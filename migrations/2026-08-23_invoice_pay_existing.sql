-- ============================================================
-- מיגרציה: זרימת "לקוח שילם" בצ'אט החשבוניות
-- ------------------------------------------------------------
-- מוסיפה סימון "נסגר" לחשבון עסקה (documents), כדי שהצ'אט ידע
-- אילו חשבוניות עסקה עדיין פתוחות כשמפיקים מס-קבלה מקושרת.
-- הרצה: Supabase Dashboard → SQL Editor → הדבק והרץ, בכל מופע.
-- בטוח להרצה חוזרת (idempotent).
-- ============================================================

alter table public.documents add column if not exists settled_at   timestamptz;
alter table public.documents add column if not exists settled_by_doc text;

comment on column public.documents.settled_at is
  'חשבון עסקה שנסגר ע"י מס-קבלה מקושרת (דרך צ׳אט החשבוניות / כרטיס הלקוח). NULL = עדיין פתוח.';
comment on column public.documents.settled_by_doc is
  'מספר מסמך המס-קבלה שסגר את חשבון העסקה הזה.';

-- אינדקס לשליפת עסקאות פתוחות ללקוח (doc_kind=proforma, status=issued, settled_at is null)
create index if not exists documents_open_proforma_idx
  on public.documents (customer_id, doc_kind, status)
  where settled_at is null;
