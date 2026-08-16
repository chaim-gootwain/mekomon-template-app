/* ============================================================
sales.js — חוזים והצעות מחיר
------------------------------------------------------------
חוזים: חבילות פרסום, מעקב ניצול, התראת פרסום אחרון
הצעות מחיר: בחירת פריטים מהמחירון ← PDF מעוצב (חלון הדפסה)
המחירים לא כוללים מע"מ (לפי המחירון) — ההצעה מציגה מע"מ בנפרד
============================================================ */

'use strict';

const VAT_PCT = 18; // מע"מ בישראל — לעדכון כאן אם ישתנה

/* ==================== חוזים ==================== */

let _contracts = [];

Pages.contracts = {
render: async (el) => {
_contracts = await run(db.from('contracts').select('*').order('created_at', { ascending: false }));

// חישוב ניצול לכל החוזים בשאילתה אחת — פשוט וקריא
const ads = await run(db.from('ads').select('contract_id,status').not('contract_id', 'is', null));
const usedMap = {};
ads.forEach(a => {
if (!['cancelled', 'rejected'].includes(a.status))
usedMap[a.contract_id] = (usedMap[a.contract_id] || 0) + 1;
});

el.innerHTML = `
<div class="page-head">
<h2>חוזים וחבילות</h2>
<button class="btn" onclick="contractAdd()">+ חוזה חדש</button>
</div>
<div id="contractAlerts"></div>
<div class="card" id="contractsTable"></div>`;

// התראות: חוזים שנותר בהם פרסום אחרון (או פחות)
const ending = _contracts.filter(c => c.active && (c.total_inserts - (usedMap[c.id] || 0)) <= 1);
if (ending.length) {
document.getElementById('contractAlerts').innerHTML = `
<div class="card card-pad" style="border-right:4px solid var(--accent);margin-bottom:16px">
<b style="color:var(--accent)">⚠ חוזים לקראת סיום — הזדמנות לחידוש:</b>
<ul class="dash-list" style="margin-top:6px">
${ending.map(c => `<li><span>${esc(nameOf('customers', c.customer_id))} — נותרו ${c.total_inserts - (usedMap[c.id] || 0)} פרסומים</span>
<span class="muted">${esc(nameOf('agents', c.agent_id))}</span></li>`).join('')}
</ul></div>`;
}

renderTable(document.getElementById('contractsTable'), _contracts, [
{ h: 'לקוח', f: r => `<b>${esc(nameOf('customers', r.customer_id))}</b>` },
{ h: 'חבילה', f: r => esc(nameOf('priceList', r.price_item_id)) + ' × ' + r.total_inserts },
{ h: 'נוצל', f: r => {
const used = usedMap[r.id] || 0, left = r.total_inserts - used;
const pct = Math.min(100, Math.round(used / r.total_inserts * 100));
return `<div style="min-width:110px">${used}/${r.total_inserts}
${left <= 1 && r.active ? '<span class="pill red">אחרון!</span>' : ''}
<div class="progress" style="margin-top:4px"><div style="width:${pct}%"></div></div></div>`;
} },
{ h: 'מחיר כולל', f: r => money(r.total_price) },
{ h: 'למודעה', f: r => money(Math.round(r.total_price / r.total_inserts * 100) / 100) },
{ h: 'סוכן', f: r => esc(nameOf('agents', r.agent_id)) },
{ h: 'מצב', f: r => r.active
? (r.skip_next ? '<span class="pill amber">מדלג שבוע</span>' : '<span class="pill green">פעיל</span>')
: '<span class="pill">הסתיים</span>' },
{ h: 'חשבונית', f: r => (typeof invoicesOn === 'function' && invoicesOn() && ['admin', 'sales'].includes(profile.role))
? `<button class="btn btn-sm" onclick="event.stopPropagation(); contractInvoice(${r.id})" title="הפק חשבונית על החבילה">🧾 הפק</button>` : '' },
], { onRow: r => contractEdit(r.id), empty: 'אין חוזים — צור חבילה ראשונה' });
}
};

const CONTRACT_FIELDS = [
{ name: 'customer_id', label: 'לקוח', type: 'select', options: 'customers', required: true },
{ name: 'agent_id', label: 'סוכן', type: 'select', options: 'agents' },
{ name: 'price_item_id', label: 'סוג מודעה (מהמחירון)', type: 'select', options: 'priceList', required: true },
{ name: 'total_inserts', label: 'מספר פרסומים בחבילה', type: 'number', required: true, default: 13 },
{ name: 'total_price', label: 'מחיר כולל לחבילה (₪, לפני מע"מ)', type: 'number', required: true },
{ name: 'commission_pct', label: '% עמלה מיוחד (ריק = לפי הסוכן)', type: 'number' },
{ name: 'start_date', label: 'תאריך התחלה', type: 'date', default: '' },
{ name: 'active', label: 'פעיל', type: 'checkbox', default: true },
{ name: 'skip_next', label: 'דלג על הגיליון הקרוב', type: 'checkbox' },
{ name: 'notes', label: 'הערות', type: 'textarea' },
];

function contractAdd() {
const f = CONTRACT_FIELDS.map(x => ({ ...x }));
f.find(x => x.name === 'start_date').default = today();
openForm('חוזה חדש', f, {}, async (rec) => {
// ברירת מחדל לסוכן: הסוכן הקבוע של הלקוח
if (!rec.agent_id) {
const cust = cache.customers.find(c => c.id === rec.customer_id);
if (cust) rec.agent_id = cust.agent_id;
}
await run(db.from('contracts').insert(rec));
await addInteraction('customer', rec.customer_id,
`נחתם חוזה: ${nameOf('priceList', rec.price_item_id)} × ${rec.total_inserts} תמורת ${money(rec.total_price)}`);
toast('החוזה נוצר — מודעות ייווצרו אוטומטית לכל גיליון');
openPage('contracts');
});
}

function contractEdit(id) {
const c = _contracts.find(x => x.id === id);
openForm('עריכת חוזה — ' + nameOf('customers', c.customer_id), CONTRACT_FIELDS, c, async (rec) => {
await run(db.from('contracts').update(rec).eq('id', id));
toast('נשמר');
openPage('contracts');
});
}

/* הפקת חשבונית על חבילת החוזה — עסקה / מס / מס-קבלה (דרך EZcount + סנכרון לחוב) */
let _ciCust = null, _ciLines = null;
async function contractInvoice(contractId) {
  const ct = (_contracts || []).find(x => x.id === contractId) || (await run(db.from('contracts').select('*').eq('id', contractId).limit(1)))[0];
  if (!ct) { toast('חוזה לא נמצא', true); return; }
  const cust = (typeof _customers !== 'undefined' && (_customers || []).find(x => x.id === ct.customer_id))
    || (cache.customers || []).find(x => x.id === ct.customer_id)
    || (await run(db.from('customers').select('*').eq('id', ct.customer_id).limit(1)))[0];
  if (!cust) { toast('לקוח לא נמצא', true); return; }
  _ciCust = cust;
  _ciLines = [{ details: 'חבילת פרסום — ' + (nameOf('priceList', ct.price_item_id) || '') + ' × ' + ct.total_inserts, amount: 1, price: Number(ct.total_price) || 0 }];
  document.getElementById('ciOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ciOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  const close = "document.getElementById('ciOv').remove();";
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;padding:18px;max-width:440px;width:92%;direction:rtl">
    <h3 style="margin:0 0 4px">🧾 הפקת חשבונית מהחוזה — ${esc(cust.name)}</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 14px">${esc(_ciLines[0].details)} · ${money(_ciLines[0].price)} (לפני מע"מ)</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" onclick="${close} invOpenModal(_ciCust, 'proforma', false, {lines:_ciLines})">חשבון עסקה</button>
      <button class="btn" onclick="${close} invOpenModal(_ciCust, 'tax_invoice', false, {lines:_ciLines})">חשבונית מס</button>
      <button class="btn" onclick="${close} invOpenModal(_ciCust, 'invoice_receipt', true, {lines:_ciLines, vatInc:false})">חשבונית מס קבלה</button>
      <button class="btn btn-ghost" onclick="${close}">ביטול</button>
    </div></div>`;
  document.body.appendChild(ov);
}

/* ==================== הצעות מחיר ==================== */

let _quotes = [];
let _quoteItems = []; // הפריטים בהצעה הנוכחית שנבנית

Pages.quotes = {
render: async (el) => {
_quotes = await run(db.from('quotes').select('*').order('created_at', { ascending: false }).limit(100));
el.innerHTML = `
<div class="page-head">
<h2>הצעות מחיר</h2>
<button class="btn" onclick="openQuoteForm({})">+ הצעה חדשה</button>
</div>
<div class="card" id="quotesTable"></div>`;
renderTable(document.getElementById('quotesTable'), _quotes, [
{ h: 'תאריך', f: r => heDate(r.created_at) },
{ h: 'נמען', f: r => `<b>${esc(r.recipient_name)}</b>` },
{ h: 'פריטים', f: r => (r.items || []).map(i => esc(i.name)).join(', ') },
{ h: 'הנחה', f: r => money(r.discount) || '—' },
{ h: 'סה"כ (לפני מע"מ)', f: r => money(r.total) },
], { onRow: r => quotePrint(r), empty: 'אין הצעות מחיר' });
}
};

/* פתיחת טופס הצעה — נקרא גם מליד ומלקוח */
function openQuoteForm(ctx) {
_quoteItems = [];
const modal = document.getElementById('viewModal');
modal.innerHTML = `
<h3>הצעת מחיר חדשה</h3>
<div class="field"><label>שם הנמען</label><input id="qName" value="${esc(ctx.recipient_name || '')}"></div>
<b style="font-size:.9rem">בחירת פריטים מהמחירון:</b>
<div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap">
<select id="qItem" style="flex:2;min-width:160px">
${cache.priceList.map(p => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}</option>`).join('')}
</select>
<input id="qQty" type="number" value="1" min="1" style="width:70px" dir="ltr" title="כמות">
<button class="btn btn-sm" onclick="quoteAddItem()">+ הוספה</button>
</div>
<div id="qItems"></div>
<div class="grid2" style="margin-top:10px">
<div class="field"><label>הנחה (₪)</label><input id="qDiscount" type="number" value="0" dir="ltr" oninput="quoteDrawItems()"></div>
<div class="field"><label>תוקף ההצעה</label><input id="qValid" value="14 יום"></div>
</div>
<div class="m-actions">
<button class="btn" onclick="quoteSave(${ctx.lead_id || null}, ${ctx.customer_id || null})">שמירה והפקת PDF</button>
<button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
</div>`;
quoteDrawItems();
document.getElementById('viewBack').classList.add('open');
}

function quoteAddItem() {
const sel = document.getElementById('qItem');
const qty = Math.max(1, Number(document.getElementById('qQty').value));
const item = cache.priceList.find(p => p.id === Number(sel.value));
_quoteItems.push({ name: item.name, price: Number(item.price), qty });
quoteDrawItems();
}

function quoteDrawItems() {
const wrap = document.getElementById('qItems');
if (!wrap) return;
const discount = Number(document.getElementById('qDiscount')?.value || 0);
const sum = _quoteItems.reduce((s, i) => s + i.price * i.qty, 0);
const total = Math.max(0, sum - discount);
const vat = Math.round(total * VAT_PCT) / 100;
wrap.innerHTML = _quoteItems.length ? `
<table class="data"><thead><tr><th>פריט</th><th>מחיר</th><th>כמות</th><th>סה"כ</th><th></th></tr></thead><tbody>
${_quoteItems.map((i, idx) => `<tr>
<td>${esc(i.name)}</td><td>${money(i.price)}</td><td>${i.qty}</td><td>${money(i.price * i.qty)}</td>
<td><button class="btn-danger-ghost btn-sm" onclick="_quoteItems.splice(${idx},1);quoteDrawItems()">✕</button></td>
</tr>`).join('')}
<tr><td colspan="3"><b>סה"כ לפני מע"מ${discount ? ' (אחרי הנחה)' : ''}</b></td><td colspan="2"><b>${money(total)}</b></td></tr>
<tr><td colspan="3">מע"מ ${VAT_PCT}%</td><td colspan="2">${money(vat)}</td></tr>
<tr><td colspan="3"><b>סה"כ כולל מע"מ</b></td><td colspan="2"><b style="color:var(--brand)">${money(total + vat)}</b></td></tr>
</tbody></table>` : '<p class="muted">עדיין לא נבחרו פריטים</p>';
}

async function quoteSave(leadId, customerId) {
const name = document.getElementById('qName').value.trim();
if (!name) { toast('נא למלא שם נמען', true); return; }
if (!_quoteItems.length) { toast('נא להוסיף לפחות פריט אחד', true); return; }
const discount = Number(document.getElementById('qDiscount').value || 0);
const total = Math.max(0, _quoteItems.reduce((s, i) => s + i.price * i.qty, 0) - discount);
const valid = document.getElementById('qValid').value;

const q = await run(db.from('quotes').insert({
lead_id: leadId, customer_id: customerId, recipient_name: name,
items: _quoteItems, discount, total, created_by: profile.id,
}).select().single());

if (leadId) await addInteraction('lead', leadId, `נשלחה הצעת מחיר על סך ${money(total)} (לפני מע"מ)`);
if (customerId) await addInteraction('customer', customerId, `נשלחה הצעת מחיר על סך ${money(total)} (לפני מע"מ)`);

document.getElementById('viewBack').classList.remove('open');
toast('ההצעה נשמרה');
quotePrint({ ...q, valid_text: valid });
}

/* הפקת ה-PDF: נפתח חלון הדפסה מעוצב — בוחרים "שמירה כ-PDF" */
function quotePrint(q) {
const items = q.items || [];
const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
const total = Math.max(0, sum - Number(q.discount || 0));
const vat = Math.round(total * VAT_PCT) / 100;
printArea('הצעת מחיר', `
<p><b>לכבוד:</b> ${esc(q.recipient_name)}<br>
<b>תאריך:</b> ${heDate(q.created_at || new Date().toISOString())}<br>
${q.valid_text ? `<b>תוקף ההצעה:</b> ${esc(q.valid_text)}` : ''}</p>
<table><thead><tr><th>פריט</th><th>מחיר ליחידה</th><th>כמות</th><th>סה"כ</th></tr></thead><tbody>
${items.map(i => `<tr><td>${esc(i.name)}</td><td>${money(i.price)}</td><td>${i.qty}</td><td>${money(i.price * i.qty)}</td></tr>`).join('')}
${q.discount > 0 ? `<tr><td colspan="3">הנחה</td><td>-${money(q.discount)}</td></tr>` : ''}
<tr><td colspan="3"><b>סה"כ לפני מע"מ</b></td><td><b>${money(total)}</b></td></tr>
<tr><td colspan="3">מע"מ ${VAT_PCT}%</td><td>${money(vat)}</td></tr>
<tr><td colspan="3"><b>סה"כ לתשלום</b></td><td><b>${money(total + vat)}</b></td></tr>
</tbody></table>
<p style="margin-top:16px;font-size:12px;color:#64748b">
המחירים אינם כוללים עיצוב גרפי. ט.ל.ח.<br>
לאישור ההצעה: @@PAPER_PHONE@@ · @@PAPER_EMAIL@@</p>`);
}

