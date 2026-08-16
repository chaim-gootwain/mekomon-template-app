/* ============================================================
   deals.js — עסקאות + לוח תשלומים (מתוך כרטיס הלקוח)
   ------------------------------------------------------------
   אשף: סוג עסקה · גודל+כמות (מחירון) · הנחה (% / סכום / מחיר כולל) ·
        תשלום מלא מראש או פריסה (לוח תשלומים אוטומטי).
   נשמר על החוזה: contracts.payment_plan (jsonb). רישום תשלום חלקי
   מעדכן את הלוח והיתרה. ללא סכימה כבדה — עמודה אחת נוספת בלבד.
   ============================================================ */

'use strict';

const DEAL_TYPES = [
  { v: 'contract', t: 'חוזה X פרסומים' },
  { v: 'bundle', t: 'חבילה במחיר כולל' },
  { v: 'subscription', t: 'מנוי מתחדש' },
];
let _dealState = null;

function _dealRound(n) { return Math.round(Number(n) || 0); }
function _dealPriceOf(itemId) { const p = (cache.priceList || []).find(x => x.id === Number(itemId)); return p ? Number(p.price) || 0 : 0; }

function dealNew(customerId) {
  const cust = (cache.customers || []).find(c => c.id === customerId);
  _dealState = { customerId, cust, listItems: cache.priceList || [] };
  const modal = document.getElementById('viewModal');
  const priceOpts = (cache.priceList || []).map(p => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}</option>`).join('');
  modal.innerHTML = `
    <h3>עסקה חדשה — ${esc(cust ? cust.name : '')}</h3>
    <div class="grid2">
      <div class="field"><label>סוג עסקה</label>
        <select id="dlType">${DEAL_TYPES.map(t => `<option value="${t.v}">${t.t}</option>`).join('')}</select></div>
      <div class="field"><label>גודל (מחירון)</label>
        <select id="dlItem" onchange="dealRecalc()"><option value="">— בחר —</option>${priceOpts}</select></div>
      <div class="field"><label>כמות פרסומים</label>
        <input type="number" id="dlQty" min="1" value="1" oninput="dealRecalc()"></div>
      <div class="field"><label>מחיר מחירון</label>
        <input id="dlList" readonly value="₪0" style="background:#f8fafc"></div>
      <div class="field"><label>סוג הנחה</label>
        <select id="dlDiscKind" onchange="dealRecalc()">
          <option value="none">ללא הנחה</option>
          <option value="pct">אחוז מהמחירון</option>
          <option value="amount">סכום קבוע</option>
          <option value="custom">מחיר כולל ידני</option>
        </select></div>
      <div class="field"><label>ערך ההנחה / מחיר</label>
        <input type="number" id="dlDiscVal" min="0" value="0" oninput="dealRecalc()"></div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:10px 14px;margin:6px 0 14px">
      <b>סה"כ העסקה</b><b id="dlTotal" style="font-size:1.3rem;color:#0369a1">₪0</b>
    </div>

    <div class="field"><label>תשלום</label>
      <select id="dlPayMode" onchange="dealRecalc()">
        <option value="full">תשלום מלא מראש</option>
        <option value="plan">פריסה לתשלומים</option>
      </select></div>
    <div id="dlPlanCfg" class="grid3 hidden">
      <div class="field"><label>מספר תשלומים</label><input type="number" id="dlN" min="2" value="3" oninput="dealRecalc()"></div>
      <div class="field"><label>תאריך ראשון</label><input type="date" id="dlFirst" value="${today()}" onchange="dealRecalc()"></div>
      <div class="field"><label>תדירות</label><select id="dlFreq" onchange="dealRecalc()"><option value="monthly">חודשי</option><option value="biweekly">כל שבועיים</option><option value="weekly">שבועי</option></select></div>
    </div>
    <div id="dlPlanPreview" style="margin-bottom:12px"></div>

    <div class="field"><label>תדירות / שיריון</label>
      <select id="dlCadence" onchange="dealCadenceToggle()">
        <option value="every">כל גיליון (רצף)</option>
        <option value="monthly">פעם בחודש</option>
        <option value="bimonthly">פעם בחודשיים</option>
        <option value="selected">גיליונות / תאריכים שמורים</option>
      </select></div>
    <div id="dlIssuesBox" class="hidden" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:12px;background:#fbfdff;max-height:190px;overflow:auto">
      <label style="font-weight:700">בחר את הגיליונות ששוריינו</label>
      <div id="dlIssuesList" style="margin-top:6px">${(cache.issues||[]).filter(i=>['planning','in_progress','layout','closed'].includes(i.status) || (i.publish_date||'')>=today()).sort((a,b)=>a.issue_number-b.issue_number).map(i=>`<label style=\"display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer\"><input type=\"checkbox\" class=\"dlIssChk\" value=\"${i.publish_date||''}\" data-iss=\"${i.issue_number}\" style=\"width:16px;height:16px\"> גיליון ${i.issue_number}${i.publish_date?' — '+heDate(i.publish_date):''}</label>`).join('')}</div>
      <p class="muted" style="font-size:.74rem;margin-top:6px">המערכת תזכיר לך אוטומטית להכניס את המודעה בכל גיליון שסימנת.</p>
    </div>

    <div class="m-actions">
      <button class="btn" onclick="dealSave()">💾 שמירת עסקה</button>
      <button class="btn btn-ghost" style="margin-right:auto" onclick="openCustomerCard(${customerId})">ביטול</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  dealRecalc();
}

function _dealBuildPlan() {
  const total = _dealState.total || 0;
  const n = Math.max(1, parseInt(document.getElementById('dlN').value) || 1);
  const first = document.getElementById('dlFirst').value || today();
  const freq = document.getElementById('dlFreq').value || 'monthly';
  const base = Math.floor(total / n);
  const plan = [];
  const d0 = new Date(first);
  for (let i = 0; i < n; i++) {
    const d = new Date(d0);
    if (freq === 'monthly') d.setMonth(d.getMonth() + i);
    else if (freq === 'biweekly') d.setDate(d.getDate() + i * 14);
    else d.setDate(d.getDate() + i * 7);
    const amt = i === n - 1 ? total - base * (n - 1) : base;
    plan.push({ seq: i + 1, due: d.toISOString().slice(0, 10), amount: amt, paid: 0, status: 'open' });
  }
  return plan;
}

function dealRecalc() {
  if (!_dealState) return;
  const item = document.getElementById('dlItem').value;
  const qty = Math.max(0, parseInt(document.getElementById('dlQty').value) || 0);
  const list = _dealPriceOf(item) * qty;
  document.getElementById('dlList').value = money(list) || '₪0';
  const kind = document.getElementById('dlDiscKind').value;
  const val = Number(document.getElementById('dlDiscVal').value) || 0;
  let total = list;
  if (kind === 'pct') total = list * (1 - val / 100);
  else if (kind === 'amount') total = list - val;
  else if (kind === 'custom') total = val;
  total = Math.max(0, _dealRound(total));
  _dealState.total = total; _dealState.list = list; _dealState.kind = kind; _dealState.val = val;
  document.getElementById('dlTotal').textContent = money(total) || '₪0';

  const planMode = document.getElementById('dlPayMode').value === 'plan';
  document.getElementById('dlPlanCfg').classList.toggle('hidden', !planMode);
  const prev = document.getElementById('dlPlanPreview');
  if (planMode) {
    const plan = _dealBuildPlan(); _dealState.plan = plan;
    prev.innerHTML = `<table class="data"><thead><tr><th>#</th><th>תאריך</th><th>סכום</th></tr></thead><tbody>
      ${plan.map(p => `<tr><td>${p.seq}</td><td>${heDate(p.due)}</td><td>${money(p.amount)}</td></tr>`).join('')}</tbody></table>`;
  } else { _dealState.plan = [{ seq: 1, due: today(), amount: total, paid: 0, status: 'open' }]; prev.innerHTML = ''; }
}

function dealCadenceToggle() {
  const cad = document.getElementById('dlCadence').value;
  document.getElementById('dlIssuesBox').classList.toggle('hidden', cad !== 'selected');
}
function _dealCollectDates() {
  return [...document.querySelectorAll('.dlIssChk:checked')].map(c => c.value).filter(Boolean).sort();
}

async function dealSave() {
  if (!_dealState || !_dealState.total) { toast('השלם גודל ומחיר', true); return; }
  const item = document.getElementById('dlItem').value;
  const qty = Math.max(1, parseInt(document.getElementById('dlQty').value) || 1);
  const type = document.getElementById('dlType').value;
  const discDesc = _dealState.kind === 'pct' ? `הנחה ${_dealState.val}% מהמחירון`
    : _dealState.kind === 'amount' ? `הנחה ${money(_dealState.val)}`
    : _dealState.kind === 'custom' ? 'מחיר כולל מיוחד' : '';
  const cadence = document.getElementById('dlCadence') ? document.getElementById('dlCadence').value : 'every';
  const selDates = cadence === 'selected' ? _dealCollectDates() : [];
  if (cadence === 'selected' && !selDates.length) { toast('בחר לפחות גיליון אחד ששוריין', true); return; }
  const totalInserts = cadence === 'selected' ? selDates.length : qty;
  const payload = {
    customer_id: _dealState.customerId,
    price_item_id: item ? Number(item) : null,
    total_inserts: totalInserts,
    cadence: cadence,
    selected_dates: selDates,
    total_price: _dealState.total,
    billing_mode: 'upfront',
    start_date: today(),
    active: true,
    agent_id: _dealState.cust ? _dealState.cust.agent_id : null,
    payment_plan: _dealState.plan,
    notes: [DEAL_TYPES.find(t => t.v === type).t, discDesc].filter(Boolean).join(' · '),
  };
  let { error } = await saveContractSafe(payload);
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  await addInteraction('customer', _dealState.customerId, `נוצרה עסקה: ${money(_dealState.total)} (${payload.notes})`);
  toast('העסקה נשמרה ✓');
  openCustomerCard(_dealState.customerId);
}

/* שמירה בטוחה: אם payment_plan עדיין לא קיים ב-DB — נשמר בלי לשבור */
async function saveContractSafe(payload) {
  let res = await db.from('contracts').insert(payload);
  if (res.error && /payment_plan|cadence|selected_dates|column/i.test(res.error.message || '')) {
    const { payment_plan, cadence, selected_dates, ...safe } = payload;
    res = await db.from('contracts').insert(safe);
  }
  return res;
}

/* לוח התשלומים בכרטיס הלקוח */
function dealPlanHtml(ct) {
  const plan = Array.isArray(ct.payment_plan) ? ct.payment_plan : null;
  if (!plan || !plan.length) return '';
  const paid = plan.reduce((s, p) => s + (Number(p.paid) || 0), 0);
  const total = Number(ct.total_price) || plan.reduce((s, p) => s + Number(p.amount), 0);
  const bal = total - paid;
  const badge = p => {
    const st = Number(p.paid) >= Number(p.amount) ? ['שולם', 'green'] : Number(p.paid) > 0 ? ['חלקי', 'amber'] : ['פתוח', ''];
    return `<span class="pill ${st[1]}">${st[0]}</span>`;
  };
  return `<div style="margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:10px;background:#fbfcff">
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:.85rem;margin-bottom:8px">
      <span>סה"כ: <b>${money(total)}</b></span><span>שולם: <b style="color:var(--ok)">${money(paid)}</b></span>
      <span>יתרה: <b style="color:${bal > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(bal)}</b></span>
    </div>
    <table class="data"><thead><tr><th>#</th><th>תאריך</th><th>סכום</th><th>שולם</th><th>מצב</th><th></th></tr></thead><tbody>
    ${plan.map(p => `<tr><td>${p.seq}</td><td>${heDate(p.due)}</td><td>${money(p.amount)}</td>
      <td>${money(p.paid) || '—'}</td><td>${badge(p)}</td>
      <td>${Number(p.paid) < Number(p.amount) ? `<button class="btn btn-sm btn-ghost" onclick="dealPayMenu(${ct.id},${p.seq})">＋ תשלום</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

async function dealPay(contractId, seq) {
  const ct = await run(db.from('contracts').select('*').eq('id', contractId).single());
  const plan = Array.isArray(ct.payment_plan) ? ct.payment_plan : [];
  const row = plan.find(p => p.seq === seq);
  if (!row) { toast('שורה לא נמצאה', true); return; }
  const remain = Number(row.amount) - Number(row.paid || 0);
  const raw = prompt(`סכום התשלום לתשלום #${seq} (יתרה ${money(remain)}):`, String(remain));
  if (raw === null) return;
  const amt = Number(raw);
  if (!isFinite(amt) || amt <= 0) { toast('סכום לא תקין', true); return; }
  row.paid = Number(row.paid || 0) + amt;
  row.status = row.paid >= Number(row.amount) ? 'paid' : 'partial';
  const { error } = await db.from('contracts').update({ payment_plan: plan }).eq('id', contractId);
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  await addInteraction('customer', ct.customer_id, `תשלום ${money(amt)} לעסקה (תשלום #${seq})`);
  toast(row.status === 'paid' ? '✓ התשלום הושלם' : 'נרשם תשלום חלקי');
  openCustomerCard(ct.customer_id);
}

/* תפריט תשלום מלוח-התשלומים: הפקת חשבונית מס קבלה (EZcount + חוב) או רישום פנימי בלבד */
function dealPayMenu(contractId, seq) {
  document.getElementById('dpOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'dpOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const close = "document.getElementById('dpOv').remove();";
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;padding:18px;max-width:430px;width:92%;direction:rtl">
    <h3 style="margin:0 0 4px">💰 תשלום עבור החוזה</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 14px">איך לרשום את התשלום?</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" onclick="${close} dealPayInvoice(${contractId}, ${seq})">🧾 הפק חשבונית מס קבלה</button>
      <button class="btn btn-ghost" onclick="${close} dealPay(${contractId}, ${seq})">✓ רשום תשלום בלבד (ללא חשבונית)</button>
      <button class="btn btn-ghost" onclick="${close}">ביטול</button>
    </div></div>`;
  document.body.appendChild(ov);
}

/* הפקת חשבונית מס קבלה על תשלום מלוח-התשלומים + עדכון הלוח */
async function dealPayInvoice(contractId, seq) {
  const ct = await run(db.from('contracts').select('*').eq('id', contractId).single());
  const plan = Array.isArray(ct.payment_plan) ? ct.payment_plan : [];
  const row = plan.find(p => p.seq === seq);
  if (!row) { toast('שורה לא נמצאה', true); return; }
  const remain = Number(row.amount) - Number(row.paid || 0);
  const raw = prompt(`סכום התשלום לתשלום #${seq} (יתרה ${money(remain)}, לפני מע"מ):`, String(remain));
  if (raw === null) return;
  const amt = Number(raw);
  if (!isFinite(amt) || amt <= 0) { toast('סכום לא תקין', true); return; }
  row.paid = Number(row.paid || 0) + amt;
  row.status = row.paid >= Number(row.amount) ? 'paid' : 'partial';
  const { error } = await db.from('contracts').update({ payment_plan: plan }).eq('id', contractId);
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  try { await addInteraction('customer', ct.customer_id, `תשלום ${money(amt)} לחוזה (תשלום #${seq}) — הופקה חשבונית מס קבלה`); } catch (e) { }
  const cust = (typeof _customers !== 'undefined' && (_customers || []).find(x => x.id === ct.customer_id))
    || (cache.customers || []).find(x => x.id === ct.customer_id)
    || (await run(db.from('customers').select('*').eq('id', ct.customer_id).limit(1)))[0];
  if (!cust) { toast('לקוח לא נמצא', true); return; }
  if (typeof invOpenModal === 'function') {
    await invOpenModal(cust, 'invoice_receipt', true, { lines: [{ details: 'תשלום עבור חבילת פרסום — ' + (nameOf('priceList', ct.price_item_id) || '') + ' (תשלום #' + seq + ')', amount: 1, price: amt }], vatInc: false });
  } else { toast('מודל החשבונית לא זמין', true); }
}
