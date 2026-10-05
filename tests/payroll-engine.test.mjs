// בדיקות node למנוע רווחיות/שכר/עמלות (js/payroll-engine.js).
// הרצה: node tests/payroll-engine.test.mjs
// הקובץ .mjs בכוונה — הסנכרון למופעים מעתיק רק *.js/*.html/*.css/*.json.
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);

const E = require('../js/payroll-engine.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓ ' + name); }
  catch (e) { console.error('✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}
const eq = (a, b, msg) => assert.strictEqual(Math.round(a * 100) / 100, Math.round(b * 100) / 100, msg);

/* ---------- מערך נתונים סינתטי ----------
   סוכנים: 1 = רחל (בסיס+עמלה, יעד 10,000) · 2 = לאה (עמלה בלבד, יעד 5,000)
           3 = שרה (מנהלת מוקד: 10% מהכנסות 1+2, וגם מוכרת בעצמה)
   גיליונות: 11 = 2026-09, 12 = 2026-10 (שניים), 13 = 2026-11 */
const issues = [
  { id: 11, print_date: '2026-09-28' },
  { id: 12, print_date: '2026-10-05' },
  { id: 14, print_date: '2026-10-19' },
  { id: 13, publish_date: '2026-11-02' },
];
const contracts = [
  // חבילה ל-3 חודשים של רחל: 3 × 4,000 = 12,000
  { id: 100, agent_id: 1, customer_id: 501, total_inserts: 3, total_price: 12000 },
  // חוזה של פרסום אחד — מתנהג כמו מודעה בודדת
  { id: 101, agent_id: 2, customer_id: 502, total_inserts: 1, total_price: 2000 },
];
const ads = [
  // רחל — בודדת באוקטובר, מעוצבת אצלנו
  { id: 1, agent_id: 1, customer_id: 500, issue_id: 12, price: 9000, discount: 1000, status: 'published', design_fee_net: 50 },
  // רחל — חבילת 3 חודשים (ספט׳/אוק׳/נוב׳)
  { id: 2, agent_id: 1, customer_id: 501, contract_id: 100, issue_id: 11, price: 4000, discount: 0, status: 'published' },
  { id: 3, agent_id: 1, customer_id: 501, contract_id: 100, issue_id: 12, price: 4000, discount: 0, status: 'published', design_fee_net: 50 },
  { id: 4, agent_id: 1, customer_id: 501, contract_id: 100, issue_id: 13, price: 4000, discount: 0, status: 'placed' },
  // לאה — בודדת מוכנה (בלי עיצוב) + חוזה של פרסום אחד, באוקטובר
  { id: 5, agent_id: 2, customer_id: 502, issue_id: 14, price: 3000, discount: 0, status: 'published' },
  { id: 6, agent_id: 2, customer_id: 502, contract_id: 101, issue_id: 12, price: 2000, discount: 0, status: 'published' },
  // לאה — מבוטלת: לא נספרת
  { id: 7, agent_id: 2, customer_id: 502, issue_id: 12, price: 9999, discount: 0, status: 'cancelled' },
  // שרה — מכירה משלה, מעוצבת
  { id: 8, agent_id: 3, customer_id: 503, issue_id: 12, price: 1000, discount: 0, status: 'published', design_fee_net: 50 },
  // מודעה מבוטלת שסומנה עיצוב — לא עלות
  { id: 9, agent_id: 3, customer_id: 503, issue_id: 12, price: 0, discount: 0, status: 'cancelled', design_fee_net: 50 },
  // בלי סוכן במודעה ובלי סוכן ללקוח → נזקפת למנהל (סוכן ברירת מחדל 4)
  { id: 11, agent_id: null, customer_id: 506, issue_id: 12, price: 700, discount: 0, status: 'published' },
  // מודעה בלי סוכן — הכנסה ל"ללא סוכן" דרך הלקוח (customer 505 → agent 2)
  { id: 10, agent_id: null, customer_id: 505, issue_id: 12, price: 500, discount: 0, status: 'published' },
];
const customers = [{ id: 505, agent_id: 2 }, { id: 506, agent_id: null }];
const comps = [
  { agent_id: 1, base_salary: 6000, monthly_target: 10000, commission_pct_base: 5, commission_pct_above: 10, active: true },
  { agent_id: 2, base_salary: null, monthly_target: 5000, commission_pct_base: 10, commission_pct_above: 15, active: true },
  { agent_id: 3, base_salary: 8000, monthly_target: 0, commission_pct_base: 4, commission_pct_above: null, active: true },
];
const managerCuts = [{ manager_agent_id: 3, source_agent_ids: [1, 2], pct: 10, active: true }];

// הלקוח משלם ₪50 על עיצוב; עלות הגרפיקה לעסק ₪30 למודעה
const base = { issues, contracts, ads, customers, comps, managerCuts, defaultAgentId: 4, graphicsCostNet: 30 };

/* ---------- מדרגות ---------- */
t('pfTiers: בסיס/מעל-יעד → שתי מדרגות', () => {
  assert.deepStrictEqual(E.pfTiers(comps[0]), [{ from: 0, pct: 5 }, { from: 10000, pct: 10 }]);
});
t('pfTiers: יעד 0 → מדרגה אחת', () => {
  assert.deepStrictEqual(E.pfTiers(comps[2]), [{ from: 0, pct: 4 }]);
});
t('pfTiers: tiers מפורש גובר (יותר משתי מדרגות)', () => {
  const c = { commission_pct_base: 1, tiers: [{ from: 20000, pct: 12 }, { from: 0, pct: 5 }, { from: 10000, pct: 8 }] };
  assert.deepStrictEqual(E.pfTiers(c).map(x => x.pct), [5, 8, 12]);
  eq(E.pfTieredCommission(25000, E.pfTiers(c)).total, 10000 * .05 + 10000 * .08 + 5000 * .12);
});
t('עמלה מתחת ליעד — רק אחוז הבסיס', () => {
  eq(E.pfTieredCommission(8000, E.pfTiers(comps[0])).total, 400);
});
t('עמלה מעל היעד — בסיס עד היעד + אחוז גבוה על העודף', () => {
  eq(E.pfTieredCommission(14000, E.pfTiers(comps[0])).total, 10000 * .05 + 4000 * .10);
});

/* ---------- סגירת חודש ---------- */
t('סגירת חודש: רק עסקה רב-גיליונית מופיעה, עם חלק החודש כהצעה', () => {
  const rows = E.pfMonthCloseRows('2026-10', { ...base, recognition: [] });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.contract_id, 100);
  assert.strictEqual(r.issues_total, 3);
  assert.strictEqual(r.issues_run, 2);
  assert.strictEqual(r.issues_remaining, 1);
  eq(r.month_portion, 4000);
  // ספטמבר לא נסגר → ההצעה כוללת גם את מה שנדחה (8,000)
  eq(r.suggested, 8000);
  assert.strictEqual(r.default_included, true);
});
t('סגירת חודש: אחרי שספטמבר הוכר — ההצעה לאוקטובר היא חלק החודש בלבד', () => {
  const recognition = [{ contract_id: 100, agent_id: 1, month: '2026-09', amount_recognized: 4000, included: true }];
  const r = E.pfMonthCloseRows('2026-10', { ...base, recognition })[0];
  eq(r.prior_recognized, 4000);
  eq(r.suggested, 4000);
  eq(r.remaining, 8000);
});
t('סגירת חודש: פתיחה מחדש מציגה את ההחלטה הקודמת', () => {
  const recognition = [{ contract_id: 100, agent_id: 1, month: '2026-10', amount_recognized: 1500, included: false }];
  const r = E.pfMonthCloseRows('2026-10', { ...base, recognition })[0];
  assert.strictEqual(r.default_included, false);
  eq(r.default_amount, 1500);
});

/* ---------- חישוב חודש מלא (אוקטובר) ---------- */
const recOct = [
  { contract_id: 100, agent_id: 1, month: '2026-09', amount_recognized: 4000, included: true },
  { contract_id: 100, agent_id: 1, month: '2026-10', amount_recognized: 4000, included: true },
];
const oct = E.pfComputeMonth('2026-10', { ...base, recognition: recOct, bonuses: [{ agent_id: 2, month: '2026-10', amount: 250 }] });
const r1 = oct.agents[1], r2 = oct.agents[2], r3 = oct.agents[3];

t('רחל: הכנסה = בודדת 8,000 + הכרה 4,000 (החבילה לא נספרת פעמיים)', () => {
  eq(r1.revenue_single, 8000); eq(r1.revenue_deals, 4000); eq(r1.revenue, 12000);
});
t('רחל: עיצוב — 2 מודעות מעוצבות: חיוב ללקוח 100, עלות גרפיקה 60', () => {
  assert.strictEqual(r1.designed_count, 2); eq(r1.design_revenue, 100); eq(r1.graphics, 60);
});
t('חיוב העיצוב לא נכנס לבסיס העמלה', () => {
  eq(r1.revenue, 12000);
});
t('רחל: מעל היעד — 5% עד 10,000 + 10% על 2,000', () => {
  eq(r1.commission, 500 + 200);
});
t('רחל: רווחיות = הכנסה + חיובי עיצוב − עלות גרפיקה − עמלה; שכר בסיס בנפרד', () => {
  eq(r1.profitability, 12000 + 100 - 60 - 700);
  eq(r1.base_salary, 6000); assert.strictEqual(r1.commission_only, false);
  eq(r1.pay_total, 6000 + 700);
});
t('לאה: עמלה בלבד, ללא עיצוב (מודעה מוכנה), חוזה-של-אחד נספר כבודדת, מבוטלת לא נספרת', () => {
  eq(r2.revenue, 3000 + 2000 + 500); // כולל מודעה בלי סוכן שהלקוח שלה משויך ללאה
  eq(r2.graphics, 0);
  assert.strictEqual(r2.commission_only, true); eq(r2.base_salary, 0);
  eq(r2.commission, 5000 * .10 + 500 * .15);
});
t('לאה: בונוס ידני נכנס לסה"כ לתשלום, לא לרווחיות', () => {
  eq(r2.bonus, 250);
  eq(r2.pay_total, 575 + 250);
  eq(r2.profitability, 5500 - 0 - 575);
});
t('שרה (מנהלת): נתח = 10% מההכנסה המוכרת של רחל+לאה — תוספת', () => {
  eq(r3.manager_cut_base, 12000 + 5500);
  eq(r3.manager_cut, 1750);
  eq(r3.commission, 40); // 4% על המכירה שלה בלבד
  eq(r3.pay_total, 8000 + 40 + 1750);
});
t('נתח המנהלת לא מנכה מהעמלה של הנציגות', () => {
  const noCut = E.pfComputeMonth('2026-10', { ...base, managerCuts: [], recognition: recOct });
  eq(noCut.agents[1].commission, r1.commission);
  eq(noCut.agents[2].commission, r2.commission);
});
t('עיצוב לפי הכפתור במודעה: רק מודעות שסומנו ולא מבוטלות', () => {
  eq(oct.totals.design_revenue, 50 * 3); // 1, 3, 8 — לא 9 (מבוטלת)
  eq(oct.totals.graphics, 30 * 3);
});
t('חיוב העיצוב = הסכום שנשמר במודעה (תעריף שהשתנה לא משנה עבר)', () => {
  const a2 = ads.map(a => a.id === 1 ? { ...a, design_fee_net: 40 } : a);
  eq(E.pfComputeMonth('2026-10', { ...base, ads: a2, recognition: recOct }).agents[1].design_revenue, 90);
});
t('בלי הגדרת עלות גרפיקה — העלות כגובה החיוב', () => {
  eq(E.pfComputeMonth('2026-10', { ...base, graphicsCostNet: null, recognition: recOct }).agents[1].graphics, 100);
});
t('מודעה בלי סוכן וללקוח אין סוכן → על שם המנהל (סוכן ברירת מחדל)', () => {
  eq(oct.agents[4].revenue, 700);
  assert.strictEqual(oct.agents[0], undefined);
});
t('בלי סוכן ברירת מחדל → נשארת "ללא סוכן"', () => {
  const m = E.pfComputeMonth('2026-10', { ...base, defaultAgentId: null, recognition: recOct });
  eq(m.agents[0].revenue, 700);
});

/* ---------- חודש שהוחרג בסגירה ---------- */
t('עסקה שהוחרגה בסגירת החודש תורמת 0', () => {
  const recEx = [{ contract_id: 100, agent_id: 1, month: '2026-10', amount_recognized: 4000, included: false }];
  const m = E.pfComputeMonth('2026-10', { ...base, recognition: recEx });
  eq(m.agents[1].revenue_deals, 0);
  eq(m.agents[1].revenue, 8000);
});
t('חודש שלא נסגר: עסקה רב-גיליונית לא מוכרת אוטומטית', () => {
  const m = E.pfComputeMonth('2026-11', { ...base, recognition: [] });
  eq(m.agents[1].revenue, 0);
});

/* ---------- רווח והפסד ---------- */
t('pfClassifyExpenses: גרפיקה/גיליון/כללי לפי תיוג, נטו מ-#net:', () => {
  const ex = E.pfClassifyExpenses([
    { amount: 3068, notes: '#issue:12;#cat:דפוס;#net:2600;' },
    { amount: 590, notes: '#issue:12;#cat:הפצה;#net:500;' },
    { amount: 118, notes: '#issue:12;#cat:גרפיקה;#net:100;' },
    { amount: 300, notes: 'שכירות' },
  ]);
  assert.deepStrictEqual(ex, { issue_print: 3100, issue_graphics: 100, other: 300, payroll_synced: 0, payroll_manual: 0 });
});
t('שכר לא נספר פעמיים: שורות #payroll ושכר בקטגוריית שכר מוחרגים מההוצאות הכלליות', () => {
  const ex = E.pfClassifyExpenses([
    { amount: 6700, notes: '#payroll:2026-10;#agent:1;#net:6700;' },
    { amount: 8000, notes: 'משכורת שרה', category_id: 7 },
    { amount: 300, notes: 'שכירות', category_id: 2 },
  ], [7]);
  assert.deepStrictEqual(ex, { issue_print: 0, issue_graphics: 0, other: 300, payroll_synced: 6700, payroll_manual: 8000 });
  const p = E.pfPnl(oct, ex);
  eq(p.net, p.operating - 300);
});
t('סנכרון שכר: שורה מתויגת לכל עובד עם סכום, סכום = לתשלום', () => {
  const rows = E.pfPayrollSyncRows(oct);
  assert.deepStrictEqual(rows.map(r => r.agent_id).sort(), [1, 2, 3]);
  const r1s = rows.find(r => r.agent_id === 1);
  eq(r1s.amount, oct.agents[1].pay_total);
  assert.strictEqual(r1s.tag, '#payroll:2026-10;#agent:1;');
  assert.ok(r1s.notes.startsWith(r1s.tag) && r1s.notes.includes('#net:' + r1s.amount + ';'));
  // והשורה הזו מזוהה בדוח כשכר מסונכרן
  eq(E.pfClassifyExpenses([{ amount: r1s.amount, notes: r1s.notes }]).payroll_synced, r1s.amount);
});
t('רווח והפסד: השכבות נסגרות בדיוק ומתאימות לסכום העובדים', () => {
  const ex = { issue_print: 3100, issue_graphics: 100, other: 300 };
  const p = E.pfPnl(oct, ex);
  // הכנסה כוללת: רחל 12,000 + לאה 5,500 + שרה 1,000 + מנהל 700
  eq(p.revenue, 19200);
  eq(p.revenue, Object.values(oct.agents).reduce((s, r) => s + r.revenue, 0));
  eq(p.design_revenue, 150);
  eq(p.income, 19350);
  eq(p.graphics, 90 + 100);
  eq(p.gross, 19350 - 190);
  eq(p.after_issue, p.gross - 3100);
  eq(p.commissions, 700 + 575 + 40 + 1750);
  eq(p.after_commissions, p.after_issue - p.commissions);
  eq(p.salaries, 6000 + 8000 + 250);
  eq(p.operating, p.after_commissions - p.salaries);
  eq(p.net, p.operating - 300);
  // שכר כולל במסך השכר = עמלות + נתח + בסיס + בונוס בדוח
  eq(oct.totals.pay_total, p.commissions + p.salaries);
});
t('רווחיות עובדים מצטברת = הכנסה + חיובי עיצוב − עלות גרפיקה − עמלות (בלי נתח מנהלת ובסיס)', () => {
  eq(oct.totals.profitability, oct.totals.revenue + oct.totals.design_revenue - oct.totals.graphics - oct.totals.commission);
});

console.log(`\n${passed} בדיקות עברו`);
