/* ============================================================
approve-import.js — אישור שורה-שורה של ייבוא גיליון
------------------------------------------------------------
- קורא תור מ-settings.import_queue_295 (נכתב ע"י הייבוא)
- בכניסה נפתח חלון לכל שורה: מפרסם · התאמת לקוח · עמוד · מחיר
- אשר → יוצר מודעה משובצת (status=placed) בעמוד, ומתאים/יוצר לקוח
- דחה → מדלג בלי ליצור · דלג → משאיר לפעם הבאה
- מתעדכן ב-settings אחרי כל פעולה (שורד יציאה/כניסה)
============================================================ */

'use strict';

const AQ_KEY = 'import_queue_295';
let _aqState = null;

async function aqLoad() {
  try {
    const { data } = await db.from('settings').select('value').eq('key', AQ_KEY).single();
    if (!data || !data.value) return null;
    return JSON.parse(data.value);
  } catch (e) { return null; }
}
async function aqPersist() {
  if (!_aqState) return;
  try {
    await db.from('settings').update({
      value: JSON.stringify({ issueId: _aqState.issueId, issueNumber: _aqState.issueNumber, items: _aqState.items }),
    }).eq('key', AQ_KEY);
  } catch (e) { }
}

// התאמת לקוח קיים לפי שם (מדויק / הכלה / מילה משותפת)
function aqMatchCustomer(title) {
  const t = (title || '').trim(); const cs = cache.customers || [];
  let m = cs.find(c => (c.name || '').trim() === t);
  if (m) return m.id;
  m = cs.find(c => { const n = (c.name || '').trim(); return n.length >= 3 && (t.includes(n) || n.includes(t)); });
  if (m) return m.id;
  const words = t.split(/\s+/).filter(w => w.length >= 3);
  m = cs.find(c => { const n = (c.name || ''); return words.some(w => n.includes(w)); });
  return m ? m.id : null;
}

async function aqStart() {
  if (!['admin', 'sales', 'editor'].includes(profile.role)) return;
  const q = await aqLoad();
  if (!q || !Array.isArray(q.items) || !q.items.some(it => !it.done)) return;
  _aqState = { issueId: q.issueId, issueNumber: q.issueNumber, items: q.items };
  aqShowNext();
}

function aqShowNext() {
  const item = (_aqState.items || []).find(it => !it.done);
  if (!item) { aqClose(); toast('הושלם ייבוא גיליון ' + _aqState.issueNumber + ' ✓'); return; }
  aqRender(item);
}

function aqRender(item) {
  const _ic = document.getElementById('icOverlay'); if (_ic) _ic.remove(); // עדיפות לאישור הגיליון
  emuEnsureStyles();
  const total = _aqState.items.length;
  const doneN = _aqState.items.filter(it => it.done).length;
  let matchId;
  const _note = (item.note || '').trim();
  if (_note === 'מועצה') matchId = ((cache.customers || []).find(c => c.name === 'מועצה מקומית עמנואל') || {}).id;
  else if (_note === 'מועצה דתית') matchId = ((cache.customers || []).find(c => c.name === 'מועצה דתית עמנואל') || {}).id;
  if (!matchId) matchId = aqMatchCustomer(item.title);
  const custOpts = `<option value="new" ${!matchId ? 'selected' : ''}>➕ צור לקוח חדש: "${esc(item.title)}"</option>`
    + (cache.customers || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(c => `<option value="${c.id}" ${c.id === matchId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const metaBits = [item.note, item.paid].filter(Boolean).join(' · ');
  let ov = document.getElementById('aqOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'aqOverlay'; ov.className = 'emu-overlay'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="emu-oops" style="max-width:520px;text-align:right">
    <div style="text-align:center" class="ic">🗞️</div>
    <p style="text-align:center;margin:6px 0 4px"><b>אישור מודעה — גיליון ${_aqState.issueNumber}</b><br>
      <span style="font-size:.85rem;color:#555">${doneN + 1} מתוך ${total}${metaBits ? ' · ' + esc(metaBits) : ''}</span></p>
    <div class="field"><label>מפרסם / כותרת המודעה</label><input id="aqTitle" value="${esc(item.title)}"></div>
    <div class="field"><label>לקוח (התאמה / יצירה)</label><select id="aqCust">${custOpts}</select></div>
    <div class="grid2">
      <div class="field"><label>עמוד</label><input id="aqPage" type="number" dir="ltr" value="${item.page != null ? item.page : ''}"></div>
      <div class="field"><label>מחיר (₪, לפני מע"מ)</label><input id="aqPrice" type="number" dir="ltr" value="${item.price != null ? item.price : 0}"></div>
    </div>
    ${item.paid ? `<p class="muted" style="font-size:.8rem">סטטוס תשלום מהגיליון: <b>${esc(item.paid)}</b> — יישמר בהערת המודעה</p>` : ''}
    <div class="m-actions" style="justify-content:center;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-sm" id="aqOk">✓ אשר והבא ←</button>
      <button class="btn btn-sm btn-ghost" id="aqSkip">דלג</button>
      <button class="btn btn-sm btn-danger-ghost" id="aqRej">דחה (לא מודעה)</button>
      <button class="btn btn-sm btn-ghost" id="aqDone">סיום להיום</button>
    </div>`;
  ov.querySelector('#aqDone').addEventListener('click', aqClose);
  ov.querySelector('#aqSkip').addEventListener('click', () => { _aqMoveAfter(item.id); aqShowNext(); });
  ov.querySelector('#aqRej').addEventListener('click', async () => { item.done = true; item.rejected = true; await aqPersist(); aqShowNext(); });
  ov.querySelector('#aqOk').addEventListener('click', () => aqApprove(item));
}

// דילוג: מזיז את הפריט לסוף התור כדי שלא ייתקע עליו
function _aqMoveAfter(id) {
  const i = _aqState.items.findIndex(x => x.id === id);
  if (i >= 0) { const [it] = _aqState.items.splice(i, 1); _aqState.items.push(it); }
}

async function aqApprove(item) {
  const g = id => (document.getElementById(id) || {}).value;
  const title = (g('aqTitle') || '').trim() || item.title;
  const page = Number(g('aqPage')) || null;
  const price = Number(g('aqPrice')) || 0;
  let custVal = g('aqCust');
  try {
    let customerId = null, createdCustId = null;
    if (custVal === 'new') {
      const { data, error } = await db.from('customers').insert({ name: title, status: 'active' }).select('id,name,status,agent_id').single();
      if (error) { toast('שגיאה ביצירת לקוח: ' + error.message, true); return; }
      customerId = data.id; createdCustId = data.id;
      if (cache.customers) cache.customers.push(data);
    } else { customerId = Number(custVal) || null; }
    const notes = [item.note, item.paid].filter(Boolean).join(' · ') || null;
    const rec = {
      customer_id: customerId, title, issue_id: _aqState.issueId,
      page_number: page, price, discount: 0,
      status: 'placed', source: 'manual', notes, created_by: profile.id,
    };
    const { error: adErr } = await db.from('ads').insert(rec);
    if (adErr) {
      if (createdCustId) { try { await db.from('customers').delete().eq('id', createdCustId); if (cache.customers) cache.customers = cache.customers.filter(c => c.id !== createdCustId); } catch (e) { } }
      toast('שגיאה ביצירת מודעה: ' + adErr.message, true); return;
    }
    item.done = true; item.approved = true;
    await aqPersist();
    toast('אושר ✓');
    aqShowNext();
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

function aqClose() { const ov = document.getElementById('aqOverlay'); if (ov) ov.remove(); }

/* הפעלה אחרי הכניסה */
(function () {
  const orig = window.afterLogin;
  if (typeof orig === 'function' && !orig._aqWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { await aqStart(); } catch (e) { console.error('approve-import', e); }
      return r;
    };
    wrapped._aqWrapped = true;
    window.afterLogin = wrapped;
  }
})();
