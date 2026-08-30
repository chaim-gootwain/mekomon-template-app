# mekomon-intake — טופס קליטת לקוח חדש

אתר סטטי עצמאי (קובץ `index.html` יחיד, בלי frameworks) שבו לקוח חדש ממלא
בעצמו את כל מה שצריך להקמת מופע של מערכת המקומונים: מיתוג, חיבורים
(חשבוניות / מייל / סליקה) ופרטים תפעוליים.

**נפרד לחלוטין מריפו התבנית `mekomon-template-app` ומהמופעים — אין שום תלות.**

## ארכיטקטורת האבטחה

| סוג מידע | לאן נשלח |
|---|---|
| פרטים רגילים + קובץ לוגו + קובץ מחירון | **Netlify Forms** (טופס `intake`) → התראת מייל אל e77050@gmail.com |
| מפתחות/סיסמאות (API keys, Gmail App Password, פרטי סליקה) | **Supabase ייעודי בלבד** — טבלת `intake_secrets`, INSERT-only ל-anon |

- שדות סודיים ב-HTML הם **ללא `name`** ולכן לעולם לא נכללים ב-FormData
  שנשלח ל-Netlify, לא במייל ולא בבלוק הסיכום — שם מופיע רק
  "✓ התקבלו פרטי חיבור".
- ה-anon key שבדף יכול רק להכניס שורות: RLS בלי policy של SELECT +
  ‏REVOKE מפורש (ראו `supabase/intake_table.sql`). קריאת הסודות — רק
  מהדשבורד של Supabase.

## הקמה (חד-פעמית)

1. **Supabase**: פרויקט חדש וקטן בשם `mekomon-intake` → SQL Editor →
   הרצת `supabase/intake_table.sql`.
2. **חיבור הדף**: ב-`index.html` להחליף את
   `@@INTAKE_SUPABASE_URL@@` ו-`@@INTAKE_SUPABASE_KEY@@`
   ב-Project URL וב-anon/publishable key של הפרויקט.
3. **Netlify**: Add new site → Import from Git → הריפו הזה.
   בלי build command, publish = `.`.
4. **התראות מייל**: Site → Forms → Form notifications →
   Email notification אל `e77050@gmail.com` על טופס `intake`.
5. בדיקת שליחה מלאה (כולל קובץ לוגו ומפתח דמה) — לוודא שהמייל מגיע
   ושורת סודות נכנסה ל-`intake_secrets`.

## הערות

- מגבלת Netlify Forms לקבצים מצורפים: ‎8MB לקובץ (מוצג גם למשתמש).
- הטופס בנוי כ-wizard בן 4 שלבים עם ולידציה (טלפון ישראלי, מייל,
  subdomain באנגלית בלבד), תצוגה מקדימה חיה לצבעים וללוגו, וטבלאות
  דינמיות למחירון ולמשתמשים.
- אחרי שליחה מוצג ללקוח (וגם נשלח בשדה `summary` במייל) בלוק סיכום
  בפורמט קבוע עם כפתור העתקה — מוכן להדבקה בסקיל `mekomon-new-client`.
