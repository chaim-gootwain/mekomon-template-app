-- ============================================================
-- 2026-09-09 — רישום תשלום אטומי על לוח-תשלומים של חוזה
-- ------------------------------------------------------------
-- הבעיה: dealPay/dealPayInvoice קוראים את payment_plan (מערך JSON), משנים
-- שורה אחת, וכותבים את כל המערך בחזרה. שני פקידים שרושמים תשלום על אותו
-- חוזה (גם על תשלומים שונים) באותן שניות — הכתיבה השנייה דורסת את הראשונה,
-- ותשלום "נעלם" בלי שגיאה.
--
-- הפתרון: פונקציה שנועלת את שורת החוזה (FOR UPDATE) ומעדכנת את רכיב לוח
-- התשלומים בתוך המסד — אטומית. שתי קריאות מקבילות מסתדרות בתור במקום לדרוס.
-- SECURITY INVOKER (ברירת מחדל): רצה בהרשאות הקורא ומכבדת RLS בדיוק כמו
-- ה-UPDATE הישיר שהיה קודם — בלי הרחבת הרשאות.
--
-- idempotent: create or replace. בטוח להרצה חוזרת.
-- ============================================================

create or replace function public.record_contract_payment(
  p_contract_id bigint, p_seq int, p_amount numeric
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_plan jsonb;
  v_idx int;
  v_row jsonb;
  v_paid numeric;
  v_amount numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount_invalid';
  end if;
  -- נעילת שורת החוזה עד סוף הטרנזקציה — סריאליזציה מול קריאות מקבילות
  select payment_plan into v_plan from public.contracts where id = p_contract_id for update;
  if v_plan is null or jsonb_typeof(v_plan) <> 'array' then
    raise exception 'no_plan';
  end if;
  select (ord - 1) into v_idx
    from jsonb_array_elements(v_plan) with ordinality as e(val, ord)
   where (val->>'seq')::int = p_seq
   limit 1;
  if v_idx is null then
    raise exception 'seq_not_found';
  end if;
  v_row := v_plan -> v_idx;
  v_paid := coalesce((v_row->>'paid')::numeric, 0) + p_amount;
  v_amount := coalesce((v_row->>'amount')::numeric, 0);
  v_row := jsonb_set(v_row, '{paid}', to_jsonb(v_paid));
  v_row := jsonb_set(v_row, '{status}', to_jsonb(case when v_paid >= v_amount then 'paid' else 'partial' end));
  v_plan := jsonb_set(v_plan, array[v_idx::text], v_row);
  update public.contracts set payment_plan = v_plan where id = p_contract_id;
  return v_row;
end $$;

grant execute on function public.record_contract_payment(bigint, int, numeric) to authenticated;
