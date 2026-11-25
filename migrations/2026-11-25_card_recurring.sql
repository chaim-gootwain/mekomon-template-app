-- ============================================================
-- מיגרציה: חיוב חודשי אוטומטי בכרטיס אשראי (קארדקום, טוקן)
-- ------------------------------------------------------------
-- 1. הלקוח שומר כרטיס פעם אחת בדף מאובטח של קארדקום (CreateTokenOnly)
--    → נשמר טוקן (לא מספר כרטיס) בטבלה card_tokens.
-- 2. "חיוב חודשי קבוע" (recurring_card_charges) — סכום לפני מע"מ, יום בחודש,
--    אופציונלית מקושר לחוזה (contracts) ועם מספר חודשים מוגבל.
-- 3. ה-Edge Function ‏cardcom-recurring מחייבת פעם ביום את מה שהגיע מועדו,
--    מפיקה חשבונית מס-קבלה ב-EZcount ורושמת חיוב+תשלום בכרטסת.
--    כל חודש של כל חיוב = שורה אחת ב-recurring_card_runs (ייחודי) — אין חיוב כפול.
--
-- הטוקנים נגישים רק לשרת (service role): אין policy ללקוח על card_tokens /
-- card_token_requests. המסך מקבל רק 4 ספרות ותוקף דרך הפונקציה.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ, בכל מופע בנפרד.
-- בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. כרטיסים שמורים (טוקן) ====================
create table if not exists public.card_tokens (
  id            bigserial primary key,
  customer_id   bigint not null references public.customers(id) on delete cascade,
  token         text not null,
  card_last4    text,
  card_exp_mmyy text,            -- MMYY
  owner_id_num  text,            -- ת"ז בעל הכרטיס (חלק מהמסופים דורשים בחיוב בטוקן)
  owner_name    text,
  active        boolean not null default true,
  lp_id         text,            -- LowProfileId שממנו נוצר הטוקן
  created_at    timestamptz not null default now()
);
create index if not exists card_tokens_customer_idx on public.card_tokens (customer_id) where active;
create unique index if not exists card_tokens_lp_uidx on public.card_tokens (lp_id) where lp_id is not null;
alter table public.card_tokens enable row level security;
-- בכוונה: בלי policies — רק service role (ה-Edge Function) קורא/כותב.

-- ==================== 2. בקשות לשמירת כרטיס (דף קארדקום פתוח) ====================
create table if not exists public.card_token_requests (
  lp_id        text primary key,
  customer_id  bigint not null references public.customers(id) on delete cascade,
  nonce        text not null,
  status       text not null default 'pending',   -- pending / saved / failed
  created_by   uuid,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);
create index if not exists card_token_requests_cust_idx on public.card_token_requests (customer_id, status);
alter table public.card_token_requests enable row level security;

-- ==================== 3. חיובים חודשיים קבועים ====================
create table if not exists public.recurring_card_charges (
  id            bigserial primary key,
  customer_id   bigint not null references public.customers(id) on delete cascade,
  contract_id   bigint references public.contracts(id) on delete set null,
  amount        numeric not null check (amount > 0),   -- לפני מע"מ
  description   text not null default 'חיוב חודשי',
  day_of_month  int not null default 1 check (day_of_month between 1 and 28),
  start_ym      text not null,                         -- YYYY-MM — החודש הראשון לחיוב
  max_charges   int check (max_charges is null or max_charges > 0),  -- ריק = עד ביטול
  charges_done  int not null default 0,
  active        boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  stopped_at    timestamptz
);
create index if not exists recurring_card_charges_cust_idx on public.recurring_card_charges (customer_id);
create index if not exists recurring_card_charges_active_idx on public.recurring_card_charges (active) where active;
alter table public.recurring_card_charges enable row level security;

drop policy if exists recurring_card_charges_admin on public.recurring_card_charges;
create policy recurring_card_charges_admin on public.recurring_card_charges
  for all to authenticated
  using (public.my_role() = 'admin')
  with check (public.my_role() = 'admin');

-- ==================== 4. ריצות (חודש × חיוב) ====================
create table if not exists public.recurring_card_runs (
  id             bigserial primary key,
  recurring_id   bigint not null references public.recurring_card_charges(id) on delete cascade,
  customer_id    bigint not null,
  ym             text not null,
  status         text not null default 'processing',  -- processing / paid / paid_no_doc / failed
  attempts       int not null default 1,
  last_attempt   date not null default current_date,
  amount_total   numeric,                              -- כולל מע"מ
  cardcom_txn    text,
  approval       text,
  doc_number     text,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (recurring_id, ym)
);
create index if not exists recurring_card_runs_status_idx on public.recurring_card_runs (status, ym);
alter table public.recurring_card_runs enable row level security;

drop policy if exists recurring_card_runs_admin_read on public.recurring_card_runs;
create policy recurring_card_runs_admin_read on public.recurring_card_runs
  for select to authenticated
  using (public.my_role() = 'admin');

-- ==================== 5. מתג בהגדרות ====================
-- ריצה אוטומטית (cron יומי / כניסת מנהל). כבוי עד שמגדירים את קארדקום.
insert into public.settings (key, value) values ('card_recurring_auto', '0')
  on conflict (key) do nothing;
