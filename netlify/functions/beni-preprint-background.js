// netlify/functions/beni-preprint-background.js
// -----------------------------------------------------------------------------
// "בני" — בדיקת גיליון לפני דפוס, אוטומטית (שלב 1, אוטומציה).
//
// הזרימה: הגרפיקאית מעלה "גליון 307.pdf" לתיקיית הדרייב "גיליונות לדפוס" →
// סקריפט Apps Script (beni/beni-preprint.gs) מזהה קובץ חדש, פותח לו קישור
// זמני וקורא לפונקציה הזו → הפונקציה מורידה את הקובץ, מנתחת, שומרת דוח
// ב-settings (pp_report_<מספר>) ושולחת מייל מתיבת העסק דרך send-email:
//   - יש בעיות  → לגרפיקאית רשימת תיקונים + עותק לחיים
//   - הכל תקין → לחיים בלבד: "מוכן לדפוס" (האישור הסופי נשאר שלו)
// הקובץ לא נשמר בשום מקום — מעובד בזיכרון ונזרק.
//
// Background function (סיומת -background): Netlify מחזיר 202 מיד, והעבודה
// רצה עד 15 דקות — מספיק לגיליון של 40+ מ"ב.
// הלוגיקה מקבילה ל-js/preprint-check.js (הבדיקה הידנית בדפדפן) — שינוי ספים
// צריך להיעשות בשני המקומות.
//
// Netlify env (קיימים כבר עבור beni-insert):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BENI_INSERT_TOKEN
//
// Request: POST /.netlify/functions/beni-preprint-background
//   headers: { "x-beni-token": "<token>", "content-type": "application/json" }
//   body: { url, fileName, issueNumber, designerEmail, ownerEmail, folderUrl? }
// -----------------------------------------------------------------------------

const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.BENI_INSERT_TOKEN;
// send-email מקבל קריאה פנימית רק עם מפתח ה-service_role הזהה לזה שבסביבת Supabase
// (מפתח legacy בפורמט JWT). אם SUPABASE_SERVICE_ROLE_KEY ב-Netlify הוא מפתח בפורמט
// אחר, שומרים כאן את מפתח ה-legacy: Supabase → Settings → API Keys → Legacy → service_role.
const EMAIL_KEY = process.env.SUPABASE_LEGACY_SERVICE_ROLE_KEY || SERVICE_ROLE;

// כיול לפי גיליון 306 (תקין, נקבע כסטנדרט 4.10.2026) — זהה ל-preprint-check.js
const PP_DPI_BAD = 80, PP_DPI_WARN = 95, PP_DPI_BG_BAD = 40, PP_DPI_COMPRESSED = 150;
const PP_BG_COVER = 0.6, PP_STRIP_CM = 1, PP_MIN_AREA_PT2 = 28 * 28;
const PP_OK_STATUSES = ["approved", "placed", "published"];
const STATUS_HE = { received: "התקבלה", in_graphics: "בגרפיקה", proof: "בפרוף", committee: "בוועדה",
  approved: "מאושרת", placed: "משובצת", published: "פורסמה" };

let _pdfjs = null;
function pdfjs() {
  if (_pdfjs) return _pdfjs;
  // אותו pdf.js שהאתר משתמש בו (js/vendor) — נכלל בפונקציה דרך included_files ב-netlify.toml
  const base = [path.join(__dirname, "js/vendor"), path.join(process.cwd(), "js/vendor"),
    path.join(__dirname, "../../js/vendor")].find(d => { try { require.resolve(path.join(d, "pdf.min.js")); return true; } catch { return false; } });
  if (!base) throw new Error("pdf.js not bundled (js/vendor/pdf.min.js)");
  _pdfjs = require(path.join(base, "pdf.min.js"));
  _pdfjs.GlobalWorkerOptions.workerSrc = path.join(base, "pdf.worker.min.js");
  return _pdfjs;
}

/* ---------- Supabase REST ---------- */
async function sb(pathq) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  if (!r.ok) throw new Error(`supabase ${r.status} ${pathq.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function saveSetting(key, value) {
  await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value }),
  });
}
/* ---------- מייל מתיבת העסק ----------
   אם מוגדר GMAIL_APP_PASSWORD ב-Netlify — שליחה ישירה ב-SMTP של Gmail מתיבת העסק
   (בלי send-email, שדוחה קריאה פנימית מכאן ב-401). אחרת — דרך send-email כמו קודם.
   SMTP מינימלי על tls של Node, בלי תלויות: TLS מאומת רגיל (פורט 465). */
const GMAIL_USER = process.env.GMAIL_USER || "imanuel.sheli@gmail.com";
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // גוגל מציגה את הסיסמה עם רווחים
const SMTP_HOST = process.env.BENI_SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = +(process.env.BENI_SMTP_PORT || 465);
const FROM_NAME = "בני – @@PAPER_NAME@@";

const b64 = s => Buffer.from(String(s), "utf8").toString("base64");
const encWord = s => `=?UTF-8?B?${b64(s)}?=`;

function smtpSend(to, subject, body) {
  const tls = require("tls");
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    sock.setEncoding("utf8");
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error("smtp timeout")); });
    let buf = "", waiter = null;
    sock.on("data", d => { buf += d; check(); });
    sock.on("error", e => reject(e));
    function check() {
      // תשובה שלמה = שורה אחרונה בפורמט "250 ..." (רווח אחרי הקוד, לא מקף)
      const m = buf.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (m && waiter) { const w = waiter, text = buf; waiter = null; buf = ""; w(+m[2], text); }
    }
    const expect = (codes) => new Promise((res, rej) => { waiter = (code, text) => codes.includes(code) ? res(text) : rej(new Error(`smtp ${code}: ${text.trim().slice(0, 200)}`)); check(); });
    const cmd = (line, codes) => { sock.write(line + "\r\n"); return expect(codes); };
    const msgId = `<beni-${Date.now()}-${Math.random().toString(36).slice(2)}@imanuel-sheli>`;
    const data = [
      `From: ${encWord(FROM_NAME)} <${GMAIL_USER}>`, `To: <${to}>`, `Reply-To: <${GMAIL_USER}>`,
      `Subject: ${encWord(subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${msgId}`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
      b64(body).replace(/.{1,76}/g, "$&\r\n").trimEnd(),
    ].join("\r\n");
    (async () => {
      await expect([220]);
      await cmd("EHLO imanuel-sheli.netlify.app", [250]);
      await cmd("AUTH PLAIN " + Buffer.from(`\u0000${GMAIL_USER}\u0000${GMAIL_PASS}`).toString("base64"), [235]);
      await cmd(`MAIL FROM:<${GMAIL_USER}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd("DATA", [354]);
      await cmd(data + "\r\n.", [250]);
      sock.write("QUIT\r\n"); sock.end();
    })().then(resolve, e => { sock.destroy(); reject(e); });
  });
}

async function sendEmail(to, subject, body) {
  if (GMAIL_PASS) return smtpSend(to, subject, body);
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EMAIL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
  });
  if (!r.ok) throw new Error(`send-email ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/* ---------- ניתוח ה-PDF (מקביל ל-_ppPageMap / _ppPageImages / _ppAnalyzeFile) ---------- */
function pageImages(OPS, ol) {
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [], out = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const pw = fn === OPS.paintImageXObject ? args[1] : args[0] && args[0].width;
      const ph = fn === OPS.paintImageXObject ? args[2] : args[0] && args[0].height;
      if (!pw || !ph) continue;
      const wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);
      if (wPt * hPt < PP_MIN_AREA_PT2) continue;
      const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
      const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
      out.push({ dpi: Math.round(Math.min(pw / (wPt / 72), ph / (hPt / 72))), px: pw + "×" + ph,
        cmW: (wPt / 72 * 2.54).toFixed(1), cmH: (hPt / 72 * 2.54).toFixed(1),
        x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  }
  return out;
}

async function analyzePdf(bytes) {
  const lib = pdfjs();
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  const images = [], text = {}, edge = {}; let n = 1;
  try {
    for (let idx = 0; idx < doc.numPages; idx++) {
      const page = await doc.getPage(idx + 1);
      const [vx0, vy0, vx1, vy1] = page.view, w = vx1 - vx0, h = vy1 - vy0;
      const halves = (w / h > 1.15 && (page.rotate || 0) % 180 === 0) ? [n, n + 1] : [n]; // כפולה: ימין = העמוד הנמוך (RTL)
      n += halves.length;
      const pick = x => halves.length === 1 ? halves[0] : halves[(x - vx0) / w >= 0.5 ? 0 : 1];
      const onPage = pageImages(lib.OPS, await page.getOperatorList()).map(im => {
        const pageArea = (w / halves.length) * h, cover = ((im.x1 - im.x0) * (im.y1 - im.y0)) / pageArea;
        const beyond = im.x0 < vx0 - 14 || im.y0 < vy0 - 14 || im.x1 > vx1 + 14 || im.y1 > vy1 + 14;
        const kind = Math.min(+im.cmW, +im.cmH) < PP_STRIP_CM ? "strip" : (cover > PP_BG_COVER || beyond) ? "background" : "content";
        return { ...im, page: pick((im.x0 + im.x1) / 2), kind };
      });
      onPage.forEach((a, i) => { // שכבת רקע: תמונה אחרת צוירה מעליה על 25%+ משטחה
        if (a.kind !== "content") return;
        const area = (a.x1 - a.x0) * (a.y1 - a.y0);
        if (onPage.slice(i + 1).some(b => { const ow = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          return ow > 0 && oh > 0 && (ow * oh) / area >= 0.25; })) a.kind = "background";
      });
      images.push(...onPage);
      (await page.getTextContent()).items.forEach(it => {
        const pg = pick(it.transform ? it.transform[4] : vx0);
        text[pg] = (text[pg] || "") + " " + it.str;
        const ry = ((it.transform ? it.transform[5] : vy0) - vy0) / h; // שוליים עליונים/תחתונים — כותרת ופוטר
        if (ry < 0.08 || ry > 0.92) edge[pg] = (edge[pg] || "") + " " + it.str;
      });
      page.cleanup();
    }
    return { pageCount: n - 1, images, text, edge };
  } finally { await doc.destroy(); }
}

/* ---------- ממצאים ---------- */
function plFraction(pl) {
  if (pl && pl.area_fraction != null && !isNaN(pl.area_fraction)) return Number(pl.area_fraction);
  const nm = (pl && pl.name) || "";
  if (/שמינית/.test(nm)) return 0.125; if (/רבע\s+עמוד/.test(nm)) return 0.25; if (/חצי\s+עמוד/.test(nm)) return 0.5;
  return 1;
}

async function findings(issueNumber, pdf) {
  const bad = [], warn = [];
  const issues = await sb(`issues?select=id,issue_number&issue_number=eq.${issueNumber}`);
  const issue = issues[0];
  if (!issue) warn.push({ page: 0, ownerOnly: true, msg: `גיליון ${issueNumber} לא נמצא במערכת — נבדקה רק איכות הקובץ, בלי התאמה לעימוד` });
  let ads = [];
  if (issue) {
    ads = await sb(`ads?select=id,customer_id,title,page_number,status,price_item_id,is_system&issue_id=eq.${issue.id}&status=not.in.(cancelled,rejected)`);
    const ids = ads.map(a => a.id), custIds = [...new Set(ads.map(a => a.customer_id).filter(Boolean))];
    const [files, custs, prices] = await Promise.all([
      ids.length ? sb(`ad_files?select=ad_id&kind=in.(design,source)&ad_id=in.(${ids.join(",")})`) : [], // גם קובץ שהלקוח שלח (בני מצרף מהמייל)
      custIds.length ? sb(`customers?select=id,name,phone&id=in.(${custIds.join(",")})`) : [],
      sb("price_list?select=id,name,area_fraction"),
    ]);
    const hasDesign = new Set(files.map(f => f.ad_id)), cust = {}; custs.forEach(c => cust[c.id] = c);
    const price = {}; prices.forEach(p => price[p.id] = p);
    const label = a => a.is_system ? "🏛 " + (a.title || "תוכן מערכת") : ((cust[a.customer_id] || {}).name || a.title || "מודעה");
    const fill = {};
    ads.forEach(a => {
      const placed = a.page_number > 0;
      if (placed) fill[a.page_number] = (fill[a.page_number] || 0) + (a.price_item_id ? plFraction(price[a.price_item_id]) : 0.25);
      if (placed && !PP_OK_STATUSES.includes(a.status)) bad.push({ page: a.page_number, msg: `${label(a)} — משובצת בעמוד ${a.page_number} אבל לא אושרה בוועדה (${STATUS_HE[a.status] || a.status})` });
      else if (!placed && a.status === "approved") warn.push({ page: 0, msg: `${label(a)} — אושרה ולא שובצה בעימוד` });
      else if (placed && !a.is_system && !hasDesign.has(a.id)) warn.push({ page: a.page_number, msg: `${label(a)} — בעמוד ${a.page_number}, אין קובץ מודעה במערכת` });
    });
    Object.keys(fill).forEach(p => { if (fill[p] > 1.001) warn.push({ page: +p, msg: `עמוד ${p} מלא ב-${Math.round(fill[p] * 100)}% לפי העימוד` }); });
    // מודעה שנמצאה בטקסט של עמוד אחר מהמתוכנן (שם / 7 ספרות אחרונות של הטלפון)
    const norm = s => String(s || "").replace(/["'״׳\-\s]+/g, "");
    ads.filter(a => a.page_number > 0 && !a.is_system).forEach(a => {
      const c = cust[a.customer_id] || {}, name = norm(c.name), phone = String(c.phone || "").replace(/\D/g, "").slice(-7);
      const hit = t => (name.length >= 3 && norm(t).includes(name)) || (phone.length === 7 && String(t || "").replace(/\D/g, "").includes(phone));
      if (hit(pdf.text[a.page_number])) return;
      const other = Object.keys(pdf.text).find(p => +p !== a.page_number && hit(pdf.text[p]));
      if (other) bad.push({ page: a.page_number, msg: `${label(a)} — אמורה להיות בעמוד ${a.page_number} אבל נמצאה בעמוד ${other}` });
    });
    const maxPage = Math.max(0, ...ads.filter(a => a.page_number > 0).map(a => a.page_number));
    if (maxPage > pdf.pageCount) bad.push({ page: maxPage, msg: `בעימוד יש ${maxPage} עמודים אבל בקובץ רק ${pdf.pageCount}` });
  }
  // מספר גיליון בכותרת/פוטר שלא תואם (שכחו לעדכן מגיליון קודם) — רק בשולי העמוד, לא בגוף הכתבות.
  // מסוכם לשורה אחת לכל מספר שגוי (בדרך כלל זו תבנית אחת שחוזרת בכל העמודים).
  const wrongNum = {};
  Object.keys(pdf.edge).forEach(p => {
    const m = String(pdf.edge[p]).match(/גי?ליון\s*(\d{2,4})/);
    if (m && +m[1] !== +issueNumber) (wrongNum[m[1]] = wrongNum[m[1]] || []).push(+p);
  });
  Object.keys(wrongNum).forEach(num => {
    const pages = wrongNum[num].sort((a, b) => a - b);
    const where = pages.length > 3 ? `ב-${pages.length} עמודים (${pages[0]}–${pages[pages.length - 1]})` : `בעמוד ${pages.join(", ")}`;
    bad.push({ page: pages[0], msg: `${where} כתוב בשולי העמוד "גיליון ${num}" במקום ${issueNumber}` });
  });
  // רזולוציה
  const imgs = pdf.images, low = imgs.filter(im => im.dpi < PP_DPI_COMPRESSED);
  if (imgs.length >= 10 && low.length / imgs.length > 0.5) {
    bad.push({ page: 0, msg: `${low.length} מתוך ${imgs.length} התמונות מתחת ל-${PP_DPI_COMPRESSED} DPI — נראה שזה קובץ דחוס ולא קובץ הדפוס` });
  } else {
    const isBad = im => im.kind === "background" ? im.dpi < PP_DPI_BG_BAD : im.dpi < PP_DPI_BAD;
    const isWarn = im => im.kind === "content" && im.dpi < PP_DPI_WARN;
    const per = {};
    imgs.filter(im => im.kind !== "strip" && (isBad(im) || isWarn(im))).forEach(im => {
      const g = per[im.page] || (per[im.page] = { bad: 0, warn: 0, worst: im });
      if (isBad(im)) g.bad++; else g.warn++;
      if (im.dpi < g.worst.dpi) g.worst = im;
    });
    Object.keys(per).forEach(p => {
      const g = per[p], w = g.worst, worst = `הגרועה: ${w.cmW}×${w.cmH} ס"מ, ${w.dpi} DPI`;
      if (g.bad) bad.push({ page: +p, msg: `עמוד ${p} — ${g.bad} תמונות יצאו מפוקסלות בדפוס; ${worst}` });
      else warn.push({ page: +p, msg: `עמוד ${p} — ${g.warn} תמונות ברזולוציה גבולית; ${worst}` });
    });
  }
  const byPage = (x, y) => (x.page || 0) - (y.page || 0);
  return { bad: bad.sort(byPage), warn: warn.sort(byPage), adsChecked: ads.length, hasIssue: !!issue };
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405 };
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  if (!SUPABASE_URL || !SERVICE_ROLE) { console.error("beni-preprint: server not configured"); return { statusCode: 500 }; }

  let b; try { b = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400 }; }
  const issueNumber = parseInt(b.issueNumber, 10);
  const { url, fileName, designerEmail, ownerEmail, folderUrl } = b;
  if (!url || !/^https:\/\/(drive\.usercontent\.google\.com|drive\.google\.com)\//.test(url) || !issueNumber || !ownerEmail) {
    console.error("beni-preprint: bad request", { hasUrl: !!url, issueNumber });
    return { statusCode: 400 };
  }

  const key = `pp_report_${issueNumber}`;
  let stage = "download", report = null; // השלב נרשם בשגיאה — לאבחון דרך beni-preprint-status
  try {
    // 1. הורדה לזיכרון (לא נשמר בשום מקום)
    const r = await fetch(url, { redirect: "follow" });
    const buf = new Uint8Array(await r.arrayBuffer());
    const head = Buffer.from(buf.slice(0, 5)).toString();
    if (!r.ok || head !== "%PDF-") throw new Error(`download failed (${r.status}, ${head === "%PDF-" ? "pdf" : "not a pdf"}) — האם הקובץ שותף?`);
    const sizeMB = (buf.length / 1e6).toFixed(1);

    // 2. ניתוח + ממצאים
    stage = "analyze";
    const pdf = await analyzePdf(buf);
    stage = "findings";
    const f = await findings(issueNumber, pdf);
    const ok = f.bad.length === 0;
    report = { at: new Date().toISOString(), file: fileName, sizeMB, pages: pdf.pageCount, images: pdf.images.length,
      ok, bad: f.bad.map(x => x.msg), warn: f.warn.map(x => x.msg) };
    await saveSetting(key, JSON.stringify(report));

    // 3. מיילים מתיבת העסק
    stage = "email";
    const line = x => "• " + x.msg;
    const summary = `נבדקו ${pdf.pageCount} עמודים ו-${pdf.images.length} תמונות` + (f.hasIssue ? `, ${f.adsChecked} מודעות בעימוד.` : ".");
    if (!ok && designerEmail) {
      await sendEmail(designerEmail, `גיליון ${issueNumber} — תיקונים לפני דפוס`,
        `שלום,\n\nבדקתי את קובץ הדפוס של גיליון ${issueNumber} (${fileName}).\n${summary}\n\n` +
        `חייב תיקון:\n${f.bad.map(line).join("\n")}\n` +
        (f.warn.some(x => !x.ownerOnly) ? `\nלבדיקה:\n${f.warn.filter(x => !x.ownerOnly).map(line).join("\n")}\n` : "") +
        `\nאחרי התיקון — נא להעלות את הקובץ המתוקן לאותה תיקייה${folderUrl ? ` (${folderUrl})` : ""}, ואבדוק שוב.\n\nתודה,\nבני — @@PAPER_NAME@@\n(עוזר אוטומטי)`);
    }
    await sendEmail(ownerEmail, ok ? `✅ גיליון ${issueNumber} עבר בדיקה — מחכה לאישורך לדפוס` : `⛔ גיליון ${issueNumber} — ${f.bad.length} בעיות, נשלח לגרפיקאית`,
      `${ok ? "לא נמצאו בעיות חוסמות." : `נמצאו ${f.bad.length} בעיות${designerEmail ? " ורשימת תיקונים נשלחה לגרפיקאית" : ""}.`}\n${summary}\n\n` +
      (f.bad.length ? `חייב תיקון:\n${f.bad.map(line).join("\n")}\n\n` : "") +
      (f.warn.length ? `לבדיקה:\n${f.warn.map(line).join("\n")}\n\n` : "") +
      `האישור הסופי "מוכן לדפוס" — במערכת: גיליון ← הפקה ודפוס ← ✅ בדיקה לפני דפוס.\n\nבני`);
    report.emailed = !ok && designerEmail ? "designer+owner" : "owner";
    await saveSetting(key, JSON.stringify(report));
    console.log("beni-preprint: done", { issueNumber, ok, bad: f.bad.length, warn: f.warn.length, sizeMB });
    return { statusCode: 200 };
  } catch (e) {
    console.error("beni-preprint: failed", e);
    try {
      await saveSetting(key, JSON.stringify({ ...(report || {}), at: new Date().toISOString(), file: fileName, error: `${stage}: ${String(e.message || e).slice(0, 300)}` }));
      await sendEmail(ownerEmail, `⚠️ בני לא הצליח לבדוק את גיליון ${issueNumber}`,
        `ניסיתי לבדוק את ${fileName} ונכשלתי:\n${String(e.message || e).slice(0, 300)}\n\nאפשר להריץ ידנית במערכת: גיליון ← הפקה ודפוס ← ✅ בדיקה לפני דפוס.\n\nבני`);
    } catch (e2) { console.error("beni-preprint: failure report failed", e2); }
    return { statusCode: 500 };
  }
};

// לבדיקות מקומיות
exports._test = { analyzePdf, findings, pageImages };
