-- ============================================================
-- מיגרציה: פורטל לקוח — יתרה לתשלום
-- ------------------------------------------------------------
-- portal_extra(p_token) מחזיר עכשיו גם את יתרת החוב של הלקוח:
--   balance    = סה"כ חיובים (חוץ מבוטלים / אבודים) פחות סה"כ תשלומים
--                — אותו חישוב כמו "יתרת חוב" בכרטיס הלקוח
--   open_count = מספר החיובים הפתוחים (pending / invoiced / partial / overdue)
-- שאר השדות (docs, proofs) בלי שינוי, כך שגרסה ישנה של הפורטל ממשיכה לעבוד.
-- אבטחה: כמו קודם — security definer, זיהוי לפי customers.portal_token בלבד,
-- לקוח ברשימה שחורה לא מקבל כלום, קריאה בלבד.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

create or replace function public.portal_extra(p_token text) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_cid     bigint;
  v_docs    jsonb;
  v_prf     jsonb;
  v_charged numeric;
  v_paid    numeric;
  v_open    int;
begin
  -- זיהוי הלקוח לפי הקישור האישי בלבד
  select id into v_cid from customers
  where portal_token::text = p_token and coalesce(status, 'active') <> 'blacklist'
  limit 1;
  if v_cid is null then
    return null;
  end if;

  -- החשבוניות (24 האחרונות שהופקו)
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

  -- מודעות שממתינות לאישור פרוף של הלקוח
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

  -- יתרת חוב — כמו בכרטיס הלקוח
  select coalesce(sum(amount), 0),
         count(*) filter (where status in ('pending', 'invoiced', 'partial', 'overdue'))
  into v_charged, v_open
  from charges
  where customer_id = v_cid and coalesce(status, '') not in ('cancelled', 'lost');

  select coalesce(sum(amount), 0) into v_paid
  from payments where customer_id = v_cid;

  return jsonb_build_object(
    'docs', v_docs,
    'proofs', v_prf,
    'balance', round(v_charged - v_paid, 2),
    'open_count', v_open
  );
end;
$fn$;

revoke all on function public.portal_extra(text) from public;
grant execute on function public.portal_extra(text) to anon, authenticated;

comment on function public.portal_extra(text)
  is 'פורטל לקוח: חשבוניות, פרופים ממתינים ויתרת חוב לפי הקישור האישי (קריאה בלבד)';
