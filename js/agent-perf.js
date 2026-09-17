/* ============================================================
agent-perf.js — דשבורד "ביצועי סוכנים" (מנהל בלבד)
------------------------------------------------------------
לכל סוכן: שעות עבודה (attendance), שיחות (call_log), שיחות/שעה,
סגירות (ליד שעבר ל-won, לפי audit_log), סכום עסקאות (charges
בתקופה, בלי cancelled/lost — כמו "מכירות" במסך העמלות) ועמלה.
בנוסף: סיכום פעולות (הערות, קידומי סטטוס, הצעות מחיר, חיובים,
תשלומים) פר שעה ופר יום, מדד פרודוקטיביות 1–10, ודוח הצלבות
(שיחות × שעות × פעולות × הכנסה) עם תובנות.

עמלה — שני מספרים, בכוונה:
• בטבלה הראשית: סכום שורות v_commissions (עמלת חיוב + גבייה) —
  אותו חישוב בדיוק כמו מסך "עמלות". ה-VIEW חודשי ('YYYY-MM'),
  לכן העמודה מסכמת את החודשים שחופפים לתקופה שנבחרה, ואי אפשר
  לפלח אותה לימים בודדים.
• בפירוט הסגירות: "עמלה צפויה" = אחוז × סכום העסקה המלא (ההגדרה
  שסוכמה), כשהאחוז לפי אותם כללים של v_commissions:
  charges.commission_pct אם הוגדר (0=ריק), אחרת pct_new בתוך
  "תקופת לקוח חדש" (new_customer_months, ברירת מחדל 3) מהחיוב
  הראשון של הלקוח, אחרת pct_renew.

סגירה = ליד שעבר ל-status='won' בתקופה. אין עמודת תאריך-סגירה
בטבלת leads, ולכן התאריך נלקח מ-audit_log (רישום שינוי הסטטוס,
פועל מאז מיגרציית audit_log). הקישור ליד→לקוח אינו נשמר בעמודה —
ההתאמה נעשית לפי טלפון (9 ספרות אחרונות), כמו lead_customer_duplicates.
שיחות נרשמות רק מרגע מיגרציית call_log — אין נתוני עבר; ספירת
הפעולות מ-audit_log מלאה רק מאז מיגרציית audit_log.

מדד הפרודוקטיביות: נקודות משוקללות ÷ שעת עבודה מול יעד שעתי.
המשקלות והיעד ניתנים לדריסה דרך טבלת settings (מפתחות prod_w_* /
prod_target_hour) — ראה apWeights(). המדד מודד פעילות מתועדת,
לא איכות — ולכן מוצג תמיד לצד סגירות והכנסה.
============================================================ */

'use strict';

let _apPreset = 'week';
let _apFrom = null, _apTo = null;   // YYYY-MM-DD
let _apAgent = '';                  // '' = כל הסוכנים

function _apRange() {
  const t = today();
  if (_apPreset === 'today') return [t, t];
  if (_apPreset === 'week') {
    const d = new Date(); d.setDate(d.getDate() - d.getDay()); // ראשון
    return [d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), t];
  }
  if (_apPreset === 'month') return [t.slice(0, 8) + '01', t];
  return [_apFrom || t, _apTo || t]; // custom
}

/* חודשי v_commissions שחופפים לטווח */
function _apMonths(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  while (true) {
    const ym = y + '-' + String(m).padStart(2, '0');
    out.push(ym);
    if (ym >= end || out.length > 36) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function _apNorm9(p) { return String(p || '').replace(/\D/g, '').slice(-9); }

/* תאריך + חודשים (לחישוב "תקופת לקוח חדש") */
function _apAddMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* תאריך מקומי (YYYY-MM-DD) ושעה מקומית מתוך timestamp */
function _apDayOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _apHourOf(ts) { return new Date(ts).getHours(); }

/* ---------- מדד פרודוקטיביות — משותף גם לדוח הבוקר (agent-brief) ----------
   משקלות ויעד ניתנים לדריסה בטבלת settings:
   prod_w_call, prod_w_note, prod_w_status, prod_w_quote, prod_w_charge,
   prod_w_payment, prod_w_close, prod_target_hour (יעד נקודות לשעה). */
function apWeights() {
  const n = (key, def) => { const v = Number((cache.settings || {})[key]); return isFinite(v) && v > 0 ? v : def; };
  return {
    call: n('prod_w_call', 1), note: n('prod_w_note', 1), status: n('prod_w_status', 2),
    quote: n('prod_w_quote', 3), charge: n('prod_w_charge', 3), payment: n('prod_w_payment', 3),
    close: n('prod_w_close', 8), target: n('prod_target_hour', 10),
  };
}
/* נקודות של דלי פעולות אחד לפי המשקלות */
function apPoints(b, W) {
  return (b.calls || 0) * W.call + ((b.leadNotes || 0) + (b.custNotes || 0) + (b.newLeads || 0)) * W.note
    + (b.statusAdv || 0) * W.status + (b.quotes || 0) * W.quote
    + (b.chargesIns || 0) * W.charge + (b.paymentsIns || 0) * W.payment + (b.closings || 0) * W.close;
}
/* ציון 1–10: קצב נקודות לשעה מול היעד. שעה מוחתמת בלי פעולות = 1.
   hours=0 → null (אין על מה לתת ציון) */
function apDayScore(points, hours, W) {
  if (!(hours > 0)) return null;
  return Math.max(1, Math.min(10, Math.round(10 * (points / hours) / W.target)));
}
/* קידום סטטוס ליד שנספר כפעולה (won=סגירה, lost/new לא נספרים) */
const AP_STATUS_ADV = ['contacted', 'meeting', 'proposal'];

function apSetPreset(v) { _apPreset = v; openPage('agent-perf'); }
function apSetAgent(v) { _apAgent = v; openPage('agent-perf'); }
function apSetRange() {
  const f = document.getElementById('apFrom')?.value, t = document.getElementById('apTo')?.value;
  if (!f || !t) { toast('בחר תאריך התחלה וסיום', true); return; }
  if (f > t) { toast('תאריך ההתחלה אחרי הסיום', true); return; }
  _apFrom = f; _apTo = t; _apPreset = 'custom';
  openPage('agent-perf');
}

/* גרף עמודות 0–23 בסגנון הקיים (reports.js) */
function _apHourChart(hist, color, unit) {
  const maxH = Math.max(1, ...hist);
  return `<div style="display:flex;align-items:flex-end;gap:3px;height:150px;padding:8px 4px;border-bottom:2px solid var(--line,#e5e7eb)">
    ${hist.map((n, h) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end" title="${String(h).padStart(2, '0')}:00 — ${n} ${unit}">
      ${n ? `<div style="font-size:.62rem;font-weight:700;color:#20306a">${n}</div>` : ''}
      <div style="width:70%;min-height:2px;height:${Math.round(n / maxH * 110)}px;background:${color};border-radius:3px 3px 0 0;margin-top:2px"></div>
      <div style="font-size:.6rem;color:#666;margin-top:3px">${h}</div></div>`).join('')}
  </div>`;
}

Pages['agent-perf'] = {
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">מסך למנהל בלבד</div>'; return; }
    const [from, to] = _apRange();
    const fromTs = new Date(from + 'T00:00:00').toISOString();
    const toD = new Date(to + 'T00:00:00'); toD.setDate(toD.getDate() + 1);
    const toTs = toD.toISOString();
    const months = _apMonths(from, to);
    const W = apWeights();

    const agents = cache.agents.filter(a => !_apAgent || String(a.id) === String(_apAgent));
    const agentByProfile = {}; cache.agents.forEach(a => { if (a.profile_id) agentByProfile[a.profile_id] = a.id; });
    const agentOf = uid => agentByProfile[uid]; // פעולה של משתמש שאינו סוכן (מנהל/עורך) לא נספרת לאף סוכן
    const inSel = aid => aid != null && (!_apAgent || String(aid) === String(_apAgent));
    const custAgent = {}; (cache.customers || []).forEach(c => { if (c.agent_id != null) custAgent[c.id] = c.agent_id; });

    el.innerHTML = `
<div class="page-head">
  <h2>ביצועי סוכנים</h2>
  <div class="actions" style="flex-wrap:wrap;gap:6px">
    <select onchange="apSetAgent(this.value)" style="width:auto">
      <option value="">כל הסוכנים</option>
      ${cache.agents.map(a => `<option value="${a.id}" ${String(a.id) === String(_apAgent) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>
    <div class="tabs" style="margin:0">
      ${[['today', 'היום'], ['week', 'השבוע'], ['month', 'החודש'], ['custom', 'טווח']].map(([v, t]) =>
      `<button class="${_apPreset === v ? 'active' : ''}" onclick="${v === 'custom' ? "document.getElementById('apCustom').style.display='flex'" : `apSetPreset('${v}')`}">${t}</button>`).join('')}
    </div>
    <span id="apCustom" style="display:${_apPreset === 'custom' ? 'flex' : 'none'};gap:6px;align-items:center">
      <input type="date" id="apFrom" value="${_apFrom || from}" style="width:auto">
      <input type="date" id="apTo" value="${_apTo || to}" style="width:auto">
      <button class="btn btn-sm" onclick="apSetRange()">הצג</button>
    </span>
  </div>
</div>
<p class="muted" style="font-size:.82rem;margin:0 0 10px">תקופה: ${heDate(from)} – ${heDate(to)}</p>
<div id="apContent"><div class="empty">טוען...</div></div>`;

    /* ---------- שליפות ---------- */
    let calls = [], att = [], periodCharges = [], commRows = [];
    let notes = [], quotes = [], auditLeads = [], auditFin = [], payRows = [];
    let auditRows = null; // null = audit_log לא זמין
    const jobs = [
      runAll((f, t) => db.from('call_log').select('agent_id,user_id,created_at').gte('created_at', fromTs).lt('created_at', toTs).order('id').range(f, t), 'יומן שיחות')
        .then(r => calls = r).catch(() => { calls = null; }),
      runAll((f, t) => db.from('attendance').select('profile_id,clock_in,clock_out').gte('clock_in', fromTs).lt('clock_in', toTs).order('id').range(f, t), 'נוכחות')
        .then(r => att = r).catch(() => { }),
      runAll((f, t) => db.from('charges').select('id,agent_id,customer_id,amount,status,issued_date').gte('issued_date', from).lte('issued_date', to).not('status', 'in', '("cancelled","lost")').order('id').range(f, t), 'חיובים')
        .then(r => periodCharges = r).catch(() => { }),
      run(db.from('v_commissions').select('agent_id,month,commission').in('month', months), 'עמלות')
        .then(r => commRows = r || []).catch(() => { }),
      db.from('audit_log').select('row_id,at').eq('table_name', 'leads').eq('action', 'update').eq('field', 'status').eq('new_value', 'won').gte('at', fromTs).lt('at', toTs).order('at').limit(2000)
        .then(r => { if (!r.error) auditRows = r.data || []; }),
      /* פעולות: הערות, הצעות מחיר, יצירת/קידום לידים, הפקת חיובים ורישום תשלומים */
      runAll((f, t) => db.from('interactions').select('user_id,entity_type,created_at').gte('created_at', fromTs).lt('created_at', toTs).order('id').range(f, t), 'הערות')
        .then(r => notes = r).catch(() => { }),
      runAll((f, t) => db.from('quotes').select('created_by,created_at').gte('created_at', fromTs).lt('created_at', toTs).order('id').range(f, t), 'הצעות מחיר')
        .then(r => quotes = r).catch(() => { }),
      runAll((f, t) => db.from('audit_log').select('action,field,new_value,user_id,at').eq('table_name', 'leads').gte('at', fromTs).lt('at', toTs).order('id').range(f, t), 'פעולות לידים')
        .then(r => auditLeads = r).catch(() => { }),
      runAll((f, t) => db.from('audit_log').select('table_name,user_id,at').in('table_name', ['charges', 'payments']).eq('action', 'insert').gte('at', fromTs).lt('at', toTs).order('id').range(f, t), 'פעולות כספים')
        .then(r => auditFin = r).catch(() => { }),
      runAll((f, t) => db.from('payments').select('amount,customer_id,paid_date').gte('paid_date', from).lte('paid_date', to).order('id').range(f, t), 'גבייה')
        .then(r => payRows = r).catch(() => { }),
    ];
    await Promise.all(jobs);
    const wrap = document.getElementById('apContent');
    if (!wrap) return; // המשתמש עבר דף בזמן הטעינה

    /* ---------- סגירות: ליד שעבר ל-won בתקופה (לפי audit_log) ---------- */
    let closings = [];
    if (auditRows && auditRows.length) {
      const lastWin = {}; // ליד שהוזז הלוך ושוב — נספר פעם אחת, לפי האירוע האחרון
      auditRows.forEach(r => { if (r.row_id != null) lastWin[r.row_id] = r.at; });
      const leadIds = Object.keys(lastWin).map(Number);
      let leadRows = [];
      try {
        leadRows = await runAllIn((f, t) => db.from('leads').select('id,name,phone,agent_id,status').order('id').range(f, t), 'id', leadIds, 'לידים');
      } catch (e) { }
      /* התאמת ליד→לקוח לפי טלפון (9 ספרות אחרונות) */
      const custByPhone = {};
      (cache.customers || []).forEach(c => { const k = _apNorm9(c.phone); if (k.length >= 7 && !custByPhone[k]) custByPhone[k] = c; });
      closings = leadRows.filter(l => l.status === 'won').map(l => {
        const cust = custByPhone[_apNorm9(l.phone)] || null;
        return { lead_id: l.id, lead_name: l.name, agent_id: l.agent_id, won_at: lastWin[l.id], customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : null };
      });
      if (_apAgent) closings = closings.filter(c => String(c.agent_id) === String(_apAgent));
      closings.sort((a, b) => String(b.won_at).localeCompare(String(a.won_at)));

      /* סכום עסקה + עמלה צפויה: כל חיובי הלקוח שהופקו מיום הסגירה והלאה */
      const custIds = [...new Set(closings.map(c => c.customer_id).filter(Boolean))];
      let custCharges = [];
      if (custIds.length) {
        try {
          custCharges = await runAllIn((f, t) => db.from('charges').select('id,customer_id,agent_id,amount,status,issued_date,commission_pct').order('id').range(f, t), 'customer_id', custIds, 'חיובי לקוחות');
        } catch (e) { }
      }
      const byCust = {}; custCharges.forEach(ch => (byCust[ch.customer_id] = byCust[ch.customer_id] || []).push(ch));
      const newMonths = Math.max(Number(cache.settings.new_customer_months || 3) || 3, 0);
      closings.forEach(c => {
        const all = byCust[c.customer_id] || [];
        const firstDate = all.reduce((m, ch) => !m || ch.issued_date < m ? ch.issued_date : m, null);
        const mine = all.filter(ch => !['cancelled', 'lost'].includes(ch.status) && ch.issued_date && ch.issued_date >= String(c.won_at).slice(0, 10));
        c.deal_sum = mine.reduce((s, ch) => s + Number(ch.amount || 0), 0);
        c.commission = mine.reduce((s, ch) => {
          const agent = cache.agents.find(a => a.id === (ch.agent_id ?? c.agent_id));
          const isNew = firstDate && ch.issued_date < _apAddMonths(firstDate, newMonths);
          const pct = Number(ch.commission_pct || 0) || (agent ? Number((isNew ? agent.pct_new : agent.pct_renew) || 0) : 0);
          return s + Number(ch.amount || 0) * pct / 100;
        }, 0);
      });
    }

    /* ---------- צבירה לפי סוכן (סה"כ לתקופה) ---------- */
    const now = Date.now();
    const perAgent = {};
    const A = id => perAgent[id] = perAgent[id] || { calls: 0, hourKeys: new Set(), hours: 0, closings: 0, deals: 0, comm: 0, hist: new Array(24).fill(0) };
    /* וצבירה פר סוכן-יום — לפעולות, לציון ולדוח ההצלבות */
    const perDay = {};
    const D = (aid, day) => perDay[aid + '|' + day] = perDay[aid + '|' + day] ||
      { aid, day, calls: 0, hours: 0, leadNotes: 0, custNotes: 0, newLeads: 0, statusAdv: 0, quotes: 0, chargesIns: 0, paymentsIns: 0, closings: 0, revenue: 0, collected: 0 };
    const actHist = new Array(24).fill(0);      // פעולות לפי שעה (מסונן לבחירה)
    const closeHist = new Array(24).fill(0);    // סגירות לפי שעה — לתובנות
    const bump = (uidOrAid, ts, field, isAid) => {
      const aid = isAid ? uidOrAid : agentOf(uidOrAid);
      if (!inSel(aid)) return;
      D(aid, _apDayOf(ts))[field]++;
      actHist[_apHourOf(ts)]++;
    };

    (calls || []).forEach(c => {
      const aid = c.agent_id ?? agentOf(c.user_id);
      if (aid == null) return;
      const d = new Date(c.created_at);
      const a = A(aid);
      a.calls++;
      a.hourKeys.add(d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours());
      a.hist[d.getHours()]++;
      if (inSel(aid)) { D(aid, _apDayOf(c.created_at)).calls++; actHist[d.getHours()]++; }
    });
    att.forEach(r => {
      const aid = agentOf(r.profile_id);
      if (aid == null) return;
      const ms = (r.clock_out ? Date.parse(r.clock_out) : now) - Date.parse(r.clock_in);
      if (ms > 0) {
        A(aid).hours += ms / 3600000;
        if (inSel(aid)) D(aid, _apDayOf(r.clock_in)).hours += ms / 3600000;
      }
    });
    notes.forEach(n => bump(n.user_id, n.created_at, n.entity_type === 'lead' ? 'leadNotes' : 'custNotes'));
    quotes.forEach(q => bump(q.created_by, q.created_at, 'quotes'));
    auditLeads.forEach(r => {
      if (r.action === 'insert') bump(r.user_id, r.at, 'newLeads');
      else if (r.action === 'update' && r.field === 'status' && AP_STATUS_ADV.includes(r.new_value)) bump(r.user_id, r.at, 'statusAdv');
    });
    auditFin.forEach(r => bump(r.user_id, r.at, r.table_name === 'charges' ? 'chargesIns' : 'paymentsIns'));
    payRows.forEach(p => {
      const aid = custAgent[p.customer_id];
      if (inSel(aid)) D(aid, p.paid_date).collected += Number(p.amount || 0);
    });
    closings.forEach(c => {
      if (c.agent_id != null) {
        A(c.agent_id).closings++;
        if (inSel(c.agent_id)) { D(c.agent_id, _apDayOf(c.won_at)).closings++; closeHist[_apHourOf(c.won_at)]++; }
      }
    });
    periodCharges.forEach(ch => {
      if (ch.agent_id != null) {
        A(ch.agent_id).deals += Number(ch.amount || 0);
        if (inSel(ch.agent_id)) D(ch.agent_id, ch.issued_date).revenue += Number(ch.amount || 0);
      }
    });
    commRows.forEach(r => { if (r.agent_id != null) A(r.agent_id).comm += Number(r.commission || 0); });

    /* ציון פר יום + ממוצע לתקופה פר סוכן */
    const dayRows = Object.values(perDay);
    dayRows.forEach(d => {
      d.actions = d.leadNotes + d.custNotes + d.newLeads + d.statusAdv + d.quotes + d.chargesIns + d.paymentsIns + d.calls;
      d.points = apPoints(d, W);
      /* אין נוכחות ביום הזה — נפילה חלופית: שעות פעילות עם שיחות באותו יום */
      const fbHours = d.hours > 0 ? d.hours : (perAgent[d.aid] ? [...perAgent[d.aid].hourKeys].filter(k => {
        const p = k.split('-'); // y-m(0based)-d-h
        return _apDayOf(new Date(+p[0], +p[1], +p[2])) === d.day;
      }).length : 0);
      d.score = apDayScore(d.points, fbHours, W);
      d.fbUsed = d.hours <= 0 && fbHours > 0;
    });
    const scoreOf = aid => {
      const ds = dayRows.filter(d => d.aid === aid && d.score != null);
      return ds.length ? Math.round(ds.reduce((s, d) => s + d.score, 0) / ds.length) : null;
    };
    const actionsOf = aid => dayRows.filter(d => d.aid === aid).reduce((s, d) => s + d.actions, 0);

    const rows = agents.map(a => ({ agent: a, score: scoreOf(a.id), actions: actionsOf(a.id), ...(perAgent[a.id] || { calls: 0, hourKeys: new Set(), hours: 0, closings: 0, deals: 0, comm: 0, hist: new Array(24).fill(0) }) }));

    /* ---------- גרפים לפי שעה (מסוננים לסוכן הנבחר) ---------- */
    const hist = new Array(24).fill(0);
    rows.forEach(r => r.hist.forEach((n, h) => hist[h] += n));
    const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
    const totalActions = actHist.reduce((s, n) => s + n, 0);
    const chart = totalCalls ? _apHourChart(hist, '@@COLOR_BRAND@@', 'שיחות')
      : '<div class="empty">אין שיחות רשומות בתקופה — הרישום מתחיל מרגע התקנת מיגרציית call_log</div>';
    const actChart = totalActions ? _apHourChart(actHist, '@@COLOR_GRAD@@', 'פעולות')
      : '<div class="empty">אין פעולות רשומות בתקופה</div>';

    /* ---------- סיכום פעולות פר יום (מסוכם על הסוכנים הנבחרים) ---------- */
    const byDay = {};
    dayRows.forEach(d => {
      const t = byDay[d.day] = byDay[d.day] || { day: d.day, calls: 0, leadNotes: 0, custNotes: 0, statusAdv: 0, newLeads: 0, quotes: 0, chargesIns: 0, paymentsIns: 0, actions: 0, hours: 0, revenue: 0, collected: 0, closings: 0 };
      ['calls', 'leadNotes', 'custNotes', 'statusAdv', 'newLeads', 'quotes', 'chargesIns', 'paymentsIns', 'actions', 'hours', 'revenue', 'collected', 'closings'].forEach(k => t[k] += d[k]);
    });
    const daySummary = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));

    /* ---------- דוח הצלבות: יחסים + תובנות ---------- */
    const totHours = rows.reduce((s, r) => s + r.hours, 0);
    const totClosings = closings.length;
    const totRevenue = rows.reduce((s, r) => s + r.deals, 0);
    const totCollected = dayRows.reduce((s, d) => s + d.collected, 0);
    const ratio = (a, b, dec = 1) => b > 0 ? (a / b).toFixed(dec) : '—';
    const insights = [];
    const distinctDays = daySummary.filter(d => d.actions > 0 || d.hours > 0).length;
    if (distinctDays >= 10) {
      /* ימים עם הרבה שיחות מול מעטות — האם ההכנסה שונה? */
      const withCalls = daySummary.filter(d => d.calls > 0).sort((a, b) => a.calls - b.calls);
      if (withCalls.length >= 10) {
        const half = Math.floor(withCalls.length / 2);
        const low = withCalls.slice(0, half), high = withCalls.slice(-half);
        const avg = (arr, k) => arr.reduce((s, d) => s + d[k], 0) / arr.length;
        const rLow = avg(low, 'revenue'), rHigh = avg(high, 'revenue');
        if (rLow > 0 && rHigh / rLow >= 1.5)
          insights.push(`בימים עם הרבה שיחות (${Math.round(avg(high, 'calls'))} בממוצע) ההכנסה גבוהה פי ${(rHigh / rLow).toFixed(1)} מבימים עם מעט שיחות`);
      }
      /* שעות הסגירה החזקות */
      if (totClosings >= 5) {
        const top = closeHist.map((n, h) => [h, n]).sort((a, b) => b[1] - a[1]).slice(0, 2).filter(x => x[1] > 0);
        const share = top.reduce((s, x) => s + x[1], 0) / totClosings;
        if (share >= 0.4) insights.push(`השעות ${top.map(x => x[0] + ':00').join(' ו-')} מייצרות ${Math.round(share * 100)}% מהסגירות`);
      }
      if (totHours > 0 && totRevenue > 0) insights.push(`כל שעת עבודה מייצרת בממוצע ${money(totRevenue / totHours)} הכנסה`);
    }
    const crossRows = dayRows.filter(d => d.actions > 0 || d.hours > 0 || d.revenue > 0 || d.collected > 0)
      .sort((a, b) => b.day.localeCompare(a.day) || String(a.aid).localeCompare(String(b.aid))).slice(0, 90);

    /* ---------- רינדור ---------- */
    const callsRate = r => {
      if (!r.calls) return '—';
      if (r.hours > 0) return (r.calls / r.hours).toFixed(1);
      const n = r.hourKeys.size; // אין נוכחות — מחלקים בשעות הפעילות שבהן היו שיחות
      return n ? (r.calls / n).toFixed(1) + ' *' : '—';
    };
    const scorePill = s => s == null ? '—' : `<span class="pill ${s >= 8 ? 'green' : s >= 5 ? 'gold' : 'red'}">${s}/10</span>`;
    wrap.innerHTML = `
${calls === null ? '<div class="card card-pad" style="margin-bottom:12px"><b>⚠ יומן השיחות לא זמין</b><div class="muted" style="font-size:.82rem">יש להריץ את מיגרציית call_log במופע (migrations/2026-09-16_call_log.sql)</div></div>' : ''}
<div class="stats" style="margin-bottom:14px">
  ${stat(totalCalls || '0', 'שיחות בתקופה')}
  ${stat(totHours.toFixed(1), 'שעות עבודה')}
  ${stat(totalActions || '0', 'פעולות')}
  ${stat(totClosings || '0', 'סגירות')}
  ${stat(money(totRevenue) || '₪0', 'סכום עסקאות')}
  ${stat(money(rows.reduce((s, r) => s + r.comm, 0)) || '₪0', 'עמלות (חודשי)', 'gold')}
</div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>סוכנים בתקופה</b>
  <div id="apAgentsTbl" style="margin-top:8px"></div>
  <p class="muted" style="font-size:.75rem;margin:8px 0 0">
    * אין נתוני נוכחות לסוכן בתקופה — הקצב חושב לפי מספר השעות הפעילות שבהן היו שיחות.<br>
    ציון = נקודות פעילות לשעת עבודה מול יעד של ${W.target} נק'/שעה (ממוצע ימי התקופה). המדד מודד פעילות מתועדת — תמיד לקרוא אותו לצד סגירות והכנסה.<br>
    עמודת "עמלה (חודשי)" מסכמת את v_commissions (עמלת חיוב + גבייה, בלי בונוס) לחודשים ${months.join(', ')} —
    אותו חישוב כמו מסך "עמלות"; ה-VIEW חודשי ולכן אינו ניתן לפילוח יומי.</p>
</div></div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>שעות שיא — שיחות לפי שעה ביום</b>
  <div style="margin-top:8px">${chart}</div>
</div></div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>פעולות לפי שעה ביום</b> <span class="muted" style="font-size:.8rem">· שיחות + הערות + קידומי סטטוס + הצעות + חיובים + תשלומים</span>
  <div style="margin-top:8px">${actChart}</div>
</div></div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>סיכום פעולות לפי יום</b>
  <div id="apDaysTbl" style="margin-top:8px"></div>
</div></div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>דוח הצלבות — שיחות × שעות × פעולות × הכנסה</b>
  <div class="stats" style="margin:10px 0 4px">
    ${stat(ratio(totalCalls, totClosings, 0), 'שיחות לסגירה')}
    ${stat(totHours > 0 ? money(totRevenue / totHours) : '—', 'הכנסה לשעת עבודה')}
    ${stat(totalCalls > 0 ? money(totRevenue / totalCalls) : '—', 'הכנסה לשיחה')}
    ${stat(money(totCollected) || '₪0', 'גבייה בפועל בתקופה')}
  </div>
  ${insights.length ? `<div style="background:var(--bg,#f6f7fb);border-radius:10px;padding:10px 14px;margin:8px 0"><b style="font-size:.85rem">💡 תובנות</b><ul style="margin:6px 0 0;padding-inline-start:18px;font-size:.85rem">${insights.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`
      : `<p class="muted" style="font-size:.78rem;margin:6px 0">תובנות אוטומטיות יופיעו כשיצטברו לפחות 10 ימי נתונים בתקופה הנבחרת</p>`}
  <div id="apCrossTbl" style="margin-top:8px"></div>
  <p class="muted" style="font-size:.75rem;margin:8px 0 0">הכנסה = חיובים שהופקו (כמו "מכירות" במסך עמלות); גבייה = תשלומים שנרשמו בפועל. מוצגים עד 90 ימי סוכן אחרונים.</p>
</div></div>
<div class="card"><div class="card-pad">
  <b>פירוט סגירות</b> <span class="muted" style="font-size:.8rem">· ליד שעבר ל"נסגר ✓" בתקופה · לחיצה פותחת את הכרטיס</span>
  <div id="apClosingsTbl" style="margin-top:8px"></div>
  ${auditRows === null ? '<p class="muted" style="font-size:.78rem;margin:8px 0 0">⚠ audit_log לא זמין במופע — אי אפשר לתארך סגירות. יש להריץ את מיגרציית audit_log.</p>'
      : '<p class="muted" style="font-size:.75rem;margin:8px 0 0">סכום העסקה = חיובי הלקוח (ללא מבוטלים/אבודים) מיום הסגירה והלאה; עמלה צפויה = אחוז הסוכן × הסכום המלא. הקישור ליד→לקוח לפי מספר טלפון.</p>'}
</div></div>`;

    renderTable(document.getElementById('apAgentsTbl'), rows, [
      { h: 'סוכן', f: r => `<b>${esc(r.agent.name)}</b>` },
      { h: 'שעות עבודה', f: r => r.hours ? r.hours.toFixed(1) : '—' },
      { h: 'שיחות', f: r => r.calls || '—' },
      { h: 'שיחות/שעה', f: callsRate },
      { h: 'פעולות', f: r => r.actions || '—' },
      { h: 'ציון', f: r => scorePill(r.score) },
      { h: 'סגירות', f: r => r.closings || '—' },
      { h: 'סכום עסקאות', f: r => money(r.deals) || '—' },
      { h: 'עמלה (חודשי)', f: r => money(r.comm) || '—' },
    ], { empty: 'אין סוכנים להצגה' });

    renderTable(document.getElementById('apDaysTbl'), daySummary, [
      { h: 'יום', f: r => heDate(r.day) },
      { h: 'שיחות', f: r => r.calls || '—' },
      { h: 'הערות בלידים', f: r => r.leadNotes || '—' },
      { h: 'הערות בלקוחות', f: r => r.custNotes || '—' },
      { h: 'לידים חדשים', f: r => r.newLeads || '—' },
      { h: 'קידומי סטטוס', f: r => r.statusAdv || '—' },
      { h: 'הצעות מחיר', f: r => r.quotes || '—' },
      { h: 'חיובים', f: r => r.chargesIns || '—' },
      { h: 'תשלומים', f: r => r.paymentsIns || '—' },
      { h: 'סה"כ פעולות', f: r => `<b>${r.actions}</b>` },
    ], { empty: 'אין פעולות בתקופה' });

    renderTable(document.getElementById('apCrossTbl'), crossRows, [
      { h: 'יום', f: r => heDate(r.day) },
      { h: 'סוכן', f: r => esc(nameOf('agents', r.aid)) || '—' },
      { h: 'שעות', f: r => r.hours ? r.hours.toFixed(1) : '—' },
      { h: 'שיחות', f: r => r.calls || '—' },
      { h: 'פעולות', f: r => r.actions || '—' },
      {
        h: 'ציון', f: r => `<span title="נקודות: ${r.points}${r.fbUsed ? ' · לפי שעות פעילות (אין נוכחות)' : ''}">${scorePill(r.score)}</span>`
      },
      { h: 'סגירות', f: r => r.closings || '—' },
      { h: 'הכנסה', f: r => money(r.revenue) || '—' },
      { h: 'גבייה', f: r => money(r.collected) || '—' },
    ], { empty: 'אין נתונים להצלבה בתקופה' });

    renderTable(document.getElementById('apClosingsTbl'), closings, [
      { h: 'תאריך', f: r => heDate(r.won_at) },
      { h: 'סוכן', f: r => esc(nameOf('agents', r.agent_id)) || '—' },
      { h: 'לקוח / עסק', f: r => r.customer_name ? esc(r.customer_name) : esc(r.lead_name) + ' <span class="muted" style="font-size:.75rem">(ליד)</span>' },
      { h: 'סכום העסקה', f: r => r.customer_id ? (money(r.deal_sum) || '₪0') : '—' },
      { h: 'עמלה צפויה', f: r => r.customer_id ? (money(r.commission) || '₪0') : '—' },
    ], {
      empty: 'אין סגירות בתקופה',
      onRow: r => {
        if (r.customer_id) openPage('customers').then(() => window.openCustomerCard && openCustomerCard(r.customer_id));
        else openPage('leads').then(() => window.openLeadCard && openLeadCard(r.lead_id));
      },
    });
  },
};
