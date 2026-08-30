-- ============================================================
-- מיגרציה: תזכורת "סגירת גיליון" למפרסמים קבועים (פיצ'ר #17)
-- ------------------------------------------------------------
-- 1. סימון "מפרסם קבוע" על הלקוח (customers.regular_advertiser).
-- 2. מתג פר-מופע settings.issue_reminders_enabled — כבוי כברירת מחדל.
-- השליחה עצמה ידנית-מהירה (סבב wa.me עם הודעה מוכנה) — אין שליחה
-- אוטומטית ללקוחות בלי מגע אנושי.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.customers
  add column if not exists regular_advertiser boolean not null default false;

comment on column public.customers.regular_advertiser
  is 'מפרסם קבוע — נכלל בסבב תזכורות סגירת הגיליון';

create index if not exists customers_regular_adv_idx
  on public.customers (regular_advertiser) where regular_advertiser;

insert into public.settings (key, value) values ('issue_reminders_enabled', '0')
  on conflict (key) do nothing;
