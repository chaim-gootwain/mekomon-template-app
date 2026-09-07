-- Mekomon — אכיפת הרשאות בצד השרת: storage לפי תפקיד + שומר ב-lead_customer_duplicates
-- רקע: ההרשמה למערכת פתוחה, ומשתמש חדש נחסם כ-role='pending' ב-UI בלבד.
-- שתי נקודות עקפו את זה בצד השרת:
--   1) מדיניות ה-storage מ-002_storage_buckets.sql העניקה קריאה/כתיבה/מחיקה על
--      ad-files ו-issues-archive לכל authenticated — כולל נרשם עצמאי במצב pending,
--      שיכול היה להוריד את כל קבצי הלקוחות או למחוק את ארכיון הגיליונות.
--   2) lead_customer_duplicates() ‏(SECURITY DEFINER, עוקפת RLS) הוענקה
--      ל-authenticated בלי בדיקת תפקיד — דליפת שמות לקוחות לכל נרשם.
-- מדיניות ה-anon של הפורטל (2026-09-02_portal_file_upload_policy) לא נוגעים בה.
-- Idempotent — בטוח להריץ שוב. מיגרציות מוחרגות מהסנכרון האוטומטי:
-- להריץ ידנית ב-SQL Editor של כל מופע.

-- עוזר: האם הקורא הוא איש צוות פעיל באחד התפקידים הנתונים.
-- SECURITY DEFINER כדי לקרוא את profiles בלי תלות ב-RLS של הקורא.
create or replace function public.emu_active_staff(allowed text[])
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and coalesce(p.active, false) and p.role = any(allowed)
  )
$fn$;
revoke all on function public.emu_active_staff(text[]) from public;
grant execute on function public.emu_active_staff(text[]) to authenticated;

-- storage: קריאה לכל הצוות הפעיל (כולל ועדה — צפייה בהגהות); העלאה/עדכון
-- לתפקידי התפעול; מחיקה רק admin/sales (מסך קבצי לקוח הוא היחיד שמוחק).
drop policy if exists "files_select" on storage.objects;
drop policy if exists "files_insert" on storage.objects;
drop policy if exists "files_update" on storage.objects;
drop policy if exists "files_delete" on storage.objects;

create policy "files_select" on storage.objects
  for select to authenticated
  using (bucket_id in ('ad-files','issues-archive')
    and public.emu_active_staff(array['admin','sales','editor','graphics','committee']));
create policy "files_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('ad-files','issues-archive')
    and public.emu_active_staff(array['admin','sales','editor','graphics']));
create policy "files_update" on storage.objects
  for update to authenticated
  using (bucket_id in ('ad-files','issues-archive')
    and public.emu_active_staff(array['admin','sales','editor','graphics']))
  with check (bucket_id in ('ad-files','issues-archive')
    and public.emu_active_staff(array['admin','sales','editor','graphics']));
create policy "files_delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('ad-files','issues-archive')
    and public.emu_active_staff(array['admin','sales']));

-- lead_customer_duplicates: אותה שאילתה, עם שומר תפקיד בפנים — הקורא היחיד
-- הוא מסך הלידים (admin/sales). לכל אחד אחר מוחזרת תוצאה ריקה במקום שמות
-- לקוחות. החתימה לא משתנה, כך שקוד הקליינט הקיים ממשיך לעבוד.
create or replace function public.lead_customer_duplicates()
returns table(lead_id bigint, customer_id bigint, customer_name text)
language sql stable security definer set search_path = public as $fn$
  select distinct on (l.id) l.id, c.id, c.name
  from public.leads l
  join public.customers c
    on right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9)
     = right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 9)
  where l.status not in ('won', 'lost')
    and length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 7
    and public.emu_active_staff(array['admin','sales'])
  order by l.id, c.id
$fn$;
