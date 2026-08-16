/* ============================================================
import-complete.js — השלמת פרטים ללקוחות שיובאו
------------------------------------------------------------
- לקוחות שיובאו מגיליון 294 מסומנים בהערה "יובא-מגיליון-294 ... להשלמת פרטים"
- בכניסה נפתח חלון לכל לקוח כזה בתורו למילוי טלפון/מייל/איש קשר וכו'
- "שמור והבא" מנקה את הסימון ועובר לבא; "דלג" משאיר לפעם הבאה
============================================================ */

'use strict';

const IMPORT_MARK = 'יובא-מגיליון-294';
let _icQueue = [];
let _icIdx = 0;

async function icLoadPending() {
  try {
    const { data } = await db.from('customers').select('id,name,notes,phone,whatsapp,email,contact_person,city,field,payment_terms')
      .ilike('notes', '%' + IMPORT_MARK + '%').order('name');
    return data || [];
  } catch (e) { return []; }
}

function _icSizeFromNote(notes) {
  const m = String(notes || '').match(/·\s*([^·]+?)\s*·/);
  return m ? m[1].trim() : '';
}

async function icMaybeStart() {
  if (!['admin', 'sales'].includes(profile.role)) return;
  _icQueue = await icLoadPending();
  _icIdx = 0;
  if (_icQueue.length) icShow();
}

function icShow() {
  if (_icIdx >= _icQueue.length) { icClose(); toast('סיימת להשלים את כל הלקוחות שיובאו ✓'); return; }
  const c = _icQueue[_icIdx];
  emuEnsureStyles();
  let ov = document.getElementById('icOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'icOverlay'; ov.className = 'emu-overlay'; document.body.appendChild(ov); }
  const size = _icSizeFromNote(c.notes);
  ov.innerHTML = `<div class="emu-oops" style="max-width:520px;text-align:right">
    <div style="text-align:center" class="ic">🗂️</div>
    <p style="text-align:center;margin:6px 0 4px"><b>השלמת פרטי לקוח שיובא</b><br>
      <span style="font-size:.85rem;color:#555">${_icIdx + 1} מתוך ${_icQueue.length}${size ? ' · מפרסם ' + esc(size) : ''}</span></p>
    <div class="field"><label>שם העסק</label><input id="icName" value="${esc(c.name || '')}"></div>
    <div class="grid2">
      <div class="field"><label>טלפון</label><input id="icPhone" dir="ltr" value="${esc(c.phone || '')}"></div>
      <div class="field"><label>וואטסאפ</label><input id="icWa" dir="ltr" value="${esc(c.whatsapp || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>מייל</label><input id="icEmail" dir="ltr" value="${esc(c.email || '')}"></div>
      <div class="field"><label>איש קשר</label><input id="icContact" value="${esc(c.contact_person || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>עיר</label><input id="icCity" value="${esc(c.city || '')}"></div>
      <div class="field"><label>תחום</label><input id="icField" value="${esc(c.field || '')}"></div>
    </div>
    <div class="field"><label>תנאי תשלום</label><select id="icTerms">
      <option value="immediate" ${(!c.payment_terms||c.payment_terms==='immediate')?'selected':''}>מיידי</option>
      <option value="net30" ${c.payment_terms==='net30'?'selected':''}>שוטף+30</option>
      <option value="net60" ${c.payment_terms==='net60'?'selected':''}>שוטף+60</option>
    </select></div>
    <div class="m-actions" style="justify-content:center;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-sm" id="icSave">שמור והבא ←</button>
      <button class="btn btn-sm btn-ghost" id="icFull">📇 כרטיס מלא</button>
      <button class="btn btn-sm btn-ghost" id="icSkip">דלג לעכשיו</button>
      <button class="btn btn-sm btn-ghost" id="icDone">סיום להיום</button>
    </div>`;
  ov.querySelector('#icDone').addEventListener('click', icClose);
  ov.querySelector('#icSkip').addEventListener('click', () => { _icIdx++; icShow(); });
  ov.querySelector('#icSave').addEventListener('click', () => icSave(c.id));
  ov.querySelector('#icFull').addEventListener('click', async () => {
    const _sz = _icSizeFromNote(c.notes);
    try { await run(db.from('customers').update({ notes: 'מפרסם גיליון 294' + (_sz ? ' · ' + _sz : '') }).eq('id', c.id)); } catch (e) { }
    const cc = (cache.customers || []).find(x => x.id === c.id); if (cc) cc.notes = 'מפרסם גיליון 294' + (_sz ? ' · ' + _sz : '');
    icClose();
    if (typeof openPage === 'function') openPage('customers').then(() => { if (typeof openCustomerCard === 'function') openCustomerCard(c.id); });
    else if (typeof openCustomerCard === 'function') openCustomerCard(c.id);
  });
}

async function icSave(id) {
  const g = i => (document.getElementById(i) || {}).value || '';
  const size = _icSizeFromNote(_icQueue[_icIdx].notes);
  const upd = {
    name: g('icName').trim(),
    phone: g('icPhone').trim() || null,
    whatsapp: g('icWa').trim() || null,
    email: g('icEmail').trim() || null,
    contact_person: g('icContact').trim() || null,
    city: g('icCity').trim() || null,
    field: g('icField').trim() || null,
    payment_terms: g('icTerms') || 'immediate',
    // מסיר את סימון ההשלמה — נשמר תיאור נקי
    notes: 'מפרסם גיליון 294' + (size ? ' · ' + size : ''),
  };
  try {
    await run(db.from('customers').update(upd).eq('id', id));
    const cc = (cache.customers || []).find(x => x.id === id);
    if (cc) Object.assign(cc, upd);
    toast('נשמר ✓');
    _icIdx++;
    icShow();
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

function icClose() { const ov = document.getElementById('icOverlay'); if (ov) ov.remove(); }

/* הפעלה אחרי הכניסה */
(function () {
  const orig = window.afterLogin;
  if (typeof orig === 'function' && !orig._icWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { await icMaybeStart(); } catch (e) { console.error('import-complete', e); }
      return r;
    };
    wrapped._icWrapped = true;
    window.afterLogin = wrapped;
  }
})();
