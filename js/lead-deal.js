/* ============================================================
lead-deal.js — קליטת פרטי עסקה בסיום המרת ליד ללקוח
------------------------------------------------------------
נפתח אוטומטית אחרי leadConvert. שני מצבים:
  • מודעה חד-פעמית  → נוצרת מודעה (ads) לגיליון, עם גודל ומחיר.
  • עסקה רציפה (מנוי) → נוצר חוזה (contracts): מספר פרסומים, תדירות ומחיר.
בסיום — כפתור "שלח חשבונית ללקוח" (invIssueOrder) שגם מעדכן את החוב.
============================================================ */

'use strict';

const LD_CADENCE = [['every', 'כל גיליון'], ['monthly', 'חודשי'], ['bimonthly', 'דו-שבועי'], ['alt', 'מסורג — גיליון כן, גיליון לא'], ['selected', 'תאריכים נבחרים']];

function _ldealIssues() {
  return (typeof cache !== 'undefined' ? (cache.issues || []) : []).slice()
    .sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')));
}
function _ldealSizeOptions(sel) {
  return (cache.priceList || []).map(p => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)}${p.premium ? ' ⭐' : ''} — ${money(p.price)}</option>`).join('');
}

/* טופס פרטי עסקה */
function leadDealForm(customerId, mode) {
  mode = mode || 'single';
  const c = (typeof _customers !== 'undefined' && _customers.find(x => x.id === customerId)) || (cache.customers || []).find(x => x.id === customerId) || { id: customerId, name: '' };
  const issues = _ldealIssues();
  const nextIssue = issues.find(i => (i.publish_date || '') >= today()) || issues[issues.length - 1];
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `
    <h3>💼 פרטי העסקה — ${esc(c.name || '')}</h3>
    <p class="muted" style="font-size:.85rem">בחר סוג עסקה, הזן מחיר, ובסיום אפשר לשלוח חשבונית.</p>
    <input type="hidden" id="ldMode" value="${mode}">
    <div class="tabs" style="margin:10px 0">
      <button class="${mode === 'single' ? 'active' : ''}" onclick="leadDealForm(${customerId},'single')">📄 מודעה חד-פעמית</button>
      <button class="${mode === 'recurring' ? 'active' : ''}" onclick="leadDealForm(${customerId},'recurring')">🔁 עסקה רציפה (מנוי)</button>
    </div>

    <div class="field"><label>גודל המודעה (מהמחירון)</label>
      <select id="ldSize" onchange="_ldealFillPrice()"><option value="">— בחר גודל —</option>${_ldealSizeOptions('')}</select></div>

    ${mode === 'single' ? `
      <div class="field"><label>תיאור המודעה</label><input id="ldTitle" placeholder="למשל: מודעת פתיחה / ברכה"></div>
      <div class="field"><label>גיליון</label>
        <select id="ldIssue">${issues.map(i => `<option value="${i.id}" ${nextIssue && i.id === nextIssue.id ? 'selected' : ''}>גיליון ${i.issue_number}${i.publish_date ? ' — ' + heDate(i.publish_date) : ''}</option>`).join('')}</select></div>
      <div class="field"><label>מחיר לפרסום (₪, לפני מע"מ)</label><input id="ldPrice" type="number" dir="ltr" placeholder="ריק = לפי המחירון"></div>
    ` : `
      <div class="field"><label>מספר פרסומים בחבילה</label><input id="ldInserts" type="number" dir="ltr" value="13" onchange="_ldealFillPrice()"></div>
      <div class="field"><label>תדירות</label><select id="ldCadence">${LD_CADENCE.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
      <div class="field"><label>תאריך התחלה</label><input id="ldStart" type="date" value="${today()}"></div>
      <div class="field"><label>מחיר כולל לעסקה (₪, לפני מע"מ)</label><input id="ldPrice" type="number" dir="ltr" placeholder="ריק = גודל × מספר פרסומים"></div>
    `}

    <div class="field"><label>הערות</label><textarea id="ldNotes" rows="2"></textarea></div>

    <div class="m-actions" style="flex-wrap:wrap;margin-top:12px">
      <button class="btn" onclick="leadDealSave(${customerId})">💾 שמירת העסקה</button>
      <button class="btn btn-ghost" onclick="openCustomerCard(${customerId})">דילוג — לכרטיס הלקוח</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* מילוי מחיר אוטומטי מהמחירון */
function _ldealFillPrice() {
  const sel = document.getElementById('ldSize'); if (!sel) return;
  const item = (cache.priceList || []).find(p => String(p.id) === sel.value); if (!item) return;
  const mode = (document.getElementById('ldMode') || {}).value || 'single';
  const priceEl = document.getElementById('ldPrice'); if (!priceEl) return;
  if (mode === 'recurring') {
    const n = Number((document.getElementById('ldInserts') || {}).value) || 1;
    priceEl.value = Math.round(Number(item.price) * n * 100) / 100;
  } else {
    priceEl.value = Number(item.price);
  }
}

/* שמירת העסקה (מודעה או חוזה) */
async function leadDealSave(customerId) {
  const mode = (document.getElementById('ldMode') || {}).value || 'single';
  const cust = (typeof _customers !== 'undefined' && _customers.find(x => x.id === customerId)) || (cache.customers || []).find(x => x.id === customerId) || {};
  const sizeId = (document.getElementById('ldSize') || {}).value || '';
  const item = (cache.priceList || []).find(p => String(p.id) === sizeId);
  const priceRaw = (document.getElementById('ldPrice') || {}).value;
  const notes = (document.getElementById('ldNotes') || {}).value || '';

  try {
    if (typeof checkCustomerStatusGate === 'function') { const okS = await checkCustomerStatusGate(customerId, mode === 'single' ? 'הוספת מודעה' : 'פתיחת חוזה'); if (!okS) return; }
    if (mode === 'single') {
      const issueId = Number((document.getElementById('ldIssue') || {}).value) || null;
      const title = (document.getElementById('ldTitle') || {}).value || (item ? item.name : 'מודעה');
      const price = priceRaw !== '' ? Number(priceRaw) : (item ? Number(item.price) : 0);
      const rec = {
        customer_id: customerId, title, price_item_id: item ? item.id : null, issue_id: issueId,
        price, discount: (typeof custFixedDiscountAmount === 'function' ? custFixedDiscountAmount(customerId, price) : 0), status: 'placed', source: 'manual',
        agent_id: cust.agent_id || null, notes, created_by: (typeof profile !== 'undefined' ? profile.id : null),
      };
      const { error } = await db.from('ads').insert(rec);
      if (error) { toast('שגיאה בשמירת המודעה: ' + error.message, true); return; }
      try { await addInteraction('customer', customerId, `נפתחה עסקה: מודעה — ${title}${item ? ' (' + item.name + ')' : ''} · ${money(price)}`); } catch (e) { }
    } else {
      const inserts = Number((document.getElementById('ldInserts') || {}).value) || 0;
      const total = priceRaw !== '' ? Number(priceRaw) : (item ? Number(item.price) * inserts : 0);
      if (!item || !inserts || !total) { toast('נא לבחור גודל, מספר פרסומים ומחיר', true); return; }
      const cad = (document.getElementById('ldCadence') || {}).value || 'every';
      const payload = {
        customer_id: customerId, agent_id: cust.agent_id || null, price_item_id: item.id,
        total_inserts: inserts, total_price: total, commission_pct: null,
        start_date: (document.getElementById('ldStart') || {}).value || today(),
        active: true, skip_next: false, cadence: cad, selected_dates: [], notes,
      };
      let { error } = await db.from('contracts').insert(payload);
      if (error && /cadence|selected_dates|column/i.test(error.message || '')) {
        const { cadence, selected_dates, ...safe } = payload;
        ({ error } = await db.from('contracts').insert(safe));
      }
      if (error) { toast('שגיאה בשמירת החוזה: ' + error.message, true); return; }
      try { await addInteraction('customer', customerId, `נחתם חוזה: ${(LD_CADENCE.find(x => x[0] === cad) || [])[1] || cad} — ${item.name} × ${inserts} · ${money(total)}`); } catch (e) { }
    }
    if (typeof refreshCache === 'function') await refreshCache();
    _ldealDone(customerId);
  } catch (e) { toast('שגיאה: ' + (e && e.message || e), true); console.error('lead-deal', e); }
}

/* מסך סיום — עם אופציית שליחת חשבונית */
function _ldealDone(customerId) {
  const modal = document.getElementById('viewModal');
  const canInvoice = typeof invIssueOrder === 'function';
  modal.innerHTML = `
    <h3>✅ העסקה נשמרה</h3>
    <p class="muted" style="font-size:.9rem">אפשר להוסיף עסקה נוספת, לשלוח חשבונית ללקוח, או לעבור לכרטיס.</p>
    <div class="m-actions" style="flex-wrap:wrap;margin-top:14px">
      ${canInvoice ? `<button class="btn" onclick="invIssueOrder(${customerId})">🧾 שלח חשבונית ללקוח</button>` : ''}
      <button class="btn btn-ghost" onclick="leadDealForm(${customerId},'single')">➕ עסקה נוספת</button>
      <button class="btn btn-ghost" onclick="openCustomerCard(${customerId})">לכרטיס הלקוח</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}
