-- ערוץ "בעיות לתיקון": כתובת המייל להתראות נשמרת ב-settings (fixes_notify_email),
-- אבל לתפקיד גרפיקה אין הרשאת קריאה להגדרות — והמייל נפל לכתובת העיתון.
-- הפונקציה מחזירה רק את הערך הזה (security definer), לכל משתמש צוות פעיל.
-- idempotent: create or replace.
create or replace function public.get_fixes_notify_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(trim(value::text), '')
  from public.settings
  where key = 'fixes_notify_email'
    and public.emu_active_staff(array['admin','sales','editor','graphics'])
  limit 1
$$;

revoke all on function public.get_fixes_notify_email() from public, anon;
grant execute on function public.get_fixes_notify_email() to authenticated;
