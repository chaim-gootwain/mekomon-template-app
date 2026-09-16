-- ============================================================
-- מיגרציה: יומן חיוגים (call_log) — פיצ'ר "ביצועי סוכנים"
-- ------------------------------------------------------------
-- כל חיוג דרך המערכת (phoneCall → Edge Function ‏call-dial) נרשם
-- כאן מצד הלקוח, כדי שדשבורד "ביצועי סוכנים" יוכל לחשב שיחות
-- לשעה וגרף שעות שיא. אין נתוני עבר — הרישום מתחיל מרגע הפריסה.
-- ה-Edge Function ‏call-dial עצמה לא משתנה.
-- RLS: מנהל רואה הכל; משתמש מחובר רושם ורואה את השיחות של עצמו;
-- ל-anon אין שום גישה (אין policy ואין grant).
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

create table if not exists public.call_log (
  id          bigint generated always as identity,
  agent_id    bigint,
  user_id     uuid default auth.uid(),   -- auth.uid() של המחייג
  target      text,                      -- מספר היעד המנורמל
  entity_type text,                      -- 'customer' | 'lead' | null
  entity_id   bigint,                    -- id של הלקוח/הליד אם ידוע מההקשר
  direction   text default 'outbound',
  created_at  timestamptz not null default now()
);

-- אילוצים — בנפרד כדי שהרצה חוזרת לא תיכשל
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'call_log_pkey') then
    alter table public.call_log add constraint call_log_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_log_agent_fkey') then
    alter table public.call_log add constraint call_log_agent_fkey
      foreign key (agent_id) references public.agents(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_log_user_fkey') then
    alter table public.call_log add constraint call_log_user_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_log_entity_check') then
    alter table public.call_log add constraint call_log_entity_check
      check (entity_type is null or entity_type in ('customer', 'lead'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_log_direction_check') then
    alter table public.call_log add constraint call_log_direction_check
      check (direction in ('outbound', 'inbound'));
  end if;
end $$;

create index if not exists call_log_created_idx on public.call_log (created_at);
create index if not exists call_log_agent_idx   on public.call_log (agent_id);

comment on table public.call_log is
  'יומן חיוגים דרך המערכת (client-side, אחרי call-dial מוצלח) — לדשבורד ביצועי סוכנים';

-- ---------- RLS ----------
alter table public.call_log enable row level security;

-- קריאה: מנהל רואה הכל; כל משתמש רואה את השיחות שהוא עצמו רשם
drop policy if exists call_log_select on public.call_log;
create policy call_log_select on public.call_log
  for select to authenticated
  using ( public.emu_is_admin() or user_id = auth.uid() );

-- הכנסה: כל משתמש מחובר, אך ורק על שם עצמו
drop policy if exists call_log_insert on public.call_log;
create policy call_log_insert on public.call_log
  for insert to authenticated
  with check ( user_id = auth.uid() );

-- אין update/delete — יומן חיוגים לא נערך.
grant select, insert on public.call_log to authenticated;
grant all on public.call_log to service_role;
