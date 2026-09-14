-- ============================================================
-- מיגרציה: ברכת "בוקר טוב" — מעבר מהפעמון לצ'אט הצוות (v2)
-- ------------------------------------------------------------
-- דורשת: 2026-09-13_team_chat.sql + 2026-09-14_morning_greeting.sql.
-- לפי בקשת חיים: הברכה מתפרסמת כהודעה בערוץ הקבוצתי של צ'אט הצוות
-- (לשונית "צ'אט צוות" — הבאדג' נדלק לכל הצוות), לא כהתראה בפעמון.
--
-- מה משתנה:
--   1. alerts_scan_morning(): במקום התראת inapp פר משתמש — הודעת
--      מערכת אחת (sender_user = null) בערוץ 'group' של team_messages.
--      תלויה רק ב-morning_greeting_enabled (לא במתג הפעמון
--      alerts_enabled — הצ'אט לא קשור לפעמון). סימון "פעם ביום"
--      נשאר דרך אירוע good_morning ב-alert_events, כמו קודם.
--   2. alerts_morning_test(): תצוגה מקדימה בלבד — מחזירה את נוסח
--      הברכה של היום בלי לפרסם כלום (פרסום בצ'אט גלוי לכל הצוות,
--      אז בדיקה לא שולחת).
-- שאר התשתית של v1 (מאגר morning_messages, {city}, alerts.user_id,
-- ה-RLS והתזמון ב-pg_cron) נשארת כמות שהיא — הג'וב קורא לאותה פונקציה.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. הסורק — מפרסם לצ'אט הקבוצתי ====================
create or replace function public.alerts_scan_morning() returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
  v_now_il   timestamp;  -- שעון קיר ישראל (Postgres מטפל בשעון קיץ)
  v_today    date;
  v_msg      text;
  v_city     text;
  v_active   integer;
  v_event_id bigint;
begin
  if coalesce((select value from settings where key = 'morning_greeting_enabled'), '0') <> '1' then
    return 0;
  end if;

  v_now_il := now() at time zone 'Asia/Jerusalem';
  v_today  := v_now_il::date;
  -- לא מברכים "בוקר טוב" באמצע הלילה (ריצת כניסה של מנהל מוקדם/מאוחר)
  if v_now_il::time < time '05:00' then
    return 0;
  end if;

  -- פעם אחת בבוקר: כבר נוצר אירוע good_morning היום (לפי תאריך ישראל)?
  if exists (
    select 1 from alert_events e
    where e.event_type = 'good_morning'
      and (e.created_at at time zone 'Asia/Jerusalem')::date = v_today
  ) then
    return 0;
  end if;

  -- רוטציה: יום-בשנה מודולו מספר ההודעות הפעילות
  select count(*) into v_active from morning_messages where active;
  if v_active = 0 then
    return 0;
  end if;
  select t.text into v_msg
  from (select m.text, row_number() over (order by m.id) - 1 as rn
        from morning_messages m where m.active) t
  where t.rn = extract(doy from v_today)::int % v_active;

  -- {city} → שם העיר של המופע (משתנה פר עסק, מוגדר בהגדרות)
  v_city := coalesce(nullif(btrim((select value from settings where key = 'paper_city')), ''), 'עיר שלנו');
  v_msg  := replace(v_msg, '{city}', v_city);

  -- סימון היום (dedup יומי) — נשאר על מסלול האירועים של המנוע
  insert into alert_events (event_type, payload, source, processed_at)
  values ('good_morning',
          jsonb_build_object('message', v_msg, 'date', v_today, 'channel', 'team_chat'),
          'morning_schedule', now())
  returning id into v_event_id;

  -- הודעת מערכת בערוץ הקבוצתי: sender_user=null → מוצגת כ"מערכת",
  -- והבאדג' של הלשונית נדלק לכל הצוות (כמו כל הודעה נכנסת)
  insert into team_messages (channel, sender_user, body)
  values ('group', null, v_msg);

  return 1;
end;
$fn$;

revoke all on function public.alerts_scan_morning() from public, anon, authenticated;
grant execute on function public.alerts_scan_morning() to service_role;

comment on function public.alerts_scan_morning()
  is 'ברכת בוקר יומית: פעם בבוקר (שעון ישראל) — הודעת מערכת בערוץ הקבוצתי של צ''אט הצוות, הודעה ברוטציה.';

-- ==================== 2. תצוגה מקדימה — מנהל בלבד, בלי פרסום ====================
create or replace function public.alerts_morning_test() returns text
language plpgsql security definer set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_msg    text;
  v_city   text;
  v_active integer;
begin
  if not exists (select 1 from profiles p
                 where p.id = v_uid and p.active and p.role = 'admin') then
    raise exception 'not allowed';
  end if;

  select count(*) into v_active from morning_messages where active;
  if v_active = 0 then
    raise exception 'אין הודעות פעילות במאגר';
  end if;
  select t.text into v_msg
  from (select m.text, row_number() over (order by m.id) - 1 as rn
        from morning_messages m where m.active) t
  where t.rn = extract(doy from (now() at time zone 'Asia/Jerusalem')::date)::int % v_active;

  v_city := coalesce(nullif(btrim((select value from settings where key = 'paper_city')), ''), 'עיר שלנו');
  return replace(v_msg, '{city}', v_city);
end;
$fn$;

revoke all on function public.alerts_morning_test() from public, anon;
grant execute on function public.alerts_morning_test() to authenticated, service_role;

comment on function public.alerts_morning_test()
  is 'ברכת בוקר: תצוגה מקדימה של נוסח היום למנהל — לא מפרסמת דבר.';
