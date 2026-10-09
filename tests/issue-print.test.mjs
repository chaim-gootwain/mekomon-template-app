// בדיקות node ללוגיקה הטהורה של הרכבת ה-PDF לדפוס (js/issue-print.js).
// הרצה: node tests/issue-print.test.mjs
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
global.Pages = {}; global.window = {}; global.cache = { settings: {} };
const { pibBidiRuns, pibHebNum, pibMasterLeftovers, pibCellsFor, pibPackPage, pibSlotRect, pibGrid, pibPageSet, pibFieldText } = require('../js/issue-print.js');

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
  const found = pibMasterLeftovers(['0583-221-232 ', ':להצעת פרסום משתלמת במיוחד חייגו כעת', '05.10.26  |כ"ד תשרי306 גיליון', '2']);
  assert.deepStrictEqual(found, ['05.10.26  |כ"ד תשרי306 גיליון', '2']);
  assert.deepStrictEqual(pibMasterLeftovers(['0583-221-232 :להצעת פרסום משתלמת במיוחד חייגו כעת']), []);
});

/* ---------- עזרים ---------- */
t('pageSet + fieldText', () => {
  assert.deepStrictEqual([...pibPageSet('1, אחרון', 32)].sort((a, b) => a - b), [1, 32]);
  assert.strictEqual(pibFieldText('גיליון {issue} עמ\' {page} {x}', { issue: 306, page: 2 }), "גיליון 306 עמ' 2 {x}");
});

console.log(`\n${passed} בדיקות עברו`);
