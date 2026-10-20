// netlify/functions/luach-pay.js
// -----------------------------------------------------------------------------
// טופס הלוח הציבורי (/luach) — הגשה + תשלום באשראי בקארדקום.
//   GET  → { ok, enabled }  — הטופס בודק אם במופע יש סליקה (404 = מופע בלי הפונקציה → הטופס הישן)
//   POST { name, phone, email, category, ad_type, body, issue_id, package, image_path }
//        → { ok, saved:{issue,price}, url }  — url = דף קארדקום על המחיר שנשמר במסד
//        → { ok, review:true }             — בני עצר את המודעה לבדיקה של חיים; לא גובים
//   GET  ?pay=<טוקן> → דף קארדקום למודעה שחיים אישר (הקישור שנשלח למפרסם)
// ציבורי (בלי התחברות): לא חושף יתרות — רק דף תשלום למודעה שהוגשה כאן הרגע.
// רישום התשלום — רק מ-webhook מאומת (cardcom-webhook → beni-pay.settle → luach-pay.settleLuach).
// -----------------------------------------------------------------------------
const cardcom = require("../lib/cardcom");
const { submitAndPay, startApprovedPayment } = require("../lib/luach-pay");

const page = (title, inner, status) => ({ statusCode: status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  body: `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f6f7fb;margin:0;padding:24px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px;line-height:1.6}</style></head><body><main>${inner}<p style="color:#6b7280;font-size:.9rem">@@PAPER_NAME@@ · @@PAPER_PHONE@@</p></main></body></html>` });

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  // ?pay=<טוקן> — קישור התשלום שנשלח למפרסם אחרי שחיים אישר מודעה שנעצרה לבדיקה
  if (event.httpMethod === "GET" && q.pay) {
    try {
      const r = await startApprovedPayment(q.pay);
      if (r.url) return { statusCode: 302, headers: { Location: r.url, "cache-control": "no-store" }, body: "" };
      if (r.paid) return page("שולם", "<h1>המודעה כבר שולמה 🙂</h1><p>תודה!</p>", 200);
      return page("קישור לא תקין", "<h1>הקישור לא תקין</h1><p>לבירור — התקשרו אלינו.</p>", 400);
    } catch (e) {
      console.error("luach-pay link", e);
      return page("תקלה", "<h1>תקלה זמנית</h1><p>לא הצלחנו לפתוח את דף התשלום. נסו שוב בעוד כמה דקות, או התקשרו אלינו.</p>", 500);
    }
  }
  if (event.httpMethod === "GET") return json(200, { ok: true, enabled: cardcom.configured() });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method" });
  if (!cardcom.configured()) return json(503, { ok: false, error: "not_configured" });
  let f; try { f = JSON.parse(event.body || "{}") || {}; } catch { return json(400, { ok: false, error: "bad_json" }); }
  let r;
  try {
    r = await submitAndPay(f);
  } catch (e) {
    console.error("luach-pay", e);
    // שגיאת הגשה (טלפון/נוסח/גיליון) — המודעה לא נשמרה, הטופס מציג את ההודעה
    if (e.rpc) return json(400, { ok: false, error: String(e.message || e).slice(0, 200) });
    // saved = המודעה נשמרה ורק דף התשלום לא נפתח — הטופס מבקש ליצור קשר (לא להגיש שוב)
    return json(500, { ok: false, error: "pay_failed", saved: !!e.saved });
  }
  if (r.review) return json(200, { ok: true, saved: r.saved, review: true, url: null });   // נעצרה לבדיקה — לא גובים
  if (!r.url) return json(200, { ok: true, saved: r.saved, url: null });
  return json(200, { ok: true, saved: r.saved, url: r.url, amount: r.amount });
};
