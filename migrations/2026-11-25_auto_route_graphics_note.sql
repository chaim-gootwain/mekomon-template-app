-- ============================================================
-- מיגרציה: ניתוב אוטומטי — קובץ מקור עם הערה לגרפיקה הולך לגרפיקה
-- ------------------------------------------------------------
-- עד עכשיו כל מודעה עם "קובץ מקור" מהלקוח נותבה ישר ל"מאושרת לשיבוץ",
-- גם כשהקובץ היה חומר גלם (לוגו/תמונה) והמזין כתב הערה לגרפיקה
-- (מקרה: סמדר שני, מודעה 1846, 25.11.2026).
-- הכלל החדש ב-ads_auto_route_one:
--   קובץ מקור בלי הערה לגרפיקה        → approved (מודעה מוכנה)
--   קובץ מקור + הערה לגרפיקה           → in_graphics
--   בלי קובץ, עם טקסט / הערה לגרפיקה   → in_graphics (כמו קודם)
-- שאר הפונקציה (עצירת חוב, תיעוד) ללא שינוי.
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ, בכל מופע בנפרד.
-- בטוח להרצה חוזרת (create or replace). לא משנה מודעות קיימות.
-- ============================================================

create or replace function public.ads_auto_route_one(p_ad_id bigint)
returns text
language plpgsql security definer set search_path = public
as $fn$
declare
  v_ad      record;
  v_balance numeric;
  v_has_src boolean;
  v_new     text;
begin
  if coalesce((select value from settings where key = 'ads_auto_route_enabled'), '0') <> '1' then
    return 'disabled';
  end if;

  select * into v_ad from ads where id = p_ad_id;
  if v_ad is null or v_ad.status <> 'received' or v_ad.debt_hold then
    return 'not_applicable';
  end if;

  -- שער חוב: יתרה פתוחה = סכום החיובים הפתוחים פחות התשלומים עליהם.
  -- debt_ok=true פירושו שהמנהל כבר אישר את המודעה הזו למרות החוב — לא בודקים שוב.
  v_balance := 0;
  if not v_ad.debt_ok then
    select coalesce(sum(greatest(oc.amount - coalesce(p.paid, 0), 0)), 0) into v_balance
    from (select id, amount::numeric from charges
          where customer_id = v_ad.customer_id
            and status in ('pending','invoiced','partial','overdue')) oc
    left join (select charge_id, sum(amount::numeric) as paid
               from payments group by charge_id) p on p.charge_id = oc.id;
  end if;

  if v_balance > 0 then
    update ads set debt_hold = true where id = p_ad_id;
    begin
      perform alerts_publish_event('ad_debt_hold', jsonb_build_object(
        'ad_id', p_ad_id,
        'ad_title', coalesce(v_ad.title, 'מודעה #' || p_ad_id),
        'customer_id', v_ad.customer_id,
        'customer_name', coalesce((select name from customers where id = v_ad.customer_id), 'לקוח'),
        'balance', round(v_balance, 2)
      ), 'ads_auto_route');
    exception when others then null; -- מנוע ההתראות לא מותקן/כבוי — לא חוסם
    end;
    begin
      insert into interactions (entity_type, entity_id, content)
      values ('ad', p_ad_id, 'אוטומציה: נעצרה לאישור — ללקוח יתרה פתוחה של ₪' || round(v_balance, 2));
    exception when others then null;
    end;
    return 'debt_hold';
  end if;

  select exists (select 1 from ad_files where ad_id = p_ad_id and kind = 'source') into v_has_src;

  -- קובץ מקור + הערה לגרפיקה = חומר גלם לעיצוב (לוגו/תמונה), לא מודעה מוכנה → גרפיקה
  if v_has_src and nullif(trim(coalesce(v_ad.graphics_note, '')), '') is null then
    v_new := 'approved';
  elsif coalesce(nullif(trim(v_ad.content_text), ''), nullif(trim(v_ad.graphics_note), '')) is not null then
    v_new := 'in_graphics';
  else
    return 'no_rule'; -- אין קובץ ואין טקסט — נשארת לניתוב ידני
  end if;

  update ads set status = v_new, auto_routed_at = now() where id = p_ad_id;
  begin
    insert into interactions (entity_type, entity_id, content)
    values ('ad', p_ad_id, case when v_new = 'approved'
      then 'אוטומציה: התקבל קובץ מעוצב מהלקוח — אושרה לשיבוץ'
      else 'אוטומציה: מודעת טקסט — נותבה לתור הגרפיקה' end);
  exception when others then null;
  end;
  return v_new;
end;
$fn$;

-- מנהל/מכירות רשאים לקרוא ידנית (כפתור "אשר והמשך" אחרי שחרור עצירת חוב)
revoke all on function public.ads_auto_route_one(bigint) from public, anon;
grant execute on function public.ads_auto_route_one(bigint) to authenticated, service_role;
