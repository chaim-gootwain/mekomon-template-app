// netlify/functions/beni-fix-20022.js
// -----------------------------------------------------------------------------
// תיקון חד-פעמי (באישור חיים, 20.10.2026) לתשלום של שיא החשמל בקארדקום (עסקה 267066965, ₪4,248):
//   בני הפיק קבלה 20022 (₪3,848) על חשבונות עסקה במקום חשבונית מס-קבלה, וחשבונית מס-קבלה 30104 (₪400)
//   ורשם את ה-₪400 על חיוב שלא קשור. החלטת חיים:
//   1. קבלה 20022 נשארת → מפיקים חשבונית מס על ₪3,848 מקושרת אליה (parent)
//   2. 30104 נשארת → ה-₪400 עוברים בספר לחשבון העסקה השלישי; החיוב הלא קשור חוזר להיות פתוח
// רץ מתוזמן, פעם אחת בלבד (claim). כל אי-התאמה → עוצר בלי לשנות כלום, ומייל לחיים.
// אחרי שבוצע — למחוק את הקובץ הזה ואת התזמון ב-netlify.toml.
// -----------------------------------------------------------------------------
const store = require("../lib/beni-store");
const { sendMail } = require("../lib/beni-mail");
const { sb, israelToday } = require("../lib/beni-collect-core");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
const H = (x = {}) => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, ...x });
const TX = "267066965", RECEIPT = "20022", IR = "30104";
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;
const money = n => "₪" + (Math.round(Number(n) * 100) / 100).toLocaleString("he-IL");

async function patch(pathq, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, { method: "PATCH", headers: H({ "content-type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${pathq.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

async function run() {
  // ---- בדיקות (בלי לשנות כלום) ----
  const custs = await sb(`customers?select=id,name&name=ilike.${encodeURIComponent("*שיא החשמל*")}&limit=3`);
  if (custs.length !== 1) throw new Error(`נמצאו ${custs.length} לקוחות בשם "שיא החשמל"`);
  const c = custs[0];
  const docs = await sb(`documents?select=doc_number,doc_kind,doc_uuid,total,status&customer_id=eq.${c.id}&status=eq.issued&doc_number=in.("${RECEIPT}","${IR}")`);
  const rcpt = docs.find(d => String(d.doc_number) === RECEIPT), ir = docs.find(d => String(d.doc_number) === IR);
  if (!rcpt || rcpt.doc_kind !== "receipt" || !near(rcpt.total, 3848) || !rcpt.doc_uuid) throw new Error(`קבלה ${RECEIPT} לא נמצאה כמצופה (${JSON.stringify(rcpt || null)})`);
  if (!ir || !near(ir.total, 400)) throw new Error(`מסמך ${IR} לא נמצא כמצופה (${JSON.stringify(ir || null)})`);
  const pays = await sb(`payments?select=id,charge_id,amount,notes&customer_id=eq.${c.id}&notes=ilike.${encodeURIComponent(`*cardcom:${TX}*`)}`);
  const pR = pays.filter(p => (p.notes || "").includes(`#doc:${RECEIPT}`)), pI = pays.filter(p => (p.notes || "").includes(`#doc:${IR}`));
  if (!near(pR.reduce((t, p) => t + Number(p.amount), 0), 3848)) throw new Error(`תשלומי קבלה ${RECEIPT} בספר לא מסתכמים ב-₪3,848`);
  if (pI.length !== 1 || !near(pI[0].amount, 400)) throw new Error(`תשלום ה-₪400 (${IR}) לא נמצא כשורה אחת בספר`);
  const chargeIds = [...new Set(pR.map(p => p.charge_id).concat(pI[0].charge_id))];
  const charges = await sb(`charges?select=id,amount,description,invoice_number,status,due_date&id=in.(${chargeIds.join(",")})`);
  const allPays = await sb(`payments?select=charge_id,amount&charge_id=in.(${chargeIds.join(",")})`);
  const bal = id => { const ch = charges.find(x => x.id === id); return Number(ch.amount) - allPays.filter(p => p.charge_id === id).reduce((t, p) => t + Number(p.amount), 0); };
  const proformaCharges = charges.filter(ch => pR.some(p => p.charge_id === ch.id));
  const target = proformaCharges.filter(ch => near(bal(ch.id), 400));
  if (target.length !== 1) throw new Error(`לא נמצא חשבון עסקה יחיד שנשארה בו יתרה של ₪400 (נמצאו ${target.length})`);
  const oldCh = charges.find(ch => ch.id === pI[0].charge_id);
  if (proformaCharges.some(ch => ch.id === oldCh.id)) throw new Error("ה-₪400 כבר רשומים על אחד מחשבונות העסקה");

  // ---- 1. חשבונית מס על ₪3,848 מקושרת לקבלה 20022 ----
  const items = proformaCharges.map(ch => ({ details: ch.description || `חיוב #${ch.id}`, amount: 1,
    price: Math.round(pR.filter(p => p.charge_id === ch.id).reduce((t, p) => t + Number(p.amount), 0) * 100) / 100 }));
  const refs = proformaCharges.map(ch => ch.invoice_number).filter(Boolean);
  const r = await fetch(`${SUPABASE_URL}/functions/v1/beni-receipt`, { method: "POST", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ customer_id: c.id, doc_kind: "tax_invoice", correction: true, parent: rcpt.doc_uuid, items, transaction_id: `fix-${RECEIPT}-tax_invoice`,
      comment: `חשבונית מס לקבלה ${RECEIPT} (תשלום באשראי, קארדקום ${TX})${refs.length ? ` — חשבונות עסקה ${refs.join(", ")}` : ""}` }) });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`הפקת חשבונית המס נכשלה: ${d.error || r.status}`);
  const doc = d.document || {};

  // ---- 2. ה-₪400 עוברים לחשבון העסקה השלישי; החיוב הלא קשור חוזר לפתוח ----
  await patch(`payments?id=eq.${pI[0].id}`, { charge_id: target[0].id, notes: `${pI[0].notes} · הועבר מחיוב #${oldCh.id} (תיקון ${israelToday()})` });
  await patch(`charges?id=eq.${target[0].id}`, { status: "paid" });
  const oldLeft = allPays.filter(p => p.charge_id === oldCh.id).reduce((t, p) => t + Number(p.amount), 0) - Number(pI[0].amount);
  const oldStatus = oldLeft > 0.009 ? "partial" : (oldCh.due_date && oldCh.due_date < israelToday() ? "overdue" : "pending");
  await patch(`charges?id=eq.${oldCh.id}`, { status: oldStatus });

  return { c, doc, items, target: target[0], oldCh, oldStatus };
}

exports.handler = async () => {
  if (!(await store.claim("fix_20022"))) return { statusCode: 200 };          // פעם אחת בלבד
  try {
    const x = await run();
    await store.log("fix", { what: "20022", ok: true, doc: x.doc.doc_number });
    await sendMail(OWNER, `✅ בני: תיקון התשלום של ${x.c.name} בוצע`,
      `לפי ההחלטה שלך:\n\n` +
      `1. הפקתי חשבונית מס ${x.doc.doc_number || ""} על ${money(x.items.reduce((t, i) => t + i.price, 0))}, מקושרת לקבלה ${RECEIPT}${x.doc.pdf_url ? `\n   ${x.doc.pdf_url}` : ""}\n` +
      `2. קבלה ${RECEIPT} וחשבונית מס-קבלה ${IR} נשארו כמו שהן.\n` +
      `3. בספר: ה-₪400 הועברו ל"${x.target.description || "חיוב #" + x.target.id}" (עכשיו שולם במלואו), ` +
      `והחיוב "${x.oldCh.description || "#" + x.oldCh.id}" חזר להיות פתוח (${x.oldStatus}).\n\n` +
      `מעכשיו תשלום על חשבון עסקה מקבל חשבונית מס-קבלה שסוגרת אותו.\n\nבני`);
  } catch (e) {
    await store.log("fix", { what: "20022", ok: false, error: String(e.message || e).slice(0, 150) });
    await sendMail(OWNER, "⚠️ בני: תיקון התשלום של שיא החשמל לא בוצע",
      `עצרתי בלי לשנות כלום (או שנעצרתי באמצע — ראה פירוט): ${String(e.message || e).slice(0, 400)}\n\nבני`).catch(() => { });
  }
  return { statusCode: 200 };
};
