-- ============================================================
-- מיגרציה: הוראות קבע לחוזים (פיצ'ר #2)
-- ------------------------------------------------------------
-- חוזה מסומן כהוראת קבע מייצר רשומת חיוב (charges) אחת בחודש דרך
-- מנוע הוראות הקבע שבצד הלקוח (deals.js). המנוע יוצר רשומות חיוב
-- צפויות בלבד — הפקת מסמך/גבייה בפועל נשארת ידנית.
-- שליחת ההתראה על "תשלום נכשל" עוברת דרך מנוע ההתראות (#23):
-- חיוב הו"ק שעבר את מועד הפירעון בלי תשלום מלא → אירוע payment_failed.
--
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ את כל הקובץ,
-- בכל מופע בנפרד. בטוח להרצה חוזרת (idempotent).
-- ============================================================

-- ==================== 1. עמודות על contracts ====================
alter table public.contracts
  add column if not exists is_standing_order boolean not null default false;

-- הסכום החודשי לחיוב. חובה כשהחוזה מסומן כהוראת קבע (נאכף בצד הלקוח).
alter table public.contracts
  add column if not exists standing_order_amount numeric;

comment on column public.contracts.is_standing_order
  is 'הוראת קבע: המנוע יוצר רשומת חיוב חודשית אוטומטית (ללא גבייה בפועל)';
comment on column public.contracts.standing_order_amount
  is 'הסכום החודשי של הוראת הקבע (לפני מע"מ)';

create index if not exists contracts_standing_idx
  on public.contracts (is_standing_order) where is_standing_order;

-- ==================== 2. מתגים ב-settings ====================
-- יצירה אוטומטית של חיובי החודש בכניסת מנהל — כבוי כברירת מחדל.
-- גם כשהוא כבוי, הכפתור הידני "צור חיובי החודש" עובד.
insert into public.settings (key, value) values ('standing_orders_auto', '0')
  on conflict (key) do nothing;
