// netlify/lib/beni-mail.js
// -----------------------------------------------------------------------------
// "בני" — שליחת מייל מתיבת העסק ישירות ב-SMTP של Gmail (smtp.gmail.com:465, TLS מאומת),
// בלי תלויות. send-email ב-Supabase דוחה קריאה פנימית מ-Netlify (401), לכן לא דרכו.
// env: GMAIL_APP_PASSWORD (סיסמת אפליקציה של imanuel.sheli), GMAIL_USER (ברירת מחדל imanuel.sheli@gmail.com)
// -----------------------------------------------------------------------------
const tls = require("tls");

const GMAIL_USER = process.env.GMAIL_USER || "imanuel.sheli@gmail.com";
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const SMTP_HOST = process.env.BENI_SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = +(process.env.BENI_SMTP_PORT || 465);
const FROM_NAME = "בני – @@PAPER_NAME@@";

const b64 = s => Buffer.from(String(s), "utf8").toString("base64");
const encWord = s => `=?UTF-8?B?${b64(s)}?=`;

function sendMail(to, subject, body) {
  if (!GMAIL_PASS) return Promise.reject(new Error("GMAIL_APP_PASSWORD missing"));
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    sock.setEncoding("utf8");
    sock.setTimeout(30000, () => { sock.destroy(); reject(new Error("smtp timeout")); });
    let buf = "", waiter = null;
    sock.on("data", d => { buf += d; check(); });
    sock.on("error", e => reject(e));
    function check() {
      const m = buf.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (m && waiter) { const w = waiter, text = buf; waiter = null; buf = ""; w(+m[2], text); }
    }
    const expect = codes => new Promise((res, rej) => { waiter = (code, text) => codes.includes(code) ? res(text) : rej(new Error(`smtp ${code}: ${text.trim().slice(0, 200)}`)); check(); });
    const cmd = (line, codes) => { sock.write(line + "\r\n"); return expect(codes); };
    const data = [
      `From: ${encWord(FROM_NAME)} <${GMAIL_USER}>`, `To: <${to}>`, `Reply-To: <${GMAIL_USER}>`,
      `Subject: ${encWord(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <beni-${Date.now()}-${Math.random().toString(36).slice(2)}@imanuel-sheli>`,
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

module.exports = { sendMail, GMAIL_USER };
