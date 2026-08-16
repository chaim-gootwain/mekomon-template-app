/* ============================================================
   invoice-reconcile.js — השלמת חוב מחשבוניות שהופקו בלי רשומת חוב
   ------------------------------------------------------------
   מזהה מסמכי חיוב (proforma / tax_invoice) שאין להם רשומת חוב במערכת,
   שולף את הסכום האמיתי מתוך documents.raw.calculatedData.price_total,
   ופותח חלון לטיפול אחד-אחד: חוב פתוח · שולם · דלג.
   נפתח אוטומטית בכניסה אם יש חשבוניות להשלמה. אין סכימה חדשה.
   ============================================================ */

'use strict';

let _invRecItems = null;        // הפריטים הממתינים לטיפול
const _invRecSkip = new Set();  // דילוגים לשיחה הנוכחית (docId)

/* טעינת החשבוניות שאין להן חוב + סכום מ-raw */
async function _invRecLoad() {
  // כולל גם מסמכי תשלום (מס-קבלה / קבלה) — משלם מיידי שלא נרשם בספר החוב
  const docs = (await db.from('documents').select('id,customer_id,doc_kind,status,doc_number,raw')
    .neq('status', 'failed').in('doc_kind', ['proforma', 'tax_invoice', 'invoice_receipt', 'receipt'])).data || [];
  const chg = (await db.from('charges').select('invoice_number,notes')).data || [];
  const pays = (await db.from('payments').select('notes')).data || [];
  // "כבר טופל" = יש חיוב או תשלום שמתייג את המסמך (מסמך תשלום שנזקף לחוב פתוח נחשב מסונכרן)
  const has = (num) => chg.some(c => (c.notes && c.notes.includes('#doc:' + num)) ||
    (c.invoice_number && String(c.invoice_number).trim() === String(num).trim())) ||
    pays.some(p => p.notes && p.notes.includes('#doc:' + num));
  const items = [];
  docs.forEach(d => {
    const num = String(d.doc_number || '').trim();
    if (!num || has(num) || _invRecSkip.has(d.id)) return;
    const cd = d.raw && d.raw.calculatedData;
    const gross = cd ? Number(cd.price_total) : null;
    if (!(gross > 0)) return; // אין סכום ב-raw — לא ניתן להשלים אוטומטית
    const isPay = ['invoice_receipt', 'receipt'].includes(d.doc_kind);
    items.push({
      docId: d.id, num, kind: d.doc_kind, isPay, cust: d.customer_id,
      name: (cache.customers || []).find(x => x.id === d.customer_id)?.name || ('לקוח #' + d.customer_id),
      gross: Math.round(gross * 100) / 100, vat: cd ? Number(cd.vat_price) : 0, date: cd ? cd.date : today(),
    });
  });
  items.sort((a, b) => String(a.num).localeCompare(String(b.num)));
  return items;
}

async function invReconcileOpen() {
  _invRecItems = await _invRecLoad();
  _invRecRender();
}

function _invRecRender() {
  const items = _invRecItems || [];
  const total = items.reduce((s, i) => s + i.gross, 0);
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `
    <h3>🔗 השלמת חוב מחשבוניות</h3>
    <p class="muted" style="font-size:.85rem">חשבוניות שהופקו ב-EZcount אך אין להן רשומת חוב במערכת. לכל אחת בחר/י פעולה.</p>
    ${items.length ? `
    <div style="margin:6px 0 10px;font-size:.9rem">נותרו <b>${items.length}</b> חשבוניות · סה"כ <b>${money(total)}</b></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>לקוח</th><th>מסמך</th><th>תאריך</th><th>סכום</th><th></th></tr></thead>
      <tbody>${items.map(it => `<tr>
        <td><b>${esc(it.name)}</b></td>
        <td>${esc(it.num)} · ${(typeof DOC_KIND_HE !== 'undefined' && DOC_KIND_HE[it.kind]) || (it.kind === 'tax_invoice' ? 'חשבונית מס' : 'חשבון עסקה')}</td>
        <td>${heDate(it.date)}</td>
        <td><b>${money(it.gross)}</b></td>
        <td style="white-space:nowrap">
          ${it.isPay ? '' : `<button class="btn btn-sm" style="background:#d35400;color:#fff" onclick="invRecMark(${it.docId},'open')">חוב פתוח</button>`}
          <button class="btn btn-sm" style="background:var(--ok);color:#fff" onclick="invRecMark(${it.docId},'paid')">${it.isPay ? 'רשום כשולם' : 'שולם'}</button>
          <button class="btn btn-sm btn-ghost" onclick="invRecSkip(${it.docId})">דלג</button>
        </td></tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty" style="margin-top:12px">✓ אין חשבוניות להשלמה — הכל מסונכרן</div>`}
    <div class="m-actions" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

function invRecSkip(docId) {
  _invRecSkip.add(docId);
  _invRecItems = (_invRecItems || []).filter(i => i.docId !== docId);
  _invRecRender();
}

async function invRecMark(docId, mode) {
  const it = (_invRecItems || []).find(i => i.docId === docId);
  if (!it) return;
  try {
    const dupC = (await db.from('charges').select('id').eq('customer_id', it.cust).ilike('notes', '%#doc:' + it.num + '%').limit(1)).data;
    const dupP = (await db.from('payments').select('id').eq('customer_id', it.cust).ilike('notes', '%#doc:' + it.num + '%').limit(1)).data;
    if ((dupC && dupC.length) || (dupP && dupP.length)) {
      toast('כבר קיים רישום לחשבונית ' + it.num);
    } else {
      const cust = (cache.customers || []).find(x => x.id === it.cust) || {};
      const kindHe = (typeof DOC_KIND_HE !== 'undefined' && DOC_KIND_HE[it.kind]) || (it.kind === 'tax_invoice' ? 'חשבונית מס' : 'חשבון עסקה');
      if (mode === 'paid') {
        const ins = await run(db.from('charges').insert({
          customer_id: it.cust, amount: it.gross, description: kindHe + ' ' + it.num,
          issued_date: it.date, due_date: it.date, status: 'paid', invoice_number: it.num,
          agent_id: cust.agent_id || null, notes: 'סונכרן מחשבונית (השלמה — שולם) #doc:' + it.num,
        }).select('id').single());
        const method = (typeof _icPayMethod === 'function') ? _icPayMethod() : 'transfer';
        await db.from('payments').insert({
          charge_id: ins.id, customer_id: it.cust, amount: it.gross, method: method,
          paid_date: it.date, notes: 'תשלום השלמה #doc:' + it.num,
          created_by: (typeof profile !== 'undefined' ? profile.id : null),
        });
      } else {
        const due = (typeof _icDue === 'function') ? _icDue(cust.payment_terms) : it.date;
        await run(db.from('charges').insert({
          customer_id: it.cust, amount: it.gross, description: kindHe + ' ' + it.num,
          issued_date: it.date, due_date: due, status: 'invoiced', invoice_number: it.num,
          agent_id: cust.agent_id || null, notes: 'סונכרן מחשבונית (השלמה) #doc:' + it.num,
        }));
      }
      // מילוי סכום המסמך (מטא-דאטה בטוחה)
      try { await db.from('documents').update({ total: it.gross, amount: Math.round((it.gross - (it.vat || 0)) * 100) / 100, vat_amount: it.vat || null }).eq('id', it.docId); } catch (e) { }
      try { await addInteraction('customer', it.cust, (mode === 'paid' ? '💰 חשבונית ' + it.num + ' — סומנה כשולם (השלמת סנכרון)' : '🧾 חשבונית ' + it.num + ' — נוצר חוב פתוח (השלמת סנכרון)')); } catch (e) { }
      toast(mode === 'paid' ? ('✓ ' + it.name + ' — סומן כשולם') : ('✓ ' + it.name + ' — נוצר חוב פתוח'));
    }
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); return; }
  _invRecItems = (_invRecItems || []).filter(i => i.docId !== docId);
  _invRecRender();
}

/* בדיקה אוטומטית בכניסה — פותח את החלון אם יש חשבוניות להשלמה (בלי לדרוס חלון פתוח) */
async function invReconcileCheckPending() {
  try {
    if (typeof profile === 'undefined' || !['admin', 'sales'].includes(profile.role)) return false;
    const vb = document.getElementById('viewBack');
    if (vb && vb.classList.contains('open')) return false; // חלון אחר כבר פתוח (למשל ייבוא) — לא דורסים
    const items = await _invRecLoad();
    if (items.length) { _invRecItems = items; _invRecRender(); return true; }
  } catch (e) { /* שקט */ }
  return false;
}
