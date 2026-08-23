/* ============================================================
invoice-chat.js — צ'אט הפקת חשבוניות ממלל חופשי (iCount)
------------------------------------------------------------
- כותבים משפט חופשי → פענוח (Edge: parse-invoice-text, Claude בצד השרת)
- התאמת לקוח fuzzy (Edge: match-customer) — לעולם לא מנחשים
- כרטיס תצוגה מקדימה עם עריכה inline וחישוב חי של מע"מ וסה"כ
- הפקה ב-iCount (Edge: issue-invoice) רק אחרי [אשר והפק]
- כל בקשה נרשמת בטבלת invoice_requests (draft/issued/cancelled/error)
- מאחורי דגל: settings.invoice_chat_enabled ('0' כברירת מחדל) —
  מדליקים רק במופע שמוגדרים בו סודות iCount. מוזרק לתפריט ולהגדרות
  בלי לגעת בקוד הקיים (עטיפות refreshCache ו-Pages.settings).
============================================================ */

'use strict';

function invoiceChatOn() { return String((cache.settings || {}).invoice_chat_enabled || '0') === '1'; }
function invChatVatPct() { const v = Number((cache.settings || {}).vat_rate); return v > 0 ? v : 18; }

const INVCHAT_DOC_HE = {
  tax_invoice: 'חשבונית מס', tax_invoice_receipt: 'חשבונית מס קבלה',
  receipt: 'קבלה', credit_invoice: 'חשבונית זיכוי', proforma: 'חשבון עסקה',
};
const INVCHAT_PAY_HE = { credit: 'אשראי', cash: 'מזומן', transfer: 'העברה בנקאית', check: 'צ׳ק' };

/* ---------- חישוב סכומים (נוסחה אחת — זהה לצד השרת) ---------- */
function invChatTotals(lines, ratePct) {
  const rate = Number(ratePct) / 100;
  let base = 0;
  (lines || []).forEach(l => {
    const line = (Number(l.quantity) || 1) * (Number(l.unit_price) || 0);
    base += l.price_includes_vat ? line / (1 + rate) : line;
  });
  base = Math.round(base * 100) / 100;
  const vat = Math.round(base * rate * 100) / 100;
  const total = Math.round((base + vat) * 100) / 100;
  return { base, vat, total };
}

/* ---------- עיצוב ---------- */
function invChatEnsureStyles() {
  if (document.getElementById('invChatStyles')) return;
  const s = document.createElement('style');
  s.id = 'invChatStyles';
  s.textContent = `
  .ic-wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  .ic-log{display:flex;flex-direction:column;gap:10px;min-height:120px}
  .ic-msg{max-width:92%;border-radius:14px;padding:10px 14px;font-size:.95rem;line-height:1.5}
  .ic-user{align-self:flex-start;background:var(--brand);color:#fff;border-bottom-right-radius:4px}
  .ic-bot{align-self:flex-end;background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
  .ic-bot.err{border-color:#f5b5b5;background:#fdecec;color:#b91c1c}
  .ic-bot.ok{border-color:#b7e4c3;background:#effaf2}
  .ic-card{align-self:stretch;max-width:100%;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px}
  .ic-card .hd{font-weight:800;color:var(--brand);margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ic-warn{background:#fff7e6;border:1px solid #ffe0a3;color:#8a5a00;border-radius:9px;padding:7px 10px;font-size:.83rem;margin-bottom:8px}
  .ic-src{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.75rem;font-weight:700}
  .ic-src.exist{background:#e7f7ec;color:#1a7f37}.ic-src.new{background:#eef2ff;color:#3b4ed8}
  .ic-line{display:grid;grid-template-columns:1fr 62px 86px 72px 26px;gap:6px;align-items:center;margin-bottom:6px}
  .ic-line input[type=text],.ic-line input[type=number]{padding:6px 8px;border:1px solid var(--line);border-radius:8px;width:100%}
  .ic-line .vat{display:flex;align-items:center;gap:4px;font-size:.72rem;color:var(--muted);white-space:nowrap}
  .ic-line .rm{cursor:pointer;color:#c0392b;font-weight:900;text-align:center}
  .ic-lh{display:grid;grid-template-columns:1fr 62px 86px 72px 26px;gap:6px;font-size:.72rem;color:var(--muted);margin-bottom:4px}
  .ic-sum{margin-top:10px;border-top:1px solid var(--line);padding-top:8px;font-size:.9rem}
  .ic-sum .row{display:flex;justify-content:space-between;margin-top:2px;color:#555}
  .ic-sum .tot{font-weight:800;font-size:1.08rem;color:var(--ink);margin-top:6px}
  .ic-choices{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .ic-inputrow{display:flex;gap:8px;position:sticky;bottom:0;background:var(--bg);padding:8px 0}
  .ic-inputrow input{flex:1}
  .ic-hist{font-size:.85rem}
  .ic-hist td{padding:6px 8px}
  @media(max-width:640px){.ic-line,.ic-lh{grid-template-columns:1fr 48px 70px 60px 22px}}
  `;
  document.head.appendChild(s);
}

/* ---------- קריאת Edge Function עם הודעת שגיאה קריאה ---------- */
async function invChatFn(name, body) {
  try {
    const { data, error } = await db.functions.invoke(name, { body });
    if (error) {
      let msg = error.message || 'שגיאה';
      try { if (error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || msg; } } catch (e) { }
      return { errMsg: msg };
    }
    if (data && data.error) return { errMsg: data.error, data };
    return { data };
  } catch (e) { return { errMsg: String(e && e.message || e) }; }
}

/* ---------- מצב הצ'אט ---------- */
let _icState = null; // הבקשה הפעילה
function icResetState() {
  _icState = { reqId: null, rawText: '', fields: null, pending: null, candidates: [], confidence: 'high', busy: false, mode: 'issue', pay: null, openProformas: [], payDate: null };
}

/* ---------- הדף ---------- */
Pages.invchat = {
  title: 'צ׳אט חשבוניות',
  render: async (el) => {
    invChatEnsureStyles();
    icResetState();
    if (!invoiceChatOn()) {
      el.innerHTML = `<div class="empty">צ׳אט החשבוניות כבוי במופע הזה.<br>מנהל יכול להדליק אותו במסך הגדרות ← "צ׳אט חשבוניות (iCount)".</div>`;
      return;
    }
    el.innerHTML = `
    <div class="ic-wrap">
      <div class="card card-pad" style="padding:12px 16px">
        <b>🧾 צ׳אט חשבוניות</b>
        <div class="muted" style="font-size:.83rem;margin-top:2px">
          כתוב משפט חופשי — למשל: <i>"תוציא לי ח. מס לגן ורדים על פרסום חצי עמוד 400+ פעמיים"</i>.
          שום מסמך לא מופק בלי אישור שלך בכרטיס התצוגה המקדימה.
        </div>
      </div>
      <div class="ic-log" id="icLog"></div>
      <div class="ic-inputrow">
        <input id="icInput" placeholder="מה להפיק?" autocomplete="off"
          onkeydown="if(event.key==='Enter')invChatSend()">
        <button class="btn" id="icSendBtn" onclick="invChatSend()">שלח</button>
      </div>
      <div class="card card-pad">
        <b>בקשות אחרונות</b>
        <div id="icHist" style="margin-top:8px"><div class="muted">טוען...</div></div>
      </div>
    </div>`;
    invChatLoadHistory();
    document.getElementById('icInput').focus();
  },
};

/* ---------- בועות בצ'אט ---------- */
function icBubble(html, cls) {
  const log = document.getElementById('icLog');
  if (!log) return null;
  const d = document.createElement('div');
  d.className = cls || 'ic-msg ic-bot';
  d.innerHTML = html;
  log.appendChild(d);
  d.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return d;
}
function icSay(html) { return icBubble(html, 'ic-msg ic-bot'); }
function icSayErr(html) { return icBubble(html, 'ic-msg ic-bot err'); }
function icSayOk(html) { return icBubble(html, 'ic-msg ic-bot ok'); }
function icSetBusy(b) {
  const btn = document.getElementById('icSendBtn');
  if (btn) { btn.disabled = b; btn.textContent = b ? '...' : 'שלח'; }
  if (_icState) _icState.busy = b;
}

/* ---------- שליחת מלל ---------- */
async function invChatSend() {
  const inp = document.getElementById('icInput');
  const text = (inp.value || '').trim();
  if (!text || (_icState && _icState.busy)) return;
  inp.value = '';
  icBubble(esc(text), 'ic-msg ic-user');

  // תשובה לשאלה פתוחה (למשל "למי להוציא?") — לא בקשה חדשה
  if (_icState && _icState.pending === 'customer' && _icState.fields) {
    icSetBusy(true);
    await invChatResolveCustomer(text);
    icSetBusy(false);
    return;
  }

  // בקשה חדשה
  icResetState();
  _icState.rawText = text;
  icSetBusy(true);
  const thinking = icSay('מפענח... ⏳');
  try {
    // 1. רישום draft בלוג
    const ins = await run(db.from('invoice_requests')
      .insert({ raw_text: text, user_id: profile.id, status: 'draft' }).select('id').single(), 'שגיאה ברישום הבקשה');
    _icState.reqId = ins.id;

    // 2. פענוח
    const p = await invChatFn('parse-invoice-text', { text });
    thinking.remove();
    if (p.errMsg || !p.data || !p.data.parsed) {
      icSayErr('הפענוח נכשל: ' + esc(p.errMsg || 'תשובה ריקה') + '<div class="ic-choices"><button class="btn btn-sm" onclick="invChatRetryParse()">נסה שוב</button></div>');
      return;
    }
    const parsed = p.data.parsed;
    _icState.confidence = parsed.confidence || 'low';
    _icState.mode = (parsed.action === 'pay_existing') ? 'pay_existing' : 'issue';
    db.from('invoice_requests').update({ parsed_json: parsed }).eq('id', _icState.reqId).then(() => { });

    _icState.fields = {
      doc_type: (_icState.mode === 'pay_existing') ? 'tax_invoice_receipt' : parsed.doc_type,
      customer_id: null,
      customer_name: parsed.customer_name_raw,
      customer_source: null,
      line_items: (parsed.line_items && parsed.line_items.length) ? parsed.line_items
        : [{ description: 'פרסום', quantity: 1, unit_price: 0, price_includes_vat: false }],
      payment_method: parsed.payment_method,
    };

    // 3. התאמת לקוח (אם יש שם)
    if (parsed.customer_name_raw) await invChatResolveCustomer(parsed.customer_name_raw);
    else invChatNext();
  } catch (e) {
    thinking.remove();
    icSayErr('שגיאה: ' + esc(String(e && e.message || e)));
  } finally {
    icSetBusy(false);
  }
}

function invChatRetryParse() {
  const inp = document.getElementById('icInput');
  if (_icState && _icState.rawText) { inp.value = _icState.rawText; }
  inp.focus();
}

/* ---------- התאמת לקוח ---------- */
async function invChatResolveCustomer(name) {
  _icState.pending = null;
  _icState.fields.customer_name = name;
  const m = await invChatFn('match-customer', { name });
  if (m.errMsg || !m.data) {
    icSayErr('התאמת הלקוח נכשלה: ' + esc(m.errMsg || '') + ' — אפשר להמשיך עם השם כלקוח חדש.');
    _icState.fields.customer_source = 'new';
    invChatNext();
    return;
  }
  const { match, candidates } = m.data;
  if (match === 'single') {
    const c = candidates[0];
    _icState.fields.customer_id = c.id;
    _icState.fields.customer_name = c.name;
    _icState.fields.customer_source = 'existing';
    invChatNext();
  } else if (match === 'multiple') {
    _icState.candidates = candidates;
    _icState.pending = 'customer_pick';
    icSay('נמצאו כמה לקוחות דומים ל"' + esc(name) + '" — למי הכוונה?' +
      '<div class="ic-choices">' +
      candidates.map((c, i) => `<button class="btn btn-sm btn-ghost" onclick="invChatPickCustomer(${i})">${esc(c.name)}${c.business_id ? ' <span class="muted">(' + esc(c.business_id) + ')</span>' : ''}</button>`).join('') +
      `<button class="btn btn-sm" onclick="invChatNewCustomer()">➕ לקוח חדש: "${esc(name)}"</button>` +
      '</div>');
  } else {
    _icState.pending = 'customer_pick';
    icSay('לא נמצא לקוח בשם "' + esc(name) + '".' +
      '<div class="ic-choices">' +
      `<button class="btn btn-sm" onclick="invChatNewCustomer()">➕ פתח כרטיס חדש: "${esc(name)}"</button>` +
      `<button class="btn btn-sm btn-ghost" onclick="invChatAskCustomerAgain()">✎ שם אחר</button>` +
      '</div>');
  }
}
function invChatPickCustomer(i) {
  const c = _icState.candidates[i];
  if (!c) return;
  _icState.fields.customer_id = c.id;
  _icState.fields.customer_name = c.name;
  _icState.fields.customer_source = 'existing';
  _icState.pending = null;
  invChatNext();
}
async function invChatNewCustomer() {
  const name = (_icState.fields.customer_name || '').trim();
  if (!name) { invChatAskCustomerAgain(); return; }
  try {
    const row = await run(db.from('customers').insert({ name }).select('id,name').single(), 'שגיאה בפתיחת כרטיס');
    _icState.fields.customer_id = row.id;
    _icState.fields.customer_source = 'new';
    _icState.pending = null;
    icSayOk('נפתח כרטיס לקוח חדש: <b>' + esc(row.name) + '</b>');
    try { cache.customers && cache.customers.push({ id: row.id, name: row.name }); } catch (e) { }
    invChatNext();
  } catch (e) { /* toast כבר הוצג */ }
}
function invChatAskCustomerAgain() {
  _icState.pending = 'customer';
  icSay('למי להוציא את המסמך? כתוב את שם הלקוח למטה.');
  document.getElementById('icInput').focus();
}

/* ---------- הצעד הבא: שאלות חסר או כרטיס ---------- */
function invChatNext() {
  const f = _icState.fields;
  if (!f.customer_id && !(f.customer_name && f.customer_name.trim())) { invChatAskCustomerAgain(); return; }
  // מצב "לקוח שילם" — שולפים את חשבון העסקה הפתוח ומפיקים מס-קבלה מקושרת
  if (_icState.mode === 'pay_existing') { invChatStartPayExisting(); return; }
  if (!f.doc_type) {
    _icState.pending = 'doc_type';
    icSay('איזה סוג מסמך להפיק?' +
      '<div class="ic-choices">' +
      Object.keys(INVCHAT_DOC_HE).map(k => `<button class="btn btn-sm btn-ghost" onclick="invChatSetDocType('${k}')">${INVCHAT_DOC_HE[k]}</button>`).join('') +
      '</div>');
    return;
  }
  if ((f.doc_type === 'receipt' || f.doc_type === 'tax_invoice_receipt') && !f.payment_method) {
    _icState.pending = 'payment_method';
    icSay('באיזה אמצעי תשלום שולם? (חובה לקבלה / מס-קבלה)' +
      '<div class="ic-choices">' +
      Object.keys(INVCHAT_PAY_HE).map(k => `<button class="btn btn-sm btn-ghost" onclick="invChatSetPay('${k}')">${INVCHAT_PAY_HE[k]}</button>`).join('') +
      '</div>');
    return;
  }
  _icState.pending = null;
  invChatRenderCard();
}
function invChatSetDocType(k) { _icState.fields.doc_type = k; _icState.pending = null; invChatNext(); }
function invChatSetPay(k) { _icState.fields.payment_method = k; _icState.pending = null; invChatNext(); }

/* ---------- כרטיס תצוגה מקדימה ---------- */
function invChatRenderCard() {
  const f = _icState.fields;
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  const noPrice = !f.line_items.some(l => Number(l.unit_price) > 0);
  const warns = [];
  if (_icState.confidence === 'low') warns.push('⚠ רמת ודאות נמוכה בפענוח — בדוק את כל השדות לפני הפקה.');
  if (f.line_items.some(l => !l.price_includes_vat)) warns.push('המחירים מסומנים <b>לפני מע"מ</b> — מע"מ ' + invChatVatPct() + '% יתווסף (אפשר לשנות בכל שורה).');
  if (noPrice) warns.push('⚠ חסר מחיר — השלם אותו בשורות למטה.');
  const srcBadge = f.customer_source === 'existing'
    ? '<span class="ic-src exist">✓ מכרטיס קיים</span>'
    : (f.customer_source === 'new' ? '<span class="ic-src new">כרטיס חדש</span>' : '<span class="ic-src new">שם חופשי</span>');
  const isPay = (f.doc_type === 'receipt' || f.doc_type === 'tax_invoice_receipt');
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'icCard-' + _icState.reqId;
  card.innerHTML = `
    <div class="hd">📄 תצוגה מקדימה — לאישור לפני הפקה</div>
    ${warns.map(w => `<div class="ic-warn">${w}</div>`).join('')}
    <div class="grid2">
      <div class="field"><label>לקוח ${srcBadge}</label>
        <input type="text" value="${esc(f.customer_name || '')}" onchange="invChatEditCustomer(this.value)"></div>
      <div class="field"><label>סוג מסמך</label>
        <select onchange="invChatCardSetDoc(this.value)">
          ${Object.keys(INVCHAT_DOC_HE).map(k => `<option value="${k}" ${k === f.doc_type ? 'selected' : ''}>${INVCHAT_DOC_HE[k]}</option>`).join('')}
        </select></div>
    </div>
    <div class="ic-lh"><span>תיאור</span><span>כמות</span><span>מחיר יח׳</span><span>כולל מע"מ</span><span></span></div>
    <div id="icLines">${invChatLinesHtml()}</div>
    <button class="btn btn-sm btn-ghost" onclick="invChatAddLine()">+ הוסף שורה</button>
    ${isPay ? `<div class="field" style="margin-top:10px;max-width:240px"><label>אמצעי תשלום</label>
      <select onchange="_icState.fields.payment_method=this.value">
        ${Object.keys(INVCHAT_PAY_HE).map(k => `<option value="${k}" ${k === f.payment_method ? 'selected' : ''}>${INVCHAT_PAY_HE[k]}</option>`).join('')}
      </select></div>` : ''}
    <div class="ic-sum" id="icSum">${invChatSumHtml()}</div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="icApprove" onclick="invChatApprove()">✅ אשר והפק</button>
      <button class="btn btn-ghost" onclick="invChatCancel()">בטל</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function invChatLinesHtml() {
  return _icState.fields.line_items.map((l, i) => `<div class="ic-line">
    <input type="text" value="${esc(l.description)}" oninput="invChatLineSet(${i},'description',this.value)">
    <input type="number" value="${l.quantity}" min="1" oninput="invChatLineSet(${i},'quantity',this.value)">
    <input type="number" value="${l.unit_price || ''}" step="any" placeholder="מחיר" oninput="invChatLineSet(${i},'unit_price',this.value)">
    <label class="vat"><input type="checkbox" ${l.price_includes_vat ? 'checked' : ''} onchange="invChatLineSet(${i},'price_includes_vat',this.checked)" style="width:16px;height:16px">כולל</label>
    <span class="rm" onclick="invChatRmLine(${i})" title="הסר">✕</span>
  </div>`).join('');
}
function invChatSumHtml() {
  const f = _icState.fields;
  const pct = invChatVatPct();
  if (f.doc_type === 'receipt') {
    const sum = Math.round(f.line_items.reduce((s, l) => s + (Number(l.quantity) || 1) * (Number(l.unit_price) || 0), 0) * 100) / 100;
    return `<div class="row tot"><span>סה"כ הקבלה</span><span>${money(sum)}</span></div>
      <div class="muted" style="font-size:.75rem;margin-top:3px">קבלה היא מסמך תשלום — הסכום כפי שנגבה, ללא פירוט מע"מ.</div>`;
  }
  const t = invChatTotals(f.line_items, pct);
  return `<div class="row"><span>לפני מע"מ</span><span>${money(t.base)}</span></div>
    <div class="row"><span>מע"מ ${pct}%</span><span>${money(t.vat)}</span></div>
    <div class="row tot"><span>סה"כ ${INVCHAT_DOC_HE[f.doc_type] || ''}</span><span>${money(t.total)}</span></div>`;
}
function invChatUpdateSum() { const el = document.getElementById('icSum'); if (el) el.innerHTML = invChatSumHtml(); }
function invChatLineSet(i, k, v) {
  const l = _icState.fields.line_items[i]; if (!l) return;
  if (k === 'quantity') l.quantity = Number(v) || 1;
  else if (k === 'unit_price') l.unit_price = Number(v) || 0;
  else if (k === 'price_includes_vat') l.price_includes_vat = !!v;
  else l[k] = v;
  invChatUpdateSum();
}
function invChatAddLine() {
  _icState.fields.line_items.push({ description: '', quantity: 1, unit_price: 0, price_includes_vat: false });
  document.getElementById('icLines').innerHTML = invChatLinesHtml();
  invChatUpdateSum();
}
function invChatRmLine(i) {
  _icState.fields.line_items.splice(i, 1);
  if (!_icState.fields.line_items.length) _icState.fields.line_items.push({ description: '', quantity: 1, unit_price: 0, price_includes_vat: false });
  document.getElementById('icLines').innerHTML = invChatLinesHtml();
  invChatUpdateSum();
}
async function invChatEditCustomer(name) {
  const n = (name || '').trim();
  if (!n) return;
  if (n !== _icState.fields.customer_name) {
    _icState.fields.customer_id = null;
    _icState.fields.customer_source = null;
    document.getElementById('icCard-' + _icState.reqId)?.remove();
    icSetBusy(true);
    await invChatResolveCustomer(n);
    icSetBusy(false);
  }
}
function invChatCardSetDoc(k) {
  _icState.fields.doc_type = k;
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  invChatNext(); // ייתכן שעכשיו חסר אמצעי תשלום (קבלה/מס-קבלה)
}

/* ---------- אישור / ביטול ---------- */
async function invChatApprove() {
  const f = _icState.fields;
  if (!f.line_items.some(l => Number(l.unit_price) > 0)) { toast('חסר מחיר — השלם לפני הפקה', true); return; }
  if (!f.customer_id && !(f.customer_name && f.customer_name.trim())) { toast('חסר לקוח', true); return; }
  const btn = document.getElementById('icApprove');
  if (btn) { btn.disabled = true; btn.textContent = 'מפיק...'; }
  icSetBusy(true);
  const r = await invChatFn('issue-invoice', { request_id: _icState.reqId, confirmed: true, fields: f });
  icSetBusy(false);
  if (r.errMsg || !r.data || !r.data.ok) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והפק'; }
    icSayErr('ההפקה נכשלה: ' + esc(r.errMsg || 'שגיאה') +
      '<div class="muted" style="font-size:.78rem;margin-top:4px">שום מסמך לא הופק. אפשר לתקן את הכרטיס ולנסות שוב.</div>');
    return;
  }
  const d = r.data.document || {};
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  icSayOk('✅ הופק <b>' + (INVCHAT_DOC_HE[f.doc_type] || 'מסמך') + '</b> ללקוח <b>' + esc(f.customer_name || '') + '</b>' +
    (d.doc_number ? ' · מספר <b dir="ltr">' + esc(String(d.doc_number)) + '</b>' : '') +
    (d.totals ? ' · סה"כ <b>' + money(f.doc_type === 'receipt' ? d.totals.total : d.totals.total) + '</b>' : '') +
    (d.pdf_url ? `<div class="ic-choices"><a class="btn btn-sm" href="${esc(d.pdf_url)}" target="_blank" rel="noopener">📄 פתח PDF</a></div>` : ''));
  icResetState();
  invChatLoadHistory();
  document.getElementById('icInput').focus();
}
async function invChatCancel() {
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  if (_icState.reqId) db.from('invoice_requests').update({ status: 'cancelled' }).eq('id', _icState.reqId).then(() => { });
  icSay('הבקשה בוטלה — לא הופק מסמך.');
  icResetState();
  invChatLoadHistory();
}

/* ============================================================
   מצב "לקוח שילם" — הפקת מס-קבלה מקושרת לחשבון עסקה פתוח
   ------------------------------------------------------------
   שולף את חשבונות העסקה הפתוחים של הלקוח מטבלת documents ומקשר
   את המס-קבלה למסמך המקור דרך ezcount-doc (parent=doc_uuid) — בדיוק
   כמו הכפתור בכרטיס הלקוח (invIssueReceiptFor). אין הפקה בלי אישור.
   ============================================================ */
function _icProformaUuid(d) {
  return (d && ((d.raw && (d.raw.doc_uuid || (d.raw.data && d.raw.data.doc_uuid))) || d.doc_uuid)) || null;
}
async function invChatFindOpenProformas(customerId) {
  const { data, error } = await db.from('documents').select('*')
    .eq('customer_id', customerId).eq('doc_kind', 'proforma').eq('status', 'issued')
    .order('created_at', { ascending: false }).limit(50);
  if (error) return { err: error.message, rows: [] };
  // פתוח = לא סומן settled (העמודה אולי עדיין לא קיימת → undefined = פתוח)
  return { err: null, rows: (data || []).filter(d => !d.settled_at) };
}
async function invChatStartPayExisting() {
  const f = _icState.fields;
  if (!f.customer_id) {
    _icState.pending = 'customer';
    icSay('כדי לרשום תשלום על חשבונית קיימת אני צריך לקוח מתוך המערכת (עם כרטיס). כתוב את שם הלקוח:');
    document.getElementById('icInput')?.focus();
    return;
  }
  icSetBusy(true);
  const thinking = icSay('מחפש חשבון עסקה פתוח ל' + esc(f.customer_name || '') + '... ⏳');
  const res = await invChatFindOpenProformas(f.customer_id);
  icSetBusy(false);
  thinking && thinking.remove();
  if (res.err) { icSayErr('שגיאה בשליפת המסמכים: ' + esc(res.err)); return; }
  const linkable = (res.rows || []).filter(d => _icProformaUuid(d));
  if (!linkable.length) {
    if (res.rows.length) {
      icSayErr('נמצאו ' + res.rows.length + ' חשבוניות עסקה פתוחות ל' + esc(f.customer_name || '') +
        ', אבל אף אחת לא ניתנת לקישור אוטומטי (הופקו מחוץ למסלול הרגיל / חסר מזהה מסמך לשיוך). אפשר להפיק מס-קבלה ידנית מכרטיס הלקוח.');
    } else {
      icSayErr('לא נמצאה חשבונית עסקה פתוחה ל' + esc(f.customer_name || '') + '. אם כבר הופקה עליה מס-קבלה — היא נסגרה.');
    }
    return;
  }
  _icState.openProformas = linkable;
  if (linkable.length === 1) { invChatPayPick(0); return; }
  icSay('ל' + esc(f.customer_name || '') + ' יש כמה חשבוניות עסקה פתוחות — על איזו שולם?' +
    '<div class="ic-choices">' +
    linkable.map((d, i) => `<button class="btn btn-sm btn-ghost" onclick="invChatPayPick(${i})">עסקה ${esc(String(d.doc_number || '—'))} · ${money(Number(d.total) || 0)}${d.created_at ? ' · ' + (typeof heDate === 'function' ? heDate(d.created_at) : String(d.created_at).slice(0, 10)) : ''}</button>`).join('') +
    '</div>');
}
function invChatPayPick(i) {
  const d = _icState.openProformas[i];
  if (!d) return;
  _icState.pay = { docId: d.id, uuid: _icProformaUuid(d), docNumber: d.doc_number, amount: Number(d.total) || 0 };
  _icState.pending = null;
  if (!_icState.fields.payment_method) {
    _icState.pending = 'pay_method';
    icSay('באיזה אמצעי תשלום שילם ' + esc(_icState.fields.customer_name || '') + '?' +
      '<div class="ic-choices">' +
      INV_PAY_METHODS.map(m => `<button class="btn btn-sm btn-ghost" onclick="invChatPaySetMethod('${m.v}')">${m.t}</button>`).join('') +
      '</div>');
    return;
  }
  invChatRenderPayCard();
}
function invChatPaySetMethod(v) {
  _icState.fields.payment_method = v;
  _icState.pending = null;
  invChatRenderPayCard();
}
function invChatRenderPayCard() {
  const f = _icState.fields, p = _icState.pay;
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  _icState.payDate = _icState.payDate || today();
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'icCard-' + _icState.reqId;
  card.innerHTML = `
    <div class="hd">🧾 מס-קבלה מקושרת — לאישור לפני הפקה</div>
    <div class="ic-warn">המס-קבלה תקושר לחשבון העסקה <b dir="ltr">${esc(String(p.docNumber || ''))}</b> ותסגור אותו. הסכום נלקח מהעסקה.</div>
    <div class="grid2">
      <div class="field"><label>לקוח <span class="ic-src exist">✓ מכרטיס קיים</span></label>
        <input type="text" value="${esc(f.customer_name || '')}" disabled></div>
      <div class="field"><label>חשבון עסקה מקושר</label>
        <input type="text" value="${esc(String(p.docNumber || '—'))}" disabled dir="ltr"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>אמצעי תשלום</label>
        <select onchange="_icState.fields.payment_method=this.value">
          ${INV_PAY_METHODS.map(m => `<option value="${m.v}" ${m.v === f.payment_method ? 'selected' : ''}>${m.t}</option>`).join('')}
        </select></div>
      <div class="field"><label>תאריך תשלום</label>
        <input type="date" value="${esc(_icState.payDate)}" onchange="_icState.payDate=this.value"></div>
    </div>
    <div class="ic-sum">
      <div class="row tot"><span>סה"כ המס-קבלה</span><span>${money(Number(p.amount) || 0)}</span></div>
      <div class="muted" style="font-size:.75rem;margin-top:3px">הסכום כפי שנקבע בחשבון העסקה (כולל מע"מ).</div>
    </div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="icApprove" onclick="invChatPayApprove()">✅ אשר והפק מס-קבלה</button>
      <button class="btn btn-ghost" onclick="invChatCancel()">בטל</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
async function invChatPayApprove() {
  const f = _icState.fields, p = _icState.pay;
  if (!p || !p.uuid) { toast('חסר מזהה קישור לעסקה', true); return; }
  const gross = Number(p.amount) || 0;
  if (!(gross > 0)) { toast('סכום העסקה אינו תקין', true); return; }
  const method = f.payment_method || 'cash';
  const dstr = _icState.payDate || today();
  const btn = document.getElementById('icApprove');
  if (btn) { btn.disabled = true; btn.textContent = 'מפיק...'; }
  icSetBusy(true);
  const body = {
    customer_id: f.customer_id,
    doc_kind: 'invoice_receipt',
    items: [{ details: 'תשלום עבור חשבון עסקה ' + (p.docNumber || ''), amount: 1, price: gross }],
    vat_included: true,
    doc_date: dstr,
    pay_date: dstr,
    payment: { method, sum: gross, date: (typeof _ezDate === 'function' ? _ezDate(dstr) : dstr) },
    parent: p.uuid,
  };
  const r = await invChatFn('ezcount-doc', body);
  icSetBusy(false);
  const doc = r.data && r.data.document;
  if (r.data && r.data.status === 'pending_allocation') {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והפק מס-קבלה'; }
    icSayErr('ממתין למספר הקצאה מרשות המסים — בדוק ב-EZcount והשלם ידנית.');
    return;
  }
  if (r.errMsg || !r.data || !r.data.ok || !doc) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והפק מס-קבלה'; }
    if (_icState.reqId) db.from('invoice_requests').update({ status: 'error', error_message: String(r.errMsg || 'שגיאה').slice(0, 300), final_fields: body }).eq('id', _icState.reqId).then(() => { });
    icSayErr('ההפקה נכשלה: ' + esc(r.errMsg || 'שגיאה') +
      '<div class="muted" style="font-size:.78rem;margin-top:4px">שום מסמך לא הופק.</div>');
    return;
  }
  // סימון חשבון העסקה כסגור (העמודה אולי לא קיימת עדיין → best effort)
  try { await db.from('documents').update({ settled_at: new Date().toISOString(), settled_by_doc: doc.doc_number ? String(doc.doc_number) : null }).eq('id', p.docId); } catch (e) { }
  if (_icState.reqId) db.from('invoice_requests').update({ status: 'issued', icount_doc_number: doc.doc_number ? String(doc.doc_number) : null, icount_doc_url: doc.pdf_url || null, final_fields: body, error_message: null }).eq('id', _icState.reqId).then(() => { });
  if (typeof applyInvoiceToLedger === 'function') { try { await applyInvoiceToLedger(body, doc); } catch (e) { console.error('ledger', e); } }
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  icSayOk('✅ הופקה <b>חשבונית מס קבלה</b> ל<b>' + esc(f.customer_name || '') + '</b>' +
    (doc.doc_number ? ' · מספר <b dir="ltr">' + esc(String(doc.doc_number)) + '</b>' : '') +
    ' · מקושרת לעסקה <b dir="ltr">' + esc(String(p.docNumber || '')) + '</b>' +
    ' · סה"כ <b>' + money(gross) + '</b>' +
    (doc.pdf_url ? `<div class="ic-choices"><a class="btn btn-sm" href="${esc(doc.pdf_url)}" target="_blank" rel="noopener">📄 פתח PDF</a></div>` : ''));
  icResetState();
  invChatLoadHistory();
  document.getElementById('icInput')?.focus();
}

/* ---------- היסטוריה ---------- */
async function invChatLoadHistory() {
  const el = document.getElementById('icHist');
  if (!el) return;
  try {
    const { data } = await db.from('invoice_requests')
      .select('id,created_at,raw_text,status,icount_doc_number,icount_doc_url,error_message')
      .order('created_at', { ascending: false }).limit(10);
    const rows = data || [];
    if (!rows.length) { el.innerHTML = '<div class="muted">אין בקשות עדיין</div>'; return; }
    const st = { draft: '<span class="pill">טיוטה</span>', issued: '<span class="pill green">הופק</span>', cancelled: '<span class="pill">בוטל</span>', error: '<span class="pill red">שגיאה</span>' };
    el.innerHTML = `<div class="table-wrap"><table class="data ic-hist"><tbody>` + rows.map(r => `<tr>
      <td class="muted" style="white-space:nowrap">${heDateTime(r.created_at)}</td>
      <td>${esc((r.raw_text || '').slice(0, 60))}${(r.raw_text || '').length > 60 ? '…' : ''}</td>
      <td>${st[r.status] || esc(r.status)}${r.status === 'error' && r.error_message ? `<div class="muted" style="font-size:.72rem">${esc(r.error_message.slice(0, 80))}</div>` : ''}</td>
      <td dir="ltr">${esc(r.icount_doc_number || '')}</td>
      <td>${r.icount_doc_url ? `<a class="btn btn-sm btn-ghost" href="${esc(r.icount_doc_url)}" target="_blank" rel="noopener">PDF</a>` : ''}</td>
    </tr>`).join('') + `</tbody></table></div>`;
  } catch (e) { el.innerHTML = '<div class="muted">שגיאה בטעינת ההיסטוריה</div>'; }
}

/* ---------- הזרקה לתפריט (בלי לגעת ב-app.js) ---------- */
function invChatInjectNav() {
  const nav = document.getElementById('sideNav');
  if (!nav || !profile) return;
  const existing = document.getElementById('nav-invchat');
  const allowed = ['admin', 'sales'].includes(profile.role) && invoiceChatOn();
  if (!allowed) { existing?.remove(); return; }
  if (existing) return;
  const btn = document.createElement('button');
  btn.id = 'nav-invchat';
  btn.innerHTML = '<span>🧾</span> צ׳אט חשבוניות <span class="badge hidden" id="badge-invchat"></span>';
  btn.onclick = () => openPage('invchat');
  const anchor = document.getElementById('nav-billing') || document.getElementById('nav-finhub');
  if (anchor && anchor.parentElement === nav) anchor.after(btn);
  else nav.appendChild(btn);
}
(function () {
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._invChatWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { invChatInjectNav(); } catch (e) { }
      return r;
    };
    wrapped._invChatWrapped = true;
    window.refreshCache = wrapped;
  }
})();

/* ---------- כרטיס במסך ההגדרות (עטיפת Pages.settings) ---------- */
async function invChatToggleSave(on) {
  await run(db.from('settings').upsert({ key: 'invoice_chat_enabled', value: on ? '1' : '0' }));
  cache.settings.invoice_chat_enabled = on ? '1' : '0';
  invChatInjectNav();
  toast(on ? 'צ׳אט החשבוניות הופעל' : 'צ׳אט החשבוניות כובה');
}
async function invChatVatSave(v) {
  const n = Number(v);
  if (!(n > 0 && n < 100)) { toast('שיעור מע"מ לא תקין', true); return; }
  await run(db.from('settings').upsert({ key: 'vat_rate', value: String(n) }));
  cache.settings.vat_rate = String(n);
  toast('שיעור המע"מ עודכן ל-' + n + '%');
}
async function invChatProbe() {
  const el = document.getElementById('icProbeOut');
  if (el) el.textContent = 'בודק...';
  const [pi, pc] = await Promise.all([
    invChatFn('issue-invoice', { probe: true }),
    invChatFn('parse-invoice-text', { probe: true }),
  ]);
  const icOk = pi.data && pi.data.ok;
  const clOk = pc.data && pc.data.ok;
  let html = (icOk ? '✅ iCount מחובר' : '❌ iCount: ' + esc((pi.data && pi.data.error) || pi.errMsg || 'לא מחובר')) + '<br>' +
    (clOk ? '✅ פענוח (Claude) מחובר' : '❌ פענוח: ' + esc((pc.data && pc.data.error) || pc.errMsg || 'לא מחובר'));
  if (icOk && pi.data.doctypes) {
    try {
      const dt = pi.data.doctypes;
      html += '<div class="muted" style="font-size:.75rem;margin-top:4px">סוגי מסמכים בחשבון: ' +
        esc(Object.entries(dt).slice(0, 12).map(([k, v]) => k + '=' + (typeof v === 'string' ? v : (v && v.name) || '')).join(' · ')) + '</div>';
    } catch (e) { }
  }
  if (el) el.innerHTML = html;
}
(function () {
  const orig = Pages.settings && Pages.settings.render;
  if (orig && !orig._invChatWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try {
        const card = document.createElement('div');
        card.className = 'card card-pad';
        card.innerHTML = `
        <b>צ׳אט חשבוניות (iCount)</b>
        <p class="muted" style="font-size:.82rem">הפקת מסמכים ממשפט חופשי בעברית, עם אישור לפני כל הפקה.
        הסודות (iCount ו-Claude) מוגדרים ב-Supabase → Edge Functions → Secrets, לא כאן.
        להדליק רק במופע שהוגדרו בו סודות iCount.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
          <input type="checkbox" ${invoiceChatOn() ? 'checked' : ''} onchange="invChatToggleSave(this.checked)" style="width:18px;height:18px">
          צ׳אט חשבוניות פעיל (מוסיף "🧾 צ׳אט חשבוניות" לתפריט)
        </label>
        <div class="grid2" style="margin-top:10px">
          <div class="field"><label>שיעור מע"מ (%)</label>
            <input type="number" value="${esc((cache.settings || {}).vat_rate || '18')}" dir="ltr" onchange="invChatVatSave(this.value)"></div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="invChatProbe()">🔌 בדיקת חיבור iCount + פענוח</button>
        <div id="icProbeOut" class="muted" style="font-size:.83rem;margin-top:6px"></div>`;
        const anchor = el.querySelector('#activityLog');
        const anchorCard = anchor ? anchor.closest('.card') : null;
        if (anchorCard) el.insertBefore(card, anchorCard); else el.appendChild(card);
      } catch (e) { console.error('invchat settings card', e); }
      return r;
    };
    wrapped._invChatWrapped = true;
    Pages.settings.render = wrapped;
  }
})();
