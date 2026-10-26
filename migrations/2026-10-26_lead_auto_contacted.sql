-- ============================================================
-- מיגרציה: ליד שבוצעה איתו שיחה עובר אוטומטית מ"חדש" ל"נוצר קשר"
-- ------------------------------------------------------------
-- עד עכשיו סטטוס הליד השתנה רק ידנית (גרירה בקנבן / פולו-אפ), ולכן
-- לידים שכבר דיברו איתם (חיוג מהמערכת / ניתוח שיחה מ-Voicenter)
-- נשארו מסומנים "חדש".
-- 1. טריגר על call_log — חיוג לליד (entity_type='lead').
-- 2. טריגר על call_analysis — ניתוח שיחה שקושר לליד (lead_id).
-- בשני המקרים: רק ליד בסטטוס 'new' מקודם ל-'contacted'; שלב מתקדם
-- יותר (פגישה/הצעה/נסגר/אבוד) לא נוגעים בו.
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- תיקון לידים קיימים (חד-פעמי, משנה נתונים) — בסוף הקובץ, בהערה;
-- מריצים בנפרד רק אחרי אישור.
-- ============================================================

create or replace function public.lead_mark_contacted(p_lead_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.leads set status = 'contacted'
   where id = p_lead_id and status = 'new';
$$;
revoke all on function public.lead_mark_contacted(bigint) from public, anon, authenticated;

-- ---------- 1. call_log ----------
create or replace function public.trg_call_log_lead_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.entity_type = 'lead' and new.entity_id is not null then
    perform public.lead_mark_contacted(new.entity_id);
  end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.call_log') is not null then
    drop trigger if exists call_log_lead_contacted on public.call_log;
    create trigger call_log_lead_contacted after insert on public.call_log
      for each row execute function public.trg_call_log_lead_contacted();
  end if;
end $$;

-- ---------- 2. call_analysis ----------
create or replace function public.trg_call_analysis_lead_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.lead_id is not null then
    perform public.lead_mark_contacted(new.lead_id);
  end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.call_analysis') is not null then
    drop trigger if exists call_analysis_lead_contacted on public.call_analysis;
    create trigger call_analysis_lead_contacted after insert or update of lead_id on public.call_analysis
      for each row execute function public.trg_call_analysis_lead_contacted();
  end if;
end $$;

-- ---------- תיקון לידים קיימים (חד-פעמי — להריץ בנפרד, אחרי אישור) ----------
-- update public.leads l set status = 'contacted'
--  where l.status = 'new'
--    and ( exists (select 1 from public.call_analysis a where a.lead_id = l.id)
--       or exists (select 1 from public.call_log c where c.entity_type = 'lead' and c.entity_id = l.id) );
