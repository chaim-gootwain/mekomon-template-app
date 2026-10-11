// netlify/lib/beni-clip.js
// -----------------------------------------------------------------------------
// "בני" — שליחת גזיר הפרסום ללקוח (כמו send-clip ב-Supabase, שדורש משתמש מחובר):
// הגיליון האחרון שיצא לאור ויש בו מודעה משובצת ללקוח → חיתוך העמודים מה-PDF של
// הגיליון (issues-archive) → מייל ללקוח מתיבת העסק עם הקובץ מצורף.
// מיפוי עמודים זהה ל-send-clip: דף לרוחב = כפולה (הנמוך בימין), דף לאורך = עמוד בודד.
// -----------------------------------------------------------------------------
const { PDFDocument } = require("./vendor/pdf-lib.min.js");
const { sb, israelToday } = require("./beni-collect-core");
const { sendMail } = require("./beni-mail");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

async function clipPdf(srcBytes, pages) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const pmap = {}; let np = 1;
  for (let i = 0; i < src.getPageCount(); i++) {
    const pg = src.getPage(i), mb = pg.getMediaBox();
    let rot = 0; try { rot = (pg.getRotation() && pg.getRotation().angle) || 0; } catch (_) { }
    if (mb.width / mb.height > 1.15 && rot % 180 === 0) { pmap[np] = { idx: i, half: "right" }; pmap[np + 1] = { idx: i, half: "left" }; np += 2; }
    else { pmap[np] = { idx: i, half: "full" }; np += 1; }
  }
  const out = await PDFDocument.create(), used = [];
  for (const N of pages) {
    const e = pmap[N]; if (!e) continue;
    const [cp] = await out.copyPages(src, [e.idx]);
    if (e.half !== "full") {
      const b = cp.getMediaBox(), x = e.half === "right" ? b.x + b.width / 2 : b.x;
      cp.setMediaBox(x, b.y, b.width / 2, b.height); cp.setCropBox(x, b.y, b.width / 2, b.height);
    }
    out.addPage(cp); used.push(N);
  }
  return { bytes: used.length ? Buffer.from(await out.save()) : null, used };
}

// מחזיר { ok, issue, pages } או { ok:false, error } בעברית
async function sendClip(customerId) {
  customerId = parseInt(customerId, 10);
  if (!customerId) return { ok: false, error: "לא זוהה לקוח" };
  const [cust] = await sb(`customers?select=name,email&id=eq.${customerId}`);
  const email = String((cust && cust.email) || "").trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "אין ללקוח כתובת מייל תקינה בכרטיס" };
  const ads = await sb(`ads?select=issue_id,page_number&customer_id=eq.${customerId}&page_number=not.is.null&status=not.in.(cancelled,rejected)&limit=500`);
  if (!ads.length) return { ok: false, error: "אין ללקוח מודעה משובצת בעמוד באף גיליון" };
  const ids = [...new Set(ads.map(a => a.issue_id))].slice(-150);
  const [issue] = await sb(`issues?select=id,issue_number,pdf_path,publish_date&id=in.(${ids.join(",")})&pdf_path=not.is.null&publish_date=lte.${israelToday()}&order=publish_date.desc&limit=1`);
  if (!issue) return { ok: false, error: "לא מצאתי גיליון שיצא לאור עם PDF ועם מודעה שלו" };
  const pages = [...new Set(ads.filter(a => a.issue_id === issue.id).map(a => a.page_number))].sort((a, b) => a - b);
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/issues-archive/${issue.pdf_path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  if (!r.ok) return { ok: false, error: `הורדת PDF הגיליון נכשלה (${r.status})` };
  const { bytes, used } = await clipPdf(new Uint8Array(await r.arrayBuffer()), pages);
  if (!bytes) return { ok: false, error: "מספרי העמודים מחוץ לטווח ה-PDF" };
  await sendMail(email, `גזיר הפרסום שלך — גיליון ${issue.issue_number} · @@PAPER_NAME@@`,
    `שלום ${cust.name || ""},\n\nמצורף גזיר הפרסום שלך מגיליון ${issue.issue_number} (עמוד ${used.join(", ")}).\nתודה שאתם מפרסמים ב@@PAPER_NAME@@!\n\nבברכה,\nבני – @@PAPER_NAME@@`,
    [{ name: `גזיר_גיליון_${issue.issue_number}.pdf`, type: "application/pdf", data: bytes }]);
  return { ok: true, issue: issue.issue_number, pages: used, email };
}

module.exports = { sendClip, clipPdf };
