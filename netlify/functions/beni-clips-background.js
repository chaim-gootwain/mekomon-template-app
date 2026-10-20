// netlify/functions/beni-clips-background.js
// -----------------------------------------------------------------------------
// "בני" — שליחת העיתון לכל מפרסם אחרי כל גיליון (כרטיס העובד: 🟢 לבד).
//   גיליון שיצא לאור ביומיים האחרונים ושה-PDF שלו כבר בארכיון → כל לקוח עם מודעה משובצת
//   בגיליון (לא מבוטלת/נדחתה) ועם מייל תקין מקבל את גזיר המודעה שלו (beni-clip), פעם אחת לגיליון.
//   מי שקיבל נרשם ב-clips/<issue>.json (beni-state) — ריצה חוזרת לא שולחת שוב.
//   בסוף: סיכום אחד לחיים. מתג: clips_off.json (חיים: "בני, תפסיק לשלוח גזירים").
// -----------------------------------------------------------------------------
const store = require("../lib/beni-store");
const { sendClip } = require("../lib/beni-clip");
const { sendMail } = require("../lib/beni-mail");
const { sb, israelToday, getSetting, saveSetting } = require("../lib/beni-collect-core");

const TOKEN = process.env.BENI_INSERT_TOKEN;
const OWNER = process.env.BENI_OWNER_EMAIL || "e77050@gmail.com";
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const BUDGET_MS = 12 * 60e3;                                   // פונקציית רקע: עד 15 דקות

exports.handler = async (event) => {
  const hdr = event.headers || {};
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return { statusCode: 401 };
  const t0 = Date.now();
  try {
    if (await store.get("clips_off.json").then(v => v && v.off)) { await store.log("clips", { skipped: "off" }); return { statusCode: 202 }; }
    if (!(await store.claim(`clips_run_${israelToday()}_${new Date().getUTCHours()}`))) return { statusCode: 202 };  // ריצה אחת בשעה
    const T = israelToday(), from = new Date(Date.now() + 3 * 3600e3 - 2 * 86400e3).toISOString().slice(0, 10);
    const issues = await sb(`issues?select=id,issue_number,publish_date,pdf_path&pdf_path=not.is.null&publish_date=gte.${from}&publish_date=lte.${T}&order=publish_date.asc`);
    for (const iss of issues) {
      const key = `clips/${iss.id}.json`, rec = (await store.get(key)) || { sent: {}, failed: {}, noEmail: [] };
      const ads = await sb(`ads?select=customer_id&issue_id=eq.${iss.id}&page_number=not.is.null&status=not.in.(cancelled,rejected)&limit=1000`);
      // settings.clips_sent_<issue> — משותף לאתר: מי שקיבל גזיר (ידנית מכפתור "גזיר" או מבני) לא מקבל שוב,
      // ובאתר מוצג "גזיר נשלח ✓" במקום הכפתור
      const sentKey = `clips_sent_${iss.id}`, shared = new Set(String((await getSetting(sentKey)) || "").split(",").filter(Boolean));
      const custIds = [...new Set(ads.map(a => a.customer_id).filter(Boolean))].filter(id => !rec.sent[id] && !shared.has(String(id)));
      if (!custIds.length) continue;
      const custs = {}; (await sb(`customers?select=id,name,email&id=in.(${custIds.join(",")})`)).forEach(c => custs[c.id] = c);
      const now = { sent: [], failed: [], noEmail: [] };
      for (const id of custIds) {
        if (Date.now() - t0 > BUDGET_MS) break;                  // השאר — בריצה הבאה
        const c = custs[id] || { name: `#${id}` };
        if (!EMAIL_RE.test(String(c.email || "").trim())) { if (!rec.noEmail.includes(c.name)) { rec.noEmail.push(c.name); now.noEmail.push(c.name); } continue; }
        try {
          const r = await sendClip(id, { issueNumber: iss.issue_number });
          if (r.ok) {
            rec.sent[id] = Date.now(); delete rec.failed[id]; now.sent.push(c.name);
            const cur = new Set(String((await getSetting(sentKey)) || "").split(",").filter(Boolean)); cur.add(String(id));
            await saveSetting(sentKey, [...cur].join(",")).catch(e => console.error("clips_sent", e));
          }
          else { rec.failed[id] = r.error; now.failed.push(`${c.name} — ${r.error}`); }
        } catch (e) { rec.failed[id] = String(e.message || e).slice(0, 120); now.failed.push(`${c.name} — ${rec.failed[id]}`); }
        await store.put(key, rec);
      }
      await store.put(key, rec);
      await store.log("clips", { issue: iss.issue_number, sent: now.sent.length, failed: now.failed.length, noEmail: now.noEmail.length });
      if (now.sent.length || now.failed.length || now.noEmail.length) {
        await sendMail(OWNER, `📰 בני: גזירי גיליון ${iss.issue_number} נשלחו (${now.sent.length})`,
          `שלחתי לכל מפרסם בגיליון ${iss.issue_number} את גזיר המודעה שלו.\n\n` +
          (now.sent.length ? `✅ נשלח (${now.sent.length}): ${now.sent.join(", ")}\n\n` : "") +
          (now.failed.length ? `⚠️ לא נשלח:\n${now.failed.join("\n")}\n\n` : "") +
          (now.noEmail.length ? `📭 אין מייל בכרטיס (${now.noEmail.length}): ${now.noEmail.join(", ")}\n\n` : "") +
          `כדי לעצור את השליחה האוטומטית: "בני, תפסיק לשלוח גזירים".\n\nבני`);
      }
    }
  } catch (e) {
    console.error("beni-clips", e);
    await store.log("error", { where: "clips", error: String(e.message || e).slice(0, 120) });
  }
  return { statusCode: 202 };
};
