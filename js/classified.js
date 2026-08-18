/* ============================================================
classified.js — מודעות לוח ("הלוח"): תמחור לפי מילים, ניהול, והפקת מדור
------------------------------------------------------------
- עמוד ייעודי (NAV מוזרק מכאן, בלי לגעת ב-app.js)
- תמחור אוטומטי: רגיל 40 / מודגש 50 עד 10 מילים, +10 לכל 10 נוספות, כולל מע"מ
- מסלול 4+1: 5 גיליונות במחיר 4
- הפקת מדור הלוח מקובץ לפי קטגוריה, מוכן לעימוד
- טבלה: classified_ads (אם עדיין לא קיימת — הודעה ידידותית)
============================================================ */

'use strict';

const CL_CATEGORIES = [
  { v: 'sale', t: 'מכירה' },
  { v: 'rent', t: 'להשכיר / נדל"ן' },
  { v: 'jobs', t: 'דרושים / ביקוש עבודה' },
  { v: 'gemach', t: 'גמ"חים' },
  { v: 'lost', t: 'השבת אבידה' },
  { v: 'other', t: 'שונות' },
];
function _clCatHe(v) { const x = CL_CATEGORIES.find(c => c.v === v); return x ? x.t : 'שונות'; }

function clBaseRegular() { const v = Number((cache.settings || {}).classified_base_regular); return Number.isFinite(v) && v > 0 ? v : 40; }
function clBaseBold() { const v = Number((cache.settings || {}).classified_base_bold); return Number.isFinite(v) && v > 0 ? v : 50; }
function clExtraPer10() { const v = Number((cache.settings || {}).classified_extra_per_10); return Number.isFinite(v) && v > 0 ? v : 10; }

function clCountWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
// מחיר יחיד (כולל מע"מ) לפי סוג + מספר מילים
function clPrice(type, words) {
  const base = type === 'bold' ? clBaseBold() : clBaseRegular();
  if (words <= 10) return base;
  const extraBlocks = Math.ceil((words - 10) / 10);
  return base + extraBlocks * clExtraPer10();
}

/* ---------- תור אישור מנהל למודעות לוח מהפורטל ---------- */
function _clQueueHtml(rows) {
  const pend = (rows || []).filter(r => r.source === 'portal_public' && r.status === 'pending');
  if (!pend.length) return '';
  const seen = new Set(); const items = [];
  pend.forEach(r => {
    const k = r.package_id ? ('p' + r.package_id) : ('s' + r.id);
    if (seen.has(k)) return; seen.add(k);
    const grp = r.package_id ? pend.filter(x => x.package_id === r.package_id) : [r];
    items.push({ r, grp });
  });
  return `<div class="card card-pad" style="margin-bottom:12px;border-right:4px solid @@COLOR_GRAD@@">
    <b style="color:@@COLOR_GRAD@@">🔔 ממתין לאישור מנהל (${items.length})</b>
    <p class="muted" style="font-size:.83rem;margin:2px 0 10px">מודעות שהוגשו דרך הפורטל. אשר/י ובחר/י אם התשלום כבר הוסדר.</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>מפרסם</th><th>קטגוריה · סוג</th><th>טקסט</th><th>גיליון</th><th>סכום</th><th></th></tr></thead>
      <tbody>${items.map(({ r, grp }) => {
    const total = grp.reduce((s, x) => s + (Number(x.price) || 0), 0);
    const issues = grp.map(x => (cache.issues.find(i => i.id === x.issue_id) || {}).issue_number).filter(Boolean).join(', ');
    const typeHe = r.ad_type === 'image' ? 'תמונה' : r.ad_type === 'bold' ? 'מודגש' : 'רגיל';
    return `<tr>
          <td><b>${esc(r.contact_name || nameOf('customers', r.customer_id))}</b><br><small class="muted">${esc(r.contact_phone || '')}</small>${r.source === 'portal_public' ? '<br><span class="pill green" style="font-size:.66rem">🟢 הלקוח סימן: תשלום הוסדר</span>' : ''}</td>
          <td>${_clCatHe(r.category)} · ${typeHe}${grp.length > 1 ? ' · <span class="pill amber">4+1</span>' : ''}</td>
          <td>${esc((r.body || '').slice(0, 46))}${(r.body || '').length > 46 ? '…' : ''}${r.image_path ? ' 📷' : ''}</td>
          <td>${esc(issues)}</td>
          <td><b>${money(total)}</b></td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" style="background:var(--ok);color:#fff" onclick="classifiedApprove(${r.id}, true)" title="אישור + סימון שהתשלום הוסדר">✓ אשר + שולם</button>
            <button class="btn btn-sm btn-ghost" onclick="classifiedApprove(${r.id}, false)" title="אישור, החוב נשאר פתוח">אשר (חוב פתוח)</button>
            <button class="btn btn-sm btn-ghost" style="color:#c0392b" onclick="classifiedReject(${r.id})">דחה</button>
          </td></tr>`;
  }).join('')}</tbody>
    </table></div></div>`;
}
function _clPayMethod() { return (typeof _icPayMethod === 'function') ? _icPayMethod() : 'cash'; }

async function classifiedApprove(id, settled) {
  try {
    const r = await run(db.from('classified_ads').select('*').eq('id', id).single());
    if (!r) { toast('מודעה לא נמצאה', true); return; }
    const usePkg = !!r.package_id;
    const grp = usePkg ? await run(db.from('classified_ads').select('*').eq('package_id', r.package_id)) : [r];
    const upd = { status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString(), payment_status: settled ? 'settled' : 'pending' };
    if (usePkg) await db.from('classified_ads').update(upd).eq('package_id', r.package_id);
    else await db.from('classified_ads').update(upd).eq('id', id);
    if (settled) {
      for (const a of grp) {
        if (a.charge_id && Number(a.price) > 0) {
          await db.from('charges').update({ status: 'paid' }).eq('id', a.charge_id);
          await db.from('payments').insert({ charge_id: a.charge_id, customer_id: a.customer_id, amount: a.price, method: _clPayMethod(), paid_date: today(), notes: 'מודעת לוח (פורטל) — התשלום הוסדר', created_by: profile.id });
        }
      }
    }
    try { await addInteraction('customer', r.customer_id, '🗒️ מודעת לוח אושרה' + (settled ? ' + התשלום הוסדר' : ' (חוב פתוח)')); } catch (e) { }
    toast('✓ המודעה אושרה' + (settled ? ' + סומן שולם' : ''));
    openPage('classified');
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

async function classifiedReject(id) {
  if (!confirm('לדחות את המודעה? (החוב שנוצר יבוטל)')) return;
  try {
    const r = await run(db.from('classified_ads').select('*').eq('id', id).single());
    const usePkg = !!(r && r.package_id);
    const grp = usePkg ? await run(db.from('classified_ads').select('*').eq('package_id', r.package_id)) : [r];
    if (usePkg) await db.from('classified_ads').update({ status: 'rejected' }).eq('package_id', r.package_id);
    else await db.from('classified_ads').update({ status: 'rejected' }).eq('id', id);
    for (const a of grp) { if (a && a.charge_id) await db.from('charges').update({ status: 'cancelled', notes: 'בוטל — מודעת לוח נדחתה' }).eq('id', a.charge_id); }
    toast('המודעה נדחתה');
    openPage('classified');
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

/* סימון מודעת לוח כ"שולם" — רק אז היא נכנסת לגיליון/מדור */
async function classifiedMarkPaid(id) {
  try {
    const r = await run(db.from('classified_ads').select('*').eq('id', id).single());
    if (!r) { toast('מודעה לא נמצאה', true); return; }
    if (r.payment_status === 'settled') { toast('כבר סומן כשולם'); return; }
    const usePkg = !!r.package_id;
    const grp = usePkg ? await run(db.from('classified_ads').select('*').eq('package_id', r.package_id)) : [r];
    for (const a of grp) {
      if (Number(a.price) > 0) {
        let chargeId = a.charge_id;
        if (!chargeId) {
          const cust = (cache.customers || []).find(x => x.id === a.customer_id) || {};
          const ins = await run(db.from('charges').insert({
            customer_id: a.customer_id, amount: a.price,
            description: 'מודעת לוח — גיליון ' + ((cache.issues.find(i => i.id === a.issue_id) || {}).issue_number || ''),
            issued_date: today(), due_date: today(), status: 'paid', invoice_number: null,
            agent_id: cust.agent_id || null, notes: 'מודעת לוח — שולם #cl' + a.id,
          }).select('id').single());
          chargeId = ins.id;
          await db.from('classified_ads').update({ charge_id: chargeId }).eq('id', a.id);
        } else {
          await db.from('charges').update({ status: 'paid' }).eq('id', chargeId);
        }
        const existP = (await db.from('payments').select('id').eq('charge_id', chargeId).limit(1)).data;
        if (!existP || !existP.length) {
          await db.from('payments').insert({ charge_id: chargeId, customer_id: a.customer_id, amount: a.price, method: _clPayMethod(), paid_date: today(), notes: 'מודעת לוח — שולם', created_by: profile.id });
        }
      }
    }
    if (usePkg) await db.from('classified_ads').update({ payment_status: 'settled' }).eq('package_id', r.package_id);
    else await db.from('classified_ads').update({ payment_status: 'settled' }).eq('id', id);
    try { await addInteraction('customer', r.customer_id, '💰 מודעת לוח — סומן שולם (נכנס לגיליון)'); } catch (e) { }
    toast('✓ סומן כשולם — המודעה נכנסת לגיליון');
    openPage('classified');
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

/* ==================== עמוד מודעות לוח ==================== */
Pages.classified = {
  render: async (el) => {
    const canEdit = ['admin', 'sales', 'editor'].includes(profile.role);
    let rows = [], tableMissing = false;
    try {
      rows = await run(db.from('classified_ads').select('*').order('created_at', { ascending: false }).limit(400));
    } catch (e) { tableMissing = true; }

    el.innerHTML = `
      <div class="page-head">
        <h2>מודעות לוח</h2>
        <div class="actions">
          ${canEdit ? `<button class="btn" onclick="classifiedAdd()">+ מודעת לוח</button>` : ''}
          <button class="btn btn-ghost" onclick="classifiedSectionPick()">🖨️ הפקת מדור הלוח</button>
        </div>
      </div>
      ${tableMissing ? `<div class="card card-pad" style="border-right:4px solid var(--warn)">
        <b style="color:var(--warn)">התכונה כמעט מוכנה</b>
        <p class="muted" style="font-size:.88rem;margin-top:4px">טבלת מודעות הלוח עדיין לא נוצרה בבסיס הנתונים (ממתין לחזרת Supabase). התמחור והמחירון כבר פעילים; ברגע שהטבלה תיווצר — ההזנה וההפקה יעבדו במלואן.</p></div>` : ''}
      <div class="card card-pad" style="margin-bottom:12px">
        <b>מחירון:</b> <span class="muted">רגיל ${money(clBaseRegular())} · מודגש ${money(clBaseBold())} — עד 10 מילים · כל 10 מילים נוספות +${money(clExtraPer10())} · כולל מע"מ · מסלול 4+1 (5 במחיר 4)</span>
      </div>
      <div id="clQueue">${_clQueueHtml(rows)}</div>
      <div class="card" id="clTable"></div>`;

    if (!tableMissing) {
      renderTable(document.getElementById('clTable'), rows, [
        { h: 'לקוח', f: r => `<b>${esc(nameOf('customers', r.customer_id))}</b>` },
        { h: 'קטגוריה', f: r => _clCatHe(r.category) },
        { h: 'סוג', f: r => r.ad_type === 'bold' ? '<span class="pill blue">מודגש</span>' : 'רגיל' },
        { h: 'טקסט', f: r => esc((r.body || '').slice(0, 40)) + ((r.body || '').length > 40 ? '…' : '') },
        { h: 'מילים', f: r => r.word_count },
        { h: 'מחיר', f: r => money(r.price) },
        { h: 'גיליון', f: r => r.issue_id ? ('גיליון ' + ((cache.issues.find(i => i.id === r.issue_id) || {}).issue_number || '')) : '—' },
        {
          h: 'תשלום', f: r => r.payment_status === 'settled'
            ? '<span class="pill green">שולם ✓ · בגיליון</span>'
            : (r.status === 'rejected' ? '—'
              : (canEdit ? `<button class="btn btn-sm" style="background:var(--ok);color:#fff" onclick="event.stopPropagation();classifiedMarkPaid(${r.id})" title="סימון כשולם — רק אז המודעה נכנסת לגיליון">✓ שולם</button>`
                : '<span class="pill amber">ממתין לתשלום</span>'))
        },
        { h: 'סטטוס', f: r => r.status === 'rejected' ? '<span class="pill red">נדחה</span>' : r.status === 'pending' ? '<span class="pill amber">ממתין לאישור</span>' : r.status === 'published' ? '<span class="pill green">פורסם</span>' : '<span class="pill green">אושר</span>' },
      ], { onRow: canEdit ? (r => classifiedAdd(r.id)) : null, empty: 'אין עדיין מודעות לוח' });
    }
  }
};

/* ---------- טופס מודעת לוח עם תמחור חי ---------- */
function classifiedAdd(existingId) {
  const ex = existingId ? { id: existingId } : null;
  const issuesOpen = (cache.issues || []).filter(i => !['published', 'closed'].includes(i.status))
    .sort((a, b) => (a.issue_number || 0) - (b.issue_number || 0));
  document.getElementById('viewModal').innerHTML = `
    <h3>מודעת לוח חדשה</h3>
    <div class="grid2">
      <div class="field"><label>לקוח *</label><select id="clCust">${(cache.customers || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>קטגוריה *</label><select id="clCat">${CL_CATEGORIES.map(c => `<option value="${c.v}">${c.t}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>סוג *</label><select id="clType" onchange="classifiedRecalc()">
        <option value="regular">רגיל (${money(clBaseRegular())})</option>
        <option value="bold">מודגש (${money(clBaseBold())})</option></select></div>
      <div class="field"><label>גיליון *</label><select id="clIssue">${issuesOpen.map(i => `<option value="${i.id}">גיליון ${i.issue_number} · ${heDate(i.publish_date)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>טקסט המודעה *</label>
      <textarea id="clBody" rows="3" oninput="classifiedRecalc()" placeholder="לדוגמה: למכירה סלון מעור במצב מצוין, טלפון 05X-XXXXXXX"></textarea></div>
    <div class="card card-pad" style="background:#fbfdff;display:flex;justify-content:space-between;align-items:center;margin:6px 0">
      <span><b>מילים:</b> <span id="clWords">0</span></span>
      <span style="font-size:1.15rem"><b>מחיר (כולל מע"מ): <span id="clPrice" style="color:@@COLOR_DARK@@">${money(clBaseRegular())}</span></b></span>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="clPackage" onchange="classifiedRecalc()"> מסלול 4+1 (5 גיליונות במחיר 4)</label>
    <div id="clPkgNote" class="hidden muted" style="font-size:.82rem;margin-bottom:6px"></div>
    <div class="field"><label>הערות</label><textarea id="clNotes" rows="1"></textarea></div>
    <div class="m-actions" style="margin-top:10px">
      <button class="btn" onclick="classifiedSave()">שמירה</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  classifiedRecalc();
}

function classifiedRecalc() {
  const type = document.getElementById('clType').value;
  const words = clCountWords(document.getElementById('clBody').value);
  const single = clPrice(type, words);
  const pkg = document.getElementById('clPackage').checked;
  document.getElementById('clWords').textContent = words;
  const total = pkg ? single * 4 : single;
  document.getElementById('clPrice').textContent = money(total);
  const note = document.getElementById('clPkgNote');
  if (pkg) { note.classList.remove('hidden'); note.textContent = `5 פרסומים במחיר 4 — ${money(single)} × 4 = ${money(single * 4)} (הגיליון החמישי חינם).`; }
  else note.classList.add('hidden');
}

async function classifiedSave() {
  const customer_id = Number(document.getElementById('clCust').value) || null;
  const category = document.getElementById('clCat').value;
  const ad_type = document.getElementById('clType').value;
  const body = document.getElementById('clBody').value.trim();
  const issue_id = Number(document.getElementById('clIssue').value) || null;
  const pkg = document.getElementById('clPackage').checked;
  const notes = document.getElementById('clNotes').value || null;
  if (!customer_id || !body || !issue_id) { toast('נא למלא לקוח, טקסט וגיליון', true); return; }
  const words = clCountWords(body);
  const single = clPrice(ad_type, words);

  // גיליונות עוקבים למסלול 4+1
  let issues = [issue_id];
  if (pkg) {
    const openSorted = (cache.issues || []).filter(i => !['published', 'closed'].includes(i.status))
      .sort((a, b) => (a.issue_number || 0) - (b.issue_number || 0));
    const startIdx = openSorted.findIndex(i => i.id === issue_id);
    if (startIdx < 0) { toast('גיליון לא נמצא', true); return; }
    issues = openSorted.slice(startIdx, startIdx + 5).map(i => i.id);
    if (issues.length < 5) { toast('אין מספיק גיליונות פתוחים ל-4+1 (נדרשים 5)', true); return; }
  }
  const packageId = pkg ? Date.now() : null;
  const recs = issues.map((iid, idx) => ({
    customer_id, category, ad_type, body, word_count: words,
    // ב-4+1: הגיליון החמישי חינם
    price: pkg ? (idx < 4 ? single : 0) : single,
    issue_id: iid, package_id: packageId, status: 'approved',
    // רק מודעה ששולמה נכנסת לגיליון — מתחיל כ"ממתין לתשלום"
    payment_status: 'pending', source: 'staff',
    notes, created_by: profile.id,
  }));
  try {
    await run(db.from('classified_ads').insert(recs));
    toast(pkg ? '✓ נוצרו 5 מודעות (מסלול 4+1)' : '✓ מודעת הלוח נשמרה');
    document.getElementById('viewBack').classList.remove('open');
    openPage('classified');
  } catch (e) {
    if (/classified_ads|relation|does not exist|column/i.test(e.message || String(e)))
      toast('הטבלה עדיין לא נוצרה ב-DB — יופעל כשה-SQL יחזור', true);
    else toast('שגיאה: ' + (e.message || e), true);
  }
}

/* ---------- הפקת מדור "הלוח" ---------- */
function classifiedSectionPick() {
  const issues = (cache.issues || []).slice().sort((a, b) => (b.issue_number || 0) - (a.issue_number || 0));
  document.getElementById('viewModal').innerHTML = `
    <h3>🖨️ הפקת מדור הלוח</h3>
    <div class="field"><label>בחר גיליון</label>
      <select id="clSecIssue">${issues.map(i => `<option value="${i.id}">גיליון ${i.issue_number} · ${heDate(i.publish_date)}</option>`).join('')}</select></div>
    <div class="m-actions" style="margin-top:8px;flex-wrap:wrap">
      <button class="btn" onclick="classifiedSectionDesigned(Number(document.getElementById('clSecIssue').value))">🎨 עמוד מעוצב (הדפסה/PDF)</button>
      <button class="btn btn-ghost" onclick="classifiedSectionGen()">📄 טקסט להעתקה</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
    </div>
    <div id="clSecOut" style="margin-top:12px"></div>`;
  document.getElementById('viewBack').classList.add('open');
}

// בונה טקסט מדור מקובץ לפי קטגוריה (מודגש בסימון). מיוצא כפונקציה טהורה לבדיקה.
function buildClassifiedSection(rows, issueNumber) {
  const byCat = {};
  rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
  let out = `הלוח — לוח המודעות · גיליון ${issueNumber}\n`;
  out += '='.repeat(40) + '\n\n';
  let count = 0;
  for (const cat of CL_CATEGORIES) {
    const items = byCat[cat.v] || [];
    if (!items.length) continue;
    out += `【 ${cat.t} 】\n`;
    items.forEach(r => {
      const mark = r.ad_type === 'bold' ? '★ ' : '• ';
      out += `${mark}${(r.body || '').replace(/\s+/g, ' ').trim()}\n`;
      count++;
    });
    out += '\n';
  }
  if (!count) out += '(אין מודעות לוח בגיליון זה)\n';
  return out;
}

async function classifiedSectionGen() {
  const issueId = Number(document.getElementById('clSecIssue').value);
  const issue = (cache.issues || []).find(i => i.id === issueId) || {};
  let rows = [];
  try {
    rows = await run(db.from('classified_ads').select('*').eq('issue_id', issueId)
      .eq('payment_status', 'settled').not('status', 'in', '("rejected","cancelled")').order('category'));
  } catch (e) { toast('הטבלה עדיין לא נוצרה ב-DB', true); return; }
  const text = buildClassifiedSection(rows, issue.issue_number || '');
  const out = document.getElementById('clSecOut');
  out.innerHTML = `
    <textarea id="clSecText" rows="14" style="width:100%;font-family:monospace;direction:rtl">${esc(text)}</textarea>
    <div class="m-actions" style="margin-top:6px">
      <button class="btn btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('clSecText').value).then(()=>toast('הועתק ✓'))">📋 העתק</button>
      <button class="btn btn-sm btn-ghost" onclick="classifiedSectionDownload(${issueId})">⬇ הורדה כקובץ</button>
    </div>`;
}

/* אומדן מספר עמודים שהמדור תופס (רגיל=1 · מודגש=1.5 · תמונה=6 יח'; ~120 יח' לעמוד) */
function _clPageEstimate(rows) {
  let units = 0;
  rows.forEach(r => { units += r.ad_type === 'image' ? 6 : r.ad_type === 'bold' ? 1.5 : 1; });
  return Math.max(1, Math.ceil(units / 120));
}

/* ---------- הפקת מדור לוח מעוצב (HTML מוכן להדפסה / שמירה כ-PDF) ---------- */
async function classifiedSectionDesigned(issueId) {
  if (!issueId) { toast('בחר/י גיליון', true); return; }
  const issue = (cache.issues || []).find(i => i.id === issueId) || {};
  let rows = [];
  try {
    rows = await run(db.from('classified_ads').select('*').eq('issue_id', issueId)
      .eq('payment_status', 'settled').not('status', 'in', '("rejected","cancelled")').order('category'));
  } catch (e) { toast('שגיאה בטעינת המודעות', true); return; }
  if (!rows.length) { toast('אין מודעות ששולמו בגיליון זה (רק מודעה ששולמה נכנסת למדור)', true); return; }
  toast('בונה עמוד מעוצב...');
  // קישורים חתומים לתמונות
  for (const r of rows) {
    if (r.image_path) { try { const { data } = await db.storage.from('ad-files').createSignedUrl(r.image_path, 3600); r._img = data ? data.signedUrl : ''; } catch (e) { r._img = ''; } }
  }
  const byCat = {}; rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
  const activeCats = CL_CATEGORIES.filter(c => (byCat[c.v] || []).length);
  const CATCOLORS = ['@@COLOR_DARK@@', '@@COLOR_GRAD@@', '@@COLOR_BRAND@@', '@@COLOR_GRAD@@', '@@COLOR_GRAD@@', '@@COLOR_BRAND@@'];
  const catColor = i => CATCOLORS[i % CATCOLORS.length];
  const catBlocks = activeCats.map((c, i) => {
    const ads = byCat[c.v].map(r => {
      const body = esc((r.body || '').replace(/\s+/g, ' ').trim());
      if (r.ad_type === 'image' && r._img) return `<div class="ad img"><img src="${r._img}" alt=""><div>${body}</div></div>`;
      if (r.ad_type === 'bold') return `<div class="ad bold">${body}</div>`;
      return `<div class="ad reg">${body}</div>`;
    }).join('');
    return `<div class="box"><div class="bh" style="background:${catColor(i)}">${esc(c.t)}</div><div class="bc">${ads}</div></div>`;
  }).join('');
  const tagRow = activeCats.map((c, i) => `<span class="tag" style="background:${catColor(i)}">${esc(c.t)}</span>`).join('');
  const pReg = Number((cache.settings || {}).classified_portal_regular) || 25;
  const pBold = Number((cache.settings || {}).classified_portal_bold) || 35;
  const pages = _clPageEstimate(rows);
  const dateHe = issue.publish_date ? (typeof heDate === 'function' ? heDate(issue.publish_date) : issue.publish_date) : '';
  const html = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>הלוח — @@PAPER_NAME@@ · גיליון ${esc(String(issue.issue_number || ''))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--navy:@@COLOR_DARK@@;--brand:@@COLOR_BRAND@@;--red:@@COLOR_GRAD@@;--lav:@@COLOR_LIGHT@@;--ink:#1c2036;--line:#d5d8ee;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Heebo',Arial,sans-serif;background:var(--lav);color:var(--ink);}
.toolbar{position:sticky;top:0;background:var(--navy);padding:9px;text-align:center;z-index:9;}
.toolbar button{font-family:inherit;font-size:1rem;font-weight:800;background:var(--red);color:#fff;border:none;border-radius:8px;padding:9px 22px;cursor:pointer;}
.page{max-width:960px;margin:14px auto;background:#fff;box-shadow:0 3px 18px rgba(29,39,101,.12);overflow:hidden;border-radius:6px;}
.confetti{height:14px;background:repeating-linear-gradient(135deg,var(--navy) 0 13px,var(--red) 13px 26px,var(--brand) 26px 39px,#c9cce6 39px 52px);}
.head{text-align:center;padding:16px 16px 8px;position:relative;}
.head .hlogo{font-size:2.7rem;font-weight:900;color:var(--red);letter-spacing:-1.5px;line-height:1;-webkit-text-stroke:1.5px var(--navy);}
.head .hsub{font-size:1.05rem;font-weight:700;color:var(--navy);margin-top:3px;}
.head .hsub b{font-weight:900;} .head .hsub span{color:var(--red);}
.head .badge{position:absolute;top:12px;left:18px;background:var(--red);color:#fff;font-weight:900;border-radius:50%;width:58px;height:58px;display:flex;align-items:center;justify-content:center;transform:rotate(-12deg);font-size:.82rem;box-shadow:0 3px 7px rgba(0,0,0,.25);text-align:center;line-height:1.05;}
.pricebar{background:var(--navy);color:#fff;text-align:center;font-size:.8rem;font-weight:500;padding:7px 12px;}
.pricebar b{color:#ffd451;font-weight:800;}
.tagrow{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:10px 14px;background:#f3f4fc;border-bottom:1px solid var(--line);}
.tag{color:#fff;font-size:.75rem;font-weight:700;padding:3px 13px;border-radius:99px;}
.grid{column-count:3;column-gap:14px;padding:14px;}
.box{border:1.5px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:12px;break-inside:avoid;}
.box .bh{color:#fff;font-weight:800;padding:6px 12px;font-size:.98rem;}
.box .bc{padding:8px 10px;}
.ad{font-size:.82rem;line-height:1.44;margin-bottom:6px;}
.ad.reg{border-bottom:1px dotted var(--line);padding-bottom:5px;}
.ad.reg::before{content:"\\25C2";color:var(--red);font-weight:800;margin-inline-end:5px;font-size:.68rem;}
.ad.bold{background:#fff4f4;border:1.5px solid var(--red);border-radius:7px;padding:7px 9px;font-weight:800;color:var(--navy);}
.ad.img{border:1px solid var(--line);border-radius:7px;padding:6px;text-align:center;}
.ad.img img{max-width:100%;max-height:110px;border-radius:5px;margin-bottom:4px;}
.foot{border-top:2px solid var(--navy);padding:9px 14px;text-align:center;color:#8890b5;font-size:.76rem;}
@media print{
  body{background:#fff;} .toolbar{display:none;}
  .page{box-shadow:none;margin:0;max-width:none;border-radius:0;}
  .grid{column-count:3;} @page{size:A4;margin:8mm;}
}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">🖨️ הדפסה / שמירה כ-PDF</button></div>
<div class="page">
  <div class="confetti"></div>
  <div class="head">
    <div class="badge">שווה<br>לך</div>
    <div class="hlogo">הלוח</div>
    <div class="hsub">לוח המודעות של <b>@@PAPER_NAME@@</b> · גיליון ${esc(String(issue.issue_number || ''))}${dateHe ? ' · ' + esc(dateHe) : ''}</div>
  </div>
  <div class="pricebar">מחירון: עד 10 מילים <b>${pReg} ₪</b> · מודגש <b>${pBold} ₪</b> · כל 10 מילים נוספות +10 ₪ · המחירים כוללים מע"מ &nbsp;|&nbsp; לשליחת מודעה: @@PAPER_PHONE@@</div>
  <div class="tagrow">${tagRow}</div>
  <div class="grid">${catBlocks}</div>
  <div class="foot">לוח פרסום · @@PAPER_NAME@@ · @@PAPER_PHONE@@ &nbsp;|&nbsp; ${rows.length} מודעות · כ-${pages} עמ'</div>
</div></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) {
    const a = document.createElement('a'); a.href = url;
    a.download = 'לוח_מעוצב_גיליון_' + (issue.issue_number || issueId) + '.html'; a.click();
    toast('החלון הקופץ נחסם — הורדתי קובץ HTML (פותחים ומדפיסים ל-PDF)');
    return;
  }
  toast('✓ עמוד מעוצב מוכן — ' + rows.length + ' מודעות · כ-' + pages + ' עמ׳');
}

function classifiedSectionDownload(issueId) {
  const issue = (cache.issues || []).find(i => i.id === issueId) || {};
  const text = document.getElementById('clSecText').value;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `לוח_גיליון_${issue.issue_number || issueId}.txt`;
  a.click();
}

/* הוספת פריט לתפריט (NAV מערך גלובלי מ-app.js) */
(function () {
  if (typeof NAV !== 'undefined' && !NAV.some(n => n.id === 'classified')) {
    // אחרי "מודעות"
    const idx = NAV.findIndex(n => n.id === 'ads');
    const item = { id: 'classified', title: 'מודעות לוח', icon: '🗒️', roles: ['admin', 'sales', 'editor'], group: 'עיתון' };
    if (idx >= 0) NAV.splice(idx + 1, 0, item); else NAV.push(item);
  }
})();
