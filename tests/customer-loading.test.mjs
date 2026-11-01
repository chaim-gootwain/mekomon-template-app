// בדיקות node לטעינת לקוחות המרכזית (custLoad / custLoadAll ב-js/api.js).
// הרצה: node tests/customer-loading.test.mjs
// api.js הוא סקריפט דפדפן ולא מודול, לכן נטען ב-vm עם גלובלים מדומים ו-db מזויף.
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
const stub = new Proxy(function () { return stub; }, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub });
const ctx = vm.createContext({
  console, setTimeout, document: stub, window: stub, location: stub, navigator: stub, supabase: stub,
  localStorage: { getItem: () => null, setItem() { } },
});
vm.runInContext(src + '\n;globalThis.__t = { custLoad, custLoadAll, setProfile: (p) => { profile = p; }, setDb: (d) => { db = d; }, setToast: (f) => { toast = f; } };', ctx);
const T = ctx.__t;

/* db מזויף: טבלת customers בלבד, עם השרשראות שהקוד משתמש בהן */
const ROWS = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, name: 'לקוח ' + (i + 1), portal_token: 'tok-' + (i + 1) }));
const fresh = () => ROWS.map(r => ({ ...r }));
function fakeDb() {
  return {
    from(table) {
      assert.strictEqual(table, 'customers');
      const q = { rows: fresh() };
      const done = (data, error = null) => Promise.resolve({ data, error });
      q.select = () => q;
      q.order = () => q;
      q.eq = (col, v) => { q.rows = q.rows.filter(r => r[col] === v); return q; };
      q.range = (f, t) => done(q.rows.slice(f, t + 1));
      q.limit = (n) => done(q.rows.slice(0, n));
      q.single = () => done(q.rows.length === 1 ? q.rows[0] : null, q.rows.length === 1 ? null : { message: 'not found' });
      return q;
    },
  };
}
T.setDb(fakeDb());
const toasts = [];
T.setToast((m) => toasts.push(m));

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

for (const role of ['admin', 'sales']) {
  await t(`${role}: רואה את portal_token בטעינה מלאה ובודדת`, async () => {
    T.setProfile({ role });
    const all = await T.custLoadAll();
    assert.strictEqual(all.length, 2500, 'עימוד: כל הלקוחות נטענים מעבר ל-1000');
    assert.strictEqual(all[1500].portal_token, 'tok-1501');
    assert.strictEqual((await T.custLoad(7)).portal_token, 'tok-7');
    assert.strictEqual((await T.custLoad(7, { required: true })).portal_token, 'tok-7');
  });
}

for (const role of ['editor', 'graphics']) {
  await t(`${role}: portal_token מוסר בכל דרכי הטעינה`, async () => {
    T.setProfile({ role });
    const all = await T.custLoadAll();
    assert.strictEqual(all.length, 2500);
    assert.ok(all.every(r => !('portal_token' in r)));
    const one = await T.custLoad(7);
    assert.strictEqual(one.name, 'לקוח 7');
    assert.ok(!('portal_token' in one));
    assert.ok(!('portal_token' in await T.custLoad(7, { required: true })));
  });
}

await t('לקוח שלא קיים: בלי required מחזיר undefined, בלי שגיאה', async () => {
  T.setProfile({ role: 'editor' });
  toasts.length = 0;
  assert.strictEqual(await T.custLoad(999999), undefined);
  assert.strictEqual(toasts.length, 0);
});

await t('לקוח שלא קיים עם required: זורק ומציג שגיאה, כמו .single()', async () => {
  T.setProfile({ role: 'admin' });
  toasts.length = 0;
  await assert.rejects(() => T.custLoad(999999, { required: true }));
  assert.strictEqual(toasts.length, 1);
});

console.log(`\n${passed} בדיקות עברו`);
