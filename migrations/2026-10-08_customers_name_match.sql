-- Mekomon — התראת "שם דומה" בהוספת ליד: התאמה מול כל הלקוחות
-- רקע: סוכן רואה (RLS) רק את הלקוחות שלו, ולכן בדיקת השם הדומה בצד הקליינט
-- לא ראתה לקוח של סוכן אחר. הפונקציה SECURITY DEFINER רואה את כל הלקוחות,
-- ומחזירה רק לקוחות שאחת המילים בשמם נמצאת במערך המילים שנשלח
-- (customer_id, שם הלקוח, שם הסוכן — בלי טלפון ופרטים נוספים).
-- הפירוק למילים זהה ל-leadNameWords ב-js/leads.js (המילים שנשלחות כבר
-- מסוננות בקליינט: 3 אותיות ומעלה, בלי מילים כלליות).
-- שומר תפקיד כמו lead_customer_duplicates: admin/sales פעילים בלבד.
-- Idempotent — בטוח להריץ שוב. להריץ ידנית ב-SQL Editor של כל מופע.

create or replace function public.customers_matching_words(p_words text[])
returns table(customer_id bigint, customer_name text, agent_name text)
language sql stable security definer set search_path = public as $fn$
  select c.id, c.name, a.name
  from public.customers c
  left join public.agents a on a.id = c.agent_id
  where public.emu_active_staff(array['admin','sales'])
    and coalesce(array_length(p_words, 1), 0) > 0
    and regexp_split_to_array(
          lower(regexp_replace(coalesce(c.name, ''), '["''״׳`.,\-–()/\\]', ' ', 'g')),
          '\s+') && p_words
  order by c.id
  limit 1000
$fn$;

revoke all on function public.customers_matching_words(text[]) from public;
grant execute on function public.customers_matching_words(text[]) to authenticated;
