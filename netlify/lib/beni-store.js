// netlify/lib/beni-store.js
// -----------------------------------------------------------------------------
// "בני" — הזיכרון בשרת: קבצי JSON ב-bucket פרטי "beni-state" ב-Supabase Storage
// (נוצר אוטומטית; בלי policies — רק service-role ניגש). לא בטבלת settings: האתר טוען
// את כל settings בכל עמוד, ותוכן מיילים לא צריך להגיע לדפדפן של אף אחד.
// כל המצב של בני כאן ולא ב-Apps Script — שינוי ביכולות לא מחייב הדבקה מחדש של הסקריפט.
//   evt/<msgId>.json    מייל מהתיבה שמחכה לטיפול
//   claim/<id>.json     נעילה (העלאה בלי דריסה) — שתי ריצות רקע לא יטפלו באותו דבר
//   op/<id>.json        פעולה ל-Apps Script בתיבה (העלאת קובץ / תשובה בשרשור / תווית)
//   items.json          הפריטים הממוספרים ממייל "קבצי מודעות שלא שייכתי" (+ שטופלו בשבוע האחרון)
// -----------------------------------------------------------------------------
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "beni-state";
const H = (extra = {}) => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, ...extra });
const OBJ = p => `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${p}`;
const safe = s => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, { method: "POST", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
  if (!r.ok) { const t = await r.text(); if (!/exist|duplicate/i.test(t)) throw new Error(`bucket ${r.status}: ${t.slice(0, 150)}`); }
  bucketReady = true;
}

async function put(path, value, upsert = true) {
  await ensureBucket();
  const r = await fetch(OBJ(path), { method: "POST", headers: H({ "content-type": "application/json", "x-upsert": upsert ? "true" : "false", "cache-control": "no-cache, max-age=0" }),
    body: JSON.stringify(value) });
  if (r.ok) return true;
  const t = await r.text();
  if (!upsert && /exist|duplicate|409/i.test(t + r.status)) return false;
  throw new Error(`store ${r.status} ${path}: ${t.slice(0, 150)}`);
}
async function get(path) {
  await ensureBucket();
  // עוקף מטמון: קובץ שמתעדכן (items/status/lock) חייב להיקרא טרי
  const r = await fetch(`${OBJ(path)}?v=${Date.now()}${Math.random().toString(36).slice(2, 6)}`, { headers: H({ "cache-control": "no-cache" }) });
  if (!r.ok) return null;
  return r.json();
}
async function del(paths) {
  if (!paths.length) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }) });
}
// שמות הקבצים בתיקייה → [{ path, created }]
async function list(dir) {
  await ensureBucket();
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, { method: "POST", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ prefix: dir + "/", limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }) });
  if (!r.ok) throw new Error(`list ${r.status}`);
  return (await r.json()).filter(o => o.id).map(o => ({ path: `${dir}/${o.name}`, created: Date.parse(o.created_at) || 0 }));
}
// נעילה: true רק לקורא הראשון
const claim = id => put(`claim/${safe(id)}.json`, { at: Date.now() }, false);

// פעולה ל-Apps Script. then = מה לעשות בשרת אחרי שהיא בוצעה (ר' beni-hub-background)
async function addOp(op, then) {
  const id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
  await put(`op/${id}.json`, { id, op, then: then || null, status: "pending", at: Date.now() });
  return id;
}

// ---------- הפריטים הממוספרים ----------
const WEEK = 7 * 86400e3;
async function getItems() {
  const s = (await get("items.json")) || { seq: 0, items: [] };
  s.items = s.items.filter(i => !i.handledAt || Date.now() - i.handledAt < WEEK);
  return s;
}
const saveItems = s => put("items.json", s);

// ניקוי: נעילות ישנות (שבועיים) — כדי שה-bucket לא יגדל בלי סוף
async function cleanup() {
  const old = (await list("claim")).filter(c => Date.now() - c.created > 14 * 86400e3).map(c => c.path);
  for (let i = 0; i < old.length; i += 100) await del(old.slice(i, i + 100));
}

// יומן החלטות — קובץ חדש לכל רשומה (בלי קריאה-כתיבה), רק קודים ומזהים, בלי תוכן מיילים
async function log(kind, data) {
  try { await put(`log/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`, { at: new Date().toISOString(), kind, ...(data || {}) }); } catch (_) { }
}
async function recentLog(n = 15) {
  const all = (await list("log")).sort((a, b) => a.path < b.path ? 1 : -1);
  const old = all.filter(x => Date.now() - x.created > 14 * 86400e3).map(x => x.path);
  if (old.length) await del(old.slice(0, 100));
  return Promise.all(all.slice(0, n).map(x => get(x.path)));
}

module.exports = { log, recentLog,  put, get, del, list, claim, addOp, getItems, saveItems, cleanup, safe };
