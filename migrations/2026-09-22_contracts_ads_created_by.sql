-- הוספת עמודת "מי יצר" (created_by) לחוזים ולמודעות.
-- הקוד (invoice-chat / data-entry-chat / issue-entry) כותב created_by בעת
-- פתיחת חוזה ויצירת מודעות, אך העמודה נוספה בזמנו רק ידנית במופע הייחוס
-- ולא נרשמה כמיגרציה — מופעים ותיקים נפלו על
-- "Could not find the 'created_by' column of 'contracts'".
-- בטוח להרצה חוזרת (idempotent).

alter table public.contracts add column if not exists created_by uuid;
alter table public.ads       add column if not exists created_by uuid;
