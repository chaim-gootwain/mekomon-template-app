// netlify/functions/beni-brain.js
// -----------------------------------------------------------------------------
// "בני" — תוצאת הפענוח של תשובה חופשית (ר' beni-brain-background.js).
//   GET ?id=<מזהה המייל>  + כותרת x-beni-token  →  { status: working|done|error|unknown, ... }
// תוצאה שנמסרה (done/error) נמחקת — היא כבר אצל Apps Script.
// -----------------------------------------------------------------------------
const { getSetting } = require("../lib/beni-collect-core");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.BENI_INSERT_TOKEN;
const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return json(401, { error: "unauthorized" });
  const id = (event.queryStringParameters || {}).id || "";
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(id)) return json(400, { error: "bad_id" });
  try {
    const raw = await getSetting(`brain_${id}`);
    if (!raw) return json(200, { status: "unknown" });
    const v = JSON.parse(raw);
    if (v.status !== "working") {
      await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.brain_${id}`, { method: "DELETE",
        headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    }
    return json(200, v);
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 200) });
  }
};
