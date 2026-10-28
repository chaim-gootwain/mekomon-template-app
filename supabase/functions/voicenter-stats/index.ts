// ============================================================
// voicenter-stats — נתוני שיחות אמיתיים מ-Voicenter לפאנל הביצועים
// ------------------------------------------------------------
// קריאה בלבד. מושך את יומן השיחות (Call-Log / CDR) של Voicenter עבור
// השלוחה של הסוכן המחובר, ומחזיר סיכום פר יום (שעון ישראל):
//   calls      — שיחות יוצאות ללקוח (רגל הלקוח)
//   answered   — מתוכן נענו (DialStatus = ANSWER)
//   unanswered — לא נענו
//   talk_sec   — זמן שיחה מצטבר בשניות (Duration — בלי צלצול)
//
// API: https://api.voicenter.com/hub/cdr/  (POST, JSON)
//   code      — מזהה הארגון / טוקן (סוד VOICENTER_CDR_CODE)
//   fromdate/todate — ISO, GMT 0
//   extensions — השלוחה של הסוכן (agents.voicenter_ext)
// שימו לב: Voicenter מאשר רק כתובות IP מורשות (Cpanel). אם מתקבל
// ERROR_NUMBER 4 — צריך לאשר את ה-IP / לבקש טוקן שאינו נעול ל-IP.
//
// הרשאות: משתמש מחובר מקבל רק את השלוחה של עצמו. מנהל רשאי לבקש
// סוכן אחר (agent_id). פונקציית החיוג לא שונתה.
//
// body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', agent_id?: number, detail?: true }
// תשובה: { ok, ext, days: { 'YYYY-MM-DD': {calls,answered,unanswered,talk_sec} } }
//        עם detail — גם calls: [{id,at,dir:'out'|'in',number,answered,sec}]
//        (שיחות חוזרות מלקוחות שהסוכן חייג אליהם) + cdr_types, inbound_error
//        או { ok:false, code:'no_secret'|'no_ext'|'voicenter', error }
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

// רגל "הלקוח" של שיחה יוצאת: 4 = יוצאת מהשלוחה, 10 = Click2Call רגל 2,
// 15 = ProductiveCall רגל 2, 22 = Attended רגל 2. רגל 1 (9/14/21) היא
// הצלצול אל הסוכן עצמו — לא נספרת, אלא אם אין שום רגל 2 (ראה fallback).
const CUSTOMER_LEGS = new Set([4, 10, 15, 22]);
const AGENT_LEGS = new Set([9, 14, 21]);
// שיחה נכנסת מבחוץ (1 = Incoming). ⚠️ לאמת מול נתוני אמת — תשובת
// detail מחזירה cdr_types (ספירה פר CdrType) כדי שאפשר יהיה לבדוק.
const INBOUND_TYPES = new Set([1]);

// מספר ישראלי מנורמל: ספרות בלבד, 972 → 0 (כמו normPhone בצד הלקוח)
function normNum(p: unknown) {
  let s = String(p ?? '').replace(/\D/g, '');
  if (s.startsWith('972')) s = '0' + s.slice(3);
  return s.length >= 9 ? s : '';
}

const ilDay = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(d);

// תחילת יום בשעון ישראל → ISO ב-UTC (מטפל בשעון קיץ/חורף)
function ilDayStartUtc(day: string) {
  const guess = new Date(day + 'T00:00:00Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false
  }).formatToParts(guess);
  const h = Number(parts.find(p => p.type === 'hour')?.value || 0) % 24;
  return new Date(guess.getTime() - h * 3600000);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
    const CODE = Deno.env.get('VOICENTER_CDR_CODE') || '';

    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ ok: false, error: 'not authenticated' }, 401);

    const body = await req.json().catch(() => ({}));
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(body.from || ''), to = String(body.to || '');
    if (!re.test(from) || !re.test(to) || from > to) return json({ ok: false, error: 'bad range' }, 400);
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return json({ ok: false, error: 'range too long' }, 400);

    if (!CODE) return json({ ok: false, code: 'no_secret', error: 'VOICENTER_CDR_CODE לא הוגדר' });

    // איזה סוכן: ברירת מחדל — של המשתמש עצמו. סוכן אחר — מנהל בלבד.
    const { data: prof } = await caller.from('profiles').select('role').eq('id', user.id).maybeSingle();
    let q = caller.from('agents').select('id,voicenter_ext,profile_id');
    if (body.agent_id != null && prof?.role === 'admin') q = q.eq('id', Number(body.agent_id));
    else q = q.eq('profile_id', user.id);
    const { data: agent } = await q.maybeSingle();
    const ext = String(agent?.voicenter_ext || '').trim();
    if (!ext) return json({ ok: false, code: 'no_ext', error: 'לסוכן אין שלוחת Voicenter' });

    const fromUtc = ilDayStartUtc(from);
    const toUtc = new Date(ilDayStartUtc(to).getTime() + 86400000 - 1000);
    const vcReq = {
      code: CODE,
      fromdate: fromUtc.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      todate: toUtc.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      extensions: [ext],
      fields: ['CallID', 'DateEpoch', 'Duration', 'DialStatus', 'CdrType', 'Callerextension', 'Targetextension', 'TargetNumber']
    };
    const r = await fetch('https://api.voicenter.com/hub/cdr/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vcReq)
    });
    const data = await r.json().catch(() => null);
    if (!data || Number(data.ERROR_NUMBER) !== 0) {
      return json({
        ok: false, code: 'voicenter',
        error: `Voicenter ${data?.ERROR_NUMBER ?? r.status}: ${data?.ERROR_DESCRIPTION || 'no response'}`
      });
    }

    const list: any[] = Array.isArray(data.CDR_LIST) ? data.CDR_LIST : [];
    const hasCustomerLeg = list.some(c => CUSTOMER_LEGS.has(Number(c.CdrType)));
    const counted = list.filter(c => {
      const t = Number(c.CdrType);
      return hasCustomerLeg ? CUSTOMER_LEGS.has(t) : AGENT_LEGS.has(t);
    });

    const days: Record<string, { calls: number; answered: number; unanswered: number; talk_sec: number }> = {};
    const seen = new Set<string>();
    for (const c of counted) {
      const id = String(c.CallID || '') + ':' + c.CdrType;
      if (c.CallID && seen.has(id)) continue;
      seen.add(id);
      const day = ilDay(new Date(Number(c.DateEpoch) * 1000));
      const d = days[day] ||= { calls: 0, answered: 0, unanswered: 0, talk_sec: 0 };
      d.calls++;
      if (String(c.DialStatus).toUpperCase() === 'ANSWER') {
        d.answered++;
        d.talk_sec += Math.max(0, Number(c.Duration) || 0);
      } else d.unanswered++;
    }
    if (!body.detail) return json({ ok: true, ext, total: list.length, days });

    // ---------- detail: רשימת שיחות + שיחות חוזרות ----------
    // יוצאות: רגל הלקוח של הסוכן (המספר = TargetNumber).
    // נכנסות: שאילתה שנייה על כל הארגון (בלי סינון שלוחה — לקוח שחוזר
    // מתקשר בדרך כלל לקו הראשי ולא לשלוחה), ומחזירים רק שיחות ממספרים
    // שהסוכן עצמו חייג אליהם בטווח (CDR או call_log) — לא שיחות של אחרים.
    const calls: { id: string; at: number; dir: 'out' | 'in'; number: string; answered: boolean; sec: number }[] = [];
    const dialed = new Set<string>();
    if (hasCustomerLeg) {
      const seenOut = new Set<string>();
      for (const c of counted) {
        const num = normNum(c.TargetNumber);
        if (!num) continue;
        const key = String(c.CallID || '') + ':' + c.CdrType;
        if (c.CallID && seenOut.has(key)) continue;
        seenOut.add(key);
        dialed.add(num);
        calls.push({
          id: String(c.CallID || ''), at: Number(c.DateEpoch) || 0, dir: 'out', number: num,
          answered: String(c.DialStatus).toUpperCase() === 'ANSWER', sec: Math.max(0, Number(c.Duration) || 0)
        });
      }
    }
    const { data: logRows } = await caller.from('call_log').select('target')
      .eq('user_id', agent?.profile_id || user.id)
      .gte('created_at', fromUtc.toISOString()).lte('created_at', toUtc.toISOString()).limit(5000);
    (logRows || []).forEach((r: any) => { const n = normNum(r.target); if (n) dialed.add(n); });

    // cdr_types — ספירת כל סוגי הרשומות בשאילתת הארגון, לאימות INBOUND_TYPES
    const cdr_types: Record<string, number> = {};
    let inbound_error: string | null = null;
    if (dialed.size) {
      const r2 = await fetch('https://api.voicenter.com/hub/cdr/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...vcReq, extensions: undefined, fields: [...vcReq.fields, 'CallerNumber'] })
      });
      const d2 = await r2.json().catch(() => null);
      if (d2 && Number(d2.ERROR_NUMBER) === 0 && Array.isArray(d2.CDR_LIST)) {
        // שיחה נכנסת שצלצלה אצל כמה סוכנים = כמה רשומות לאותו CallID —
        // מאחדים לשיחה אחת, ונענתה אם אחת הרשומות נענתה
        const byId = new Map<string, { id: string; at: number; dir: 'in'; number: string; answered: boolean; sec: number }>();
        for (const c of d2.CDR_LIST) {
          const t = Number(c.CdrType);
          cdr_types[t] = (cdr_types[t] || 0) + 1;
          if (!INBOUND_TYPES.has(t)) continue;
          const num = normNum(c.CallerNumber);
          if (!num || !dialed.has(num)) continue;
          const id = String(c.CallID || '') || `${num}:${c.DateEpoch}`;
          const answered = String(c.DialStatus).toUpperCase() === 'ANSWER';
          const sec = Math.max(0, Number(c.Duration) || 0);
          const prev = byId.get(id);
          if (prev) { prev.answered ||= answered; prev.sec = Math.max(prev.sec, sec); continue; }
          byId.set(id, { id, at: Number(c.DateEpoch) || 0, dir: 'in', number: num, answered, sec });
        }
        calls.push(...byId.values());
      } else {
        inbound_error = `Voicenter ${d2?.ERROR_NUMBER ?? r2.status}: ${d2?.ERROR_DESCRIPTION || 'no response'}`;
      }
    }
    calls.sort((a, b) => a.at - b.at);
    return json({ ok: true, ext, total: list.length, days, calls, cdr_types, inbound_error });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
