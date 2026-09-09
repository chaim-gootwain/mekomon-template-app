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
    const { to, subject, body, html, customer_id, attachments } = await req.json();
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
