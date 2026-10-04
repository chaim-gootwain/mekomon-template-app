/* ============================================================
   preprint-check.js — בדיקת גיליון לפני דפוס (שלב 1 של "בני")
   ------------------------------------------------------------
   משלים את print-verify.js (שרץ אחרי הדפוס). כאן בודקים לפני ששולחים לדפוס:
   1. התאמה לעימוד (בלי PDF): מודעה בעימוד שלא אושרה בוועדה, מודעה מאושרת
      שלא שובצה, מודעה משובצת בלי קובץ עיצוב, עמוד שגולש מעל 100%.
   2. רזולוציה (עם ה-PDF הסופי מהגרפיקאית): לכל תמונה בגיליון מחושבת
      הרזולוציה האפקטיבית לפי הגודל שבו היא מודפסת בפועל (pdf.js operator
      list + מטריצת הטרנספורמציה). ספים מכוילים לגיליון 306 (ר' למטה).
   3. זיהוי מודעה בעמוד: חיפוש שם הלקוח / הטלפון בטקסט של העמוד, וסקירה
      ויזואלית של העמוד מול קבצי העיצוב שהמערכת מצפה להם.
   תוצר: דוח מוכן/לא מוכן + רשימת תיקונים להעתקה לגרפיקאית.
   האישור הסופי לדפוס נשאר של המנהל (נשמר ב-settings: pp_ok_<מספר גיליון>).
   קובץ ה-PDF נקרא מקומית בלבד — לא מועלה לאחסון (כדי לא לבלבל את print-verify).
   מסתמך על: _pvEnsurePdfJs (print-verify.js), _adFraction/_adLabel (issues.js).
   ============================================================ */
'use strict';

/* כיול לפי גיליון 306 (תקין, נקבע כסטנדרט 4.10.2026): דפוס עיתון סופג 100–140 DPI
   בלי פגיעה נראית. רקעים (מטושטשים מטבעם) ופסים דקים לא נבדקים כתמונות תוכן. */
const PP_DPI_BAD = 80;          // מתחת לזה — מפוקסל בדפוס
const PP_DPI_WARN = 95;         // מתחת לזה — גבולי
const PP_DPI_BG_BAD = 40;       // רקע: רק אם נמוך באופן קיצוני
const PP_DPI_COMPRESSED = 150;  // רוב התמונות מתחת לזה = קובץ דחוס ולא קובץ דפוס
const PP_BG_COVER = 0.6;        // תמונה שמכסה יותר מזה מהעמוד = רקע
const PP_STRIP_CM = 1;          // צלע קצרה מזה = פס/קישוט
const PP_MIN_AREA_PT2 = 28 * 28; // מתעלמים מתמונות זעירות (~1x1 ס"מ): אייקונים, קישוטים
const PP_OK_STATUSES = ['approved', 'placed', 'published'];

let _ppState = null;

function _ppKey(n) { return 'pp_ok_' + n; }
function _ppClose() { _ppRelease(); document.getElementById('viewBack').classList.remove('open'); }

/* שחרור הקובץ אחרי כל בדיקה: קבצי גיליון שוקלים עשרות מ"ב, ולא נשמרים בשום מקום.
   הורסים את מסמך pdf.js (משחרר את ה-worker והזיכרון) ומאפסים את המצב. */
function _ppRelease() {
  const st = _ppState; if (!st) return;
  if (st.pdf && st.pdf.doc) { try { st.pdf.doc.destroy(); } catch (e) { } }
  if (st.pdf) { st.pdf.thumbs = null; st.pdf = null; }
  const f = document.getElementById('ppFile'); if (f) f.value = '';
  _ppState = null;
}

/* ---------- כניסה ---------- */
async function openPreprintCheck(issueId) {
  _ppRelease();
  try {
    toast('טוען את נתוני הגיליון...');
    const issue = (cache.issues || []).find(i => i.id === issueId) || await run(db.from('issues').select('*').eq('id', issueId).single());
    if (!issue) { toast('גיליון לא נמצא', true); return; }
    const ads = await run(db.from('ads').select('id,customer_id,title,page_number,status,price_item_id,is_system')
      .eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")'));
    const ids = (ads || []).map(a => a.id);
    const files = ids.length ? await run(db.from('ad_files').select('ad_id,storage_path,file_name,kind').in('ad_id', ids).eq('kind', 'design')) : [];
    const design = {}; (files || []).forEach(f => { if (!design[f.ad_id]) design[f.ad_id] = f; });
    _ppState = { issue, ads: ads || [], design, data: _ppDataChecks(ads || [], design), pdf: null };
    _ppRender();
  } catch (e) { toast('שגיאה: ' + (e && e.message || e), true); }
}

/* ---------- 1. בדיקות נתונים (בלי PDF) ---------- */
function _ppDataChecks(ads, design) {
  const out = { bad: [], warn: [], ok: 0 };
  const fill = {};
  ads.forEach(a => {
    const placed = a.page_number > 0;
    const st = (STATUS.ad[a.status] || [a.status])[0];
    if (placed) fill[a.page_number] = (fill[a.page_number] || 0) + _adFraction(a);
    if (placed && !PP_OK_STATUSES.includes(a.status)) {
      out.bad.push({ ad: a, page: a.page_number, msg: `משובצת בעמוד ${a.page_number} אבל לא אושרה בוועדה (סטטוס: ${st})` });
    } else if (!placed && a.status === 'approved') {
      out.warn.push({ ad: a, msg: 'אושרה ולא שובצה בעימוד — אמורה להיכנס לגיליון?' });
    } else if (placed && !a.is_system && !design[a.id]) {
      out.warn.push({ ad: a, page: a.page_number, msg: `בעמוד ${a.page_number} — אין קובץ עיצוב סופי במערכת, אי אפשר לוודא שזו הגרסה הנכונה` });
    } else if (placed) out.ok++;
  });
  Object.keys(fill).forEach(p => {
    if (fill[p] > 1.001) out.warn.push({ page: +p, msg: `עמוד ${p} מלא ב-${Math.round(fill[p] * 100)}% — יותר ממה שנכנס בעמוד` });
  });
  return out;
}

/* ---------- 2+3. ניתוח ה-PDF הסופי ---------- */
async function _ppAnalyzeFile() {
  const st = _ppState; if (!st) return;
  const file = (document.getElementById('ppFile') || {}).files && document.getElementById('ppFile').files[0];
  if (!file) { toast('נא לבחור את קובץ ה-PDF הסופי', true); return; }
  try {
    document.getElementById('ppPdfBox').innerHTML = '<p class="muted">מנתח את הגיליון... (עשוי לקחת דקה בגיליון גדול)</p>';
    await _pvEnsurePdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const map = await _ppPageMap(doc);
    const images = [], text = {};
    for (let idx = 0; idx < doc.numPages; idx++) {
      const page = await doc.getPage(idx + 1);
      const vp = page.getViewport({ scale: 1 });
      const halves = map.byIdx[idx];
      for (const im of await _ppPageImages(page)) {
        const cx = (im.cx - page.view[0]) / vp.width;
        const h = halves.length === 1 ? halves[0] : halves[cx >= 0.5 ? 0 : 1]; // RTL: ימין = העמוד הנמוך
        // סיווג: פס דקורטיבי / רקע / תמונת תוכן (שטח העמוד = חצי דף בכפולה)
        const pageArea = (vp.width / halves.length) * vp.height;
        const cover = ((im.x1 - im.x0) * (im.y1 - im.y0)) / pageArea;
        const beyond = im.x0 < page.view[0] - 14 || im.y0 < page.view[1] - 14 || im.x1 > page.view[2] + 14 || im.y1 > page.view[3] + 14;
        const kind = Math.min(+im.cmW, +im.cmH) < PP_STRIP_CM ? 'strip' : (cover > PP_BG_COVER || beyond) ? 'background' : 'content';
        images.push({ ...im, page: h.n, idx, kind });
      }
      // שכבת רקע: תמונה שתמונה אחרת צוירה מעליה על 25%+ משטחה (רקע של מודעה, לא תוכן)
      const onPage = images.filter(x => x.idx === idx);
      onPage.forEach((a, i) => {
        if (a.kind !== 'content') return;
        const area = (a.x1 - a.x0) * (a.y1 - a.y0);
        const covered = onPage.slice(i + 1).some(b => {
          const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), hh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          return w > 0 && hh > 0 && (w * hh) / area >= 0.25;
        });
        if (covered) a.kind = 'background';
      });
      const tc = await page.getTextContent();
      tc.items.forEach(it => {
        const x = ((it.transform ? it.transform[4] : 0) - page.view[0]) / vp.width;
        const h = halves.length === 1 ? halves[0] : halves[x >= 0.5 ? 0 : 1];
        text[h.n] = (text[h.n] || '') + ' ' + it.str;
      });
    }
    st.pdf = { doc, map, images, text, pageCount: map.pageCount, thumbs: {} };
    _ppRender();
  } catch (e) {
    console.error('preprint', e);
    document.getElementById('ppPdfBox').innerHTML = `<p style="color:#b91c1c">לא הצלחתי לקרוא את ה-PDF: ${esc(e && e.message || e)}</p>`;
  }
}

/* עמוד עיתון ↔ עמוד PDF (כולל כפולות RTL), כמו _apPageMap אבל על pdf.js */
async function _ppPageMap(doc) {
  const byIdx = {}, byPage = {}; let n = 1;
  for (let idx = 0; idx < doc.numPages; idx++) {
    const p = await doc.getPage(idx + 1);
    const w = p.view[2] - p.view[0], h = p.view[3] - p.view[1];
    if (w / h > 1.15 && (p.rotate || 0) % 180 === 0) {
      byIdx[idx] = [{ n, half: 'right' }, { n: n + 1, half: 'left' }];
      byPage[n] = { idx, half: 'right' }; byPage[n + 1] = { idx, half: 'left' }; n += 2;
    } else { byIdx[idx] = [{ n, half: 'full' }]; byPage[n] = { idx, half: 'full' }; n += 1; }
  }
  return { byIdx, byPage, pageCount: n - 1 };
}

/* כל התמונות בעמוד + הגודל שבו הן מודפסות → DPI אפקטיבי */
async function _ppPageImages(page) {
  const OPS = window.pdfjsLib.OPS;
  const ol = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; const out = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const pw = fn === OPS.paintImageXObject ? args[1] : args[0] && args[0].width;
      const ph = fn === OPS.paintImageXObject ? args[2] : args[0] && args[0].height;
      if (!pw || !ph) continue;
      const wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);
      if (wPt * hPt < PP_MIN_AREA_PT2) continue;
      const dpi = Math.min(pw / (wPt / 72), ph / (hPt / 72));
      // ריבוע היחידה של התמונה → מלבן בעמוד (נקודות)
      const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
      const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
      out.push({ dpi: Math.round(dpi), px: pw + '×' + ph, cmW: (wPt / 72 * 2.54).toFixed(1), cmH: (hPt / 72 * 2.54).toFixed(1),
        x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), cx: (Math.min(...xs) + Math.max(...xs)) / 2 });
    }
  }
  return out;
}

/* האם המודעה מזוהה בטקסט של העמוד (שם לקוח / 7 ספרות אחרונות של הטלפון) */
function _ppFindAd(a, text) {
  if (a.is_system) return null;
  const c = (cache.customers || []).find(x => x.id === a.customer_id) || {};
  const norm = s => String(s || '').replace(/["'״׳\-\s]+/g, '');
  const name = norm(c.name), phone = String(c.phone || '').replace(/\D/g, '').slice(-7);
  const hit = t => { const tn = norm(t); const td = String(t || '').replace(/\D/g, '');
    return (name.length >= 3 && tn.includes(name)) || (phone.length === 7 && td.includes(phone)); };
  if (hit(text[a.page_number])) return { here: true };
  const other = Object.keys(text).find(p => +p !== a.page_number && hit(text[p]));
  return other ? { here: false, other: +other } : { here: false };
}

/* ---------- תצוגה ---------- */
function _ppRow(icon, label, msg) {
  return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line,#e5e7eb);font-size:.88rem">
    <span>${icon}</span><div><b>${esc(label)}</b>${label ? ' — ' : ''}${esc(msg)}</div></div>`;
}

function _ppFindings() {
  const st = _ppState; const bad = [], warn = [];
  st.data.bad.forEach(f => bad.push({ page: f.page, label: f.ad ? _adLabel(f.ad) : '', msg: f.msg }));
  st.data.warn.forEach(f => warn.push({ page: f.page, label: f.ad ? _adLabel(f.ad) : '', msg: f.msg }));
  if (st.pdf) {
    const placed = st.ads.filter(a => a.page_number > 0);
    const maxPage = Math.max(0, ...placed.map(a => a.page_number));
    if (maxPage > st.pdf.pageCount) bad.push({ page: maxPage, label: '', msg: `בעימוד יש ${maxPage} עמודים אבל בקובץ רק ${st.pdf.pageCount}` });
    const imgs = st.pdf.images, low = imgs.filter(im => im.dpi < PP_DPI_COMPRESSED);
    if (imgs.length >= 10 && low.length / imgs.length > 0.5) {
      // רוב הקובץ ברזולוציה נמוכה — כמעט בוודאות גרסה דחוסה (לקוראים/מייל) ולא קובץ הדפוס
      bad.push({ page: 0, label: '', msg: `${low.length} מתוך ${imgs.length} התמונות בקובץ מתחת ל-${PP_DPI_COMPRESSED} DPI — נראה שזה קובץ דחוס ולא קובץ הדפוס. בקש מהגרפיקאית את קובץ הדפוס המלא ובדוק שוב` });
    } else {
      // שורה אחת לכל עמוד: כמה תמונות בעייתיות והגרועה שבהן
      const perPage = {};
      const isBad = im => im.kind === 'background' ? im.dpi < PP_DPI_BG_BAD : im.dpi < PP_DPI_BAD;
      const isWarn = im => im.kind === 'content' && im.dpi < PP_DPI_WARN;
      imgs.filter(im => im.kind !== 'strip' && (isBad(im) || isWarn(im))).forEach(im => {
        const g = perPage[im.page] || (perPage[im.page] = { bad: 0, warn: 0, worst: im });
        if (isBad(im)) g.bad++; else g.warn++;
        if (im.dpi < g.worst.dpi) g.worst = im;
      });
      Object.keys(perPage).forEach(pg => {
        const g = perPage[pg], w = g.worst;
        const worst = `הגרועה: ${w.cmW}×${w.cmH} ס"מ, ${w.dpi} DPI (${w.px} פיקסלים)`;
        if (g.bad) bad.push({ page: +pg, label: '', msg: `עמוד ${pg} — ${g.bad} תמונות יצאו מפוקסלות בדפוס; ${worst}` });
        else warn.push({ page: +pg, label: '', msg: `עמוד ${pg} — ${g.warn} תמונות ברזולוציה גבולית; ${worst}` });
      });
    }
    placed.forEach(a => {
      const r = _ppFindAd(a, st.pdf.text);
      if (r && !r.here && r.other) bad.push({ page: a.page_number, label: _adLabel(a), msg: `אמורה להיות בעמוד ${a.page_number} אבל נמצאה בטקסט של עמוד ${r.other}` });
    });
  }
  const byPage = (x, y) => (x.page || 0) - (y.page || 0);
  return { bad: bad.sort(byPage), warn: warn.sort(byPage) };
}

function _ppRender() {
  const st = _ppState; if (!st) return;
  const { bad, warn } = _ppFindings();
  const okAt = (cache.settings || {})[_ppKey(st.issue.issue_number)];
  const verdict = !st.pdf
    ? `<div style="padding:10px;border-radius:10px;background:#f1f5f9">📄 העלה את ה-PDF הסופי מהגרפיקאית כדי לבדוק פיקסול ושיבוץ בפועל.</div>`
    : bad.length
      ? `<div style="padding:10px;border-radius:10px;background:#fee2e2;color:#991b1b;font-weight:700">⛔ לא מוכן לדפוס — ${bad.length} בעיות לתיקון</div>`
      : `<div style="padding:10px;border-radius:10px;background:#dcfce7;color:#166534;font-weight:700">✅ לא נמצאו בעיות חוסמות${warn.length ? ` · ${warn.length} הערות לבדיקה` : ''}</div>`;
  const pdfBox = st.pdf
    ? `<div class="muted" style="font-size:.82rem">נבדקו ${st.pdf.pageCount} עמודים, ${st.pdf.images.length} תמונות. <a href="#" onclick="event.preventDefault();_ppPagesView()">סקירה ויזואלית עמוד מול מודעות ←</a></div>`
    : `<div class="field"><label>PDF סופי של הגיליון (לפני דפוס)</label><input id="ppFile" type="file" accept=".pdf"></div>
       <button class="btn btn-sm" onclick="_ppAnalyzeFile()">בדוק את הקובץ ←</button>`;
  document.getElementById('viewModal').innerHTML = `
    <h3>✅ בדיקה לפני דפוס — גיליון ${st.issue.issue_number}</h3>
    ${verdict}
    <div id="ppPdfBox" style="margin:10px 0">${pdfBox}</div>
    <div style="max-height:46vh;overflow:auto">
      ${bad.length ? `<h4 style="margin:10px 0 4px">⛔ חייב תיקון</h4>${bad.map(f => _ppRow('⛔', f.label, f.msg)).join('')}` : ''}
      ${warn.length ? `<h4 style="margin:10px 0 4px">⚠️ לבדיקה</h4>${warn.map(f => _ppRow('⚠️', f.label, f.msg)).join('')}` : ''}
      <p class="muted" style="font-size:.8rem;margin-top:8px">${st.data.ok} מודעות משובצות עברו את בדיקת הנתונים.</p>
    </div>
    ${okAt ? `<p class="muted" style="font-size:.8rem">סומן "מוכן לדפוס" ב-${esc(heDateTime(okAt))}</p>` : ''}
    <div class="m-actions" style="flex-wrap:wrap">
      ${bad.length || warn.length ? `<button class="btn" onclick="_ppCopyFixList()">📋 העתק רשימת תיקונים לגרפיקאית</button>` : ''}
      ${profile.role === 'admin' && st.pdf ? `<button class="btn ${bad.length ? 'btn-ghost' : ''}" onclick="_ppMarkReady()">🖨️ אישור: מוכן לדפוס</button>` : ''}
      <button class="btn btn-ghost" onclick="_ppClose()">סגירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

function _ppCopyFixList() {
  const st = _ppState; if (!st) return;
  const { bad, warn } = _ppFindings();
  const line = f => '• ' + (f.label ? f.label + ' — ' : '') + f.msg;
  const txt = `גיליון ${st.issue.issue_number} — תיקונים לפני דפוס:\n\n` +
    (bad.length ? 'חייב תיקון:\n' + bad.map(line).join('\n') + '\n\n' : '') +
    (warn.length ? 'לבדיקה:\n' + warn.map(line).join('\n') + '\n' : '') + '\nתודה!';
  const done = () => toast('הרשימה הועתקה — אפשר להדביק בוואטסאפ/מייל');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, () => prompt('העתק:', txt));
  else prompt('העתק:', txt);
}

async function _ppMarkReady() {
  const st = _ppState; if (!st) return;
  const { bad } = _ppFindings();
  if (bad.length && !confirm(`יש ${bad.length} בעיות שסומנו "חייב תיקון". לסמן מוכן לדפוס בכל זאת?`)) return;
  const v = new Date().toISOString();
  try {
    await db.from('settings').upsert({ key: _ppKey(st.issue.issue_number), value: v });
    if (cache.settings) cache.settings[_ppKey(st.issue.issue_number)] = v;
    toast('סומן: מוכן לדפוס'); _ppRender();
  } catch (e) { toast('שמירה נכשלה', true); }
}

/* ---------- סקירה ויזואלית: עמוד מול קבצי העיצוב שהעימוד מצפה להם ---------- */
async function _ppPagesView() {
  const st = _ppState; if (!st || !st.pdf) return;
  let cells = '';
  for (let p = 1; p <= st.pdf.pageCount; p++) {
    const exp = st.ads.filter(a => a.page_number === p);
    const flagged = st.pdf.images.some(im => im.page === p && im.kind !== 'strip' && im.dpi < (im.kind === 'background' ? PP_DPI_BG_BAD : PP_DPI_BAD));
    cells += `<div style="border:1px solid ${flagged ? '#ef4444' : 'var(--line,#e5e7eb)'};border-radius:10px;padding:8px;background:#fff">
      <div style="font-weight:700;margin-bottom:6px">עמוד ${p}${flagged ? ' ⛔' : ''}</div>
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <div id="ppth_${p}" style="width:180px;height:250px;background:#f1f5f9;display:flex;align-items:center;justify-content:center"><span class="muted" style="font-size:.72rem">טוען…</span></div>
        <div style="flex:1;min-width:140px">${exp.length ? exp.map(a => `<div style="margin-bottom:6px">
          <div style="font-size:.8rem;font-weight:600">${esc(_adLabel(a))}</div>
          <div id="ppad_${a.id}" style="width:110px;height:80px;background:#f8fafc;display:flex;align-items:center;justify-content:center"><span class="muted" style="font-size:.68rem">${st.design[a.id] ? '…' : 'אין קובץ'}</span></div></div>`).join('') : '<span class="muted" style="font-size:.8rem">אין מודעות בעימוד</span>'}</div>
      </div></div>`;
  }
  document.getElementById('viewModal').innerHTML = `
    <h3>👁️ גיליון ${st.issue.issue_number} — עמוד מול המודעות שאמורות להיות בו</h3>
    <p class="muted" style="font-size:.83rem;margin-top:-6px">מסגרת אדומה = יש בעמוד תמונה מפוקסלת. השווה בעין שהמודעה בעמוד היא הגרסה שבקובץ.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;max-height:66vh;overflow:auto">${cells}</div>
    <div class="m-actions" style="margin-top:12px"><button class="btn" onclick="_ppRender()">← חזרה לדוח</button></div>`;
  for (let p = 1; st.pdf && p <= st.pdf.pageCount; p++) {
    if (_ppState !== st) return;
    try {
      const url = st.pdf.thumbs[p] || (st.pdf.thumbs[p] = await _ppThumb(p));
      const el = document.getElementById('ppth_' + p);
      if (el && url) el.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%">`;
    } catch (e) { }
    for (const a of st.ads.filter(x => x.page_number === p && st.design[x.id])) _ppDesignThumb(a);
  }
}

async function _ppThumb(n) {
  const st = _ppState; if (!st || !st.pdf) return null; const e = st.pdf.map.byPage[n]; if (!e) return null;
  const page = await st.pdf.doc.getPage(e.idx + 1);
  const vp = page.getViewport({ scale: 0.6 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  if (e.half === 'full') return c.toDataURL('image/jpeg', 0.7);
  const hw = Math.floor(c.width / 2), c2 = document.createElement('canvas'); c2.width = hw; c2.height = c.height;
  c2.getContext('2d').drawImage(c, e.half === 'right' ? c.width - hw : 0, 0, hw, c.height, 0, 0, hw, c.height);
  return c2.toDataURL('image/jpeg', 0.7);
}

async function _ppDesignThumb(a) {
  if (!_ppState) return; const f = _ppState.design[a.id]; const el = document.getElementById('ppad_' + a.id); if (!f || !el) return;
  try {
    const { data } = await db.storage.from('ad-files').createSignedUrl(f.storage_path, 600);
    if (!data) return;
    if (/\.(png|jpe?g|gif|webp)$/i.test(f.storage_path)) {
      el.innerHTML = `<a href="${data.signedUrl}" target="_blank"><img src="${data.signedUrl}" style="max-width:110px;max-height:80px"></a>`;
    } else if (/\.pdf$/i.test(f.storage_path)) {
      const d = await window.pdfjsLib.getDocument(data.signedUrl).promise;
      const pg = await d.getPage(1); const vp0 = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: Math.min(110 / vp0.width, 80 / vp0.height) });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      el.innerHTML = `<a href="${data.signedUrl}" target="_blank"><img src="${c.toDataURL('image/png')}"></a>`;
      try { d.destroy(); } catch (e) { }
    } else el.innerHTML = `<a href="${data.signedUrl}" target="_blank" style="font-size:.72rem">${esc(f.file_name || 'קובץ')}</a>`;
  } catch (e) { }
}
