// netlify/functions/beni-crm-lookup.js
// -----------------------------------------------------------------------------
// "בני" — server-side CRM lookup for incoming email senders (feature #24).
//
// Why this exists: beni.gs (Apps Script) needs to know if a sender is an
// existing advertiser, a lead, or unknown — plus their open balance — so the
// drafted reply is personal and accurate. Instead of placing the Supabase
// service_role key inside Apps Script (sensitive!), this function keeps it
// SERVER-SIDE (Netlify env var, same as beni-insert) and is protected by the
// same shared token. Apps Script calls this endpoint with `x-beni-token`.
//
// Required Netlify environment variables (already set for beni-insert):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BENI_INSERT_TOKEN
//
// Request:  POST /.netlify/functions/beni-crm-lookup
//   headers: { "x-beni-token": "<token>", "content-type": "application/json" }
//   body:    { "email": "sender@example.com" }
// Response: 200 {
//   ok: true,
//   card: {
//     type: "advertiser" | "lead" | "unknown",
//     name, customer_id?, lead_id?, agent?, phone?,
//     open_balance?,          // ₪, charges − payments on open charges
//     ads_count?, last_ad?,   // publishing history hints
//     lead_status?, lead_created?
//   }
// }
// Read-only: this function never writes anything.
// -----------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN        = process.env.BENI_INSERT_TOKEN;

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { "apikey": SERVICE_ROLE, "Authorization": `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const headers = event.headers || {};
  const token = headers["x-beni-token"] || headers["X-Beni-Token"];
  if (!TOKEN) return json(500, { error: "server_not_configured", detail: "BENI_INSERT_TOKEN missing" });
  if (!token || token !== TOKEN) return json(401, { error: "unauthorized" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "server_not_configured" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "bad_email" });
  const enc = encodeURIComponent(email);

  try {
    // 1) customer by email (exact, case-insensitive)
    const custs = await sb(`customers?select=id,name,agent_id,phone,status&email=ilike.${enc}&limit=1`);
    if (custs.length) {
      const c = custs[0];
      const card = { type: "advertiser", name: c.name, customer_id: c.id, phone: c.phone || null };

      // agent name
      if (c.agent_id) {
        try {
          const ag = await sb(`agents?select=name&id=eq.${c.agent_id}&limit=1`);
          if (ag.length) card.agent = ag[0].name;
        } catch (e) { /* לא חוסם */ }
      }

      // open balance: open charges minus their payments
      try {
        const charges = await sb(`charges?select=id,amount&customer_id=eq.${c.id}&status=in.(pending,invoiced,partial,overdue)`);
        let balance = charges.reduce((s, ch) => s + Number(ch.amount || 0), 0);
        if (charges.length) {
          const ids = charges.map(ch => ch.id).join(",");
          const pays = await sb(`payments?select=amount&charge_id=in.(${ids})`);
          balance -= pays.reduce((s, p) => s + Number(p.amount || 0), 0);
        }
        card.open_balance = Math.round(Math.max(0, balance) * 100) / 100;
      } catch (e) { /* לא חוסם */ }

      // publishing history hints
      try {
        const ads = await sb(`ads?select=id,title,created_at&customer_id=eq.${c.id}&status=not.in.(cancelled,rejected)&order=created_at.desc&limit=1`);
        card.last_ad = ads.length ? { title: ads[0].title, at: ads[0].created_at } : null;
        const cnt = await sb(`ads?select=id&customer_id=eq.${c.id}&status=not.in.(cancelled,rejected)&limit=500`);
        card.ads_count = cnt.length;
      } catch (e) { /* לא חוסם */ }

      return json(200, { ok: true, card });
    }

    // 2) lead by email
    const leads = await sb(`leads?select=id,name,status,created_at,phone&email=ilike.${enc}&limit=1`);
    if (leads.length) {
      const l = leads[0];
      return json(200, { ok: true, card: {
        type: "lead", name: l.name, lead_id: l.id, phone: l.phone || null,
        lead_status: l.status, lead_created: l.created_at,
      } });
    }

    // 3) unknown — new business
    return json(200, { ok: true, card: { type: "unknown" } });
  } catch (e) {
    return json(502, { error: "lookup_failed", detail: String(e).slice(0, 300) });
  }
};
