/* ============================================================
invoice-charge.js — סנכרון חשבוניות → ספר החוב הפנימי (charges/payments)
------------------------------------------------------------
כשמפיקים מסמך ב-EZcount (invCall), מעדכנים אוטומטית את החוב:
  • חשבון עסקה / חשבונית מס  → נוצר חיוב פתוח (חוב), לתשלום לפי תנאי הלקוח.
  • חשבונית מס/קבלה / קבלה   → נרשם תשלום שסוגר את החוב הפתוח (הישן ביותר קודם);
                               אם אין חוב פתוח — נרשם כחיוב ששולם (מכירה ישירה, נטו 0).
מונע כפל: כל רשומה מתויגת ב-notes ב-"#doc:<אסמכתא>" ונבדקת לפני יצירה.
============================================================ */

'use strict';

const IC_ORDER_KINDS = ['proforma', 'tax_invoice'];      // יוצרים חוב
const IC_PAY_KINDS = ['invoice_receipt', 'receipt'];     // סוגרים חוב
const IC_CREDIT_KINDS = ['credit'];                      // מבטלים חוב (זיכוי)

function _icAddDays(dateStr, n) { const [y, m, d] = String(dateStr).split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }
function _icDue(terms) { const t = today(); if (terms === 'net30') return _icAddDays(t, 30); if (terms === 'net60') return _icAddDays(t, 60); return t; }
function _icPayMethod() { return (typeof PAY_METHODS !== 'undefined' && PAY_METHODS.transfer) ? 'transfer' : Object.keys(PAY_METHODS || { other: 1 })[0]; }

/* אסמכתא ייחודית למסמך (למניעת כפל) */
function _icRef(doc, body) { return String((doc && doc.doc_number) || (body && body.transaction_id) || '').trim(); }

/* התאמת תג מדויקת: "#doc:123" לא יתפוס "#doc:1234" (מספרי המסמכים רציפים,
   כך שהתנגשות קידומת מובטחת עם הזמן). ilike נשאר כסינון גס בשאילתה —
   ההכרעה הסופית כאן. */
function _icTagIn(notes, tag) {
  if (!notes || !tag) return false;
  const esc = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc + '(?![0-9A-Za-z])').test(String(notes));
}
function _icHasDocTag(notes, ref) { return _icTagIn(notes, '#doc:' + ref); }

/* סכום המסמך כולל מע"מ (מעדיפים את total מהמסמך; אחרת מחשבים מהשורות) */
function _icDocTotal(doc, body) {
  const t = Number(doc && doc.total);
  if (Number.isFinite(t) && t > 0) return t;
  const items = (body && body.items) || [];
  let sum = 0; items.forEach(it => sum += (Number(it.amount) || 1) * (Number(it.price) || 0));
  if (body && !body.vat_included) sum = sum * 1.18; // גיבוי בלבד אם אין total מהמסמך (מע"מ 18%)
  return Math.round(sum * 100) / 100;
}

/* תכנון פריסת תשלום על חובות פתוחים — פונקציה טהורה (נבדקת) */
function _icPlanSettlement(openCharges, total) {
  const allocs = []; let remaining = total;
  for (const ch of openCharges) {
    if (remaining <= 0) break;
    const bal = Number(ch.balance);
    if (bal <= 0) continue;
    const applied = Math.min(remaining, bal);
    allocs.push({ id: ch.id, applied, newStatus: (bal - applied) <= 0.001 ? 'paid' : 'partial' });
    remaining = Math.round((remaining - applied) * 100) / 100;
  }
  return { allocs, leftover: Math.round(remaining * 100) / 100 };
}

/* בדיקת כפל — האם כבר טופל מסמך זה */
async function _icAlreadyDone(cid, ref) {
  if (!ref) return false;
  try {
    const c = await db.from('charges').select('id,notes').eq('customer_id', cid).ilike('notes', '%#doc:' + ref + '%').limit(20);
    if ((c.data || []).some(r => _icHasDocTag(r.notes, ref))) return true;
    const p = await db.from('payments').select('id,notes').eq('customer_id', cid).ilike('notes', '%#doc:' + ref + '%').limit(20);
    if ((p.data || []).some(r => _icHasDocTag(r.notes, ref))) return true;
  } catch (e) { /* אם notes לא קיים בסכימה — לא חוסמים */ }
  return false;
}

/* הפונקציה הראשית — נקראת מ-invCall אחרי הפקה מוצלחת */
async function applyInvoiceToLedger(body, doc) {
  try {
    if (!body || !body.customer_id) return;
    const kind = body.doc_kind;
    if (![...IC_ORDER_KINDS, ...IC_PAY_KINDS, ...IC_CREDIT_KINDS].includes(kind)) return;
    const cid = body.customer_id;
    const _iDate = body.doc_date || today(); // תאריך המסמך → תאריך החיוב בספר החוב
    const _pDate = body.pay_date || body.doc_date || today(); // תאריך התשלום בספר החוב
    const total = _icDocTotal(doc, body);
    if (!(total > 0)) return;
    // חשבון עסקה / חשבונית מס נשמרים ב-EZcount ללא total (רק מסמכי תשלום) — משלימים כדי שהסכום יופיע בכרטיס
    try { if (doc && doc.id && (doc.total == null) && !IC_CREDIT_KINDS.includes(kind)) { await db.from('documents').update({ total: total }).eq('id', doc.id); } } catch (e) { }
    const ref = _icRef(doc, body);
    if (await _icAlreadyDone(cid, ref)) return; // כבר טופל

    const cust = (typeof cache !== 'undefined' && (cache.customers || []).find(x => x.id === cid)) || {};
    const docNum = (doc && doc.doc_number) || '';
    const heKind = (typeof DOC_KIND_HE !== 'undefined' && DOC_KIND_HE[kind]) || kind;
    const tag = ref ? (' #doc:' + ref) : '';
    const baseDesc = heKind + (docNum ? ' ' + docNum : '') + (body.comment ? ' — ' + body.comment : '');

    if (IC_CREDIT_KINDS.includes(kind)) {
      // זיכוי / ביטול. אם החיוב המקורי עדיין פתוח — מבטלים אותו ישירות, כך
      // שהחוב יורד מכל מסכי הגבייה (שסופרים רק סטטוסים פתוחים ומתעלמים
      // משורת קיזוז שלילית).
      let _origCharges = [];
      if (body.credit_ref) {
        try {
          const _cand = (await db.from('charges').select('id,notes').eq('customer_id', cid)
            .in('status', ['pending', 'invoiced', 'partial', 'overdue'])
            .ilike('notes', '%#doc:' + body.credit_ref + '%')).data || [];
          _origCharges = _cand.filter(r => _icHasDocTag(r.notes, body.credit_ref));
          for (const r of _origCharges) {
            await db.from('charges').update({
              status: 'cancelled',
              notes: (r.notes || '') + ' · בוטל בזיכוי' + (docNum ? ' ' + docNum : '') + tag,
            }).eq('id', r.id);
          }
        } catch (e) { console.error('credit-cancel-orig', e); }
      }
      // שורת קיזוז שלילית נרשמת רק כשלא בוטל חוב פתוח (המקור כבר שולם, או
      // שלא סונכרן לספר) — אחרת הכרטסת תספור את ההפחתה פעמיים.
      let _creditChargeId = null;
      if (!_origCharges.length) {
        const _cc = await db.from('charges').insert({
          customer_id: cid, amount: -total, description: 'זיכוי/ביטול' + (docNum ? ' ' + docNum : '') + (body.credit_ref ? ' (למסמך ' + body.credit_ref + ')' : ''),
          issued_date: _iDate, due_date: today(), status: 'paid',
          invoice_number: docNum || null, agent_id: cust.agent_id || null, notes: 'זיכוי מחשבונית' + tag,
        }).select('id').single();
        _creditChargeId = _cc.data ? _cc.data.id : null;
      }
      // אם המסמך המקורי יצר תשלומים (מס-קבלה / קבלה, או חיוב ששולם חלקית) —
      // מבטלים גם אותם, לפי תג המסמך או שיוך לחיובים שבוטלו כעת
      if (body.credit_ref) {
        try {
          const _byTag = (await db.from('payments').select('id,amount,notes').eq('customer_id', cid).ilike('notes', '%#doc:' + body.credit_ref + '%')).data || [];
          const _origPays = _byTag.filter(r => _icHasDocTag(r.notes, body.credit_ref));
          if (_origCharges.length) {
            const _seen = new Set(_origPays.map(p => p.id));
            const _byCh = (await db.from('payments').select('id,amount,notes').in('charge_id', _origCharges.map(r => r.id))).data || [];
            _byCh.forEach(p => { if (!_seen.has(p.id) && Number(p.amount) > 0) _origPays.push(p); });
          }
          const _paidSum = _origPays.reduce((s, p) => s + Number(p.amount || 0), 0);
          if (_paidSum > 0.001) {
            await db.from('payments').insert({
              charge_id: _creditChargeId, customer_id: cid, amount: -Math.round(_paidSum * 100) / 100,
              method: _icPayMethod(), paid_date: _pDate,
              notes: 'ביטול תשלום — זיכוי' + (docNum ? ' ' + docNum : '') + ' (למסמך ' + body.credit_ref + ')' + tag,
              created_by: (typeof profile !== 'undefined' ? profile.id : null),
            });
          }
        } catch (e) { console.error('credit-payment-reverse', e); }
      }
      return { credited: total };
    }

    if (IC_ORDER_KINDS.includes(kind)) {
      // חוב פתוח חדש
      await db.from('charges').insert({
        customer_id: cid, amount: total, description: baseDesc,
        issued_date: _iDate, due_date: _icDue(cust.payment_terms), status: 'invoiced',
        invoice_number: docNum || null, agent_id: cust.agent_id || null, notes: 'סונכרן מחשבונית' + tag,
      });
      return { created: 'charge', amount: total };
    }

    // מסמך תשלום — סוגר חובות פתוחים
    const openRows = (await db.from('charges').select('id,amount').eq('customer_id', cid)
      .in('status', ['pending', 'invoiced', 'partial', 'overdue']).order('issued_date', { ascending: true })).data || [];
    const withBal = [];
    for (const ch of openRows) {
      const pays = (await db.from('payments').select('amount').eq('charge_id', ch.id)).data || [];
      const bal = Number(ch.amount) - pays.reduce((s, p) => s + Number(p.amount), 0);
      if (bal > 0.001) withBal.push({ id: ch.id, balance: bal });
    }
    const plan = _icPlanSettlement(withBal, total);
    for (const a of plan.allocs) {
      await db.from('payments').insert({ charge_id: a.id, customer_id: cid, amount: a.applied, method: _icPayMethod(), paid_date: _pDate, notes: 'תשלום מחשבונית' + tag, created_by: (typeof profile !== 'undefined' ? profile.id : null) });
      await db.from('charges').update({ status: a.newStatus }).eq('id', a.id);
    }
    if (plan.leftover > 0.001) {
      // אין חוב פתוח מתאים — מכירה ישירה ששולמה (נטו 0)
      const ins = await db.from('charges').insert({
        customer_id: cid, amount: plan.leftover, description: baseDesc,
        issued_date: _iDate, due_date: today(), status: 'paid',
        invoice_number: docNum || null, agent_id: cust.agent_id || null, notes: 'מכירה ישירה מחשבונית' + tag,
      }).select('id').single();
      if (ins.data) await db.from('payments').insert({ charge_id: ins.data.id, customer_id: cid, amount: plan.leftover, method: _icPayMethod(), paid_date: _pDate, notes: 'תשלום מחשבונית' + tag, created_by: (typeof profile !== 'undefined' ? profile.id : null) });
    }
    return { settled: total, leftover: plan.leftover };
  } catch (e) { console.error('invoice-charge', e); }
}
