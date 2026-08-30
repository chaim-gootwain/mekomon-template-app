/* ============================================================
api.js — תשתית משותפת לכל המערכת
------------------------------------------------------------
מה יש כאן:
1. חיבור ל-Supabase (הגדרה חד-פעמית)
2. משתני מצב גלובליים: session, profile, cache
3. פונקציות עזר: תרגומים, תאריכים, כסף, HTML בטוח
4. רכיבים משותפים: toast, מודאל טפסים, טבלת נתונים
כל מודול (leads.js, ads.js...) משתמש רק במה שמוגדר כאן.
============================================================ */

'use strict';

/* ---------- 1. חיבור ל-Supabase ---------- */
/* פרטי החיבור מוטמעים — הצוות לא צריך להזין כלום.
המפתח הוא publishable (ציבורי); ההרשאות נאכפות בשרת (RLS). */
const BUILT_IN_URL = '@@SUPABASE_URL@@';
const BUILT_IN_KEY = '@@SUPABASE_KEY@@';

const CFG_KEY = 'emanuel_cfg';
let db = null; // לקוח Supabase — נוצר ב-initSupabase
let session = null; // החיבור הנוכחי
let profile = null; // הפרופיל של המשתמש (כולל role)

function initSupabase() {
if (BUILT_IN_URL.startsWith('https://')) {
db = supabase.createClient(BUILT_IN_URL, BUILT_IN_KEY);
return true;
}
const raw = localStorage.getItem(CFG_KEY); // גיבוי: הגדרה ידנית
if (!raw) return false;
const cfg = JSON.parse(raw);
db = supabase.createClient(cfg.url, cfg.key);
return true;
}

function saveConfig() {
const url = document.getElementById('cfgUrl').value.trim();
const key = document.getElementById('cfgKey').value.trim();
if (!url.startsWith('https://') || key.length < 20) {
document.getElementById('cfgErr').textContent = 'נא להזין כתובת ומפתח תקינים';
return;
}
localStorage.setItem(CFG_KEY, JSON.stringify({ url, key }));
location.reload();
}

/* ---------- 2. מטמון רשימות (לתפריטים נפתחים) ---------- */
const cache = { customers: [], agents: [], agencies: [], issues: [], priceList: [], sections: [], profiles: [], settings: {} };

async function refreshCache() {
const role = profile.role;
const jobs = [
db.from('price_list').select('*').eq('active', true).order('sort').then(r => cache.priceList = r.data || []),
db.from('issues').select('id,issue_number,publish_date,print_date,status').order('issue_number', { ascending: false }).limit(30).then(r => cache.issues = r.data || []),
db.from('settings').select('*').then(r => { (r.data || []).forEach(s => cache.settings[s.key] = s.value); }),
];
if (['admin', 'sales', 'editor', 'graphics'].includes(role)) {
jobs.push(db.from('customers').select('id,name,agent_id,phone,email,portal_token,business_id,invoice_name,order_doc_type,payment_terms,agency_id').order('name').then(r => {
  // נפילה בטוחה: אם עמודת agency_id עוד לא קיימת במופע — נטען בלעדיה
  if (r.error) return db.from('customers').select('id,name,agent_id,phone,email,portal_token,business_id,invoice_name,order_doc_type,payment_terms').order('name').then(r2 => cache.customers = r2.data || []);
  cache.customers = r.data || [];
}));
jobs.push(db.from('agencies').select('*').order('name').then(r => cache.agencies = r.data || []));
}
if (['admin', 'sales', 'editor'].includes(role)) {
jobs.push(db.from('agents').select('*').order('name').then(r => cache.agents = r.data || []));
jobs.push(db.from('profiles').select('id,full_name,role,active').then(r => cache.profiles = r.data || []));
}
if (['admin', 'editor'].includes(role) || true)
jobs.push(db.from('sections').select('*').eq('active', true).order('sort').then(r => cache.sections = r.data || []));
await Promise.all(jobs);
}

/* חיפוש שם לפי מזהה במטמון */
function nameOf(list, id, field = 'name') {
if (id == null) return '';
const r = cache[list].find(x => x.id === id);
return r ? (field === 'issue' ? 'גיליון ' + r.issue_number : r[field]) : '';
}

/* ---------- 3. תרגומים וקבועים ---------- */
const ROLE_NAMES = { admin: 'מנהל', sales: 'מכירות', editor: 'עורך', graphics: 'גרפיקה', committee: 'ועדה', pending: 'ממתין לאישור' };

const STATUS = {
lead: { new: ['חדש', 'blue'], contacted: ['נוצר קשר', ''], meeting: ['במשא ומתן', 'amber'], proposal: ['הצעת מחיר', 'gold'], won: ['נסגר ✓', 'green'], lost: ['אבוד', 'red'] },
ad: { received: ['התקבלה', 'blue'], in_graphics: ['בגרפיקה', 'amber'], proof: ['פרוף מוכן', 'gold'], committee: ['בוועדה', 'gold'], approved: ['מאושרת', 'green'], placed: ['שובצה', 'green'], published: ['פורסמה', 'green'], rejected: ['נדחתה', 'red'], cancelled: ['בוטלה', 'red'] },
issue: { planning: ['בתכנון', ''], in_progress: ['בעבודה', 'blue'], layout: ['בעימוד', 'amber'], closed: ['נסגר', 'gold'], published: ['יצא לאור', 'green'] },
article: { idea: ['רעיון', ''], approved: ['אושר לכתיבה', 'blue'], writing: ['בכתיבה', 'blue'], submitted: ['הוגש', 'amber'], editing: ['בעריכה', 'amber'], ready: ['מוכן', 'green'], placed: ['שובץ', 'green'], published: ['פורסם', 'green'] },
charge: { pending: ['ממתין להפקה', 'amber'], invoiced: ['הופקה חשבונית', 'blue'], paid: ['שולם', 'green'], partial: ['שולם חלקית', 'gold'], overdue: ['באיחור', 'red'], lost: ['חוב אבוד', 'red'], cancelled: ['בוטל', ''] },
expense: { expected: ['צפויה', 'amber'], paid: ['שולמה', 'green'] },
};

const PAY_METHODS = { transfer: 'העברה בנקאית', check: 'צ׳ק', credit: 'אשראי', cash: 'מזומן' };
const PAY_TERMS = { immediate: 'מיידי', net30: 'שוטף+30', net60: 'שוטף+60' };
const LEAD_SOURCES = ['טלפון', 'המלצה', 'שטח', 'וואטסאפ', 'מייל'];

function pill(group, key) {
const s = STATUS[group][key] || [key, ''];
return `<span class="pill ${s[1]}">${esc(s[0])}</span>`;
}

/* ---------- 4. עזרי תצוגה ---------- */
function esc(v) { return (v == null ? '' : String(v)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(v) { return v == null || v === '' ? '' : '₪' + Number(v).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
function heDate(d) { if (!d) return ''; const s = String(d).slice(0, 10).split('-'); return `${s[2]}.${s[1]}.${s[0]}`; }
function heDateTime(d) { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('he-IL') + ' ' + dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
function today() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }

function toast(msg, isError = false) {
const t = document.getElementById('toast');
t.textContent = msg;
t.className = 'toast show' + (isError ? ' err' : '');
setTimeout(() => t.classList.remove('show'), isError ? 4000 : 2200);
}

/* עטיפה אחידה לקריאות נתונים — שגיאה תמיד מוצגת ונרשמת בקונסולה */
async function run(promise, errPrefix = 'שגיאה') {
const { data, error } = await promise;
if (error) {
console.error(errPrefix, error); // לדיבוג ידני ב-F12
toast(errPrefix + ': ' + error.message, true);
throw error;
}
return data;
}

/* ---------- 5. מודאל טפסים גנרי ----------
openForm(כותרת, שדות, ערכים, פונקציית-שמירה)
סוגי שדה: text, number, date, select, textarea, checkbox
שדה select מקבל options: [{v, t}] או שם רשימה מהמטמון */
let _formSave = null;
let _formFields = [];

function openForm(title, fields, values = {}, onSave) {
_formSave = onSave; _formFields = fields;
document.getElementById('modalTitle').textContent = title;
const wrap = document.getElementById('modalFields');
wrap.innerHTML = fields.map(f => {
if (f.type === 'section') return `<div class="form-section">${esc(f.label)}</div>`;
if (f.type === 'html') return `<div class="field" style="grid-column:1/-1">${f.html}</div>`;
const v = values[f.name] ?? f.default ?? '';
const dir = f.dir ? ` dir="${f.dir}"` : '';
let inp;
if (f.type === 'textarea') inp = `<textarea id="f_${f.name}" rows="${f.rows || 3}">${esc(v)}</textarea>`;
else if (f.type === 'checkbox') inp = `<input type="checkbox" id="f_${f.name}" ${v ? 'checked' : ''} style="width:18px;height:18px">`;
else if (f.type === 'select') {
const opts = (typeof f.options === 'string'
? cache[f.options].map(r => ({ v: r.id, t: f.options === 'issues' ? 'גיליון ' + r.issue_number : r.name }))
: f.options);
inp = `<select id="f_${f.name}">` +
(f.required ? '' : `<option value="">— ללא —</option>`) +
opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.t)}</option>`).join('') +
`</select>`;
}
else if (f.type === 'customer') {
// בורר לקוחות משותף (חיפוש + הוסף לקוח חדש). נפילה בטוחה ל-select אם המודול לא נטען.
if (typeof custPickerHtml === 'function') {
inp = custPickerHtml({ base: 'f_' + f.name, value: v, allowNew: f.allowNew !== false, placeholder: f.placeholder, form: true });
} else {
const _co = (cache.customers || []).map(r => ({ v: r.id, t: r.name }));
inp = `<select id="f_${f.name}">` + (f.required ? '' : `<option value="">— ללא —</option>`) +
_co.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.t)}</option>`).join('') + `</select>`;
}
}
else inp = `<input id="f_${f.name}" type="${f.type || 'text'}" value="${esc(v)}"${dir} ${f.type === 'number' ? 'step="any" dir="ltr"' : ''}>`;
return `<div class="field ${f.half ? 'half' : ''}"><label>${f.label}${f.required ? ' *' : ''}</label>${inp}</div>`;
}).join('');
document.getElementById('modalBack').classList.add('open');
}

function closeForm() { document.getElementById('modalBack').classList.remove('open'); }

async function submitForm() {
const rec = {};
for (const f of _formFields) {
if (f.type === 'section' || f.type === 'html') continue;
const el = document.getElementById('f_' + f.name);
let v = f.type === 'checkbox' ? el.checked : el.value;
if (f.type === 'number') v = v === '' ? null : Number(v);
if (f.type === 'select') v = v === '' ? null : (isNaN(Number(v)) ? v : Number(v));
if (f.type === 'customer') v = v === '' ? null : Number(v);
if (f.type === 'date') v = v === '' ? null : v;
if (f.type === 'time') v = v === '' ? null : v;
if (typeof v === 'string') v = v.trim();
if (f.required && (v === null || v === '')) { toast('נא למלא: ' + f.label, true); return; }
rec[f.name] = v;
}
try { await _formSave(rec); closeForm(); } catch (e) { /* השגיאה כבר הוצגה ב-run */ }
}

/* ---------- 6. טבלת נתונים גנרית ----------
renderTable(container, rows, columns, options)
columns: [{h: כותרת, f: פונקציה שמחזירה HTML לתא}]
options: {onRow: לחיצה על שורה, empty: טקסט כשריק} */
function renderTable(el, rows, columns, opts = {}) {
if (!rows.length) { el.innerHTML = `<div class="empty">${opts.empty || 'אין רשומות'}</div>`; return; }
el.innerHTML = `<div class="table-wrap"><table class="data">
<thead><tr>${columns.map(c => `<th>${c.h}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r, i) => `<tr data-i="${i}">${columns.map(c => `<td>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
if (opts.onRow) el.querySelectorAll('tbody tr').forEach(tr =>
tr.addEventListener('click', ev => {
if (ev.target.closest('button, a, select, input')) return; // כפתור בתוך תא לא פותח שורה
opts.onRow(rows[Number(tr.dataset.i)]);
}));
}

/* ---------- 7. ציר זמן (אינטראקציות + יומן) ---------- */
async function loadTimeline(entityType, entityId) {
const notes = await run(db.from('interactions').select('*')
.eq('entity_type', entityType).eq('entity_id', entityId)
.order('created_at', { ascending: false }).limit(50));
return notes;
}

function timelineHtml(items) {
if (!items.length) return '<p class="muted">אין רישומים עדיין</p>';
return `<ul class="timeline">` + items.map(n => {
const who = cache.profiles.find(p => p.id === n.user_id);
return `<li><div class="tl-time">${heDateTime(n.created_at)}${who ? ' · ' + esc(who.full_name) : ''}</div>${esc(n.content)}</li>`;
}).join('') + `</ul>`;
}

async function addInteraction(entityType, entityId, content) {
await run(db.from('interactions').insert({ entity_type: entityType, entity_id: entityId, content, user_id: profile.id }));
}

/* ---------- 8. ייצוא לאקסל (CSV עם BOM לעברית) ולהדפסה/PDF ---------- */
function exportCsv(filename, headers, rows) {
const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
const csv = '﻿' + [headers.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
a.download = filename + '.csv';
a.click();
}

/* ---------- 9. ייבוא מאקסל ----------
readSpreadsheet(file) — קורא xlsx/xls/csv ומחזיר מערך שורות,
כשכל שורה היא אובייקט לפי כותרות העמודות בשורה הראשונה.
pickField(row, [שמות אפשריים]) — מוצא ערך לפי כמה שמות עמודה נפוצים */
function readSpreadsheet(file) {
return new Promise((resolve, reject) => {
const reader = new FileReader();
reader.onload = (e) => {
try {
const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
resolve(rows);
} catch (err) { reject(err); }
};
reader.onerror = reject;
reader.readAsArrayBuffer(file);
});
}

function pickField(row, names) {
const keys = Object.keys(row);
for (const n of names) {
const k = keys.find(k => k.trim() === n || k.trim().includes(n));
if (k && String(row[k]).trim() !== '') return String(row[k]).trim();
}
return '';
}

/* זיהוי סוכן לפי שם מעמודת "סוכן" בקובץ.
מחזיר את מזהה הסוכן אם נמצאה התאמה (מלאה או חלקית), אחרת ברירת המחדל */
function matchAgent(row, fallbackAgentId) {
const name = pickField(row, ['סוכן', 'איש מכירות', 'נציג']);
if (!name) return fallbackAgentId;
const exact = cache.agents.find(a => a.name.trim() === name);
if (exact) return exact.id;
const partial = cache.agents.find(a => a.name.includes(name) || name.includes(a.name));
return partial ? partial.id : fallbackAgentId;
}

/* הדפסה של אזור מסוים — המשתמש בוחר "שמור כ-PDF" בחלון ההדפסה */
function printArea(title, innerHtml) {
const w = window.open('', '_blank');
w.document.write(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;color:#1c2438}
h1{color:@@COLOR_BRAND@@;font-size:22px;border-bottom:3px solid @@COLOR_GRAD@@;padding-bottom:8px}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}
th{background:@@COLOR_LIGHT@@;color:@@COLOR_DARK@@;padding:8px;text-align:right;border:1px solid #cdd2ea}
td{padding:7px 8px;border:1px solid #e2e8f0}
.footer{margin-top:24px;font-size:11px;color:#64748b}
</style></head><body>
<h1>${esc(cache.settings.paper_name || '@@PAPER_NAME@@')} — ${esc(title)}</h1>
${innerHtml}
<div class="footer">הופק ב-${heDateTime(new Date())} · מערכת ניהול המקומון</div>
</body></html>`);
w.document.close();
setTimeout(() => w.print(), 300);
}

/* ---------- 10. טלפוניה (Voicenter) ---------- */
/* מוצג רק כשהטלפוניה מופעלת בהגדרות. החיוג עובר דרך Edge Function
   בשם call-dial (מחזיק את קוד ה-API של Voicenter כסוד). */
function normPhone(p) {
  if (!p) return '';
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('+972')) s = '0' + s.slice(4);
  else if (s.startsWith('972')) s = '0' + s.slice(3);
  return s.replace(/\D/g, '');
}
function telephonyOn() {
  const v = cache.settings.telephony_enabled;
  return v === '1' || v === 1 || v === true || v === 'true';
}
/* כפתור חייגן — מחזיר '' כשהטלפוניה כבויה */
function phoneBtn(phone) {
  if (!telephonyOn() || !phone) return '';
  return `<button class="btn btn-sm btn-ghost" title="חייג דרך Voicenter" onclick="event.stopPropagation();phoneCall('${esc(String(phone))}')">📞 חייג</button>`;
}
async function phoneCall(phone) {
  const target = normPhone(phone);
  if (!target) { toast('אין מספר תקין לחיוג', true); return; }
  toast('מחייג ל-' + phone + '...');
  try {
    const { error } = await db.functions.invoke('call-dial', { body: { target } });
    if (error) throw error;
    toast('☎ מצלצל אצלך — ענה כדי להתחבר ללקוח');
  } catch (e) {
    console.error('call-dial', e);
    toast('החייגן עדיין לא מחובר (ממתין להגדרת Voicenter)', true);
  }
}

/* ---------- 10. מעקב היסטוריה — Audit (פיצ'ר #11) ----------
   צופה גנרי ברשומות audit_log של שורה: auditShow('customers', id, 'שם').
   הכתיבה נעשית ע"י טריגרים ב-DB (מיגרציית audit_log) — לא מכאן. */

const AUDIT_FIELD_HE = {
  name: 'שם', invoice_name: 'שם לחשבונית', phone: 'טלפון', whatsapp: 'וואטסאפ', email: 'מייל',
  contact_person: 'איש קשר', contact_role: 'תפקיד', city: 'עיר', address: 'כתובת', field: 'תחום',
  business_id: 'ח.פ/עוסק', status: 'סטטוס', status_reason: 'סיבת סטטוס', crm_status: 'סטטוס CRM',
  agent_id: 'סוכן', payment_terms: 'תנאי תשלום', credit_limit: 'מסגרת אשראי', notes: 'הערות',
  amount: 'סכום', price: 'מחיר', discount: 'הנחה', due_date: 'תאריך יעד', issued_date: 'תאריך חיוב',
  paid_date: 'תאריך תשלום', method: 'אמצעי תשלום', description: 'פירוט', invoice_number: 'מס\' חשבונית',
  title: 'כותרת', page_number: 'עמוד', issue_id: 'גיליון', deal_stage: 'שלב עסקה', source: 'מקור',
  follow_up: 'תאריך מעקב', follow_up_time: 'שעת מעקב', total_price: 'מחיר כולל', total_inserts: 'כמות פרסומים',
  is_standing_order: 'הוראת קבע', standing_order_amount: 'סכום הו"ק', active: 'פעיל',
  fixed_discount: 'הנחה קבועה', order_doc_type: 'סוג מסמך'
};
const AUDIT_ACTION_HE = { insert: '➕ נוצר', update: '✏️ עודכן', delete: '🗑 נמחק' };

let _auditUsers = null;
async function _auditUserName(uid) {
  if (!uid) return 'מערכת';
  if (!_auditUsers) {
    _auditUsers = {};
    try {
      const rows = await run(db.from('profiles').select('id,full_name'));
      rows.forEach(p => _auditUsers[p.id] = p.full_name || '');
    } catch (e) { }
  }
  return _auditUsers[uid] || 'משתמש';
}

async function auditShow(tableName, rowId, title) {
  let rows = [];
  try {
    rows = await run(db.from('audit_log').select('*')
      .eq('table_name', tableName).eq('row_id', rowId)
      .order('at', { ascending: false }).limit(200));
  } catch (e) {
    toast('טבלת ההיסטוריה עוד לא קיימת — יש להריץ את מיגרציית audit_log', true);
    return;
  }
  await _auditUserName(rows.length ? rows[0].user_id : null); // טוען את מפת השמות
  const fh = f => AUDIT_FIELD_HE[f] || f;
  const val = v => v === '' || v == null ? '—' : esc(String(v).length > 60 ? String(v).slice(0, 60) + '…' : v);
  const items = [];
  for (const r of rows) {
    const who = await _auditUserName(r.user_id);
    if (r.action === 'update') {
      items.push(`<tr><td style="white-space:nowrap">${heDateTime(r.at)}</td><td>${esc(who)}</td>
        <td><b>${esc(fh(r.field))}</b></td><td dir="auto">${val(r.old_value)} ← ${val(r.new_value)}</td></tr>`);
    } else {
      items.push(`<tr><td style="white-space:nowrap">${heDateTime(r.at)}</td><td>${esc(who)}</td>
        <td colspan="2"><b>${AUDIT_ACTION_HE[r.action] || r.action}</b></td></tr>`);
    }
  }
  document.getElementById('auditOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'auditOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,20,40,.55);display:flex;align-items:center;justify-content:center;z-index:99998;padding:16px;direction:rtl';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:16px;padding:20px;max-width:640px;width:96%;max-height:86vh;overflow:auto">
    <h3 style="margin:0 0 4px">🕘 היסטוריית שינויים${title ? ' — ' + esc(title) : ''}</h3>
    <p class="muted" style="font-size:.8rem;margin:0 0 10px">מי שינה מה ומתי (עד 200 שינויים אחרונים). נרשם אוטומטית מרגע הפעלת המעקב.</p>
    ${items.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>מתי</th><th>מי</th><th>שדה</th><th>שינוי (ישן ← חדש)</th></tr></thead>
      <tbody>${items.join('')}</tbody></table></div>` : '<p class="empty">אין עדיין רשומות היסטוריה לשורה הזו</p>'}
    <div style="margin-top:12px;text-align:left"><button class="btn btn-ghost" onclick="document.getElementById('auditOv').remove()">סגירה</button></div>
  </div>`;
  document.body.appendChild(ov);
}
