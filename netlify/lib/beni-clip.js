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

// opts: extraPages — עמודים נוספים שחיים ביקש (למשל השער); onlyExtra — רק אותם, בלי הגזיר;
//       issueNumber — גיליון מסוים (אחרת: האחרון שיצא לאור ויש בו מודעה של הלקוח)
// מחזיר { ok, issue, pages, what, email } או { ok:false, error } בעברית
async function sendClip(customerId, opts = {}) {
  customerId = parseInt(customerId, 10);
  if (!customerId) return { ok: false, error: "לא זוהה לקוח" };
  const extra = (opts.extraPages || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 200).slice(0, 8);
  const onlyExtra = !!opts.onlyExtra && extra.length > 0;
  const [cust] = await sb(`customers?select=name,email&id=eq.${customerId}`);
  const email = String((cust && cust.email) || "").trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "אין ללקוח כתובת מייל תקינה בכרטיס" };
  const ads = await sb(`ads?select=issue_id,page_number&customer_id=eq.${customerId}&page_number=not.is.null&status=not.in.(cancelled,rejected)&limit=500`);
  const T = israelToday();
  let issue;
  if (opts.issueNumber) {
    [issue] = await sb(`issues?select=id,issue_number,pdf_path,publish_date&issue_number=eq.${parseInt(opts.issueNumber, 10)}&limit=1`);
    if (!issue || !issue.pdf_path || !(issue.publish_date <= T)) return { ok: false, error: `לגיליון ${opts.issueNumber} אין PDF של גיליון שיצא לאור` };
  } else {
    if (!ads.length && !onlyExtra) return { ok: false, error: "אין ללקוח מודעה משובצת בעמוד באף גיליון" };
    const ids = [...new Set(ads.map(a => a.issue_id))].slice(-150);
    const q = ids.length && !onlyExtra ? `&id=in.(${ids.join(",")})` : "";
    [issue] = await sb(`issues?select=id,issue_number,pdf_path,publish_date${q}&pdf_path=not.is.null&publish_date=lte.${T}&order=publish_date.desc&limit=1`);
    if (!issue) return { ok: false, error: "לא מצאתי גיליון שיצא לאור עם PDF" + (onlyExtra ? "" : " ועם מודעה שלו") };
  }
  const own = onlyExtra ? [] : ads.filter(a => a.issue_id === issue.id).map(a => a.page_number);
  if (!own.length && !extra.length) return { ok: false, error: `אין לו מודעה משובצת בגיליון ${issue.issue_number}` };
  const pages = [...new Set(own.concat(extra))].sort((a, b) => a - b);
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/issues-archive/${issue.pdf_path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  if (!r.ok) return { ok: false, error: `הורדת PDF הגיליון נכשלה (${r.status})` };
  const { bytes, used } = await clipPdf(new Uint8Array(await r.arrayBuffer()), pages);
  if (!bytes) return { ok: false, error: "מספרי העמודים מחוץ לטווח ה-PDF" };
  const ownUsed = used.filter(n => own.includes(n)), extraUsed = used.filter(n => !own.includes(n));
  const what = [ownUsed.length ? `גזיר הפרסום (עמ' ${ownUsed.join(", ")})` : "", extraUsed.length ? `עמ' ${extraUsed.join(", ")}` : ""].filter(Boolean).join(" + ");
  const intro = ownUsed.length ? `מצורף גזיר הפרסום שלך מגיליון ${issue.issue_number} (עמוד ${ownUsed.join(", ")})` : `מצורפים עמודים מגיליון ${issue.issue_number}`;
  await sendMail(email, `${ownUsed.length ? "גזיר הפרסום שלך" : "עמודים מהעיתון"} — גיליון ${issue.issue_number} · @@PAPER_NAME@@`,
    `שלום ${cust.name || ""},\n\n${intro}${ownUsed.length && extraUsed.length ? `, ואיתו עמוד ${extraUsed.join(", ")}` : ""}.\nתודה שאתם מפרסמים ב@@PAPER_NAME@@!\n\nבברכה,\nבני – @@PAPER_NAME@@`,
    [{ name: `גיליון_${issue.issue_number}_עמודים_${used.join("-")}.pdf`, type: "application/pdf", data: bytes }]);
  return { ok: true, issue: issue.issue_number, pages: used, what, email };
}

module.exports = { sendClip, clipPdf };
