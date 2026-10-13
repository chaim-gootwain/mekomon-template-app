-- 2026-10-13_lockdown_anon_rpcs.sql
-- ------------------------------------------------------------------------------
-- תיקוני אבטחה מבדיקת המסד החי (עמנואל שלי, 13.10.2026). המשך ל-
-- 2026-10-13_rpc_null_role_guard.sql.
--
-- 1. בדיקות תפקיד שעוברות כש-my_role() הוא NULL (גולש לא מחובר):
--    approve_attendance_request, convert_lead, generate_issues,
--    generate_recurring_expenses, reset_portal_token, route_ad.
--    עוטפים את my_role() ב-coalesce בגוף הפונקציה החי (שאר הגוף לא משתנה).
-- 2. merge_customers — SECURITY DEFINER בלי שום בדיקת הרשאה. מוסיפים: מנהל פעיל בלבד
--    (כמו במסך — js/customer-merge.js מאפשר מיזוג רק למנהל).
-- 3. חסימת הפעלה מ-anon לכל פונקציות ה-RPC הפנימיות (אף דף ציבורי לא קורא להן).
--    פונקציות הפורטל/הגהה/הצעת מחיר/ארכיון ופונקציות העזר של ה-RLS נשארות כמו שהן.
-- 4. whatsapp_messages — הייתה פתוחה לכל משתמש מחובר (כולל "ממתין" שנרשם לבד).
--    מוסיפים מדיניות מגבילה: צוות פעיל בלבד.
-- 5. classified_ads — הייתה פתוחה לקריאה גם ל-anon (כולל שם וטלפון המפרסם).
--    מוסיפים מדיניות קריאה מגבילה: צוות פעיל בלבד. הגשה מהטופס הציבורי ממשיכה לעבוד
--    (portal_submit_classified היא SECURITY DEFINER).
--
-- בטוח להרצה חוזרת (idempotent).
-- ------------------------------------------------------------------------------

-- 1 + 2: תיקון גוף הפונקציות החי
do $mig$
declare
  r      record;
  v_def  text;
  v_new  text;
begin
  for r in
    select * from (values
      ('approve_attendance_request', 'public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('convert_lead',               'public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('generate_issues',            'public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('generate_recurring_expenses','public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('reset_portal_token',         'public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('route_ad',                   'public.my_role()', 'coalesce(public.my_role(), '''')'),
      ('merge_customers',
       'if p_keep = p_dup then',
       'if not public.emu_active_staff(array[''admin'']) then raise exception ''אין הרשאה — מיזוג לקוחות למנהל בלבד''; end if;
  if p_keep = p_dup then')
    ) as t(fn, old_txt, new_txt)
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = r.fn;

    if v_def is null then
      raise notice '% — לא קיימת במופע, מדלג', r.fn;
    elsif position(r.new_txt in v_def) > 0
       or (r.fn <> 'merge_customers' and position('coalesce(public.my_role(), '''')' in v_def) > 0) then
      raise notice '% — כבר מתוקן', r.fn;
    elsif position(r.old_txt in v_def) > 0 then
      if r.fn = 'merge_customers' then
        v_new := regexp_replace(v_def, 'if p_keep = p_dup then', r.new_txt);   -- המופע הראשון בלבד
      else
        v_new := replace(v_def, r.old_txt, r.new_txt);
      end if;
      execute v_new;
      raise notice '% — תוקן', r.fn;
    else
      raise warning '% — שורת הבדיקה לא נמצאה; לבדוק ידנית', r.fn;
    end if;
  end loop;
end
$mig$;

-- 3: חסימת anon מפונקציות פנימיות
do $mig$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('approve_attendance_request','check_duplicate_phone','claim_lead','clock_in','clock_out',
        'convert_lead','customers_matching_words','delete_customer','delete_lead','generate_issues',
        'generate_recurring_expenses','lead_customer_duplicates','merge_customers','prospect_match',
        'reset_portal_token','resolve_commission_pct','route_ad','get_setting')
  loop
    execute format('revoke all on function %s from public, anon', r.fn);
    execute format('grant execute on function %s to authenticated, service_role', r.fn);
  end loop;
end
$mig$;

-- 4: whatsapp_messages — צוות פעיל בלבד
do $mig$ begin
  if to_regclass('public.whatsapp_messages') is not null then
    execute 'drop policy if exists zz_staff_whatsapp_messages on public.whatsapp_messages';
    execute $p$create policy zz_staff_whatsapp_messages on public.whatsapp_messages
      as restrictive for all to public
      using ( public.emu_active_staff(array['admin','sales','editor','graphics']) )
      with check ( public.emu_active_staff(array['admin','sales','editor','graphics']) )$p$;
  end if;
end $mig$;

-- 5: classified_ads — קריאה לצוות פעיל בלבד
do $mig$ begin
  if to_regclass('public.classified_ads') is not null then
    execute 'drop policy if exists zz_staff_classified_select on public.classified_ads';
    execute $p$create policy zz_staff_classified_select on public.classified_ads
      as restrictive for select to public
      using ( public.emu_active_staff(array['admin','sales','editor','graphics','committee']) )$p$;
  end if;
end $mig$;

-- בדיקה: כל השורות צריכות להחזיר ok = true
select 'פונקציה: ' || p.proname as item,
       not has_function_privilege('anon', p.oid, 'execute')
       and (p.proname not in ('approve_attendance_request','convert_lead','generate_issues',
                              'generate_recurring_expenses','reset_portal_token','route_ad')
            or pg_get_functiondef(p.oid) like '%coalesce(public.my_role(), '''')%')
       and (p.proname <> 'merge_customers'
            or pg_get_functiondef(p.oid) like '%emu_active_staff(array[''admin''])%') as ok
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('approve_attendance_request','check_duplicate_phone','claim_lead','clock_in','clock_out',
    'convert_lead','customers_matching_words','delete_customer','delete_lead','generate_issues',
    'generate_recurring_expenses','lead_customer_duplicates','merge_customers','prospect_match',
    'reset_portal_token','resolve_commission_pct','route_ad','get_setting')
union all
select 'מדיניות: ' || tablename || ' / ' || policyname, true
from pg_policies
where schemaname = 'public' and policyname in ('zz_staff_whatsapp_messages', 'zz_staff_classified_select')
order by 1;
