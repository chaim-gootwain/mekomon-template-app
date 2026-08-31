/* ============================================================
ads.js — זרימת המודעות המלאה
------------------------------------------------------------
שלושה דפים:
1. ads — כל המודעות + כפתורי ניתוב (מנהל/מכירות)
2. graphics — תור העבודה של הגרפיקאית
3. committee — מסך האישור של הוועדה
כל מעבר סטטוס עובר דרך route_ad בשרת — מתועד ונאכף לפי תפקיד
============================================================ */

'use strict';

let _ads = [];

/* טעינת מודעות + שם לקוח */
async function loadAds(filterStatus) {
let q = db.from('ads').select('*').order('created_at', { ascending: false }).limit(300);
if (filterStatus) q = q.in('status', filterStatus);
return await run(q);
}

/* ==================== 1. דף המודעות הראשי ==================== */

Pages.ads = {
render: async (el) => {
_ads = await loadAds();
const canRoute = ['admin', 'sales'].includes(profile.role);
el.innerHTML = `
<div class="page-head">
<h2>מודעות</h2>
${canRoute ? `<button class="btn" onclick="adAdd()">+ מודעה ידנית</button>
<button class="btn btn-ghost" onclick="adAddByCustomer()">+ מודעה לפי לקוח</button>` : ''}
</div>
<div class="tabs" id="adTabs">
<button class="active" data-f="inbox" onclick="adsTab(this)">📥 חדשות לניתוב</button>
<button data-f="working" onclick="adsTab(this)">בתהליך</button>
<button data-f="ready" onclick="adsTab(this)">מוכנות לשיבוץ</button>
<button data-f="done" onclick="adsTab(this)">פורסמו</button>
<button data-f="all" onclick="adsTab(this)">הכל</button>
</div>
<div class="filter-bar">
<input id="adSearch" placeholder="חיפוש..." oninput="adsDraw()" style="min-width:200px">
<select id="adIssueFilter" onchange="adsDraw()">
<option value="">כל הגיליונות</option>
${cache.issues.map(i => `<option value="${i.id}">גיליון ${i.issue_number}</option>`).join('')}
</select>
</div>
<div class="card" id="adsTable"></div>`;
adsDraw();
}
};

let _adsFilter = 'inbox';
function adsTab(btn) {
_adsFilter = btn.dataset.f;
document.querySelectorAll('#adTabs button').forEach(b => b.classList.toggle('active', b === btn));
adsDraw();
}

function adsDraw() {
const term = (document.getElementById('adSearch')?.value || '').trim();
const issue = document.getElementById('adIssueFilter')?.value || '';
const groups = {
inbox: ['received'], working: ['in_graphics', 'proof', 'committee'],
ready: ['approved', 'placed'], done: ['published'],
all: null,
};
const statuses = groups[_adsFilter];
const rows = _ads.filter(a =>
(!statuses || statuses.includes(a.status)) &&
(!issue || a.issue_id === Number(issue)) &&
(!term || [a.title, a.notes, a.content_text].some(v => (v || '').includes(term))));

renderTable(document.getElementById('adsTable'), rows, [
{ h: 'מודעה', f: r => `<b>${esc(r.title)}</b>${r.source === 'portal' ? ' <span class="pill gold">מהפורטל</span>' : ''}${r.source === 'contract' ? ' <span class="pill blue">חוזה</span>' : ''}` },
{ h: 'לקוח', f: r => esc(nameOf('customers', r.customer_id)) },
{ h: 'גודל', f: r => esc(nameOf('priceList', r.price_item_id)) },
{ h: 'גיליון', f: r => esc(nameOf('issues', r.issue_id, 'issue')) || '<span class="muted">טרם</span>' },
{ h: 'מחיר', f: r => money(r.price - r.discount) },
{ h: 'סטטוס', f: r => pill('ad', r.status) },
{ h: 'התקבלה', f: r => heDateTime(r.created_at) },
], { onRow: r => openAdCard(r.id), empty: _adsFilter === 'inbox' ? 'אין מודעות חדשות לניתוב 👍' : 'אין מודעות' });
}

/* --- הוספה ידנית --- */
function adAdd(prefill) {
openForm('מודעה חדשה', [
{ name: 'customer_id', label: 'לקוח', type: 'customer', required: true },
{ name: 'title', label: 'תיאור המודעה', required: true },
{ name: 'price_item_id', label: 'גודל (מהמחירון)', type: 'select', options: 'priceList' },
{ name: 'issue_id', label: 'גיליון יעד', type: 'select', options: 'issues' },
{ name: 'requested_placement', label: 'מיקום מבוקש' },
{ name: 'price', label: 'מחיר (₪, ריק = לפי המחירון)', type: 'number' },
{ name: 'discount', label: 'הנחה (₪)', type: 'number', default: 0 },
{ name: 'commission_pct', label: '% עמלה מיוחד (ריק = לפי הסוכן)', type: 'number' },
{ name: 'content_text', label: 'תוכן המודעה (טקסט שהלקוח שלח)', type: 'textarea' },
{ name: 'graphics_note', label: 'הנחיה לעיצוב (לגרפיקאית)', type: 'textarea', rows: 2 },
{ type: 'html', html: '<label>קובץ המודעה מהלקוח (תמונה / PDF)</label><input type="file" id="adNewFile" accept="image/*,application/pdf" style="width:100%">' },
{ name: 'notes', label: 'הערות פנימיות', type: 'textarea', rows: 2 },
], prefill || {}, async (rec) => {
const cust = cache.customers.find(c => c.id === rec.customer_id);
if (cust) rec.agent_id = cust.agent_id;
if (typeof checkDebtGate === 'function') { const _okDebt = await checkDebtGate(rec.customer_id, 'הכנסת מודעה חדשה'); if (!_okDebt) throw new Error('debt-gate-cancel'); }
if (typeof checkCustomerStatusGate === 'function') { const _okS = await checkCustomerStatusGate(rec.customer_id, 'הכנסת מודעה'); if (!_okS) throw new Error('status-gate-cancel'); }
if (rec.price == null && rec.price_item_id) {
const item = cache.priceList.find(p => p.id === rec.price_item_id);
rec.price = item ? Number(item.price) : 0;
// סוג גיליון מיוחד (#21): הצעת המחיר ממחירון מוכפלת באחוז הסוג — גלוי למשתמש
if (rec.issue_id && typeof issueTypePct === 'function') {
const _iss = (cache.issues || []).find(i => i.id === rec.issue_id);
const _pct = _iss ? issueTypePct(_iss.issue_type) : 100;
if (_pct !== 100 && rec.price > 0) {
rec.price = Math.round(rec.price * _pct / 100);
toast(`מחיר לפי גיליון ${(typeof ISSUE_TYPE_HE !== 'undefined' && ISSUE_TYPE_HE[_iss.issue_type]) || 'מיוחד'} — ${_pct}% מהמחירון`);
}
}
}
rec.price = rec.price || 0;
if ((!rec.discount || Number(rec.discount) === 0) && typeof custFixedDiscountAmount === 'function') rec.discount = custFixedDiscountAmount(rec.customer_id, rec.price);
rec.discount = rec.discount || 0;
rec.created_by = profile.id;
// ניקוי שדות ריקים כדי לא לדרוס עם מחרוזת ריקה
if (!rec.content_text) delete rec.content_text;
if (!rec.graphics_note) delete rec.graphics_note;
let data;
try { data = await db.from('ads').insert(rec).select().single().then(r => { if (r.error) throw r.error; return r.data; }); }
catch (e) { const r2 = { ...rec }; delete r2.content_text; delete r2.graphics_note; data = await run(db.from('ads').insert(r2).select().single()); }
// העלאת קובץ המודעה מהלקוח אם צורף
try {
const _f = document.getElementById('adNewFile');
const _file = _f && _f.files && _f.files[0];
if (_file) {
const _path = `staff/${data.id}/${Date.now()}_${safeKey(_file.name)}`;
const { error: _e } = await db.storage.from('ad-files').upload(_path, _file);
if (_e) { toast('המודעה נשמרה, אך העלאת הקובץ נכשלה: ' + _e.message, true); }
else { await run(db.from('ad_files').insert({ ad_id: data.id, storage_path: _path, file_name: _file.name, kind: 'source', uploaded_by: profile.id })); }
}
} catch (e) { }
await addInteraction('ad', data.id, 'המודעה נוצרה ידנית');
// חבילות (#6): אם ללקוח חבילה פעילה עם יתרה — הצעת שיוך שמורידה מהמונה
if (!data.contract_id && typeof packageLinkAd === 'function') { try { await packageLinkAd(data.id, rec.customer_id); } catch (e) { } }
toast('המודעה נוספה');
openPage('ads');
});
}

/* --- כרטיס מודעה: תצוגה + כפתורי ניתוב לפי תפקיד וסטטוס --- */
async function openAdCard(id) {
const a = _ads.find(x => x.id === id) || await run(db.from('ads').select('*').eq('id', id).single());
const [files, notes] = await Promise.all([
run(db.from('ad_files').select('*').eq('ad_id', id).order('created_at', { ascending: false })),
loadTimeline('ad', id),
]);
const canRoute = ['admin', 'sales'].includes(profile.role);

/* כפתורי הניתוב הרלוונטיים לסטטוס הנוכחי */
let routeButtons = '';
if (canRoute) {
if (a.status === 'received') routeButtons = `
<button class="btn btn-sm" onclick="adRoute(${id},'to_graphics',true)">🎨 לגרפיקה</button>
<button class="btn btn-sm btn-gold" onclick="adRoute(${id},'to_committee')">🕮 לוועדה</button>
<button class="btn btn-sm" style="background:var(--ok)" onclick="adRoute(${id},'approve')">✓ אישור לשיבוץ</button>
<button class="btn btn-sm btn-danger-ghost" onclick="adRoute(${id},'reject',true)">✗ דחייה</button>`;
else if (a.status === 'approved') routeButtons = `
<button class="btn btn-sm" onclick="adAssignIssue(${id})">📌 שיבוץ לגיליון</button>
<button class="btn btn-sm btn-ghost" onclick="adRoute(${id},'to_committee')">בכל זאת לוועדה</button>`;
else if (a.status === 'placed') routeButtons = profile.role === 'admin'
? `<button class="btn btn-sm" style="background:var(--ok)" onclick="adRoute(${id},'publish')">📣 סימון פורסמה (יוצר חיוב)</button>` : '';
if (!['published', 'cancelled', 'rejected'].includes(a.status))
routeButtons += `<button class="btn btn-sm btn-danger-ghost" onclick="adRoute(${id},'cancel',true)">ביטול</button>`;
}

const filesHtml = files.length
? files.map(f => `<li style="display:flex;justify-content:space-between;padding:5px 0">
<span>${f.kind === 'source' ? '📎 מקור מהלקוח' : '🎨 עיצוב'} — ${esc(f.file_name) || 'קובץ'}</span>
<button class="btn btn-sm btn-ghost" onclick="adFileOpen('${esc(f.storage_path)}')">צפייה</button></li>`).join('')
: '<li class="muted">אין קבצים</li>';

document.getElementById('viewModal').innerHTML = `
<h3>${esc(a.title)} ${pill('ad', a.status)}</h3>
<div class="grid3" style="font-size:.9rem">
<div><label>לקוח</label><b>${esc(nameOf('customers', a.customer_id)) || '—'}</b></div>
<div><label>סוכן</label><b>${esc(nameOf('agents', a.agent_id)) || '—'}</b></div>
<div><label>גודל</label><b>${esc(nameOf('priceList', a.price_item_id)) || '—'}</b></div>
<div><label>גיליון</label><b>${esc(nameOf('issues', a.issue_id, 'issue')) || 'טרם שובץ'}</b></div>
<div><label>עמוד</label><b>${a.page_number || '—'}</b></div>
<div><label>מחיר</label><b>${money(a.price)}${a.discount > 0 ? ' (הנחה ' + money(a.discount) + ')' : ''}</b></div>
</div>
${a.content_text ? `<div class="field" style="margin-top:8px"><label>תוכן שהלקוח שלח</label>
<div style="background:var(--bg);border-radius:8px;padding:10px;font-size:.88rem;white-space:pre-wrap">${esc(a.content_text)}</div></div>` : ''}
${a.graphics_note ? `<p style="font-size:.85rem"><b>הנחיה לגרפיקה:</b> ${esc(a.graphics_note)}</p>` : ''}
${a.committee_note ? `<p style="font-size:.85rem"><b>הערת ועדה:</b> ${esc(a.committee_note)}</p>` : ''}
${a.reject_reason && ['rejected', 'cancelled'].includes(a.status) ? `<p style="color:var(--danger);font-size:.85rem"><b>סיבה:</b> ${esc(a.reject_reason)}</p>` : ''}
${typeof proofCardBlock === 'function' ? proofCardBlock(a) : ''}

<b style="font-size:.9rem">קבצים</b>
<ul style="list-style:none;margin:6px 0 12px">${filesHtml}</ul>
${['admin', 'sales', 'graphics'].includes(profile.role) ? `
<input type="file" id="adFileInput" class="hidden" onchange="adFileUpload(${id})">
<button class="btn btn-sm btn-ghost" onclick="document.getElementById('adFileInput').click()">⬆ העלאת קובץ</button>` : ''}

<div class="m-actions" style="flex-wrap:wrap">
${routeButtons}
${canRoute ? `<button class="btn btn-sm btn-ghost" onclick="adEdit(${id})">עריכה</button>` : ''}
<button class="btn btn-sm btn-ghost" style="margin-right:auto"
onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
</div>
<hr style="border:none;border-top:1px solid var(--line);margin:16px 0 10px">
<b>ציר זמן</b><div style="margin-top:8px">${timelineHtml(notes)}</div>`;
document.getElementById('viewBack').classList.add('open');
}

/* --- ניתוב: קריאה אחת לשרת, שמתעדת ואוכפת --- */
async function adRoute(id, action, askNote = false) {
let note = '';
if (askNote) {
const labels = { to_graphics: 'הנחיה לגרפיקאית:', reject: 'סיבת הדחייה:', cancel: 'סיבת הביטול:' };
note = prompt(labels[action] || 'הערה:') || '';
if (['reject', 'cancel'].includes(action) && !note) return; // דחייה/ביטול מחייבים סיבה
}
try {
await run(db.rpc('route_ad', { p_ad_id: id, p_action: action, p_note: note }));
toast('בוצע');
document.getElementById('viewBack').classList.remove('open');
openPage(currentPage);
} catch (e) { /* toast כבר הוצג */ }
}

/* שיבוץ לגיליון: בחירת גיליון ואז סטטוס placed */
function adAssignIssue(id) {
document.getElementById('viewBack').classList.remove('open');
openForm('שיבוץ לגיליון', [
{ name: 'issue_id', label: 'גיליון', type: 'select', options: 'issues', required: true },
{ name: 'page_number', label: 'עמוד (אפשר גם דרך הפלטפלן)', type: 'number' },
], {}, async (rec) => {
await run(db.from('ads').update(rec).eq('id', id));
await run(db.rpc('route_ad', { p_ad_id: id, p_action: 'place', p_note: 'שובץ לגיליון' }));
toast('שובץ');
openPage('ads');
});
}

function adEdit(id) {
const a = _ads.find(x => x.id === id);
document.getElementById('viewBack').classList.remove('open');
openForm('עריכת מודעה', [
{ name: 'title', label: 'תיאור', required: true },
{ name: 'customer_id', label: 'לקוח', type: 'customer' },
{ name: 'price_item_id', label: 'גודל', type: 'select', options: 'priceList' },
{ name: 'issue_id', label: 'גיליון', type: 'select', options: 'issues' },
{ name: 'requested_placement', label: 'מיקום מבוקש' },
{ name: 'price', label: 'מחיר (₪)', type: 'number' },
{ name: 'discount', label: 'הנחה (₪)', type: 'number' },
{ name: 'commission_pct', label: '% עמלה מיוחד', type: 'number' },
{ name: 'notes', label: 'הערות', type: 'textarea' },
], a, async (rec) => {
await run(db.from('ads').update(rec).eq('id', id));
toast('נשמר');
openPage('ads');
});
}

/* --- קבצים: העלאה ל-Storage וצפייה בקישור חתום --- */
async function adFileUpload(adId) {
const input = document.getElementById('adFileInput');
const file = input.files[0];
if (!file) return;
const path = `staff/${adId}/${Date.now()}_${safeKey(file.name)}`;
const { error } = await db.storage.from('ad-files').upload(path, file);
if (error) { toast('שגיאה בהעלאה: ' + error.message, true); return; }
const kind = profile.role === 'graphics' ? 'design' : 'source';
await run(db.from('ad_files').insert({ ad_id: adId, storage_path: path, file_name: file.name, kind, uploaded_by: profile.id }));
await addInteraction('ad', adId, `הועלה קובץ: ${file.name}`);
toast('הקובץ הועלה');
openAdCard(adId);
}

async function adFileOpen(path) {
const { data, error } = await db.storage.from('ad-files').createSignedUrl(path, 300);
if (error) { toast('שגיאה בפתיחה: ' + error.message, true); return; }
window.open(data.signedUrl, '_blank');
}

/* ==================== 2. תור הגרפיקה ==================== */

Pages.graphics = {
render: async (el) => { await gfxQueueRender(el); }
};

async function gfxDone(id) {
if (!confirm('לסמן שהעיצוב מוכן? המודעה תחזור למנהל להמשך טיפול.\n(ודא שהעלית את הקובץ המעוצב בכרטיס המודעה)')) return;
await run(db.rpc('route_ad', { p_ad_id: id, p_action: 'graphics_done', p_note: 'העיצוב הושלם' }));
toast('נשלח חזרה לניתוב');
openPage('graphics');
}

/* ==================== 3. מסך הוועדה ==================== */

Pages.committee = {
render: async (el) => {
// הוועדה רואה רק מודעות בסטטוס committee — RLS אוכף זאת גם בשרת
const queue = await loadAds(['committee']);
_ads = queue;
el.innerHTML = `
<div class="page-head"><h2>מודעות לאישור הוועדה <span class="muted">(${queue.length})</span></h2></div>
${queue.length ? '' : '<div class="card"><div class="empty">אין מודעות הממתינות לאישור 👍</div></div>'}
<div id="committeeCards"></div>`;
const wrap = document.getElementById('committeeCards');
for (const a of queue) {
const files = await run(db.from('ad_files').select('*').eq('ad_id', a.id).order('created_at', { ascending: false }).limit(3));
const div = document.createElement('div');
div.className = 'card card-pad';
div.style.marginBottom = '14px';
div.innerHTML = `
<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
<b>${esc(a.title)}</b><span class="muted">${esc(nameOf('customers', a.customer_id))}</span>
</div>
${a.content_text ? `<div style="background:var(--bg);border-radius:8px;padding:10px;margin-top:8px;font-size:.88rem;white-space:pre-wrap">${esc(a.content_text)}</div>` : ''}
<div style="margin-top:8px">
${files.map(f => `<button class="btn btn-sm btn-ghost" onclick="adFileOpen('${esc(f.storage_path)}')">📎 ${esc(f.file_name) || 'קובץ'}</button>`).join(' ')}
</div>
<div class="m-actions">
<button class="btn btn-sm" style="background:var(--ok)" onclick="committeeDecide(${a.id}, true)">✓ אישור</button>
<button class="btn btn-sm btn-danger-ghost" onclick="committeeDecide(${a.id}, false)">✗ דחייה</button>
</div>`;
wrap.appendChild(div);
}
}
};

async function committeeDecide(id, approve) {
const note = prompt(approve ? 'הערה (לא חובה):' : 'סיבת הדחייה (חובה):') || '';
if (!approve && !note) return;
await run(db.rpc('route_ad', { p_ad_id: id, p_action: approve ? 'committee_approve' : 'committee_reject', p_note: note }));
toast(approve ? 'אושר' : 'נדחה');
openPage('committee');
}


/* ============================================================
   מודעה לפי לקוח (פיצ'ר #12) — מסלול שמתחיל מבחירת לקוח
   ------------------------------------------------------------
   חלון קטן עם בורר הלקוחות המשותף (כולל "הוסף לקוח חדש"), הצגת
   הקשר מהיר (יתרה פתוחה + פרסומים אחרונים), והמשך לטופס המודעה
   המלא כשהלקוח כבר משויך.
   ============================================================ */

function adAddByCustomer() {
  document.getElementById('abcOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'abcOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,20,40,.5);display:flex;align-items:flex-start;justify-content:center;z-index:99996;padding:60px 16px;direction:rtl';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:16px;padding:20px;max-width:460px;width:96%">
    <h3 style="margin:0 0 4px">➕ מודעה לפי לקוח</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 10px">הקלד שם או טלפון — אפשר גם להוסיף לקוח חדש מכאן.</p>
    ${custPickerHtml({ base: 'abcCust', onpick: adAddByCustomerPicked })}
    <div id="abcInfo" style="margin-top:10px"></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="abcGo" class="btn" disabled onclick="adAddByCustomerGo()">המשך לטופס המודעה ←</button>
      <button class="btn btn-ghost" onclick="document.getElementById('abcOv').remove()">ביטול</button>
    </div></div>`;
  document.body.appendChild(ov);
  setTimeout(() => document.getElementById('abcCust__q')?.focus(), 60);
}

async function adAddByCustomerPicked(customerId) {
  const go = document.getElementById('abcGo'); if (go) go.disabled = !customerId;
  const box = document.getElementById('abcInfo'); if (!box || !customerId) return;
  box.innerHTML = '<span class="muted" style="font-size:.8rem">טוען פרטים...</span>';
  try {
    const c = (cache.customers || []).find(x => x.id === Number(customerId)) || {};
    let balTxt = '';
    if (typeof customerOpenBalance === 'function') {
      const bal = await customerOpenBalance(Number(customerId));
      balTxt = bal.total > 0 ? `<span style="color:var(--danger)">יתרה פתוחה: <b>${money(bal.total)}</b></span>` : '<span style="color:var(--ok)">אין חוב פתוח ✓</span>';
    }
    const { data: recent } = await db.from('ads').select('id,title,issue_id,status')
      .eq('customer_id', Number(customerId)).order('created_at', { ascending: false }).limit(3);
    let pkgTxt = '';
    if (typeof packagesWithRemaining === 'function') {
      const pkgs = await packagesWithRemaining(Number(customerId));
      if (pkgs.length) pkgTxt = `<div style="margin-top:6px;color:#0369a1">📦 ${pkgs.map(p => `${esc(nameOf('priceList', p.ct.price_item_id) || 'חבילה')}: נותרו <b>${p.left}</b> מתוך ${p.total}`).join(' · ')}</div>`;
    }
    box.innerHTML = `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;font-size:.85rem;background:#fbfdff">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span>סוכן: <b>${esc(nameOf('agents', c.agent_id) || '—')}</b></span>${balTxt}
      </div>
      ${pkgTxt}
      ${(recent || []).length ? `<div class="muted" style="margin-top:6px">פרסומים אחרונים: ${(recent || []).map(a => esc(a.title || 'מודעה')).join(' · ')}</div>` : '<div class="muted" style="margin-top:6px">אין פרסומים קודמים</div>'}
    </div>`;
  } catch (e) { box.innerHTML = ''; }
}

function adAddByCustomerGo() {
  const cid = Number(document.getElementById('abcCust')?.value);
  if (!cid) { toast('בחר לקוח קודם', true); return; }
  document.getElementById('abcOv')?.remove();
  adAdd({ customer_id: cid });
}
