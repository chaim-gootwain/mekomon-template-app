/* ============================================================
pending-invoice-popup.js — "ממתינים לחשבונית" בכניסה למערכת
------------------------------------------------------------
פופאפ שקופץ למנהל מיד אחרי ההתחברות, עם כל הלקוחות שיש להם
חיובים בסטטוס pending — כלומר חוב שנרשם אבל עוד לא הופקה עליו
חשבונית (אותה הגדרה כמו הטאב "ממתינים לחשבונית" במסך הגבייה).
מאחורי מתג פר-מופע: settings.pending_invoice_popup ('0' כברירת מחדל).
תצוגה בלבד — שום מסמך לא מופק מכאן.
============================================================ */

'use strict';

function pipOn() { return String((cache.settings || {}).pending_invoice_popup || '0') === '1'; }

/* נקרא משרשרת הפופאפים של afterLogin — מחזיר true אם הוצג חלון */
async function pipCheckPending() {
  try {
    if (typeof profile === 'undefined' || profile.role !== 'admin') return false;
    if (!pipOn()) return false;
    if (document.getElementById('pipOverlay')) return true;
    const _vb = document.getElementById('viewBack');
    if (_vb && _vb.classList.contains('open')) return false; // חלון אחר פתוח — לא דורסים

    const charges = await runAll((f, t) => db.from('charges')
      .select('id,customer_id,amount,description,issued_date')
      .eq('status', 'pending').order('id').range(f, t));
    if (!charges.length) return false;

    const byCust = {};
    charges.forEach(c => {
      const cu = byCust[c.customer_id] = byCust[c.customer_id] || { customer_id: c.customer_id, count: 0, total: 0, oldest: null };
      cu.count++; cu.total += Number(c.amount || 0);
      if (c.issued_date && (!cu.oldest || c.issued_date < cu.oldest)) cu.oldest = c.issued_date;
    });
    const rows = Object.values(byCust).map(cu => {
      const c = (cache.customers || []).find(x => x.id === cu.customer_id) || {};
      return { ...cu, name: c.name || nameOf('customers', cu.customer_id) || 'לקוח' };
    }).sort((a, b) => b.total - a.total);

    pipRender(rows, charges.length);
    return true;
  } catch (e) { console.error('pending-invoice-popup', e); return false; }
}

function pipRender(rows, chargeCount) {
  if (typeof emuEnsureStyles === 'function') emuEnsureStyles();
  const totalSum = rows.reduce((s, r) => s + r.total, 0);
  const list = rows.slice(0, 20).map(r =>
    `<li style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #eee">
      <span><b>${esc(r.name)}</b> <span class="muted">· ${r.count} ${r.count === 1 ? 'חיוב' : 'חיובים'}${r.oldest ? ' · מ-' + heDate(r.oldest) : ''}</span></span>
      <span style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <b>${money(r.total)}</b>
        <button class="btn btn-sm btn-ghost" onclick="pipOpenCustomer(${r.customer_id})">פתח כרטיס</button>
      </span>
    </li>`).join('');
  const ov = document.createElement('div');
  ov.id = 'pipOverlay';
  ov.className = 'emu-overlay';
  ov.innerHTML = `<div class="emu-oops" style="max-width:520px;text-align:right">
    <div style="text-align:center" class="ic">🧾</div>
    <p style="text-align:center;margin:8px 0 6px"><b>ממתינים לחשבונית</b><br>
    <span style="font-size:.9rem;color:#555">${rows.length} לקוחות · ${chargeCount} חיובים · סה"כ ${money(totalSum)}</span></p>
    <ul style="list-style:none;margin:6px 0 14px;padding:0;max-height:46vh;overflow:auto">${list}
    ${rows.length > 20 ? `<li class="muted" style="padding:6px 4px">ועוד ${rows.length - 20} לקוחות — הרשימה המלאה במסך הגבייה</li>` : ''}</ul>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="btn btn-sm" id="pipBilling">למסך הגבייה</button>
      <button class="btn btn-sm btn-ghost" id="pipClose">סגור</button>
    </div>
  </div>`;
  ov.querySelector('#pipClose').addEventListener('click', () => ov.remove());
  ov.querySelector('#pipBilling').addEventListener('click', () => { ov.remove(); openPage('billing'); });
  document.body.appendChild(ov);
}

function pipOpenCustomer(id) {
  document.getElementById('pipOverlay')?.remove();
  openPage('customers').then(() => window.openCustomerCard && openCustomerCard(id));
}

/* כרטיס הגדרות (מנהל) — מתג הפופאפ */
function pipSettingsCard() {
  return `
<div class="card card-pad">
<b>פופאפ "ממתינים לחשבונית" בכניסה 🧾</b>
<p class="muted" style="font-size:.82rem">בכל כניסה למערכת קופץ למנהל חלון עם הלקוחות שיש להם חיובים שטרם הופקה עליהם חשבונית, כולל סכומים וקיצור לכרטיס הלקוח. תצוגה בלבד — שום מסמך לא מופק אוטומטית.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setPipPopup" ${pipOn() ? 'checked' : ''} onchange="pipToggle(this.checked)" style="width:18px;height:18px">
הפופאפ פעיל במופע הזה
</label>
</div>`;
}

async function pipToggle(on) {
  await run(db.from('settings').upsert({ key: 'pending_invoice_popup', value: on ? '1' : '0' }));
  cache.settings.pending_invoice_popup = on ? '1' : '0';
  toast(on ? 'הפופאפ יופיע בכניסה הבאה למערכת' : 'הפופאפ כובה');
}
