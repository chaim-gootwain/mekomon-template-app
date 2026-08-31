/* ============================================================
invoices.js — הפקת חשבוניות דרך EZcount
------------------------------------------------------------
- מוזרק לכרטיס הלקוח בלי לגעת בקוד הקיים (עטיפת openCustomerCard)
- מאחורי דגל: settings.ezcount_enabled ('0' כברירת מחדל)
- טופס מרובה-שורות · שורה אוטומטית (גיליון+תאריך) · "סיכום חודש"
- המספור תמיד אצל EZcount; אנחנו רק שולחים ושומרים תוצאה
============================================================ */

'use strict';

function invoicesOn() { return String((cache.settings || {}).ezcount_enabled || '0') === '1'; }
function invMode() { return (cache.settings || {}).ezcount_mode === 'production' ? 'אמיתי' : 'בדיקה'; }

const DOC_KIND_HE = {
  proforma: 'חשבון עסקה', tax_invoice: 'חשבונית מס',
  invoice_receipt: 'חשבונית מס-קבלה', receipt: 'קבלה', credit: 'חשבונית זיכוי',
};
const INV_PAY_METHODS = [
  { v: 'cash', t: 'מזומן' }, { v: 'check', t: 'צ׳ק' }, { v: 'transfer', t: 'העברה' },
  { v: 'bit', t: 'ביט' }, { v: 'paybox', t: 'פייבוקס' }, { v: 'credit', t: 'אשראי' },
];

function invEnsureStyles() {
  if (document.getElementById('invFxStyles')) return;
  const s = document.createElement('style');
  s.id = 'invFxStyles';
  s.textContent = `
  .inv-panel{margin-top:16px;border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:14px;background:#fbfdff}
  .inv-head{font-weight:800;color:@@COLOR_BRAND@@;margin-bottom:8px}
  .inv-banner{background:#fff7e6;border:1px solid #ffe0a3;border-radius:10px;padding:10px 12px;margin-bottom:8px;
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#8a5a00}
  .inv-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:rgba(17,20,40,.55);backdrop-filter:blur(2px);padding:16px;overflow:auto}
  .inv-box{background:#fff;border-radius:16px;max-width:640px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:92vh;overflow:auto}
  .inv-box h3{margin:0 0 12px;color:@@COLOR_BRAND@@}
  .inv-line{display:grid;grid-template-columns:1fr 60px 84px 62px 30px;gap:6px;align-items:center;margin-bottom:6px}
  .inv-line input{padding:6px 8px;border:1px solid var(--line,#e5e7eb);border-radius:8px;width:100%}
  .inv-line .rm{cursor:pointer;color:#c0392b;font-weight:900;text-align:center}
  .inv-lh{display:grid;grid-template-columns:1fr 60px 84px 62px 30px;gap:6px;font-size:.75rem;color:#8890a6;margin-bottom:4px}
  .inv-total{font-weight:800;color:#1c2438;margin:10px 0}
  `;
  document.head.appendChild(s);
}

async function loadCustomerDocs(cid) {
  try {
    const { data } = await db.from('documents').select('*').eq('customer_id', cid).order('created_at', { ascending: false });
    return data || [];
  } catch (e) { return []; }
}

function invStatusPill(s) {
  if (s === 'issued') return '<span class="pill green">הופק</span>';
  if (s === 'pending_allocation') return '<span class="pill amber">ממתין להקצאה</span>';
  if (s === 'failed') return '<span class="pill red">נכשל</span>';
  if (s === 'cancelled') return '<span class="pill red">בוטל</span>';
  return esc(s);
}

function invPanelHtml(cust, docs, issMap) {
  issMap = issMap || {};
  const _issForDoc = (d) => {
    const m = String(d.transaction_id || '').match(/emu-iss(\d+)-cust/);
    if (m) { const iss = ((typeof cache !== 'undefined' && cache.issues) || []).find(i => i.id === Number(m[1])); if (iss) return 'גיליון ' + iss.issue_number; }
    return issMap[d.doc_number] || '';
  };
  const hasOrderDoc = docs.some(d => ['proforma', 'tax_invoice', 'invoice_receipt'].includes(d.doc_kind) && d.status !== 'failed');
  const orderKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
  const banner = !hasOrderDoc
    ? `<div class="inv-banner">📄 עדיין לא הופק מסמך להזמנה —
        <button class="btn btn-sm" onclick="invIssueOrder(${cust.id})">הנפק ${DOC_KIND_HE[orderKind]}</button></div>`
    : '';
  const rows = docs.map(d => `<tr>
      <td>${DOC_KIND_HE[d.doc_kind] || esc(d.doc_kind)}${(() => { const _g = _issForDoc(d); return _g ? `<div style="font-size:.72rem;color:var(--muted)">${esc(_g)}</div>` : ''; })()}</td>
      <td dir="ltr">${esc(d.doc_number) || '—'}</td>
      <td>${heDate(d.created_at)}</td>
      <td>${d.total != null ? money(d.total) : '—'}</td>
      <td>${invStatusPill(d.status)}</td>
      <td>${d.pdf_url ? `<a class="btn btn-sm btn-ghost" href="${esc(d.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : ''}
          ${d.status === 'issued' && ['proforma', 'tax_invoice'].includes(d.doc_kind) && ((d.raw && d.raw.doc_uuid) || d.doc_uuid)
      ? `<button class="btn btn-sm" onclick="invIssueReceiptFor(${d.id})">🧾 ${d.doc_kind === 'tax_invoice' ? 'קבלה' : 'מס-קבלה'}</button>` : ''}
          ${d.status === 'issued' && d.doc_kind !== 'credit'
      ? `<button class="btn btn-sm btn-danger-ghost" onclick="invCredit(${d.id})">🚫 ביטול</button>` : ''}</td>
    </tr>`).join('');
  return `<div class="inv-panel">
    <div class="inv-head">🧾 חשבוניות (EZcount · מצב ${invMode()})</div>
    ${banner}
    <div class="m-actions" style="flex-wrap:wrap;margin:8px 0">
      <button class="btn btn-sm btn-ghost" onclick="invIssueOrder(${cust.id})">+ חשבון עסקה / חשבונית מס</button>
      <button class="btn btn-sm" onclick="invIssuePayment(${cust.id})">+ מס-קבלה / קבלה (תשלום)</button>
    </div>
    ${docs.length
      ? `<div class="table-wrap"><table class="data"><thead><tr><th>סוג</th><th>מספר</th><th>תאריך</th><th>סכום</th><th>סטטוס</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">עדיין לא הופקו מסמכים</p>'}
  </div>`;
}

function _ezDate(d) { // yyyy-mm-dd -> dd/mm/yyyy
  if (!d) return undefined;
  const p = String(d).split('-');
  return (p.length === 3) ? `${p[2]}/${p[1]}/${p[0]}` : undefined;
}
function _dmy(dateStr) { // date -> dd/mm/yyyy
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
// התאריך של הגיליון (יום ה' הדפוס): print_date אם קיים, אחרת publish_date
function _issueDate(iss) { return _dmy(iss.print_date || iss.publish_date); }
function _issueLineText(iss) {
  const num = iss.issue_number ?? iss.number ?? iss.id;
  const dt = _issueDate(iss);
  return dt ? `גיליון ${num} — ${dt}` : `גיליון ${num}`;
}

/* ---------- טעינת גיליונות + מצב הטופס ---------- */
let _invIssues = [];
let _invState = null; // {cid, kind, isPayment, lines:[{details,amount,price}], issueId, vatInc, method, date}

async function invLoadIssues() {
  try {
    const { data } = await db.from('issues').select('id,issue_number,publish_date,print_date').order('issue_number', { ascending: false }).limit(60);
    _invIssues = data || [];
  } catch (e) { _invIssues = []; }
}
function _nearestIssueId() {
  if (!_invIssues.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  // הקרוב: הגיליון הראשון שתאריכו >= היום; אחרת האחרון
  const upcoming = _invIssues.slice().reverse().find(i => (i.publish_date || '') >= today);
  return (upcoming || _invIssues[0]).id;
}
// חלון "סיכום חודש": 25 לחודש ומעלה, או עד ה-5 לחודש הבא
function _inMonthWindow() { const d = new Date().getDate(); return d >= 25 || d <= 5; }
// גיליונות של חודש החיוב (אם היום <=5 → החודש שעבר; אחרת החודש הנוכחי)
function _monthIssues() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth(); // 0-based
  if (now.getDate() <= 5) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const pref = `${y}-${String(m + 1).padStart(2, '0')}`;
  return _invIssues.filter(i => (i.publish_date || '').startsWith(pref))
    .sort((a, b) => (a.issue_number || 0) - (b.issue_number || 0));
}

async function invIssueOrder(cid) {
  if (typeof checkCustomerStatusGate === 'function') { const _okS = await checkCustomerStatusGate(cid, 'הפקת חשבונית'); if (!_okS) return; }
  const c = _customers.find(x => x.id === cid) || await run(db.from('customers').select('*').eq('id', cid).single());
  const kind = c.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
  await invOpenModal(c, kind, false);
}
async function invIssuePayment(cid) {
  const c = _customers.find(x => x.id === cid) || await run(db.from('customers').select('*').eq('id', cid).single());
  const docs = await loadCustomerDocs(cid);
  const hasTaxInvoice = docs.some(d => d.doc_kind === 'tax_invoice' && d.status !== 'failed');
  const kind = hasTaxInvoice ? 'receipt' : 'invoice_receipt';
  await invOpenModal(c, kind, true);
}

/* הנפקת מסמך תשלום המשויך למסמך מקור (parent):
   אחרי חשבון עסקה → חשבונית מס קבלה · אחרי חשבונית מס → קבלה */
async function invIssueReceiptFor(docId) {
  const d = await run(db.from('documents').select('*').eq('id', docId).single());
  if (!d) { toast('מסמך לא נמצא', true); return; }
  const parentUuid = (d.raw && d.raw.doc_uuid) || d.doc_uuid || null;
  if (!parentUuid) { toast('חסר מזהה מסמך לשיוך', true); return; }
  const kind = d.doc_kind === 'tax_invoice' ? 'receipt' : 'invoice_receipt';
  if (typeof checkCustomerStatusGate === 'function') { const _ok = await checkCustomerStatusGate(d.customer_id, 'הנפקת קבלה'); if (!_ok) return; }
  const c = _customers.find(x => x.id === d.customer_id) || await run(db.from('customers').select('*').eq('id', d.customer_id).single());
  await invOpenModal(c, kind, true, { parentUuid, amount: d.total, srcLabel: DOC_KIND_HE[d.doc_kind] || 'מסמך', srcNumber: d.doc_number });
}

async function invOpenModal(c, kind, isPayment, opts = {}) {
  invEnsureStyles();
  await invLoadIssues();
  const issueId = _nearestIssueId();
  const iss = _invIssues.find(i => i.id === issueId);
  document.getElementById('viewBack')?.classList.remove('open');
  const _line = opts.parentUuid
    ? { details: 'תשלום עבור ' + (opts.srcLabel || 'חשבונית') + (opts.srcNumber ? ' ' + opts.srcNumber : ''), amount: 1, price: (opts.amount != null ? opts.amount : '') }
    : { details: iss ? _issueLineText(iss) : 'מודעת פרסום', amount: 1, price: '' };
  const _lines = (opts.lines && opts.lines.length)
    ? opts.lines.map(l => ({ details: l.details, amount: (l.amount != null ? l.amount : 1), price: (l.price != null ? l.price : '') }))
    : [_line];
  // סוכנות (פיצ'ר #7): ברירת המחדל של "על שם מי" נקבעת בהגדרות הסוכנות
  const _agency = (c.agency_id && (cache.agencies || []).find(a => a.id === c.agency_id)) || null;
  _invState = {
    cid: c.id, name: c.name, kind, isPayment, issueId: (opts.issueId != null ? opts.issueId : issueId),
    parentUuid: opts.parentUuid || null, srcNumber: opts.srcNumber || null,
    hpMissing: !(c.business_id && String(c.business_id).trim()),
    agency: _agency, billTo: (_agency && _agency.invoice_target === 'agency') ? 'agency' : 'customer',
    orderRef: opts.orderRef || '',
    lines: _lines,
    vatInc: (opts.vatInc != null ? opts.vatInc : (isPayment ? true : false)), method: 'cash', date: '',
    docDate: today(),
    openCharges: [],
  };
  // תשלום ללא שיוך למסמך-אב — טוענים את החוב הפתוח כדי להציג למה התשלום ייזקף
  if (isPayment && !opts.parentUuid) {
    try {
      const rows = (await db.from('charges').select('id,amount,description').eq('customer_id', c.id)
        .in('status', ['pending', 'invoiced', 'partial', 'overdue']).order('issued_date', { ascending: true })).data || [];
      const withBal = [];
      for (const ch of rows) {
        const pays = (await db.from('payments').select('amount').eq('charge_id', ch.id)).data || [];
        const bal = Number(ch.amount) - pays.reduce((s, p) => s + Number(p.amount), 0);
        if (bal > 0.001) withBal.push({ desc: ch.description || 'חיוב', bal: Math.round(bal * 100) / 100 });
      }
      _invState.openCharges = withBal;
    } catch (e) { _invState.openCharges = []; }
  }
  const ov = document.createElement('div');
  ov.className = 'inv-ov'; ov.id = 'invOv';
  ov.addEventListener('click', e => { if (e.target === ov) invCloseModal(); });
  document.body.appendChild(ov);
  invRenderModal();
}
function invCloseModal() { document.getElementById('invOv')?.remove(); _invState = null; }

function invRenderModal() {
  const s = _invState; if (!s) return;
  const issOpts = `<option value="" ${!s.issueId ? 'selected' : ''}>— ללא שורת גיליון —</option>` + _invIssues.map(i => `<option value="${i.id}" ${i.id === s.issueId ? 'selected' : ''}>גיליון ${i.issue_number} · ${_issueDate(i) || ''}</option>`).join('');
  const lines = s.lines.map((ln, i) => `<div class="inv-line">
      <input value="${esc(ln.details)}" oninput="invLineSet(${i},'details',this.value)" placeholder="תיאור">
      <input type="number" value="${ln.amount}" oninput="invLineSet(${i},'amount',this.value)">
      <input type="number" value="${ln.price}" oninput="invLineSet(${i},'price',this.value)" placeholder="מחיר">
      <input type="number" value="${ln.disc || ''}" min="0" max="100" oninput="invLineSet(${i},'disc',this.value)" placeholder="% הנחה" title="אחוז הנחה לשורה — יופיע בתיאור הפריט">
      <span class="rm" onclick="invRmLine(${i})" title="הסר">✕</span>
    </div>`).join('');
  let total = 0; s.lines.forEach(l => total += (Number(l.amount) || 0) * (Number(l.price) || 0));
  const payFields = s.isPayment ? `
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>אמצעי תשלום</label><select id="invMethod" onchange="_invState.method=this.value">
        ${INV_PAY_METHODS.map(m => `<option value="${m.v}" ${m.v === s.method ? 'selected' : ''}>${m.t}</option>`).join('')}</select></div>
      <div class="field"><label>תאריך תשלום</label><input type="date" value="${s.date}" onchange="_invState.date=this.value"></div>
    </div>` : '';
  document.getElementById('invOv').innerHTML = `<div class="inv-box">
    <h3>הנפקת ${DOC_KIND_HE[s.kind]} — ${esc(s.name)}</h3>
    ${s.agency ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:8px 11px;margin:0 0 10px;font-size:.85rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      🏢 לקוח דרך סוכנות <b>${esc(s.agency.name)}</b> · המסמך על שם:
      <select onchange="_invState.billTo=this.value" style="padding:3px 8px;border-radius:6px;border:1px solid #bfdbfe">
        <option value="customer" ${s.billTo === 'customer' ? 'selected' : ''}>הלקוח — ${esc(s.name)}</option>
        <option value="agency" ${s.billTo === 'agency' ? 'selected' : ''}>הסוכנות — ${esc(s.agency.invoice_name || s.agency.name)}</option>
      </select></div>` : ''}
    ${s.hpMissing ? `<div style="background:#fdecec;border:1px solid #f5b5b5;color:#b91c1c;border-radius:9px;padding:8px 11px;margin:0 0 10px;font-size:.84rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">⚠ ללקוח אין <b>ח.פ / עוסק</b> — מומלץ להשלים לפני ההפקה. <button class="btn btn-sm" style="background:var(--brand)" onclick="invCloseModal(); customerEdit(${s.cid})">✎ השלמת ח.פ</button></div>` : ''}
    ${(s.isPayment && !s.parentUuid) ? ((s.openCharges && s.openCharges.length)
      ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;padding:8px 11px;margin:0 0 10px;font-size:.84rem">
          <b>חוב פתוח (${s.openCharges.length}) — ${money(s.openCharges.reduce((t, o) => t + o.bal, 0))}:</b>
          <div style="margin-top:4px">${s.openCharges.map(o => `<div>• ${esc(o.desc)} — ${money(o.bal)}</div>`).join('')}</div>
          <div class="muted" style="margin-top:4px">התשלום ייזקף אוטומטית לחוב הפתוח (הישן קודם).</div>
        </div>`
      : `<div class="muted" style="font-size:.82rem;margin:0 0 8px">אין חוב פתוח ללקוח — בחר/י גיליון או "📅 סיכום חודש" לייחוס התשלום.</div>`) : ''}
    ${!s.isPayment ? `<div class="field"><label>סוג מסמך</label>
      <select onchange="invSetKind(this.value)">
        <option value="proforma" ${s.kind === 'proforma' ? 'selected' : ''}>חשבון עסקה</option>
        <option value="tax_invoice" ${s.kind === 'tax_invoice' ? 'selected' : ''}>חשבונית מס</option>
      </select></div>` : (!s.parentUuid ? `<div class="field"><label>סוג מסמך</label>
      <select onchange="invSetKind(this.value)">
        <option value="invoice_receipt" ${s.kind === 'invoice_receipt' ? 'selected' : ''}>חשבונית מס קבלה (תשלום מיידי)</option>
        <option value="receipt" ${s.kind === 'receipt' ? 'selected' : ''}>קבלה</option>
      </select></div>` : '')}
    <div class="field"><label>תאריך המסמך</label>
      <input type="date" value="${s.docDate || ''}" onchange="_invState.docDate=this.value"></div>
    <div class="field"><label>מס' הזמנה של הלקוח (יודפס על המסמך)</label>
      <input value="${esc(s.orderRef || '')}" dir="ltr" oninput="_invState.orderRef=this.value" placeholder="למשל PO-1234"></div>
    <div class="field"><label>גיליון (לשורה האוטומטית)</label>
      <select onchange="invSetIssue(this.value)">${issOpts}</select></div>
    <div class="inv-lh"><span>תיאור</span><span>כמות</span><span>מחיר</span><span>% הנחה</span><span></span></div>
    <div id="invLinesBox">${lines}</div>
    <div class="m-actions" style="flex-wrap:wrap;margin-top:6px">
      <button class="btn btn-sm btn-ghost" onclick="invAddLine()">+ הוסף שורה</button>
      ${(_inMonthWindow() || (typeof isMonthlyCustomer === 'function' && isMonthlyCustomer(s.cid))) ? `<button class="btn btn-sm btn-ghost" onclick="invMonthSummary()">📅 סיכום חודש</button>` : ''}
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;cursor:pointer">
      <input type="checkbox" ${s.vatInc ? 'checked' : ''} onchange="_invState.vatInc=this.checked; invUpdateTotal()" style="width:18px;height:18px"> המחירים כוללים מע"מ</label>
    ${payFields}
    <div class="inv-total" id="invTotal" style="display:block;text-align:right">${_invTotalsHtml()}</div>
    <div class="m-actions" style="justify-content:flex-start;gap:8px">
      <button class="btn" onclick="invSubmit()">הפק ${DOC_KIND_HE[s.kind]}</button>
      <button class="btn btn-ghost" onclick="invCloseModal()">ביטול</button>
    </div>
  </div>`;
}
function invLineSet(i, k, v) { if (_invState && _invState.lines[i]) { _invState.lines[i][k] = v; invUpdateTotal(); } }
/* פירוט מלא: בסיס / מע"מ / סה"כ — משתנה חי לפי "כולל מע"מ" (תצוגה מקדימה) */
/* מחיר נטו לשורה אחרי הנחת אחוז (פיצ'ר #5) */
function _invLineNet(l) {
  const disc = Math.min(100, Math.max(0, Number(l.disc) || 0));
  return Math.round((Number(l.amount) || 0) * (Number(l.price) || 0) * (1 - disc / 100) * 100) / 100;
}
function _invTotals() {
  const s = _invState; let net = 0; (s ? s.lines : []).forEach(l => net += _invLineNet(l));
  const rate = 0.18; let base, vat, total;
  if (s && s.vatInc) { total = net; base = Math.round(net / (1 + rate) * 100) / 100; vat = Math.round((total - base) * 100) / 100; }
  else { base = net; vat = Math.round(net * rate * 100) / 100; total = Math.round((net + vat) * 100) / 100; }
  return { base, vat, total, vatInc: !!(s && s.vatInc) };
}
function _invTotalsHtml() {
  const b = _invTotals();
  return `<div style="display:flex;justify-content:space-between;font-size:.9rem;color:#555"><span>בסיס (לפני מע"מ)</span><span>${money(b.base)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:.9rem;color:#555;margin-top:2px"><span>מע"מ 18%</span><span>${money(b.vat)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:800;font-size:1.1rem;margin-top:6px;padding-top:6px;border-top:1px solid var(--line,#e5e7eb)"><span>סה"כ לתשלום</span><span>${money(b.total)}</span></div>
    <div class="muted" style="font-size:.75rem;margin-top:4px">${b.vatInc ? 'המחירים שהוזנו כוללים מע"מ (המע"מ מחולץ מתוכם)' : 'המחירים שהוזנו לפני מע"מ — מתווסף 18%'}</div>`;
}
function invUpdateTotal() {
  const el = document.getElementById('invTotal');
  if (el) el.innerHTML = _invTotalsHtml();
}
function invAddLine() { _invState.lines.push({ details: '', amount: 1, price: '', disc: 0 }); invRenderModal(); }
function invRmLine(i) { _invState.lines.splice(i, 1); if (!_invState.lines.length) _invState.lines.push({ details: '', amount: 1, price: '' }); invRenderModal(); }
function invSetKind(k) { if (_invState) { _invState.kind = k; invRenderModal(); } }
function invSetIssue(id) {
  if (!id) { _invState.issueId = null; if (_invState.lines[0]) _invState.lines[0].details = ''; invRenderModal(); return; }
  _invState.issueId = Number(id);
  const iss = _invIssues.find(i => i.id === _invState.issueId);
  if (iss && _invState.lines[0]) _invState.lines[0].details = _issueLineText(iss);
  invRenderModal();
}
function invMonthSummary() {
  const issues = _monthIssues();
  if (!issues.length) { toast('לא נמצאו גיליונות לחודש הזה', true); return; }
  // מחליף את השורות בשורה לכל גיליון של החודש
  _invState.lines = issues.map(i => ({ details: _issueLineText(i), amount: 1, price: '' }));
  invRenderModal();
  toast(`נוספו ${issues.length} שורות — גיליונות החודש`);
}

async function invSubmit() {
  const s = _invState; if (!s) return;
  const items = s.lines.filter(l => (l.details || '').trim() && Number(l.price) > 0)
    .map(l => {
      const disc = Math.min(100, Math.max(0, Number(l.disc) || 0));
      const unit = disc ? Math.round(Number(l.price) * (1 - disc / 100) * 100) / 100 : (Number(l.price) || 0);
      return { details: l.details + (disc ? ` (כולל הנחה ${disc}%)` : ''), amount: Number(l.amount) || 1, price: unit };
    });
  if (!items.length) { toast('הוסף לפחות שורה אחת עם תיאור ומחיר', true); return; }
  const cid = s.cid;
  const body = { customer_id: cid, doc_kind: s.kind, items, vat_included: !!s.vatInc };
  // חשבונית על שם הסוכנות (פיצ'ר #7) — דריסת שם/ח.פ במסמך בלבד; החוב נשאר על הלקוח
  if (s.agency && s.billTo === 'agency') {
    body.bill_to_name = s.agency.invoice_name || s.agency.name;
    if (s.agency.business_id) body.bill_to_crn = s.agency.business_id;
    body.comment = ((body.comment ? body.comment + ' · ' : '') + 'עבור ' + s.name);
  }
  if (s.docDate) body.doc_date = s.docDate; // תאריך המסמך (YYYY-MM-DD)
  if ((s.orderRef || '').trim()) body.comment = 'הזמנה מס\' ' + s.orderRef.trim(); // מס' הזמנת הלקוח — מודפס בהערת המסמך
  if (s.isPayment && s.date) body.pay_date = s.date; // תאריך התשלום לספר החוב (YYYY-MM-DD)
  if (s.isPayment) {
    // סכום הקבלה חייב להיות ברוטו (כולל מע"מ) כדי להתאים לסכום החשבונית:
    // אם המחירים "פלוס מע"מ" (vatInc=false) — EZcount יוסיף 18% לשורות, אז גם הקבלה חייבת לכלול מע"מ.
    let base = 0; items.forEach(it => base += it.amount * it.price);
    // קבלה בלבד: הסכום שהוזן הוא הסכום הסופי (אין שורות מע"מ). חשבונית מס-קבלה: מגלמים מע"מ אם המחירים "פלוס מע"מ".
    const gross = (s.vatInc || s.kind === 'receipt') ? base : Math.round(base * 1.18 * 100) / 100;
    body.payment = { method: s.method, sum: gross, date: _ezDate(s.date) };
    if (s.kind === 'receipt') delete body.items; // קבלה בלבד — בלי פירוט חשבונית
  }
  if (s.parentUuid) body.parent = s.parentUuid; // שיוך המסמך למסמך המקור (חשבון עסקה / חשבונית מס)
  const _issueIds = new Set(); if (s.issueId) _issueIds.add(s.issueId);
  s.lines.forEach(ln => { const m = (_invIssues || []).find(i => _issueLineText(i) === (ln.details || '')); if (m) _issueIds.add(m.id); });
  if (_issueIds.size) { try { const { data: _mAds } = await db.from('ads').select('id').eq('customer_id', cid).in('issue_id', [..._issueIds]).not('status', 'in', '("cancelled","rejected")'); if (_mAds) body.ad_ids = _mAds.map(a => a.id); } catch (e) { } }
  // רושמים על החשבונית לאיזה גיליון(ות) היא שייכת — נשמר בהערת המסמך ובתיאור החיוב
  if (_issueIds.size && !body.comment) {
    const _nums = [..._issueIds].map(iid => { const _i = (_invIssues || []).find(x => x.id === iid); return _i ? _i.issue_number : null; }).filter(Boolean).sort((a, b) => a - b);
    if (_nums.length) body.comment = 'גיליון ' + _nums.join(', ');
  }
  const _tb = _invTotals();
  if (!confirm('תצוגה מקדימה — לפני הפקה:\n\n' + (DOC_KIND_HE[s.kind] || s.kind) + ' ל' + s.name +
    '\nבסיס: ' + money(_tb.base) + '  ·  מע"מ 18%: ' + money(_tb.vat) +
    '\nסה"כ לתשלום: ' + money(_tb.total) +
    '\nתאריך המסמך: ' + (s.docDate || today()) +
    '\n\nלהפיק? (לאחר ההפקה לא ניתן לבטל בקלות)')) return;
  invCloseModal();
  await invCall(body);
}

async function invCredit(docId) {
  const { data: d } = await db.from('documents').select('*').eq('id', docId).single();
  if (!d) return;
  const num = String(d.doc_number || '').trim();
  // חשבון עסקה אינו מסמך מס — ביטול פנימי בלבד (בלי חשבונית זיכוי שמזכה מע"מ)
  if (d.doc_kind === 'proforma') {
    if (!confirm('לבטל את חשבון העסקה ' + num + '?\n(ביטול פנימי בלבד — לא מופקת חשבונית זיכוי, כי חשבון עסקה אינו מסמך מס)')) return;
    try {
      const { data: chs } = await db.from('charges').select('id').eq('customer_id', d.customer_id).ilike('notes', '%#doc:' + num + '%').in('status', ['pending', 'invoiced', 'partial', 'overdue']);
      if (chs && chs.length) await db.from('charges').update({ status: 'cancelled', notes: 'בוטל — חשבון עסקה ' + num }).in('id', chs.map(c => c.id));
      await db.from('documents').update({ status: 'cancelled' }).eq('id', d.id);
      try { await addInteraction('customer', d.customer_id, '🚫 בוטל חשבון עסקה ' + num + ' (ביטול פנימי — ללא זיכוי מס)'); } catch (e) { }
      toast('✓ חשבון העסקה בוטל והחוב הוסר');
      if (typeof openCustomerCard === 'function') openCustomerCard(d.customer_id);
    } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
    return;
  }
  // מסמכי מס (חשבונית מס / מס-קבלה / קבלה) — חשבונית זיכוי (330) כדין, מזכה מע"מ
  if (!confirm('לבטל את "' + (DOC_KIND_HE[d.doc_kind] || d.doc_kind) + ' ' + num + '" ע"י הפקת חשבונית זיכוי?')) return;
  const parentUuid = (d.raw && d.raw.doc_uuid) || d.doc_uuid || null;
  const body = {
    customer_id: d.customer_id, doc_kind: 'credit', credit_ref: num || null, vat_included: true,
    items: [{ details: 'ביטול / זיכוי — ' + (DOC_KIND_HE[d.doc_kind] || '') + ' ' + num, amount: 1, price: (Number(d.total) || Number(d.raw && d.raw.calculatedData && d.raw.calculatedData.price_total) || 0) }],
    comment: 'זיכוי למסמך ' + num,
  };
  if (parentUuid) body.parent = parentUuid;
  await invCall(body);
}

async function invCall(body) {
  toast('מפיק מסמך...');
  try {
    const { data, error } = await db.functions.invoke('ezcount-doc', { body });
    if (error) {
      let msg = 'שגיאה';
      try { if (error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || msg; } } catch (e) { }
      toast('נכשל: ' + msg, true);
      if (body.customer_id) openCustomerCard(body.customer_id);
      return;
    }
    if (data && data.ok) {
      toast('✅ הופק מסמך ' + (data.document && data.document.doc_number ? data.document.doc_number : '') + ' — ה-PDF יהיה מוכן בעוד רגע');
      if (typeof applyInvoiceToLedger === 'function') { try { await applyInvoiceToLedger(body, data.document); } catch (e) { console.error('ledger sync', e); } }
      try { if (Array.isArray(body.ad_ids) && body.ad_ids.length) { await db.from('ads').update({ deal_stage: 'invoiced' }).in('id', body.ad_ids).or('deal_stage.is.null,deal_stage.neq.paid'); } } catch (e) { console.error('mark invoiced', e); }
    } else if (data && data.status === 'pending_allocation') {
      toast('ממתין למספר הקצאה מרשות המסים — בדוק ב-EZcount', true);
    } else {
      toast('נכשל: ' + (data && data.error ? data.error : ''), true);
    }
    if (body.customer_id) openCustomerCard(body.customer_id);
    return data;
  } catch (e) { toast('שגיאה: ' + e, true); }
}

/* עטיפת openCustomerCard — מזריק את פאנל החשבוניות אחרי רינדור הכרטיס */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._invWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (invoicesOn()) {
          const c = (typeof _customers !== 'undefined' && _customers.find(x => x.id === id)) || ((typeof cache !== 'undefined' && cache.customers) || []).find(x => x.id === id) || { id, order_doc_type: 'proforma' };
          const docs = await loadCustomerDocs(id);
          const _issMap = {};
          try {
            const { data: _chs } = await db.from('charges').select('invoice_number,description,notes').eq('customer_id', id);
            (_chs || []).forEach(ch => {
              const _num = ch.invoice_number || ((String(ch.notes || '').match(/#doc:([0-9]+)/) || [])[1]);
              const _m = String(ch.description || '').match(/גיליון[ ]*[0-9][0-9, ]*/);
              if (_num && _m) _issMap[_num] = _m[0].trim();
            });
          } catch (e) { }
          invEnsureStyles();
          const modal = document.getElementById('viewModal');
          if (modal) { const div = document.createElement('div'); div.innerHTML = invPanelHtml(c, docs, _issMap); (document.getElementById('ccInvoices') || modal).appendChild(div); }
        }
      } catch (e) { console.error('inv panel', e); }
      return r;
    };
    wrapped._invWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();

/* ── חשבונית מס קבלה ישירות מכרטיס הלקוח ──────────────────────────
   מפיק מסמך תשלום (invoice_receipt) עם החוב הפתוח של הלקוח נטען דינמית,
   ומוסיף כפתור לצד "הפקת חשבונית" בכרטיס הלקוח. */
async function invIssueReceiptDirect(cid) {
  if (typeof checkCustomerStatusGate === 'function') {
    const _okS = await checkCustomerStatusGate(cid, 'הפקת חשבונית מס קבלה');
    if (!_okS) return;
  }
  const c = _customers.find(x => x.id === cid) || await run(db.from('customers').select('*').eq('id', cid).single());
  await invOpenModal(c, 'invoice_receipt', true);
}
