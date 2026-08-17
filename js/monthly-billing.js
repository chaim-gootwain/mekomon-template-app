/* ============================================================
monthly-billing.js — חיוב חודשי
------------------------------------------------------------
- כפתור בכרטיס הלקוח: הפיכה לחיוב חודשי (נשמר ב-settings.monthly_billing_customers)
- לקוח חודשי מדולג ב"חיוב הגיליון" (badge "חיוב חודשי")
- בגיליון האחרון בחודש: כפתור שמפיק חשבונית אחת לכל לקוח חודשי על כל החודש
- מזהה ייחודי לכל לקוח+חודש — מונע חיוב כפול
============================================================ */

'use strict';

const MB_KEY = 'monthly_billing_customers';

/* מזהה עסקה ייחודי לחיוב חודשי. EZcount מגביל את transaction_id ל-45 תווים,
   ולכן בצירוף חורג (למשל חשבונית מס למרכז קהילתי עם סיומת קטגוריה) מקצרים את הזנב.
   הקידומת "emu-monthly-<ym>-cust<cid>-" נשמרת תמיד — כך שזיהוי "הופק?" (ilike/השוואה) ממשיך לעבוד,
   והפורמט הקיים לא משתנה כשהוא בגבול (בלי סיכון לחיוב כפול). */
function _mbTxn(ym, cid, kind, cat) {
  const pre = 'emu-monthly-' + ym + '-cust' + cid + '-';
  const full = pre + kind + (cat ? '-' + cat : '');
  if (full.length <= 45) return full;
  const kk = { proforma: 'p', tax_invoice: 'ti', invoice_receipt: 'ir', receipt: 'r', credit: 'cr' }[kind] || kind;
  const cc = cat ? (cat === 'social' ? 's' : cat === 'regular' ? 'r' : String(cat).slice(0, 3)) : '';
  return (pre + kk + (cc ? '-' + cc : '')).slice(0, 45);
}

function mbList() { try { return JSON.parse((cache.settings || {})[MB_KEY] || '[]'); } catch (e) { return []; } }
function isMonthlyCustomer(id) { return mbList().includes(Number(id)); }
async function mbSetList(arr) {
  const v = JSON.stringify(arr);
  await db.from('settings').upsert({ key: MB_KEY, value: v }, { onConflict: 'key' });
  if (cache.settings) cache.settings[MB_KEY] = v;
}
async function toggleMonthlyBilling(id) {
  id = Number(id);
  const arr = mbList(); const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1); else arr.push(id);
  await mbSetList(arr);
  toast(arr.includes(id) ? '🔁 חיוב חודשי הופעל — יחויב בסוף החודש' : 'חיוב חודשי בוטל');
  if (typeof openCustomerCard === 'function') openCustomerCard(id);
}

/* ---- מרכז קהילתי עמנואל: פיצול חשבונית חודשית ל-2 קטגוריות (רגיל / חברתי כלכלי) ---- */
/* הסיווג הוא ברמת המודעה הבודדת — באותו שבוע יכולות להיות מודעות משתי הקטגוריות */
const EC_KEY = 'emanuel_center_cat';
const EC_CAT_HE = { regular: 'רגיל', social: 'חברתי כלכלי' };
function ecIsCenter(cid) {
  const c = (cache.customers || []).find(x => x.id === Number(cid));
  const n = (c && c.name) ? c.name : '';
  return /מרכז\s*קהילתי/.test(n) && /עמנואל/.test(n);
}
function ecMap() { try { return JSON.parse((cache.settings || {})[EC_KEY] || '{}'); } catch (e) { return {}; } }
function ecCatOfAd(adId) { return ecMap()['ad' + adId] || 'regular'; }
async function ecSetCatAd(adId, cat) {
  const m = ecMap(); m['ad' + adId] = cat;
  const v = JSON.stringify(m);
  await db.from('settings').upsert({ key: EC_KEY, value: v }, { onConflict: 'key' });
  if (cache.settings) cache.settings[EC_KEY] = v;
  if (typeof toast === 'function') toast('סווג: ' + (EC_CAT_HE[cat] || cat));
}
/* חלון סיווג מודעות (רגיל / חברתי כלכלי) לכל מודעה בנפרד — נפתח מכפתור בשורת הלקוח */
async function ecCatsModal(issueId, customerId) {
  const iss = (cache.issues || []).find(i => i.id === issueId) || {};
  const ads = (await db.from('ads').select('*').eq('issue_id', issueId).eq('customer_id', customerId).not('status', 'in', '("cancelled","rejected")')).data || [];
  const lbl = (typeof _ibLabel === 'function') ? _ibLabel : (t => t || 'מודעה');
  const priced = ads.filter(a => Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) > 0);
  document.getElementById('ecOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ecOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ecCatsClose(issueId); });
  const rows = priced.map(a => {
    const cur = ecCatOfAd(a.id);
    const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || '';
    const price = Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
    return `<tr>
      <td style="text-align:right">${esc(lbl(a.title))}${sz ? ' · ' + esc(sz) : ''}${a.page_number ? ' — עמ׳ ' + a.page_number : ''}</td>
      <td style="white-space:nowrap">${money(price)}</td>
      <td><select onchange="ecSetCatAd(${a.id}, this.value)" style="padding:3px 6px;border-radius:6px;border:1px solid #d1d5db">
        <option value="regular" ${cur === 'regular' ? 'selected' : ''}>רגיל</option>
        <option value="social" ${cur === 'social' ? 'selected' : ''}>חברתי כלכלי</option></select></td></tr>`;
  }).join('');
  ov.innerHTML = `<div style="background:#fff;border-radius:14px;padding:18px;max-width:580px;width:92%;max-height:84vh;overflow:auto;direction:rtl">
    <h3 style="margin:0 0 4px">🏷️ קטגוריות מודעות — ${esc(nameOf('customers', customerId))}</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 10px">גיליון ${iss.issue_number || ''} · בחר/י קטגוריה לכל מודעה בנפרד. הבחירה נשמרת אוטומטית ומפצלת את החשבונית החודשית.</p>
    ${priced.length ? `<table class="data" style="width:100%"><thead><tr><th>מודעה</th><th>מחיר</th><th>קטגוריה</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">אין מודעות עם מחיר בגיליון זה</p>'}
    <div style="margin-top:14px;text-align:left"><button class="btn" onclick="ecCatsClose(${issueId})">סגור</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function ecCatsClose(issueId) {
  document.getElementById('ecOv')?.remove();
  if (typeof issueBillingOpen === 'function') issueBillingOpen(issueId);
}

/* תאריך המסמך לחשבונית החודשית = היום האחרון בחודש; אם יוצא בשבת — יומיים קודם (חמישי) */
function _mbDocDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 0); // היום האחרון של החודש (m הוא 1-בסיס → Date(y,m,0))
  if (d.getDay() === 6) d.setDate(d.getDate() - 2); // שבת → חמישי
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

let _mbCtx = null; // הקשר לרשימת האישור החודשית: {ym, issMap, ads, done}
let _mbKind = null; // סוג המסמך שנבחר בתצוגה המקדימה החודשית
let _mbClipsSent = new Set(); // מעקב: למי כבר נשלחו גזירי החודש (למניעת כפילות בפיצול קטגוריות)
/* שורת פריט אחת למודעה בחשבונית החודשית */
function _mbLine(a, issMap) {
  const iss = issMap[a.issue_id] || {};
  const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || '';
  const lbl = (typeof _ibLabel === 'function') ? _ibLabel : (t => t || 'מודעה');
  return { details: lbl(a.title) + (sz ? ' · ' + sz : '') + ' — גיליון ' + iss.issue_number + (a.page_number ? ' — עמוד ' + a.page_number : ''), amount: 1, price: Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) };
}

/* הפקת חשבוניות חודשיות לחודש (YYYY-MM) — הפקה מרוכזת (משמש כגיבוי; הכפתור מפנה לאישור פרטני) */
async function monthlyBillingRun(ym) {
  ym = ym || new Date().toISOString().slice(0, 7);
  const monthly = mbList();
  if (!monthly.length) { toast('אין לקוחות בחיוב חודשי', true); return 0; }
  // קיבוץ לפי חודש הסגירה לדפוס (print_date), עם נפילה ל-publish_date בגיליונות ישנים
  const _effM = (i) => ((i.print_date || i.publish_date) || '').slice(0, 7);
  const _allIss = await run(db.from('issues').select('id,issue_number,publish_date,print_date'));
  const issues = (_allIss || []).filter(i => _effM(i) === ym);
  if (!issues.length) { toast('אין גיליונות לחודש ' + ym, true); return 0; }
  const issMap = {}; issues.forEach(i => issMap[i.id] = i);
  const ads = await run(db.from('ads').select('*').in('issue_id', issues.map(i => i.id)).in('customer_id', monthly).not('status', 'in', '("cancelled","rejected")'));
  const lbl = (typeof _ibLabel === 'function') ? _ibLabel : (t => t || 'מודעה');
  const docDate = _mbDocDate(ym); // תאריך המסמך = סוף החודש (ואם שבת — יומיים קודם)
  let count = 0;
  const mkLine = a => { const iss = issMap[a.issue_id] || {}; const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || ''; return { details: lbl(a.title) + (sz ? ' · ' + sz : '') + ' — גיליון ' + iss.issue_number + (a.page_number ? ' — עמוד ' + a.page_number : ''), amount: 1, price: Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) }; };
  for (const cid of monthly) {
    const cAds = ads.filter(a => a.customer_id === cid);
    if (!cAds.length) continue;
    const cust = (cache.customers || []).find(c => c.id === cid) || {};
    const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
    // מרכז קהילתי עמנואל → פיצול ל-2 קטגוריות; שאר הלקוחות → חשבונית אחת כרגיל
    const isCenter = ecIsCenter(cid);
    const groups = isCenter
      ? { regular: cAds.filter(a => ecCatOfAd(a.id) === 'regular'), social: cAds.filter(a => ecCatOfAd(a.id) === 'social') }
      : { regular: cAds };
    for (const gk of Object.keys(groups)) {
      const lines = groups[gk].map(mkLine).filter(it => it.price > 0);
      if (!lines.length) continue;
      const isSocial = gk === 'social';
      const header = 'חיוב חודשי — ' + ym + (isSocial ? ' — חברתי כלכלי' : '');
      const items = [{ details: header, amount: 1, price: 0 }, ...lines];
      const txn = _mbTxn(ym, cid, docKind, isCenter ? gk : '');
      await invCall({ customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: docDate, transaction_id: txn, comment: 'חיוב חודשי ' + ym + (isSocial ? ' (חברתי כלכלי)' : ''), ad_ids: groups[gk].map(a => a.id) });
      count++;
    }
  }
  toast('הופקו ' + count + ' חשבוניות חודשיות לחודש ' + ym);
  return count;
}

/* חלון הזנת/עדכון מייל הלקוח (נשמר בכרטיס הלקוח) — כשאין מייל */
function mbCaptureEmail(cid, ym) {
  const cust = (cache.customers || []).find(c => c.id === cid) || {};
  document.getElementById('mbEmOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'mbEmOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;padding:18px;max-width:440px;width:92%;direction:rtl">
    <h3 style="margin:0 0 4px">✉️ מייל ללקוח — ${esc(nameOf('customers', cid))}</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 12px">הזן/עדכן את כתובת המייל של הלקוח. הכתובת נשמרת בכרטיס הלקוח.</p>
    <input id="mbEmInput" type="email" dir="ltr" value="${esc(cust.email || '')}" placeholder="name@example.com" style="width:100%;padding:9px;border:1px solid var(--line,#d1d5db);border-radius:8px;font-size:15px;box-sizing:border-box">
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="btn" onclick="mbSaveEmail(${cid}, '${ym}', true)">💾 שמור ושלח גזירים</button>
      <button class="btn btn-ghost" onclick="mbSaveEmail(${cid}, '${ym}', false)">שמור בלבד</button>
      <button class="btn btn-ghost" onclick="document.getElementById('mbEmOv').remove()">ביטול</button>
    </div></div>`;
  document.body.appendChild(ov);
  setTimeout(() => { const i = document.getElementById('mbEmInput'); if (i) i.focus(); }, 60);
}

async function mbSaveEmail(cid, ym, alsoSend) {
  const inp = document.getElementById('mbEmInput');
  const email = (inp ? inp.value : '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('כתובת מייל לא תקינה', true); return; }
  try {
    await run(db.from('customers').update({ email }).eq('id', cid));
    const c = (cache.customers || []).find(x => x.id === cid); if (c) c.email = email;
    if (typeof _customers !== 'undefined' && _customers) { const cc = _customers.find(x => x.id === cid); if (cc) cc.email = email; }
    document.getElementById('mbEmOv')?.remove();
    toast('✅ המייל נשמר בכרטיס הלקוח');
    if (alsoSend) {
      let issueIds = (_mbCtx && _mbCtx.ym === ym) ? [...new Set(_mbCtx.ads.filter(a => a.customer_id === cid).map(a => a.issue_id))] : [];
      if (!issueIds.length) {
        const _iss = await run(db.from('issues').select('id,publish_date,print_date'));
        const _ids = (_iss || []).filter(i => ((i.print_date || i.publish_date) || '').slice(0, 7) === ym).map(i => i.id);
        const _a = await run(db.from('ads').select('issue_id').eq('customer_id', cid).in('issue_id', _ids).not('status', 'in', '("cancelled","rejected")'));
        issueIds = [...new Set((_a || []).map(a => a.issue_id))];
      }
      if (issueIds.length && typeof adProofSendMonth === 'function') {
        toast('שולח גזירי החודש...');
        const r = await adProofSendMonth(cid, issueIds, ym, { email: true });
        toast(r && r.emailed ? '✅ גזירי החודש נשלחו למייל' : 'הגזירים מוכנים');
      } else { toast('אין גזירים לחודש זה לשליחה', true); }
    }
    if (typeof monthlyBillingReview === 'function') await monthlyBillingReview(ym);
  } catch (e) { toast('שמירה נכשלה: ' + (e && e.message || e), true); }
}

/* הורדת PDF עם כל גזירי הפרסום של הלקוח לחודש (בלי לשלוח מייל) */
async function mbDownloadClips(ym, cid) {
  try {
    let issueIds = [];
    if (_mbCtx && _mbCtx.ym === ym) {
      issueIds = [...new Set(_mbCtx.ads.filter(a => a.customer_id === cid).map(a => a.issue_id))];
    }
    if (!issueIds.length) {
      const _iss = await run(db.from('issues').select('id,publish_date,print_date'));
      const _ids = (_iss || []).filter(i => ((i.print_date || i.publish_date) || '').slice(0, 7) === ym).map(i => i.id);
      const _a = await run(db.from('ads').select('issue_id').eq('customer_id', cid).in('issue_id', _ids).not('status', 'in', '("cancelled","rejected")'));
      issueIds = [...new Set((_a || []).map(a => a.issue_id))];
    }
    if (!issueIds.length) { toast('אין גזירים לחודש זה', true); return; }
    if (typeof adProofSendMonth !== 'function') { toast('לא זמין', true); return; }
    toast('מכין ומוריד גזירי החודש...');
    await adProofSendMonth(cid, issueIds, ym, { email: false, download: true });
    toast('✅ גזירי החודש הורדו');
  } catch (e) { toast('ההורדה נכשלה: ' + (e && e.message || e), true); }
}

/* מסך אישור פרטני לחיוב החודשי — רשימת לקוחות, הפקה אחד-אחד (כמו בחיוב הגיליון) */
async function monthlyBillingReview(ym) {
  ym = ym || new Date().toISOString().slice(0, 7);
  const monthly = mbList();
  if (!monthly.length) { toast('אין לקוחות בחיוב חודשי', true); return; }
  // קיבוץ לפי חודש הסגירה לדפוס (print_date), עם נפילה ל-publish_date בגיליונות ישנים
  const _effM = (i) => ((i.print_date || i.publish_date) || '').slice(0, 7);
  const _allIss = await run(db.from('issues').select('id,issue_number,publish_date,print_date'));
  const issues = (_allIss || []).filter(i => _effM(i) === ym);
  if (!issues.length) { toast('אין גיליונות לחודש ' + ym, true); return; }
  const issMap = {}; issues.forEach(i => issMap[i.id] = i);
  const ads = await run(db.from('ads').select('*').in('issue_id', issues.map(i => i.id)).in('customer_id', monthly).not('status', 'in', '("cancelled","rejected")'));
  const done = new Set();
  try { const docs = await run(db.from('documents').select('transaction_id,status').ilike('transaction_id', 'emu-monthly-' + ym + '-cust%')); (docs || []).forEach(d => { if (!['failed', 'cancelled'].includes(d.status)) done.add(d.transaction_id); }); } catch (e) { }
  _mbCtx = { ym, issMap, ads, done };
  _mbClipsSent = new Set();
  const rows = [];
  for (const cid of monthly) {
    const cAds = ads.filter(a => a.customer_id === cid);
    if (!cAds.length) continue;
    const cust = (cache.customers || []).find(c => c.id === cid) || {};
    const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
    const isCenter = ecIsCenter(cid);
    const groups = isCenter ? ['regular', 'social'] : ['regular'];
    for (const gk of groups) {
      const gAds = isCenter ? cAds.filter(a => ecCatOfAd(a.id) === gk) : cAds;
      const total = gAds.reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);
      if (!(total > 0)) continue;
      const txn = _mbTxn(ym, cid, docKind, isCenter ? gk : '');
      // "הופק?" — מזהים כל סוג מסמך (חשבון עסקה / חשבונית מס), כי המשתמש יכול לבחור סוג בבורר
      const _isDone = ['proforma', 'tax_invoice', 'invoice_receipt', 'receipt'].some(k => done.has(_mbTxn(ym, cid, k, isCenter ? gk : '')));
      const _cRec = (cache.customers || []).find(c => c.id === cid) || {};
      rows.push({ cid, gk, isCenter, isSocial: gk === 'social', total, count: gAds.length, txn, done: _isDone, name: nameOf('customers', cid), email: (_cRec.email || '').trim() });
    }
  }
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he') || a.gk.localeCompare(b.gk));
  const listRows = rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b>${r.isCenter ? ` <span style="font-size:.78rem;color:${r.isSocial ? '@@COLOR_BRAND@@' : '#6b7280'}">· ${r.isSocial ? 'חברתי כלכלי' : 'רגיל'}</span>` : ''}</td>
      <td>${r.count}</td>
      <td>${money(r.total)}</td>
      <td>${r.done ? '<span class="pill green">חויב ✓</span>' : `<button class="btn btn-sm" onclick="monthlyBillingPreviewOne('${ym}',${r.cid},'${r.gk}')">תצוגה והפקה</button>`}
        <button class="btn btn-sm btn-ghost" onclick="mbDownloadClips('${ym}', ${r.cid})" title="הורד PDF עם כל גזירי הפרסום של הלקוח לחודש">📎 גזירים</button>
        ${r.email ? '' : `<button class="btn btn-sm btn-ghost" style="color:var(--brand)" onclick="mbCaptureEmail(${r.cid}, '${ym}')" title="ללקוח אין מייל — הוסף/עדכן כדי לשלוח גזירים">✉️ הוסף מייל</button>`}</td>
    </tr>`).join('');
  const pending = rows.filter(r => !r.done).length;
  document.getElementById('viewModal').innerHTML = `
    <h3>🗓️ חיוב חודשי — ${ym}</h3>
    <p class="muted" style="font-size:.85rem">אישור והפקה אחד-אחד · תאריך המסמך: ${_mbDocDate(ym)}${pending ? ` · ${pending} ממתינות` : ' · הכל הופק'}</p>
    ${rows.length ? `<div class="table-wrap" style="margin-top:10px"><table class="data">
      <thead><tr><th>לקוח</th><th>מודעות</th><th>סכום (לפני מע"מ)</th><th></th></tr></thead><tbody>${listRows}</tbody></table></div>`
      : '<p class="empty" style="margin-top:10px">אין חשבוניות חודשיות להפקה בחודש זה</p>'}
    <div class="m-actions" style="margin-top:12px"><button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* תצוגה מקדימה של חשבונית חודשית אחת (לקוח + קטגוריה) */
async function monthlyBillingPreviewOne(ym, cid, gk) {
  if (!_mbCtx || _mbCtx.ym !== ym) { await monthlyBillingReview(ym); }
  const ctx = _mbCtx; if (!ctx) return;
  const cust = (cache.customers || []).find(c => c.id === cid) || {};
  const isCenter = ecIsCenter(cid);
  const cAds = ctx.ads.filter(a => a.customer_id === cid && (!isCenter || ecCatOfAd(a.id) === gk));
  const lines = cAds.map(a => _mbLine(a, ctx.issMap)).filter(it => it.price > 0);
  if (!lines.length) { toast('אין מה לחייב', true); return; }
  const total = lines.reduce((s, it) => s + it.amount * it.price, 0);
  const isSocial = gk === 'social';
  const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
  _mbKind = docKind; // ברירת מחדל לסוג המסמך
  document.getElementById('viewModal').innerHTML = `
    <h3>תצוגה מקדימה — ${esc(nameOf('customers', cid))}${isCenter ? (isSocial ? ' · חברתי כלכלי' : ' · רגיל') : ''}</h3>
    <p class="muted" style="font-size:.85rem">חיוב חודשי ${ym} · תאריך המסמך: ${_mbDocDate(ym)}</p>
    <div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>פירוט</th><th>מחיר</th></tr></thead><tbody>
      ${lines.map(it => `<tr><td>${esc(it.details)}</td><td>${money(it.price)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="inv-total" style="margin-top:10px;font-weight:800">סה"כ (לפני מע"מ): ${money(total)}</div>
    <div class="field" style="margin-top:12px"><label>סוג מסמך</label>
      <select onchange="_mbKind=this.value">
        <option value="proforma" ${docKind === 'proforma' ? 'selected' : ''}>חשבון עסקה</option>
        <option value="tax_invoice" ${docKind === 'tax_invoice' ? 'selected' : ''}>חשבונית מס</option>
      </select></div>
    <div class="m-actions" style="margin-top:12px">
      <button class="btn" onclick="monthlyBillingIssueOne('${ym}',${cid},'${gk}')">הפק ושלח ←</button>
      <button class="btn btn-ghost" onclick="monthlyBillingReview('${ym}')">→ חזרה לרשימה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* הפקה בפועל של חשבונית חודשית אחת */
async function monthlyBillingIssueOne(ym, cid, gk) {
  if (!_mbCtx || _mbCtx.ym !== ym) { await monthlyBillingReview(ym); }
  const cust = (cache.customers || []).find(c => c.id === cid) || {};
  const isCenter = ecIsCenter(cid);
  const cAds = _mbCtx.ads.filter(a => a.customer_id === cid && (!isCenter || ecCatOfAd(a.id) === gk));
  const lines = cAds.map(a => _mbLine(a, _mbCtx.issMap)).filter(it => it.price > 0);
  if (!lines.length) { toast('אין מה לחייב', true); return; }
  const isSocial = gk === 'social';
  const docKind = _mbKind || (cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma');
  const header = 'חיוב חודשי — ' + ym + (isSocial ? ' — חברתי כלכלי' : '');
  const items = [{ details: header, amount: 1, price: 0 }, ...lines];
  const txn = _mbTxn(ym, cid, docKind, isCenter ? gk : '');
  document.getElementById('viewBack').classList.remove('open');
  await invCall({ customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: _mbDocDate(ym), transaction_id: txn, comment: 'חיוב חודשי ' + ym + (isSocial ? ' (חברתי כלכלי)' : ''), ad_ids: cAds.map(a => a.id) });
  // שולח ללקוח מייל אחד עם כל גזירי הפרסום שלו מהחודש (פעם אחת בלבד, גם בפיצול קטגוריות)
  try {
    const _key = cid + '|' + ym;
    const _allAds = (_mbCtx && _mbCtx.ads || []).filter(a => a.customer_id === cid);
    const _issueIds = [...new Set(_allAds.map(a => a.issue_id))];
    if (typeof adProofSendMonth === 'function' && _issueIds.length && !_mbClipsSent.has(_key)) {
      _mbClipsSent.add(_key);
      toast('מכין גזירי החודש...');
      const _r = await adProofSendMonth(cid, _issueIds, ym);
      if (_r && _r.emailed) toast('✅ גזירי החודש נשלחו ללקוח במייל אחד');
      else if (_r && _r.downloaded) toast('ℹ️ אין מייל ללקוח — הורדתי לך את גזירי החודש');
      else toast('גזירי החודש מוכנים');
    }
  } catch (e) { toast('הערה: שליחת גזירי החודש נכשלה — ' + (e && e.message || e), true); }
  await monthlyBillingReview(ym);
}

/* סימון לקוח כחודשי מתוך מסך "חיוב הגיליון" (ומרענן את הרשימה) */
async function issueBillingSetMonthly(issueId, customerId) {
  customerId = Number(customerId);
  const arr = mbList(); const i = arr.indexOf(customerId);
  if (i >= 0) arr.splice(i, 1); else arr.push(customerId);
  await mbSetList(arr);
  toast(arr.includes(customerId) ? '🔁 הוגדר כחיוב חודשי — הפרסומים נשמרים לחשבונית החודשית' : 'בוטל חיוב חודשי');
  if (typeof issueBillingOpen === 'function') issueBillingOpen(issueId);
}

/* עטיפת openCustomerCard — כפתור חיוב חודשי */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._mbWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (['admin', 'sales'].includes(profile.role)) {
          const modal = document.getElementById('viewModal');
          if (modal && !document.getElementById('mbToggle')) {
            const on = isMonthlyCustomer(id);
            const div = document.createElement('div');
            div.style.cssText = 'margin-top:12px;padding:10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;background:#fbfdff;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap';
            div.innerHTML = `<span><b>אופן חיוב:</b> ${on ? '<span class="pill amber">חודשי — חשבונית אחת בסוף החודש</span>' : 'לפי גיליון'}</span>
              <button id="mbToggle" class="btn btn-sm ${on ? 'btn-ghost' : ''}" onclick="toggleMonthlyBilling(${id})">${on ? 'בטל חיוב חודשי' : '🔁 הפוך לחיוב חודשי'}</button>`;
            modal.appendChild(div);
          }
        }
      } catch (e) { console.error('monthly-billing', e); }
      return r;
    };
    wrapped._mbWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
