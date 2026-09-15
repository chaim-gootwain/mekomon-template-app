-- ============================================================
-- מיגרציה: קישורי תשלום ללוח הציבורי — מהגדרות המופע, לא מהקוד
-- ------------------------------------------------------------
-- עד עכשיו קישורי התשלום (Pay360) של הלוח הציבורי היו מקודדים
-- קשיח בתוך portal/luach.html — כלומר ערכים של מופע אחד זלגו
-- לתבנית ולכל מופע חדש. מעכשיו העמוד טוען אותם בזמן ריצה מ-
-- settings.classified_pay_links דרך RPC ציבורי (anon).
--
-- מבנה הערך (JSON), לפי סוג מודעה → מדרגת מילים → קישור:
-- {"regular":{"10":{"single":"https://...","pkg":"https://..."},
--             "20":{"single":"https://...","pkg":"https://..."}},
--  "bold":   {"10":{...},"20":{...}},
--  "image":  {"10":{"single":"https://...","pkg":null}}}
--
-- מופע בלי ערך (או ערך ריק) — כפתור התשלום פשוט לא יוצג בלוח.
-- את הקישורים עצמם מזינים פר מופע (SQL Editor / מסך ההגדרות),
-- לעולם לא בתבנית.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. מפתח ההגדרה ====================
insert into public.settings (key, value) values ('classified_pay_links', '')
  on conflict (key) do nothing;

-- ==================== 2. RPC ציבורי ====================
-- security definer כדי שגם גולש אנונימי בלוח יקבל את הקישורים,
-- בלי לפתוח את טבלת settings כולה. ערך לא-תקין → אובייקט ריק.
create or replace function public.portal_pay_links()
returns jsonb
language plpgsql stable security definer set search_path = public
as $fn$
declare
  v text;
  j jsonb;
begin
  select value into v from settings where key = 'classified_pay_links';
  if v is null or btrim(v) = '' then return '{}'::jsonb; end if;
  begin
    j := v::jsonb;
  exception when others then
    return '{}'::jsonb;
  end;
  if jsonb_typeof(j) <> 'object' then return '{}'::jsonb; end if;
  return j;
end $fn$;

revoke all on function public.portal_pay_links() from public;
grant execute on function public.portal_pay_links() to anon, authenticated;
