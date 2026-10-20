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
  try {
    return await openPage(before, phone, data);
  } catch (e) { e.saved = true; throw e; }       // המודעה נשמרה — רק דף התשלום נכשל
}
async function openPage(before, phone, data) {
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

  const [cust] = await sb(`customers?select=id,name,invoice_name,email,phone&id=eq.${first.customer_id}`);
  const nonce = crypto.randomBytes(6).toString("hex");
  const page = await cardcom.createPage({ amount, returnValue: `luach:${first.id}:${nonce}`,
    productName: `מודעת לוח${grp.length > 1 ? " (4+1)" : ""} — ${(cust && cust.name) || phone}`,
    name: cust && (cust.invoice_name || cust.name), email: cust && cust.email, phone: (cust && cust.phone) || phone,
    webhookUrl: `${SITE}/.netlify/functions/cardcom-webhook`,
    successUrl: `${SITE}/luach?paid=1`, failedUrl: `${SITE}/luach?paid=0` });
  await store.put(`pay/${store.safe(page.lowProfileId)}.json`, { kind: "luach", customerId: first.customer_id, adIds: grp.map(x => x.id), amount, nonce, at: Date.now() });
  return { saved, url: page.url, amount };
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
  try { await sbWrite("POST", "interactions", { customer_id: rec.customerId, kind: "note", note: `💳 מודעת לוח שולמה באשראי — ${money(amount)} (${deal})` }, "return=minimal"); } catch (_) { /* */ }

  await sendMail(OWNER, `💳 בני: ${who} שילם ${money(amount)} על מודעת לוח`,
    `${who} שילם ${money(amount)} בקארדקום על מודעת לוח${ads.length > 1 ? " (4+1)" : ""} (${deal}).\n\n${lines.join("\n")}\n\nהמודעה ממתינה לאישור שלך בעמוד הלוח (מסומנת "שולם באשראי").\n\nבני`).catch(() => { });
  return { ok: true, amount, lines };
}

module.exports = { submitAndPay, settleLuach };
