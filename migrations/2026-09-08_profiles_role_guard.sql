-- שומר על profiles.role / profiles.active מפני העלאת-הרשאות עצמית.
-- ההרשמה למערכת פתוחה ומשתמש חדש נחסם כ-pending ב-UI בלבד; אם מדיניות
-- ה-UPDATE הבסיסית על profiles מתירה "שורה של עצמי", כל נרשם יכול לכתוב
-- לעצמו role='admin' — וכל שכבות ההגנה (RLS, פונקציות Edge שסומכות על
-- profiles.role) נופלות איתו. הטריגר אוכף זאת בצד השרת, בלי תלות במדיניות:
-- שינוי role/active מותר רק למנהל פעיל או לחיבור service_role (admin-users).
-- חל על UPDATE בלבד — יצירת הפרופיל בהרשמה (trigger של auth.users) לא נחסמת.
-- Idempotent — בטוח להריץ שוב. מיגרציות מוחרגות מהסנכרון האוטומטי:
-- להריץ ידנית ב-SQL Editor של כל מופע.

create or replace function public.emu_profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if (new.role is distinct from old.role) or (new.active is distinct from old.active) then
    -- חיבור service_role (פונקציות Edge כמו admin-users) — מותר
    if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') = 'service_role' then
      return new;
    end if;
    if not public.emu_active_staff(array['admin']) then
      raise exception 'שינוי תפקיד/סטטוס משתמש מותר למנהל פעיל בלבד';
    end if;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_profiles_role_guard on public.profiles;
create trigger trg_profiles_role_guard
  before update on public.profiles
  for each row execute function public.emu_profiles_guard();
