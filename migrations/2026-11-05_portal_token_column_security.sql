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
-- תיקון 18.11.2026: הגרסה הקודמת העניקה רשימת עמודות קבועה. היא נכשלה (updated_at לא קיימת
-- ב-customers ⇒ כל המיגרציה בוטלה ולא רצה באף מופע), וגם הייתה חסרה עמודות שהקוד קורא
-- (field, contact_role ...). עכשיו: מוענקות כל העמודות הקיימות חוץ מ-portal_token.
-- ⚠️ עמודה חדשה שתתווסף ל-customers בעתיד לא תהיה קריאה אוטומטית — מיגרציה שמוסיפה עמודה
--    ל-customers צריכה גם: grant select (<עמודה>) on public.customers to authenticated;
--    (או להריץ שוב את הקובץ הזה — הוא idempotent).
revoke select on public.customers from authenticated;
do $grant$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'customers' and column_name <> 'portal_token';
  execute format('grant select (%s) on public.customers to authenticated', cols);
end
$grant$;

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
