-- Mekomon — Sales role least-privilege hardening (RESTRICTIVE RLS)
-- A sales user (profiles.role='sales') sees ONLY his own data: customers/leads/ads/calls/
-- contracts by agent_id; quotes he created/for his customers-leads (create+edit kept);
-- charges/payments only his own customers' rows (balances), no write; commission_payouts
-- hidden; agents only his own row; whatsapp/customer_files/customer_tasks/call_analysis/
-- ad_files/interactions scoped to his customers/leads/own. Admin & non-sales UNAFFECTED.
-- Adds RESTRICTIVE policies only (existing permissive untouched); revert by dropping
-- zz_sales_*. Idempotent + tolerant (to_regclass skips missing tables). Migrations are
-- excluded from auto-sync -> run manually in each instance's Supabase SQL editor.

create or replace function public.my_agent_id()
returns bigint language sql stable security definer set search_path = public as $fn$
  select id from public.agents where profile_id = auth.uid() limit 1
$fn$;

do $do$ begin if to_regclass('public.customers') is not null then
  execute $p$drop policy if exists zz_sales_customers on public.customers$p$;
  execute $p$create policy zz_sales_customers on public.customers as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id is null or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.leads') is not null then
  execute $p$drop policy if exists zz_sales_leads on public.leads$p$;
  execute $p$create policy zz_sales_leads on public.leads as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.quotes') is not null then
  execute $p$drop policy if exists zz_sales_quotes on public.quotes$p$;
  execute $p$create policy zz_sales_quotes on public.quotes as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or created_by = auth.uid() or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) or lead_id in (select id from public.leads where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or created_by = auth.uid() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.ads') is not null then
  execute $p$drop policy if exists zz_sales_ads on public.ads$p$;
  execute $p$create policy zz_sales_ads on public.ads as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.calls') is not null then
  execute $p$drop policy if exists zz_sales_calls on public.calls$p$;
  execute $p$create policy zz_sales_calls on public.calls as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.contracts') is not null then
  execute $p$drop policy if exists zz_sales_contracts on public.contracts$p$;
  execute $p$create policy zz_sales_contracts on public.contracts as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.charges') is not null then
  execute $p$drop policy if exists zz_sales_charges on public.charges$p$;
  execute $p$create policy zz_sales_charges on public.charges as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.payments') is not null then
  execute $p$drop policy if exists zz_sales_payments on public.payments$p$;
  execute $p$create policy zz_sales_payments on public.payments as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.commission_payouts') is not null then
  execute $p$drop policy if exists zz_sales_commission_payouts on public.commission_payouts$p$;
  execute $p$create policy zz_sales_commission_payouts on public.commission_payouts as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.agents') is not null then
  execute $p$drop policy if exists zz_sales_agents on public.agents$p$;
  execute $p$create policy zz_sales_agents on public.agents as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or id = public.my_agent_id() ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.whatsapp_messages') is not null then
  execute $p$drop policy if exists zz_sales_whatsapp_messages on public.whatsapp_messages$p$;
  execute $p$create policy zz_sales_whatsapp_messages on public.whatsapp_messages as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or agent_id = public.my_agent_id() )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.customer_files') is not null then
  execute $p$drop policy if exists zz_sales_customer_files on public.customer_files$p$;
  execute $p$create policy zz_sales_customer_files on public.customer_files as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.customer_tasks') is not null then
  execute $p$drop policy if exists zz_sales_customer_tasks on public.customer_tasks$p$;
  execute $p$create policy zz_sales_customer_tasks on public.customer_tasks as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or assigned_to = auth.uid() or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or assigned_to = auth.uid() or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.call_analysis') is not null then
  execute $p$drop policy if exists zz_sales_call_analysis on public.call_analysis$p$;
  execute $p$create policy zz_sales_call_analysis on public.call_analysis as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or customer_id in (select id from public.customers where agent_id = public.my_agent_id()) or lead_id in (select id from public.leads where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.ad_files') is not null then
  execute $p$drop policy if exists zz_sales_ad_files on public.ad_files$p$;
  execute $p$create policy zz_sales_ad_files on public.ad_files as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or ad_id in (select id from public.ads where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or ad_id in (select id from public.ads where agent_id = public.my_agent_id()) )$p$;
end if; end $do$;

do $do$ begin if to_regclass('public.interactions') is not null then
  execute $p$drop policy if exists zz_sales_interactions on public.interactions$p$;
  execute $p$create policy zz_sales_interactions on public.interactions as restrictive for all to public using ( public.emu_is_admin() or public.my_role() <> 'sales' or user_id = auth.uid() or entity_id in (select id from public.customers where agent_id = public.my_agent_id()) or entity_id in (select id from public.leads where agent_id = public.my_agent_id()) ) with check ( public.emu_is_admin() or public.my_role() <> 'sales' or user_id = auth.uid() )$p$;
end if; end $do$;

