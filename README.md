# תבנית מקומון — Newspaper Management System (generic template)

תבנית גנרית וקונפיג-מבוססת להקמת מערכת ניהול מקומון: CRM, תכנון גיליונות,
גבייה, לוח מודעות, ותור גרפיקה — עם הפקת מסמכים אופציונלית מול חשבונית ירוקה.

**להקמת מופע חדש: ראה [`SETUP.md`](SETUP.md).**
בקצרה: מלא `instance.config` → הרץ `python3 setup_instance.py instance.config`
→ הקם סכימה ואחסון לפי `migrations/README.md` → פרוס פונקציות מ-`supabase/functions/`
→ חבר ל-Netlify.

מחסנית: Vanilla JS + Supabase (Postgres/Auth/Storage/Edge Functions). Netlify מריץ
`build.sh` שמשרשר את `js/*.js` ל-`app.bundle.js`.
