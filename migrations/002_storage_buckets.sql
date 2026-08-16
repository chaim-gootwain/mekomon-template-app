-- אחסון קבצים: שני באקטים פרטיים + הרשאות לצוות מחובר.
-- זהה לכל מופע (שמות הבאקטים קבועים בקוד). להריץ פעם אחת בכל פרויקט Supabase חדש.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('ad-files','ad-files', false, 52428800),
  ('issues-archive','issues-archive', false, 209715200)
on conflict (id) do nothing;

drop policy if exists "files_select" on storage.objects;
drop policy if exists "files_insert" on storage.objects;
drop policy if exists "files_update" on storage.objects;
drop policy if exists "files_delete" on storage.objects;

create policy "files_select" on storage.objects
  for select to authenticated using (bucket_id in ('ad-files','issues-archive'));
create policy "files_insert" on storage.objects
  for insert to authenticated with check (bucket_id in ('ad-files','issues-archive'));
create policy "files_update" on storage.objects
  for update to authenticated
  using (bucket_id in ('ad-files','issues-archive'))
  with check (bucket_id in ('ad-files','issues-archive'));
create policy "files_delete" on storage.objects
  for delete to authenticated using (bucket_id in ('ad-files','issues-archive'));
