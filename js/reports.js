/* ============================================================
reports.js — דו״חות (ייצוא לאקסל + הדפסה/PDF)
------------------------------------------------------------
הכנסות · משפך מכירות · גיול חובות · גיליון · לקוח
כל דו"ח: פונקציה אחת שמושכת נתונים ובונה טבלה — קל להוסיף עוד
============================================================ */

'use strict';

Pages.reports = {
render: async (el) => {
const role = profile.role;
const reports = [
{ id: 'revenue', title: '📈 הכנסות', desc: 'לפי חודש, גיליון וסוכן — נמכר מול נגבה', roles: ['admin', 'sales'] },
{ id: 'deals', title: '🤝 עסקאות שנסגרו', desc: 'חוזים לפי חודש-סגירה — כמות, ₪ וצמיחה', roles: ['admin', 'sales'] },
{ id: 'funnel', title: '🔻 משפך מכירות', desc: 'לידים לפי שלב ומקור, אחוזי המרה', roles: ['admin', 'sales'] },
{ id: 'aging', title: '⏳ גיול חובות', desc: 'חובות פתוחים לפי 30/60/90+ ימים', roles: ['admin', 'sales'] },
{ id: 'pnl', title: '💰 רווח והפסד', desc: 'הכנסות מודעות (נטו) פחות הוצאות (נטו) לפי חודש', roles: ['admin'] },
{ id: 'issue', title: '🗞️ דו"ח גיליון', desc: 'שטח פרסום, הכנסה ועמידה בדדליינים', roles: ['admin', 'sales', 'editor'] },
{ id: 'top', title: '🏆 מפרסמים מובילים', desc: 'הלקוחות עם ההכנסה הגבוהה ביותר', roles: ['admin', 'sales'] },
{ id: 'unsold', title: '📭 שטח שלא נמכר', desc: 'עמודים ריקים בכל גיליון — פוטנציאל מכירה', roles: ['admin', 'sales', 'editor'] },
{ id: 'churn', title: '⚠️ לקוחות שהפסיקו', desc: 'מפרסמים שלא חזרו — הזדמנות לחידוש', roles: ['admin', 'sales'] },
{ id: 'customer', title: '🏪 היסטוריית לקוח', desc: 'כל הפרסומים, החיובים והתשלומים', roles: ['admin', 'sales'] },
{ id: 'ledger', title: '📒 כרטסות לרו"ח', desc: 'ייצוא חודשי לאקסל — כל תנועות הלקוחות עם יתרה רצה', roles: ['admin'] },
{ id: 'weekly', title: '🗓️ דוח שבועי תפעולי', desc: 'מה נסגר, מה נכנס ומה תקוע — לשבוע שנבחר', roles: ['admin', 'sales'] },
{ id: 'agencies', title: '🏢 עמלות סוכנויות', desc: 'מחזור חודשי פר סוכנות × אחוז העמלה — תצוגה בלבד', roles: ['admin'] },
].filter(r => r.roles.includes(role));

el.innerHTML = `
<div class="page-head"><h2>דו״חות</h2></div>
<div class="stats">
${reports.map(r => `<div class="stat" style="cursor:pointer" onclick="report_${r.id}()">
<div style="font-weight:700">${r.title}</div>
<div class="lbl">${r.desc}</div></div>`).join('')}
</div>
<div class="card" id="reportArea"><div class="empty">בחר דו"ח למעלה</div></div>`;
}
};

/* עוזר: כותרת דו"ח + כפתורי ייצוא */
function reportShell(title, tableHtml, exportFn) {
document.getElementById('reportArea').innerHTML = `
<div class="card-pad">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<b style="font-size:1.05rem">${title}</b>
<span>
<button class="btn btn-sm btn-ghost" onclick="${exportFn}">⬇ אקסל</button>
<button class="btn btn-sm btn-ghost" onclick="printArea('${title}', document.getElementById('repTable').innerHTML)">🖨 PDF</button>
</span>
</div>
<div id="repTable" class="table-wrap" style="margin-top:12px">${tableHtml}</div>
</div>`;
}

let _repData = []; // הנתונים של הדו"ח האחרון — לייצוא

/* ---------- הכנסות: 6 חודשים אחרונים ---------- */
async function report_revenue() {
const since = new Date(); since.setMonth(since.getMonth() - 6);
const [charges, payments] = await Promise.all([
run(db.from('charges').select('amount,issued_date,agent_id,status').gte('issued_date', since.toISOString().slice(0, 10))),
run(db.from('payments').select('amount,paid_date').gte('paid_date', since.toISOString().slice(0, 10))),
]);
const months = {};
charges.filter(c => !['cancelled'].includes(c.status)).forEach(c => {
const m = c.issued_date.slice(0, 7);
months[m] = months[m] || { billed: 0, collected: 0 };
months[m].billed += Number(c.amount);
});
payments.forEach(p => {
const m = p.paid_date.slice(0, 7);
months[m] = months[m] || { billed: 0, collected: 0 };
months[m].collected += Number(p.amount);
});
const rows = Object.entries(months).sort((a, b) => b[0].localeCompare(a[0]));
_repData = rows.map(([m, v]) => [m, v.billed, v.collected]);
reportShell('הכנסות — 6 חודשים', `
<table class="data"><thead><tr><th>חודש</th><th>נמכר (חויב)</th><th>נגבה בפועל</th><th>פער</th></tr></thead><tbody>
${rows.map(([m, v]) => `<tr><td>${m}</td><td>${money(v.billed)}</td><td>${money(v.collected)}</td>
<td style="color:${v.billed - v.collected > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(v.billed - v.collected)}</td></tr>`).join('')}
</tbody></table>`,
`exportCsv('הכנסות', ['חודש','נמכר','נגבה'], _repData)`);
}

/* ---------- עסקאות שנסגרו: לפי חודש-סגירה (צמיחה ותזרים) ---------- */
async function report_deals() {
const contracts = await run(db.from('contracts').select('closed_date,total_price,customer_id,agent_id').not('closed_date', 'is', null));
const months = {};
(contracts || []).forEach(c => {
const m = String(c.closed_date).slice(0, 7);
months[m] = months[m] || { count: 0, sum: 0 };
months[m].count += 1;
months[m].sum += Number(c.total_price) || 0;
});
const rows = Object.entries(months).sort((a, b) => b[0].localeCompare(a[0])); // חדש→ישן לתצוגה
const chron = [...rows].sort((a, b) => a[0].localeCompare(b[0]));
const prevSum = {}; for (let i = 0; i < chron.length; i++) prevSum[chron[i][0]] = i > 0 ? chron[i - 1][1].sum : null;
const maxSum = Math.max(1, ...chron.map(([, v]) => v.sum));
const byAgent = {};
(contracts || []).forEach(c => { const a = c.agent_id || 0; byAgent[a] = byAgent[a] || { count: 0, sum: 0 }; byAgent[a].count += 1; byAgent[a].sum += Number(c.total_price) || 0; });
const agentRows = Object.entries(byAgent).sort((a, b) => b[1].sum - a[1].sum);
const chart = chron.length ? `<div style="display:flex;align-items:flex-end;gap:6px;height:170px;margin:6px 0 18px;padding:8px 4px;border-bottom:2px solid var(--line,#e5e7eb)">
${chron.map(([m, v]) => { const h = Math.round(v.sum / maxSum * 130); return `<div style="flex:1;min-width:34px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end" title="${m}: ${v.count} עסקאות · ${money(v.sum)}">
<div style="font-size:.66rem;font-weight:700;color:#20306a;white-space:nowrap">${money(v.sum)}</div>
<div style="width:66%;min-height:2px;height:${h}px;background:@@COLOR_BRAND@@;border-radius:4px 4px 0 0;margin-top:3px"></div>
<div style="font-size:.66rem;color:#666;margin-top:4px">${m.slice(5, 7)}/${m.slice(2, 4)}</div></div>`; }).join('')}
</div>` : '';
_repData = rows.map(([m, v]) => [m, v.count, Math.round(v.sum), v.count ? Math.round(v.sum / v.count) : 0]);
const totalDeals = (contracts || []).length;
const totalSum = (contracts || []).reduce((s, c) => s + (Number(c.total_price) || 0), 0);
reportShell(`עסקאות שנסגרו — ${totalDeals} עסקאות · ${money(totalSum)} סה"כ`, `
${chart}
<table class="data"><thead><tr><th>חודש</th><th>עסקאות</th><th>סה"כ ₪</th><th>ממוצע לעסקה</th><th>צמיחה (₪ מול חודש קודם)</th></tr></thead><tbody>
${rows.map(([m, v]) => { const pv = prevSum[m]; const g = (pv == null || pv === 0) ? null : Math.round((v.sum - pv) / pv * 100); return `<tr><td>${m}</td><td><b>${v.count}</b></td><td>${money(v.sum)}</td><td>${money(v.count ? v.sum / v.count : 0)}</td><td style="color:${g == null ? '#8a93ad' : g >= 0 ? 'var(--ok)' : 'var(--danger)'}">${g == null ? '—' : (g >= 0 ? '▲ +' : '▼ ') + g + '%'}</td></tr>`; }).join('')}
</tbody></table>
${agentRows.length ? `<br><b style="font-size:.95rem">לפי סוכן:</b>
<table class="data" style="margin-top:6px"><thead><tr><th>סוכן</th><th>עסקאות</th><th>סה"כ ₪</th></tr></thead><tbody>
${agentRows.map(([a, v]) => `<tr><td>${esc(Number(a) ? (nameOf('agents', Number(a)) || '—') : 'ללא סוכן')}</td><td><b>${v.count}</b></td><td>${money(v.sum)}</td></tr>`).join('')}
</tbody></table>` : ''}
${!rows.length ? '<p class="empty" style="margin-top:8px">אין עדיין עסקאות עם תאריך סגירה. מלא/י "תאריך סגירת עסקה" בחוזים כדי לראות כאן צמיחה חודשית.</p>' : ''}`,
`exportCsv('עסקאות_שנסגרו', ['חודש','עסקאות','סה"כ','ממוצע'], _repData)`);
}

/* ---------- משפך מכירות ---------- */
async function report_funnel() {
const leads = await run(db.from('leads').select('status,source,agent_id,created_at'));
const stages = ['new', 'contacted', 'meeting', 'proposal', 'won', 'lost'];
const byStage = stages.map(s => [STATUS.lead[s][0], leads.filter(l => l.status === s).length]);
const bySource = {};
leads.forEach(l => { const s = l.source || 'לא ידוע'; bySource[s] = (bySource[s] || 0) + 1; });
const won = leads.filter(l => l.status === 'won').length;
const conv = leads.length ? Math.round(won / leads.length * 100) : 0;
_repData = byStage;
reportShell(`משפך מכירות — המרה כוללת ${conv}%`, `
<table class="data"><thead><tr><th>שלב</th><th>לידים</th></tr></thead><tbody>
${byStage.map(([s, n]) => `<tr><td>${s}</td><td>${n}</td></tr>`).join('')}
</tbody></table>
<br><b style="font-size:.9rem">לפי מקור:</b>
<table class="data"><thead><tr><th>מקור</th><th>לידים</th></tr></thead><tbody>
${Object.entries(bySource).map(([s, n]) => `<tr><td>${esc(s)}</td><td>${n}</td></tr>`).join('')}
</tbody></table>`,
`exportCsv('משפך_מכירות', ['שלב','לידים'], _repData)`);
}

/* ---------- גיול חובות — פר לקוח, יתרות אמת (פיצ'ר #9) ---------- */
// יתרה פר חיוב = סכום פחות תשלומים (תשלום חלקי לא נספר כחוב).
// כל לקוח בשורה: היתרה מפוצלת לחלונות זמן לפי ימי האיחור, ממוין
// מהחוב הגבוה לנמוך. סוכן מכירות רואה רק את הלקוחות שלו.
const AGING_BUCKETS = ['שוטף', '1-30 יום', '31-60 יום', '61-90 יום', 'מעל 90 יום'];

async function report_aging() {
const charges = await run(db.from('charges').select('id,customer_id,amount,status,due_date').in('status', ['pending', 'invoiced', 'partial', 'overdue']));
const ids = charges.map(c => c.id);
const paid = {};
if (ids.length) {
try {
const pays = await run(db.from('payments').select('charge_id,amount').in('charge_id', ids));
pays.forEach(p => paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount || 0));
} catch (e) { }
}
// סוכן רואה רק את הלקוחות שלו (בנוסף ל-RLS בצד השרת)
const mine = (typeof myAgentId === 'function') ? myAgentId() : null;
const custAgent = {}; (cache.customers || []).forEach(c => custAgent[c.id] = c.agent_id);
const now = new Date();
const byCust = {};
charges.forEach(c => {
if (profile.role === 'sales' && custAgent[c.customer_id] !== mine) return;
const bal = Number(c.amount || 0) - (paid[c.id] || 0);
if (bal <= 0.005) return;
const days = c.due_date ? Math.floor((now - new Date(c.due_date)) / 86400000) : 0;
const bi = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
const row = byCust[c.customer_id] = byCust[c.customer_id] || { buckets: [0, 0, 0, 0, 0], total: 0, oldest: 0 };
row.buckets[bi] += bal; row.total += bal;
if (days > row.oldest) row.oldest = days;
});
const rows = Object.entries(byCust)
.map(([cid, v]) => ({ cid: Number(cid), name: nameOf('customers', Number(cid)) || ('לקוח #' + cid), ...v }))
.sort((a, b) => b.total - a.total);
const colSum = [0, 0, 0, 0, 0]; let grand = 0;
rows.forEach(r => { r.buckets.forEach((v, i) => colSum[i] += v); grand += r.total; });
_repData = rows.map(r => [r.name, ...r.buckets.map(v => Math.round(v * 100) / 100), Math.round(r.total * 100) / 100, r.oldest]);
const fmt = v => v > 0.005 ? money(v) : '—';
reportShell(`גיול חובות — ${rows.length} לקוחות · ${money(grand) || '₪0'} סה"כ`, `
<p class="muted" style="font-size:.8rem;margin-bottom:8px">יתרה אמיתית (אחרי תשלומים חלקיים), מפוצלת לפי ימי איחור מתאריך היעד. ממוין מהחוב הגבוה לנמוך.</p>
<table class="data"><thead><tr><th>לקוח</th>${AGING_BUCKETS.map(b => `<th>${b}</th>`).join('')}<th>סה"כ</th><th>ותק מרבי</th><th></th></tr></thead><tbody>
${rows.map(r => `<tr>
<td><b>${esc(r.name)}</b></td>
${r.buckets.map((v, i) => `<td style="${i >= 3 && v > 0.005 ? 'color:var(--danger);font-weight:600' : ''}">${fmt(v)}</td>`).join('')}
<td><b>${money(r.total)}</b></td>
<td>${r.oldest > 0 ? r.oldest + ' ימים' : '—'}</td>
<td style="white-space:nowrap">${typeof collReminderBtn === 'function' ? collReminderBtn(r.cid, r.total) : ''} <button class="btn btn-sm btn-ghost" onclick="customerStatement(${r.cid})">📄</button></td>
</tr>`).join('') || `<tr><td colspan="${AGING_BUCKETS.length + 4}">אין חובות פתוחים 🎉</td></tr>`}
</tbody>
${rows.length ? `<tfoot><tr style="border-top:2px solid var(--line)"><td><b>סה"כ</b></td>${colSum.map(v => `<td><b>${fmt(v)}</b></td>`).join('')}<td><b>${money(grand)}</b></td><td></td><td></td></tr></tfoot>` : ''}
</table>`,
`exportCsv('גיול_חובות', ['לקוח',${AGING_BUCKETS.map(b => `'${b}'`).join(',')},'סה"כ','ותק_מרבי_ימים'], _repData)`);
}

/* ---------- דו"ח גיליון ---------- */
async function report_issue() {
const issues = await run(db.from('issues').select('*').order('issue_number', { ascending: false }).limit(12));
const ads = await run(db.from('ads').select('issue_id,price,discount,status').not('issue_id', 'is', null));
_repData = issues.map(i => {
const iAds = ads.filter(a => a.issue_id === i.id && !['cancelled', 'rejected'].includes(a.status));
const rev = iAds.reduce((s, a) => s + Number(a.price) - Number(a.discount), 0);
return [i.issue_number, heDate(i.publish_date), iAds.length, rev, STATUS.issue[i.status][0]];
});
reportShell('דו"ח גיליונות — 12 אחרונים', `
<table class="data"><thead><tr><th>גיליון</th><th>תאריך</th><th>מודעות</th><th>הכנסה</th><th>סטטוס</th></tr></thead><tbody>
${_repData.map(r => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td>${r[2]}</td><td>${money(r[3])}</td><td>${r[4]}</td></tr>`).join('')}
</tbody></table>`,
`exportCsv('גיליונות', ['גיליון','תאריך','מודעות','הכנסה','סטטוס'], _repData)`);
}

/* ---------- היסטוריית לקוח ---------- */
async function report_customer() {
document.getElementById('reportArea').innerHTML = `
<div class="card-pad">
<b>היסטוריית לקוח</b>
<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:flex-start">
<div style="min-width:240px">${custPickerHtml({ base: 'repCust', allowNew: false, placeholder: 'הקלד שם לקוח לחיפוש…' })}</div>
<button class="btn btn-sm" onclick="reportCustomerRun()">הצגה</button>
</div>
<div id="repTable" class="table-wrap" style="margin-top:14px"></div>
</div>`;
}

async function reportCustomerRun() {
const id = Number(document.getElementById('repCust').value);
if (!id) { toast('בחר לקוח מהחיפוש', true); return; }
const [ads, charges, payments] = await Promise.all([
run(db.from('ads').select('*').eq('customer_id', id).order('created_at', { ascending: false })),
run(db.from('charges').select('*').eq('customer_id', id).order('issued_date', { ascending: false })),
run(db.from('payments').select('*').eq('customer_id', id).order('paid_date', { ascending: false })),
]);
const billed = charges.filter(c => !['cancelled', 'lost'].includes(c.status)).reduce((s, c) => s + Number(c.amount), 0);
const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
document.getElementById('repTable').innerHTML = `
<div class="stats">
${stat(ads.filter(a => a.status === 'published').length, 'מודעות שפורסמו')}
${stat(money(billed) || '₪0', 'סה"כ חויב')}
${stat(money(paid) || '₪0', 'סה"כ שולם')}
${stat(money(billed - paid) || '₪0', 'יתרה', billed - paid > 0 ? 'red' : '')}
</div>
<table class="data"><thead><tr><th>תאריך</th><th>מודעה</th><th>גיליון</th><th>סכום</th><th>סטטוס</th></tr></thead><tbody>
${ads.map(a => `<tr><td>${heDate(a.created_at)}</td><td>${esc(a.title)}</td>
<td>${esc(nameOf('issues', a.issue_id, 'issue'))}</td><td>${money(a.price - a.discount)}</td><td>${pill('ad', a.status)}</td></tr>`).join('')
|| '<tr><td colspan="5">אין מודעות</td></tr>'}
</tbody></table>`;
}


/* ---------- מפרסמים מובילים ---------- */
async function report_top() {
  const ads = await run(db.from('ads').select('customer_id,price,discount,status,issue_id').not('status', 'in', '("cancelled","rejected")'));
  const by = {};
  ads.forEach(a => {
    const rev = (Number(a.price) || 0) - (Number(a.discount) || 0);
    const b = by[a.customer_id] = by[a.customer_id] || { rev: 0, count: 0, issues: new Set() };
    b.rev += rev; b.count++; if (a.issue_id) b.issues.add(a.issue_id);
  });
  const rows = Object.entries(by)
    .map(([cid, v]) => [nameOf('customers', Number(cid)), v.count, v.issues.size, v.rev])
    .sort((a, b) => b[3] - a[3]).slice(0, 30);
  _repData = rows;
  reportShell('מפרסמים מובילים', `
    <table class="data"><thead><tr><th>לקוח</th><th>מודעות</th><th>גיליונות</th><th>סה"כ הכנסה</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r[0])}</b></td><td>${r[1]}</td><td>${r[2]}</td><td><b>${money(r[3])}</b></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">אין עדיין נתוני מודעות — יתמלא כשתזין מודעות לגיליונות</td></tr>'}
    </tbody></table>`,
    `exportCsv('מפרסמים_מובילים', ['לקוח','מודעות','גיליונות','הכנסה'], _repData)`);
}

/* ---------- שטח שלא נמכר (עמודים ריקים לפי גיליון) ---------- */
async function report_unsold() {
  const issues = await run(db.from('issues').select('*').order('issue_number', { ascending: false }).limit(12));
  const ids = issues.map(i => i.id);
  const [ads, articles] = await Promise.all([
    run(db.from('ads').select('issue_id,page_number,status').in('issue_id', ids)),
    run(db.from('articles').select('issue_id,page_number').in('issue_id', ids)),
  ]);
  _repData = issues.map(i => {
    const pages = new Set();
    ads.filter(a => a.issue_id === i.id && a.page_number && !['cancelled', 'rejected'].includes(a.status)).forEach(a => pages.add(a.page_number));
    articles.filter(a => a.issue_id === i.id && a.page_number).forEach(a => pages.add(a.page_number));
    const total = i.pages_count || 0, filled = pages.size, unsold = Math.max(0, total - filled);
    return [i.issue_number, total, filled, unsold, (total ? Math.round(unsold / total * 100) : 0) + '%'];
  });
  reportShell('שטח שלא נמכר — עמודים ריקים לפי גיליון', `
    <table class="data"><thead><tr><th>גיליון</th><th>עמודים</th><th>מאוישים</th><th>ריקים</th><th>% ריק</th></tr></thead><tbody>
    ${_repData.map(r => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td>${r[2]}</td>
      <td style="color:${r[3] > 0 ? 'var(--warn)' : 'var(--ok)'}"><b>${r[3]}</b></td><td>${r[4]}</td></tr>`).join('')}
    </tbody></table>`,
    `exportCsv('שטח_לא_נמכר', ['גיליון','עמודים','מאוישים','ריקים','אחוז_ריק'], _repData)`);
}

/* ---------- לקוחות שהפסיקו לפרסם (churn) ---------- */
async function report_churn() {
  const issues = await run(db.from('issues').select('id,issue_number'));
  const issNum = {}; issues.forEach(i => issNum[i.id] = i.issue_number);
  const maxIssue = issues.length ? Math.max(...issues.map(i => i.issue_number || 0)) : 0;
  const ads = await run(db.from('ads').select('customer_id,issue_id,status').not('status', 'in', '("cancelled","rejected")'));
  const last = {};
  ads.forEach(a => { const n = issNum[a.issue_id] || 0; if (!last[a.customer_id] || n > last[a.customer_id]) last[a.customer_id] = n; });
  const GAP = 3;
  const rows = Object.entries(last)
    .map(([cid, n]) => [nameOf('customers', Number(cid)), n, maxIssue - n])
    .filter(r => r[2] >= GAP).sort((a, b) => b[2] - a[2]);
  _repData = rows;
  reportShell('לקוחות שהפסיקו לפרסם (' + GAP + '+ גיליונות)', `
    <p class="muted" style="font-size:.82rem;margin-bottom:8px">מפרסמים שלא חזרו — הזדמנות ליצור קשר ולחדש</p>
    <table class="data"><thead><tr><th>לקוח</th><th>גיליון אחרון</th><th>גיליונות מאז</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><b>${esc(r[0])}</b></td><td>גיליון ${r[1]}</td><td style="color:var(--warn)"><b>${r[2]}</b></td></tr>`).join('')
      || '<tr><td colspan="3" class="empty">אין — כולם פעילים 🎉 (או שעדיין אין היסטוריית מודעות)</td></tr>'}
    </tbody></table>`,
    `exportCsv('churn', ['לקוח','גיליון_אחרון','גיליונות_מאז'], _repData)`);
}


/* ---------- רווח והפסד: 12 חודשים ---------- */
async function report_pnl() {
  const since = new Date(); since.setMonth(since.getMonth() - 11); since.setDate(1);
  const sinceM = since.toISOString().slice(0, 7);
  const [ads, issues, expenses] = await Promise.all([
    run(db.from('ads').select('issue_id,price,discount,status').limit(8000)),
    run(db.from('issues').select('id,publish_date,print_date').limit(2000)),
    run(db.from('expenses').select('notes,amount,expense_date').gte('expense_date', sinceM + '-01').limit(4000)),
  ]);
  // חודש הגיליון = חודש הסגירה לדפוס (print_date), כמו העלויות — כדי שהכנסות ועלויות של אותו גיליון ייפלו באותו חודש
  const issMonth = {}; issues.forEach(i => { issMonth[i.id] = String(i.print_date || i.publish_date || '').slice(0, 7); });
  const rev = {}, exp = {};
  ads.forEach(a => {
    if (['cancelled', 'rejected'].includes(a.status)) return;
    const m = issMonth[a.issue_id]; if (!m || m < sinceM) return;
    rev[m] = (rev[m] || 0) + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
  });
  expenses.forEach(e => {
    const m = String(e.expense_date || '').slice(0, 7); if (m < sinceM) return;
    const mn = String(e.notes || '').match(/#net:([0-9.]+)/);
    const net = mn ? Number(mn[1]) : Number(e.amount || 0);
    exp[m] = (exp[m] || 0) + net;
  });
  const months = [...new Set([...Object.keys(rev), ...Object.keys(exp)])].sort().reverse();
  _repData = months.map(m => [m, Math.round(rev[m] || 0), Math.round(exp[m] || 0), Math.round((rev[m] || 0) - (exp[m] || 0))]);
  const tR = _repData.reduce((s, r) => s + r[1], 0), tE = _repData.reduce((s, r) => s + r[2], 0), tP = tR - tE;
  reportShell('רווח והפסד — 12 חודשים (נטו, ללא מע"מ)', `
    <table class="data"><thead><tr><th>חודש</th><th>הכנסות מודעות</th><th>הוצאות</th><th>רווח / הפסד</th></tr></thead><tbody>
    ${_repData.map(r => `<tr><td><b>${r[0]}</b></td><td style="color:var(--ok)">${money(r[1])}</td>
      <td style="color:var(--danger)">${money(r[2])}</td>
      <td><b style="color:${r[3] >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(r[3])}</b></td></tr>`).join('')}
    </tbody>
    <tfoot><tr style="border-top:2px solid var(--line)"><td><b>סה"כ</b></td>
      <td><b>${money(tR)}</b></td><td><b>${money(tE)}</b></td>
      <td><b style="color:${tP >= 0 ? 'var(--ok)' : 'var(--danger)'}">${money(tP)}</b></td></tr></tfoot>
    </table>
    <p class="muted" style="font-size:.78rem;margin-top:8px">הכנסות = שווי המודעות (נטו) לפי חודש הסגירה לדפוס של הגיליון · הוצאות = עלויות נטו שהוזנו (כולל עלויות הגיליון). מספרים ללא מע"מ.</p>`,
    `exportCsv('רווח_והפסד', ['חודש','הכנסות','הוצאות','רווח'], _repData)`);
}

/* ---------- כרטסות לרו"ח: ייצוא חודשי של כל התנועות (פיצ'ר #4) ---------- */
// קריאה בלבד: charges + payments. לכל לקוח — יתרת פתיחה, תנועות התקופה
// (חובה/זכות) ויתרה רצה. יוצא כקובץ Excel (גיליון RTL) דרך SheetJS הטעון.
function report_ledger() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const defMonth = d.toISOString().slice(0, 7);
  document.getElementById('reportArea').innerHTML = `
<div class="card-pad">
<b>📒 כרטסות לרו"ח — ייצוא חודשי</b>
<p class="muted" style="font-size:.82rem;margin-top:4px">כל תנועות החיובים והתשלומים של כל הלקוחות בטווח שנבחר, עם יתרת פתיחה ויתרה רצה פר לקוח. קריאה בלבד — שום דבר לא משתנה במערכת.</p>
<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:end">
<div class="field" style="margin:0"><label style="font-size:.8rem">חודש</label><input id="ledMonth" type="month" value="${defMonth}"></div>
<span class="muted" style="font-size:.8rem">או טווח:</span>
<div class="field" style="margin:0"><label style="font-size:.8rem">מתאריך</label><input id="ledFrom" type="date"></div>
<div class="field" style="margin:0"><label style="font-size:.8rem">עד תאריך</label><input id="ledTo" type="date"></div>
<button class="btn btn-sm" onclick="reportLedgerRun()">הצגה</button>
<button class="btn btn-sm btn-ghost" onclick="reportLedgerExport()">⬇ ייצוא לאקסל</button>
</div>
<div id="repTable" class="table-wrap" style="margin-top:14px"><div class="empty">בחר חודש (או טווח) ולחץ הצגה / ייצוא</div></div>
</div>`;
}

function _ledRange() {
  const from = document.getElementById('ledFrom')?.value;
  const to = document.getElementById('ledTo')?.value;
  if (from && to) return { from, to };
  const m = document.getElementById('ledMonth')?.value;
  if (!m) return null;
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(y, mo, 0).getDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` };
}

// אוסף את כל התנועות עד סוף הטווח ומפצל ליתרת פתיחה + תנועות התקופה
async function _ledGather() {
  const range = _ledRange();
  if (!range) { toast('בחר חודש או טווח תאריכים', true); return null; }
  const [charges, payments] = await Promise.all([
    run(db.from('charges').select('id,customer_id,amount,status,issued_date,description,invoice_number').lte('issued_date', range.to).limit(20000)),
    run(db.from('payments').select('id,customer_id,charge_id,amount,method,paid_date,check_due_date').lte('paid_date', range.to).limit(20000)),
  ]);
  const dead = c => ['cancelled', 'lost'].includes(c.status);
  const chargeCust = {}; charges.forEach(c => chargeCust[c.id] = c.customer_id);
  const byCust = {};
  const ent = (cid, e) => { (byCust[cid] = byCust[cid] || []).push(e); };
  charges.forEach(c => {
    if (dead(c)) return;
    ent(c.customer_id, { date: c.issued_date || '', kind: 'חיוב', desc: c.description || 'חיוב', ref: c.invoice_number || '', debit: Number(c.amount || 0), credit: 0 });
  });
  payments.forEach(p => {
    const cid = p.customer_id || chargeCust[p.charge_id];
    if (!cid) return;
    const method = (typeof PAY_METHODS !== 'undefined' && PAY_METHODS[p.method]) ? PAY_METHODS[p.method] : (p.method || '');
    ent(cid, { date: p.paid_date || '', kind: 'תשלום', desc: 'תשלום (' + method + ')' + (p.check_due_date ? ' · פירעון ' + heDate(p.check_due_date) : ''), ref: '', debit: 0, credit: Number(p.amount || 0) });
  });

  const custs = Object.keys(byCust)
    .map(cid => ({ cid: Number(cid), name: nameOf('customers', Number(cid)) || ('לקוח #' + cid) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const out = [];
  custs.forEach(cu => {
    const list = byCust[cu.cid].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.kind === 'חיוב' ? -1 : 1));
    let opening = 0; const period = [];
    list.forEach(e => {
      if (e.date < range.from) opening += e.debit - e.credit;
      else period.push(e);
    });
    if (!period.length && Math.abs(opening) < 0.005) return; // אין פעילות ואין יתרה — לא מייצאים
    let bal = opening;
    const rows = period.map(e => { bal += e.debit - e.credit; return { ...e, balance: bal }; });
    out.push({ ...cu, opening, rows, closing: bal });
  });
  return { range, custs: out };
}

async function reportLedgerRun() {
  toast('אוסף תנועות...');
  const data = await _ledGather(); if (!data) return;
  const totC = data.custs.reduce((s, c) => s + c.rows.reduce((x, r) => x + r.debit, 0), 0);
  const totP = data.custs.reduce((s, c) => s + c.rows.reduce((x, r) => x + r.credit, 0), 0);
  document.getElementById('repTable').innerHTML = `
<div class="stats" style="margin-bottom:10px">
${stat(data.custs.length, 'לקוחות עם פעילות/יתרה')}
${stat(money(totC) || '₪0', 'חיובים בתקופה')}
${stat(money(totP) || '₪0', 'תשלומים בתקופה')}
</div>
${data.custs.map(cu => `
<div style="margin-bottom:14px">
<b>${esc(cu.name)}</b> <span class="muted" style="font-size:.8rem">יתרת פתיחה: ${money(cu.opening) || '₪0'} · יתרת סגירה: <b style="color:${cu.closing > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(cu.closing) || '₪0'}</b></span>
${cu.rows.length ? `<table class="data" style="margin-top:4px"><thead><tr><th>תאריך</th><th>סוג</th><th>פירוט</th><th>חשבונית</th><th>חובה</th><th>זכות</th><th>יתרה</th></tr></thead><tbody>
${cu.rows.map(r => `<tr><td>${heDate(r.date)}</td><td>${r.kind}</td><td>${esc(r.desc)}</td><td>${esc(r.ref || '—')}</td><td>${r.debit ? money(r.debit) : '—'}</td><td>${r.credit ? money(r.credit) : '—'}</td><td><b>${money(r.balance)}</b></td></tr>`).join('')}
</tbody></table>` : '<div class="muted" style="font-size:.8rem">אין תנועות בתקופה (יתרה קודמת בלבד)</div>'}
</div>`).join('') || '<div class="empty">אין תנועות ואין יתרות בטווח שנבחר</div>'}`;
}

async function reportLedgerExport() {
  toast('מכין קובץ לרו"ח...');
  const data = await _ledGather(); if (!data) return;
  if (!data.custs.length) { toast('אין תנועות ואין יתרות בטווח שנבחר', true); return; }
  const headers = ['לקוח', 'תאריך', 'סוג', 'פירוט', 'מס\' חשבונית', 'חובה', 'זכות', 'יתרה'];
  const aoa = [headers];
  data.custs.forEach(cu => {
    aoa.push([cu.name, data.range.from, 'יתרת פתיחה', '', '', '', '', round2(cu.opening)]);
    cu.rows.forEach(r => aoa.push([cu.name, r.date, r.kind, r.desc, r.ref || '', r.debit ? round2(r.debit) : '', r.credit ? round2(r.credit) : '', round2(r.balance)]));
    aoa.push([cu.name, data.range.to, 'יתרת סגירה', '', '', '', '', round2(cu.closing)]);
  });
  const fname = `כרטסות_${data.range.from}_${data.range.to}`;
  try {
    if (typeof XLSX === 'undefined') throw new Error('no-xlsx');
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 11 }, { wch: 11 }, { wch: 40 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 11 }];
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, 'כרטסות');
    XLSX.writeFile(wb, fname + '.xlsx');
  } catch (e) {
    // נפילה חזרה ל-CSV אם ספריית האקסל לא נטענה
    exportCsv(fname, headers, aoa.slice(1));
  }
  toast('✓ הקובץ ירד — מוכן לשליחה לרו"ח');
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

/* ---------- דוח שבועי תפעולי (פיצ'ר #10) ---------- */
// נשען על weeklySummaryBuild (הסיכום השבועי, #22) עם טווח לבחירה.
// נסגר/נכנס נמדדים בטווח; "מה תקוע" ו"חובות" הם תמונת-מצב נוכחית.
function report_weekly() {
  const to = today();
  const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  document.getElementById('reportArea').innerHTML = `
<div class="card-pad">
<b>🗓️ דוח שבועי תפעולי</b>
<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:end">
<div class="field" style="margin:0"><label style="font-size:.8rem">מתאריך</label><input id="rwFrom" type="date" value="${from}"></div>
<div class="field" style="margin:0"><label style="font-size:.8rem">עד תאריך</label><input id="rwTo" type="date" value="${to}"></div>
<button class="btn btn-sm" onclick="reportWeeklyRun()">הצגה</button>
<button class="btn btn-sm btn-ghost" onclick="reportWeeklyRun(-7)">◀ שבוע אחורה</button>
</div>
<div id="repTable" class="table-wrap" style="margin-top:14px"><div class="empty">בחר טווח ולחץ הצגה</div></div>
</div>`;
  reportWeeklyRun();
}

async function reportWeeklyRun(shiftDays) {
  const fEl = document.getElementById('rwFrom'), tEl = document.getElementById('rwTo');
  if (shiftDays) {
    const sh = d => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + shiftDays); return x.toISOString().slice(0, 10); };
    fEl.value = sh(fEl.value); tEl.value = sh(tEl.value);
  }
  const from = fEl.value, to = tEl.value;
  if (!from || !to || from > to) { toast('טווח תאריכים לא תקין', true); return; }
  if (typeof weeklySummaryBuild !== 'function') { toast('מודול הסיכום השבועי לא נטען', true); return; }
  document.getElementById('repTable').innerHTML = '<div class="empty">אוסף נתונים...</div>';
  const m = await weeklySummaryBuild(from, to);
  _repData = [
    ['מודעות שנסגרו', m.closed ? m.closed.count : '', m.closed ? Math.round(m.closed.total) : ''],
    ['לידים חדשים', m.leads ? m.leads.count : '', ''],
    ['מודעות תקועות (כעת)', m.stuck ? m.stuck.adsCount : '', m.stuck ? Math.round(m.stuck.adsSum) : ''],
    ['לידים ממתינים למעקב (כעת)', m.stuck ? m.stuck.leadsDue : '', ''],
    ['חוב פתוח (כעת)', m.debts ? m.debts.debtors : '', m.debts ? Math.round(m.debts.total) : ''],
  ];
  document.getElementById('repTable').innerHTML = `
<div class="stats" style="margin-bottom:10px">
${stat(m.closed ? m.closed.count : '—', 'מודעות נסגרו (' + heDate(from) + '–' + heDate(to) + ')')}
${stat(m.closed ? (money(m.closed.total) || '₪0') : '—', '₪ שנסגרו בטווח')}
${stat(m.leads ? m.leads.count : '—', 'לידים חדשים בטווח')}
${stat(m.stuck ? m.stuck.adsCount : '—', 'מודעות תקועות כעת', m.stuck && m.stuck.adsCount ? 'red' : '')}
</div>
${m.leads && m.leads.names.length ? `<p style="font-size:.85rem"><b>לידים שנכנסו:</b> ${m.leads.names.map(esc).join(', ')}${m.leads.count > m.leads.names.length ? ' ועוד ' + (m.leads.count - m.leads.names.length) : ''}</p>` : ''}
${m.stuck ? `<p style="font-size:.85rem"><b>מה תקוע כעת:</b> ${m.stuck.adsCount} מודעות בלי סגירה בסך ${money(m.stuck.adsSum) || '₪0'}${m.stuck.leadsDue ? ' · ' + m.stuck.leadsDue + ' לידים ממתינים למעקב' : ''}</p>` : ''}
${m.debts ? `<p style="font-size:.85rem"><b>חובות כעת:</b> ${money(m.debts.total) || '₪0'} אצל ${m.debts.debtors} לקוחות${m.debts.tops.length ? ' — הגדולים: ' + m.debts.tops.slice(0, 3).map(t => esc(t.name) + ' (' + money(t.bal) + ')').join(', ') : ''}</p>` : ''}
<div style="display:flex;gap:8px;margin-top:8px">
<button class="btn btn-sm btn-ghost" onclick="exportCsv('דוח_שבועי_${from}_${to}', ['מדד','כמות','₪'], _repData)">⬇ אקסל</button>
</div>`;
}

/* ---------- עמלות סוכנויות (פיצ'ר #7) — חישוב תצוגה בלבד ---------- */
// מחזור החיובים החודשי של לקוחות כל סוכנות × אחוז העמלה שלה.
// שום תשלום עמלה לא מבוצע מכאן — מספרים להצגה ולהתחשבנות ידנית.
async function report_agencies() {
  const agencies = cache.agencies || [];
  if (!agencies.length) {
    document.getElementById('reportArea').innerHTML = '<div class="card-pad"><p class="empty">אין סוכנויות מוגדרות — מוסיפים בהגדרות → "סוכנויות פרסום 🏢"</p></div>';
    return;
  }
  const ym = new Date().toISOString().slice(0, 7);
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const prevYm = d.toISOString().slice(0, 7);
  const charges = await run(db.from('charges').select('customer_id,amount,status,issued_date')
    .gte('issued_date', prevYm + '-01').not('status', 'in', '("cancelled","lost")'));
  const custAgency = {}; (cache.customers || []).forEach(c => { if (c.agency_id) custAgency[c.id] = c.agency_id; });
  const sums = {}; // agency_id -> {cur, prev}
  charges.forEach(c => {
    const aid = custAgency[c.customer_id]; if (!aid) return;
    const m = String(c.issued_date || '').slice(0, 7);
    const s = sums[aid] = sums[aid] || { cur: 0, prev: 0 };
    if (m === ym) s.cur += Number(c.amount || 0);
    else if (m === prevYm) s.prev += Number(c.amount || 0);
  });
  _repData = agencies.map(a => {
    const s = sums[a.id] || { cur: 0, prev: 0 };
    const pct = Number(a.commission_pct) || 0;
    const n = (cache.customers || []).filter(c => c.agency_id === a.id).length;
    return [a.name, n, Math.round(s.cur), Math.round(s.cur * pct) / 100, Math.round(s.prev), Math.round(s.prev * pct) / 100, pct];
  }).sort((x, y) => y[2] - x[2]);
  reportShell('עמלות סוכנויות — ' + ym + ' (תצוגה בלבד)', `
<p class="muted" style="font-size:.8rem;margin-bottom:8px">מחזור = חיובים שהופקו ללקוחות הסוכנות בחודש (בלי מבוטלים/אבודים). העמלה מחושבת להצגה — התשלום לסוכנות ידני.</p>
<table class="data"><thead><tr><th>סוכנות</th><th>לקוחות</th><th>מחזור ${ym}</th><th>עמלה ${ym}</th><th>מחזור ${prevYm}</th><th>עמלה ${prevYm}</th><th>%</th></tr></thead><tbody>
${_repData.map(r => `<tr><td><b>${esc(r[0])}</b></td><td>${r[1]}</td><td>${money(r[2])}</td><td><b>${money(r[3])}</b></td><td>${money(r[4])}</td><td>${money(r[5])}</td><td>${r[6]}%</td></tr>`).join('')}
</tbody></table>`,
    `exportCsv('עמלות_סוכנויות', ['סוכנות','לקוחות','מחזור_נוכחי','עמלה_נוכחית','מחזור_קודם','עמלה_קודמת','אחוז'], _repData)`);
}
