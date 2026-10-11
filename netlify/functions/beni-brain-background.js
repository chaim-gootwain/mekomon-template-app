// netlify/functions/beni-brain-background.js
// -----------------------------------------------------------------------------
// "בני" — תשובה חופשית של חיים למייל של בני (כשהיא לא בפורמט הקבוע "1 חדשה" / "שלח 1,3").
// Apps Script (beni/beni-attachments.gs) שולח לכאן את הטקסט, ומושך את התוצאה מ-beni-brain.
//   { id, kind:"attach", text, items:[{n, customer, customerId, subject, candidates:[{letter,title}]}] }
//   { id, kind:"collect", text, date }
// 1. המוח (Supabase edge function beni-brain, Claude) מפרש את הטקסט לרשימת פעולות.
// 2. כאן מבצעים רק פעולות מותרות, ורק על פריטים שקיימים ברשימה:
//    attach  — "חדשה"/"צרף"/"דלג" חוזרות ל-Apps Script כפקודות בפורמט הקבוע (הוא מעלה את הקבצים),
//              "שלח גזיר" מתבצע כאן (beni-clip).
//    collect — שלח / שילם / לא להזכיר, דרך אותו handleReply של התשובות הקבועות.
//    כל השאר (מחירים במערכת, זיכויים, רישום תשלום, שיבוץ) — לא מבוצע; בני כותב לחיים שאת זה הוא לא עושה.
// התוצאה נשמרת ב-settings ‏brain_<id> (רקע — עד 15 דקות; המוח + PDF גדול לא נכנסים ב-10 שניות).
// env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BENI_INSERT_TOKEN
// -----------------------------------------------------------------------------
const { saveSetting, money } = require("../lib/beni-collect-core");
const { sendClip } = require("../lib/beni-clip");
const { findPlan, handleReply } = require("./beni-collect");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.BENI_INSERT_TOKEN;
const LETTERS = "אבגדהוזחטי";
const oneLine = s => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);

async function think(kind, b, items) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/beni-brain`, { method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json" },
    body: JSON.stringify({ kind, text: b.text, quoted: b.quoted, context: { items } }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`המוח לא זמין (${r.status}): ${t.slice(0, 150)}`);
  return JSON.parse(t);
}

const refuseLine = a => `✋ ביקשת: ${oneLine(a.request) || "משהו שאינו ברשימת התפקידים שלי"} — את זה אני לא עושה לבד.`;

async function attach(b, brain) {
  const items = Array.isArray(b.items) ? b.items : [];
  const byN = n => items.find(i => Number(i.n) === Number(n));
  const commands = [], lines = [], resolved = [];
  for (const a of (brain.actions || []).slice(0, 20)) {
    if (a.type === "refuse") { lines.push(refuseLine(a)); continue; }
    const it = byN(a.item);
    if (!it) { lines.push(`• לא הבנתי לאיזה פריט התכוונת${a.item ? ` (${a.item} לא ברשימה)` : ""}`); continue; }
    const note = oneLine(a.note);
    if (a.type === "create_ad") {
      const price = a.price != null && isFinite(a.price) && a.price >= 0 && a.price < 1e6 ? Number(a.price) : null;
      commands.push(`${it.n} חדשה${price != null ? ` במחיר ${price}` : ""}${note ? ` - ${note}` : ""}`);
    } else if (a.type === "attach_option") {
      const k = LETTERS.indexOf(String(a.option || "").trim().charAt(0));
      if (k < 0 || !(it.candidates || [])[k]) { lines.push(`• ${it.customer}: לא הבנתי לאיזו מודעה לצרף`); continue; }
      commands.push(`${it.n}${LETTERS[k]}${note ? ` - ${note}` : ""}`);
    } else if (a.type === "skip") {
      commands.push(`${it.n} דלג`);
    } else if (a.type === "send_clip") {
      try {
        const r = await sendClip(it.customerId);
        if (r.ok) { lines.push(`✅ ${it.customer}: שלחתי לו את גזיר הפרסום מגיליון ${r.issue} (עמ' ${r.pages.join(", ")}) ל-${r.email}`); resolved.push(it.n); }
        else lines.push(`⚠️ ${it.customer}: לא שלחתי גזיר — ${r.error}`);
      } catch (e) { lines.push(`⚠️ ${it.customer}: שליחת הגזיר נכשלה — ${String(e.message || e).slice(0, 150)}`); }
    } else lines.push(`• ${it.customer}: "${a.type}" לא שייך למייל הזה`);
  }
  return { commands, lines, resolved };
}

async function collect(b, brain, plan) {
  const all = plan.items.concat(plan.escalate || []);
  const has = id => all.some(x => x.id === Number(id));
  const commands = [], lines = [], sendIds = [];
  for (const a of (brain.actions || []).slice(0, 50)) {
    if (a.type === "refuse") { lines.push(refuseLine(a)); continue; }
    if (a.type === "send_all") { commands.push({ type: "send", all: true }); continue; }
    if (!has(a.item)) { lines.push(`• לא הבנתי לאיזה חוב התכוונת${a.item ? ` (${a.item} לא ברשימה)` : ""}`); continue; }
    if (a.type === "send") sendIds.push(Number(a.item));
    else if (a.type === "paid" || a.type === "snooze") commands.push({ type: a.type, id: Number(a.item), note: oneLine(a.note) });
    else lines.push(`• ${a.item}: "${a.type}" לא שייך למייל הזה`);
  }
  if (sendIds.length) commands.unshift({ type: "send", ids: sendIds });
  const r = commands.length ? await handleReply({ date: plan.date, commands }) : { lines: [] };
  return { lines: (r.lines || []).concat(lines) };
}

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400 }; }
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(b.id || "")) return { statusCode: 400 };
  const key = `brain_${b.id}`;
  try {
    await saveSetting(key, JSON.stringify({ status: "working", at: new Date().toISOString() }));
    let out;
    if (b.kind === "collect") {
      const plan = await findPlan(b.date);
      if (!plan) out = { lines: ["לא מצאתי תוכנית תזכורות מהימים האחרונים."] };
      else {
        const ctx = plan.items.map(i => ({ item: i.id, name: i.name, total: money(i.total), daysOverdue: i.daysOverdue, reminderNo: i.stage,
          hasEmail: !!i.sendable, overThreshold: !!i.over, alreadyDone: !!i.done }))
          .concat((plan.escalate || []).map(e => ({ item: e.id, name: e.name, total: money(e.total), daysOverdue: e.daysOverdue, escalated: "כבר קיבל 3 תזכורות — לטיפול חיים" })));
        const brain = await think("collect", b, ctx);
        out = { understood: brain.understood, reply: brain.reply, ...(await collect(b, brain, plan)) };
      }
    } else {
      const ctx = (Array.isArray(b.items) ? b.items : []).map(i => ({ item: Number(i.n), customer: i.customer, emailSubject: i.subject,
        candidates: (i.candidates || []).map((c, k) => ({ option: LETTERS[k], title: c.title })) }));
      const brain = await think("attach", b, ctx);
      out = { understood: brain.understood, reply: brain.reply, ...(await attach(b, brain)) };
    }
    await saveSetting(key, JSON.stringify({ status: "done", ...out }));
  } catch (e) {
    console.error("beni-brain", e);
    await saveSetting(key, JSON.stringify({ status: "error", error: String(e.message || e).slice(0, 300) })).catch(() => { });
  }
  return { statusCode: 202 };
};

exports._test = { attach, collect };
