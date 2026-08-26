// ============================================================
// send-clip — שליחת "גזיר" (עמוד המודעה מתוך ה-PDF של הגיליון) במייל ללקוח
// ------------------------------------------------------------
// קלט: { customer_id, issue_id }
// שולף את עמודי המודעות של הלקוח בגיליון, חותך אותם מ-PDF הגיליון
// (issues-archive), ושולח במייל (Gmail SMTP) עם הקובץ מצורף.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}
function toB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for(let i = 0; i < bytes.length; i += chunk)bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return btoa(bin);
}
const _S = {
  err: ""
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const authHeader = req.headers.get("Authorization") || "";
    const { data: userData } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!userData?.user?.id) return json({
      ok: false,
      error: "unauthorized"
    }, 401);
    const { customer_id, issue_id } = await req.json();
    if (!customer_id || !issue_id) return json({
      ok: false,
      error: "missing",
      detail: "חסר לקוח/גיליון"
    }, 400);
    const { data: cust } = await admin.from("customers").select("name,email").eq("id", customer_id).single();
    if (!cust?.email) return json({
      ok: false,
      error: "no-email",
      detail: "ללקוח אין כתובת מייל"
    }, 400);
    const { data: issue } = await admin.from("issues").select("issue_number,pdf_path").eq("id", issue_id).single();
    if (!issue?.pdf_path) return json({
      ok: false,
      error: "no-pdf",
      detail: "עדיין לא הועלה PDF לגיליון"
    }, 400);
    const { data: ads } = await admin.from("ads").select("page_number").eq("customer_id", customer_id).eq("issue_id", issue_id).not("status", "in", '("cancelled","rejected")');
    const pages = [
      ...new Set((ads || []).map((a)=>a.page_number).filter((p)=>p))
    ].sort((a, b)=>a - b);
    if (!pages.length) return json({
      ok: false,
      error: "no-pages",
      detail: "אין עמודים למודעות הלקוח"
    }, 400);
    const { data: file, error: dlErr } = await admin.storage.from("issues-archive").download(issue.pdf_path);
    if (dlErr || !file) return json({
      ok: false,
      error: "pdf-download",
      detail: String(dlErr?.message || "")
    }, 500);
    const srcBytes = new Uint8Array(await file.arrayBuffer());
    const src = await PDFDocument.load(srcBytes);
    const total = src.getPageCount();
    const idxs = pages.map((p)=>p - 1).filter((i)=>i >= 0 && i < total);
    if (!idxs.length) return json({
      ok: false,
      error: "pages-range",
      detail: "מספרי העמודים מחוץ לטווח ה-PDF"
    }, 400);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, idxs);
    copied.forEach((p)=>out.addPage(p));
    const clipBytes = await out.save();
    const b64 = toB64(clipBytes);
    const user = Deno.env.get("GMAIL_USER") || "@@PAPER_EMAIL@@";
    const pass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!pass) return json({
      ok: false,
      error: "no-smtp",
      detail: "לא הוגדר סוד Gmail"
    }, 400);
    const CRLF = String.fromCharCode(13, 10);
    const NL = String.fromCharCode(10);
    const _b64s = (str)=>btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(str))));
    const _wrap = (s)=>s.replace(/.{1,76}/g, function(m) {
        return m + CRLF;
      });
    const _E = "=?UTF-8?B?";
    const _subject = "גזיר הפרסום שלך — גיליון " + issue.issue_number + " · @@PAPER_NAME@@";
    const _fname = "גזיר_גיליון_" + issue.issue_number + ".pdf";
    const _bodyText = [
      "שלום " + (cust.name || "") + ",",
      "",
      "מצורף גזיר הפרסום שלך מגיליון " + issue.issue_number + " (עמוד " + pages.join(", ") + ").",
      "תודה שאתם מפרסמים ב@@PAPER_NAME@@!",
      "",
      "בברכה,",
      "מערכת @@PAPER_NAME@@"
    ].join(NL);
    const _bound = "emu_" + Date.now().toString(36);
    const _msg = [
      "From: " + user,
      "To: " + cust.email,
      "Reply-To: @@PAPER_EMAIL@@",
      "Subject: " + _E + _b64s(_subject) + "?=",
      "Date: " + new Date().toUTCString(),
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=\"" + _bound + "\"",
      "",
      "--" + _bound,
      "Content-Type: text/plain; charset=\"UTF-8\"",
      "Content-Transfer-Encoding: base64",
      "",
      _wrap(_b64s(_bodyText)),
      "--" + _bound,
      "Content-Type: application/pdf; name=\"" + _E + _b64s(_fname) + "?=\"",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename=\"" + _E + _b64s(_fname) + "?=\"",
      "",
      _wrap(b64),
      "--" + _bound + "--"
    ].join(CRLF);
    _S.err = "";
    const _conn = await Deno.connectTls({
      hostname: "smtp.gmail.com",
      port: 465
    });
    const _te = new TextEncoder();
    const _td = new TextDecoder();
    const _read = async ()=>{
      const bb = new Uint8Array(8192);
      const n = await _conn.read(bb);
      {
        const __r = n ? _td.decode(bb.subarray(0, n)) : "";
        if (typeof __r === "string" && /^\s*[45]\d\d/.test(__r)) {
          _S.err = __r.trim().slice(0, 150);
        }
        return __r;
      }
    };
    const _cmd = async (c)=>{
      await _conn.write(_te.encode(c + CRLF));
      return await _read();
    };
    await _read();
    await _cmd("EHLO emanuel-sheli.local");
    await _cmd("AUTH LOGIN");
    await _cmd(_b64s(user));
    await _cmd(_b64s(pass));
    await _cmd("MAIL FROM:<" + user + ">");
    await _cmd("RCPT TO:<" + cust.email + ">");
    await _cmd("DATA");
    await (async ()=>{
      const _b = _te.encode(_msg + CRLF + "." + CRLF);
      let _o = 0;
      while(_o < _b.length){
        const _w = await _conn.write(_b.subarray(_o));
        if (_w <= 0) break;
        _o += _w;
      }
    })();
    await _read();
    try {
      await _conn.write(_te.encode("QUIT" + CRLF));
    } catch (_e) {}
    try {
      _conn.close();
    } catch (_e) {}
    if (_S.err) return json({
      ok: false,
      error: "email-failed",
      detail: _S.err
    });
    return json({
      ok: true,
      pages,
      email: cust.email
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e?.message || e)
    }, 500);
  }
});
