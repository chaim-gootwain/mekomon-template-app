// ============================================================
// committee-digest — דיוור מרוכז לוועדה (אוטומציית המודעות)
// ------------------------------------------------------------
// הוועדה יצאה מהמסלול החוסם; במקומה מייל מרוכז בזמנים קבועים עם
// כל המודעות שנכנסו מאז הדיוור הקודם (לקוח, תיאור, תוכן, קבצים).
// הוועדה משיבה למייל של העיתון — הטיפול בהתנגדות נעשה ידנית.
//
// תזמון: פעם בשעה (Dashboard → Integrations → Cron, עם מפתח ה-anon).
// הפונקציה בודקת לבד אם השעה הנוכחית (שעון ישראל) היא אחד מזמני
// הדיוור שבהגדרות ושולחת רק אז. body {force:true} = שליחה מיידית
// (כפתור הבדיקה בהגדרות, מנהל בלבד).
//
// מתגים/הגדרות (settings):
//   committee_digest_enabled  '1' = פעיל
//   committee_emails          נמענים, מופרד בפסיקים
//   committee_digest_times    "רביעי 20:00, חמישי 13:00, חמישי 19:00"
//   committee_digest_last_at  חותם הדיוור האחרון (מנוהל אוטומטית)
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

const DEFAULT_TIMES = 'רביעי 20:00, חמישי 13:00, חמישי 19:00';
const HE_DAYS = {
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6,
  'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6
};

// "רביעי 20:00" → {day:3, hour:20}; פריט לא-תקין מוחזר null ומדולג
function parseSlot(s) {
  const m = String(s || '').trim().match(/^(\S+)\s+(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const day = HE_DAYS[m[1].toLowerCase()] ?? HE_DAYS[m[1]];
  const hour = Number(m[2]);
  if (day === undefined || !Number.isFinite(hour) || hour > 23) return null;
  return { day, hour };
}

// היום והשעה עכשיו בשעון ישראל (חסין שעון קיץ/חורף)
function israelNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', hour12: false
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase() || '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[wd.slice(0, 3)];
  return { day, hour };
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

const AD_STATUS_HE = {
  received: 'התקבלה', in_graphics: 'בגרפיקה', proof: 'פרוף מוכן', committee: 'בבדיקה',
  approved: 'מאושרת לשיבוץ', placed: 'שובצה', published: 'פורסמה'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    // ----- אימות: קריאה מתוזמנת (anon) או מנהל מחובר -----
    const authHeader = req.headers.get('Authorization') || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isScheduledCall = !!ANON && bearer === ANON;
    if (!isScheduledCall) {
      const caller = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } }
      });
      const { data: { user }, error: uErr } = await caller.auth.getUser();
      if (uErr || !user) return json({ error: 'לא מזוהה' }, 401);
      const { data: prof } = await svc.from('profiles').select('role, active').eq('id', user.id).single();
      if (!prof || prof.role !== 'admin' || prof.active === false) {
        return json({ error: 'אין הרשאה — נדרש מנהל' }, 403);
      }
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true && !isScheduledCall; // כפייה רק למנהל מחובר

    // ----- הגדרות -----
    const { data: sRows } = await svc.from('settings').select('key,value').in('key', [
      'committee_digest_enabled', 'committee_emails', 'committee_digest_times', 'committee_digest_last_at'
    ]);
    const settings = {};
    (sRows || []).forEach((r) => settings[r.key] = r.value);
    if (settings.committee_digest_enabled !== '1') return json({ ok: true, skipped: 'disabled' });

    const recipients = String(settings.committee_emails || '').split(',')
      .map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!recipients.length) return json({ ok: false, error: 'אין נמענים (committee_emails)' });

    // ----- האם הגיע זמן דיוור? -----
    const slots = String(settings.committee_digest_times || DEFAULT_TIMES)
      .split(',').map(parseSlot).filter(Boolean);
    const nowIL = israelNow();
    const due = slots.some((s) => s.day === nowIL.day && s.hour === nowIL.hour);
    if (!force && !due) return json({ ok: true, skipped: 'not_due' });

    // הגנת כפל: לא שולחים פעמיים בתוך אותה שעה
    const lastAt = settings.committee_digest_last_at ? new Date(settings.committee_digest_last_at) : null;
    if (!force && lastAt && (Date.now() - lastAt.getTime()) < 55 * 60 * 1000) {
      return json({ ok: true, skipped: 'already_sent_this_hour' });
    }

    // ----- המודעות שנכנסו מאז הדיוור הקודם -----
    const sinceIso = (lastAt && !isNaN(lastAt.getTime()))
      ? lastAt.toISOString()
      : new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: ads } = await svc.from('ads')
      .select('id, title, content_text, status, created_at, customer_id, issue_id, source')
      .gt('created_at', sinceIso)
      .not('status', 'in', '("cancelled","rejected")')
      .order('created_at', { ascending: true })
      .limit(200);
    if (!ads || !ads.length) {
      // אין מודעות חדשות — אין מייל ריק, אבל מזיזים את הסמן קדימה
      await svc.from('settings').upsert({ key: 'committee_digest_last_at', value: new Date().toISOString() });
      return json({ ok: true, sent: 0, skipped: 'no_new_ads' });
    }

    // שמות לקוחות + מספרי גיליונות + קבצים בבת אחת
    const custIds = [...new Set(ads.map((a) => a.customer_id).filter(Boolean))];
    const issueIds = [...new Set(ads.map((a) => a.issue_id).filter(Boolean))];
    const adIds = ads.map((a) => a.id);
    const [{ data: custs }, { data: issues }, { data: files }] = await Promise.all([
      custIds.length ? svc.from('customers').select('id,name').in('id', custIds) : Promise.resolve({ data: [] }),
      issueIds.length ? svc.from('issues').select('id,issue_number').in('id', issueIds) : Promise.resolve({ data: [] }),
      svc.from('ad_files').select('ad_id,storage_path,file_name,kind,created_at').in('ad_id', adIds).order('created_at', { ascending: false })
    ]);
    const custName = {}; (custs || []).forEach((c) => custName[c.id] = c.name);
    const issueNum = {}; (issues || []).forEach((i) => issueNum[i.id] = i.issue_number);

    // קובץ אחד לכל מודעה: עיצוב אם יש, אחרת המקור מהלקוח — קישור חתום לשבוע
    const fileFor = {};
    for (const f of files || []) {
      const cur = fileFor[f.ad_id];
      if (!cur || (cur.kind !== 'design' && f.kind === 'design')) fileFor[f.ad_id] = f;
    }
    for (const id of Object.keys(fileFor)) {
      try {
        const { data } = await svc.storage.from('ad-files').createSignedUrl(fileFor[id].storage_path, 7 * 24 * 3600);
        fileFor[id].url = data?.signedUrl || '';
      } catch (_e) { fileFor[id].url = ''; }
    }

    // ----- בניית המייל -----
    const heDT = (d) => new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rows = ads.map((a) => {
      const f = fileFor[a.id];
      return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:0 0 12px;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <b style="font-size:15px">${esc(a.title || 'מודעה #' + a.id)}</b>
          <span style="color:#64748b;font-size:13px">${esc(custName[a.customer_id] || '')}</span>
        </div>
        <div style="color:#64748b;font-size:12px;margin-top:2px">
          התקבלה: ${heDT(a.created_at)}
          ${a.issue_id ? ' · גיליון ' + esc(issueNum[a.issue_id] || '') : ''}
          · סטטוס: ${esc(AD_STATUS_HE[a.status] || a.status)}
          ${a.source === 'contract' ? ' · מחוזה' : a.source === 'portal' ? ' · מהפורטל' : ''}
        </div>
        ${a.content_text ? `<div style="background:#f8fafc;border-radius:8px;padding:10px;margin-top:8px;font-size:13px;white-space:pre-wrap">${esc(String(a.content_text).slice(0, 1200))}</div>` : ''}
        ${f && f.url ? `<div style="margin-top:8px"><a href="${esc(f.url)}" style="color:#3b4dd8;font-size:13px">📎 ${esc(f.file_name || 'צפייה בקובץ')} (${f.kind === 'design' ? 'עיצוב' : 'מקור מהלקוח'})</a></div>` : ''}
      </div>`;
    }).join('');

    const html = `<div dir="rtl" style="font-family:Arial,Heebo,sans-serif;max-width:640px;margin:0 auto;background:#f1f5f9;padding:18px;border-radius:12px">
      <h2 style="margin:0 0 2px">מודעות לעיון הוועדה — @@PAPER_NAME@@</h2>
      <div style="color:#64748b;font-size:13px;margin-bottom:14px">${ads.length} מודעות שנכנסו מאז הדיוור הקודם. יש הערה או התנגדות? פשוט השיבו למייל הזה.</div>
      ${rows}
      <div style="color:#94a3b8;font-size:11px;margin-top:6px">נשלח אוטומטית ממערכת הניהול · קישורי הקבצים בתוקף לשבוע</div>
    </div>`;
    const textBody = ads.map((a) => `• ${a.title || 'מודעה #' + a.id} — ${custName[a.customer_id] || ''}`).join('\n');

    // ----- שליחה דרך send-email (קריאה פנימית עם service_role) -----
    let sent = 0; const errors = [];
    for (const to of recipients) {
      const res = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SERVICE_ROLE, apikey: SERVICE_ROLE },
        body: JSON.stringify({
          to,
          subject: `🕮 מודעות לעיון הוועדה (${ads.length}) — @@PAPER_NAME@@`,
          body: textBody, html
        })
      });
      const out = await res.json().catch(() => ({}));
      if (out?.ok) sent++;
      else errors.push({ to, error: out?.detail || out?.error || 'http ' + res.status });
    }

    if (sent) {
      await svc.from('settings').upsert({ key: 'committee_digest_last_at', value: new Date().toISOString() });
    }
    return json({ ok: sent > 0, sent, ads: ads.length, errors });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
