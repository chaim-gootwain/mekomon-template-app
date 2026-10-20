// netlify/functions/cardcom-webhook-background.js
// -----------------------------------------------------------------------------
// אימות התשלום מול קארדקום → קבלה ב-EZcount → רישום בספר → מייל לחיים (ר' lib/beni-pay.js settle).
// אידמפוטנטי: הודעה כפולה מקארדקום לא תפיק קבלה כפולה ולא תרשום תשלום פעמיים.
// -----------------------------------------------------------------------------
const { settle } = require("../lib/beni-pay");
const { sendMail } = require("../lib/beni-mail");
const TOKEN = process.env.BENI_INSERT_TOKEN;
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400 }; }
  try {
    const r = await settle(b.lowProfileId);
    console.log("cardcom settle", b.lowProfileId, JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.error("cardcom settle failed", b.lowProfileId, e);
    await sendMail(OWNER, "⚠️ בני: תשלום בקארדקום — לא הצלחתי לרשום",
      `הגיעה הודעה מקארדקום על דף תשלום ${b.lowProfileId}, אבל הטיפול נכשל: ${String(e.message || e).slice(0, 300)}\n` +
      `תבדוק בממשק של קארדקום אם הלקוח שילם, ואם כן — תפיק קבלה מהאתר כרגיל (היא גם תרשום את התשלום).\n\nבני`).catch(() => { });
  }
  return { statusCode: 202 };
};
