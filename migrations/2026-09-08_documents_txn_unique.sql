-- ============================================================
-- 2026-09-08 — אינדקס ייחודי על documents.transaction_id (מסמכים שהופקו)
-- ------------------------------------------------------------
-- הגנת עומק לסגירת חשבוניות כפולות: הצד הלקוח שולח כעת transaction_id יציב
-- ו-ezcount-doc בודק replay לפני קריאה ל-EZcount, אבל שתי בקשות מקבילות
-- באמת (שני מכשירים באותה שנייה) עוברות את הבדיקה. האינדקס מבטיח ששורת
-- "issued"/"pending_allocation" אחת בלבד תירשם לכל transaction_id;
-- ezcount-doc מתאושש מהקונפליקט ומחזיר את המסמך הקיים.
-- ניסיונות שנכשלו (status='failed'/'cancelled') חולקים מזהה בכוונה — מוחרגים.
--
-- idempotent: רץ שוב בלי נזק. אם כבר קיימות כפילויות היסטוריות — מדלגים
-- בהתראה במקום להפיל את הרצף (לנקות ידנית ולהריץ שוב).
-- ============================================================

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'documents') then
    raise notice 'documents table missing — skipping';
    return;
  end if;
  begin
    create unique index if not exists documents_txn_issued_uniq
      on public.documents (transaction_id)
      where status in ('issued', 'pending_allocation') and transaction_id is not null;
  exception when others then
    raise notice 'documents_txn_issued_uniq not created (% ) — יש כפילויות קיימות? לנקות ולהריץ שוב', sqlerrm;
  end;
end $$;
