-- שלב א' — תור גרפיקה, פרוף ואישורים
-- הוספת עמודות בלבד (בטוח, לא נוגע בנתונים קיימים)
alter table ads
  add column if not exists queue_order  int,
  add column if not exists proof_round   int not null default 0,
  add column if not exists proof_mgmt_by uuid,
  add column if not exists proof_mgmt_at timestamptz,
  add column if not exists proof_cust_at timestamptz,
  add column if not exists proof_token   uuid not null default gen_random_uuid(),
  add column if not exists revision_note text;
