// netlify/functions/beni-attach.js
// -----------------------------------------------------------------------------
// "בני" — צירוף אוטומטי של קבצי מודעות שלקוחות שולחים לתיבת העסק.
//
// סקריפט Apps Script בחשבון imanuel.sheli (beni/beni-attachments.gs) סורק מיילים
// חדשים עם קבצים, ושואל כאן למי לצרף:
//   action "match":    { email, subject, files:[{name,size,type}] }
//     → שולח מזוהה כלקוח ויש לו בדיוק מודעה אחת פתוחה בגיליון הקרוב
//       { match:true, adId, label, uploads:[{name, path, url}] }  (קישורי העלאה חתומים)
//     → אחרת { match:false, reason, customer?, candidates? }
//   action "register": { adId, files:[{path, name}], subject }
//     → רושם ב-ad_files (kind=source) — כמו העלאה ידנית של קובץ מהלקוח
// הקבצים עצמם עולים ישירות מ-Apps Script ל-Supabase Storage (bucket ad-files)
// דרך הקישורים החתומים — לא עוברים דרך Netlify (מגבלת 6MB לבקשה).
//
// מוגן ב-BENI_INSERT_TOKEN כמו שאר פונקציות בני. env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// -----------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.BENI_INSERT_TOKEN;
const BUCKET = "ad-files";

const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });

async function sb(pathq) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { headers: H() });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// שם קובץ בטוח לאחסון (כמו safeKey באתר): רק תווים לטיניים, ספרות ._- ; הסיומת נשמרת
function safeKey(name) {
  const s = String(name || "file").normalize("NFKD");
  const dot = s.lastIndexOf(".");
  const base = (dot > 0 ? s.slice(0, dot) : s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "file";
  const ext = dot > 0 ? s.slice(dot).replace(/[^A-Za-z0-9.]+/g, "").slice(0, 8) : "";
  return base + ext.toLowerCase();
}

async function signUpload(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: "POST", headers: { ...H(), "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`sign ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return `${SUPABASE_URL}/storage/v1${d.url}`;
}

async function match(b) {
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { match: false, reason: "bad_email" };
  const enc = encodeURIComponent(email.replace(/[\\%_]/g, m => "\\" + m));
  const custs = await sb(`customers?select=id,name&email=ilike.${enc}&limit=2`);
  if (custs.length !== 1) return { match: false, reason: custs.length ? "several_customers" : "unknown_sender" };
  const c = custs[0];

  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // תאריך ישראל
  const issues = await sb(`issues?select=id,issue_number,publish_date&publish_date=gte.${today}&order=publish_date.asc&limit=6`);
  if (!issues.length) return { match: false, reason: "no_open_issue", customer: c.name };
  const ads = await sb(`ads?select=id,title,issue_id,status&customer_id=eq.${c.id}&issue_id=in.(${issues.map(i => i.id).join(",")})&status=not.in.(cancelled,rejected,published)`);
  if (!ads.length) return { match: false, reason: "no_open_ad", customer: c.name };
  // הגיליון הקרוב ביותר שיש בו מודעה ללקוח
  const nearest = issues.find(i => ads.some(a => a.issue_id === i.id));
  const inNearest = ads.filter(a => a.issue_id === nearest.id);
  if (inNearest.length !== 1) {
    return { match: false, reason: "several_ads", customer: c.name, issue: nearest.issue_number,
      candidates: inNearest.map(a => ({ adId: a.id, title: a.title || "" })) };
  }
  const ad = inNearest[0];
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10);
  const uploads = [];
  for (const f of files) {
    const path = `beni/${ad.id}/${Date.now()}_${uploads.length}_${safeKey(f.name)}`;
    uploads.push({ name: String(f.name || "file"), path, url: await signUpload(path) });
  }
  return { match: true, adId: ad.id, customer: c.name, issue: nearest.issue_number,
    label: `${c.name}${ad.title ? " · " + ad.title : ""} (גיליון ${nearest.issue_number})`, uploads };
}

async function register(b) {
  const adId = parseInt(b.adId, 10);
  if (!adId) return { ok: false, error: "bad_ad" };
  const files = (Array.isArray(b.files) ? b.files : []).filter(f => typeof f.path === "string" && f.path.startsWith(`beni/${adId}/`));
  if (!files.length) return { ok: false, error: "no_files" };
  const subj = String(b.subject || "").slice(0, 80);
  const rows = files.map(f => ({ ad_id: adId, storage_path: f.path, kind: "source",
    file_name: `📧 ${String(f.name || "קובץ").slice(0, 120)}${subj ? " — " + subj : ""}` }));
  const post = body => fetch(`${SUPABASE_URL}/rest/v1/ad_files`, { method: "POST", headers: { ...H(), "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) });
  let r = await post(rows);
  if (!r.ok) {
    const t = await r.text();
    // אם העמודה uploaded_by חובה במופע — רושמים על שם מנהל המערכת
    if (!/uploaded_by/.test(t)) throw new Error(`ad_files ${r.status}: ${t.slice(0, 200)}`);
    const admin = await sb("profiles?select=id&role=eq.admin&limit=1");
    if (!admin.length) throw new Error(`ad_files ${r.status}: ${t.slice(0, 200)}`);
    r = await post(rows.map(x => ({ ...x, uploaded_by: admin[0].id })));
    if (!r.ok) throw new Error(`ad_files ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return { ok: true, count: rows.length };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return json(401, { error: "unauthorized" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "server_not_configured" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }
  try {
    if (b.action === "match") return json(200, await match(b));
    if (b.action === "register") return json(200, await register(b));
    return json(400, { error: "bad_action" });
  } catch (e) {
    console.error("beni-attach", e);
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};

exports._test = { safeKey, match, register };
