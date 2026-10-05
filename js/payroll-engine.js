/* ============================================================
   payroll-engine.js — מנוע החישוב של רווחיות, שכר ועמלות
   ------------------------------------------------------------
   פונקציות טהורות בלבד: מקבלות נתונים, מחזירות מספרים. בלי db,
   בלי DOM, בלי כתיבה — כך שאפשר לבדוק אותן ב-node
   (tests/payroll-engine.test.mjs) ושכל המסכים (סגירת חודש, שכר,
   "הביצועים שלי", רווח והפסד) מחשבים מאותו מקור.

   כללי הכסף (כולם נטו, לפני מע"מ — כמו תגי #net: של עלויות הגיליון):
   • נטו מודעה = max(0, price − discount)  (כמו דוח הרווחיות הקיים)
   • חודש מודעה = חודש print_date של הגיליון (או publish_date) — כמו
     דוח "רווח והפסד" הקיים, כדי שהכנסה ועלות של גיליון ייפלו יחד.
   • מודעה בודדת (בלי חוזה, או חוזה של פרסום אחד) — מוכרת אוטומטית
     בחודש הגיליון שלה.
   • עסקה רב-גיליונית (חוזה עם יותר מפרסום אחד) — מוכרת רק דרך
     revenue_recognition (סגירת חודש). חודש שלא נסגר = 0 מהעסקה.
   • עיצוב: לפי הכפתור "🎨 עיצוב ₪50 + מע"מ" בכרטיס המודעה —
     ads.design_fee_net (נטו) נספר כעלות בחודש הגיליון של המודעה.
   • מודעה בלי סוכן (וגם ללקוח אין סוכן) → נזקפת לסוכן ברירת המחדל
     (המנהל, defaultAgentId).
   • עמלה מדורגת על ההכנסה המוכרת של החודש.
   • רווחיות עובד = הכנסה − עיצוב − עמלה (שכר בסיס בשורה נפרדת).
   ============================================================ */

'use strict';

const PF_DEAD = ['cancelled', 'rejected'];

function pfRound(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pfNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function pfAdNet(a) { return Math.max(0, pfNum(a.price) - pfNum(a.discount)); }
function pfIssueMonth(iss) { return iss ? String(iss.print_date || iss.publish_date || '').slice(0, 7) : ''; }
function pfAlive(a) { return !PF_DEAD.includes(a.status); }

/* מדרגות העמלה של עובד: tiers מפורש (אם הוגדר) או בסיס/מעל-יעד.
   מחזיר [{from, pct}] ממוין. יעד ריק/0 → מדרגה אחת. */
function pfTiers(comp) {
  if (!comp) return [];
  if (Array.isArray(comp.tiers) && comp.tiers.length) {
    return comp.tiers.map(t => ({ from: Math.max(0, pfNum(t.from)), pct: pfNum(t.pct) }))
      .sort((a, b) => a.from - b.from);
  }
  const base = pfNum(comp.commission_pct_base);
  const target = pfNum(comp.monthly_target);
  const above = comp.commission_pct_above == null || comp.commission_pct_above === '' ? base : pfNum(comp.commission_pct_above);
  const out = [{ from: 0, pct: base }];
  if (target > 0) out.push({ from: target, pct: above });
  return out;
}

/* עמלה מדורגת: כל מדרגה מקבלת את האחוז שלה רק על החלק שבתוכה.
   מחזיר { total, parts: [{from, to, base, pct, amount}] } */
function pfTieredCommission(revenue, tiers) {
  const rev = Math.max(0, pfNum(revenue));
  const parts = [];
  let total = 0;
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i].from;
    const to = i + 1 < tiers.length ? tiers[i + 1].from : Infinity;
    const base = Math.max(0, Math.min(rev, to) - from);
    const amount = base * tiers[i].pct / 100;
    parts.push({ from, to, base: pfRound(base), pct: tiers[i].pct, amount: pfRound(amount) });
    total += amount;
  }
  return { total: pfRound(total), parts };
}

/* אינדקסים עזר על הנתונים הגולמיים */
function pfIndex(data) {
  const issueMonth = {};
  (data.issues || []).forEach(i => { issueMonth[i.id] = pfIssueMonth(i); });
  const contractById = {};
  (data.contracts || []).forEach(c => { contractById[c.id] = c; });
  const custAgent = {};
  (data.customers || []).forEach(c => { custAgent[c.id] = c.agent_id; });
  const adsByContract = {};
  (data.ads || []).forEach(a => {
    if (a.contract_id == null || !pfAlive(a)) return;
    (adsByContract[a.contract_id] = adsByContract[a.contract_id] || []).push(a);
  });
  const defaultAgent = Number(data.defaultAgentId) || 0;
  return { issueMonth, contractById, custAgent, adsByContract, defaultAgent };
}

/* עסקה רב-גיליונית: חוזה ליותר מפרסום אחד (או שכבר יש לו יותר ממודעה אחת) */
function pfIsMultiDeal(ct, ctAds) {
  if (!ct) return false;
  return pfNum(ct.total_inserts) > 1 || (ctAds || []).length > 1;
}

function pfAdAgent(a, ix) {
  if (a.agent_id != null) return Number(a.agent_id);
  const ct = a.contract_id != null ? ix.contractById[a.contract_id] : null;
  if (ct && ct.agent_id != null) return Number(ct.agent_id);
  const ca = ix.custAgent[a.customer_id];
  return ca != null ? Number(ca) : ix.defaultAgent;
}

function pfContractAgent(ct, ix) {
  if (ct.agent_id != null) return Number(ct.agent_id);
  const first = (ix.adsByContract[ct.id] || []).find(a => a.agent_id != null);
  if (first) return Number(first.agent_id);
  const ca = ix.custAgent[ct.customer_id];
  return ca != null ? Number(ca) : ix.defaultAgent;
}

/* עלות העיצוב של מודעה (נטו) — מה שסומן בכפתור בכרטיס המודעה; 0 = לא עוצבה אצלנו */
function pfDesignFee(a) { return Math.max(0, pfNum(a.design_fee_net)); }

/* שווי עסקה (נטו): total_price של החוזה; אם ריק — סכום מודעותיה */
function pfDealNet(ct, ctAds) {
  const tp = pfNum(ct.total_price);
  if (tp > 0) return tp;
  return (ctAds || []).reduce((s, a) => s + pfAdNet(a), 0);
}

/* ---------- שורות מסך "סגירת חודש" ----------
   לכל עסקה רב-גיליונית שרלוונטית לחודש: יש לה מודעה בחודש, או שנשארה
   יתרה לא מוכרת ממודעות של חודשים קודמים, או שכבר נשמרה לה החלטה לחודש.
   default — הצעה בלבד (חלק החודש, עד היתרה); שום דבר לא נשמר מכאן. */
function pfMonthCloseRows(month, data) {
  const ix = pfIndex(data);
  const rec = data.recognition || [];
  const rows = [];
  (data.contracts || []).forEach(ct => {
    const ctAds = ix.adsByContract[ct.id] || [];
    if (!pfIsMultiDeal(ct, ctAds)) return;
    const existing = rec.find(r => Number(r.contract_id) === Number(ct.id) && r.month === month) || null;
    const prior = rec.filter(r => Number(r.contract_id) === Number(ct.id) && r.month < month && r.included)
      .reduce((s, r) => s + pfNum(r.amount_recognized), 0);
    const later = rec.filter(r => Number(r.contract_id) === Number(ct.id) && r.month > month && r.included)
      .reduce((s, r) => s + pfNum(r.amount_recognized), 0);
    const dealNet = pfDealNet(ct, ctAds);
    let runSoFar = 0, inMonth = 0, portion = 0, runNet = 0;
    ctAds.forEach(a => {
      const m = ix.issueMonth[a.issue_id];
      if (!m) return;
      if (m <= month) { runSoFar++; runNet += pfAdNet(a); }
      if (m === month) { inMonth++; portion += pfAdNet(a); }
    });
    const total = Math.max(pfNum(ct.total_inserts), ctAds.length);
    const remaining = Math.max(0, dealNet - prior - later);
    const backlog = Math.max(0, runNet - prior);  // מה שרץ עד החודש ועוד לא הוכר
    const relevant = inMonth > 0 || existing || (runSoFar > 0 && backlog > 0.005 && remaining > 0.005);
    if (!relevant) return;
    // ברירת מחדל: מה שרץ עד סוף החודש ועוד לא הוכר (חלק החודש + מה שנדחה), עד היתרה
    const suggested = pfRound(Math.min(remaining, backlog));
    rows.push({
      contract_id: ct.id,
      agent_id: pfContractAgent(ct, ix),
      customer_id: ct.customer_id,
      deal_net: pfRound(dealNet),
      issues_total: total,
      issues_run: runSoFar,
      issues_remaining: Math.max(0, total - runSoFar),
      issues_in_month: inMonth,
      month_portion: pfRound(portion),
      prior_recognized: pfRound(prior),
      remaining: pfRound(remaining),
      suggested,
      existing,
      default_included: existing ? !!existing.included : suggested > 0,
      default_amount: existing ? pfRound(existing.amount_recognized) : suggested,
    });
  });
  return rows;
}

/* ---------- חישוב חודש: פר עובד + סיכומים ----------
   data: { ads, issues, contracts, customers, recognition, comps,
           managerCuts, bonuses, defaultAgentId }
   מחזיר { month, agents: {agentId: row}, totals } — row כולל את כל
   המרכיבים לשכר, לרווחיות ולדוח. agentId 0 = "ללא סוכן" (הכנסה בלבד). */
function pfComputeMonth(month, data) {
  const ix = pfIndex(data);
  const A = {};
  const row = id => (A[id] = A[id] || {
    agent_id: id, revenue_single: 0, revenue_deals: 0, revenue: 0,
    ads_count: 0, designed_count: 0, graphics: 0,
    commission: 0, commission_parts: [], tiers: [], target: 0,
    manager_cut: 0, manager_cut_base: 0, manager_cut_pct: 0, manager_sources: [],
    base_salary: 0, commission_only: true, bonus: 0, profitability: 0, pay_total: 0, has_comp: false,
  });

  // 1. מודעות החודש: הכנסה של בודדות + עלות עיצוב לכל מודעה מעוצבת
  (data.ads || []).forEach(a => {
    if (!pfAlive(a)) return;
    if (ix.issueMonth[a.issue_id] !== month) return;
    const ag = pfAdAgent(a, ix);
    const r = row(ag);
    const ct = a.contract_id != null ? ix.contractById[a.contract_id] : null;
    const multi = ct && pfIsMultiDeal(ct, ix.adsByContract[ct.id]);
    if (!multi) { r.revenue_single += pfAdNet(a); r.ads_count++; }
    const fee = pfDesignFee(a);
    if (fee > 0) { r.designed_count++; r.graphics += fee; }
  });

  // 2. עסקאות רב-גיליוניות: רק מה שאושר בסגירת החודש
  (data.recognition || []).forEach(rc => {
    if (rc.month !== month || !rc.included) return;
    const ct = ix.contractById[rc.contract_id];
    const ag = rc.agent_id != null ? Number(rc.agent_id) : (ct ? pfContractAgent(ct, ix) : 0);
    row(ag).revenue_deals += pfNum(rc.amount_recognized);
  });

  // עובדים מוגדרים מופיעים גם בלי פעילות (שכר בסיס)
  (data.comps || []).forEach(c => { if (c.active !== false) row(Number(c.agent_id)); });
  (data.managerCuts || []).forEach(m => { if (m.active !== false) row(Number(m.manager_agent_id)); });

  Object.values(A).forEach(r => { r.revenue = pfRound(r.revenue_single + r.revenue_deals); });

  // 3. עמלה מדורגת + שכר בסיס
  const compBy = {};
  (data.comps || []).forEach(c => { compBy[Number(c.agent_id)] = c; });
  Object.values(A).forEach(r => {
    const c = compBy[r.agent_id];
    if (!c || c.active === false) return;
    r.has_comp = true;
    r.tiers = pfTiers(c);
    r.target = pfNum(c.monthly_target);
    const tc = pfTieredCommission(r.revenue, r.tiers);
    r.commission = tc.total; r.commission_parts = tc.parts;
    r.commission_only = c.base_salary == null || c.base_salary === '';
    r.base_salary = r.commission_only ? 0 : pfRound(c.base_salary);
  });

  // 4. נתח מנהלת: % מההכנסה המוכרת של הנציגות שתחתיה — תוספת בלבד
  (data.managerCuts || []).forEach(m => {
    if (m.active === false) return;
    const mid = Number(m.manager_agent_id);
    const srcs = (m.source_agent_ids || []).map(Number).filter(id => id !== mid);
    const base = srcs.reduce((s, id) => s + (A[id] ? A[id].revenue : 0), 0);
    const r = row(mid);
    r.manager_cut_base = pfRound(r.manager_cut_base + base);
    r.manager_cut_pct = pfNum(m.pct);
    r.manager_sources = srcs;
    r.manager_cut = pfRound(r.manager_cut + base * pfNum(m.pct) / 100);
  });

  // 5. בונוס ידני
  (data.bonuses || []).forEach(b => {
    if (b.month !== month) return;
    row(Number(b.agent_id)).bonus += pfNum(b.amount);
  });

  // 6. סיכומים פר עובד
  Object.values(A).forEach(r => {
    r.revenue_single = pfRound(r.revenue_single);
    r.revenue_deals = pfRound(r.revenue_deals);
    r.graphics = pfRound(r.graphics);
    r.bonus = pfRound(r.bonus);
    r.profitability = pfRound(r.revenue - r.graphics - r.commission);
    r.pay_total = pfRound(r.base_salary + r.commission + r.manager_cut + r.bonus);
  });

  const sum = k => pfRound(Object.values(A).reduce((s, r) => s + pfNum(r[k]), 0));
  return {
    month,
    agents: A,
    totals: {
      revenue: sum('revenue'), revenue_single: sum('revenue_single'), revenue_deals: sum('revenue_deals'),
      graphics: sum('graphics'), designed_count: sum('designed_count'),
      commission: sum('commission'), manager_cut: sum('manager_cut'),
      base_salary: sum('base_salary'), bonus: sum('bonus'), pay_total: sum('pay_total'),
      profitability: sum('profitability'),
    },
  };
}

/* ---------- סיווג הוצאות לדוח רווח והפסד ----------
   expenses: [{amount, notes, expense_date, category_id}] של החודש.
   תיוג #issue: → עלות גיליון; #cat:גרפיקה → שורת הגרפיקה (מעל הרווח הגולמי);
   בלי #issue: → הוצאות כלליות אחרות. נטו מ-#net: (כמו הדוחות הקיימים).
   שכר ועמלות לא נספרים פעמיים: שורות שסונכרנו ממסך השכר (#payroll:) וכל
   הוצאה בקטגוריית שכר/עמלות (payrollCategoryIds) — כבר בשורות השכר של הדוח,
   ולכן מוחרגות ומוצגות בנפרד כ-payroll_synced / payroll_manual (מידע בלבד). */
function pfClassifyExpenses(expenses, payrollCategoryIds) {
  const out = { issue_print: 0, issue_graphics: 0, other: 0, payroll_synced: 0, payroll_manual: 0 };
  const payCats = new Set((payrollCategoryIds || []).map(Number));
  (expenses || []).forEach(e => {
    const notes = String(e.notes || '');
    const mn = notes.match(/#net:([0-9.]+)/);
    const net = mn ? Number(mn[1]) : pfNum(e.amount);
    if (/#payroll:/.test(notes)) { out.payroll_synced += net; return; }
    if (e.category_id != null && payCats.has(Number(e.category_id))) { out.payroll_manual += net; return; }
    if (/#issue:\d+/.test(notes)) {
      const cat = (notes.match(/#cat:([^;]+);/) || [])[1] || '';
      if (cat.trim() === 'גרפיקה') out.issue_graphics += net; else out.issue_print += net;
    } else out.other += net;
  });
  Object.keys(out).forEach(k => { out[k] = pfRound(out[k]); });
  return out;
}

/* ---------- רווח והפסד מדורג לחודש ----------
   הכנסה → − עיצוב → = רווח גולמי → − דפוס/הפצה (עלויות גיליון) →
   − עמלות ונתח מנהלת → − שכר בסיס (+בונוסים) → = רווח תפעולי →
   − הוצאות כלליות אחרות → = רווח נקי */
function pfPnl(calc, exp) {
  const t = calc.totals;
  const e = exp || { issue_print: 0, issue_graphics: 0, other: 0 };
  const graphics = pfRound(t.graphics + e.issue_graphics);
  const gross = pfRound(t.revenue - graphics);
  const afterIssue = pfRound(gross - e.issue_print);
  const commissions = pfRound(t.commission + t.manager_cut);
  const afterComm = pfRound(afterIssue - commissions);
  const salaries = pfRound(t.base_salary + t.bonus);
  const operating = pfRound(afterComm - salaries);
  const net = pfRound(operating - e.other);
  return {
    revenue: t.revenue, revenue_single: t.revenue_single, revenue_deals: t.revenue_deals,
    graphics_ads: t.graphics, graphics_issue: e.issue_graphics, graphics,
    gross, issue_costs: e.issue_print, after_issue: afterIssue,
    commission: t.commission, manager_cut: t.manager_cut, commissions, after_commissions: afterComm,
    base_salary: t.base_salary, bonus: t.bonus, salaries, operating,
    other_expenses: e.other, net,
    payroll_synced: pfRound(e.payroll_synced), payroll_manual: pfRound(e.payroll_manual),
  };
}

/* ---------- סנכרון השכר להוצאות (תזרים) ----------
   שורה אחת לכל עובד × חודש, מתויגת #payroll:YYYY-MM;#agent:<id>;#net:<סכום>;
   כך שסנכרון חוזר מעדכן את אותה שורה, והדוח מזהה אותה ולא סופר פעמיים.
   מחזיר [{agent_id, amount, tag, notes}] — רק עובדים עם סכום לתשלום. */
function pfPayrollTag(month, agentId) { return '#payroll:' + month + ';#agent:' + agentId + ';'; }
function pfPayrollSyncRows(calc) {
  return Object.values(calc.agents)
    .filter(r => r.agent_id && r.pay_total > 0)
    .map(r => {
      const tag = pfPayrollTag(calc.month, r.agent_id);
      return { agent_id: r.agent_id, amount: r.pay_total, tag, notes: tag + '#net:' + r.pay_total + ';' };
    });
}

/* חשיפה לבדיקות node (לא פעיל בדפדפן) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pfRound, pfAdNet, pfIssueMonth, pfTiers, pfTieredCommission, pfIsMultiDeal,
    pfMonthCloseRows, pfComputeMonth, pfClassifyExpenses, pfPnl, pfPayrollTag, pfPayrollSyncRows,
  };
}
