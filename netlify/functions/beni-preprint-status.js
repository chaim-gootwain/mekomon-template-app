// netlify/functions/beni-preprint-status.js
// -----------------------------------------------------------------------------
// "בני" — מצב הבדיקה האחרונה של גיליון לפני דפוס (לאבחון, קריאה בלבד).
//
// מחזיר רק נתונים טכניים מתוך settings.pp_report_<מספר>: מתי רץ, האם תקין,
// כמה ממצאים, ושגיאה אם הייתה — בלי שמות לקוחות ובלי תוכן הממצאים, כדי
// שאפשר יהיה לבדוק מה קרה בלי גישה ללוגים של Netlify.
//
// GET /.netlify/functions/beni-preprint-status?issue=306
// -----------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const issue = parseInt((event.queryStringParameters || {}).issue, 10);
  if (!issue) return json(400, { error: "issue_required" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "server_not_configured" });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.pp_report_${issue}`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    if (!r.ok) return json(502, { error: "supabase_" + r.status });
    const rows = await r.json();
    if (!rows.length) return json(200, { issue, found: false });
    let rep = {}; try { rep = JSON.parse(rows[0].value); } catch { }
    return json(200, {
      issue, found: true, at: rep.at || null,
      ok: rep.ok === undefined ? null : rep.ok,
      sizeMB: rep.sizeMB || null, pages: rep.pages || null, images: rep.images || null,
      badCount: Array.isArray(rep.bad) ? rep.bad.length : null,
      warnCount: Array.isArray(rep.warn) ? rep.warn.length : null,
      emailed: rep.emailed || null,
      error: rep.error ? String(rep.error).slice(0, 300) : null,
    });
  } catch (e) {
    return json(500, { error: "failed" });
  }
};
