/* ============================================================
customer-tags.js — תיוג לקוחות ופעולות קבוצתיות (פיצ'ר 5)
------------------------------------------------------------
- תגיות חופשיות לכל לקוח (עמודת tags[] בטבלת customers)
- תצוגת תגיות ברשימה + סינון לפי תגית
- בחירה מרובה (צ'קבוקסים) + סרגל פעולות קבוצתיות:
  הוספת/הסרת תגית · שינוי סטטוס · שיוך לסוכן · ייצוא הנבחרים
דורש עמודה: alter table customers add column tags text[] default '{}';
============================================================ */
'use strict';

/* מצב הבחירה המרובה ברשימת הלקוחות (מזהי לקוחות) */
let _custSelected = new Set();

/* כל התגיות שבשימוש, ממוינות — לרשימות בחירה וסינון */
function custAllTags() {
  const s = new Set();
  (_customers || []).forEach(c => (c.tags || []).forEach(t => t && s.add(t)));
  return [...s].sort((a, b) => a.localeCompare(b, 'he'));
}

/* צ'יפים לתצוגה בלבד */
function custTagChips(tags) {
  if (!tags || !tags.length) return '<span class="muted">—</span>';
  return tags.map(t => `<span class="ctag">${esc(t)}</span>`).join(' ');
}

/* ---------- בחירה מרובה ---------- */
function custToggleSel(id, on) {
  if (on) _custSelected.add(id); else _custSelected.delete(id);
  custBulkBarUpdate();
  const all = document.getElementById('custSelAll');
  if (all) { const rows = _customersFiltered(); all.checked = rows.length && rows.every(r => _custSelected.has(r.id)); }
}
function custSelAllVisible(on) {
  const ids = _customersFiltered().map(c => c.id);
  if (on) ids.forEach(i => _custSelected.add(i));
  else ids.forEach(i => _custSelected.delete(i));
  customersDraw();
}
function custSelClear() { _custSelected.clear(); customersDraw(); }

/* סרגל הפעולות הקבוצתיות — מוצג רק כשיש בחירה */
function custBulkBarUpdate() {
  const bar = document.getElementById('custBulkBar');
  if (!bar) return;
  const n = _custSelected.size;
  if (!n) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <b>${n} נבחרו</b>
    <button class="btn btn-sm" onclick="custBulkTag('add')">🏷 הוסף תגית</button>
    <button class="btn btn-sm btn-ghost" onclick="custBulkTag('remove')">הסר תגית</button>
    <button class="btn btn-sm btn-ghost" onclick="custBulkStatus()">שינוי סטטוס</button>
    <button class="btn btn-sm btn-ghost" onclick="custBulkAgent()">שיוך לסוכן</button>
    <button class="btn btn-sm btn-ghost" onclick="custBulkExport()">⬇ ייצוא הנבחרים</button>
    <button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="custSelClear()">בטל בחירה</button>`;
}

function _custSelIds() { return [..._custSelected]; }

/* ---------- פעולות קבוצתיות ---------- */
async function custBulkTag(mode) {
  const ids = _custSelIds(); if (!ids.length) return;
  const title = (mode === 'add' ? 'הוספת תגית ל-' : 'הסרת תגית מ-') + ids.length + ' לקוחות';
  _custTagPicker(title, [], mode === 'add' ? 'הוסף לכולם' : 'הסר מכולם', async (tags) => {
    if (!tags.length) return;
    const sel = (_customers || []).filter(c => _custSelected.has(c.id));
    await Promise.all(sel.map(c => {
      const cur = new Set(c.tags || []);
      if (mode === 'add') tags.forEach(t => cur.add(t)); else tags.forEach(t => cur.delete(t));
      const next = [...cur];
      c.tags = next;
      return run(db.from('customers').update({ tags: next }).eq('id', c.id));
    }));
    toast('✓ עודכנו ' + sel.length + ' לקוחות');
    customersDraw();
  });
}

async function custBulkStatus() {
  const ids = _custSelIds(); if (!ids.length) return;
  openForm('שינוי סטטוס ל-' + ids.length + ' לקוחות', [
    { name: 'status', label: 'סטטוס', type: 'select', required: true,
      options: [{ v: 'active', t: 'פעיל' }, { v: 'frozen', t: 'מוקפא' }, { v: 'blacklist', t: 'רשימה שחורה' }] },
    { name: 'status_reason', label: 'סיבה (להקפאה/רשימה שחורה)' },
  ], {}, async (rec) => {
    await run(db.from('customers').update({ status: rec.status, status_reason: rec.status_reason || '' }).in('id', ids));
    (_customers || []).forEach(c => { if (_custSelected.has(c.id)) { c.status = rec.status; c.status_reason = rec.status_reason || ''; } });
    toast('✓ עודכן סטטוס ל-' + ids.length + ' לקוחות');
    _custSelected.clear();
    customersDraw();
  });
}

async function custBulkAgent() {
  const ids = _custSelIds(); if (!ids.length) return;
  openForm('שיוך סוכן ל-' + ids.length + ' לקוחות', [
    { name: 'agent_id', label: 'סוכן', type: 'select', required: true, options: 'agents' },
  ], {}, async (rec) => {
    const aid = Number(rec.agent_id) || null;
    await run(db.from('customers').update({ agent_id: aid }).in('id', ids));
    (_customers || []).forEach(c => { if (_custSelected.has(c.id)) c.agent_id = aid; });
    toast('✓ שויכו ' + ids.length + ' לקוחות');
    _custSelected.clear();
    customersDraw();
  });
}

function custBulkExport() {
  const rows = (_customers || []).filter(c => _custSelected.has(c.id));
  if (!rows.length) { toast('לא נבחרו לקוחות', true); return; }
  const data = rows.map(c => [
    c.name || '', c.contact_person || '', c.phone || '', c.whatsapp || '', c.email || '',
    c.city || '', c.field || '', nameOf('agents', c.agent_id) || '', PAY_TERMS[c.payment_terms] || '',
    (c.tags || []).join(', '), (_custDebt[c.id] && _custDebt[c.id].debt) || 0, (CUSTOMER_STATUS[c.status] || [''])[0]]);
  exportCsv('לקוחות_נבחרים_' + today(),
    ['שם העסק', 'איש קשר', 'טלפון', 'וואטסאפ', 'מייל', 'יישוב', 'תחום', 'סוכן', 'תנאי תשלום', 'תגיות', 'יתרת חוב', 'סטטוס'], data);
  toast('✓ יוצאו ' + rows.length + ' לקוחות');
}

/* ---------- עריכת תגיות ללקוח בודד (מכרטיס הלקוח) ---------- */
async function custEditTags(id) {
  let c = (_customers || []).find(x => x.id === id);
  if (!c) c = await run(db.from('customers').select('id,tags,name').eq('id', id).single());
  _custTagPicker('תגיות — ' + (c.name || ''), c.tags || [], 'שמור', async (tags) => {
    await run(db.from('customers').update({ tags }).eq('id', id));
    const cc = (_customers || []).find(x => x.id === id); if (cc) cc.tags = tags;
    toast('✓ התגיות נשמרו');
    openCustomerCard(id);
  });
}

/* ---------- בוחר תגיות משותף (overlay) ---------- */
let _ctagSel = [];
let _ctagAll = [];
let _ctagOnSave = null;
let _ctagMeta = { title: '', save: 'שמור' };

function _custTagPicker(title, initialTags, saveLabel, onSave) {
  _ctagSel = [...(initialTags || [])];
  _ctagAll = custAllTags();
  _ctagOnSave = onSave;
  _ctagMeta = { title, save: saveLabel };
  let ov = document.getElementById('ctagOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'ctagOverlay'; ov.className = 'ctag-overlay'; document.body.appendChild(ov); }
  ov.className = 'ctag-overlay';
  _ctagDraw();
  const inp = document.getElementById('ctagInput'); if (inp) inp.focus();
}

function _ctagDraw() {
  const ov = document.getElementById('ctagOverlay'); if (!ov) return;
  const quick = _ctagAll.filter(t => !_ctagSel.includes(t)).slice(0, 24);
  ov.innerHTML = `<div class="ctag-box">
    <h3 style="margin:0 0 12px">${esc(_ctagMeta.title)}</h3>
    <div class="ctag-sel">${_ctagSel.length ? _ctagSel.map((t, i) => `<span class="ctag ctag-rm" onclick="_ctagRm(${i})">${esc(t)} ✕</span>`).join(' ') : '<span class="muted">אין תגיות</span>'}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <input id="ctagInput" list="ctagList" placeholder="הקלד/י תגית ואנטר" style="flex:1" onkeydown="if(event.key==='Enter'){event.preventDefault();_ctagAdd();}">
      <datalist id="ctagList">${_ctagAll.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      <button class="btn btn-sm" onclick="_ctagAdd()">הוסף</button>
    </div>
    ${quick.length ? `<div class="ctag-quick">${quick.map((t) => `<span class="ctag ctag-pick" onclick="_ctagPick(${_ctagAll.indexOf(t)})">${esc(t)}</span>`).join(' ')}</div>` : ''}
    <div class="m-actions" style="justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm btn-ghost" onclick="_ctagClose()">ביטול</button>
      <button class="btn btn-sm" onclick="_ctagSave()">${esc(_ctagMeta.save)}</button>
    </div>
  </div>`;
}

function _ctagAdd() {
  const inp = document.getElementById('ctagInput'); if (!inp) return;
  const v = (inp.value || '').trim();
  if (v && !_ctagSel.includes(v)) _ctagSel.push(v);
  inp.value = '';
  _ctagDraw();
  const ni = document.getElementById('ctagInput'); if (ni) ni.focus();
}
function _ctagPick(idx) { const t = _ctagAll[idx]; if (t && !_ctagSel.includes(t)) _ctagSel.push(t); _ctagDraw(); }
function _ctagRm(i) { _ctagSel.splice(i, 1); _ctagDraw(); }
function _ctagClose() { const ov = document.getElementById('ctagOverlay'); if (ov) ov.remove(); }
function _ctagSave() { const ov = document.getElementById('ctagOverlay'); if (ov) ov.remove(); if (_ctagOnSave) _ctagOnSave(_ctagSel.slice()); }

/* ---------- סגנונות ---------- */
(function _ctagStyles() {
  if (document.getElementById('ctagStyles')) return;
  const s = document.createElement('style');
  s.id = 'ctagStyles';
  s.textContent = `
.ctag{display:inline-block;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:999px;padding:1px 9px;font-size:.75rem;line-height:1.7;white-space:nowrap;margin:1px 0}
.ctag-rm,.ctag-pick{cursor:pointer;user-select:none}
.ctag-rm:hover{background:#fee2e2;color:#991b1b;border-color:#fecaca}
.ctag-pick{background:#f1f5f9;color:#334155;border-color:#e2e8f0}
.ctag-pick:hover{background:#e2e8f0}
.ctag-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
.ctag-box{background:#fff;border-radius:16px;padding:22px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:right;max-height:82vh;overflow:auto}
.ctag-sel{min-height:28px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ctag-quick{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;max-height:140px;overflow:auto;border-top:1px solid #f1f5f9;padding-top:10px}
#custBulkBar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:8px 12px;margin-bottom:10px}
#custBulkBar.hidden{display:none}`;
  document.head.appendChild(s);
})();
