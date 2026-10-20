// netlify/functions/pay.js
// -----------------------------------------------------------------------------
// "בני" — הקישור הקבוע לתשלום שבני שולח ללקוח (…/pay?t=<טוקן>).
//   GET ?t=  → הסכום הפתוח של הלקוח עכשיו → דף התשלום של קארדקום (הפניה)
//   GET ?done=ok|fail → דף תודה / ניסיון חוזר (קארדקום מחזירה לכאן אחרי התשלום)
// רישום התשלום עצמו — רק מ-webhook מאומת (cardcom-webhook), לא מהדף הזה.
// -----------------------------------------------------------------------------
const { startPayment } = require("../lib/beni-pay");
const { sendMail } = require("../lib/beni-mail");
const store = require("../lib/beni-store");
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, inner, status = 200) => ({ statusCode: status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  body: `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f6f7fb;color:#1f2937;margin:0;padding:24px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px}
h1{font-size:1.3rem;margin:0 0 10px}p{line-height:1.6}.muted{color:#6b7280;font-size:.9rem}</style></head><body><main>${inner}
<p class="muted">@@PAPER_NAME@@ · @@PAPER_PHONE@@</p></main></body></html>` });

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.done === "ok") return page("תודה", `<h1>✅ התשלום התקבל — תודה!</h1><p>קבלה תישלח אליכם בהקדם.</p>`);
  if (q.done) return page("התשלום לא הושלם", `<h1>התשלום לא הושלם</h1><p>לא חויבתם. אפשר לחזור לקישור מהמייל ולנסות שוב, או להתקשר אלינו.</p>`);
  try {
    const r = await startPayment(q.t);
    if (r.error) return page("קישור לא תקין", `<h1>הקישור לא תקין</h1><p>${esc(r.error)} לבירור — התקשרו אלינו.</p>`, 400);
    if (r.nothing) return page("אין יתרה", `<h1>אין יתרה פתוחה 🙂</h1><p>${esc(r.name)}, לפי הרישומים שלנו אין כרגע מה לשלם. תודה!</p>`);
    return { statusCode: 302, headers: { Location: r.url, "cache-control": "no-store" }, body: "" };
  } catch (e) {
    console.error("pay", e);
    // חיים צריך לדעת מיד שלקוח ניסה לשלם ונכשל — עם הודעת השגיאה של קארדקום (בלי סודות)
    const msg = String(e.message || e).slice(0, 300);
    await store.put("status.json", { ...((await store.get("status.json").catch(() => null)) || {}), lastPayError: msg, lastPayErrorAt: new Date().toISOString() }).catch(() => { });
    await sendMail(OWNER, "⚠️ בני: לקוח ניסה לשלם ודף התשלום לא נפתח", `לקוח לחץ על קישור התשלום, אבל קארדקום החזירה שגיאה:\n${msg}\n\nבדרך כלל זה אומר שמספר המסוף או שם המשתמש ל-API ב-Netlify לא נכונים (CARDCOM_TERMINAL / CARDCOM_API_NAME), או שהמשתמש חסום בקארדקום.\n\nבני`).catch(() => { });
    return page("תקלה", `<h1>תקלה זמנית</h1><p>לא הצלחנו לפתוח את דף התשלום כרגע. נסו שוב בעוד כמה דקות, או התקשרו אלינו.</p>`, 500);
  }
};
