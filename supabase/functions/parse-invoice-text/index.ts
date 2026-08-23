// parse-invoice-text — פענוח מלל חופשי בעברית לשדות חשבונית (Claude)
// הסוד ANTHROPIC_API_KEY נשמר בצד השרת בלבד. הפונקציה רק מפענחת —
// היא לא מפיקה שום מסמך ולא כותבת לטבלאות.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('INVOICE_PARSE_MODEL') || 'claude-sonnet-4-5';

const SYSTEM = `אתה מפענח בקשות בעברית להפקת מסמכי חשבונות עבור מקומון (עיתון מקומי).
המשתמש כותב משפט חופשי, ואתה מחזיר JSON בלבד — בלי שום טקסט נוסף, בלי גדרות קוד.

מבנה הפלט (בדיוק):
{
  "doc_type": "tax_invoice | tax_invoice_receipt | receipt | credit_invoice | proforma | null",
  "customer_name_raw": "string | null",
  "line_items": [
    { "description": "string", "quantity": number, "unit_price": number, "price_includes_vat": boolean }
  ],
  "payment_method": "credit | cash | transfer | check | null",
  "confidence": "high | medium | low",
  "missing_fields": ["שמות שדות חסרים קריטיים"]
}

כללי הקיצור של המשתמש:
- סוג מסמך: "ח. מס" / "ח מס" / "חשבונית מס" → tax_invoice · "מס קבלה" / "חשבונית מס קבלה" → tax_invoice_receipt · "קבלה" → receipt · "זיכוי" / "חשבונית זיכוי" → credit_invoice · "עסקה" / "חשבון עסקה" / "חשבונית על עסקה" → proforma. לא ברור → null והוסף "doc_type" ל-missing_fields.
- מע"מ: "+ מע\"מ" אחרי סכום, או "+" צמוד לסוף הסכום (למשל "250+") → המחיר לפני מע"מ → price_includes_vat=false. נאמר "כולל מע\"מ" → price_includes_vat=true. לא צוין כלום → price_includes_vat=false (ההנחה: לפני מע"מ; הכרטיס יציג זאת לאישור).
- כמות: "4 פעמים", "4 פרסומים", "פעמיים" (=2), מספרים במילים ("ארבע") → quantity. לא צוינה כמות → 1.
- מחיר: תומך בעשרוני (662.5), במילים ("חמש מאות" → 500, "אלף מאתיים" → 1200), ובסימני מטבע (₪, ש"ח). unit_price הוא תמיד מחיר ליחידה אחת, מספר בלבד.
- לקוח: בדרך כלל אחרי "ל..." ("לשבועון לבית היהודי" → "שבועון לבית היהודי"). כשהלמ"ד היא תחילית יחס — הסר אותה; כשהיא חלק מהשם עצמו (למשל "לבית היהודי" בתוך השם) — השאר. אין שם לקוח → customer_name_raw=null והוסף "customer" ל-missing_fields.
- אמצעי תשלום: "אשראי" → credit · "מזומן" → cash · "העברה" / "העברה בנקאית" → transfer · "צ'ק" / "שיק" → check. לא צוין → null (זה קריטי רק לקבלה ולמס-קבלה — במקרה כזה הוסף "payment_method" ל-missing_fields).
- description: תיאור השירות/המוצר מתוך המשפט, בלי שם הלקוח ובלי הסכום. אין תיאור → השתמש ב"פרסום" והורד confidence.
- missing_fields כולל רק שדות קריטיים חסרים: customer, doc_type, price, ולקבלה/מס-קבלה גם payment_method.
- confidence: high כשהכול חד-משמעי · medium כשמשהו הושלם בהנחה · low כשהמשפט עמום.

דוגמאות:
קלט: תוציא לי ח. מס לשבועון לבית היהודי על חלוקת המרווה לצמא 662.5 + מע"מ 4 פעמים
פלט: {"doc_type":"tax_invoice","customer_name_raw":"שבועון לבית היהודי","line_items":[{"description":"חלוקת המרווה לצמא","quantity":4,"unit_price":662.5,"price_includes_vat":false}],"payment_method":null,"confidence":"high","missing_fields":[]}

קלט: תפיק לי חשבונית על עסקה של 4 פרסומים של רבע עמוד 250+
פלט: {"doc_type":"proforma","customer_name_raw":null,"line_items":[{"description":"פרסום רבע עמוד","quantity":4,"unit_price":250,"price_includes_vat":false}],"payment_method":null,"confidence":"high","missing_fields":["customer"]}

קלט: קבלה לגן ורדים 500 כולל מעמ במזומן
פלט: {"doc_type":"receipt","customer_name_raw":"גן ורדים","line_items":[{"description":"פרסום","quantity":1,"unit_price":500,"price_includes_vat":true}],"payment_method":"cash","confidence":"medium","missing_fields":[]}

החזר JSON בלבד.`;

/* חילוץ JSON גם אם המודל עטף אותו בטקסט/גדרות */
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

/* אכיפת המבנה וברירות המחדל — לא סומכים על המודל בעיוורון */
const DOC_TYPES = ['tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma'];
const PAY_METHODS = ['credit', 'cash', 'transfer', 'check'];
function normalizeParsed(p) {
  const out = {
    doc_type: DOC_TYPES.includes(p && p.doc_type) ? p.doc_type : null,
    customer_name_raw: (p && typeof p.customer_name_raw === 'string' && p.customer_name_raw.trim()) ? p.customer_name_raw.trim() : null,
    line_items: [],
    payment_method: PAY_METHODS.includes(p && p.payment_method) ? p.payment_method : null,
    confidence: ['high', 'medium', 'low'].includes(p && p.confidence) ? p.confidence : 'low',
    missing_fields: Array.isArray(p && p.missing_fields) ? p.missing_fields.filter(x => typeof x === 'string') : [],
  };
  const items = Array.isArray(p && p.line_items) ? p.line_items : [];
  out.line_items = items.map((it) => ({
    description: (it && typeof it.description === 'string' && it.description.trim()) ? it.description.trim() : 'פרסום',
    quantity: (it && Number(it.quantity) > 0) ? Number(it.quantity) : 1,
    unit_price: (it && isFinite(Number(it.unit_price))) ? Number(it.unit_price) : 0,
    price_includes_vat: !!(it && it.price_includes_vat),
  })).filter(it => it.unit_price >= 0);
  // שדות קריטיים חסרים — משלימים את missing_fields גם אם המודל שכח
  const miss = new Set(out.missing_fields);
  if (!out.customer_name_raw) miss.add('customer');
  if (!out.doc_type) miss.add('doc_type');
  if (!out.line_items.length || out.line_items.every(it => !it.unit_price)) miss.add('price');
  if ((out.doc_type === 'receipt' || out.doc_type === 'tax_invoice_receipt') && !out.payment_method) miss.add('payment_method');
  if (out.customer_name_raw) miss.delete('customer');
  if (out.doc_type) miss.delete('doc_type');
  if (out.line_items.some(it => it.unit_price > 0)) miss.delete('price');
  if (out.payment_method) miss.delete('payment_method');
  out.missing_fields = [...miss];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json().catch(() => ({}));

    // הרשאה: admin או sales פעיל
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || (prof.role !== 'admin' && prof.role !== 'sales')) return json({ error: 'אין הרשאה' }, 403);

    // בדיקת חיבור בלבד — בלי לשרוף טוקנים על פענוח
    if (body.probe) {
      if (!API_KEY) return json({ probe: true, ok: false, error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase' });
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      });
      return json({ probe: true, ok: r.ok, status: r.status });
    }

    const text = String(body.text || '').trim();
    if (!text) return json({ error: 'לא התקבל מלל' }, 400);
    if (text.length > 1000) return json({ error: 'המלל ארוך מדי (עד 1000 תווים)' }, 400);
    if (!API_KEY) return json({ error: 'ANTHROPIC_API_KEY לא הוגדר ב-Supabase' }, 500);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: SYSTEM,
        messages: [{ role: 'user', content: text }],
      }),
    });
    const rText = await r.text();
    if (!r.ok) return json({ error: 'שגיאת פענוח (' + r.status + ')', detail: rText.slice(0, 300) }, 502);
    let resp; try { resp = JSON.parse(rText); } catch (_) { resp = {}; }
    const content = (resp.content && resp.content[0] && resp.content[0].text) || '';
    const raw = extractJson(content);
    if (!raw) return json({ error: 'הפענוח לא החזיר JSON תקין — נסה לנסח מחדש' }, 422);

    const parsed = normalizeParsed(raw);
    return json({ ok: true, parsed });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : String(e) }, 500);
  }
});
