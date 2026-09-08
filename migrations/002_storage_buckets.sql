-- אחסון קבצים: שני באקטים פרטיים + הרשאות לצוות פעיל בלבד.
-- זהה לכל מופע (שמות הבאקטים קבועים בקוד). Idempotent — בטוח להריץ שוב.
-- המדיניות כאן זהה לגרסה המוקשחת של 2026-09-07_server_side_authz.sql
-- (אותם שמות policy) — כך שהרצה חוזרת של הקובץ הזה לא מחזירה את הגרסה
-- הפתוחה הישנה שכל משתמש מחובר (כולל pending) יכול היה לקרוא/למחוק בה.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('ad-files','ad-files', false, 52428800),
  ('issues-archive','issues-archive', false, 209715200)
on conflict (id) do nothing;

-- עוזר: האם הקורא הוא איש צוות פעיל באחד התפקידים הנתונים.
-- מוגדר גם כאן כי קובץ זה רץ ראשון במופע חדש, לפני server_side_authz.
create or replace function public.emu_active_staff(allowed text[])
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and coalesce(p.active, false) and p.role = any(allowed)
  )
$fn$;
revoke all on function public.emu_active_staff(text[]) from public;
grant execute on function public.emu_active_staff(text[]) to authenticated;

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
