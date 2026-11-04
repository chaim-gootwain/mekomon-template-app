-- ============================================================
-- מיגרציה: שחרור אוטומטי של לידים שלא היה איתם קשר — למאגר ללא שיוך
-- ------------------------------------------------------------
-- הכלל (מופיע גם בהסכם העבודה של אנשי המכירות):
-- • ליד משויך לסוכן שלא היה איתו קשר X ימים (ברירת מחדל 60) — יוצא
--   מהשיוך (agent_id = null) ועובר למאגר, וכל סוכן יכול לתפוס אותו.
-- • ליד שפרסם (הטלפון שלו שייך ללקוח עם מודעה ב-Y הימים האחרונים,
--   ברירת מחדל 120) — לא משתחרר.
-- • רק לידים פתוחים: לא "נסגר", לא "אבוד", לא ממתין למחיקה. לקוחות
--   (טבלת customers) לא משתחררים — הכלל חל על לידים בלבד.
-- "קשר אחרון" = המאוחר מבין: יצירת הליד, שיוכו לסוכן הנוכחי, חיוג
-- מהמערכת (call_log), הערה/תיעוד (interactions), ניתוח שיחה (call_analysis).
--
-- 1. leads.agent_assigned_at + טריגר — מתי הליד שויך לסוכן הנוכחי
--    (כדי שליד שזה עתה נתפס לא ישתחרר מיד).
-- 2. lead_release_candidates() — רשימת הלידים שיצאו מהשיוך (לתצוגה מקדימה).
-- 3. lead_release_stale() — מבצע את השחרור. רץ כל לילה (pg_cron) רק אם
--    settings.lead_release_enabled = '1'.
-- 4. הגדרות: lead_release_enabled ('0' — כבוי עד שמפעילים),
--    lead_release_days ('60'), lead_keep_advertiser_days ('120').
--
-- ⚠ בהפעלה הראשונה ישתחררו בבת אחת כל הלידים שעומדים בכלל. לפני
--   ההפעלה: הגדרות → "♻️ שחרור לידים" → "תצוגה מקדימה".
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ---------- 1. מועד השיוך ----------
alter table public.leads add column if not exists agent_assigned_at timestamptz;

create or replace function public.trg_leads_agent_assigned()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.agent_id is not null and (tg_op = 'INSERT' or new.agent_id is distinct from old.agent_id) then
    new.agent_assigned_at := now();
  end if;
  return new;
end $$;

drop trigger if exists leads_agent_assigned on public.leads;
create trigger leads_agent_assigned before insert or update of agent_id on public.leads
  for each row execute function public.trg_leads_agent_assigned();

-- ---------- 4. הגדרות (לפני הפונקציות שקוראות אותן) ----------
insert into public.settings (key, value) values
  ('lead_release_enabled', '0'),
  ('lead_release_days', '60'),
  ('lead_keep_advertiser_days', '120')
on conflict (key) do nothing;

-- ---------- 2. מועמדים לשחרור ----------
-- נבנה דינמית כדי לעבוד גם במופע שחסרות בו טבלאות/עמודות אופציונליות.
create or replace function public.lead_release_candidates()
returns table (lead_id bigint, agent_id bigint, last_contact timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_days int := coalesce(nullif((select value from settings where key = 'lead_release_days'), '')::int, 60);
  v_keep int := coalesce(nullif((select value from settings where key = 'lead_keep_advertiser_days'), '')::int, 120);
  v_cl boolean := to_regclass('public.call_log') is not null;
  v_in boolean := to_regclass('public.interactions') is not null;
  v_ca boolean := exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'call_analysis' and column_name = 'created_at');
  v_pd boolean := exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'leads' and column_name = 'pending_delete');
  q text;
begin
  -- מהממשק — מנהל בלבד; מ-pg_cron (ללא משתמש) — מותר
  if auth.uid() is not null and not public.emu_is_admin() then
    raise exception 'למנהל בלבד';
  end if;
  if v_days <= 0 then return; end if;

  q := 'with t as (
          select l.id, l.agent_id, l.phone,
                 greatest(l.created_at, l.agent_assigned_at'
    || case when v_cl then ', (select max(c.created_at) from public.call_log c where c.entity_type = ''lead'' and c.entity_id = l.id)' else '' end
    || case when v_in then ', (select max(i.created_at) from public.interactions i where i.entity_type = ''lead'' and i.entity_id = l.id)' else '' end
    || case when v_ca then ', (select max(a.created_at) from public.call_analysis a where a.lead_id = l.id)' else '' end
    || ') as last_contact
          from public.leads l
         where l.agent_id is not null
           and coalesce(l.status, '''') not in (''won'', ''lost'')'
    || case when v_pd then ' and l.pending_delete is not true' else '' end
    || ')
        select t.id, t.agent_id, t.last_contact
          from t
         where t.last_contact < now() - make_interval(days => $1)
           and not exists (
             select 1
               from public.customers cu
               join public.ads ad on ad.customer_id = cu.id
               left join public.issues iss on iss.id = ad.issue_id
              where length(regexp_replace(coalesce(t.phone, ''''), ''\D'', '''', ''g'')) >= 7
                and (right(regexp_replace(coalesce(cu.phone, ''''), ''\D'', '''', ''g''), 9)
                     = right(regexp_replace(coalesce(t.phone, ''''), ''\D'', '''', ''g''), 9))
                and coalesce(ad.status, '''') not in (''cancelled'', ''rejected'')
                and coalesce(iss.print_date, iss.publish_date, ad.created_at::date) >= current_date - $2)';

  return query execute q using v_days, v_keep;
end $fn$;

revoke all on function public.lead_release_candidates() from public, anon;
grant execute on function public.lead_release_candidates() to authenticated;

-- ---------- 3. השחרור ----------
create or replace function public.lead_release_stale(p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  if auth.uid() is not null and not public.emu_is_admin() then
    raise exception 'למנהל בלבד';
  end if;
  -- הריצה הלילית פועלת רק כשהמתג דלוק; הפעלה ידנית של מנהל (p_force) — תמיד
  if not p_force and coalesce((select value from settings where key = 'lead_release_enabled'), '0') <> '1' then
    return 0;
  end if;

  update public.leads l
     set agent_id = null
   where l.id in (select c.lead_id from public.lead_release_candidates() c);
  get diagnostics n = row_count;

  insert into public.settings (key, value)
  values ('lead_release_last', to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') || ' · ' || n)
  on conflict (key) do update set value = excluded.value;

  return n;
end $fn$;

revoke all on function public.lead_release_stale(boolean) from public, anon;
grant execute on function public.lead_release_stale(boolean) to authenticated;

-- ---------- תזמון לילי (03:30 UTC) ----------
do $mig$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron לא זמין (%). חלופה: לתזמן "select public.lead_release_stale();" פעם ביום דרך Dashboard → Integrations → Cron.', sqlerrm;
    return;
  end;

  begin
    perform cron.unschedule('lead-release-daily');
  exception when others then
    null; -- הג'וב עוד לא קיים — זה בסדר
  end;

  perform cron.schedule('lead-release-daily', '30 3 * * *', 'select public.lead_release_stale();');
  raise notice 'תוזמן ג''וב: lead-release-daily (כל לילה).';
exception when others then
  raise notice 'תזמון pg_cron נכשל (%). חלופה: Dashboard → Integrations → Cron.', sqlerrm;
end $mig$;
