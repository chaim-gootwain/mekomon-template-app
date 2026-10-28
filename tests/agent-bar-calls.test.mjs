// בדיקות node ל"השיחות שלי" בפאנל הסוכן (_abBuildCalls ב-js/agent-bar.js).
// הרצה: node tests/agent-bar-calls.test.mjs
// הקובץ .mjs בכוונה — הסנכרון למופעים מעתיק רק *.js/*.html/*.css/*.json.
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);

// גלובלים מינימליים כדי שהקובץ ייטען מחוץ לדפדפן
global.cache = { settings: {}, customers: [{ id: 7, name: 'פיצה כהן', phone: '054-111-2222' }] };
global.normPhone = p => {
  if (!p) return '';
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('+972')) s = '0' + s.slice(4);
  else if (s.startsWith('972')) s = '0' + s.slice(3);
  return s.replace(/\D/g, '');
};

const { _abBuildCalls } = require('../js/agent-bar.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}
const out = (number, at, answered) => ({ id: 'o' + at, at, dir: 'out', number, answered, sec: answered ? 60 : 0 });
const inc = (number, at, answered) => ({ id: 'i' + at, at, dir: 'in', number, answered, sec: answered ? 60 : 0 });
const by = rows => Object.fromEntries(rows.map(r => [r.number, r]));

t('לא ענה → no_answer עם מספר ניסיונות', () => {
  const r = by(_abBuildCalls([], [out('0501', 10, false), out('0501', 20, false)]));
  assert.strictEqual(r['0501'].state, 'no_answer');
  assert.strictEqual(r['0501'].outs, 2);
});
t('לא ענה ואז חזר ולא נענה → cb_missed', () => {
  const r = by(_abBuildCalls([], [out('0501', 10, false), inc('0501', 30, false)]));
  assert.strictEqual(r['0501'].state, 'cb_missed');
  assert.deepStrictEqual(r['0501'].inIds, ['i30']);
});
t('חזר ונענה → cb_answered', () => {
  const r = by(_abBuildCalls([], [out('0501', 10, false), inc('0501', 30, true)]));
  assert.strictEqual(r['0501'].state, 'cb_answered');
});
t('חזר ולא נענה, ואז חייגתי שוב ונענה → answered', () => {
  const r = by(_abBuildCalls([], [out('0501', 10, false), inc('0501', 30, false), out('0501', 40, true)]));
  assert.strictEqual(r['0501'].state, 'answered');
});
t('מיון: חזר-לא-נענה לפני לא-ענה לפני נענה', () => {
  const rows = _abBuildCalls([], [out('0503', 50, true), out('0502', 40, false), out('0501', 10, false), inc('0501', 20, false)]);
  assert.deepStrictEqual(rows.map(r => r.state), ['cb_missed', 'no_answer', 'answered']);
});
t('ייחוס: call_log גובר, אחרת טלפון של לקוח מהמטמון', () => {
  const log = [{ target: '0501', entity_type: 'lead', entity_id: 9, created_at: '2026-10-28T08:00:00Z' }];
  const r = by(_abBuildCalls(log, [out('0501', 10, false), out('0541112222', 20, false), out('0599', 30, false)]));
  assert.deepStrictEqual(r['0501'].ent, { type: 'lead', id: 9 });
  assert.deepStrictEqual(r['0541112222'].ent, { type: 'customer', id: 7 });
  assert.strictEqual(r['0599'].ent, null);
});
t('בלי Voicenter — נבנה מ-call_log בסטטוס dialed', () => {
  const log = [
    { target: '0501', entity_type: 'customer', entity_id: 3, created_at: '2026-10-28T08:00:00Z' },
    { target: '0501', entity_type: 'customer', entity_id: 3, created_at: '2026-10-28T09:00:00Z' },
  ];
  const rows = _abBuildCalls(log, null);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'dialed');
  assert.strictEqual(rows[0].outs, 2);
  assert.strictEqual(rows[0].at, Date.parse('2026-10-28T09:00:00Z') / 1000);
});
t('voicenter-stats ישן (ok בלי calls) — לא קורס', () => {
  const rows = _abBuildCalls([{ target: '0501', created_at: '2026-10-28T08:00:00Z' }], undefined);
  assert.strictEqual(rows[0].state, 'dialed');
});

console.log(`\n${passed} בדיקות עברו`);
