-- ============================================================
-- מיגרציה: תיקון שעות נוכחות ע"י מנהל
-- ------------------------------------------------------------
-- RPC חדש admin_fix_attendance: מאפשר למנהל לערוך רישום נוכחות
-- קיים — בעיקר להשלים שעת יציאה לעובד ששכח להחתים. הרישום מסומן
-- manual=true ("תיקון ידני") כדי לשמור על שקיפות מול העובד,
-- בטבלה ובייצוא לשכר.
-- אבטחה: security definer עם בדיקת הרשאה בפנים — רק מנהל פעיל
-- (profiles.role='admin' and active) עובר; כל אחד אחר נחסם בשרת.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

create or replace function public.admin_fix_attendance(
  p_id bigint, p_clock_in timestamptz, p_clock_out timestamptz)
returns void
language plpgsql security definer set search_path = public
as $fn$
begin
  if not exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.active and p.role = 'admin') then
    raise exception 'רק מנהל רשאי לתקן רישומי נוכחות';
  end if;
  if p_clock_in is null then
    raise exception 'שעת כניסה חסרה';
  end if;
  if p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'שעת היציאה חייבת להיות אחרי שעת הכניסה';
  end if;

  update public.attendance
     set clock_in = p_clock_in, clock_out = p_clock_out, manual = true
   where id = p_id;

  if not found then
    raise exception 'רישום הנוכחות לא נמצא';
  end if;
end;
$fn$;

revoke all on function public.admin_fix_attendance(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_fix_attendance(bigint, timestamptz, timestamptz) to authenticated;

comment on function public.admin_fix_attendance(bigint, timestamptz, timestamptz)
  is 'תיקון שעות רישום נוכחות ע"י מנהל (מסמן manual=true); הרשאה נבדקת בתוך הפונקציה';
