/* ============================================================
   notifications.js — פעמון התראות יזומות
   ------------------------------------------------------------
   מרכז: דדליין מודעות מתקרב/עבר · חוב באיחור · ליד למעקב
   כל התראת חוב מאפשרת שליחת תזכורת ללקוח כטיוטה (וואטסאפ/מייל)
   ============================================================ */

'use strict';

let _notifItems = [];

async function notifBuild() {
  const role = profile.role, T = today(), items = [];
  const canSales = ['admin', 'sales'].includes(role);
  let leads = [], charges = [], issues = [];
  const jobs = [];
  jobs.push(db.from('issues').select('id,issue_number,ads_deadline,status')
    .not('status', 'in', '("closed","published")').then(r => issues = r.data || []));
  if (canSales) {
    jobs.push(db.from('leads').select('id,name,phone,status,follow_up,agent_id')
      .not('status', 'in', '("won","lost")').lte('follow_up', T).then(r => leads = r.data || []));
    jobs.push(db.from('charges').select('id,customer_id,amount,status,due_date')
      .in('status', ['pending', 'invoiced', 'partial', 'overdue']).then(r => charges = r.data || []));
  }
  await Promise.all(jobs);

  const now = Date.now(), soon = now + 48 * 3600 * 1000;
  issues.forEach(i => {
    if (!i.ads_deadline) return;
    const d = new Date(i.ads_deadline).getTime(); if (isNaN(d)) return;
    if (d >= now && d <= soon) items.push({ type: 'deadline', prio: 1, icon: '⏰', text: 'דדליין מודעות מתקרב — גיליון ' + i.issue_number, sub: heDateTime(i.ads_deadline), onclick: 'openFlatplan(' + i.id + ')' });
    else if (d < now) items.push({ type: 'deadline', prio: 0, icon: '❗', text: 'עבר דדליין מודעות — גיליון ' + i.issue_number, sub: heDateTime(i.ads_deadline), onclick: 'openFlatplan(' + i.id + ')' });
  });
  const byC = {};
  charges.forEach(c => { if (c.due_date && c.due_date < T) byC[c.customer_id] = (byC[c.customer_id] || 0) + Number(c.amount || 0); });
  Object.entries(byC).forEach(([cid, amt]) => { if (amt > 0) items.push({ type: 'debt', prio: 2, icon: '💰', text: 'חוב באיחור — ' + (nameOf('customers', Number(cid)) || 'לקוח'), sub: money(amt), cid: Number(cid), amt }); });
  leads.forEach(l => items.push({ type: 'lead', prio: 3, icon: '📞', text: 'מעקב ליד — ' + l.name, sub: l.follow_up ? heDate(l.follow_up) : '', onclick: "openPage('leads')" }));

  items.sort((a, b) => a.prio - b.prio);
  return items;
}

async function notifRefresh() {
  if (!document.getElementById('notifBell')) return;
  try { _notifItems = await notifBuild(); } catch (e) { _notifItems = []; }
  const b = document.getElementById('notifCount');
  if (b) { b.textContent = _notifItems.length; b.classList.toggle('hidden', !_notifItems.length); }
}

function _notifMailBtn(cid, amt) {
  const c = (cache.customers || []).find(x => x.id === cid);
  if (!c || !c.email) return '';
  const subj = encodeURIComponent('תזכורת יתרת חוב — @@PAPER_NAME@@');
  const body = encodeURIComponent('שלום,\nרצינו להזכיר בעדינות שקיימת יתרת חוב פתוחה של ' + money(amt) + '.\nנשמח להסדרה בהקדם. תודה רבה!\n@@PAPER_NAME@@');
  return '<a class="btn btn-sm btn-ghost" href="mailto:' + c.email + '?subject=' + subj + '&body=' + body + '">✉️ מייל</a>';
}

function notifToggle() {
  const dd = document.getElementById('notifDrop'); if (!dd) return;
  if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
  const items = _notifItems || [];
  dd.innerHTML = `<div class="notif-head">התראות (${items.length})</div>` + (items.length ? items.map(it => {
    let actions = '';
    if (it.type === 'debt') actions = `<div class="notif-actions">${(typeof collReminderBtn === 'function' ? collReminderBtn(it.cid, it.amt) : '')}${_notifMailBtn(it.cid, it.amt)}<button class="btn btn-sm btn-ghost" onclick="notifClose();openCustomerCard(${it.cid})">כרטיס</button></div>`;
    const click = it.onclick ? `onclick="notifClose();${it.onclick}"` : '';
    return `<div class="notif-item">
      <div class="notif-row" ${click} style="${it.onclick ? 'cursor:pointer' : ''}">
        <span class="notif-ico">${it.icon}</span>
        <div><div class="notif-text">${esc(it.text)}</div><div class="notif-sub">${it.sub || ''}</div></div>
      </div>${actions}</div>`;
  }).join('') : '<div class="notif-empty">אין התראות פתוחות 👍</div>');
  dd.classList.remove('hidden');
}
function notifClose() { const dd = document.getElementById('notifDrop'); if (dd) dd.classList.add('hidden'); }

async function notifInit() {
  await notifRefresh();
  if (window._notifTimer) clearInterval(window._notifTimer);
  window._notifTimer = setInterval(notifRefresh, 5 * 60 * 1000);
  document.addEventListener('click', e => {
    const bell = document.getElementById('notifBell'), dd = document.getElementById('notifDrop');
    if (dd && !dd.classList.contains('hidden') && !dd.contains(e.target) && bell && !bell.contains(e.target)) dd.classList.add('hidden');
  });
}
