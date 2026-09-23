// manager-agent — סוכן המקומון (שלב א'): לולאת כלים של Claude על נתוני המערכת
// ------------------------------------------------------------
// בניגוד ל-parse-invoice-text (פענוח חד-פעמי), כאן רצה שיחה אמיתית:
// Claude מקבל את התמליל + ארגז כלים, ומחליט בעצמו — לשלוף נתונים,
// לשאול שאלה, או להציע פעולה כספית.
// - כלי קריאה (search_customers, get_customer_status, ...) רצים כאן,
//   עם ה-JWT של הפונה — RLS אוכף שהסוכן רואה בדיוק מה שהמשתמש רואה.
// - כלי פעולה (propose_*) לעולם לא מבוצעים בשרת: הלולאה נעצרת,
//   ההצעה חוזרת לדפדפן, ושם נפתח כרטיס האישור הקיים של צ'אט
//   החשבוניות. שום מסמך כספי לא מופק בלי אישור מפורש של המשתמש.
// - הרשאה: admin פעיל בלבד (לסוכני מכירות יש את בוט הזנת הנתונים).
// סודות: ANTHROPIC_API_KEY (קיים מצ'אט החשבוניות); אופציונלי
// MANAGER_AGENT_MODEL (ברירת מחדל claude-opus-5).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('MANAGER_AGENT_MODEL') || 'claude-opus-5';
const MAX_TURNS = 8;          // תקרת סבבי כלים לפנייה אחת
const MAX_MESSAGES = 60;      // תקרת אורך תמליל שנשלח מהדפדפן
const MAX_BODY_CHARS = 400000;

/* ==================== פרומפט המערכת ====================
   בלוק יציב (עם cache_control) + בלוק דינמי קטן (תאריך/מע"מ) —
   כך התמליל ההולך וגדל נהנה ממטמון הפרומפט בין פניות. */
const SYSTEM_STABLE = `אתה "סוכן המקומון" — העוזר האישי של מנהל מקומון (עיתון מקומי) בתוך מערכת הניהול שלו.
המנהל כותב לך בעברית חופשית, ואתה עוזר לו בשני דברים:
1. תשובות על נתונים — חובות, לקוחות, פרסומים, גיליונות, חיובים — דרך כלי הקריאה.
2. פעולות כספיות — הפקת מסמכים, רישום תשלום, פתיחת עסקה — דרך כלי propose_* בלבד.

חוקי ברזל:
- אתה לעולם לא מפיק מסמך ולא כותב שום דבר למערכת. כלי propose_* רק פותחים כרטיס תצוגה מקדימה שהמנהל רואה, עורך ומאשר. תוצאת האישור/הביטול תגיע אליך כ-tool_result.
- לעולם אל תמציא נתונים. כל מספר שאתה מציג חייב להגיע מכלי. אם אין לך נתון — אמור זאת.
- זיהוי לקוח: לפני כל propose_* חובה לקרוא ל-search_customers. התאמה יחידה ברורה — המשך. כמה מועמדים דומים — הצג אותם ושאל למי הכוונה. לא נמצא — שאל את המנהל; ב-propose_issue_document מותר להמשיך עם שם חופשי (בלי customer_id) רק אחרי שהמנהל אישר שזה לקוח חדש/חד-פעמי. propose_pay_existing ו-propose_new_deal מחייבים customer_id של לקוח קיים.
- אל תנחש. כשמשהו חסר או דו-משמעי (סוג מסמך, מחיר, אמצעי תשלום לקבלה) — שאל שאלה אחת קצרה וממוקדת.

מוסכמות הניסוח של המנהל:
- סוגי מסמכים: "ח. מס" / "חשבונית מס" → tax_invoice · "מס קבלה" → tax_invoice_receipt · "קבלה" → receipt · "זיכוי" → credit_invoice · "עסקה" / "חשבון עסקה" → proforma.
- מע"מ: "+" צמוד לסכום ("250+") או "+ מע\"מ" → המחיר לפני מע"מ (price_includes_vat=false). "כולל מע\"מ" → true. לא צוין → false (לפני מע"מ; הכרטיס מציג זאת לאישור).
- אמצעי תשלום: אשראי → credit · מזומן → cash · העברה → transfer · צ'ק/שיק → check. קבלה ומס-קבלה מחייבות אמצעי תשלום.
- כמויות ומחירים גם במילים ("פעמיים"=2, "חמש מאות"=500).
- "לקוח שילם" בלי סכום חדש → propose_pay_existing (הסכום יילקח מחשבון העסקה הפתוח שלו במערכת). אם ננקב סכום מפורש להפקה — זו הפקה רגילה (propose_issue_document).
- "גזירים" = תמונות המודעות כפי שפורסמו בעיתון. כשמבקשים גזירים — search_customers ואז show_customer_clips (הוא מציג למנהל את הטבלה וכפתור הורדה; אל תשתמש ב-get_customer_publications בשביל גזירים).
- שליחת גזירים במייל ללקוח → propose_send_clips עם מספרי הגיליונות. אם המנהל לא ציין גיליונות — בדוק ב-get_customer_publications אילו גיליונות רלוונטיים (למשל האחרון שפורסם) והצע. המייל נשלח לכתובת שבכרטיס הלקוח, והמנהל מאשר בכרטיס לפני שליחה.
- "צרף לי את החשבונית" / "תראה לי את המסמך" → get_customer_documents, ותן את הקישור בפורמט markdown: [חשבונית מס 10009 — PDF](pdf_url). הקישור נפתח בלחיצה אצל המנהל. מסמך בלי pdf_url — אמור שהקובץ לא זמין במערכת (הופק מחוץ למסלול הרגיל).
- תזכורות חוב: "מי חייב" / "שלח תזכורות למי שחייב מעל X" → get_debtors, הצג את הרשימה, ואז propose_debt_reminders עם הלקוחות שנבחרו וערוץ (whatsapp או email — שאל אם לא צוין). וואטסאפ נפתח לשליחה ידנית אצל המנהל; מייל נשלח מהמערכת. שום תזכורת לא יוצאת בלי אישור בכרטיס.
- משימות: "תזכיר לי ל..." / "מה המשימות שלי" → get_customer_tasks לקריאה, propose_add_task להוספה (משימה יושבת על כרטיס לקוח — חובה customer_id). תאריכים יחסיים ("יום חמישי", "עוד שבוע") — חשב לתאריך לפי התאריך של היום.
- עסקה/חבילה של כמה פרסומים עם גיליון התחלה או רצף גיליונות → propose_new_deal. אם כל הפרסומים באותו גיליון אחד ("8 עמודים בגיליון 305") → propose_new_deal עם same_issue=true ו-start_issue=אותו גיליון.
- תיאור שורה (description): השירות בלבד, בלי שם הלקוח ובלי הסכום. אין תיאור → "פרסום".

סגנון: ענה בעברית, קצר ולעניין. סכומים בש"ח עם שני ספרות עשרוניות לכל היותר. כשאתה מציג רשימות — שורות קצרות, לא טבלאות ענק. אחרי שהמנהל אישר כרטיס (tool_result עם "אושר") — אשר בקצרה והמשך אם נשארו שלבים; אחרי ביטול — קבל את זה בלי להתווכח.
הצעות המשך: כשיש המשך טבעי ומועיל, סיים את התשובה בשורה נפרדת אחרונה בפורמט המדויק: הצעות: אפשרות א | אפשרות ב (עד 3, קצרות, כל אחת ניסוח שאפשר לשלוח כמו-שהוא). בלי המשך מתבקש — אל תוסיף את השורה.
בקשות מורכבות מותרות ומעודדות: "תבדוק כמה פסיפס חייב ותוציא לו מס-קבלה" = קודם search_customers + get_customer_status, הצג את המצב, ואז propose_pay_existing.`;

/* ==================== הגדרות הכלים ==================== */
const TOOLS = [
  {
    name: 'search_customers',
    description: 'חיפוש לקוח לפי שם (סובלני לתחיליות "ל/ה", כתיב חסר/מלא וסדר מילים). מחזיר עד 10 מועמדים: id, name, business_id. חובה לפני כל propose_*.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'שם הלקוח כפי שהמנהל כתב אותו' } },
      required: ['query']
    }
  },
  {
    name: 'get_customer_status',
    description: 'מצב כספי של לקוח קיים: חובות פתוחים (עם יתרות), חוזים פעילים וניצולם, וחשבונות עסקה פתוחים (שטרם שולמו).',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'number', description: 'מזהה הלקוח מ-search_customers' } },
      required: ['customer_id']
    }
  },
  {
    name: 'get_customer_publications',
    description: 'הפרסומים (מודעות) של לקוח: גיליון, גודל, מחיר, סטטוס חיוב. אופציונלי: טווח גיליונות.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number' },
        issue_from: { type: 'number', description: 'מספר גיליון התחלה (אופציונלי)' },
        issue_to: { type: 'number', description: 'מספר גיליון סיום (אופציונלי)' }
      },
      required: ['customer_id']
    }
  },
  {
    name: 'list_issues',
    description: 'הגיליונות האחרונים: מספר, תאריך פרסום, תאריך הדפסה, סטטוס.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'כמה גיליונות (ברירת מחדל 12, עד 30)' } },
      required: []
    }
  },
  {
    name: 'get_unbilled_ads',
    description: 'מודעות מתומחרות שעדיין לא חויבו (ולא שולמו), מקובצות לפי לקוח — "מי עוד לא חויב". אופציונלי: גיליון מסוים.',
    input_schema: {
      type: 'object',
      properties: { issue_number: { type: 'number', description: 'מספר גיליון (אופציונלי — בלעדיו: כל הפתוחות)' } },
      required: []
    }
  },
  {
    name: 'get_debtors',
    description: 'רשימת הלקוחות עם חוב פתוח (חיובים פתוחים פחות תשלומים), ממוינת מהגדול לקטן: סכום, מספר חיובים, החוב הוותיק ביותר, והאם יש טלפון/מייל בכרטיס. השתמש ל"מי חייב", "גיול חובות", ולפני propose_debt_reminders.',
    input_schema: {
      type: 'object',
      properties: {
        min_balance: { type: 'number', description: 'סינון: רק חוב מעל סכום זה (אופציונלי)' },
        limit: { type: 'number', description: 'כמה לקוחות (ברירת מחדל 20, עד 50)' }
      },
      required: []
    }
  },
  {
    name: 'get_customer_tasks',
    description: 'משימות פתוחות: של לקוח מסוים (customer_id), או כולן (בלי פרמטר) — כולל שם הלקוח ותאריך יעד. "מה המשימות שלי" = בלי פרמטרים.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'סינון ללקוח מסוים (אופציונלי)' }
      },
      required: []
    }
  },
  {
    name: 'get_customer_documents',
    description: 'המסמכים הכספיים של לקוח (חשבוניות מס, מס-קבלות, קבלות, חשבונות עסקה, זיכויים) כולל קישור PDF לכל מסמך. השתמש כשמבקשים לצרף/לראות/למצוא מסמך.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'מזהה הלקוח מ-search_customers' },
        doc_kind: { type: 'string', enum: ['tax_invoice', 'invoice_receipt', 'receipt', 'proforma', 'credit'], description: 'סינון לסוג מסמך (אופציונלי)' },
        limit: { type: 'number', description: 'כמה מסמכים אחרונים (ברירת מחדל 10, עד 30)' }
      },
      required: ['customer_id']
    }
  },
  {
    name: 'show_customer_clips',
    description: 'הצגת הפרסומים והגזירים (תמונות המודעות שפורסמו) של לקוח קיים למנהל, כולל כפתור הורדת ZIP. ההצגה נעשית בדפדפן — אתה תקבל בחזרה סיכום כמה מודעות וגזירים הוצגו. אופציונלי: טווח גיליונות.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'מזהה הלקוח מ-search_customers' },
        customer_name: { type: 'string', description: 'שם הלקוח להצגה' },
        issue_from: { type: 'number', description: 'מספר גיליון התחלה (אופציונלי)' },
        issue_to: { type: 'number', description: 'מספר גיליון סיום (אופציונלי)' }
      },
      required: ['customer_id', 'customer_name']
    }
  },
  {
    name: 'propose_debt_reminders',
    description: 'הצעת שליחת תזכורות חוב ללקוחות חייבים: פותח כרטיס עם הרשימה והיתרות המעודכנות, והמנהל שולח משם (וואטסאפ נפתח לשליחה ידנית; מייל נשלח מהמערכת). שום תזכורת לא יוצאת בלי הכרטיס. השתמש אחרי get_debtors.',
    input_schema: {
      type: 'object',
      properties: {
        customers: {
          type: 'array', maxItems: 30,
          items: {
            type: 'object',
            properties: {
              customer_id: { type: 'number' },
              customer_name: { type: 'string' }
            },
            required: ['customer_id', 'customer_name']
          },
          description: 'הלקוחות לתזכורת (מ-get_debtors)'
        },
        channel: { type: 'string', enum: ['whatsapp', 'email'], description: 'ערוץ השליחה' }
      },
      required: ['customers', 'channel']
    }
  },
  {
    name: 'propose_add_task',
    description: 'הצעת הוספת משימה/תזכורת על כרטיס לקוח (למשל "להתקשר לגן ורדים ביום חמישי"). פותח כרטיס אישור קטן; המשימה מופיעה בכרטיס הלקוח ובתזכורות של המערכת.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'מזהה הלקוח מ-search_customers' },
        customer_name: { type: 'string', description: 'שם הלקוח להצגה' },
        title: { type: 'string', description: 'נוסח המשימה, קצר וברור' },
        due_date: { type: 'string', description: 'תאריך יעד YYYY-MM-DD (אופציונלי)' }
      },
      required: ['customer_id', 'customer_name', 'title']
    }
  },
  {
    name: 'propose_send_clips',
    description: 'הצעת שליחת גזירים במייל ללקוח: עמודי המודעות של הלקוח נחתכים מ-PDF של כל גיליון ונשלחים לכתובת המייל שבכרטיס הלקוח. פותח כרטיס אישור — שום מייל לא נשלח בלי אישור המנהל. מחייב לקוח קיים ומספרי גיליונות.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'מזהה הלקוח מ-search_customers' },
        customer_name: { type: 'string', description: 'שם הלקוח להצגה' },
        issue_numbers: { type: 'array', items: { type: 'number' }, description: 'מספרי הגיליונות שמהם לשלוח את הגזירים (עד 12)' }
      },
      required: ['customer_id', 'customer_name', 'issue_numbers']
    }
  },
  {
    name: 'propose_issue_document',
    description: 'הצעת הפקת מסמך (חשבונית מס / מס-קבלה / קבלה / זיכוי / חשבון עסקה). פותח למנהל כרטיס תצוגה מקדימה לעריכה ואישור — לא מפיק כלום בעצמו.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'מזהה לקוח קיים; השמט רק ללקוח חד-פעמי בשם חופשי' },
        customer_name: { type: 'string', description: 'שם הלקוח להצגה' },
        doc_type: { type: 'string', enum: ['tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma'] },
        line_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              price_includes_vat: { type: 'boolean' }
            },
            required: ['description', 'quantity', 'unit_price', 'price_includes_vat']
          }
        },
        payment_method: { type: 'string', enum: ['credit', 'cash', 'transfer', 'check'], description: 'חובה לקבלה/מס-קבלה אם ידוע; אחרת השמט' }
      },
      required: ['customer_name', 'doc_type', 'line_items']
    }
  },
  {
    name: 'propose_pay_existing',
    description: 'הצעת רישום תשלום על חשבון עסקה פתוח: מס-קבלה מקושרת שסוגרת אותו. הסכום נלקח מהעסקה הפתוחה במערכת. מחייב לקוח קיים.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number' },
        customer_name: { type: 'string' },
        payment_method: { type: 'string', enum: ['credit', 'cash', 'transfer', 'check'], description: 'אם המנהל ציין; אחרת השמט' }
      },
      required: ['customer_id', 'customer_name']
    }
  },
  {
    name: 'propose_new_deal',
    description: 'הצעת עסקת פרסומים ברצף: חוזה + מודעות פר גיליון + חשבון עסקה. מחייב לקוח קיים, מספר פרסומים וגיליון התחלה.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number' },
        customer_name: { type: 'string' },
        count: { type: 'number', description: 'מספר הפרסומים' },
        start_issue: { type: 'number', description: 'מספר הגיליון הראשון' },
        size_raw: { type: 'string', description: 'תיאור הגודל אם צוין ("רבע עמוד") — יותאם למחירון בכרטיס' },
        unit_price: { type: 'number', description: 'מחיר לפרסום אם צוין; 0 אם לא' },
        price_includes_vat: { type: 'boolean' },
        same_issue: { type: 'boolean', description: 'true = כל הפרסומים באותו גיליון אחד (start_issue); false/השמט = פרוסים ברצף, גיליון אחרי גיליון' }
      },
      required: ['customer_id', 'customer_name', 'count', 'start_issue']
    }
  }
];

/* ==================== חיפוש לקוח (fuzzy קליל) ==================== */
function norm(s) {
  return String(s || '').replace(/["'`״׳]/g, '').replace(/[-–—ـ]/g, ' ')
    .replace(/[^֐-׿a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function foldFinals(s) {
  return s.replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ץ/g, 'צ').replace(/ף/g, 'פ').replace(/ך/g, 'כ');
}
function queryVariants(raw) {
  const base = foldFinals(norm(raw));
  const out = new Set([base]);
  const m = base.match(/^([להב])(.{2,})$/); // תחילית יחס: "לגן ורדים" → גם "גן ורדים"
  if (m) out.add(m[2].trim());
  return [...out].filter(Boolean);
}
function scoreName(variants, custName) {
  const c = foldFinals(norm(custName));
  if (!c) return 0;
  const cWords = c.split(' ');
  let best = 0;
  for (const v of variants) {
    if (!v) continue;
    if (c === v) return 100;
    let s = 0;
    if (c.includes(v) || v.includes(c)) s = 80;
    else {
      const vWords = v.split(' ');
      const hit = vWords.filter(w => cWords.some(cw => cw === w || cw.startsWith(w) || w.startsWith(cw))).length;
      if (hit) s = 40 + Math.round(40 * hit / Math.max(vWords.length, cWords.length));
    }
    if (s > best) best = s;
  }
  return best;
}

/* ==================== ביצוע כלי קריאה (RLS של הפונה) ==================== */
async function runReadTool(caller, name, input) {
  if (name === 'search_customers') {
    const q = String(input && input.query || '').trim();
    if (!q) return { error: 'חסר שם לחיפוש' };
    const { data, error } = await caller.from('customers').select('id,name,business_id').limit(2000);
    if (error) return { error: error.message };
    const variants = queryVariants(q);
    const scored = (data || [])
      .map(c => ({ id: c.id, name: c.name, business_id: c.business_id || null, score: scoreName(variants, c.name) }))
      .filter(c => c.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return { candidates: scored, note: scored.length ? undefined : 'לא נמצא לקוח דומה — אפשר לנסות ניסוח אחר או לשאול את המנהל' };
  }

  if (name === 'get_customer_status') {
    const cid = Number(input && input.customer_id);
    if (!cid) return { error: 'חסר customer_id' };
    const { data: charges, error: e1 } = await caller.from('charges')
      .select('id,amount,description,status,due_date')
      .eq('customer_id', cid).in('status', ['pending', 'invoiced', 'partial', 'overdue']);
    if (e1) return { error: e1.message };
    const ids = (charges || []).map(c => c.id);
    let paysByCharge = {};
    if (ids.length) {
      const { data: pays } = await caller.from('payments').select('charge_id,amount').in('charge_id', ids);
      (pays || []).forEach(p => { paysByCharge[p.charge_id] = (paysByCharge[p.charge_id] || 0) + Number(p.amount); });
    }
    let debtTotal = 0;
    const openCharges = (charges || []).map(c => {
      const bal = Math.round((Number(c.amount) - (paysByCharge[c.id] || 0)) * 100) / 100;
      return { description: c.description || 'חיוב', balance: bal, status: c.status, due_date: c.due_date || null };
    }).filter(c => c.balance > 0.001);
    openCharges.forEach(c => debtTotal += c.balance);
    debtTotal = Math.round(debtTotal * 100) / 100;

    const { data: contracts } = await caller.from('contracts')
      .select('id,price_item_id,total_inserts,used_offset,total_price')
      .eq('customer_id', cid).eq('active', true);
    const conIds = (contracts || []).map(c => c.id);
    const usedByCon = {};
    if (conIds.length) {
      const { data: conAds } = await caller.from('ads').select('id,contract_id')
        .in('contract_id', conIds).not('status', 'in', '("cancelled","rejected")');
      (conAds || []).forEach(a => { usedByCon[a.contract_id] = (usedByCon[a.contract_id] || 0) + 1; });
    }
    const { data: priceList } = await caller.from('price_list').select('id,name');
    const priceName = {};
    (priceList || []).forEach(p => priceName[p.id] = p.name);
    const activeContracts = (contracts || []).map(c => ({
      id: c.id,
      size: priceName[c.price_item_id] || 'חבילה',
      used: (usedByCon[c.id] || 0) + (Number(c.used_offset) || 0),
      total_inserts: c.total_inserts || 0,
      total_price: c.total_price || null
    }));

    // select('*') בכוונה — העמודה settled_at אולי לא קיימת בכל מופע (כמו בצ'אט החשבוניות)
    const { data: profs } = await caller.from('documents')
      .select('*')
      .eq('customer_id', cid).eq('doc_kind', 'proforma').eq('status', 'issued')
      .order('created_at', { ascending: false }).limit(20);
    const openProformas = (profs || []).filter(d => !d.settled_at)
      .map(d => ({ doc_number: d.doc_number, total: d.total, created_at: (d.created_at || '').slice(0, 10) }));

    return { debt_total: debtTotal, open_charges: openCharges.slice(0, 15), active_contracts: activeContracts, open_proformas: openProformas };
  }

  if (name === 'get_debtors') {
    const { data: charges, error } = await caller.from('charges')
      .select('id,customer_id,amount,due_date')
      .in('status', ['pending', 'invoiced', 'partial', 'overdue']).limit(2000);
    if (error) return { error: error.message };
    // תשלומים — בנתחים, כדי לא לחרוג מאורך ה-URL של PostgREST
    const paid = {};
    const ids = (charges || []).map(c => c.id);
    for (let i = 0; i < ids.length; i += 150) {
      const { data: pays } = await caller.from('payments').select('charge_id,amount').in('charge_id', ids.slice(i, i + 150));
      (pays || []).forEach(p => { paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount); });
    }
    const byCust = {};
    (charges || []).forEach(c => {
      const bal = Number(c.amount) - (paid[c.id] || 0);
      if (bal <= 0.001 || !c.customer_id) return;
      if (!byCust[c.customer_id]) byCust[c.customer_id] = { customer_id: c.customer_id, total: 0, open_charges: 0, oldest_due: null };
      const r = byCust[c.customer_id];
      r.total += bal;
      r.open_charges += 1;
      if (c.due_date && (!r.oldest_due || c.due_date < r.oldest_due)) r.oldest_due = c.due_date;
    });
    const custIds = Object.keys(byCust).map(Number);
    const info = {};
    for (let i = 0; i < custIds.length; i += 150) {
      const { data: custs } = await caller.from('customers').select('id,name,phone,whatsapp,email').in('id', custIds.slice(i, i + 150));
      (custs || []).forEach(c => info[c.id] = c);
    }
    const minBal = Number(input && input.min_balance) || 0;
    const lim = Math.min(50, Math.max(1, Number(input && input.limit) || 20));
    const rows = Object.values(byCust)
      .map(r => ({
        customer_id: r.customer_id,
        customer: (info[r.customer_id] && info[r.customer_id].name) || 'לא ידוע',
        total: Math.round(r.total * 100) / 100,
        open_charges: r.open_charges,
        oldest_due: r.oldest_due,
        has_phone: !!(info[r.customer_id] && (info[r.customer_id].whatsapp || info[r.customer_id].phone)),
        has_email: !!(info[r.customer_id] && String(info[r.customer_id].email || '').trim())
      }))
      .filter(r => r.total >= minBal)
      .sort((a, b) => b.total - a.total)
      .slice(0, lim);
    return { debtors: rows, note: 'has_phone/has_email — האם אפשר לשלוח תזכורת בוואטסאפ/מייל' };
  }

  if (name === 'get_customer_tasks') {
    let q = caller.from('customer_tasks').select('id,customer_id,title,due_date,created_at')
      .eq('done', false).order('due_date', { ascending: true, nullsFirst: false }).limit(30);
    const cid = Number(input && input.customer_id) || 0;
    if (cid) q = q.eq('customer_id', cid);
    const { data, error } = await q;
    if (error) {
      // הטבלה אולי לא קיימת במופע (המיגרציה טרם רצה)
      if (/customer_tasks/.test(String(error.message))) return { error: 'טבלת המשימות עדיין לא הופעלה במופע הזה' };
      return { error: error.message };
    }
    const tIds = [...new Set((data || []).map(t => t.customer_id).filter(Boolean))];
    const names = {};
    if (tIds.length) {
      const { data: custs } = await caller.from('customers').select('id,name').in('id', tIds);
      (custs || []).forEach(c => names[c.id] = c.name);
    }
    return {
      tasks: (data || []).map(t => ({
        customer_id: t.customer_id, customer: names[t.customer_id] || null,
        title: t.title, due_date: t.due_date
      }))
    };
  }

  if (name === 'get_customer_documents') {
    const cid = Number(input && input.customer_id);
    if (!cid) return { error: 'חסר customer_id' };
    const lim = Math.min(30, Math.max(1, Number(input && input.limit) || 10));
    // select('*') בכוונה — עמודות אופציונליות (settled_at) אולי לא קיימות בכל מופע
    let q = caller.from('documents').select('*').eq('customer_id', cid)
      .order('created_at', { ascending: false }).limit(lim);
    const kind = String(input && input.doc_kind || '');
    if (['tax_invoice', 'invoice_receipt', 'receipt', 'proforma', 'credit'].includes(kind)) q = q.eq('doc_kind', kind);
    const { data, error } = await q;
    if (error) return { error: error.message };
    const docs = (data || []).map(d => ({
      doc_number: d.doc_number || null,
      doc_kind: d.doc_kind,
      total: d.total,
      status: d.status,
      date: (d.created_at || '').slice(0, 10),
      settled: !!d.settled_at,
      pdf_url: d.pdf_url || null
    }));
    return { documents: docs, note: 'doc_kind: tax_invoice=חשבונית מס, invoice_receipt=מס-קבלה, receipt=קבלה, proforma=חשבון עסקה, credit=זיכוי. תן קישורי PDF בפורמט markdown.' };
  }

  if (name === 'get_customer_publications') {
    const cid = Number(input && input.customer_id);
    if (!cid) return { error: 'חסר customer_id' };
    const { data: ads, error } = await caller.from('ads')
      .select('issue_id,price,discount,status,deal_stage,price_item_id,page_number')
      .eq('customer_id', cid).not('status', 'in', '("cancelled","rejected")').limit(300);
    if (error) return { error: error.message };
    const issueIds = [...new Set((ads || []).map(a => a.issue_id).filter(Boolean))];
    const issueNum = {};
    if (issueIds.length) {
      const { data: issues } = await caller.from('issues').select('id,issue_number,publish_date').in('id', issueIds);
      (issues || []).forEach(i => issueNum[i.id] = { n: i.issue_number, d: (i.publish_date || '').slice(0, 10) });
    }
    const { data: priceList } = await caller.from('price_list').select('id,name');
    const priceName = {};
    (priceList || []).forEach(p => priceName[p.id] = p.name);
    const from = Number(input && input.issue_from) || 0;
    const to = Number(input && input.issue_to) || Infinity;
    const rows = (ads || [])
      .map(a => ({
        issue: issueNum[a.issue_id] ? issueNum[a.issue_id].n : null,
        date: issueNum[a.issue_id] ? issueNum[a.issue_id].d : null,
        size: priceName[a.price_item_id] || null,
        price: a.price, discount: a.discount || 0,
        status: a.status, deal_stage: a.deal_stage || null, page: a.page_number || null
      }))
      .filter(r => r.issue == null || (r.issue >= from && r.issue <= to))
      .sort((a, b) => (b.issue || 0) - (a.issue || 0))
      .slice(0, 60);
    return { publications: rows, note: 'deal_stage: invoiced=חויב, paid=שולם, אחר/ריק=טרם חויב' };
  }

  if (name === 'list_issues') {
    const lim = Math.min(30, Math.max(1, Number(input && input.limit) || 12));
    const { data, error } = await caller.from('issues')
      .select('issue_number,publish_date,print_date,status')
      .order('issue_number', { ascending: false }).limit(lim);
    if (error) return { error: error.message };
    return { issues: data || [] };
  }

  if (name === 'get_unbilled_ads') {
    let q = caller.from('ads')
      .select('customer_id,issue_id,price,discount,deal_stage')
      .gt('price', 0).not('issue_id', 'is', null)
      .not('status', 'in', '("cancelled","rejected")').limit(500);
    const wantIssue = Number(input && input.issue_number) || 0;
    if (wantIssue) {
      const { data: iss } = await caller.from('issues').select('id').eq('issue_number', wantIssue).limit(1);
      if (!iss || !iss.length) return { error: 'גיליון ' + wantIssue + ' לא נמצא' };
      q = q.eq('issue_id', iss[0].id);
    }
    const { data: ads, error } = await q;
    if (error) return { error: error.message };
    const open = (ads || []).filter(a => !['invoiced', 'paid'].includes(a.deal_stage || ''));
    const custIds = [...new Set(open.map(a => a.customer_id).filter(Boolean))];
    const custName = {};
    if (custIds.length) {
      const { data: custs } = await caller.from('customers').select('id,name').in('id', custIds);
      (custs || []).forEach(c => custName[c.id] = c.name);
    }
    const issueIds = [...new Set(open.map(a => a.issue_id).filter(Boolean))];
    const issueNum = {};
    if (issueIds.length) {
      const { data: issues } = await caller.from('issues').select('id,issue_number').in('id', issueIds);
      (issues || []).forEach(i => issueNum[i.id] = i.issue_number);
    }
    const byCust = {};
    open.forEach(a => {
      const k = a.customer_id || 0;
      if (!byCust[k]) byCust[k] = { customer_id: a.customer_id, customer: custName[k] || 'לא ידוע', total: 0, ads: 0, issues: new Set() };
      byCust[k].total += Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
      byCust[k].ads += 1;
      if (issueNum[a.issue_id] != null) byCust[k].issues.add(issueNum[a.issue_id]);
    });
    const rows = Object.values(byCust)
      .map(r => ({ customer_id: r.customer_id, customer: r.customer, total_before_vat: Math.round(r.total * 100) / 100, ads: r.ads, issues: [...r.issues].sort((a, b) => a - b) }))
      .sort((a, b) => b.total_before_vat - a.total_before_vat)
      .slice(0, 40);
    return { unbilled: rows, note: 'הסכומים לפני מע"מ ואחרי הנחה קבועה של הלקוח' };
  }

  return { error: 'כלי לא מוכר: ' + name };
}

/* ==================== ניקוי תמליל שמגיע מהדפדפן ==================== */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  let msgs = raw.filter(m => m && (m.role === 'user' || m.role === 'assistant') &&
    (typeof m.content === 'string' || Array.isArray(m.content)));
  // גזירה מהתחלה עד להודעת משתמש שאינה tool_result (שלא נקטע זוג tool_use/result)
  const isPlainUser = m => m.role === 'user' &&
    (typeof m.content === 'string' || !m.content.some(b => b && b.type === 'tool_result'));
  while (msgs.length > MAX_MESSAGES || (msgs.length && !isPlainUser(msgs[0]))) {
    msgs.shift();
    if (!msgs.length) break;
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}

/* ==================== קריאה ל-Claude ==================== */
async function callClaude(systemBlocks, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: systemBlocks,
      tools: TOOLS,
      // כלי אחד לכל סבב — מפשט את פרוטוקול ההצעות מול הדפדפן
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages
    })
  });
  const text = await r.text();
  if (!r.ok) return { err: 'שגיאת מודל (' + r.status + '): ' + text.slice(0, 300) };
  try { return { resp: JSON.parse(text) }; } catch (_) { return { err: 'תשובת מודל לא תקינה' }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    const bodyText = await req.text();
    if (bodyText.length > MAX_BODY_CHARS) return json({ error: 'השיחה ארוכה מדי — פתח שיחה חדשה' }, 400);
    let body = {};
    try { body = JSON.parse(bodyText || '{}'); } catch (_) { }

    // הרשאה: admin פעיל בלבד
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || prof.role !== 'admin') return json({ error: 'אין הרשאה — סוכן המקומון פתוח למנהל בלבד' }, 403);

    // בדיקת חיבור בלבד
    if (body.probe) {
      if (!API_KEY) return json({ probe: true, ok: false, error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase' });
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
      });
      return json({ probe: true, ok: r.ok, status: r.status, model: MODEL });
    }

    if (!API_KEY) return json({ error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase' }, 500);
    const messages = sanitizeMessages(body.messages);
    if (!messages) return json({ error: 'תמליל לא תקין — פתח שיחה חדשה' }, 400);

    // בלוק דינמי: תאריך + מע"מ + הוראות קבועות של המנהל מההגדרות
    // (יציב בתוך היום — לא שובר את מטמון הבלוק הקבוע)
    let vat = '18', notes = '';
    try {
      const { data: st } = await caller.from('settings').select('key,value').in('key', ['vat_rate', 'manager_agent_notes']);
      (st || []).forEach(s => {
        if (s.key === 'vat_rate' && s.value) vat = String(s.value);
        if (s.key === 'manager_agent_notes') notes = String(s.value || '').slice(0, 2000);
      });
    } catch (_) { }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
    const systemBlocks = [
      { type: 'text', text: SYSTEM_STABLE, cache_control: { type: 'ephemeral' } },
      {
        type: 'text', text: 'התאריך היום: ' + today + '. שיעור המע"מ במערכת: ' + vat + '%.' +
          (notes.trim() ? '\nהוראות קבועות מהמנהל (כבד אותן תמיד): ' + notes.trim() : '')
      }
    ];

    // ==================== לולאת הסוכן ====================
    // emit מקבל עדכוני התקדמות (לזרימת ה-SSE); מחזיר את גוף התשובה כאובייקט
    const runLoop = async (emit) => {
      let usage = { input_tokens: 0, output_tokens: 0, billed_input_tokens: 0 };
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const { resp, err } = await callClaude(systemBlocks, messages);
        if (err) return { error: err, _status: 502 };
        if (resp.usage) {
          const u = resp.usage;
          usage.input_tokens += Number(u.input_tokens) || 0;
          usage.output_tokens += Number(u.output_tokens) || 0;
          // שווה-ערך קלט לחישוב עלות: כתיבת מטמון ×1.25, קריאה ממטמון ×0.1
          usage.billed_input_tokens += Math.round((Number(u.input_tokens) || 0) +
            1.25 * (Number(u.cache_creation_input_tokens) || 0) +
            0.1 * (Number(u.cache_read_input_tokens) || 0));
        }
        const content = resp.content || [];
        messages.push({ role: 'assistant', content });
        const replyText = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        const toolUse = content.find(b => b.type === 'tool_use');

        if (resp.stop_reason !== 'tool_use' || !toolUse) {
          return { ok: true, reply: replyText || '(אין תשובה)', messages, usage, model: MODEL };
        }

        // כלי דפדפן (הצעת פעולה / הצגת גזירים) — עוצרים ומחזירים לדפדפן;
        // ה-tool_result יגיע משם (אחרי אישור/ביטול, או מיד אחרי ההצגה)
        if (toolUse.name.startsWith('propose_') || toolUse.name === 'show_customer_clips') {
          return {
            ok: true, reply: replyText,
            proposal: { tool_use_id: toolUse.id, name: toolUse.name, input: toolUse.input || {} },
            messages, usage, model: MODEL
          };
        }

        // כלי קריאה — מבצעים כאן וממשיכים בלולאה
        emit({ type: 'status', tool: toolUse.name });
        let result;
        try { result = await runReadTool(caller, toolUse.name, toolUse.input || {}); }
        catch (e) { result = { error: String(e && e.message || e) }; }
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }]
        });
      }
      return { error: 'הבקשה מורכבת מדי (יותר מדי שלבים) — נסה לפצל אותה', _status: 500 };
    };

    // מצב רגיל (JSON) — נשאר כנפילה חזרה ולתאימות
    if (body.stream !== true) {
      const payload = await runLoop(() => { });
      const status = payload._status || 200;
      delete payload._status;
      return json(payload, status);
    }

    // מצב זרימה (SSE): אירועי status תוך כדי עבודה, ואז final עם אותו גוף תשובה
    const enc = new TextEncoder();
    const sse = new ReadableStream({
      start(controller) {
        const send = (obj) => { try { controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (_) { } };
        runLoop(send)
          .then((payload) => { delete payload._status; send({ type: 'final', payload }); })
          .catch((e) => send({ type: 'final', payload: { error: String(e && e.message || e) } }))
          .finally(() => { try { controller.close(); } catch (_) { } });
      }
    });
    return new Response(sse, {
      headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
    });
  } catch (e) {
    return json({ error: e && e.message ? e.message : String(e) }, 500);
  }
});
