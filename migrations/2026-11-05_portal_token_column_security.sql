-- אבטחת עמודת portal_token ברמת מסד הנתונים.
-- עד עכשיו: כל משתמש מחובר (authenticated) יכול לשלוח שאילתה ישירה ל-Supabase ולקרוא portal_token.
-- לאחר המיגרציה: עמודת portal_token אינה נגישה דרך PostgREST לאף תפקיד; גישה רק דרך RPC
-- שבודק my_role() מול admin/manager/sales לפני שמחזיר את הערך.
--
-- שינויי קוד נדרשים (כבר קיימים ב-PR המלווה):
--   api.js         - הסרת _tok מ-_custCols; פונקציה custPortalToken() שקוראת ל-RPC
--   customers.js   - openCustomerCard טוען portal_token דרך custPortalToken() במקום c.portal_token

begin;

-- שלב 1: הסרת GRANT גורף על הטבלה, החלפה בעמודות מפורשות (ללא portal_token)
revoke select on public.customers from authenticated;
grant select (
  id, name, agent_id, phone, email, whatsapp,
  business_id, invoice_name, order_doc_type, payment_terms,
  agency_id, regular_advertiser, status, status_reason, fixed_discount,
  became_customer_at, city, contact_person, contacts,
  credit_limit, crm_status, notes, tags, mailing_list,
  created_at, updated_at
) on public.customers to authenticated;

-- שלב 2: פונקציה מאובטחת להחזרת portal_token למורשים בלבד
create or replace function public.get_customer_portal_token(p_customer_id int)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(my_role(), '') not in ('admin', 'manager', 'sales') then
    raise exception 'unauthorized' using errcode = 'insufficient_privilege';
  end if;
  return (select portal_token from customers where id = p_customer_id);
end;
$$;

revoke all on function public.get_customer_portal_token(int) from public;
grant execute on function public.get_customer_portal_token(int) to authenticated;

commit;
