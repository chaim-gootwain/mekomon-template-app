-- ============================================================
-- מיגרציה: סוגי גיליון מיוחדים (פיצ'ר #21)
-- ------------------------------------------------------------
-- עמודת issue_type על issues: regular (רגיל) / vacation (נופש) /
-- extra (עלון נוסף). כל הגיליונות הקיימים = רגיל.
-- תמחור: מכפילי אחוז פר סוג ב-settings — ברירת מחדל 100% (בלי
-- שינוי!). המכפיל משפיע רק על הצעת המחיר האוטומטית ממחירון בעת
-- הכנסת מודעה לגיליון מיוחד, ומוצג למשתמש. שום מחיר קיים לא משתנה.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.issues
  add column if not exists issue_type text not null default 'regular';

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'issues_issue_type_check') then
    alter table public.issues add constraint issues_issue_type_check
      check (issue_type in ('regular','vacation','extra'));
  end if;
end $mig$;

comment on column public.issues.issue_type
  is 'סוג הגיליון: regular=רגיל, vacation=נופש, extra=עלון נוסף';

-- מכפילי תמחור פר סוג (אחוז מהמחירון) — 100 = ללא שינוי
insert into public.settings (key, value) values ('issue_type_pct_vacation', '100')
  on conflict (key) do nothing;
insert into public.settings (key, value) values ('issue_type_pct_extra', '100')
  on conflict (key) do nothing;
