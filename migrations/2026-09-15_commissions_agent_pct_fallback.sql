-- ============================================================
-- תיקון v_commissions — עמלה לפי הסוכן כשאין אחוז מיוחד על החיוב
-- ------------------------------------------------------------
-- הבאג: ה-VIEW חישב עמלה רק מ-charges.commission_pct, אבל אף מסלול
-- יצירת חיוב בקוד לא ממלא את העמודה הזו — ולכן ה-VIEW היה ריק תמיד
-- ומסך "עמלות סוכנים" הציג ₪0 לכולם, בכל חודש.
--
-- התיקון: אם על החיוב אין אחוז מיוחד (NULL או 0) — נופלים לאחוז של
-- הסוכן מטבלת agents: pct_new אם החיוב הופק בתוך "תקופת לקוח חדש"
-- (הגדרת new_customer_months, ברירת מחדל 3 חודשים) מהחיוב הראשון של
-- הלקוח, אחרת pct_renew. אחוז מיוחד שהוגדר על החיוב עדיין גובר.
--
-- הערות:
-- * commission_pct = 0 נחשב "לא הוגדר" (כמו NULL) — בהתאם להתנהגות
--   הקיימת (התנאי הישן היה > 0) ולתווית בממשק: "ריק = לפי הסוכן".
-- * "לקוח חדש" = החיוב הופק בתוך new_customer_months מתאריך החיוב
--   הראשון של הלקוח (כולל חוב ישן שהוזן עם תאריכו המקורי).
-- * מבנה העמודות, פורמט month ‏('YYYY-MM') וכללי הסטטוס נשמרו כפי
--   שהיו (billing מחריג cancelled; collection מחריג lost).
-- * התיקון רטרואקטיבי — VIEW מחושב תמיד מהנתונים הקיימים.
--
-- idempotent — בטוח להרצה חוזרת.
-- ============================================================

do $mig$
declare
  v_si boolean;
begin
  -- שימור הגדרת security_invoker הקיימת של ה-VIEW (אם יש):
  -- CREATE OR REPLACE VIEW מאפס reloptions, ואסור לאבד את ההגדרה בשקט.
  select coalesce(
    (select bool_or(split_part(opt, '=', 2) in ('true', 'on', '1'))
       from pg_class, unnest(coalesce(reloptions, array[]::text[])) as opt
      where oid = to_regclass('public.v_commissions')
        and opt like 'security_invoker=%'), false)
  into v_si;

  execute $v$
    create or replace view public.v_commissions as
    with cfg as (
      select coalesce(public.get_setting('commission_split_billing'), '50')::numeric / 100.0 as billing_part,
             greatest(coalesce(nullif(public.get_setting('new_customer_months'), ''), '3')::int, 0) as new_months
    ), first_charge as (
      -- עוגן "לקוח חדש": תאריך החיוב הראשון של כל לקוח
      select customer_id, min(issued_date) as first_date
      from public.charges
      group by customer_id
    ), base as (
      select c.id, c.agent_id, c.customer_id, c.amount, c.issued_date, c.status,
             cfg.billing_part,
             coalesce(
               nullif(c.commission_pct, 0),
               case when c.issued_date < fc.first_date + make_interval(months => cfg.new_months)
                    then a.pct_new
                    else a.pct_renew
               end,
               0) as eff_pct
      from public.charges c
      cross join cfg
      left join first_charge fc on fc.customer_id = c.customer_id
      left join public.agents a on a.id = c.agent_id
      where c.agent_id is not null
    )
    select b.agent_id,
           to_char(b.issued_date::timestamp with time zone, 'YYYY-MM') as month,
           b.id as charge_id,
           b.customer_id,
           b.amount as base_amount,
           'billing'::text as part,
           round(b.amount * (b.eff_pct / 100.0) * b.billing_part, 2) as commission
    from base b
    where b.eff_pct > 0 and b.status <> 'cancelled'
    union all
    select b.agent_id,
           to_char(p.paid_date::timestamp with time zone, 'YYYY-MM') as month,
           b.id as charge_id,
           b.customer_id,
           p.amount as base_amount,
           'collection'::text as part,
           round(p.amount * (b.eff_pct / 100.0) * (1 - b.billing_part), 2) as commission
    from public.payments p
    join base b on b.id = p.charge_id
    where b.eff_pct > 0 and b.status <> 'lost'
  $v$;

  if v_si then
    execute 'alter view public.v_commissions set (security_invoker = on)';
  end if;
end
$mig$;
