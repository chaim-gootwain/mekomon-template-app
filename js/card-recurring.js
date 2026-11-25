/* ============================================================
card-recurring.js — חיוב חודשי אוטומטי בכרטיס אשראי (קארדקום, טוקן)
------------------------------------------------------------
- כרטיס הלקוח → "💳 חיוב אוטומטי חודשי": שליחת קישור לשמירת כרטיס,
  הוספת חיוב חודשי קבוע (סכום לפני מע"מ, יום בחודש, מספר חודשים), עצירה,
  היסטוריית חיובים וניסיון חוזר לחיוב שנכשל.
- עסקה חדשה (deals.js): בהוראת קבע — תיבה "לחייב אוטומטית בכרטיס" →
  נוצר חיוב חודשי קבוע מקושר לחוזה (crCreateForContract).
- הגדרות: כרטיס "חיוב אוטומטי באשראי" — מצב קארדקום, מתג ריצה אוטומטית,
  "חייב עכשיו", חיובים אחרונים.
- השרת: Edge Function ‏cardcom-recurring (החיוב, החשבונית והכרטסת קורים שם).
  טבלאות: migrations/2026-11-25_card_recurring.sql
============================================================ */

'use strict';

async function crFn(action, body) {
  try {
    const { data, error } = await db.functions.invoke('cardcom-recurring', { body: Object.assign({ action }, body || {}) });
    if (error) {
      let msg = error.message || String(error);
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { }
      return { ok: false, error: msg };
    }
    return data || { ok: false, error: 'אין תשובה' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function _crVat() { const v = Number((cache.settings || {}).vat_rate); return Number.isFinite(v) && v > 0 ? v : 18; }
function _crWithVat(n) { return Math.round(Number(n) * (1 + _crVat() / 100) * 100) / 100; }
function _crNextYm() { const [y, m] = thisMonth().split('-').map(Number); const d = new Date(y, m, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
const CR_RUN_ST = {
  paid: ['שולם ✓', 'green'], paid_no_doc: ['שולם — בלי חשבונית', 'amber'],
  failed: ['נכשל', 'red'], processing: ['בטיפול / לבדיקה', 'amber'],
};
function _crRunPill(st) { const x = CR_RUN_ST[st] || [st, '']; return `<span class="pill ${x[1]}">${x[0]}</span>`; }
function _crClose() { document.getElementById('viewBack').classList.remove('open'); }

/* יצירת חיוב חודשי קבוע (RLS: מנהל) */
async function crCreate(o) {
  const row = {
    customer_id: Number(o.customer_id), contract_id: o.contract_id || null,
    amount: Math.round(Number(o.amount) * 100) / 100, description: String(o.description || 'חיוב חודשי').slice(0, 200),
    day_of_month: Math.min(28, Math.max(1, parseInt(o.day_of_month) || 1)),
    start_ym: /^\d{4}-\d{2}$/.test(o.start_ym || '') ? o.start_ym : thisMonth(),
    max_charges: Number(o.max_charges) > 0 ? parseInt(o.max_charges) : null,
    active: true, created_by: (typeof profile !== 'undefined' ? profile.id : null),
  };
  const { data, error } = await db.from('recurring_card_charges').insert(row).select('id').single();
  if (error) {
    if (/recurring_card_charges|relation|does not exist/i.test(error.message || '')) return { error: 'הטבלאות חסרות — יש להריץ את המיגרציה card_recurring' };
    return { error: error.message };
  }
  try { await addInteraction('customer', row.customer_id, `💳 הוגדר חיוב חודשי אוטומטי באשראי: ${money(row.amount)} + מע"מ, ב-${row.day_of_month} לחודש${row.max_charges ? ' · ' + row.max_charges + ' חודשים' : ' · עד ביטול'}`); } catch (e) { }
  return { id: data && data.id };
}

/* מעסקה חדשה (deals.js) — חוזה עם הוראת קבע + "חיוב אוטומטי בכרטיס" */
async function crCreateForContract(contractId, customerId, amount, description) {
  const r = await crCreate({ customer_id: customerId, contract_id: contractId, amount, description: description || 'הוראת קבע חודשית', day_of_month: 1, start_ym: thisMonth() });
  if (r.error) { toast('החוזה נשמר, אבל החיוב האוטומטי לא הוגדר: ' + r.error, true); return false; }
  return true;
}

/* ---------- המסך בכרטיס הלקוח ---------- */
let _crCid = null;
async function crOpen(cid) {
  if (typeof profile === 'undefined' || profile.role !== 'admin') { toast('רק מנהל יכול להגדיר חיוב אוטומטי', true); return; }
  _crCid = Number(cid);
  const modal = document.getElementById('viewModal');
  const cust = (cache.customers || []).find(c => c.id === _crCid) || {};
  modal.innerHTML = `<h3>💳 חיוב אוטומטי חודשי — ${esc(cust.name || '')}</h3><p class="muted">טוען...</p>`;
  document.getElementById('viewBack').classList.add('open');
  const s = await crFn('status', { customer_id: _crCid });
  if (!s || !s.ok) { modal.innerHTML = `<h3>💳 חיוב אוטומטי חודשי</h3><p style="color:var(--danger,#b91c1c)">${esc((s && s.error) || 'שגיאה')}</p><p class="muted" style="font-size:.82rem">אם זו הפעם הראשונה: צריך להריץ את המיגרציה card_recurring ולפרוס את הפונקציה cardcom-recurring.</p><div class="m-actions"><button class="btn btn-ghost" onclick="_crClose()">סגור</button></div>`; return; }
  const card = s.card;
  const cardHtml = !s.configured
    ? `<div class="pill amber" style="display:inline-block">קארדקום לא מוגדרת במופע — הגדרות → חיוב אוטומטי באשראי</div>`
    : card
      ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="pill green">כרטיס שמור ✓</span>
         <b dir="ltr">${card.card_last4 ? '**** ' + esc(card.card_last4) : 'כרטיס'}</b>
         ${card.card_exp_mmyy ? `<span class="muted">תוקף ${esc(card.card_exp_mmyy.slice(0, 2))}/${esc(card.card_exp_mmyy.slice(2))}</span>` : ''}
         <span class="muted" style="font-size:.8rem">נשמר ${heDate(card.created_at)}</span>
         <button class="btn btn-sm btn-ghost" onclick="crSendLink()">החלפת כרטיס</button>
         <button class="btn btn-sm btn-ghost" onclick="crRemoveCard()">הסרה</button></div>`
      : `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="pill">אין כרטיס שמור</span>
         ${s.pending_link ? '<span class="muted" style="font-size:.82rem">נשלח קישור — ממתין שהלקוח ימלא</span>' : ''}
         <button class="btn btn-sm" onclick="crSendLink()">📨 שלח ללקוח קישור לשמירת כרטיס</button>
         <button class="btn btn-sm btn-ghost" onclick="crOpen(${_crCid})">🔄 רענן</button></div>`;
  const rcs = s.recurring || [];
  const rcHtml = rcs.length ? rcs.map(r => `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line,#e5e7eb)">
      <b>${money(r.amount)}</b><span class="muted">+ מע"מ = ${money(_crWithVat(r.amount))}</span>
      <span>${esc(r.description || '')}</span>
      <span class="muted" style="font-size:.82rem">ב-${r.day_of_month} לחודש · מ-${esc(r.start_ym)} · ${r.max_charges ? r.charges_done + '/' + r.max_charges + ' חודשים' : r.charges_done + ' חויבו · עד ביטול'}${r.contract_id ? ' · חוזה #' + r.contract_id : ''}</span>
      ${r.active ? `<span class="pill green">פעיל</span><button class="btn btn-sm btn-ghost" onclick="crToggle(${r.id},false)">⏸ עצור</button>`
                 : `<span class="pill">מושהה</span><button class="btn btn-sm btn-ghost" onclick="crToggle(${r.id},true)">▶ הפעל</button>`}
    </div>`).join('') : '<p class="muted">אין עדיין חיוב חודשי קבוע ללקוח.</p>';
  const runs = s.runs || [];
  const runsHtml = runs.length ? `<table class="data" style="width:100%;font-size:.84rem"><thead><tr><th>חודש</th><th>סכום</th><th>מצב</th><th>חשבונית</th><th>פרטים</th><th></th></tr></thead><tbody>
    ${runs.map(x => `<tr><td>${esc(x.ym)}</td><td>${x.amount_total ? money(x.amount_total) : ''}</td><td>${_crRunPill(x.status)}</td><td>${esc(x.doc_number || '')}</td>
      <td style="max-width:260px">${x.cardcom_txn ? 'קארדקום ' + esc(x.cardcom_txn) : ''}${x.error ? `<div style="color:#991b1b;font-size:.78rem">${esc(x.error)}</div>` : ''}</td>
      <td>${x.status === 'failed' ? `<button class="btn btn-sm btn-ghost" onclick="crRetry(${x.id})">נסה שוב</button>` : ''}${x.status === 'processing' && !x.cardcom_txn && x.error ? `<button class="btn btn-sm btn-ghost" title="רק אחרי שבדקת בממשק קארדקום שלא בוצע חיוב" onclick="crMarkFailed(${x.id})">לא חויב — שחרר</button>` : ''}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">עוד לא בוצעו חיובים.</p>';
  modal.innerHTML = `
    <h3>💳 חיוב אוטומטי חודשי — ${esc(cust.name || '')}</h3>
    <div class="card card-pad" style="margin-bottom:10px">${cardHtml}</div>
    <div class="card card-pad" style="margin-bottom:10px">
      <b>חיובים חודשיים קבועים</b>${rcHtml}
      <details style="margin-top:10px" ${rcs.length ? '' : 'open'}><summary style="cursor:pointer;font-weight:700">+ חיוב חודשי חדש</summary>
        <div class="grid2" style="margin-top:8px">
          <div class="field"><label>סכום חודשי (לפני מע"מ) *</label><input id="crAmt" type="number" min="1" dir="ltr" oninput="crAmtHint()"><p id="crAmtHint" class="muted" style="font-size:.76rem"></p></div>
          <div class="field"><label>תיאור בחשבונית</label><input id="crDesc" value="חיוב חודשי"></div>
        </div>
        <div class="grid3">
          <div class="field"><label>יום החיוב בחודש</label><input id="crDay" type="number" min="1" max="28" value="1" dir="ltr"></div>
          <div class="field"><label>חודש ראשון</label><input id="crStart" type="month" value="${thisMonth()}" dir="ltr"></div>
          <div class="field"><label>מספר חודשים (ריק = עד ביטול)</label><input id="crMax" type="number" min="1" dir="ltr"></div>
        </div>
        <p class="muted" style="font-size:.78rem">בכל חודש, ביום שנקבע, הכרטיס השמור יחויב בסכום כולל מע"מ, תופק חשבונית מס-קבלה ויירשם תשלום בכרטסת. חיוב שנכשל ינוסה שוב עד 3 פעמים (פעם ביום).</p>
        <button class="btn" onclick="crAdd()">שמור חיוב חודשי</button>
      </details>
    </div>
    <div class="card card-pad"><b>חיובים שבוצעו</b>${runsHtml}</div>
    <div class="m-actions"><button class="btn btn-ghost" onclick="_crClose()">סגור</button></div>`;
}
function crAmtHint() {
  const v = Number(document.getElementById('crAmt').value) || 0;
  document.getElementById('crAmtHint').textContent = v > 0 ? `יחויב ${money(_crWithVat(v))} כולל מע"מ (${_crVat()}%)` : '';
}
async function crAdd() {
  const amount = Number(document.getElementById('crAmt').value) || 0;
  if (!(amount > 0)) { toast('הזן סכום חודשי', true); return; }
  const r = await crCreate({ customer_id: _crCid, amount, description: document.getElementById('crDesc').value.trim() || 'חיוב חודשי',
    day_of_month: document.getElementById('crDay').value, start_ym: document.getElementById('crStart').value, max_charges: document.getElementById('crMax').value });
  if (r.error) { toast('שגיאה: ' + r.error, true); return; }
  toast('החיוב החודשי נשמר ✓');
  crOpen(_crCid);
}
async function crToggle(id, on) {
  if (!on && !confirm('לעצור את החיוב החודשי? לא יבוצעו חיובים נוספים עד שתפעיל שוב.')) return;
  const { error } = await db.from('recurring_card_charges').update({ active: on, stopped_at: on ? null : new Date().toISOString() }).eq('id', id);
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  toast(on ? 'החיוב הופעל ✓' : 'החיוב נעצר');
  crOpen(_crCid);
}
async function crRemoveCard() {
  if (!confirm('להסיר את הכרטיס השמור? חיובים חודשיים ייכשלו עד שהלקוח ישמור כרטיס חדש.')) return;
  const r = await crFn('remove_card', { customer_id: _crCid });
  if (!r.ok) { toast(r.error || 'שגיאה', true); return; }
  crOpen(_crCid);
}
async function crRetry(runId) {
  if (!confirm('לנסות לחייב שוב עכשיו?')) return;
  toast('מחייב...');
  const r = await crFn('retry', { run_id: runId });
  const x = r && r.results && r.results[0];
  if (!r.ok) toast(r.error || 'שגיאה', true);
  else if (x && x.ok) toast('החיוב עבר ✓' + (x.doc_number ? ' · חשבונית ' + x.doc_number : ''));
  else toast('החיוב נכשל: ' + ((x && x.error) || ''), true);
  crOpen(_crCid);
}

async function crMarkFailed(runId) {
  if (!confirm('בדקת בממשק קארדקום שהחיוב הזה לא בוצע? אחרי האישור אפשר יהיה לנסות לחייב שוב.')) return;
  const r = await crFn('mark_failed', { run_id: runId });
  if (!r.ok) { toast(r.error || 'שגיאה', true); return; }
  crOpen(_crCid);
}

/* קישור לשמירת כרטיס — העתקה / וואטסאפ / מייל */
async function crSendLink() {
  const cust = (cache.customers || []).find(c => c.id === _crCid) || {};
  toast('יוצר קישור מאובטח...');
  const rc = await db.from('recurring_card_charges').select('amount').eq('customer_id', _crCid).eq('active', true).limit(1);
  const amt = rc.data && rc.data[0] ? _crWithVat(rc.data[0].amount) : 0;
  const r = await crFn('token_link', { customer_id: _crCid, amount: amt, return_url: location.origin + '/card-saved.html' });
  if (!r.ok || !r.url) { toast(r.error || 'יצירת הקישור נכשלה', true); return; }
  const msg = `שלום${cust.name ? ' ' + cust.name : ''}, לצורך החיוב החודשי — אפשר לשמור כאן את פרטי כרטיס האשראי בדף המאובטח של קארדקום (לא מתבצע חיוב בשמירה): ${r.url}`;
  const phone = String(cust.whatsapp || cust.phone || '').replace(/\D/g, '');
  const intl = phone ? (phone.startsWith('0') ? '972' + phone.slice(1) : phone) : '';
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `<h3>📨 קישור לשמירת כרטיס — ${esc(cust.name || '')}</h3>
    <p class="muted" style="font-size:.85rem">הלקוח מזין את הכרטיס בדף של קארדקום. בשמירה לא מתבצע חיוב — הכרטיס נשמר כטוקן לחיובים החודשיים.</p>
    <textarea id="crLinkMsg" rows="4" style="width:100%">${esc(msg)}</textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('crLinkMsg').value).then(()=>toast('הועתק ✓'))">📋 העתק</button>
      ${intl ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${intl}?text=${encodeURIComponent(msg)}">💬 וואטסאפ</a>` : ''}
      ${cust.email ? `<a class="btn" href="mailto:${esc(cust.email)}?subject=${encodeURIComponent('שמירת כרטיס לחיוב חודשי')}&body=${encodeURIComponent(msg)}">✉️ מייל</a>` : ''}
    </div>
    <div class="m-actions"><button class="btn btn-ghost" onclick="crOpen(${_crCid})">חזרה</button></div>`;
}

/* ---------- כרטיס ההגדרות ---------- */
function _crAutoOn() { return String((cache.settings || {}).card_recurring_auto || '0') === '1'; }
function cardRecurringCard() {
  const s = cache.settings || {};
  setTimeout(cardRecurringCardLoad, 50);
  return `
<div class="card card-pad" id="crSetCard">
<b>חיוב אוטומטי באשראי 💳</b>
<p class="muted" style="font-size:.82rem">חיוב חודשי קבוע בכרטיס שהלקוח שמר (קארדקום). בכל חיוב מופקת חשבונית מס-קבלה ונרשם תשלום בכרטסת. מגדירים ללקוח מכרטיס הלקוח → מסמכים → 💳 חיוב אוטומטי חודשי, או בעסקה חדשה עם הוראת קבע.</p>
<div id="crSetStatus" class="muted" style="font-size:.82rem">בודק חיבור לקארדקום...</div>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" ${_crAutoOn() ? 'checked' : ''} onchange="cardRecurringToggleAuto(this.checked)" style="width:18px;height:18px">
חיוב אוטומטי פעיל (כל יום — מה שהגיע מועדו)
</label>
<p class="muted" style="font-size:.78rem;margin-top:4px">${s.card_recurring_last_run ? 'רץ לאחרונה: ' + heDate(s.card_recurring_last_run) + '.' : 'טרם רץ.'}</p>
<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-sm" onclick="cardRecurringRunNow()">💳 חייב עכשיו את מה שהגיע מועדו</button></div>
<div id="crSetRuns" style="margin-top:10px"></div>
</div>`;
}
async function cardRecurringCardLoad() {
  const el = document.getElementById('crSetStatus'); if (!el) return;
  const p = await crFn('probe');
  el.innerHTML = !p.ok ? `<span style="color:#991b1b">הפונקציה cardcom-recurring לא זמינה (${esc(p.error || '')}) — לפרוס אותה ולהריץ את המיגרציה card_recurring.</span>`
    : p.configured ? `<span class="pill green">קארדקום מחוברת ✓</span>${p.cron ? '' : ' <span class="pill amber">CRON_SECRET לא מוגדר — הריצה היומית תתבצע רק בכניסת מנהל</span>'}`
    : '<span class="pill amber">קארדקום לא מוגדרת</span> — להוסיף ב-Supabase → Edge Functions → Secrets את CARDCOM_TERMINAL ו-CARDCOM_API_NAME (ואם המסוף דורש — CARDCOM_API_PASSWORD).';
  try {
    const runs = (await db.from('recurring_card_runs').select('*').order('id', { ascending: false }).limit(15)).data || [];
    const box = document.getElementById('crSetRuns');
    if (box && runs.length) box.innerHTML = `<table class="data" style="width:100%;font-size:.82rem"><thead><tr><th>לקוח</th><th>חודש</th><th>סכום</th><th>מצב</th><th></th></tr></thead><tbody>${runs.map(x =>
      `<tr><td>${esc(nameOf('customers', x.customer_id) || '#' + x.customer_id)}</td><td>${esc(x.ym)}</td><td>${x.amount_total ? money(x.amount_total) : ''}</td><td>${_crRunPill(x.status)}${x.error ? `<div style="color:#991b1b;font-size:.74rem">${esc(x.error)}</div>` : ''}</td><td><button class="btn btn-sm btn-ghost" onclick="crOpen(${x.customer_id})">פתח</button></td></tr>`).join('')}</tbody></table>`;
  } catch (e) { }
}
async function cardRecurringToggleAuto(on) {
  await db.from('settings').upsert({ key: 'card_recurring_auto', value: on ? '1' : '0' }, { onConflict: 'key' });
  cache.settings.card_recurring_auto = on ? '1' : '0';
  toast(on ? 'חיוב אוטומטי הופעל ✓' : 'חיוב אוטומטי כובה');
}
function _crRunSummary(r) {
  const res = (r && r.results) || [];
  const ok = res.filter(x => x.ok), bad = res.filter(x => !x.ok);
  return !res.length ? 'אין חיובים שהגיע מועדם' : `חויבו ${ok.length}${ok.length ? ' (' + money(ok.reduce((s, x) => s + Number(x.total || 0), 0)) + ')' : ''}${bad.length ? ' · ' + bad.length + ' נכשלו' : ''}`;
}
async function cardRecurringRunNow() {
  if (!confirm('לחייב עכשיו את כל החיובים החודשיים שהגיע מועדם?')) return;
  toast('מחייב...');
  const r = await crFn('run');
  if (!r.ok) { toast(r.error || 'שגיאה', true); return; }
  toast('💳 ' + _crRunSummary(r));
  cardRecurringCardLoad();
}

/* ריצה פעם ביום בכניסת מנהל — גיבוי ל-cron (רק כשהמתג דלוק) */
async function cardRecurringAutoCheck() {
  try {
    if (typeof profile === 'undefined' || profile.role !== 'admin' || !_crAutoOn()) return;
    if ((cache.settings || {}).card_recurring_last_run === today()) return;
    const r = await crFn('run');
    if (r && r.ok) {
      cache.settings.card_recurring_last_run = today();
      if ((r.results || []).length) toast('💳 חיוב חודשי אוטומטי: ' + _crRunSummary(r), (r.results || []).some(x => !x.ok));
    }
  } catch (e) { }
}

/* ---------- בטופס החוזה (subscriptions.js) ---------- */
let _crCtExisting = null;
function crContractBoxHtml(contractId) {
  if (typeof profile === 'undefined' || profile.role !== 'admin') return '';
  _crCtExisting = null;
  if (contractId) setTimeout(() => crContractBoxLoad(contractId), 30);
  return `<div id="crCtBox" style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;margin:8px 0;background:#fbfdff">
  <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:700">
    <input type="checkbox" id="crCtOn" onchange="document.getElementById('crCtCfg').classList.toggle('hidden',!this.checked)" style="width:17px;height:17px">
    💳 חיוב חודשי אוטומטי בכרטיס אשראי
  </label>
  <div id="crCtCfg" class="hidden" style="margin-top:8px">
    <div class="grid2">
      <div class="field" style="margin:0"><label style="font-size:.8rem">סכום חודשי (לפני מע"מ)</label><input type="number" id="crCtAmt" min="1" dir="ltr"></div>
      <div class="field" style="margin:0"><label style="font-size:.8rem">יום החיוב בחודש</label><input type="number" id="crCtDay" min="1" max="28" value="1" dir="ltr"></div>
    </div>
    <p id="crCtInfo" class="muted" style="font-size:.76rem;margin-top:4px">בכל חודש הכרטיס השמור של הלקוח יחויב בסכום + מע"מ, תופק חשבונית מס-קבלה והתשלום יירשם בכרטסת.</p>
  </div></div>`;
}
async function crContractBoxLoad(contractId) {
  try {
    const { data } = await db.from('recurring_card_charges').select('*').eq('contract_id', contractId).order('id', { ascending: false }).limit(1);
    const r = data && data[0]; if (!r || !document.getElementById('crCtOn')) return;
    _crCtExisting = r;
    document.getElementById('crCtAmt').value = r.amount;
    document.getElementById('crCtDay').value = r.day_of_month;
    if (r.active) { document.getElementById('crCtOn').checked = true; document.getElementById('crCtCfg').classList.remove('hidden'); }
    document.getElementById('crCtInfo').textContent = `${r.active ? 'פעיל' : 'מושהה'} · חויבו ${r.charges_done} חודשים · ניהול הכרטיס וההיסטוריה: כרטיס הלקוח → 🔁 חיוב אוטומטי חודשי.`;
  } catch (e) { }
}
/* נקרא אחרי שמירת החוזה. מחזיר true אם נוצר חיוב חדש */
async function crContractBoxSave(contractId, customerId, description) {
  const on = document.getElementById('crCtOn'); if (!on || !contractId) return false;
  const amount = Number(document.getElementById('crCtAmt').value) || 0;
  const day = Math.min(28, Math.max(1, parseInt(document.getElementById('crCtDay').value) || 1));
  const ex = _crCtExisting;
  if (!on.checked) {
    if (ex && ex.active) await db.from('recurring_card_charges').update({ active: false, stopped_at: new Date().toISOString() }).eq('id', ex.id);
    return false;
  }
  if (!(amount > 0)) { toast('החוזה נשמר — חסר סכום חודשי לחיוב האוטומטי', true); return false; }
  if (ex) {
    const { error } = await db.from('recurring_card_charges').update({ amount, day_of_month: day, active: true, stopped_at: null }).eq('id', ex.id);
    if (error) toast('עדכון החיוב האוטומטי נכשל: ' + error.message, true);
    return false;
  }
  const r = await crCreate({ customer_id: customerId, contract_id: contractId, amount, day_of_month: day, start_ym: thisMonth(), description: description || 'חיוב חודשי לפי חוזה' });
  if (r.error) { toast('החוזה נשמר, אבל החיוב האוטומטי לא הוגדר: ' + r.error, true); return false; }
  return true;
}
