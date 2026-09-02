-- ============================================================
-- מיגרציה: תיקון באג — העלאת קובץ בפורטל הלקוחות נכשלת
-- ------------------------------------------------------------
-- הבעיה: הפורטל מעלה את קובץ המודעה ל-bucket ‏ad-files כמשתמש
-- אנונימי (הלקוח מזוהה בקישור אישי עם טוקן, בלי התחברות), אבל
-- מדיניות האחסון (002_storage_buckets.sql) מתירה insert רק
-- ל-authenticated. לכן כל הגשת מודעה עם קובץ נכשלה בשגיאת RLS,
-- בעוד הגשה בטקסט חופשי (שעוברת דרך portal_submit_ad) עבדה.
--
-- הפתרון: פונקציית עזר security definer שמאמתת שנתיב הקובץ הוא
-- portal/<טוקן>/<קובץ> ושהטוקן שייך ללקוח קיים שאינו ברשימה
-- שחורה (אותה בדיקה כמו portal_info / portal_extra), ומדיניות
-- insert ל-anon על ad-files שמוגבלת לפונקציה הזו בלבד.
-- הלקוח יכול אך ורק להעלות לתיקיית הטוקן של עצמו — אין לו
-- קריאה, עדכון, מחיקה או גישה לשום נתיב אחר.
--
-- מגבלת גודל קובץ: הפורטל חוסם מעל 20MB בצד הלקוח
-- (portal/index.html), וה-bucket עצמו מוגבל בשרת ל-50MB
-- (file_size_limit=52428800 שהוגדר ב-002_storage_buckets.sql).
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

create or replace function public.portal_upload_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public
as $fn$
  select p_name like 'portal/%/%'
     and exists (
       select 1 from customers
       where portal_token::text = split_part(p_name, '/', 2)
         and coalesce(status, 'active') <> 'blacklist'
     );
$fn$;

revoke all on function public.portal_upload_allowed(text) from public;
grant execute on function public.portal_upload_allowed(text) to anon, authenticated;

comment on function public.portal_upload_allowed(text)
  is 'פורטל לקוח: האם מותר להעלות קובץ לנתיב הזה — portal/<טוקן תקף>/ בלבד';

drop policy if exists "portal_files_insert" on storage.objects;
create policy "portal_files_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'ad-files' and public.portal_upload_allowed(name));
