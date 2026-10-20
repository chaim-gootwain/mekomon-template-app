// netlify/lib/luach-pay.js
// -----------------------------------------------------------------------------
// תשלום באשראי (קארדקום) על מודעת לוח מהטופס הציבורי (/luach):
//   submitAndPay(form) → שומר את המודעה (portal_submit_classified) ופותח דף קארדקום
//                        על המחיר שנשמר במסד — לא על מה שהדפדפן שלח.
//   settleLuach(rec, res) → אחרי webhook מאומת (נקרא מ-beni-pay.settle):
//                        חשבונית מס-קבלה ב-EZcount → חיוב + תשלום בספר → המודעה "שולם" → מייל לחיים.
// הגנה מכפילות: store.claim על דף התשלום + transaction_id ייחודי ב-beni-receipt.
// מסמך: חשבונית מס-קבלה אוטומטית — החלטת חיים (20.10.2026) למודעות לוח בלבד.
// -----------------------------------------------------------------------------
const crypto = require("crypto");
const store = require("./beni-store");
const cardcom = require("./cardcom");
const { sendMail } = require("./beni-mail");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = process.env.URL || "https://imanuel-sheli.netlify.app";
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
const H = (x = {}) => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, ...x });
const r2 = n => Math.round(Number(n) * 100) / 100;
const money = n => "₪" + r2(n).toLocaleString("he-IL");
const israelToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

async function sb(pathq) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { headers: H() });
  if (!r.ok) throw new Error(`supabase ${r.status} ${pathq.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function sbWrite(method, pathq, body, prefer = "return=representation") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { method, headers: H({ "content-type": "application/json", Prefer: prefer }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`supabase ${method} ${r.status} ${pathq.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
  return prefer.includes("representation") ? r.json() : null;
}
async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify(args) });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch (_) { /* */ }
  if (!r.ok) { const e = new Error((d && (d.message || d.hint)) || t.slice(0, 200)); e.rpc = true; throw e; }
  return d;
}

const TYPES = ["regular", "bold", "image"];
const CATS = ["sale", "rent", "jobs", "gemach", "lost", "other"];

// ---------- הגשה + פתיחת דף תשלום ----------
async function submitAndPay(f) {
  const phone = String(f.phone || "").trim().slice(0, 30);
  const body = String(f.body || "").trim().slice(0, 2000);
  const type = TYPES.includes(f.ad_type) ? f.ad_type : "regular";
  const imagePath = f.image_path ? String(f.image_path) : null;
  if (imagePath && !/^classified\/[0-9]{7,15}_[0-9]{10,}_[A-Za-z0-9_.-]{0,60}$/.test(imagePath)) throw Object.assign(new Error("bad_image_path"), { rpc: true });

  // המזהה האחרון לפני ההגשה — כך מזהים בדיוק את השורות שההגשה הזאת יצרה
  const [last] = await sb("classified_ads?select=id&order=id.desc&limit=1");
  const before = last ? last.id : 0;
  const data = await rpc("portal_submit_classified", {
    p_name: String(f.name || "").trim().slice(0, 120), p_phone: phone, p_category: CATS.includes(f.category) ? f.category : "other",
    p_ad_type: type, p_body: body, p_issue_id: Number(f.issue_id) || null, p_package: !!f.package, p_image_path: imagePath,
  });
  const email = validEmail(f.email);
  try {
    return await afterSubmit(before, phone, data, email);
  } catch (e) { e.saved = true; throw e; }       // המודעה נשמרה — רק השלב הבא נכשל
}
const validEmail = s => { const v = String(s || "").trim().slice(0, 120); return /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(v) ? v : null; };

// אחרי ההגשה: בדיקת תוכן *לפני* התשלום (החלטת חיים, 20.10.2026) —
//   תקינה → דף תשלום (והמודעה תאושר אוטומטית כשהתשלום יעבור)
//   חשודה → לא גובים; מייל לחיים להחלטה; אישור שלו שולח למפרסם קישור תשלום
//   הבדיקה נכשלה → דף תשלום כרגיל, והבדיקה תרוץ שוב אחרי התשלום
async function afterSubmit(before, phone, data, email) {
  // השורות החדשות מהפורטל, ומתוכן של הטלפון הזה (השוואת ספרות — בלי תלות בפורמט השמירה)
  const digits = s => String(s || "").replace(/\D/g, "");
  const rows = (await sb(`classified_ads?select=id,customer_id,issue_id,price,charge_id,package_id,payment_status,contact_phone&id=gt.${before}` +
    `&source=eq.portal_public&order=id.asc&limit=20`)).filter(x => digits(x.contact_phone) === digits(phone));
  // 4+1 — כל שורות החבילה; אחרת השורה האחת שנוצרה
  const first = rows[0];
  const grp = !first ? [] : first.package_id ? rows.filter(x => x.package_id === first.package_id) : [first];
  const amount = r2(grp.reduce((s, x) => s + (Number(x.price) || 0), 0));
  const saved = { issue: data && data.issue, price: data && data.price };
  if (!first || !(amount > 0)) return { saved, url: null, reason: "no_rows" };
  const adIds = grp.map(x => x.id);

  // מייל מהטופס — לכרטיס הלקוח רק אם אין בו מייל (לא דורסים)
  if (email) try { await sbWrite("PATCH", `customers?id=eq.${first.customer_id}&or=(email.is.null,email.eq.)`, { email }, "return=minimal"); } catch (_) { /* */ }

  let v;
  try { v = await classify(adIds); } catch (e) { console.error("luach classify", e); v = { error: String(e.message || e) }; }
  if (v.verdict === "review") {
    const url = await createReview(adIds, v.reason, { unpaid: true, email });
    const [cust] = await sb(`customers?select=name&id=eq.${first.customer_id}`);
    await sendMail(OWNER, `🟡 בני: מודעת לוח מחכה להחלטה שלך — ${(cust && cust.name) || phone}`,
      `הוגשה מודעת לוח (${money(amount)}) ולא אישרתי אותה לבד: ${v.reason}\n\nעוד לא נגבה כסף — המפרסם יקבל קישור תשלום רק אם תאשר.\nלאישור או דחייה: ${url}\n\nבני`).catch(() => { });
    return { saved, review: true };
  }
  const url = await createLuachPage({ adIds, customerId: first.customer_id, amount, preApproved: v.verdict === "approve", email });
  return { saved, url, amount };
}

// דף קארדקום למודעת לוח; preApproved = התוכן כבר אושר (בני / חיים) → יאושר אוטומטית בתשלום
async function createLuachPage({ adIds, customerId, amount, preApproved, email }) {
  const [cust] = await sb(`customers?select=id,name,invoice_name,email,phone&id=eq.${customerId}`);
  const nonce = crypto.randomBytes(6).toString("hex");
  const page = await cardcom.createPage({ amount, returnValue: `luach:${adIds[0]}:${nonce}`,
    productName: `מודעת לוח${adIds.length > 1 ? " (4+1)" : ""} — ${(cust && cust.name) || ""}`,
    name: cust && (cust.invoice_name || cust.name), email: (cust && cust.email) || email || undefined, phone: cust && cust.phone,
    webhookUrl: `${SITE}/.netlify/functions/cardcom-webhook`,
    successUrl: `${SITE}/luach?paid=1`, failedUrl: `${SITE}/luach?paid=0` });
  await store.put(`pay/${store.safe(page.lowProfileId)}.json`, { kind: "luach", customerId, adIds, amount, nonce, preApproved: !!preApproved, email: email || null, at: Date.now() });
  return page.url;
}

// קישור תשלום קבוע למודעה שחיים אישר (נשלח למפרסם): בלחיצה נפתח דף קארדקום על המחיר העדכני
async function payLinkFor(adIds, customerId) {
  const token = crypto.randomBytes(14).toString("base64url");
  await store.put(`luachpay/${token}.json`, { adIds, customerId, at: Date.now() });
  return `${SITE}/.netlify/functions/luach-pay?pay=${token}`;
}
async function startApprovedPayment(token) {
  if (!/^[A-Za-z0-9_-]{16,30}$/.test(token || "")) return { error: "bad" };
  const t = await store.get(`luachpay/${token}.json`).catch(() => null);
  if (!t) return { error: "bad" };
  const ads = await sb(`classified_ads?select=id,price,status,payment_status&id=in.(${t.adIds.join(",")})`);
  if (!ads.length || ads.some(a => a.status === "rejected" || a.status === "cancelled")) return { error: "bad" };
  if (ads.every(a => a.payment_status === "settled")) return { paid: true };
  const amount = r2(ads.reduce((s, x) => s + (Number(x.price) || 0), 0));
  if (!(amount > 0)) return { paid: true };
  return { url: await createLuachPage({ adIds: t.adIds, customerId: t.customerId, amount, preApproved: true }) };
}

// ---------- אחרי תשלום (rec מ-store, res מאומת מול קארדקום) ----------
async function settleLuach(lp, rec, res) {
  if (!String(res.ReturnValue || "").startsWith(`luach:${rec.adIds[0]}:${rec.nonce}`)) return { ok: false, error: "mismatch" };
  if (!cardcom.isPaid(res)) return { ok: false, error: "not_paid", code: res.ResponseCode };
  if (!(await store.claim(`pay_${lp}`))) return { ok: true, duplicate: true };          // webhook כפול
  const tx = res.TranzactionInfo, amount = r2(tx.Amount);
  const deal = `קארדקום ${tx.TranzactionId}${tx.ApprovalNumber ? `, אישור ${tx.ApprovalNumber}` : ""}`;
  const payDate = /^\d{4}-\d{2}-\d{2}$/.test(String(tx.CreateDate || "").slice(0, 10)) ? String(tx.CreateDate).slice(0, 10) : israelToday();
  const ads = await sb(`classified_ads?select=id,customer_id,issue_id,price,charge_id,payment_status,status&id=in.(${rec.adIds.join(",")})&order=id.asc`);
  const [cust] = await sb(`customers?select=id,name,agent_id&id=eq.${rec.customerId}`);
  const who = cust ? cust.name : `#${rec.customerId}`;
  const issueNums = {};
  const issIds = [...new Set(ads.map(a => a.issue_id).filter(Boolean))];
  if (issIds.length) (await sb(`issues?select=id,issue_number&id=in.(${issIds.join(",")})`)).forEach(i => { issueNums[i.id] = i.issue_number; });
  const priced = ads.filter(a => Number(a.price) > 0);
  const lines = [];

  // כבר סומן כשולם (למשל מנהל אישר "שולם" לפני שהתשלום הגיע / תשלום כפול) — לא מפיקים מסמך שני
  if (ads.length && ads.every(a => a.payment_status === "settled")) {
    await sendMail(OWNER, `⚠️ בני: תשלום כפול על מודעת לוח — ${who}`,
      `${who} שילם ${money(amount)} בקארדקום (${deal}) על מודעת לוח שכבר הייתה מסומנת "שולם".\nלא הפקתי מסמך ולא רשמתי תשלום — תבדוק אם צריך לזכות בקארדקום.\n\nבני`).catch(() => { });
    return { ok: true, already: true };
  }

  // 1. חשבונית מס-קבלה ב-EZcount (נכשל → לא רושמים תשלום בספר; ההפקה מהאתר תרשום אותו)
  const items = priced.map(a => ({ details: `מודעת לוח — גיליון ${issueNums[a.issue_id] || ""}`.trim(), amount: 1, price: r2(a.price) }));
  const itemsSum = r2(items.reduce((s, i) => s + i.price, 0));
  let doc = null;
  if (Math.abs(itemsSum - amount) > 0.01) {
    lines.push(`⚠️ הסכום ששולם (${money(amount)}) שונה ממחיר המודעות (${money(itemsSum)}) — לא הפקתי מסמך ולא רשמתי תשלום. תפיק מהאתר חשבונית מס-קבלה (אשראי, ${deal}).`);
  } else {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/beni-receipt`, { method: "POST", headers: H({ "content-type": "application/json" }),
      body: JSON.stringify({ customer_id: rec.customerId, doc_kind: "invoice_receipt", items, transaction_id: `cardcom-${tx.TranzactionId}-luach`,
        payment: { sum: amount, cc_last4: tx.Last4CardDigitsString || String(tx.Last4CardDigits || ""), installments: tx.NumberOfPayments || 1, date: payDate.split("-").reverse().join("/") },
        comment: `מודעת לוח — תשלום באשראי (${deal})` }) });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      doc = d.document || {};
      lines.push(`✅ חשבונית מס-קבלה ${doc.doc_number || ""} על ${money(amount)}${d.mode === "demo" ? " (⚠️ EZcount במצב דמו — לא מסמך חוקי)" : ""}${doc.pdf_url ? `\n   ${doc.pdf_url}` : ""}`);
    } else {
      lines.push(`⚠️ חשבונית מס-קבלה על ${money(amount)} לא הופקה (${d.error || r.status}). התשלום *לא* נרשם בספר — תפיק את המסמך מהאתר כרגיל (אשראי, ${deal}), והוא ירשום את התשלום.`);
    }
  }

  // 2. רישום בספר — רק כשהמסמך הופק (כמו classifiedMarkPaid באתר: חיוב פר מודעה + תשלום)
  if (doc) {
    const tag = ` #doc:${doc.doc_number || doc.transaction_id} #cardcom:${tx.TranzactionId}`;
    try {
      for (const a of priced) {
        let chargeId = a.charge_id;
        if (!chargeId) {
          const [ins] = await sbWrite("POST", "charges", { customer_id: a.customer_id, amount: r2(a.price),
            description: `מודעת לוח — גיליון ${issueNums[a.issue_id] || ""}`.trim(), issued_date: payDate, due_date: payDate, status: "paid",
            invoice_number: doc.doc_number ? String(doc.doc_number) : null, agent_id: (cust && cust.agent_id) || null, notes: `מודעת לוח — שולם באשראי #cl${a.id}` });
          chargeId = ins.id;
          await sbWrite("PATCH", `classified_ads?id=eq.${a.id}`, { charge_id: chargeId }, "return=minimal");
        } else {
          await sbWrite("PATCH", `charges?id=eq.${chargeId}`, { status: "paid", ...(doc.doc_number ? { invoice_number: String(doc.doc_number) } : {}) }, "return=minimal");
        }
        const exist = await sb(`payments?select=id&charge_id=eq.${chargeId}&limit=1`);
        if (!exist.length) await sbWrite("POST", "payments", { charge_id: chargeId, customer_id: a.customer_id, amount: r2(a.price), method: "credit", paid_date: payDate,
          notes: `מודעת לוח — תשלום באשראי (${deal})${tag}` }, "return=minimal");
      }
    } catch (e) { lines.push(`⚠️ המסמך הופק, אבל רישום התשלום בספר נכשל באמצע (${String(e.message || e).slice(0, 120)}) — תבדוק בכרטיס הלקוח`); }
  }

  // 3. המודעה "שולם" — הכסף התקבל בפועל (אומת מול קארדקום), גם אם המסמך נכשל; האישור התוכני נשאר אצל המנהל
  await sbWrite("PATCH", `classified_ads?id=in.(${rec.adIds.join(",")})`, { payment_status: "settled" }, "return=minimal");
  await logNote(rec.customerId, `💳 מודעת לוח שולמה באשראי — ${money(amount)} (${deal})`);


  // 4. אישור התוכן: נבדק כבר לפני התשלום (preApproved) → מאשרים; אחרת (הבדיקה נכשלה אז) — בודקים עכשיו
  let mod;
  try {
    if (rec.preApproved) { await approveAds(rec.adIds, "🤖 מודעת לוח אושרה (תוכן נבדק לפני התשלום, שולמה באשראי)"); mod = { status: "approved", reason: "התוכן נבדק ואושר לפני התשלום" }; }
    else mod = await moderatePaid(rec.adIds);
  } catch (e) { console.error("luach moderate", e); mod = { status: "error" }; }
  const modLine = mod.status === "approved" ? `✅ המודעה מאושרת ונכנסת לגיליון. (${mod.reason})`
    : mod.status === "review" ? `🟡 המודעה מחכה להחלטה שלך: ${mod.reason}\n   לאישור או דחייה: ${mod.url}`
    : mod.status === "skip" ? "" : `⚠️ לא הצלחתי לבדוק את התוכן — המודעה ממתינה לאישור שלך בעמוד הלוח (מסומנת "שולם באשראי").`;

  await sendMail(OWNER, `💳 בני: ${who} שילם ${money(amount)} על מודעת לוח${mod.status === "review" ? " — צריך החלטה" : ""}`,
    `${who} שילם ${money(amount)} בקארדקום על מודעת לוח${ads.length > 1 ? " (4+1)" : ""} (${deal}).\n\n${lines.join("\n")}${modLine ? `\n\n${modLine}` : ""}\n\nבני`).catch(() => { });

  // 5. אישור למפרסם במייל (אם השאיר מייל בטופס / יש בכרטיס)
  const [c2] = await sb(`customers?select=name,email&id=eq.${rec.customerId}`);
  const to = rec.email || (c2 && validEmail(c2.email));
  if (to) {
    const iss = [...new Set(ads.map(a => issueNums[a.issue_id]).filter(Boolean))].join(", ");
    const docLine = doc && doc.pdf_url ? `\nחשבונית מס-קבלה: ${doc.pdf_url}` : "";
    const status = mod.status === "approved" ? `המודעה אושרה ותתפרסם ${iss ? `בגיליון ${iss}` : "בגיליון הקרוב"}.` : "המודעה בבדיקה קצרה אצלנו, ונעדכן אם יש בעיה.";
    await sendMail(to, "המודעה שלך בלוח התקבלה — @@PAPER_NAME@@",
      `שלום ${(c2 && c2.name) || ""},\n\nהתשלום על מודעת הלוח התקבל (${money(amount)}) — תודה!\n${status}${docLine}\n\nלכל שאלה: @@PAPER_PHONE@@\n\nבני — @@PAPER_NAME@@`).catch(() => { });
  }
  return { ok: true, amount, lines, moderation: mod.status };
}

// ---------- בדיקת תוכן (luach-moderate, Claude) ----------
const IMG_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
async function adImage(path) {
  if (!path) return null;
  const mt = IMG_MIME[(String(path).match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase()];
  if (!mt) return null;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/ad-files/${String(path).split("/").map(encodeURIComponent).join("/")}`, { headers: H() });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > 5 * 1024 * 1024 ? null : { media_type: mt, data: buf.toString("base64") };
}
async function adminId() {
  const [a] = await sb("profiles?select=id&role=eq.admin&active=eq.true&limit=1");
  return a ? a.id : null;
}
// ציר הזמן בכרטיס הלקוח (interactions — כמו addInteraction באתר)
async function logNote(customerId, content) {
  try { await sbWrite("POST", "interactions", { entity_type: "customer", entity_id: customerId, content, user_id: await adminId() }, "return=minimal"); } catch (_) { /* */ }
}
async function approveAds(adIds, note) {
  await sbWrite("PATCH", `classified_ads?id=in.(${adIds.join(",")})&status=eq.pending`,
    { status: "approved", approved_by: await adminId(), approved_at: new Date().toISOString() }, "return=minimal");
  const [a] = await sb(`classified_ads?select=customer_id&id=eq.${adIds[0]}`);
  if (a) await logNote(a.customer_id, note);
}
// סיווג בלבד: { verdict: approve|review, reason } או { skip } (כבר טופלה) — זורק בתקלה
async function classify(adIds) {
  const ads = await sb(`classified_ads?select=id,status,body,category,ad_type,contact_name,image_path&id=in.(${adIds.join(",")})&order=id.asc`);
  const a = ads[0];
  if (!a || ads.some(x => x.status !== "pending")) return { skip: true };
  const r = await fetch(`${SUPABASE_URL}/functions/v1/luach-moderate`, { method: "POST", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ body: a.body, category: a.category, ad_type: a.ad_type, name: a.contact_name, image: await adImage(a.image_path).catch(() => null) }) });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || !v.verdict) throw new Error(v.error || `luach-moderate HTTP ${r.status}`);
  return v;
}
async function createReview(adIds, reason, extra = {}) {
  const token = crypto.randomBytes(18).toString("base64url");
  await store.put(`luachrev/${token}.json`, { adIds, reason, ...extra, at: Date.now() });
  return `${SITE}/.netlify/functions/luach-review?t=${token}`;
}
// אחרי תשלום, כשלא נבדק מראש (הבדיקה נכשלה בזמן ההגשה)
async function moderatePaid(adIds) {
  let v;
  try { v = await classify(adIds); } catch (e) { return { status: "error", reason: String(e.message || e) }; }
  if (v.skip) return { status: "skip" };
  if (v.verdict === "approve") {
    await approveAds(adIds, "🤖 בני אישר מודעת לוח (שולמה באשראי, תוכן תקין)");
    return { status: "approved", reason: v.reason };
  }
  return { status: "review", reason: v.reason, url: await createReview(adIds, v.reason) };
}

// ---------- החלטת חיים מהמייל (luach-review) — רק על מודעה שעדיין ממתינה ----------
async function reviewInfo(token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token || "")) return null;
  const t = await store.get(`luachrev/${token}.json`).catch(() => null);
  if (!t) return null;
  const ads = await sb(`classified_ads?select=id,status,payment_status,body,category,ad_type,contact_name,contact_phone,image_path,price,issue_id,customer_id,charge_id&id=in.(${t.adIds.join(",")})&order=id.asc`);
  let image = null;
  if (ads[0] && ads[0].image_path) {
    const s = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/ad-files/${String(ads[0].image_path).split("/").map(encodeURIComponent).join("/")}`,
      { method: "POST", headers: H({ "content-type": "application/json" }), body: JSON.stringify({ expiresIn: 3600 }) });
    const d = s.ok ? await s.json().catch(() => null) : null;
    if (d && (d.signedURL || d.signedUrl)) image = `${SUPABASE_URL}/storage/v1${d.signedURL || d.signedUrl}`;
  }
  const paid = ads.length > 0 && ads.every(a => a.payment_status === "settled");
  return { ...t, ads, image, paid };
}
// קישור וואטסאפ עם הודעה מוכנה (חיים לוחץ "שלח" — למערכת אין שליחת וואטסאפ אוטומטית)
function waLink(phone, text) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "972" + d.slice(1);
  return d.length >= 11 ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null;
}
async function reviewDecide(token, action) {
  const info = await reviewInfo(token);
  if (!info || !info.ads.length) return { error: "not_found" };
  if (info.ads.some(x => x.status !== "pending")) return { done: true, status: info.ads[0].status, info };
  const a = info.ads[0];
  const total = r2(info.ads.reduce((s, x) => s + (Number(x.price) || 0), 0));
  const [cust] = await sb(`customers?select=name,email&id=eq.${a.customer_id}`);
  const name = (cust && cust.name) || a.contact_name || "";
  const to = info.email || (cust && validEmail(cust.email));

  if (action === "approve") {
    await approveAds(info.adIds, info.paid ? "✅ חיים אישר מודעת לוח (מהמייל של בני)" : "✅ חיים אישר מודעת לוח (מהמייל של בני) — נשלח קישור תשלום");
    if (info.paid) return { ok: true, action, info };
    // לא שולמה: קישור תשלום למפרסם — במייל אוטומטית, ובוואטסאפ בלחיצה של חיים
    const payUrl = await payLinkFor(info.adIds, a.customer_id);
    const msg = `שלום ${name},\nמודעת הלוח שלך ב"@@PAPER_NAME@@" אושרה 🙂\nלתשלום מאובטח באשראי (${money(total)}): ${payUrl}\nהמודעה תתפרסם אחרי התשלום.\n\nבני — @@PAPER_NAME@@ · @@PAPER_PHONE@@`;
    let mailed = false;
    if (to) mailed = await sendMail(to, "המודעה שלך בלוח אושרה — קישור לתשלום", msg).then(() => true, () => false);
    return { ok: true, action, info, payUrl, mailed, to, wa: waLink(a.contact_phone, msg) };
  }

  // דחייה
  await sbWrite("PATCH", `classified_ads?id=in.(${info.adIds.join(",")})&status=eq.pending`, { status: "rejected" }, "return=minimal");
  if (info.paid) {
    // התשלום כבר נגבה — הזיכוי והחשבונית זיכוי אצל חיים (🔴 בכרטיס של בני)
    await logNote(a.customer_id, "❌ חיים דחה מודעת לוח (מהמייל של בני) — לזכות את התשלום");
    return { ok: true, action, info };
  }
  // לא שולמה: מבטלים חיובים פתוחים שנוצרו בהגשה (כמו classifiedReject באתר) — בלי לגעת בחיוב עם תשלום
  for (const x of info.ads) {
    if (!x.charge_id) continue;
    const pays = await sb(`payments?select=id&charge_id=eq.${x.charge_id}&limit=1`);
    if (!pays.length) await sbWrite("PATCH", `charges?id=eq.${x.charge_id}`, { status: "cancelled", notes: "בוטל — מודעת לוח נדחתה" }, "return=minimal");
  }
  await logNote(a.customer_id, "❌ חיים דחה מודעת לוח (מהמייל של בני) — לא נגבה תשלום");
  if (to) await sendMail(to, "לגבי מודעת הלוח שלך — @@PAPER_NAME@@",
    `שלום ${name},\nתודה שפנית ללוח של "@@PAPER_NAME@@".\nלצערנו לא נוכל לפרסם את המודעה בנוסח הזה. לא חויבת בתשלום.\nלפרטים — @@PAPER_PHONE@@.\n\nבני — @@PAPER_NAME@@`).catch(() => { });
  return { ok: true, action, info, notified: !!to };
}

module.exports = { submitAndPay, settleLuach, startApprovedPayment, reviewInfo, reviewDecide };
