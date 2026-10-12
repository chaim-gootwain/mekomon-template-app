-- ============================================================
-- מיגרציה: פתיחת "מפרסמים פוטנציאליים" לסוכנים (תפקיד sales)
-- ------------------------------------------------------------
-- 1. טבלת prospects: מנהל + סוכן פעיל (קריאה/כתיבה). המפרסמים הם מאגר
--    משותף — עוד לא משויכים לאף סוכן; השיוך קורה ב"העבר ללידים".
-- 2. פונקציה prospect_match: בודקת אם טלפון/שם כבר קיימים כלקוח או
--    כליד — בכל המערכת, גם אצל סוכנים אחרים — ומחזירה רק את סוג ההתאמה
--    (לקוח/ליד, לקוח עבר או לא). לא חושפת שמות, טלפונים או שיוך של
--    לקוחות ולידים של סוכנים אחרים.
--
-- דורש: 2026-10-06_prospects.sql (רץ קודם).
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. RLS — מנהל + סוכן ====================
do $mig$
begin
  execute 'drop policy if exists prospects_admin on public.prospects';
  execute 'drop policy if exists prospects_staff on public.prospects';
  execute $p$
    create policy prospects_staff on public.prospects
      for all to authenticated
      using (exists (select 1 from public.profiles p
                     where p.id = auth.uid() and p.active and p.role in ('admin','sales')))
      with check (exists (select 1 from public.profiles p
                          where p.id = auth.uid() and p.active and p.role in ('admin','sales')))
  $p$;
end $mig$;

-- ==================== 2. בדיקת התאמה ללקוחות/לידים ====================
-- p_phones: מפתחות טלפון (9 ספרות אחרונות). p_name: שם מנורמל
-- (אותיות עברית/אנגלית וספרות בלבד, אותיות קטנות).
-- מחזיר שורה אחת: kind = 'customer' | 'lead' | null, past = לקוח עבר.
create or replace function public.prospect_match(p_phones text[], p_name text)
returns table (kind text, customer_id bigint, past boolean)
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_cust record;
  v_last timestamptz;
begin
  if not exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.active and p.role in ('admin','sales')) then
    raise exception 'אין הרשאה';
  end if;

  select c.id, c.crm_status into v_cust
  from public.customers c
  where (coalesce(array_length(p_phones, 1), 0) > 0
         and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9) = any (p_phones))
     or (coalesce(p_name, '') <> ''
         and lower(regexp_replace(coalesce(c.name, ''), '[^a-zA-Z0-9א-ת]', '', 'g')) = p_name)
  order by c.id
  limit 1;

  if found then
    select max(a.created_at) into v_last from public.ads a where a.customer_id = v_cust.id;
    return query select 'customer'::text, v_cust.id::bigint,
      (v_cust.crm_status = 'past' or (v_last is not null and v_last < now() - interval '180 days'));
    return;
  end if;

  if exists (
    select 1 from public.leads l
    where (coalesce(array_length(p_phones, 1), 0) > 0
           and (right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 9) = any (p_phones)
                or right(regexp_replace(coalesce(l.whatsapp, ''), '\D', '', 'g'), 9) = any (p_phones)))
       or (coalesce(p_name, '') <> ''
           and lower(regexp_replace(coalesce(l.name, ''), '[^a-zA-Z0-9א-ת]', '', 'g')) = p_name)
  ) then
    return query select 'lead'::text, null::bigint, false;
    return;
  end if;

  return query select null::text, null::bigint, false;
end $fn$;

revoke all on function public.prospect_match(text[], text) from public;
grant execute on function public.prospect_match(text[], text) to authenticated;
