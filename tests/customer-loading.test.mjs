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
vm.runInContext(src + '\n;globalThis.__t = { custLoad, custLoadAll, custPortalToken, setProfile: (p) => { profile = p; }, setDb: (d) => { db = d; }, setToast: (f) => { toast = f; } };', ctx);
const T = ctx.__t;

/* db מזויף: טבלת customers בלבד, עם השרשראות שהקוד משתמש בהן.
   select(cols) מחזיר רק את העמודות שנבחרו — כמו Supabase. portal_token נשלף
   רק דרך RPC get_customer_portal_token (אבטחה, מיגרציה 2026-11-05). */
const ROWS = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, name: 'לקוח ' + (i + 1), portal_token: 'tok-' + (i + 1) }));
const fresh = () => ROWS.map(r => ({ ...r }));
const rpcCalls = [];
let MISSING = []; // עמודות שלא קיימות ב"מסד" (כמו updated_at בעמנואל)
function project(rows, cols) {
  if (!cols || cols === '*') return rows;
  const keep = cols.split(',').map(c => c.trim());
  return rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k))));
}
function fakeDb() {
  return {
    rpc(fn, args) {
      rpcCalls.push(fn);
      assert.strictEqual(fn, 'get_customer_portal_token');
      const r = ROWS.find(x => x.id === args.p_customer_id);
      return Promise.resolve({ data: r ? r.portal_token : null, error: null });
    },
    from(table) {
      assert.strictEqual(table, 'customers');
      const q = { rows: fresh() };
      const done = (data, error = null) => Promise.resolve(q.err ? { data: null, error: q.err } : { data, error });
      q.select = (cols) => {
        q.cols = cols;
        const miss = (cols || '').split(',').map(c => c.trim()).find(c => MISSING.includes(c));
        if (miss) q.err = { message: `column customers.${miss} does not exist`, code: '42703' };
        return q;
      };
      q.order = () => q;
      q.eq = (col, v) => { q.rows = q.rows.filter(r => r[col] === v); return q; };
      q.range = (f, t) => done(project(q.rows.slice(f, t + 1), q.cols));
      q.limit = (n) => done(project(q.rows.slice(0, n), q.cols));
      q.single = () => done(q.rows.length === 1 ? project(q.rows, q.cols)[0] : null, q.rows.length === 1 ? null : { message: 'not found' });
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

for (const role of ['admin', 'sales', 'editor', 'graphics']) {
  await t(`${role}: טעינה מלאה ובודדת — כל הלקוחות, בלי portal_token`, async () => {
    T.setProfile({ role });
    const all = await T.custLoadAll();
    assert.strictEqual(all.length, 2500, 'עימוד: כל הלקוחות נטענים מעבר ל-1000');
    assert.strictEqual(all[1500].name, 'לקוח 1501');
    assert.ok(all.every(r => !('portal_token' in r)), 'portal_token לא נשלף ב-SELECT הישיר');
    const one = await T.custLoad(7);
    assert.strictEqual(one.name, 'לקוח 7');
    assert.ok(!('portal_token' in one));
    const req = await T.custLoad(7, { required: true });
    assert.strictEqual(req.id, 7);
    assert.ok(!('portal_token' in req));
  });
}

for (const role of ['admin', 'manager', 'sales']) {
  await t(`${role}: portal_token דרך custPortalToken (RPC)`, async () => {
    T.setProfile({ role });
    assert.strictEqual(await T.custPortalToken(7), 'tok-7');
  });
}

for (const role of ['editor', 'graphics']) {
  await t(`${role}: custPortalToken מחזיר null בלי לפנות לשרת`, async () => {
    T.setProfile({ role });
    rpcCalls.length = 0;
    assert.strictEqual(await T.custPortalToken(7), null);
    assert.strictEqual(rpcCalls.length, 0);
  });
}

await t('עמודה שחסרה במסד של המופע (updated_at): הטעינה עובדת בלעדיה, בלי הודעת שגיאה', async () => {
  // סקריפט api.js נטען מחדש — המטמון של רשימת העמודות הוא לכל סשן
  const ctx2 = vm.createContext({
    console: { ...console, warn() { } }, setTimeout, document: stub, window: stub, location: stub, navigator: stub, supabase: stub,
    localStorage: { getItem: () => null, setItem() { } },
  });
  vm.runInContext(src + '\n;globalThis.__t = { custLoad, custLoadAll, setProfile: (p) => { profile = p; }, setDb: (d) => { db = d; }, setToast: (f) => { toast = f; } };', ctx2);
  const T2 = ctx2.__t;
  MISSING = ['updated_at', 'mailing_list'];
  const t2 = [];
  T2.setDb(fakeDb()); T2.setToast((m) => t2.push(m)); T2.setProfile({ role: 'admin' });
  try {
    const all = await T2.custLoadAll();
    assert.strictEqual(all.length, 2500);
    assert.strictEqual((await T2.custLoad(7)).name, 'לקוח 7');
    assert.strictEqual((await T2.custLoad(7, { required: true })).id, 7);
    assert.strictEqual(t2.length, 0, 'בלי toast שגיאה');
  } finally { MISSING = []; }
});

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
