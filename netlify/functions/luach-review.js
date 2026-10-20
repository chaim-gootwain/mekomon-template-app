// netlify/functions/luach-review.js
// -----------------------------------------------------------------------------
// מודעת לוח ששולמה ובני לא אישר לבד (luach-moderate החזיר "review") — חיים מחליט מהמייל.
//   GET  ?t=<טוקן>             → דף עם המודעה, הסיבה, וכפתורי "אשר" / "דחה"
//   POST t=<טוקן>&a=approve|reject → ביצוע ההחלטה (רק אם המודעה עדיין ממתינה)
// ההחלטה רק ב-POST מכפתור — סורקי קישורים במייל פותחים GET ולא יאשרו מודעה בטעות.
// הטוקן אקראי ונשלח רק במייל לחיים (BENI_OWNER_EMAIL).
// -----------------------------------------------------------------------------
const { reviewInfo, reviewDecide } = require("../lib/luach-pay");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "₪" + (Math.round(Number(n) * 100) / 100).toLocaleString("he-IL");
const CATS = { sale: "מכירה", rent: "להשכיר / נדל\"ן", jobs: "דרושים / ביקוש עבודה", gemach: "גמ\"חים", lost: "השבת אבידה", other: "שונות" };
const page = (title, inner, status = 200) => ({ statusCode: status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  body: `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f6f7fb;color:#1f2937;margin:0;padding:24px 16px}main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px}
h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.6}.muted{color:#6b7280;font-size:.9rem}.ad{background:#f3f4fc;border-radius:10px;padding:14px;white-space:pre-wrap;line-height:1.6;margin:10px 0}
.why{background:#fff7e6;border:1px solid #f5d9a8;border-radius:10px;padding:10px 12px;margin:10px 0}img{max-width:100%;border-radius:10px;margin:8px 0}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;font:inherit;font-size:1.05rem;font-weight:700;padding:13px;border-radius:10px;border:none;cursor:pointer}
.ok{background:#1c7a3f;color:#fff}.no{background:#fff;color:#c0392b;border:1.5px solid #c0392b}</style></head><body><main>${inner}
<p class="muted">בני — @@PAPER_NAME@@</p></main></body></html>` });

function parseBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : (event.body || "");
  return new URLSearchParams(raw);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "POST") {
      const p = parseBody(event);
      const action = p.get("a") === "approve" ? "approve" : p.get("a") === "reject" ? "reject" : null;
      if (!action) return page("שגיאה", "<h1>פעולה לא מוכרת</h1>", 400);
      const r = await reviewDecide(p.get("t"), action);
      if (r.error) return page("לא נמצא", "<h1>הקישור לא תקין או שפג תוקפו</h1>", 404);
      if (r.done) return page("כבר טופל", `<h1>המודעה כבר טופלה</h1><p>הסטטוס שלה: <b>${esc(r.status)}</b>. לא שיניתי כלום.</p>`);
      const total = r.info.ads.reduce((s, x) => s + (Number(x.price) || 0), 0);
      if (action === "approve" && r.info.paid) return page("אושר", "<h1>✅ אושר</h1><p>המודעה נכנסת לגיליון.</p>");
      if (action === "approve") return page("אושר", `<h1>✅ אושר — עכשיו המפרסם צריך לשלם</h1>
<p>${r.mailed ? `שלחתי לו קישור תשלום במייל (${esc(r.to)}).` : "אין לו מייל — שלח לו את הקישור בוואטסאפ:"}</p>
${r.wa ? `<p><a href="${esc(r.wa)}" style="display:block;text-align:center;background:#25d366;color:#fff;font-weight:700;padding:13px;border-radius:10px;text-decoration:none">📲 שלח קישור תשלום בוואטסאפ</a></p>` : ""}
<p class="muted">הקישור לתשלום: <span dir="ltr">${esc(r.payUrl)}</span><br>אחרי התשלום המודעה נכנסת לגיליון אוטומטית, והחשבונית יוצאת לבד.</p>`);
      return r.info.paid
        ? page("נדחה", `<h1>❌ המודעה נדחתה</h1><p>המפרסם כבר שילם <b>${money(total)}</b>. הזיכוי בקארדקום וחשבונית הזיכוי ב-EZcount — אצלך.</p>`)
        : page("נדחה", `<h1>❌ המודעה נדחתה</h1><p>לא נגבה תשלום, אז אין מה לזכות.${r.notified ? " שלחתי למפרסם הודעה מנומסת במייל." : " למפרסם אין מייל — לא נשלחה לו הודעה."}</p>`);
    }
    const t = (event.queryStringParameters || {}).t;
    const info = await reviewInfo(t);
    if (!info || !info.ads.length) return page("לא נמצא", "<h1>הקישור לא תקין או שפג תוקפו</h1>", 404);
    const a = info.ads[0];
    const total = info.ads.reduce((s, x) => s + (Number(x.price) || 0), 0);
    if (info.ads.some(x => x.status !== "pending")) return page("כבר טופל", `<h1>המודעה כבר טופלה</h1><p>הסטטוס שלה: <b>${esc(a.status)}</b>.</p>`);
    return page("מודעת לוח — החלטה", `<h1>מודעת לוח מחכה להחלטה שלך</h1>
<p><b>${esc(a.contact_name || "")}</b> · ${esc(a.contact_phone || "")}<br>${esc(CATS[a.category] || "שונות")} · ${info.paid ? "שולם" : "עוד לא שולם —"} ${money(total)}${info.ads.length > 1 ? " · 4+1" : ""}</p>
<div class="ad">${esc(a.body)}</div>${info.image ? `<img src="${esc(info.image)}" alt="תמונת המודעה">` : ""}
<div class="why">🟡 <b>למה לא אישרתי לבד:</b> ${esc(info.reason)}</div>
<form method="post" class="row"><input type="hidden" name="t" value="${esc(t)}">
<button class="ok" name="a" value="approve">✓ אשר</button><button class="no" name="a" value="reject">✕ דחה</button></form>
<p class="muted">${info.paid ? "בדחייה — הזיכוי של התשלום אצלך." : "באישור — המפרסם מקבל קישור לתשלום. בדחייה — לא נגבה כלום."}</p>`);
  } catch (e) {
    console.error("luach-review", e);
    return page("תקלה", "<h1>תקלה זמנית</h1><p>נסה שוב בעוד דקה.</p>", 500);
  }
};
