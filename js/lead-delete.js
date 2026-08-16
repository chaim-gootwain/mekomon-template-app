/* ============================================================
lead-delete.js — מחיקת ליד עם אישור מנהל
------------------------------------------------------------
- סוכן: לוחץ "מחיקה" → מזין סיבה → הליד מוסתר אצלו ונשלח לאישור המנהל
  (מסומן על הליד: pending_delete + delete_reason + delete_requested_by/at).
- מנהל: רואה באנר "בקשות מחיקה ממתינות" עם הסיבה, ומאשר או דוחה.
    • אישור  → מחיקה סופית (delete_lead RPC).
    • דחייה  → הליד עובר לבעלות המנהל (agent_id = הסוכן של המנהל) והדגל מנוקה.
- נשען על 4 עמודות ב-leads (מיגרציה רצה אוטומטית כשה-Supabase חוזר).
============================================================ */

'use strict';

function _ldColMissing(err) {
  const m = String((err && err.message) || err || '');
  return /pending_delete|delete_reason|delete_requested|column .* does not exist|42703/i.test(m);
}

/* ---------- סוכן: בקשת מחיקה ---------- */
function leadRequestDelete(id) {
  const l = (typeof _leads !== 'undefined' ? _leads : []).find(x => x.id === id) || {};
  document.getElementById('viewModal').innerHTML = `
    <h3>🗑 בקשת מחיקת ליד</h3>
    <p class="muted" style="font-size:.9rem">הליד "<b>${esc(l.name || '')}</b>" יוסתר אצלך וישלח למנהל לאישור.</p>
    <div class="field" style="margin-top:8px"><label>סיבת המחיקה (חובה)</label>
      <textarea id="ldReason" rows="3" placeholder="למשל: כפילות · לא רלוונטי · לא מעוניין · מספר שגוי"></textarea></div>
    <div class="m-actions" style="margin-top:12px">
      <button class="btn btn-danger" onclick="leadSubmitDelete(${id})">שליחת בקשה למנהל</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  setTimeout(() => document.getElementById('ldReason') && document.getElementById('ldReason').focus(), 60);
}

async function leadSubmitDelete(id) {
  const reason = (document.getElementById('ldReason') && document.getElementById('ldReason').value || '').trim();
  if (!reason) { toast('נא לציין סיבת מחיקה', true); return; }
  const patch = {
    pending_delete: true,
    delete_reason: reason,
    delete_requested_by: (typeof myAgentId === 'function' ? myAgentId() : null),
    delete_requested_at: new Date().toISOString(),
  };
  const { error } = await db.from('leads').update(patch).eq('id', id);
  if (error) {
    if (_ldColMissing(error)) toast('הפיצ\'ר יופעל לאחר עדכון מסד הנתונים (ממתין ל-Supabase)', true);
    else toast('שגיאה: ' + error.message, true);
    return;
  }
  const l = (typeof _leads !== 'undefined' ? _leads : []).find(x => x.id === id);
  if (l) { l.pending_delete = true; l.delete_reason = reason; l.delete_requested_by = patch.delete_requested_by; l.delete_requested_at = patch.delete_requested_at; }
  const vb = document.getElementById('viewBack'); if (vb) vb.classList.remove('open');
  toast('✅ הבקשה נשלחה למנהל לאישור');
  if (typeof openPage === 'function') openPage('leads');
}

/* ---------- מנהל: רשימת בקשות ממתינות ---------- */
function leadRenderDelReqs() {
  const box = document.getElementById('leadDelReqs');
  if (!box) return;
  const pend = (typeof _leads !== 'undefined' ? _leads : []).filter(l => l.pending_delete);
  if (!pend.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card" style="border:1px solid #fecaca;background:#fef2f2;margin-bottom:12px">
    <b style="color:#991b1b">🗑 ${pend.length} בקשות מחיקת ליד ממתינות לאישור</b>
    <div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>ליד</th><th>סוכן מבקש</th><th>סיבה</th><th>תאריך</th><th></th></tr></thead>
      <tbody>${pend.map(l => `<tr>
        <td><b>${esc(l.name || '')}</b>${l.phone ? ` · <span dir="ltr">${esc(l.phone)}</span>` : ''}</td>
        <td>${esc(nameOf('agents', l.delete_requested_by)) || '—'}</td>
        <td>${esc(l.delete_reason || '')}</td>
        <td>${l.delete_requested_at ? heDate(l.delete_requested_at) : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" style="background:#16a34a;color:#fff" onclick="leadApproveDelete(${l.id})">✅ אשר מחיקה</button>
          <button class="btn btn-sm btn-ghost" onclick="leadRejectDelete(${l.id})">↩ דחה (העבר אליי)</button>
        </td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

/* ---------- מנהל: אישור מחיקה (סופי) ---------- */
async function leadApproveDelete(id) {
  const l = (typeof _leads !== 'undefined' ? _leads : []).find(x => x.id === id) || {};
  if (!confirm(`לאשר מחיקה סופית של הליד "${l.name || ''}"?\nכל ציר הזמן שלו יימחק. הפעולה בלתי-הפיכה.`)) return;
  try {
    await run(db.rpc('delete_lead', { p_lead_id: id }));
    const vb = document.getElementById('viewBack'); if (vb) vb.classList.remove('open');
    toast('🗑 הליד נמחק סופית');
    if (typeof openPage === 'function') openPage('leads');
  } catch (e) { /* run מציג שגיאה */ }
}

/* ---------- מנהל: דחיית בקשה → הליד עובר אליו ---------- */
async function leadRejectDelete(id) {
  const mgr = (typeof myAgentId === 'function' ? myAgentId() : null);
  const patch = { pending_delete: false, delete_reason: null, delete_requested_by: null, delete_requested_at: null, agent_id: mgr };
  const { error } = await db.from('leads').update(patch).eq('id', id);
  if (error) {
    if (_ldColMissing(error)) toast('הפיצ\'ר יופעל לאחר עדכון מסד הנתונים (ממתין ל-Supabase)', true);
    else toast('שגיאה: ' + error.message, true);
    return;
  }
  const l = (typeof _leads !== 'undefined' ? _leads : []).find(x => x.id === id);
  if (l) { l.pending_delete = false; l.delete_reason = null; l.delete_requested_by = null; l.agent_id = mgr; }
  const vb = document.getElementById('viewBack'); if (vb) vb.classList.remove('open');
  toast(mgr ? '↩ המחיקה נדחתה — הליד הועבר אליך' : '↩ המחיקה נדחתה — הליד הוחזר למאגר (למנהל אין כרטיס סוכן)');
  if (typeof openPage === 'function') openPage('leads');
}
