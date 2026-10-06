// ============================================================
// weekly-summary — הסיכום השבועי האוטומטי של סוכן המקומון
// ------------------------------------------------------------
// פעם בשבוע (זמן מההגדרות, ברירת מחדל "ראשון 08:00") נשלח למנהל מייל:
// מה נסגר השבוע (עסקאות/מודעות/תשלומים), מצב החובות והחייבים הגדולים,
// לידים חדשים, מה תקוע בגרפיקה, ומבט לגיליון הקרוב. אם מוגדר
// ANTHROPIC_API_KEY — Claude מוסיף תקציר מנהלים קצר בראש המייל;
// בלעדיו (או בכשל) נשלחים הנתונים כמו-שהם. קריאה בלבד — לא כותב דבר
// מלבד חותם "נשלח לאחרונה".
//
// תזמון: אותו מנגנון של committee-digest — קרון שעתי (Dashboard →
// Integrations → Cron) עם Authorization=anon ו-x-cron-secret=CRON_SECRET;
// הפונקציה בודקת לבד אם השעה בשעון ישראל תואמת. body {force:true} =
// שליחה מיידית (כפתור הניסיון בהגדרות, מנהל בלבד).
//
// מתגים/הגדרות (settings):
//   weekly_summary_enabled  '1' = פעיל ('0' ברירת מחדל — רדום)
//   weekly_summary_emails   נמענים, מופרד בפסיקים
//   weekly_summary_time     "ראשון 08:00" (יום שעה, שעון ישראל)
//   weekly_summary_last_at  חותם השליחה האחרונה (מנוהל אוטומטית)
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
// השוואת סודות חסינת-תזמון — כמו ב-committee-digest
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
const HE_DAYS = {
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6,
  'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6
};
function parseSlot(s) {
  const m = String(s || '').trim().match(/^(\S+)\s+(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const day = HE_DAYS[m[1].toLowerCase()] ?? HE_DAYS[m[1]];
  const hour = Number(m[2]);
  if (day === undefined || !Number.isFinite(hour) || hour > 23) return null;
  return { day, hour };
}
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
const money = (n) => '₪' + (Math.round(Number(n) * 100) / 100).toLocaleString('he-IL');
const OPEN_STATUSES = ['pending', 'invoiced', 'partial', 'overdue'];

/* ---------- איסוף נתוני השבוע (service role — קריאה בלבד) ---------- */
async function collectData(svc) {
  const weekAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const weekAgoDate = weekAgoIso.slice(0, 10);
  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

  // עסקאות ומודעות חדשות
  const { data: newContracts } = await svc.from('contracts')
    .select('id,customer_id,total_inserts,total_price').gt('created_at', weekAgoIso).limit(100);
  const { data: newAds } = await svc.from('ads')
    .select('id,customer_id,price,discount').gt('created_at', weekAgoIso)
    .not('status', 'in', '("cancelled","rejected")').limit(500);
  const adsRevenue = (newAds || []).reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);

  // כספים: חיובים ותשלומים השבוע
  const { data: wkCharges } = await svc.from('charges').select('amount').gt('issued_date', weekAgoDate).limit(1000);
  const { data: wkPays } = await svc.from('payments').select('amount').gt('paid_date', weekAgoDate).limit(1000);
  const chargedWeek = (wkCharges || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const paidWeek = (wkPays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // חוב פתוח כולל + חמשת החייבים הגדולים
  const { data: openCharges } = await svc.from('charges')
    .select('id,customer_id,amount').in('status', OPEN_STATUSES).limit(2000);
  const paid = {};
  const ids = (openCharges || []).map((c) => c.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data: pays } = await svc.from('payments').select('charge_id,amount').in('charge_id', ids.slice(i, i + 150));
    (pays || []).forEach((p) => paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount));
  }
  const debtByCust = {};
  let debtTotal = 0;
  (openCharges || []).forEach((c) => {
    const bal = (Number(c.amount) || 0) - (paid[c.id] || 0);
    if (bal <= 0.001) return;
    debtTotal += bal;
    if (c.customer_id) debtByCust[c.customer_id] = (debtByCust[c.customer_id] || 0) + bal;
  });
  const topDebtors = Object.entries(debtByCust).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([cid, total]) => ({ cid: Number(cid), total: Math.round(total) }));

  // לידים חדשים השבוע
  const { data: newLeads } = await svc.from('leads')
    .select('id,name,status,created_at').gt('created_at', weekAgoIso)
    .order('created_at', { ascending: false }).limit(50);

  // תקוע בתהליך: מודעות שמחכות יותר מ-3 ימים
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data: stuckAds } = await svc.from('ads')
    .select('id,title,status,customer_id,created_at')
    .in('status', ['received', 'in_graphics', 'proof'])
    .lt('created_at', threeDaysAgo).limit(50);

  // הגיליון הקרוב
  const { data: nextIssues } = await svc.from('issues')
    .select('id,issue_number,publish_date').gte('publish_date', todayDate)
    .order('publish_date', { ascending: true }).limit(1);
  const nextIssue = (nextIssues || [])[0] || null;
  let nextIssueAds = 0;
  if (nextIssue) {
    const { count } = await svc.from('ads').select('id', { count: 'exact', head: true })
      .eq('issue_id', nextIssue.id).not('status', 'in', '("cancelled","rejected")');
    nextIssueAds = count || 0;
  }

  // שמות לקוחות לכל מה שנאסף
  const custIds = [...new Set([
    ...topDebtors.map((d) => d.cid),
    ...(stuckAds || []).map((a) => a.customer_id),
    ...(newContracts || []).map((c) => c.customer_id),
  ].filter(Boolean))];
  const custName = {};
  for (let i = 0; i < custIds.length; i += 150) {
    const { data: custs } = await svc.from('customers').select('id,name').in('id', custIds.slice(i, i + 150));
    (custs || []).forEach((c) => custName[c.id] = c.name);
  }

  return {
    newContracts: (newContracts || []).map((c) => ({ customer: custName[c.customer_id] || '', inserts: c.total_inserts, total: c.total_price })),
    newAdsCount: (newAds || []).length,
    adsRevenue: Math.round(adsRevenue),
    chargedWeek: Math.round(chargedWeek),
    paidWeek: Math.round(paidWeek),
    debtTotal: Math.round(debtTotal),
    debtorsCount: Object.keys(debtByCust).length,
    topDebtors: topDebtors.map((d) => ({ name: custName[d.cid] || '', total: d.total })),
    newLeads: (newLeads || []).map((l) => ({ name: l.name, status: l.status })),
    stuckAds: (stuckAds || []).map((a) => ({ title: a.title, status: a.status, customer: custName[a.customer_id] || '' })),
    nextIssue: nextIssue ? { number: nextIssue.issue_number, date: nextIssue.publish_date, ads: nextIssueAds } : null,
  };
}

/* ---------- תקציר מנהלים מ-Claude (אופציונלי — נופל בשקט) ---------- */
async function execSummary(data) {
  const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
  if (!API_KEY) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('MANAGER_AGENT_MODEL') || 'claude-opus-5',
        max_tokens: 1000,
        system: 'אתה סוכן המקומון — העוזר של מנהל מקומון. קיבלת נתוני סיכום שבועי כ-JSON. כתוב תקציר מנהלים בעברית: 3-5 משפטים, חמים וענייניים, עם המספרים החשובים באמת והדבר האחד שהכי דורש תשומת לב השבוע. בלי כותרות, בלי markdown, בלי רשימות — פסקה אחת זורמת. אל תמציא נתונים שלא ב-JSON.',
        messages: [{ role: 'user', content: JSON.stringify(data) }]
      })
    });
    if (!r.ok) return '';
    const resp = await r.json();
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return text.slice(0, 1500);
  } catch (_e) { return ''; }
}

/* ---------- בניית המייל ---------- */
function buildEmail(data, summary) {
  const sec = (title, inner) => inner
    ? `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:0 0 12px">
        <b style="font-size:15px">${title}</b><div style="margin-top:8px;font-size:13px;color:#334155">${inner}</div></div>`
    : '';
  const li = (s) => `<div style="margin:3px 0">• ${s}</div>`;

  const dealsInner = [
    li(`<b>${data.newAdsCount}</b> מודעות חדשות השבוע · שווי ${money(data.adsRevenue)} (לפני מע"מ)`),
    data.newContracts.length ? li(`<b>${data.newContracts.length}</b> חוזים חדשים: ` +
      data.newContracts.slice(0, 5).map((c) => esc(c.customer) + (c.total ? ' (' + money(c.total) + ')' : '')).join(', ')) : '',
  ].filter(Boolean).join('');

  const moneyInner = [
    li(`חויב השבוע: <b>${money(data.chargedWeek)}</b> · התקבל בפועל: <b>${money(data.paidWeek)}</b>`),
    li(`חוב פתוח כולל: <b style="color:#b45309">${money(data.debtTotal)}</b> (${data.debtorsCount} לקוחות)`),
    data.topDebtors.length ? li('החייבים הגדולים: ' + data.topDebtors.map((d) => esc(d.name) + ' — ' + money(d.total)).join(' · ')) : '',
  ].filter(Boolean).join('');

  const leadsInner = data.newLeads.length
    ? li(`<b>${data.newLeads.length}</b> לידים חדשים: ` + data.newLeads.slice(0, 8).map((l) => esc(l.name || '')).join(', '))
    : '<span style="color:#64748b">אין לידים חדשים השבוע</span>';

  const stuckInner = data.stuckAds.length
    ? data.stuckAds.slice(0, 8).map((a) => li(esc(a.title || 'מודעה') + (a.customer ? ' (' + esc(a.customer) + ')' : '') + ' — ממתינה מעל 3 ימים')).join('')
    : '<span style="color:#1a7f37">אין מודעות תקועות ✓</span>';

  const issueInner = data.nextIssue
    ? li(`גיליון <b>${esc(String(data.nextIssue.number))}</b> יוצא ב-${esc(String(data.nextIssue.date))} · <b>${data.nextIssue.ads}</b> מודעות נכנסו עד כה`)
    : '';

  const html = `<div dir="rtl" style="font-family:Arial,Heebo,sans-serif;max-width:640px;margin:0 auto;background:#f1f5f9;padding:18px;border-radius:12px">
    <h2 style="margin:0 0 2px">🤖 הסיכום השבועי — @@PAPER_NAME@@</h2>
    <div style="color:#64748b;font-size:13px;margin-bottom:14px">מסוכן המקומון, על שבעת הימים האחרונים</div>
    ${summary ? `<div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:14px;margin:0 0 12px;font-size:14px;line-height:1.6">${esc(summary)}</div>` : ''}
    ${sec('💼 מכירות', dealsInner)}
    ${sec('💰 כספים', moneyInner)}
    ${sec('📞 לידים', leadsInner)}
    ${sec('🎨 מה תקוע', stuckInner)}
    ${sec('🗞️ הגיליון הקרוב', issueInner)}
    <div style="color:#94a3b8;font-size:11px;margin-top:6px">נשלח אוטומטית מסוכן המקומון · לשינוי התזמון והנמענים: הגדרות ← סוכן המקומון</div>
  </div>`;
  const text = (summary ? summary + '\n\n' : '') +
    `מודעות חדשות: ${data.newAdsCount} (${money(data.adsRevenue)})\n` +
    `חויב: ${money(data.chargedWeek)} · התקבל: ${money(data.paidWeek)} · חוב פתוח: ${money(data.debtTotal)}\n` +
    `לידים חדשים: ${data.newLeads.length} · תקועות בגרפיקה: ${data.stuckAds.length}`;
  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    // אימות: קריאה מתוזמנת (CRON_SECRET) או מנהל מחובר — כמו committee-digest
    const authHeader = req.headers.get('Authorization') || '';
    const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
    const givenSecret = req.headers.get('x-cron-secret') || '';
    const isScheduledCall = !!CRON_SECRET && timingSafeEqual(givenSecret, CRON_SECRET);
    if (!isScheduledCall) {
      const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error: uErr } = await caller.auth.getUser();
      if (uErr || !user) return json({ error: 'לא מזוהה' }, 401);
      const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
      if (!prof || prof.role !== 'admin' || prof.active === false) return json({ error: 'אין הרשאה — נדרש מנהל' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true && !isScheduledCall; // כפייה רק למנהל מחובר

    // הגדרות
    const { data: sRows } = await svc.from('settings').select('key,value').in('key', [
      'weekly_summary_enabled', 'weekly_summary_emails', 'weekly_summary_time', 'weekly_summary_last_at'
    ]);
    const settings = {};
    (sRows || []).forEach((r) => settings[r.key] = r.value);
    if (!force && settings.weekly_summary_enabled !== '1') return json({ ok: true, skipped: 'disabled' });

    const recipients = String(settings.weekly_summary_emails || '').split(',')
      .map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!recipients.length) return json({ ok: false, error: 'אין נמענים — מלא "נמעני הסיכום" במסך ההגדרות' });

    // האם הגיע הזמן? (שליחה שבועית — חלון של שעה)
    const slot = parseSlot(settings.weekly_summary_time || 'ראשון 08:00') || { day: 0, hour: 8 };
    const nowIL = israelNow();
    const due = slot.day === nowIL.day && slot.hour === nowIL.hour;
    if (!force && !due) return json({ ok: true, skipped: 'not_due' });

    // הגנת כפל: לא פעמיים בתוך 6 ימים (הקרון שעתי)
    const lastAt = settings.weekly_summary_last_at ? new Date(settings.weekly_summary_last_at) : null;
    if (!force && lastAt && !isNaN(lastAt.getTime()) && (Date.now() - lastAt.getTime()) < 6 * 24 * 3600 * 1000) {
      return json({ ok: true, skipped: 'already_sent_this_week' });
    }

    // איסוף → תקציר → מייל
    const data = await collectData(svc);
    const summary = await execSummary(data);
    const { html, text } = buildEmail(data, summary);

    let sent = 0; const errors = [];
    for (const to of recipients) {
      const res = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SERVICE_ROLE, apikey: SERVICE_ROLE },
        body: JSON.stringify({ to, subject: '🤖 הסיכום השבועי — @@PAPER_NAME@@', body: text, html })
      });
      const out = await res.json().catch(() => ({}));
      if (out?.ok) sent++;
      else errors.push({ to, error: out?.detail || out?.error || 'http ' + res.status });
    }
    if (sent && !force) {
      await svc.from('settings').upsert({ key: 'weekly_summary_last_at', value: new Date().toISOString() });
    }
    return json({ ok: sent > 0, sent, errors, had_summary: !!summary });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
