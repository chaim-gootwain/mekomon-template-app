-- 2026-10-13_rpc_null_role_guard.sql
-- ------------------------------------------------------------------------------
-- תיקון אבטחה: בדיקות תפקיד שעוברות כשהתפקיד ריק (NULL).
--
-- generate_contract_ads ו-publish_issue_ads הן SECURITY DEFINER ובודקות הרשאה כך:
--     if public.my_role() not in ('admin','sales') then raise ...
-- למשתמש לא מחובר (anon) או למשתמש בלי שורה ב-profiles, my_role() מחזיר NULL,
-- ו-NULL not in (...) הוא NULL — לא true — ולכן ה-raise לא קורה והבדיקה עוברת.
-- generate_contract_ads גם לא נחסמה מ-anon, כך שכל אחד עם המפתח הציבורי יכול היה
-- להפעיל אותה (ליצור מודעות חוזה בכל גיליון ולשנות contracts.skip_next).
--
-- התיקון:
--   1. עוטף את my_role() ב-coalesce(..., '') בגוף הפונקציה החי (מחליף רק את שורת
--      הבדיקה — שאר הגוף נשאר כפי שהוא במופע).
--   2. חוסם הפעלה מ-public/anon ומשאיר רק ל-authenticated.
--
-- בטוח להרצה חוזרת (idempotent).
-- ------------------------------------------------------------------------------

do $mig$
declare
  r      record;
  v_def  text;
  v_new  text;
begin
  for r in
    select * from (values
      ('public.generate_contract_ads(bigint)'::regprocedure,
       'if public.my_role() not in (',
       'if coalesce(public.my_role(), '''') not in ('),
      ('public.publish_issue_ads(bigint)'::regprocedure,
       'if public.my_role() <> ''admin'' then',
       'if coalesce(public.my_role(), '''') <> ''admin'' then')
    ) as t(fn, old_txt, new_txt)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.new_txt in v_def) > 0 then
      raise notice '% — כבר מתוקן', r.fn;
    elsif position(r.old_txt in v_def) > 0 then
      v_new := replace(v_def, r.old_txt, r.new_txt);
      execute v_new;
      raise notice '% — תוקן', r.fn;
    else
      raise warning '% — שורת הבדיקה לא נמצאה; לבדוק ידנית', r.fn;
    end if;
  end loop;
end
$mig$;

revoke all on function public.generate_contract_ads(bigint) from public, anon;
grant execute on function public.generate_contract_ads(bigint) to authenticated, service_role;

revoke all on function public.publish_issue_ads(bigint) from public, anon;
grant execute on function public.publish_issue_ads(bigint) to authenticated, service_role;

-- בדיקה: שתי השורות צריכות להחזיר anon_can_exec = false ו-guard_fixed = true
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_exec,
       pg_get_functiondef(p.oid) like '%coalesce(public.my_role()%' as guard_fixed
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('generate_contract_ads', 'publish_issue_ads');
