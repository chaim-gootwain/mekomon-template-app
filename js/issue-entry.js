/* ============================================================
issue-entry.js — הזנת מודעות לגיליון (מהיר, עם חיפוש לקוח)
------------------------------------------------------------
- חיפוש לקוח קיים (שם/טלפון) או פתיחת לקוח חדש
- בחירת גודל + מחיר (אוטומטי מהמחירון) + שיבוץ לעמוד
- שלב עסקה (deal_stage): באמצע עסקה / סוכם / חשבונית הופקה / שולם
- בדיקת חשבונית של הלקוח (מתוך החיובים)
- כל הזנה מקושרת ללקוח ולגיליון ומופיעה בכרטסת + ציר הזמן
דורש עמודה: alter table ads add column deal_stage text;
============================================================ */
'use strict';

const DEAL_STAGES = {
  in_progress: ['🟡 באמצע עסקה', 'amber'],
  agreed: ['🔵 סוכם', 'blue'],
  invoiced: ['🟣 חשבונית הופקה', 'gold'],
  paid: ['🟢 שולם', 'green'],
};
function dealStageLabel(v) { const d = DEAL_STAGES[v]; return d ? d[0] : ''; }

let _ieIssue = null, _ieAds = [], _ieCust = null, _ieCharges = null;
let _ieContract = null, _ieContractUsed = 0;

async function openIssueEntry(issueId) {
  _ieIssue = (typeof _issues !== 'undefined' ? _issues : []).find(i => i.id === issueId)
    || (cache.issues || []).find(i => i.id === issueId)
    || await run(db.from('issues').select('*').eq('id', issueId).single());
  _ieCust = null; _ieCharges = null;
  _ieAds = await run(db.from('ads').select('*').eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")').order('created_at', { ascending: false }));
  _iePaint();
}

function _iePaint() {
  const el = document.getElementById('content'); if (!el || !_ieIssue) return;
  const canWrite = ['admin', 'editor', 'sales'].includes(profile.role);
  const priceOpts = (cache.priceList || []).map(p => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}</option>`).join('');
  const stageOpts = Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}">${t[0]}</option>`).join('');

  el.innerHTML = `
<div class="page-head">
<h2>הזנת מודעות — גיליון ${_ieIssue.issue_number} <span class="muted" style="font-size:.9rem">(${_ieAds.length} מודעות)</span></h2>
<div class="actions">
<button class="btn btn-ghost btn-sm" onclick="openFlatplan(${_ieIssue.id})">→ לפלטפלן</button>
<button class="btn btn-ghost btn-sm" onclick="openPage('issues')">רשימת גיליונות</button>
${_dealInProgressCount(_ieAds) ? `<button class="btn btn-sm" onclick="dealReviewOpen(${_ieIssue.id})">🟡 עסקאות באמצע (${_dealInProgressCount(_ieAds)})</button>` : ''}
</div>
</div>

${canWrite ? `<div class="card card-pad" style="margin-bottom:16px">
<b>הוספת מודעה</b>
<div class="grid2" style="margin-top:10px;align-items:start">
<div class="field" style="position:relative">
<label>לקוח</label>
<div id="ieCustBox">${_ieCustPickerHtml()}</div>
</div>
<div class="field"><label>גודל (מהמחירון)</label>
<select id="ieSize" onchange="ieSizeChange()"><option value="">— בחר —</option>${priceOpts}</select></div>
<div class="field"><label>מחיר (₪)</label><input id="iePrice" type="number" dir="ltr"></div>
<div class="field"><label>שם/כותרת המודעה (ריק = שם הלקוח)</label><input id="ieTitle" placeholder="ברירת מחדל: שם הלקוח"></div>
<div class="field"><label>עמוד (שיבוץ — אופציונלי)</label><input id="iePage" type="number" dir="ltr" placeholder="ריק = לא משובץ"></div>
<div class="field"><label>שלב עסקה</label><select id="ieStage">${stageOpts}</select></div>
<div class="field"><label>עסקה: סה"כ פרסומים (רק אם פותחים עסקה חדשה)</label><input id="ieDealTotal" type="number" dir="ltr" placeholder="למשל 10"></div>
<div class="field"><label>הערה / מיקום מבוקש (מוצג בריחוף — לא בשם המודעה)</label><input id="ieDesc"></div>
<div class="field"><label>הנחיה לעיצוב (אם נשאר ריק — המודעה תעבור לוועדה במקום לגרפיקה)</label><textarea id="ieGfxNote" rows="2" placeholder="למשל: לפי הפרסום הקודם / קובץ מצורף / הנחיות ללקוח..."></textarea></div>
</div>
<div class="m-actions" style="margin-top:10px">
<button class="btn" onclick="ieAddAd()">＋ הוסף מודעה לגיליון</button>
</div>
</div>` : ''}

<div class="card" id="ieList"></div>`;

  _ieDrawList();
}

/* ----- בורר לקוח ----- */
function _ieCustPickerHtml() {
  if (_ieCust) {
    const inv = _ieCharges == null ? '<span class="muted">בודק חשבונית…</span>' : _ieInvoiceBadge();
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:8px 10px">
      <b>${esc(_ieCust.name)}</b>${_ieCust.phone ? ` <span class="muted" dir="ltr" style="font-size:.82rem">${esc(_ieCust.phone)}</span>` : ''}
      ${inv} ${_ieDealBadge()}
      <button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="ieClearCust()">שנה</button>
    </div>`;
  }
  return `<input id="ieSearch" autocomplete="off" placeholder="הקלד/י שם עסק או טלפון…" oninput="ieSearchCust(this.value)">
    <div id="ieResults" class="search-results" style="position:absolute;left:0;right:0;z-index:20;max-height:240px;overflow:auto"></div>
    <div style="margin-top:6px"><button class="btn btn-sm btn-ghost" onclick="ieNewCustomer()">＋ לקוח חדש</button></div>`;
}

function _ieInvoiceBadge() {
  if (!_ieCharges) return '';
  const issued = _ieCharges.filter(c => ['invoiced', 'paid', 'partial', 'overdue'].includes(c.status));
  const open = _ieCharges.filter(c => ['pending', 'invoiced', 'partial', 'overdue'].includes(c.status));
  if (issued.length) return `<span class="pill gold" title="ללקוח יש חשבונית/חיוב פעיל">🧾 יש חשבונית (${issued.length})</span>`;
  if (open.length) return `<span class="pill amber">חיוב ממתין להפקה</span>`;
  return `<span class="pill">אין חשבונית פתוחה</span>`;
}

function ieSearchCust(q) {
  const box = document.getElementById('ieResults'); if (!box) return;
  q = (q || '').trim();
  if (q.length < 1) { box.innerHTML = ''; return; }
  const list = (cache.customers || []).filter(c =>
    (c.name || '').includes(q) || (c.phone || '').includes(q)).slice(0, 8);
  box.innerHTML = list.length ? list.map(c => `<div class="search-item" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f1f5f9" onclick="ieSelectCust(${c.id})"><b>${esc(c.name)}</b>${c.phone ? ` <span class="muted" dir="ltr" style="font-size:.8rem">${esc(c.phone)}</span>` : ''}</div>`).join('')
    : `<div style="padding:8px 10px" class="muted">אין תוצאה — <a style="cursor:pointer;color:var(--brand)" onclick="ieNewCustomer('${esc(q).replace(/'/g, '')}')">פתח/י לקוח חדש</a></div>`;
}

async function ieSelectCust(id) {
  _ieCust = (cache.customers || []).find(c => c.id === id) || null;
  _ieCharges = null; _ieContract = null; _ieContractUsed = 0;
  const box = document.getElementById('ieCustBox'); if (box) box.innerHTML = _ieCustPickerHtml();
  try { _ieCharges = await run(db.from('charges').select('status').eq('customer_id', id)); } catch (e) { _ieCharges = []; }
  try {
    const cons = await run(db.from('contracts').select('*').eq('customer_id', id).eq('active', true).order('start_date', { ascending: false }));
    _ieContract = (cons && cons[0]) || null;
    if (_ieContract) { const r = await db.from('ads').select('id', { count: 'exact', head: true }).eq('contract_id', _ieContract.id).not('status', 'in', '("cancelled","rejected")'); _ieContractUsed = (r.count || 0) + (Number(_ieContract.used_offset) || 0); }
  } catch (e) { _ieContract = null; }
  const box2 = document.getElementById('ieCustBox'); if (box2) box2.innerHTML = _ieCustPickerHtml();
}

/* תג התקדמות העסקה (חוזה) של הלקוח הנבחר */
function _ieDealBadge() {
  if (!_ieContract) return '';
  const tot = _ieContract.total_inserts || 0, used = _ieContractUsed;
  if (tot && used >= tot) return `<span class="pill red" title="העסקה נוצלה במלואה">📄 עסקה ${used}/${tot} — ⚠ לחדש</span>`;
  return `<span class="pill blue" title="פרסומים שנוצלו מתוך העסקה">📄 עסקה: ${used}/${tot}</span>`;
}

function ieClearCust() { _ieCust = null; _ieCharges = null; _ieContract = null; _ieContractUsed = 0; const box = document.getElementById('ieCustBox'); if (box) box.innerHTML = _ieCustPickerHtml(); }

function ieNewCustomer(preName) {
  /* פותח את חלון "לקוח חדש" המלא (ח.פ, שם לחשבונית, כתובת וכו') כדי שלא נצטרך להשלים פרטים בזמן החשבונית */
  if (typeof customerCreateFull === 'function') {
    customerCreateFull(preName, async (data) => { await ieSelectCust(data.id); toast('✓ לקוח נוסף ונבחר'); });
    return;
  }
  openForm('לקוח חדש', [
    { name: 'name', label: 'שם העסק', required: true, default: preName || '' },
    { name: 'phone', label: 'טלפון', dir: 'ltr' },
    { name: 'field', label: 'תחום' },
    { name: 'agent_id', label: 'סוכן', type: 'select', options: 'agents' },
  ], {}, async (rec) => {
    const data = await run(db.from('customers').insert(rec).select().single());
    try { await addInteraction('customer', data.id, 'הלקוח נוצר (מהזנת גיליון)'); } catch (e) { }
    await refreshCache();
    await ieSelectCust(data.id);
    toast('✓ לקוח נוסף ונבחר');
  });
}

/* ----- מחיר אוטומטי לפי גודל ----- */
function ieSizeChange() {
  const sel = document.getElementById('ieSize'); const pr = document.getElementById('iePrice');
  if (!sel || !pr) return;
  const item = (cache.priceList || []).find(p => p.id === Number(sel.value));
  if (item && !pr.value) pr.value = item.price;
  else if (item) pr.value = item.price;
}

/* ----- הוספת מודעה ----- */
async function ieAddAd() {
  if (!_ieCust) { toast('בחר/י לקוח קודם', true); return; }
  const sizeId = Number(document.getElementById('ieSize').value) || null;
  if (!sizeId) { toast('בחר/י גודל מודעה', true); return; }
  const _rawPrice = (document.getElementById('iePrice').value || '').trim();
  let price;
  if (_rawPrice === '') { const it = (cache.priceList || []).find(p => p.id === sizeId); price = it ? Number(it.price) : 0; }
  else { price = Number(_rawPrice); if (isNaN(price)) price = 0; }
  const page = Number(document.getElementById('iePage').value) || null;
  const stage = document.getElementById('ieStage').value || 'in_progress';
  const desc = (document.getElementById('ieDesc').value || '').trim();
  const gfxNote = (document.getElementById('ieGfxNote') ? document.getElementById('ieGfxNote').value : '' || '').trim();
  const _title = (document.getElementById('ieTitle') ? document.getElementById('ieTitle').value : '' || '').trim();
  let discount = 0;
  if (typeof custFixedDiscountAmount === 'function') discount = custFixedDiscountAmount(_ieCust.id, price) || 0;
  // עסקה (חוזה): קישור אוטומטי אם קיימת עסקה פעילה שלא נוצלה; אחרת — פתיחת עסקה חדשה לפי סה"כ שהוזן
  let _contractId = (_ieContract && _ieContractUsed < (_ieContract.total_inserts || 0)) ? _ieContract.id : null;
  const _dealTotal = Number((document.getElementById('ieDealTotal') || {}).value) || 0;
  if (!_contractId && _dealTotal >= 2) {
    try {
      const _c = await run(db.from('contracts').insert({ customer_id: _ieCust.id, agent_id: _ieCust.agent_id || null, price_item_id: sizeId, total_inserts: _dealTotal, total_price: (price || 0) * _dealTotal, active: true, cadence: 'every', start_date: today(), created_by: profile.id, notes: 'נפתחה מהזנת גיליון' }).select().single());
      _contractId = _c.id; _ieContract = _c; _ieContractUsed = 0;
      try { await addInteraction('customer', _ieCust.id, `נפתחה עסקה: ${nameOf('priceList', sizeId)} × ${_dealTotal} פרסומים`); } catch (e) { }
    } catch (e) { }
  }
  const rec = {
    customer_id: _ieCust.id,
    title: _title || _ieCust.name,
    price_item_id: sizeId, price, discount,
    agent_id: _ieCust.agent_id || null,
    requested_placement: desc || null,
    issue_id: _ieIssue.id,
    page_number: page,
    status: page ? 'placed' : (gfxNote ? 'in_graphics' : 'committee'),
    graphics_note: gfxNote || null,
    deal_stage: stage,
    contract_id: _contractId,
    created_by: profile.id,
  };
  try {
    let data;
    try { data = await db.from('ads').insert(rec).select().single().then(r => { if (r.error) throw r.error; return r.data; }); }
    catch (e1) {
      if (String(e1.message || e1).includes('deal_stage')) { const r2 = { ...rec }; delete r2.deal_stage; data = await run(db.from('ads').insert(r2).select().single()); toast('נשמר (שדה שלב-עסקה יופעל לאחר עדכון קצר)', true); }
      else throw e1;
    }
    try { await addInteraction('customer', _ieCust.id, `מודעה לגיליון ${_ieIssue.issue_number} (${nameOf('priceList', sizeId)}) — ${dealStageLabel(stage)}${page ? ' · עמוד ' + page : ''}`); } catch (e) { }
    _ieAds.unshift(data);
    if (_contractId) _ieContractUsed++;
    toast('✓ המודעה נוספה' + (_contractId ? ' · עסקה ' + _ieContractUsed + '/' + (_ieContract.total_inserts || '?') : ''));
    // איפוס טופס, שמירת הלקוח לבחירה מהירה של עוד מודעה
    _iePaint();
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

/* ----- רשימת המודעות שהוזנו ----- */
function _ieDrawList() {
  const el = document.getElementById('ieList'); if (!el) return;
  if (!_ieAds.length) { el.innerHTML = '<div class="empty">עדיין לא הוזנו מודעות לגיליון זה</div>'; return; }
  const canWrite = ['admin', 'editor', 'sales'].includes(profile.role);
  el.innerHTML = `<div class="table-wrap"><table class="data">
<thead><tr><th>לקוח</th><th>גודל</th><th>מחיר</th><th>עמוד</th><th>שלב עסקה</th>${canWrite ? '<th></th>' : ''}</tr></thead>
<tbody>${_ieAds.map(a => {
    const st = DEAL_STAGES[a.deal_stage];
    return `<tr>
<td><b>${esc(nameOf('customers', a.customer_id) || a.title)}</b></td>
<td>${esc(nameOf('priceList', a.price_item_id)) || '—'}</td>
<td>${money((a.price || 0) - (a.discount || 0))}</td>
<td>${a.page_number ? "עמ' " + a.page_number : '<span class="muted">—</span>'}</td>
<td>${canWrite ? `<select onchange="ieSetStage(${a.id}, this.value)" style="font-size:.82rem">${Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}" ${a.deal_stage === v ? 'selected' : ''}>${t[0]}</option>`).join('')}</select>` : (st ? `<span class="pill ${st[1]}">${st[0]}</span>` : '—')}</td>
${canWrite ? `<td style="white-space:nowrap"><button class="btn btn-sm btn-ghost" onclick="ieDealEdit(${a.customer_id})">✎ עסקה</button> <button class="btn btn-sm btn-danger-ghost" onclick="ieDelAd(${a.id})">🗑</button></td>` : ''}
</tr>`;
  }).join('')}</tbody></table></div>`;
}

async function ieSetStage(adId, stage) {
  const up = await db.from('ads').update({ deal_stage: stage }).eq('id', adId);
  if (up.error) { toast('שלב-העסקה יופעל לאחר עדכון קצר', true); return; }
  const a = _ieAds.find(x => x.id === adId); if (a) a.deal_stage = stage;
  try { await addInteraction('customer', a.customer_id, `שלב העסקה עודכן ל: ${dealStageLabel(stage)} (גיליון ${_ieIssue.issue_number})`); } catch (e) { }
  toast('✓ עודכן שלב העסקה');
}

async function ieDelAd(adId) {
  if (!confirm('להסיר את המודעה מהגיליון?')) return;
  await run(db.from('ads').update({ status: 'cancelled' }).eq('id', adId));
  _ieAds = _ieAds.filter(x => x.id !== adId);
  toast('הוסרה');
  _iePaint();
}

/* ============================================================
   אשף "עסקאות באמצע" — עובר אחת-אחת על כל המודעות שסומנו
   'באמצע עסקה' בגיליון, מציג סטטוס חשבונית, ומאפשר לעדכן שלב.
   ============================================================ */
let _drQueue = [], _drIdx = 0, _drIssue = null, _drCharges = {}, _drDeal = {};

function _dealInProgressCount(ads) { return (ads || []).filter(a => a.deal_stage === 'in_progress').length; }

async function dealReviewOpen(issueId) {
  _drIssue = (typeof _issues !== 'undefined' ? _issues : []).find(i => i.id === issueId)
    || (cache.issues || []).find(i => i.id === issueId)
    || (typeof _fpIssue !== 'undefined' ? _fpIssue : null)
    || (typeof _ieIssue !== 'undefined' ? _ieIssue : null);
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).eq('deal_stage', 'in_progress').not('status', 'in', '("cancelled","rejected")').order('customer_id'));
  if (!ads.length) { toast('אין מודעות מסומנות "באמצע עסקה" בגיליון זה 👍', true); return; }
  _drQueue = ads; _drIdx = 0;
  _drShow();
}

function _drInvBadge(ch) {
  const issued = ch.filter(c => ['invoiced', 'paid', 'partial', 'overdue'].includes(c.status));
  const open = ch.filter(c => ['pending'].includes(c.status));
  if (issued.length) return `<span class="pill gold">🧾 יש חשבונית (${issued.length})</span>`;
  if (open.length) return `<span class="pill amber">חיוב ממתין להפקה</span>`;
  return `<span class="pill">אין חשבונית עדיין</span>`;
}

async function _drLoadInv(custId) {
  try { _drCharges[custId] = await run(db.from('charges').select('status').eq('customer_id', custId)); }
  catch (e) { _drCharges[custId] = []; }
  try {
    const cons = await run(db.from('contracts').select('id,total_inserts,active').eq('customer_id', custId).eq('active', true).order('start_date', { ascending: false }));
    const con = cons && cons[0];
    if (con) { const r = await db.from('ads').select('id', { count: 'exact', head: true }).eq('contract_id', con.id).not('status', 'in', '("cancelled","rejected")'); _drDeal[custId] = { total: con.total_inserts || 0, used: (r.count || 0) + (Number(con.used_offset) || 0) }; }
    else _drDeal[custId] = null;
  } catch (e) { _drDeal[custId] = null; }
  if (_drQueue[_drIdx] && _drQueue[_drIdx].customer_id === custId) _drShow();
}
function _drDealHtml(custId) {
  const d = _drDeal[custId];
  if (d === undefined) return '';
  if (!d) return '<span class="muted" style="font-size:.82rem">אין עסקה פעילה רשומה</span>';
  const done = d.total && d.used >= d.total;
  return `<span class="pill ${done ? 'red' : 'blue'}">📄 עסקה: ${d.used}/${d.total}${done ? ' — ⚠ לחדש' : ''}</span>`;
}

function _drShow() {
  if (_drIdx >= _drQueue.length) { _drClose(); toast('✓ סיימת לעבור על כל העסקאות שבאמצע'); return; }
  const a = _drQueue[_drIdx];
  const cust = (cache.customers || []).find(c => c.id === a.customer_id) || { name: 'לקוח #' + a.customer_id, id: a.customer_id };
  let ov = document.getElementById('drOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'drOverlay'; document.body.appendChild(ov); }
  ov.className = 'ctag-overlay';
  const inv = _drCharges[a.customer_id];
  const invHtml = inv === undefined ? '<span class="muted">בודק חשבונית…</span>' : _drInvBadge(inv);
  ov.innerHTML = `<div class="ctag-box" style="max-width:520px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">🟡 עסקה באמצע — ${_drIdx + 1} מתוך ${_drQueue.length}${_drIssue ? ' · גיליון ' + _drIssue.issue_number : ''}</h3>
      <button class="btn btn-sm btn-ghost" onclick="_drClose()">✕</button>
    </div>
    <div style="margin-top:12px;font-size:1.1rem"><b>${esc(cust.name)}</b>${cust.phone ? ` <span class="muted" dir="ltr" style="font-size:.85rem">${esc(cust.phone)}</span>` : ''}</div>
    <div style="margin-top:4px;color:#475569">מודעה: ${esc(nameOf('priceList', a.price_item_id)) || '—'} · ${money((a.price || 0) - (a.discount || 0))}${a.page_number ? " · עמ' " + a.page_number : ' · טרם שובצה'}</div>
    <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">חשבונית: ${invHtml}</div>
    <div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">עסקה: ${_drDealHtml(a.customer_id)}</div>
    <div class="field" style="margin-top:14px"><label>מה סטטוס העסקה עכשיו?</label>
      <select id="drStage">${Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}" ${a.deal_stage === v ? 'selected' : ''}>${t[0]}</option>`).join('')}</select></div>
    <div class="m-actions" style="justify-content:space-between;flex-wrap:wrap;margin-top:16px;gap:8px">
      <span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm" onclick="ieDealEdit(${a.customer_id}, {closeWizard:true})">✎ פרטי העסקה</button><button class="btn btn-sm btn-ghost" onclick="_drOpenCard()">📇 כרטיס מלא</button></span>
      <span style="display:flex;gap:8px">
        <button class="btn btn-sm btn-ghost" onclick="_drSkip()">דלג</button>
        <button class="btn btn-sm" onclick="_drSave()">שמור והבא ←</button>
      </span>
    </div>
    <p class="muted" style="font-size:.76rem;margin:10px 0 0;text-align:center">${_drQueue.length - _drIdx - 1} עסקאות נוספות ממתינות</p>
  </div>`;
  if (inv === undefined) _drLoadInv(a.customer_id);
}

async function _drSave() {
  const a = _drQueue[_drIdx];
  const stage = document.getElementById('drStage') ? document.getElementById('drStage').value : a.deal_stage;
  if (stage && stage !== a.deal_stage) {
    await run(db.from('ads').update({ deal_stage: stage }).eq('id', a.id));
    a.deal_stage = stage;
    try { await addInteraction('customer', a.customer_id, `שלב העסקה עודכן ל: ${dealStageLabel(stage)}${_drIssue ? ' (גיליון ' + _drIssue.issue_number + ')' : ''}`); } catch (e) { }
    toast('✓ עודכן');
  }
  _drIdx++;
  _drShow();
}

function _drSkip() { _drIdx++; _drShow(); }
function _drClose() { const ov = document.getElementById('drOverlay'); if (ov) ov.remove(); }
function _drOpenCard() {
  const a = _drQueue[_drIdx]; _drClose();
  if (typeof openCustomerCard === 'function') openCustomerCard(a.customer_id);
}

/* ============================================================
   עורך פרטי העסקה (חוזה) של לקוח — פתיחה/עריכה, כולל מודל חיוב.
   נגיש מהאשף "עסקאות באמצע" ומטבלת ההזנה.
   ============================================================ */
async function ieDealEdit(custId, opts) {
  opts = opts || {};
  const cust = (cache.customers || []).find(c => c.id === custId) || { id: custId, name: 'לקוח #' + custId };
  let con = null;
  try { const cons = await run(db.from('contracts').select('*').eq('customer_id', custId).eq('active', true).order('start_date', { ascending: false })); con = (cons && cons[0]) || null; } catch (e) { }
  if (opts.closeWizard && typeof _drClose === 'function') _drClose();
  openForm((con ? 'עריכת עסקה — ' : 'פתיחת עסקה — ') + cust.name, [
    { name: 'price_item_id', label: 'גודל מודעה בעסקה', type: 'select', options: 'priceList' },
    { name: 'total_inserts', label: 'סה"כ פרסומים בעסקה', type: 'number', required: true },
    { name: 'total_price', label: 'מחיר מוסכם כולל (₪)', type: 'number' },
    { name: 'billing_mode', label: 'מודל חיוב', type: 'select', options: [{ v: 'upfront', t: 'מראש (חשבונית אחת לחבילה)' }, { v: 'per_ad', t: 'פר-מודעה' }] },
    { name: 'notes', label: 'הערות', type: 'textarea' },
  ], con || { billing_mode: 'upfront' }, async (rec) => {
    const payload = {
      customer_id: custId, agent_id: cust.agent_id || null,
      price_item_id: rec.price_item_id || (con && con.price_item_id) || null,
      total_inserts: Number(rec.total_inserts) || 0,
      total_price: Number(rec.total_price) || 0,
      billing_mode: rec.billing_mode || 'upfront',
      active: true, cadence: (con && con.cadence) || 'every',
      start_date: (con && con.start_date) || today(),
      notes: rec.notes || null, created_by: profile.id,
    };
    let cid = con ? con.id : null;
    async function saveContract(pl) {
      if (cid) { const { error } = await db.from('contracts').update(pl).eq('id', cid); return { error }; }
      const { data, error } = await db.from('contracts').insert(pl).select().single(); if (!error && data) cid = data.id; return { error };
    }
    let { error } = await saveContract(payload);
    if (error && /billing_mode|column/i.test(error.message || '')) { const { billing_mode, ...safe } = payload; ({ error } = await saveContract(safe)); }
    if (error) { toast('שגיאה: ' + (error.message || error), true); throw error; }
    if (!con) { try { await addInteraction('customer', custId, `נפתחה עסקה: ${nameOf('priceList', payload.price_item_id)} × ${payload.total_inserts}`); } catch (e) { } }
    try {
      const issId = (typeof _ieIssue !== 'undefined' && _ieIssue) ? _ieIssue.id
        : ((typeof _drIssue !== 'undefined' && _drIssue) ? _drIssue.id
          : ((typeof _fpIssue !== 'undefined' && _fpIssue) ? _fpIssue.id : null));
      if (issId && cid) await run(db.from('ads').update({ contract_id: cid }).eq('customer_id', custId).eq('issue_id', issId).is('contract_id', null).not('status', 'in', '("cancelled","rejected")'));
    } catch (e) { }
    toast('✓ פרטי העסקה נשמרו');
    if (typeof _ieCust !== 'undefined' && _ieCust && _ieCust.id === custId) { try { await ieSelectCust(custId); } catch (e) { } }
    if (document.getElementById('ieList') && typeof _ieIssue !== 'undefined' && _ieIssue) {
      try { _ieAds = await run(db.from('ads').select('*').eq('issue_id', _ieIssue.id).not('status', 'in', '("cancelled","rejected")').order('created_at', { ascending: false })); _ieDrawList(); } catch (e) { }
    }
    if (opts.closeWizard && typeof _drShow === 'function') { if (typeof _drDeal !== 'undefined') delete _drDeal[custId]; _drShow(); }
  });
}
