# הקמת מופע חדש לעיתון — תבנית מקומון

תבנית **גנרית** של מערכת ניהול מקומון (CRM + גיליונות + גבייה + הפקת מסמכים + מיילים).
כל מה שמשתנה בין עיתון לעיתון — שם, סלוגן, טלפון, אימייל, צבעים, לוגו וחיבור
ל-Supabase — מרוכז ב-`@@TOKEN@@` ומוזרק אוטומטית.

## שלבים

1. **צור repo חדש** מהתבנית ("Use this template" → Create a new repository).
   הריפו החדש יורש את כל הקבצים, כולל `supabase/functions/`, `supabase/config.toml`
   וה-workflow `deploy-functions.yml`.
2. **צור פרויקט Supabase** לעיתון החדש. העתק את **Project URL** ואת ה-**publishable/anon key**.
3. **קונפיג צד-לקוח:** העתק את `instance.config.example` ל-`instance.config` ומלא ערכים
   (כולל נתיב ל-PNG של הלוגו), והרץ `python3 setup_instance.py instance.config`
   (ממלא טוקנים, מתקין לוגו ויוצר אייקונים; דורש `pip install pillow`).
4. **Secrets & Variables של ה-repo** (Settings → Secrets and variables → Actions).
   אלה משמשים גם את הסנכרון וגם את פריסת ה-Edge Functions:

   **Variables:** `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `PAPER_NAME`, `PAPER_SUB`,
   `PAPER_PHONE`, `PAPER_EMAIL`, `COLOR_BRAND`, `COLOR_DARK`, `COLOR_LIGHT`,
   `COLOR_GRAD`, `COLOR_ACCENT`, `COLOR_BG`.

   **Secrets:** `SUPABASE_KEY` (anon), `SYNC_PAT` (אם רלוונטי),
   `SUPABASE_ACCESS_TOKEN` (טוקן אישי מ- https://supabase.com/dashboard/account/tokens —
   לפריסת ה-Edge Functions).

5. **סכימה + אחסון:** ב-Supabase → SQL Editor, הרץ את כל ה-`migrations/` לפי הסדר
   (`migrations/README.md`): סכימת בסיס → באקטים של אחסון → שדרוגים → הגדרת מנהל ראשון.
   (מיגרציות מוחרגות מהסנכרון האוטומטי — הרצה ידנית בכל מופע.)

6. **Edge Functions — פריסה אוטומטית של *כולן*:**
   אחרי שהוגדרו `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` + `PAPER_NAME` + `PAPER_EMAIL`,
   הרץ Actions → **"Deploy Edge Functions to Supabase"** → Run workflow.
   ה-workflow מושך את *כל* הפונקציות מהתבנית, מחליף בהן את הטוקנים בערכי המופע, ופורס:
   `admin-users`, `alerts-engine`, `green-invoice-doc`, `issue-invoice`, `match-customer`,
   `parse-invoice-text`, `send-clip`, `send-clip-month`, `send-email`, `send-issue`, `ezcount-doc`.
   (מכאן והלאה, כל עדכון בתבנית פורס אוטומטית לכל מופע דרך אותו workflow.)
   `verify_jwt` נקבע מ-`supabase/config.toml` (send-email=false, השאר true).
   **`call-dial` (טלפוניה, Voicenter) לא בתבנית ולא נפרסת — פר-לקוח בלבד.**

7. **סודות Edge Functions לפי הפיצ'רים שהלקוח מפעיל** (Supabase → Edge Functions → Secrets):

   | פיצ'ר | סודות |
   |---|---|
   | שליחת מיילים (גזיר, גזיר-חודשי, התראות) | `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
   | חשבוניות EZcount | `EZCOUNT_API_KEY_PROD`, `EZCOUNT_DEVELOPER_EMAIL` (ו-`ICOUNT_TOKEN` אם בשימוש) |
   | חשבונית ירוקה (עוסק פטור) | `GI_KEY`, `GI_SECRET` |
   | צ'אטבוט חשבוניות (AI) | `ANTHROPIC_API_KEY` |
   | כללי | `SUPABASE_SERVICE_ROLE_KEY` (מוזרק אוטומטית ע"י Supabase) |

   **⚠️ מלכודת Gmail:** ה-App Password חייב להיווצר **מאותו חשבון Google** שמוגדר
   ב-`GMAIL_USER` (השולח) — לא מחשבון אחר — ולהדביק אותו **בלי רווחים** (רווחים = שגיאת 535).
   דורש 2-Step Verification פעיל בחשבון השולח.

8. **הגדרות אפליקציה:** בטבלת `settings` — `paper_name`, ואם מפיקים מסמכים:
   `ezcount_enabled='1'`, `ezcount_mode='production'`, ו-`vat_rate` (`'0'` לעוסק פטור).

9. **Auth:** ב-Authentication → URL Configuration הוסף את כתובת `set-password.html`
   של האתר החדש ל-Redirect URLs, וקבע Site URL.

10. **דחוף** ל-GitHub, **חבר ל-Netlify** (Netlify מריץ `build.sh` שמשרשר `js/*.js` → `app.bundle.js`).

11. **רישום לסנכרון:** הוסף את שם המופע ל-matrix ב-`notify-instances.yml` שבתבנית,
    כדי שעדכוני תבנית עתידיים יגיעו אליו אוטומטית.

## בדיקת בריאות (לפני מסירה ללקוח)

- כל Edge Function עונה ל-OPTIONS ב-200.
- הסודות הנדרשים לפיצ'רים שהופעלו קיימים.
- בדיקת SMTP: לחיצת גזיר אחת → הלוג מראה `235 Accepted` (לא 535), והמייל מגיע.
- הפקת מסמך בדיקה (רק באישור מפורש — פעולה כספית).

## הפקת מסמכים — חשבונית ירוקה (עוסק פטור)

`green-invoice-doc` ממפה: הצעת מחיר→10, חשבון עסקה→300, קבלה→400, זיכוי→330.
לעוסק פטור **לא** שולחים `vatType` — סיווג "עוסק פטור" בחשבון חשבונית ירוקה כבר
מייצר 0% מע"מ. אם העיתון הוא עוסק מורשה, יש להתאים את הפונקציה וה-`vat_rate` בהתאם.

## טוקנים

`PAPER_NAME` · `PAPER_SUB` · `PAPER_PHONE` · `PAPER_EMAIL` ·
`COLOR_BRAND` · `COLOR_DARK` · `COLOR_LIGHT` · `COLOR_GRAD` · `COLOR_ACCENT` · `COLOR_BG` ·
`SUPABASE_URL` · `SUPABASE_KEY`

הטוקנים חלים גם על קוד צד-הלקוח (סנכרון) וגם על ה-Edge Functions (`@@PAPER_NAME@@`,
`@@PAPER_EMAIL@@` בפריסה). לבנייה-מחדש של התבנית מקוד חי: ערוך את ערכי-המקור ב-`tokenize.py`
והרץ `python3 tokenize.py <תיקייה>`.
