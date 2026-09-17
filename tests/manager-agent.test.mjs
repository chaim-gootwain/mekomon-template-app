// בדיקות node ללוגיקה הטהורה של סוכן המקומון (js/manager-agent.js).
// הרצה: node tests/manager-agent.test.mjs
// הקובץ .mjs בכוונה — הסנכרון למופעים מעתיק רק *.js/*.html/*.css/*.json,
// כך שהבדיקות נשארות בתבנית ולא מגיעות לבאנדל או למופעים.
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);

// גלובלים מינימליים כדי שהקובץ ייטען מחוץ לדפדפן
global.Pages = {};
global.window = {};
global.cache = { settings: {} };

const { mgrBuildUserContent, mgrTrimMessages } = require('../js/manager-agent.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

/* ---------- mgrBuildUserContent ---------- */
t('mgrBuildUserContent: בלי הצעה תלויה → טקסט רגיל', () => {
  assert.strictEqual(mgrBuildUserContent(null, 'שלום'), 'שלום');
});
t('mgrBuildUserContent: עם הצעה תלויה → tool_result ואז טקסט', () => {
  const c = mgrBuildUserContent('toolu_1', 'בעצם משהו אחר');
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].type, 'tool_result');
  assert.strictEqual(c[0].tool_use_id, 'toolu_1');
  assert.strictEqual(c[1].type, 'text');
  assert.strictEqual(c[1].text, 'בעצם משהו אחר');
});

/* ---------- mgrTrimMessages ---------- */
const user = (txt) => ({ role: 'user', content: txt });
const asst = (blocks) => ({ role: 'assistant', content: blocks });
const toolResultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] };

t('mgrTrimMessages: תמליל קצר נשאר כמו שהוא', () => {
  const msgs = [user('א'), asst([{ type: 'text', text: 'ב' }]), user('ג')];
  assert.deepStrictEqual(mgrTrimMessages(msgs, 40), msgs);
});
t('mgrTrimMessages: גזירה עד הודעת משתמש רגילה — לא קוטע זוג tool_use/result', () => {
  const msgs = [
    user('ישן'), asst([{ type: 'tool_use', id: 'x', name: 't', input: {} }]), toolResultMsg,
    asst([{ type: 'text', text: 'תשובה' }]),
    user('חדש'), asst([{ type: 'text', text: 'ב' }]), user('אחרון'),
  ];
  const out = mgrTrimMessages(msgs, 4);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].content, 'חדש'); // דילג על ה-tool_result התלוש
});
t('mgrTrimMessages: הראשונה שנשארת לעולם לא tool_result', () => {
  const out = mgrTrimMessages([toolResultMsg, asst([]), user('שלום')], 40);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, 'שלום');
});
t('mgrTrimMessages: ריק/לא-מערך → ריק', () => {
  assert.deepStrictEqual(mgrTrimMessages([], 10), []);
  assert.deepStrictEqual(mgrTrimMessages(null, 10), []);
});

console.log('\n' + passed + ' בדיקות עברו');
