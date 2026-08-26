import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const EZCOUNT_PUBLIC_DEMO_KEY = "f1c85d16fc1acd369a93f0489f4615d93371632d97a9b0a197de6d4dc0da51bf";
const KIND_TO_TYPE = {
  proforma: 300,
  tax_invoice: 305,
  invoice_receipt: 320,
  receipt: 400,
  credit: 330
};
const PAY_TYPE = {
  cash: 1,
  check: 2,
  transfer: 4,
  credit: 3,
  bit: 9,
  paybox: 9
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const authHeader = req.headers.get("Authorization") || "";
    const { data: userData } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    const uid = userData?.user?.id;
    if (!uid) return json({
      ok: false,
      error: "unauthorized"
    }, 401);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", uid).single();
    if (!prof || ![
      "admin",
      "sales"
    ].includes(prof.role)) return json({
      ok: false,
      error: "forbidden"
    }, 403);
    const body = await req.json();
    const { customer_id, charge_id, doc_kind, items = [], vat_included = false, payment = null, transaction_id: txnIn, comment, parent = null, doc_date = null } = body || {};
    const type = KIND_TO_TYPE[doc_kind];
    if (!type) return json({
      ok: false,
      error: "bad doc_kind"
    }, 400);
    const { data: cust } = await admin.from("customers").select("*").eq("id", customer_id).single();
    if (!cust) return json({
      ok: false,
      error: "customer not found"
    }, 404);
    const { data: setRows } = await admin.from("settings").select("key,value").in("key", [
      "ezcount_mode",
      "ezcount_autosend"
    ]);
    const settings = {};
    (setRows || []).forEach((r)=>settings[r.key] = r.value);
    const mode = settings.ezcount_mode === "production" ? "production" : "demo";
    const autosend = settings.ezcount_autosend === "1";
    const base = mode === "production" ? "https://api.ezcount.co.il" : "https://demo.ezcount.co.il";
    const apiKey = mode === "production" ? Deno.env.get("EZCOUNT_API_KEY_PROD") || "" : Deno.env.get("EZCOUNT_API_KEY_DEMO") || EZCOUNT_PUBLIC_DEMO_KEY;
    const devEmail = Deno.env.get("EZCOUNT_DEVELOPER_EMAIL") || "dev@emanuel-sheli.local";
    if (!apiKey) return json({
      ok: false,
      error: "no-api-key"
    }, 400);
    const vatType = vat_included ? "INC" : "PRE";
    const itemArr = (items || []).map((it)=>({
        details: String(it.details || "פריט"),
        amount: Number(it.amount || 1),
        price: Number(it.price || 0),
        vat_type: vatType
      }));
    const paymentArr = [];
    if (payment && payment.sum) {
      const pt = PAY_TYPE[payment.method] ?? 9;
      const p = {
        payment_type: pt,
        payment_sum: Number(payment.sum)
      };
      if (payment.date) p.date = payment.date;
      if (payment.method === "check") {
        p.checks_bank_name = payment.bank_name || "—";
        p.checks_number = payment.check_number || "—";
      } else if (payment.method === "credit") {
        p.cc_type = 0;
        p.cc_type_name = payment.cc_name || "אשראי";
        p.cc_number = payment.cc_last4 || "";
        p.cc_deal_type = 1;
        p.cc_num_of_payments = Number(payment.installments || 1);
      } else if (payment.method === "bit") {
        p.other_payment_type_name = "ביט";
      } else if (payment.method === "paybox") {
        p.other_payment_type_name = "פייבוקס";
      }
      paymentArr.push(p);
    }
    const txn = txnIn || "emu-" + customer_id + "-" + (charge_id || "x") + "-" + doc_kind + "-" + Date.now();
    const payload = {
      api_key: apiKey,
      developer_email: devEmail,
      type,
      transaction_id: txn,
      lang: "he",
      customer_name: cust.invoice_name || cust.name || "לקוח",
      customerAction: "ASSOC_CREATE",
      send_copy: 1,
      dont_send_email: autosend ? 0 : 1
    };
    payload.customer_crn = cust.business_id || String(cust.id);
    if (parent) payload.parent = parent;
    if (doc_date) {
      const _dp = String(doc_date).split('-');
      if (_dp.length === 3) payload.date = _dp[2] + '/' + _dp[1] + '/' + _dp[0];
    }
    if (cust.email) payload.customer_email = cust.email;
    if (cust.phone) payload.customer_phone = cust.phone;
    if (cust.address) payload.customer_address = cust.address;
    if (comment) payload.comment = String(comment);
    if (itemArr.length) {
      payload.item = itemArr;
      if (vat_included) payload.show_items_including_vat = 1;
      if (doc_kind === "receipt" || doc_kind === "credit") payload.forceItemsIntoNonItemsDocument = 1;
    }
    if (paymentArr.length) {
      payload.payment = paymentArr;
      payload.price_total = paymentArr.reduce((s, p)=>s + Number(p.payment_sum || 0), 0);
    }
    let resp, raw;
    try {
      resp = await fetch(base + "/api/createDoc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      raw = await resp.json().catch(()=>({}));
    } catch (e) {
      await admin.from("documents").insert({
        created_by: uid,
        customer_id,
        charge_id: charge_id || null,
        doc_kind,
        ezcount_type: type,
        transaction_id: txn,
        status: "failed",
        mode,
        error: "network: " + String(e)
      });
      return json({
        ok: false,
        error: "network",
        detail: String(e)
      }, 502);
    }
    const success = raw && (raw.success === true || raw.success === "true");
    const pendingAllocation = resp.status === 417 || raw?.errNum === 417;
    const docRow = {
      created_by: uid,
      customer_id,
      charge_id: charge_id || null,
      doc_kind,
      ezcount_type: type,
      transaction_id: txn,
      mode,
      payment_method: payment?.method || null,
      vat_included: !!vat_included,
      total: paymentArr.length ? payload.price_total : null,
      raw
    };
    if (success) {
      docRow.status = "issued";
      docRow.doc_number = raw.doc_number ? String(raw.doc_number) : null;
      docRow.doc_uuid = raw.doc_uuid || null;
      docRow.pdf_url = raw.pdf_link || null;
      docRow.pdf_url_copy = raw.pdf_link_copy || null;
    } else if (pendingAllocation) {
      docRow.status = "pending_allocation";
      docRow.error = raw?.errMsg || "ממתין למספר הקצאה";
    } else {
      docRow.status = "failed";
      docRow.error = raw?.errMsg || "EZcount error " + (raw?.errNum ?? resp.status);
    }
    const { data: inserted } = await admin.from("documents").insert(docRow).select("*").single();
    if (success) {
      try {
        await admin.from("interactions").insert({
          customer_id,
          kind: "document",
          note: "📄 הופק " + doc_kind + " #" + (docRow.doc_number || "")
        });
      } catch (_e) {}
    }
    return json({
      ok: success,
      status: docRow.status,
      document: inserted,
      error: success ? null : docRow.error
    });
  } catch (e) {
    return json({
      ok: false,
      error: String(e)
    }, 500);
  }
});
