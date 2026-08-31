/* ============================================================
invoice-chat.js — צ'אט הפקת חשבוניות ממלל חופשי (EZcount)
------------------------------------------------------------
- כותבים משפט חופשי → פענוח (Edge: parse-invoice-text, Claude בצד השרת)
- התאמת לקוח fuzzy (Edge: match-customer) — לעולם לא מנחשים
- כרטיס תצוגה מקדימה עם עריכה inline וחישוב חי של מע"מ וסה"כ
- הפקה ב-EZcount (Edge: ezcount-doc) רק אחרי [אשר והפק]
- כל בקשה נרשמת בטבלת invoice_requests (draft/issued/cancelled/error)
- מאחורי דגל: settings.invoice_chat_enabled ('0' כברירת מחדל) —
  מדליקים רק במופע שמוגדרים בו סודות EZcount. מוזרק לתפריט ולהגדרות
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
  _icState = { reqId: null, rawText: '', fields: null, pending: null, candidates: [], confidence: 'high', busy: false, mode: 'issue', pay: null, openProformas: [], payDate: null, deal: null };
}

/* ---------- הדף ---------- */
Pages.invchat = {
  title: 'צ׳אט חשבוניות',
  render: async (el) => {
    invChatEnsureStyles();
    icResetState();
    if (!invoiceChatOn()) {
      el.innerHTML = `<div class="empty">צ׳אט החשבוניות כבוי במופע הזה.<br>מנהל יכול להדליק אותו במסך הגדרות ← "צ׳אט חשבוניות (EZcount)".</div>`;
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
    _icState.mode = ['pay_existing', 'new_deal'].includes(parsed.action) ? parsed.action : 'issue';
    _icState.deal = (_icState.mode === 'new_deal') ? (parsed.deal || null) : null;
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
  if (_icState.mode === 'new_deal') { invChatStartNewDeal(); return; }
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
    <div id="icCtx-${_icState.reqId}"></div>
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
  if (f.customer_id) invChatCustomerContext(f.customer_id, _icState.reqId);
}

/* פאנל הקשר ללקוח מזוהה בכרטיס הצ'אט: חוב פתוח + חוזים פעילים + שליחה.
   מסתנכרן עם אותן טבלאות של המערכת (charges/payments/contracts/ads). */
async function invChatCustomerContext(customerId, reqId) {
  const box = document.getElementById('icCtx-' + reqId);
  if (!box || !customerId) return;
  try {
    const charges = (await db.from('charges').select('id,amount,description,status')
      .eq('customer_id', customerId).in('status', ['pending', 'invoiced', 'partial', 'overdue'])
      .order('issued_date', { ascending: true })).data || [];
    let openTotal = 0; const openList = [];
    for (const ch of charges) {
      const pays = (await db.from('payments').select('amount').eq('charge_id', ch.id)).data || [];
      const bal = Number(ch.amount) - pays.reduce((s, p) => s + Number(p.amount), 0);
      if (bal > 0.001) { openTotal += bal; openList.push({ desc: ch.description || 'חיוב', bal: Math.round(bal * 100) / 100 }); }
    }
    const contracts = (await db.from('contracts').select('id,price_item_id,total_inserts,used_offset,active')
      .eq('customer_id', customerId).eq('active', true)).data || [];
    const conRows = [];
    for (const ct of contracts) {
      const { count } = await db.from('ads').select('id', { count: 'exact', head: true })
        .eq('contract_id', ct.id).not('status', 'in', '("cancelled","rejected")');
      const used = (count || 0) + (Number(ct.used_offset) || 0);
      conRows.push({ id: ct.id, label: (typeof nameOf === 'function' ? nameOf('priceList', ct.price_item_id) : '') || 'חבילה', used, total: ct.total_inserts || 0 });
    }
    if (!openTotal && !conRows.length) { box.innerHTML = ''; return; }
    const canInv = typeof contractInvoice === 'function';
    const debtHtml = openTotal > 0
      ? `<div style="font-weight:800;color:#b45309">💰 חוב פתוח — ${money(openTotal)} <span style="font-weight:400;color:#8a5a00">(${openList.length})</span></div>
         <div style="font-size:.78rem;color:#8a5a00;margin-top:2px">${openList.slice(0, 4).map(o => '• ' + esc(o.desc) + ' — ' + money(o.bal)).join('<br>')}${openList.length > 4 ? '<br>…' : ''}</div>`
      : '<div class="muted" style="font-size:.8rem">אין חוב פתוח ✓</div>';
    const conHtml = conRows.length
      ? '<div style="margin-top:8px;font-weight:800;color:#1c2438">📦 חוזים פעילים</div>' + conRows.map(c =>
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:.8rem;margin-top:3px">
           <span>${esc(c.label)} — נוצל ${c.used}/${c.total}${(c.total && c.used >= c.total) ? ' <span class="pill red" style="font-size:.66rem">נוצל</span>' : ''}</span>
           ${canInv ? `<button class="btn btn-sm btn-ghost" title="הפק חשבונית מהחוזה" onclick="contractInvoice(${c.id})">🧾 הפק</button>` : ''}
         </div>`).join('')
      : '';
    const sendBtns = `<div class="m-actions" style="flex-wrap:wrap;margin-top:10px;gap:6px">
        ${typeof customerStatement === 'function' ? `<button class="btn btn-sm btn-ghost" onclick="customerStatement(${customerId})" title="דוח חוב / כרטסת להדפסה או PDF">📄 דוח חוב</button>` : ''}
        ${typeof commOpen === 'function' ? `<button class="btn btn-sm btn-ghost" onclick="commOpen(${customerId}, 'whatsapp')" title="שליחת הודעה בוואטסאפ (תזכורת תשלום)">💬 שלח בוואטסאפ</button>` : ''}
      </div>`;
    box.innerHTML = `<div style="border:1px solid #fde68a;background:#fffbeb;border-radius:10px;padding:9px 11px;margin:2px 0 10px">
      ${debtHtml}${conHtml}${sendBtns}</div>`;
  } catch (e) { box.innerHTML = ''; }
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
// מיפוי doc_type של הצ'אט → doc_kind של ezcount-doc (אותו ספק כמו כרטיס הלקוח = EZcount)
const INVCHAT_EZ_DOC_KIND = {
  tax_invoice: 'tax_invoice', tax_invoice_receipt: 'invoice_receipt',
  receipt: 'receipt', credit_invoice: 'credit', proforma: 'proforma',
};
/* בונה גוף בקשה ל-ezcount-doc מתוך שדות הצ'אט — אותו חוזה של מסך החשבוניות (invSubmit) */
function invChatEzcountBody(f) {
  const isPay = (f.doc_type === 'receipt' || f.doc_type === 'tax_invoice_receipt');
  const lines = (f.line_items || []).filter(l => Number(l.unit_price) > 0);
  // מע"מ ברמת המסמך (ezcount-doc מקבל דגל אחד): כלול רק אם כל השורות "כולל מע"מ"
  const vatInc = lines.length ? lines.every(l => !!l.price_includes_vat) : false;
  const pct = invChatVatPct();
  const dstr = (f.doc_date ? String(f.doc_date).slice(0, 10) : today());
  const body = {
    customer_id: f.customer_id || null,
    doc_kind: INVCHAT_EZ_DOC_KIND[f.doc_type] || f.doc_type,
    items: lines.map(l => ({ details: String(l.description || '').trim() || 'פרסום', amount: Number(l.quantity) || 1, price: Number(l.unit_price) || 0 })),
    vat_included: vatInc,
    doc_date: dstr,
  };
  if (!f.customer_id && f.customer_name) body.client_name = String(f.customer_name).trim();
  if (isPay) {
    const base = lines.reduce((s, l) => s + (Number(l.quantity) || 1) * (Number(l.unit_price) || 0), 0);
    // מס-קבלה: אם המחירים "לפני מע"מ" — מגלמים מע"מ כדי שהתשלום יתאים לסה"כ. קבלה: הסכום כפי שנגבה.
    const gross = (vatInc || f.doc_type === 'receipt') ? base : base * (1 + pct / 100);
    body.pay_date = dstr;
    body.payment = { method: f.payment_method || 'cash', sum: Math.round(gross * 100) / 100, date: (typeof _ezDate === 'function' ? _ezDate(dstr) : dstr) };
    if (f.doc_type === 'receipt') delete body.items; // קבלה בלבד — מסמך תשלום ללא פירוט חשבונית
  }
  return body;
}
async function invChatApprove() {
  const f = _icState.fields;
  if (!f.line_items.some(l => Number(l.unit_price) > 0)) { toast('חסר מחיר — השלם לפני הפקה', true); return; }
  if (!f.customer_id && !(f.customer_name && f.customer_name.trim())) { toast('חסר לקוח', true); return; }
  const btn = document.getElementById('icApprove');
  if (btn) { btn.disabled = true; btn.textContent = 'מפיק...'; }
  icSetBusy(true);
  const body = invChatEzcountBody(f);
  const r = await invChatFn('ezcount-doc', body);
  icSetBusy(false);
  const doc = r.data && r.data.document;
  if (r.data && r.data.status === 'pending_allocation') {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והפק'; }
    icSayErr('ממתין למספר הקצאה מרשות המסים — בדוק ב-EZcount והשלם ידנית.');
    return;
  }
  if (r.errMsg || !r.data || !r.data.ok || !doc) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והפק'; }
    if (_icState.reqId) db.from('invoice_requests').update({ status: 'error', error_message: String(r.errMsg || 'שגיאה').slice(0, 300), final_fields: body }).eq('id', _icState.reqId).then(() => { });
    icSayErr('ההפקה נכשלה: ' + esc(r.errMsg || 'שגיאה') +
      '<div class="muted" style="font-size:.78rem;margin-top:4px">שום מסמך לא הופק. אפשר לתקן את הכרטיס ולנסות שוב.</div>');
    return;
  }
  if (_icState.reqId) db.from('invoice_requests').update({ status: 'issued', icount_doc_number: doc.doc_number ? String(doc.doc_number) : null, icount_doc_url: doc.pdf_url || null, final_fields: body, error_message: null }).eq('id', _icState.reqId).then(() => { });
  if (typeof applyInvoiceToLedger === 'function') { try { await applyInvoiceToLedger(body, doc); } catch (e) { console.error('ledger', e); } }
  const t = invChatTotals(f.line_items, invChatVatPct());
  const shownTotal = f.doc_type === 'receipt'
    ? Math.round(f.line_items.reduce((s, l) => s + (Number(l.quantity) || 1) * (Number(l.unit_price) || 0), 0) * 100) / 100
    : t.total;
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  icSayOk('✅ הופק <b>' + (INVCHAT_DOC_HE[f.doc_type] || 'מסמך') + '</b> ללקוח <b>' + esc(f.customer_name || '') + '</b>' +
    (doc.doc_number ? ' · מספר <b dir="ltr">' + esc(String(doc.doc_number)) + '</b>' : '') +
    ' · סה"כ <b>' + money(shownTotal) + '</b>' +
    (doc.pdf_url ? `<div class="ic-choices"><a class="btn btn-sm" href="${esc(doc.pdf_url)}" target="_blank" rel="noopener">📄 פתח PDF</a></div>` : ''));
  icResetState();
  invChatLoadHistory();
  document.getElementById('icInput')?.focus();
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

/* ============================================================
   מצב "עסקת פרסומים ברצף" (new_deal)
   ------------------------------------------------------------
   "תוציא עסקה של 5 פרסומים מגיליון 301, רבע עמוד, 250" →
   כרטיס אישור עם אפשרויות סימון (חוזה / מודעות / השלמת גיליונות /
   חשבון עסקה) — לא חייבים הכול. אחרי אישור: משלים גיליונות חסרים
   (RPC generate_issues), פותח חוזה (contracts), יוצר מודעות (ads)
   פר גיליון, ומפיק חשבון עסקה דרך ezcount-doc (אחרון — כדי שלא ייווצר
   מסמך כספי אם ההקמה נכשלה). מבנה הרשומות זהה ל-issue-entry.js.
   ============================================================ */
function _icNorm(s) { return String(s || '').replace(/["'`״׳.\-]/g, '').replace(/\s+/g, '').trim(); }
/* התאמת גודל חופשי ("רבע עמוד") לפריט מחירון */
function invChatMatchSize(raw) {
  const list = cache.priceList || [];
  if (!list.length) return null;
  if (!raw) return null;
  const q = _icNorm(raw);
  let hit = list.find(p => _icNorm(p.name) === q);
  if (!hit) hit = list.find(p => { const n = _icNorm(p.name); return n.includes(q) || q.includes(n); });
  return hit || null;
}
/* מיפוי מספרי גיליון לרשומות קיימות ב-cache */
function invChatMapIssues(nums) {
  const byNum = {};
  (cache.issues || []).forEach(i => { byNum[Number(i.issue_number)] = i; });
  const existing = [], missing = [];
  nums.forEach(n => { if (byNum[n]) existing.push({ num: n, id: byNum[n].id }); else missing.push(n); });
  const maxExisting = Math.max(0, ...(cache.issues || []).map(i => Number(i.issue_number) || 0));
  return { existing, missing, maxExisting, byNum };
}
async function invChatStartNewDeal() {
  const f = _icState.fields, d = _icState.deal || {};
  if (!f.customer_id) {
    _icState.pending = 'customer';
    icSay('עסקת פרסומים נפתחת על כרטיס לקוח קיים. כתוב את שם הלקוח:');
    document.getElementById('icInput')?.focus();
    return;
  }
  // גודל + מחיר ברירת מחדל מהמחירון
  const sizeHit = invChatMatchSize(d.size_raw);
  _icState.deal = {
    count: Number(d.count) || 0,
    start_issue: Number(d.start_issue) || 0,
    unit_price: (Number(d.unit_price) > 0) ? Number(d.unit_price) : (sizeHit ? Number(sizeHit.price) || 0 : 0),
    price_includes_vat: !!d.price_includes_vat,
    size_id: sizeHit ? sizeHit.id : ((cache.priceList || [])[0] ? cache.priceList[0].id : null),
    opts: { contract: true, ads: true, autoIssues: true, proforma: true },
  };
  invChatNewDealCard();
}
function _icDealNums() {
  const d = _icState.deal;
  const n = Math.max(0, Number(d.count) || 0), s = Number(d.start_issue) || 0;
  const out = []; for (let i = 0; i < n && s > 0; i++) out.push(s + i); return out;
}
function invChatNewDealCard() {
  const f = _icState.fields, d = _icState.deal;
  document.getElementById('icCard-' + _icState.reqId)?.remove();
  const pct = invChatVatPct();
  const nums = _icDealNums();
  const map = invChatMapIssues(nums);
  const base = (Number(d.count) || 0) * (Number(d.unit_price) || 0);
  const totalBase = d.price_includes_vat ? Math.round(base / (1 + pct / 100) * 100) / 100 : base;
  const vat = Math.round(totalBase * pct / 100 * 100) / 100;
  const total = Math.round((totalBase + vat) * 100) / 100;
  const sizeOpts = (cache.priceList || []).map(p => `<option value="${p.id}" ${p.id === d.size_id ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('');
  const rangeTxt = nums.length ? (nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '')) : '—';
  const missFuture = map.missing.filter(x => x > map.maxExisting);
  const missPast = map.missing.filter(x => x <= map.maxExisting);
  const warns = [];
  if (d.opts.ads && missFuture.length) warns.push('גיליונות ' + missFuture.join(', ') + ' עדיין לא קיימים — ' + (d.opts.autoIssues ? 'ייווצרו אוטומטית לפי מספור רץ.' : 'סמן "השלמת גיליונות" כדי ליצור אותם, אחרת המודעות עליהם ידולגו.'));
  if (d.opts.ads && missPast.length) warns.push('⚠ גיליונות ' + missPast.join(', ') + ' חסרים ואי אפשר ליצור אותם אוטומטית (הם לפני הגיליון האחרון). המודעות עליהם ידולגו.');
  if (!d.size_id) warns.push('⚠ בחר גודל מהמחירון.');
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'icCard-' + _icState.reqId;
  const cb = (k, label, extra) => `<label style="display:flex;gap:7px;align-items:center;cursor:pointer;font-size:.9rem">
    <input type="checkbox" ${d.opts[k] ? 'checked' : ''} onchange="invChatDealToggle('${k}',this.checked)" style="width:16px;height:16px">${label}${extra || ''}</label>`;
  card.innerHTML = `
    <div class="hd">🧾 עסקת פרסומים ברצף — לאישור</div>
    ${warns.map(w => `<div class="ic-warn">${w}</div>`).join('')}
    <div class="grid2">
      <div class="field"><label>לקוח <span class="ic-src exist">✓ מכרטיס</span></label>
        <input type="text" value="${esc(f.customer_name || '')}" disabled></div>
      <div class="field"><label>גודל (מחירון)</label>
        <select onchange="invChatDealSetSize(this.value)">${sizeOpts}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>מספר פרסומים</label>
        <input type="number" min="1" value="${Number(d.count) || ''}" onchange="invChatDealSet('count',this.value)"></div>
      <div class="field"><label>מגיליון</label>
        <input type="number" min="1" value="${Number(d.start_issue) || ''}" dir="ltr" onchange="invChatDealSet('start_issue',this.value)"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>מחיר לפרסום</label>
        <input type="number" step="any" value="${Number(d.unit_price) || ''}" onchange="invChatDealSet('unit_price',this.value)"></div>
      <div class="field"><label>גיליונות</label>
        <input type="text" value="${esc(rangeTxt)} (${nums.length})" disabled dir="ltr"></div>
    </div>
    <label class="vat" style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" ${d.price_includes_vat ? 'checked' : ''} onchange="invChatDealSet('price_includes_vat',this.checked)" style="width:15px;height:15px">המחיר כולל מע"מ</label>
    <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:6px">
      <div class="muted" style="font-size:.8rem">מה להקים (אפשר לבחור):</div>
      ${cb('contract', 'חוזה/עסקה (' + (Number(d.count) || 0) + ' פרסומים)')}
      ${cb('ads', 'מודעות פר גיליון (' + nums.length + ')')}
      ${cb('autoIssues', 'השלמת גיליונות חסרים אוטומטית')}
      ${cb('proforma', 'חשבון עסקה (על כל החבילה)')}
    </div>
    <div class="ic-sum">
      <div class="row"><span>לפני מע"מ</span><span>${money(totalBase)}</span></div>
      <div class="row"><span>מע"מ ${pct}%</span><span>${money(vat)}</span></div>
      <div class="row tot"><span>סה"כ חשבון עסקה</span><span>${money(total)}</span></div>
    </div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="icApprove" onclick="invChatNewDealApprove()">✅ אשר והקם</button>
      <button class="btn btn-ghost" onclick="invChatCancel()">בטל</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function invChatDealSet(k, v) {
  const d = _icState.deal;
  if (k === 'price_includes_vat') d.price_includes_vat = !!v;
  else if (k === 'count' || k === 'start_issue') d[k] = Math.max(0, Math.floor(Number(v) || 0));
  else if (k === 'unit_price') d.unit_price = Math.max(0, Number(v) || 0);
  invChatNewDealCard();
}
function invChatDealSetSize(id) {
  const d = _icState.deal; d.size_id = Number(id) || null;
  const it = (cache.priceList || []).find(p => p.id === d.size_id);
  if (it && !(Number(d.unit_price) > 0)) d.unit_price = Number(it.price) || 0;
  invChatNewDealCard();
}
function invChatDealToggle(k, on) { _icState.deal.opts[k] = !!on; invChatNewDealCard(); }
async function invChatNewDealApprove() {
  const f = _icState.fields, d = _icState.deal;
  const nums = _icDealNums();
  if (!nums.length) { toast('חסר מספר פרסומים / גיליון התחלה', true); return; }
  if ((d.opts.contract || d.opts.ads || d.opts.proforma) && !(Number(d.unit_price) > 0)) { toast('חסר מחיר לפרסום', true); return; }
  if ((d.opts.contract || d.opts.ads) && !d.size_id) { toast('בחר גודל מהמחירון', true); return; }
  const btn = document.getElementById('icApprove');
  if (btn) { btn.disabled = true; btn.textContent = 'מקים...'; }
  icSetBusy(true);
  const done = [];
  try {
    // ----- שלב 1: השלמת גיליונות חסרים (רק אם יוצרים מודעות) -----
    let issueMap = invChatMapIssues(nums);
    if (d.opts.ads && d.opts.autoIssues) {
      const missFuture = issueMap.missing.filter(x => x > issueMap.maxExisting);
      if (missFuture.length) {
        const weeks = Math.min(52, Math.max(...missFuture) - issueMap.maxExisting);
        try {
          const before = new Set((cache.issues || []).map(i => i.id));
          await run(db.rpc('generate_issues', { p_weeks: weeks }), 'שגיאה ביצירת גיליונות');
          try {
            const dpc = Number((cache.settings || {}).default_pages_count) || 40;
            const { data: allI } = await db.from('issues').select('id');
            const newIds = (allI || []).map(i => i.id).filter(id => !before.has(id));
            if (newIds.length) await db.from('issues').update({ pages_count: dpc }).in('id', newIds);
          } catch (e) { }
          if (typeof refreshCache === 'function') await refreshCache();
          issueMap = invChatMapIssues(nums);
          done.push('נוצרו גיליונות עד ' + Math.max(...nums));
        } catch (e) { icSayErr('לא הצלחתי ליצור גיליונות (' + esc(String(e && e.message || e)) + '). ' + (done.length ? 'הוקמו: ' + done.join(', ') : 'לא הוקם דבר') + '.'); if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והקם'; } return; }
      }
    }
    // ----- שלב 2: חוזה (לא נוצר שוב אם כבר הוקם בניסיון קודם) -----
    const c = _customerRow(f.customer_id);
    let contractId = d._contractId || null;
    if (d.opts.contract && !contractId) {
      const row = await run(db.from('contracts').insert({
        customer_id: f.customer_id, agent_id: (c && c.agent_id) || null,
        price_item_id: d.size_id, total_inserts: Number(d.count) || nums.length,
        total_price: (Number(d.unit_price) || 0) * (Number(d.count) || nums.length),
        active: true, cadence: 'every', start_date: today(), created_by: profile.id,
        notes: 'נפתחה מצ׳אט החשבוניות',
      }).select().single(), 'שגיאה בפתיחת חוזה');
      contractId = row.id; d._contractId = contractId;
      done.push('חוזה #' + contractId);
    }
    // ----- שלב 3: מודעות פר גיליון (לא נוצרות שוב אם כבר הוקמו) -----
    if (d.opts.ads && !d._adsDone) {
      const targets = issueMap.existing; // רק גיליונות שקיימים בפועל
      const missingSkipped = nums.length - targets.length; // גיליונות שלא קיימים בכלל
      let made = 0, failed = 0;
      for (const t of targets) {
        const price = Number(d.unit_price) || 0;
        const rec = {
          customer_id: f.customer_id, title: (c && c.name) || f.customer_name || 'לקוח',
          price_item_id: d.size_id, price: price,
          discount: (typeof custFixedDiscountAmount === 'function' ? (custFixedDiscountAmount(f.customer_id, price) || 0) : 0),
          agent_id: (c && c.agent_id) || null, requested_placement: null,
          issue_id: t.id, page_number: null, status: 'committee',
          graphics_note: null, deal_stage: 'in_progress', contract_id: contractId, created_by: profile.id,
        };
        try { await db.from('ads').insert(rec).select('id').single().then(r => { if (r.error) throw r.error; }); made++; }
        catch (e1) {
          if (String(e1.message || e1).includes('deal_stage')) {
            const r2 = { ...rec }; delete r2.deal_stage;
            try { await db.from('ads').insert(r2).select('id').single().then(r => { if (r.error) throw r.error; }); made++; }
            catch (e2) { failed++; console.error('ad insert failed', e2); }
          } else { failed++; console.error('ad insert failed', e1); }
        }
      }
      if (made > 0) d._adsDone = true; // ננעל רק אחרי שנוצרה לפחות מודעה אחת — מונע כפילויות בלחיצה חוזרת
      done.push(made + ' מודעות' +
        (missingSkipped > 0 ? ' (' + missingSkipped + ' דולגו — גיליון חסר)' : '') +
        (failed > 0 ? ' (⚠ ' + failed + ' נכשלו — אפשר להוסיף ידנית)' : ''));
    }
    // ----- שלב 4: חשבון עסקה (אחרון — מסמך כספי) -----
    let docNum = null, pdfUrl = null;
    if (d.opts.proforma) {
      const sizeName = (cache.priceList || []).find(p => p.id === d.size_id);
      const label = 'פרסום' + (sizeName ? ' ' + sizeName.name : '') + ' — גיליונות ' + (nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '')) + ' (' + (Number(d.count) || nums.length) + ' פרסומים)';
      const body = {
        customer_id: f.customer_id, doc_kind: 'proforma',
        items: [{ details: label, amount: Number(d.count) || nums.length, price: Number(d.unit_price) || 0 }],
        vat_included: !!d.price_includes_vat, doc_date: today(),
        comment: 'גיליון ' + (nums[0] + (nums.length > 1 ? '-' + nums[nums.length - 1] : '')),
      };
      const r = await invChatFn('ezcount-doc', body);
      const doc = r.data && r.data.document;
      if (r.errMsg || !r.data || !r.data.ok || !doc) {
        if (_icState.reqId) db.from('invoice_requests').update({ status: 'error', error_message: String(r.errMsg || 'שגיאה').slice(0, 300), final_fields: body }).eq('id', _icState.reqId).then(() => { });
        icSayErr('הוקמו: ' + (done.join(', ') || '—') + '. אבל הפקת חשבון העסקה נכשלה: ' + esc(r.errMsg || 'שגיאה') + ' (החוזה/המודעות כבר נוצרו ולא ייווצרו שוב — לחיצה נוספת על "אשר והקם" תנסה להפיק רק את חשבון העסקה; לחלופין אפשר להפיק אותו ידנית מכרטיס הלקוח).');
        if (btn) { btn.disabled = false; btn.textContent = '🔁 נסה שוב חשבון עסקה'; }
        return;
      }
      docNum = doc.doc_number; pdfUrl = doc.pdf_url;
      if (_icState.reqId) db.from('invoice_requests').update({ status: 'issued', icount_doc_number: docNum ? String(docNum) : null, icount_doc_url: pdfUrl || null, final_fields: body, error_message: null }).eq('id', _icState.reqId).then(() => { });
      if (typeof applyInvoiceToLedger === 'function') { try { await applyInvoiceToLedger(body, doc); } catch (e) { console.error('ledger', e); } }
      done.push('חשבון עסקה' + (docNum ? ' #' + docNum : ''));
    }
    // רישום בציר הזמן של הלקוח (כמו בהזנת גיליון) — לא קריטי
    if (typeof addInteraction === 'function') {
      const szName = (cache.priceList || []).find(p => p.id === d.size_id);
      try { await addInteraction('customer', f.customer_id, 'עסקת פרסומים מהצ׳אט: ' + (szName ? szName.name + ' × ' : '') + (Number(d.count) || nums.length) + ' פרסומים · גיליונות ' + (nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '')) + (docNum ? ' · חשבון עסקה #' + docNum : '')); } catch (e) { }
    }
    if (typeof refreshCache === 'function') { try { await refreshCache(); } catch (e) { } }
    document.getElementById('icCard-' + _icState.reqId)?.remove();
    icSayOk('✅ הוקם ל<b>' + esc(f.customer_name || '') + '</b>: ' + done.map(x => '<b>' + esc(x) + '</b>').join(' · ') +
      (pdfUrl ? `<div class="ic-choices"><a class="btn btn-sm" href="${esc(pdfUrl)}" target="_blank" rel="noopener">📄 פתח PDF</a></div>` : ''));
    icResetState();
    invChatLoadHistory();
    document.getElementById('icInput')?.focus();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר והקם'; }
    icSayErr('שגיאה בהקמת העסקה: ' + esc(String(e && e.message || e)) + (done.length ? ' · הוקם עד כה: ' + esc(done.join(', ')) : '') + '. חשבון העסקה לא הופק.');
  } finally {
    icSetBusy(false);
  }
}
/* שליפת רשומת לקוח מה-cache (לשם/סוכן) */
function _customerRow(id) {
  return (cache.customers || []).find(x => x.id === id) || null;
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
    invChatFn('ezcount-doc', { probe: true }),
    invChatFn('parse-invoice-text', { probe: true }),
  ]);
  const icOk = pi.data && (pi.data.ok || pi.data.authOk);
  const clOk = pc.data && pc.data.ok;
  let html = (icOk ? '✅ EZcount מחובר' : '❌ EZcount: ' + esc((pi.data && pi.data.error) || pi.errMsg || 'לא מחובר')) + '<br>' +
    (clOk ? '✅ פענוח (Claude) מחובר' : '❌ פענוח: ' + esc((pc.data && pc.data.error) || pc.errMsg || 'לא מחובר'));
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
        <b>צ׳אט חשבוניות (EZcount)</b>
        <p class="muted" style="font-size:.82rem">הפקת מסמכים ממשפט חופשי בעברית, עם אישור לפני כל הפקה.
        ההפקה עוברת דרך אותו ספק חיוב של כרטיס הלקוח (EZcount). סוד ה-Claude (ANTHROPIC_API_KEY)
        מוגדר ב-Supabase → Edge Functions → Secrets.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
          <input type="checkbox" ${invoiceChatOn() ? 'checked' : ''} onchange="invChatToggleSave(this.checked)" style="width:18px;height:18px">
          צ׳אט חשבוניות פעיל (מוסיף "🧾 צ׳אט חשבוניות" לתפריט)
        </label>
        <div class="grid2" style="margin-top:10px">
          <div class="field"><label>שיעור מע"מ (%)</label>
            <input type="number" value="${esc((cache.settings || {}).vat_rate || '18')}" dir="ltr" onchange="invChatVatSave(this.value)"></div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="invChatProbe()">🔌 בדיקת חיבור EZcount + פענוח</button>
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
