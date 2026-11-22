-- ============================================================
-- מיגרציה: phone_near_matches — טלפון "קרוב" ללידים/לקוחות קיימים
-- ------------------------------------------------------------
-- הוספת ליד מתריעה כשיש ליד/לקוח עם טלפון שכמעט זהה — אותו מספר
-- חוץ מהספרות האחרונות (קווים שונים של אותו עסק: 03-9555606 / 03-9555609).
-- קווי (0X-XXXXXXX, 9 ספרות): שונות 2 הספרות האחרונות לכל היותר.
-- נייד (05X, 10 ספרות): רק הספרה האחרונה (פחות התראות שווא).
-- טלפון זהה לגמרי לא מוחזר כאן — הוא כבר נבדק ב-check_duplicate_phone.
-- security definer (כמו check_duplicate_phone) כדי לראות גם לקוחות של
-- סוכנים אחרים; טלפון של לקוח מוחזר רק למנהל (לסוכן — שם וסוכן בלבד).
-- הרצה: Supabase Dashboard → SQL Editor, בכל מופע. בטוח להרצה חוזרת.
-- ============================================================
create or replace function public.phone_near_matches(p_phone text)
returns table(kind text, id bigint, name text, phone text, agent_name text)
language sql stable security definer set search_path = public
as $fn$
  with q as (
    select d, case when d ~ '^05' then 1 else 2 end as tail
    from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) x
    where length(d) between 9 and 10
  ),
  cand as (
    select 'lead'::text as kind, l.id, l.name, l.phone as ph, l.phone as shown, l.agent_id
    from leads l where l.status not in ('won', 'lost')
    union all
    select 'lead', l.id, l.name, l.whatsapp, l.whatsapp, l.agent_id
    from leads l where l.status not in ('won', 'lost')
    union all
    select 'customer', c.id, c.name, c.phone, case when public.emu_is_admin() then c.phone end, c.agent_id
    from customers c
    union all
    select 'customer', c.id, c.name, c.whatsapp, case when public.emu_is_admin() then c.whatsapp end, c.agent_id
    from customers c
  )
  select distinct on (cand.kind, cand.id) cand.kind, cand.id, cand.name, cand.shown, a.name
  from cand
  cross join q
  left join agents a on a.id = cand.agent_id
  where public.emu_active_staff(array['admin','sales'])
    and length(regexp_replace(coalesce(cand.ph, ''), '\D', '', 'g')) = length(q.d)
    and regexp_replace(cand.ph, '\D', '', 'g') <> q.d
    and left(regexp_replace(cand.ph, '\D', '', 'g'), length(q.d) - q.tail) = left(q.d, length(q.d) - q.tail)
  order by cand.kind, cand.id
  limit 10
$fn$;

revoke all on function public.phone_near_matches(text) from public, anon;
grant execute on function public.phone_near_matches(text) to authenticated;
