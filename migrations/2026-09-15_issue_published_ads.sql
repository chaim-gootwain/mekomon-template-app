-- ============================================================
-- 2026-09-15_issue_published_ads.sql  (idempotent — בטוח להרצה חוזרת)
-- ------------------------------------------------------------
-- גיליון שעובר לסטטוס "יצא לאור" (published) מפרסם אוטומטית את
-- המודעות המשובצות שלו: ads.status 'placed' → 'published'.
-- בלי זה מונה "מודעות שפורסמו" (דוח היסטוריית לקוח, הצ'אט) מציג 0
-- גם ללקוחות שפורסמו בפועל. תופס כל מסלול עדכון — כולל הסימון
-- האוטומטי שרץ בכניסה לעמוד הגיליונות (issues.js).
-- security definer: גם תפקיד שמורשה לעדכן גיליון אך לא את כל
-- המודעות (RLS) מפעיל את הפרסום.
-- ============================================================

create or replace function public.issue_published_ads_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'published' and (old.status is distinct from new.status) then
    update public.ads
       set status = 'published'
     where issue_id = new.id
       and status = 'placed';
  end if;
  return new;
end;
$$;

drop trigger if exists issue_published_ads on public.issues;
create trigger issue_published_ads
  after update of status on public.issues
  for each row execute function public.issue_published_ads_tg();
