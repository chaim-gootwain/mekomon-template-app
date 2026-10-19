// netlify/functions/pay-link.js
// -----------------------------------------------------------------------------
// הקישור הקבוע לתשלום של לקוח — לשימוש מתוך המערכת (סוכן המקומון).
// עוטף את התשתית של בני (lib/beni-pay): אותו קישור קבוע שבני שולח
// בתזכורות, שבלחיצה נפתח דף קארדקום על היתרה הפתוחה באותו רגע,
// והתשלום נסגר מקצה לקצה (webhook → קבלה ב-EZcount → רישום בכרטסת).
//
// POST /.netlify/functions/pay-link
//   headers: { Authorization: "Bearer <JWT של משתמש מחובר>" }
//   body:    { "customer_id": 123 }
// Response: { ok, url, balance, open_count, name }
//
// אבטחה: הטוקן מאומת מול Supabase Auth, והתפקיד נבדק בטבלת profiles —
// admin או sales פעילים בלבד. הקישור חושף ללוחץ עליו את השם והיתרה,
// ולכן היצירה שמורה לצוות בלבד. קריאה חוזרת מחזירה את אותו קישור קבוע.
// -----------------------------------------------------------------------------
const { linkFor, openCharges } = require("../lib/beni-pay");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method" });
  try {
    const token = String(event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json(401, { ok: false, error: "unauthorized" });
    // אימות המשתמש מול Supabase Auth (ה-apikey הוא service_role — נשאר בשרת)
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${token}` } });
    const user = ur.ok ? await ur.json() : null;
    if (!user || !user.id) return json(401, { ok: false, error: "unauthorized" });
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role,active&id=eq.${user.id}`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const [prof] = pr.ok ? await pr.json() : [];
    if (!prof || !prof.active || !["admin", "sales"].includes(prof.role)) return json(403, { ok: false, error: "forbidden" });

    const cid = parseInt((JSON.parse(event.body || "{}") || {}).customer_id, 10);
    if (!cid || cid < 1) return json(400, { ok: false, error: "no-customer", detail: "חסר customer_id" });
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/customers?select=id,name&id=eq.${cid}`, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    const [cust] = cr.ok ? await cr.json() : [];
    if (!cust) return json(404, { ok: false, error: "no-customer", detail: "הלקוח לא נמצא" });

    const charges = await openCharges(cid);
    const balance = Math.round(charges.reduce((s, c) => s + c.balance, 0) * 100) / 100;
    const url = await linkFor(cid);
    return json(200, { ok: true, url, balance, open_count: charges.length, name: cust.name });
  } catch (e) {
    console.error("pay-link", e);
    return json(500, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
