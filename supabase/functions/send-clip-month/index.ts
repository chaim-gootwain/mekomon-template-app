import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(b, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
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
    const { data: userData } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    const uid = userData && userData.user && userData.user.id;
    if (!uid) return json({
      ok: false,
      error: "unauthorized"
    }, 401);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", uid).single();
    if (!prof || ![
      "admin",
      "sales"
    ].includes(prof.role)) return json({
      ok: false,
      error: "forbidden"
    }, 403);
    const body = await req.json();
    const { customer_id, issue_ids, ym, send_email } = body || {};
    if (!customer_id || !Array.isArray(issue_ids) || !issue_ids.length) return json({
      ok: false,
      error: "bad-request"
    }, 400);
    const { data: cust } = await admin.from("customers").select("name,email").eq("id", customer_id).single();
    if (!cust) return json({
      ok: false,
      error: "customer not found"
    }, 404);
    const out = await PDFDocument.create();
    const usedByIssue = [];
    for (const iid of issue_ids){
      const { data: issue } = await admin.from("issues").select("issue_number,pdf_path").eq("id", iid).single();
      if (!issue || !issue.pdf_path) continue;
      const { data: adRows } = await admin.from("ads").select("page_number").eq("issue_id", iid).eq("customer_id", customer_id).not("status", "in", "(\"cancelled\",\"rejected\")");
      const pages = [
        ...new Set((adRows || []).map((a)=>a.page_number).filter((p)=>p))
      ].sort((a, b)=>a - b);
      if (!pages.length) continue;
      const { data: file } = await admin.storage.from("issues-archive").download(issue.pdf_path);
      if (!file) continue;
      const src = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
      const pmap = {};
      let np = 1;
      const tp = src.getPageCount();
      for(let i = 0; i < tp; i++){
        const pg = src.getPage(i);
        const b = pg.getMediaBox();
        let rot = 0;
        try {
          rot = pg.getRotation() && pg.getRotation().angle || 0;
        } catch (_e) {}
        const land = b.width / b.height > 1.15;
        if (land && rot % 180 === 0) {
          pmap[np] = {
            idx: i,
            half: "right"
          };
          pmap[np + 1] = {
            idx: i,
            half: "left"
          };
          np += 2;
        } else {
          pmap[np] = {
            idx: i,
            half: "full"
          };
          np += 1;
        }
      }
      const used = [];
      for (const N of pages){
        const e = pmap[N];
        if (!e) continue;
        const [cp] = await out.copyPages(src, [
          e.idx
        ]);
        if (e.half !== "full") {
          const b = cp.getMediaBox();
          if (e.half === "right") {
            cp.setMediaBox(b.x + b.width / 2, b.y, b.width / 2, b.height);
            cp.setCropBox(b.x + b.width / 2, b.y, b.width / 2, b.height);
          } else {
            cp.setMediaBox(b.x, b.y, b.width / 2, b.height);
            cp.setCropBox(b.x, b.y, b.width / 2, b.height);
          }
        }
        out.addPage(cp);
        used.push(N);
      }
      if (used.length) usedByIssue.push({
        num: issue.issue_number,
        pages: used
      });
    }
    if (!out.getPageCount()) return json({
      ok: false,
      error: "no-clips",
      detail: "לא נמצאו גזירים לחודש"
    }, 400);
    const clipBytes = await out.save();
    let _bs = "";
    const _CH = 0x8000;
    for(let i = 0; i < clipBytes.length; i += _CH)_bs += String.fromCharCode.apply(null, clipBytes.subarray(i, i + _CH));
    const pdf_b64 = btoa(_bs);
    let emailed = false;
    let emailError = null;
    const _wantEmail = send_email !== false && !!cust.email;
    if (_wantEmail) {
      try {
        const user = Deno.env.get("GMAIL_USER");
        const pass = Deno.env.get("GMAIL_APP_PASSWORD");
        if (!user || !pass) throw new Error("no-smtp");
        const CRLF = String.fromCharCode(13, 10);
        const NL = String.fromCharCode(10);
        const _b64s = (str)=>btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(str))));
        const _wrap = (s)=>s.replace(/.{1,76}/g, function(m) {
            return m + CRLF;
          });
        const _E = "=?UTF-8?B?";
        const _list = usedByIssue.map((u)=>"גיליון " + u.num).join(", ");
        const _subject = "גזירי הפרסום שלך — " + (ym || "") + " · @@PAPER_NAME@@";
        const _fname = "גזירי_החודש_" + (ym || "") + ".pdf";
        const _bodyText = "שלום " + (cust.name || "") + "," + NL + NL + "מצורפים גזירי הפרסום שלך לחודש " + (ym || "") + " (" + _list + ")." + NL + "תודה שאתם מפרסמים ב@@PAPER_NAME@@!" + NL + NL + "בברכה," + NL + "מערכת @@PAPER_NAME@@";
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
          _wrap(pdf_b64),
          "--" + _bound + "--"
        ].join(CRLF);
        const _conn = await Deno.connectTls({
          hostname: "smtp.gmail.com",
          port: 465
        });
        const _te = new TextEncoder();
        const _td = new TextDecoder();
        const _writeAll = async (b)=>{
          let o = 0;
          while(o < b.length){
            const w = await _conn.write(b.subarray(o));
            if (w <= 0) break;
            o += w;
          }
        };
        const _readOnce = async ()=>{
          const bb = new Uint8Array(16384);
          const to = new Promise(function(_, rej) {
            setTimeout(function() {
              rej(new Error("smtp-read-timeout"));
            }, 20000);
          });
          const n = await Promise.race([
            _conn.read(bb),
            to
          ]);
          return n === null ? null : _td.decode(bb.subarray(0, n));
        };
        const _reply = async ()=>{
          let acc = "";
          for(let _i = 0; _i < 80; _i++){
            const s = await _readOnce();
            if (s === null) break;
            acc += s;
            const ls = acc.split(CRLF).filter(function(x) {
              return x.length;
            });
            const last = ls[ls.length - 1] || "";
            if (/^[0-9]{3} /.test(last)) break;
          }
          return acc;
        };
        const _code = (rep)=>{
          const ls = rep.split(CRLF).filter(function(x) {
            return x.length;
          });
          const last = ls[ls.length - 1] || "";
          return last.slice(0, 3);
        };
        const _cmd = async (c, ok)=>{
          await _writeAll(_te.encode(c + CRLF));
          const rep = await _reply();
          if (ok && _code(rep) !== ok) throw new Error("SMTP " + c.split(" ")[0] + " => " + rep.slice(0, 120));
          return rep;
        };
        await _reply();
        await _cmd("EHLO emanuel-sheli.local", "250");
        await _cmd("AUTH LOGIN", "334");
        await _cmd(_b64s(user), "334");
        await _cmd(_b64s(pass), "235");
        await _cmd("MAIL FROM:<" + user + ">", "250");
        await _cmd("RCPT TO:<" + cust.email + ">", "250");
        await _cmd("DATA", "354");
        await _writeAll(_te.encode(_msg + CRLF + "." + CRLF));
        const _final = await _reply();
        try {
          await _writeAll(_te.encode("QUIT" + CRLF));
        } catch (_e) {}
        try {
          _conn.close();
        } catch (_e) {}
        if (_code(_final) !== "250") throw new Error("SMTP data => " + _final.slice(0, 150));
        emailed = true;
      } catch (e) {
        emailError = String(e && e.message || e);
      }
    }
    return json({
      ok: true,
      pdf_b64,
      issues: usedByIssue.map((u)=>u.num),
      emailed,
      email: cust.email || null,
      emailError
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e && e.message || e)
    }, 500);
  }
});
