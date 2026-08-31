/* ============================================================
customer-files.js — מסמכים/קבצים על הלקוח (פיצ'ר 2)
------------------------------------------------------------
- סעיף "מסמכים" בכרטיס הלקוח: העלאה, רשימה, הורדה, מחיקה.
- אחסון בבאקט הקיים ad-files בנתיב customer/<id>/... ; מטא בטבלת customer_files.
- אם הטבלה עדיין לא קיימת (מיגרציה בתור) — מוצג מסר מסודר.
============================================================ */

'use strict';

const CF_KINDS = [['contract', 'חוזה'], ['license', 'רישיון עסק'], ['logo', 'לוגו'], ['quote', 'הצעת מחיר'], ['id', 'ת.ז / ח.פ'], ['other', 'אחר']];
function _cfKindHe(k) { const f = CF_KINDS.find(x => x[0] === k); return f ? f[1] : (k || 'אחר'); }
function _cfMissing(err) { return /customer_files|does not exist|relation .* does not exist|42P01|schema cache/i.test(String((err && err.message) || err || '')); }

async function custFilesRender(customerId) {
  const box = document.getElementById('cfSection'); if (!box) return;
  let files = null, missing = false;
  try {
    const r = await db.from('customer_files').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    if (r.error) { if (_cfMissing(r.error)) missing = true; else throw r.error; } else files = r.data || [];
  } catch (e) { missing = _cfMissing(e); if (!missing) { box.innerHTML = '<p class="muted" style="font-size:.85rem">שגיאה בטעינת מסמכים</p>'; return; } }

  if (missing) {
    box.innerHTML = `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;background:#fbfdff">
      <b>📎 מסמכים</b>
      <p class="muted" style="font-size:.83rem;margin-top:6px">התכונה תופעל לאחר עדכון מסד הנתונים (ממתין ל-Supabase).</p></div>`;
    return;
  }

  const rows = (files || []).map(f => `<tr>
      <td><b>${esc(f.file_name || 'קובץ')}</b></td>
      <td>${esc(_cfKindHe(f.kind))}</td>
      <td>${heDate(f.created_at)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-ghost" onclick="custFileOpen('${esc(f.storage_path)}')">⬇ הורדה</button>
        <button class="btn btn-sm btn-danger-ghost" onclick="custFileDelete(${f.id}, '${esc(f.storage_path)}', ${customerId})">🗑</button>
      </td></tr>`).join('');

  box.innerHTML = `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;background:#fbfdff">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <b>📎 מסמכים (${(files || []).length})</b>
      <span style="display:flex;gap:6px;align-items:center">
        <select id="cfKind" style="width:auto">${CF_KINDS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
        <input type="file" id="cfInput" class="hidden" onchange="custFileUpload(${customerId})">
        <button class="btn btn-sm" onclick="document.getElementById('cfInput').click()">⬆ העלאת מסמך</button>
      </span>
    </div>
    ${(files || []).length ? `<div class="table-wrap" style="margin-top:8px"><table class="data">
      <thead><tr><th>שם</th><th>סוג</th><th>תאריך</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted" style="font-size:.83rem;margin-top:6px">אין עדיין מסמכים</p>'}
  </div>`;
}

async function custFileUpload(customerId) {
  const input = document.getElementById('cfInput'); const file = input && input.files[0];
  if (!file) return;
  const kind = (document.getElementById('cfKind') || {}).value || 'other';
  input.value = '';
  toast('מעלה מסמך...');
  const path = `customer/${customerId}/${Date.now()}_${safeKey(file.name)}`;
  const up = await db.storage.from('ad-files').upload(path, file);
  if (up.error) { toast('שגיאה בהעלאה: ' + up.error.message, true); return; }
  const ins = await db.from('customer_files').insert({ customer_id: customerId, storage_path: path, file_name: file.name, kind, uploaded_by: (typeof profile !== 'undefined' ? profile.id : null) });
  if (ins.error) {
    try { await db.storage.from('ad-files').remove([path]); } catch (e) { }
    toast(_cfMissing(ins.error) ? 'התכונה תופעל לאחר עדכון מסד הנתונים' : ('שגיאה: ' + ins.error.message), true);
    return;
  }
  try { await addInteraction('customer', customerId, `📎 הועלה מסמך: ${file.name} (${_cfKindHe(kind)})`); } catch (e) { }
  toast('✅ המסמך הועלה');
  custFilesRender(customerId);
}

async function custFileOpen(path) {
  const { data, error } = await db.storage.from('ad-files').createSignedUrl(path, 300);
  if (error) { toast('שגיאה בפתיחה: ' + error.message, true); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function custFileDelete(id, path, customerId) {
  if (!confirm('למחוק את המסמך?')) return;
  const { error } = await db.from('customer_files').delete().eq('id', id);
  if (error) { toast('שגיאה במחיקה: ' + error.message, true); return; }
  try { await db.storage.from('ad-files').remove([path]); } catch (e) { }
  toast('המסמך נמחק');
  custFilesRender(customerId);
}

/* עטיפת openCustomerCard — הזרקת סעיף מסמכים */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._cfWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (['admin', 'sales'].includes(profile.role)) {
          const modal = document.getElementById('viewModal');
          if (modal && !document.getElementById('cfSection')) {
            const div = document.createElement('div');
            div.id = 'cfSection'; div.style.cssText = 'margin-top:12px';
            (document.getElementById('ccExtra') || modal).appendChild(div);
            custFilesRender(id);
          }
        }
      } catch (e) { console.error('cust-files wrap', e); }
      return r;
    };
    wrapped._cfWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
