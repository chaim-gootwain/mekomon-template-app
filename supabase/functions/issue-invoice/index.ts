// issue-invoice — הפקת מסמך ב-iCount אחרי אישור מפורש בכרטיס התצוגה המקדימה
// ------------------------------------------------------------
// סודות בצד השרת בלבד: ICOUNT_TOKEN (מומלץ) או ICOUNT_CID+ICOUNT_USER+ICOUNT_PASS.
// שיעור המע"מ נקרא מטבלת settings (מפתח vat_rate) — לא מקודד קשיח.
// כשל מול iCount: הבקשה נרשמת בלוג עם status=error ובלי שום מסמך חלקי.
//
// מיפוי doc_type → doctype של iCount (API v3, https://api.icount.co.il/api/v3.php):
//   tax_invoice         → invoice   (חשבונית מס)
//   tax_invoice_receipt → invrec    (חשבונית מס קבלה)
//   receipt             → receipt   (קבלה)
//   credit_invoice      → refund    (חשבונית זיכוי)
//   proforma            → deal      (חשבון עסקה)
// אימות פר-מופע: קריאת probe מחזירה את מפת doc/types של החשבון ב-iCount,
// כך שאפשר לוודא שחמשת הקודים קיימים לפני ההפקה הראשונה.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const IC = 'https://api.icount.co.il/api/v3.php';
const TOKEN = Deno.env.get('ICOUNT_TOKEN') || '';
const CID = Deno.env.get('ICOUNT_CID') || '';
const USER = Deno.env.get('ICOUNT_USER') || '';
const PASS = Deno.env.get('ICOUNT_PASS') || '';

const DOCTYPE_MAP = {
  tax_invoice: 'invoice',
  tax_invoice_receipt: 'invrec',
  receipt: 'receipt',
  credit_invoice: 'refund',
  proforma: 'deal',
};
// מיפוי לטבלת documents הקיימת (הפאנל בכרטיס הלקוח)
const DOC_KIND_MAP = {
  tax_invoice: 'tax_invoice',
  tax_invoice_receipt: 'invoice_receipt',
  receipt: 'receipt',
  credit_invoice: 'credit',
  proforma: 'proforma',
};

function icHasCreds() { return !!TOKEN || (!!CID && !!USER && !!PASS); }
async function icCall(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const payload = { ...body };
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  else { payload.cid = CID; payload.user = USER; payload.pass = PASS; }
  const r = await fetch(IC + path, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (_) { j = null; }
  if (!r.ok || !j || j.status === false) {
    const msg = (j && (j.reason || j.message || j.error)) || text.slice(0, 300) || ('HTTP ' + r.status);
    throw new Error('iCount: ' + msg);
  }
  return j;
}

function round2(n) { return Math.round(n * 100) / 100; }

/* חישוב הסכומים — אותה נוסחה כמו בכרטיס התצוגה המקדימה בצד הלקוח */
function computeTotals(lines, ratePct) {
  const rate = Number(ratePct) / 100;
  let base = 0;
  for (const l of lines) {
    const line = (Number(l.quantity) || 1) * (Number(l.unit_price) || 0);
    base += l.price_includes_vat ? line / (1 + rate) : line;
  }
  base = round2(base);
  const vat = round2(base * rate);
  const total = round2(base + vat);
  return { base, vat, total };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE);
  let requestId = null;
  try {
    const body = await req.json().catch(() => ({}));

    // הרשאה: admin או sales פעיל
    const authHeader = req.headers.get('Authorization') || '';
    const caller = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'לא מזוהה' }, 401);
    const { data: prof } = await svc.from('profiles').select('role,active').eq('id', user.id).single();
    if (!prof || !prof.active || (prof.role !== 'admin' && prof.role !== 'sales')) return json({ error: 'אין הרשאה' }, 403);

    // בדיקת חיבור + אימות קודי המסמכים מול החשבון ב-iCount
    if (body.probe) {
      if (!icHasCreds()) return json({ probe: true, ok: false, error: 'סודות iCount לא הוגדרו ב-Supabase (ICOUNT_TOKEN או ICOUNT_CID/USER/PASS)' });
      try {
        const t = await icCall('/doc/types', {});
        return json({ probe: true, ok: true, doctypes: t.doctypes || t.data || t.types || null });
      } catch (e) {
        return json({ probe: true, ok: false, error: String(e && e.message || e) });
      }
    }

    if (!icHasCreds()) return json({ error: 'סודות iCount לא הוגדרו ב-Supabase' }, 500);

    const f = body.fields || {};
    requestId = body.request_id || null;

    // כללי ברזל: אין הפקה בלי אישור מפורש מהכרטיס, ואין הפקה בלי רישום בלוג
    if (body.confirmed !== true) return json({ error: 'הפקה מותרת רק אחרי אישור מפורש ([אשר והפק])' }, 400);
    if (!requestId) return json({ error: 'חסר request_id — כל הפקה חייבת רישום בלוג' }, 400);

    const doctype = DOCTYPE_MAP[f.doc_type];
    if (!doctype) return json({ error: 'סוג מסמך לא נתמך: ' + (f.doc_type || '—') }, 400);

    const lines = (Array.isArray(f.line_items) ? f.line_items : [])
      .map(l => ({
        description: String(l.description || '').trim() || 'פרסום',
        quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
        unit_price: Number(l.unit_price) || 0,
        price_includes_vat: !!l.price_includes_vat,
      }))
      .filter(l => l.unit_price > 0);
    if (!lines.length) return json({ error: 'אין שורות עם מחיר' }, 400);

    const needsPayment = (f.doc_type === 'receipt' || f.doc_type === 'tax_invoice_receipt');
    if (needsPayment && !['credit', 'cash', 'transfer', 'check'].includes(f.payment_method))
      return json({ error: 'לקבלה / מס-קבלה חובה לציין אמצעי תשלום' }, 400);

    if (!f.customer_id && !(f.customer_name && String(f.customer_name).trim()))
      return json({ error: 'חסר לקוח' }, 400);

    // שיעור מע"מ מהגדרת המופע
    const { data: vatRow } = await svc.from('settings').select('value').eq('key', 'vat_rate').maybeSingle();
    const ratePct = Number(vatRow && vatRow.value) > 0 ? Number(vatRow.value) : 18;
    const totals = computeTotals(lines, ratePct);

    // לקוח: כרטיס קיים → פרטים מלאים; אחרת שם חופשי מהמלל
    const payload = { doctype, lang: 'he', currency_code: 'ILS' };
    let custRow = null;
    if (f.customer_id) {
      const { data: c } = await svc.from('customers')
        .select('id, name, invoice_name, business_id, address, city, email, phone')
        .eq('id', f.customer_id).single();
      if (!c) return json({ error: 'לקוח ' + f.customer_id + ' לא נמצא' }, 400);
      custRow = c;
      payload.client_name = c.invoice_name || c.name;
      if (c.business_id) payload.vat_id = c.business_id;
      if (c.email) payload.email = c.email;
      if (c.address) payload.client_address = c.address;
      if (c.city) payload.client_city = c.city;
      if (c.phone) payload.client_phone = c.phone;
    } else {
      payload.client_name = String(f.customer_name).trim();
    }

    // שורות — תמיד במחיר לפני מע"מ (iCount מוסיף מע"מ לפי החשבון).
    // קבלה היא מסמך תשלום בלבד — בלי שורות הכנסה, רק סכום התשלום.
    const rate = ratePct / 100;
    if (f.doc_type !== 'receipt') {
      payload.items = lines.map(l => ({
        description: l.description,
        quantity: l.quantity,
        unitprice: round2(l.price_includes_vat ? l.unit_price / (1 + rate) : l.unit_price),
      }));
    }
    if (f.doc_date) payload.doc_date = String(f.doc_date).slice(0, 10);
    if (f.comment) payload.hwc = String(f.comment).slice(0, 500);
    if (f.doc_type === 'receipt' && !payload.hwc)
      payload.hwc = lines.map(l => l.description + (l.quantity > 1 ? ' × ' + l.quantity : '')).join(' · ');

    // תשלום (קבלה / מס-קבלה) — הסכום ברוטו כדי להתאים לסה"כ המסמך
    if (needsPayment) {
      // בקבלה אין שורות מע"מ: הסכום שהוזן הוא הסכום שנגבה בפועל
      const paySum = f.doc_type === 'receipt'
        ? round2(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0))
        : totals.total;
      const today = new Date().toISOString().slice(0, 10);
      const payDate = (f.doc_date ? String(f.doc_date).slice(0, 10) : today);
      if (f.payment_method === 'cash') payload.cash = { sum: paySum };
      else if (f.payment_method === 'transfer') payload.banktransfer = { sum: paySum, date: payDate };
      else if (f.payment_method === 'check') payload.cheques = [{ sum: paySum, date: payDate }];
      else if (f.payment_method === 'credit') payload.cc = { sum: paySum, date: payDate };
    }

    // ---------- הקריאה ל-iCount (פעולה אחת — אין מסמך חלקי) ----------
    let doc;
    try {
      doc = await icCall('/doc/create', payload);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (requestId) {
        await svc.from('invoice_requests').update({
          status: 'error', error_message: msg, final_fields: f,
        }).eq('id', requestId);
      }
      return json({ error: msg, retryable: true }, 400);
    }

    const d = doc.data || doc;
    const docNumber = d.docnum || d.doc_number || d.docNumber || null;
    // מזהה ייחודי של המסמך בספק — נשמר כדי שאפשר יהיה לקשר אליו מס-קבלה מאוחר יותר
    const docUuid = d.doc_uuid || d.docUuid || d.uuid || (d.data && d.data.doc_uuid) || null;
    let pdfUrl = d.pdf_link || d.doc_url || d.link || null;
    if (!pdfUrl && docNumber) {
      try {
        const u = await icCall('/doc/get_doc_url', { doctype, docnum: docNumber });
        pdfUrl = u.url || (u.data && u.data.url) || null;
      } catch (_) { /* לא קריטי — המסמך כבר הופק */ }
    }

    // עדכון הלוג — הפקה הושלמה
    if (requestId) {
      await svc.from('invoice_requests').update({
        status: 'issued',
        icount_doc_number: docNumber ? String(docNumber) : null,
        icount_doc_url: pdfUrl,
        final_fields: f,
        error_message: null,
      }).eq('id', requestId);
    }

    // רישום בטבלת documents — כדי שהמסמך יופיע גם בכרטיס הלקוח (best effort)
    try {
      await svc.from('documents').insert({
        customer_id: (custRow && custRow.id) || null,
        doc_kind: DOC_KIND_MAP[f.doc_type] || f.doc_type,
        doc_number: docNumber ? String(docNumber) : null,
        doc_uuid: docUuid,
        pdf_url: pdfUrl,
        amount: totals.base, vat_amount: totals.vat, total: totals.total,
        vat_included: false, status: 'issued', mode: 'production', raw: d,
      });
    } catch (_) { /* הפאנל בכרטיס הלקוח הוא בונוס — לא מכשילים הפקה שהצליחה */ }

    return json({ ok: true, document: { doc_number: docNumber, pdf_url: pdfUrl, totals, vat_rate: ratePct } });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    try {
      if (requestId) await svc.from('invoice_requests').update({ status: 'error', error_message: msg }).eq('id', requestId);
    } catch (_) { }
    return json({ error: msg }, 500);
  }
});
