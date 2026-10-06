// netlify/functions/beni-collect.js
// -----------------------------------------------------------------------------
// "בני" — דף האישור של תזכורות החוב (מצב צל).
//   GET  ?d=<תאריך>&t=<טוקן>  → דף: כל התזכורות של היום, עם תיבות סימון ונוסח מלא
//   POST d, t, id[]          → שולח רק את המסומנות מתיבת העסק, ורושם ב-debt_reminders
// הקישור מגיע רק במייל של חיים (טוקן אקראי לכל יום), בתוקף 3 ימים, ונשלח פעם אחת בלבד.
// -----------------------------------------------------------------------------
const { getSetting, saveSetting, heDate, money, israelToday } = require("../lib/beni-collect-core");
const { sendMail } = require("../lib/beni-mail");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, inner, status = 200) => ({ statusCode: status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  body: `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f6f7fb;color:#1f2937;margin:0;padding:16px}main{max-width:760px;margin:0 auto}
h1{font-size:1.3rem}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:10px 0}
.row{display:flex;gap:10px;align-items:flex-start}.row input{margin-top:4px;width:20px;height:20px}.muted{color:#6b7280;font-size:.88rem}
.over{color:#b91c1c;font-weight:600}pre{white-space:pre-wrap;font-family:inherit;background:#f9fafb;border-radius:8px;padding:10px;font-size:.9rem}
button{background:@@COLOR_BRAND@@;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:1rem;cursor:pointer}a{color:@@COLOR_BRAND@@}</style></head>
<body><main>${inner}</main></body></html>` });

async function load(d, t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "") || !t) return { err: "קישור לא תקין." };
  const raw = await getSetting(`collect_plan_${d}`);
  if (!raw) return { err: "לא נמצאה תוכנית לתאריך הזה." };
  const plan = JSON.parse(raw);
  if (!plan.token || plan.token !== t) return { err: "קישור לא תקין." };
  const age = (new Date(israelToday()) - new Date(d)) / 86400e3;
  if (age > 3) return { err: "הקישור פג תוקף (3 ימים). בני יכין תוכנית חדשה מחר בבוקר." };
  return { plan };
}

function parseForm(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : (event.body || "");
  const p = new URLSearchParams(raw);
  return { d: p.get("d"), t: p.get("t"), ids: p.getAll("id").map(Number) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      const { plan, err } = await load(q.d, q.t);
      if (err) return page("בני", `<h1>בני — תזכורות חוב</h1><div class="card">${esc(err)}</div>`, 400);
      if (plan.status === "sent") {
        return page("בני", `<h1>תזכורות ${esc(heDate(plan.date))} — כבר נשלחו</h1><div class="card">${(plan.results || []).map(r => `<div>${r.ok ? "✅" : "⚠️"} ${esc(r.name)}${r.ok ? "" : " — " + esc(r.error)}</div>`).join("")}</div>`);
      }
      const items = plan.items.map(i => `<div class="card"><label class="row">
        <input type="checkbox" name="id" value="${i.id}" ${i.checked && !i.done ? "checked" : ""} ${i.sendable && !i.done ? "" : "disabled"}>
        <div style="flex:1"><div>${i.done ? "✅ נשלח · " : ""}<b>${esc(i.name)}</b> — ${esc(money(i.total))} · ${i.daysOverdue} ימים באיחור · תזכורת ${i.stage}
        ${i.over ? `<span class="over"> · 🔴 מעל הסף (${esc(money(plan.threshold))})</span>` : ""}</div>
        <div class="muted">${i.sendable ? "אל: " + esc(i.email) : "אין מייל בכרטיס" + (i.phone ? ` — <a href="https://wa.me/972${esc(i.phone.replace(/^0/, ""))}?text=${encodeURIComponent(i.body)}" target="_blank">לשלוח בוואטסאפ ידנית</a>` : "")}</div>
        <details><summary class="muted">הנוסח המלא</summary><pre>${esc("נושא: " + i.subject + "\n\n" + i.body)}</pre></details></div></label></div>`).join("");
      const esc3 = plan.escalate.length ? `<h2 style="font-size:1.05rem">🔴 לטיפולך — כבר קיבלו 3 תזכורות</h2>` +
        plan.escalate.map(e => `<div class="card"><b>${esc(e.name)}</b> — ${esc(money(e.total))}, ${e.daysOverdue} ימים באיחור</div>`).join("") : "";
      return page("בני — תזכורות חוב", `<h1>בני — תזכורות חוב ל-${esc(heDate(plan.date))}</h1>
        <p class="muted">שום דבר עוד לא נשלח. מה שמסומן יישלח מתיבת העסק בשם "בני – @@PAPER_NAME@@" וירשם ביומן החובות. חובות מעל הסף לא מסומנים — אתה מחליט.</p>
        <form method="post"><input type="hidden" name="d" value="${esc(plan.date)}"><input type="hidden" name="t" value="${esc(plan.token)}">
        ${items}<p><button type="submit">שלח את המסומנות</button></p></form>${esc3}`);
    }

    if (event.httpMethod === "POST") {
      const f = parseForm(event);
      const { plan, err } = await load(f.d, f.t);
      if (err) return page("בני", `<div class="card">${esc(err)}</div>`, 400);
      if (plan.status === "sent") return page("בני", `<div class="card">התזכורות של היום כבר נשלחו.</div>`);
      plan.status = "sending"; await saveSetting(`collect_plan_${plan.date}`, JSON.stringify(plan)); // נגד לחיצה כפולה
      const chosen = plan.items.filter(i => f.ids.includes(i.id) && i.sendable && !i.done);
      const results = [];
      for (const i of chosen) {
        try {
          await sendMail(i.email, i.subject, i.body);
          await fetch(`${SUPABASE_URL}/rest/v1/debt_reminders`, { method: "POST",
            headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ customer_id: i.customerId, amount: i.total, channel: "email", message: i.body, status: "sent" }) });
          i.done = true; results.push({ name: i.name, ok: true });
        } catch (e) { results.push({ name: i.name, ok: false, error: String(e.message || e).slice(0, 120) }); }
      }
      // מה שנכשל נשאר פתוח לשליחה חוזרת מאותו קישור; מה שנשלח מסומן done ולא יישלח פעמיים
      const failed = results.some(r => !r.ok);
      plan.status = failed ? "pending" : "sent"; plan.results = (plan.results || []).concat(results); plan.sentAt = new Date().toISOString();
      await saveSetting(`collect_plan_${plan.date}`, JSON.stringify(plan));
      const ok = results.filter(r => r.ok).length;
      return page("בני — נשלח", `<h1>✅ נשלחו ${ok} תזכורות</h1><div class="card">${results.map(r => `<div>${r.ok ? "✅" : "⚠️"} ${esc(r.name)}${r.ok ? "" : " — " + esc(r.error)}</div>`).join("") || "לא סומנה אף תזכורת."}</div>
        ${failed ? `<p class="over">חלק לא נשלחו. אפשר לפתוח שוב את הקישור מהמייל ולנסות שוב — מה שכבר נשלח לא יישלח פעמיים.</p>` : ""}
        <p class="muted">נרשמו ביומן החובות. מי שלא ישלם — בני יציע תזכורת הבאה בעוד שבוע.</p>`);
    }
    return { statusCode: 405 };
  } catch (e) {
    console.error("beni-collect", e);
    return page("בני", `<div class="card">שגיאה: ${esc(String(e.message || e).slice(0, 200))}</div>`, 500);
  }
};
