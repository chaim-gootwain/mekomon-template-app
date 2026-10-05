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
//   action "uploadsFor": { adId, customerId, files }   ← חיים ענה "2א" (בחר מודעה)
//   action "createAd":   { customerId, title, files }  ← חיים ענה "1 חדשה" (מודעה חדשה,
//     בלי מחיר, סטטוס "התקבלה", בגיליון הקרוב — את המחיר והגודל חיים משלים)
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
  const ads = await sb(`ads?select=id,title,issue_id,status,price_item_id&customer_id=eq.${c.id}&issue_id=in.(${issues.map(i => i.id).join(",")})&status=not.in.(cancelled,rejected,published)`);
  if (!ads.length) return { match: false, reason: "no_open_ad", customer: c.name, customerId: c.id };
  // הגיליון הקרוב ביותר שיש בו מודעה ללקוח
  const nearest = issues.find(i => ads.some(a => a.issue_id === i.id));
  const inNearest = ads.filter(a => a.issue_id === nearest.id);
  if (inNearest.length !== 1) {
    const pl = {}; (await sb("price_list?select=id,name")).forEach(p => pl[p.id] = p.name);
    return { match: false, reason: "several_ads", customer: c.name, customerId: c.id, issue: nearest.issue_number,
      candidates: inNearest.map(a => ({ adId: a.id, title: [a.title, pl[a.price_item_id]].filter(Boolean).join(" · ") || "מודעה #" + a.id })) };
  }
  const ad = inNearest[0];
  const uploads = await makeUploads(ad.id, b.files);
  return { match: true, adId: ad.id, customer: c.name, issue: nearest.issue_number,
    label: `${c.name}${ad.title ? " · " + ad.title : ""} (גיליון ${nearest.issue_number})`, uploads };
}

async function makeUploads(adId, files) {
  const out = [];
  for (const f of (Array.isArray(files) ? files : []).slice(0, 10)) {
    const path = `beni/${adId}/${Date.now()}_${out.length}_${safeKey(f.name)}`;
    out.push({ name: String(f.name || "file"), path, url: await signUpload(path) });
  }
  return out;
}

// חיים בחר מודעה מסוימת — מוודאים שהיא של אותו לקוח ועדיין פתוחה
async function uploadsFor(b) {
  const adId = parseInt(b.adId, 10), customerId = parseInt(b.customerId, 10);
  if (!adId || !customerId) return { ok: false, error: "bad_request" };
  const ads = await sb(`ads?select=id,title,customer_id,status&id=eq.${adId}`);
  const ad = ads[0];
  if (!ad || ad.customer_id !== customerId) return { ok: false, error: "ad_not_of_customer" };
  if (["cancelled", "rejected", "published"].includes(ad.status)) return { ok: false, error: "ad_closed" };
  return { ok: true, adId, uploads: await makeUploads(adId, b.files) };
}

// "חדשה": מודעה חדשה בגיליון הקרוב, בלי מחיר (חיים משלים) — כמו הוספה ידנית
async function createAd(b) {
  const customerId = parseInt(b.customerId, 10);
  if (!customerId) return { ok: false, error: "bad_request" };
  const custs = await sb(`customers?select=id,name,agent_id&id=eq.${customerId}`);
  if (!custs.length) return { ok: false, error: "no_customer" };
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const issues = await sb(`issues?select=id,issue_number&publish_date=gte.${today}&order=publish_date.asc&limit=1`);
  if (!issues.length) return { ok: false, error: "no_open_issue" };
  const admin = await sb("profiles?select=id&role=eq.admin&limit=1");
  const rec = { customer_id: customerId, issue_id: issues[0].id, title: String(b.title || "").slice(0, 120) || null,
    status: "received", price: 0, discount: 0, source: "manual",
    notes: "נפתחה ע\"י בני מתוך מייל של הלקוח — להשלים גודל ומחיר" };
  if (custs[0].agent_id) rec.agent_id = custs[0].agent_id;
  if (admin.length) rec.created_by = admin[0].id;
  const ins = async body => fetch(`${SUPABASE_URL}/rest/v1/ads`, { method: "POST", headers: { ...H(), "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
  let r = await ins(rec);
  if (!r.ok) { const r2 = { ...rec }; delete r2.notes; r = await ins(r2); } // עמודה אופציונלית שחסרה במופע
  if (!r.ok) throw new Error(`ads ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const ad = (await r.json())[0];
  return { ok: true, adId: ad.id, issue: issues[0].issue_number, customer: custs[0].name, uploads: await makeUploads(ad.id, b.files) };
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
    if (b.action === "uploadsFor") return json(200, await uploadsFor(b));
    if (b.action === "createAd") return json(200, await createAd(b));
    return json(400, { error: "bad_action" });
  } catch (e) {
    console.error("beni-attach", e);
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};

exports._test = { safeKey, match, register, uploadsFor, createAd };
