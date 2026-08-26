import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-cron-secret",
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
const ATTACH_LIMIT = 8 * 1024 * 1024;
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const cronSecret = Deno.env.get("SEND_ISSUE_SECRET") || "";
    const gotCron = req.headers.get("x-cron-secret") || new URL(req.url).searchParams.get("cron") || "";
    let authorized = cronSecret && gotCron === cronSecret;
    if (!authorized) {
      const { data: u } = await admin.auth.getUser((req.headers.get("Authorization") || "").replace("Bearer ", ""));
      if (u?.user?.id) {
        const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).single();
        if (p?.role === "admin") authorized = true;
      }
    }
    if (!authorized) return json({
      ok: false,
      error: "unauthorized"
    }, 401);
    const body = await req.json().catch(()=>({}));
    const issueIdIn = body?.issue_id ?? null;
    const testTo = body?.test_to ?? null;
    const { data: setRows } = await admin.from("settings").select("key,value").in("key", [
      "issue_mail_enabled",
      "issue_mail_subject",
      "issue_mail_body"
    ]);
    const st = {};
    (setRows || []).forEach((r)=>st[r.key] = r.value);
    if (st.issue_mail_enabled !== "1" && !testTo) return json({
      ok: false,
      error: "disabled"
    }, 400);
    const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
    const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD") || "";
    if (!GMAIL_USER || !GMAIL_PASS) return json({
      ok: false,
      error: "no-gmail-credentials"
    }, 400);
    if (testTo) {
      const tc = new SMTPClient({
        connection: {
          hostname: "smtp.gmail.com",
          port: 465,
          tls: true,
          auth: {
            username: GMAIL_USER,
            password: GMAIL_PASS
          }
        }
      });
      try {
        await tc.send({
          from: GMAIL_USER,
          to: testTo,
          replyTo: GMAIL_USER,
          subject: "בדיקה — @@PAPER_NAME@@",
          content: "מייל בדיקה מהמערכת של @@PAPER_NAME@@. אם קיבלת את זה — חיבור ה-Gmail עובד!"
        });
        await tc.close();
        return json({
          ok: true,
          test: true,
          to: testTo
        });
      } catch (e) {
        try {
          await tc.close();
        } catch (_e) {}
        return json({
          ok: false,
          error: "smtp: " + String(e)
        }, 500);
      }
    }
    const subjTmpl = st.issue_mail_subject || "@@PAPER_NAME@@ — גיליון [מספר]";
    const bodyTmpl = st.issue_mail_body || "שלום [שם הלקוח],";
    let issue = null;
    if (issueIdIn) {
      const { data } = await admin.from("issues").select("*").eq("id", issueIdIn).single();
      issue = data;
    } else {
      const { data } = await admin.from("issues").select("*").not("pdf_url", "is", null).is("emailed_at", null).order("id", {
        ascending: false
      }).limit(1);
      issue = (data || [])[0] || null;
    }
    if (!issue) return json({
      ok: true,
      sent: 0,
      note: "no-issue-ready"
    });
    if (!issue.pdf_url) return json({
      ok: false,
      error: "issue-has-no-pdf"
    }, 400);
    const { data: ads } = await admin.from("ads").select("customer_id").eq("issue_id", issue.id);
    const custIds = [
      ...new Set((ads || []).map((a)=>a.customer_id).filter(Boolean))
    ];
    let recipients = [];
    if (custIds.length) {
      const { data: custs } = await admin.from("customers").select("id,name,invoice_name,email").in("id", custIds);
      recipients = (custs || []).filter((c)=>c.email && c.email.includes("@"));
    }
    let attachBytes = null;
    try {
      const r = await fetch(issue.pdf_url);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength <= ATTACH_LIMIT) attachBytes = buf;
    } catch (_e) {
      attachBytes = null;
    }
    const issueNum = issue.number ?? issue.issue_number ?? issue.id;
    const subject = subjTmpl.replace(/\[מספר\]/g, String(issueNum));
    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: {
          username: GMAIL_USER,
          password: GMAIL_PASS
        }
      }
    });
    const sentTo = [];
    const failed = [];
    for (const c of recipients){
      const name = c.invoice_name || c.name || "לקוח";
      let text = bodyTmpl.replace(/\[שם הלקוח\]/g, name);
      if (!attachBytes) text += "\n\nלצפייה בגיליון: " + issue.pdf_url;
      const msg = {
        from: GMAIL_USER,
        to: c.email,
        replyTo: GMAIL_USER,
        subject,
        content: text
      };
      if (attachBytes) msg.attachments = [
        {
          filename: "גיליון-" + issueNum + ".pdf",
          content: attachBytes,
          encoding: "binary",
          contentType: "application/pdf"
        }
      ];
      try {
        await client.send(msg);
        sentTo.push(c.email);
      } catch (e) {
        failed.push(c.email + ": " + String(e));
      }
      await new Promise((r)=>setTimeout(r, 900));
    }
    try {
      await client.send({
        from: GMAIL_USER,
        to: GMAIL_USER,
        subject: "[עותק] " + subject,
        content: "נשלח גיליון " + issueNum + " ל-" + sentTo.length + " לקוחות. נכשלו: " + failed.length
      });
    } catch (_e) {}
    await client.close();
    if (!testTo) await admin.from("issues").update({
      emailed_at: new Date().toISOString(),
      email_log: {
        sent: sentTo,
        failed
      }
    }).eq("id", issue.id);
    return json({
      ok: true,
      issue: issueNum,
      sent: sentTo.length,
      failed: failed.length,
      attachment: !!attachBytes
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e)
    }, 500);
  }
});
