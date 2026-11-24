// בדיקות node לשליחת חשבוניות אוטומטית (js/auto-invoice.js) אחרי "אמת מול מודפס".
// הרצה: node tests/auto-invoice.test.mjs
// הקבצים הם סקריפטים של דפדפן — נטענים ב-vm עם db מזויף ו-invCall מדומה.
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const rd = f => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
const stub = new Proxy(function () { return stub; }, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub });

function setup({ settings = {}, customers, issues, ads, docs = [] }) {
  const calls = { inv: [], mail: [], clips: [], inter: [], upserts: [] };
  const tables = { customers, issues, ads, documents: docs, settings: [] };
  const db = {
    from(t) {
      const q = { rows: (tables[t] || []).map(r => ({ ...r })) };
      const res = () => Promise.resolve({ data: q.rows, error: null });
      Object.assign(q, {
        select() { return q; },
        eq(c, v) { q.rows = q.rows.filter(r => r[c] === v); return q; },
        in(c, vs) { q.rows = q.rows.filter(r => vs.includes(r[c])); return q; },
        not(c, op, v) { const bad = v.replace(/[()"]/g, '').split(','); q.rows = q.rows.filter(r => !bad.includes(r[c])); return q; },
        ilike(c, p) { const re = new RegExp('^' + p.replace(/[-]/g, '\\-').replace(/%/g, '.*') + '$', 'i'); q.rows = q.rows.filter(r => re.test(r[c] || '')); return q; },
        maybeSingle() { return Promise.resolve({ data: q.rows[0] || null, error: null }); },
        upsert(v) { calls.upserts.push(v); tables.settings = tables.settings.filter(x => x.key !== v.key).concat([v]); return Promise.resolve({ error: null }); },
        then(a, b) { return res().then(a, b); },
      });
      return q;
    },
    functions: { invoke(fn, { body }) { calls.mail.push({ fn, body }); return Promise.resolve({ data: { ok: true }, error: null }); } },
  };
  let docN = 1000;
  const ctx = vm.createContext({
    console, setTimeout, Date, JSON, Math, document: stub, window: {},
    cache: { settings, customers: customers.map(c => ({ ...c })), issues, priceList: [] },
    profile: { role: 'admin', id: 'u1' }, db,
    run: async (p) => (await p).data,
    toast() { }, esc: s => String(s), money: n => '₪' + n, nameOf: (t, id) => 'C' + id,
    today: () => '2026-11-24', ISSUE_TYPE_HE: {},
    addInteraction: async (t, id, txt) => { calls.inter.push([id, txt]); },
    invoicesOn: () => true,
    invCall: async (body, opts) => {
      calls.inv.push({ body: JSON.parse(JSON.stringify(body)), opts });
      body.ad_ids.forEach(id => { const a = tables.ads.find(x => x.id === id); a.deal_stage = 'invoiced'; });
      tables.documents.push({ customer_id: body.customer_id, status: 'open', transaction_id: body.transaction_id });
      return { ok: true, document: { id: ++docN, doc_number: docN, doc_uuid: 'u' + docN }, pay_url: 'https://pay/x' };
    },
    adProofSendMonth: async (cid, iss, ym, o) => { calls.clips.push({ cid, iss, ym, o }); return { emailed: true }; },
    DOC_KIND_HE: { proforma: 'חשבון עסקה', tax_invoice: 'חשבונית מס' },
  });
  ctx.window = ctx;
  vm.runInContext(rd('issue-billing.js') + '\n' + rd('monthly-billing.js') + '\n'
    + 'var _pvState = null; async function _pvFinish(){ _pvState = null; }\n'
    + rd('auto-invoice.js') + '\n;globalThis.__t = { autoInvoiceAfterVerify, aiAutoList };', ctx);
  return { T: ctx.__t, calls, tables, ctx };
}

const CUST = [
  { id: 1, name: 'שבועי', email: 'a@x.co', order_doc_type: 'tax_invoice' },
  { id: 2, name: 'בלי מייל', email: '' },
  { id: 3, name: 'חודשי', email: 'm@x.co' },
  { id: 4, name: 'לא אוטומטי', email: 'n@x.co' },
];
const ISS = [
  { id: 10, issue_number: 100, print_date: '2026-11-10' },
  { id: 11, issue_number: 101, print_date: '2026-11-24' },
];
const mkAds = () => [
  { id: 1, issue_id: 11, customer_id: 1, price: 500, discount: 0, status: 'published', page_number: 3 },
  { id: 2, issue_id: 11, customer_id: 1, price: 0, discount: 0, status: 'published' },
  { id: 3, issue_id: 11, customer_id: 1, price: 200, discount: 0, status: 'published', deal_stage: 'invoiced' },
  { id: 4, issue_id: 11, customer_id: 2, price: 300, discount: 0, status: 'published' },
  { id: 5, issue_id: 10, customer_id: 3, price: 100, discount: 0, status: 'published' },
  { id: 6, issue_id: 11, customer_id: 3, price: 150, discount: 0, status: 'published' },
  { id: 7, issue_id: 11, customer_id: 4, price: 900, discount: 0, status: 'published' },
  { id: 8, issue_id: 11, customer_id: 1, price: 400, discount: 0, status: 'cancelled' },
];
const S = () => ({ auto_invoice_customers: '[1,2,3]', monthly_billing_customers: '[3]' });

// 1. שבועי: רק מודעות פתוחות עם מחיר; סוג מסמך מהכרטיס; תאריך = יום הדפוס; קישור תשלום; מייל נשלח
{
  const { T, calls } = setup({ settings: S(), customers: CUST, issues: ISS, ads: mkAds() });
  const html = await T.autoInvoiceAfterVerify(ISS[1]);
  const w = calls.inv.find(c => c.body.customer_id === 1);
  assert.ok(w, 'weekly invoice for customer 1');
  assert.deepStrictEqual(w.body.ad_ids, [1]);
  assert.strictEqual(w.body.doc_kind, 'tax_invoice');
  assert.strictEqual(w.body.doc_date, '2026-11-24');
  assert.strictEqual(w.body.pay_link, 'amount');
  assert.strictEqual(w.body.transaction_id, 'emu-iss11-cust1-tax_invoice');
  assert.ok(w.opts.stay);
  assert.ok(!calls.inv.some(c => c.body.customer_id === 4), 'non-auto customer untouched');
  assert.ok(!calls.inv.some(c => c.body.customer_id === 2), 'no-email customer skipped');
  assert.ok(html.includes('אין מייל'));
  const m = calls.mail.find(x => x.body.customer_id === 1);
  assert.ok(m && m.body.attach_document_id && m.body.body.includes('https://pay/x'), 'mail with doc + pay link');
  // 2. חודשי: 24/11 + 7 ימים = דצמבר → זה הגיליון האחרון → חשבונית חודשית על שני הגיליונות
  const mo = calls.inv.find(c => c.body.customer_id === 3);
  assert.ok(mo, 'monthly invoice');
  assert.deepStrictEqual(mo.body.ad_ids.sort(), [5, 6]);
  assert.strictEqual(mo.body.transaction_id, 'emu-monthly-2026-11-cust3-proforma');
  assert.strictEqual(mo.body.doc_date, '2026-11-30');
  assert.strictEqual(calls.clips.length, 1);
  assert.ok(calls.clips[0].o.invoice, 'invoice attached to month clips mail');
  assert.ok(!calls.mail.some(x => x.body.customer_id === 3), 'monthly sent once (with clips)');
  // 3. אימות חוזר — לא מפיק שוב
  const before = calls.inv.length;
  await T.autoInvoiceAfterVerify(ISS[1]);
  assert.strictEqual(calls.inv.length, before, 'no double invoicing on re-verify');
}

// 3ב. פריטים פתוחים נשמרים (בלי מייל) — והפקה מוצלחת מנקה פריט קודם
{
  const { T, calls, tables } = setup({ settings: S(), customers: CUST, issues: ISS, ads: mkAds() });
  tables.settings.push({ key: 'auto_invoice_pending', value: JSON.stringify([{ k: 'iss11-c1', cid: 1, since: '2026-11-01' }, { k: 'old', cid: 9, since: '2026-11-01' }]) });
  await T.autoInvoiceAfterVerify(ISS[1]);
  const pend = JSON.parse(tables.settings.find(x => x.key === 'auto_invoice_pending').value);
  const keys = pend.map(p => p.k).sort();
  assert.deepStrictEqual(keys, ['iss11-c2', 'old'], 'c1 cleared, c2 added, unrelated kept');
  const c2 = pend.find(p => p.k === 'iss11-c2');
  assert.deepStrictEqual(c2.ad_ids, [4]);
  assert.strictEqual(c2.since, '2026-11-24');
}

// 4. גיליון באמצע החודש — חודשי לא מופק; שבועי כן
{
  const { T, calls } = setup({ settings: S(), customers: CUST, issues: ISS, ads: mkAds() });
  await T.autoInvoiceAfterVerify(ISS[0]);
  assert.ok(!calls.inv.some(c => c.body.customer_id === 3), 'monthly waits for month end');
}

// 5. EZcount שולח בעצמו → לא שולחים מייל נוסף
{
  const st = Object.assign(S(), { ezcount_autosend: '1' });
  const { T, calls } = setup({ settings: st, customers: CUST, issues: ISS, ads: mkAds() });
  await T.autoInvoiceAfterVerify(ISS[1]);
  assert.ok(!calls.mail.some(x => x.fn === 'send-email'), 'no extra send-email when EZcount autosend is on');
  assert.ok(!calls.clips[0].o.invoice, 'no duplicate invoice attachment');
}

// 6. אין לקוחות אוטומטיים — לא נוגע בכלום
{
  const { T, calls } = setup({ settings: {}, customers: CUST, issues: ISS, ads: mkAds() });
  assert.strictEqual(await T.autoInvoiceAfterVerify(ISS[1]), '');
  assert.strictEqual(calls.inv.length, 0);
}

// 7. חשבונית גיליון קיימת (ידנית) — לא מפיקים שוב, מדווחים
{
  const { T, calls } = setup({ settings: S(), customers: CUST, issues: ISS, ads: mkAds(), docs: [{ customer_id: 1, status: 'open', transaction_id: 'emu-iss11-cust1-proforma' }] });
  const html = await T.autoInvoiceAfterVerify(ISS[1]);
  assert.ok(!calls.inv.some(c => c.body.customer_id === 1));
  assert.ok(html.includes('כבר הופקה'));
}

console.log('auto-invoice: all tests passed');
