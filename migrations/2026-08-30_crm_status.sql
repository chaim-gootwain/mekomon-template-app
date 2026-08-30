-- ============================================================
-- מיגרציה: סטטוס CRM ללקוח (פיצ'ר #13)
-- ------------------------------------------------------------
-- עמודה חדשה customers.crm_status — מחזור חיים של הלקוח:
--   prospect = מתעניין · active = פעיל · past = לקוח בעבר
-- ממד נפרד מהסטטוס התפעולי (active/frozen/blacklist) שקובע אם
-- מותר לעבוד עם הלקוח. כל הלקוחות הקיימים מקבלים 'active'.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.customers
  add column if not exists crm_status text not null default 'active';

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_crm_status_check') then
    alter table public.customers add constraint customers_crm_status_check
      check (crm_status in ('prospect','active','past'));
  end if;
end $mig$;

create index if not exists customers_crm_status_idx on public.customers (crm_status);

comment on column public.customers.crm_status
  is 'סטטוס CRM: prospect=מתעניין, active=פעיל, past=לקוח בעבר (נפרד מהסטטוס התפעולי)';
