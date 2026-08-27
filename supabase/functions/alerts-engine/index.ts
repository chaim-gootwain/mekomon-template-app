// alerts-engine — מנוע ההתראות הגנרי (שלב 1)
// ------------------------------------------------------------
// זרימה: alert_events (לא-מעובדים) → כללים פעילים → condition →
//        dedup+throttle → alerts + alert_deliveries → משלוח לערוצים.
// פעולות (body.action): 'run' (ברירת מחדל: scan+process+deliver),
//                       'scan' | 'process' | 'deliver'.
// עקרונות-על: המנוע מודיע בלבד — לעולם לא מבצע פעולה כספית.
//             מתג ראשי (settings.alerts_enabled='1') כבוי → לא קורה כלום.
// הרשאות: מנהל פעיל (JWT) — או קריאה מתוזמנת עם מפתח ה-anon
//         (Scheduled Function / pg_cron+pg_net; אין בה חשיפת נתונים).
// ערוצים: inapp פעיל; email/whatsapp = stub שלא שולח כלום
//         (TODO: pending provider/secret).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
}
const BATCH = 200; // תקרת עיבוד לריצה אחת — נגד הצפה
/* ---------- עזרי מנוע ---------- */ // הצבת {placeholder} מתוך ה-payload בתבנית ההודעה של הכלל
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k)=>vars[k] === undefined || vars[k] === null ? '' : String(vars[k]));
}
function moneyIL(v) {
  const n = Number(v);
  return Number.isFinite(n) ? '₪' + n.toLocaleString('he-IL', {
    maximumFractionDigits: 2
  }) : String(v ?? '');
}
// בדיקת condition של כלל מול payload של אירוע.
// קונבנציה גנרית: {"threshold": N} → payload.balance (או payload.amount) >= N.
// condition ריק → הכלל תמיד תואם. פיצ'רים עתידיים מוסיפים מפתחות משלהם כאן.
function conditionMatches(condition, payload) {
  const cond = condition || {};
  if (cond.threshold !== undefined) {
    const v = Number(payload?.balance ?? payload?.amount);
    if (!Number.isFinite(v) || v < Number(cond.threshold)) return false;
  }
  return true;
}
// מפתח מניעת-כפילויות: debt_over:<customer_id>:<threshold> לאירוע החוב;
// ברירת מחדל גנרית לכל אירוע עתידי.
function dedupKeyFor(eventType, rule, payload) {
  if (eventType === 'debt_over_threshold') {
    return `debt_over:${payload?.customer_id}:${rule?.condition?.threshold ?? ''}`;
  }
  return `${eventType}:${rule.id}:${payload?.customer_id ?? payload?.id ?? ''}`;
}
function buildAlertText(eventType, rule, payload) {
  const vars = {
    ...payload,
    balance: moneyIL(payload?.balance),
    threshold: moneyIL(rule?.condition?.threshold)
  };
  if (eventType === 'debt_over_threshold') {
    return {
      title: `חוב מעל הסף — ${payload?.customer_name || 'לקוח'}`,
      body: rule.template ? fillTemplate(rule.template, vars) : `ללקוח ${payload?.customer_name || ''} חוב פתוח של ${vars.balance} (מעל הסף ${vars.threshold})`,
      severity: 'warning'
    };
  }
  return {
    title: rule.template ? fillTemplate(rule.template, vars) : eventType,
    body: rule.template ? fillTemplate(rule.template, vars) : JSON.stringify(payload),
    severity: 'info'
  };
}
/* ---------- שלבי המנוע ---------- */ // שלב א: סריקה — יצרן האירוע debt_over_threshold (SQL, security definer)
async function stepScan(svc) {
  const { data, error } = await svc.rpc('alerts_scan_debts');
  if (error) throw new Error('scan: ' + error.message);
  return {
    events_created: data ?? 0
  };
}
// שלב ב: עיבוד — אירועים לא-מעובדים → התראות + רשומות משלוח
async function stepProcess(svc) {
  const { data: events, error: eErr } = await svc.from('alert_events').select('*').is('processed_at', null).order('created_at', {
    ascending: true
  }).limit(BATCH);
  if (eErr) throw new Error('process/events: ' + eErr.message);
  if (!events?.length) return {
    events_processed: 0,
    alerts_created: 0,
    suppressed: 0
  };
  const types = [
    ...new Set(events.map((e)=>e.event_type))
  ];
  const { data: rules, error: rErr } = await svc.from('alert_rules').select('*').eq('enabled', true).in('event_type', types);
  if (rErr) throw new Error('process/rules: ' + rErr.message);
  let created = 0, suppressed = 0;
  for (const ev of events){
    const matching = (rules || []).filter((r)=>r.event_type === ev.event_type);
    for (const rule of matching){
      if (!conditionMatches(rule.condition, ev.payload)) continue;
      const dedupKey = dedupKeyFor(ev.event_type, rule, ev.payload);
      const throttleH = Number(rule.throttle_hours) > 0 ? Number(rule.throttle_hours) : 24;
      const since = new Date(Date.now() - throttleH * 3600 * 1000).toISOString();
      // בלימה: קיימת התראה פתוחה עם אותו מפתח, או התראה כלשהי בתוך חלון ה-throttle
      const { data: existing, error: dErr } = await svc.from('alerts').select('id,status,created_at').eq('dedup_key', dedupKey).or(`status.eq.new,created_at.gte.${since}`).limit(1);
      if (dErr) throw new Error('process/dedup: ' + dErr.message);
      if (existing?.length) {
        suppressed++;
        continue;
      }
      const txt = buildAlertText(ev.event_type, rule, ev.payload);
      const { data: alertRow, error: aErr } = await svc.from('alerts').insert({
        rule_id: rule.id,
        event_id: ev.id,
        title: txt.title,
        body: txt.body,
        severity: txt.severity,
        dedup_key: dedupKey,
        status: 'new'
      }).select('id').single();
      if (aErr) {
        // 23505 = הפרת האינדקס הייחודי החלקי (מרוץ) — נחשב כבלימה, לא ככשל
        if (String(aErr.code) === '23505') {
          suppressed++;
          continue;
        }
        throw new Error('process/insert: ' + aErr.message);
      }
      const channels = (rule.channels?.length ? rule.channels : [
        'inapp'
      ]).filter((c)=>[
          'inapp',
          'email',
          'whatsapp'
        ].includes(c));
      const rows = channels.map((c)=>({
          alert_id: alertRow.id,
          channel: c,
          status: 'queued'
        }));
      if (rows.length) {
        const { error: dvErr } = await svc.from('alert_deliveries').insert(rows);
        if (dvErr) throw new Error('process/deliveries: ' + dvErr.message);
      }
      created++;
    }
    const { error: mErr } = await svc.from('alert_events').update({
      processed_at: new Date().toISOString()
    }).eq('id', ev.id);
    if (mErr) throw new Error('process/mark: ' + mErr.message);
  }
  return {
    events_processed: events.length,
    alerts_created: created,
    suppressed
  };
}
/* ----- ערוצי המשלוח ----- */ // inapp: ההתראה כבר קיימת בטבלת alerts (זה הערוץ) — רק מסמנים שנשלח
async function sendInapp() {
  return {
    ok: true
  };
}
// email: stub — לא שולח כלום עד שיוגדרו ספק וסוד.
// TODO: pending provider/secret — כשיוחלט על ספק (למשל Resend/SMTP):
//   לקרוא סוד מ-Deno.env, לכבד את settings.alerts_email_enabled,
//   לשלוח לפי rule.recipients, ולמלא provider_msg_id.
async function sendEmailStub() {
  return {
    ok: false,
    error: 'channel not configured'
  };
}
// whatsapp: stub — לא שולח כלום עד שיוחלט על ספק (לא רלוונטי לשלב זה).
// TODO: pending provider/secret — כשיוחלט על ספק וואטסאפ:
//   אותו מבנה כמו המייל. אין קשר ל-call-dial (Voicenter) — לא נוגעים בה.
async function sendWhatsappStub() {
  return {
    ok: false,
    error: 'channel not configured'
  };
}
// שלב ג: משלוח — עובר על רשומות queued ומסמן sent/failed
async function stepDeliver(svc, settings) {
  const { data: queued, error: qErr } = await svc.from('alert_deliveries').select('*').eq('status', 'queued').order('created_at', {
    ascending: true
  }).limit(BATCH);
  if (qErr) throw new Error('deliver/queued: ' + qErr.message);
  if (!queued?.length) return {
    delivered: 0,
    failed: 0
  };
  let sent = 0, failed = 0;
  for (const d of queued){
    let res;
    if (d.channel === 'inapp') {
      res = await sendInapp();
    } else if (d.channel === 'email') {
      // גם כשהמתג דלוק — אין ספק/סוד עדיין, ולכן לא נשלח דבר (stub)
      res = settings.alerts_email_enabled === '1' ? await sendEmailStub() : {
        ok: false,
        error: 'channel not configured'
      };
    } else if (d.channel === 'whatsapp') {
      res = settings.alerts_whatsapp_enabled === '1' ? await sendWhatsappStub() : {
        ok: false,
        error: 'channel not configured'
      };
    } else {
      res = {
        ok: false,
        error: 'unknown channel'
      };
    }
    const patch = res.ok ? {
      status: 'sent',
      sent_at: new Date().toISOString(),
      error: null
    } : {
      status: 'failed',
      error: res.error || 'send failed'
    };
    const { error: uErr } = await svc.from('alert_deliveries').update(patch).eq('id', d.id);
    if (uErr) throw new Error('deliver/update: ' + uErr.message);
    res.ok ? sent++ : failed++;
  }
  return {
    delivered: sent,
    failed
  };
}
/* ---------- HTTP ---------- */ Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
    // ----- אימות הקורא -----
    // מסלול 1: קריאה מתוזמנת (Scheduled Function / pg_cron) עם מפתח ה-anon בלבד.
    // מסלול 2: משתמש מחובר — חייב להיות מנהל פעיל (כמו admin-users).
    const authHeader = req.headers.get('Authorization') || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isScheduledCall = !!ANON && bearer === ANON;
    if (!isScheduledCall) {
      const caller = createClient(SUPABASE_URL, ANON, {
        global: {
          headers: {
            Authorization: authHeader
          }
        }
      });
      const { data: { user }, error: uErr } = await caller.auth.getUser();
      if (uErr || !user) return json({
        error: 'לא מזוהה'
      }, 401);
      const { data: prof } = await svc.from('profiles').select('role, active').eq('id', user.id).single();
      if (!prof || prof.role !== 'admin' || prof.active === false) {
        return json({
          error: 'אין הרשאה — נדרש מנהל'
        }, 403);
      }
    }
    // ----- מתג ראשי -----
    const { data: sRows } = await svc.from('settings').select('key,value').in('key', [
      'alerts_enabled',
      'alerts_email_enabled',
      'alerts_whatsapp_enabled'
    ]);
    const settings = {};
    (sRows || []).forEach((r)=>settings[r.key] = r.value);
    if (settings.alerts_enabled !== '1') {
      return json({
        ok: true,
        skipped: 'alerts_disabled'
      });
    }
    let action = 'run';
    try {
      action = (await req.json())?.action || 'run';
    } catch (_) {}
    const out = {
      ok: true,
      action
    };
    if (action === 'scan' || action === 'run') Object.assign(out, await stepScan(svc));
    if (action === 'process' || action === 'run') Object.assign(out, await stepProcess(svc));
    if (action === 'deliver' || action === 'run') Object.assign(out, await stepDeliver(svc, settings));
    if (![
      'run',
      'scan',
      'process',
      'deliver'
    ].includes(action)) {
      return json({
        error: 'פעולה לא מוכרת'
      }, 400);
    }
    return json(out);
  } catch (e) {
    return json({
      error: e && e.message ? e.message : String(e)
    }, 500);
  }
});
