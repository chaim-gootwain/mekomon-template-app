/* ============================================================
ad-proof.js — הוכחת פרסום (גזיר) בצד הלקוח
------------------------------------------------------------
- כפתור "🖼️ הוכחת פרסום" בחיוב הגיליון, לכל לקוח.
- מוריד את PDF הגיליון מ-issues-archive (signed URL),
  חותך בדפדפן את עמודי המודעות של הלקוח (pdf-lib),
  ופותח/מוריד PDF להוכחה — עובד מיד, בלי תלות בפונקציית המייל.
- pdf-lib נטען על פי דרישה מ-js/vendor/pdf-lib.min.js (window.PDFLib).
============================================================ */

'use strict';

let _apLibPromise = null;
function _apEnsureLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (_apLibPromise) return _apLibPromise;
  _apLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/pdf-lib.min.js';
    s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib לא נטען'));
    s.onerror = () => reject(new Error('טעינת pdf-lib נכשלה'));
    document.head.appendChild(s);
  });
  return _apLibPromise;
}

async function _apIssue(issueId) {
  const cached = (typeof cache !== 'undefined' && cache.issues || []).find(i => i.id === issueId);
  if (cached && 'pdf_path' in cached) return cached;
  return await run(db.from('issues').select('id,issue_number,pdf_path').eq('id', issueId).single());
}

/* עמודי המודעות של הלקוח בגיליון */
async function _apPages(issueId, customerId) {
  const ads = await run(db.from('ads').select('page_number')
    .eq('issue_id', issueId).eq('customer_id', customerId)
    .not('status', 'in', '("cancelled","rejected")'));
  return [...new Set((ads || []).map(a => a.page_number).filter(p => p))].sort((a, b) => a - b);
}

/* מיפוי אוטומטי: מספר עמוד עיתון -> {idx עמוד ב-PDF, half}.
   מזהה פריסת כפולות (spreads): עמוד PDF רחב = שני עמודי עיתון (RTL: הנמוך בימין).
   עמוד PDF יחיד (portrait) = עמוד עיתון אחד. עובד גם ל-PDF מפוצל ל-40 עמודים. */
function _apPageMap(src) {
  const map = {}; let np = 1;
  const total = src.getPageCount();
  for (let idx = 0; idx < total; idx++) {
    const pg = src.getPage(idx);
    const b = pg.getMediaBox();
    let rot = 0; try { rot = (pg.getRotation() && pg.getRotation().angle) || 0; } catch (e) { }
    const landscape = (b.width / b.height) > 1.15;
    if (landscape && (rot % 180 === 0)) {
      // כפולה: חצי ימין = העמוד הנמוך (RTL), חצי שמאל = הגבוה
      map[np] = { idx, half: 'right' };
      map[np + 1] = { idx, half: 'left' };
      np += 2;
    } else {
      map[np] = { idx, half: 'full' };
      np += 1;
    }
  }
  return { map, pageCount: np - 1 };
}

/* בונה PDF הוכחה (העמודים הרלוונטיים) ומחזיר Uint8Array */
async function _apBuild(issueId, customerId) {
  const issue = await _apIssue(issueId);
  if (!issue || !issue.pdf_path) throw new Error('עדיין לא הועלה PDF לגיליון זה');
  const pages = await _apPages(issueId, customerId);
  if (!pages.length) throw new Error('אין עמודים למודעות הלקוח בגיליון');

  const { data: signed, error: sErr } = await db.storage.from('issues-archive').createSignedUrl(issue.pdf_path, 600);
  if (sErr || !signed) throw new Error('אין גישה ל-PDF: ' + (sErr && sErr.message || ''));
  const resp = await fetch(signed.signedUrl);
  if (!resp.ok) throw new Error('הורדת ה-PDF נכשלה (' + resp.status + ')');
  const srcBytes = new Uint8Array(await resp.arrayBuffer());

  const PDFLib = await _apEnsureLib();
  const src = await PDFLib.PDFDocument.load(srcBytes);
  const { map, pageCount } = _apPageMap(src);

  const out = await PDFLib.PDFDocument.create();
  const used = [], missing = [];
  for (const N of pages) {
    const e = map[N];
    if (!e) { missing.push(N); continue; }
    const [cp] = await out.copyPages(src, [e.idx]);
    if (e.half !== 'full') {
      const b = cp.getMediaBox();
      if (e.half === 'right') { cp.setMediaBox(b.x + b.width / 2, b.y, b.width / 2, b.height); cp.setCropBox(b.x + b.width / 2, b.y, b.width / 2, b.height); }
      else { cp.setMediaBox(b.x, b.y, b.width / 2, b.height); cp.setCropBox(b.x, b.y, b.width / 2, b.height); }
    }
    out.addPage(cp);
    used.push(N);
  }
  if (!used.length) throw new Error('מספרי העמודים (' + pages.join(', ') + ') לא נמצאו ב-PDF (' + pageCount + ' עמ\')');
  const bytes = await out.save();
  return { bytes, pages: used, missing, issueNumber: issue.issue_number };
}

/* פותח את הוכחת הפרסום בכרטיסייה + מוריד קובץ מעוצב-שם */
async function adProofOpen(issueId, customerId) {
  try {
    if (typeof toast === 'function') toast('מכין הוכחת פרסום...');
    const { bytes, pages, issueNumber } = await _apBuild(Number(issueId), Number(customerId));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const custName = (typeof nameOf === 'function') ? nameOf('customers', Number(customerId)) : '';
    const fname = `הוכחת_פרסום_גיליון_${issueNumber}${custName ? '_' + custName : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '_');

    const w = window.open(url, '_blank');
    if (!w) {
      // חלון קופץ נחסם — הורדה ישירה
      const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    }
    if (typeof toast === 'function') toast('✅ הוכחת פרסום מוכנה (עמוד ' + pages.join(', ') + ')');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (typeof toast === 'function') toast('לא נוצרה הוכחה: ' + (e && e.message || e), true);
    console.error('ad-proof', e);
  }
}

/* מוריד ישירות (בלי לפתוח כרטיסייה) — לשימוש עתידי / כפתור משני */
async function adProofDownload(issueId, customerId) {
  try {
    if (typeof toast === 'function') toast('מכין הוכחת פרסום...');
    const { bytes, pages, issueNumber } = await _apBuild(Number(issueId), Number(customerId));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const custName = (typeof nameOf === 'function') ? nameOf('customers', Number(customerId)) : '';
    const fname = `הוכחת_פרסום_גיליון_${issueNumber}${custName ? '_' + custName : ''}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    if (typeof toast === 'function') toast('✅ הורד (עמוד ' + pages.join(', ') + ')');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    if (typeof toast === 'function') toast('לא נוצרה הוכחה: ' + (e && e.message || e), true);
    console.error('ad-proof', e);
  }
}

/* ---------- גזירי החודש ---------- */
/* מוריד PDF מ-base64 */
function _apDownloadB64(b64, fname) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = String(fname).replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* בונה (בצד השרת) את כל גזירי הלקוח לחודש, שולח במייל ו/או מוריד.
   opts.email (ברירת מחדל true) — לשלוח במייל · opts.download — להוריד.
   אם התבקש מייל אבל אין ללקוח כתובת / השליחה נכשלה — יורד אוטומטית. */
async function adProofSendMonth(customerId, issueIds, ym, opts) {
  opts = opts || {};
  const wantEmail = opts.email !== false;
  const { data, error } = await db.functions.invoke('send-clip-month', { body: { customer_id: customerId, issue_ids: issueIds, ym, send_email: wantEmail } });
  if (error) { let d = ''; try { if (error.context && error.context.json) { const j = await error.context.json(); d = j.detail || j.error || ''; } } catch (e) { } throw new Error(d || error.message || 'שליחה נכשלה'); }
  if (data && data.pdf_b64 && (opts.download || (wantEmail && !data.emailed))) {
    _apDownloadB64(data.pdf_b64, 'גזירי_החודש_' + ym + '.pdf');
    data.downloaded = true;
  }
  return data;
}
