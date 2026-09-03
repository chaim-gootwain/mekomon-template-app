// parse-entry — פענוח מלל חופשי בעברית לבוט הזנת הנתונים (Claude)
// פונקציה נפרדת מ-parse-invoice-text בכוונה: הפרסר הכספי נשאר יציב
// ולא נוגעים בו. הפונקציה רק מפענחת — לא כותבת לטבלאות ולא מפיקה דבר.
// MVP: action=new_deal בלבד (עסקת פרסומים על לקוח קיים); כל השאר → unknown.
// הסוד ANTHROPIC_API_KEY נשמר בצד השרת בלבד (משותף עם parse-invoice-text).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
}
const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('ENTRY_PARSE_MODEL') || Deno.env.get('INVOICE_PARSE_MODEL') || 'claude-sonnet-4-5';
const SYSTEM = `אתה מפענח בקשות בעברית של סוכני מכירות במקומון (עיתון מקומי) להזנת נתונים תפעוליים.
המשתמש כותב משפט חופשי, ואתה מחזיר JSON בלבד — בלי שום טקסט נוסף, בלי גדרות קוד.

מבנה הפלט (בדיוק):
{
  "action": "new_deal | unknown",
  "customer_name_raw": "string | null",
  "deal": { "count": number, "start_issue": number, "size_raw": "string | null", "unit_price": number, "price_includes_vat": boolean },
  "confidence": "high | medium | low",
  "missing_fields": ["שמות שדות חסרים קריטיים"]
}
(שדה deal מופיע רק כש-action="new_deal"; אחרת deal=null.)

בשלב זה נתמכת פעולה אחת בלבד:
- action="new_deal": המשתמש סוגר **עסקה/חבילה של כמה פרסומים שפרוסים על גיליונות** — מציין מספר פרסומים, ובדרך כלל גם גיליון-התחלה. סימנים: "עסקה של 5 פרסומים מגיליון 301", "סגרתי עם פסיפס 4 רבעי עמוד מגיליון 12", "חוזה של 6 פרסומים חצי עמוד החל מגיליון 40", "פרסום כל שבוע X פעמים מגיליון Y".
  מלא את "deal": count=מספר הפרסומים, start_issue=מספר הגיליון הראשון (0 אם לא צוין), size_raw=תיאור הגודל אם צוין ("רבע עמוד" / "חצי עמוד" / "עמוד שלם" / "שמינית" / null), unit_price=מחיר לפרסום אחד אם צוין (0 אם לא), price_includes_vat כמפורט למטה.
  missing_fields: הוסף "customer" אם אין שם לקוח, "count" אם אין מספר פרסומים, "start_issue" אם אין גיליון התחלה.
- כל בקשה אחרת (הפקת מסמך, קבלה, חשבונית, תשלום, פתיחת לקוח/ליד, מודעה בודדת, שאלה כללית) → action="unknown" עם deal=null. אל תנסה לדחוס בקשה כזאת ל-new_deal.

כללי הקיצור של המשתמש:
- מע"מ: "+ מע\"מ" אחרי סכום, או "+" צמוד לסוף הסכום (למשל "250+") → המחיר לפני מע"מ → price_includes_vat=false. נאמר "כולל מע\"מ" → price_includes_vat=true. לא צוין כלום → price_includes_vat=false (ההנחה: לפני מע"מ; הכרטיס יציג זאת לאישור).
- כמות: "4 פעמים", "4 פרסומים", "פעמיים" (=2), מספרים במילים ("ארבע") → count.
- מחיר: תומך בעשרוני (662.5), במילים ("חמש מאות" → 500), ובסימני מטבע (₪, ש"ח). unit_price הוא תמיד מחיר לפרסום אחד, מספר בלבד.
- לקוח: בדרך כלל אחרי "ל..." ("לפסיפס" → "פסיפס") או אחרי "עם" ("סגרתי עם גן ורדים"). כשהלמ"ד היא תחילית יחס — הסר אותה; כשהיא חלק מהשם עצמו — השאר. אין שם לקוח → customer_name_raw=null והוסף "customer" ל-missing_fields.
- confidence: high כשהכול חד-משמעי · medium כשמשהו הושלם בהנחה · low כשהמשפט עמום.

דוגמאות:
קלט: עסקה של 4 פרסומים רבע עמוד מגיליון 295 לפסיפס
פלט: {"action":"new_deal","customer_name_raw":"פסיפס","deal":{"count":4,"start_issue":295,"size_raw":"רבע עמוד","unit_price":0,"price_includes_vat":false},"confidence":"high","missing_fields":[]}

קלט: סגרתי עם גן ורדים חבילה של 6 חצאי עמוד מגיליון 12, 400 לפרסום
פלט: {"action":"new_deal","customer_name_raw":"גן ורדים","deal":{"count":6,"start_issue":12,"size_raw":"חצי עמוד","unit_price":400,"price_includes_vat":false},"confidence":"high","missing_fields":[]}

קלט: עסקה של 3 פרסומים שמינית למכולת השכונה 250+ מגיליון 301
פלט: {"action":"new_deal","customer_name_raw":"מכולת השכונה","deal":{"count":3,"start_issue":301,"size_raw":"שמינית","unit_price":250,"price_includes_vat":false},"confidence":"high","missing_fields":[]}

קלט: חוזה של 5 פרסומים לפסיפס
פלט: {"action":"new_deal","customer_name_raw":"פסיפס","deal":{"count":5,"start_issue":0,"size_raw":null,"unit_price":0,"price_includes_vat":false},"confidence":"medium","missing_fields":["start_issue"]}

קלט: תוציא קבלה לגן ורדים על 500
פלט: {"action":"unknown","customer_name_raw":"גן ורדים","deal":null,"confidence":"high","missing_fields":[]}

קלט: תפתח ליד חדש לפיצריית הכיכר
פלט: {"action":"unknown","customer_name_raw":"פיצריית הכיכר","deal":null,"confidence":"high","missing_fields":[]}

החזר JSON בלבד.`;
/* חילוץ JSON גם אם המודל עטף אותו בטקסט/גדרות */
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}
/* אכיפת המבנה וברירות המחדל — לא סומכים על המודל בעיוורון */
const ACTIONS = [
  'new_deal',
  'unknown'
];
function normalizeParsed(p) {
  const action = ACTIONS.includes(p && p.action) ? p.action : 'unknown';
  const out = {
    action,
    customer_name_raw: p && typeof p.customer_name_raw === 'string' && p.customer_name_raw.trim() ? p.customer_name_raw.trim() : null,
    deal: null,
    confidence: [
      'high',
      'medium',
      'low'
    ].includes(p && p.confidence) ? p.confidence : 'low',
    missing_fields: Array.isArray(p && p.missing_fields) ? p.missing_fields.filter((x)=>typeof x === 'string') : []
  };
  const miss = new Set(out.missing_fields);
  if (action === 'new_deal') {
    const d = p && p.deal || {};
    out.deal = {
      count: Number(d.count) > 0 ? Math.floor(Number(d.count)) : 0,
      start_issue: Number(d.start_issue) > 0 ? Math.floor(Number(d.start_issue)) : 0,
      size_raw: typeof d.size_raw === 'string' && d.size_raw.trim() ? d.size_raw.trim() : null,
      unit_price: isFinite(Number(d.unit_price)) && Number(d.unit_price) >= 0 ? Number(d.unit_price) : 0,
      price_includes_vat: !!d.price_includes_vat
    };
    // עסקת רצף: חובה לקוח + כמות + גיליון-התחלה. גודל ומחיר מושלמים בכרטיס
    // (הגודל מהמחירון, המחיר מברירת-המחדל של הגודל אם לא צוין).
    miss.clear();
    if (!out.customer_name_raw) miss.add('customer');
    if (!out.deal.count) miss.add('count');
    if (!out.deal.start_issue) miss.add('start_issue');
  } else {
    miss.clear();
  }
  out.missing_fields = [
    ...miss
  ];
  return out;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json().catch(()=>({}));
    // הרשאה: admin או sales פעיל (כמו parse-invoice-text)
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({
      error: 'לא מזוהה'
    }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || prof.role !== 'admin' && prof.role !== 'sales') return json({
      error: 'אין הרשאה'
    }, 403);
    // בדיקת חיבור בלבד — בלי לשרוף טוקנים על פענוח
    if (body.probe) {
      if (!API_KEY) return json({
        probe: true,
        ok: false,
        error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase'
      });
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        }
      });
      return json({
        probe: true,
        ok: r.ok,
        status: r.status
      });
    }
    const text = String(body.text || '').trim();
    if (!text) return json({
      error: 'לא התקבל מלל'
    }, 400);
    if (text.length > 1000) return json({
      error: 'המלל ארוך מדי (עד 1000 תווים)'
    }, 400);
    if (!API_KEY) return json({
      error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase'
    }, 500);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: text
          }
        ]
      })
    });
    const rText = await r.text();
    if (!r.ok) return json({
      error: 'שגיאת פענוח (' + r.status + ')',
      detail: rText.slice(0, 300)
    }, 502);
    let resp;
    try {
      resp = JSON.parse(rText);
    } catch (_) {
      resp = {};
    }
    const content = resp.content && resp.content[0] && resp.content[0].text || '';
    const raw = extractJson(content);
    if (!raw) return json({
      error: 'הפענוח לא החזיר JSON תקין — נסה לנסח מחדש'
    }, 422);
    const parsed = normalizeParsed(raw);
    return json({
      ok: true,
      parsed
    });
  } catch (e) {
    return json({
      error: e && e.message ? e.message : String(e)
    }, 500);
  }
});
