/* ============================================================
issue-print.js — הרכבת PDF לדפוס מהשיבוץ (בלי אינדיזיין)
------------------------------------------------------------
כפתור "📄 הרכבת PDF לדפוס" בפלטפלן (הפקה ודפוס): לוקח את המודעות
המשובצות בגיליון (קבצים סגורים — PDF/JPG/PNG מ-ad_files), מניח כל
אחת במשבצת שלה בגריד העמוד, מעליהן את עמוד האב (המסגרת: פס תחתון,
לוגו וכו'), כותב את הטקסט המשתנה (מספר עמוד, גיליון, תאריכים) ומוריד
PDF אחד של כל הגיליון. לא כותב שום דבר למסד.
- עמוד האב: PDF שהגרפיקאית מייצאת פעם אחת (עמוד זוגי + אי-זוגי),
  בלי הטקסט המשתנה. גודל העמוד, החיתוך (Trim) והגלישה (Bleed) נלקחים
  ממנו. נשמר בבאקט issues-archive (layout/master.pdf).
- הגדרות: settings.print_layout (JSON) — שוליים, טורים×שורות, רווחים,
  עמודים בלי מסגרת, שדות טקסט משתנים. נערך בכרטיס בהגדרות.
- גודל מודעה: יחידות השיבוץ האוטומטי (alItemUnits ב-issues.js) →
  מספר משבצות בגריד; הכיוון (לרוחב/לגובה) נבחר לפי יחס הקובץ.
- צבע: הקבצים נכנסים כמו שהם (וקטור/CMYK נשמרים); הטקסט המשתנה נכתב
  בווקטור CMYK. אין המרת RGB→CMYK בדפדפן.
- pdf-lib / fontkit / גופן Heebo נטענים לפי דרישה מ-js/vendor.
- גרסה לאישור ראשוני ("📝 PDF לאישור"): אותה הרכבה בדיוק, ואחריה כל עמוד
  מצויר מחדש כתמונת JPG ברזולוציה נמוכה (pdf.js) עם הכיתוב "טיוטה לאישור".
  קובץ קל לשליחה במייל/וואטסאפ — לא לדפוס.
- קובץ מודעה של כמה עמודים: עמוד 1 → המודעה שהקובץ עליה, והשאר → המודעות
  הבאות של אותו לקוח בגיליון שאין להן קובץ (pibChainAds).
- עמודי כתבות ("📰 עמודי כתבות"): PDF אחד עם כמה עמודים סגורים מהגרפיקאית.
  נשמר לגיליון (issues-archive: editorial/issue_<id>.pdf) ובהרכבה נכנס לפי
  העימוד: עמוד 1 בקובץ → העמוד הראשון בגיליון שאין בו מודעות, עמוד 2 → הבא,
  וכן הלאה. עמוד כזה נכנס כמו שהוא — בלי עמוד אב ובלי טקסט משתנה.
============================================================ */

'use strict';

const _PIB_DEFAULTS = {
  margins_mm: { top: 10, right: 10, bottom: 10, left: 10 },
  cols: 2, rows: 4, gutter_x_mm: 5, gutter_y_mm: 5,
  master_path: '', master_first: 'even',
  no_frame_pages: '1,last',
  fill_from: 'bottom',
  fields: [],
};
const _PIB_MM = 72 / 25.4;
const _PIB_PROOF_DPI = 90, _PIB_PROOF_JPG = 0.6; // גרסה לאישור: קריא במסך, קל במשקל

function pibConfig() {
  let c = {};
  try { c = JSON.parse((cache.settings || {}).print_layout || '{}') || {}; } catch (e) { c = {}; }
  return Object.assign({}, _PIB_DEFAULTS, c, { margins_mm: Object.assign({}, _PIB_DEFAULTS.margins_mm, c.margins_mm || {}) });
}

/* ---------- לוגיקה טהורה (נבדקת ב-tests/issue-print.test.mjs) ---------- */

/* טקסט לוגי → רצפים בסדר תצוגה משמאל לימין, כל רצף בסדר הלוגי שלו.
   כיוון בסיס RTL. fontkit (דרך pdf-lib) הופך בעצמו רצף עברי, ולכן כל רצף
   מצויר בנפרד: כך מספרים ותאריכים לא מתהפכים יחד עם העברית. */
function pibBidiRuns(s) {
  const chars = Array.from(String(s || ''));
  // R = עברית, L = לטינית, N = ספרה; מפריד יחיד בין שתי ספרות (05.10.26) מצטרף למספר
  const type = chars.map(c => /[\u0590-\u05FF\uFB1D-\uFB4F]/.test(c) ? 'R' : /[A-Za-z]/.test(c) ? 'L' : /[0-9]/.test(c) ? 'N' : null);
  for (let i = 1; i < type.length - 1; i++) if (!type[i] && /[.,:\/\-]/.test(chars[i]) && type[i - 1] === 'N' && type[i + 1] === 'N') type[i] = 'N';
  // ניטרלי בין שני כיוונים זהים מקבל אותם (ספרה נחשבת R לעניין זה, כמו בתקן); אחרת — R
  const eff = t => t === 'L' ? 'L' : 'R';
  const dir = type.map((t, i) => {
    if (t) return t;
    let a = i - 1; while (a >= 0 && !type[a]) a--;
    let b = i + 1; while (b < type.length && !type[b]) b++;
    const da = a >= 0 ? eff(type[a]) : 'R', db = b < type.length ? eff(type[b]) : 'R';
    return da === db ? da : 'R';
  }).map(d => d === 'N' ? 'L' : d);
  const runs = [];
  chars.forEach((c, i) => {
    const d = dir[i], isNum = type[i] === 'N';
    const last = runs[runs.length - 1];
    // רצף ספרות הוא יחידה נפרדת (לא מתמזג עם לטינית סמוכה)
    if (last && last.d === d && last.num === isNum) last.t.push(c);
    else runs.push({ d, num: isNum, t: [c] });
  });
  return runs.reverse().map(r => ({ d: r.d, text: r.t.join('') }));
}

/* ציור טקסט מעורב עברית/מספרים: x = הקצה השמאלי */
function _pibDrawText(page, s, x, y, size, font, color) {
  for (const r of pibBidiRuns(s)) {
    page.drawText(r.text, { x, y, size, font, color });
    x += font.widthOfTextAtSize(r.text, size);
  }
}
function _pibTextWidth(s, size, font) { return pibBidiRuns(s).reduce((w, r) => w + font.widthOfTextAtSize(r.text, size), 0); }

/* מספר → אותיות (1–999), עם גרש/גרשיים: 15 → ט"ו, 24 → כ"ד */
function pibHebNum(n) {
  if (!(n > 0 && n < 1000)) return String(n);
  const H = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'], T = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'], O = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  let t = H[Math.floor(n / 100)], r = n % 100;
  t += (r === 15 ? 'טו' : r === 16 ? 'טז' : T[Math.floor(r / 10)] + O[r % 10]);
  return t.length === 1 ? t + "'" : t.slice(0, -1) + '"' + t.slice(-1);
}

/* יחידות שיבוץ → משבצות בגריד (cols×rows). שבר — מעוגל ומסומן */
function pibCellsFor(units, unitsPerPage, cells) {
  const exact = units * cells / (unitsPerPage || cells);
  const n = Math.max(1, Math.round(exact));
  return { cells: Math.min(n, cells), exact: Math.abs(exact - n) < 1e-6 && n <= cells };
}

/* צורות אפשריות (w×h משבצות) לפריט, ממוינות לפי קרבה ליחס הקובץ.
   orient ('v' מאונך / 'h' מאוזן, נבחר ידנית במודעה) — רק צורות בכיוון הזה;
   אם אין כאלה (משבצת בודדת, ריבוע) — כל הצורות */
function _pibShapes(cells, g, aspect, orient) {
  const out = [];
  for (let w = 1; w <= g.cols; w++) {
    if (cells % w) continue;
    const h = cells / w;
    if (h > g.rows) continue;
    const ar = (w * g.mw + (w - 1) * g.gx) / (h * g.mh + (h - 1) * g.gy);
    out.push({ w, h, ar });
  }
  const score = s => aspect ? Math.abs(Math.log(s.ar / aspect)) : -s.w; // בלי קובץ: הרחב קודם
  const sorted = out.sort((a, b) => score(a) - score(b) || a.w - b.w);
  const want = orient === 'v' ? sorted.filter(s => s.ar < 0.97) : orient === 'h' ? sorted.filter(s => s.ar > 1.03) : sorted;
  return want.length ? want : sorted;
}

/* סידור פריטים בעמוד: g = {cols, rows, mw, mh, gx, gy}; items = [{id, cells, aspect, orient?}]
   סריקה מלמטה למעלה (או מלמעלה, g.fromTop) ומימין לשמאל; חיפוש לעומק כדי שכל הפריטים ייכנסו אם אפשר.
   מחזיר { placed:[{id,col,row,w,h}], unplaced:[id] } — col 0 = הטור הימני */
function pibPackPage(g, items) {
  const order = items.slice().sort((a, b) => (b.cells - a.cells) || (a.id - b.id));
  const grid = Array.from({ length: g.rows }, () => Array(g.cols).fill(false));
  const fits = (r, c, w, h) => { if (r + h > g.rows || c + w > g.cols) return false; for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (grid[y][x]) return false; return true; };
  const mark = (r, c, w, h, v) => { for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) grid[y][x] = v; };
  const rowsOrder = Array.from({ length: g.rows }, (_, i) => i);
  if (!g.fromTop) rowsOrder.reverse();
  // שורת עיגון של צורה בגובה h: במילוי מלמטה הצורה "נשענת" על השורה הנסרקת
  const anchors = h => rowsOrder.map(r => g.fromTop ? r : r - h + 1).filter(r => r >= 0 && r + h <= g.rows);
  const placed = [];
  let nodes = 0;
  function dfs(i) {
    if (i === order.length) return true;
    if (++nodes > 50000) return false;
    const it = order[i];
    for (const s of _pibShapes(it.cells, g, it.aspect, it.orient)) {
      for (const r of anchors(s.h)) for (let c = 0; c < g.cols; c++) {
        if (!fits(r, c, s.w, s.h)) continue;
        mark(r, c, s.w, s.h, true); placed.push({ id: it.id, col: c, row: r, w: s.w, h: s.h });
        if (dfs(i + 1)) return true;
        placed.pop(); mark(r, c, s.w, s.h, false);
      }
    }
    return false;
  }
  if (dfs(0)) return { placed, unplaced: [] };
  // אין סידור מלא (עמוד עמוס/צורות לא מתאימות) — חמדני: מה שנכנס נכנס
  for (const row of grid) row.fill(false);
  const greedy = [], unplaced = [];
  for (const it of order) {
    let done = false;
    for (const s of _pibShapes(it.cells, g, it.aspect, it.orient)) {
      for (const r of anchors(s.h)) for (let c = 0; c < g.cols && !done; c++) {
        if (fits(r, c, s.w, s.h)) { mark(r, c, s.w, s.h, true); greedy.push({ id: it.id, col: c, row: r, w: s.w, h: s.h }); done = true; }
      }
      if (done) break;
    }
    if (!done) unplaced.push(it.id);
  }
  return { placed: greedy, unplaced };
}

/* משבצת → מלבן במ"מ מפינת החיתוך השמאלית-עליונה (טור 0 = ימין) */
function pibSlotRect(cfg, g, trimW, slot) {
  const m = cfg.margins_mm;
  const xRight = trimW - m.right - slot.col * (g.mw + g.gx);
  const w = slot.w * g.mw + (slot.w - 1) * g.gx;
  const h = slot.h * g.mh + (slot.h - 1) * g.gy;
  return { x: xRight - w, y: m.top + slot.row * (g.mh + g.gy), w, h };
}

function pibGrid(cfg, trimW, trimH) {
  const m = cfg.margins_mm, gx = Number(cfg.gutter_x_mm) || 0, gy = Number(cfg.gutter_y_mm) || 0;
  const cols = Math.max(1, cfg.cols | 0), rows = Math.max(1, cfg.rows | 0);
  const mw = (trimW - m.left - m.right - (cols - 1) * gx) / cols;
  const mh = (trimH - m.top - m.bottom - (rows - 1) * gy) / rows;
  return { cols, rows, mw, mh, gx, gy };
}

/* "1,5,last" → Set של מספרי עמודים */
function pibPageSet(txt, pages) {
  const s = new Set();
  String(txt || '').split(/[,\s]+/).forEach(t => {
    if (/^(last|אחרון)$/i.test(t)) s.add(pages);
    else if (/^\d+$/.test(t)) s.add(Number(t));
  });
  return s;
}

/* טקסט שנשאר בעמוד האב ונראה כמו ערך משתנה (מספר עמוד/גיליון/תאריך) —
   אם יישאר, הוא יודפס מתחת לטקסט שהמערכת כותבת (טקסט כפול בפס התחתון) */
function pibMasterLeftovers(strings) {
  return (strings || []).map(t => String(t || '').trim()).filter(t =>
    /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(t) ||          // תאריך 05.10.26
    /גיליון\s*\d|\d\s*גיליון/.test(t) ||                  // "גיליון 306"
    /^\d{1,3}$/.test(t));                                   // מספר עמוד בודד
}

/* עמודי כתבות לפי העימוד: עמודי הגיליון בלי מודעות (adPages) מקבלים לפי הסדר
   את עמודי קובץ הכתבות (n עמודים). מחזיר { map: {עמוד גיליון: אינדקס בקובץ},
   empty: [עמודים פנויים שלא קיבלו עמוד], extra: עמודים בקובץ שלא נכנסו } */
function pibEditorialMap(pages, adPages, n) {
  const free = [];
  for (let p = 1; p <= pages; p++) if (!adPages.has(p)) free.push(p);
  const map = {};
  free.slice(0, n).forEach((p, i) => { map[p] = i; });
  return { map, empty: free.slice(n), extra: Math.max(0, n - free.length) };
}
function _pibEditorialPath(issueId) { return `editorial/issue_${issueId}.pdf`; }

/* קובץ הכתבות של הגיליון: bytes, או null אם לא הועלה. שגיאה אחרת — נזרקת
   (לא "לא הועלה"). קישור חתום + no-store: אחרי החלפה לא מקבלים גרסה ישנה מהמטמון */
async function _pibEditorialFetch(issueId) {
  const { data, error } = await db.storage.from('issues-archive').createSignedUrl(_pibEditorialPath(issueId), 300);
  if (error) {
    if (/not.?found|404|does not exist/i.test(String(error.message || '') + ' ' + String(error.statusCode || error.status || ''))) return null;
    throw new Error('קובץ הכתבות לא נקרא: ' + (error.message || error));
  }
  const r = await fetch(data.signedUrl, { cache: 'no-store' });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error('קובץ הכתבות לא נקרא (' + r.status + ')');
  return new Uint8Array(await r.arrayBuffer());
}

/* סיבוב תצוגה של קובץ (מעלות, עם כיוון השעון): PDF עם /Rotate או צילום
   JPG עם תג EXIF. בלי זה מודעה שנראית מאונכת בקובץ נכנסת שוכבת. */
function pibNormRot(a) { a = Math.round((Number(a) || 0) / 90) * 90; return ((a % 360) + 360) % 360; }
function pibJpegRotation(bytes) {
  try {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 0;
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xFF) {
      const mk = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (mk === 0xE1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) { // "Exif"
        const t = i + 10, le = bytes[t] === 0x49;
        const u16 = o => le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
        const u32 = o => le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
        const ifd = t + u32(t + 4), n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return { 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 }[u16(e + 8)] || 0;
        }
        return 0;
      }
      if (mk === 0xDA) break; // תחילת נתוני התמונה — אין EXIF
      i += 2 + len;
    }
  } catch (e) { }
  return 0;
}
/* ציור אובייקט בגודל טבעי w×h עם סיבוב תצוגה rot, כך שיתפוס בדיוק את המלבן
   (X0,Y0,DW,DH). pdf-lib מסובב סביב (x,y), נגד כיוון השעון */
function pibRotPlace(rot, X0, Y0, DW, DH) {
  const sw = rot % 180 ? DH : DW, sh = rot % 180 ? DW : DH; // רוחב/גובה לפני הסיבוב
  if (rot === 90) return { x: X0, y: Y0 + DH, width: sw, height: sh, deg: -90 };
  if (rot === 180) return { x: X0 + DW, y: Y0 + DH, width: sw, height: sh, deg: 180 };
  if (rot === 270) return { x: X0 + DW, y: Y0, width: sw, height: sh, deg: 90 };
  return { x: X0, y: Y0, width: sw, height: sh, deg: 0 };
}

/* מודעה מסובבת (layout_orient='r') — הקורא מסובב את העיתון. רגלי המודעה
   (התחתית) תמיד פונות החוצה, לשוליים החיצוניים, והראש לשדרה — קוראים אותה
   מצד החוץ של הדף (החלטת חיים 15.10.2026). עיתון עברי נפתח מימין: עמוד זוגי
   הוא הימני בכפולה (חוץ = ימין) → סיבוב 270° (נגד השעון, הראש שמאלה);
   עמוד אי-זוגי שמאלי (חוץ = שמאל) → 90° (עם השעון, הראש ימינה) */
function pibOutwardRot(page) { return page % 2 === 0 ? 270 : 90; }
/* סיבוב נוסף למודעה לפי הבחירה: 'r' = רגליים החוצה (לפי העמוד),
   'rr' = ראש המודעה ימינה (90° עם השעון), 'rl' = ראש המודעה שמאלה (270°) */
function pibAdTurn(orient, page) {
  return orient === 'r' ? pibOutwardRot(page) : orient === 'rr' ? 90 : orient === 'rl' ? 270 : 0;
}

/* קובץ מודעה של כמה עמודים (למשל כתבות של מועצה): עמוד 1 בקובץ → המודעה
   שהקובץ עליה; עמוד 2 והלאה → המודעות הבאות של אותו לקוח בגיליון שאין להן
   קובץ משלהן, לפי סדר העמודים. ads = [{id, customer_id, page_number}],
   sources = {adId: מספר עמודים בקובץ}, hasFile = Set של מודעות עם קובץ.
   מחזיר { assign: {adId: {from: adId, idx}}, leftover: {adId: עמודים שלא שובצו} } */
function pibChainAds(ads, sources, hasFile) {
  const assign = {}, leftover = {};
  const srcAds = ads.filter(a => (sources[a.id] || 0) > 1).sort((x, y) => x.page_number - y.page_number || x.id - y.id);
  for (const s of srcAds) {
    const next = ads.filter(a => a.customer_id === s.customer_id && a.page_number > s.page_number && !hasFile.has(a.id) && !assign[a.id])
      .sort((x, y) => x.page_number - y.page_number || x.id - y.id)
      .slice(0, sources[s.id] - 1);
    next.forEach((a, k) => { assign[a.id] = { from: s.id, idx: k + 1 }; });
    if (sources[s.id] - 1 > next.length) leftover[s.id] = sources[s.id] - 1 - next.length;
  }
  return { assign, leftover };
}

/* החלפת משתנים בטקסט שדה */
function pibFieldText(tpl, v) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => v[k] != null ? String(v[k]) : m);
}

/* ---------- דפדפן ---------- */

function _pibLoadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(src + ' לא נטען'));
    s.onerror = () => reject(new Error('טעינת ' + src + ' נכשלה'));
    document.head.appendChild(s);
  });
}

function _pibB64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

function _pibKind(bytes) {
  const b = bytes.subarray(0, 8);
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  return null;
}

function _pibColor(PDFLib, c) {
  if (Array.isArray(c) && c.length === 4) return PDFLib.cmyk(...c.map(Number));
  if (c === 'white') return PDFLib.cmyk(0, 0, 0, 0);
  return PDFLib.cmyk(0, 0, 0, 1); // שחור (ברירת מחדל)
}

/* ערכי השדות המשתנים לעמוד */
function _pibVars(issue, page) {
  const v = { page, issue: issue.issue_number, date: '', hebdate: '' };
  const norm = t => String(t).replace(/\u05F4/g, '"').replace(/\u05F3/g, "'");
  if (issue.publish_date) {
    const [y, m, d] = String(issue.publish_date).slice(0, 10).split('-');
    v.date = `${d}.${m}.${String(y).slice(2)}`;
    try {
      const parts = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long' }).formatToParts(new Date(issue.publish_date.slice(0, 10) + 'T12:00:00'));
      let day = (parts.find(p => p.type === 'day') || {}).value || '';
      if (/^\d+$/.test(day)) day = pibHebNum(Number(day)); // יש דפדפנים שמחזירים ספרות
      const mon = ((parts.find(p => p.type === 'month') || {}).value || '').replace(/^ב/, '');
      v.hebdate = norm((day + ' ' + mon).trim());
    } catch (e) { }
  }
  return v;
}

/* proof = גרסה קלה לאישור ראשוני (תמונות ברזולוציה נמוכה, לא לדפוס) */
async function fpBuildPrintPdf(proof) {
  proof = proof === true;
  const title = proof ? '📝 PDF לאישור' : '📄 הרכבת PDF לדפוס';
  if (!['admin', 'editor'].includes(profile.role)) return;
  if (typeof _alBusyGuard === 'function' && _alBusyGuard()) return;
  const cfg = pibConfig();
  if (!cfg.master_path) { toast('לא הועלה עמוד אב — הגדרות ← הרכבת PDF לדפוס', true); return; }
  const issue = _fpIssue, pages = Number(issue.pages_count) || 0;
  if (!pages) { toast('לגיליון לא הוגדר מספר עמודים', true); return; }

  const modal = document.getElementById('viewModal'), back = document.getElementById('viewBack');
  const step = t => { modal.innerHTML = `<h3>${title} — גיליון ${esc(issue.issue_number)}</h3><p>${esc(t)}</p>`; };
  back.classList.add('open'); step('טוען ספריות...');
  const warn = [];
  // block = חובה לתקן לפני דפוס · note = לבדיקה
  const W = (sev, text) => warn.push({ sev, text });
  try {
    const PDFLib = await _apEnsureLib();
    const fontkit = await _pibLoadScript('js/vendor/fontkit.umd.min.js', 'fontkit');
    await _pibLoadScript('js/vendor/heebo-font.js', 'HEEBO_TTF_B64');

    step('טוען עמוד אב...');
    const mres = await db.storage.from('issues-archive').download(cfg.master_path);
    if (mres.error) throw new Error('עמוד האב לא נמצא: ' + mres.error.message);
    const masterBytes = new Uint8Array(await mres.data.arrayBuffer());
    const masterDoc = await PDFLib.PDFDocument.load(masterBytes, { ignoreEncryption: true });
    // בדיקת טקסט ישן בעמוד האב (pdf.js, אם זמין) — רק כשהמערכת כותבת שדות בעצמה
    if ((cfg.fields || []).length && typeof _pvEnsurePdfJs === 'function') {
      try {
        await _pvEnsurePdfJs();
        const md = await window.pdfjsLib.getDocument({ data: masterBytes.slice(), isEvalSupported: false }).promise;
        const strs = [];
        for (let k = 1; k <= md.numPages; k++) (await (await md.getPage(k)).getTextContent()).items.forEach(it => strs.push(it.str));
        const left = pibMasterLeftovers(strs);
        if (left.length) W('block', `עמוד האב מכיל טקסט משתנה ישן (${left.slice(0, 3).join(' · ')}) — הוא יודפס מתחת לטקסט החדש. יש להעלות עמוד אב נקי בהגדרות`);
      } catch (e) { console.warn('master text check', e); }
    }

    const out = await PDFLib.PDFDocument.create();
    out.registerFontkit(fontkit);
    const font = await out.embedFont(_pibB64ToBytes(window.HEEBO_TTF_B64), { subset: true });
    const masterPages = await out.embedPdf(masterDoc, masterDoc.getPageIndices());
    const mp0 = masterDoc.getPage(0);
    const media = mp0.getMediaBox(), trim = mp0.getTrimBox(), bleed = mp0.getBleedBox();
    const trimW = trim.width / _PIB_MM, trimH = trim.height / _PIB_MM;
    const g = pibGrid(cfg, trimW, trimH);
    g.fromTop = cfg.fill_from === 'top';
    if (g.mw <= 0 || g.mh <= 0) throw new Error('הגריד לא תקין — בדוק שוליים/טורים/שורות בהגדרות');
    const cellsPerPage = g.cols * g.rows;
    const U = (typeof _alUnitsPerPage === 'function') ? _alUnitsPerPage() : cellsPerPage;
    const sizeMap = (typeof _alSizeMap === 'function') ? _alSizeMap() : {};
    const noFrame = pibPageSet(cfg.no_frame_pages, pages);
    // מ"מ מפינת החיתוך (שמאל-עליון) → נקודות PDF (שמאל-תחתון)
    const X = mm => trim.x + mm * _PIB_MM;
    const Y = mm => trim.y + trim.height - mm * _PIB_MM;
    const masterFor = p => {
      if (masterPages.length === 1) return masterPages[0];
      const even = p % 2 === 0;
      return (cfg.master_first === 'odd') === even ? masterPages[1] : masterPages[0];
    };

    // המודעות המשובצות וקבציהן
    const ads = _fpAds.filter(a => a.page_number >= 1 && a.page_number <= pages && !['cancelled', 'rejected'].includes(a.status));
    const files = ads.length ? await run(db.from('ad_files').select('ad_id,storage_path,file_name,kind,created_at').in('ad_id', ads.map(a => a.id)).order('created_at', { ascending: false })) : [];
    const fileFor = id => files.find(f => f.ad_id === id && f.kind === 'design') || files.find(f => f.ad_id === id && f.kind === 'source');
    const loaded = {}, byHash = {}, pdfSrc = {}, noFile = [];
    // עמוד מתוך PDF → פריט לציור (חיתוך, גלישה, סיבוב, יחס)
    const pdfItem = (src, idx) => {
      const sp = src.getPage(idx), srcTrim = sp.getTrimBox(), srcBleed = sp.getBleedBox();
      let rot = 0; try { rot = pibNormRot(sp.getRotation().angle); } catch (e) { }
      const aspect = rot % 180 ? srcTrim.height / srcTrim.width : srcTrim.width / srcTrim.height;
      return { kind: 'pdf', emb: { src, sp }, srcTrim, srcBleed, aspect, rot };
    };
    let i = 0;
    for (const a of ads) {
      step(`מוריד קבצי מודעות ${++i}/${ads.length}...`);
      const f = fileFor(a.id);
      if (!f) { noFile.push(a); continue; }
      try {
        const r = await db.storage.from('ad-files').download(f.storage_path);
        if (r.error) throw r.error;
        const bytes = new Uint8Array(await r.data.arrayBuffer());
        const kind = _pibKind(bytes);
        const hash = await _pibHash(bytes);
        (byHash[hash] = byHash[hash] || []).push(a);
        if (!kind) { W('block', `עמ' ${a.page_number}: ${_adLabel(a)} — סוג קובץ לא נתמך (${f.file_name || ''}) — נדרש PDF/JPG/PNG`); continue; }
        if (kind === 'pdf') {
          const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
          pdfSrc[a.id] = src;
          loaded[a.id] = pdfItem(src, 0);
        } else {
          const emb = kind === 'jpg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
          const rot = kind === 'jpg' ? pibJpegRotation(bytes) : 0;
          loaded[a.id] = { kind, emb, srcTrim: null, srcBleed: null, aspect: rot % 180 ? emb.height / emb.width : emb.width / emb.height, rot };
        }
      } catch (e) { W('block', `עמ' ${a.page_number}: ${_adLabel(a)} — הקובץ לא נטען (${e.message || e})`); }
    }
    // קובץ של כמה עמודים ממשיך למודעות הבאות של אותו לקוח שאין להן קובץ
    const pageCounts = {};
    Object.keys(pdfSrc).forEach(id => { pageCounts[id] = pdfSrc[id].getPageCount(); });
    const chain = pibChainAds(ads, pageCounts, new Set(ads.filter(a => fileFor(a.id)).map(a => a.id)));
    for (const a of noFile) {
      const c = chain.assign[a.id];
      if (c) loaded[a.id] = pdfItem(pdfSrc[c.from], c.idx);
      else W('block', `עמ' ${a.page_number}: ${_adLabel(a)} — אין קובץ`);
    }
    Object.keys(chain.leftover).forEach(id => {
      const a = ads.find(x => String(x.id) === String(id));
      W('note', `עמ' ${a.page_number}: ${_adLabel(a)} — לקובץ ${pageCounts[id]} עמודים, ${chain.leftover[id]} אחרונים לא נכנסו (אין עוד מודעות של הלקוח בלי קובץ בעמודים הבאים)`);
    });
    // עמודי כתבות (אם הועלו לגיליון) — לפי העימוד, לעמודים בלי מודעות
    let edDoc = null, edMap = { map: {}, empty: [], extra: 0 };
    step('בודק עמודי כתבות...');
    let edBytes = null;
    try { edBytes = await _pibEditorialFetch(issue.id); } catch (e) { W('block', e.message || String(e)); }
    if (edBytes) {
      try {
        edDoc = await PDFLib.PDFDocument.load(edBytes, { ignoreEncryption: true });
        edMap = pibEditorialMap(pages, new Set(ads.map(a => a.page_number)), edDoc.getPageCount());
        if (edMap.extra) W('block', `קובץ הכתבות: ${edMap.extra} עמודים אחרונים לא נכנסו — אין מספיק עמודים בלי מודעות בעימוד`);
        if (edMap.empty.length) W('note', `קובץ הכתבות קצר מהעימוד — עמודים בלי מודעות שנשארו ריקים: ${edMap.empty.join(', ')}`);
      } catch (e) { W('block', `קובץ הכתבות לא נטען (${e.message || e})`); }
    }
    // אותו קובץ ביותר ממודעה אחת (לפי תוכן הקובץ, לא לפי שם)
    Object.values(byHash).filter(l => l.length > 1).forEach(l =>
      W('note', `אותו קובץ מופיע ${l.length} פעמים: ${l.map(a => `עמ' ${a.page_number} (${_adLabel(a)})`).join(', ')}`));

    for (let p = 1; p <= pages; p++) {
      step(`מרכיב עמוד ${p}/${pages}...`);
      const page = out.addPage([media.width, media.height]);
      page.setMediaBox(media.x, media.y, media.width, media.height);
      page.setTrimBox(trim.x, trim.y, trim.width, trim.height);
      page.setBleedBox(bleed.x, bleed.y, bleed.width, bleed.height);
      if (edDoc && edMap.map[p] != null) { // עמוד כתבות סגור — נכנס כמו שהוא
        const sp = edDoc.getPage(edMap.map[p]), st = sp.getTrimBox(), sb = sp.getBleedBox();
        let er = 0; try { er = pibNormRot(sp.getRotation().angle); } catch (e) { }
        if (!er && Math.abs(st.width / _PIB_MM - trimW) < 3 && Math.abs(st.height / _PIB_MM - trimH) < 3) {
          const ep = await out.embedPage(sp, { left: sb.x, bottom: sb.y, right: sb.x + sb.width, top: sb.y + sb.height });
          page.drawPage(ep, { x: trim.x - (st.x - sb.x), y: trim.y - (st.y - sb.y), width: sb.width, height: sb.height });
        } else {
          const ep = await out.embedPage(sp, { left: st.x, bottom: st.y, right: st.x + st.width, top: st.y + st.height });
          const vw = er % 180 ? st.height : st.width, vh = er % 180 ? st.width : st.height; // כפי שהעמוד נראה
          const k = Math.min(trim.width / vw, trim.height / vh);
          const pl = pibRotPlace(er, trim.x + (trim.width - vw * k) / 2, trim.y + (trim.height - vh * k) / 2, vw * k, vh * k);
          page.drawPage(ep, { x: pl.x, y: pl.y, width: pl.width, height: pl.height, rotate: PDFLib.degrees(pl.deg) });
          if (Math.abs(vw / _PIB_MM - trimW) >= 3 || Math.abs(vh / _PIB_MM - trimH) >= 3)
            W('note', `עמ' ${p}: עמוד ${edMap.map[p] + 1} בקובץ הכתבות לא בגודל העמוד (${Math.round(vw / _PIB_MM)}×${Math.round(vh / _PIB_MM)} מ"מ) — הותאם`);
        }
        continue;
      }
      const onPage = ads.filter(a => a.page_number === p);
      if (!onPage.length) W('block', `עמ' ${p}: ריק`);
      const items = onPage.map(a => {
        const u = (typeof alItemUnits === 'function') ? alItemUnits(a.price_item_id, U, sizeMap, cache.priceList || []).units : cellsPerPage;
        const c = pibCellsFor(u, U, cellsPerPage);
        if (!c.exact) W('note', `עמ' ${p}: ${_adLabel(a)} — ${u} יחידות לא מתחלקות לגריד ${g.cols}×${g.rows} (עוגל ל-${c.cells} משבצות)`);
        const asp = loaded[a.id] ? loaded[a.id].aspect : null;
        // מסובבת: המשבצת נבחרת לפי הקובץ כשהוא מסובב (קובץ רחב → משבצת גבוהה)
        if (pibAdTurn(a.layout_orient, p)) return { id: a.id, cells: c.cells, aspect: asp ? 1 / asp : null, orient: null };
        return { id: a.id, cells: c.cells, aspect: asp, orient: a.layout_orient || null };
      });
      const pack = pibPackPage(g, items);
      const used = pack.placed.reduce((n, s) => n + s.w * s.h, 0);
      if (onPage.length && used < cellsPerPage) W('note', `עמ' ${p}: מלא ${used}/${cellsPerPage} — ${cellsPerPage - used} משבצות ריקות`);
      pack.unplaced.forEach(id => W('block', `עמ' ${p}: ${_adLabel(ads.find(a => a.id === id))} — אין מקום בעמוד (עמוד עמוס)`));
      for (const s of pack.placed) { // כיוון שנבחר ידנית ולא התקיים (אין צורה כזו לגודל, או שהעמוד לא אפשר)
        const o = (ads.find(a => a.id === s.id) || {}).layout_orient;
        const sar = (s.w * g.mw + (s.w - 1) * g.gx) / (s.h * g.mh + (s.h - 1) * g.gy);
        if ((o === 'v' && sar >= 0.97) || (o === 'h' && sar <= 1.03))
          W('note', `עמ' ${p}: ${_adLabel(ads.find(a => a.id === s.id))} — סומנה ${o === 'v' ? 'מאונכת' : 'מאוזנת'} אבל לגודל שלה אין משבצת בכיוון הזה בעמוד`);
      }

      for (const s of pack.placed) {
        const a = ads.find(x => x.id === s.id), L = loaded[s.id];
        const r = pibSlotRect(cfg, g, trimW, s);
        const full = s.w === g.cols && s.h === g.rows;
        if (!L) { // מלבן ממלא-מקום כדי שיהיה ברור מה חסר
          page.drawRectangle({ x: X(r.x), y: Y(r.y + r.h), width: r.w * _PIB_MM, height: r.h * _PIB_MM, color: PDFLib.cmyk(0, 0, 0, 0.08), borderColor: PDFLib.cmyk(0, 1, 1, 0), borderWidth: 1 });
          _pibDrawText(page, 'חסר קובץ: ' + _adLabel(a), X(r.x) + 6, Y(r.y) - 14, 9, font, PDFLib.cmyk(0, 1, 1, 0));
          continue;
        }
        // מודעת עמוד מלא בגודל החיתוך → נכנסת לכל הדף כולל הגלישה
        const R = pibNormRot(L.rot + pibAdTurn(a.layout_orient, p)); // סיבוב הקובץ + הסיבוב שנבחר
        const isTrimSized = L.srcTrim && !R && Math.abs(L.srcTrim.width / _PIB_MM - trimW) < 3 && Math.abs(L.srcTrim.height / _PIB_MM - trimH) < 3;
        if (full && isTrimSized) {
          const b = L.srcBleed;
          const ep = await out.embedPage(L.emb.sp, { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height });
          page.drawPage(ep, { x: trim.x - (L.srcTrim.x - b.x), y: trim.y - (L.srcTrim.y - b.y), width: b.width, height: b.height });
          continue;
        }
        let ew, eh, draw;
        if (L.kind === 'pdf') {
          const t = L.srcTrim;
          const ep = await out.embedPage(L.emb.sp, { left: t.x, bottom: t.y, right: t.x + t.width, top: t.y + t.height });
          ew = t.width; eh = t.height; draw = (o) => page.drawPage(ep, o);
        } else { ew = L.emb.width; eh = L.emb.height; draw = (o) => page.drawImage(L.emb, o); }
        if (R % 180) [ew, eh] = [eh, ew]; // מידות כפי שהקובץ ייראה בעמוד
        // התאמה למשבצת בלי עיוות, ממורכז
        const sw = r.w * _PIB_MM, sh = r.h * _PIB_MM, k = Math.min(sw / ew, sh / eh);
        const dw = ew * k, dh = eh * k;
        if (Math.abs(Math.log((ew / eh) / (sw / sh))) > 0.06) W('note', `עמ' ${p}: ${_adLabel(a)} — יחס הקובץ לא תואם למשבצת (${Math.round(r.w)}×${Math.round(r.h)} מ"מ) — יישאר שוליים לבנים`);
        const pl = pibRotPlace(R, X(r.x) + (sw - dw) / 2, Y(r.y + r.h) + (sh - dh) / 2, dw, dh);
        draw({ x: pl.x, y: pl.y, width: pl.width, height: pl.height, rotate: PDFLib.degrees(pl.deg) });
      }

      if (!noFrame.has(p)) {
        page.drawPage(masterFor(p), { x: 0, y: 0 });
        const vars = _pibVars(issue, p), side = p % 2 === 0 ? 'even' : 'odd';
        for (const f of (cfg.fields || [])) {
          if (f.side && f.side !== 'all' && f.side !== side) continue;
          const txt = pibFieldText(f.text, vars);
          const size = Number(f.size_pt) || 8, w = _pibTextWidth(txt, size, font);
          let x = X(Number(f.x_mm) || 0);
          if (f.align === 'right') x -= w; else if (f.align === 'center') x -= w / 2;
          _pibDrawText(page, txt, x, Y(Number(f.y_mm) || 0), size, font, _pibColor(PDFLib, f.color));
        }
      }
    }

    step('שומר...');
    let bytes = await out.save();
    if (proof) bytes = await _pibProofPdf(PDFLib, fontkit, bytes, trim, media, step);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const name = proof ? `גיליון-${issue.issue_number}-לאישור.pdf` : `גיליון-${issue.issue_number}.pdf`;
    modal.innerHTML = `<h3>${proof ? '📝 PDF לאישור' : '📄 PDF לדפוס'} — גיליון ${esc(issue.issue_number)}</h3>
<p>${pages} עמודים · ${(bytes.length / 1048576).toFixed(1)}MB. ${proof ? 'גרסה קלה לאישור ראשוני — <b>לא לדפוס</b>.' : 'כדאי לעבור על הקובץ לפני השליחה לדפוס.'}</p>
${_pibWarnHtml(warn)}
<div class="m-actions" style="margin-top:12px">
<a class="btn" href="${url}" download="${esc(name)}">⬇ הורדת ה-PDF</a>
<a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">👁 פתיחה לצפייה</a>
<button class="btn btn-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
</div>`;
  } catch (e) {
    console.error('print pdf', e);
    modal.innerHTML = `<h3>${title}</h3><p style="color:#b91c1c">שגיאה: ${esc(e.message || String(e))}</p>
<div class="m-actions"><button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`;
  }
}

/* גרסה לאישור: כל עמוד (בגבולות החיתוך) → JPG ברזולוציה נמוכה + כיתוב "טיוטה לאישור".
   הקבצים המקוריים (וקטור, תמונות ברזולוציית דפוס) לא נכנסים — לכן הקובץ קל. */
async function _pibProofPdf(PDFLib, fontkit, printBytes, trim, media, step) {
  await _pvEnsurePdfJs();
  const src = await window.pdfjsLib.getDocument({ data: printBytes, isEvalSupported: false }).promise;
  const out = await PDFLib.PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(_pibB64ToBytes(window.HEEBO_TTF_B64), { subset: true });
  const sc = _PIB_PROOF_DPI / 72;
  // היסט החיתוך בתוך עמוד המדיה (pdf.js: ראשית בפינה השמאלית-עליונה)
  const offX = (trim.x - media.x) * sc, offY = (media.y + media.height - trim.y - trim.height) * sc;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(trim.width * sc); canvas.height = Math.round(trim.height * sc);
  const ctx = canvas.getContext('2d');
  const label = 'טיוטה לאישור — לא לדפוס', lsize = 7;
  for (let k = 1; k <= src.numPages; k++) {
    step(`מקטין לאישור — עמוד ${k}/${src.numPages}...`);
    const pg = await src.getPage(k);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: pg.getViewport({ scale: sc, offsetX: -offX, offsetY: -offY }) }).promise;
    pg.cleanup();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', _PIB_PROOF_JPG));
    const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([trim.width, trim.height]);
    page.drawImage(jpg, { x: 0, y: 0, width: trim.width, height: trim.height });
    const w = _pibTextWidth(label, lsize, font);
    page.drawRectangle({ x: trim.width - w - 10, y: trim.height - lsize - 8, width: w + 6, height: lsize + 5, color: PDFLib.rgb(1, 1, 1), opacity: 0.85 });
    _pibDrawText(page, label, trim.width - w - 7, trim.height - lsize - 5, lsize, font, PDFLib.rgb(0.73, 0.11, 0.11));
  }
  src.destroy();
  return out.save();
}

/* רשימת הבדיקה: קודם מה שחוסם דפוס, אחר כך הערות */
function _pibWarnHtml(warn) {
  if (!warn.length) return '<p style="color:var(--ok)">✓ כל המודעות נכנסו בלי הערות</p>';
  const block = warn.filter(w => w.sev === 'block'), note = warn.filter(w => w.sev !== 'block');
  const list = (arr, col, title) => arr.length ? `<div style="font-size:.84rem;color:${col};margin:6px 0"><b>${title} (${arr.length}):</b>
<ul style="margin:4px 18px 0">${arr.map(w => `<li>${esc(w.text)}</li>`).join('')}</ul></div>` : '';
  return `<div style="max-height:45vh;overflow:auto">
${list(block, '#b91c1c', '🔴 חובה לתקן לפני דפוס')}
${list(note, '#92400e', '🟡 לבדיקה')}</div>
${block.length ? '' : '<p style="color:var(--ok);font-size:.84rem">✓ אין בעיות חוסמות</p>'}`;
}

async function _pibHash(bytes) {
  try {
    const d = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return bytes.length + ':' + bytes[0] + bytes[bytes.length - 1]; }
}

/* ==================== הורדת כל קבצי המודעות של הגיליון ==================== */
/* כל קובץ כמו שהועלה (בלי הקטנה/המרה), ב-ZIP אחד. שם הקובץ מתחיל במספר העמוד
   כדי שיסתדר לפי העימוד; מודעה שלא שובצה — "לא_משובצת". קובץ עיצוב קודם,
   ואם אין — קובץ המקור. */
function pibZipName(a, fileName, used) {
  const ext = (String(fileName || '').match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0];
  const pg = a.page_number ? 'עמ_' + String(a.page_number).padStart(2, '0') : 'לא_משובצת';
  let name = (pg + '_' + String(a.title || 'מודעה')).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + ext;
  if (used[name]) { const n = ++used[name], dot = name.lastIndexOf('.'); name = dot > 0 ? name.slice(0, dot) + '_' + n + name.slice(dot) : name + '_' + n; }
  else used[name] = 1;
  return name;
}

async function fpDownloadAllAds() {
  if (typeof _zipStore !== 'function') { toast('הורדת ZIP לא זמינה', true); return; }
  const issue = _fpIssue;
  const ads = _fpAds.filter(a => !['cancelled', 'rejected'].includes(a.status))
    .sort((x, y) => (x.page_number || 999) - (y.page_number || 999) || x.id - y.id);
  if (!ads.length) { toast('אין מודעות בגיליון', true); return; }
  const files = await run(db.from('ad_files').select('ad_id,storage_path,file_name,kind,created_at').in('ad_id', ads.map(a => a.id)).order('created_at', { ascending: false }));
  const fileFor = id => files.find(f => f.ad_id === id && f.kind === 'design') || files.find(f => f.ad_id === id && f.kind === 'source');
  const withFile = ads.filter(a => fileFor(a.id));
  if (!withFile.length) { toast('לאף מודעה בגיליון אין קובץ', true); return; }
  const modal = document.getElementById('viewModal'), back = document.getElementById('viewBack');
  const head = `<h3>⬇ הורדת כל המודעות — גיליון ${esc(issue.issue_number)}</h3>`;
  back.classList.add('open');
  const entries = [], used = {}, errs = [];
  for (let i = 0; i < withFile.length; i++) {
    const a = withFile[i], f = fileFor(a.id);
    modal.innerHTML = `${head}<p>מוריד ${i + 1}/${withFile.length}...</p>`;
    const { data, error } = await db.storage.from('ad-files').download(f.storage_path);
    if (error || !data) { errs.push(_adLabel(a)); continue; }
    entries.push({ name: pibZipName(a, f.file_name || f.storage_path, used), data: new Uint8Array(await data.arrayBuffer()) });
  }
  const missing = ads.filter(a => !fileFor(a.id));
  const close = `<button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>`;
  if (!entries.length) { modal.innerHTML = `${head}<p style="color:#b91c1c">לא הצלחתי להוריד אף קובץ.</p><div class="m-actions">${close}</div>`; return; }
  const url = URL.createObjectURL(_zipStore(entries));
  const name = `מודעות-גיליון-${issue.issue_number}.zip`;
  modal.innerHTML = `${head}
<p>${entries.length} קבצים בגודל המקורי, כמו שהועלו. שם כל קובץ מתחיל במספר העמוד.</p>
${errs.length ? `<p style="color:#b91c1c;font-size:.84rem">🔴 לא ירדו (${errs.length}): ${esc(errs.join(', '))}</p>` : ''}
${missing.length ? `<p style="color:#92400e;font-size:.84rem">🟡 בלי קובץ במערכת (${missing.length}): ${esc(missing.map(a => (a.page_number ? "עמ' " + a.page_number + ' ' : '') + _adLabel(a)).join(', '))}</p>` : ''}
<div class="m-actions" style="margin-top:12px"><a class="btn" href="${url}" download="${esc(name)}">⬇ הורדת ה-ZIP</a>${close}</div>`;
  const dl = document.createElement('a'); dl.href = url; dl.download = name; dl.click();
}

/* ==================== עמודי כתבות — העלאה ותצוגת שיבוץ ==================== */
function fpEditorialUpload() {
  if (!['admin', 'editor'].includes(profile.role)) return;
  // השדה מחובר לדף: בספארי/אייפון שדה קובץ מנותק לא תמיד מפעיל onchange
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    inp.remove();
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('נדרש קובץ PDF', true); return; }
    toast('מעלה את עמודי הכתבות...');
    const { error } = await db.storage.from('issues-archive').upload(_pibEditorialPath(_fpIssue.id), file, { upsert: true, contentType: 'application/pdf', cacheControl: '0' });
    if (error) { toast('העלאה נכשלה: ' + error.message, true); return; }
    toast('✓ עמודי הכתבות נשמרו לגיליון');
    fpEditorialShow(new Uint8Array(await file.arrayBuffer())); // מציגים מהקובץ שנבחר — בלי קריאה חוזרת מהשרת
  };
  inp.click();
}

/* מה נכנס לאן — לפי העימוד הנוכחי */
async function fpEditorialShow(localBytes) {
  const issue = _fpIssue, pages = Number(issue.pages_count) || 0;
  const modal = document.getElementById('viewModal'), back = document.getElementById('viewBack');
  const close = `<button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>`;
  modal.innerHTML = `<h3>📰 עמודי כתבות — גיליון ${esc(issue.issue_number)}</h3><p>טוען...</p>`;
  back.classList.add('open');
  try {
    const bytes = localBytes instanceof Uint8Array ? localBytes : await _pibEditorialFetch(issue.id);
    if (!bytes) {
      modal.innerHTML = `<h3>📰 עמודי כתבות — גיליון ${esc(issue.issue_number)}</h3>
<p>עוד לא הועלה קובץ כתבות לגיליון. מעלים PDF אחד עם כל עמודי הכתבות הסגורים, לפי הסדר — המערכת מכניסה אותם לעמודים שאין בהם מודעות.</p>
<div class="m-actions"><button class="btn" onclick="fpEditorialUpload()">⬆ העלאת PDF</button>${close}</div>`;
      return;
    }
    const PDFLib = await _apEnsureLib();
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const n = doc.getPageCount();
    const adPages = new Set(_fpAds.filter(a => a.page_number >= 1 && a.page_number <= pages).map(a => a.page_number));
    const m = pibEditorialMap(pages, adPages, n);
    const rows = Object.keys(m.map).map(Number).sort((a, b) => a - b).map(p => `<li>עמוד ${m.map[p] + 1} בקובץ ← עמוד ${p} בגיליון</li>`).join('');
    modal.innerHTML = `<h3>📰 עמודי כתבות — גיליון ${esc(issue.issue_number)}</h3>
<p>בקובץ ${n} עמודים · בעימוד ${pages - adPages.size} עמודים בלי מודעות.</p>
<ul style="margin:4px 18px;max-height:35vh;overflow:auto;font-size:.86rem">${rows || '<li>אין עמודים פנויים</li>'}</ul>
${m.extra ? `<p style="color:#b91c1c;font-size:.84rem">🔴 ${m.extra} עמודים אחרונים בקובץ לא ייכנסו — אין מספיק עמודים בלי מודעות</p>` : ''}
${m.empty.length ? `<p style="color:#92400e;font-size:.84rem">🟡 עמודים בלי מודעות שיישארו ריקים: ${m.empty.join(', ')}</p>` : ''}
<p class="muted" style="font-size:.8rem">השיבוץ מחושב מחדש בכל הרכבה — הזזת מודעה בעימוד מזיזה גם את עמודי הכתבות.</p>
<div class="m-actions"><button class="btn btn-ghost" onclick="fpEditorialUpload()">⬆ החלפת הקובץ</button>
${profile.role === 'admin' ? `<button class="btn btn-ghost" onclick="fpEditorialRemove()">🗑 הסרה</button>` : ''}${close}</div>`;
  } catch (e) {
    modal.innerHTML = `<h3>📰 עמודי כתבות</h3><p style="color:#b91c1c">שגיאה: ${esc(e.message || String(e))}</p><div class="m-actions">${close}</div>`;
  }
}

async function fpEditorialRemove() {
  if (profile.role !== 'admin' || !confirm('להסיר את קובץ הכתבות מהגיליון?')) return;
  const { error } = await db.storage.from('issues-archive').remove([_pibEditorialPath(_fpIssue.id)]);
  if (error) { toast('ההסרה נכשלה: ' + error.message, true); return; }
  toast('קובץ הכתבות הוסר');
  fpEditorialShow();
}

/* ==================== כרטיס הגדרות (מנהל) ==================== */
function printLayoutCard() {
  if (profile.role !== 'admin') return '';
  const c = pibConfig(), m = c.margins_mm;
  const num = (id, label, v, step) => `<div class="field"><label>${label}</label><input id="${id}" type="number" step="${step || '0.1'}" value="${esc(v)}" dir="ltr"></div>`;
  const example = JSON.stringify([{ side: 'even', text: '{page}', x_mm: 150, y_mm: 232, size_pt: 7, align: 'center', color: 'black' },
    { side: 'odd', text: 'גיליון {issue} | {hebdate}  {date}', x_mm: 48, y_mm: 234, size_pt: 8, align: 'right', color: 'white' }]);
  return `<div class="card card-pad">
<b>📄 הרכבת PDF לדפוס</b>
<p class="muted" style="font-size:.82rem">בפלטפלן ← הפקה ודפוס ← "הרכבת PDF לדפוס": מניח את קבצי המודעות המשובצות בגריד, מוסיף את עמוד האב והטקסט המשתנה ומוריד PDF של כל הגיליון. גודל העמוד, החיתוך והגלישה נלקחים מעמוד האב.</p>
<div style="margin:8px 0">עמוד אב: ${c.master_path ? '<span style="color:var(--ok)">✓ הועלה</span>' : '<span style="color:var(--warn)">לא הועלה</span>'}
<input type="file" id="pibMaster" accept="application/pdf" style="margin-right:8px" onchange="printLayoutUploadMaster(this)"></div>
<p class="muted" style="font-size:.78rem;margin:0 0 8px">PDF של עמוד זוגי + עמוד אי-זוגי, עם גלישה, <b>בלי</b> הטקסט המשתנה (מספר עמוד, תאריך, מספר גיליון) — המערכת כותבת אותו.</p>
<div class="grid2">
${num('pibMt', 'שוליים עליון (מ"מ)', m.top)}${num('pibMb', 'שוליים תחתון (מ"מ)', m.bottom)}
${num('pibMr', 'שוליים ימין (מ"מ)', m.right)}${num('pibMl', 'שוליים שמאל (מ"מ)', m.left)}
${num('pibCols', 'טורים בגריד', c.cols, '1')}${num('pibRows', 'שורות בגריד', c.rows, '1')}
${num('pibGx', 'רווח בין טורים (מ"מ)', c.gutter_x_mm)}${num('pibGy', 'רווח בין שורות (מ"מ)', c.gutter_y_mm)}
<div class="field"><label>העמוד הראשון בקובץ האב הוא</label><select id="pibFirst">
<option value="even" ${c.master_first !== 'odd' ? 'selected' : ''}>זוגי</option><option value="odd" ${c.master_first === 'odd' ? 'selected' : ''}>אי-זוגי</option></select></div>
<div class="field"><label>מילוי מודעות בעמוד</label><select id="pibFill">
<option value="bottom" ${c.fill_from !== 'top' ? 'selected' : ''}>מלמטה למעלה (הגדולה למטה)</option><option value="top" ${c.fill_from === 'top' ? 'selected' : ''}>מלמעלה למטה</option></select></div>
<div class="field"><label>עמודים בלי מסגרת (שער/אחורי)</label><input id="pibNoFrame" value="${esc(c.no_frame_pages)}" placeholder="1,אחרון"></div>
</div>
<div class="field" style="margin-top:6px"><label>שדות טקסט משתנים (JSON) — {page} {issue} {date} {hebdate}; מיקום במ"מ מפינת החיתוך השמאלית-עליונה</label>
<textarea id="pibFields" rows="5" dir="ltr" style="width:100%;font-family:monospace;font-size:.78rem" placeholder='${esc(example)}'>${esc(c.fields && c.fields.length ? JSON.stringify(c.fields, null, 1) : '')}</textarea></div>
<div class="m-actions" style="margin-top:8px"><button class="btn btn-sm" onclick="printLayoutSave()">שמירה</button></div>
</div>`;
}

async function _pibSaveConfig(c) {
  const v = JSON.stringify(c);
  await run(db.from('settings').upsert({ key: 'print_layout', value: v }));
  cache.settings.print_layout = v;
}

async function printLayoutUploadMaster(inp) {
  if (profile.role !== 'admin') return;
  const file = inp.files && inp.files[0]; if (!file) return;
  if (!/\.pdf$/i.test(file.name)) { toast('נדרש קובץ PDF', true); return; }
  const path = 'layout/master.pdf';
  const { error } = await db.storage.from('issues-archive').upload(path, file, { upsert: true, contentType: 'application/pdf' });
  if (error) { toast('העלאה נכשלה: ' + error.message, true); return; }
  const c = pibConfig(); c.master_path = path;
  await _pibSaveConfig(c);
  toast('✓ עמוד האב הועלה');
  openPage('settings');
}

async function printLayoutSave() {
  if (profile.role !== 'admin') return;
  const n = id => Number(document.getElementById(id)?.value);
  const c = pibConfig();
  c.margins_mm = { top: n('pibMt'), right: n('pibMr'), bottom: n('pibMb'), left: n('pibMl') };
  c.cols = Math.max(1, n('pibCols') | 0); c.rows = Math.max(1, n('pibRows') | 0);
  c.gutter_x_mm = n('pibGx'); c.gutter_y_mm = n('pibGy');
  c.master_first = document.getElementById('pibFirst').value;
  c.fill_from = document.getElementById('pibFill').value;
  c.no_frame_pages = document.getElementById('pibNoFrame').value.trim();
  const ft = document.getElementById('pibFields').value.trim();
  if (ft) {
    try { const f = JSON.parse(ft); if (!Array.isArray(f)) throw new Error('נדרש מערך'); c.fields = f; }
    catch (e) { toast('שדות הטקסט — JSON לא תקין: ' + e.message, true); return; }
  } else c.fields = [];
  await _pibSaveConfig(c);
  toast('הגדרות ה-PDF נשמרו');
}

/* חשיפת הלוגיקה הטהורה לבדיקות node (לא פעיל בדפדפן) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pibBidiRuns, pibHebNum, pibMasterLeftovers, pibCellsFor, pibPackPage, pibSlotRect, pibGrid, pibPageSet, pibFieldText, pibEditorialMap, pibNormRot, pibJpegRotation, pibRotPlace, pibOutwardRot, pibAdTurn, pibChainAds, pibZipName };
}
