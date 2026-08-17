/* ============================================================
subscriptions.js — הרחבת חוזים: תדירות (רצף/חודשי/דו-חודשי/תאריכים נבחרים)
------------------------------------------------------------
- טופס חוזה מותאם עם בורר תדירות + שורות תאריך מלוח-שנה (+ הוסף שורה)
- יצירת מודעות מחוזים לפי תדירות (מחליף את קריאת ה-RPC, בצד הלקוח)
- תזכורת שבועית למנהל/עימוד: מודעות מנוי להכנסה לגיליון הקרוב
- שמירה בטוחה: אם עמודות cadence/selected_dates עדיין לא קיימות ב-DB,
  החוזה נשמר כ"רצף" בלי לשבור דבר.
============================================================ */

'use strict';

const SUB_CADENCES = [
  { v: 'every', t: 'כל גיליון (רצף)' },
  { v: 'monthly', t: 'פעם בחודש' },
  { v: 'bimonthly', t: 'פעם בחודשיים' },
  { v: 'selected', t: 'תאריכים נבחרים' },
];
function _subCadenceHe(v) { const x = SUB_CADENCES.find(c => c.v === v); return x ? x.t : 'כל גיליון (רצף)'; }
function _subOpts(items, sel, labelFn) {
  return (items || []).map(it => `<option value="${it.id}" ${it.id === sel ? 'selected' : ''}>${esc(labelFn(it))}</option>`).join('');
}

/* ---------- טופס חוזה מותאם ---------- */
function subContractModal(existing) {
  const c = existing || {};
  const dates = Array.isArray(c.selected_dates) ? c.selected_dates : [];
  const cad = c.cadence || 'every';
  document.getElementById('viewModal').innerHTML = `
    <h3>${existing ? 'עריכת חוזה — ' + esc(nameOf('customers', c.customer_id)) : 'חוזה חדש'}</h3>
    <div class="grid2">
      <div class="field"><label>לקוח *</label><select id="subCust">${_subOpts(cache.customers, c.customer_id, x => x.name)}</select></div>
      <div class="field"><label>סוכן</label><select id="subAgent"><option value="">—</option>${_subOpts(cache.agents, c.agent_id, x => x.name)}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>סוג מודעה (מהמחירון) *</label><select id="subItem">${_subOpts(cache.priceList, c.price_item_id, x => x.name || x.label || ('#' + x.id))}</select></div>
      <div class="field"><label>תדירות *</label><select id="subCadence" onchange="subToggleDates()">
        ${SUB_CADENCES.map(o => `<option value="${o.v}" ${o.v === cad ? 'selected' : ''}>${o.t}</option>`).join('')}</select></div>
    </div>
    <div id="subDatesBox" class="${cad === 'selected' ? '' : 'hidden'}" style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px;margin:8px 0;background:#fbfdff">
      <label style="font-weight:700">תאריכים נבחרים</label>
      <p class="muted" style="font-size:.78rem;margin:2px 0 8px">בחר את התאריכים שבהם המודעה תיכנס. אפשר להוסיף שורות.</p>
      <div id="subDatesList"></div>
      <button class="btn btn-sm btn-ghost" onclick="subAddDate()">+ הוסף תאריך</button>
    </div>
    <div class="grid2">
      <div class="field"><label>מספר פרסומים בחבילה *</label><input id="subInserts" type="number" value="${c.total_inserts != null ? c.total_inserts : 13}" dir="ltr"></div>
      <div class="field"><label>מחיר כולל (₪, לפני מע"מ) *</label><input id="subPrice" type="number" value="${c.total_price != null ? c.total_price : ''}" dir="ltr"></div>
    </div>
    <div class="field"><label>נוצל עד כה (ידני) — פרסומים שכבר מומשו מחוץ למערכת</label>
      <input id="subUsedOffset" type="number" min="0" value="${c.used_offset != null ? c.used_offset : 0}" dir="ltr">
      <p class="muted" style="font-size:.76rem;margin-top:2px">נספר בנוסף למודעות שכבר קושרו לעסקה במערכת.</p></div>
    <div class="grid2">
      <div class="field"><label>📅 תאריך סגירת עסקה</label><input id="subClosed" type="date" value="${c.closed_date || today()}">
        <p class="muted" style="font-size:.74rem;margin-top:2px">היום שבו נסגרה העסקה — לפיו נספרת הצמיחה החודשית.</p></div>
      <div class="field"><label>תאריך התחלה (פרסום ראשון)</label><input id="subStart" type="date" value="${c.start_date || today()}"></div>
    </div>
    <div class="field"><label>% עמלה מיוחד (ריק = לפי הסוכן)</label><input id="subComm" type="number" value="${c.commission_pct != null ? c.commission_pct : ''}" dir="ltr"></div>
    <div class="field"><label>הערות</label><textarea id="subNotes" rows="2">${esc(c.notes || '')}</textarea></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:6px"><input type="checkbox" id="subActive" ${c.active === false ? '' : 'checked'}> פעיל</label>
    <label style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="subSkip" ${c.skip_next ? 'checked' : ''}> דלג על הגיליון הקרוב</label>
    <div class="m-actions" style="margin-top:12px">
      <button class="btn" onclick="subContractSave(${existing ? c.id : 'null'})">שמירה</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  // אתחול שורות התאריכים
  if (cad === 'selected') { if (dates.length) dates.forEach(d => subAddDate(d)); else subAddDate(); }
}

function subToggleDates() {
  const cad = document.getElementById('subCadence').value;
  const box = document.getElementById('subDatesBox');
  box.classList.toggle('hidden', cad !== 'selected');
  if (cad === 'selected' && !document.querySelector('#subDatesList .sub-date-row')) subAddDate();
}

function subAddDate(val) {
  const list = document.getElementById('subDatesList');
  const row = document.createElement('div');
  row.className = 'sub-date-row';
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
  row.innerHTML = `<input type="date" value="${typeof val === 'string' ? val : ''}" style="padding:6px 8px;border:1px solid var(--line,#e5e7eb);border-radius:8px">
    <span style="cursor:pointer;color:#c0392b;font-weight:900" onclick="this.parentElement.remove()">✕</span>`;
  list.appendChild(row);
}

function _subCollectDates() {
  return [...document.querySelectorAll('#subDatesList .sub-date-row input[type=date]')]
    .map(i => i.value).filter(Boolean).sort();
}

async function subContractSave(id) {
  const cad = document.getElementById('subCadence').value;
  const dates = cad === 'selected' ? _subCollectDates() : [];
  if (cad === 'selected' && !dates.length) { toast('הוסף לפחות תאריך אחד', true); return; }
  let inserts = Number(document.getElementById('subInserts').value) || 0;
  if (cad === 'selected') inserts = dates.length; // בתאריכים נבחרים מספר הפרסומים = מספר התאריכים
  const rec = {
    customer_id: Number(document.getElementById('subCust').value) || null,
    agent_id: Number(document.getElementById('subAgent').value) || null,
    price_item_id: Number(document.getElementById('subItem').value) || null,
    total_inserts: inserts,
    total_price: Number(document.getElementById('subPrice').value) || 0,
    commission_pct: document.getElementById('subComm').value !== '' ? Number(document.getElementById('subComm').value) : null,
    start_date: document.getElementById('subStart').value || null,
    closed_date: document.getElementById('subClosed').value || null,
    active: document.getElementById('subActive').checked,
    skip_next: document.getElementById('subSkip').checked,
    notes: document.getElementById('subNotes').value || null,
    cadence: cad,
    selected_dates: dates,
    used_offset: Math.max(0, Number(document.getElementById('subUsedOffset') && document.getElementById('subUsedOffset').value) || 0),
  };
  if (!rec.customer_id || !rec.price_item_id || !rec.total_price) { toast('נא למלא לקוח, סוג מודעה ומחיר', true); return; }
  if (!rec.agent_id) { const cust = cache.customers.find(x => x.id === rec.customer_id); if (cust) rec.agent_id = cust.agent_id; }

  async function doSave(payload) {
    if (id) return db.from('contracts').update(payload).eq('id', id);
    return db.from('contracts').insert(payload).select('id').single();
  }
  let res = await doSave(rec);
  if (res.error && /cadence|selected_dates|column/i.test(res.error.message || '')) {
    // עמודות התדירות עדיין לא קיימות ב-DB — נשמור בלעדיהן (כרצף) בלי לשבור
    const { cadence, selected_dates, used_offset, ...safe } = rec;
    res = await doSave(safe);
    if (!res.error) toast('נשמר (התדירות תיכנס כשה-DB יתעדכן)');
  } else if (!res.error) {
    toast(id ? 'נשמר' : 'החוזה נוצר');
  }
  if (res.error) { toast('שגיאה: ' + res.error.message, true); return; }
  const newId = id || (res.data && res.data.id);
  if (!id) { try { await addInteraction('customer', rec.customer_id, `נחתם חוזה: ${_subCadenceHe(cad)} — ${nameOf('priceList', rec.price_item_id)} × ${rec.total_inserts}`); } catch (e) { } }
  // חוזה חדש → יצירת מודעה אוטומטית לגיליון הקרוב (אלא אם סומן "דלג על הקרוב")
  if (!id && newId && rec.active && !rec.skip_next) {
    try {
      const openIssues = await run(db.from('issues').select('id,issue_number,publish_date,print_date,status')
        .not('status', 'in', '("published","closed")').order('publish_date'));
      const T = today();
      const upcoming = openIssues.find(i => (i.publish_date || '') >= T) || openIssues[0];
      const c = await run(db.from('contracts').select('*').eq('id', newId).single());
      if (upcoming && c && subIssueMatches(upcoming, c, openIssues)) {
        const ok = await subInsertOne(newId, upcoming.id);
        if (ok) toast('✓ נוספה מודעה מהחוזה לגיליון ' + upcoming.issue_number);
      }
    } catch (e) { console.error('auto-insert contract ad', e); }
  }
  document.getElementById('viewBack').classList.remove('open');
  openPage('contracts');
}

/* עוקף את הטופס הישן */
window.contractAdd = function () { subContractModal(null); };
window.contractEdit = function (id) {
  const c = (typeof _contracts !== 'undefined') ? _contracts.find(x => x.id === id) : null;
  subContractModal(c || { id });
};

/* ---------- יצירת מודעות מחוזים לפי תדירות (צד לקוח) ---------- */
function subIssueMatches(issue, contract, allIssues) {
  const cad = contract.cadence || 'every';
  if (cad === 'every') return true;
  if (cad === 'selected') {
    const dates = Array.isArray(contract.selected_dates) ? contract.selected_dates : [];
    return dates.includes(issue.publish_date) || dates.includes(issue.print_date);
  }
  // חודשי / דו-חודשי: הגיליון הראשון של החודש (לפי חודש הסגירה לדפוס, עם נפילה לתאריך חלוקה)
  const _ed = (i) => (i.print_date || i.publish_date) || '';
  const mk = _ed(issue).slice(0, 7);
  const firstOfMonth = allIssues.filter(i => _ed(i).slice(0, 7) === mk)
    .sort((a, b) => _ed(a).localeCompare(_ed(b)))[0];
  if (!firstOfMonth || firstOfMonth.id !== issue.id) return false;
  if (cad === 'monthly') return true;
  const start = contract.start_date ? new Date(contract.start_date) : new Date(_ed(issue));
  const iss = new Date(_ed(issue));
  const months = (iss.getFullYear() - start.getFullYear()) * 12 + (iss.getMonth() - start.getMonth());
  return months % 2 === 0;
}

async function contractGenerateForIssue(issueId) {
  const issues = await run(db.from('issues').select('id,issue_number,publish_date,print_date,status'));
  const issue = issues.find(i => i.id === issueId);
  if (!issue) return 0;
  const contracts = await run(db.from('contracts').select('*').eq('active', true));
  const existing = await run(db.from('ads').select('contract_id').eq('issue_id', issueId).not('contract_id', 'is', null));
  const existingSet = new Set(existing.map(a => a.contract_id));
  const allAds = await run(db.from('ads').select('contract_id,status').not('contract_id', 'is', null));
  const used = {};
  allAds.forEach(a => { if (!['cancelled', 'rejected'].includes(a.status)) used[a.contract_id] = (used[a.contract_id] || 0) + 1; });
  let created = 0;
  const skippedIds = [];
  for (const c of contracts) {
    if (existingSet.has(c.id)) continue;
    if (((used[c.id] || 0) + (c.used_offset || 0)) >= c.total_inserts) continue;
    if (!subIssueMatches(issue, c, issues)) continue;
    if (c.skip_next) { skippedIds.push(c.id); continue; }
    const perInsert = c.total_inserts ? Math.round(Number(c.total_price) / c.total_inserts * 100) / 100 : Number(c.total_price);
    const rec = {
      customer_id: c.customer_id, agent_id: c.agent_id, price_item_id: c.price_item_id,
      price: perInsert, discount: 0, issue_id: issueId, contract_id: c.id,
      source: 'contract', status: 'approved',
      title: (nameOf('customers', c.customer_id) || 'לקוח') + ' — חוזה', created_by: profile.id,
    };
    if (c.commission_pct != null) rec.commission_pct = c.commission_pct;
    try { await run(db.from('ads').insert(rec)); created++; } catch (e) { console.error('gen ad', e); }
  }
  if (skippedIds.length) { try { await run(db.from('contracts').update({ skip_next: false }).in('id', skippedIds)); } catch (e) { } }
  return created;
}

/* הכנסת מודעה מעסקה בודדת לגיליון (per-deal) — לשימוש מהתזכורת / כרטיס לקוח */
async function subInsertOne(contractId, issueId) {
  const c = await run(db.from('contracts').select('*').eq('id', contractId).single());
  if (!c) { toast('עסקה לא נמצאה', true); return false; }
  const ex = (await db.from('ads').select('id').eq('contract_id', contractId).eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")')).data;
  if (ex && ex.length) { toast('כבר קיימת מודעה מהעסקה בגיליון זה'); return false; }
  const perInsert = c.total_inserts ? Math.round(Number(c.total_price) / c.total_inserts * 100) / 100 : Number(c.total_price);
  const rec = {
    customer_id: c.customer_id, agent_id: c.agent_id, price_item_id: c.price_item_id,
    price: perInsert, discount: 0, issue_id: issueId, contract_id: c.id,
    source: 'contract', status: 'approved',
    title: (nameOf('customers', c.customer_id) || 'לקוח') + ' — חוזה', created_by: profile.id,
  };
  if (c.commission_pct != null) rec.commission_pct = c.commission_pct;
  await run(db.from('ads').insert(rec));
  return true;
}
window.subRemInsertRow = async function (contractId, issueId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  const ok = await subInsertOne(contractId, issueId);
  if (ok) { toast('✓ המודעה מהעסקה נוספה לגיליון'); const li = btn && btn.closest('li'); if (li) li.remove(); }
  else if (btn) { btn.disabled = false; btn.textContent = '✚ הכנס'; }
};

/* "השבוע לא" — מסמן שמנוי זה אינו נכנס לגיליון הנוכחי, בלי לצרוך פרסום מהחבילה.
   נרשם כמודעת-חוזה מבוטלת (status=cancelled, מחיר 0) לגיליון: כך היא לא תיווצר
   שוב אוטומטית ולא תופיע שוב בתזכורת, אך גם לא נספרת בניצול. */
async function subSkipOne(contractId, issueId) {
  const c = await run(db.from('contracts').select('*').eq('id', contractId).single());
  if (!c) { toast('עסקה לא נמצאה', true); return false; }
  const ex = (await db.from('ads').select('id,status').eq('contract_id', contractId).eq('issue_id', issueId)).data;
  if (ex && ex.length) { toast('כבר קיים סימון למנוי בגיליון זה'); return false; }
  await run(db.from('ads').insert({
    customer_id: c.customer_id, agent_id: c.agent_id, price_item_id: c.price_item_id,
    price: 0, discount: 0, issue_id: issueId, contract_id: contractId,
    source: 'contract', status: 'cancelled',
    title: (nameOf('customers', c.customer_id) || 'לקוח') + ' — מנוי (לא נכנס השבוע)', created_by: profile.id,
  }));
  return true;
}
window.subRemSkipWeek = async function (contractId, issueId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  const ok = await subSkipOne(contractId, issueId);
  if (ok) { toast('✓ סומן: לא נכנס השבוע'); const li = btn && btn.closest('li'); if (li) li.remove(); }
  else if (btn) { btn.disabled = false; btn.textContent = '🚫 השבוע לא'; }
};

/* עוקף את יצירת המודעות מחוזים בעמוד הגיליונות */
window.contractAdsGenerate = async function () {
  if (typeof _issues === 'undefined' || !_issues.length) { toast('פתח קודם את עמוד הגיליונות', true); return; }
  const open = _issues.filter(i => !['published', 'closed'].includes(i.status));
  if (!open.length) { toast('אין גיליון פתוח', true); return; }
  const target = open[open.length - 1];
  if (!confirm(`ליצור מודעות מהחוזים הפעילים לגיליון ${target.issue_number}?`)) return;
  const n = await contractGenerateForIssue(target.id);
  toast(`נוצרו ${n} מודעות מחוזים`);
  if (typeof openFlatplan === 'function') openFlatplan(target.id);
};

/* ---------- תזכורת שבועית: מודעות מנוי להכנסה לגיליון הקרוב ---------- */
async function subDueForUpcoming() {
  const issues = await run(db.from('issues').select('id,issue_number,publish_date,print_date,status')
    .not('status', 'in', '("published","closed")').order('publish_date'));
  if (!issues.length) return { issue: null, items: [] };
  const T = today();
  const upcoming = issues.find(i => (i.publish_date || '') >= T) || issues[0];
  const contracts = await run(db.from('contracts').select('*').eq('active', true));
  const existing = await run(db.from('ads').select('contract_id').eq('issue_id', upcoming.id).not('contract_id', 'is', null));
  const existingSet = new Set(existing.map(a => a.contract_id));
  const allAds = await run(db.from('ads').select('contract_id,status').not('contract_id', 'is', null));
  const used = {};
  allAds.forEach(a => { if (!['cancelled', 'rejected'].includes(a.status)) used[a.contract_id] = (used[a.contract_id] || 0) + 1; });
  const items = contracts.filter(c =>
    !existingSet.has(c.id) && ((used[c.id] || 0) + (c.used_offset || 0)) < c.total_inserts && subIssueMatches(upcoming, c, issues));
  return { issue: upcoming, items };
}

async function subMaybeReminder() {
  if (!['admin', 'editor'].includes(profile.role)) return; // מנהל + אחראי עימוד
  try {
    const { issue, items } = await subDueForUpcoming();
    if (!issue || !items.length) return;
    if (document.getElementById('subRemOverlay')) return;
    const _vb = document.getElementById('viewBack');
    if (_vb && _vb.classList.contains('open')) return; // חלון אחר פתוח (למשל אשף ייבוא) — לא דורסים
    emuEnsureStyles();
    const ov = document.createElement('div');
    ov.id = 'subRemOverlay';
    ov.className = 'emu-overlay';
    const list = items.slice(0, 15).map(c =>
      `<li style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #eee">
        <span><b>${esc(nameOf('customers', c.customer_id))}</b> <span class="muted">· ${_subCadenceHe(c.cadence || 'every')}</span></span>
        <span style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm" onclick="subRemInsertRow(${c.id}, ${issue.id}, this)">✚ הכנס</button>
          <button class="btn btn-sm btn-ghost" onclick="subRemSkipWeek(${c.id}, ${issue.id}, this)">🚫 השבוע לא</button>
        </span>
      </li>`).join('');
    ov.innerHTML = `<div class="emu-oops" style="max-width:460px;text-align:right">
      <div style="text-align:center" class="ic">🗞️</div>
      <p style="text-align:center;margin:8px 0 6px"><b>מודעות מנוי להכנסה — גיליון ${issue.issue_number}</b><br>
        <span style="font-size:.9rem;color:#555">${items.length} לקוחות שהמודעה שלהם צריכה להיכנס לגיליון הקרוב</span></p>
      <ul style="list-style:none;margin:6px 0 14px;padding:0;max-height:42vh;overflow:auto">${list}</ul>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-sm" id="subRemGen">✚ צור את כולן עכשיו</button>
        <button class="btn btn-sm btn-ghost" id="subRemOpen">פתח את הגיליון</button>
        <button class="btn btn-sm btn-ghost" id="subRemLater">אחר כך</button>
      </div>
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('#subRemLater').addEventListener('click', close);
    ov.querySelector('#subRemOpen').addEventListener('click', () => { close(); openPage('issues').then(() => openFlatplan(issue.id)); });
    ov.querySelector('#subRemGen').addEventListener('click', async () => {
      const n = await contractGenerateForIssue(issue.id);
      toast(`נוצרו ${n} מודעות`); close();
    });
    document.body.appendChild(ov);
  } catch (e) { console.error('sub reminder', e); }
}

/* הפעלת התזכורת אחרי הכניסה */
(function () {
  const orig = window.afterLogin;
  if (typeof orig === 'function' && !orig._subWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      setTimeout(() => { try { subMaybeReminder(); } catch (e) { console.error(e); } }, 2600); // אחרי בדיקת אשף הייבוא, כדי לא לדרוס
      return r;
    };
    wrapped._subWrapped = true;
    window.afterLogin = wrapped;
  }
})();
