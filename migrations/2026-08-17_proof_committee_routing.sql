-- ============================================================
-- מיגרציה: תיקון מסלול הפרוף + ניתוב לוועדה אחרי אישור כפול
-- ------------------------------------------------------------
-- 1) מתקן באג חוסם: ads_status_check לא כלל את הערך 'proof',
--    כך שכל נסיון לסמן "פרוף מוכן" (status='proof') נכשל בפועל.
-- 2) proof_customer_decision: כששני האישורים (הנהלה+לקוח) קיימים,
--    עוברת ל-status='committee' במקום ל-'approved' ישירות (סעיף 5 בבקשה).
-- 3) generate_contract_ads: מודעות שנוצרות אוטומטית בכמות מחוזים
--    (בלי הנחיית עיצוב פר-מודעה) הולכות לוועדה כברירת מחדל, לא approved.
--    (בפועל contractGenerateForIssue בצד הלקוח הוא זה שרץ היום; זה
--    רק מיישר את הפונקציה הזו איתו למקרה שתופעל בעתיד.)
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ.
-- בטוח להרצה חוזרת (CREATE OR REPLACE / DROP+ADD CONSTRAINT אידמפוטנטיים).
-- ============================================================

-- 1) הוספת 'proof' לרשימת הסטטוסים המותרים
alter table public.ads drop constraint if exists ads_status_check;
alter table public.ads add constraint ads_status_check
  check (status = any (array[
    'received'::text, 'in_graphics'::text, 'proof'::text, 'committee'::text,
    'approved'::text, 'placed'::text, 'published'::text,
    'rejected'::text, 'cancelled'::text
  ]));

-- 2) proof_customer_decision: אישור כפול -> committee (היה approved)
create or replace function public.proof_customer_decision(p_token uuid, p_decision text, p_note text default null::text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_id bigint; v_status text; v_mgmt timestamptz;
begin
  select id, status, proof_mgmt_at into v_id, v_status, v_mgmt from ads where proof_token = p_token limit 1;
  if v_id is null then return 'not_found'; end if;
  if v_status <> 'proof' then return 'not_pending'; end if;
  if p_decision = 'approve' then
    update ads set proof_cust_at = now() where id = v_id;
    if v_mgmt is not null then
      update ads set status = 'committee' where id = v_id;
      return 'committee_final';
    end if;
    return 'approved';
  elsif p_decision = 'revise' then
    update ads set status = 'in_graphics', revision_note = coalesce(p_note, 'תיקון מבוקש ע"י הלקוח'),
      proof_mgmt_at = null, proof_mgmt_by = null, proof_cust_at = null where id = v_id;
    return 'revision';
  else
    return 'bad_decision';
  end if;
end; $function$;

-- 3) generate_contract_ads: יישור לברירת המחדל committee (ללא הנחיית עיצוב זמינה בשלב זה)
create or replace function public.generate_contract_ads(p_issue_id bigint)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_c record; v_used int; v_created int := 0;
begin
  if public.my_role() not in ('admin','sales') then raise exception 'אין הרשאה'; end if;
  for v_c in select ct.*, pl.name as item_name, c.name as customer_name
    from public.contracts ct
    join public.customers c on c.id = ct.customer_id
    left join public.price_list pl on pl.id = ct.price_item_id
    where ct.active
  loop
    if v_c.skip_next then
      update public.contracts set skip_next = false where id = v_c.id;
      continue;
    end if;
    select count(*) into v_used from public.ads
      where contract_id = v_c.id and status not in ('cancelled','rejected');
    if v_used >= v_c.total_inserts then
      update public.contracts set active = false where id = v_c.id;
      continue;
    end if;
    if exists (select 1 from public.ads where contract_id = v_c.id and issue_id = p_issue_id) then
      continue;
    end if;
    insert into public.ads (customer_id, agent_id, issue_id, contract_id, price_item_id,
      title, price, commission_pct, status, source)
    values (v_c.customer_id, v_c.agent_id, p_issue_id, v_c.id, v_c.price_item_id,
      coalesce(v_c.item_name,'מודעה') || ' — ' || v_c.customer_name || ' (חוזה)',
      round(v_c.total_price / v_c.total_inserts, 2),
      v_c.commission_pct, 'committee', 'contract');
    v_created := v_created + 1;
  end loop;
  return v_created;
end; $function$;
