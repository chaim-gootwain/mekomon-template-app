/* ============================================================
collections.js — גבייה: דו"ח חוב לפי גיל · סף התראה · אזהרת חוב בהכנסת מודעה
------------------------------------------------------------
- מוזרק לעמוד הגבייה (עטיפת Pages.billing.render) ולזרימת המודעות
- נשען על הטבלאות הקיימות charges + payments (אין טבלה חדשה)
- תזכורת וואטסאפ = קישור wa.me (שליחה ידנית, בלי API, בלי סיכון חסימה)
============================================================ */

'use strict';

const COLL_OPEN_STATUSES = ['pending', 'invoiced', 'partial', 'overdue'];

function debtThreshold() {
  const v = Number((cache.settings || {}).debt_alert_threshold);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}
function managerPin() { return String((cache.settings || {}).manager_pin || ''); }

function _collDaysOverdue(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr), now = new Date();
  return Math.floor((now - d) / 86400000);
}

// יתרה פתוחה ללקוח (חיובים פתוחים פחות תשלומים) + מועד החוב הישן ביותר
async function customerOpenBalance(customerId) {
  const charges = await run(db.from('charges').select('id,amount,due_date,status')
    .eq('customer_id', customerId).in('status', COLL_OPEN_STATUSES));
  if (!charges.length) return { total: 0, oldestDue: null, count: 0 };
  const ids = charges.map(c => c.id);
  const paid = {};
  try {
    const pays = await run(db.from('payments').select('charge_id,amount').in('charge_id', ids));
    pays.forEach(p => { paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount); });
  } catch (e) { /* אין תשלומים */ }
  let total = 0, oldestDue = null;
  const T = today();
  for (const c of charges) {
    const bal = Number(c.amount) - (paid[c.id] || 0);
    if (bal > 0) {
      total += bal;
      if (c.due_date && c.due_date < T && (!oldestDue || c.due_date < oldestDue)) oldestDue = c.due_date;
    }
  }
  return { total, oldestDue, count: charges.length };
}

/* ---------- שער חוב לפני הכנסת מודעה: אזהרה + אישור מנהל ---------- */
async function checkDebtGate(customerId, actionLabel) {
  try {
    if (!customerId) return true;
    const bal = await customerOpenBalance(customerId);
    if (bal.total <= debtThreshold()) return true;
    return await showDebtGateModal(customerId, bal, actionLabel);
  } catch (e) { return true; } // בכשל בדיקה לא חוסמים את העבודה
}

function showDebtGateModal(customerId, bal, actionLabel) {
  return new Promise(resolve => {
    emuEnsureStyles();
    const custName = nameOf('customers', customerId);
    const ageTxt = bal.oldestDue ? (_collDaysOverdue(bal.oldestDue) + ' ימים באיחור') : 'טרם הגיע מועד';
    const isAdmin = profile.role === 'admin';
    const pin = managerPin();
    const ov = document.createElement('div');
    ov.className = 'emu-overlay';
    ov.innerHTML = `<div class="emu-oops" style="max-width:460px">
      <div class="ic">⚠️</div>
      <p style="margin:10px 0 6px"><b>ללקוח ${esc(custName)} יש חוב פתוח</b><br>
        <span style="font-size:1.15rem;color:#c0392b;font-weight:800">${money(bal.total)}</span>
        <span style="font-size:.85rem;color:#555"> · ${ageTxt}</span><br>
        <span style="font-size:.85rem;color:#555">מעל סף ההתראה (${money(debtThreshold())}).${actionLabel ? ' ' + esc(actionLabel) : ''}</span></p>
      ${(!isAdmin && pin) ? `<input id="dgPin" type="password" placeholder="קוד אישור מנהל" style="padding:8px;border:1px solid #e5e7eb;border-radius:8px;width:70%;text-align:center;margin:6px 0">` : ''}
      ${(!isAdmin && !pin) ? `<p style="font-size:.8rem;color:#8a5a00;background:#fff7e6;border:1px solid #ffe0a3;border-radius:8px;padding:8px">פעולה זו דורשת אישור מנהל. ההמשך יירשם ביומן הלקוח.</p>` : ''}
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-sm btn-ghost" id="dgCancel">ביטול</button>
        <button class="btn btn-sm" id="dgProceed">${isAdmin ? 'אשר והמשך' : 'המשך באישור מנהל'}</button>
      </div>
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('#dgCancel').addEventListener('click', () => { close(); resolve(false); });
    ov.querySelector('#dgProceed').addEventListener('click', async () => {
      if (!isAdmin && pin) {
        const entered = (ov.querySelector('#dgPin') || {}).value || '';
        if (entered !== pin) { toast('קוד מנהל שגוי', true); return; }
      }
      try { await addInteraction('customer', customerId, `מודעה אושרה למרות חוב פתוח (${money(bal.total)}) — ${profile.full_name || ''}`); } catch (e) { }
      close(); resolve(true);
    });
    document.body.appendChild(ov);
  });
}

/* ---------- תזכורת חוב בוואטסאפ (פיצ'ר #1) ---------- */
// מתג פר-מופע: הכפתורים מוצגים רק כשהוא דלוק (settings.whatsapp_enabled).
function waRemindersOn() { return String((cache.settings || {}).whatsapp_enabled || '0') === '1'; }

// שליחת תזכורת: מחשב יתרה עדכנית, בונה הודעה מנומסת עם פירוט,
// פותח wa.me (שליחה ידנית — בלי API), ורושם לוג ב-debt_reminders.
// תזכורת בלבד — שום חיוב לא מתבצע מכאן.
async function debtReminderSend(customerId) {
  const cust = (cache.customers || []).find(c => c.id === customerId);
  if (!cust) { toast('לקוח לא נמצא', true); return; }
  const raw = String(cust.whatsapp || cust.phone || '').replace(/\D/g, '');
  if (!raw) { toast('ללקוח אין מספר טלפון/וואטסאפ', true); return; }
  let intl = raw;
  if (intl.startsWith('0')) intl = '972' + intl.slice(1);
  else if (!intl.startsWith('972')) intl = '972' + intl;

  toast('מחשב יתרה...');
  const bal = await customerOpenBalance(customerId);
  if (!(bal.total > 0)) { toast('אין ללקוח חוב פתוח 👍', true); return; }

  const ageTxt = bal.oldestDue ? ` (הוותיק שבהם מ-${heDate(bal.oldestDue)})` : '';
  const msg = `שלום ${cust.name || ''}, כאן @@PAPER_NAME@@.\n` +
    `תזכורת ידידותית: קיימת יתרת חוב פתוחה של ${money(bal.total)} על ${bal.count} חיובים${ageTxt}.\n` +
    `נשמח להסדרה בהקדם. לפירוט מלא או לתיאום תשלום: @@PAPER_PHONE@@.\nתודה רבה! 🙏`;

  window.open(`https://wa.me/${intl}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');

  // לוג — נכשל בשקט אם המיגרציה debt_reminders עוד לא הורצה במופע
  try {
    await db.from('debt_reminders').insert({
      customer_id: customerId, amount: Math.round(bal.total * 100) / 100,
      channel: 'whatsapp', message: msg, status: 'opened', created_by: profile.id
    });
  } catch (e) { console.warn('debt_reminders log', e); }
  try { await addInteraction('customer', customerId, `💬 נשלחה תזכורת חוב בוואטסאפ (${money(bal.total)})`); } catch (e) { }
  toast('✓ נפתח וואטסאפ עם התזכורת — נרשם ביומן');
}

/* ---------- דו"ח חוב לפי גיל (מוזרק לעמוד הגבייה) ---------- */
function collReminderBtn(customerId, total) {
  if (!waRemindersOn()) return '';
  const cust = (cache.customers || []).find(c => c.id === customerId);
  if (!cust || !(cust.whatsapp || cust.phone)) return '';
  return `<button class="btn btn-sm btn-ghost" onclick="debtReminderSend(${customerId})">💬 תזכורת</button>`;
}

/* כרטיס הגדרות קטן — מתג התזכורות (מוצג במסך ההגדרות של המנהל) */
function collSettingsCard() {
  const on = waRemindersOn();
  return `
<div class="card card-pad">
<b>תזכורות חוב בוואטסאפ 💬</b>
<p class="muted" style="font-size:.82rem">כפתור "שלח תזכורת חוב" בכרטיס הלקוח ובדו"ח הגבייה: פותח וואטסאפ עם הודעה מנוסחת הכוללת את היתרה, ורושם לוג. תזכורת בלבד — שום חיוב לא מתבצע.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setWaReminders" ${on ? 'checked' : ''} onchange="collToggleWaReminders(this.checked)" style="width:18px;height:18px">
תזכורות וואטסאפ פעילות במופע הזה
</label>
</div>`;
}

async function collToggleWaReminders(on) {
  await run(db.from('settings').upsert({ key: 'whatsapp_enabled', value: on ? '1' : '0' }));
  cache.settings.whatsapp_enabled = on ? '1' : '0';
  toast(on ? 'תזכורות וואטסאפ הופעלו' : 'תזכורות וואטסאפ כובו');
}

async function collRenderAging(el) {
  if (typeof _charges === 'undefined' || !_charges) return;
  const open = _charges.filter(c => COLL_OPEN_STATUSES.includes(c.status));
  if (!open.length) return;
  const ids = open.map(c => c.id);
  const paid = {};
  try {
    const pays = await run(db.from('payments').select('charge_id,amount').in('charge_id', ids));
    pays.forEach(p => { paid[p.charge_id] = (paid[p.charge_id] || 0) + Number(p.amount); });
  } catch (e) { }
  const byCust = {};
  const T = today();
  for (const c of open) {
    const bal = Number(c.amount) - (paid[c.id] || 0);
    if (bal <= 0) continue;
    const cu = byCust[c.customer_id] = byCust[c.customer_id] || { notDue: 0, b1: 0, b2: 0, b3: 0, b4: 0, total: 0 };
    if (!(c.due_date && c.due_date < T)) cu.notDue += bal;
    else {
      const days = _collDaysOverdue(c.due_date);
      if (days <= 30) cu.b1 += bal; else if (days <= 60) cu.b2 += bal; else if (days <= 90) cu.b3 += bal; else cu.b4 += bal;
    }
    cu.total += bal;
  }
  const rows = Object.entries(byCust)
    .sort((a, b) => (b[1].b4 + b[1].b3) - (a[1].b4 + a[1].b3) || b[1].total - a[1].total);
  if (!rows.length) return;
  const fmt = n => n > 0 ? money(n) : '<span class="muted">—</span>';
  if (document.getElementById('collAging')) return; // כבר מוזרק
  const html = `<div class="card card-pad" id="collAging" style="margin-top:16px">
    <b>📊 דו"ח חוב לפי גיל</b>
    <p class="muted" style="font-size:.8rem;margin:4px 0 8px">ככל שהחוב ישן יותר (ימין) — הסיכון גבוה יותר</p>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>לקוח</th><th>סה"כ חוב</th><th>טרם מועד</th><th>1–30</th><th>31–60</th><th>61–90</th><th>90+</th><th></th></tr></thead>
      <tbody>${rows.map(([cid, u]) => `<tr>
        <td><b>${esc(nameOf('customers', Number(cid)))}</b></td>
        <td><b>${money(u.total)}</b></td>
        <td>${fmt(u.notDue)}</td>
        <td>${fmt(u.b1)}</td>
        <td${u.b2 > 0 ? ' style="color:#e67e22"' : ''}>${fmt(u.b2)}</td>
        <td${u.b3 > 0 ? ' style="color:#d35400"' : ''}>${fmt(u.b3)}</td>
        <td${u.b4 > 0 ? ' style="color:#c0392b;font-weight:800"' : ''}>${fmt(u.b4)}</td>
        <td style="white-space:nowrap">${collReminderBtn(Number(cid), u.total)} <button class="btn btn-sm btn-ghost" onclick="customerStatement(${Number(cid)})">📄 כרטסת</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
  el.insertAdjacentHTML('beforeend', html);
}

/* עטיפת עמוד הגבייה — הזרקת דו"ח הגיל בסוף */
(function () {
  if (typeof Pages === 'undefined' || !Pages.billing) return;
  const orig = Pages.billing.render;
  if (typeof orig === 'function' && !orig._collWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try { await collRenderAging(el); } catch (e) { console.error('aging', e); }
      return r;
    };
    wrapped._collWrapped = true;
    Pages.billing.render = wrapped;
  }
})();
