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
  const cc = _mbCatShort(cat);
  return (pre + kk + (cc ? '-' + cc : '')).slice(0, 45);
}

/* קיצור הסוג במזהה העסקה: רגיל/חברתי — r/s (כמו עד היום); סוגים חדשים (c1…c99) — כמו שהם */
function _mbCatShort(cat) { return cat ? (cat === 'social' ? 's' : cat === 'regular' ? 'r' : String(cat).slice(0, 3)) : ''; }

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

/* ---- פיצול החשבונית החודשית לפי סוגי מודעות ----
   ללקוחות שסומנו בכרטיס הלקוח (settings.cat_split_customers = [id,…]) מופקת חשבונית
   נפרדת לכל סוג מודעה. הסוגים מוגדרים לכל לקוח בנפרד (settings.cat_defs_<cid> =
   [{"k":"c1","he":"…"},…]); לקוח בלי הגדרה מקבל את ברירת המחדל רגיל / חברתי כלכלי.
   הסוג נבחר בהכנסת המודעה; מודעה בלי סוג מקבלת את סוג המודעה האחרונה של הלקוח
   באותו גודל, ואפשר לתקן במסך החיוב החודשי (🏷️ סיווג).
   (EC_KEY — שם מפתח היסטורי של מפת הסיווג; לא לשנות, יש בו נתונים) */
const EC_KEY = 'emanuel_center_cat';
const EC_SPLIT_KEY = 'cat_split_customers';
const EC_DEFAULT_CATS = [{ k: 'regular', he: 'רגיל' }, { k: 'social', he: 'חברתי כלכלי' }];
const EC_MAX_CATS = 6;
function ecSplitList() { try { const a = JSON.parse((cache.settings || {})[EC_SPLIT_KEY] || '[]'); return Array.isArray(a) ? a.map(Number) : []; } catch (e) { return []; } }
function ecIsCenter(cid) { return ecSplitList().includes(Number(cid)); }
function _ecDefsKey(cid) { return 'cat_defs_' + Number(cid); }
function _ecStoredCats(cid) { try { const a = JSON.parse((cache.settings || {})[_ecDefsKey(cid)] || 'null'); return Array.isArray(a) ? a.filter(x => x && x.k && String(x.he || '').trim()) : null; } catch (e) { return null; } }
function ecCats(cid) { const a = _ecStoredCats(cid); return (a && a.length) ? a : EC_DEFAULT_CATS; }
function ecCatKeys(cid) { return ecCats(cid).map(c => c.k); }
function ecCatLabel(cid, k) { const c = ecCats(cid).find(x => x.k === k); return c ? c.he : (k === 'regular' ? 'רגיל' : String(k || '')); }
/* תוספת לכותרת/הערת החשבונית: הסוג "רגיל" של ברירת המחדל בלי תוספת (כמו עד היום) */
function _ecSfx(cid, k, isSplit) { return (isSplit && k !== 'regular') ? ecCatLabel(cid, k) : ''; }
async function ecToggleSplit(cid) {
  cid = Number(cid);
  const arr = ecSplitList(); const i = arr.indexOf(cid);
  const turningOn = i < 0;
  if (!turningOn) {
    if (!confirm('לבטל את פיצול החשבונית לפי סוגי מודעות ללקוח הזה?\nמהחיוב החודשי הבא תופק לו חשבונית אחת.')) return;
    arr.splice(i, 1);
  } else arr.push(cid);
  const v = JSON.stringify(arr);
  await db.from('settings').upsert({ key: EC_SPLIT_KEY, value: v }, { onConflict: 'key' });
  if (cache.settings) cache.settings[EC_SPLIT_KEY] = v;
  if (turningOn) { toast('🏷️ פיצול לפי סוגי מודעות הופעל — הגדר/י את הסוגים'); ecCatsEdit(cid, true); return; }
  toast('פיצול לפי סוגי מודעות בוטל');
  if (typeof openCustomerCard === 'function') openCustomerCard(cid);
}
/* מייל לכל סוג, לכל לקוח בנפרד: settings.cat_emails_<cid> = {"<k>":"…"}. ריק = המייל הרגיל של הלקוח */
function _ecEmailsKey(cid) { return 'cat_emails_' + Number(cid); }
function ecEmails(cid) { try { const o = JSON.parse((cache.settings || {})[_ecEmailsKey(cid)] || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
function ecEmailOf(cid, cat) { return String(ecEmails(cid)[cat] || '').trim(); }
/* עריכת הסוגים והמיילים של הלקוח. fresh = הופעל עכשיו: לקוח בלי סוגים שמורים מתחיל משורות ריקות */
function ecCatsEdit(cid, fresh) {
  cid = Number(cid);
  const stored = _ecStoredCats(cid);
  const cats = (stored && stored.length) ? stored : (fresh ? [] : EC_DEFAULT_CATS);
  const em = ecEmails(cid);
  const fields = [{ type: 'section', label: 'סוגי המודעות — חשבונית נפרדת לכל סוג (לפחות 2)' }];
  const vals = {};
  for (let n = 1; n <= EC_MAX_CATS; n++) {
    fields.push({ name: 'name_' + n, label: 'סוג ' + n + ' — שם' });
    fields.push({ name: 'email_' + n, label: 'סוג ' + n + ' — מייל (ריק = המייל של הלקוח)', dir: 'ltr' });
    const c = cats[n - 1];
    vals['name_' + n] = c ? c.he : '';
    vals['email_' + n] = c ? (em[c.k] || '') : '';
  }
  openForm('סוגי מודעות לחשבונית — ' + (nameOf('customers', cid) || ''), fields, vals, async (r) => {
    const used = new Set(cats.map(c => c.k));
    const nextKey = () => { for (let n = 1; n < 100; n++) { const k = 'c' + n; if (!used.has(k)) { used.add(k); return k; } } return 'c99'; };
    const defs = [], emails = {};
    for (let n = 1; n <= EC_MAX_CATS; n++) {
      const he = String(r['name_' + n] || '').trim();
      if (!he) continue;
      const k = cats[n - 1] ? cats[n - 1].k : nextKey();
      defs.push({ k, he });
      const e = String(r['email_' + n] || '').trim();
      if (e) emails[k] = e;
    }
    if (defs.length < 2) { toast('צריך לפחות 2 סוגים כדי לפצל את החשבונית', true); throw new Error('cats<2'); }
    if (new Set(defs.map(d => d.he)).size !== defs.length) { toast('שני סוגים באותו שם — שנה/י אחד מהם', true); throw new Error('dup'); }
    const dv = JSON.stringify(defs), ev = JSON.stringify(emails);
    await db.from('settings').upsert([{ key: _ecDefsKey(cid), value: dv }, { key: _ecEmailsKey(cid), value: ev }], { onConflict: 'key' });
    if (cache.settings) { cache.settings[_ecDefsKey(cid)] = dv; cache.settings[_ecEmailsKey(cid)] = ev; }
    toast('✓ סוגי המודעות נשמרו');
    if (typeof openCustomerCard === 'function') openCustomerCard(cid);
  });
}
function ecMap() { try { return JSON.parse((cache.settings || {})[EC_KEY] || '{}'); } catch (e) { return {}; } }
/* הסוג שמוצע למודעה חדשה: סוג המודעה האחרונה של הלקוח באותו גודל, אחרת הסוג הראשון */
function ecCatGuess(cid, sizeId) {
  const keys = ecCatKeys(cid);
  const g = ecMap()['last' + Number(cid) + '_' + (Number(sizeId) || 0)];
  return keys.includes(g) ? g : keys[0];
}
/* הסוג של מודעה. מקבל אובייקט מודעה (עדיף — אז מודעה בלי סיווג מקבלת את ההצעה) או מזהה */
function ecCatOfAd(a) {
  const obj = (a && typeof a === 'object') ? a : null;
  const k = ecMap()['ad' + (obj ? obj.id : a)];
  if (obj && obj.customer_id) { const keys = ecCatKeys(obj.customer_id); return keys.includes(k) ? k : ecCatGuess(obj.customer_id, obj.price_item_id); }
  return k || 'regular';
}
async function ecSetCatAd(adId, cat, cid, sizeId) {
  const m = ecMap(); m['ad' + adId] = cat;
  if (cid) m['last' + Number(cid) + '_' + (Number(sizeId) || 0)] = cat;
  const v = JSON.stringify(m);
  await db.from('settings').upsert({ key: EC_KEY, value: v }, { onConflict: 'key' });
  if (cache.settings) cache.settings[EC_KEY] = v;
}
/* שדה "סוג לחשבונית" לטופסי הכנסת מודעה — רק ללקוח מפוצל; אחרת ריק */
function ecCatFieldHtml(cid, sizeId, selId, cur) {
  cid = Number(cid);
  if (!cid || !ecIsCenter(cid)) return '';
  const sel = cur && ecCatKeys(cid).includes(cur) ? cur : ecCatGuess(cid, sizeId);
  return `<label>סוג לחשבונית (חשבונית נפרדת לכל סוג)</label><select id="${selId}">${ecCats(cid).map(c => `<option value="${esc(c.k)}" ${c.k === sel ? 'selected' : ''}>${esc(c.he)}</option>`).join('')}</select>`;
}
/* שמירת הסוג שנבחר בטופס (אם השדה מוצג) */
async function ecSaveCatFromField(selId, adId, cid, sizeId) {
  const el = document.getElementById(selId);
  if (!el || !el.value || !ecIsCenter(cid)) return;
  try { await ecSetCatAd(adId, el.value, cid, sizeId); } catch (e) { console.error('ad category', e); }
}
/* חלון סיווג מודעות החודש של לקוח — מתוך מסך החיוב החודשי, לתיקון לפני הפקה */
function ecCatsModalMonth(ym, cid) {
  if (!_mbCtx || _mbCtx.ym !== ym) return;
  const lbl = (typeof _ibLabel === 'function') ? _ibLabel : (t => t || 'מודעה');
  const ads = _mbCtx.ads.filter(a => a.customer_id === cid && _mbBillable(a) && Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) > 0);
  const cats = ecCats(cid);
  document.getElementById('ecOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ecOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999';
  ov.addEventListener('click', e => { if (e.target === ov) ecCatsCloseMonth(ym); });
  const rows = ads.map(a => {
    const cur = ecCatOfAd(a);
    const iss = _mbCtx.issMap[a.issue_id] || {};
    const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || '';
    const price = Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
    return `<tr>
      <td style="text-align:right">${esc(lbl(a.title))}${sz ? ' · ' + esc(sz) : ''}<br><span class="muted" style="font-size:.78rem">גיליון ${esc(String(iss.issue_number || ''))}${a.page_number ? ' · עמ׳ ' + a.page_number : ''}</span></td>
      <td style="white-space:nowrap">${money(price)}</td>
      <td><select onchange="ecSetCatAd(${a.id}, this.value, ${cid}, ${Number(a.price_item_id) || 0})" style="padding:3px 6px;border-radius:6px;border:1px solid #d1d5db">
        ${cats.map(c => `<option value="${esc(c.k)}" ${c.k === cur ? 'selected' : ''}>${esc(c.he)}</option>`).join('')}</select></td></tr>`;
  }).join('');
  ov.innerHTML = `<div style="background:#fff;border-radius:14px;padding:18px;max-width:620px;width:92%;max-height:84vh;overflow:auto;direction:rtl">
    <h3 style="margin:0 0 4px">🏷️ סוגי מודעות — ${esc(nameOf('customers', cid))}</h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 10px">חיוב חודשי ${ym} · כל סוג מקבל חשבונית נפרדת. הבחירה נשמרת מיד.</p>
    ${ads.length ? `<table class="data" style="width:100%"><thead><tr><th>מודעה</th><th>מחיר</th><th>סוג</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">אין מודעות פתוחות לחיוב החודש</p>'}
    <div style="margin-top:14px;text-align:left"><button class="btn" onclick="ecCatsCloseMonth('${ym}')">סגור ורענן</button></div>
  </div>`;
  document.body.appendChild(ov);
}
function ecCatsCloseMonth(ym) {
  document.getElementById('ecOv')?.remove();
  monthlyBillingReview(ym);
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

/* אילו טרנזקציות חודשיות כבר הופקו — נבדק מול כל סוגי המסמכים, כי הסוג
   הוא חלק מה-transaction_id ובדיקה לפי סוג אחד מפספסת הפקה קודמת בסוג
   אחר (proforma מול tax_invoice) → חשבונית חודשית כפולה */
const _MB_KINDS = ['proforma', 'tax_invoice', 'invoice_receipt', 'receipt'];
async function _mbDoneSet(ym) {
  const done = new Set();
  try {
    const docs = await run(db.from('documents').select('transaction_id,status').ilike('transaction_id', 'emu-monthly-' + ym + '-cust%'));
    (docs || []).forEach(d => { if (!['failed', 'cancelled'].includes(d.status)) done.add(d.transaction_id); });
  } catch (e) { }
  return done;
}
function _mbIsDone(done, ym, cid, cat) {
  // כולל הפקה מחדש אחרי ביטול (סיומת R1..R9 — invTxnVariant)
  const _v = (typeof invTxnVariant === 'function') ? invTxnVariant : (t => t);
  return _MB_KINDS.some(k => { const b = _mbTxn(ym, cid, k, cat); for (let n = 0; n <= 9; n++) if (done.has(_v(b, n))) return true; return false; });
}
/* מודעה שטרם חויבה — "חויב" נקבע לפי המודעה עצמה ולא לפי "יש ללקוח חשבונית החודש":
   מודעה שנוספה אחרי ההפקה החודשית (או הוזנה מחדש על הלקוח) לא נבלעת ב"חויב ✓" */
function _mbBillable(a) { return !['invoiced', 'paid'].includes(a.deal_stage); }
/* מזהה עסקה לחיוב השלמה (מודעות שנוספו אחרי החשבונית החודשית). שומר על הקידומת
   החודשית, ונגזר מהמודעות עצמן — לחיצה כפולה על אותה השלמה לא מפיקה מסמך שני */
function _mbSuppTxn(ym, cid, kind, cat, ads) {
  const kk = { proforma: 'p', tax_invoice: 'ti', invoice_receipt: 'ir', receipt: 'r' }[kind] || kind;
  const cc = _mbCatShort(cat);
  const ids = ads.map(a => a.id).sort((a, b) => a - b);
  return ('emu-monthly-' + ym + '-cust' + cid + '-x' + ids[0] + 'n' + ids.length + '-' + kk + (cc ? '-' + cc : '')).slice(0, 45);
}
/* פירוט מקוצר בחשבונית החודשית: לכל גיליון — "גיליון X — תאריך" ואחריה "פרסום (עמודים)" */
function ipoMonthlyLines(ads, issMap) {
  const byIss = {};
  ads.forEach(a => { (byIss[a.issue_id] = byIss[a.issue_id] || []).push(a); });
  const ids = Object.keys(byIss).sort((x, y) => (Number((issMap[x] || {}).issue_number) || 0) - (Number((issMap[y] || {}).issue_number) || 0));
  const out = [];
  ids.forEach(id => {
    const ln = ipoLine(byIss[id]);
    if (!ln.length) return;
    out.push(_ibHdrLine(issMap[id] || { issue_number: '' }), ...ln);
  });
  return out;
}
/* שורת פריט אחת למודעה בחשבונית החודשית */
function _mbLine(a, issMap) {
  const iss = issMap[a.issue_id] || {};
  const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || '';
  const lbl = (typeof _ibLabel === 'function') ? _ibLabel : (t => t || 'מודעה');
  return { details: lbl(a.title) + (sz ? ' · ' + sz : '') + ' — גיליון ' + iss.issue_number + (a.page_number ? ' — עמוד ' + a.page_number : ''), amount: 1, price: Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) };
}

/* הפקת חשבוניות חודשיות לחודש (YYYY-MM) — הפקה מרוכזת (משמש כגיבוי; הכפתור מפנה לאישור פרטני) */
async function monthlyBillingRun(ym) {
  ym = ym || thisMonth(); // חודש מקומי — UTC נתן את החודש הקודם בליל ה-1
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
  const done = await _mbDoneSet(ym); // לא מפיקים שוב למי שכבר הופק — בכל סוג מסמך
  const docDate = _mbDocDate(ym); // תאריך המסמך = סוף החודש (ואם שבת — יומיים קודם)
  let count = 0;
  const mkLine = a => { const iss = issMap[a.issue_id] || {}; const sz = (typeof nameOf === 'function' ? nameOf('priceList', a.price_item_id) : '') || ''; return { details: lbl(a.title) + (sz ? ' · ' + sz : '') + ' — גיליון ' + iss.issue_number + (a.page_number ? ' — עמוד ' + a.page_number : ''), amount: 1, price: Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) }; };
  for (const cid of monthly) {
    const cAds = ads.filter(a => a.customer_id === cid && _mbBillable(a));
    if (!cAds.length) continue;
    const cust = (cache.customers || []).find(c => c.id === cid) || {};
    const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
    // לקוח עם פיצול לפי סוגי מודעות (מסומן בכרטיס) → חשבונית לכל סוג; שאר הלקוחות → חשבונית אחת כרגיל
    const isCenter = ecIsCenter(cid);
    const groups = {};
    if (isCenter) ecCatKeys(cid).forEach(k => { groups[k] = cAds.filter(a => ecCatOfAd(a) === k); });
    else groups.regular = cAds;
    for (const gk of Object.keys(groups)) {
      const lines = isPagesOnlyCustomer(cid) ? ipoMonthlyLines(groups[gk], issMap) : groups[gk].map(mkLine).filter(it => it.price > 0);
      if (!lines.length) continue;
      if (_mbIsDone(done, ym, cid, isCenter ? gk : '')) continue; // כבר חויב החודש
      const sfx = _ecSfx(cid, gk, isCenter);
      const header = 'חיוב חודשי — ' + ym + (sfx ? ' — ' + sfx : '');
      const items = isPagesOnlyCustomer(cid) ? lines : [{ details: header, amount: 1, price: 0 }, ...lines];
      const txn = _mbTxn(ym, cid, docKind, isCenter ? gk : '');
      await invCall({ customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: docDate, transaction_id: txn, comment: 'חיוב חודשי ' + ym + (sfx ? ' (' + sfx + ')' : ''), ad_ids: groups[gk].map(a => a.id) });
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
        if (r && r.emailed) toast('✅ גזירי החודש נשלחו למייל');
        else if (r && r.downloaded) toast('⚠️ שליחת המייל נכשלה' + (r.emailError ? ' — ' + r.emailError : '') + ' — הורדתי לך את הגזירים', true);
        else toast('הגזירים מוכנים');
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
  ym = ym || thisMonth(); // חודש מקומי — UTC נתן את החודש הקודם בליל ה-1
  const monthly = mbList();
  if (!monthly.length) { toast('אין לקוחות בחיוב חודשי', true); return; }
  // קיבוץ לפי חודש הסגירה לדפוס (print_date), עם נפילה ל-publish_date בגיליונות ישנים
  const _effM = (i) => ((i.print_date || i.publish_date) || '').slice(0, 7);
  const _allIss = await run(db.from('issues').select('id,issue_number,publish_date,print_date'));
  const issues = (_allIss || []).filter(i => _effM(i) === ym);
  if (!issues.length) { toast('אין גיליונות לחודש ' + ym, true); return; }
  const issMap = {}; issues.forEach(i => issMap[i.id] = i);
  const ads = await run(db.from('ads').select('*').in('issue_id', issues.map(i => i.id)).in('customer_id', monthly).not('status', 'in', '("cancelled","rejected")'));
  const done = await _mbDoneSet(ym);
  _mbCtx = { ym, issMap, ads, done };
  _mbClipsSent = new Set();
  const rows = [];
  for (const cid of monthly) {
    const cAds = ads.filter(a => a.customer_id === cid);
    if (!cAds.length) continue;
    const cust = (cache.customers || []).find(c => c.id === cid) || {};
    const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
    const isCenter = ecIsCenter(cid);
    const groups = isCenter ? ecCatKeys(cid) : ['regular'];
    let _first = true;
    for (const gk of groups) {
      const gAds = isCenter ? cAds.filter(a => ecCatOfAd(a) === gk) : cAds;
      const _net = a => Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
      const openAds = gAds.filter(_mbBillable);
      const total = openAds.reduce((s, a) => s + _net(a), 0);
      const billedTotal = gAds.filter(a => !_mbBillable(a)).reduce((s, a) => s + _net(a), 0);
      if (!(total > 0) && !(billedTotal > 0)) continue;
      const txn = _mbTxn(ym, cid, docKind, isCenter ? gk : '');
      // "הופק?" — מזהים כל סוג מסמך (חשבון עסקה / חשבונית מס), כי המשתמש יכול לבחור סוג בבורר
      const _docDone = _mbIsDone(done, ym, cid, isCenter ? gk : '');
      // חויב במלואו = אין מודעה פתוחה. יש חשבונית חודשית ועדיין מודעות פתוחות → חיוב השלמה
      const _isDone = !(total > 0);
      const _cRec = (cache.customers || []).find(c => c.id === cid) || {};
      rows.push({ cid, gk, isCenter, catHe: isCenter ? ecCatLabel(cid, gk) : '', catIdx: groups.indexOf(gk), firstOfCust: (() => { const f = _first; _first = false; return f; })(), total, count: openAds.length, billedCount: gAds.length - openAds.length, txn, done: _isDone, supp: _docDone && !_isDone, name: nameOf('customers', cid), email: (_cRec.email || '').trim() });
    }
  }
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he') || a.cid - b.cid || a.catIdx - b.catIdx);
  const listRows = rows.map(r => `<tr>
      <td><b>${esc(r.name)}</b>${r.isCenter ? ` <span style="font-size:.78rem;color:${r.catIdx ? '@@COLOR_BRAND@@' : '#6b7280'}">· ${esc(r.catHe)}</span>` : ''}${(r.isCenter && r.firstOfCust) ? ` <button class="btn btn-sm btn-ghost" style="padding:1px 7px;font-size:.75rem" onclick="ecCatsModalMonth('${ym}', ${r.cid})" title="בדיקה ותיקון של סוג כל מודעה לפני ההפקה">🏷️ סיווג</button>` : ''}</td>
      <td>${r.count}${r.billedCount ? ` <span class="muted" style="font-size:.78rem">(+${r.billedCount} חויבו)</span>` : ''}</td>
      <td>${money(r.total)}</td>
      <td>${r.done ? '<span class="pill green">חויב ✓</span>' : r.supp
        ? `<span class="pill green" title="הופקה חשבונית חודשית">חויב ✓</span> <button class="btn btn-sm" onclick="monthlyBillingPreviewOne('${ym}',${r.cid},'${r.gk}')" title="מודעות שנוספו אחרי החשבונית החודשית">➕ השלמה (${r.count})</button>`
        : `<button class="btn btn-sm" onclick="monthlyBillingPreviewOne('${ym}',${r.cid},'${r.gk}')">תצוגה והפקה</button>`}
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
  const cAds = ctx.ads.filter(a => a.customer_id === cid && (!isCenter || ecCatOfAd(a) === gk) && _mbBillable(a));
  const lines = isPagesOnlyCustomer(cid) ? ipoMonthlyLines(cAds, ctx.issMap) : cAds.map(a => _mbLine(a, ctx.issMap)).filter(it => it.price > 0);
  if (!lines.length) { toast('אין מה לחייב', true); return; }
  const total = lines.reduce((s, it) => s + it.amount * it.price, 0);
  const _supp = _mbIsDone(ctx.done, ym, cid, isCenter ? gk : '');
  const docKind = cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma';
  _mbKind = docKind; // ברירת מחדל לסוג המסמך
  document.getElementById('viewModal').innerHTML = `
    <h3>תצוגה מקדימה — ${esc(nameOf('customers', cid))}${isCenter ? ' · ' + esc(ecCatLabel(cid, gk)) : ''}</h3>
    <p class="muted" style="font-size:.85rem">חיוב חודשי ${ym} · תאריך המסמך: ${_mbDocDate(ym)}</p>
    ${_supp ? `<div style="margin-top:6px;padding:8px 10px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;font-size:.85rem">➕ <b>חיוב השלמה</b> — ללקוח כבר הופקה חשבונית חודשית ל-${ym}. כאן רק המודעות שנוספו אחריה ועוד לא חויבו.</div>` : ''}
    <div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>פירוט</th><th>מחיר</th></tr></thead><tbody>
      ${lines.map(it => `<tr><td>${esc(it.details)}</td><td>${it.price ? money(it.price) : ''}</td></tr>`).join('')}
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
  const cAds = _mbCtx.ads.filter(a => a.customer_id === cid && (!isCenter || ecCatOfAd(a) === gk) && _mbBillable(a));
  const lines = isPagesOnlyCustomer(cid) ? ipoMonthlyLines(cAds, _mbCtx.issMap) : cAds.map(a => _mbLine(a, _mbCtx.issMap)).filter(it => it.price > 0);
  if (!lines.length) { toast('אין מה לחייב', true); return; }
  const sfx = _ecSfx(cid, gk, isCenter);
  const docKind = _mbKind || (cust.order_doc_type === 'tax_invoice' ? 'tax_invoice' : 'proforma');
  // בדיקה טרייה מול המסד ממש לפני ההפקה — גם בסוג מסמך אחר וגם ממכשיר אחר.
  // כבר הופקה חשבונית חודשית → זה חיוב השלמה: רק המודעות הפתוחות, במזהה עסקה נפרד
  const _doneNow = await _mbDoneSet(ym);
  const _supp = _mbIsDone(_doneNow, ym, cid, isCenter ? gk : '');
  if (_supp) {
    const { data: _fresh } = await db.from('ads').select('id,deal_stage').in('id', cAds.map(a => a.id));
    const _stillOpen = new Set((_fresh || []).filter(_mbBillable).map(a => a.id));
    if (cAds.some(a => !_stillOpen.has(a.id))) {
      toast('חלק מהמודעות כבר חויבו בינתיים — מרענן', true);
      monthlyBillingReview(ym);
      return;
    }
  }
  const header = (_supp ? 'חיוב השלמה — ' : 'חיוב חודשי — ') + ym + (sfx ? ' — ' + sfx : '');
  const items = isPagesOnlyCustomer(cid) ? lines : [{ details: header, amount: 1, price: 0 }, ...lines];
  const txn = _supp ? _mbSuppTxn(ym, cid, docKind, isCenter ? gk : '', cAds) : _mbTxn(ym, cid, docKind, isCenter ? gk : '');
  document.getElementById('viewBack').classList.remove('open');
  const _doc = await invCall({ customer_id: cid, doc_kind: docKind, items, vat_included: false, doc_date: _mbDocDate(ym), transaction_id: txn, comment: (_supp ? 'חיוב השלמה ' : 'חיוב חודשי ') + ym + (sfx ? ' (' + sfx + ')' : ''), ad_ids: cAds.map(a => a.id) });
  if (_supp) { await monthlyBillingReview(ym); return; } // הגזירים החודשיים כבר נשלחו בהפקה החודשית
  // ההפקה נכשלה — לא שולחים ללקוח גזירים על חשבונית שלא קיימת
  if (!(_doc && _doc.ok)) { await monthlyBillingReview(ym); return; }
  try {
    if (isCenter) {
      // פיצול לפי סוגי מודעות: מייל לכל סוג עם הגזירים שלו ומספר החשבונית — לכתובת של הסוג,
      // ואם לא הוגדרה לו כתובת — למייל הרגיל של הלקוח
      const _catHe = ecCatLabel(cid, gk);
      const _to = ecEmailOf(cid, gk);
      const _catAds = cAds.map(a => a.id);
      const _issueIds = [...new Set(cAds.map(a => a.issue_id))];
      const _catKey = cid + '|' + ym + '|' + gk;
      if (typeof adProofSendMonth === 'function' && _issueIds.length && !_mbClipsSent.has(_catKey)) {
        _mbClipsSent.add(_catKey);
        toast('מכין מייל לסוג ' + _catHe + '...');
        const _num = _doc.document && _doc.document.doc_number ? _doc.document.doc_number : '';
        const _o = { ad_ids: _catAds, category_he: _catHe, note: 'חשבונית' + (_num ? " מס' " + _num : '') + ' — ' + _catHe, invoice: _doc.document ? { doc_number: _doc.document.doc_number, doc_uuid: _doc.document.doc_uuid } : null };
        if (_to) _o.to_email = _to;
        const _r = await adProofSendMonth(cid, _issueIds, ym, _o);
        if (_r && _r.emailed) toast('✅ נשלח מייל — ' + _catHe);
        else if (_r && _r.downloaded && !_r.email) toast('ℹ️ ' + _catHe + ': אין מייל ללקוח — הורדתי לך את הגזירים');
        else toast('ℹ️ ' + _catHe + ': המייל לא אושר' + (_r && _r.emailError ? ' — ' + _r.emailError : '') + ' — בדוק', true);
      }
    } else {
      // שולח ללקוח מייל אחד עם כל גזירי הפרסום שלו מהחודש (פעם אחת בלבד)
      const _key = cid + '|' + ym;
      const _allAds = (_mbCtx && _mbCtx.ads || []).filter(a => a.customer_id === cid);
      const _issueIds = [...new Set(_allAds.map(a => a.issue_id))];
      if (typeof adProofSendMonth === 'function' && _issueIds.length && !_mbClipsSent.has(_key)) {
        _mbClipsSent.add(_key);
        toast('מכין גזירי החודש...');
        const _r = await adProofSendMonth(cid, _issueIds, ym);
        if (_r && _r.emailed) toast('✅ גזירי החודש נשלחו ללקוח במייל אחד');
        else if (_r && _r.downloaded && !_r.email) toast('ℹ️ אין מייל ללקוח — הורדתי לך את גזירי החודש');
        else if (_r && _r.downloaded) toast('⚠️ שליחת המייל נכשלה' + (_r.emailError ? ' — ' + _r.emailError : '') + ' — הורדתי לך את גזירי החודש', true);
        else toast('גזירי החודש מוכנים');
      }
    }
  } catch (e) { toast('הערה: שליחת מייל החודש נכשלה — ' + (e && e.message || e), true); }
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
            // בתוך לשונית "כספים" (אם קיימת), אחרת בתחתית הכרטיס
            const host = document.getElementById('ccBilling') || modal;
            host.appendChild(div);
            const po = isPagesOnlyCustomer(id);
            const div2 = document.createElement('div');
            div2.style.cssText = div.style.cssText;
            div2.innerHTML = `<span><b>פירוט בחשבונית:</b> ${po ? '<span class="pill amber">מקוצר — "גיליון X — תאריך" + "פרסום (עמודים)"</span>' : 'מלא — שורה לכל מודעה'}</span>
              <button class="btn btn-sm ${po ? 'btn-ghost' : ''}" onclick="togglePagesOnlyInvoice(${id})">${po ? 'חזרה לפירוט מלא' : '🧾 פירוט מקוצר'}</button>`;
            host.appendChild(div2);
            // פיצול לפי סוגי מודעות: שורה בלשונית כספים כשפעיל; כשכבוי — רק פריט בתפריט "פעולות"
            if (ecIsCenter(id)) {
              const em = ecEmails(id);
              const cats = ecCats(id);
              const chips = cats.map(c => `<span class="pill amber">${esc(c.he)}</span>`).join(' ');
              const emTxt = cats.map(c => esc(c.he) + ': ' + (em[c.k] ? `<span dir="ltr">${esc(em[c.k])}</span>` : 'המייל של הלקוח')).join(' · ');
              const div3 = document.createElement('div');
              div3.style.cssText = div.style.cssText;
              div3.innerHTML = `<span><b>חשבונית נפרדת לכל סוג מודעה:</b> ${chips}<br><span style="font-size:.82rem;color:#64748b">${emTxt}</span></span>
                <span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm" onclick="ecCatsEdit(${id})">✏️ סוגים ומיילים</button><button class="btn btn-sm btn-ghost" onclick="ecToggleSplit(${id})">ביטול פיצול</button></span>`;
              host.appendChild(div3);
            } else {
              const menu = document.getElementById('ccMoreMenu');
              if (menu && !document.getElementById('ecSplitBtn')) {
                const btn = `<button id="ecSplitBtn" class="btn" onclick="ccMenuClose();ecToggleSplit(${id})">🏷️ חשבונית נפרדת לכל סוג מודעה</button>`;
                const sep = menu.querySelector('.cc-msep'); // מעל קו ההפרדה של "מחיקת לקוח"
                if (sep) sep.insertAdjacentHTML('beforebegin', btn); else menu.insertAdjacentHTML('beforeend', btn);
              }
            }
          }
        }
      } catch (e) { console.error('monthly-billing', e); }
      return r;
    };
    wrapped._mbWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
