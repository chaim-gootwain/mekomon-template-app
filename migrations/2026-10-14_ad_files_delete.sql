-- 2026-10-14_ad_files_delete.sql
-- ------------------------------------------------------------------------------
-- הסרה והחלפה של קובץ מכרטיס המודעה.
--
-- כרטיס המודעה מקבל כפתורי "הסרה" ו"החלפה" ליד כל קובץ (admin/sales).
-- מחיקת האובייקט ב-Storage כבר מותרת ל-admin/sales (files_delete ב-
-- 2026-09-07_server_side_authz.sql). כאן מוסיפים מדיניות delete על
-- public.ad_files לאותם תפקידים. סוכן מכירות ממשיך להיות מוגבל למודעות שלו
-- דרך המדיניות המגבילה zz_sales_ad_files.
--
-- בטוח להרצה חוזרת (idempotent).
-- ------------------------------------------------------------------------------

drop policy if exists "ad_files_staff_delete" on public.ad_files;
create policy "ad_files_staff_delete" on public.ad_files
  for delete to authenticated
  using (public.emu_active_staff(array['admin','sales']));

grant delete on public.ad_files to authenticated;
