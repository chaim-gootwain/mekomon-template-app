// green-invoice-doc — הפקת מסמכים מול חשבונית ירוקה (עוסק פטור, ללא מע"מ)
// מקבל את אותו חוזה של מסך החשבוניות ומתרגם ל-Green Invoice.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const KEY = Deno.env.get('GI_KEY') || '';
const SECRET = Deno.env.get('GI_SECRET') || '';
const GI = 'https://api.greeninvoice.co.il/api/v1';

// doc_kind (מהמערכת) -> סוג מסמך בחשבונית ירוקה. עוסק פטור: אין חשבונית מס.
const TYPE_MAP = {
  quote: 10,           // הצעת מחיר
  proforma: 300,       // חשבון עסקה
  tax_invoice: 300,    // עוסק פטור — ממופה לחשבון עסקה
  invoice_receipt: 400,// קבלה
  receipt: 400,        // קבלה
  credit: 330,         // זיכוי
};

async function giToken() {
  const r = await fetch(GI + '/account/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: KEY, secret: SECRET }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('GI auth ' + r.status + ': ' + txt.slice(0, 200));
  const j = JSON.parse(txt);
  if (!j.token) throw new Error('GI token missing');
  return j.token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ANON = Deno.env.get('SUPABASE_ANON_KEY');
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json().catch(() => ({}));

    if (body.probe) {
      if (!KEY || !SECRET) return json({ probe: true, error: 'GI_KEY/GI_SECRET לא הוגדרו' });
      const tok = await giToken().catch((e) => null);
      return json({ probe: true, authOk: !!tok });
    }

    // הרשאה: admin או sales
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role').eq('id', user.id).single();
    if (!prof || (prof.role !== 'admin' && prof.role !== 'sales')) return json({ error: 'אין הרשאה' }, 403);

    const doc_kind = body.doc_kind || 'proforma';
    const giType = TYPE_MAP[doc_kind];
    if (!giType) return json({ error: 'סוג מסמך לא נתמך: ' + doc_kind }, 400);

    // לקוח
    let client = { name: 'לקוח', add: true, self: false };
    if (body.customer_id) {
      const { data: c } = await svc.from('customers')
        .select('name, invoice_name, business_id, address, city, email, phone').eq('id', body.customer_id).single();
      if (c) {
        client = { name: c.invoice_name || c.name, add: true, self: false };
        if (c.business_id) client.taxId = c.business_id;
        const addr = [c.address, c.city].filter(Boolean).join(', ');
        if (addr) client.address = addr;
        if (c.email) client.emails = [c.email];
        if (c.phone) client.phone = c.phone;
      }
    }
    if (body.client_name) client.name = body.client_name;

    // תשלום — לקבלה הפרונט שולח body.payment כאובייקט {method, sum, date} (ולא מערך items)
    let payObj = null;
    if (body.payment && typeof body.payment === 'object' && !Array.isArray(body.payment)) payObj = body.payment;

    // שורות הכנסה — עוסק פטור: לא שולחים vatType כלל. סיווג "עוסק פטור" בחשבון
    // חשבונית ירוקה כבר גורם לכל מסמך להיות 0% מע"מ. שליחת vatType מפורש מחזירה שגיאה 2409.
    const items = Array.isArray(body.items) ? body.items : [];
    const income = items.map((it) => ({
      description: String(it.details || 'פריט'),
      quantity: Number(it.amount) || 1,
      price: Number(it.price) || 0,
      currency: 'ILS',
    }));
    if (!income.length) {
      const p = (payObj && Number(payObj.sum)) ? Number(payObj.sum) : 0;
      income.push({ description: body.comment || 'שירות', quantity: 1, price: p, currency: 'ILS' });
    }
    const total = income.reduce((s, r) => s + r.price * r.quantity, 0);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const payload = {
      type: giType, lang: 'he', currency: 'ILS',
      client, income,
      description: body.comment || undefined,
    };
    // מסמכים שמחייבים תשלום (קבלה) — מוסיפים בלוק תשלום
    if (giType === 400 || giType === 320) {
      const pType = (payObj && Number(payObj.method)) ? Number(payObj.method) : (Number(body.payment_type) || 4);
      const pDate = (payObj && payObj.date) ? String(payObj.date).slice(0, 10) : today;
      payload.payment = [{ type: pType, date: pDate, price: total, currency: 'ILS' }];
    }
    if (giType === 330 && body.parent) payload.linkedDocumentIds = [body.parent];

    const token = await giToken();
    const cr = await fetch(GI + '/documents', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const crText = await cr.text();
    if (!cr.ok) return json({ error: 'הפקה נכשלה (' + cr.status + ')', detail: crText.slice(0, 500) }, 400);
    let doc; try { doc = JSON.parse(crText); } catch (_) { doc = {}; }

    const docId = doc.id || null;
    const docNumber = doc.number || doc.documentNumber || null;
    let pdfUrl = (doc.url && (doc.url.he || doc.url.origin || doc.url.en)) || null;
    if (!pdfUrl && docId) {
      try {
        const lr = await fetch(GI + '/documents/' + docId + '/download/links', { headers: { 'Authorization': 'Bearer ' + token } });
        if (lr.ok) { const lj = await lr.json(); pdfUrl = lj.he || lj.origin || lj.en || null; }
      } catch (_) {}
    }

    // רישום בטבלת documents (כמו EZcount)
    try {
      await svc.from('documents').insert({
        customer_id: body.customer_id || null,
        doc_kind,
        transaction_id: body.transaction_id || null,
        doc_number: docNumber ? String(docNumber) : null,
        doc_uuid: docId,
        pdf_url: pdfUrl,
        amount: total, vat_amount: 0, total: total, vat_included: false,
        status: 'issued', mode: 'production', raw: doc,
      });
    } catch (_) {}

    return json({ ok: true, document: { doc_number: docNumber, doc_uuid: docId, pdf_url: pdfUrl } });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : String(e) }, 500);
  }
});
