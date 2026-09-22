-- ============================================================
-- מיגרציה: סוכן המקומון — מדידת שימוש ועלות
-- ------------------------------------------------------------
-- מוסיפה לטבלת agent_chats שלוש עמודות:
--   input_tokens  — שווה-ערך טוקני קלט לחישוב עלות (כולל שקלול מטמון)
--   output_tokens — טוקני פלט
--   model         — המודל ששימש את השיחה (לתמחור נכון)
-- מסך ההגדרות משתמש בהן להצגת "שימוש החודש" ועלות משוערת.
-- עד שהמיגרציה רצה — הסוכן עובד כרגיל, רק בלי רישום השימוש.
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.agent_chats add column if not exists input_tokens  bigint not null default 0;
alter table public.agent_chats add column if not exists output_tokens bigint not null default 0;
alter table public.agent_chats add column if not exists model         text;

comment on column public.agent_chats.input_tokens is
  'שווה-ערך טוקני קלט לעלות: קלט רגיל + 1.25×כתיבת מטמון + 0.1×קריאה ממטמון';
