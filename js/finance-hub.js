/* ============================================================
   finance-hub.js — מרכז כספים: תמונה כספית אחת מרוכזת
   ------------------------------------------------------------
   מרכז במסך אחד: חוב כולל + גיל חוב, הכנסות מול הוצאות החודש,
   צפוי להיגבות + מזומן משוער, ולקוחות עם החוב הגבוה.
   נשען על הטבלאות הקיימות (charges/payments/expenses) — אין סכימה חדשה.
   ============================================================ */

'use strict';

const FH_OPEN = ['pending', 'invoiced', 'partial', 'overdue'];
const FH_DEAD = ['cancelled', 'lost'];

function _fhDaysOver(dateStr) {
  if (!dateStr) return 0;
  const d = Date.parse(String(dateStr).slice(0, 10));
  if (isNaN(d)) return 0;
  return Math.floor((Date.parse(today()) - d) / 86400000);
}
function _fhAgeDate(c) { return c.due_date || c.issued_date; }
function _fhMonLabel(ym) { const p = ym.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, 1).toLocaleDateString('he-IL', { month: 'short' }); }
function _fhBar(val, max, color, h) { const w = max > 0 ? Math.round(val / max * 100) : 0; return `<div style="background:${color};height:${h || 8}px;border-radius:4px;width:${w}%;min-width:${val > 0 ? 3 : 0}px"></div>`; }

Pages.finhub = {
  render: async (el) => {
    const isAdmin = profile.role === 'admin';
    el.innerHTML = `<div class="page-head"><h2>💰 מרכז כספים</h2>
      <div class="actions">
        <button class="btn btn-ghost btn-sm" onclick="openPage('billing')">גבייה</button>
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openPage('cashflow')">תזרים</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="openPage('reports')">דו״חות</button>
        <button class="btn btn-ghost btn-sm" onclick="invReconcileOpen()">🔗 השלמת חוב מחשבוניות</button>
      </div></div>
      <div id="fhBody"><div class="empty">טוען נתונים כספיים...</div></div>`;

    const t = today();
    const mNow = thisMonth();
    const sixAgo = (() => { const d = new Date(); d.setMonth(d.getMonth() - 5); d.setDate(1); return d.toISOString().slice(0, 10); })();
    const yearStart = t.slice(0, 4) + '-01-01';

    const [openCh, recentCh, expenses, payments] = await Promise.all([
      run(db.from('charges').select('id,customer_id,amount,status,due_date,issued_date').in('status', FH_OPEN).limit(4000)),
      run(db.from('charges').select('amount,status,issued_date').gte('issued_date', sixAgo).not('status', 'in', '("cancelled","lost")').limit(4000)),
      isAdmin ? run(db.from('expenses').select('amount,status,expense_date').gte('expense_date', sixAgo).limit(2000)) : [],
      isAdmin ? run(db.from('payments').select('amount,paid_date').gte('paid_date', yearStart).limit(4000)) : [],
    ]);

    /* ---- מדדים ---- */
    const totalDebt = openCh.reduce((s, c) => s + Number(c.amount || 0), 0);
    const overdueAmt = openCh.filter(c => c.due_date && c.due_date < t).reduce((s, c) => s + Number(c.amount || 0), 0);
    const t30 = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); })();
    const expected30 = openCh.filter(c => c.due_date && c.due_date >= t && c.due_date <= t30).reduce((s, c) => s + Number(c.amount || 0), 0);
    const revMonth = recentCh.filter(c => String(c.issued_date || '').slice(0, 7) === mNow).reduce((s, c) => s + Number(c.amount || 0), 0);
    const expMonth = expenses.filter(e => String(e.expense_date || '').slice(0, 7) === mNow).reduce((s, e) => s + Number(e.amount || 0), 0);
    const profitMonth = revMonth - expMonth;
    const opening = Number((cache.settings || {}).opening_balance || 0);
    const paidThisYear = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const expPaidYear = expenses.filter(e => e.status === 'paid').reduce((s, e) => s + Number(e.amount || 0), 0);
    const cashEst = opening + paidThisYear - expPaidYear;

    let kpis = '';
    kpis += stat(money(totalDebt) || '₪0', 'חוב פתוח כולל' + (overdueAmt > 0 ? ` · <b style="color:var(--danger)">${money(overdueAmt)} באיחור</b>` : ''), totalDebt > 0 ? 'red' : '');
    kpis += stat(money(expected30) || '₪0', 'צפוי להיגבות ב-30 יום');
    kpis += stat(money(revMonth) || '₪0', 'הכנסות החודש');
    if (isAdmin) {
      kpis += stat(money(expMonth) || '₪0', 'הוצאות החודש');
      kpis += stat(money(profitMonth), 'רווח החודש', profitMonth < 0 ? 'red' : 'gold');
      kpis += stat(money(cashEst), 'מזומן משוער', cashEst < 0 ? 'red' : '');
    }

    /* ---- גיל חוב ---- */
    const buckets = [
      { k: 'future', t: 'טרם פירעון', sum: 0, color: '#0369a1' },
      { k: 'b30', t: '1–30 יום', sum: 0, color: '#65a30d' },
      { k: 'b60', t: '31–60 יום', sum: 0, color: '#d97706' },
      { k: 'b90', t: '61–90 יום', sum: 0, color: '#ea580c' },
      { k: 'b90p', t: '90+ יום', sum: 0, color: '#b91c1c' },
    ];
    openCh.forEach(c => {
      const days = _fhDaysOver(_fhAgeDate(c)), amt = Number(c.amount || 0);
      let b;
      if (days <= 0) b = buckets[0];
      else if (days <= 30) b = buckets[1];
      else if (days <= 60) b = buckets[2];
      else if (days <= 90) b = buckets[3];
      else b = buckets[4];
      b.sum += amt;
    });
    const agingMax = Math.max(1, ...buckets.map(b => b.sum));
    const agingHtml = `<div class="card card-pad">
      <b>גיל החוב</b>
      <table class="data" style="margin-top:10px">
        <tbody>${buckets.map(b => `<tr>
          <td style="width:110px">${b.t}</td>
          <td style="min-width:120px"><div style="background:#eef2f7;border-radius:4px;overflow:hidden">${_fhBar(b.sum, agingMax, b.color, 14)}</div></td>
          <td style="text-align:left;font-weight:700;color:${b.color}">${money(b.sum) || '₪0'}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr style="border-top:2px solid var(--line)"><td><b>סה״כ</b></td><td></td><td style="text-align:left"><b>${money(totalDebt) || '₪0'}</b></td></tr></tfoot>
      </table></div>`;

    /* ---- הכנסות מול הוצאות 6 חודשים ---- */
    const months = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)); }
    const trend = months.map(ym => ({
      ym,
      rev: recentCh.filter(c => String(c.issued_date || '').slice(0, 7) === ym).reduce((s, c) => s + Number(c.amount || 0), 0),
      exp: expenses.filter(e => String(e.expense_date || '').slice(0, 7) === ym).reduce((s, e) => s + Number(e.amount || 0), 0),
    }));
    const trendMax = Math.max(1, ...trend.map(m => Math.max(m.rev, m.exp)));
    const trendHtml = `<div class="card card-pad">
      <b>הכנסות מול הוצאות · 6 חודשים</b>
      <div style="margin-top:6px;font-size:.75rem;color:var(--muted)">
        <span style="color:var(--ok)">■ הכנסות</span> &nbsp; ${isAdmin ? '<span style="color:var(--danger)">■ הוצאות</span>' : ''}</div>
      <table class="data" style="margin-top:8px"><tbody>
      ${trend.map(m => `<tr>
        <td style="width:70px">${_fhMonLabel(m.ym)}</td>
        <td><div style="display:flex;flex-direction:column;gap:3px">
          ${_fhBar(m.rev, trendMax, 'var(--ok)', 9)}
          ${isAdmin ? _fhBar(m.exp, trendMax, 'var(--danger)', 9) : ''}
        </div></td>
        <td style="text-align:left;white-space:nowrap">
          <span style="color:var(--ok)">${money(m.rev) || '₪0'}</span>
          ${isAdmin ? `<br><span style="color:var(--danger)">${money(m.exp) || '₪0'}</span>` : ''}
        </td>
      </tr>`).join('')}
      </tbody></table></div>`;

    /* ---- לקוחות עם החוב הגבוה ---- */
    const byCust = {};
    openCh.forEach(c => {
      const id = c.customer_id; if (!id) return;
      if (!byCust[id]) byCust[id] = { id, sum: 0, oldest: 0 };
      byCust[id].sum += Number(c.amount || 0);
      const days = _fhDaysOver(_fhAgeDate(c));
      if (days > byCust[id].oldest) byCust[id].oldest = days;
    });
    const top = Object.values(byCust).sort((a, b) => b.sum - a.sum).slice(0, 10);
    const custPhone = id => { const c = (cache.customers || []).find(x => x.id === id); return c ? c.phone : ''; };
    const topHtml = `<div class="card">
      <div class="card-pad"><b>לקוחות עם החוב הגבוה</b>
        <span class="muted" style="font-size:.8rem"> · לחיצה פותחת כרטיס</span></div>
      ${top.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>לקוח</th><th>חוב פתוח</th><th>הכי ישן</th><th>פעולות</th></tr></thead>
        <tbody>${top.map(r => `<tr onclick="openCustomerCard(${r.id})" style="cursor:pointer">
          <td>${esc(nameOf('customers', r.id)) || '—'}</td>
          <td style="font-weight:700;color:var(--danger)">${money(r.sum)}</td>
          <td>${r.oldest > 0 ? r.oldest + ' ימים' : '<span class="muted">טרם</span>'}</td>
          <td onclick="event.stopPropagation()" style="white-space:nowrap">
            ${phoneBtn(custPhone(r.id))}
            ${typeof collReminderBtn === 'function' ? collReminderBtn(r.id, r.sum) : ''}
            <button class="btn btn-sm btn-ghost" onclick="customerStatement(${r.id})">כרטסת</button>
          </td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="card-pad"><div class="empty">אין חוב פתוח 👍</div></div>'}
      </div>`;

    document.getElementById('fhBody').innerHTML = `
      <div class="stats">${kpis}</div>
      <div class="dash-grid" style="margin:16px 0">${agingHtml}${trendHtml}</div>
      ${topHtml}
      ${isAdmin ? `<p class="muted" style="font-size:.76rem;margin-top:10px">מזומן משוער = יתרת פתיחה + תקבולים מתחילת השנה − הוצאות ששולמו. לתחזית מדויקת ראה מסך התזרים.</p>` : ''}`;
  }
};
