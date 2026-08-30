/* ============================================================
billing.js — גבייה ועמלות (מנהל + מכירות)
------------------------------------------------------------
גבייה: חיובים, רישום תשלומים (כולל צ'קים דחויים),
"למי להתקשר השבוע", רישום מס' חשבונית ירוקה
עמלות: דו"ח חודשי לכל סוכן מתוך v_commissions + סימון תשלום
============================================================ */

'use strict';

let _charges = [];

Pages.billing = {
render: async (el) => {
_charges = await run(db.from('charges').select('*').order('issued_date', { ascending: false }).limit(400));

// עדכון אוטומטי של חיובים שעברו את תאריך היעד ל"באיחור"
const overdueIds = _charges
.filter(c => ['pending', 'invoiced', 'partial'].includes(c.status) && c.due_date && c.due_date < today())
.map(c => c.id);
if (overdueIds.length) {
await run(db.from('charges').update({ status: 'overdue' }).in('id', overdueIds));
_charges.forEach(c => { if (overdueIds.includes(c.id)) c.status = 'overdue'; });
}

const open = _charges.filter(c => ['pending', 'invoiced', 'partial', 'overdue'].includes(c.status));
const openSum = open.reduce((s, c) => s + Number(c.amount), 0);
const overdue = _charges.filter(c => c.status === 'overdue');

el.innerHTML = `
<div class="page-head">
<h2>גבייה</h2>
<div class="actions">
<button class="btn btn-ghost btn-sm" onclick="billingExport()">⬇ ייצוא לאקסל</button>
<button class="btn" onclick="paymentAdd()">+ רישום תשלום</button>
<button class="btn btn-ghost" onclick="chargeAdd()">+ חיוב ידני</button>
</div>
</div>

<div class="stats">
${stat(money(openSum) || '₪0', 'סה"כ חוב פתוח (' + open.length + ' חיובים)')}
${stat(money(overdue.reduce((s, c) => s + Number(c.amount), 0)) || '₪0', 'מזה באיחור (' + overdue.length + ')', overdue.length ? 'red' : '')}
</div>

${overdue.length ? `<div class="card card-pad" style="border-right:4px solid var(--danger);margin-bottom:16px">
<b style="color:var(--danger)">📞 למי להתקשר השבוע:</b>
<ul class="dash-list" style="margin-top:6px">
${overdue.slice(0, 10).map(c => `<li>
<span><b>${esc(nameOf('customers', c.customer_id))}</b> — ${money(c.amount)} (יעד: ${heDate(c.due_date)})</span>
<span class="muted" dir="ltr">${esc((cache.customers.find(x => x.id === c.customer_id) || {}).phone || '')}</span>
</li>`).join('')}
</ul></div>` : ''}

<div class="tabs">
<button class="active" data-f="open" onclick="billingTab(this)">פתוחים</button>
<button data-f="pending" onclick="billingTab(this)">ממתינים לחשבונית</button>
<button data-f="paid" onclick="billingTab(this)">שולמו</button>
<button data-f="all" onclick="billingTab(this)">הכל</button>
</div>
<div class="card" id="chargesTable"></div>`;
billingDraw();
}
};

let _billingFilter = 'open';
function billingTab(btn) {
_billingFilter = btn.dataset.f;
btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
billingDraw();
}

function billingDraw() {
const groups = {
open: ['pending', 'invoiced', 'partial', 'overdue'],
pending: ['pending'],
paid: ['paid'],
all: null,
};
const statuses = groups[_billingFilter];
const rows = statuses ? _charges.filter(c => statuses.includes(c.status)) : _charges;
renderTable(document.getElementById('chargesTable'), rows, [
{ h: 'לקוח', f: r => `<b>${esc(nameOf('customers', r.customer_id))}</b>` },
{ h: 'תיאור', f: r => esc(r.description) },
{ h: 'סכום', f: r => money(r.amount) },
{ h: 'הופק', f: r => heDate(r.issued_date) },
{ h: 'לתשלום עד', f: r => heDate(r.due_date) },
{ h: 'חשבונית', f: r => esc(r.invoice_number) || '<span class="pill amber">ממתין</span>' },
{ h: 'סטטוס', f: r => pill('charge', r.status) },
], { onRow: r => chargeCard(r.id), empty: 'אין חיובים' });
}

/* --- כרטיס חיוב: חשבונית, תשלום, חוב אבוד --- */
async function chargeCard(id) {
const c = _charges.find(x => x.id === id);
const pays = await run(db.from('payments').select('*').eq('charge_id', id).order('paid_date'));
const paidSum = pays.reduce((s, p) => s + Number(p.amount), 0);
document.getElementById('viewModal').innerHTML = `
<h3>חיוב — ${esc(nameOf('customers', c.customer_id))} ${pill('charge', c.status)}</h3>
<div class="grid3" style="font-size:.9rem">
<div><label>סכום</label><b>${money(c.amount)}</b></div>
<div><label>שולם</label><b>${money(paidSum) || '₪0'}</b></div>
<div><label>יתרה</label><b style="color:${c.amount - paidSum > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(c.amount - paidSum)}</b></div>
<div><label>הופק</label><b>${heDate(c.issued_date)}</b></div>
<div><label>לתשלום עד</label><b>${heDate(c.due_date) || '—'}</b></div>
<div><label>מס' חשבונית</label><b>${esc(c.invoice_number) || 'טרם הופקה'}</b></div>
</div>
<p class="muted" style="font-size:.85rem;margin-top:6px">${esc(c.description)}</p>
${pays.length ? `<b style="font-size:.88rem">תשלומים:</b>
<ul class="dash-list">${pays.map(p => `<li><span>${heDate(p.paid_date)} · ${PAY_METHODS[p.method]}${p.check_due_date ? ' (פירעון ' + heDate(p.check_due_date) + ')' : ''}${p.bounced ? ` <span class="pill red">↩️ חזר${p.bounced_date ? ' ' + heDate(p.bounced_date) : ''}</span>` : ''}</span><b style="${Number(p.amount) < 0 ? 'color:var(--danger)' : ''}">${money(p.amount)}</b>${(!p.bounced && Number(p.amount) > 0) ? ` <button class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="paymentMarkBounced(${p.id}, ${id})" title="סימון התשלום כצ'ק שחזר / הוראה שנדחתה">↩️ חזר</button>` : ''}</li>`).join('')}</ul>` : ''}
<div class="m-actions" style="flex-wrap:wrap">
${!c.invoice_number && !['cancelled', 'lost'].includes(c.status) ? `
<button class="btn btn-sm" onclick="chargeSetInvoice(${id})">🧾 רישום מס' חשבונית (מחשבונית ירוקה)</button>` : ''}
${['pending', 'invoiced', 'partial', 'overdue'].includes(c.status) ? `
<button class="btn btn-sm" style="background:var(--ok)" onclick="paymentAdd(${id})">💰 רישום תשלום</button>
<button class="btn btn-sm btn-danger-ghost" onclick="chargeMarkLost(${id})">סימון חוב אבוד</button>` : ''}
<button class="btn btn-sm btn-ghost" style="margin-right:auto"
onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
</div>`;
document.getElementById('viewBack').classList.add('open');
}

function chargeAdd() {
openForm('חיוב ידני', [
{ name: 'customer_id', label: 'לקוח', type: 'customer', required: true },
{ name: 'amount', label: 'סכום (₪)', type: 'number', required: true },
{ name: 'description', label: 'תיאור', required: true },
{ name: 'due_date', label: 'לתשלום עד', type: 'date' },
{ name: 'notes', label: 'הערות', type: 'textarea' },
], {}, async (rec) => {
const cust = cache.customers.find(x => x.id === rec.customer_id);
if (cust) rec.agent_id = cust.agent_id;
await run(db.from('charges').insert(rec));
toast('החיוב נוצר');
openPage('billing');
});
}

function chargeSetInvoice(id) {
const num = prompt('מס\' החשבונית שהופקה בחשבונית ירוקה:');
if (!num) return;
run(db.from('charges').update({ invoice_number: num, status: 'invoiced' }).eq('id', id)).then(() => {
toast('נרשם');
document.getElementById('viewBack').classList.remove('open');
openPage('billing');
});
}

async function chargeMarkLost(id) {
if (!confirm('לסמן כחוב אבוד?\nחלק הגבייה של עמלת הסוכן על החיוב הזה יתבטל.')) return;
await run(db.from('charges').update({ status: 'lost' }).eq('id', id));
toast('סומן כחוב אבוד');
document.getElementById('viewBack').classList.remove('open');
openPage('billing');
}

/* --- רישום תשלום; אחרי השמירה מתעדכן סטטוס החיוב --- */
function paymentAdd(chargeId) {
document.getElementById('viewBack').classList.remove('open');
const openCharges = _charges.filter(c => ['pending', 'invoiced', 'partial', 'overdue'].includes(c.status));
openForm('רישום תשלום', [
{ name: 'charge_id', label: 'עבור חיוב', type: 'select', required: true, default: chargeId,
options: openCharges.map(c => ({ v: c.id, t: `${nameOf('customers', c.customer_id)} — ${money(c.amount)} (${heDate(c.issued_date)})` })) },
{ name: 'amount', label: 'סכום (₪)', type: 'number', required: true },
{ name: 'method', label: 'אמצעי תשלום', type: 'select', required: true, default: 'transfer',
options: Object.entries(PAY_METHODS).map(([v, t]) => ({ v, t })) },
{ name: 'paid_date', label: 'תאריך התשלום', type: 'date', default: today(), required: true },
{ name: 'check_due_date', label: 'תאריך פירעון (לצ\'ק דחוי)', type: 'date' },
{ name: 'notes', label: 'הערות' },
], {}, async (rec) => {
const charge = _charges.find(c => c.id === rec.charge_id);
rec.customer_id = charge.customer_id;
rec.created_by = profile.id;
await run(db.from('payments').insert(rec));

/* עדכון סטטוס החיוב לפי סך התשלומים — לוגיקה גלויה ופשוטה */
const pays = await run(db.from('payments').select('amount').eq('charge_id', rec.charge_id));
const paidSum = pays.reduce((s, p) => s + Number(p.amount), 0);
const newStatus = paidSum >= Number(charge.amount) ? 'paid' : 'partial';
await run(db.from('charges').update({ status: newStatus }).eq('id', rec.charge_id));

toast(newStatus === 'paid' ? '✓ החיוב שולם במלואו' : 'נרשם תשלום חלקי');
openPage('billing');
});
}

function billingExport() {
exportCsv('חיובים_' + today(),
['לקוח', 'תיאור', 'סכום', 'הופק', 'לתשלום עד', 'חשבונית', 'סטטוס'],
_charges.map(c => [nameOf('customers', c.customer_id), c.description, c.amount,
c.issued_date, c.due_date || '', c.invoice_number || '', STATUS.charge[c.status][0]]));
}

/* ==================== עמלות ==================== */

Pages.commissions = {
render: async (el) => {
const myAgent = cache.agents.find(a => a.profile_id === profile.id);
const isAdmin = profile.role === 'admin';
const month = document.getElementById('commMonth')?.value || thisMonth();

el.innerHTML = `
<div class="page-head">
<h2>עמלות סוכנים</h2>
<div class="actions">
<input type="month" id="commMonth" value="${month}" onchange="openPage('commissions')" style="width:auto">
</div>
</div>
<div id="commContent"><div class="empty">טוען...</div></div>`;

/* שליפת שורות העמלה מהתצוגה בשרת + התשלומים לסוכנים */
const [rows, payouts, charges] = await Promise.all([
run(db.from('v_commissions').select('*').eq('month', month)),
isAdmin ? run(db.from('commission_payouts').select('*').eq('month', month)) : [],
run(db.from('charges').select('agent_id,amount,issued_date').gte('issued_date', month + '-01').lte('issued_date', month + '-31')),
]);

/* סיכום לפי סוכן */
const agents = isAdmin ? cache.agents : cache.agents.filter(a => myAgent && a.id === myAgent.id);
const wrap = document.getElementById('commContent');
if (!agents.length) { wrap.innerHTML = '<div class="card"><div class="empty">אינך מקושר לסוכן — פנה למנהל</div></div>'; return; }

wrap.innerHTML = agents.map(a => {
const mine = rows.filter(r => r.agent_id === a.id);
const billing = mine.filter(r => r.part === 'billing').reduce((s, r) => s + Number(r.commission), 0);
const collection = mine.filter(r => r.part === 'collection').reduce((s, r) => s + Number(r.commission), 0);
const sales = charges.filter(c => c.agent_id === a.id).reduce((s, c) => s + Number(c.amount), 0);

/* בונוס: אם יש יעד והמכירות עברו אותו */
let bonus = 0, bonusText = '';
if (a.monthly_target > 0 && sales >= a.monthly_target && a.bonus_type !== 'none') {
bonus = a.bonus_type === 'fixed' ? Number(a.bonus_value)
: (billing + collection) * Number(a.bonus_value) / 100;
bonusText = `✓ עמד ביעד (${money(a.monthly_target)})`;
} else if (a.monthly_target > 0) {
bonusText = `יעד: ${money(a.monthly_target)} · הושג ${Math.round(sales / a.monthly_target * 100)}%`;
}
const total = billing + collection + bonus;
const payout = (payouts || []).find(p => p.agent_id === a.id);

return `<div class="card card-pad" style="margin-bottom:14px">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<b style="font-size:1.05rem">${esc(a.name)}</b>
${payout ? `<span class="pill green">שולם ${heDate(payout.paid_at)} · ${money(payout.amount)}</span>`
: (isAdmin && total > 0 ? `<button class="btn btn-sm" onclick="payoutMark(${a.id}, '${month}', ${total.toFixed(2)})">סימון שולם</button>` : '')}
</div>
<div class="stats" style="margin-top:12px;margin-bottom:0">
${stat(money(sales) || '₪0', 'מכירות החודש')}
${stat(money(billing) || '₪0', 'עמלת חיוב (' + (cache.settings.commission_split_billing || 50) + '%)')}
${stat(money(collection) || '₪0', 'עמלת גבייה')}
${stat(money(bonus) || '—', 'בונוס ' + (bonusText ? '· ' + bonusText : ''), bonus ? 'gold' : '')}
${stat(money(total) || '₪0', 'סה"כ לתשלום', 'gold')}
</div>
</div>`;
}).join('');
}
};

async function payoutMark(agentId, month, amount) {
if (!confirm(`לסמן שהעמלה שולמה לסוכן? (${money(amount)})\nהתשלום יירשם גם כהוצאה בתזרים.`)) return;
await run(db.from('commission_payouts').insert({ agent_id: agentId, month, amount, paid_at: today() }));
/* רישום כהוצאה בתזרים */
const cat = await run(db.from('expense_categories').select('id').eq('name', 'עמלות סוכנים').limit(1));
await run(db.from('expenses').insert({
expense_date: today(), supplier: nameOf('agents', agentId),
category_id: cat.length ? cat[0].id : null, amount, status: 'paid',
notes: 'עמלת ' + month,
}));
toast('נרשם התשלום + הוצאה בתזרים');
openPage('commissions');
}

/* ============================================================
   צ'קים שחזרו (פיצ'ר #8)
   ------------------------------------------------------------
   סימון תשלום כ"חזר": מסמן את התשלום, מוסיף תנועת ביטול (תשלום
   שלילי) כך שכל חישובי היתרה במערכת נשארים נכונים, פותח מחדש את
   החיוב, רושם ביומן הלקוח ומדווח למנוע ההתראות. אין פעולה כספית.
   ============================================================ */

async function paymentMarkBounced(paymentId, chargeId) {
  let p;
  try {
    p = await run(db.from('payments').select('*').eq('id', paymentId).single());
  } catch (e) { toast('התשלום לא נמצא', true); return; }
  if (p.bounced) { toast('התשלום כבר מסומן כחזר', true); return; }
  if (!(Number(p.amount) > 0)) { toast('אי אפשר לסמן תנועת ביטול', true); return; }
  const custName = nameOf('customers', p.customer_id) || 'הלקוח';
  const reason = prompt(`סימון תשלום של ${money(p.amount)} מ-${custName} כצ'ק שחזר / הוראה שנדחתה.\nסיבה (לא חובה):`, '');
  if (reason === null) return;
  const T = today();

  // 1) סימון התשלום המקורי — אם העמודות חסרות, עוצרים לפני שנוגעים בכסף
  try {
    await run(db.from('payments').update({ bounced: true, bounced_reason: reason || null, bounced_date: T }).eq('id', paymentId));
  } catch (e) { toast('עמודות הסימון חסרות — יש להריץ את מיגרציית bounced_checks', true); return; }

  // 2) תנועת ביטול — מאזנת את התשלום כך שהיתרה חוזרת להיות פתוחה
  try {
    await run(db.from('payments').insert({
      charge_id: p.charge_id, customer_id: p.customer_id,
      amount: -Number(p.amount), method: p.method, paid_date: T,
      notes: 'ביטול תשלום — צ\'ק/תשלום חזר' + (reason ? ' (' + reason + ')' : '') + ' [bounce:' + paymentId + ']'
    }));
  } catch (e) { toast('יצירת תנועת הביטול נכשלה: ' + (e.message || e), true); return; }

  // 3) פתיחת החיוב מחדש לפי היתרה המעודכנת
  try {
    const cid = chargeId || p.charge_id;
    if (cid) {
      const ch = await run(db.from('charges').select('id,amount,due_date,status').eq('id', cid).single());
      const allPays = await run(db.from('payments').select('amount').eq('charge_id', cid));
      const paid = allPays.reduce((s, x) => s + Number(x.amount || 0), 0);
      let st = 'pending';
      if (paid >= Number(ch.amount) - 0.005) st = 'paid';
      else if (paid > 0.005) st = 'partial';
      else if (ch.due_date && ch.due_date < T) st = 'overdue';
      if (st !== ch.status && !['cancelled', 'lost'].includes(ch.status)) {
        await run(db.from('charges').update({ status: st }).eq('id', cid));
      }
    }
  } catch (e) { console.error('bounce/reopen', e); }

  // 4) יומן + התראה
  try { await addInteraction('customer', p.customer_id, `↩️ צ'ק/תשלום חזר — ${money(p.amount)}${reason ? ' (' + reason + ')' : ''}. החיוב נפתח מחדש.`); } catch (e) { }
  try {
    if (typeof alertsPublishEvent === 'function') {
      await alertsPublishEvent('check_bounced', {
        customer_id: p.customer_id, customer_name: custName,
        amount: Number(p.amount), payment_id: paymentId
      }, 'billing');
    }
  } catch (e) { }

  toast('↩️ סומן כחזר — נוצרה תנועת ביטול והחיוב נפתח מחדש');
  if (chargeId || p.charge_id) chargeCard(chargeId || p.charge_id);
}
