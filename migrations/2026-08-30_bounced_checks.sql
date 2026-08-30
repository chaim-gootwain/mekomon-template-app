-- ============================================================
-- מיגרציה: צ'קים שחזרו (פיצ'ר #8)
-- ------------------------------------------------------------
-- שלוש עמודות סימון על payments. הלוגיקה בצד הלקוח: סימון תשלום
-- כ"חזר" מוסיף תנועת ביטול (תשלום שלילי) כדי שכל חישובי היתרה
-- הקיימים יישארו נכונים, פותח מחדש את החיוב, ומדווח למנוע
-- ההתראות (check_bounced). אין כאן שום פעולה כספית.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.payments
  add column if not exists bounced boolean not null default false;
alter table public.payments
  add column if not exists bounced_reason text;
alter table public.payments
  add column if not exists bounced_date date;

comment on column public.payments.bounced is 'התשלום חזר (צ''ק שחזר / הוראה שנדחתה)';
comment on column public.payments.bounced_reason is 'סיבת החזרה';
comment on column public.payments.bounced_date is 'תאריך החזרה';

create index if not exists payments_bounced_idx
  on public.payments (customer_id) where bounced;
