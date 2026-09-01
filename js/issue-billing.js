/* ============================================================
issue-billing.js — לולאת מודעה ← חשבונית (צד ניהול)
------------------------------------------------------------
- כפתור "חיוב הגיליון" בפלטפלן → רשימת לקוחות עם מודעות בגיליון
- כפתור נפרד לכל לקוח → תצוגה מקדימה של פירוט המודעות → הפקה
- הפקה דרך EZcount (invCall מ-invoices.js) עם transaction_id ייחודי
  לכל לקוח+גיליון — מונע חיוב כפול
============================================================ */

'use strict';

// תאריכים ניתנים לעריכה בהפקה ממסך החיוב: תאריך המסמך (ברירת מחדל = תאריך הגיליון/יעד הדפוס) + תאריך התשלום
let _ibDates = { doc: '', pay: '' };
let _ibKind = null; // סוג המסמך שנבחר בתצוגה המקדימה (חשבון עסקה / חשבונית מס)

function _ibLabel(t) { return (t || '').trim() === 'כתבות' ? 'מידע לתושב' : (t || 'מודעה'); }
function _ibSize(a) { try { const z = (typeof nameOf === 'function') ? nameOf('priceList', a.price_item_id) : ''; return z || ''; } catch (e) { return ''; } }
function _ibIssueDate(issue) { const d = issue.print_date || issue.publish_date; if (!d) return ''; const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
function _ibItems(ads, issue) {
  const num = issue.issue_number;
  const adLines = ads.map(a => ({
    details: _ibLabel(a.title) + (_ibSize(a) ? ' · ' + _ibSize(a) : '') + (a.page_number ? ' — עמוד ' + a.page_number : ''),
    amount: 1,
    price: Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)),
  })).filter(it => it.price > 0);
  if (!adLines.length) return [];
  // סוג גיליון מיוחד (#21) — מסומן בשורת הכותרת של החשבונית
  const typeTag = (issue.issue_type && issue.issue_type !== 'regular' && typeof ISSUE_TYPE_HE !== 'undefined')
    ? ' (' + (ISSUE_TYPE_HE[issue.issue_type] || issue.issue_type) + ')' : '';
  return [{ details: 'גיליון ' + num + typeTag + ' — ' + _ibIssueDate(issue), amount: 1, price: 0 }, ...adLines];
}
function _ibDocKind(customerId) {
  const c = (cache.customers || []).find(x => x.id === customerId) || {};
  return c.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
}

/* רשימת לקוחות לחיוב בגיליון */
async function issueBillingOpen(issueId) {
  const issue = (cache.issues || []).find(i => i.id === issueId)
    || (await run(db.from('issues').select('*').eq('id', issueId).limit(1)))[0];
  if (!issue) { toast('גיליון לא נמצא', true); return; }
  _ibDates = { doc: '', pay: '' }; // איפוס — כדי שרישום מהיר מהשורה ישתמש בברירת המחדל (היום)
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")'));
  const byCust = {};
  ads.forEach(a => { if (a.customer_id) (byCust[a.customer_id] = byCust[a.customer_id] || []).push(a); });
  const doneSet = new Set();
  try {
    const docs = await run(db.from('documents').select('customer_id,status,transaction_id').ilike('transaction_id', 'emu-iss' + issueId + '-cust%'));
    docs.forEach(d => { if (!['failed', 'cancelled'].includes(d.status)) doneSet.add(d.customer_id); });
  } catch (e) { }
  // סנכרון בין-מסלולי: גם חשבונית שהופקה מכרטיס הלקוח מסמנת את המודעות כ"חשבונית הופקה"/"שולם"
  Object.keys(byCust).forEach(cid => { if (byCust[cid].some(a => ['invoiced', 'paid'].includes(a.deal_stage))) doneSet.add(Number(cid)); });
  // חשבוניות חודשיות שכבר הופקו לחודש של הגיליון — כדי לסמן לקוחות חודשיים כ"הופק" בכל גיליון של אותו חודש
  const monthlyDoneSet = new Set();
  try {
    const _ymEff = ((issue.print_date || issue.publish_date) || '').slice(0, 7);
    if (_ymEff) {
      const mdocs = await run(db.from('documents').select('transaction_id,status').ilike('transaction_id', 'emu-monthly-' + _ymEff + '-cust%'));
      (mdocs || []).forEach(d => { if (['failed', 'cancelled'].includes(d.status)) return; const m = String(d.transaction_id || '').match(/cust(\d+)/); if (m) monthlyDoneSet.add(Number(m[1])); });
    }
  } catch (e) { }
  const rows = Object.keys(byCust).map(Number).map(cid => {
    const cAds = byCust[cid];
    const total = cAds.reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);
    return {
      cid, count: cAds.length, total, done: doneSet.has(cid),
      monthly: (typeof isMonthlyCustomer === 'function' && isMonthlyCustomer(cid)),
      monthlyDone: monthlyDoneSet.has(cid),
      isCenter: (typeof ecIsCenter === 'function' && ecIsCenter(cid)),
      social: (typeof ecCatOfAd === 'function') ? cAds.filter(a => ecCatOfAd(a.id) === 'social').length : 0,
    };
  }).filter(r => r.monthly || r.total > 0)  // לא מציגים לקוחות בסכום ₪0 (מודעות מערכת/חינם) — אין להם חשבונית
    .sort((a, b) => b.total - a.total);

  let monthCloseBtn = '';
  try {
    // חודש נקבע לפי תאריך הסגירה לדפוס (print_date), עם נפילה ל-publish_date
    const _eff = (x) => (x.print_date || x.publish_date) || '';
    const ym = _eff(issue).slice(0, 7);
    if (ym && typeof mbList === 'function' && mbList().length) {
      const all = await run(db.from('issues').select('publish_date,print_date'));
      const monthIss = (all || []).filter(x => _eff(x).slice(0, 7) === ym);
      const isLast = monthIss.every(x => _eff(x) <= _eff(issue));
      if (isLast) monthCloseBtn = `<button class="btn btn-sm" style="background:@@COLOR_BRAND@@;color:#fff" onclick="monthlyBillingReview('${ym}')">🗓️ סוף חודש — חיוב חודשי (אישור אחד-אחד)</button>`;
    }
  } catch (e) { }
  document.getElementById('viewModal').innerHTML = `
    <h3>🧾 חיוב הגיליון — גיליון ${issue.issue_number}</h3>
    <p class="muted" style="font-size:.85rem">כפתור נפרד לכל לקוח · תצוגה מקדימה של הפירוט לפני ההפקה</p>
    ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table class="data">
      <thead><tr><th>לקוח</th><th>מודעות</th><th>סכום (לפני מע"מ)</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><b>${esc(nameOf('customers', r.cid))}</b></td>
        <td>${r.count}</td>
        <td>${money(r.total)}</td>
        <td>${r.isCenter ? `<button class="btn btn-sm" style="background:@@COLOR_BRAND@@;color:#fff" onclick="ecCatsModal(${issueId}, ${r.cid})" title="סיווג כל מודעה: רגיל / חברתי כלכלי">🏷️ קטגוריות${r.social ? ' · ' + r.social + ' חברתי' : ''}</button> ` : ''}${r.monthly
      ? `${r.monthlyDone ? '<span class="pill green" title="החשבונית החודשית של חודש זה כבר הופקה">🧾 חשבונית חודשית הופקה ✓</span>' : '<span class="pill amber">חיוב חודשי</span>'} <button class="btn btn-sm btn-ghost" onclick="issueBillingSetMonthly(${issueId}, ${r.cid})">בטל חודשי</button>`
      : `${r.done ? '<span class="pill green">חויב ✓</span>' : `<button class="btn btn-sm" onclick="issueBillingPreview(${issueId}, ${r.cid})">תצוגה והפקה</button> <button class="btn btn-sm btn-ghost" style="color:var(--ok)" onclick="issueBillingPaidMenu(${issueId}, ${r.cid})" title="שולם — ללא חשבונית או חשבונית מס קבלה">💰 שולם</button> <button class="btn btn-sm btn-ghost" onclick="issueBillingMarkInvoiced(${issueId}, ${r.cid})" title="סמן שחשבונית כבר הופקה — בלי להפיק ובלי לרשום חוב">🧾 סמן הופקה</button>`} <button class="btn btn-sm btn-ghost" onclick="issueBillingSetMonthly(${issueId}, ${r.cid})">🔁 חודשי</button>`}
          <button class="btn btn-sm btn-ghost" onclick="issueSendClip(${issueId}, ${r.cid})">📎 גזיר</button> <button class="btn btn-sm btn-ghost" onclick="adProofOpen(${issueId}, ${r.cid})">🖼️ הוכחת פרסום</button></td>
      </tr>`).join('')}
    </tbody></table></div>` : '<p class="empty" style="margin-top:10px">אין מודעות בגיליון זה לחיוב</p>'}
    <div class="m-actions" style="margin-top:12px;flex-wrap:wrap">
      ${monthCloseBtn}
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* תצוגה מקדימה של החשבונית ללקוח */
async function issueBillingPreview(issueId, customerId) {
  const issue = (cache.issues || []).find(i => i.id === issueId);
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")'));
  const items = _ibItems(ads, issue);
  if (!items.length) { toast('אין מודעות עם מחיר לחיוב', true); return; }
  const total = items.reduce((s, it) => s + it.amount * it.price, 0);
  const docKind = _ibDocKind(customerId);
  _ibKind = docKind; // ברירת מחדל לסוג המסמך לפי הלקוח
  // ברירות מחדל לתאריכים: תאריך המסמך = תאריך הגיליון (יעד הדפוס), תאריך התשלום = היום
  _ibDates = { doc: (issue.print_date || issue.publish_date || today()).slice(0, 10), pay: today() };
  document.getElementById('viewModal').innerHTML = `
    <h3>תצוגה מקדימה — ${esc(nameOf('customers', customerId))}</h3>
    <p class="muted" style="font-size:.85rem">גיליון ${issue.issue_number}</p>
    <div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>פירוט</th><th>כמות</th><th>מחיר</th></tr></thead><tbody>
      ${items.map(it => `<tr><td>${esc(it.details)}</td><td>${it.amount}</td><td>${money(it.price)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="inv-total" style="margin-top:10px;font-weight:800">סה"כ (לפני מע"מ): ${money(total)}</div>
    <div class="field" style="margin-top:12px"><label>סוג מסמך</label>
      <select onchange="_ibKind=this.value">
        <option value="proforma" ${docKind === 'proforma' ? 'selected' : ''}>חשבון עסקה</option>
        <option value="tax_invoice" ${docKind === 'tax_invoice' ? 'selected' : ''}>חשבונית מס</option>
      </select></div>
    <div class="grid2" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="field"><label>תאריך המסמך</label>
        <input type="date" value="${_ibDates.doc}" onchange="_ibDates.doc=this.value"></div>
      <div class="field"><label>תאריך התשלום</label>
        <input type="date" value="${_ibDates.pay}" onchange="_ibDates.pay=this.value"></div>
    </div>
    <p class="muted" style="font-size:.78rem;margin:4px 0 0">תאריך המסמך חל על החשבונית ועל רישום החוב · תאריך התשלום חל על "שולם".</p>
    <div class="m-actions" style="margin-top:12px">
      <button class="btn" onclick="issueBillingIssue(${issueId}, ${customerId})">הפק ושלח ←</button>
      <button class="btn btn-ghost" onclick="issueBillingPaidMenu(${issueId}, ${customerId})">💰 שולם</button>
      <button class="btn btn-ghost" onclick="issueBillingOpen(${issueId})">→ חזרה לרשימה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* הפקה בפועל */
async function issueBillingIssue(issueId, customerId) {
  const issue = (cache.issues || []).find(i => i.id === issueId);
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")'));
  const items = _ibItems(ads, issue);
  if (!items.length) { toast('אין מה לחייב', true); return; }
  const docKind = _ibKind || _ibDocKind(customerId);
  document.getElementById('viewBack').classList.remove('open');
  await invCall({
    customer_id: customerId,
    doc_kind: docKind,
    items,
    vat_included: false,
    doc_date: _ibDates.doc || null, // תאריך המסמך שנבחר (ברירת מחדל = תאריך הגיליון)
    transaction_id: 'emu-iss' + issueId + '-cust' + customerId + '-' + docKind,
    comment: 'גיליון ' + issue.issue_number,
    ad_ids: ads.map(a => a.id),
  });
}

/* רישום כשולם — בלי הפקת חשבונית ב-EZcount (מזומן / שולם במקום אחר) */
async function issueBillingMarkPaid(issueId, customerId) {
  const issue = (cache.issues || []).find(i => i.id === issueId)
    || (await run(db.from('issues').select('*').eq('id', issueId).limit(1)))[0];
  if (!issue) { toast('גיליון לא נמצא', true); return; }
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")'));
  const total = ads.reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);
  if (!(total > 0)) { toast('אין סכום לרישום', true); return; }
  if (!confirm('לרשום את התשלום של ' + nameOf('customers', customerId) + ' לגיליון ' + issue.issue_number + ' (' + money(total) + ') כ"שולם" — בלי להפיק חשבונית ב-EZcount?')) return;
  const tag = '#iss' + issueId + '-cust' + customerId;
  try {
    const cust = (cache.customers || []).find(x => x.id === customerId) || {};
    const pd = (_ibDates && _ibDates.pay) || today(); // תאריך התשלום שנבחר בתצוגה המקדימה
    const dup = (await db.from('charges').select('id').eq('customer_id', customerId).ilike('notes', '%' + tag + '%').limit(1)).data;
    if (dup && dup.length) {
      toast('כבר קיים רישום תשלום לגיליון זה');
    } else {
      const ins = await run(db.from('charges').insert({
        customer_id: customerId, amount: total, description: 'גיליון ' + issue.issue_number + ' — שולם ללא חשבונית',
        issued_date: pd, due_date: pd, status: 'paid', invoice_number: null,
        agent_id: cust.agent_id || null, notes: 'שולם ללא חשבונית — גיליון ' + issue.issue_number + ' ' + tag,
      }).select('id').single());
      const method = (typeof _icPayMethod === 'function') ? _icPayMethod() : 'cash';
      await db.from('payments').insert({
        charge_id: ins.id, customer_id: customerId, amount: total, method: method,
        paid_date: pd, notes: 'שולם ללא חשבונית — גיליון ' + issue.issue_number + ' ' + tag,
        created_by: (typeof profile !== 'undefined' ? profile.id : null),
      });
    }
    await db.from('ads').update({ deal_stage: 'paid' }).in('id', ads.map(a => a.id));
    try { await addInteraction('customer', customerId, '✓ גיליון ' + issue.issue_number + ' — סומן שולם (ללא חשבונית, ' + money(total) + ')'); } catch (e) { }
    toast('✓ נרשם כשולם ללא חשבונית — ' + money(total));
    issueBillingOpen(issueId);
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

/* סימון ידני: "חשבונית הופקה" — בלי להפיק חשבונית וללא רישום חוב.
   שימושי כשהחשבונית הופקה מחוץ למסלול חיוב-הגיליון. השורה תעבור ל"חויב ✓". */
async function issueBillingMarkInvoiced(issueId, customerId) {
  const issue = (cache.issues || []).find(i => i.id === issueId)
    || (await run(db.from('issues').select('*').eq('id', issueId).limit(1)))[0];
  if (!issue) { toast('גיליון לא נמצא', true); return; }
  const ads = await run(db.from('ads').select('id').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")'));
  if (!ads.length) { toast('אין מודעות', true); return; }
  if (!confirm('לסמן שחשבונית כבר הופקה ל' + nameOf('customers', customerId) + ' לגיליון ' + issue.issue_number + '?\n(סימון בלבד — לא מפיק חשבונית ולא רושם חוב)')) return;
  try {
    await db.from('ads').update({ deal_stage: 'invoiced' }).in('id', ads.map(a => a.id)).or('deal_stage.is.null,deal_stage.neq.paid');
    try { await addInteraction('customer', customerId, '🟣 גיליון ' + issue.issue_number + ' — סומן ידנית: חשבונית הופקה'); } catch (e) { }
    toast('✓ סומן: חשבונית הופקה');
    issueBillingOpen(issueId);
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

/* תפריט "שולם" — בחירה בין רישום ללא חשבונית לבין הפקת חשבונית מס קבלה */
function issueBillingPaidMenu(issueId, customerId) {
  document.getElementById('sbOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'sbOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;padding:18px;max-width:420px;width:90%;direction:rtl">
    <h3 style="margin:0 0 4px">💰 שולם — ${esc(nameOf('customers', customerId))}</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 14px">איך לרשום את התשלום?</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn" onclick="document.getElementById('sbOv').remove(); issueBillingReceipt(${issueId}, ${customerId})">🧾 הפק חשבונית מס קבלה</button>
      <button class="btn btn-ghost" onclick="document.getElementById('sbOv').remove(); issueBillingMarkPaid(${issueId}, ${customerId})">✓ שולם ללא חשבונית</button>
      <button class="btn btn-ghost" onclick="document.getElementById('sbOv').remove()">ביטול</button>
    </div></div>`;
  document.body.appendChild(ov);
}

/* הפקת חשבונית מס קבלה לגיליון — פותח את מודל התשלום עם שורות הגיליון */
async function issueBillingReceipt(issueId, customerId) {
  const issue = (cache.issues || []).find(i => i.id === issueId) || (await run(db.from('issues').select('*').eq('id', issueId).limit(1)))[0];
  if (!issue) { toast('גיליון לא נמצא', true); return; }
  const ads = await run(db.from('ads').select('*').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")'));
  const items = _ibItems(ads, issue);
  if (!items.length) { toast('אין מודעות עם מחיר לחיוב', true); return; }
  const cust = (cache.customers || []).find(c => c.id === customerId) || (await run(db.from('customers').select('*').eq('id', customerId).limit(1)))[0];
  if (!cust) { toast('לקוח לא נמצא', true); return; }
  document.getElementById('viewBack')?.classList.remove('open');
  if (typeof invOpenModal === 'function') {
    await invOpenModal(cust, 'invoice_receipt', true, { lines: items, issueId });
  } else { toast('מודל החשבונית לא זמין', true); }
}

/* שליחת גזיר (עמוד המודעה מה-PDF) במייל ללקוח */
async function issueSendClip(issueId, customerId) {
  toast('שולח גזיר במייל...');
  try {
    const { data, error } = await db.functions.invoke('send-clip', { body: { customer_id: customerId, issue_id: issueId } });
    if (!error && data && data.ok) {
      toast('✅ הגזיר נשלח במייל ל' + (data.email || 'לקוח') + ' (עמוד ' + (data.pages || []).join(', ') + ')');
      return;
    }
    // שליחה אוטומטית לא זמינה / נכשלה → מפיקים את הגזיר להורדה ושליחה ידנית
    let msg = '';
    try { if (error && error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || ''; } } catch (e) { }
    if (!msg && data) msg = data.detail || data.error || '';
    toast('שליחה אוטומטית במייל עדיין לא פעילה — מפיק לך את הגזיר לשליחה ידנית' + (msg ? ' (' + msg + ')' : ''), true);
    if (typeof adProofOpen === 'function') adProofOpen(issueId, customerId);
  } catch (e) {
    toast('שליחה אוטומטית נכשלה — מפיק לך את הגזיר לשליחה ידנית', true);
    if (typeof adProofOpen === 'function') adProofOpen(issueId, customerId);
  }
}

/* עטיפת openFlatplan — הזרקת כפתור "חיוב הגיליון" */
(function () {
  const orig = window.openFlatplan;
  if (typeof orig === 'function' && !orig._ibWrapped) {
    const wrapped = async function (issueId) {
      const r = await orig.apply(this, arguments);
      try {
        if (typeof invoicesOn === 'function' && invoicesOn() && ['admin', 'sales'].includes(profile.role)) {
          const menu = document.getElementById('fpMenuMoney');
          const target = menu || document.querySelector('.page-head .actions');
          if (target && !document.getElementById('ibBtn')) {
            const b = document.createElement('button');
            b.id = 'ibBtn'; b.className = menu ? 'btn' : 'btn btn-sm';
            b.textContent = '🧾 חיוב הגיליון';
            b.addEventListener('click', () => { if (typeof ccMenuClose === 'function') ccMenuClose(); issueBillingOpen(issueId); });
            target.insertBefore(b, target.firstChild);
          }
        }
      } catch (e) { console.error('issue-billing', e); }
      return r;
    };
    wrapped._ibWrapped = true;
    window.openFlatplan = wrapped;
  }
})();

/* ===== מיילים לפי קטגוריה (מרכז קהילתי) — נוסף ע"י Claude ===== */
const EC_EMAIL_KEY = { regular: 'emanuel_center_email_regular', social: 'emanuel_center_email_social' };
function ecEmailOf(cat){ return (((cache.settings||{})[EC_EMAIL_KEY[cat]]) || '').trim(); }
async function ecSetEmail(cat, val){
  const k = EC_EMAIL_KEY[cat]; const v = (val||'').trim();
  await db.from('settings').upsert({ key: k, value: v }, { onConflict: 'key' });
  if (cache.settings) cache.settings[k] = v;
}
const EC_EMAIL_FIELDS = [
  { type:'section', label:'מיילים לפי קטגוריה' },
  { name:'email_regular', label:'מייל קטגוריה כללית (רגיל)' },
  { name:'email_social',  label:'מייל קטגוריה חברתית כלכלית' },
];
function ecEmailsModal(cid){
  const rec = { email_regular: ecEmailOf('regular'), email_social: ecEmailOf('social') };
  openForm('מיילים לפי קטגוריה — מרכז קהילתי', EC_EMAIL_FIELDS, rec, async (r)=>{
    await ecSetEmail('regular', r.email_regular);
    await ecSetEmail('social',  r.email_social);
    toast('נשמר ✔');
    if (typeof openCustomerCard==='function') openCustomerCard(cid);
  });
}
