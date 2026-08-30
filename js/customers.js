/* ============================================================
customers.js — מודול לקוחות
------------------------------------------------------------
- רשימת לקוחות עם חיפוש וסינון
- כרטיס לקוח מרכז: פרטים, מודעות, חוזים, חיובים, תשלומים,
יתרת חוב, ציר זמן, קישור פורטל אישי
- סטטוס מוקפא / רשימה שחורה עם סיבה
============================================================ */

'use strict';

let _customers = [];
let _custDebt = {};

const CUSTOMER_STATUS = { active: ['פעיל', 'green'], frozen: ['מוקפא', 'amber'], blacklist: ['רשימה שחורה', 'red'] };
// סטטוס CRM (פיצ'ר #13) — ממד נפרד מהסטטוס התפעולי שלמעלה:
// איפה הלקוח במחזור החיים, לא האם מותר לעבוד איתו.
const CRM_STATUS = { prospect: ['מתעניין', 'amber'], active: ['פעיל', 'green'], past: ['לקוח בעבר', ''] };

/* ---- שיפורים: הנחה קבועה · שער סטטוס · מפת חוב · מיפוי תנאי תשלום בייבוא ---- */
function _custFind(id) { return (cache.customers || []).find(x => x.id === id) || (_customers || []).find(x => x.id === id) || null; }

/* סכום ההנחה הקבועה (₪) של הלקוח על מחיר נתון */
function custFixedDiscountAmount(customerId, price) {
  const c = _custFind(customerId); const pct = c && Number(c.fixed_discount);
  if (!pct || !(price > 0)) return 0;
  return Math.round(price * pct / 100 * 100) / 100;
}

/* שער סטטוס: רשימה שחורה חוסמת, מוקפא מזהיר. מחזיר true אם מותר להמשיך */
async function checkCustomerStatusGate(customerId, actionLabel) {
  try {
    let c = _custFind(customerId);
    if (!c) { try { c = await run(db.from('customers').select('status,status_reason,name').eq('id', customerId).single()); } catch (e) { return true; } }
    if (!c) return true;
    const who = c.name || 'הלקוח';
    if (c.status === 'blacklist') { toast('⛔ ' + who + ' ברשימה שחורה' + (c.status_reason ? ' — ' + c.status_reason : '') + '. ' + (actionLabel || 'הפעולה') + ' חסומה.', true); return false; }
    if (c.status === 'frozen') { return confirm('⚠ ' + who + ' מסומן כמוקפא' + (c.status_reason ? ' — ' + c.status_reason : '') + '.\nלהמשיך ב' + (actionLabel || 'פעולה') + ' בכל זאת?'); }
    return true;
  } catch (e) { return true; }
}

/* מפת יתרת חוב לכל הלקוחות (לרשימה) */
async function _loadCustDebt() {
  const map = {};
  try {
    const open = await run(db.from('charges').select('id,customer_id,amount,due_date,status').in('status', ['pending', 'invoiced', 'partial', 'overdue']));
    if (!open.length) return map;
    const ids = open.map(c => c.id); const paid = {};
    try { const pays = await run(db.from('payments').select('charge_id,amount').in('charge_id', ids)); pays.forEach(pp => { paid[pp.charge_id] = (paid[pp.charge_id] || 0) + Number(pp.amount); }); } catch (e) { }
    const T = today();
    open.forEach(c => { const bal = Number(c.amount) - (paid[c.id] || 0); if (bal > 0.001) { const m = map[c.customer_id] = map[c.customer_id] || { debt: 0, overdue: false }; m.debt += bal; if (c.status === 'overdue' || (c.due_date && c.due_date < T)) m.overdue = true; } });
  } catch (e) { console.error('cust debt', e); }
  return map;
}

/* מיפוי תנאי תשלום מטקסט חופשי (לייבוא) */
function _importTerms(v) { const x = String(v || '').replace(/\s/g, ''); if (/60/.test(x)) return 'net60'; if (/30/.test(x)) return 'net30'; return 'immediate'; }

Pages.customers = {
render: async (el) => {
_customers = await run(db.from('customers').select('*').order('name'));
const canWrite = ['admin', 'sales'].includes(profile.role);
el.innerHTML = `
<div class="page-head">
<h2>לקוחות <span class="muted" style="font-size:.9rem">(${_customers.length})</span></h2>
<div class="actions">
${canWrite ? `
<input type="file" id="custImportFile" class="hidden" accept=".xlsx,.xls,.csv" onchange="customersImport()">
<button class="btn btn-ghost" onclick="document.getElementById('custImportFile').click()">⬆ ייבוא מאקסל</button>
<button class="btn btn-ghost" onclick="customersExport()">⬇ ייצוא לאקסל</button>
${profile.role === 'admin' ? `<button class="btn btn-ghost" onclick="customerMergeOpen()">🔗 מיזוג כפולים</button>` : ''}
<button class="btn" onclick="customerAdd()">+ לקוח חדש</button>` : ''}
</div>
</div>
<div class="filter-bar">
<input id="custSearch" placeholder="חיפוש שם / טלפון / תחום..." oninput="customersDraw()" style="min-width:220px">
<select id="custAgentFilter" onchange="customersDraw()">
<option value="">כל הסוכנים</option>
${cache.agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
</select>
<select id="custCrmFilter" onchange="customersDraw()">
<option value="">כל סטטוסי ה-CRM</option>
<option value="prospect">מתעניינים</option>
<option value="active">פעילים</option>
<option value="past">לקוחות בעבר</option>
</select>
<select id="custStatusFilter" onchange="customersDraw()">
<option value="">כל הסטטוסים</option>
<option value="active">פעילים</option>
<option value="frozen">מוקפאים</option>
<option value="blacklist">רשימה שחורה</option>
</select>
<select id="custTagFilter" onchange="customersDraw()">
<option value="">כל התגיות</option>
${(typeof custAllTags==='function'?custAllTags():[]).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
</select>
</div>
<div id="custBulkBar" class="hidden"></div>
<div class="card" id="custTable"></div>`;
if (typeof _custSelected !== 'undefined') _custSelected.clear();
customersDraw();
_loadCustDebt().then(m => { _custDebt = m; if (document.getElementById('custTable')) customersDraw(); });
}
};

/* סינון הרשימה לפי חיפוש/סוכן/סטטוס — משותף לתצוגה ולייצוא */
function _customersFiltered() {
const term = (document.getElementById('custSearch')?.value || '').trim();
const agent = document.getElementById('custAgentFilter')?.value || '';
const status = document.getElementById('custStatusFilter')?.value || '';
const crm = document.getElementById('custCrmFilter')?.value || '';
const tag = document.getElementById('custTagFilter')?.value || '';
return _customers.filter(c =>
(!agent || c.agent_id === Number(agent)) &&
(!status || c.status === status) &&
(!crm || (c.crm_status || 'active') === crm) &&
(!tag || (c.tags || []).includes(tag)) &&
(!term || [c.name, c.phone, c.whatsapp, c.contact_person, c.field, c.email, c.business_id, c.city, c.invoice_name].some(v => (v || '').includes(term))));
}

/* ייצוא הרשימה המסוננת ל-CSV/Excel */
function customersExport() {
const rows = _customersFiltered();
if (!rows.length) { toast('אין לקוחות לייצוא', true); return; }
const data = rows.map(c => [
c.name || '', c.contact_person || '', c.phone || '', c.whatsapp || '', c.email || '',
c.city || '', c.field || '', nameOf('agents', c.agent_id) || '', PAY_TERMS[c.payment_terms] || '',
(_custDebt[c.id] && _custDebt[c.id].debt) || 0, (CUSTOMER_STATUS[c.status] || [''])[0]]);
exportCsv('לקוחות_' + today(), ['שם העסק', 'איש קשר', 'טלפון', 'וואטסאפ', 'מייל', 'יישוב', 'תחום', 'סוכן', 'תנאי תשלום', 'יתרת חוב', 'סטטוס'], data);
toast('✓ יוצאו ' + rows.length + ' לקוחות');
}

function customersDraw() {
const rows = _customersFiltered();
const _sel = (typeof _custSelected !== 'undefined') ? _custSelected : new Set();
const _allSel = rows.length && rows.every(r => _sel.has(r.id));
renderTable(document.getElementById('custTable'), rows, [
{ h: `<input type="checkbox" id="custSelAll" title="בחר הכל" ${_allSel ? 'checked' : ''} onclick="custSelAllVisible(this.checked)">`, f: r => `<input type="checkbox" class="custSelChk" ${_sel.has(r.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="custToggleSel(${r.id}, this.checked)">` },
{ h: 'שם העסק', f: r => `<b>${esc(r.name)}</b>` },
{ h: 'איש קשר', f: r => esc(r.contact_person) },
{ h: 'טלפון', f: r => `<span dir="ltr">${esc(r.phone)}</span>` },
{ h: 'תחום', f: r => esc(r.field) },
{ h: 'תגיות', f: r => (typeof custTagChips === 'function' ? custTagChips(r.tags) : '') },
{ h: 'סוכן', f: r => esc(nameOf('agents', r.agent_id)) },
{ h: 'תנאי תשלום', f: r => PAY_TERMS[r.payment_terms] || '' },
{ h: 'יתרת חוב', f: r => { const d = _custDebt[r.id]; if (!d || !(d.debt > 0)) return '<span class="muted">—</span>'; return `<b style="color:${d.overdue ? '#b91c1c' : '#334155'}">${money(d.debt)}${d.overdue ? ' ⏰' : ''}</b>`; } },
{ h: 'סטטוס', f: r => { const s = CUSTOMER_STATUS[r.status]; return `<span class="pill ${s[1]}">${s[0]}</span>`; } },
{ h: 'CRM', f: r => { const s = CRM_STATUS[r.crm_status || 'active']; return s ? `<span class="pill ${s[1]}">${s[0]}</span>` : ''; } },
], { onRow: r => openCustomerCard(r.id), empty: 'אין לקוחות תואמים' });
if (typeof custBulkBarUpdate === 'function') custBulkBarUpdate();
}

const CUSTOMER_FIELDS = [
{ type: 'section', label: 'זיהוי' },
{ name: 'name', label: 'שם לקוח', required: true },
{ name: 'crm_status', label: 'סטטוס CRM', type: 'select', default: 'active',
  options: [{ v: 'prospect', t: 'מתעניין' }, { v: 'active', t: 'פעיל' }, { v: 'past', t: 'לקוח בעבר' }] },
{ name: 'invoice_name', label: 'שם לחשבונית' },
{ type: 'html', html: '<button type="button" class="btn btn-sm btn-ghost" onclick="custInvoiceCopy()">⬅ זהה לשם הלקוח</button>' },
{ name: 'business_id', label: 'ח.פ / עוסק', dir: 'ltr' },
{ name: 'order_doc_type', label: 'מסמך בהזמנה (EZcount)', type: 'select', options: [{ v: 'proforma', t: 'חשבון עסקה (ברירת מחדל)' }, { v: 'tax_invoice', t: 'חשבונית מס' }] },
{ name: 'contact_person', label: 'איש קשר' },
{ name: 'contact_role', label: 'תפקיד איש הקשר' },
{ name: 'phone', label: 'טלפון', dir: 'ltr' },
{ name: 'whatsapp', label: 'וואטסאפ / טלפון נוסף', dir: 'ltr' },
{ name: 'email', label: 'אימייל', dir: 'ltr' },
{ name: 'address', label: 'כתובת' },
{ name: 'city', label: 'יישוב' },
{ name: 'field', label: 'תחום' },
{ type: 'section', label: 'חיוב וכספים' },
{ name: 'agent_id', label: 'סוכן קבוע', type: 'select', options: 'agents' },
{ name: 'payment_terms', label: 'תנאי תשלום', type: 'select', required: true, default: 'immediate',
options: [{ v: 'immediate', t: 'מיידי' }, { v: 'net30', t: 'שוטף+30' }, { v: 'net60', t: 'שוטף+60' }] },
{ name: 'pay_method', label: 'אמצעי תשלום מועדף', type: 'select',
options: [{ v: 'transfer', t: 'העברה בנקאית' }, { v: 'check', t: 'צ׳ק' }, { v: 'credit', t: 'אשראי' }, { v: 'cash', t: 'מזומן' }] },
{ name: 'fixed_discount', label: 'הנחה קבועה (%)', type: 'number' },
{ name: 'credit_limit', label: 'תקרת חוב / מסגרת אשראי (₪)', type: 'number' },
{ type: 'section', label: 'הערות' },
{ name: 'notes', label: 'הערות', type: 'textarea' },
];

/* יומן שינויים: השוואת ערכים ישנים/חדשים לפי שדות הטופס (לתיעוד בציר הזמן) */
function _custDiff(oldObj, newRec) {
const labels = {}; CUSTOMER_FIELDS.forEach(f => { if (f.name) labels[f.name] = f.label; });
const out = [];
Object.keys(newRec || {}).forEach(k => {
if (!labels[k]) return;
const ov = oldObj[k] == null ? '' : String(oldObj[k]);
const nv = newRec[k] == null ? '' : String(newRec[k]);
if (ov !== nv) out.push(`${labels[k]}: "${ov || '—'}" ← "${nv || '—'}"`);
});
return out;
}

/* העתקת שם הלקוח לשדה שם החשבונית בלחיצה */
function custInvoiceCopy() {
const n = document.getElementById('f_name');
const inv = document.getElementById('f_invoice_name');
if (n && inv) { inv.value = n.value; toast('הועתק שם הלקוח'); }
}

function customerAdd() {
openForm('לקוח חדש', CUSTOMER_FIELDS, {}, async (rec) => {
if (rec.phone) {
const dups = await run(db.rpc('check_duplicate_phone', { p_phone: rec.phone }));
if (dups.length && !confirm(`הטלפון כבר קיים אצל "${dups[0].name}". להוסיף בכל זאת?`)) return;
}
const _nm = (rec.name || '').trim();
const _dupC = (cache.customers || []).find(x => (x.name || '').trim() === _nm);
if (_dupC && confirm('כבר קיים לקוח בשם "' + _nm + '".\nאישור = לפתוח את הכרטיס הקיים כדי להזין/לעדכן את הנתונים · ביטול = להוסיף כלקוח חדש נפרד')) { openCustomerCard(_dupC.id); return; }
const data = await run(db.from('customers').insert(rec).select().single());
await addInteraction('customer', data.id, 'הלקוח נוצר');
await refreshCache();
toast('הלקוח נוסף');
openPage('customers');
});
}

/* יצירת לקוח חדש בטופס המלא — לשימוש חוזר מכל מסלול (הזנת גיליון / ייבוא PDF).
   פותח את אותו חלון "לקוח חדש" עם כל השדות (ח.פ, שם לחשבונית, כתובת וכו').
   onDone(customer) נקרא אחרי היצירה כדי לבחור את הלקוח בהקשר שממנו נקרא. */
function customerCreateFull(preName, onDone) {
const seed = preName ? { name: String(preName).trim() } : {};
openForm('לקוח חדש', CUSTOMER_FIELDS, seed, async (rec) => {
if (rec.phone) {
const dups = await run(db.rpc('check_duplicate_phone', { p_phone: rec.phone }));
if (dups.length && !confirm(`הטלפון כבר קיים אצל "${dups[0].name}". להוסיף בכל זאת?`)) return;
}
const _nm = (rec.name || '').trim();
const _dupC = (cache.customers || []).find(x => (x.name || '').trim() === _nm);
if (_dupC && confirm('כבר קיים לקוח בשם "' + _nm + '".\nאישור = להשתמש בלקוח הקיים · ביטול = ליצור לקוח חדש נפרד')) {
await refreshCache();
if (typeof onDone === 'function') await onDone(_dupC);
return;
}
const data = await run(db.from('customers').insert(rec).select().single());
try { await addInteraction('customer', data.id, 'הלקוח נוצר'); } catch (e) { }
await refreshCache();
toast('✓ לקוח נוסף');
if (typeof onDone === 'function') await onDone(data);
});
}

function customerEdit(id) {
const c = _customers.find(x => x.id === id);
document.getElementById('viewBack').classList.remove('open');
openForm('עריכת לקוח — ' + c.name, CUSTOMER_FIELDS, c, async (rec) => {
const _changes = _custDiff(c, rec);
await run(db.from('customers').update(rec).eq('id', id));
if (_changes.length) { try { await addInteraction('customer', id, '✏️ עריכה: ' + _changes.join(' · ')); } catch (e) { } }
await refreshCache();
toast('נשמר');
openPage('customers');
});
}

/* --- כרטיס הלקוח: מרכז את כל המידע --- */
async function openCustomerCard(id) {
_ccEnsureCss();
let c = _customers.find(x => x.id === id);
if (!c) c = await run(db.from('customers').select('*').eq('id', id).single());
const canWrite = ['admin', 'sales'].includes(profile.role);
const canMoney = ['admin', 'sales'].includes(profile.role);

// כל הנתונים הקשורים נטענים במקביל
const [ads, contracts, charges, payments, notes] = await Promise.all([
run(db.from('ads').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(300)),
canMoney ? run(db.from('contracts').select('*').eq('customer_id', id).order('created_at', { ascending: false })) : [],
canMoney ? run(db.from('charges').select('*').eq('customer_id', id).order('issued_date', { ascending: false }).limit(50)) : [],
canMoney ? run(db.from('payments').select('*').eq('customer_id', id).order('paid_date', { ascending: false }).limit(50)) : [],
loadTimeline('customer', id),
]);

const totalCharged = charges.filter(x => !['cancelled', 'lost'].includes(x.status)).reduce((s, x) => s + Number(x.amount), 0);
const totalPaid = payments.reduce((s, x) => s + Number(x.amount), 0);
const debt = totalCharged - totalPaid;
const liveAds = ads.filter(a => !['cancelled', 'rejected'].includes(a.status));
const adRevenue = liveAds.reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);
const issuesSet = new Set(liveAds.map(a => a.issue_id).filter(Boolean));
const openCh = charges.filter(x => ['pending', 'invoiced', 'partial', 'overdue'].includes(x.status));
const overdueAmt = charges.filter(x => x.status === 'overdue').reduce((s, x) => s + Number(x.amount || 0), 0);
const nextIssue = (cache.issues || []).filter(i => (i.publish_date || '') >= today()).sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')))[0];
const bookedNext = !!(nextIssue && liveAds.some(a => a.issue_id === nextIssue.id));
const churnGap = Number((cache.settings || {}).churn_gap_issues) || 4;
const _lastAdIssue = liveAds.map(a => (cache.issues || []).find(i => i.id === a.issue_id)).filter(Boolean).sort((a, b) => String(b.publish_date || '').localeCompare(String(a.publish_date || '')))[0];
let churnGapCount = 0, churnRisk = false;
if (liveAds.length && _lastAdIssue) { churnGapCount = (cache.issues || []).filter(i => (i.publish_date || '') > (_lastAdIssue.publish_date || '') && (i.publish_date || '') <= today()).length; churnRisk = churnGapCount >= churnGap; }
const creditLimit = Number(c.credit_limit) || 0;
const overLimit = creditLimit > 0 && debt > creditLimit;
const st = CUSTOMER_STATUS[c.status];

const portalUrl = location.href.replace(/index\.html.*$/, '').replace(/\/$/, '') + '/portal/?t=' + c.portal_token;

const modal = document.getElementById('viewModal');
modal.innerHTML = `
<h3>${esc(c.name)} <span class="pill ${st[1]}">${st[0]}</span>${(c.crm_status && c.crm_status !== 'active' && CRM_STATUS[c.crm_status]) ? ` <span class="pill ${CRM_STATUS[c.crm_status][1]}">${CRM_STATUS[c.crm_status][0]}</span>` : ''}</h3>
${c.status !== 'active' && c.status_reason ? `<p style="color:var(--danger);font-size:.85rem;margin-top:-10px">סיבה: ${esc(c.status_reason)}</p>` : ''}
${(canWrite && !(c.business_id && String(c.business_id).trim())) ? `<div style="background:#fdecec;border:1px solid #f5b5b5;color:#b91c1c;border-radius:9px;padding:8px 12px;margin:6px 0;font-size:.86rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">⚠ חסר <b>ח.פ / עוסק</b> — יש להשלים לפני הפקת חשבונית. <button class="btn btn-sm" style="background:var(--brand)" onclick="customerEdit(${id})">✎ השלמת ח.פ</button></div>` : ''}
${canWrite ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 8px">
<span style="font-size:.8rem;color:#64748b">תגיות:</span>
${(typeof custTagChips === 'function' ? custTagChips(c.tags) : '')}
<button class="btn btn-sm btn-ghost" onclick="custEditTags(${id})">✎ עריכת תגיות</button>
</div>` : ''}

<div style="font-size:.9rem;color:#334155;margin:2px 0 6px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
<span dir="ltr">📞 ${esc(c.phone) || '—'}</span>
<span>סוכן: ${esc(nameOf('agents', c.agent_id)) || '—'}</span>
<span>${PAY_TERMS[c.payment_terms] || ''}</span>
<button class="btn btn-sm btn-ghost" onclick="custToggleDetails(this)">כל הפרטים ▾</button>
</div>
<div id="ccGrid" class="grid3 hidden" style="font-size:.9rem">
<div><label>איש קשר</label><b>${esc(c.contact_person) || '—'}</b></div>
<div><label>שם לחשבונית</label><b>${esc(c.invoice_name) || esc(c.name)}</b></div>
<div><label>ח.פ / עוסק</label><b dir="ltr">${esc(c.business_id) || '—'}</b></div>
<div><label>טלפון</label><b dir="ltr">${esc(c.phone) || '—'}</b></div>
<div><label>אימייל</label><b dir="ltr">${esc(c.email) || '—'}</b></div>
<div><label>וואטסאפ</label><b dir="ltr">${esc(c.whatsapp) || '—'}</b></div>
<div><label>עיר</label><b>${esc(c.city) || '—'}</b></div>
<div><label>תחום</label><b>${esc(c.field) || '—'}</b></div>
<div><label>סוכן</label><b>${esc(nameOf('agents', c.agent_id)) || '—'}</b></div>
<div><label>תנאי תשלום</label><b>${PAY_TERMS[c.payment_terms]}</b></div>
<div><label>לקוח מאז</label><b>${heDate(c.became_customer_at)}</b></div>
${canMoney ? `<div><label>סה"כ חויב</label><b>${money(totalCharged)}</b></div>` : ''}
</div>

${canMoney ? `
<div class="cc-kpis">
<div class="cc-kpi" style="flex:2;min-width:200px;background:${debt > 0 ? '#fef2f2' : '#f0fdf4'};border:1px solid ${debt > 0 ? '#fecaca' : '#bbf7d0'};border-radius:12px;padding:12px 14px">
<div style="font-size:.78rem;color:#64748b">יתרת חוב</div>
<div style="font-size:1.7rem;font-weight:800;color:${debt > 0 ? '#b91c1c' : '#15803d'}">${money(debt) || '₪0'}</div>
<div style="font-size:.76rem;color:#475569;margin-top:2px">${openCh.length} חיובים פתוחים${overdueAmt > 0 ? ` · <b style="color:#b91c1c">${money(overdueAmt)} באיחור</b>` : ''}${creditLimit > 0 ? ` · מסגרת ${money(creditLimit)}${overLimit ? ' <b style="color:#b91c1c">חריגה!</b>' : ''}` : ''}</div>
</div>
<div class="cc-kpi" style="flex:1;min-width:120px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:12px;text-align:center;display:flex;flex-direction:column;justify-content:center"><div style="font-size:1.25rem;font-weight:800;color:#0369a1">${money(adRevenue)}</div><div style="font-size:.72rem;color:#475569">הכנסות ממודעות</div></div>
<div class="cc-kpi" style="flex:1;min-width:100px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:12px;padding:12px;text-align:center;display:flex;flex-direction:column;justify-content:center"><div style="font-size:1.25rem;font-weight:800;color:#7e22ce">${issuesSet.size}</div><div style="font-size:.72rem;color:#475569">גיליונות</div></div>
</div>
${nextIssue ? `<div style="margin:-4px 0 10px;font-size:.85rem;padding:8px 10px;border-radius:8px;background:${bookedNext ? '#f0fdf4' : '#fffbeb'};border:1px solid ${bookedNext ? '#bbf7d0' : '#fde68a'};color:${bookedNext ? '#15803d' : '#92400e'}">${bookedNext ? '✓ מוזמן לגיליון הקרוב' : '⚠ טרם הזמין לגיליון הקרוב'} — גיליון ${nextIssue.issue_number}${nextIssue.publish_date ? ' (' + heDate(nextIssue.publish_date) + ')' : ''}</div>` : ''}
${churnRisk ? `<div style="margin:-4px 0 10px;font-size:.85rem;padding:8px 10px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b">⚠ <b>בסיכון נטישה</b> — לא פרסם ${churnGapCount} גיליונות ברצף</div>` : ''}
${overLimit ? `<div style="margin:-4px 0 10px;font-size:.85rem;padding:8px 10px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b">⛔ <b>חריגה ממסגרת אשראי</b> — חוב ${money(debt)} מתוך מסגרת ${money(creditLimit)}</div>` : ''}
` : ''}
${canWrite ? `<div class="cc-toolbar">
<button class="cc-tbtn cc-primary" data-tip="מודעה לגיליון" aria-label="מודעה לגיליון" onclick="adAdd({customer_id:${id}})">${_ccIco('plus')}</button>
<span class="cc-tsep"></span>
<div class="cc-mwrap">
<button class="cc-tbtn" data-tip="חשבונית ומסמכים" aria-label="חשבונית ומסמכים" onclick="ccMenu(event,'ccInvMenu')">${_ccIco('doc')}<span class="cc-cx"></span></button>
<div id="ccInvMenu" class="cc-menu hidden">
<button class="btn" onclick="ccMenuClose();invIssueOrder(${id})">🧾 הפקת חשבונית</button>
<button class="btn" onclick="ccMenuClose();invIssueReceiptDirect(${id})">🧾 חשבונית מס קבלה${debt > 0 ? ' <span class="pill red" style="font-size:.66rem">חוב פתוח</span>' : ''}</button>
<button class="btn" onclick="ccMenuClose();window.openQuoteForm ? openQuoteForm({customer_id:${id}, recipient_name:'${esc(c.name).replace(/'/g, '&#39;')}'}) : toast('בטעינה')">📝 הצעת מחיר</button>
<button class="btn" onclick="ccMenuClose();dealNew(${id})">💼 עסקה חדשה</button>
<div class="cc-msep"></div>
<button id="csBtn" class="btn" onclick="ccMenuClose();customerStatement(${id})">📄 כרטסת / דו"ח חוב</button>
${(typeof waRemindersOn === 'function' && waRemindersOn() && debt > 0) ? `<button class="btn" onclick="ccMenuClose();debtReminderSend(${id})">💬 שלח תזכורת חוב</button>` : ''}
</div>
</div>
<div class="cc-mwrap">
<button class="cc-tbtn" data-tip="עוד פעולות" aria-label="עוד פעולות" onclick="ccMenu(event,'ccMoreMenu')">${_ccIco('dots')}<span class="cc-cx"></span></button>
<div id="ccMoreMenu" class="cc-menu hidden">
${phoneBtn(c.phone)}
${(c.whatsapp || c.phone) ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${_ccIntl(c.whatsapp || c.phone)}">💬 וואטסאפ</a>` : ''}
${(typeof ecIsCenter==='function' && ecIsCenter(id)) ? `<button class="btn" onclick="ccMenuClose();ecEmailsModal(${id})">✉️ מיילים לקטגוריות</button>` : ''}
<button class="btn" onclick="ccMenuClose();customerEdit(${id})">✎ עריכת פרטים</button>
<button class="btn" onclick="ccMenuClose();customerAddNote(${id})">＋ הוסף הערה</button>
<button class="btn" onclick="ccMenuClose();customerStatusChange(${id})">🔄 שינוי סטטוס</button>
<button class="btn" onclick="custPortalShow()">🔗 קישור פורטל</button>
${profile.role === 'admin' ? `<div class="cc-msep"></div><button class="btn btn-danger-ghost" onclick="ccMenuClose();customerDelete(${id})">🗑 מחיקת לקוח</button>` : ''}
</div>
</div>
<span style="flex:1"></span>
<button class="cc-tbtn cc-danger" data-tip="סגירה" aria-label="סגירה" onclick="document.getElementById('viewBack').classList.remove('open')">${_ccIco('x')}</button>
</div>
<div id="ccPortalBox" class="hidden" style="margin-top:8px">
<div style="display:flex;gap:8px">
<input readonly value="${esc(portalUrl)}" dir="ltr" style="font-size:.78rem" onclick="this.select()">
<button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText('${esc(portalUrl)}').then(()=>toast('הקישור הועתק'))">העתקה</button>
<button class="btn btn-sm btn-danger-ghost" onclick="portalTokenReset(${id})">חידוש קישור</button>
</div>
</div>` : `<div class="m-actions"><button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`}

<div class="tabs" style="margin-top:16px">
<button class="active" onclick="custTab(this,'ccAds')">מודעות (${ads.length})</button>
${canMoney ? `<button onclick="custTab(this,'ccContracts')">חוזים (${contracts.length})</button>
<button onclick="custTab(this,'ccMoney')">💰 כספים (${charges.length + payments.length})</button>` : ''}
<button onclick="custTab(this,'ccContacts')">אנשי קשר (${((c.contacts)||[]).length})</button>
${['admin', 'sales'].includes(profile.role) ? `<button onclick="custTab(this,'ccExtra')">📎 קבצים ומשימות</button>` : ''}
<button onclick="custTab(this,'ccTimeline')">ציר זמן</button>
</div>

<div id="ccAds" class="cc-tab">
${custAdsGroupedHtml(ads, id)}
</div>
${canMoney ? `
<div id="ccContracts" class="cc-tab hidden">
${contracts.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>חבילה</th><th>נוצל</th><th>מחיר</th><th>מצב</th></tr></thead><tbody>
${contracts.map(ct => `<tr><td>${esc(nameOf('priceList', ct.price_item_id))} × ${ct.total_inserts}</td>
<td id="ctUsed${ct.id}">—</td><td>${money(ct.total_price)}</td>
<td>${ct.active ? '<span class="pill green">פעיל</span>' : '<span class="pill">הסתיים</span>'}</td></tr>`).join('')}
</tbody></table></div>` : '<p class="muted">אין חוזים</p>'}
${contracts.filter(ct => Array.isArray(ct.payment_plan) && ct.payment_plan.length).map(ct => `<div style="margin-top:14px"><b>לוח תשלומים — ${esc(nameOf('priceList', ct.price_item_id))}</b>${(typeof dealPlanHtml==='function'?dealPlanHtml(ct):'')}</div>`).join('')}
</div>
<div id="ccMoney" class="cc-tab hidden">
<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:.9rem;margin-bottom:12px;background:#f8fafc;border:1px solid #eef2f7;border-radius:10px;padding:10px 12px">
<span>יתרת חוב: <b style="color:${debt > 0 ? '#b91c1c' : '#15803d'}">${money(debt) || '₪0'}</b></span>
<span>סה"כ חויב: <b>${money(totalCharged)}</b></span>
<span>שולם: <b>${money(totalPaid)}</b></span>
<span>${openCh.length} חיובים פתוחים</span>
</div>
<div id="ccInvoices"></div>
<div style="margin:16px 0 6px"><b>כרטסת (חיובים ותשלומים)</b></div>
${_custLedgerHtml(charges, payments)}
</div>` : ''}
<div id="ccContacts" class="cc-tab hidden">${typeof custContactsRender === 'function' ? custContactsRender(c) : ''}</div>
<div id="ccTimeline" class="cc-tab hidden">${timelineHtml(notes)}</div>
<div id="ccExtra" class="cc-tab hidden" style="margin-top:6px"></div>`;

document.getElementById('viewBack').classList.add('open');

// ניצול חוזים — שאילתה קטנה לכל חוזה (קריא ופשוט לדיבוג)
for (const ct of contracts) {
const { count } = await db.from('ads').select('id', { count: 'exact', head: true })
.eq('contract_id', ct.id).not('status', 'in', '("cancelled","rejected")');
const cel = document.getElementById('ctUsed' + ct.id);
if (cel) {
const _used = (count || 0) + (Number(ct.used_offset) || 0), _tot = ct.total_inserts || 0;
const _done = _tot && _used >= _tot;
cel.innerHTML = `${_used} מתוך ${_tot}` + (_done ? ` <span class="pill red" style="cursor:pointer" title="העסקה נוצלה — לחדש" onclick="if(window.contractEdit)contractEdit(${ct.id})">⚠ לחדש</span>` : (_tot && _used === _tot - 1 ? ' <span class="pill amber">נשאר 1</span>' : ''));
}
}
}

function custTab(btn, id) {
btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
document.querySelectorAll('.cc-tab').forEach(t => t.classList.toggle('hidden', t.id !== id));
}

/* נירמול טלפון לפורמט בינ"ל לוואטסאפ */
function _ccIntl(p) { let s = String(p || '').replace(/\D/g, ''); if (s.startsWith('0')) s = '972' + s.slice(1); else if (!s.startsWith('972')) s = '972' + s; return s; }

/* היסטוריית מודעות מקובצת לפי גיליון + הדגשת הגיליון הקרוב */
function custAdsGroupedHtml(ads, custId) {
  if (!ads.length) return '<p class="muted">אין מודעות</p>';
  const nextIssue = (cache.issues || []).filter(i => (i.publish_date || '') >= today()).sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')))[0];
  const nextId = nextIssue ? nextIssue.id : null;
  const groups = {};
  ads.forEach(a => { const k = a.issue_id || 0; (groups[k] = groups[k] || []).push(a); });
  const keys = Object.keys(groups).map(Number).sort((k1, k2) => {
    const i1 = (cache.issues || []).find(i => i.id === k1) || {}, i2 = (cache.issues || []).find(i => i.id === k2) || {};
    return String(i2.publish_date || '').localeCompare(String(i1.publish_date || ''));
  });
  return keys.map(k => {
    const list = groups[k];
    const iss = (cache.issues || []).find(i => i.id === k);
    const live = list.filter(a => !['cancelled', 'rejected'].includes(a.status));
    const sub = live.reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);
    const isNext = k === nextId;
    const title = k === 0 ? 'ללא גיליון' : ('גיליון ' + (iss ? iss.issue_number : k) + (iss && iss.publish_date ? ' — ' + heDate(iss.publish_date) : ''));
    return `<div style="border:1px solid ${isNext ? '#16a34a' : 'var(--line,#e5e7eb)'};border-radius:10px;padding:8px 10px;margin-bottom:8px;${isNext ? 'background:#f0fdf4' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <b>${esc(title)} ${isNext ? '<span class="pill green">הגיליון הקרוב</span>' : ''}</b>
        <span style="display:flex;gap:6px;align-items:center;white-space:nowrap"><b>${money(sub)}</b>${k && typeof adProofOpen === 'function' ? `<button class="btn btn-sm btn-ghost" title="הוכחת פרסום" onclick="adProofOpen(${k}, ${custId})">🖼️ הוכחה</button>` : ''}</span>
      </div>
      <table class="data" style="margin-top:6px"><tbody>
      ${list.map(a => `<tr><td>${esc(a.title)}</td><td>${esc(nameOf('priceList', a.price_item_id)) || '—'}</td><td>${a.page_number ? ("עמ' " + a.page_number) : '—'}</td><td>${money(a.price - a.discount)}</td><td>${pill('ad', a.status)} ${(typeof profile !== 'undefined' && ['admin', 'sales'].includes(profile.role)) && typeof DEAL_STAGES !== 'undefined' ? `<select onchange="adStatusSet(${a.id}, this.value).then(function(){ openCustomerCard(${custId}); })" style="font-size:.72rem;padding:2px 4px;border-radius:6px;border:1px solid var(--line,#d1d5db)"><option value="">— סטטוס —</option>${Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}" ${a.deal_stage === v ? 'selected' : ''}>${t[0]}</option>`).join('')}</select>` : (a.deal_stage && typeof dealStageLabel === 'function' ? '<span class="pill" style="font-size:.7rem">' + dealStageLabel(a.deal_stage) + '</span>' : '')}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  }).join('');
}

function customerAddNote(id) {
const content = prompt('מה לתעד?');
if (!content) return;
addInteraction('customer', id, content).then(() => { toast('נרשם'); openCustomerCard(id); });
}

function customerStatusChange(id) {
const c = _customers.find(x => x.id === id);
document.getElementById('viewBack').classList.remove('open');
openForm('שינוי סטטוס — ' + c.name, [
{ name: 'status', label: 'סטטוס', type: 'select', required: true,
options: [{ v: 'active', t: 'פעיל' }, { v: 'frozen', t: 'מוקפא' }, { v: 'blacklist', t: 'רשימה שחורה' }] },
{ name: 'status_reason', label: 'סיבה (להקפאה/רשימה שחורה)' },
], c, async (rec) => {
await run(db.from('customers').update(rec).eq('id', id));
await addInteraction('customer', id, 'סטטוס שונה ל: ' + CUSTOMER_STATUS[rec.status][0] + (rec.status_reason ? ' — ' + rec.status_reason : ''));
toast('עודכן');
openPage('customers');
});
}

/* --- מחיקת לקוח (מנהל בלבד) — נחסמת אם ללקוח יש היסטוריה --- */
async function customerDelete(id) {
  const c = _customers.find(x => x.id === id);
  if (!confirm(`למחוק לצמיתות את הלקוח "${c ? c.name : ''}"?\nהפעולה בלתי-הפיכה.\n(אם ללקוח יש מודעות / חיובים / חוזים — המחיקה תיחסם אוטומטית.)`)) return;
  try {
    await run(db.rpc('delete_customer', { p_customer_id: id }));
    document.getElementById('viewBack')?.classList.remove('open');
    await refreshCache();
    toast('🗑 הלקוח נמחק');
    openPage('customers');
  } catch (e) { /* run shows the block message */ }
}

/* ---------- ייבוא לקוחות מאקסל ----------
עמודות מזוהות אוטומטית לפי הכותרת בשורה הראשונה:
שם (חובה) · טלפון · אימייל · איש קשר · כתובת · תחום · ח.פ · הערות
כפילות לפי טלפון או שם — מדולגת ומדווחת בסוף */
async function customersImport() {
const input = document.getElementById('custImportFile');
const file = input.files[0];
if (!file) return;
input.value = '';
let rows;
try { rows = await readSpreadsheet(file); }
catch (e) { toast('לא הצלחתי לקרוא את הקובץ: ' + e.message, true); return; }
if (!rows.length) { toast('הקובץ ריק או שאין שורת כותרות', true); return; }

const existing = await run(db.from('customers').select('name, phone'));
const knownPhones = new Set(existing.map(c => c.phone).filter(Boolean));
const knownNames = new Set(existing.map(c => c.name.trim()));

const toInsert = [], skipped = [];
for (const row of rows) {
const name = pickField(row, ['שם העסק', 'שם עסק', 'שם הלקוח', 'שם לקוח', 'עסק', 'שם']);
if (!name) { skipped.push('(שורה בלי שם)'); continue; }
const phone = pickField(row, ['טלפון', 'נייד', 'פלאפון', 'סלולרי', 'phone']);
if ((phone && knownPhones.has(phone)) || knownNames.has(name)) { skipped.push(name); continue; }
toInsert.push({
name, phone,
email: pickField(row, ['אימייל', 'מייל', 'דוא', 'email']),
contact_person: pickField(row, ['איש קשר', 'איש', 'קשר']),
address: pickField(row, ['כתובת']),
city: pickField(row, ['יישוב', 'ישוב', 'עיר']),
whatsapp: pickField(row, ['וואטסאפ', 'ווטסאפ', 'whatsapp', 'טלפון נוסף', 'נייד נוסף']),
field: pickField(row, ['תחום', 'ענף', 'קטגוריה']),
business_id: pickField(row, ['ח.פ', 'חפ', 'עוסק', 'ע.מ']),
payment_terms: _importTerms(pickField(row, ['תנאי תשלום', 'תשלום', 'שוטף'])),
notes: pickField(row, ['הערות', 'הערה']),
agent_id: matchAgent(row, null), // עמודת "סוכן" בקובץ
});
if (phone) knownPhones.add(phone);
knownNames.add(name);
}

if (!toInsert.length) { toast('אין שורות חדשות לייבוא (הכל כפול או ריק)', true); return; }
if (!confirm(`נמצאו ${toInsert.length} לקוחות חדשים לייבוא` +
(skipped.length ? `\n(${skipped.length} דולגו — כפולים או בלי שם)` : '') + '\n\nלהמשיך?')) return;

// הכנסה במנות של 50 — יציב גם לקבצים גדולים
for (let i = 0; i < toInsert.length; i += 50)
await run(db.from('customers').insert(toInsert.slice(i, i + 50)));

await refreshCache();
toast(`✓ יובאו ${toInsert.length} לקוחות` + (skipped.length ? ` · דולגו ${skipped.length}` : ''));
openPage('customers');
}

async function portalTokenReset(id) {
if (!confirm('לחדש את הקישור? הקישור הישן יפסיק לעבוד מיידית.')) return;
await run(db.rpc('reset_portal_token', { p_customer_id: id }));
_customers = await run(db.from('customers').select('*').order('name'));
await refreshCache();
toast('קישור חדש הונפק');
openCustomerCard(id);
}

/* ---- כרטיס לקוח נקי: תפריט "עוד", פרטים מלאים, קישור פורטל ---- */
function custToggleMore() { const m = document.getElementById('ccMoreMenu'); if (m) m.classList.toggle('hidden'); }
function custToggleDetails(btn) { const g = document.getElementById('ccGrid'); if (!g) return; const open = g.classList.toggle('hidden') === false; if (btn) btn.textContent = open ? 'פחות פרטים ▲' : 'כל הפרטים ▾'; }
function custPortalShow() { const b = document.getElementById('ccPortalBox'); if (b) { b.classList.toggle('hidden'); const inp = b.querySelector('input'); if (inp && !b.classList.contains('hidden')) inp.select(); } }

/* ---- כרטיס לקוח: סרגל אייקונים אחיד + תפריטים נפתחים ---- */
function _ccIco(n) {
if (n === 'dots') return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const p = { plus: '<path d="M12 5v14M5 12h14"/>', doc: '<path d="M8 2h8l4 4v16H4V2h4Z"/><path d="M8 2v4h8"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>' };
return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (p[n] || '') + '</svg>';
}
function ccMenuClose() { document.querySelectorAll('.cc-menu').forEach(x => x.classList.add('hidden')); }
function ccMenu(ev, id) {
if (ev) ev.stopPropagation();
const m = document.getElementById(id); if (!m) return;
const wasHidden = m.classList.contains('hidden');
ccMenuClose();
if (wasHidden) m.classList.remove('hidden');
}
function _ccEnsureCss() {
if (document.getElementById('ccCardCss')) return;
const st = document.createElement('style'); st.id = 'ccCardCss';
st.textContent = `
.cc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.cc-tsep{width:1px;height:24px;background:var(--line,#e5e7eb)}
.cc-tbtn{width:42px;height:42px;border-radius:11px;border:1px solid var(--line,#e5e7eb);background:#fff;display:inline-grid;place-items:center;cursor:pointer;color:var(--brand);position:relative;padding:0;text-decoration:none;transition:background .15s,border-color .15s}
.cc-tbtn:hover{background:#eef0fb;border-color:#dfe3f5}
.cc-tbtn svg{width:19px;height:19px}
.cc-tbtn.cc-primary{background:var(--brand);border-color:var(--brand);color:#fff}
.cc-tbtn.cc-primary:hover{filter:brightness(.94)}
.cc-tbtn.cc-danger{color:#dc2626}
.cc-tbtn.cc-danger:hover{background:#fef2f2;border-color:#fde0e0}
.cc-tbtn.cc-wa{color:#12a150}
.cc-tbtn[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);background:#1e2340;color:#fff;font-size:11px;font-weight:600;white-space:nowrap;padding:3px 8px;border-radius:6px;pointer-events:none;z-index:60}
.cc-cx{position:absolute;bottom:5px;inset-inline-start:6px;width:0;height:0;border-inline:3px solid transparent;border-top:4px solid currentColor;opacity:.5}
.cc-mwrap{position:relative;display:inline-block}
.cc-menu{position:absolute;top:calc(100% + 6px);inset-inline-start:0;z-index:30;min-width:220px;background:#fff;border:1px solid var(--line,#e5e7eb);border-radius:12px;box-shadow:0 10px 30px rgba(20,25,50,.16);padding:6px}
.cc-menu .btn{display:flex!important;width:100%;justify-content:flex-start;align-items:center;gap:8px;border:none!important;background:none!important;box-shadow:none!important;border-radius:8px;padding:9px 11px!important;margin:0;font-size:.86rem;color:#1e2340;text-align:start}
.cc-menu .btn:hover{background:#eef0fb!important}
.cc-menu .btn-danger-ghost{color:#dc2626!important}
.cc-menu .cc-msep{height:1px;background:var(--line,#eef0f5);margin:5px 4px}
`;
document.head.appendChild(st);
document.addEventListener('click', e => { if (!e.target.closest('.cc-mwrap')) ccMenuClose(); });
}

/* כרטסת מאוחדת: חיובים + תשלומים כרונולוגית עם יתרה רצה */
function _custLedgerHtml(charges, payments) {
  const live = (charges || []).filter(c => !['cancelled', 'lost'].includes(c.status));
  const rows = [];
  live.forEach(c => rows.push({ date: c.issued_date, type: 'charge', desc: c.description || 'חיוב', amount: Number(c.amount) || 0, inv: c.invoice_number, status: c.status }));
  (payments || []).forEach(p => rows.push({ date: p.paid_date, type: 'pay', desc: 'תשלום' + (PAY_METHODS[p.method] ? ' · ' + PAY_METHODS[p.method] : '') + (p.notes ? ' · ' + p.notes : ''), amount: Number(p.amount) || 0 }));
  rows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (!rows.length) return '<p class="muted">אין תנועות כספיות</p>';
  let bal = 0;
  const body = rows.map(r => {
    if (r.type === 'charge') bal += r.amount; else bal -= r.amount;
    return `<tr>
      <td style="white-space:nowrap">${heDate(r.date)}</td>
      <td>${esc(r.desc)}${r.inv ? ` <span class="muted" dir="ltr" style="font-size:.78rem">#${esc(r.inv)}</span>` : ''}${r.type === 'charge' && r.status ? ' ' + pill('charge', r.status) : ''}</td>
      <td style="color:#b91c1c">${r.type === 'charge' ? money(r.amount) : ''}</td>
      <td style="color:#15803d">${r.type === 'pay' ? money(r.amount) : ''}</td>
      <td><b style="color:${bal > 0.001 ? '#b91c1c' : '#15803d'}">${money(bal)}</b></td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="data"><thead><tr><th>תאריך</th><th>תיאור</th><th>חיוב</th><th>תשלום</th><th>יתרה</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
