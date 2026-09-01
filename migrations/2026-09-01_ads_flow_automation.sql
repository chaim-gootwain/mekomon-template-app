-- ============================================================
-- מיגרציה: אוטומציית זרימת המודעות (01.09.2026)
-- ------------------------------------------------------------
-- 1. עמודות חדשות ב-ads: debt_hold (עצירה לאישור בגלל חוב פתוח),
--    auto_routed_at (תיעוד — מתי האוטומציה ניתבה את המודעה).
-- 2. ads_auto_route_one(id) — חוק הניתוב למודעה בודדת:
--    לקוח עם חוב פתוח → debt_hold + התראה למנהל (המודעה נשארת
--    ב"חדשות לניתוב" עד אישור ידני);
--    יש קובץ מקור מהלקוח → approved (מוכנה לשיבוץ);
--    יש טקסט/הנחיית עיצוב → in_graphics (תור הגרפיקה);
--    אין כלום → נשארת לניתוב ידני.
-- 3. ads_auto_route_sweep() — סריקה כל 5 דקות (pg_cron):
--    מנתבת מודעות received שהתיישבו (>2 דקות, כדי לתת לקבצים לעלות),
--    ומרוקנת את סטטוס committee ל-approved כשמצב "דיוור ועדה" דולק.
-- 4. טריגר על ad_files — ניתוב מיידי כשקובץ מקור עולה למודעה שממתינה.
-- 5. publish_issue_ads(issue_id) — פרסום מרוכז: כל המשובצות בגיליון
--    מסומנות פורסמו דרך route_ad (שיוצר את החיובים), מנהל בלבד.
-- 6. כלל התראה ad_debt_hold במנוע ההתראות.
--
-- מתגים (הכל כבוי כברירת מחדל — אין שינוי התנהגות עד הדלקה בהגדרות):
--   ads_auto_route_enabled='1'    → ניתוב אוטומטי פעיל
--   committee_digest_enabled='1'  → ועדה במייל מרוכז (ריקון סטטוס ועדה)
--   committee_emails              → נמעני הדיוור (מופרד בפסיקים)
--   committee_digest_times        → זמני הדיוור (ברירת מחדל בצד הפונקציה)
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- אחרי ההרצה: לתזמן את פונקציית ה-Edge ‏committee-digest פעם בשעה
-- (Dashboard → Integrations → Cron → Scheduled Function) — היא בודקת
-- לבד אם הגיע אחד מזמני הדיוור ושולחת רק אז.
-- ============================================================

-- ==================== 1. עמודות חדשות ====================
alter table public.ads
  add column if not exists debt_hold      boolean not null default false,
  add column if not exists debt_ok        boolean not null default false,
  add column if not exists auto_routed_at timestamptz;
-- debt_ok: המנהל אישר את המודעה למרות החוב — שער החוב לא נבדק שוב עבורה.

-- ==================== 2. חוק הניתוב למודעה בודדת ====================
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

  if v_has_src then
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

-- ==================== 3. סריקה מחזורית ====================
create or replace function public.ads_auto_route_sweep()
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
  v_id      bigint;
  v_count   integer := 0;
  v_drained integer := 0;
begin
  if coalesce((select value from settings where key = 'ads_auto_route_enabled'), '0') <> '1' then
    return 0;
  end if;

  -- מודעות חדשות שהתיישבו (2 דקות — נותן לקובץ מהטופס/פורטל לעלות)
  for v_id in
    select id from ads
    where status = 'received' and not debt_hold
      and created_at < now() - interval '2 minutes'
    order by id limit 200
  loop
    if public.ads_auto_route_one(v_id) in ('approved', 'in_graphics', 'debt_hold') then
      v_count := v_count + 1;
    end if;
  end loop;

  -- מצב "ועדה במייל": סטטוס ועדה אינו תחנה חוסמת — מרוקנים ל-approved.
  -- (מודעות מחוזים ומהפרוף עוד נכנסות לשם; הדיוור המרוכז מכסה אותן.)
  if coalesce((select value from settings where key = 'committee_digest_enabled'), '0') = '1' then
    update ads set status = 'approved', auto_routed_at = now()
    where status = 'committee';
    get diagnostics v_drained = row_count;
    v_count := v_count + v_drained;
  end if;

  return v_count;
end;
$fn$;

revoke all on function public.ads_auto_route_sweep() from public, anon, authenticated;
grant execute on function public.ads_auto_route_sweep() to service_role;

-- ==================== 4. טריגר: קובץ מקור עלה → ניתוב מיידי ====================
create or replace function public.ad_files_auto_route_tg()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
begin
  if new.kind = 'source' then
    begin
      perform public.ads_auto_route_one(new.ad_id);
    exception when others then null; -- הניתוב לעולם לא מפיל העלאת קובץ
    end;
  end if;
  return new;
end;
$fn$;

drop trigger if exists ad_files_auto_route on public.ad_files;
create trigger ad_files_auto_route
  after insert on public.ad_files
  for each row execute function public.ad_files_auto_route_tg();

-- ==================== 5. פרסום מרוכז לגיליון ====================
-- מסמן את כל המודעות המשובצות (placed) בגיליון כפורסמו דרך route_ad —
-- אותה פונקציה שהכפתור הידני קורא לה, כך שיצירת החיובים זהה אחד-לאחד.
create or replace function public.publish_issue_ads(p_issue_id bigint)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_id        bigint;
  v_published integer := 0;
  v_errors    jsonb := '[]'::jsonb;
begin
  if public.my_role() <> 'admin' then
    raise exception 'אין הרשאה — פרסום מרוכז למנהל בלבד';
  end if;

  for v_id in
    select id from ads where issue_id = p_issue_id and status = 'placed' order by id
  loop
    begin
      perform public.route_ad(v_id, 'publish', 'פורסמה במרוכז עם הגיליון');
      v_published := v_published + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('ad_id', v_id, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('published', v_published, 'errors', v_errors);
end;
$fn$;

revoke all on function public.publish_issue_ads(bigint) from public, anon;
grant execute on function public.publish_issue_ads(bigint) to authenticated;

-- ==================== 6. כלל התראה: מודעה נעצרה בגלל חוב ====================
insert into public.alert_rules (event_type, enabled, condition, channels, template, throttle_hours, recipients)
select 'ad_debt_hold', true, '{}'::jsonb, array['inapp'],
       'מודעה "{ad_title}" של {customer_name} ממתינה לאישורך — יתרה פתוחה {balance}',
       0, '{"roles":["admin"]}'::jsonb
where not exists (select 1 from public.alert_rules where event_type = 'ad_debt_hold');

-- ==================== 7. תזמון הסריקה (pg_cron) ====================
do $mig$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron לא זמין (%). חלופה: לתזמן קריאה ל-ads_auto_route_sweep כל 5 דקות דרך Dashboard → Integrations → Cron.', sqlerrm;
    return;
  end;

  begin
    perform cron.unschedule('ads-auto-route-sweep');
  exception when others then
    null; -- הג'וב עוד לא קיים — זה בסדר
  end;

  perform cron.schedule('ads-auto-route-sweep', '*/5 * * * *',
                        'select public.ads_auto_route_sweep();');
  raise notice 'תוזמן ג''וב: ads-auto-route-sweep (כל 5 דקות).';
exception when others then
  raise notice 'תזמון pg_cron נכשל (%). חלופה: Dashboard → Integrations → Cron.', sqlerrm;
end $mig$;

-- תזכורת: את פונקציית ה-Edge ‏committee-digest מתזמנים פעם בשעה דרך
-- Dashboard → Integrations → Cron (היא שולחת רק בזמנים שהוגדרו בהגדרות).
