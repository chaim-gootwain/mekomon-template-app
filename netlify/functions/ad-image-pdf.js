// netlify/functions/ad-image-pdf.js
// -----------------------------------------------------------------------------
// עטיפת מודעה שהיא תמונה (JPG/PNG) בקובץ PDF של עמוד אחד — בשרת.
//
// למה: חיים עובד מאחורי מסנן אינטרנט (אתרוג) שמחליף תמונות בגרסה מפוקסלת בדרך
// לדפדפן. הרכבת ה-PDF לדפוס רצה בדפדפן ומורידה את קבצי המודעות — כך תמונה
// מפוקסלת נכנסה לקובץ הדפוס. כאן השרת קורא את הקובץ המקורי מהאחסון, עוטף אותו
// כמו שהוא (ה-JPEG נשמר בתוך ה-PDF בלי דחיסה מחדש; PNG נשמר ללא אובדן),
// ושומר ב-ad-files/wrapped/<הנתיב המקורי>.pdf. הדפדפן מוריד את ה-PDF.
// בקשה מפורשת של חיים (בעל ההגנה), לקבצי המודעות של העסק בלבד.
// הצד בדפדפן: _pibAdFileBytes ב-js/issue-print.js (בתבנית; במופע בלי הפונקציה —
// 404 והורדה ישירה).
//
// Request: POST /.netlify/functions/ad-image-pdf
//   headers: { authorization: "Bearer <access token של המשתמש>" }
//   body: { path: "<storage_path מטבלת ad_files>" }
// Response: { ok:true, path:"wrapped/....pdf" }
// הרשאה: משתמש פעיל בתפקיד admin/editor/sales/graphics, והנתיב חייב להופיע ב-ad_files.
// env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// -----------------------------------------------------------------------------

const { PDFDocument, degrees } = require("../lib/vendor/pdf-lib.min.js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROLES = ["admin", "editor", "sales", "graphics"];

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
const SR = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const encPath = p => String(p).split("/").map(encodeURIComponent).join("/");

/* סיבוב תצוגה מתג EXIF של JPG (מעלות, עם כיוון השעון) — כמו pibJpegRotation בדפדפן */
function jpegRotation(b) {
  try {
    if (b[0] !== 0xFF || b[1] !== 0xD8) return 0;
    let i = 2;
    while (i + 4 < b.length && b[i] === 0xFF) {
      const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (mk === 0xE1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        const t = i + 10, le = b[t] === 0x49;
        const u16 = o => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
        const u32 = o => le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        const ifd = t + u32(t + 4), n = u16(ifd);
        for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return { 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 }[u16(e + 8)] || 0; }
        return 0;
      }
      if (mk === 0xDA) break;
      i += 2 + len;
    }
  } catch (e) { }
  return 0;
}

/* תמונה → PDF של עמוד אחד בגודל התמונה (נקודה לפיקסל; היחס הוא מה שקובע בהרכבה) */
async function wrapImage(bytes) {
  const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (!isJpg && !isPng) throw new Error("not an image");
  const doc = await PDFDocument.create();
  const img = isJpg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  const rot = isJpg ? jpegRotation(bytes) : 0;
  if (rot) page.setRotation(degrees(rot));
  return doc.save();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method" });
  try {
    const token = String(event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json(401, { ok: false, error: "unauthorized" });
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${token}` } });
    const user = ur.ok ? await ur.json() : null;
    if (!user || !user.id) return json(401, { ok: false, error: "unauthorized" });
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role,active&id=eq.${user.id}`, { headers: SR() });
    const [prof] = pr.ok ? await pr.json() : [];
    if (!prof || !prof.active || !ROLES.includes(prof.role)) return json(403, { ok: false, error: "forbidden" });

    const body = JSON.parse(event.body || "{}") || {};
    const path = String(body.path || "");
    if (!path || path.includes("..") || path.startsWith("/") || path.startsWith("wrapped/") || !/\.(jpe?g|png)$/i.test(path))
      return json(400, { ok: false, error: "bad-path" });
    // רק קובץ שרשום כקובץ מודעה
    const fr = await fetch(`${SUPABASE_URL}/rest/v1/ad_files?select=id&storage_path=eq.${encodeURIComponent(path)}&limit=1`, { headers: SR() });
    const rows = fr.ok ? await fr.json() : [];
    if (!rows.length) return json(404, { ok: false, error: "not-an-ad-file" });

    const dr = await fetch(`${SUPABASE_URL}/storage/v1/object/ad-files/${encPath(path)}`, { headers: SR() });
    if (!dr.ok) return json(502, { ok: false, error: "download", status: dr.status });
    const pdf = await wrapImage(new Uint8Array(await dr.arrayBuffer()));

    const out = `wrapped/${path}.pdf`;
    const upr = await fetch(`${SUPABASE_URL}/storage/v1/object/ad-files/${encPath(out)}`, {
      method: "POST",
      headers: { ...SR(), "content-type": "application/pdf", "x-upsert": "true", "cache-control": "no-cache" },
      body: Buffer.from(pdf),
    });
    if (!upr.ok) return json(502, { ok: false, error: "upload", status: upr.status, detail: (await upr.text()).slice(0, 200) });
    return json(200, { ok: true, path: out });
  } catch (e) {
    return json(500, { ok: false, error: "server", detail: String(e.message || e).slice(0, 200) });
  }
};

exports._test = { wrapImage, jpegRotation };
