-- ============================================================
-- מיגרציה: ארכיון גיליונות ציבורי (פיצ'ר #20)
-- ------------------------------------------------------------
-- דף ציבורי (portal/archive.html) שמציג גיליונות עבר עם PDF.
-- אבטחה, בשכבות:
--   1. מתג-על settings.public_archive_enabled — כבוי כברירת מחדל.
--      כשהוא כבוי: גם הרשימה וגם הקבצים לא נגישים לציבור.
--   2. RPC ‏archive_public_list — מחזיר אך ורק גיליונות שפורסמו
--      (status='published') שיש להם PDF, ורק שדות: מספר, תאריך, נתיב.
--   3. מדיניות קריאה אנונימית על storage — מוגבלת לבאקט
--      issues-archive בלבד (שמכיל רק PDF של גיליונות) ומותנית במתג.
--      הבאקט נשאר פרטי; הצפייה דרך קישורים חתומים קצרי-מועד.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. מתג-על (כבוי כברירת מחדל) ====================
insert into public.settings (key, value) values ('public_archive_enabled', '0')
  on conflict (key) do nothing;

-- ==================== 2. רשימת הגיליונות לציבור ====================
create or replace function public.archive_public_list() returns jsonb
language plpgsql security definer set search_path = public
as $fn$
begin
  if coalesce((select value from settings where key = 'public_archive_enabled'), '0') <> '1' then
    return null; -- הארכיון הציבורי כבוי
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'issue_number', i.issue_number,
             'publish_date', i.publish_date,
             'pdf_path', i.pdf_path
           ) order by i.issue_number desc)
    from issues i
    where i.status = 'published' and i.pdf_path is not null
  ), '[]'::jsonb);
end;
$fn$;

revoke all on function public.archive_public_list() from public;
grant execute on function public.archive_public_list() to anon, authenticated;

comment on function public.archive_public_list()
  is 'ארכיון ציבורי: גיליונות שפורסמו עם PDF בלבד; ריק כשהמתג public_archive_enabled כבוי';

-- ==================== 3. קריאה אנונימית — רק הבאקט הזה, רק כשהמתג דלוק ====================
-- בדיקת המתג עטופה בפונקציית security definer, כי בתוך מדיניות RLS
-- שאילתת-משנה רצה בהרשאות הקורא (anon) — שאין לו קריאה על settings.
create or replace function public.archive_is_public() returns boolean
language sql security definer set search_path = public
as $fn$
  select coalesce((select value from settings where key = 'public_archive_enabled'), '0') = '1';
$fn$;
revoke all on function public.archive_is_public() from public;
grant execute on function public.archive_is_public() to anon, authenticated;

drop policy if exists "archive_public_read" on storage.objects;
create policy "archive_public_read" on storage.objects
  for select to anon
  using (bucket_id = 'issues-archive' and public.archive_is_public());
