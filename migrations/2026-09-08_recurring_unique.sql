-- מניעת הזרעה כפולה של מודעות קבועות (מודעות מערכת: לוח תורנויות, זמני שבת).
-- שני משתמשים שפתחו את מסך הגיליונות בו-זמנית עוברים יחד את בדיקת
-- ה"כבר קיים" בקליינט ומזריעים פעמיים; הדגל _recSweepBusy מגן רק בתוך
-- טאב אחד. אילוץ ייחודיות במסד סוגר את המרוץ סופית — הקוד כבר בולע
-- שגיאת insert כפול בשקט (recAdsSweep), כך שאין צורך בשינוי קליינט.
-- Idempotent — בטוח להריץ שוב. להריץ ידנית ב-SQL Editor של כל מופע.

-- ניקוי כפילויות קיימות מהבאג (משאירים את המודעה הוותיקה בכל צמד):
delete from public.ads a
using public.ads b
where a.recurring_id is not null
  and b.recurring_id = a.recurring_id
  and b.issue_id = a.issue_id
  and b.id < a.id;

create unique index if not exists ads_recurring_issue_uniq
  on public.ads (recurring_id, issue_id)
  where recurring_id is not null;
