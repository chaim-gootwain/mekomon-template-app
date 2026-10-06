// netlify/functions/beni-collect-daily.js
// -----------------------------------------------------------------------------
// "בני" — גבייה במצב צל: כל בוקר (א'–ה', ר' netlify.toml) בונה את תזכורות החוב של
// היום ושולח לחיים מייל אחד עם קישור לדף אישור (beni-collect). שום דבר לא נשלח
// ללקוחות מכאן — רק אחרי שחיים מסמן ולוחץ "שלח" בדף.
// env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_APP_PASSWORD, BENI_OWNER_EMAIL (אופציונלי)
// -----------------------------------------------------------------------------
const { buildPlan, saveSetting, newToken, money } = require("../lib/beni-collect-core");
const { sendMail } = require("../lib/beni-mail");

const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
const SITE = "https://imanuel-sheli.netlify.app";

exports.handler = async () => {
  try {
    const plan = await buildPlan();
    if (!plan.items.length && !plan.escalate.length) { console.log("beni-collect: nothing today"); return { statusCode: 200 }; }
    plan.token = newToken(); plan.status = "pending"; plan.created = new Date().toISOString();
    await saveSetting(`collect_plan_${plan.date}`, JSON.stringify(plan));
    const link = `${SITE}/.netlify/functions/beni-collect?d=${plan.date}&t=${plan.token}`;
    const ready = plan.items.filter(i => i.checked), held = plan.items.filter(i => !i.checked);
    const line = i => `${i.id}. ${i.name} — ${money(i.total)}, ${i.daysOverdue} ימים באיחור (תזכורת ${i.stage})` +
      (i.over ? " 🔴 מעל הסף" : "") + (!i.sendable ? " — אין מייל בכרטיס" : "");
    const body = `בוקר טוב,\n\nהכנתי ${plan.items.length} תזכורות חוב להיום. שום דבר עוד לא נשלח — מחכה לאישורך:\n${link}\n\n` +
      (ready.length ? `מוכנות לשליחה (${ready.length}):\n${ready.map(line).join("\n")}\n\n` : "") +
      (held.length ? `לא מסומנות — אתה מחליט (${held.length}):\n${held.map(line).join("\n")}\n\n` : "") +
      (plan.escalate.length ? `🔴 לטיפולך — כבר קיבלו 3 תזכורות:\n${plan.escalate.map(e => `${e.id}. ${e.name} — ${money(e.total)}, ${e.daysOverdue} ימים באיחור`).join("\n")}\n\n` : "") +
      `אפשר לאשר בדף (שם רואים את הנוסח המלא), או פשוט להשיב למייל הזה — שורה לכל פקודה:\n` +
      `שלח הכל — שולח את כל המוכנות (חוב מעל הסף רק אם תציין את המספר)\nשלח 1,3 — רק אלה\n2 שילם — לא אזכיר לו שבועיים (את התשלום אתה רושם במערכת)\n4 לא להזכיר — מקפיא לחודש\n` +
      `מה שתכתוב אחרי הפקודה נשמר כהערה.\nהקישור בתוקף 3 ימים.\n\nבני`;
    await sendMail(OWNER, `בני: תזכורות חוב להיום (${plan.items.length})`, body);
    console.log("beni-collect: plan", plan.date, plan.items.length, "items,", plan.escalate.length, "escalations");
    return { statusCode: 200 };
  } catch (e) {
    console.error("beni-collect-daily failed", e);
    try { await sendMail(OWNER, "⚠️ בני: לא הצלחתי להכין את תזכורות החוב", String(e.message || e).slice(0, 400) + "\n\nבני"); } catch (_) { }
    return { statusCode: 500 };
  }
};
