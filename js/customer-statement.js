/* ============================================================
customer-statement.js — כרטסת / דו"ח חוב ללקוח
------------------------------------------------------------
- כפתור בכרטיס הלקוח: "📄 דו"ח חוב / כרטסת"
- מרכז את כל החיובים (charges) והתשלומים (payments) של הלקוח,
  מחשב יתרה פתוחה, ומפיק מסמך מודפס / לשמירה כ-PDF (חלון הדפסה).
- נשען על הטבלאות הקיימות בלבד (charges + payments) — אין סכימה חדשה.
- גם כפתור "כרטסת" בשורות דו"ח החוב שבעמוד הגבייה.
============================================================ */

'use strict';

const CS_OPEN = ['pending', 'invoiced', 'partial', 'overdue'];
const CS_DEAD = ['cancelled', 'lost'];

function _csMoney(n) {
  try { if (typeof money === 'function') return money(n); } catch (e) { }
  return '₪' + Number(n || 0).toLocaleString('he-IL');
}
function _csDate(d) {
  try { if (d && typeof heDate === 'function') return heDate(d) || ''; } catch (e) { }
  return d || '';
}
function _csStatusHe(s) {
  try { if (typeof STATUS !== 'undefined' && STATUS.charge && STATUS.charge[s]) return STATUS.charge[s][0]; } catch (e) { }
  return s || '';
}
function _csEsc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* שם אמצעי תשלום בעברית (נשען על PAY_METHODS אם קיים) */
function _csPayMethod(m) {
  try { if (typeof PAY_METHODS !== 'undefined' && PAY_METHODS[m]) return PAY_METHODS[m]; } catch (e) { }
  return m || 'תשלום';
}

/* אוסף נתוני כרטסת ללקוח — יומן חובה/זכות כרונולוגי עם יתרה רצה */
async function _csGather(customerId) {
  const cust = await run(db.from('customers').select('*').eq('id', customerId).single());
  const charges = await run(db.from('charges').select('*')
    .eq('customer_id', customerId).order('issued_date', { ascending: true }));
  let pays = [];
  try {
    // גם תשלומים שנרשמו ישירות על הלקוח וגם כאלה שנרשמו על חיוב שלו
    const ids = charges.map(c => c.id);
    const byCust = await run(db.from('payments').select('*').eq('customer_id', customerId));
    const byCharge = ids.length ? await run(db.from('payments').select('*').in('charge_id', ids)) : [];
    const seen = new Set();
    [...byCust, ...byCharge].forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); pays.push(p); } });
  } catch (e) { /* אין תשלומים */ }

  const T = (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10);
  const chargeDesc = {}; charges.forEach(c => chargeDesc[c.id] = c.description || '');

  // יומן: חיוב = חובה, תשלום = זכות. חיובים מבוטלים לא נספרים ביתרה.
  const entries = [];
  charges.forEach(c => {
    entries.push({
      date: c.issued_date || '', type: 'charge', dead: CS_DEAD.includes(c.status),
      desc: c.description || 'חיוב', ref: c.invoice_number || '', status: c.status,
      debit: Number(c.amount || 0), credit: 0
    });
  });
  pays.forEach(p => {
    const base = _csPayMethod(p.method);
    const forWhat = p.charge_id && chargeDesc[p.charge_id] ? ' — ' + chargeDesc[p.charge_id] : '';
    entries.push({
      date: p.paid_date || '', type: 'payment', dead: false,
      desc: 'תשלום (' + base + ')' + forWhat + (p.check_due_date ? ' · פירעון ' + _csDate(p.check_due_date) : ''),
      ref: '', status: '', debit: 0, credit: Number(p.amount || 0)
    });
  });
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.type === 'charge' ? -1 : 1));

  let running = 0, totalCharged = 0, totalPaid = 0;
  entries.forEach(e => {
    if (!e.dead) { running += e.debit - e.credit; totalCharged += e.debit; totalPaid += e.credit; }
    e.balance = running;
  });

  // יתרה פתוחה "רשמית" (לפי סטטוסים) + החוב הוותיק — כמו קודם
  const paidByCharge = {};
  pays.forEach(p => { if (p.charge_id) paidByCharge[p.charge_id] = (paidByCharge[p.charge_id] || 0) + Number(p.amount || 0); });
  let outstanding = 0, oldestDue = null;
  charges.forEach(c => {
    const bal = Number(c.amount || 0) - (paidByCharge[c.id] || 0);
    if (CS_OPEN.includes(c.status) && bal > 0) {
      outstanding += bal;
      if (c.due_date && c.due_date < T && (!oldestDue || c.due_date < oldestDue)) oldestDue = c.due_date;
    }
  });
  return { cust, entries, totalCharged, totalPaid, outstanding, oldestDue };
}

/* בונה HTML עצמאי (מסמך שלם) להדפסה / שמירה כ-PDF */
function _csBuildHtml(data) {
  const { cust, entries, totalCharged, totalPaid, outstanding, oldestDue } = data;
  const now = new Date();
  const dateStr = now.toLocaleDateString('he-IL');
  const contact = [cust.contact_person, cust.phone, cust.email].filter(Boolean).map(_csEsc).join(' · ');
  const bodyRows = entries.length ? entries.map(e => {
    const balColor = e.balance > 0 ? '#b91c1c' : (e.balance < 0 ? '#047857' : '#111');
    const style = e.dead ? 'color:#9ca3af;text-decoration:line-through' : '';
    return `<tr style="${style}">
      <td>${_csDate(e.date)}</td>
      <td>${_csEsc(e.desc)}${e.dead ? ' (' + _csEsc(_csStatusHe(e.status)) + ')' : ''}</td>
      <td class="ctr">${_csEsc(e.ref || '—')}</td>
      <td class="num">${e.debit ? _csMoney(e.debit) : '—'}</td>
      <td class="num">${e.credit ? _csMoney(e.credit) : '—'}</td>
      <td class="num" style="color:${balColor};font-weight:600">${e.dead ? '—' : _csMoney(e.balance)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:18px">אין תנועות רשומות ללקוח זה</td></tr>`;

  const overdueNote = oldestDue
    ? `<div class="warn">⚠ קיים חוב באיחור מתאריך ${_csDate(oldestDue)}. נודה על הסדרת התשלום.</div>` : '';

  return `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>כרטסת — ${_csEsc(cust.name || '')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 28px 32px; background:#fff; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #1e3a8a; padding-bottom:14px; margin-bottom:18px; }
  .brand { font-size:26px; font-weight:800; color:#1e3a8a; letter-spacing:-.5px; }
  .brand small { display:block; font-size:12px; font-weight:500; color:#6b7280; letter-spacing:0; }
  .doc-title { text-align:left; }
  .doc-title h1 { margin:0; font-size:20px; color:#111; }
  .doc-title span { font-size:13px; color:#6b7280; }
  .who { background:#f8fafc; border:1px solid #e5e7eb; border-radius:10px; padding:12px 16px; margin-bottom:16px; }
  .who b { font-size:16px; }
  .who div { color:#4b5563; font-size:13px; margin-top:3px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { background:#1e3a8a; color:#fff; padding:8px 10px; text-align:right; font-weight:600; }
  th.num, td.num { text-align:left; }
  th.ctr, td.ctr { text-align:center; }
  td { padding:7px 10px; border-bottom:1px solid #eef2f7; }
  tbody tr:nth-child(even) { background:#fafbfe; }
  .totals { margin-top:18px; margin-inline-start:auto; width:320px; }
  .totals div { display:flex; justify-content:space-between; padding:6px 0; font-size:14px; }
  .totals .grand { border-top:2px solid #1e3a8a; margin-top:6px; padding-top:10px; font-size:17px; font-weight:800; }
  .totals .grand .v { color:#b91c1c; }
  .warn { margin-top:16px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; padding:10px 14px; font-size:13px; }
  .foot { margin-top:26px; border-top:1px solid #e5e7eb; padding-top:12px; font-size:12px; color:#6b7280; text-align:center; }
  .bar { position:sticky; top:0; text-align:center; margin-bottom:14px; }
  .bar button { font-family:inherit; font-size:14px; padding:9px 22px; border:0; border-radius:8px; background:#1e3a8a; color:#fff; cursor:pointer; margin:0 4px; }
  .bar button.sec { background:#e5e7eb; color:#111; }
  @media print { .bar { display:none; } body { padding:0; } }
</style></head><body>
  <div class="bar">
    <button onclick="window.print()">🖨️ הדפס / שמור PDF</button>
    <button class="sec" onclick="window.close()">סגור</button>
  </div>
  <div class="top">
    <div class="brand">@@PAPER_NAME@@<small>@@PAPER_SUB@@</small></div>
    <div class="doc-title"><h1>כרטסת לקוח / דו"ח חוב</h1><span>הופק בתאריך ${_csEsc(dateStr)}</span></div>
  </div>
  <div class="who">
    <b>${_csEsc(cust.name || '')}</b>
    ${contact ? `<div>${contact}</div>` : ''}
    ${cust.city ? `<div>${_csEsc(cust.city)}</div>` : ''}
  </div>
  <table>
    <thead><tr>
      <th>תאריך</th><th>פירוט</th><th class="ctr">חשבונית</th>
      <th class="num">חובה</th><th class="num">זכות</th><th class="num">יתרה</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div class="totals">
    <div><span>סה"כ חיובים</span><span>${_csMoney(totalCharged)}</span></div>
    <div><span>סה"כ שולם</span><span>${_csMoney(totalPaid)}</span></div>
    <div class="grand"><span>יתרה לתשלום</span><span class="v">${_csMoney(outstanding)}</span></div>
  </div>
  ${overdueNote}
  <div class="foot">מסמך זה הופק אוטומטית ממערכת הניהול של "@@PAPER_NAME@@". לבירורים ניתן לפנות למערכת.</div>
</body></html>`;
}

/* פותח את הכרטסת בחלון להדפסה / שמירה כ-PDF */
async function customerStatement(customerId) {
  try {
    if (typeof toast === 'function') toast('מפיק כרטסת...');
    const data = await _csGather(Number(customerId));
    const html = _csBuildHtml(data);
    const w = window.open('', '_blank');
    if (!w) { if (typeof toast === 'function') toast('חלון ההדפסה נחסם — אפשר חלונות קופצים לאתר', true); return; }
    w.document.open(); w.document.write(html); w.document.close(); w.focus();
  } catch (e) {
    if (typeof toast === 'function') toast('שגיאה בהפקת כרטסת: ' + e, true);
    console.error('customer-statement', e);
  }
}

/* עטיפת openCustomerCard — הזרקת כפתור כרטסת */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._csWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (['admin', 'sales'].includes(profile.role)) {
          const modal = document.getElementById('viewModal');
          if (modal && !document.getElementById('csBtn')) {
            const div = document.createElement('div');
            div.style.cssText = 'margin-top:10px;text-align:start';
            div.innerHTML = `<button id="csBtn" class="btn btn-sm btn-ghost" onclick="customerStatement(${id})">📄 דו"ח חוב / כרטסת</button>`;
            modal.appendChild(div);
          }
        }
      } catch (e) { console.error('customer-statement wrap', e); }
      return r;
    };
    wrapped._csWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
