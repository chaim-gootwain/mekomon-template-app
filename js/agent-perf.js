/* ============================================================
agent-perf.js — דשבורד "ביצועי סוכנים" (מנהל בלבד)
------------------------------------------------------------
לכל סוכן: שעות עבודה (attendance), שיחות (call_log), שיחות/שעה,
סגירות (ליד שעבר ל-won, לפי audit_log), סכום עסקאות (charges
בתקופה, בלי cancelled/lost — כמו "מכירות" במסך העמלות) ועמלה.

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
שיחות נרשמות רק מרגע מיגרציית call_log — אין נתוני עבר.
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

function apSetPreset(v) { _apPreset = v; openPage('agent-perf'); }
function apSetAgent(v) { _apAgent = v; openPage('agent-perf'); }
function apSetRange() {
  const f = document.getElementById('apFrom')?.value, t = document.getElementById('apTo')?.value;
  if (!f || !t) { toast('בחר תאריך התחלה וסיום', true); return; }
  if (f > t) { toast('תאריך ההתחלה אחרי הסיום', true); return; }
  _apFrom = f; _apTo = t; _apPreset = 'custom';
  openPage('agent-perf');
}

Pages['agent-perf'] = {
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">מסך למנהל בלבד</div>'; return; }
    const [from, to] = _apRange();
    const fromTs = new Date(from + 'T00:00:00').toISOString();
    const toD = new Date(to + 'T00:00:00'); toD.setDate(toD.getDate() + 1);
    const toTs = toD.toISOString();
    const months = _apMonths(from, to);

    const agents = cache.agents.filter(a => !_apAgent || String(a.id) === String(_apAgent));
    const agentByProfile = {}; cache.agents.forEach(a => { if (a.profile_id) agentByProfile[a.profile_id] = a.id; });

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

    /* ---------- צבירה לפי סוכן ---------- */
    const now = Date.now();
    const perAgent = {};
    const A = id => perAgent[id] = perAgent[id] || { calls: 0, hourKeys: new Set(), hours: 0, closings: 0, deals: 0, comm: 0, hist: new Array(24).fill(0) };
    (calls || []).forEach(c => {
      const aid = c.agent_id ?? agentByProfile[c.user_id];
      if (aid == null) return;
      const d = new Date(c.created_at);
      const a = A(aid);
      a.calls++;
      a.hourKeys.add(d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours());
      a.hist[d.getHours()]++;
    });
    att.forEach(r => {
      const aid = agentByProfile[r.profile_id];
      if (aid == null) return;
      const ms = (r.clock_out ? Date.parse(r.clock_out) : now) - Date.parse(r.clock_in);
      if (ms > 0) A(aid).hours += ms / 3600000;
    });
    closings.forEach(c => { if (c.agent_id != null) { A(c.agent_id).closings++; } });
    periodCharges.forEach(ch => { if (ch.agent_id != null) A(ch.agent_id).deals += Number(ch.amount || 0); });
    commRows.forEach(r => { if (r.agent_id != null) A(r.agent_id).comm += Number(r.commission || 0); });

    const rows = agents.map(a => ({ agent: a, ...(perAgent[a.id] || { calls: 0, hourKeys: new Set(), hours: 0, closings: 0, deals: 0, comm: 0, hist: new Array(24).fill(0) }) }));

    /* ---------- גרף שעות שיא (מסונן לסוכן הנבחר) ---------- */
    const hist = new Array(24).fill(0);
    rows.forEach(r => r.hist.forEach((n, h) => hist[h] += n));
    const maxH = Math.max(1, ...hist);
    const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
    const chart = totalCalls ? `<div style="display:flex;align-items:flex-end;gap:3px;height:150px;padding:8px 4px;border-bottom:2px solid var(--line,#e5e7eb)">
      ${hist.map((n, h) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end" title="${String(h).padStart(2, '0')}:00 — ${n} שיחות">
        ${n ? `<div style="font-size:.62rem;font-weight:700;color:#20306a">${n}</div>` : ''}
        <div style="width:70%;min-height:2px;height:${Math.round(n / maxH * 110)}px;background:@@COLOR_BRAND@@;border-radius:3px 3px 0 0;margin-top:2px"></div>
        <div style="font-size:.6rem;color:#666;margin-top:3px">${h}</div></div>`).join('')}
    </div>` : '<div class="empty">אין שיחות רשומות בתקופה — הרישום מתחיל מרגע התקנת מיגרציית call_log</div>';

    /* ---------- רינדור ---------- */
    const callsRate = r => {
      if (!r.calls) return '—';
      if (r.hours > 0) return (r.calls / r.hours).toFixed(1);
      const n = r.hourKeys.size; // אין נוכחות — מחלקים בשעות הפעילות שבהן היו שיחות
      return n ? (r.calls / n).toFixed(1) + ' *' : '—';
    };
    wrap.innerHTML = `
${calls === null ? '<div class="card card-pad" style="margin-bottom:12px"><b>⚠ יומן השיחות לא זמין</b><div class="muted" style="font-size:.82rem">יש להריץ את מיגרציית call_log במופע (migrations/2026-09-16_call_log.sql)</div></div>' : ''}
<div class="stats" style="margin-bottom:14px">
  ${stat(totalCalls || '0', 'שיחות בתקופה')}
  ${stat(rows.reduce((s, r) => s + r.hours, 0).toFixed(1), 'שעות עבודה')}
  ${stat(closings.length || '0', 'סגירות')}
  ${stat(money(rows.reduce((s, r) => s + r.deals, 0)) || '₪0', 'סכום עסקאות')}
  ${stat(money(rows.reduce((s, r) => s + r.comm, 0)) || '₪0', 'עמלות (חודשי)', 'gold')}
</div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>סוכנים בתקופה</b>
  <div id="apAgentsTbl" style="margin-top:8px"></div>
  <p class="muted" style="font-size:.75rem;margin:8px 0 0">
    * אין נתוני נוכחות לסוכן בתקופה — הקצב חושב לפי מספר השעות הפעילות שבהן היו שיחות.<br>
    עמודת "עמלה (חודשי)" מסכמת את v_commissions (עמלת חיוב + גבייה, בלי בונוס) לחודשים ${months.join(', ')} —
    אותו חישוב כמו מסך "עמלות"; ה-VIEW חודשי ולכן אינו ניתן לפילוח יומי.</p>
</div></div>
<div class="card" style="margin-bottom:14px"><div class="card-pad">
  <b>שעות שיא — שיחות לפי שעה ביום</b>
  <div style="margin-top:8px">${chart}</div>
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
      { h: 'סגירות', f: r => r.closings || '—' },
      { h: 'סכום עסקאות', f: r => money(r.deals) || '—' },
      { h: 'עמלה (חודשי)', f: r => money(r.comm) || '—' },
    ], { empty: 'אין סוכנים להצגה' });

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
