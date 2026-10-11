-- ============================================================
-- מיגרציה: נוכחות אוטומטית (בלי לחיצה על כניסה/יציאה)
-- ------------------------------------------------------------
-- למי שמסומן auto_attendance (ברירת מחדל: המנהלים) המערכת מחתימה לבד:
-- - כניסה: ברגע הראשון שהוא פעיל בתוכנה
-- - בזמן עבודה: "דופק" כל כמה דקות מעדכן last_seen
-- - יציאה: אחרי 30 דקות בלי פעילות המשמרת נסגרת בשעת הפעילות האחרונה
--   (+5 דק' — מרווח הדופק). חזרה לעבודה פותחת משמרת חדשה.
-- רישומים אוטומטיים מסומנים auto=true — שקיפות במסך ובייצוא לשכר.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.profiles   add column if not exists auto_attendance boolean not null default false;
alter table public.attendance add column if not exists auto      boolean not null default false;
alter table public.attendance add column if not exists last_seen timestamptz;

-- הפעלה ראשונית למנהלים (רק בהרצה הראשונה — עמודה שזה עתה נוספה)
do $$
begin
  if not exists (select 1 from public.profiles where auto_attendance) then
    update public.profiles set auto_attendance = true where role = 'admin' and active;
  end if;
end $$;

-- דופק נוכחות: נקרא מהדפדפן כל כמה דקות כשהמשתמש פעיל.
-- מחזיר: 'off' (לא מוגדר אוטומטי) / 'in' (משמרת פתוחה עודכנה) / 'started' (נפתחה משמרת)
create or replace function public.attendance_heartbeat()
returns text
language plpgsql security definer set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_gap  interval := interval '30 minutes';
  r      record;
  v_out  timestamptz;
begin
  if v_uid is null then raise exception 'לא מחובר'; end if;
  if not exists (select 1 from public.profiles p
                 where p.id = v_uid and p.active and p.auto_attendance) then
    return 'off';
  end if;

  select * into r from public.attendance
   where profile_id = v_uid and clock_out is null
   order by clock_in desc limit 1
   for update;

  if found then
    -- משמרת פעילה, או משמרת שנפתחה בכפתור (ידנית) — רק מעדכנים "נראה לאחרונה"
    if not r.auto or now() - coalesce(r.last_seen, r.clock_in) <= v_gap then
      update public.attendance set last_seen = now() where id = r.id;
      return 'in';
    end if;
    -- משמרת אוטומטית שנזנחה: נסגרת בשעת הפעילות האחרונה (+ מרווח הדופק)
    v_out := least(coalesce(r.last_seen, r.clock_in) + interval '5 minutes', now());
    if v_out <= r.clock_in then v_out := r.clock_in + interval '1 minute'; end if;
    update public.attendance set clock_out = v_out where id = r.id;
  end if;

  -- פתיחת משמרת חדשה דרך clock_in הקיים (שומר על כל ברירות המחדל של הטבלה)
  perform public.clock_in();
  update public.attendance set auto = true, last_seen = now()
   where id = (select id from public.attendance
                where profile_id = v_uid and clock_out is null
                order by clock_in desc limit 1);
  return 'started';
end;
$fn$;

revoke all on function public.attendance_heartbeat() from public, anon;
grant execute on function public.attendance_heartbeat() to authenticated;

-- הפעלה/כיבוי נוכחות אוטומטית לעובד — מנהל פעיל בלבד
create or replace function public.set_auto_attendance(p_profile uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $fn$
begin
  if not public.emu_active_staff(array['admin']) then
    raise exception 'רק מנהל רשאי לשנות נוכחות אוטומטית';
  end if;
  update public.profiles set auto_attendance = coalesce(p_on, false) where id = p_profile;
  if not found then raise exception 'המשתמש לא נמצא'; end if;
end;
$fn$;

revoke all on function public.set_auto_attendance(uuid, boolean) from public, anon;
grant execute on function public.set_auto_attendance(uuid, boolean) to authenticated;
