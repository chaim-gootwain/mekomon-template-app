/* ============================================================
customer-picker.js — בורר לקוחות משותף לכל המערכת
------------------------------------------------------------
חיפוש מלל חופשי לפי שם/טלפון + "הוסף לקוח חדש" (טופס הלקוח המלא, ממולא
מראש עם מה שהוקלד). מחזיק input מוסתר עם ה-id שנתבקש, שערכו הוא customer_id —
כך כל קורא קיים (document.getElementById(id).value) ממשיך לעבוד בלי שינוי.

שימוש:
  ${custPickerHtml({ base:'subCust', value: c.customer_id })}          // עצמאי, עם הוספה
  ${custPickerHtml({ base:'repCust', allowNew:false })}                // חיפוש בלבד
  openForm(..., [{ name:'customer_id', type:'customer', required:true }])  // בתוך טופס

קורא הערך: document.getElementById(base).value  (או f_<name> בתוך openForm).
============================================================ */

'use strict';

const _CP = {}; // base-id -> { allowNew, form, onpick }

function _cpEsc(s) { return (typeof esc === 'function') ? esc(s) : String(s == null ? '' : s); }

function custPickerHtml(cfg) {
cfg = cfg || {};
const base = cfg.base;
_CP[base] = { allowNew: cfg.allowNew !== false, form: !!cfg.form, onpick: cfg.onpick || null };
// נפילה בטוחה: אם מסיבה כלשהי הקובץ לא נטען, אל תשבור טפסים — הצג select רגיל
const val = (cfg.value != null && cfg.value !== '') ? cfg.value : '';
const selName = val ? ((typeof nameOf === 'function' ? nameOf('customers', val) : '') || '') : '';
const ph = cfg.placeholder || 'הקלד שם או טלפון…';
return `<div class="cp-wrap" style="position:relative">
<input type="hidden" id="${base}" value="${_cpEsc(val)}" data-selname="${_cpEsc(selName)}">
<input id="${base}__q" autocomplete="off" placeholder="${_cpEsc(ph)}" value="${_cpEsc(selName)}"
oninput="custPickerFilter('${base}', this.value)"
onblur="setTimeout(function(){var r=document.getElementById('${base}__res');if(r)r.style.display='none';},200)">
<div id="${base}__res" class="cp-res" style="position:absolute;left:0;right:0;z-index:40;max-height:220px;overflow:auto;background:#fff;border:1px solid var(--line,#e5e7eb);border-radius:8px;margin-top:2px;display:none"></div>
</div>`;
}

function custPickerFilter(base, q) {
const res = document.getElementById(base + '__res'); if (!res) return;
const hid = document.getElementById(base);
const st = _CP[base] || {};
q = (q || '').trim();
// אם הטקסט שונה מהשם הנבחר — הבחירה בוטלה עד לבחירה חדשה
if (hid && q !== (hid.getAttribute('data-selname') || '')) hid.value = '';
let rows = '';
if (q) {
const list = (typeof cache !== 'undefined' ? (cache.customers || []) : []).filter(c =>
(c.name || '').includes(q) || (c.phone || '').includes(q)).slice(0, 20);
rows = list.map(c => `<div class="cp-item" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f1f5f9" onmousedown="event.preventDefault()" onclick="custPickerPick('${base}', ${c.id})"><b>${_cpEsc(c.name)}</b>${c.phone ? ` <span class="muted" dir="ltr" style="font-size:.8rem">${_cpEsc(c.phone)}</span>` : ''}</div>`).join('');
if (st.allowNew) {
rows += `<div class="cp-new" style="padding:8px 10px;cursor:pointer;color:var(--brand);font-weight:700;border-top:1px solid #eee" onmousedown="event.preventDefault()" onclick="custPickerNew('${base}')">＋ הוסף לקוח חדש: "${_cpEsc(q)}"</div>`;
} else if (!list.length) {
rows = `<div class="muted" style="padding:7px 10px">לא נמצא</div>`;
}
}
res.innerHTML = rows;
res.style.display = rows ? 'block' : 'none';
}

function custPickerPick(base, id) {
const hid = document.getElementById(base);
const nm = (typeof nameOf === 'function' ? nameOf('customers', id) : '') || '';
if (hid) { hid.value = id; hid.setAttribute('data-selname', nm); }
const q = document.getElementById(base + '__q'); if (q) q.value = nm;
const res = document.getElementById(base + '__res'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
const st = _CP[base]; if (st && typeof st.onpick === 'function') { try { st.onpick(id); } catch (e) { } }
}

function custPickerNew(base) {
const q = (document.getElementById(base + '__q') || {}).value || '';
const st = _CP[base] || {};
if (typeof customerCreateFull !== 'function') { if (typeof toast === 'function') toast('לא ניתן להוסיף לקוח כאן', true); return; }
if (st.form) {
// הבורר נמצא בתוך openForm (אותו מודאל) — צלם את הטופס, פתח "לקוח חדש",
// ואחרי היצירה החזר את הטופס עם הערכים והלקוח הנבחר (setTimeout כדי לעקוף את closeForm של הטופס המקונן)
const snap = _cpFormSnapshot();
customerCreateFull(q, function (cust) {
setTimeout(function () {
if (typeof openForm === 'function') openForm(snap.title, snap.fields, snap.values, snap.save);
custPickerPick(base, cust.id);
}, 0);
});
} else {
customerCreateFull(q, function (cust) { custPickerPick(base, cust.id); });
}
}

/* צילום מצב טופס openForm הנוכחי (לפני פתיחת טופס לקוח מקונן) */
function _cpFormSnapshot() {
const titleEl = document.getElementById('modalTitle');
const title = titleEl ? titleEl.textContent : '';
const fields = (typeof _formFields !== 'undefined') ? _formFields : [];
const save = (typeof _formSave !== 'undefined') ? _formSave : null;
const values = {};
for (const f of fields) {
if (!f || f.type === 'section' || f.type === 'html') continue;
const el = document.getElementById('f_' + f.name);
if (!el) continue;
values[f.name] = (f.type === 'checkbox') ? el.checked : el.value;
}
return { title, fields, values, save };
}
