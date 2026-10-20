// ============================================================
// send-email — שליחת מייל ללקוח ישירות מהמערכת (Gmail SMTP)
// ------------------------------------------------------------
// קלט: { to, subject, body, customer_id?, attachments?: [{filename, content(base64), contentType}] }
// אימות: getUser (משתמש מחובר). דורש verify_jwt כבוי (מאמת בעצמו).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
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
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    // קריאה פנימית מפונקציה אחרת (למשל alerts-engine) עם מפתח ה-service_role
    const isInternal = !!token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!isInternal) {
      const { data: userData } = await admin.auth.getUser(token);
      if (!userData?.user?.id) return json({
        ok: false,
        error: "unauthorized"
      }, 401);
      // ההרשמה למערכת פתוחה ומשתמש חדש נחסם כ-pending ב-UI בלבד — בלי בדיקת
      // תפקיד כאן הפונקציה היא ממסר דואר פתוח מחשבון ה-Gmail של העיתון.
      const { data: prof } = await admin.from("profiles").select("role,active").eq("id", userData.user.id).single();
      if (!prof?.active || ![
        "admin",
        "sales",
        "editor",
        "graphics"
      ].includes(prof.role)) return json({
        ok: false,
        error: "forbidden"
      }, 403);
    }
    const { to, subject, body, html, customer_id, attachments, attach_document_id } = await req.json();
    let dest = String(to || "").trim();
    if (!dest && customer_id) {
      const { data: cust } = await admin.from("customers").select("email").eq("id", customer_id).single();
      dest = String(cust?.email || "").trim();
    }
    if (!dest || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return json({
      ok: false,
      error: "no-email",
      detail: "כתובת מייל חסרה או שגויה"
    }, 400);
    if (!subject && !body) return json({
      ok: false,
      error: "empty",
      detail: "נושא/תוכן חסרים"
    }, 400);
    const user = Deno.env.get("GMAIL_USER") || "@@PAPER_EMAIL@@";
    const pass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!pass) return json({
      ok: false,
      error: "no-smtp",
      detail: "לא הוגדר סוד Gmail"
    }, 400);
    const atts = Array.isArray(attachments) ? attachments.filter((a)=>a && a.filename && a.content).map((a)=>({
        filename: String(a.filename),
        content: String(a.content),
        encoding: "base64",
        contentType: a.contentType || "application/octet-stream"
      })) : [];
    // צירוף מסמך חשבונאי לפי מזהה מטבלת documents (למשל מסוכן המקומון):
    // הפונקציה מורידה בעצמה את ה-PDF מהקישור השמור בטבלה — לא מקבלת
    // כתובות חופשיות מהדפדפן. כשל בהורדה מוחזר כשגיאה ברורה, בלי לשלוח.
    if (attach_document_id) {
      const { data: doc } = await admin.from("documents").select("id,customer_id,doc_number,pdf_url")
        .eq("id", Number(attach_document_id)).single();
      if (!doc || !doc.pdf_url || !/^https:\/\//.test(String(doc.pdf_url))) return json({
        ok: false, error: "no-doc-pdf", detail: "למסמך אין קובץ PDF זמין במערכת"
      }, 400);
      if (customer_id && doc.customer_id && Number(customer_id) !== Number(doc.customer_id)) return json({
        ok: false, error: "doc-mismatch", detail: "המסמך לא שייך ללקוח הזה"
      }, 400);
      const pdfRes = await fetch(String(doc.pdf_url));
      if (!pdfRes.ok) return json({
        ok: false, error: "doc-fetch", detail: "הורדת ה-PDF נכשלה (" + pdfRes.status + ") — אפשר לשלוח קישור במקום"
      }, 502);
      const buf = new Uint8Array(await pdfRes.arrayBuffer());
      if (buf.length > 10 * 1024 * 1024) return json({
        ok: false, error: "doc-too-big", detail: "קובץ המסמך גדול מדי לצירוף"
      }, 400);
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
      atts.push({
        filename: "מסמך-" + String(doc.doc_number || doc.id) + ".pdf",
        content: btoa(bin),
        encoding: "base64",
        contentType: "application/pdf"
      });
    }
    /* מייל עם קבצים מצורפים: denomailer שובר כותרות לא-ASCII (שם קובץ עברי
       מקודד עם שבירות שורה בתוך ה-encoded-word) ולא עוטף base64 ארוך לשורות
       של 76 תווים — הקובץ מגיע פגום ("הטעינה של מסמך ה-PDF נכשלה").
       לכן מיילים עם צירופים נשלחים ב-SMTP גולמי עם MIME בנוי ידנית —
       אותו מנגנון מוכח של send-clip. בלי צירופים — הנתיב הקיים (denomailer).
       בנתיב הזה html לא נתמך — גוף המייל נשלח כטקסט. */
    if (atts.length) {
      const CRLF = String.fromCharCode(13, 10);
      const _b64s = (str)=>btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(str))));
      const _wrap = (s)=>s.replace(/.{1,76}/g, (m)=>m + CRLF);
      const _E = "=?UTF-8?B?";
      const subjClean = String(subject || "הודעה מ@@PAPER_NAME@@").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
      const destClean = dest.replace(/[\r\n<>]/g, "");
      const _bound = "emu_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const parts = [
        "From: " + user,
        "To: " + destClean,
        "Reply-To: @@PAPER_EMAIL@@",
        "Subject: " + _E + _b64s(subjClean) + "?=",
        "Date: " + new Date().toUTCString(),
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"" + _bound + "\"",
        "",
        "--" + _bound,
        "Content-Type: text/plain; charset=\"UTF-8\"",
        "Content-Transfer-Encoding: base64",
        "",
        _wrap(_b64s(String(body || ""))),
      ];
      for (const a of atts) {
        const safeType = /^[\w.+-]+\/[\w.+-]+$/.test(String(a.contentType || "")) ? String(a.contentType) : "application/octet-stream";
        parts.push(
          "--" + _bound,
          "Content-Type: " + safeType + "; name=\"" + _E + _b64s(String(a.filename)) + "?=\"",
          "Content-Transfer-Encoding: base64",
          "Content-Disposition: attachment; filename=\"" + _E + _b64s(String(a.filename)) + "?=\"",
          "",
          _wrap(String(a.content).replace(/[\r\n\s]/g, "")),
        );
      }
      parts.push("--" + _bound + "--");
      const _msg = parts.join(CRLF);
      const _S = { err: "" };
      const _conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
      const _te = new TextEncoder(), _td = new TextDecoder();
      const _read = async ()=>{
        const bb = new Uint8Array(8192);
        const n = await _conn.read(bb);
        const r = n ? _td.decode(bb.subarray(0, n)) : "";
        if (/^\s*[45]\d\d/.test(r)) _S.err = r.trim().slice(0, 150);
        return r;
      };
      const _cmd = async (c)=>{ await _conn.write(_te.encode(c + CRLF)); return await _read(); };
      await _read();
      await _cmd("EHLO mekomon.local");
      await _cmd("AUTH LOGIN");
      await _cmd(_b64s(user));
      await _cmd(_b64s(pass));
      await _cmd("MAIL FROM:<" + user + ">");
      await _cmd("RCPT TO:<" + destClean + ">");
      await _cmd("DATA");
      await (async ()=>{
        const _b = _te.encode(_msg + CRLF + "." + CRLF);
        let _o = 0;
        while (_o < _b.length) {
          const _w = await _conn.write(_b.subarray(_o));
          if (_w <= 0) break;
          _o += _w;
        }
      })();
      await _read();
      try { await _conn.write(_te.encode("QUIT" + CRLF)); } catch (_e) {}
      try { _conn.close(); } catch (_e) {}
      if (_S.err) return json({ ok: false, error: "email-failed", detail: _S.err });
      return json({ ok: true, to: dest });
    }
    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: {
          username: user,
          password: pass
        }
      }
    });
    /* נושא בעברית/אמוג'י: קידוד Base64 ידני (encoded-word יחיד, כמו ב-send-clip).
       denomailer מקודד נושא לא-ASCII ב-quoted-printable עם שבירות שורה בתוך
       ה-encoded-word — נושא ארוך שובר את בלוק הכותרות וכל המייל מגיע כטקסט גולמי.
       הרווח המוביל מונע מ-denomailer לזהות "=?" ולקודד שוב. */
    // הסרת CR/LF ותווי בקרה מהנושא — אלה ASCII ולכן בנתיב ה-ASCII למטה היו עוברים
    // כמות שהם ומאפשרים הזרקת כותרות SMTP (Bcc / סיום DATA מוקדם). Base64 מנטרל
    // אותם בנתיב הלא-ASCII, אבל כאן חובה לנקות במפורש.
    const subjRaw = String(subject || "הודעה מ@@PAPER_NAME@@").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    const subjSafe = /[^\x00-\x7f]/.test(subjRaw)
      ? " =?UTF-8?B?" + btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(subjRaw)))) + "?="
      : subjRaw;
    await client.send({
      from: user,
      to: dest,
      replyTo: "@@PAPER_EMAIL@@",
      subject: subjSafe,
      content: String(body || ""),
      html: html ? String(html) : undefined,
      attachments: atts
    });
    await client.close();
    return json({
      ok: true,
      to: dest
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e?.message || e)
    }, 500);
  }
});
