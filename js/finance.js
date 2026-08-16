/* ============================================================
finance.js — תזרים והוצאות (מנהל בלבד)
------------------------------------------------------------
- תחזית 8 שבועות: תקבולים צפויים מול הוצאות, התראת בור
- ניהול הוצאות + הוצאות קבועות (חודשיות/שבועיות)
- יתרת פתיחה נשמרת בהגדרות
============================================================ */

'use strict';

Pages.cashflow = {
render: async (el) => {
const [flows, expenses] = await Promise.all([
run(db.from('v_cashflow').select('*')),
run(db.from('expenses').select('*').order('expense_date', { ascending: false }).limit(200)),
]);
const opening = Number(cache.settings.opening_balance || 0);

/* --- בניית 8 שבועות קדימה: לוגיקה גלויה, שבוע = ראשון עד שבת --- */
const weeks = [];
const start = new Date();
start.setDate(start.getDate() - start.getDay()); // תחילת השבוע הנוכחי (ראשון)
for (let w = 0; w < 8; w++) {
const from = new Date(start); from.setDate(from.getDate() + w * 7);
const to = new Date(from); to.setDate(to.getDate() + 6);
const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
const inSum = flows.filter(x => x.direction === 'in' && x.flow_date >= f && x.flow_date <= t)
.reduce((s, x) => s + Number(x.amount), 0);
const outSum = flows.filter(x => x.direction === 'out' && x.flow_date >= f && x.flow_date <= t)
.reduce((s, x) => s + Number(x.amount), 0);
weeks.push({ from: f, to: t, inSum, outSum });
}
/* יתרה מצטברת שבוע אחרי שבוע */
let balance = opening;
weeks.forEach(w => { balance += w.inSum - w.outSum; w.balance = balance; });
const firstNegative = weeks.find(w => w.balance < 0);
const maxVal = Math.max(1, ...weeks.map(w => Math.max(w.inSum, w.outSum)));

el.innerHTML = `
<div class="page-head">
<h2>תזרים מזומנים</h2>
<div class="actions">
<button class="btn btn-ghost btn-sm" onclick="openingBalanceEdit()">יתרת פתיחה: ${money(opening)}</button>
<button class="btn btn-ghost btn-sm" onclick="recurringManage()">הוצאות קבועות</button>
<button class="btn" onclick="expenseAdd()">+ הוצאה</button>
</div>
</div>

${firstNegative ? `<div class="card card-pad" style="border-right:4px solid var(--danger);margin-bottom:16px">
<b style="color:var(--danger)">⚠ התראה: צפוי בור תזרימי בשבוע של ${heDate(firstNegative.from)}
(יתרה צפויה: ${money(firstNegative.balance)})</b></div>` : ''}

<div class="card card-pad">
<b>תחזית 8 שבועות קדימה</b>
<div class="table-wrap"><table class="data" style="margin-top:10px">
<thead><tr><th>שבוע</th><th>תקבולים צפויים</th><th>הוצאות צפויות</th><th></th><th>יתרה מצטברת</th></tr></thead>
<tbody>
${weeks.map(w => `<tr>
<td>${heDate(w.from)} – ${heDate(w.to)}</td>
<td style="color:var(--ok)">${money(w.inSum) || '—'}</td>
<td style="color:var(--danger)">${money(w.outSum) || '—'}</td>
<td style="min-width:130px">
<div style="display:flex;gap:2px;align-items:center">
<div style="background:var(--ok);height:8px;border-radius:4px;width:${Math.round(w.inSum / maxVal * 100)}px"></div>
<div style="background:var(--danger);height:8px;border-radius:4px;width:${Math.round(w.outSum / maxVal * 100)}px"></div>
</div></td>
<td><b style="color:${w.balance < 0 ? 'var(--danger)' : 'var(--brand)'}">${money(w.balance)}</b></td>
</tr>`).join('')}
</tbody></table></div>
<p class="muted" style="font-size:.78rem;margin-top:8px">
תקבולים צפויים = חיובים פתוחים לפי תנאי התשלום + צ'קים דחויים לפי פירעון. חובות באיחור אינם נספרים.</p>
</div>

<div class="card">
<div class="card-pad" style="display:flex;justify-content:space-between;align-items:center">
<b>הוצאות אחרונות</b>
<button class="btn btn-ghost btn-sm" onclick="expensesGenerateRecurring()">⚡ יצירת הוצאות קבועות לתקופה</button>
</div>
<div id="expTable"></div>
</div>`;

renderTable(document.getElementById('expTable'), expenses, [
{ h: 'תאריך', f: r => heDate(r.expense_date) },
{ h: 'ספק/תיאור', f: r => esc(r.supplier) },
{ h: 'סכום', f: r => money(r.amount) },
{ h: 'סטטוס', f: r => pill('expense', r.status) },
{ h: 'הערות', f: r => esc(r.notes) },
], { onRow: r => expenseEdit(r), empty: 'אין הוצאות רשומות' });
}
};

function openingBalanceEdit() {
const v = prompt('יתרת פתיחה בבנק (₪):', cache.settings.opening_balance || '0');
if (v === null || isNaN(Number(v))) return;
run(db.from('settings').upsert({ key: 'opening_balance', value: String(Number(v)) })).then(() => {
cache.settings.opening_balance = String(Number(v));
toast('עודכן');
openPage('cashflow');
});
}

let _expCategories = null;
async function expCategories() {
if (!_expCategories) _expCategories = await run(db.from('expense_categories').select('*').order('sort'));
return _expCategories;
}

async function expenseAdd() {
const cats = await expCategories();
openForm('הוצאה חדשה', [
{ name: 'expense_date', label: 'תאריך', type: 'date', required: true, default: today() },
{ name: 'supplier', label: 'ספק / תיאור', required: true },
{ name: 'category_id', label: 'קטגוריה', type: 'select', options: cats.map(c => ({ v: c.id, t: c.name })) },
{ name: 'amount', label: 'סכום (₪)', type: 'number', required: true },
{ name: 'status', label: 'סטטוס', type: 'select', required: true, default: 'expected',
options: [{ v: 'expected', t: 'צפויה' }, { v: 'paid', t: 'שולמה' }] },
{ name: 'notes', label: 'הערות' },
], {}, async (rec) => {
await run(db.from('expenses').insert(rec));
toast('ההוצאה נרשמה');
openPage('cashflow');
});
}

async function expenseEdit(exp) {
const cats = await expCategories();
openForm('עריכת הוצאה', [
{ name: 'expense_date', label: 'תאריך', type: 'date', required: true },
{ name: 'supplier', label: 'ספק / תיאור', required: true },
{ name: 'category_id', label: 'קטגוריה', type: 'select', options: cats.map(c => ({ v: c.id, t: c.name })) },
{ name: 'amount', label: 'סכום (₪)', type: 'number', required: true },
{ name: 'status', label: 'סטטוס', type: 'select', required: true,
options: [{ v: 'expected', t: 'צפויה' }, { v: 'paid', t: 'שולמה' }] },
{ name: 'notes', label: 'הערות' },
], exp, async (rec) => {
await run(db.from('expenses').update(rec).eq('id', exp.id));
toast('נשמר');
openPage('cashflow');
});
}

async function expensesGenerateRecurring() {
const n = await run(db.rpc('generate_recurring_expenses'));
toast(n ? `נוצרו ${n} הוצאות קבועות` : 'הכל כבר קיים לתקופה זו');
openPage('cashflow');
}

/* --- ניהול הוצאות קבועות --- */
async function recurringManage() {
const [recs, cats] = await Promise.all([
run(db.from('recurring_expenses').select('*').order('name')),
expCategories(),
]);
document.getElementById('viewModal').innerHTML = `
<h3>הוצאות קבועות</h3>
<p class="muted" style="font-size:.82rem;margin-top:-8px">נוצרות אוטומטית בלחיצה על "יצירת הוצאות קבועות לתקופה" במסך התזרים</p>
${recs.length ? `<table class="data"><thead><tr><th>שם</th><th>סכום</th><th>תדירות</th><th>פעילה</th></tr></thead><tbody>
${recs.map(r => `<tr>
<td>${esc(r.name)}</td><td>${money(r.amount)}</td>
<td>${r.frequency === 'monthly' ? 'חודשית (יום ' + r.day_of_month + ')' : 'שבועית (חמישי)'}</td>
<td>${r.active ? '<span class="pill green">כן</span>' : '<span class="pill">לא</span>'}</td>
</tr>`).join('')}
</tbody></table>` : '<p class="muted">אין הוצאות קבועות עדיין</p>'}
<div class="m-actions">
<button class="btn btn-sm" onclick="recurringAdd()">+ הוצאה קבועה</button>
<button class="btn btn-sm btn-ghost" style="margin-right:auto"
onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
</div>`;
document.getElementById('viewBack').classList.add('open');
}

async function recurringAdd() {
const cats = await expCategories();
document.getElementById('viewBack').classList.remove('open');
openForm('הוצאה קבועה חדשה', [
{ name: 'name', label: 'שם (למשל: דפוס שבועי, שכירות)', required: true },
{ name: 'category_id', label: 'קטגוריה', type: 'select', options: cats.map(c => ({ v: c.id, t: c.name })) },
{ name: 'amount', label: 'סכום (₪)', type: 'number', required: true },
{ name: 'frequency', label: 'תדירות', type: 'select', required: true, default: 'monthly',
options: [{ v: 'monthly', t: 'חודשית' }, { v: 'weekly', t: 'שבועית (חמישי)' }] },
{ name: 'day_of_month', label: 'יום בחודש (לחודשית)', type: 'number', default: 1 },
{ name: 'active', label: 'פעילה', type: 'checkbox', default: true },
], {}, async (rec) => {
await run(db.from('recurring_expenses').insert(rec));
toast('נוספה');
recurringManage();
});
}
