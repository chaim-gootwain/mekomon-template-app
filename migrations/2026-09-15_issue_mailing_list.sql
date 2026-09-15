-- ============================================================
-- מיגרציה: רשימת תפוצה לדיוור הגליון
-- ------------------------------------------------------------
-- עמודת customers.mailing_list — לקוח שמסומן בה מקבל את הגליון
-- במייל בכל שליחה (בנוסף למפרסמי אותו גיליון, שמקבלים תמיד).
-- מסמנים בטופס הלקוח: "📧 רשימת תפוצה — מקבל את הגליון במייל".
--
-- המתג הראשי issue_mail_enabled כבוי כברירת מחדל — מדליקים במסך
-- ההגדרות ← "📧 דיוור הגליון". השליחה עצמה דורשת גם את סודות
-- ה-Gmail (GMAIL_USER + GMAIL_APP_PASSWORD) ב-Edge Functions Secrets.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.customers
  add column if not exists mailing_list boolean not null default false;

-- מעקב קמפיינים: מתי נשלח הגיליון ולמי (נכתב ע"י פונקציית send-issue)
alter table public.issues
  add column if not exists emailed_at timestamptz;
alter table public.issues
  add column if not exists email_log jsonb;

comment on column public.customers.mailing_list is 'רשימת תפוצה — מקבל את הגליון במייל בכל שליחה';

insert into public.settings (key, value) values ('issue_mail_enabled', '0')
  on conflict (key) do nothing;
