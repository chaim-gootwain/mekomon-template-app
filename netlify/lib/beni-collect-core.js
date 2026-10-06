// netlify/lib/beni-collect-core.js
// -----------------------------------------------------------------------------
// "בני" — גבייה, מצב צל (שלב 2). בונה את "תוכנית התזכורות" של היום:
//   יתרה פתוחה = חיובים פתוחים פחות תשלומים (כמו customerOpenBalance ב-collections.js)
//   מועד: החיוב הוותיק שעבר את תאריך היעד (לפחות GRACE_DAYS ימים)
//   שלב: לפי יומן debt_reminders מאז אותו מועד — 1 → 2 → 3, מרווח של 7 ימים לפחות;
//        אחרי 3 תזכורות → "לטיפולך" (לא נשלח)
//   מעל סף החוב של המערכת (settings.debt_alert_threshold, ברירת מחדל 1,000) → מסומן 🔴
//        ולא מסומן לשליחה כברירת מחדל — חיים מחליט (כרטיס העובד: חוב גדול = אצל חיים)
// התוכנית נשמרת ב-settings ‏collect_plan_<תאריך>; שום דבר לא נשלח ללקוח בלי אישור חיים.
// -----------------------------------------------------------------------------
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPEN = ["pending", "invoiced", "partial", "overdue"];
const GRACE_DAYS = 3, GAP_DAYS = 7, MAX_REMINDERS = 3;
const PAPER_PHONE = "@@PAPER_PHONE@@";

const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sb(pathq) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { headers: H() });
  if (!r.ok) throw new Error(`supabase ${r.status} ${pathq.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function sbIn(table, select, col, ids, extra = "") { // שאילתת in בחלקים (אורך URL)
  const out = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...await sb(`${table}?select=${select}&${col}=in.(${ids.slice(i, i + 150).join(",")})${extra}`));
  return out;
}
async function getSetting(key) {
  const rows = await sb(`settings?select=value&key=eq.${encodeURIComponent(key)}`);
  return rows.length ? rows[0].value : null;
}
async function saveSetting(key, value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/settings`, { method: "POST",
    headers: { ...H(), "content-type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key, value }) });
  if (!r.ok) throw new Error(`settings ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

const israelToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400e3);
const heDate = d => { const [y, m, dd] = String(d).slice(0, 10).split("-"); return `${dd}/${m}/${y}`; };
const money = n => "₪" + Math.round(n).toLocaleString("he-IL");

function messageFor(stage, c) {
  const first = String(c.name || "").trim();
  const head = `שלום${first ? " " + first : ""},\n\n`;
  const facts = `לפי הרישומים שלנו קיימת יתרה פתוחה של ${money(c.total)} (${c.count === 1 ? "חיוב אחד" : c.count + " חיובים"}, הוותיק מתאריך ${heDate(c.oldestDue)}).`;
  const pay = `\n\nלתשלום באשראי אפשר פשוט להשיב למייל הזה ונשלח קישור מאובטח. אם כבר שילמתם — תודה, ונשמח שתעדכנו כדי שנסדר את הרישום.\nלכל שאלה: ${PAPER_PHONE}.`;
  const sign = "\n\nתודה רבה,\nבני – @@PAPER_NAME@@";
  if (stage === 1) return { subject: "תזכורת ידידותית — יתרה פתוחה ב@@PAPER_NAME@@", body: head + "רצינו להזכיר בעדינות: " + facts + pay + sign };
  if (stage === 2) return { subject: "תזכורת שנייה — יתרה פתוחה ב@@PAPER_NAME@@", body: head + "חוזרים אליכם בעניין התשלום: " + facts + " נשמח להסדרה בימים הקרובים." + pay + sign };
  return { subject: "תזכורת אחרונה — יתרה פתוחה ב@@PAPER_NAME@@", body: head + "זוהי תזכורת שלישית: " + facts + " נבקש להסדיר את התשלום השבוע. אם יש קושי — דברו איתנו ונמצא פתרון." + pay + sign };
}

async function buildPlan() {
  const T = israelToday();
  const charges = await sb(`charges?select=id,customer_id,amount,due_date,status&status=in.(${OPEN.join(",")})&limit=5000`);
  const paid = {};
  if (charges.length) (await sbIn("payments", "charge_id,amount", "charge_id", charges.map(c => c.id)))
    .forEach(p => { paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount || 0); });
  const per = {};
  charges.forEach(c => {
    const bal = Number(c.amount || 0) - (paid[c.id] || 0);
    if (!(bal > 0.5) || !c.customer_id) return;
    const g = per[c.customer_id] || (per[c.customer_id] = { total: 0, count: 0, oldestDue: null });
    g.total += bal; g.count++;
    if (c.due_date && c.due_date < T && (!g.oldestDue || c.due_date < g.oldestDue)) g.oldestDue = c.due_date;
  });
  const due = Object.keys(per).filter(id => per[id].oldestDue && daysBetween(per[id].oldestDue, T) >= GRACE_DAYS);
  if (!due.length) return { date: T, items: [], escalate: [] };

  const [custs, rems, thrRaw] = await Promise.all([
    sbIn("customers", "id,name,email,phone,whatsapp", "id", due),
    sbIn("debt_reminders", "customer_id,created_at", "customer_id", due),
    getSetting("debt_alert_threshold"),
  ]);
  const thr = Number(thrRaw) > 0 ? Number(thrRaw) : 1000;
  const cust = {}; custs.forEach(c => cust[c.id] = c);
  const items = [], escalate = [];
  due.forEach(id => {
    const g = per[id], c = cust[id] || {};
    const since = rems.filter(r => String(r.customer_id) === String(id) && r.created_at.slice(0, 10) >= g.oldestDue);
    const last = since.map(r => r.created_at).sort().pop();
    if (last && daysBetween(last.slice(0, 10), T) < GAP_DAYS) return;            // תזכורת אחרונה פחות משבוע
    const base = { customerId: +id, name: c.name || "", total: Math.round(g.total * 100) / 100, count: g.count,
      oldestDue: g.oldestDue, daysOverdue: daysBetween(g.oldestDue, T), reminders: since.length };
    if (since.length >= MAX_REMINDERS) { escalate.push({ ...base, why: `נשלחו כבר ${since.length} תזכורות` }); return; }
    const stage = since.length + 1, email = String(c.email || "").trim();
    const msg = messageFor(stage, { ...base });
    items.push({ ...base, id: items.length + 1, stage, email, phone: String(c.whatsapp || c.phone || "").replace(/\D/g, ""),
      over: g.total > thr, sendable: !!email, checked: !!email && g.total <= thr, ...msg });
  });
  items.sort((a, b) => b.total - a.total).forEach((it, i) => it.id = i + 1);
  return { date: T, threshold: thr, items, escalate };
}

module.exports = { buildPlan, getSetting, saveSetting, sb, israelToday, heDate, money,
  newToken: () => crypto.randomBytes(18).toString("base64url") };
