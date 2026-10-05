/* ============================================================
   payroll.js — רווחיות, שכר ועמלות (מסכים)
   ------------------------------------------------------------
   שלושה מסכים נפרדים + דוח + כרטיס הגדרות:
   (א) סגירת חודש (מנהל) — קלט: כמה מכל עסקה רב-חודשית להכיר החודש.
       הכתיבה היחידה כאן: אישור מפורש → revenue_recognition (upsert
       על contract_id+month, כך שסגירה חוזרת מעדכנת ולא משכפלת).
   (ב) שכר לתשלום (מנהל) — פלט: בסיס + עמלה מדורגת + נתח מנהלת +
       בונוס ידני = לתשלום. כותב רק את הבונוס (payroll_bonus) באישור.
   (ג) הביצועים שלי (סוכן) — הכנסה, עיצוב, עמלה ורווחיות של העובד
       עצמו בלבד (RLS: סוכן קורא רק את השורות שלו).
   + דו"ח "רווח והפסד מדורג" בדוחות (report_pnlx) — קריאה בלבד.
   + כרטיס הגדרות: הפעלה, עלויות, תגמול עובדים, נתח מנהלת.
   כל החישוב ב-payroll-engine.js. המודול כבוי עד profitability_enabled='1'.
   ============================================================ */

'use strict';

function pfOn() { return String((cache.settings || {}).profitability_enabled || '0') === '1'; }
function pfFee() { const v = Number((cache.settings || {}).graphics_fee_net); return isFinite(v) && v >= 0 && (cache.settings || {}).graphics_fee_net != null ? v : 50; }
/* סוכן ברירת מחדל למודעה בלי סוכן (וללקוח אין סוכן): ההגדרה default_agent_id,
   ואם ריקה — הסוכן המקושר למשתמש מנהל */
function pfDefaultAgentId() {
  const v = Number((cache.settings || {}).default_agent_id);
  if (v && (cache.agents || []).some(a => a.id === v)) return v;
  const admins = new Set((cache.profiles || []).filter(p => p.role === 'admin').map(p => p.id));
  const a = (cache.agents || []).find(x => x.profile_id && admins.has(x.profile_id));
  return a ? a.id : null;
}
function pfAgentName(id) { return Number(id) ? (nameOf('agents', Number(id)) || 'סוכן #' + id) : 'ללא סוכן'; }
function pfPrevMonth(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 2, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function pfMonthsBack(ym, n) { const out = [ym]; for (let i = 1; i < n; i++) out.push(pfPrevMonth(out[i - 1])); return out; }
/* חודש ברירת מחדל לסגירה: בתחילת חודש — החודש הקודם */
function pfDefaultCloseMonth() { const t = today(); return Number(t.slice(8, 10)) <= 15 ? pfPrevMonth(t.slice(0, 7)) : t.slice(0, 7); }
function pfMoney(v) { return money(Math.round((Number(v) || 0) * 100) / 100) || '₪0'; }

const _PF_MIGRATION_MSG = 'טבלאות המודול חסרות — יש להריץ את המיגרציה 2026-10-05_profitability_payroll.sql ב-Supabase';

function _pfDisabledHtml() {
  return `<div class="card card-pad"><p class="empty">מודול רווחיות ושכר כבוי. ${profile.role === 'admin' ? 'מפעילים בהגדרות → "💼 רווחיות, שכר ועמלות".' : 'פנה למנהל.'}</p></div>`;
}

/* ---------- טעינת נתונים (קריאה בלבד) ----------
   months — רשימת חודשים 'YYYY-MM' שצריך לחשב. מחזיר את מבנה ה-data
   של המנוע. סוכן מקבל מה-RLS רק את השורות שלו; טבלאות מנהל לא נקראות לו. */
async function pfLoad(months, opts = {}) {
  const probe = await db.from('agent_comp').select('agent_id').limit(1);
  if (probe.error) throw new Error(_PF_MIGRATION_MSG);
  const admin = profile.role === 'admin';
  const [issues, contracts, recognition, comps, cuts, bonuses, closes] = await Promise.all([
    runAll((f, t) => db.from('issues').select('id,issue_number,print_date,publish_date').order('id').range(f, t), 'גיליונות'),
    runAll((f, t) => db.from('contracts').select('*').order('id').range(f, t), 'חוזים'),
    runAll((f, t) => db.from('revenue_recognition').select('*').order('id').range(f, t), 'הכרה בהכנסה'),
    run(db.from('agent_comp').select('*'), 'תגמול'),
    admin ? run(db.from('agent_manager_cut').select('*'), 'נתח מנהלת') : [],
    admin ? run(db.from('payroll_bonus').select('*').in('month', months), 'בונוסים') : [],
    run(db.from('revenue_month_close').select('*'), 'סגירות חודש'),
  ]);
    // מודעות: כולן (עסקאות צריכות את כל ההיסטוריה שלהן) בלי מבוטלות/נדחות.
  // design_fee_net — עלות העיצוב שסומנה בכפתור בכרטיס המודעה (מאותה מיגרציה).
  const ads = await runAll((f, t) => db.from('ads').select('id,agent_id,customer_id,contract_id,issue_id,price,discount,status,design_fee_net')
    .not('status', 'in', '("cancelled","rejected")').order('id').range(f, t), 'מודעות');
  const data = {
    issues, contracts, ads, recognition, comps: comps || [], managerCuts: cuts || [], bonuses: bonuses || [],
    customers: cache.customers || [], defaultAgentId: pfDefaultAgentId(), closes: closes || [],
  };
  if (opts.expenses && admin) {
    const sorted = [...months].sort();
    const [exps, cats] = await Promise.all([
      runAll((f, t) => db.from('expenses').select('amount,notes,expense_date,category_id')
        .gte('expense_date', sorted[0] + '-01').lte('expense_date', monthEnd(sorted[sorted.length - 1])).order('id').range(f, t), 'הוצאות'),
      (async () => { const r = await db.from('expense_categories').select('id,name'); return (r && r.data) || []; })(),
    ]);
    data.expenses = exps;
    // קטגוריות שכר/עמלות — הוצאה כזו כבר מחושבת בשורות השכר, לא נספרת פעמיים
    data.payrollCategoryIds = cats.filter(c => /שכר|משכור|עמל/.test(String(c.name || ''))).map(c => c.id);
  }
  return data;
}

function pfClosedInfo(data, month) {
  const c = (data.closes || []).find(x => x.month === month);
  if (!c) return null;
  const who = (cache.profiles || []).find(p => p.id === c.closed_by);
  return { at: c.closed_at, by: who ? who.full_name : '' };
}

/* ======================================================================
   (א) סגירת חודש — הכרה בהכנסה (מנהל בלבד)
   ====================================================================== */
let _pfMcMonth = null;
let _pfMcRows = [];

Pages.monthclose = {
  title: 'סגירת חודש',
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">למנהל בלבד</div>'; return; }
    if (!pfOn()) { el.innerHTML = _pfDisabledHtml(); return; }
    _pfMcMonth = _pfMcMonth || pfDefaultCloseMonth();
    el.innerHTML = `
<div class="page-head"><h2>🗓️ סגירת חודש — הכרה בהכנסה</h2>
  <input type="month" id="pfMcMonth" value="${_pfMcMonth}" onchange="_pfMcMonth=this.value; openPage('monthclose')" style="width:auto">
</div>
<p class="muted" style="font-size:.84rem;margin-bottom:10px">לכל נציג/ה — העסקאות הרב-חודשיות שרלוונטיות לחודש. מסמנים מה להכניס החודש ומה לא, ומתקנים סכום אם צריך.
<b>שום דבר לא נרשם עד "אישור סגירת החודש".</b> מודעות בודדות מוכרות אוטומטית בחודש הגיליון שלהן (מוצגות לתמונה מלאה). כל הסכומים נטו, לפני מע"מ.</p>
<div id="pfMcBody"><div class="empty">טוען...</div></div>`;
    let data;
    try { data = await pfLoad([_pfMcMonth]); }
    catch (e) { document.getElementById('pfMcBody').innerHTML = `<div class="card card-pad"><p class="empty">${esc(e.message)}</p></div>`; return; }
    const month = _pfMcMonth;
    _pfMcRows = pfMonthCloseRows(month, data);
    const calc = pfComputeMonth(month, data);
    const closed = pfClosedInfo(data, month);
    // מודעות בודדות של החודש לפי נציג — לתצוגה בלבד
    const issMonth = {}; data.issues.forEach(i => { issMonth[i.id] = pfIssueMonth(i); });
    const issNum = {}; data.issues.forEach(i => { issNum[i.id] = i.issue_number; });
    const ctById = {}; data.contracts.forEach(c => { ctById[c.id] = c; });
    const ctAdsCount = {}; data.ads.forEach(a => { if (a.contract_id != null) ctAdsCount[a.contract_id] = (ctAdsCount[a.contract_id] || 0) + 1; });
    const custAgent = {}; (cache.customers || []).forEach(c => { custAgent[c.id] = c.agent_id; });
    const singles = {};
    data.ads.forEach(a => {
      if (issMonth[a.issue_id] !== month) return;
      const ct = a.contract_id != null ? ctById[a.contract_id] : null;
      if (ct && (Number(ct.total_inserts) > 1 || ctAdsCount[ct.id] > 1)) return;
      const ag = a.agent_id != null ? a.agent_id : (ct && ct.agent_id != null ? ct.agent_id : (custAgent[a.customer_id] != null ? custAgent[a.customer_id] : (data.defaultAgentId || 0)));
      (singles[ag] = singles[ag] || []).push(a);
    });
    const agentIds = [...new Set([..._pfMcRows.map(r => r.agent_id), ...Object.keys(singles).map(Number)])]
      .sort((a, b) => pfAgentName(a).localeCompare(pfAgentName(b), 'he'));

    const payInfo = ct => {
      const plan = Array.isArray(ct.payment_plan) ? ct.payment_plan : [];
      if (plan.length) {
        const paid = plan.reduce((s, p) => s + (Number(p.paid) || 0), 0);
        const next = plan.find(p => (Number(p.paid) || 0) < Number(p.amount));
        return `${pfMoney(paid)} שולם` + (next ? ` · הבא ${heDate(next.due)}` : ' · נפרע במלואו');
      }
      return ct.closed_date ? 'נסגרה ' + heDate(ct.closed_date) : (ct.prepaid ? 'שולם מראש' : '—');
    };

    let html = closed
      ? `<div class="card card-pad" style="background:#ecfdf5">✓ החודש נסגר ${heDateTime(closed.at)}${closed.by ? ' ע"י ' + esc(closed.by) : ''}. אפשר לשנות ולאשר שוב — הרישום יתעדכן.</div>`
      : `<div class="card card-pad" style="background:#fffbeb">החודש עדיין לא נסגר — עסקאות רב-חודשיות לא נספרות בשכר ובדוחות עד האישור.</div>`;
    if (!agentIds.length) html += '<div class="card card-pad"><p class="empty">אין פעילות בחודש זה</p></div>';
    agentIds.forEach(ag => {
      const deals = _pfMcRows.map((r, i) => ({ r, i })).filter(x => x.r.agent_id === ag);
      const sg = singles[ag] || [];
      const sgSum = sg.reduce((s, a) => s + pfAdNet(a), 0);
      html += `<div class="card card-pad">
<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><b style="font-size:1.02rem">${esc(pfAgentName(ag))}</b>
<span class="muted" style="font-size:.84rem">בודדות (אוטומטי): <b>${pfMoney(sgSum)}</b> · עסקאות שסומנו: <b id="pfMcAg${ag}">—</b></span></div>
${deals.length ? `<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr>
<th>להכניס החודש</th><th>לקוח</th><th>שווי עסקה (נטו)</th><th>תשלום</th><th>גיליונות: רצו / נותרו</th><th>הוכר בעבר</th><th>חלק החודש</th><th>יתרה</th><th>סכום להכרה</th></tr></thead><tbody>
${deals.map(({ r, i }) => { const ct = ctById[r.contract_id] || {}; return `<tr>
<td><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="pfMcInc${i}" ${r.default_included ? 'checked' : ''} onchange="pfMcRecalc()" style="width:18px;height:18px"> כן</label></td>
<td><b>${esc(nameOf('customers', r.customer_id) || 'לקוח #' + r.customer_id)}</b><div class="muted" style="font-size:.74rem">חוזה #${r.contract_id}${r.existing ? ' · נשמר בעבר' : ''}</div></td>
<td>${pfMoney(r.deal_net)}</td>
<td style="font-size:.8rem">${esc(payInfo(ct))}</td>
<td>${r.issues_run} / ${r.issues_remaining} <span class="muted" style="font-size:.74rem">(מתוך ${r.issues_total}; ${r.issues_in_month} החודש)</span></td>
<td>${pfMoney(r.prior_recognized)}</td>
<td>${pfMoney(r.month_portion)}</td>
<td>${pfMoney(r.remaining)}</td>
<td><input type="number" min="0" step="0.01" id="pfMcAmt${i}" value="${r.default_amount}" oninput="pfMcRecalc()" style="width:110px;text-align:left"></td>
</tr>`; }).join('')}
</tbody></table></div>` : ''}
${sg.length ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:.84rem">${sg.length} מודעות בודדות — מוכרות אוטומטית בחודש הגיליון</summary>
<table class="data" style="margin-top:6px"><thead><tr><th>לקוח</th><th>גיליון</th><th>נטו</th></tr></thead><tbody>
${sg.map(a => `<tr><td>${esc(nameOf('customers', a.customer_id) || '#' + a.customer_id)}</td><td>${esc(String(issNum[a.issue_id] || ''))}</td><td>${pfMoney(pfAdNet(a))}</td></tr>`).join('')}
</tbody></table></details>` : ''}
</div>`;
    });
    if (_pfMcRows.length) {
      html += `<div class="card card-pad" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<span>סה"כ להכרה מעסקאות החודש: <b id="pfMcTotal">—</b> · הכנסה מודעות בודדות: <b>${pfMoney(calc.totals.revenue_single)}</b></span>
<button class="btn" onclick="pfMcConfirm()">✅ אישור סגירת החודש</button></div>`;
    } else {
      html += `<div class="card card-pad" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<span class="muted">אין עסקאות רב-חודשיות לחודש זה — ההכנסה כולה ממודעות בודדות (${pfMoney(calc.totals.revenue_single)}).</span>
<button class="btn btn-ghost" onclick="pfMcConfirm()">סמן את החודש כסגור</button></div>`;
    }
    document.getElementById('pfMcBody').innerHTML = html;
    pfMcRecalc();
  }
};

function _pfMcRead() {
  return _pfMcRows.map((r, i) => {
    const inc = document.getElementById('pfMcInc' + i);
    const amt = document.getElementById('pfMcAmt' + i);
    return { r, included: !!(inc && inc.checked), amount: Math.round((Number(amt && amt.value) || 0) * 100) / 100 };
  });
}

function pfMcRecalc() {
  const vals = _pfMcRead();
  const byAg = {};
  let total = 0;
  vals.forEach(v => {
    const amt = document.getElementById('pfMcAmt' + _pfMcRows.indexOf(v.r));
    const over = v.amount > v.r.remaining + 0.005;
    if (amt) { amt.disabled = !v.included; amt.style.borderColor = v.included && (over || v.amount < 0) ? 'var(--danger)' : ''; }
    if (!v.included) return;
    byAg[v.r.agent_id] = (byAg[v.r.agent_id] || 0) + v.amount;
    total += v.amount;
  });
  [...new Set(_pfMcRows.map(r => r.agent_id))].forEach(ag => {
    const e = document.getElementById('pfMcAg' + ag); if (e) e.textContent = pfMoney(byAg[ag] || 0);
  });
  const t = document.getElementById('pfMcTotal'); if (t) t.textContent = pfMoney(total);
}

async function pfMcConfirm() {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  const month = _pfMcMonth;
  const vals = _pfMcRead();
  const bad = vals.find(v => v.included && (v.amount < 0 || v.amount > v.r.remaining + 0.005));
  if (bad) { toast('סכום להכרה גבוה מיתרת העסקה (או שלילי) — ' + (nameOf('customers', bad.r.customer_id) || 'חוזה #' + bad.r.contract_id), true); return; }
  const inc = vals.filter(v => v.included);
  const total = inc.reduce((s, v) => s + v.amount, 0);
  if (!confirm(`לאשר את סגירת ${month}?\n\nיוכרו ${inc.length} עסקאות בסך ${pfMoney(total)} (נטו).\n${vals.length - inc.length} עסקאות לא ייכנסו החודש ויעברו לחודש מאוחר יותר.\n\nאפשר לפתוח שוב ולשנות.`)) return;
  const now = new Date().toISOString();
  const rows = vals.map(v => ({
    contract_id: v.r.contract_id, agent_id: v.r.agent_id || null, month,
    amount_recognized: v.included ? v.amount : 0, included: v.included,
    confirmed_by: profile.id, confirmed_at: now,
  }));
  if (rows.length) await run(db.from('revenue_recognition').upsert(rows, { onConflict: 'contract_id,month' }), 'שמירת ההכרה');
  await run(db.from('revenue_month_close').upsert({ month, closed_by: profile.id, closed_at: now }, { onConflict: 'month' }), 'סימון סגירה');
  toast('✓ החודש נסגר — ' + pfMoney(total) + ' הוכרו');
  openPage('monthclose');
}

/* ======================================================================
   (ב) שכר לתשלום — כמה לשלם לכל עובד/ת החודש (מנהל בלבד)
   ====================================================================== */
let _pfPayMonth = null;
let _pfPayCalc = null;
let _pfPayExport = [];

Pages.payroll = {
  title: 'שכר לתשלום',
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">למנהל בלבד</div>'; return; }
    if (!pfOn()) { el.innerHTML = _pfDisabledHtml(); return; }
    _pfPayMonth = _pfPayMonth || pfDefaultCloseMonth();
    el.innerHTML = `
<div class="page-head"><h2>💵 שכר לתשלום</h2>
  <span style="display:flex;gap:6px;align-items:center">
  <input type="month" id="pfPayMonth" value="${_pfPayMonth}" onchange="_pfPayMonth=this.value; openPage('payroll')" style="width:auto">
  <button class="btn btn-sm btn-ghost" onclick="exportCsv('שכר_' + _pfPayMonth, _PF_PAY_HEAD, _pfPayExport)">⬇ אקסל</button>
  <button class="btn btn-sm btn-ghost" onclick="printArea('שכר לתשלום — ' + _pfPayMonth, document.getElementById('pfPayTable').innerHTML)">🖨 הדפסה</button>
  </span>
</div>
<div id="pfPayBody"><div class="empty">מחשב...</div></div>`;
    let data;
    try { data = await pfLoad([_pfPayMonth]); }
    catch (e) { document.getElementById('pfPayBody').innerHTML = `<div class="card card-pad"><p class="empty">${esc(e.message)}</p></div>`; return; }
    const month = _pfPayMonth;
    const calc = _pfPayCalc = pfComputeMonth(month, data);
    const closed = pfClosedInfo(data, month);
    const openDeals = pfMonthCloseRows(month, data).filter(r => !r.existing).length;
    const rows = Object.values(calc.agents).filter(r => r.has_comp || r.manager_cut || r.bonus)
      .sort((a, b) => pfAgentName(a.agent_id).localeCompare(pfAgentName(b.agent_id), 'he'));
    const unconfigured = Object.values(calc.agents).filter(r => !r.has_comp && r.agent_id && r.revenue > 0);
    const tierLbl = r => {
      if (!r.has_comp) return '—';
      const hit = r.commission_parts.filter(p => p.base > 0);
      return hit.map(p => `${p.pct}%${p.from > 0 ? ' מעל ' + pfMoney(p.from) : ''}`).join(' + ') || (r.tiers[0] ? r.tiers[0].pct + '%' : '—');
    };
    _pfPayExport = rows.map(r => [pfAgentName(r.agent_id), r.commission_only ? 'עמלה בלבד' : r.base_salary, r.revenue, r.target || '', tierLbl(r), r.commission, r.manager_cut, r.bonus, r.pay_total]);
    const T = calc.totals;
    document.getElementById('pfPayBody').innerHTML = `
${closed ? '' : `<div class="card card-pad" style="background:#fffbeb">⚠️ ${month} עדיין לא נסגר${openDeals ? ` (${openDeals} עסקאות רב-חודשיות ממתינות)` : ''} — העמלות כוללות רק מודעות בודדות. <a href="#" onclick="openPage('monthclose');return false">לסגירת החודש ←</a></div>`}
<div class="stats">
${stat(pfMoney(T.pay_total), 'סה"כ לתשלום', 'gold')}
${stat(pfMoney(T.base_salary), 'שכר בסיס')}
${stat(pfMoney(T.commission), 'עמלות')}
${stat(pfMoney(T.manager_cut), 'נתח מנהלת')}
${stat(pfMoney(T.bonus), 'בונוסים')}
</div>
<div class="card" id="pfPayTable"><div class="table-wrap"><table class="data"><thead><tr>
<th>עובד/ת</th><th>שכר בסיס</th><th>הכנסה מוכרת (נטו)</th><th>יעד</th><th>מדרגה</th><th>עמלה</th><th>נתח מנהלת</th><th>בונוס</th><th>לתשלום</th></tr></thead><tbody>
${rows.map(r => `<tr>
<td><b>${esc(pfAgentName(r.agent_id))}</b> <a href="#" class="muted" style="font-size:.74rem" onclick="pfOpenEmployee(${r.agent_id});return false">פירוט</a></td>
<td>${r.commission_only ? '<span class="muted">עמלה בלבד</span>' : pfMoney(r.base_salary)}</td>
<td>${pfMoney(r.revenue)}<div class="muted" style="font-size:.72rem">בודדות ${pfMoney(r.revenue_single)} · עסקאות ${pfMoney(r.revenue_deals)}</div></td>
<td>${r.target ? pfMoney(r.target) : '—'}</td>
<td style="font-size:.8rem">${esc(tierLbl(r))}</td>
<td>${pfMoney(r.commission)}</td>
<td>${r.manager_cut ? pfMoney(r.manager_cut) + `<div class="muted" style="font-size:.72rem">${r.manager_cut_pct}% × ${pfMoney(r.manager_cut_base)}</div>` : '—'}</td>
<td><input type="number" step="0.01" class="pfBonus" data-agent="${r.agent_id}" value="${r.bonus || ''}" placeholder="0" style="width:90px;text-align:left"></td>
<td><b>${pfMoney(r.pay_total)}</b></td></tr>`).join('') || '<tr><td colspan="9" class="empty">אין עובדים מוגדרים — מגדירים תגמול בהגדרות → "💼 רווחיות, שכר ועמלות"</td></tr>'}
</tbody><tfoot><tr style="border-top:2px solid var(--line)"><td><b>סה"כ</b></td><td><b>${pfMoney(T.base_salary)}</b></td><td><b>${pfMoney(rows.reduce((s, r) => s + r.revenue, 0))}</b></td><td></td><td></td>
<td><b>${pfMoney(T.commission)}</b></td><td><b>${pfMoney(T.manager_cut)}</b></td><td><b>${pfMoney(T.bonus)}</b></td><td><b>${pfMoney(T.pay_total)}</b></td></tr></tfoot>
</table></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<button class="btn btn-sm" onclick="pfSaveBonuses()">💾 שמירת בונוסים</button>
<button class="btn btn-sm btn-ghost" onclick="pfPayrollSync()">📤 סנכרון השכר לתזרים</button>
<span class="muted" style="font-size:.78rem">לתשלום = בסיס + עמלה מדורגת (על ההכנסה המוכרת של החודש) + נתח מנהלת + בונוס. הסכומים נטו לפני מע"מ ולפני ניכויי שכר.</span>
</div>
${unconfigured.length ? `<p class="muted" style="font-size:.8rem;margin-top:10px">⚠️ עם הכנסה החודש אך בלי הגדרת תגמול: ${unconfigured.map(r => esc(pfAgentName(r.agent_id))).join(', ')}.</p>` : ''}`;
  }
};
const _PF_PAY_HEAD = ['עובד', 'שכר בסיס', 'הכנסה מוכרת', 'יעד', 'מדרגה', 'עמלה', 'נתח מנהלת', 'בונוס', 'לתשלום'];

async function pfSaveBonuses() {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  const month = _pfPayMonth;
  const prev = {}; Object.values((_pfPayCalc || {}).agents || {}).forEach(r => { prev[r.agent_id] = r.bonus || 0; });
  const changes = [...document.querySelectorAll('.pfBonus')].map(inp => ({ agent_id: Number(inp.dataset.agent), amount: Math.round((Number(inp.value) || 0) * 100) / 100 }))
    .filter(c => Math.abs(c.amount - (prev[c.agent_id] || 0)) > 0.005);
  if (!changes.length) { toast('אין שינוי בבונוסים'); return; }
  if (!confirm(`לשמור בונוסים ל-${month}?\n\n` + changes.map(c => `${pfAgentName(c.agent_id)}: ${pfMoney(c.amount)}`).join('\n'))) return;
  const now = new Date().toISOString();
  await run(db.from('payroll_bonus').upsert(changes.map(c => ({ agent_id: c.agent_id, month, amount: c.amount, updated_by: profile.id, updated_at: now })), { onConflict: 'agent_id,month' }), 'שמירת בונוסים');
  toast('✓ הבונוסים נשמרו');
  openPage('payroll');
}

/* סנכרון השכר להוצאות (תזרים): שורה אחת לכל עובד × חודש, מתויגת
   #payroll:YYYY-MM;#agent:<id>; — סנכרון חוזר מעדכן את אותה שורה (לא מכפיל),
   ועובד שירד ל-0 — השורה שלו נמחקת. דוח רווח והפסד מזהה את התג ולא סופר שוב. */
async function pfPayrollSync() {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  if (!_pfPayCalc) return;
  const month = _pfPayCalc.month;
  const rows = pfPayrollSyncRows(_pfPayCalc);
  const existing = await runAll((f, t) => db.from('expenses').select('id,notes').ilike('notes', '%#payroll:' + month + ';%').order('id').range(f, t), 'הוצאות שכר');
  const byTag = {}; existing.forEach(e => { const m = String(e.notes || '').match(/#payroll:[0-9-]+;#agent:\d+;/); if (m) byTag[m[0]] = e; });
  const stale = existing.filter(e => !rows.some(r => String(e.notes || '').includes(r.tag)));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (!confirm(`לסנכרן את השכר של ${month} לתזרים?\n\n${rows.map(r => `${pfAgentName(r.agent_id)}: ${pfMoney(r.amount)}`).join('\n')}\n\nסה"כ ${pfMoney(total)} · ${rows.filter(r => byTag[r.tag]).length} יעודכנו, ${rows.filter(r => !byTag[r.tag]).length} חדשות${stale.length ? `, ${stale.length} יימחקו (ירדו ל-0)` : ''}.\nהדוח לא יספור אותן פעמיים.`)) return;
  const cats = (await db.from('expense_categories').select('id,name')).data || [];
  const cat = cats.find(c => /שכר|משכור/.test(String(c.name || '')));
  for (const r of rows) {
    const payload = { expense_date: monthEnd(month), supplier: pfAgentName(r.agent_id), amount: r.amount, notes: r.notes, category_id: cat ? cat.id : null };
    const ex = byTag[r.tag];
    if (ex) await run(db.from('expenses').update(payload).eq('id', ex.id), 'עדכון שכר בתזרים');
    else await run(db.from('expenses').insert({ ...payload, status: 'expected' }), 'רישום שכר בתזרים');
  }
  for (const e of stale) await run(db.from('expenses').delete().eq('id', e.id), 'מחיקת שכר ישן');
  toast('✓ השכר סונכרן לתזרים — ' + pfMoney(total));
}

/* ======================================================================
   (ג) הביצועים שלי — כמה הכנסתי ואם אני רווחי/ת
   סוכן: רק את עצמו (RLS + סינון). מנהל: בוחר עובד.
   לא מוצגים: נתח מנהלת, שכר בסיס, נתוני עובדים אחרים או סיכומי העסק.
   ====================================================================== */
let _pfEmpAgent = null;

function pfOpenEmployee(agentId) { _pfEmpAgent = agentId; openPage('mypay'); }

Pages.mypay = {
  title: 'הביצועים שלי',
  render: async (el) => {
    if (!['admin', 'sales'].includes(profile.role)) { el.innerHTML = '<div class="empty">אין הרשאה</div>'; return; }
    if (!pfOn()) { el.innerHTML = _pfDisabledHtml(); return; }
    const admin = profile.role === 'admin';
    const agentId = admin ? (_pfEmpAgent || (cache.agents[0] || {}).id) : myAgentId();
    if (!agentId) { el.innerHTML = '<div class="card card-pad"><p class="empty">המשתמש לא מקושר לסוכן — פנה למנהל</p></div>'; return; }
    const cur = today().slice(0, 7);
    const months = pfMonthsBack(cur, 6);
    el.innerHTML = `
<div class="page-head"><h2>💼 ${admin ? 'ביצועי עובד/ת' : 'הביצועים שלי'}</h2>
${admin ? `<select onchange="_pfEmpAgent=Number(this.value); openPage('mypay')">${(cache.agents || []).map(a => `<option value="${a.id}" ${a.id === agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
</div>
<div id="pfEmpBody"><div class="empty">מחשב...</div></div>`;
    let data;
    try { data = await pfLoad(months); }
    catch (e) { document.getElementById('pfEmpBody').innerHTML = `<div class="card card-pad"><p class="empty">${esc(e.message)}</p></div>`; return; }
    // המסך הזה לא מציג נתח מנהלת — גם למנהל, כדי שיראה בדיוק מה העובד/ת רואה
    data.managerCuts = [];
    const rows = months.map(m => {
      const r = pfComputeMonth(m, data).agents[agentId] || { revenue: 0, graphics: 0, commission: 0, profitability: 0, designed_count: 0, revenue_single: 0, revenue_deals: 0, target: 0, has_comp: false };
      return { m, r, closed: !!pfClosedInfo(data, m) };
    });
    const now = rows[0];
    const r = now.r;
    const prog = r.target ? Math.min(100, Math.round(r.revenue / r.target * 100)) : null;
    document.getElementById('pfEmpBody').innerHTML = `
<div class="card card-pad"><b>${esc(pfAgentName(agentId))} — ${cur}</b>
${now.closed ? '' : '<p class="muted" style="font-size:.8rem;margin:4px 0 0">עסקאות רב-חודשיות נכנסות אחרי סגירת החודש ע"י המנהל — עד אז מוצגות רק מודעות בודדות.</p>'}
</div>
<div class="stats">
${stat(pfMoney(r.revenue), 'כמה הכנסתי (נטו)')}
${stat(pfMoney(r.graphics), `עלות עיצוב (${r.designed_count || 0} מודעות)`)}
${stat(pfMoney(r.commission), 'העמלה שלי')}
${stat(pfMoney(r.profitability), r.profitability >= 0 ? 'רווחיות ✓' : 'רווחיות — הפסד', r.profitability >= 0 ? 'gold' : 'red')}
</div>
${prog != null ? `<div class="card card-pad"><div style="display:flex;justify-content:space-between;font-size:.85rem"><span>התקדמות ליעד ${pfMoney(r.target)}</span><b>${prog}%</b></div>
<div style="height:10px;background:var(--line,#e5e7eb);border-radius:6px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${prog}%;background:${prog >= 100 ? 'var(--ok)' : '@@COLOR_BRAND@@'}"></div></div>
${r.commission_parts && r.commission_parts.length > 1 ? `<p class="muted" style="font-size:.78rem;margin-top:6px">${r.commission_parts.map(p => `${p.pct}% על ${pfMoney(p.base)}`).join(' · ')}</p>` : ''}</div>` : ''}
<div class="card"><div class="table-wrap"><table class="data"><thead><tr><th>חודש</th><th>הכנסה (נטו)</th><th>עיצוב</th><th>עמלה</th><th>רווחיות</th><th></th></tr></thead><tbody>
${rows.map(x => `<tr><td><b>${x.m}</b></td><td>${pfMoney(x.r.revenue)}</td><td>${pfMoney(x.r.graphics)}</td><td>${pfMoney(x.r.commission)}</td>
<td><b style="color:${x.r.profitability >= 0 ? 'var(--ok)' : 'var(--danger)'}">${pfMoney(x.r.profitability)}</b></td>
<td class="muted" style="font-size:.74rem">${x.closed ? 'נסגר' : 'פתוח'}</td></tr>`).join('')}
</tbody></table></div></div>
<p class="muted" style="font-size:.78rem">רווחיות = הכנסה − עלות עיצוב המודעות שלי − העמלה שלי. ${r.has_comp ? '' : 'לא הוגדרו עדיין אחוזי עמלה — פנה למנהל.'}</p>`;
  }
};

/* ======================================================================
   דו"ח: רווח והפסד מדורג (נקרא מ-reports.js כ-report_pnlx) — מנהל בלבד
   ====================================================================== */
let _pfPnlTo = null, _pfPnlN = 3;

async function report_pnlx() {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  if (!pfOn()) { document.getElementById('reportArea').innerHTML = _pfDisabledHtml(); return; }
  _pfPnlTo = _pfPnlTo || pfDefaultCloseMonth();
  document.getElementById('reportArea').innerHTML = `
<div class="card-pad">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<b style="font-size:1.05rem">🧮 רווח והפסד מדורג</b>
<span style="display:flex;gap:6px;align-items:center">
<input type="month" value="${_pfPnlTo}" onchange="_pfPnlTo=this.value; report_pnlx()" style="width:auto">
<select onchange="_pfPnlN=Number(this.value); report_pnlx()">${[1, 3, 6, 12].map(n => `<option value="${n}" ${n === _pfPnlN ? 'selected' : ''}>${n === 1 ? 'חודש אחד' : n + ' חודשים'}</option>`).join('')}</select>
<button class="btn btn-sm btn-ghost" id="pfPnlCsv">⬇ אקסל</button>
<button class="btn btn-sm btn-ghost" onclick="printArea('רווח והפסד מדורג', document.getElementById('repTable').innerHTML)">🖨 PDF</button>
</span></div>
<div id="repTable" class="table-wrap" style="margin-top:12px"><div class="empty">מחשב...</div></div></div>`;
  const months = pfMonthsBack(_pfPnlTo, _pfPnlN).reverse();
  let data;
  try { data = await pfLoad(months, { expenses: true }); }
  catch (e) { document.getElementById('repTable').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const per = months.map(m => {
    const calc = pfComputeMonth(m, data);
    const exp = pfClassifyExpenses((data.expenses || []).filter(x => String(x.expense_date || '').slice(0, 7) === m), data.payrollCategoryIds);
    return { m, calc, p: pfPnl(calc, exp), closed: !!pfClosedInfo(data, m) };
  });
  const tot = k => per.reduce((s, x) => s + (Number(x.p[k]) || 0), 0);
  const LINES = [
    ['revenue', 'הכנסות מודעות (נטו, מוכרות)', 'sub'],
    ['revenue_single', '· מודעות בודדות', 'minor'],
    ['revenue_deals', '· עסקאות רב-חודשיות (סגירת חודש)', 'minor'],
    ['graphics', '− עיצוב / גרפיקה', 'neg'],
    ['graphics_ads', '· לפי מודעה מעוצבת', 'minor'],
    ['graphics_issue', '· עלויות גיליון בקטגוריית "גרפיקה"', 'minor'],
    ['gross', '= רווח גולמי', 'sum'],
    ['issue_costs', '− דפוס, הפצה ועלויות גיליון', 'neg'],
    ['commission', '− עמלות סוכנים', 'neg'],
    ['manager_cut', '− נתח מנהלת', 'neg'],
    ['salaries', '− שכר בסיס ובונוסים', 'neg'],
    ['operating', '= רווח תפעולי', 'sum'],
    ['other_expenses', '− הוצאות כלליות אחרות (לא מתויגות לגיליון)', 'neg'],
    ['net', '= רווח נקי', 'total'],
    ['payroll_synced', 'לידיעה: שכר שסונכרן לתזרים (כבר בשורות השכר — לא נספר שוב)', 'minor'],
    ['payroll_manual', 'לידיעה: הוצאות בקטגוריית שכר/עמלות (כבר בשורות השכר — לא נספרו שוב)', 'minor'],
  ];
  const cell = (v, kind) => {
    const n = Number(v) || 0;
    const clr = (kind === 'sum' || kind === 'total') ? `color:${n >= 0 ? 'var(--ok)' : 'var(--danger)'};font-weight:700` : (kind === 'minor' ? 'color:var(--muted);font-size:.82rem' : '');
    return `<td style="${clr}">${pfMoney(n)}</td>`;
  };
  const multi = months.length > 1;
  const agg = {};
  per.forEach(x => Object.values(x.calc.agents).forEach(r => {
    const a = agg[r.agent_id] = agg[r.agent_id] || { revenue: 0, graphics: 0, commission: 0, manager_cut: 0, base_salary: 0, profitability: 0 };
    ['revenue', 'graphics', 'commission', 'manager_cut', 'base_salary', 'profitability'].forEach(k => a[k] += Number(r[k]) || 0);
  }));
  const agRows = Object.entries(agg).filter(([, a]) => a.revenue || a.commission || a.manager_cut || a.base_salary)
    .sort((a, b) => b[1].revenue - a[1].revenue);
  const openMonths = per.filter(x => !x.closed).map(x => x.m);
  document.getElementById('repTable').innerHTML = `
${openMonths.length ? `<p style="background:#fffbeb;padding:8px;border-radius:8px;font-size:.84rem">⚠️ חודשים שלא נסגרו: ${openMonths.join(', ')} — עסקאות רב-חודשיות לא נכללות בהם עד סגירת החודש.</p>` : ''}
<table class="data"><thead><tr><th></th>${per.map(x => `<th>${x.m}</th>`).join('')}${multi ? '<th>סה"כ</th>' : ''}</tr></thead><tbody>
${LINES.map(([k, label, kind]) => `<tr${kind === 'sum' || kind === 'total' ? ' style="border-top:2px solid var(--line)"' : ''}><td${kind === 'minor' ? ' class="muted" style="font-size:.82rem;padding-right:18px"' : ''}>${kind === 'total' || kind === 'sum' ? '<b>' + label + '</b>' : label}</td>
${per.map(x => cell(x.p[k], kind)).join('')}${multi ? cell(tot(k), kind) : ''}</tr>`).join('')}
</tbody></table>
<b style="display:block;margin-top:18px">רווחיות לפי עובד/ת — ${months[0]}${multi ? ' עד ' + months[months.length - 1] : ''}</b>
<table class="data" style="margin-top:6px"><thead><tr><th>עובד/ת</th><th>הכנסה</th><th>עיצוב</th><th>עמלה</th><th>רווחיות (הכנסה−עיצוב−עמלה)</th><th>נתח מנהלת</th><th>שכר בסיס</th></tr></thead><tbody>
${agRows.map(([id, a]) => `<tr><td><b>${esc(pfAgentName(Number(id)))}</b></td><td>${pfMoney(a.revenue)}</td><td>${pfMoney(a.graphics)}</td><td>${pfMoney(a.commission)}</td>
<td><b style="color:${a.profitability >= 0 ? 'var(--ok)' : 'var(--danger)'}">${pfMoney(a.profitability)}</b></td><td>${a.manager_cut ? pfMoney(a.manager_cut) : '—'}</td><td>${a.base_salary ? pfMoney(a.base_salary) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">אין נתונים</td></tr>'}
</tbody></table>
<p class="muted" style="font-size:.78rem;margin-top:8px">הכל נטו, לפני מע"מ. הכנסה = מודעות בודדות לפי חודש הסגירה לדפוס של הגיליון + עסקאות רב-חודשיות לפי מה שאושר בסגירת החודש.
עיצוב = הסכום שסומן בכפתור "🎨 עיצוב" בכל מודעה + עלויות גיליון שתויגו "גרפיקה". עלויות גיליון והוצאות כלליות לפי חודש ההוצאה (#net:).
שכר ועמלות מחושבים רק מהגדרות התגמול: שורות שסונכרנו ממסך השכר וכל הוצאה בקטגוריית שכר/עמלות מוחרגות מההוצאות הכלליות, כדי שלא ייספרו פעמיים.
שכר בסיס הוא עלות קבועה — מוצג בדוח ובמסך השכר, ולא בתוך "רווחיות עובד".</p>`;
  const csvRows = LINES.map(([k, label]) => [label, ...per.map(x => Math.round(Number(x.p[k]) || 0)), ...(multi ? [Math.round(tot(k))] : [])]);
  document.getElementById('pfPnlCsv').onclick = () => exportCsv('רווח_והפסד_מדורג', ['שורה', ...months, ...(multi ? ['סה"כ'] : [])], csvRows);
}

/* ======================================================================
   כרטיס הגדרות: הפעלה · עלויות · תגמול עובדים · נתח מנהלת (מנהל בלבד)
   ====================================================================== */
async function pfToggleSave(on) {
  if (on && !confirm('להפעיל את מודול הרווחיות והשכר?\nיתווספו לתפריט: סגירת חודש, שכר לתשלום, והביצועים שלי (לסוכנים).')) { openPage('settings'); return; }
  await run(db.from('settings').upsert({ key: 'profitability_enabled', value: on ? '1' : '0' }));
  cache.settings.profitability_enabled = on ? '1' : '0';
  pfNavSync();
  toast(on ? 'מודול הרווחיות הופעל' : 'מודול הרווחיות כובה');
}

async function pfCostsSave() {
  const fee = document.getElementById('pfFee').value.trim();
  const dist = document.getElementById('pfDist').value.trim();
  const pt = document.getElementById('pfPrint').value.trim();
  if (fee !== '' && !(Number(fee) >= 0)) { toast('עלות עיצוב לא תקינה', true); return; }
  if (pt) { try { const o = JSON.parse(pt); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; } catch (e) { toast('טבלת מחירי דפוס חייבת להיות JSON, למשל {"32":2600,"40":3580}', true); return; } }
  if (!confirm('לשמור את עלויות הרווחיות?')) return;
  const ups = [{ key: 'graphics_fee_net', value: fee === '' ? '50' : String(Number(fee)) }];
  if (dist !== '') ups.push({ key: 'distribution_cost', value: String(Number(dist)) });
  if (pt) ups.push({ key: 'print_price_table', value: JSON.stringify(JSON.parse(pt)) });
  for (const u of ups) { await run(db.from('settings').upsert(u)); cache.settings[u.key] = u.value; }
  toast('✓ העלויות נשמרו');
}

async function pfDefAgentSave(v) {
  if (profile.role !== 'admin') return;
  await run(db.from('settings').upsert({ key: 'default_agent_id', value: v || '' }));
  cache.settings.default_agent_id = v || '';
  toast('✓ מודעות בלי סוכן ייזקפו ל' + (v ? pfAgentName(Number(v)) : 'סוכן המנהל'));
}

async function pfCompLoadInto() {
  const box = document.getElementById('pfCompBox'); if (!box) return;
  const probe = await db.from('agent_comp').select('*');
  if (probe.error) { box.innerHTML = `<p class="muted">${esc(_PF_MIGRATION_MSG)}</p>`; return; }
  const comps = {}; (probe.data || []).forEach(c => { comps[c.agent_id] = c; });
  const cutsR = await db.from('agent_manager_cut').select('*').order('id');
  const cut = (cutsR.data || [])[0] || null;
  const agents = (cache.agents || []).filter(a => a.active !== false || comps[a.id]);
  const v = x => x == null ? '' : esc(String(Number(x)));
  box.innerHTML = `
<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr>
<th>עובד/ת</th><th>שכר בסיס (ריק = עמלה בלבד)</th><th>יעד חודשי ₪</th><th>% עד היעד</th><th>% מעל היעד</th><th>פעיל</th></tr></thead><tbody>
${agents.map(a => { const c = comps[a.id] || {}; return `<tr data-agent="${a.id}" class="pfCompRow">
<td><b>${esc(a.name)}</b>${Array.isArray(c.tiers) && c.tiers.length ? ' <span class="pill amber" title="מוגדרות מדרגות מורחבות (tiers) — הן גוברות על שני האחוזים">מדרגות</span>' : ''}</td>
<td><input type="number" step="0.01" min="0" class="pfBase" value="${v(c.base_salary)}" placeholder="עמלה בלבד" style="width:110px;text-align:left"></td>
<td><input type="number" step="1" min="0" class="pfTarget" value="${c.agent_id != null ? v(c.monthly_target) : v(a.monthly_target)}" style="width:100px;text-align:left"></td>
<td><input type="number" step="0.1" min="0" max="100" class="pfPctB" value="${v(c.commission_pct_base)}" style="width:70px;text-align:left"></td>
<td><input type="number" step="0.1" min="0" max="100" class="pfPctA" value="${v(c.commission_pct_above)}" style="width:70px;text-align:left"></td>
<td><input type="checkbox" class="pfAct" ${c.agent_id == null || c.active ? 'checked' : ''} style="width:18px;height:18px"></td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">אין סוכנים</td></tr>'}
</tbody></table></div>
<button class="btn btn-sm" style="margin-top:8px" onclick="pfCompSave()">💾 שמירת תגמול עובדים</button>
<p class="muted" style="font-size:.76rem;margin-top:4px">שורה בלי אחוז עד-היעד ובלי שכר בסיס לא נשמרת. "% מעל היעד" ריק = אותו אחוז כמו עד היעד. העמלה מחושבת על ההכנסה המוכרת (נטו) של החודש.</p>

<b style="display:block;margin-top:16px">👩‍💼 נתח מנהלת מוקד</b>
<p class="muted" style="font-size:.8rem">אחוז מההכנסה המוכרת של הנציגות שתחתיה — משולם למנהלת <b>בנוסף</b>, לא מנוכה מהעמלה שלהן.</p>
<div class="grid2">
<div class="field"><label>המנהלת</label><select id="pfMgr"><option value="">— ללא —</option>${(cache.agents || []).map(a => `<option value="${a.id}" ${cut && cut.manager_agent_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
<div class="field"><label>% מהכנסות הנציגות</label><input id="pfMgrPct" type="number" step="0.1" min="0" max="100" value="${cut ? v(cut.pct) : ''}" dir="ltr"></div>
</div>
<div class="field"><label>הנציגות שתחתיה</label><div style="display:flex;flex-wrap:wrap;gap:10px">
${(cache.agents || []).filter(a => a.active !== false).map(a => `<label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" class="pfMgrSrc" value="${a.id}" ${cut && (cut.source_agent_ids || []).map(Number).includes(a.id) ? 'checked' : ''}> ${esc(a.name)}</label>`).join('')}
</div></div>
<button class="btn btn-sm" onclick="pfCutSave(${cut ? cut.id : 'null'})">💾 שמירת נתח מנהלת</button>`;
}

async function pfCompSave() {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  const num = (el) => { const s = el.value.trim(); return s === '' ? null : Number(s); };
  const recs = [];
  for (const tr of document.querySelectorAll('.pfCompRow')) {
    const base = num(tr.querySelector('.pfBase')), target = num(tr.querySelector('.pfTarget'));
    const pb = num(tr.querySelector('.pfPctB')), pa = num(tr.querySelector('.pfPctA'));
    if (pb == null && base == null) continue;
    if ([base, target].some(x => x != null && !(x >= 0)) || [pb, pa].some(x => x != null && !(x >= 0 && x <= 100))) {
      toast('ערך לא תקין בשורה של ' + tr.querySelector('b').textContent, true); return;
    }
    recs.push({ agent_id: Number(tr.dataset.agent), base_salary: base, monthly_target: target, commission_pct_base: pb || 0,
      commission_pct_above: pa, active: tr.querySelector('.pfAct').checked, updated_by: profile.id, updated_at: new Date().toISOString() });
  }
  if (!recs.length) { toast('אין שורות למילוי', true); return; }
  if (!confirm(`לשמור הגדרות תגמול ל-${recs.length} עובדים?\n\n` + recs.map(r => `${pfAgentName(r.agent_id)}: ${r.base_salary == null ? 'עמלה בלבד' : 'בסיס ' + pfMoney(r.base_salary)} · ${r.commission_pct_base}%${r.monthly_target ? ' עד ' + pfMoney(r.monthly_target) + ', ' + (r.commission_pct_above == null ? r.commission_pct_base : r.commission_pct_above) + '% מעל' : ''}`).join('\n'))) return;
  await run(db.from('agent_comp').upsert(recs, { onConflict: 'agent_id' }), 'שמירת תגמול');
  toast('✓ הגדרות התגמול נשמרו');
}

async function pfCutSave(existingId) {
  if (profile.role !== 'admin') { toast('למנהל בלבד', true); return; }
  const mgr = Number(document.getElementById('pfMgr').value) || null;
  const pct = Number(document.getElementById('pfMgrPct').value) || 0;
  const srcs = [...document.querySelectorAll('.pfMgrSrc:checked')].map(c => Number(c.value)).filter(id => id !== mgr);
  if (!mgr) {
    if (existingId && confirm('לבטל את נתח המנהלת?')) {
      await run(db.from('agent_manager_cut').update({ active: false, updated_by: profile.id, updated_at: new Date().toISOString() }).eq('id', existingId));
      toast('נתח המנהלת בוטל');
    }
    return;
  }
  if (!(pct >= 0 && pct <= 100)) { toast('אחוז לא תקין', true); return; }
  if (!srcs.length) { toast('בחר לפחות נציגה אחת', true); return; }
  if (!confirm(`לשמור: ${pfAgentName(mgr)} מקבלת ${pct}% מההכנסה המוכרת של ${srcs.map(pfAgentName).join(', ')}?`)) return;
  const rec = { manager_agent_id: mgr, source_agent_ids: srcs, pct, active: true, updated_by: profile.id, updated_at: new Date().toISOString() };
  // מנהלת אחת בהגדרה הנוכחית: עדכון השורה הקיימת (גם אם הוחלפה המנהלת)
  if (existingId) await run(db.from('agent_manager_cut').update(rec).eq('id', existingId), 'שמירת נתח מנהלת');
  else await run(db.from('agent_manager_cut').insert(rec), 'שמירת נתח מנהלת');
  toast('✓ נתח המנהלת נשמר');
  pfCompLoadInto();
}

(function () {
  const orig = typeof Pages !== 'undefined' && Pages.settings && Pages.settings.render;
  if (orig && !orig._pfWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try {
        const st = cache.settings || {};
        const card = document.createElement('div');
        card.className = 'card card-pad';
        card.innerHTML = `
<b>💼 רווחיות, שכר ועמלות</b>
<p class="muted" style="font-size:.82rem">תגמול עובדים (בסיס + עמלה מדורגת לפי יעד), נתח מנהלת, סגירת חודש (הכרה בהכנסה מעסקאות רב-חודשיות),
מסך שכר לתשלום, "הביצועים שלי" לסוכנים ודו"ח רווח והפסד מדורג. דורש את המיגרציה 2026-10-05_profitability_payroll. למנהל בלבד.
<br>כשהמודול פעיל — העמלות מחושבות רק לפי ההגדרות כאן: מסך "🤝 עמלות" מציג את החישוב הזה (מנהל: שכר לתשלום, סוכן: הביצועים שלי) במקום החישוב הישן לפי חיוב/גבייה.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" ${pfOn() ? 'checked' : ''} onchange="pfToggleSave(this.checked)" style="width:18px;height:18px">
המודול פעיל
</label>
<b style="display:block;margin-top:14px">עלויות (נטו, לפני מע"מ)</b>
<div class="grid2" style="margin-top:6px">
<div class="field"><label>תעריף עיצוב למודעה (₪ נטו + מע"מ) — ערך הכפתור "🎨 עיצוב" בכרטיס המודעה</label><input id="pfFee" type="number" min="0" step="1" value="${esc(st.graphics_fee_net != null ? st.graphics_fee_net : '50')}" dir="ltr"></div>
<div class="field"><label>עלות הפצה לגיליון (₪) — ברירת מחדל במסך עלויות הגיליון</label><input id="pfDist" type="number" min="0" step="1" value="${esc(st.distribution_cost || '')}" placeholder="500" dir="ltr"></div>
</div>
<div class="field"><label>מחירי דפוס לפי מספר עמודים (JSON) — ברירת מחדל במסך עלויות הגיליון</label><input id="pfPrint" value="${esc(st.print_price_table || '')}" placeholder='{"32":2600,"40":3580,"48":4100,"56":4695}' dir="ltr"></div>
<button class="btn btn-sm" onclick="pfCostsSave()">💾 שמירת עלויות</button>
<p class="muted" style="font-size:.76rem;margin-top:4px">עלות העיצוב נספרת רק למודעות שסומן בהן הכפתור "🎨 עיצוב" (אופציונלי, בכרטיס המודעה) — בסכום שהיה בתוקף בזמן הסימון. דפוס והפצה בפועל נרשמים פר גיליון במסך "עלויות גיליון" ונספרים בדו"ח לפי חודש ההוצאה.</p>
<div class="field" style="margin-top:10px"><label>מודעה בלי סוכן (וללקוח אין סוכן) נזקפת ל:</label>
<select id="pfDefAgent" onchange="pfDefAgentSave(this.value)"><option value="">אוטומטי — הסוכן המקושר למנהל${pfDefaultAgentId() ? ' (' + esc(pfAgentName(pfDefaultAgentId())) + ')' : ' (לא נמצא — בחרו)'}</option>
${(cache.agents || []).map(a => `<option value="${a.id}" ${String(st.default_agent_id || '') === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
<b style="display:block;margin-top:14px">תגמול עובדים</b>
<div id="pfCompBox"><div class="muted">טוען...</div></div>`;
        const anchor = el.querySelector('#activityLog');
        const anchorCard = anchor ? anchor.closest('.card') : null;
        if (anchorCard) el.insertBefore(card, anchorCard); else el.appendChild(card);
        pfCompLoadInto();
      } catch (e) { console.error('profitability settings card', e); }
      return r;
    };
    wrapped._pfWrapped = true;
    Pages.settings.render = wrapped;
  }
})();

/* ---------- תפריט: הפריטים נרשמים ב-NAV ומוסתרים כשהמודול כבוי ---------- */
const _PF_NAV = [
  { id: 'monthclose', title: 'סגירת חודש', icon: '🗓️', roles: ['admin'], group: 'כספים' },
  { id: 'payroll', title: 'שכר לתשלום', icon: '💵', roles: ['admin'], group: 'כספים' },
  { id: 'mypay', title: 'הביצועים שלי', icon: '💼', roles: ['sales'], group: 'כספים' },
];
(function () {
  if (typeof NAV === 'undefined') return;
  let idx = NAV.findIndex(n => n.id === 'commissions');
  _PF_NAV.forEach(item => {
    if (NAV.some(n => n.id === item.id)) return;
    if (idx >= 0) { NAV.splice(++idx, 0, item); } else NAV.push(item);
  });
})();
function pfNavSync() {
  const on = pfOn();
  _PF_NAV.forEach(n => { const b = document.getElementById('nav-' + n.id); if (b) b.classList.toggle('hidden', !on); });
}
(function () {
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._pfWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { pfNavSync(); } catch (e) { }
      return r;
    };
    wrapped._pfWrapped = true;
    window.refreshCache = wrapped;
  }
  // לפני שההגדרות נטענות — מוסתר (כבוי כברירת מחדל)
  const origShell = window.buildShell;
  if (typeof origShell === 'function' && !origShell._pfWrapped) {
    const w = function () { const r = origShell.apply(this, arguments); try { pfNavSync(); } catch (e) { } return r; };
    w._pfWrapped = true;
    window.buildShell = w;
  }
})();

/* ---------- "🤝 עמלות" — כשהמודול פעיל, העמלות לפי ההגדרות כאן בלבד ----------
   החישוב הישן (v_commissions: עמלת חיוב/גבייה לפי pct_new/pct_renew) לא מוצג
   כשהמודול פעיל, כדי שיהיה מקור אחד לעמלה. מנהל → שכר לתשלום; סוכן → הביצועים שלי.
   כשהמודול כבוי — המסך הישן כמו שהיה. */
(function () {
  const orig = typeof Pages !== 'undefined' && Pages.commissions && Pages.commissions.render;
  if (orig && !orig._pfWrapped) {
    const wrapped = async function (el) {
      if (!pfOn()) return orig.apply(this, arguments);
      const target = profile.role === 'admin' ? Pages.payroll : Pages.mypay;
      await target.render(el);
      const note = document.createElement('p');
      note.className = 'muted';
      note.style.fontSize = '.78rem';
      note.textContent = 'העמלות מחושבות לפי הגדרות התגמול (רווחיות, שכר ועמלות): אחוז עד היעד / מעל היעד על ההכנסה המוכרת של החודש.';
      el.prepend(note);
    };
    wrapped._pfWrapped = true;
    Pages.commissions.render = wrapped;
  }
})();
