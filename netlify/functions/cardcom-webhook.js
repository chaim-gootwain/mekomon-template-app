// netlify/functions/cardcom-webhook.js
// -----------------------------------------------------------------------------
// קארדקום מודיעה כאן על עסקה שהסתיימה בדף תשלום של בני. לא סומכים על תוכן ההודעה:
// לוקחים רק את LowProfileId ומעבירים לטיפול ברקע (cardcom-webhook-background), שמאמת
// מול קארדקום (GetLpResult) לפני שמפיק קבלה ורושם תשלום. עונים 200 מיד.
// -----------------------------------------------------------------------------
const TOKEN = process.env.BENI_INSERT_TOKEN;
const SITE = process.env.URL || "https://imanuel-sheli.netlify.app";

function lowProfileId(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : (event.body || "");
  let v = null;
  try { const j = JSON.parse(raw); v = j.LowProfileId || j.lowProfileId || j.LowProfileCode || j.lowprofilecode; } catch (_) {
    const p = new URLSearchParams(raw); v = p.get("LowProfileId") || p.get("lowprofilecode") || p.get("LowProfileCode");
  }
  const q = event.queryStringParameters || {};
  v = v || q.LowProfileId || q.lowprofilecode;
  return /^[A-Za-z0-9-]{8,64}$/.test(String(v || "")) ? String(v) : null;
}

exports.handler = async (event) => {
  const id = lowProfileId(event);
  if (!id) return { statusCode: 400, body: "missing LowProfileId" };
  await fetch(`${SITE}/.netlify/functions/cardcom-webhook-background`, { method: "POST", headers: { "x-beni-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ lowProfileId: id }) }).catch(e => console.error("cardcom-webhook kick", e));
  return { statusCode: 200, body: "OK" };
};

exports._test = { lowProfileId };
