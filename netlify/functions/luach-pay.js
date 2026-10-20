// netlify/functions/luach-pay.js
// -----------------------------------------------------------------------------
// טופס הלוח הציבורי (/luach) — הגשה + תשלום באשראי בקארדקום.
//   GET  → { ok, enabled }  — הטופס בודק אם במופע יש סליקה (404 = מופע בלי הפונקציה → הטופס הישן)
//   POST { name, phone, category, ad_type, body, issue_id, package, image_path }
//        → { ok, saved:{issue,price}, url }  — url = דף קארדקום על המחיר שנשמר במסד
// ציבורי (בלי התחברות): לא חושף יתרות — רק דף תשלום למודעה שהוגשה כאן הרגע.
// רישום התשלום — רק מ-webhook מאומת (cardcom-webhook → beni-pay.settle → luach-pay.settleLuach).
// -----------------------------------------------------------------------------
const cardcom = require("../lib/cardcom");
const { submitAndPay } = require("../lib/luach-pay");

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
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
  if (!r.url) return json(200, { ok: true, saved: r.saved, url: null });
  return json(200, { ok: true, saved: r.saved, url: r.url, amount: r.amount });
};
