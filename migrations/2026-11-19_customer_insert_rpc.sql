-- ============================================================
-- מיגרציה: customer_insert — יצירת לקוח בלי לבקש את portal_token
-- ------------------------------------------------------------
-- אחרי הסתרת portal_token (2026-11-05_portal_token_column_security)
-- יצירת לקוח מהמערכת נכשלה: "permission denied for table customers".
-- insert().select() של PostgREST מבקש RETURNING של כל עמודות השורה,
-- כולל העמודה המוסתרת. (נבדק בעמנואל 19.11.2026: אותו insert ישירות
-- במסד, כמשתמש מחובר, עובר.)
-- הפונקציה מכניסה רק את השדות שנשלחו ומחזירה id בלבד; הקוד טוען את
-- השורה אחר כך בעמודות המותרות (custInsert ב-js/api.js).
-- security INVOKER בכוונה: אותן הרשאות ואותם כללי RLS של המשתמש
-- (customers_write, zz_sales_customers) — הפונקציה לא עוקפת כלום.
-- הרצה: Supabase Dashboard → SQL Editor, בכל מופע. בטוח להרצה חוזרת.
-- ============================================================
create or replace function public.customer_insert(p jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  cols text;
  new_id bigint;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'customers'
    and c.column_name not in ('id', 'portal_token')
    and p ? c.column_name;
  if cols is null then raise exception 'customer_insert: לא התקבלו שדות'; end if;
  execute format('insert into public.customers (%1$s) select %1$s from jsonb_populate_record(null::public.customers, $1) returning id', cols)
    using p into new_id;
  return new_id;
end
$fn$;

revoke all on function public.customer_insert(jsonb) from public, anon;
grant execute on function public.customer_insert(jsonb) to authenticated;
