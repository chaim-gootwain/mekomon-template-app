// submission-created — Netlify מפעיל פונקציה בשם הזה אוטומטית על כל הגשת טופס
// מאומתת (אחרי סינון ספאם), בלי שום הגדרת webhook. הפונקציה לא נוגעת במסד:
// היא רק מעבירה את הגשת טופס המפרסמים (advertiser-lead בדף הנחיתה) אל
// ה-Edge Function הקיימת netlify-lead בסופאבייס, שמכניסה את הליד לטבלת leads
// (כולל הגנה מכפילות לפי טלפון). כך ב-Netlify שמור רק הטוקן המוגבל
// NETLIFY_LEAD_TOKEN — לא מפתח service_role.
// Netlify Forms ממשיך לשמור כל הגשה כרגיל (גיבוי בלוח של Netlify).
// כשל כאן לעולם לא חוסם את הטופס: תמיד מחזירים 200 ורק רושמים ללוג.
// ייחודי למופע עמנואל — לא למיזוג לתבנית.

const FALLBACK_SUPABASE_URL = '@@SUPABASE_URL@@'; // עמנואל (כמו BUILT_IN_URL ב-js/api.js)

exports.handler = async (event) => {
  const ok = (note) => ({ statusCode: 200, body: JSON.stringify({ ok: true, note }) });

  let submission;
  try {
    submission = JSON.parse(event.body || '{}').payload || {};
  } catch (e) {
    console.error('submission-created: bad event body', e.message);
    return ok('bad body');
  }

  // מופעל על כל טופס באתר — מטפלים רק בטופס המפרסמים של דף הנחיתה
  if (submission.form_name !== 'advertiser-lead') {
    console.log('submission-created: skipping form', submission.form_name);
    return ok('skipped form');
  }

  const token = process.env.NETLIFY_LEAD_TOKEN || '';
  if (!token) {
    console.warn('submission-created: NETLIFY_LEAD_TOKEN לא מוגדר ב-Netlify env — הליד לא הועבר למערכת (נשמר רק ב-Netlify Forms)');
    return ok('no token configured');
  }

  const base = (process.env.SUPABASE_URL || FALLBACK_SUPABASE_URL).replace(/\/+$/, '');
  const url = base + '/functions/v1/netlify-lead?token=' + encodeURIComponent(token);

  // netlify-lead מצפה למבנה ה-webhook של Netlify Forms: השדות תחת data
  // (name, business, phone, source, referrer — שדות הטופס בדף הנחיתה)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: submission.data || {} }),
      signal: ac.signal
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('submission-created: netlify-lead החזירה שגיאה', res.status, text);
      return ok('forward failed');
    }
    console.log('submission-created: הליד הועבר למערכת', text);
    return ok('forwarded');
  } catch (e) {
    console.error('submission-created: העברה ל-netlify-lead נכשלה', e.message);
    return ok('forward error');
  } finally {
    clearTimeout(timer);
  }
};
