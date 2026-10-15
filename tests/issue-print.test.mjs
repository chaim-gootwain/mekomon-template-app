// בדיקות node ללוגיקה הטהורה של הרכבת ה-PDF לדפוס (js/issue-print.js).
// הרצה: node tests/issue-print.test.mjs
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
global.Pages = {}; global.window = {}; global.cache = { settings: {} };
const { pibBidiRuns, pibHebNum, pibMasterLeftovers, pibCellsFor, pibPackPage, pibSlotRect, pibGrid, pibPageSet, pibFieldText, pibEditorialMap, pibNormRot, pibJpegRotation, pibRotPlace, pibOutwardRot, pibAdTurn, pibChainAds } = require('../js/issue-print.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

/* ---------- כיווניות ---------- */
t('bidi: רצפים בסדר תצוגה — עברית ומספרים נפרדים, כל רצף בסדר לוגי', () => {
  const v = r => r.map(x => x.d + ':' + x.text);
  assert.deepStrictEqual(v(pibBidiRuns('גיליון 306')), ['L:306', 'R:גיליון ']);
  assert.deepStrictEqual(v(pibBidiRuns('גיליון 306 | כ"ד תשרי  05.10.26')), ['L:05.10.26', 'R: | כ"ד תשרי  ', 'L:306', 'R:גיליון ']);
  assert.deepStrictEqual(v(pibBidiRuns('12')), ['L:12']);
  // "|" בין שני מספרים בהקשר עברי לא מדביק אותם לרצף אחד
  assert.deepStrictEqual(v(pibBidiRuns("גיליון 307 | א' חשוון  12.10.26")), ['L:12.10.26', "R: | א' חשוון  ", 'L:307', 'R:גיליון ']);
});
t('hebNum: מספרים עבריים', () => {
  assert.deepStrictEqual([1, 15, 16, 24, 30, 306].map(pibHebNum), ["א'", 'ט"ו', 'ט"ז', 'כ"ד', "ל'", 'ש"ו']);
});

/* ---------- יחידות → משבצות ---------- */
t('cells: 8 יחידות על גריד 2×4', () => {
  assert.deepStrictEqual(pibCellsFor(4, 8, 8), { cells: 4, exact: true });
  assert.deepStrictEqual(pibCellsFor(1, 8, 8), { cells: 1, exact: true });
  assert.deepStrictEqual(pibCellsFor(3, 16, 8), { cells: 2, exact: false });
});

/* ---------- סידור בעמוד (גריד הגיליון: 155×224 מ"מ, 2×4) ---------- */
const cfg = { margins_mm: { top: 4.5, right: 5, bottom: 11.4, left: 5 }, cols: 2, rows: 4, gutter_x_mm: 5, gutter_y_mm: 3.5 };
const g = pibGrid(cfg, 165, 240);
const ar = (w, h) => w / h;

t('grid: מידות משבצת', () => {
  assert.ok(Math.abs(g.mw - 75) < 0.01, g.mw);
  assert.ok(Math.abs(g.mh - 53.4) < 0.05, g.mh);
});
t('pack: עמוד 24 — רבע לגובה, 2 שמיניות, חצי לרוחב', () => {
  const r = pibPackPage(g, [
    { id: 1, cells: 4, aspect: ar(155, 108.7) }, { id: 2, cells: 2, aspect: ar(75, 111) },
    { id: 3, cells: 1, aspect: ar(75, 54) }, { id: 4, cells: 1, aspect: ar(75, 54) }]);
  assert.deepStrictEqual(r.unplaced, []);
  const by = Object.fromEntries(r.placed.map(p => [p.id, p]));
  assert.deepStrictEqual([by[1].w, by[1].h], [2, 2]); // חצי לרוחב
  assert.deepStrictEqual([by[2].w, by[2].h], [1, 2]); // רבע לגובה
  assert.strictEqual(by[1].row, 2);                    // מילוי מלמטה: החצי בתחתית
  const used = r.placed.reduce((s, p) => s + p.w * p.h, 0);
  assert.strictEqual(used, 8);
});
t('pack: חצי לגובה + חצי לרוחב לא נכנסים יחד → נבחר כיוון אחר ולא נזרק', () => {
  const r = pibPackPage(g, [{ id: 1, cells: 4, aspect: ar(75, 224) }, { id: 2, cells: 4, aspect: ar(155, 109) }]);
  assert.deepStrictEqual(r.unplaced, []);
});
t('pack: מילוי מלמעלה (fromTop) — הגדולה למעלה', () => {
  const r = pibPackPage(Object.assign({}, g, { fromTop: true }), [{ id: 1, cells: 4, aspect: ar(155, 109) }, { id: 2, cells: 1 }]);
  assert.strictEqual(r.placed.find(p => p.id === 1).row, 0);
});
t('pack: עמוד עמוס — העודף מדווח', () => {
  const r = pibPackPage(g, [{ id: 1, cells: 8 }, { id: 2, cells: 1 }]);
  assert.deepStrictEqual(r.unplaced, [2]);
});
t('slot: עמוד מלא = אזור התוכן; טור 0 = ימין', () => {
  const full = pibSlotRect(cfg, g, 165, { col: 0, row: 0, w: 2, h: 4 });
  assert.ok(Math.abs(full.x - 5) < 0.01 && Math.abs(full.w - 155) < 0.01 && Math.abs(full.y - 4.5) < 0.01 && Math.abs(full.h - 224.1) < 0.05);
  const right = pibSlotRect(cfg, g, 165, { col: 0, row: 0, w: 1, h: 1 });
  assert.ok(Math.abs(right.x - 85) < 0.01, right.x);
});

/* ---------- טקסט ישן בעמוד האב ---------- */
t('masterLeftovers: מזהה תאריך/גיליון/מספר עמוד, לא את הטלפון', () => {
  const found = pibMasterLeftovers(['050-000-0000 ', ':להצעת פרסום משתלמת במיוחד חייגו כעת', '05.10.26  |כ"ד תשרי306 גיליון', '2']);
  assert.deepStrictEqual(found, ['05.10.26  |כ"ד תשרי306 גיליון', '2']);
  assert.deepStrictEqual(pibMasterLeftovers(['050-000-0000 :להצעת פרסום משתלמת במיוחד חייגו כעת']), []);
});

/* ---------- עזרים ---------- */
t('pageSet + fieldText', () => {
  assert.deepStrictEqual([...pibPageSet('1, אחרון', 32)].sort((a, b) => a - b), [1, 32]);
  assert.strictEqual(pibFieldText('גיליון {issue} עמ\' {page} {x}', { issue: 306, page: 2 }), "גיליון 306 עמ' 2 {x}");
});


/* ---------- עמודי כתבות לפי העימוד ---------- */
t('editorial: עמודי הקובץ נכנסים לפי הסדר לעמודים בלי מודעות', () => {
  assert.deepStrictEqual(pibEditorialMap(8, new Set([1, 4, 8]), 5), { map: { 2: 0, 3: 1, 5: 2, 6: 3, 7: 4 }, empty: [], extra: 0 });
});
t('editorial: קובץ קצר — עמודים פנויים נשארים; קובץ ארוך — עודף', () => {
  assert.deepStrictEqual(pibEditorialMap(6, new Set([1, 2]), 2), { map: { 3: 0, 4: 1 }, empty: [5, 6], extra: 0 });
  assert.deepStrictEqual(pibEditorialMap(4, new Set([1, 2, 3]), 3), { map: { 4: 0 }, empty: [], extra: 2 });
});

/* ---------- סיבוב קבצים ---------- */
t('rotation: נרמול זווית', () => {
  assert.deepStrictEqual([0, 90, -90, 270, 450, 180].map(pibNormRot), [0, 90, 270, 270, 90, 180]);
});
t('rotation: תג EXIF בצילום JPG', () => {
  // JPEG מינימלי: SOI + APP1(Exif, II, IFD עם תג 0x0112) + SOS
  const jpg = o => Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2A, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xDA]);
  assert.deepStrictEqual([1, 3, 6, 8].map(o => pibJpegRotation(jpg(o))), [0, 180, 90, 270]);
  assert.strictEqual(pibJpegRotation(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xDA, 0, 2])), 0);
});
t('rotation: ציור מסובב תופס בדיוק את המלבן', () => {
  // פינות התוצאה אחרי סיבוב סביב (x,y) נגד כיוון השעון
  const box = (pl) => { const r = pl.deg * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    const pts = [[0, 0], [pl.width, 0], [0, pl.height], [pl.width, pl.height]].map(([u, v]) => [pl.x + u * c - v * s, pl.y + u * s + v * c]);
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]; };
  for (const rot of [0, 90, 180, 270]) assert.deepStrictEqual(box(pibRotPlace(rot, 10, 20, 100, 300)), [10, 20, 110, 320], 'rot ' + rot);
});

/* ---------- כיוון שנבחר ידנית ---------- */
t('orient: חצי עמוד (4 משבצות) — מאונך מקבל טור, מאוזן מקבל רוחב מלא', () => {
  // קובץ ריבועי בערך: בלי בחירה ייבחר 2×2; עם בחירה — לפי הכיוון
  const sq = ar(1, 1);
  const auto = pibPackPage(g, [{ id: 1, cells: 4, aspect: sq }]).placed[0];
  const v = pibPackPage(g, [{ id: 1, cells: 4, aspect: sq, orient: 'v' }]).placed[0];
  const h = pibPackPage(g, [{ id: 1, cells: 2, aspect: sq, orient: 'h' }]).placed[0];
  assert.deepStrictEqual([auto.w, auto.h], [2, 2]);
  assert.deepStrictEqual([v.w, v.h], [1, 4]);
  assert.deepStrictEqual([h.w, h.h], [2, 1]);
});
t('orient: משבצת בודדת — אין כיוון, נשארת כמו שהיא', () => {
  const one = pibPackPage(g, [{ id: 1, cells: 1, aspect: null, orient: 'h' }]).placed[0];
  assert.deepStrictEqual([one.w, one.h], [1, 1]);
});

t('rotated ad: רגלי המודעה פונות החוצה — זוגי (ימין בכפולה) נגד השעון, אי-זוגי עם', () => {
  assert.deepStrictEqual([2, 3, 10, 11].map(pibOutwardRot), [270, 90, 270, 90]);
  // רגלי הקובץ (u=0..w, v=0) אחרי הסיבוב: בעמוד זוגי בצד ימין (חוץ), באי-זוגי בצד שמאל (חוץ)
  const footSide = rot => { const pl = pibRotPlace(rot, 0, 0, 100, 300); const r = pl.deg * Math.PI / 180;
    const x = pl.x + (pl.width / 2) * Math.round(Math.cos(r)); return x > 50 ? 'right' : 'left'; };
  assert.strictEqual(footSide(pibOutwardRot(2)), 'right');
  assert.strictEqual(footSide(pibOutwardRot(3)), 'left');
});

t('rotated ad: בחירת כיוון ידנית — ראש ימינה/שמאלה בכל עמוד', () => {
  assert.deepStrictEqual([2, 3].map(p => pibAdTurn('rr', p)), [90, 90]);
  assert.deepStrictEqual([2, 3].map(p => pibAdTurn('rl', p)), [270, 270]);
  assert.deepStrictEqual([2, 3].map(p => pibAdTurn('r', p)), [270, 90]);
  assert.deepStrictEqual([null, 'v', 'h'].map(o => pibAdTurn(o, 2)), [0, 0, 0]);
});

/* ---------- קובץ של כמה עמודים ---------- */
t('chain: קובץ 5 עמודים בעמוד 22 ממשיך למודעות הלקוח בעמודים 23–26', () => {
  const ads = [{ id: 1, customer_id: 9, page_number: 22 }, { id: 2, customer_id: 9, page_number: 24 }, { id: 3, customer_id: 9, page_number: 23 },
    { id: 4, customer_id: 9, page_number: 26 }, { id: 5, customer_id: 9, page_number: 25 }, { id: 6, customer_id: 7, page_number: 24 }];
  const r = pibChainAds(ads, { 1: 5 }, new Set([1, 6]));
  assert.deepStrictEqual(r.assign, { 3: { from: 1, idx: 1 }, 2: { from: 1, idx: 2 }, 5: { from: 1, idx: 3 }, 4: { from: 1, idx: 4 } });
  assert.deepStrictEqual(r.leftover, {});
});
t('chain: לא נוגע במודעות עם קובץ משלהן, בלקוח אחר או בעמוד קודם; עודף מדווח', () => {
  const ads = [{ id: 1, customer_id: 9, page_number: 5 }, { id: 2, customer_id: 9, page_number: 4 }, { id: 3, customer_id: 9, page_number: 6 },
    { id: 4, customer_id: 8, page_number: 7 }, { id: 5, customer_id: 9, page_number: 8 }];
  const r = pibChainAds(ads, { 1: 4, 3: 1 }, new Set([1, 3]));
  assert.deepStrictEqual(r.assign, { 5: { from: 1, idx: 1 } });
  assert.deepStrictEqual(r.leftover, { 1: 2 });
});

console.log(`\n${passed} בדיקות עברו`);
