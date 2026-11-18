// netlify/functions/beni-clips-daily.js
// -----------------------------------------------------------------------------
// "בני" — כל בוקר (ר' netlify.toml) מפעיל את שליחת הגזירים למפרסמים ברקע.
// פונקציה מתוזמנת מוגבלת ל-30 שניות; השליחה עצמה (PDF + עשרות מיילים) ב-beni-clips-background.
// -----------------------------------------------------------------------------
const SITE = process.env.URL || "https://imanuel-sheli.netlify.app";

exports.handler = async () => {
  await fetch(`${SITE}/.netlify/functions/beni-clips-background`, { method: "POST", headers: { "x-beni-token": process.env.BENI_INSERT_TOKEN || "" }, body: "{}" })
    .catch(e => console.error("beni-clips kick", e));
  return { statusCode: 200 };
};
