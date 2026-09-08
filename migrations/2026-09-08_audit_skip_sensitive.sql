-- הרחבת רשימת השדות שיומן הביקורת מדלג עליהם: proof_token (טוקן אישור
-- הפרוף הציבורי) ו-signature_data (חתימת לקוח) נרשמו עד עכשיו כערכים
-- מלאים ב-audit_log — טבלה עם RLS שונה מהטבלה המקורית, כלומר הטוקן דלף
-- אל מחוץ להגנה שלו. זהה לפונקציה שב-2026-08-30_audit_log.sql לאחר העדכון.
-- Idempotent — בטוח להריץ שוב. להריץ ידנית ב-SQL Editor של כל מופע.

create or replace function public.audit_track() returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare
  v_old  jsonb;
  v_new  jsonb;
  v_row  bigint;
  k      text;
  skip   constant text[] := array['created_at','updated_at','portal_token','proof_token','signature_data','tags'];
begin
  if tg_op = 'INSERT' then
    begin v_row := (to_jsonb(new)->>'id')::bigint; exception when others then v_row := null; end;
    insert into audit_log (table_name, row_id, action, user_id)
    values (tg_table_name, v_row, 'insert', auth.uid());
    return new;
  end if;

  if tg_op = 'DELETE' then
    begin v_row := (to_jsonb(old)->>'id')::bigint; exception when others then v_row := null; end;
    insert into audit_log (table_name, row_id, action, user_id)
    values (tg_table_name, v_row, 'delete', auth.uid());
    return old;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  begin v_row := (v_new->>'id')::bigint; exception when others then v_row := null; end;
  for k in select jsonb_object_keys(v_new) loop
    if k = any(skip) then continue; end if;
    if v_old->k is distinct from v_new->k then
      insert into audit_log (table_name, row_id, action, field, old_value, new_value, user_id)
      values (tg_table_name, v_row, 'update', k,
              left(coalesce(v_old->>k, ''), 500),
              left(coalesce(v_new->>k, ''), 500),
              auth.uid());
    end if;
  end loop;
  return new;
end;
$fn$;

-- ניקוי ערכים שכבר נרשמו ביומן עבור השדות הרגישים:
update public.audit_log
   set old_value = null, new_value = null
 where field in ('proof_token', 'signature_data')
   and (old_value is not null or new_value is not null);
