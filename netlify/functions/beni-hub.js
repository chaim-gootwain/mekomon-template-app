// netlify/functions/beni-hub.js
// -----------------------------------------------------------------------------
// "בני" — הצינור בין תיבת העסק (Apps Script beni/beni-attachments.gs) לשרת.
// הסקריפט בתיבה "טיפש" בכוונה: מעביר מיילים ומבצע פעולות שהשרת מבקש. כל ההחלטות כאן,
// כך שיכולת חדשה לבני = עדכון בשרת, בלי להדביק את הסקריפט מחדש.
//   POST { action:"events", messages:[...], legacy? }  ← מיילים חדשים בתיבה (+ פריטים מגרסה קודמת, פעם אחת)
//   GET  ?ops=1                                       → { ops:[{id, op}], busy } — פעולות לבצע בתיבה
//   POST { action:"opResult", opId, result }          ← תוצאת פעולה (למשל אילו קבצים עלו)
// הטיפול עצמו (ממושך: המוח, PDF) — ב-beni-hub-background.
// מוגן ב-BENI_INSERT_TOKEN (כותרת x-beni-token), כמו שאר פונקציות בני.
// -----------------------------------------------------------------------------
const store = require("../lib/beni-store");

const TOKEN = process.env.BENI_INSERT_TOKEN;
const SITE = process.env.URL || "https://imanuel-sheli.netlify.app";
const json = (statusCode, obj) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

const kick = () => fetch(`${SITE}/.netlify/functions/beni-hub-background`, { method: "POST", headers: { "x-beni-token": TOKEN }, body: "{}" })
  .catch(e => console.error("beni-hub kick", e));

function cleanMessage(m) {
  return { id: str(m.id, 40), thread: str(m.thread, 40), from: str(m.from, 200), email: str(m.email, 120).toLowerCase().trim(),
    subject: str(m.subject, 300), date: Number(m.date) || Date.now(), text: str(m.text, 4000), quoted: str(m.quoted, 3000),
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 15)
      .map(a => ({ i: parseInt(a.i, 10), name: str(a.name, 150), size: Number(a.size) || 0, type: str(a.type, 80) })) };
}

// דופק: מתי הסקריפט בתיבה דיבר עם השרת לאחרונה (לאבחון בלי לוגים)
const beat = (k, extra) => store.get("status.json").then(s => store.put("status.json", { ...(s || {}), [k]: new Date().toISOString(), ...(extra || {}) })).catch(() => { });

exports.handler = async (event) => {
  const hdr = event.headers || {};
  // GET ?status=1 — פתוח (בלי תוכן מיילים / סודות): רק זמנים ומונים
  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).status) {
    try {
      const s = (await store.get("status.json")) || {};
      return json(200, { ...s, log: await store.recentLog(20), pendingEvents: (await store.list("evt")).length, pendingOps: (await store.list("op")).length,
        running: !!(await store.get("lock/run.json")), now: new Date().toISOString(),
        // לאבחון הגדרת קארדקום — רק 3 ספרות אחרונות של המסוף ואורך שם המשתמש, לא הערכים עצמם
        cardcom: { terminalEnds: String(process.env.CARDCOM_TERMINAL || "").trim().slice(-3) || null,
          terminalDigits: String(process.env.CARDCOM_TERMINAL || "").replace(/\D/g, "").length, apiNameLength: String(process.env.CARDCOM_API_NAME || "").trim().length } });
    } catch (e) { return json(500, { error: String(e.message || e).slice(0, 200) }); }
  }
  if (!TOKEN || (hdr["x-beni-token"] || hdr["X-Beni-Token"]) !== TOKEN) return json(401, { error: "unauthorized" });
  try {
    if (event.httpMethod === "GET") {
      const now = Date.now(), out = [];
      for (const o of await store.list("op")) {
        const op = await store.get(o.path);
        if (!op) continue;
        if (op.status === "sent" && now - op.sentAt > 30 * 60e3) {         // נשלחה ולא חזרה תשובה
          if (op.op.type === "reply" || (op.tries || 0) >= 3) { await store.del([o.path]); continue; } // תשובה — לא שולחים פעמיים
          op.status = "pending";
        }
        if (op.status !== "pending") continue;
        op.status = "sent"; op.sentAt = now; op.tries = (op.tries || 0) + 1;
        await store.put(o.path, op);
        out.push({ id: op.id, op: op.op });
        if (out.length >= 10) break;
      }
      const pending = (await store.list("evt")).length > 0, running = !!(await store.get("lock/run.json"));
      if (pending && !running) await kick();                               // אירוע שנתקע (הגיע בדיוק כשריצה הסתיימה)
      const busy = pending || running;
      await beat("lastOpsPoll");
      return json(200, { ops: out, busy });
    }

    if (event.httpMethod !== "POST") return json(405, {});
    let b; try { b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }

    if (b.action === "events") {
      let queued = 0;
      for (const m of (Array.isArray(b.messages) ? b.messages : []).slice(0, 30)) {
        const msg = cleanMessage(m);
        if (!/^[A-Za-z0-9]{6,40}$/.test(msg.id)) continue;
        if (await store.get(`claim/evt_${msg.id}.json`)) continue;           // כבר טופל
        await store.put(`evt/${msg.id}.json`, msg); queued++;
      }
      if (b.legacy && Array.isArray(b.legacy.items) && b.legacy.items.length) {  // פריטים ממוספרים מהגרסה הקודמת של הסקריפט
        const s = await store.getItems();
        b.legacy.items.forEach(it => {
          if (s.items.some(x => x.n === it.n)) return;
          s.items.push({ n: +it.n, msgId: str(it.msgId, 40), customerId: +it.customerId, customer: str(it.customer, 120), subject: str(it.subject, 300),
            candidates: (it.candidates || []).slice(0, 10),
            files: Array.isArray(it.files) ? it.files.slice(0, 10).map(f => ({ i: parseInt(f.i, 10), name: str(f.name, 150), size: Number(f.size) || 0, type: str(f.type, 80) })) : null,
            handledAt: it.handled ? (it.handledAt || Date.now()) : null });
        });
        s.seq = Math.max(s.seq, Number(b.legacy.seq) || 0, ...s.items.map(x => x.n));
        await store.saveItems(s);
      }
      await store.log("events", { n: (b.messages || []).length, queued, ids: (b.messages || []).slice(0, 10).map(m => String(m.id).slice(-6)) });
      await beat("lastEvents", { lastEventsCount: (b.messages || []).length, lastQueued: queued,
        lastMessageDates: (b.messages || []).slice(0, 10).map(m => new Date(Number(m.date) || 0).toISOString()) });
      if (queued) await kick();
      return json(200, { ok: true, queued });
    }

    if (b.action === "opResult") {
      const path = `op/${store.safe(b.opId)}.json`, op = await store.get(path);
      if (!op) return json(200, { ok: false, error: "no_op" });
      if (!op.then) { await store.del([path]); return json(200, { ok: true }); }
      op.status = "done"; op.result = b.result || {};
      await store.put(path, op);
      await kick();
      return json(200, { ok: true });
    }
    return json(400, { error: "bad_action" });
  } catch (e) {
    console.error("beni-hub", e);
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
};
