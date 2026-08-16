/* ============================================================
customer-merge.js — מיזוג לקוחות כפולים (פיצ'ר 11)
------------------------------------------------------------
- מזהה כפילויות לפי טלפון מנורמל ולפי שם מנורמל
- בכל קבוצה בוחרים את הלקוח שנשמר; השאר ממוזגים אליו
- המיזוג מתבצע ב-RPC merge_customers (טרנזקציה: מעביר מודעות/
  חיובים/חוזים/תשלומים/מסמכים/ציר-זמן ואז מוחק את הכפול)
דורש: create function merge_customers(bigint,bigint)
============================================================ */
'use strict';

let _mergeGroups = [];

function _mgPhone(p) { const s = String(p || '').replace(/\D/g, ''); return s.length >= 7 ? s.replace(/^972/, '0') : ''; }
function _mgName(n) { return String(n || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

/* בונה קבוצות כפילויות מתוך _customers */
function _mgScan() {
  const byPhone = {}, byName = {};
  (_customers || []).forEach(c => {
    const p = _mgPhone(c.phone); if (p) (byPhone[p] = byPhone[p] || []).push(c);
    const n = _mgName(c.name); if (n) (byName[n] = byName[n] || []).push(c);
  });
  const groups = [], seen = new Set();
  function addGroups(map, reason) {
    Object.entries(map).forEach(([k, arr]) => {
      if (arr.length < 2) return;
      const key = arr.map(c => c.id).sort((a, b) => a - b).join(',');
      if (seen.has(key)) return; seen.add(key);
      groups.push({ reason, key: k, members: arr });
    });
  }
  addGroups(byPhone, 'phone');
  addGroups(byName, 'name');
  return groups;
}

function customerMergeOpen() {
  if (profile.role !== 'admin') { toast('רק מנהל יכול למזג לקוחות', true); return; }
  _mergeGroups = _mgScan();
  let ov = document.getElementById('mergeOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'mergeOverlay'; ov.className = 'ctag-overlay'; document.body.appendChild(ov); }
  ov.className = 'ctag-overlay';
  _mgDraw();
}

function _mgDraw() {
  const ov = document.getElementById('mergeOverlay'); if (!ov) return;
  const body = _mergeGroups.length ? _mergeGroups.map((g, gi) => {
    const reasonHe = g.reason === 'phone' ? 'טלפון זהה: ' + esc(g.key) : 'שם זהה';
    const rows = g.members.map((c, mi) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;margin:4px 0;cursor:pointer">
      <input type="radio" name="mg_${gi}" value="${c.id}" ${mi === 0 ? 'checked' : ''}>
      <span style="flex:1"><b>${esc(c.name)}</b> <span class="muted" style="font-size:.8rem">· #${c.id}${c.phone ? ' · ' + esc(c.phone) : ''}${c.agent_id ? ' · ' + esc(nameOf('agents', c.agent_id)) : ''}${c.status && c.status !== 'active' ? ' · ' + (CUSTOMER_STATUS[c.status] || [''])[0] : ''}</span></span>
    </label>`).join('');
    return `<div style="border:1px solid #cbd5e1;border-radius:12px;padding:12px;margin-bottom:12px">
      <div style="font-size:.8rem;color:#64748b;margin-bottom:6px">${reasonHe} · ${g.members.length} רשומות · בחר/י את הרשומה שנשמרת:</div>
      ${rows}
      <div style="text-align:left;margin-top:8px"><button class="btn btn-sm" onclick="_mgDo(${gi})">🔗 מזג את השאר אל הנבחר</button></div>
    </div>`;
  }).join('') : '<p class="muted" style="padding:20px 0;text-align:center">לא נמצאו כפילויות לפי טלפון או שם 🎉</p>';

  ov.innerHTML = `<div class="ctag-box" style="max-width:620px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0">מיזוג לקוחות כפולים <span class="muted" style="font-size:.85rem">(${_mergeGroups.length})</span></h3>
      <button class="btn btn-sm btn-ghost" onclick="_mgClose()">סגירה</button>
    </div>
    <div style="max-height:64vh;overflow:auto">${body}</div>
  </div>`;
}

async function _mgDo(gi) {
  const g = _mergeGroups[gi]; if (!g) return;
  const picked = document.querySelector(`input[name="mg_${gi}"]:checked`);
  const keepId = picked ? Number(picked.value) : g.members[0].id;
  const keep = g.members.find(c => c.id === keepId);
  const dups = g.members.filter(c => c.id !== keepId);
  if (!dups.length) return;
  if (!confirm(`למזג ${dups.length} רשומות אל "${keep.name}"?\n\nכל המודעות, החיובים, החוזים, התשלומים, המסמכים וההיסטוריה של הכפולים יועברו אל "${keep.name}", והרשומות הכפולות יימחקו.\n\nפעולה בלתי-הפיכה.`)) return;
  try {
    for (const d of dups) {
      await run(db.rpc('merge_customers', { p_keep: keepId, p_dup: d.id }));
    }
    toast(`✓ מוזגו ${dups.length} רשומות אל ${keep.name}`);
    _customers = await run(db.from('customers').select('*').order('name'));
    await refreshCache();
    _mergeGroups = _mgScan();
    _mgDraw();
    if (typeof customersDraw === 'function' && document.getElementById('custTable')) customersDraw();
  } catch (e) { /* run מציג את השגיאה */ }
}

function _mgClose() { const ov = document.getElementById('mergeOverlay'); if (ov) ov.remove(); }
