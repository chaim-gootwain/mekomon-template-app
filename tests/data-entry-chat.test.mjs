// בדיקות node ללוגיקה הטהורה של בוט הזנת הנתונים (js/data-entry-chat.js).
// הרצה: node tests/data-entry-chat.test.mjs
// הקובץ .mjs בכוונה — הסנכרון למופעים מעתיק רק *.js/*.html/*.css/*.json,
// כך שהבדיקות נשארות בתבנית ולא מגיעות לבאנדל או למופעים.
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);

// גלובלים מינימליים כדי שהקובץ ייטען מחוץ לדפדפן
global.Pages = {};
global.window = {};
global.cache = { settings: {} };

const { deNorm, deMatchSize, deDealNums, deMapIssues, deDealTotals } =
  require('../js/data-entry-chat.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

/* ---------- deDealNums ---------- */
t('deDealNums: רצף רגיל', () => {
  assert.deepStrictEqual(deDealNums(4, 295), [295, 296, 297, 298]);
});
t('deDealNums: בלי גיליון התחלה → ריק', () => {
  assert.deepStrictEqual(deDealNums(4, 0), []);
});
t('deDealNums: בלי כמות → ריק', () => {
  assert.deepStrictEqual(deDealNums(0, 295), []);
});
t('deDealNums: קלט לא-מספרי → ריק', () => {
  assert.deepStrictEqual(deDealNums('abc', 'xyz'), []);
});

/* ---------- deMapIssues ---------- */
const issues = [
  { id: 11, issue_number: 295 },
  { id: 12, issue_number: 296 },
  { id: 13, issue_number: 300 },
];
t('deMapIssues: קיימים וחסרים', () => {
  const m = deMapIssues([295, 296, 297, 298], issues);
  assert.deepStrictEqual(m.existing, [{ num: 295, id: 11 }, { num: 296, id: 12 }]);
  assert.deepStrictEqual(m.missing, [297, 298]);
  assert.strictEqual(m.maxExisting, 300);
});
t('deMapIssues: חסר-עבר מול חסר-עתיד', () => {
  const m = deMapIssues([297, 301], issues);
  // 297 חסר אבל לפני הגיליון האחרון (300) → לא ניתן ליצירה אוטומטית
  assert.deepStrictEqual(m.missing.filter(x => x <= m.maxExisting), [297]);
  assert.deepStrictEqual(m.missing.filter(x => x > m.maxExisting), [301]);
});
t('deMapIssues: בלי גיליונות בכלל', () => {
  const m = deMapIssues([1, 2], []);
  assert.deepStrictEqual(m.existing, []);
  assert.deepStrictEqual(m.missing, [1, 2]);
  assert.strictEqual(m.maxExisting, 0);
});

/* ---------- deDealTotals (אותה נוסחה כמו new_deal בצ'אט החשבוניות) ---------- */
t('deDealTotals: מחיר לפני מע"מ', () => {
  const r = deDealTotals(4, 250, false, 18);
  assert.strictEqual(r.base, 1000);
  assert.strictEqual(r.vat, 180);
  assert.strictEqual(r.total, 1180);
});
t('deDealTotals: מחיר כולל מע"מ — הסה"כ נשאר הסכום שנאמר', () => {
  const r = deDealTotals(4, 250, true, 18);
  assert.strictEqual(r.total, 1000);
  assert.strictEqual(r.base, Math.round(1000 / 1.18 * 100) / 100);
});
t('deDealTotals: עיגול אגורות', () => {
  const r = deDealTotals(3, 333.33, false, 18);
  assert.strictEqual(r.base, 999.99);
  assert.strictEqual(r.vat, 180);
  assert.strictEqual(r.total, 1179.99);
});

/* ---------- deMatchSize ---------- */
const priceList = [
  { id: 1, name: 'רבע עמוד', price: 250 },
  { id: 2, name: 'חצי עמוד', price: 450 },
  { id: 3, name: 'עמוד שלם', price: 800 },
];
t('deMatchSize: התאמה מדויקת', () => {
  assert.strictEqual(deMatchSize('רבע עמוד', priceList).id, 1);
});
t('deMatchSize: התאמה חלקית ("חצי")', () => {
  assert.strictEqual(deMatchSize('חצי', priceList).id, 2);
});
t('deMatchSize: סובלנות לגרשיים ורווחים', () => {
  assert.strictEqual(deMatchSize('רבע-עמוד', priceList).id, 1);
  assert.strictEqual(deNorm('רבע "עמוד"'), deNorm('רבע עמוד'));
});
t('deMatchSize: אין התאמה → null', () => {
  assert.strictEqual(deMatchSize('באנר ענק', priceList), null);
});
t('deMatchSize: מחירון ריק / קלט ריק → null', () => {
  assert.strictEqual(deMatchSize('רבע עמוד', []), null);
  assert.strictEqual(deMatchSize(null, priceList), null);
});

console.log(`\n${passed} בדיקות עברו${process.exitCode ? ' (יש כשלונות!)' : ''}`);
