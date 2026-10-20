// netlify/lib/beni-pay.js
// -----------------------------------------------------------------------------
// "בני" — תשלום באשראי (קארדקום) מקצה לקצה:
//   linkFor(customerId)  → קישור קבוע ללקוח (…/pay?t=<טוקן>). בלחיצה נבנה דף תשלום לסכום הפתוח *באותו רגע*
//                          — הקישור לא "מתיישן" ולא נשאר עם סכום ישן.
//   settle(lowProfileId) → אחרי webhook: אימות מול קארדקום → קבלה ב-EZcount (beni-receipt) →
//                          רישום התשלום בספר (payments/charges, בדיוק כמו applyInvoiceToLedger באתר) → מייל לחיים.
//   אם הקבלה נכשלה — לא רושמים תשלום (אחרת קבלה ידנית מהאתר הייתה רושמת אותו פעם שנייה);
//   חיים מקבל מייל להפיק קבלה מהאתר כרגיל, והיא גם תרשום את התשלום.
// -----------------------------------------------------------------------------
const crypto = require("crypto");
const store = require("./beni-store");
const cardcom = require("./cardcom");
const { sendMail } = require("./beni-mail");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = process.env.URL || "https://imanuel-sheli.netlify.app";
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
const OPEN = ["pending", "invoiced", "partial", "overdue"];
const H = (x = {}) => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, ...x });
const money = n => "₪" + (Math.round(Number(n) * 100) / 100).toLocaleString("he-IL");
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

// החובות הפתוחים של לקוח, מהוותיק לחדש, עם יתרה
async function openCharges(customerId) {
  const rows = await sb(`charges?select=id,amount,description,status,issued_date,due_date,invoice_number&customer_id=eq.${customerId}&status=in.(${OPEN.join(",")})&order=issued_date.asc.nullsfirst,id.asc&limit=200`);
  if (!rows.length) return [];
  const pays = await sb(`payments?select=charge_id,amount&charge_id=in.(${rows.map(r => r.id).join(",")})`);
  const paid = {}; pays.forEach(p => paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount || 0));
  return rows.map(r => ({ ...r, balance: Math.round((Number(r.amount) - (paid[r.id] || 0)) * 100) / 100 })).filter(r => r.balance > 0.009);
}

// ---------- קישור קבוע ללקוח ----------
async function tokenFor(customerId) {
  const c = await store.get(`paycust/${customerId}.json`);
  if (c && c.token) return c.token;
  const token = crypto.randomBytes(12).toString("base64url");
  await store.put(`paytok/${token}.json`, { customerId: Number(customerId), at: Date.now() });
  await store.put(`paycust/${customerId}.json`, { token });
  return token;
}
const linkFor = async customerId => `${SITE}/.netlify/functions/pay?t=${await tokenFor(customerId)}`;

// קישור לסכום קבוע (מסוכן המקומון): טוקן נפרד פר (לקוח, סכום) — הקישור
// הקבוע של הלקוח נשאר תמיד על כל היתרה. בלחיצה נגבה הסכום שנקבע, ולא
// יותר מהיתרה הפתוחה באותו רגע (ראו startPayment).
async function tokenForAmount(customerId, amount) {
  const amt = Math.round(Number(amount) * 100) / 100;
  const key = `paycust-amt/${Number(customerId)}-${Math.round(amt * 100)}.json`;
  const c = await store.get(key).catch(() => null);
  if (c && c.token) return c.token;
  const token = crypto.randomBytes(12).toString("base64url");
  await store.put(`paytok/${token}.json`, { customerId: Number(customerId), amount: amt, at: Date.now() });
  await store.put(key, { token });
  return token;
}
const linkForAmount = async (customerId, amount) => `${SITE}/.netlify/functions/pay?t=${await tokenForAmount(customerId, amount)}`;

// לחיצה על הקישור → דף תשלום לסכום הפתוח עכשיו
async function startPayment(token) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token || "")) return { error: "קישור לא תקין." };
  const t = await store.get(`paytok/${token}.json`);
  if (!t) return { error: "קישור לא תקין." };
  const [cust] = await sb(`customers?select=id,name,invoice_name,email,phone&id=eq.${t.customerId}`);
  if (!cust) return { error: "קישור לא תקין." };
  const charges = await openCharges(cust.id);
  const total = Math.round(charges.reduce((s, c) => s + c.balance, 0) * 100) / 100;
  if (!(total > 0)) return { nothing: true, name: cust.name };
  // טוקן עם סכום קבוע: גובים את הסכום שנקבע, ולעולם לא יותר מהיתרה הפתוחה
  const want = Math.round((Number(t.amount) || 0) * 100) / 100;
  const amount = want > 0 ? Math.min(want, total) : total;
  const nonce = crypto.randomBytes(6).toString("hex");
  const page = await cardcom.createPage({ amount, returnValue: `beni:${cust.id}:${nonce}`, productName: `תשלום יתרה — ${cust.name}`,
    name: cust.invoice_name || cust.name, email: cust.email, phone: cust.phone,
    webhookUrl: `${SITE}/.netlify/functions/cardcom-webhook`,
    successUrl: `${SITE}/.netlify/functions/pay?done=ok`, failedUrl: `${SITE}/.netlify/functions/pay?done=fail` });
  await store.put(`pay/${store.safe(page.lowProfileId)}.json`, { customerId: cust.id, amount, chargeIds: charges.map(c => c.id), nonce, at: Date.now() });
  return { url: page.url };
}

// ---------- אחרי תשלום ----------
async function settle(lowProfileId) {
  const lp = store.safe(lowProfileId);
  const rec = await store.get(`pay/${lp}.json`);
  if (!rec) return { ok: false, error: "unknown_page" };                     // דף שלא בני יצר
  const res = await cardcom.getResult(lowProfileId);
  if (!String(res.ReturnValue || "").startsWith(`beni:${rec.customerId}:${rec.nonce}`)) return { ok: false, error: "mismatch" };
  if (!cardcom.isPaid(res)) return { ok: false, error: "not_paid", code: res.ResponseCode };
  if (!(await store.claim(`pay_${lp}`))) return { ok: true, duplicate: true }; // webhook כפול
  const tx = res.TranzactionInfo, amount = Math.round(Number(tx.Amount) * 100) / 100;
  const [cust] = await sb(`customers?select=id,name,agent_id&id=eq.${rec.customerId}`);
  const who = cust ? cust.name : `#${rec.customerId}`;
  const deal = `קארדקום ${tx.TranzactionId}${tx.ApprovalNumber ? `, אישור ${tx.ApprovalNumber}` : ""}`;
  const payDate = String(tx.CreateDate || "").slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) ? String(tx.CreateDate).slice(0, 10) : israelToday();

  // החובות לסגירה: הפתוחים עכשיו (ייתכן ששולם חלק בינתיים) — מהוותיק לחדש
  const open = await openCharges(rec.customerId);
  const allocs = []; let left = amount;
  for (const c of open) { if (left <= 0.009) break; const a = Math.min(left, c.balance); allocs.push({ ...c, applied: Math.round(a * 100) / 100 }); left = Math.round((left - a) * 100) / 100; }
  // תמיד קבלה אחת על כל התשלום — בני לא מפיק חשבונית מס מתשלום. סטטוס "באיחור" מוחק את הסימן
  // שכבר הופקה חשבונית (20.10.2026: תשלום של שיא החשמל הפיק גם חשבונית מס-קבלה על ₪400 — חשש לחשבונית כפולה).
  // חוב שבאמת אין לו חשבונית — חיים מפיק חשבונית מהאתר כרגיל; הקבלה לא יוצרת הכנסה כפולה.
  const groups = [{ kind: "receipt", allocs, sum: allocs.reduce((s, a) => s + a.applied, 0) + Math.max(0, left), leftover: Math.max(0, left) }];

  const lines = [], adminRows = await sb("profiles?select=id&role=eq.admin&active=eq.true&limit=1"), createdBy = adminRows[0] ? adminRows[0].id : null;
  for (const g of groups) {
    const items = g.allocs.map(a => ({ details: a.description || `חיוב #${a.id}`, amount: 1, price: a.applied }));
    if (g.leftover) items.push({ details: "תשלום על חשבון", amount: 1, price: g.leftover });
    const r = await fetch(`${SUPABASE_URL}/functions/v1/beni-receipt`, { method: "POST", headers: H({ "content-type": "application/json" }),
      body: JSON.stringify({ customer_id: rec.customerId, doc_kind: g.kind, items, transaction_id: `cardcom-${tx.TranzactionId}-${g.kind}`,
        payment: { sum: Math.round(g.sum * 100) / 100, cc_last4: tx.Last4CardDigitsString || String(tx.Last4CardDigits || ""), installments: tx.NumberOfPayments || 1, date: payDate.split("-").reverse().join("/") },
        comment: `תשלום באשראי (${deal})` }) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) { lines.push(`⚠️ ${g.kind === "receipt" ? "קבלה" : "חשבונית מס-קבלה"} על ${money(g.sum)} לא הופקה (${d.error || r.status}). התשלום *לא* נרשם בספר — תפיק את המסמך מהאתר כרגיל, והוא ירשום את התשלום.`); continue; }
    const doc = d.document || {}, tag = ` #doc:${doc.doc_number || doc.transaction_id} #cardcom:${tx.TranzactionId}`;
    try {
    for (const a of g.allocs) {
      await sbWrite("POST", "payments", { charge_id: a.id, customer_id: rec.customerId, amount: a.applied, method: "credit", paid_date: payDate,
        notes: `תשלום באשראי (בני, ${deal})${tag}`, created_by: createdBy }, "return=minimal");
      await sbWrite("PATCH", `charges?id=eq.${a.id}`, { status: a.balance - a.applied <= 0.009 ? "paid" : "partial" }, "return=minimal");
    }
    if (g.leftover) {                                                         // תשלום מעבר לחוב — חיוב ששולם (נטו 0), כמו באתר
      const [ch] = await sbWrite("POST", "charges", { customer_id: rec.customerId, amount: g.leftover, description: `תשלום על חשבון (${deal})`, issued_date: payDate,
        due_date: payDate, status: "paid", invoice_number: doc.doc_number || null, agent_id: cust && cust.agent_id || null, notes: `מכירה ישירה מחשבונית${tag}` });
      if (ch) await sbWrite("POST", "payments", { charge_id: ch.id, customer_id: rec.customerId, amount: g.leftover, method: "credit", paid_date: payDate,
        notes: `תשלום באשראי (בני, ${deal})${tag}`, created_by: createdBy }, "return=minimal");
    }
    } catch (e) { lines.push(`⚠️ המסמך ${doc.doc_number || ""} הופק, אבל רישום התשלום בספר נכשל באמצע (${String(e.message || e).slice(0, 120)}) — תבדוק בכרטיס הלקוח`); }
    lines.push(`✅ ${g.kind === "receipt" ? "קבלה" : "חשבונית מס-קבלה"} ${doc.doc_number || ""} על ${money(g.sum)}${d.mode === "demo" ? " (⚠️ EZcount במצב דמו — לא מסמך חוקי)" : ""}${doc.pdf_url ? `\n   ${doc.pdf_url}` : ""}`);
  }
  // התשלום עצמו התקבל — הקפאת תזכורות לא נדרשת: החוב נסגר בספר והתוכנית מחשבת יתרה מחדש
  await sendMail(OWNER, `💳 בני: ${who} שילם ${money(amount)} באשראי`,
    `${who} שילם ${money(amount)} בקארדקום (${deal}${Number(tx.NumberOfPayments) > 1 ? `, ${tx.NumberOfPayments} תשלומים` : ""}).\n\n${lines.join("\n")}\n\nבני`);
  return { ok: true, amount, lines };
}

module.exports = { linkFor, linkForAmount, tokenFor, startPayment, settle, openCharges };
