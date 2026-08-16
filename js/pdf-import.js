/* ============================================================
   pdf-import.js — אשף ייבוא מודעות מ-PDF (מודעה-מודעה)
   ------------------------------------------------------------
   נפתח בכניסה כשיש רשימת ייבוא ממתינה. לכל מודעה קופץ חלון:
   מותג (כותרת) · חיפוש/בחירת לקוח (או לקוח חדש) · גודל · עמוד.
   אישור → יוצר מודעה משובצת (source=manual). מצב מתעדכן בהגדרות.
   הרשימה נשמרת ב-settings בכל key: pdfimport_<מספר גיליון>.
   ============================================================ */

'use strict';

function _piKey(n) { return 'pdfimport_' + n; }

async function pdfImportLoad(issueNum) {
  try {
    const { data } = await db.from('settings').select('value').eq('key', _piKey(issueNum)).single();
    return data && data.value ? JSON.parse(data.value) : null;
  } catch (e) { return null; }
}
async function pdfImportSave() {
  if (!_piState) return;
  await run(db.from('settings').upsert({ key: _piKey(_piState.issueNum), value: JSON.stringify(_piState.obj) }));
  if (cache.settings) cache.settings[_piKey(_piState.issueNum)] = JSON.stringify(_piState.obj);
}

let _piState = null;

async function pdfImportOpen(issueNum) {
  const obj = await pdfImportLoad(issueNum);
  if (!obj || !Array.isArray(obj.items)) { toast('אין רשימת ייבוא לגיליון ' + issueNum, true); return; }
  _piState = { issueNum, obj, issueId: obj.issue_id, selCust: null };
  _piNext();
}

function _piNext() {
  _piState.selCust = null;
  const items = _piState.obj.items;
  const pend = items.filter(it => !it.done);
  const doneN = items.length - pend.length;
  if (!pend.length) { _piDoneScreen(doneN, items.length); return; }
  _piShow(pend[0], doneN + 1, items.length);
}

function _piDoneScreen(done, total) {
  document.getElementById('viewModal').innerHTML = `
    <h3>✓ סיימת את הייבוא — גיליון ${_piState.issueNum}</h3>
    <p>הוזנו/טופלו ${done} מתוך ${total} מודעות.</p>
    <div class="m-actions" style="flex-wrap:wrap">
      <button class="btn" onclick="pdfImportNext(${_piState.issueNum})">המשך לגיליון הבא ←</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open');openFlatplan(${_piState.issueId})">לפלטפלן</button>
      <button class="btn btn-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`;
  document.getElementById('viewBack').classList.add('open');
}

/* מעבר לגיליון הבא שממתין לייבוא — בלי צורך לרענן */
async function pdfImportNext(fromNum) {
  const list = [286, 287, 288, 289, 290, 291, 292, 293, 294];
  const start = list.indexOf(Number(fromNum));
  for (let i = start + 1; i < list.length; i++) {
    const obj = await pdfImportLoad(list[i]);
    if (obj && Array.isArray(obj.items) && obj.items.some(it => !it.done)) { pdfImportOpen(list[i]); return; }
  }
  toast('אין גיליונות נוספים לייבוא — סיימת! 🎉');
  const vb = document.getElementById('viewBack'); if (vb) vb.classList.remove('open');
}

function _piShow(item, idx, total) {
  // התאמת לקוח אוטומטית: לפי שם המותג, ואם אין — לפי רמז הלקוח (עמודת "שם" בגיליון / מועצה / קהילתי)
  const _norm = s => (s || '').trim();
  let exact = (cache.customers || []).find(c => _norm(c.name) === _norm(item.brand));
  if (!exact && item.custHint) exact = (cache.customers || []).find(c => _norm(c.name) === _norm(item.custHint));
  _piState.selCust = exact ? { id: exact.id, name: exact.name } : null;
  // גודל: אין נתון בגיליון → מנסים להתאים לפי המחיר; אחרת ברירת מחדל ריקה ("בחר גודל") ולא הפריט הראשון
  const _matchSize = item.size || ((item.price != null && item.price !== '') ? ((cache.priceList || []).find(p => Number(p.price) === Number(item.price)) || {}).id : null);
  const sizeOpts = `<option value="" ${!_matchSize ? 'selected' : ''}>— בחר גודל —</option>` + (cache.priceList || []).map(p => `<option value="${p.id}" ${p.id === _matchSize ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('');
  document.getElementById('viewModal').innerHTML = `
    <h3>📥 ייבוא מודעה ${idx} מתוך ${total}</h3>
    <p class="muted" style="font-size:.82rem;margin-top:-8px">גיליון ${_piState.issueNum} · עמוד ${item.page || '?'}${item.category ? ' · <b>' + esc(item.category) + '</b>' : ''}${item.status ? ' · סטטוס: <b>' + esc(item.status) + '</b>' : ''}${item.custHint ? ' · שם: ' + esc(item.custHint) : ''}${item.phone ? ' · טל׳ ' + esc(item.phone) : ''}</p>

    <div class="field"><label>כותרת המודעה (מותג כפי שמופיע בגיליון)</label>
      <input id="piTitle" value="${esc(item.brand || '')}"></div>

    <div class="field"><label>לקוח (שם החשבונית) — חפש ובחר, או צור חדש</label>
      <input id="piCustSearch" placeholder="הקלד שם לחיפוש..." oninput="piCustSearch(this.value)" autocomplete="off">
      <div id="piCustRes" style="max-height:160px;overflow:auto;border:1px solid var(--line);border-radius:8px;margin-top:4px;display:none"></div>
      <div id="piCustSel" style="margin-top:6px"></div>
    </div>

    <div class="grid3">
      <div class="field"><label>גודל (מחירון)</label><select id="piSize" onchange="piSyncPrice()">${sizeOpts}</select></div>
      <div class="field"><label>מחיר (₪) — ניתן לשנות</label><input type="number" id="piPrice" value="${(item.price != null && item.price !== '') ? item.price : _piListPrice(item.size)}" step="1"></div>
      <div class="field"><label>עמוד</label><input type="number" id="piPage" value="${item.page || ''}"></div>
    </div>
    <div class="field"><label>שלב עסקה (לא חובה)</label>
      <select id="piStage"><option value="">—</option>${typeof DEAL_STAGES !== 'undefined' ? Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}" ${item.stage === v ? 'selected' : ''}>${t[0]}</option>`).join('') : ''}</select></div>

    <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--brand);font-weight:600"><input type="checkbox" id="piSystem" onchange="piSysToggle()" style="width:18px;height:18px"> 🏛 מודעת מערכת (לא בתשלום — תופסת מקום, ₪0)</label></div>

    <div class="m-actions" style="flex-wrap:wrap">
      <button class="btn" style="background:var(--ok)" onclick="piSubmit()">✓ אשר והזן</button>
      <button class="btn btn-ghost" onclick="piSkip()">⏭ דלג</button>
      <button class="btn btn-danger-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">עצור לעכשיו</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  _piRenderSel();
  // אם לא נמצאה התאמה מדויקת אך יש רמז שם — נטען חיפוש מוכן כדי לזרז בחירה ידנית
  if (!_piState.selCust && item.custHint) { const si = document.getElementById('piCustSearch'); if (si) { si.value = item.custHint; piCustSearch(item.custHint); } }
  if (item.system) { const cb = document.getElementById('piSystem'); if (cb) { cb.checked = true; piSysToggle(); } }
}

function piCustSearch(term) {
  const box = document.getElementById('piCustRes');
  term = (term || '').trim();
  if (!term) { box.style.display = 'none'; return; }
  const matches = (cache.customers || []).filter(c => (c.name || '').includes(term)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(c => `<div style="padding:8px 10px;cursor:pointer;border-bottom:1px solid #f1f4fa" onclick="piPickCust(${c.id})">${esc(c.name)}${c.phone ? ' <span class="muted" style="font-size:.8rem" dir="ltr">' + esc(c.phone) + '</span>' : ''}</div>`).join('')
    : `<div style="padding:8px 10px"><button class="btn btn-sm" onclick="piNewCust()">➕ צור לקוח חדש: "${esc(term)}"</button></div>`;
  box.style.display = 'block';
}
function piPickCust(id) {
  const c = (cache.customers || []).find(x => x.id === id);
  _piState.selCust = c ? { id: c.id, name: c.name } : null;
  document.getElementById('piCustRes').style.display = 'none';
  document.getElementById('piCustSearch').value = '';
  _piRenderSel();
}
function piNewCust() {
  const term = (document.getElementById('piCustSearch').value || '').trim();
  /* פותח את חלון "לקוח חדש" המלא כדי לקלוט ח.פ ופרטי חשבונית כבר עכשיו (מעל חלון הייבוא) */
  if (typeof customerCreateFull === 'function') {
    customerCreateFull(term, (data) => { piPickCust(data.id); });
    return;
  }
  _piState.selCust = { id: null, name: term, isNew: true };
  document.getElementById('piCustRes').style.display = 'none';
  _piRenderSel();
}
function _piRenderSel() {
  const el = document.getElementById('piCustSel'); if (!el) return;
  const s = _piState.selCust;
  if (!s) { el.innerHTML = '<span class="muted" style="font-size:.85rem">לא נבחר לקוח עדיין</span>'; return; }
  el.innerHTML = s.isNew
    ? `<span class="pill gold">לקוח חדש: ${esc(s.name)}</span> <span class="muted" style="font-size:.8rem">(ייווצר בעת האישור)</span>`
    : `<span class="pill green">לקוח: ${esc(s.name)}</span>`;
}

function _piListPrice(sizeId) { const p = (cache.priceList || []).find(x => x.id === Number(sizeId)); return p ? Number(p.price) : ''; }
function piSyncPrice() { const inp = document.getElementById('piPrice'); if (inp && String(inp.value).trim() === '') inp.value = _piListPrice(document.getElementById('piSize').value); } // ממלא מחיר מהמחירון רק אם השדה ריק — לא דורס סכום שכבר הוזן (מהגיליון / עם הנחה)

function piSysToggle() {
  const c = document.getElementById('piSystem').checked;
  const pr = document.getElementById('piPrice');
  if (c) { pr.value = '0'; pr.setAttribute('disabled', 'disabled'); }
  else { pr.removeAttribute('disabled'); piSyncPrice(); }
}
async function _piSystemCust() {
  let c = (cache.customers || []).find(x => (x.name || '').trim() === 'מערכת (תוכן)');
  if (c) return c.id;
  const ins = await db.from('customers').insert({ name: 'מערכת (תוכן)' }).select('id,name,agent_id,phone').single();
  if (ins.error) throw new Error('לקוח מערכת: ' + ins.error.message);
  if (cache.customers) cache.customers.push(ins.data);
  return ins.data.id;
}

async function piSubmit() {
  if (!_piState) return;
  const s = _piState.selCust;
  const isSystem = document.getElementById('piSystem') && document.getElementById('piSystem').checked;
  if (!s && !isSystem) { toast('בחר לקוח או צור חדש', true); return; }
  const title = (document.getElementById('piTitle').value || '').trim();
  const sizeId = Number(document.getElementById('piSize').value) || null;
  const page = Number(document.getElementById('piPage').value) || null;
  const stage = document.getElementById('piStage').value || null;
  const priceItem = (cache.priceList || []).find(p => p.id === sizeId);
    const _rawPrice = (document.getElementById('piPrice').value || '').trim();
    const _finalPrice = _rawPrice === '' ? (priceItem ? Number(priceItem.price) : 0) : Number(_rawPrice);
  let custId = s ? s.id : null;
  try {
    if (s && s.isNew) {
      const ins = await db.from('customers').insert({ name: s.name }).select('id,name,agent_id,phone').single();
      if (ins.error) throw new Error('יצירת לקוח: ' + ins.error.message);
      custId = ins.data.id;
      if (cache.customers) cache.customers.push(ins.data);
    }
    if (isSystem && !custId) custId = await _piSystemCust();
    const payload = {
      title: title || (s ? s.name : '') || 'תוכן מערכת', customer_id: custId, issue_id: _piState.issueId,
      price_item_id: sizeId, page_number: page, status: 'placed', source: 'manual',
      created_by: profile.id, price: isSystem ? 0 : (isFinite(_finalPrice) ? _finalPrice : 0), discount: 0, is_system: !!isSystem,
      deal_stage: stage,
    };
    const ins = await db.from('ads').insert(payload).select('id').single();
    if (ins.error) throw new Error('יצירת מודעה: ' + ins.error.message);
    // סימון הפריט הנוכחי (הראשון הממתין) כטופל
    const target = _piState.obj.items.find(x => !x.done);
    if (target) { target.done = true; target.ad_id = ins.data.id; }
    await pdfImportSave();
    toast('✓ הוזנה: ' + (title || s.name));
    _piNext();
  } catch (e) { toast('שגיאה: ' + (e.message || e), true); }
}

async function piSkip() {
  const pend = _piState.obj.items.filter(x => !x.done);
  if (pend[0]) { pend[0].done = true; pend[0].skipped = true; await pdfImportSave(); }
  _piNext();
}

/* בדיקה בכניסה: אם יש ייבוא ממתין — הצעה לפתוח */
async function pdfImportCheckPending() {
  if (!['admin', 'sales'].includes(profile.role)) return false;
  for (const num of [286, 287, 288, 289, 290, 291, 292, 293, 294]) {
    const obj = await pdfImportLoad(num);
    if (obj && Array.isArray(obj.items)) {
      const pend = obj.items.filter(it => !it.done).length;
      if (pend > 0) { pdfImportOpen(num); return true; }
    }
  }
  return false;
}
