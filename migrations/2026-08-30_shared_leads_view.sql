-- Mekomon — Shared leads view + duplicates vs customers
-- 1) Leads become SHARED for viewing: every sales agent can SEE all leads
--    (his own, the pool, and other agents'), but can WRITE only his own
--    (insert to himself or to the pool; update/delete only agent_id=mine).
--    This also restores pool visibility for sales, which the 2026-08-24
--    least-privilege migration accidentally blocked (agent_id is null did
--    not pass "agent_id = my_agent_id()").
-- 2) Lead interactions (timeline) become readable for all leads, so shared
--    viewing shows the full customer journey. Writing rules unchanged.
-- 3) lead_customer_duplicates(): SECURITY DEFINER helper that returns open
--    leads whose phone matches an existing customer (last 9 digits), so the
--    UI can flag "already a customer" even for sales users whose direct
--    access to other agents' customers is RLS-restricted.
-- Admin & non-sales roles UNAFFECTED (policies keep the same bypass).
-- Idempotent + tolerant (to_regclass skips missing tables). Migrations are
-- excluded from auto-sync -> run manually in each instance's SQL editor.

-- 1. leads: split the single FOR ALL restrictive policy into per-command
--    policies — shared SELECT, own-only writes.
do $do$ begin if to_regclass('public.leads') is not null then
  execute $p$drop policy if exists zz_sales_leads on public.leads$p$;
  execute $p$drop policy if exists zz_sales_leads_select on public.leads$p$;
  execute $p$drop policy if exists zz_sales_leads_insert on public.leads$p$;
  execute $p$drop policy if exists zz_sales_leads_update on public.leads$p$;
  execute $p$drop policy if exists zz_sales_leads_delete on public.leads$p$;
  -- shared viewing: any logged-in user the permissive base policies admit
  -- (auth.uid() check keeps anon out, like the old restrictive policy did)
  execute $p$create policy zz_sales_leads_select on public.leads as restrictive for select to public using ( auth.uid() is not null )$p$;
  execute $p$create policy zz_sales_leads_insert on public.leads as restrictive for insert to public with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id is null or agent_id = public.my_agent_id() )$p$;
  execute $p$create policy zz_sales_leads_update on public.leads as restrictive for update to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
  execute $p$create policy zz_sales_leads_delete on public.leads as restrictive for delete to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

-- 2. interactions: same policy as 2026-08-24 plus "or entity_type='lead'"
--    so the shared lead timeline is readable by every sales agent.
do $do$ begin if to_regclass('public.interactions') is not null then
  execute $p$drop policy if exists zz_sales_interactions on public.interactions$p$;
  execute $p$create policy zz_sales_interactions on public.interactions as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or user_id = auth.uid() or (entity_type = 'lead' and auth.uid() is not null) or entity_id in (select id from public.customers where agent_id = public.my_agent_id()) or entity_id in (select id from public.leads where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or user_id = auth.uid() )$p$;
end if; end $do$;

-- 3. Duplicates vs customers: open leads whose phone matches a customer.
--    SECURITY DEFINER so it sees ALL customers regardless of the caller's
--    RLS scope; exposes only (lead_id, customer_id, customer_name).
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
  order by l.id, c.id
$fn$;

revoke all on function public.lead_customer_duplicates() from public;
grant execute on function public.lead_customer_duplicates() to authenticated;
