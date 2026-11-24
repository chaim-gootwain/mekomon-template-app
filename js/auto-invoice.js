/* ============================================================
auto-invoice.js — שליחת חשבוניות אוטומטית ללקוח
------------------------------------------------------------
- מתג אופציונלי בכרטיס הלקוח (מנהל בלבד) — settings.auto_invoice_customers
  (רשימת מזהי לקוחות). אי אפשר להדליק ללקוח בלי מייל בכרטיס.
- הטריגר: "סיום ושמירה" באשף "אמת מול מודפס" של גיליון.
  · לקוח רגיל — חשבונית על המודעות של הגיליון שעוד לא חויבו, מיד.
  · לקוח בחיוב חודשי — חשבונית חודשית אחת, רק כשהגיליון שאומת הוא
    האחרון של החודש (לפי תאריך ההורדה לדפוס).
- סוג המסמך לפי הכרטיס (חשבון עסקה / חשבונית מס), תאריך המסמך = תאריך
  ההורדה לדפוס (בחודשי: סוף החודש, כמו בחיוב החודשי הידני), כולל קישור
  לתשלום באשראי על סכום החשבונית.
- מניעת כפילות: אותו transaction_id של "חיוב הגיליון"/"חיוב חודשי" הידני,
  ורק מודעות שעוד לא סומנו "חשבונית הופקה"/"שולם". אימות חוזר של אותו
  גיליון לא מפיק שוב.
- בסוף: סיכום למנהל בחלון הסיום של האימות + תיעוד בכרטיס כל לקוח.
- מה שלא הסתדר (דולג / נכשל / המייל לא יצא) נשמר כפריט פתוח עד שמטופל
  (settings.auto_invoice_pending) — מוצג בכרטיס הלקוח, ובמופע עם שרת תזמון
  נשלח עליו מייל יומי למנהל.
============================================================ */

'use strict';

const AI_KEY = 'auto_invoice_customers';
function aiAutoList() { try { return JSON.parse((cache.settings || {})[AI_KEY] || '[]').map(Number); } catch (e) { return []; } }
function isAutoInvoiceCustomer(id) { return aiAutoList().includes(Number(id)); }
function _aiEmailOk(em) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(em || '').trim()); }
function _aiNet(a) { return Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)); }
function _aiOpen(a) { return _aiNet(a) > 0 && !['invoiced', 'paid'].includes(a.deal_stage); }

async function toggleAutoInvoice(id) {
  id = Number(id);
  if (typeof profile === 'undefined' || profile.role !== 'admin') { toast('רק מנהל יכול לשנות הגדרה זו', true); return; }
  const arr = aiAutoList(); const i = arr.indexOf(id);
  if (i < 0) {
    // הדלקה — רק עם מייל תקין בכרטיס (נבדק מול המסד, לא רק מהזיכרון)
    let em = ((cache.customers || []).find(c => c.id === id) || {}).email;
    try { const { data } = await db.from('customers').select('email').eq('id', id).maybeSingle(); if (data) em = data.email; } catch (e) { }
    if (!_aiEmailOk(em)) { toast('ללקוח אין מייל תקין בכרטיס — עדכן מייל ואז הפעל שליחה אוטומטית', true); return; }
    arr.push(id);
  } else arr.splice(i, 1);
  const v = JSON.stringify(arr);
  try {
    await run(db.from('settings').upsert({ key: AI_KEY, value: v }, { onConflict: 'key' }));
    if (cache.settings) cache.settings[AI_KEY] = v;
    toast(arr.includes(id) ? '⚡ שליחת חשבוניות אוטומטית הופעלה' : 'שליחת חשבוניות אוטומטית בוטלה');
    try { await addInteraction('customer', id, arr.includes(id) ? '⚡ הופעלה שליחת חשבוניות אוטומטית' : 'בוטלה שליחת חשבוניות אוטומטית'); } catch (e) { }
  } catch (e) { toast('שמירה נכשלה: ' + (e && e.message || e), true); }
  if (typeof openCustomerCard === 'function') openCustomerCard(id);
}

/* שליחת המסמך במייל ללקוח — רק כשהשליחה האוטומטית של EZcount כבויה
   (כשהיא דולקת EZcount כבר שלח את המסמך בעצמו) */
async function _aiEmailDoc(cust, doc, kind, payUrl) {
  if (String((cache.settings || {}).ezcount_autosend || '') === '1') return { ok: true, via: 'ezcount' };
  const label = ((typeof DOC_KIND_HE !== 'undefined' && DOC_KIND_HE[kind]) || 'מסמך') + (doc.doc_number ? ' ' + doc.doc_number : '');
  try {
    const { data, error } = await db.functions.invoke('send-email', { body: {
      to: String(cust.email).trim(), customer_id: cust.id, attach_document_id: doc.id,
      subject: label + ' — @@PAPER_NAME@@',
      body: 'שלום ' + (cust.name || '') + ',\nמצורף ' + label + '.\n' + (payUrl ? 'לתשלום מאובטח באשראי: ' + payUrl + '\n' : '') + 'תודה רבה, @@PAPER_NAME@@ · @@PAPER_PHONE@@',
    } });
    if (error || !data || !data.ok) {
      let m = '';
      try { if (error && error.context && typeof error.context.json === 'function') { const j = await error.context.json(); m = j.detail || j.error || ''; } } catch (e) { }
      return { ok: false, err: m || (data && (data.detail || data.error)) || 'שליחת המייל נכשלה' };
    }
    return { ok: true, via: 'mail' };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
}

async function _aiCustomers(ids) {
  const out = {};
  (cache.customers || []).forEach(c => { if (ids.includes(c.id)) out[c.id] = c; });
  try {
    const { data } = await db.from('customers').select('id,name,email,order_doc_type').in('id', ids);
    (data || []).forEach(c => { out[c.id] = Object.assign({}, out[c.id] || {}, c); });
  } catch (e) { }
  return out;
}

/* ---------- לקוחות לפי גיליון ---------- */
async function _aiRunIssue(issue, custs, res) {
  const ids = Object.keys(custs).map(Number).filter(cid => !(typeof isMonthlyCustomer === 'function' && isMonthlyCustomer(cid)));
  if (!ids.length) return;
  const ads = await run(db.from('ads').select('*').eq('issue_id', issue.id).in('customer_id', ids).not('status', 'in', '("cancelled","rejected")'));
  const byCust = {};
  (ads || []).forEach(a => { (byCust[a.customer_id] = byCust[a.customer_id] || []).push(a); });
  const done = new Set();
  try {
    const docs = await run(db.from('documents').select('customer_id,status,transaction_id').ilike('transaction_id', 'emu-iss' + issue.id + '-cust%'));
    (docs || []).forEach(d => { if (!['failed', 'cancelled'].includes(d.status)) done.add(Number(d.customer_id)); });
  } catch (e) { }
  const docDate = (issue.print_date || issue.publish_date || today()).slice(0, 10);
  for (const cid of Object.keys(byCust).map(Number)) {
    const cust = custs[cid] || { id: cid };
    const name = cust.name || nameOf('customers', cid);
    const open = byCust[cid].filter(_aiOpen);
    if (!open.length) continue; // אין מה לחייב (חינם / כבר חויב / חוזה ששולם מראש)
    const meta = { k: 'iss' + issue.id + '-c' + cid, what: 'גיליון ' + issue.issue_number, ad_ids: open.map(a => a.id) };
    if (done.has(cid)) { res.push({ ...meta, cid, name, st: 'skip', why: 'כבר הופקה חשבונית לגיליון — מודעות פתוחות נשארו לטיפול ידני' }); continue; }
    if (!_aiEmailOk(cust.email)) { res.push({ ...meta, cid, name, st: 'skip', why: 'אין מייל בכרטיס' }); continue; }
    const items = _ibItems(open, issue);
    if (!items.length) continue;
    const docKind = _ibDocKind(cid);
    const total = items.reduce((s, it) => s + it.amount * it.price, 0);
    const data = await invCall({
      customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: docDate,
      transaction_id: 'emu-iss' + issue.id + '-cust' + cid + '-' + docKind,
      comment: 'גיליון ' + issue.issue_number, ad_ids: open.map(a => a.id), pay_link: 'amount',
    }, { stay: true });
    await _aiAfterDoc(cust, name, data, docKind, total, 'גיליון ' + issue.issue_number, res, null, meta);
  }
}

async function _aiAfterDoc(cust, name, data, docKind, total, what, res, mail, meta) {
  meta = meta || {};
  if (!(data && data.ok && data.document)) {
    res.push({ ...meta, cid: cust.id, name, total, st: 'fail', why: (data && (data.error || data.status)) || 'ההפקה נכשלה' });
    return false;
  }
  const doc = data.document;
  const sent = mail || await _aiEmailDoc(cust, doc, docKind, data.pay_url || null);
  res.push({ ...meta, doc_id: doc.id, cid: cust.id, name, st: sent.ok ? 'ok' : 'nomail', num: doc.doc_number || '', total, why: sent.ok ? '' : sent.err });
  try { await addInteraction('customer', cust.id, '⚡ חשבונית אוטומטית (' + what + ') ' + (doc.doc_number || '') + ' — ' + money(total) + (sent.ok ? ' · נשלחה ל-' + cust.email : ' · ⚠ המייל לא נשלח: ' + sent.err)); } catch (e) { }
  return true;
}

/* ---------- לקוחות בחיוב חודשי — רק אחרי אימות הגיליון האחרון של החודש ---------- */
async function _aiMonthEnd(issue) {
  const eff = x => ((x.print_date || x.publish_date) || '').slice(0, 10);
  const d = eff(issue); if (!d) return null;
  const ym = d.slice(0, 7);
  const all = await run(db.from('issues').select('id,issue_number,publish_date,print_date'));
  const monthIss = (all || []).filter(x => eff(x).slice(0, 7) === ym);
  if (!monthIss.every(x => eff(x) <= d)) return null;
  // גיליון השבוע הבא כבר בחודש הבא? (אחרת ייתכן שעוד לא נפתח גיליון מאוחר יותר באותו חודש)
  const nx = new Date(d + 'T12:00:00'); nx.setDate(nx.getDate() + 7);
  if (nx.toISOString().slice(0, 7) === ym) return null;
  const issMap = {}; monthIss.forEach(i => issMap[i.id] = i);
  return { ym, issMap };
}

async function _aiRunMonthly(issue, custs, res) {
  if (typeof mbList !== 'function') return null;
  const ids = Object.keys(custs).map(Number).filter(cid => isMonthlyCustomer(cid));
  if (!ids.length) return null;
  const me = await _aiMonthEnd(issue);
  if (!me) return null;
  const { ym, issMap } = me;
  const ads = await run(db.from('ads').select('*').in('issue_id', Object.keys(issMap).map(Number)).in('customer_id', ids).not('status', 'in', '("cancelled","rejected")'));
  const doneSet = await _mbDoneSet(ym);
  const docDate = _mbDocDate(ym);
  for (const cid of ids) {
    const cust = custs[cid] || { id: cid };
    const name = cust.name || nameOf('customers', cid);
    const cAds = (ads || []).filter(a => a.customer_id === cid);
    if (!cAds.length) continue;
    const isCenter = typeof ecIsCenter === 'function' && ecIsCenter(cid);
    const groups = isCenter ? ecCatKeys(cid) : ['regular'];
    for (const gk of groups) {
      const catHe = isCenter ? ecCatLabel(cid, gk) : '';
      const sfx = isCenter ? _ecSfx(cid, gk, true) : '';
      const gName = name + (isCenter ? ' · ' + catHe : '');
      const open = cAds.filter(a => (!isCenter || ecCatOfAd(a) === gk) && _aiOpen(a));
      if (!open.length) continue;
      const meta = { k: 'm' + ym + '-c' + cid + (isCenter ? '-' + gk : ''), what: 'חודשי ' + ym, ad_ids: open.map(a => a.id) };
      if (_mbIsDone(doneSet, ym, cid, isCenter ? gk : '')) { res.push({ ...meta, cid, name: gName, st: 'skip', why: 'כבר הופקה חשבונית חודשית — מודעות שנוספו אחריה לטיפול ידני (השלמה)' }); continue; }
      const toEmail = isCenter ? ecEmailOf(cid, gk) : '';
      if (!_aiEmailOk(toEmail || cust.email)) { res.push({ ...meta, cid, name: gName, st: 'skip', why: 'אין מייל' }); continue; }
      const lines = isPagesOnlyCustomer(cid) ? ipoMonthlyLines(open, issMap) : open.map(a => _mbLine(a, issMap)).filter(it => it.price > 0);
      if (!lines.length) continue;
      const items = isPagesOnlyCustomer(cid) ? lines : [{ details: 'חיוב חודשי — ' + ym + (sfx ? ' — ' + sfx : ''), amount: 1, price: 0 }, ...lines];
      const docKind = _ibDocKind(cid);
      const total = lines.reduce((s, it) => s + it.amount * it.price, 0);
      const data = await invCall({
        customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: docDate,
        transaction_id: _mbTxn(ym, cid, docKind, isCenter ? gk : ''),
        comment: 'חיוב חודשי ' + ym + (sfx ? ' (' + sfx + ')' : ''), ad_ids: open.map(a => a.id), pay_link: 'amount',
      }, { stay: true });
      // מייל אחד ללקוח: גזירי החודש + החשבונית מצורפת (כמו בחיוב החודשי הידני)
      let mail = null;
      if (data && data.ok && data.document && typeof adProofSendMonth === 'function') {
        try {
          const doc = data.document;
          const o = { note: 'חשבונית' + (doc.doc_number ? " מס' " + doc.doc_number : '') + (data.pay_url ? ' · לתשלום מאובטח באשראי: ' + data.pay_url : '') };
          // EZcount כבר שולח את המסמך כשהשליחה האוטומטית שלו דולקת — אז לא מצרפים אותו שוב
          if (String((cache.settings || {}).ezcount_autosend || '') !== '1') o.invoice = { doc_number: doc.doc_number, doc_uuid: doc.doc_uuid };
          if (isCenter) Object.assign(o, { to_email: toEmail || cust.email, ad_ids: open.map(a => a.id), category_he: catHe });
          const r = await adProofSendMonth(cid, [...new Set(cAds.map(a => a.issue_id))], ym, o);
          mail = (r && r.emailed) ? { ok: true } : { ok: false, err: (r && r.emailError) || 'המייל לא אושר' };
        } catch (e) { mail = { ok: false, err: String(e && e.message || e) }; }
      }
      await _aiAfterDoc(Object.assign({}, cust, { email: toEmail || cust.email }), gName, data, docKind, total, 'חודשי ' + ym, res, mail, meta);
    }
  }
  return ym;
}

/* ---------- פריטים פתוחים (דולג / נכשל / המייל לא יצא) ----------
   נשמרים ב-settings.auto_invoice_pending עד שמטופלים. במופע עם שרת תזמון
   (עמנואל) — מייל יומי למנהל עם הרשימה; פריט שכל המודעות שלו כבר חויבו /
   בוטלו נסגר לבד. "המייל לא יצא" נסגר ידנית בכרטיס הלקוח (✓ טופל). */
const AI_PENDING_KEY = 'auto_invoice_pending';
async function aiPendingLoad() {
  try {
    const { data } = await db.from('settings').select('value').eq('key', AI_PENDING_KEY).maybeSingle();
    const v = data ? data.value : (cache.settings || {})[AI_PENDING_KEY];
    const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
async function aiPendingStore(arr) {
  const v = JSON.stringify(arr);
  await run(db.from('settings').upsert({ key: AI_PENDING_KEY, value: v }, { onConflict: 'key' }));
  if (cache.settings) cache.settings[AI_PENDING_KEY] = v;
}
async function _aiSavePending(res) {
  const withKey = res.filter(r => r.k);
  if (!withKey.length) return;
  const cur = await aiPendingLoad();
  const byK = {}; cur.forEach(p => { if (p && p.k) byK[p.k] = p; });
  withKey.forEach(r => {
    if (r.st === 'ok') { delete byK[r.k]; return; }
    const prev = byK[r.k];
    byK[r.k] = { k: r.k, cid: r.cid, name: r.name, what: r.what, st: r.st, why: r.why || '', ad_ids: r.ad_ids || [], doc_id: r.doc_id || null, num: r.num || '', total: r.total || 0, since: (prev && prev.since) || today() };
  });
  await aiPendingStore(Object.values(byK));
}
function aiPendingFor(cid) {
  try { return JSON.parse((cache.settings || {})[AI_PENDING_KEY] || '[]').filter(p => p && Number(p.cid) === Number(cid)); } catch (e) { return []; }
}
async function aiPendingDone(k, cid) {
  if (typeof profile === 'undefined' || profile.role !== 'admin') return;
  const arr = (await aiPendingLoad()).filter(p => p.k !== k);
  try { await aiPendingStore(arr); toast('✓ סומן כטופל — לא תקבל עליו תזכורת'); } catch (e) { toast('שמירה נכשלה', true); }
  if (cid && typeof openCustomerCard === 'function') openCustomerCard(cid);
}

/* הרצה מלאה לגיליון שאומת — מחזיר HTML של סיכום (או '' אם אין לקוחות אוטומטיים) */
async function autoInvoiceAfterVerify(issue) {
  if (typeof profile === 'undefined' || profile.role !== 'admin') return '';
  if (typeof invoicesOn === 'function' && !invoicesOn()) return '';
  const ids = aiAutoList();
  if (!ids.length || !issue) return '';
  const res = [];
  let ym = null;
  try {
    toast('⚡ מפיק חשבוניות אוטומטיות...');
    const custs = await _aiCustomers(ids);
    await _aiRunIssue(issue, custs, res);
    ym = await _aiRunMonthly(issue, custs, res);
  } catch (e) { res.push({ cid: 0, name: '—', st: 'fail', why: String(e && e.message || e) }); }
  try { await _aiSavePending(res); } catch (e) { console.error('auto-invoice pending', e); }
  if (!res.length) return `<div style="margin-top:12px;padding:10px;border-radius:10px;background:#f8fafc;border:1px solid var(--line,#e5e7eb);font-size:.88rem">⚡ חשבוניות אוטומטיות: אין חשבוניות חדשות להפקה בגיליון זה${ym ? ' (כולל חיוב חודשי ' + ym + ')' : ''}.</div>`;
  const ico = { ok: '✅', nomail: '⚠️', skip: '⏭️', fail: '❌' };
  const okN = res.filter(r => r.st === 'ok').length;
  const sum = res.filter(r => r.st === 'ok' || r.st === 'nomail').reduce((s, r) => s + (r.total || 0), 0);
  const rows = res.map(r => `<tr><td>${ico[r.st]} <a href="#" onclick="event.preventDefault();openCustomerCard(${r.cid})">${esc(r.name)}</a></td>
    <td>${r.num ? esc(String(r.num)) : ''}</td><td>${r.total ? money(r.total) : ''}</td>
    <td style="font-size:.82rem">${r.st === 'ok' ? 'הופק ונשלח' : esc(r.why || '')}</td></tr>`).join('');
  return `<div style="margin-top:14px">
    <h4 style="margin:0 0 6px">⚡ חשבוניות אוטומטיות — ${okN} נשלחו · ${money(sum)} לפני מע"מ${ym ? ' · כולל חיוב חודשי ' + ym : ''}</h4>
    <div class="table-wrap"><table class="data"><thead><tr><th>לקוח</th><th>מסמך</th><th>סכום</th><th>מצב</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* עטיפת _pvFinish ("סיום ושמירה" באימות מול מודפס) — הפקה אוטומטית וסיכום בחלון הסיום */
(function () {
  const orig = window._pvFinish;
  if (typeof orig === 'function' && !orig._aiWrapped) {
    const wrapped = async function () {
      const issue = (typeof _pvState !== 'undefined' && _pvState) ? _pvState.issue : null;
      const r = await orig.apply(this, arguments);
      if (issue && aiAutoList().length) {
        try {
          const html = await autoInvoiceAfterVerify(issue);
          if (html) {
            const m = document.getElementById('viewModal');
            const act = m && m.querySelector('.m-actions');
            if (act) act.insertAdjacentHTML('beforebegin', html); else if (m) m.insertAdjacentHTML('beforeend', html);
            document.getElementById('viewBack').classList.add('open');
          }
        } catch (e) { console.error('auto-invoice', e); toast('שגיאה בחשבוניות האוטומטיות: ' + (e && e.message || e), true); }
      }
      return r;
    };
    wrapped._aiWrapped = true;
    window._pvFinish = wrapped;
  }
})();

/* עטיפת openCustomerCard — מתג "שליחת חשבוניות אוטומטית" (מנהל בלבד) */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._aiWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (typeof profile !== 'undefined' && profile.role === 'admin' && (typeof invoicesOn !== 'function' || invoicesOn())) {
          const modal = document.getElementById('viewModal');
          if (modal && !document.getElementById('aiToggle')) {
            const on = isAutoInvoiceCustomer(id);
            const c = (cache.customers || []).find(x => x.id === Number(id)) || {};
            const hasEm = _aiEmailOk(c.email);
            const monthly = typeof isMonthlyCustomer === 'function' && isMonthlyCustomer(id);
            const div = document.createElement('div');
            div.style.cssText = 'margin-top:12px;padding:10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:#fbfdff;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap';
            div.innerHTML = `<span><b>שליחת חשבוניות אוטומטית:</b> ${on
              ? '<span class="pill green">פעיל — ' + (monthly ? 'חשבונית חודשית אחרי אימות הגיליון האחרון בחודש' : 'חשבונית אחרי אימות כל גיליון מול המודפס') + '</span>'
              : 'כבוי'}${!hasEm && !on ? ' <span class="muted" style="font-size:.8rem">(דרוש מייל בכרטיס)</span>' : ''}${on && !hasEm ? ' <span class="pill amber">⚠ אין מייל — לא יישלח</span>' : ''}</span>
              <button id="aiToggle" class="btn btn-sm ${on ? 'btn-ghost' : ''}" ${!on && !hasEm ? 'disabled style="opacity:.5;cursor:not-allowed" title="הוסף מייל ללקוח כדי להפעיל"' : ''} onclick="toggleAutoInvoice(${id})">${on ? 'כבה שליחה אוטומטית' : '⚡ הפעל שליחה אוטומטית'}</button>`;
            const pend = aiPendingFor(id);
            if (pend.length) div.insertAdjacentHTML('beforeend', '<div style="flex-basis:100%;font-size:.84rem">' + pend.map(p =>
              `<div style="margin-top:6px;padding:6px 8px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;display:flex;gap:8px;align-items:center;flex-wrap:wrap">⚠ <b>${esc(p.what || '')}</b> — ${esc(p.st === 'nomail' ? 'מסמך ' + (p.num || '') + ' הופק, המייל לא יצא' : (p.why || 'לא הופק'))}${p.st === 'nomail' && p.why ? ' (' + esc(p.why) + ')' : ''} <span class="muted">· מאז ${esc(p.since || '')}</span>
              <button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="aiPendingDone('${esc(p.k)}', ${id})">✓ טופל</button></div>`).join('') + '</div>');
            (document.getElementById('ccBilling') || modal).appendChild(div);
          }
        }
      } catch (e) { console.error('auto-invoice card', e); }
      return r;
    };
    wrapped._aiWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
