-- ============================================================
-- מיגרציה: merge_customers — איחוד שני כרטיסי לקוח (גרסה 2, כללית)
-- ------------------------------------------------------------
-- הגרסה הקודמת (מהסכמה הבסיסית) העבירה רשימה קבועה של טבלאות; טבלאות
-- שנוספו אחריה (מסמכים, משימות, קבצים, תזכורות חוב…) היו נשארות מאחור
-- או מפילות את המחיקה. כאן מועברות אוטומטית *כל* ההפניות ללקוח הכפול:
--   1. כל עמודה ב-public שיש לה FK ל-customers, וכל עמודה בשם customer_id
--   2. טבלאות עם entity_type/entity_id (ציר זמן, יומן חיוגים…) — entity_type='customer'
--   3. שדות ריקים בכרטיס שנשמר מושלמים מהכפול (טלפון, מייל, ח.פ…)
--   4. הכפול נמחק
-- הכל בטרנזקציה אחת: כשל באמצע (למשל ייחודיות כפולה) — שום דבר לא משתנה.
-- מנהל בלבד. security definer (עוקף RLS — לכן בדיקת מנהל בתחילה).
-- הרצה: Supabase Dashboard → SQL Editor, בכל מופע. בטוח להרצה חוזרת.
-- ============================================================
drop function if exists public.merge_customers(bigint, bigint);

create function public.merge_customers(p_keep bigint, p_dup bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r record;
  n bigint;
  moved jsonb := '{}'::jsonb;
begin
  if not public.emu_is_admin() then raise exception 'רק מנהל יכול לאחד לקוחות'; end if;
  if p_keep is null or p_dup is null or p_keep = p_dup then raise exception 'יש לבחור שני לקוחות שונים'; end if;
  if not exists (select 1 from customers where id = p_keep) then raise exception 'הלקוח שנשמר (%) לא נמצא', p_keep; end if;
  if not exists (select 1 from customers where id = p_dup) then raise exception 'הלקוח הכפול (%) לא נמצא', p_dup; end if;

  -- 1. הפניות: FK ל-customers + כל עמודה בשם customer_id
  for r in
    select distinct tbl, col from (
      select cl.relname as tbl, a.attname as col
      from pg_constraint co
      join pg_class cl on cl.oid = co.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
      where co.contype = 'f' and co.confrelid = 'public.customers'::regclass
        and ns.nspname = 'public' and array_length(co.conkey, 1) = 1
      union
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'customer_id' and c.table_name <> 'customers'
        and c.data_type in ('bigint', 'integer')
    ) x
  loop
    execute format('update public.%I set %I = $1 where %I = $2', r.tbl, r.col, r.col) using p_keep, p_dup;
    get diagnostics n = row_count;
    if n > 0 then moved := moved || jsonb_build_object(r.tbl || '.' || r.col, n); end if;
  end loop;

  -- 2. טבלאות עם entity_type / entity_id
  for r in
    select c1.table_name as tbl
    from information_schema.columns c1
    join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'entity_id'
    join information_schema.tables t on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
    where c1.table_schema = 'public' and c1.column_name = 'entity_type'
  loop
    execute format('update public.%I set entity_id = $1 where entity_type = ''customer'' and entity_id = $2', r.tbl) using p_keep, p_dup;
    get diagnostics n = row_count;
    if n > 0 then moved := moved || jsonb_build_object(r.tbl, n); end if;
  end loop;

  -- 3. השלמת שדות ריקים בכרטיס שנשמר מהכפול
  for r in
    select column_name as col from information_schema.columns
    where table_schema = 'public' and table_name = 'customers'
      and column_name not in ('id', 'portal_token', 'created_at', 'updated_at')
      and is_generated = 'NEVER' and is_identity = 'NO'
  loop
    execute format(
      'update public.customers k set %1$I = d.%1$I from public.customers d
         where k.id = $1 and d.id = $2
           and (k.%1$I is null or k.%1$I::text in ('''', ''[]'', ''{}''))
           and d.%1$I is not null and d.%1$I::text not in ('''', ''[]'', ''{}'')', r.col)
      using p_keep, p_dup;
  end loop;

  -- תיעוד בציר הזמן של הלקוח שנשמר (אם הטבלה קיימת)
  if to_regclass('public.interactions') is not null then
    begin
      insert into public.interactions (entity_type, entity_id, content, user_id)
      values ('customer', p_keep, 'אוחד לתוכו לקוח כפול #' || p_dup, auth.uid());
    exception when others then null; -- מבנה שונה — לא חוסם את האיחוד
    end;
  end if;

  -- 4. מחיקת הכפול
  delete from public.customers where id = p_dup;
  return jsonb_build_object('ok', true, 'moved', moved);
end
$fn$;

revoke all on function public.merge_customers(bigint, bigint) from public, anon;
grant execute on function public.merge_customers(bigint, bigint) to authenticated;
