-- ============================================================
-- 2026-09-09 — אינדקסים לשיפור ביצועים (הורדת עומס מעבד מה-DB)
-- ------------------------------------------------------------
-- הרקע: על חבילת ה-DB הקטנה (nano), המעבד הוא המשאב הצר. שאילתות
-- שמסננות טבלה בלי אינדקס גורמות לסריקה מלאה (seq scan) שקוראת את כל
-- הטבלה וגוזלת מעבד יקר — במיוחד call_analysis (הכי גדולה, ~18MB): כל
-- סינון לפי lead_id/customer_id בלעדיה קורא את כל הטבלה.
--
-- האינדקסים כאן מכסים את שדות הסינון החמים: הדשבורד (סטטוס לידים/חיובים/
-- מודעות/כתבות, שעון פתוח), בודק המעקב-המתוזמן, כרטיס הלקוח, וטבלת ניתוח
-- השיחות. כולם משפרים גם את זמן השאילתה וגם — חשוב יותר כאן — מורידים את
-- צריכת המעבד, מה שמאפשר לנקודות-הזיכוי של ה-nano להתאושש.
--
-- idempotent: create index if not exists בלבד. בטוח להרצה חוזרת.
-- טבלאות קטנות ננעלות לרגע בזמן היצירה; ללא CONCURRENTLY (כמו שאר המיגרציות).
-- אם עמודה/טבלה לא קיימת במופע מסוים — הדלג על אותה שורה (לא כולן קיימות בכולם).
-- ============================================================

-- לידים — בודק המעקב המתוזמן ודשבורד (agent_id + follow_up)
create index if not exists leads_agent_followup_idx on public.leads (agent_id, follow_up);
create index if not exists leads_status_idx          on public.leads (status);

-- חיובים — קוביית החוב בדשבורד (סטטוס) וכרטיס הלקוח (customer_id)
create index if not exists charges_status_idx   on public.charges (status);
create index if not exists charges_customer_idx on public.charges (customer_id);
create index if not exists charges_agent_idx    on public.charges (agent_id);

-- תשלומים — חישוב יתרת החוב בדשבורד וכרטיס לקוח (לפי charge_id)
create index if not exists payments_charge_idx on public.payments (charge_id);

-- מודעות — "התקבלו לניתוב" בדשבורד (סטטוס) וכרטיס לקוח (customer_id)
create index if not exists ads_status_idx   on public.ads (status);
create index if not exists ads_customer_idx on public.ads (customer_id);

-- כתבות — "בעבודה/באיחור" בדשבורד (סטטוס)
create index if not exists articles_status_idx on public.articles (status);

-- שעון נוכחות — משמרת פתוחה (clock_out is null) לפי משתמש. אינדקס חלקי קטן.
create index if not exists attendance_open_idx on public.attendance (profile_id) where clock_out is null;

-- ניתוח שיחות — הטבלה הגדולה ביותר. סינון לפי ליד/לקוח/זמן בלי אינדקס = סריקת 18MB.
create index if not exists call_analysis_lead_idx     on public.call_analysis (lead_id);
create index if not exists call_analysis_customer_idx on public.call_analysis (customer_id);
create index if not exists call_analysis_created_idx  on public.call_analysis (created_at desc);
