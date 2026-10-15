-- 2026-10-15_ads_layout_orient.sql
-- ------------------------------------------------------------------------------
-- כיוון מודעה בהרכבת ה-PDF לדפוס: 'v' = מאונך, 'h' = מאוזן, null = אוטומטי
-- (לפי יחס הקובץ). נבחר בעריכת מודעה בפלטפלן.
-- בלי העמודה הקוד ממשיך לעבוד (הכול אוטומטי); רק שמירת הבחירה נכשלת.
--
-- בטוח להרצה חוזרת (idempotent).
-- ------------------------------------------------------------------------------

alter table public.ads add column if not exists layout_orient text;

alter table public.ads drop constraint if exists ads_layout_orient_chk;
alter table public.ads add constraint ads_layout_orient_chk
  check (layout_orient is null or layout_orient in ('v','h'));
