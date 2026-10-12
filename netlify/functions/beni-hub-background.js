// netlify/functions/beni-hub-background.js
// -----------------------------------------------------------------------------
// "בני" — הטיפול במיילים שהגיעו מתיבת העסק (ר' beni-hub.js). כל ההחלטות כאן, לפי כרטיס העובד:
//
//  • מייל מלקוח עם קובץ מודעה → לקוח עם מודעה אחת פתוחה בגיליון הקרוב: הקובץ מצורף (פעולת
//    "upload" לסקריפט בתיבה, ואחריה רישום ב-ad_files). אחרת → פריט ממוספר במייל "קבצי מודעות
//    שלא שייכתי" לחיים.
//  • מייל מחיים (תשובה למייל של בני, או מייל חדש שפונה ל"בני") → פקודה קבועה ("1 חדשה", "שלח 1,3")
//    מבוצעת ישר; כל השאר → המוח (supabase/functions/beni-brain) מפרש לפעולות, ומבוצעות רק:
//      🟢 מודעה חדשה / צירוף / דילוג, שליחת גזיר ועמודים מהעיתון, תזכורות 1–2, "שילם" (הפסקת תזכורות)
//      🟡 תזכורת 3, דחייה עד חודש, ביטול מודעה עתידית שלא שובצה — מבוצע ומדווח
//      🔴 מחיר/הנחה/זיכוי/ביטול חשבונית/רישום תשלום/שיבוץ/אישור דפוס — "זה אצלך", לא מבוצע
//    בני עונה לחיים באותו שרשור: מה הבין, מה עשה, ומה לא.
// הזיכרון (אירועים, פעולות, פריטים) — beni-store (bucket פרטי). env: SUPABASE_*, BENI_INSERT_TOKEN, GMAIL_APP_PASSWORD
// -----------------------------------------------------------------------------
const store = require("../lib/beni-store");
const { money, heDate, israelToday, snoozeCustomer } = require("../lib/beni-collect-core");
const { sendClip } = require("../lib/beni-clip");
const { sendMail } = require("../lib/beni-mail");
const { findPlan, handleReply } = require("./beni-collect");
const { lib: attach } = require("./beni-attach");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.BENI_INSERT_TOKEN;
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
// לא לקוחות — מיילים מהם לא נבדקים (העסק עצמו, הגרפיקאית, הוועדה, הדפוס, הצוות)
const SKIP_FROM = ["imanuel.sheli@gmail.com", "tamar80819@gmail.com", "rabaney.emanuel@gmail.com", "dfus@em-print.co.il", "d@@PAPER_PHONE@@@gmail.com", "@@PAPER_EMAIL@@"];
const MIN_BYTES = 20 * 1024;                                  // קטן מזה — לוגו/חתימה, לא מודעה
const FILE_TYPE = /^(application\/pdf|image\/(jpeg|png|tiff|webp))$/i;
const DIGEST_SUBJECT = "בני: קבצי מודעות שלא שייכתי";
const LABEL_DONE = "בני/צורף למערכת", LABEL_SKIP = "בני/לא שויך";
const LETTERS = "אבגדהוזחטי";
const ATTACH_CMD = /^(\d+)\s*(חדשה|חדש|דלג|[א-י](?![א-ת]))(.*)$/;
const oneLine = s => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
const H = (x = {}) => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, ...x });

// ---------- עזרים ----------
async function customerByName(name) {                          // רק התאמה יחידה
  name = oneLine(name).replace(/[\\%_*,()]/g, "").slice(0, 80);
  if (name.length < 2) return null;
  const rows = await attach.sb(`customers?select=id,name&name=ilike.${encodeURIComponent(name)}&limit=2`);
  if (rows.length === 1) return rows[0];
  if (rows.length) return null;
  const part = await attach.sb(`customers?select=id,name&name=ilike.${encodeURIComponent("*" + name + "*")}&limit=2`);  // "בדיקה" → "בדיקה – חיים"
  return part.length === 1 ? part[0] : null;
}
async function think(evt, files, debts) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/beni-brain`, { method: "POST", headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ subject: evt.subject, text: evt.text, quoted: evt.quoted, context: { files, debts } }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`המוח לא זמין (${r.status}): ${t.slice(0, 150)}`);
  return JSON.parse(t);
}
const filesOf = evt => evt.attachments.filter(a => FILE_TYPE.test(a.type) && a.size >= MIN_BYTES && Number.isInteger(a.i));

// העלאת הקבצים של מייל ללקוח → למודעה (הסקריפט בתיבה מעלה; אחר כך register כאן)
async function queueUpload(msgId, files, uploads, adId, subject) {
  await store.addOp({ type: "upload", msgId, label: { add: LABEL_DONE, remove: LABEL_SKIP },
    files: uploads.map((u, k) => ({ i: files[k].i, url: u.url, path: u.path, name: u.name })) },
  { kind: "register", adId, subject });
}

// ---------- מייל מלקוח עם קבצים ----------
async function onCustomerMail(evt, digest, items) {
  const files = filesOf(evt);
  if (!files.length) return;                                   // בלי קובץ מודעה — כרגע לא מטפלים
  const m = await attach.match({ email: evt.email, subject: evt.subject, files });
  if (m.match) { await queueUpload(evt.id, files, m.uploads, m.adId, evt.subject); return; }
  if (m.reason === "unknown_sender" || m.reason === "bad_email") return;     // לא לקוח — בשקט
  await store.addOp({ type: "label", msgId: evt.id, add: LABEL_SKIP });
  const why = m.reason === "no_open_ad" ? "אין לו מודעה פתוחה בגיליונות הקרובים — אולי הזמנה חדשה?"
    : m.reason === "several_ads" ? `יש לו ${m.candidates.length} מודעות בגיליון ${m.issue} — לא ידעתי לאיזו לצרף`
    : m.reason === "no_open_issue" ? "אין גיליון פתוח במערכת" : m.reason === "several_customers" ? "הכתובת רשומה אצל כמה לקוחות" : m.reason;
  if (m.customerId && (m.reason === "no_open_ad" || m.reason === "several_ads")) {
    const n = ++items.seq;
    items.items.push({ n, msgId: evt.id, customerId: m.customerId, customer: m.customer, subject: evt.subject,
      candidates: m.candidates || [], files: files.map(f => ({ i: f.i, name: f.name, size: f.size, type: f.type })), handledAt: null });
    const opts = m.reason === "several_ads"
      ? m.candidates.map((c, k) => `${n}${LETTERS[k]} (${c.title})`).join(" · ") + ` · ${n} דלג`
      : `${n} חדשה (מודעה חדשה בגיליון הקרוב) · ${n} דלג`;
    digest.push(`${n}. ${m.customer} — "${evt.subject}": ${why}\n   מה לעשות? השב: ${opts}`);
  } else digest.push(`• ${m.customer || evt.email} — "${evt.subject}": ${why}`);
}

// ---------- פעולות (אחרי פענוח) ----------
async function doFiles(a, it, evt, lines) {
  const note = oneLine(a.note);
  if (it.handledAt) { lines.push(`• ${it.customer}: הפריט כבר טופל`); return; }
  if (a.type === "skip") { it.handledAt = Date.now(); await store.addOp({ type: "label", msgId: it.msgId, remove: LABEL_SKIP }); lines.push(`• ${it.customer}: דילגתי`); return; }
  if (!it.files) { lines.push(`⚠️ ${it.customer}: הפריט מגרסה קודמת של בני — אין לי את רשימת הקבצים. תענה "${it.n} דלג" ותעביר את המייל שוב`); return; }
  let r, where;
  if (a.type === "create_ad") {
    const price = a.price != null && isFinite(a.price) && a.price >= 0 && a.price < 1e6 ? Number(a.price) : null;
    r = await attach.createAd({ customerId: it.customerId, title: it.subject, files: it.files, note, price });
    if (r.ok) where = `נפתחה מודעה חדשה בגיליון ${r.issue}${price != null ? ` במחיר ${price}` : ""}${note ? " · ההוראה שלך נשמרה בהערות המודעה" : ""} (להשלים ${price == null ? "גודל ומחיר" : "גודל"})`;
  } else {
    const k = LETTERS.indexOf(String(a.option || "").trim().charAt(0)), c = (it.candidates || [])[k];
    if (!c) { lines.push(`• ${it.customer}: לא הבנתי לאיזו מודעה לצרף`); return; }
    r = await attach.uploadsFor({ adId: c.adId, customerId: it.customerId, files: it.files });
    where = `הקובץ מצורף ל"${c.title}"`;
  }
  if (!r.ok) { lines.push(`⚠️ ${it.customer}: לא הצלחתי — ${r.error}`); return; }
  await queueUpload(it.msgId, it.files, r.uploads, r.adId, it.subject);
  it.handledAt = Date.now();
  lines.push(`✅ ${it.customer}: ${where}`);
}

async function doClip(a, it, lines) {
  let cust = it ? { id: it.customerId, name: it.customer } : await customerByName(a.customer);
  if (!cust) { lines.push(`• לא זיהיתי את הלקוח${a.customer ? ` "${oneLine(a.customer)}"` : ""} — תכתוב את השם כמו במערכת`); return; }
  const extra = (Array.isArray(a.pages) ? a.pages : []).map(Number).filter(n => n >= 1 && n <= 200).slice(0, 8);
  try {
    const r = await sendClip(cust.id, { extraPages: extra, onlyExtra: extra.length > 0 && /רק/.test(a.note || ""), issueNumber: a.issue });
    if (r.ok) { lines.push(`✅ ${cust.name}: שלחתי לו מגיליון ${r.issue} את ${r.what} ל-${r.email}`); if (it && !it.handledAt) it.handledAt = Date.now(); }
    else lines.push(`⚠️ ${cust.name}: לא שלחתי — ${r.error}`);
  } catch (e) { lines.push(`⚠️ ${cust.name}: השליחה נכשלה — ${String(e.message || e).slice(0, 150)}`); }
}

// 🟡 ביטול מודעה עתידית שעוד לא נכנסה לעימוד (בדיוק אחת מתאימה)
async function doCancel(a, lines) {
  const cust = await customerByName(a.customer);
  if (!cust) { lines.push(`• ביטול: לא זיהיתי את הלקוח${a.customer ? ` "${oneLine(a.customer)}"` : ""}`); return; }
  let issues = await attach.sb(`issues?select=id,issue_number&publish_date=gt.${israelToday()}&order=publish_date.asc&limit=10`);
  if (a.issue) issues = issues.filter(i => i.issue_number === Number(a.issue));
  if (!issues.length) { lines.push(`• ${cust.name}: לא מצאתי גיליון עתידי${a.issue ? ` ${a.issue}` : ""}`); return; }
  const ads = await attach.sb(`ads?select=id,title,issue_id,status,page_number,notes&customer_id=eq.${cust.id}&issue_id=in.(${issues.map(i => i.id).join(",")})&status=in.(received,in_graphics,proof,committee,approved)`);
  const open = ads.filter(x => !x.page_number);
  if (open.length !== 1) {
    lines.push(`• ${cust.name}: ${open.length ? `יש ${open.length} מודעות עתידיות — איזו לבטל? (ציין מספר גיליון)` : ads.length ? "המודעה כבר שובצה בעמוד — ביטול אחרי עימוד אצלך" : "לא מצאתי מודעה עתידית פתוחה"}`);
    return;
  }
  const ad = open[0], iss = issues.find(i => i.id === ad.issue_id);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/ads?id=eq.${ad.id}&page_number=is.null`, { method: "PATCH", headers: H({ "content-type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify({ status: "cancelled", notes: `${ad.notes ? ad.notes + "\n" : ""}בוטלה ע"י בני לפי הוראת חיים (${heDate(israelToday())})${a.note ? ": " + oneLine(a.note) : ""}` }) });
  if (!r.ok || !(await r.json()).length) { lines.push(`⚠️ ${cust.name}: הביטול לא עבר`); return; }
  lines.push(`🟡 ${cust.name}: ביטלתי את המודעה${ad.title ? ` "${ad.title}"` : ""} בגיליון ${iss.issue_number}`);
}

// 🟢 קישור תשלום (קארדקום) ללקוח — לכל היתרה הפתוחה במערכת
async function doPayLink(a, plan, lines) {
  const it = plan && a.list !== "files" && [...plan.items, ...(plan.escalate || [])].find(x => x.id === Number(a.item));
  const c = it ? { id: it.customerId, name: it.name } : await customerByName(a.customer);
  if (!c) { lines.push(`• קישור תשלום: לא זיהיתי את הלקוח${a.customer ? ` "${oneLine(a.customer)}"` : ""}`); return; }
  if (!require("../lib/cardcom").configured()) { lines.push(`⚠️ ${c.name}: קארדקום עוד לא מחוברת (חסרים פרטי המסוף ב-Netlify)`); return; }
  const pay = require("../lib/beni-pay");
  const [cust] = await attach.sb(`customers?select=name,email&id=eq.${c.id}`);
  const email = String((cust && cust.email) || "").trim();
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(email)) { lines.push(`⚠️ ${c.name}: אין מייל תקין בכרטיס`); return; }
  const open = await pay.openCharges(c.id), total = open.reduce((s, x) => s + x.balance, 0);
  if (!(total > 0)) { lines.push(`• ${c.name}: אין לו יתרה פתוחה במערכת`); return; }
  const link = await pay.linkFor(c.id);
  await sendMail(email, "קישור לתשלום — @@PAPER_NAME@@",
    `שלום ${cust.name || ""},\n\nלפי הרישומים שלנו היתרה הפתוחה היא ${money(total)}.\nלתשלום מאובטח באשראי: ${link}\n\nאם כבר שילמתם — תודה, ונשמח שתעדכנו.\nלכל שאלה: @@PAPER_PHONE@@.\n\nתודה רבה,\nבני – @@PAPER_NAME@@`);
  lines.push(`✅ ${c.name}: שלחתי קישור תשלום על ${money(total)} ל-${email}`);
}

// 🟢 זיכרון של בני: תנאי תשלום / סף ללקוח (משפיע רק על התזכורות; כרטיס הלקוח במערכת לא משתנה)
async function doTerms(a, plan, lines) {
  const it = plan && [...plan.items, ...(plan.escalate || [])].find(x => x.id === Number(a.item) && a.list !== "files");
  const c = it ? { id: it.customerId, name: it.name } : await customerByName(a.customer);
  if (!c) { lines.push(`• תנאים: לא זיהיתי את הלקוח${a.customer ? ` "${oneLine(a.customer)}"` : ""}`); return; }
  const days = a.days != null && a.days >= 0 && a.days <= 180 ? Math.round(a.days) : null;
  const threshold = a.threshold != null && a.threshold > 0 && a.threshold < 1e7 ? Math.round(a.threshold) : null;
  if (days == null && threshold == null) { lines.push(`• ${c.name}: לא הבנתי מה התנאים`); return; }
  const mem = (await store.get("terms.json")) || {};
  mem[c.id] = { ...(mem[c.id] || {}), ...(days != null ? { days } : {}), ...(threshold != null ? { threshold } : {}), name: c.name, note: oneLine(a.note), at: Date.now() };
  await store.put("terms.json", mem);
  lines.push(`✅ ${c.name}: רשמתי — ${[days != null ? (days ? `שוטף+${days}` : "תשלום מיידי") : "", threshold != null ? `סף ${money(threshold)}` : ""].filter(Boolean).join(", ")} (לתזכורות שלי; כרטיס הלקוח במערכת לא השתנה)`);
}

async function doDebts(actions, plan, lines) {
  const all = plan ? plan.items.concat(plan.escalate || []) : [];
  const has = id => all.some(x => x.id === Number(id));
  const commands = [], sendIds = [];
  for (const a of actions) {
    if (a.type === "send_all") { if (plan) commands.push({ type: "send", all: true }); else lines.push("• אין תוכנית תזכורות פעילה"); continue; }
    if (plan && has(a.item)) {
      if (a.type === "send") sendIds.push(Number(a.item));
      else commands.push({ type: a.type, id: Number(a.item), note: oneLine(a.note), days: a.days });
      continue;
    }
    if ((a.type === "paid" || a.type === "snooze") && a.customer) {            // לקוח שלא ברשימה של היום
      const c = await customerByName(a.customer);
      if (!c) { lines.push(`• לא זיהיתי את הלקוח "${oneLine(a.customer)}"`); continue; }
      const days = a.type === "paid" ? 14 : Math.min(30, Math.max(1, parseInt(a.days, 10) || 30));
      const until = await snoozeCustomer(c.id, days, a.type, a.note);
      lines.push(a.type === "paid" ? `✅ ${c.name}: לא אזכיר עד ${heDate(until)}. ⚠️ את התשלום עצמו תרשום במערכת — את זה אני לא עושה לבד.`
        : `🟡 ${c.name}: התזכורות מוקפאות עד ${heDate(until)}${a.note ? " — " + oneLine(a.note) : ""}`);
      continue;
    }
    lines.push(`• לא הבנתי לאיזה חוב התכוונת${a.item ? ` (${a.item} לא ברשימה)` : ""}`);
  }
  if (sendIds.length) commands.unshift({ type: "send", ids: sendIds });
  if (commands.length) lines.push(...((await handleReply({ date: plan.date, commands })).lines || []));
}

// פקודות קבועות → אותו מבנה כמו פלט המוח (בלי לקרוא למוח)
function fixedActions(evt) {
  const ls = evt.text.split("\n").map(l => l.trim()).filter(Boolean);
  if (!ls.length) return null;
  if (/קבצי מודעות/.test(evt.subject) && ls.every(l => ATTACH_CMD.test(l))) {
    return ls.map(l => {
      const m = l.match(ATTACH_CMD), note = m[3].replace(/^[\s\-–—:,.]+/, "").trim(), pm = note.match(/מחיר\D{0,6}(\d[\d,]*(?:\.\d+)?)/);
      const type = /^חדש/.test(m[2]) ? "create_ad" : m[2] === "דלג" ? "skip" : "attach_option";
      return { type, list: "files", item: +m[1], option: type === "attach_option" ? m[2] : null, note, price: pm ? Number(pm[1].replace(/,/g, "")) : null };
    });
  }
  if (/תזכורות חוב/.test(evt.subject)) {
    const out = [];
    for (const l of ls) {
      let m;
      if (/^שלח\s+(הכל|הכול)(?=\s|$)/.test(l)) out.push({ type: "send_all", list: "debts" });
      else if ((m = l.match(/^שלח\s+([\d,\s]+)$/))) m[1].split(/[,\s]+/).filter(Boolean).forEach(n => out.push({ type: "send", list: "debts", item: +n }));
      else if ((m = l.match(/^(\d+)\s*(שילם|שילמה|שולם)(.*)$/))) out.push({ type: "paid", list: "debts", item: +m[1], note: m[3].replace(/^[\s\-–—:,.]+/, "").trim() });
      else if ((m = l.match(/^(\d+)\s*(לא להזכיר|הקפא|להקפיא)(.*)$/))) out.push({ type: "snooze", list: "debts", item: +m[1], note: m[3].replace(/^[\s\-–—:,.]+/, "").trim() });
      else return null;
    }
    return out;
  }
  return null;
}

// ---------- מייל מחיים ----------
async function onOwnerMail(evt, items) {
  if (!evt.text.trim() && evt.subject.trim()) evt.text = evt.subject;            // מייל שכל ההוראה בשורת הנושא
  const toBeni = /בני/.test(evt.subject) || /(^|[\s,.:;!?"'])בני([\s,.:;!?"']|$)/.test(evt.text);
  if (!toBeni || !evt.text.trim()) return;                      // מייל של חיים שלא פונה לבני — לא נוגעים
  const plan = await findPlan(null);
  const files = items.items.map(i => ({ item: i.n, customer: i.customer, emailSubject: i.subject, ...(i.handledAt ? { alreadyHandled: true } : {}),
    candidates: (i.candidates || []).map((c, k) => ({ option: LETTERS[k], title: c.title })) }));
  const debts = plan ? plan.items.map(i => ({ item: i.id, name: i.name, total: money(i.total), daysOverdue: i.daysOverdue, reminderNo: i.stage,
    hasEmail: !!i.sendable, overThreshold: !!i.over, alreadyDone: !!i.done }))
    .concat((plan.escalate || []).map(e => ({ item: e.id, name: e.name, total: money(e.total), escalated: "כבר קיבל 3 תזכורות — לטיפול חיים" }))) : [];

  let brain = { understood: null, reply: null, actions: fixedActions(evt) };
  if (!brain.actions) brain = await think(evt, files, debts);
  const lines = [], debtActs = [];
  for (const a of (brain.actions || []).slice(0, 30)) {
    if (a.type === "none") continue;
    if (a.type === "refuse") { lines.push(`🔴 ביקשת: ${oneLine(a.request) || "משהו שאינו בתפקיד שלי"} — זה אצלך, את זה אני לא עושה לבד.`); continue; }
    if (a.type === "send_clip") { await doClip(a, a.item ? items.items.find(i => i.n === Number(a.item)) : null, lines); continue; }
    if (a.type === "cancel_ad") { await doCancel(a, lines); continue; }
    if (a.type === "set_terms") { await doTerms(a, plan, lines); continue; }
    if (a.type === "send_pay_link") { await doPayLink(a, plan, lines); continue; }
    if (["send", "send_all", "paid", "snooze"].includes(a.type)) { debtActs.push(a); continue; }
    if (["create_ad", "attach_option", "skip"].includes(a.type)) {
      const it = items.items.find(i => i.n === Number(a.item));
      if (!it) { lines.push(`• ${a.item || "?"}: לא מצאתי פריט כזה (אולי כבר טופל)`); continue; }
      await doFiles(a, it, evt, lines); continue;
    }
    lines.push(`• "${a.type}" — לא מכיר את הפעולה הזו`);
  }
  if (debtActs.length) await doDebts(debtActs, plan, lines);

  const out = [];
  if (brain.understood) out.push(`הבנתי: ${brain.understood}`);
  if (lines.length) out.push(lines.join("\n"));
  if (brain.reply) out.push(brain.reply);
  if (!lines.length && !brain.reply) out.push("לא מצאתי מה לבצע. אפשר לנסח שוב, או לענות בפורמט הקבוע.");
  await store.addOp({ type: "reply", msgId: evt.id, body: out.join("\n\n") + "\n\nבני" });
}

// ---------- אחרי שהסקריפט ביצע פעולה ----------
async function onOpDone(op) {
  if (op.then.kind === "register") {
    const up = (op.result.uploaded || []).filter(u => typeof u.path === "string");
    if (!up.length) { await sendMail(OWNER, "⚠️ בני: העלאת קובץ נכשלה", `לא הצלחתי להעלות את הקובץ של "${op.then.subject}" למודעה #${op.then.adId}. תעלה ידנית מהמייל.\n\nבני`); return; }
    const r = await attach.register({ adId: op.then.adId, files: up, subject: op.then.subject });
    if (!r.ok) await sendMail(OWNER, "⚠️ בני: רישום קובץ נכשל", `הקובץ עלה אבל הרישום במודעה #${op.then.adId} נכשל (${r.error}).\n\nבני`);
  }
}

// ---------- ריצה ----------
async function runOnce() {
  let worked = false;
  for (const o of await store.list("op")) {
    const op = await store.get(o.path);
    if (!op || op.status !== "done" || !op.then) continue;
    if (!(await store.claim(`op_${op.id}`))) continue;
    worked = true;
    try { await onOpDone(op); } catch (e) { console.error("beni op", op.id, e); }
    await store.del([o.path]);
  }
  const evts = await store.list("evt");
  if (evts.length) {
    worked = true;
    const items = await store.getItems(), digest = [];
    for (const e of evts) {
      const evt = await store.get(e.path);
      if (!evt || !(await store.claim(`evt_${evt.id}`))) { await store.del([e.path]); continue; }
      try {
        if (evt.email === OWNER) await onOwnerMail(evt, items);
        else if (!SKIP_FROM.includes(evt.email)) await onCustomerMail(evt, digest, items);
      } catch (err) {
        console.error("beni evt", evt.id, err);
        await store.put("status.json", { ...((await store.get("status.json")) || {}), lastError: String(err.message || err).slice(0, 200), lastErrorAt: new Date().toISOString() }).catch(() => { });
        if (evt.email === OWNER) await store.addOp({ type: "reply", msgId: evt.id, body: `⚠️ לא הצלחתי לטפל בזה: ${String(err.message || err).slice(0, 200)}\nאפשר לנסות שוב, או לענות בפורמט הקבוע.\n\nבני` });
      }
      await store.del([e.path]);
    }
    await store.saveItems(items);
    if (digest.length) {
      await sendMail(OWNER, `${DIGEST_SUBJECT} (${digest.length})`,
        "לקוחות מזוהים שלחו קבצים לתיבת העסק, אבל לא היה לי ברור לאיזו מודעה לצרף:\n\n" + digest.join("\n\n") +
        "\n\nאפשר להשיב למייל הזה, שורה לכל פריט — למשל:\n1 חדשה במחיר 250\n2א\n3 דלג\n\n" +
        '"חדשה" = מודעה חדשה בגיליון הקרוב + הקובץ. מה שתכתוב אחרי נשמר בהערות המודעה; "במחיר X" קובע את המחיר.\n' +
        'אפשר גם במילים שלך ("הוא רוצה את הפרסום שלו ב-PDF, שלח לו") — אבצע מה שמותר לי לפי כרטיס העובד, ואם לא אהיה בטוח אשאל.\n\nבני');
    }
  }
  return worked;
}

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  // ריצה אחת בכל פעם; נעילה ישנה (ריצה שנפלה) משתחררת אחרי 10 דקות
  if (!(await store.put("lock/run.json", { at: Date.now() }, false))) {
    const lock = await store.get("lock/run.json");
    if (lock && Date.now() - lock.at < 10 * 60e3) return { statusCode: 202 };  // ריצה אחרת פעילה — היא תאסוף גם את זה
    await store.put("lock/run.json", { at: Date.now() });
  }
  try {
    for (let k = 0; k < 10 && await runOnce(); k++);             // עד שאין יותר מה לעשות
    if (Math.random() < 0.05) await store.cleanup();
  } catch (e) { console.error("beni-hub-background", e); }
  finally { await store.del(["lock/run.json"]); }
  return { statusCode: 202 };
};

exports._test = { runOnce, fixedActions, onOwnerMail, onCustomerMail };
