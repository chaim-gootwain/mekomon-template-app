// netlify/functions/luach-pay-background.js
// -----------------------------------------------------------------------------
// השלב האיטי של הגשת מודעת לוח (ר' lib/luach-pay.js processJob): בדיקת התוכן
// (luach-moderate, Claude) ואז דף קארדקום / עצירה לבדיקה של חיים.
// פונקציית רקע (עד 15 דק') — נקראת רק מ-luach-pay עם הטוקן הפנימי. עונה 202 מיד.
// -----------------------------------------------------------------------------
const { processJob } = require("../lib/luach-pay");
const TOKEN = process.env.BENI_INSERT_TOKEN;

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400 }; }
  try { await processJob(String(b.job || "")); } catch (e) { console.error("luach-pay-background", b.job, e); }
  return { statusCode: 202 };
};
