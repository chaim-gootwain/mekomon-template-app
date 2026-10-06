// netlify/functions/beni-insert.js
// -----------------------------------------------------------------------------
// "בני" — server-side insert into the beni_drafts table.
//
// Why this exists: the beni_drafts table is RLS-locked (admin-only). The
// scheduled (browserless) session that runs בני has no logged-in user, so it
// cannot write to the table directly. This function holds the Supabase
// service_role key SERVER-SIDE (as a Netlify env var — never exposed to the
// browser and never placed in the scheduled trigger) and is protected by a
// shared token. The trigger calls this endpoint with the token in the
// `x-beni-token` header; only requests carrying the right token get through.
//
// Required Netlify environment variables (Site settings → Environment):
//   SUPABASE_URL               = @@SUPABASE_URL@@
//   SUPABASE_SERVICE_ROLE_KEY  = <Supabase → Settings → API → service_role>
//   BENI_INSERT_TOKEN          = <the shared secret token>
//
// Request:  POST  /.netlify/functions/beni-insert
//   headers: { "x-beni-token": "<token>", "content-type": "application/json" }
//   body:    { "rows": [ { ...draft row... }, ... ] }   // 1..100 rows
//            (a single { "row": {...} } is also accepted)
// Response: 200 { ok: true, count: <n> }  |  4xx/5xx { error, ... }
// -----------------------------------------------------------------------------

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_ROLE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN         = process.env.BENI_INSERT_TOKEN;

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // --- auth ---
  const headers = event.headers || {};
  const token = headers["x-beni-token"] || headers["X-Beni-Token"];
  if (!TOKEN) return json(500, { error: "server_not_configured", detail: "BENI_INSERT_TOKEN missing" });
  if (!token || token !== TOKEN) return json(401, { error: "unauthorized" });

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json(500, { error: "server_not_configured", detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" });
  }

  // --- parse ---
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "bad_json" }); }

  const rows = Array.isArray(body.rows) ? body.rows
             : (body.row && typeof body.row === "object") ? [body.row]
             : null;
  if (!rows || rows.length === 0) return json(400, { error: "no_rows" });
  if (rows.length > 100)          return json(400, { error: "too_many_rows", max: 100 });

  // --- insert (bypasses RLS via service_role) ---
  let res, text;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/beni_drafts`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_ROLE,
        "Authorization": `Bearer ${SERVICE_ROLE}`,
        "content-type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify(rows),
    });
    text = await res.text();
  } catch (e) {
    return json(502, { error: "fetch_failed", detail: String(e).slice(0, 300) });
  }

  if (!res.ok) {
    return json(502, { error: "supabase_error", status: res.status, detail: (text || "").slice(0, 600) });
  }

  let inserted = null;
  try { inserted = JSON.parse(text); } catch { /* ignore */ }
  return json(200, { ok: true, count: Array.isArray(inserted) ? inserted.length : rows.length });
};
