/* ============================================================
customer-tasks.js — משימות ותזכורות ללקוח (פיצ'ר 3)
------------------------------------------------------------
- סעיף "משימות" בכרטיס הלקוח: הוספת משימה (כותרת + תאריך יעד),
  רשימת פתוחות עם סימון "בוצע", מודגש באדום אם באיחור.
- וידג'ט "משימות היום / באיחור" בדף הבית (לכל הלקוחות).
- נשען על טבלת customer_tasks (מיגרציה בתור). אם חסרה — מסר מסודר.
פונקציות:
  custTasksRender(customerId)  — מרנדר את סעיף המשימות בכרטיס.
  custTaskAdd(customerId)      — מוסיף משימה חדשה מהשדות.
  custTaskDone(id, customerId) — מסמן משימה כבוצעה.
  custMyTasksWidget()          — מרנדר את וידג'ט דף הבית.
  _ctMissing(err)              — מזהה שגיאת "טבלה חסרה" (לפני מיגרציה).
============================================================ */

'use strict';

/* מזהה אם השגיאה היא בגלל שהטבלה עדיין לא קיימת (מיגרציה בתור) */
function _ctMissing(err) { return /customer_tasks|does not exist|relation .* does not exist|42P01|schema cache/i.test(String((err && err.message) || err || '')); }

/* האם משימה פתוחה באיחור (יש תאריך יעד שעבר) */
function _ctOverdue(t) { return !t.done && t.due_date && t.due_date < today(); }

/* מרנדר את סעיף המשימות בכרטיס הלקוח (טוען פתוחות + מציג טופס הוספה) */
async function custTasksRender(customerId) {
  const box = document.getElementById('ctSection'); if (!box) return;
  let tasks = null, missing = false;
  try {
    const r = await db.from('customer_tasks').select('*').eq('customer_id', customerId).eq('done', false).order('due_date', { ascending: true });
    if (r.error) { if (_ctMissing(r.error)) missing = true; else throw r.error; } else tasks = r.data || [];
  } catch (e) { missing = _ctMissing(e); if (!missing) { box.innerHTML = '<p class="muted" style="font-size:.85rem">שגיאה בטעינת משימות</p>'; return; } }

  if (missing) {
    box.innerHTML = `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;background:#fbfdff">
      <b>✅ משימות</b><p class="muted" style="font-size:.83rem;margin-top:6px">התכונה תופעל לאחר עדכון מסד הנתונים (ממתין ל-Supabase).</p></div>`;
    return;
  }

  const rows = (tasks || []).map(t => `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0">
      <span><b>${esc(t.title)}</b>${t.due_date ? ` <span style="font-size:.8rem;color:${_ctOverdue(t) ? '#b91c1c' : '#64748b'}">· ${heDate(t.due_date)}${_ctOverdue(t) ? ' ⏰' : ''}</span>` : ''}</span>
      <button class="btn btn-sm btn-ghost" onclick="custTaskDone(${t.id}, ${customerId})">✓ בוצע</button></li>`).join('');

  box.innerHTML = `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;background:#fbfdff">
    <b>✅ משימות (${(tasks || []).length})</b>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      <input id="ctTitle" placeholder="משימה חדשה (למשל: להתקשר לחידוש)" style="flex:1;min-width:160px">
      <input id="ctDue" type="date" style="width:auto">
      <button class="btn btn-sm" onclick="custTaskAdd(${customerId})">+ הוסף</button>
    </div>
    ${(tasks || []).length ? `<ul class="dash-list" style="margin-top:8px">${rows}</ul>` : '<p class="muted" style="font-size:.83rem;margin-top:8px">אין משימות פתוחות</p>'}
  </div>`;
}

/* מוסיף משימה חדשה מהשדות בכרטיס */
async function custTaskAdd(customerId) {
  const title = (document.getElementById('ctTitle') || {}).value || '';
  const due = (document.getElementById('ctDue') || {}).value || null;
  if (!title.trim()) { toast('נא להזין כותרת למשימה', true); return; }
  const rec = { customer_id: customerId, title: title.trim(), due_date: due, done: false, created_by: (typeof profile !== 'undefined' ? profile.id : null) };
  const { error } = await db.from('customer_tasks').insert(rec);
  if (error) { toast(_ctMissing(error) ? 'התכונה תופעל לאחר עדכון מסד הנתונים' : ('שגיאה: ' + error.message), true); return; }
  try { await addInteraction('customer', customerId, `✅ נוספה משימה: ${title.trim()}${due ? ' (עד ' + heDate(due) + ')' : ''}`); } catch (e) { }
  toast('המשימה נוספה');
  custTasksRender(customerId);
}

/* מסמן משימה כבוצעה */
async function custTaskDone(id, customerId) {
  const { error } = await db.from('customer_tasks').update({ done: true, done_at: new Date().toISOString() }).eq('id', id);
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  toast('✓ בוצע');
  custTasksRender(customerId);
  if (document.getElementById('dashTasks')) custMyTasksWidget();
}

/* וידג'ט דף הבית: משימות פתוחות שהגיע/עבר מועדן (לכל הלקוחות) */
async function custMyTasksWidget() {
  const box = document.getElementById('dashTasks'); if (!box) return;
  let tasks = null, missing = false;
  try {
    const r = await db.from('customer_tasks').select('*').eq('done', false).not('due_date', 'is', null).lte('due_date', today()).order('due_date', { ascending: true }).limit(12);
    if (r.error) { missing = _ctMissing(r.error); if (!missing) { box.innerHTML = ''; return; } } else tasks = r.data || [];
  } catch (e) { box.innerHTML = ''; return; }
  if (missing) { box.innerHTML = ''; return; }              // לפני מיגרציה — לא מציגים כלום
  if (!(tasks || []).length) { box.innerHTML = ''; return; } // אין משימות — לא מציגים כלום

  const items = tasks.map(t => `<li onclick="openCustomerCard(${t.customer_id})" style="cursor:pointer;display:flex;justify-content:space-between;gap:8px">
      <span><b>${esc(t.title)}</b> <span class="muted">· ${esc(nameOf('customers', t.customer_id))}</span></span>
      <span style="color:${t.due_date < today() ? '#b91c1c' : '#64748b'};white-space:nowrap">${heDate(t.due_date)}${t.due_date < today() ? ' ⏰' : ''}</span></li>`).join('');
  box.innerHTML = `<div class="card card-pad" style="margin-top:12px;border:1px solid #fde68a;background:#fffbeb">
    <b style="color:#92400e">✅ משימות לביצוע (${tasks.length})</b>
    <ul class="dash-list" style="margin-top:8px">${items}</ul></div>`;
}

/* עטיפת openCustomerCard — הזרקת סעיף משימות */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._ctWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (['admin', 'sales'].includes(profile.role)) {
          const modal = document.getElementById('viewModal');
          if (modal && !document.getElementById('ctSection')) {
            const div = document.createElement('div');
            div.id = 'ctSection'; div.style.cssText = 'margin-top:12px';
            (document.getElementById('ccExtra') || modal).appendChild(div);
            custTasksRender(id);
          }
        }
      } catch (e) { console.error('cust-tasks wrap', e); }
      return r;
    };
    wrapped._ctWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();

/* עטיפת דשבורד דף הבית — הוספת וידג'ט משימות */
(function () {
  if (typeof Pages !== 'undefined' && Pages.dash && Pages.dash.render && !Pages.dash.render._ctWrapped) {
    const orig = Pages.dash.render;
    const wrapped = async function (el) {
      const r = await orig.call(this, el);
      try {
        if (['admin', 'sales'].includes(profile.role) && !document.getElementById('dashTasks')) {
          const w = document.createElement('div'); w.id = 'dashTasks'; el.appendChild(w);
          custMyTasksWidget();
        }
      } catch (e) { console.error('dash-tasks', e); }
      return r;
    };
    wrapped._ctWrapped = true;
    Pages.dash.render = wrapped;
  }
})();
