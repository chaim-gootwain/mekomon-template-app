# הקמת מופע חדש לעיתון — תבנית מקומון

תבנית **גנרית** של מערכת ניהול מקומון (CRM + גיליונות + גבייה + הפקת מסמכים).
כל מה שמשתנה בין עיתון לעיתון — שם, סלוגן, טלפון, אימייל, צבעים, לוגו וחיבור
ל-Supabase — מרוכז ב-`@@TOKEN@@` ומוזרק ע"י סקריפט אחד מקובץ קונפיג.

## שלבים

1. **צור repo חדש** מהתבנית ("Use this template" → Create a new repository).
2. **צור פרויקט Supabase** לעיתון החדש. העתק את **Project URL** ואת ה-**publishable/anon key**.
3. **קונפיג:** העתק את `instance.config.example` ל-`instance.config` ומלא ערכים (כולל נתיב ל-PNG של הלוגו).
4. **הרץ:** `python3 setup_instance.py instance.config`
   ממלא את כל הטוקנים, מתקין את הלוגו ויוצר אייקונים (דורש `pip install pillow`).
5. **סכימה + אחסון:** ב-Supabase → SQL Editor, לפי `migrations/README.md`
   (סכימת בסיס → באקטים של אחסון → שדרוגים → הגדרת מנהל ראשון).
6. **Edge Functions:** פרוס מ-`supabase/functions/`:
   - `admin-users` — הזמנת/מחיקת משתמשים (חובה).
   - `green-invoice-doc` — הפקת מסמכים מול חשבונית ירוקה (רק אם העיתון מפיק מסמכים;
     דורש secrets `GI_KEY` + `GI_SECRET`).
7. **הגדרות אפליקציה:** בטבלת `settings` — `paper_name`, ואם מפיקים מסמכים:
   `ezcount_enabled='1'`, `ezcount_mode='production'`, ו-`vat_rate` (`'0'` לעוסק פטור).
8. **Auth:** ב-Authentication → URL Configuration הוסף את כתובת `set-password.html`
   של האתר החדש ל-Redirect URLs, וקבע Site URL.
9. **דחוף** ל-GitHub, **חבר ל-Netlify** (Netlify מריץ `build.sh` שמשרשר `js/*.js` → `app.bundle.js`).

## הפקת מסמכים — חשבונית ירוקה (עוסק פטור)

`green-invoice-doc` ממפה: הצעת מחיר→10, חשבון עסקה→300, קבלה→400, זיכוי→330.
לעוסק פטור **לא** שולחים `vatType` — סיווג "עוסק פטור" בחשבון חשבונית ירוקה כבר
מייצר 0% מע"מ. אם העיתון הוא עוסק מורשה, יש להתאים את הפונקציה וה-`vat_rate` בהתאם.

## טוקנים

`PAPER_NAME` · `PAPER_SUB` · `PAPER_PHONE` · `PAPER_EMAIL` ·
`COLOR_BRAND` · `COLOR_DARK` · `COLOR_LIGHT` · `COLOR_GRAD` · `COLOR_BG` ·
`SUPABASE_URL` · `SUPABASE_KEY`

לבנייה-מחדש של התבנית מקוד חי מעודכן: ערוך את ערכי-המקור ב-`tokenize.py` והרץ `python3 tokenize.py <תיקייה>`.
