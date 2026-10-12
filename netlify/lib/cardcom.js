// netlify/lib/cardcom.js
// -----------------------------------------------------------------------------
// קארדקום (API v11) — דף תשלום ("Low Profile") ואימות תוצאה.
//   createPage({...}) → { lowProfileId, url }   — דף תשלום לסכום מדויק; ReturnValue חוזר אלינו ב-webhook
//   getResult(lowProfileId) → LowProfileResult   — אימות מול קארדקום (לא סומכים על מה שהגיע ב-webhook)
// מסמכים (קבלה) לא מופקים בקארדקום — רק ב-ezcount (החלטת חיים, 12.10.2026).
// env: CARDCOM_TERMINAL, CARDCOM_API_NAME (סיסמת API לא נדרשת לחיוב רגיל), CARDCOM_MAX_PAYMENTS (ברירת מחדל 1)
// -----------------------------------------------------------------------------
const BASE = "https://secure.cardcom.solutions/api/v11";
const TERMINAL = parseInt(process.env.CARDCOM_TERMINAL || "", 10);
const API_NAME = (process.env.CARDCOM_API_NAME || "").trim();
const configured = () => !!(TERMINAL && API_NAME);

async function call(path, body) {
  const r = await fetch(`${BASE}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch (_) { throw new Error(`cardcom ${r.status}: ${t.slice(0, 150)}`); }
  return d;
}

async function createPage({ amount, returnValue, productName, name, email, phone, webhookUrl, successUrl, failedUrl, maxPayments }) {
  if (!configured()) throw new Error("קארדקום לא מוגדרת (CARDCOM_TERMINAL / CARDCOM_API_NAME)");
  const max = Math.max(1, Math.min(12, parseInt(maxPayments || process.env.CARDCOM_MAX_PAYMENTS || "1", 10) || 1));
  const d = await call("LowProfile/Create", {
    TerminalNumber: TERMINAL, ApiName: API_NAME, Operation: "ChargeOnly",
    ReturnValue: String(returnValue).slice(0, 250), Amount: Math.round(Number(amount) * 100) / 100, ISOCoinId: 1, Language: "he",
    ProductName: String(productName || "תשלום — @@PAPER_NAME@@").slice(0, 100),
    SuccessRedirectUrl: successUrl, FailedRedirectUrl: failedUrl, CancelRedirectUrl: failedUrl, WebHookUrl: webhookUrl,
    UIDefinition: { CardOwnerNameValue: name || undefined, CardOwnerEmailValue: email || undefined, CardOwnerPhoneValue: phone || undefined },
    AdvancedDefinition: max > 1 ? { MinNumOfPayments: 1, MaxNumOfPayments: max } : undefined,
  });
  if (d.ResponseCode !== 0 || !d.Url) throw new Error(`קארדקום: ${d.Description || "שגיאה " + d.ResponseCode}`);
  return { lowProfileId: d.LowProfileId, url: d.Url };
}

async function getResult(lowProfileId) {
  if (!configured()) throw new Error("קארדקום לא מוגדרת");
  return call("LowProfile/GetLpResult", { TerminalNumber: TERMINAL, ApiName: API_NAME, LowProfileId: String(lowProfileId) });
}

// עסקה ששולמה בפועל: הדף הצליח, העסקה אושרה, ולא זיכוי
function isPaid(res) {
  const t = res && res.TranzactionInfo;
  return !!(res && res.ResponseCode === 0 && t && t.ResponseCode === 0 && !t.IsRefund && Number(t.Amount) > 0 && Number(res.TerminalNumber) === TERMINAL);
}

module.exports = { configured, createPage, getResult, isPaid };
