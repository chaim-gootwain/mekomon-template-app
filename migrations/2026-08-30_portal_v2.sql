-- ============================================================
-- מיגרציה: פורטל לקוח משודרג — שלב א (פיצ'ר #15)
-- ------------------------------------------------------------
-- RPC חדש portal_extra(p_token): מחזיר ללקוח (לפי הקישור האישי
-- שלו בלבד) שני דברים נוספים:
--   1. החשבוניות שלו (מסמכים שהופקו) עם קישורי PDF.
--   2. מודעות שממתינות לאישור פרוף שלו + טוקן דף האישור הקיים.
-- אבטחה: security definer, זיהוי לפי customers.portal_token בלבד,
-- שדות מצומצמים, קריאה בלבד — אף עדכון לא עובר כאן.
-- הפורטל וההגשה הקיימים (portal_info / portal_submit_ad) לא נגעו.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

create or replace function public.portal_extra(p_token text) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_cid  bigint;
  v_docs jsonb;
  v_prf  jsonb;
begin
  -- זיהוי הלקוח לפי הטוקן האישי — כמו portal_info הקיים
  select id into v_cid from customers
  where portal_token::text = p_token and coalesce(status, 'active') <> 'blacklist'
  limit 1;
  if v_cid is null then
    return null;
  end if;

  -- 1) המסמכים שהופקו ללקוח (שדות מצומצמים בלבד)
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', d.doc_kind,
           'number', d.doc_number,
           'date', to_char(d.created_at, 'DD.MM.YYYY'),
           'total', d.total,
           'pdf', d.pdf_url
         ) order by d.created_at desc), '[]'::jsonb)
  into v_docs
  from (select * from documents
        where customer_id = v_cid and status = 'issued'
        order by created_at desc limit 24) d;

  -- 2) מודעות שממתינות לאישור הפרוף של הלקוח (דף האישור הקיים)
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', a.title,
           'proof_token', a.proof_token,
           'round', a.proof_round
         ) order by a.id desc), '[]'::jsonb)
  into v_prf
  from ads a
  where a.customer_id = v_cid
    and a.status = 'proof'
    and a.proof_cust_at is null;

  return jsonb_build_object('docs', v_docs, 'proofs', v_prf);
end;
$fn$;

revoke all on function public.portal_extra(text) from public;
grant execute on function public.portal_extra(text) to anon, authenticated;

comment on function public.portal_extra(text)
  is 'פורטל לקוח: חשבוניות + פרופים ממתינים לפי הקישור האישי (קריאה בלבד)';
