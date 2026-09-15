-- ============================================================
-- 2026-09-15_ad_publish_charge_dedup.sql  (idempotent)
-- ------------------------------------------------------------
-- on_ad_published (הטריגר trg_ad_published): יוצר חיוב למודעה כשהיא
-- עוברת ל"פורסמה". בדיקת הכפילות המקורית ראתה רק חיובים עם ad_id —
-- וחיובים ממסלולים אחרים (חשבונית מכרטיס/צ'אט, חיוב גיליון, עסקה)
-- לא ממלאים ad_id, ולכן מודעה שכבר חויבה שם קיבלה חיוב שני בפרסום
-- (התגלה 15.09.2026: פרסום-למפרע של מודעות היסטוריות יצר 1,008 חיובים
-- כוזבים). התוספת: דילוג גם על מודעה שמסומנת deal_stage חויבה/שולמה —
-- הסימון שכל מסלולי החיוב מעדכנים.
-- דרישות: עמודת ads.deal_stage (מיגרציית issue-entry) והטריגר
-- trg_ad_published קיים במופע. במופע בלי הטריגר — אין צורך להריץ.
-- ============================================================

create or replace function public.on_ad_published()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_customer public.customers; v_agent public.agents;
  v_terms_days int; v_pct numeric; v_months int;
begin
  if new.status = 'published' and old.status is distinct from 'published'
     and new.customer_id is not null
     -- מודעה שכבר חויבה/שולמה במסלול אחר — לא יוצרים חיוב נוסף
     and coalesce(new.deal_stage, '') not in ('invoiced', 'paid')
     and not exists (select 1 from public.charges where ad_id = new.id) then
    select * into v_customer from public.customers where id = new.customer_id;
    select * into v_agent from public.agents where id = new.agent_id;
    v_terms_days := case v_customer.payment_terms when 'net30' then 30 when 'net60' then 60 else 0 end;
    v_pct := public.resolve_commission_pct(new, v_customer, v_agent);
    v_months := coalesce(public.get_setting('new_customer_months'),'3')::int;
    insert into public.charges (customer_id, ad_id, contract_id, agent_id, amount, description,
                                due_date, commission_pct, is_new_customer)
    values (new.customer_id, new.id, new.contract_id, new.agent_id,
            greatest(new.price - new.discount, 0),
            'מודעה: ' || new.title,
            current_date + v_terms_days, v_pct,
            v_customer.became_customer_at >= (current_date - (v_months||' months')::interval)::date);
  end if;
  return new;
end; $function$;
