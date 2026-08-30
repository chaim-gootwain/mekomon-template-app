-- ============================================================
-- מיגרציה: מנוע התראות גנרי (Alerts Engine) — שלב 2
-- ------------------------------------------------------------
-- מרחיבה את 2026-08-24_alerts_engine.sql (חובה להריץ אותה קודם!).
-- לא משכתבת דבר מהקיים — רק מוסיפה:
--   1. RPC ‏alerts_publish_event — נקודת כניסה גנרית: כל מודול במערכת
--      (וכל פיצ'ר עתידי) מפרסם אירוע למנוע בקריאה אחת.
--   2. סורק דדליין גיליון alerts_scan_issue_deadlines() — אירוע
--      issue_deadline לגיליונות שדדליין המודעות שלהם מתקרב.
--   3. עוטף alerts_scan_all() שמריץ את כל הסורקים — ומחליף את
--      ג'וב ה-pg_cron הישן (alerts-daily-debt-scan → alerts-daily-scan).
--   4. כללים חדשים: issue_deadline (פעיל), payment_failed ו-check_bounced
--      (כבויים — ממתינים לפיצ'רים שיפרסמו את האירועים).
--   5. מפתח settings חדש: alerts_email_to — נמען ערוץ המייל.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- המנוע מודיע בלבד — אף פעולה כספית לא מתבצעת מכאן.
-- ============================================================

-- ==================== 1. פרסום אירוע — RPC גנרי ====================
-- כל משתמש פעיל (לא רק מנהל) רשאי לפרסם אירוע; מי שרואה את ההתראות
-- שנוצרות נשאר מנהל בלבד (RLS על alerts לא משתנה).
create or replace function public.alerts_publish_event(
  p_event_type text,
  p_payload    jsonb default '{}'::jsonb,
  p_source     text  default null
) returns bigint
language plpgsql security definer set search_path = public
as $fn$
declare
  v_id bigint;
begin
  if not exists (select 1 from profiles p where p.id = auth.uid() and p.active) then
    raise exception 'not allowed';
  end if;
  if p_event_type is null or btrim(p_event_type) = '' or length(p_event_type) > 60
     or p_event_type !~ '^[a-z0-9_]+$' then
    raise exception 'bad event_type';
  end if;

  insert into alert_events (event_type, payload, source)
  values (p_event_type, coalesce(p_payload, '{}'::jsonb), coalesce(p_source, 'app'))
  returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.alerts_publish_event(text, jsonb, text) from public, anon;
grant execute on function public.alerts_publish_event(text, jsonb, text) to authenticated, service_role;

comment on function public.alerts_publish_event(text, jsonb, text)
  is 'מנוע התראות: פרסום אירוע גנרי מכל מודול. המנוע (alerts-engine) מעבד לפי הכללים.';

-- ==================== 2. סורק דדליין גיליון ====================
-- אירוע issue_deadline לכל גיליון פתוח שדדליין המודעות שלו בתוך חלון
-- ה-hours_before הגדול ביותר מבין הכללים הפעילים. הכלל עצמו מסנן שוב
-- במנוע לפי ה-hours_before שלו (payload.hours_left).
create or replace function public.alerts_scan_issue_deadlines() returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
  v_hours numeric;
  v_count integer := 0;
begin
  if coalesce((select value from settings where key = 'alerts_enabled'), '0') <> '1' then
    return 0;
  end if;

  select max((condition->>'hours_before')::numeric) into v_hours
  from alert_rules
  where event_type = 'issue_deadline' and enabled
    and (condition->>'hours_before') ~ '^[0-9]+(\.[0-9]+)?$';
  if v_hours is null then
    return 0;
  end if;

  with ins as (
    insert into alert_events (event_type, payload, source)
    select 'issue_deadline',
           jsonb_build_object(
             'issue_id',     i.id,
             'issue_number', i.issue_number,
             'ads_deadline', i.ads_deadline,
             'hours_left',   round(extract(epoch from (i.ads_deadline - now())) / 3600, 1)
           ),
           'daily_scan'
    from issues i
    where i.ads_deadline is not null
      and coalesce(i.status, '') not in ('closed', 'published')
      and i.ads_deadline > now()
      and i.ads_deadline <= now() + make_interval(hours => v_hours::int)
      -- לא לערום אירוע חדש כשיש כבר אירוע זהה שממתין לעיבוד
      and not exists (
        select 1 from alert_events e
        where e.event_type = 'issue_deadline'
          and e.processed_at is null
          and (e.payload->>'issue_id')::bigint = i.id
      )
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end;
$fn$;

revoke all on function public.alerts_scan_issue_deadlines() from public, anon, authenticated;
grant execute on function public.alerts_scan_issue_deadlines() to service_role;

-- ==================== 3. עוטף כל הסורקים + עדכון התזמון ====================
create or replace function public.alerts_scan_all() returns integer
language plpgsql security definer set search_path = public
as $fn$
begin
  return coalesce(public.alerts_scan_debts(), 0)
       + coalesce(public.alerts_scan_issue_deadlines(), 0);
end;
$fn$;

revoke all on function public.alerts_scan_all() from public, anon, authenticated;
grant execute on function public.alerts_scan_all() to service_role;

-- ג'וב יומי חדש שמריץ את כל הסורקים; מסיר את הג'וב הישן (חוב בלבד) אם קיים.
do $mig$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron לא זמין במופע הזה (%). חלופה: לתזמן את ה-Edge Function ‏alerts-engine פעם ביום דרך Dashboard → Integrations → Cron.', sqlerrm;
    return;
  end;

  begin
    perform cron.unschedule('alerts-daily-debt-scan');
  exception when others then
    null; -- הג'וב הישן לא קיים — זה בסדר
  end;
  begin
    perform cron.unschedule('alerts-daily-scan');
  exception when others then
    null;
  end;

  perform cron.schedule('alerts-daily-scan', '0 3 * * *',
                        'select public.alerts_scan_all();');
  raise notice 'תוזמן ג''וב יומי: alerts-daily-scan (03:00 UTC) — כל הסורקים.';
exception when others then
  raise notice 'תזמון pg_cron נכשל (%). חלופה: לתזמן את alerts-engine דרך Dashboard → Integrations → Cron.', sqlerrm;
end $mig$;

-- ==================== 4. כללים חדשים ====================
-- issue_deadline — פעיל: התראה כשדדליין מודעות בתוך 48 שעות.
insert into public.alert_rules (event_type, enabled, condition, channels, template, throttle_hours, recipients)
select 'issue_deadline', true, '{"hours_before": 48}'::jsonb, array['inapp'],
       'דדליין המודעות לגיליון {issue_number} בעוד {hours_left} שעות',
       24, '{"roles":["admin"]}'::jsonb
where not exists (select 1 from public.alert_rules where event_type = 'issue_deadline');

-- payment_failed / check_bounced — כבויים: אין עדיין מודול שמפרסם את
-- האירועים האלה; כשפיצ'ר עתידי יקרא ל-alerts_publish_event הם יופעלו מההגדרות.
insert into public.alert_rules (event_type, enabled, condition, channels, template, throttle_hours, recipients)
select 'payment_failed', false, '{}'::jsonb, array['inapp'],
       'תשלום של {customer_name} נכשל — {amount}',
       24, '{"roles":["admin"]}'::jsonb
where not exists (select 1 from public.alert_rules where event_type = 'payment_failed');

insert into public.alert_rules (event_type, enabled, condition, channels, template, throttle_hours, recipients)
select 'check_bounced', false, '{}'::jsonb, array['inapp'],
       'צ''ק של {customer_name} חזר — {amount}',
       24, '{"roles":["admin"]}'::jsonb
where not exists (select 1 from public.alert_rules where event_type = 'check_bounced');

-- ==================== 5. נמען ערוץ המייל ====================
-- ריק = ערוץ המייל לא שולח (גם כשהמתג דלוק). ממולא מההגדרות במערכת.
insert into public.settings (key, value) values ('alerts_email_to', '')
  on conflict (key) do nothing;
