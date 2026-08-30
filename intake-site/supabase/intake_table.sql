-- ============================================================
-- טופס קליטת לקוח — טבלת סודות (intake_secrets)
-- להרצה חד-פעמית ב-SQL Editor של פרויקט ה-Supabase הייעודי לטופס.
--
-- עקרון האבטחה: ה-anon key (שנמצא בדף הציבורי) יכול *רק להכניס*
-- שורות (INSERT). אין שום policy של SELECT/UPDATE/DELETE ל-anon,
-- ובנוסף ההרשאות עצמן נשללות (REVOKE) — כך שגם מי שמחזיק במפתח
-- הציבורי לא יכול לקרוא סודות של לקוחות אחרים.
-- קריאה נעשית רק דרך הדשבורד / service_role.
-- ============================================================

create table if not exists public.intake_secrets (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  paper_name    text,
  contact_name  text,
  contact_phone text,
  secrets     jsonb not null
);

alter table public.intake_secrets enable row level security;

-- INSERT בלבד ל-anon (הטופס שולח עם Prefer: return=minimal, בלי SELECT)
drop policy if exists "intake anon insert only" on public.intake_secrets;
create policy "intake anon insert only"
  on public.intake_secrets
  for insert
  to anon
  with check (true);

-- חגורת ביטחון נוספת: שלילת כל שאר ההרשאות מהתפקידים הציבוריים
revoke select, update, delete, truncate, references, trigger
  on public.intake_secrets from anon, authenticated;

-- לוודא ש-INSERT כן קיים
grant insert on public.intake_secrets to anon;
