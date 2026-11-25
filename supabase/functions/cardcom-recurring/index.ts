// supabase/functions/cardcom-recurring/index.ts
// -----------------------------------------------------------------------------
// חיוב חודשי אוטומטי בכרטיס אשראי — קארדקום (API v11) עם טוקן.
//
// פעולות (POST JSON {action, ...}):
//   probe                  (מנהל)  → האם קארדקום מוגדרת במופע
//   token_link             (מנהל)  → דף קארדקום לשמירת כרטיס (CreateTokenOnly) — הקישור נשלח ללקוח
//   status                 (מנהל)  → כרטיס שמור + חיובים חודשיים + ריצות אחרונות של לקוח
//                                    (וגם סוגר בקשות שמירה שה-webhook שלהן לא הגיע)
//   remove_card            (מנהל)  → השבתת הכרטיס השמור של הלקוח
//   run                    (מנהל / cron עם x-cron-secret) → חיוב כל מה שהגיע מועדו היום
//   retry                  (מנהל)  → ניסיון חוזר לריצה שנכשלה {run_id}
//   mark_failed            (מנהל)  → ריצה תקועה (processing, בלי עסקה) → failed, אחרי בדיקה ידנית בקארדקום
//   webhook  (?action=webhook, קארדקום — בלי JWT) → אימות מול קארדקום ושמירת הטוקן
//
// הגנות:
//   • שורה אחת לכל (חיוב, חודש) ב-recurring_card_runs — נתפסת *לפני* החיוב בקארדקום.
//   • ExternalUniqTranId לכל ניסיון — קארדקום לא תבצע את אותו ניסיון פעמיים.
//   • ריצה שנתקעה ב-processing לא חוזרת אוטומטית (ייתכן שחויבה) — דורשת בדיקה ידנית.
//   • טוקנים לא יוצאים מהשרת; למסך חוזרות רק 4 ספרות ותוקף.
//
// Secrets (Supabase → Edge Functions → Secrets), לכל מופע:
//   CARDCOM_TERMINAL, CARDCOM_API_NAME  (חובה) · CARDCOM_API_PASSWORD (אם המסוף דורש לחיוב בטוקן)
//   CRON_SECRET (לריצה היומית) · EZCOUNT_API_KEY_PROD / EZCOUNT_DEVELOPER_EMAIL (כמו ezcount-doc)
// verify_jwt=false (ב-config.toml) — כי קארדקום קוראת ל-webhook בלי JWT; כל שאר
// הפעולות מאמתות מנהל בעצמן.
// -----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const CC_BASE = "https://secure.cardcom.solutions/api/v11";
const TERMINAL = parseInt(String(Deno.env.get("CARDCOM_TERMINAL") || "").replace(/\D/g, ""), 10) || 0;
const API_NAME = String(Deno.env.get("CARDCOM_API_NAME") || "").trim();
const API_PASSWORD = String(Deno.env.get("CARDCOM_API_PASSWORD") || "").trim();
const ccConfigured = () => !!(TERMINAL && API_NAME);
const MAX_ATTEMPTS = 3;

const CC_HINTS: Record<number, string> = {
  603: "שם משתמש ה-API שגוי (CARDCOM_API_NAME)",
  605: "משתמש ה-API חסום בקארדקום",
};

function timingSafeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
const r2 = (n: number) => Math.round(Number(n) * 100) / 100;
function israelNow() {
  const s = new Date().toLocaleString("en-CA", { timeZone: "Asia/Jerusalem", hour12: false });
  const [d] = s.split(",");
  return { date: d.trim(), ym: d.trim().slice(0, 7), day: Number(d.trim().slice(8, 10)) };
}
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");

// הערה בציר הזמן של הלקוח (interactions: entity_type/entity_id/content/user_id)
let ACTOR: string | null = null;
async function logNote(svc: any, customerId: number, content: string) {
  try {
    if (!ACTOR) { const { data: a } = await svc.from("profiles").select("id").eq("role", "admin").eq("active", true).limit(1); ACTOR = a && a[0] ? a[0].id : null; }
    await svc.from("interactions").insert({ entity_type: "customer", entity_id: customerId, content, user_id: ACTOR });
  } catch (_) { /* לא חוסם */ }
}

async function cc(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${CC_BASE}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { throw new Error(`cardcom ${r.status}: ${t.slice(0, 150)}`); }
}
const ccErr = (d: any) => `קארדקום (${d?.ResponseCode}): ${d?.Description || "שגיאה"}${CC_HINTS[d?.ResponseCode] ? " — " + CC_HINTS[d.ResponseCode] : ""}`;

// ---------------------------------------------------------------- שמירת טוקן
async function saveTokenFromLp(svc: any, lpId: string) {
  const { data: req } = await svc.from("card_token_requests").select("*").eq("lp_id", lpId).maybeSingle();
  if (!req) return { ok: false, error: "unknown_lp" };
  if (req.status === "saved") return { ok: true, duplicate: true };
  const res = await cc("LowProfile/GetLpResult", { TerminalNumber: TERMINAL, ApiName: API_NAME, LowProfileId: lpId });
  if (Number(res?.TerminalNumber) && Number(res.TerminalNumber) !== TERMINAL) return { ok: false, error: "terminal_mismatch" };
  if (!String(res?.ReturnValue || "").startsWith(`rc:${req.customer_id}:${req.nonce}`)) return { ok: false, error: "mismatch" };
  const ti = res?.TokenInfo || {};
  if (res?.ResponseCode !== 0 || !ti.Token) {
    // הדף עדיין פתוח / בוטל — לא מסמנים כשל על בקשה צעירה משעה
    const young = Date.now() - new Date(req.created_at).getTime() < 3600e3;
    if (!young) await svc.from("card_token_requests").update({ status: "failed", done_at: new Date().toISOString() }).eq("lp_id", lpId).eq("status", "pending");
    return { ok: false, error: "no_token", code: res?.ResponseCode };
  }
  const tx = res.TranzactionInfo || {};
  const ui = res.UIValues || {};
  const mm = String(ti.CardMonth || tx.CardMonth || "").padStart(2, "0");
  const yy = String(ti.CardYear || tx.CardYear || "").slice(-2).padStart(2, "0");
  const last4 = String(tx.Last4CardDigitsString || tx.Last4CardDigits || "").slice(-4) || null;
  // כרטיס חדש מחליף את הקודם של הלקוח
  await svc.from("card_tokens").update({ active: false }).eq("customer_id", req.customer_id).eq("active", true);
  const { error } = await svc.from("card_tokens").insert({
    customer_id: req.customer_id, token: String(ti.Token), card_last4: last4,
    card_exp_mmyy: mm !== "00" && yy !== "00" ? mm + yy : null,
    owner_id_num: String(ti.CardOwnerIdentityNumber || ui.CardOwnerIdentityNumber || "") || null,
    owner_name: String(ui.CardOwnerName || "") || null, lp_id: lpId,
  });
  if (error && !/duplicate|unique/i.test(error.message)) return { ok: false, error: error.message };
  await svc.from("card_token_requests").update({ status: "saved", done_at: new Date().toISOString() }).eq("lp_id", lpId);
  await logNote(svc, req.customer_id, `💳 הלקוח שמר כרטיס אשראי לחיוב חודשי${last4 ? " (****" + last4 + ")" : ""}`);
  return { ok: true };
}

// ---------------------------------------------------------------- EZcount
async function issueInvoiceReceipt(svc: any, p: { customer_id: number; amountPre: number; vatTotal: number; details: string; txn: string; last4: string | null; createdBy: string | null; comment: string }) {
  const { data: setRows } = await svc.from("settings").select("key,value").in("key", ["ezcount_mode", "ezcount_autosend"]);
  const st: Record<string, string> = {};
  (setRows || []).forEach((r: any) => st[r.key] = r.value);
  const mode = st.ezcount_mode === "production" ? "production" : "demo";
  const base = mode === "production" ? "https://api.ezcount.co.il" : "https://demo.ezcount.co.il";
  const apiKey = mode === "production" ? Deno.env.get("EZCOUNT_API_KEY_PROD") || "" : Deno.env.get("EZCOUNT_API_KEY_DEMO") || "f1c85d16fc1acd369a93f0489f4615d93371632d97a9b0a197de6d4dc0da51bf";
  if (!apiKey) return { ok: false, error: "no-api-key" };
  // כבר הופק (ריצה חוזרת אחרי קריסה)? — מחזירים את הקיים
  const { data: ex } = await svc.from("documents").select("*").eq("transaction_id", p.txn).eq("status", "issued").limit(1);
  if (ex && ex[0]) return { ok: true, document: ex[0], mode };
  const { data: cust } = await svc.from("customers").select("*").eq("id", p.customer_id).single();
  const now = israelNow();
  const payload: Record<string, unknown> = {
    api_key: apiKey, developer_email: Deno.env.get("EZCOUNT_DEVELOPER_EMAIL") || "dev@emanuel-sheli.local",
    type: 320, transaction_id: p.txn, lang: "he",
    customer_name: cust?.invoice_name || cust?.name || "לקוח", customerAction: "ASSOC_CREATE",
    customer_crn: cust?.business_id || String(p.customer_id),
    send_copy: 1, dont_send_email: st.ezcount_autosend === "1" ? 0 : 1,
    item: [{ details: p.details, amount: 1, price: p.amountPre, vat_type: "PRE" }],
    payment: [{ payment_type: 3, payment_sum: p.vatTotal, date: now.date.split("-").reverse().join("/"),
      cc_type: 0, cc_type_name: "אשראי", cc_number: p.last4 || "", cc_deal_type: 1, cc_num_of_payments: 1 }],
    price_total: p.vatTotal, comment: p.comment,
  };
  if (cust?.email) payload.customer_email = cust.email;
  if (cust?.phone) payload.customer_phone = cust.phone;
  if (cust?.address) payload.customer_address = cust.address;
  let raw: any = {};
  try {
    const resp = await fetch(base + "/api/createDoc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    raw = await resp.json().catch(() => ({}));
  } catch (e) { raw = { errMsg: "network: " + String(e) }; }
  const success = raw && (raw.success === true || raw.success === "true");
  const row: Record<string, unknown> = {
    created_by: p.createdBy, customer_id: p.customer_id, doc_kind: "invoice_receipt", ezcount_type: 320,
    transaction_id: p.txn, mode, payment_method: "credit", vat_included: false, total: p.vatTotal,
    status: success ? "issued" : "failed",
    raw: { ...(raw || {}), _sent: { items: payload.item, comment: p.comment, vat_included: false } },
  };
  if (success) {
    row.doc_number = raw.doc_number ? String(raw.doc_number) : null;
    row.doc_uuid = raw.doc_uuid || null; row.pdf_url = raw.pdf_link || null; row.pdf_url_copy = raw.pdf_link_copy || null;
  } else row.error = raw?.errMsg || "EZcount error " + (raw?.errNum ?? "");
  const { data: ins } = await svc.from("documents").insert(row).select("*").single();
  return success ? { ok: true, document: ins || row, mode } : { ok: false, error: String(row.error) };
}

// ---------------------------------------------------------------- חיוב אחד
async function chargeOne(svc: any, rc: any, run: any, vatRate: number, createdBy: string | null) {
  const fail = async (msg: string) => {
    await svc.from("recurring_card_runs").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", run.id);
    await logNote(svc, rc.customer_id, `⚠️ חיוב חודשי באשראי ${run.ym} נכשל: ${msg.slice(0, 200)}`);
    return { id: run.id, customer_id: rc.customer_id, ok: false, error: msg };
  };
  const { data: tok } = await svc.from("card_tokens").select("*").eq("customer_id", rc.customer_id).eq("active", true).order("id", { ascending: false }).limit(1);
  const card = tok && tok[0];
  if (!card) return fail("אין כרטיס שמור ללקוח — שלח לו קישור לשמירת כרטיס");
  const amountPre = r2(rc.amount);
  const total = r2(amountPre * (1 + vatRate / 100));
  const { data: cust } = await svc.from("customers").select("name,invoice_name,email,phone,agent_id").eq("id", rc.customer_id).single();
  const extId = `rc${rc.id}-${run.ym}-a${run.attempts}`;
  const body: Record<string, unknown> = {
    TerminalNumber: TERMINAL, ApiName: API_NAME, Amount: total, Token: card.token,
    CardExpirationMMYY: card.card_exp_mmyy || undefined, ExternalUniqTranId: extId, ExternalUniqUniqTranIdResponse: true,
    NumOfPayments: 1, ISOCoinId: 1,
    CardOwnerInformation: { FullName: card.owner_name || cust?.invoice_name || cust?.name || undefined, IdentityNumber: card.owner_id_num || undefined,
      Phone: cust?.phone || undefined, CardOwnerEmail: cust?.email || undefined },
  };
  if (API_PASSWORD) body.ApiPassword = API_PASSWORD;
  let res: any;
  try { res = await cc("Transactions/Transaction", body); }
  catch (e) {
    // לא ידוע אם חויב — משאירים processing לבדיקה ידנית (לא מנסים שוב לבד)
    await svc.from("recurring_card_runs").update({ error: "תקשורת עם קארדקום נכשלה — לבדוק בממשק קארדקום אם חויב: " + String(e).slice(0, 200), updated_at: new Date().toISOString() }).eq("id", run.id);
    return { id: run.id, customer_id: rc.customer_id, ok: false, error: "network — needs manual check" };
  }
  if (res?.ResponseCode !== 0) return fail(ccErr(res));
  const txnId = String(res.TranzactionId || "");
  const approval = String(res.ApprovalNumber || "");
  const last4 = String(res.Last4CardDigitsString || res.Last4CardDigits || card.card_last4 || "").slice(-4) || null;
  // החיוב עבר — נועלים מיד, לפני המסמך
  await svc.from("recurring_card_runs").update({ status: "paid_no_doc", amount_total: total, cardcom_txn: txnId, approval, error: null, updated_at: new Date().toISOString() }).eq("id", run.id);
  await svc.from("recurring_card_charges").update({ charges_done: (rc.charges_done || 0) + 1, ...(rc.max_charges && (rc.charges_done || 0) + 1 >= rc.max_charges ? { active: false, stopped_at: new Date().toISOString() } : {}) }).eq("id", rc.id);

  const deal = `קארדקום ${txnId}${approval ? ", אישור " + approval : ""}`;
  const details = `${rc.description || "חיוב חודשי"} — ${run.ym}`;
  const doc = await issueInvoiceReceipt(svc, { customer_id: rc.customer_id, amountPre, vatTotal: total, details, txn: `rc-run-${run.id}`, last4, createdBy, comment: `חיוב חודשי אוטומטי באשראי (${deal})` });
  const today = israelNow().date;
  const docNum = doc.ok ? String(doc.document?.doc_number || "") : "";
  const tag = `${docNum ? " #doc:" + docNum : ""} #cardcom:${txnId}`;
  // כרטסת: חיוב ששולם + תשלום (מכירה ישירה) — לא נוגע בחובות פתוחים אחרים
  try {
    const { data: ch } = await svc.from("charges").insert({
      customer_id: rc.customer_id, amount: total, description: details + (docNum ? ` (חשבונית מס-קבלה ${docNum})` : ""),
      issued_date: today, due_date: today, status: "paid", invoice_number: docNum || null, agent_id: cust?.agent_id || null,
      notes: `חיוב חודשי אוטומטי באשראי [חיוב קבוע ${rc.id}]${tag}`,
    }).select("id").single();
    if (ch) await svc.from("payments").insert({ charge_id: ch.id, customer_id: rc.customer_id, amount: total, method: "credit", paid_date: today, notes: `אשראי אוטומטי (${deal})${tag}`, created_by: createdBy });
  } catch (e) { console.error("ledger", e); }
  await svc.from("recurring_card_runs").update({ status: doc.ok ? "paid" : "paid_no_doc", doc_number: docNum || null, error: doc.ok ? null : `החיוב עבר אבל החשבונית לא הופקה: ${doc.error} — להפיק ידנית (התשלום כבר רשום בכרטסת)`, updated_at: new Date().toISOString() }).eq("id", run.id);
  await logNote(svc, rc.customer_id, `💳 חויב אוטומטית ₪${total} באשראי (${deal})${docNum ? " · חשבונית מס-קבלה " + docNum : " · ⚠️ חשבונית לא הופקה"}`);
  return { id: run.id, customer_id: rc.customer_id, ok: true, total, doc_number: docNum || null, doc_error: doc.ok ? null : doc.error };
}

// ---------------------------------------------------------------- ריצה יומית
async function runDue(svc: any, createdBy: string | null, onlyRunId: number | null) {
  if (!ccConfigured()) return { ok: false, error: "קארדקום לא מוגדרת במופע (CARDCOM_TERMINAL / CARDCOM_API_NAME)" };
  const now = israelNow();
  const { data: vr } = await svc.from("settings").select("value").eq("key", "vat_rate").maybeSingle();
  const vatRate = Number(vr?.value) > 0 ? Number(vr.value) : 18;
  const out: any[] = [];

  if (onlyRunId) {
    // ניסיון חוזר ידני לריצה שנכשלה
    const { data: cur } = await svc.from("recurring_card_runs").select("*").eq("id", onlyRunId).maybeSingle();
    if (!cur || cur.status !== "failed") return { ok: false, error: "הריצה לא במצב 'נכשל' — אין מה לנסות שוב" };
    const { data: bumped } = await svc.from("recurring_card_runs").update({ status: "processing", attempts: cur.attempts + 1, last_attempt: now.date, updated_at: new Date().toISOString() })
      .eq("id", cur.id).eq("status", "failed").eq("attempts", cur.attempts).select("*").maybeSingle();
    if (!bumped) return { ok: false, error: "הריצה כבר בטיפול" };
    const { data: rc } = await svc.from("recurring_card_charges").select("*").eq("id", cur.recurring_id).single();
    out.push(await chargeOne(svc, rc, bumped, vatRate, createdBy));
    return { ok: true, results: out };
  }

  const { data: list } = await svc.from("recurring_card_charges").select("*").eq("active", true).lte("start_ym", now.ym);
  for (const rc of list || []) {
    if (rc.day_of_month > now.day) continue;
    if (rc.max_charges && rc.charges_done >= rc.max_charges) continue;
    // חודש החיוב: החודש הנוכחי (לא משלימים חודשים שהוחמצו — מונע חיוב מצטבר בהפתעה)
    const ym = now.ym;
    let run: any = null;
    const { data: ins, error: insErr } = await svc.from("recurring_card_runs").insert({ recurring_id: rc.id, customer_id: rc.customer_id, ym, status: "processing", last_attempt: now.date }).select("*").maybeSingle();
    if (ins) run = ins;
    else if (insErr) {
      // כבר קיימת שורה לחודש — מנסים שוב רק אם נכשלה, פחות מ-3 ניסיונות, ולא היום
      const { data: ex } = await svc.from("recurring_card_runs").select("*").eq("recurring_id", rc.id).eq("ym", ym).maybeSingle();
      if (!ex || ex.status !== "failed" || ex.attempts >= MAX_ATTEMPTS || ex.last_attempt >= now.date) continue;
      const { data: claimed } = await svc.from("recurring_card_runs").update({ status: "processing", attempts: ex.attempts + 1, last_attempt: now.date, updated_at: new Date().toISOString() })
        .eq("id", ex.id).eq("status", "failed").eq("attempts", ex.attempts).select("*").maybeSingle();
      if (!claimed) continue;
      run = claimed;
    }
    if (!run) continue;
    try { out.push(await chargeOne(svc, rc, run, vatRate, createdBy)); }
    catch (e) {
      await svc.from("recurring_card_runs").update({ error: "שגיאה לא צפויה — לבדוק בקארדקום אם חויב: " + String(e).slice(0, 200), updated_at: new Date().toISOString() }).eq("id", run.id);
      out.push({ id: run.id, customer_id: rc.customer_id, ok: false, error: String(e) });
    }
  }
  try { await svc.from("settings").upsert({ key: "card_recurring_last_run", value: now.date }, { onConflict: "key" }); } catch (_) { /* */ }
  return { ok: true, date: now.date, results: out };
}

// ---------------------------------------------------------------- HTTP
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  ACTOR = null;
  try {
    // ----- webhook מקארדקום (בלי JWT): לוקחים רק את ה-LowProfileId ומאמתים מולם -----
    if (url.searchParams.get("action") === "webhook") {
      let lp = url.searchParams.get("lowprofilecode") || url.searchParams.get("LowProfileId") || "";
      if (!lp) {
        const t = await req.text().catch(() => "");
        try { const j = JSON.parse(t); lp = j.LowProfileId || j.lowprofilecode || ""; }
        catch (_) { const f = new URLSearchParams(t); lp = f.get("LowProfileId") || f.get("lowprofilecode") || ""; }
      }
      if (!/^[A-Za-z0-9-]{10,60}$/.test(lp) || !ccConfigured()) return json({ ok: false }, 200);
      const r = await saveTokenFromLp(svc, lp);
      return json({ ok: r.ok }, 200);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    // ----- אימות: cron (רק run) או מנהל מחובר -----
    const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
    const isCron = !!CRON_SECRET && timingSafeEqual(req.headers.get("x-cron-secret") || "", CRON_SECRET);
    let uid: string | null = null;
    if (!(isCron && action === "run")) {
      const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: ud } = await svc.auth.getUser(jwt);
      uid = ud?.user?.id || null;
      if (!uid) return json({ ok: false, error: "לא מזוהה" }, 401);
      const { data: prof } = await svc.from("profiles").select("role,active").eq("id", uid).single();
      if (!prof || prof.role !== "admin" || prof.active === false) return json({ ok: false, error: "אין הרשאה — נדרש מנהל" }, 403);
      ACTOR = uid;
    }

    if (action === "probe") return json({ ok: true, configured: ccConfigured(), cron: !!CRON_SECRET });

    if (action === "token_link") {
      if (!ccConfigured()) return json({ ok: false, error: "קארדקום לא מוגדרת במופע — יש להגדיר CARDCOM_TERMINAL ו-CARDCOM_API_NAME ב-Secrets של Supabase" });
      const cid = Number(body.customer_id);
      const { data: cust } = await svc.from("customers").select("id,name,invoice_name,email,phone").eq("id", cid).single();
      if (!cust) return json({ ok: false, error: "הלקוח לא נמצא" });
      const ret = String(body.return_url || "");
      const back = /^https:\/\/[^\s"']+$/.test(ret) ? ret : undefined;
      const nonce = randHex(6);
      const show = r2(Number(body.amount) > 0 ? Number(body.amount) : 1);
      const d = await cc("LowProfile/Create", {
        TerminalNumber: TERMINAL, ApiName: API_NAME, Operation: "CreateTokenOnly",
        ReturnValue: `rc:${cid}:${nonce}`, Amount: show, ISOCoinId: 1, Language: "he",
        ProductName: String(body.product_name || "שמירת כרטיס לחיוב חודשי").slice(0, 100),
        SuccessRedirectUrl: back ? back + (back.includes("?") ? "&" : "?") + "ok=1" : undefined,
        FailedRedirectUrl: back ? back + (back.includes("?") ? "&" : "?") + "ok=0" : undefined,
        CancelRedirectUrl: back ? back + (back.includes("?") ? "&" : "?") + "ok=0" : undefined,
        WebHookUrl: `${SUPABASE_URL}/functions/v1/cardcom-recurring?action=webhook`,
        UIDefinition: { CardOwnerNameValue: cust.invoice_name || cust.name || undefined, CardOwnerEmailValue: cust.email || undefined, CardOwnerPhoneValue: cust.phone || undefined, IsHideCardOwnerIdentityNumber: false },
      });
      if (d?.ResponseCode !== 0 || !d?.Url) return json({ ok: false, error: ccErr(d) });
      await svc.from("card_token_requests").insert({ lp_id: String(d.LowProfileId), customer_id: cid, nonce, created_by: uid });
      return json({ ok: true, url: d.Url });
    }

    if (action === "status") {
      const cid = Number(body.customer_id);
      // בקשות שמירה פתוחות (webhook שלא הגיע) — בודקים מול קארדקום
      if (ccConfigured()) {
        const { data: pend } = await svc.from("card_token_requests").select("lp_id").eq("customer_id", cid).eq("status", "pending").order("created_at", { ascending: false }).limit(3);
        for (const p of pend || []) { try { await saveTokenFromLp(svc, p.lp_id); } catch (_) { /* */ } }
      }
      const { data: tok } = await svc.from("card_tokens").select("id,card_last4,card_exp_mmyy,owner_name,created_at").eq("customer_id", cid).eq("active", true).order("id", { ascending: false }).limit(1);
      const { data: pendNow } = await svc.from("card_token_requests").select("created_at").eq("customer_id", cid).eq("status", "pending").limit(1);
      const { data: rcs } = await svc.from("recurring_card_charges").select("*").eq("customer_id", cid).order("id", { ascending: false });
      const { data: runs } = await svc.from("recurring_card_runs").select("*").eq("customer_id", cid).order("id", { ascending: false }).limit(24);
      return json({ ok: true, configured: ccConfigured(), card: (tok && tok[0]) || null, pending_link: !!(pendNow && pendNow.length), recurring: rcs || [], runs: runs || [] });
    }

    if (action === "remove_card") {
      await svc.from("card_tokens").update({ active: false }).eq("customer_id", Number(body.customer_id)).eq("active", true);
      await logNote(svc, Number(body.customer_id), "💳 הכרטיס השמור לחיוב חודשי הוסר");
      return json({ ok: true });
    }

    if (action === "run") {
      if (isCron) {
        const { data: s } = await svc.from("settings").select("value").eq("key", "card_recurring_auto").maybeSingle();
        if (String(s?.value || "0") !== "1") return json({ ok: true, skipped: "disabled" });
      }
      let createdBy = uid;
      if (!createdBy) { const { data: a } = await svc.from("profiles").select("id").eq("role", "admin").eq("active", true).limit(1); createdBy = a && a[0] ? a[0].id : null; }
      return json(await runDue(svc, createdBy, null));
    }

    if (action === "retry") return json(await runDue(svc, uid, Number(body.run_id) || 0 || null));

    // ריצה שנתקעה ב-processing בלי מספר עסקה — המנהל בדק בממשק קארדקום שלא חויב → מאפשר ניסיון חוזר
    if (action === "mark_failed") {
      const { data: r } = await svc.from("recurring_card_runs").update({ status: "failed", error: "סומן ידנית: לא חויב בקארדקום", updated_at: new Date().toISOString() })
        .eq("id", Number(body.run_id)).eq("status", "processing").is("cardcom_txn", null).select("id").maybeSingle();
      return json(r ? { ok: true } : { ok: false, error: "הריצה לא תקועה (או שכבר יש לה מספר עסקה)" });
    }

    return json({ ok: false, error: "bad action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
