// בדיקות node למנוע השיבוץ האוטומטי (js/issues.js — alLayoutEngine וחבריו).
// הרצה: node tests/auto-layout.test.mjs
// הקובץ .mjs בכוונה — הסנכרון למופעים מעתיק רק *.js/*.html/*.css/*.json.
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);

// גלובלים מינימליים כדי שהקובץ ייטען מחוץ לדפדפן
global.Pages = {};
global.window = {};
global.cache = { settings: {}, priceList: [] };

const { alLayoutEngine, alPageCapacities, alParseCapacity, alItemUnits } = require('../js/issues.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

const U = 8;
function usedFrom(pages, fixed, placements, unitsById) {
  const used = {};
  for (let p = 1; p <= pages; p++) used[p] = 0;
  fixed.forEach(f => used[f.page] += f.units);
  placements.forEach(x => used[x.page] += unitsById[x.id]);
  return used;
}

/* ---------- קיבולת ---------- */
t('alPageCapacities: ברירת מחדל — עמוד 1 = 0, השאר U', () => {
  const c = alPageCapacities(4, U, {}, {});
  assert.deepStrictEqual(c, { 1: 0, 2: 8, 3: 8, 4: 8 });
});
t('alPageCapacities: דריסה גלובלית + לגיליון (הגיליון גובר) + "אחרון"', () => {
  const c = alPageCapacities(4, U, alParseCapacity('2:4, אחרון:0'), alParseCapacity('2:6'));
  assert.deepStrictEqual(c, { 1: 0, 2: 6, 3: 8, 4: 0 });
});
t('alParseCapacity: מתעלם מזבל, last באנגלית', () => {
  assert.deepStrictEqual(alParseCapacity('1:0, abc, last=2 ;5:3'), { '1': 0, last: 2, '5': 3 });
});

/* ---------- יחידות ---------- */
t('alItemUnits: מיפוי גובר; בלי מיפוי — הערכה לפי שם ומסומן', () => {
  const pl = [{ id: 1, name: 'חצי עמוד' }, { id: 2, name: 'מודעה מיוחדת' }, { id: 3, name: 'רבע עמוד' }];
  assert.deepStrictEqual(alItemUnits(1, U, { 1: 5 }, pl), { units: 5, mapped: true });
  assert.deepStrictEqual(alItemUnits(1, U, {}, pl), { units: 4, mapped: false });
  assert.deepStrictEqual(alItemUnits(2, U, {}, pl), { units: 1, mapped: false });
  assert.deepStrictEqual(alItemUnits(3, U, {}, pl), { units: 2, mapped: false });
  assert.deepStrictEqual(alItemUnits(null, U, {}, pl), { units: 2, mapped: false });
});

/* ---------- המנוע ---------- */
// 4 עמודים, עמוד 1 שמור; מודעה משובצת בעמוד 2 (4 יח'); מודעה קבועה מוצמדת לעמוד 4;
// מועמדים בגדלים מעורבים + חריגה מכוונת
const pages = 4;
const caps = alPageCapacities(pages, U, {}, {});
const fixed = [{ id: 100, page: 2, units: 4 }, { id: 101, page: 1, units: 8 }]; // 101 = שער (שמור, קיים)
const pinned = [{ id: 200, page: 4, units: 2 }];
const candidates = [
  { id: 1, units: 1 }, { id: 2, units: 8 }, { id: 3, units: 4 }, { id: 4, units: 2 },
  { id: 5, units: 8 }, { id: 6, units: 2 }, { id: 7, units: 4 },
];
const unitsById = {}; [...fixed, ...pinned, ...candidates].forEach(a => unitsById[a.id] = a.units);
const res = alLayoutEngine({ pages, pageUnits: U, caps, fixed, pinned, candidates });
const pageOf = id => (res.placements.find(x => x.id === id) || {}).page;

t('מנוע: אף עמוד לא חורג מהקיבולת (מעבר למה שכבר היה משובץ)', () => {
  const used = usedFrom(pages, fixed, res.placements, unitsById);
  for (let p = 2; p <= pages; p++) assert.ok(used[p] <= U, `עמוד ${p}: ${used[p]}`);
  assert.deepStrictEqual(used, res.used);
});
t('מנוע: עמוד 1 השמור לא מקבל מודעות חדשות', () => {
  assert.ok(!res.placements.some(x => x.page === 1));
});
t('מנוע: מודעות משובצות לא מוזזות ולא מופיעות בהצעה', () => {
  assert.ok(!res.placements.some(x => x.id === 100 || x.id === 101));
});
t('מנוע: מודעה קבועה נשארת בעמוד הקבוע שלה', () => {
  assert.strictEqual(pageOf(200), 4);
});
t('מנוע: first-fit-decreasing דטרמיניסטי', () => {
  // עמוד 2: 4 פנויות; 3: 8; 4: 6 (אחרי הקבועה)
  assert.strictEqual(pageOf(2), 3);   // 8 → עמוד 3 (הראשון עם 8 פנויות)
  assert.strictEqual(pageOf(3), 2);   // 4 → עמוד 2
  assert.strictEqual(pageOf(7), 4);   // 4 → עמוד 4 (נשארות 2)
  assert.strictEqual(pageOf(4), 4);   // 2 → עמוד 4 (מלא)
  assert.strictEqual(pageOf(6), undefined); // 2 → אין מקום
  assert.strictEqual(pageOf(1), undefined); // 1 → אין מקום
  const again = alLayoutEngine({ pages, pageUnits: U, caps, fixed, pinned, candidates: candidates.slice().reverse() });
  assert.deepStrictEqual(again.placements, res.placements);
});
t('מנוע: חריגה מדווחת עם סיבה, בלי קריסה', () => {
  const ids = res.overflow.map(o => o.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [1, 5, 6]);
  assert.ok(res.overflow.find(o => o.id === 5).reason.includes('8'));
  assert.strictEqual(res.placements.length + res.overflow.length, candidates.length + pinned.length);
});
t('מנוע: עמוד קבוע מלא / לא קיים → חריגה ולא דריסה', () => {
  const r = alLayoutEngine({ pages: 3, pageUnits: U, caps: alPageCapacities(3, U), fixed: [{ id: 9, page: 2, units: 8 }],
    pinned: [{ id: 10, page: 2, units: 1 }, { id: 11, page: 7, units: 1 }], candidates: [] });
  assert.strictEqual(r.placements.length, 0);
  assert.deepStrictEqual(r.overflow.map(o => o.id), [10, 11]);
});
t('מנוע: הרצה שנייה (אחרי אישור) לא נוגעת במשובצות', () => {
  const fixed2 = fixed.concat(res.placements.map(x => ({ id: x.id, page: x.page, units: unitsById[x.id] })));
  const left = candidates.filter(c => !pageOf(c.id));
  const r2 = alLayoutEngine({ pages, pageUnits: U, caps, fixed: fixed2, pinned: [], candidates: left });
  assert.strictEqual(r2.placements.length, 0);
  assert.ok(!r2.placements.some(x => fixed2.some(f => f.id === x.id)));
});

console.log(`\n${passed} בדיקות עברו`);
