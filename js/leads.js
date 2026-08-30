/* ============================================================
leads.js — מודול לידים
------------------------------------------------------------
- הוספת ליד בלחיצת כפתור (שם + טלפון מספיקים) — הזמן נרשם אוטומטית
- קנבן: גרירת ליד בין שלבי המשפך, כל גרירה מתועדת
- לידים ללא שיוך: מאגר משותף שסוכן יכול "לתפוס" לעצמו
- צפייה משותפת: כל סוכן רואה את כל הלידים (כולל של סוכנים אחרים) —
  אבל עורך/גורר רק את שלו; ליד של סוכן אחר נפתח לצפייה בלבד (נאכף גם ב-RLS)
- חסימת כפילות לפי טלפון: אם המספר כבר אצל סוכן אחר — הסוכן לא יכול להזין
- סימון כפילות מול לקוחות: ליד שהטלפון שלו קיים אצל לקוח מקבל תג "קיים כלקוח"
  (RPC ‏lead_customer_duplicates — עובד גם כשהסוכן לא רואה את הלקוח ישירות)
- מסע לקוח: פולו-אפ עם תזכורת, ורישום סטטוס מחדש אחרי כל פולו-אפ
- סגירת ליד ללקוח: הנפשת "כל הכבוד" עם גביע ומטבעות זהב
============================================================ */

'use strict';

const LEAD_STAGES = ['new', 'contacted', 'meeting', 'proposal']; // עמודות הקנבן
let _leads = [];
let _leadDups = {}; // lead_id -> { customer_id, customer_name } — כפילות מול לקוח קיים
let _leadsView = localStorage.getItem('leads_view') || 'kanban'; // kanban / table

/* ---------- עזרי תפקיד ---------- */
function isAdmin() { return profile.role === 'admin'; }
function isSales() { return profile.role === 'sales'; }
function myAgentId() {
  const a = cache.agents.find(x => x.profile_id === profile.id);
  return a ? a.id : null;
}
/* צפייה משותפת: סוכן יכול לפעול רק על ליד שלו; ליד של סוכן אחר — צפייה בלבד
   (ליד מהמאגר נתפס דרך "תפוס ליד", לא בעריכה ישירה) */
function leadEditable(l) { return isAdmin() || !isSales() || l.agent_id === myAgentId(); }
/* תג כפילות מול לקוח קיים */
function leadDupTag(l) {
  const d = _leadDups[l.id];
  return d ? `<span class="pill amber" title="הטלפון של הליד קיים אצל לקוח במערכת">👥 קיים כלקוח: ${esc(d.customer_name)}</span>` : '';
}

Pages.leads = {
  render: async (el) => {
    // צפייה משותפת: כולם רואים את כל הלידים; ההגבלה בשרת היא על כתיבה בלבד
    _leads = await run(db.from('leads').select('*').order('created_at', { ascending: false }));

    // כפילות מול לקוחות (RPC עם security definer — רואה את כל הלקוחות).
    // אם המיגרציה עוד לא רצה במופע — ממשיכים בשקט בלי תגי כפילות.
    _leadDups = {};
    try {
      const { data } = await db.rpc('lead_customer_duplicates');
      (data || []).forEach(d => _leadDups[d.lead_id] = d);
    } catch (e) { /* הפונקציה עוד לא קיימת במופע הזה */ }

    const scopeBar = isAdmin()
      ? `<select id="leadAgentFilter" onchange="leadsDraw()">
           <option value="">כל הסוכנים</option>
           <option value="__none__">— ללא שיוך (מאגר) —</option>
           ${cache.agents.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
         </select>`
      : `<select id="leadScope" onchange="leadsDraw()">
           <option value="mine">הלידים שלי</option>
           <option value="pool">מאגר ללא שיוך</option>
           <option value="mine_pool">שלי + מאגר</option>
           <option value="all">👁 כל הלידים (צפייה משותפת)</option>
         </select>`;

    el.innerHTML = `
      <div class="page-head">
        <h2>לידים</h2>
        <div class="actions">
          <input type="file" id="leadImportFile" class="hidden" accept=".xlsx,.xls,.csv" onchange="leadsImport()">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('leadImportFile').click()">⬆ ייבוא מאקסל</button>
          <button class="btn btn-ghost btn-sm" onclick="leadsSwitchView()">
            ${_leadsView === 'kanban' ? '☰ תצוגת טבלה' : '▦ תצוגת קנבן'}</button>
          <button class="btn" onclick="leadQuickAdd()">+ ליד חדש</button>
        </div>
      </div>
      <div class="filter-bar">
        <input id="leadSearch" placeholder="חיפוש..." oninput="leadsDraw()" style="min-width:200px">
        ${scopeBar}
        <select id="leadShowClosed" onchange="leadsDraw()">
          <option value="open">פתוחים בלבד</option>
          <option value="all">כולל סגורים</option>
        </select>
      </div>
      <div id="leadDelReqs"></div>
      <div id="leadsArea"></div>`;
    emuEnsureStyles(); // סגנונות הכרטיסים (תפיסה/מאגר/צפייה-בלבד) כבר ברינדור
    leadsDraw();
    if (isAdmin() && typeof leadRenderDelReqs === 'function') leadRenderDelReqs();
  }
};

function leadsSwitchView() {
  _leadsView = _leadsView === 'kanban' ? 'table' : 'kanban';
  localStorage.setItem('leads_view', _leadsView);
  openPage('leads');
}

/* סינון לפי חיפוש, היקף (סוכן/מאגר), ומצב פתוח/סגור */
function leadsFiltered() {
  const term = (document.getElementById('leadSearch')?.value || '').trim();
  const showClosed = (document.getElementById('leadShowClosed')?.value || 'open') === 'all';

  let scopeMatch = () => true;
  if (isAdmin()) {
    const agent = document.getElementById('leadAgentFilter')?.value || '';
    if (agent === '__none__') scopeMatch = l => l.agent_id == null;
    else if (agent) scopeMatch = l => l.agent_id === Number(agent);
  } else {
    const scope = document.getElementById('leadScope')?.value || 'mine';
    const mine = myAgentId();
    if (scope === 'pool') scopeMatch = l => l.agent_id == null;
    else if (scope === 'mine') scopeMatch = l => l.agent_id === mine;
    else if (scope === 'all') scopeMatch = () => true; // צפייה משותפת — כולל של סוכנים אחרים
    else scopeMatch = l => l.agent_id === mine || l.agent_id == null; // mine_pool
  }

  return _leads.filter(l =>
    (isAdmin() || !l.pending_delete) &&
    (showClosed || !['won', 'lost'].includes(l.status)) &&
    scopeMatch(l) &&
    (!term || [l.name, l.phone, l.email, l.field, l.interest, l.notes].some(v => (v || '').includes(term))));
}

function leadsDraw() {
  const area = document.getElementById('leadsArea');
  const rows = leadsFiltered();
  if (_leadsView === 'table') { leadsDrawTable(area, rows); return; }

  /* --- קנבן --- */
  const showClosed = (document.getElementById('leadShowClosed')?.value || 'open') === 'all';
  const cols = showClosed ? [...LEAD_STAGES, 'won', 'lost'] : LEAD_STAGES;
  area.innerHTML = `<div class="kanban">` + cols.map(stage => {
    const items = rows.filter(l => l.status === stage);
    return `<div class="kanban-col" data-stage="${stage}"
        ondragover="event.preventDefault();this.classList.add('drag-over')"
        ondragleave="this.classList.remove('drag-over')"
        ondrop="leadDrop(event, '${stage}')">
        <h4>${STATUS.lead[stage][0]} <span class="muted">${items.length}</span></h4>
        <div class="cards">` +
      items.map(l => {
        const overdue = l.follow_up && l.follow_up <= today() && !['won', 'lost'].includes(l.status);
        const unassigned = l.agent_id == null;
        const canDrag = leadEditable(l); // ליד של סוכן אחר — לא נגרר (צפייה בלבד)
        return `<div class="kanban-card ${overdue ? 'overdue' : ''} ${unassigned ? 'pool' : ''} ${canDrag ? '' : 'shared-view'}" draggable="${canDrag}"
            ondragstart="event.dataTransfer.setData('text/plain','${l.id}')"
            onclick="openLeadCard(${l.id})">
            <div class="kc-name">${l.temperature ? tempDot(l.temperature) : ''}${esc(l.name)}</div>
            <div class="kc-meta">
              ${l.phone ? `<span dir="ltr">${esc(l.phone)}</span> · ` : ''}${esc(nameOf('agents', l.agent_id)) || '<b style="color:var(--danger,@@COLOR_GRAD@@)">ללא שיוך</b>'}
              ${l.follow_up ? `<br>מעקב: <b ${overdue ? 'style="color:var(--danger)"' : ''}>${heDate(l.follow_up)}${l.follow_up_time ? ' ' + l.follow_up_time.slice(0, 5) : ''}</b>` : ''}
            </div>
            ${leadDupTag(l) ? `<div style="margin-top:6px">${leadDupTag(l)}</div>` : ''}
            ${unassigned && isSales() ? `<button class="btn btn-sm claim-btn" onclick="event.stopPropagation();leadClaim(${l.id})">🎯 תפוס ליד</button>` : ''}
          </div>`;
      }).join('') + `</div></div>`;
  }).join('') + `</div>`;
}

function leadsDrawTable(area, rows) {
  renderTable(area, rows, [
    { h: 'שם', f: r => esc(r.name) + (leadDupTag(r) ? ' ' + leadDupTag(r) : '') },
    { h: 'טלפון', f: r => `<span dir="ltr">${esc(r.phone)}</span>` },
    { h: 'מקור', f: r => esc(r.source) },
    { h: 'סוכן', f: r => esc(nameOf('agents', r.agent_id)) || '<span class="pill amber">ללא שיוך</span>' },
    { h: 'מעקב הבא', f: r => r.follow_up && r.follow_up <= today() && !['won', 'lost'].includes(r.status) ? `<span class="pill red">${heDate(r.follow_up)}</span>` : heDate(r.follow_up) },
    { h: 'נוצר', f: r => heDateTime(r.created_at) },
    { h: 'סטטוס', f: r => pill('lead', r.status) },
    { h: '', f: r => (r.agent_id == null && isSales()) ? `<button class="btn btn-sm claim-btn" onclick="event.stopPropagation();leadClaim(${r.id})">🎯 תפוס</button>` : '' },
  ], { onRow: r => openLeadCard(r.id), empty: 'אין לידים' });
}

/* --- תפיסת ליד מהמאגר (אטומי בשרת — מונע שני סוכנים על אותו ליד) --- */
async function leadClaim(id) {
  try {
    await run(db.rpc('claim_lead', { p_lead_id: id }));
    await addInteraction('lead', id, 'הליד נתפס על ידי הסוכן');
    const l = _leads.find(x => x.id === id);
    if (l) l.agent_id = myAgentId();
    toast('🎯 הליד נתפס — הוא שלך עכשיו');
    document.getElementById('viewBack')?.classList.remove('open');
    openPage('leads');
  } catch (e) { /* השגיאה כבר הוצגה ב-run (למשל: כבר נתפס) */ }
}

/* --- גרירה בקנבן: עדכון סטטוס + תיעוד אוטומטי --- */
async function leadDrop(ev, stage) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('drag-over');
  const id = Number(ev.dataTransfer.getData('text/plain'));
  const lead = _leads.find(l => l.id === id);
  if (!lead || lead.status === stage) return;
  if (!leadEditable(lead)) { toast(lead.agent_id == null ? 'ליד מהמאגר — קודם "תפוס ליד"' : 'ליד של סוכן אחר — צפייה בלבד', true); return; }
  if (stage === 'lost') { leadMarkLost(id); return; } // אבוד — דורש סיבה
  if (stage === 'won') { leadConvert(id); return; }   // נסגר — המרה ללקוח + חגיגה
  const from = STATUS.lead[lead.status][0], to = STATUS.lead[stage][0];
  await run(db.from('leads').update({ status: stage }).eq('id', id));
  await addInteraction('lead', id, `סטטוס שונה: ${from} ← ${to}`);
  lead.status = stage;
  leadsDraw();
}

/* --- הוספה מהירה: שם + טלפון, השאר אופציונלי --- */
function LEAD_FIELDS() {
  return [
    { type: 'section', label: 'זיהוי' },
    { name: 'name', label: 'שם', required: true },
    { name: 'contact_person', label: 'איש קשר' },
    { name: 'contact_role', label: 'תפקיד איש הקשר' },
    { name: 'phone', label: 'טלפון', dir: 'ltr' },
    { name: 'whatsapp', label: 'וואטסאפ / טלפון נוסף', dir: 'ltr' },
    { name: 'email', label: 'אימייל', dir: 'ltr' },
    { name: 'city', label: 'יישוב' },
    { name: 'field', label: 'תחום העסק' },
    { name: 'source', label: 'מקור', type: 'select', options: LEAD_SOURCES.map(s => ({ v: s, t: s })) },
    { name: 'source_detail', label: 'פרטי מקור (מי הפנה / איזו פנייה)' },
    { type: 'section', label: 'הצורך' },
    { name: 'interest', label: 'מה מעניין אותו' },
    { name: 'ad_size_id', label: 'גודל מודעה מבוקש', type: 'select', options: 'priceList' },
    { name: 'deal_type', label: 'סוג עסקה', type: 'select', options: [{ v: 'oneoff', t: 'חד-פעמי' }, { v: 'recurring', t: 'חוזה מתמשך' }] },
    { name: 'target_issue_id', label: 'גיליון יעד', type: 'select', options: 'issues' },
    { name: 'est_value', label: 'פוטנציאל כספי משוער (₪)', type: 'number' },
    { name: 'competitor', label: 'מפרסם היום אצל' },
    { type: 'section', label: 'מעקב' },
    { name: 'agent_id', label: 'סוכן מטפל (ריק = מאגר ללא שיוך)', type: 'select', options: 'agents' },
    { name: 'temperature', label: 'דרגת חום', type: 'select', options: [{ v: 'hot', t: '🔥 חם' }, { v: 'warm', t: 'פושר' }, { v: 'cold', t: 'קר' }] },
    { name: 'follow_up', label: 'תאריך מעקב הבא', type: 'date' },
    { name: 'follow_up_time', label: 'שעת מעקב (לתזכורת)', type: 'time' },
    { name: 'followup_method', label: 'אמצעי המעקב הבא', type: 'select', options: [{ v: 'call', t: 'טלפון' }, { v: 'whatsapp', t: 'וואטסאפ' }, { v: 'meeting', t: 'פגישה' }] },
    { type: 'section', label: 'סגירה והערות' },
    { name: 'objection', label: 'חסם / התנגדות עיקרית' },
    { name: 'reopen_date', label: 'תאריך לחזור אליו', type: 'date' },
    { name: 'notes', label: 'הערות', type: 'textarea' },
  ];
}

function tempDot(t) {
  const c = t === 'hot' ? '@@COLOR_GRAD@@' : t === 'warm' ? '#d35400' : '@@COLOR_BRAND@@';
  const lbl = t === 'hot' ? 'חם' : t === 'warm' ? 'פושר' : 'קר';
  return `<span title="${lbl}" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-left:6px;vertical-align:middle"></span>`;
}

function leadQuickAdd() {
  const myAgent = cache.agents.find(a => a.profile_id === profile.id);
  openForm('ליד חדש — הזמן נרשם אוטומטית', LEAD_FIELDS(), { agent_id: myAgent?.id }, async (rec) => {
    /* זיהוי כפילות לפי טלפון לפני השמירה */
    if (rec.phone) {
      const dups = await run(db.rpc('check_duplicate_phone', { p_phone: rec.phone }));
      if (dups.length) {
        const d = dups[0];
        const kind = d.kind === 'lead' ? 'ליד' : 'לקוח';

        // 1) כבר קיים אצלי
        if (d.mine) {
          const ex = _leads.find(x => x.phone === rec.phone && !['won', 'lost'].includes(x.status));
          if (d.kind === 'lead' && ex) {
            if (confirm(`המספר כבר קיים אצלך — ${kind} בשם "${d.name}".\nלפתוח את הכרטיס הקיים?`)) {
              closeForm(); openLeadCard(ex.id);
            }
            throw new Error('duplicate-mine');
          }
          showOops(`המספר כבר קיים אצלך אצל ${kind} "${esc(d.name)}".`);
          throw new Error('duplicate-mine');
        }

        // 2) קיים במאגר ללא שיוך — אפשר לתפוס אותו
        if (d.unassigned) {
          const ex = _leads.find(x => x.phone === rec.phone && x.agent_id == null);
          if (ex) {
            if (confirm(`הליד כבר קיים במאגר ללא שיוך בשם "${d.name}".\nלפתוח אותו כדי לתפוס?`)) {
              closeForm(); openLeadCard(ex.id);
            }
            throw new Error('duplicate-pool');
          }
          showOops(`הליד כבר קיים במאגר ללא שיוך בשם "${esc(d.name)}". חפש אותו בתצוגת "מאגר ללא שיוך" ותפוס אותו.`);
          throw new Error('duplicate-pool');
        }

        // 3) קיים אצל סוכן אחר — חסימה לסוכן, אישור למנהל
        if (!isAdmin()) {
          showOops(`אופססס! 🤚<br>המספר כבר נמצא אצל סוכן אחר (${kind} "${esc(d.name)}").<br><b>לא ניתן להזין את הליד.</b>`);
          throw new Error('duplicate-other');
        }
        if (!confirm(`שים לב: הטלפון כבר קיים אצל ${kind} "${d.name}" של סוכן אחר.\nלהוסיף בכל זאת?`)) {
          throw new Error('duplicate-other-cancel');
        }
      }
    }
    rec.created_by = profile.id;
    const data = await run(db.from('leads').insert(rec).select().single());
    await addInteraction('lead', data.id, 'הליד נוצר');
    toast('הליד נוסף — ' + heDateTime(data.created_at));
    openPage('leads');
  });
}

/* --- כרטיס ליד מלא: פרטים + ציר זמן + פעולות --- */
async function openLeadCard(id) {
  const l = _leads.find(x => x.id === id);
  if (!l) return;
  const notes = await loadTimeline('lead', id);
  const closed = ['won', 'lost'].includes(l.status);
  const unassigned = l.agent_id == null;
  const overdue = l.follow_up && l.follow_up <= today() && !closed;
  /* צפייה משותפת: ליד משויך לסוכן אחר — רואים הכל, בלי כפתורי פעולה */
  const viewOnly = !leadEditable(l) && !unassigned;
  const dup = _leadDups[id];
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `
    <h3>${esc(l.name)} ${pill('lead', l.status)}
      ${viewOnly ? '<span class="pill amber">👁 צפייה בלבד — ליד של סוכן אחר</span>' : ''}</h3>
    <div class="grid2" style="font-size:.9rem">
      <div><label>טלפון</label><b dir="ltr">${esc(l.phone) || '—'}</b></div>
      <div><label>אימייל</label><b dir="ltr">${esc(l.email) || '—'}</b></div>
      <div><label>מקור</label><b>${esc(l.source) || '—'}</b></div>
      <div><label>סוכן</label><b>${esc(nameOf('agents', l.agent_id)) || '<span class="pill amber">ללא שיוך</span>'}</b></div>
      <div><label>תחום</label><b>${esc(l.field) || '—'}</b></div>
      <div><label>מתעניין ב</label><b>${esc(l.interest) || '—'}</b></div>
      <div><label>מעקב הבא</label><b ${overdue ? 'style="color:var(--danger)"' : ''}>${heDate(l.follow_up) || '—'}${l.follow_up_time ? ' ' + l.follow_up_time.slice(0, 5) : ''}${overdue ? ' ⏰' : ''}</b></div>
      <div><label>נוצר</label><b>${heDateTime(l.created_at)}</b></div>
      ${dup ? `<div style="grid-column:1/-1"><label>כפילות מול לקוח</label>
        <span class="pill amber">👥 הטלפון קיים אצל הלקוח "${esc(dup.customer_name)}"</span>
        ${(isAdmin() || cache.customers.some(c => c.id === dup.customer_id)) && window.openCustomerCard
          ? `<button class="btn btn-sm btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open');openPage('customers').then(()=>openCustomerCard(${dup.customer_id}))">פתח את כרטיס הלקוח</button>` : ''}
      </div>` : ''}
      ${l.lost_reason ? `<div><label>סיבת אובדן</label><b>${esc(l.lost_reason)}</b></div>` : ''}
      ${l.notes ? `<div style="grid-column:1/-1"><label>הערות</label>${esc(l.notes)}</div>` : ''}
      ${l.pending_delete && isAdmin() ? `<div style="grid-column:1/-1;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px;font-size:.85rem;color:#991b1b">🗑 <b>בקשת מחיקה</b> מאת ${esc(nameOf('agents', l.delete_requested_by)) || 'סוכן'} — ${esc(l.delete_reason || '')}</div>` : ''}
    </div>
    <div class="m-actions" style="flex-wrap:wrap">
      ${closed || viewOnly ? '' : `
      ${unassigned && isSales() ? `<button class="btn btn-sm claim-btn" onclick="leadClaim(${id})">🎯 תפוס ליד</button>` : ''}
      ${phoneBtn(l.phone)}
      ${leadEditable(l) ? `
      <button class="btn btn-sm" onclick="leadFollowup(${id})">📅 פולו-אפ / עדכון סטטוס</button>
      <button class="btn btn-sm btn-ghost" onclick="leadAddNote(${id})">+ הערה לציר הזמן</button>
      <button class="btn btn-sm btn-ghost" onclick="leadEdit(${id})">עריכת פרטים</button>
      <button class="btn btn-sm btn-gold" onclick="leadConvert(${id})">➜ המרה ללקוח</button>
      <button class="btn btn-sm btn-ghost" onclick="leadQuotePlaceholder(${id})">הצעת מחיר</button>
      <button class="btn btn-sm btn-danger-ghost" onclick="leadMarkLost(${id})">סימון כאבוד</button>` : ''}`}
      ${l.pending_delete && isAdmin() ? `<button class="btn btn-sm" style="background:#16a34a;color:#fff" onclick="leadApproveDelete(${id})">✅ אשר מחיקה</button> <button class="btn btn-sm btn-ghost" onclick="leadRejectDelete(${id})">↩ דחה (העבר אליי)</button>` : ''}
      ${!l.pending_delete && (isAdmin() || (isSales() && l.agent_id === myAgentId())) ? `<button class="btn btn-sm btn-danger-ghost" onclick="leadDelete(${id})">🗑 מחיקה</button>` : ''}
      <button class="btn btn-sm btn-ghost" style="margin-right:auto"
        onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
    </div>
    <hr style="border:none;border-top:1px solid var(--line);margin:18px 0 12px">
    <b>מסע הלקוח — ציר זמן</b><div style="margin-top:10px">${timelineHtml(notes)}</div>`;
  document.getElementById('viewBack').classList.add('open');
}

function leadAddNote(id) {
  const content = prompt('מה לתעד? (שיחה, פגישה, סיכום...)');
  if (!content) return;
  addInteraction('lead', id, content).then(() => { toast('נרשם'); openLeadCard(id); });
}

/* --- פולו-אפ: רישום מה קרה + סטטוס מחדש + מועד המעקב הבא --- */
function leadFollowup(id) {
  const l = _leads.find(x => x.id === id);
  if (!l) return;
  document.getElementById('viewBack').classList.remove('open');
  openForm('פולו-אפ — מה קורה עם הלקוח?', [
    { name: 'outcome', label: 'סיכום השיחה / מה קרה בפולו-אפ', type: 'textarea', required: true, rows: 3 },
    { name: 'status', label: 'סטטוס הליד עכשיו', type: 'select', required: true,
      options: Object.entries(STATUS.lead).map(([v, t]) => ({ v, t: t[0] })) },
    { name: 'follow_up', label: 'תאריך הפולו-אפ הבא (אם צריך עוד מעקב)', type: 'date' },
    { name: 'follow_up_time', label: 'שעת הפולו-אפ הבא (לתזכורת)', type: 'time' },
  ], { status: l.status, follow_up: l.follow_up, follow_up_time: l.follow_up_time }, async (rec) => {
    const nextTxt = rec.follow_up ? ` · מעקב הבא: ${heDate(rec.follow_up)}` : '';
    await addInteraction('lead', id, `📅 פולו-אפ: ${rec.outcome} · סטטוס: ${STATUS.lead[rec.status][0]}${nextTxt}`);

    // נסגר → המרה ללקוח + חגיגה
    if (rec.status === 'won') {
      await run(db.from('leads').update({ follow_up: rec.follow_up, follow_up_time: rec.follow_up_time }).eq('id', id));
      const l2 = _leads.find(x => x.id === id); if (l2) l2.follow_up = rec.follow_up;
      closeForm();
      leadConvert(id, true);
      return;
    }
    // אבוד → סיבה = סיכום הפולו-אפ
    if (rec.status === 'lost') {
      await run(db.from('leads').update({ status: 'lost', lost_reason: rec.outcome, follow_up: null }).eq('id', id));
      toast('סומן כאבוד');
      openPage('leads');
      return;
    }
    // המשך טיפול — סטטוס + מועד מעקב הבא
    fuClear(id);
    await run(db.from('leads').update({ status: rec.status, follow_up: rec.follow_up, follow_up_time: rec.follow_up_time }).eq('id', id));
    toast('הפולו-אפ נרשם ✓');
    openPage('leads');
  });
}

function leadEdit(id) {
  const l = _leads.find(x => x.id === id);
  document.getElementById('viewBack').classList.remove('open');
  openForm('עריכת ליד — ' + l.name, LEAD_FIELDS(), l, async (rec) => {
    await run(db.from('leads').update(rec).eq('id', id));
    fuClear(id);
    await addInteraction('lead', id, 'הפרטים עודכנו');
    toast('נשמר');
    openPage('leads');
  });
}

async function leadConvert(id, skipConfirm = false) {
  const l = _leads.find(x => x.id === id);
  if (!l) return;
  if (!skipConfirm && !confirm(`להפוך את "${l.name}" ללקוח?\nכל ההיסטוריה תעבור לכרטיס הלקוח.`)) { leadsDraw(); return; }
  try {
    const customerId = await run(db.rpc('convert_lead', { p_lead_id: id }));
    try { await db.from('customers').update({ invoice_name: l.name, whatsapp: l.whatsapp, city: l.city, contact_role: l.contact_role }).eq('id', customerId); } catch (e) { console.error(e); }
    document.getElementById('viewBack')?.classList.remove('open');
    await celebrate();   // 🏆 כל הכבוד — גביע ומטבעות זהב
    await refreshCache();
    openPage('customers').then(() => { if (typeof leadDealForm === 'function') leadDealForm(customerId); else if (window.openCustomerCard) openCustomerCard(customerId); });
  } catch (e) { leadsDraw(); }
}

async function leadMarkLost(id) {
  const reason = prompt('סיבת האובדן (חובה):');
  if (!reason) { leadsDraw(); return; }
  await run(db.from('leads').update({ status: 'lost', lost_reason: reason }).eq('id', id));
  await addInteraction('lead', id, 'סומן כאבוד: ' + reason);
  document.getElementById('viewBack').classList.remove('open');
  toast('סומן כאבוד');
  openPage('leads');
}

/* --- מחיקת ליד: מנהל מוחק ישירות; סוכן שולח בקשת מחיקה לאישור המנהל --- */
async function leadDelete(id) {
  if (isSales()) { return leadRequestDelete(id); }
  const l = _leads.find(x => x.id === id);
  if (!confirm(`למחוק לצמיתות את הליד "${l ? l.name : ''}"?\nכל ציר הזמן שלו יימחק. הפעולה בלתי-הפיכה.`)) return;
  try {
    await run(db.rpc('delete_lead', { p_lead_id: id }));
    document.getElementById('viewBack')?.classList.remove('open');
    toast('🗑 הליד נמחק');
    openPage('leads');
  } catch (e) { /* run shows the error */ }
}

/* ---------- ייבוא לידים מאקסל ----------
   עמודות: שם (חובה) · טלפון · אימייל · מקור · תחום · מתעניין · הערות · סוכן
   כפילות לפי טלפון (מול לידים ולקוחות) — מדולגת */
async function leadsImport() {
  const input = document.getElementById('leadImportFile');
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  let rows;
  try { rows = await readSpreadsheet(file); }
  catch (e) { toast('לא הצלחתי לקרוא את הקובץ: ' + e.message, true); return; }
  if (!rows.length) { toast('הקובץ ריק או שאין שורת כותרות', true); return; }

  const [exLeads, exCustomers] = await Promise.all([
    run(db.from('leads').select('phone')),
    run(db.from('customers').select('phone')),
  ]);
  const knownPhones = new Set([...exLeads, ...exCustomers].map(x => x.phone).filter(Boolean));
  const myAgent = cache.agents.find(a => a.profile_id === profile.id);

  const toInsert = [], skipped = [];
  for (const row of rows) {
    const name = pickField(row, ['שם העסק', 'שם הליד', 'שם']);
    if (!name) { skipped.push('(בלי שם)'); continue; }
    const phone = pickField(row, ['טלפון', 'נייד', 'פלאפון', 'סלולרי', 'phone']);
    if (phone && knownPhones.has(phone)) { skipped.push(name); continue; }
    toInsert.push({
      name, phone,
      email: pickField(row, ['אימייל', 'מייל', 'email']),
      source: pickField(row, ['מקור']),
      field: pickField(row, ['תחום', 'ענף']),
      interest: pickField(row, ['מתעניין', 'התעניינות', 'מה מעניין']),
      notes: pickField(row, ['הערות', 'הערה']),
      agent_id: matchAgent(row, myAgent ? myAgent.id : null), // עמודת "סוכן" בקובץ (ריק = מאגר)
      created_by: profile.id,
    });
    if (phone) knownPhones.add(phone);
  }

  if (!toInsert.length) { toast('אין שורות חדשות לייבוא', true); return; }
  if (!confirm(`נמצאו ${toInsert.length} לידים חדשים לייבוא` +
    (skipped.length ? `\n(${skipped.length} דולגו — טלפון קיים או בלי שם)` : '') + '\n\nלהמשיך?')) return;

  for (let i = 0; i < toInsert.length; i += 50)
    await run(db.from('leads').insert(toInsert.slice(i, i + 50)));

  toast(`✓ יובאו ${toInsert.length} לידים` + (skipped.length ? ` · דולגו ${skipped.length}` : ''));
  openPage('leads');
}

/* הצעת מחיר מליד — הפונקציה המלאה נמצאת ב-sales.js */
function leadQuotePlaceholder(id) {
  const l = _leads.find(x => x.id === id);
  document.getElementById('viewBack').classList.remove('open');
  if (window.openQuoteForm) openQuoteForm({ lead_id: id, recipient_name: l.name });
  else toast('מודול הצעות המחיר בטעינה', true);
}

/* ============================================================
   תוספות UI עצמאיות (לא דורשות שינוי ב-index.html / app.js):
   1. showOops   — חלון "אופססס" לחסימת כפילות
   2. celebrate  — הנפשת "כל הכבוד" עם גביע ומטבעות זהב
   3. תזכורת פולו-אפ בכניסה + באדג' על "לידים"
   ============================================================ */

function emuEnsureStyles() {
  if (document.getElementById('emuFxStyles')) return;
  const s = document.createElement('style');
  s.id = 'emuFxStyles';
  s.textContent = `
  /* כפתור תפיסת ליד */
  .claim-btn{margin-top:8px;background:@@COLOR_BRAND@@;color:#fff;border:none}
  .kanban-card.pool{border-inline-start:4px solid @@COLOR_GRAD@@}
  /* צפייה משותפת: ליד של סוכן אחר — מעומעם קלות ולא נגרר */
  .kanban-card.shared-view:not(.pool){opacity:.75;cursor:default}
  /* שכבת-על משותפת */
  .emu-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:rgba(17,20,40,.55);backdrop-filter:blur(2px);animation:emuFade .25s ease}
  @keyframes emuFade{from{opacity:0}to{opacity:1}}
  /* אופססס */
  .emu-oops{background:#fff;border-radius:18px;max-width:380px;width:88%;padding:26px 22px;text-align:center;
    box-shadow:0 20px 60px rgba(0,0,0,.3);animation:emuPop .3s cubic-bezier(.2,1.4,.4,1)}
  .emu-oops .ic{font-size:52px;line-height:1}
  .emu-oops p{margin:12px 0 18px;font-size:1.05rem;color:#1c2438}
  @keyframes emuPop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
  /* חגיגה */
  .emu-celebrate{position:fixed;inset:0;z-index:9999;overflow:hidden;
    background:radial-gradient(circle at 50% 40%, rgba(43,57,144,.55), rgba(17,20,40,.85));animation:emuFade .3s ease}
  .emu-cel-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  .emu-trophy{position:relative;width:200px;height:230px;animation:emuTrophy .8s cubic-bezier(.2,1.5,.4,1)}
  @keyframes emuTrophy{0%{transform:scale(.3) rotate(-12deg);opacity:0}60%{transform:scale(1.12) rotate(4deg)}100%{transform:scale(1) rotate(0);opacity:1}}
  .emu-trophy .logo{position:absolute;top:52px;left:50%;transform:translateX(-50%);width:112px;height:auto;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}
  .emu-bravo{font-family:Arial,'Segoe UI',sans-serif;font-weight:900;font-size:clamp(38px,9vw,72px);
    background:linear-gradient(180deg,#fff3b0,#ffcf3f 45%,#d99a1c);-webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 2px 10px rgba(0,0,0,.25);animation:emuBravo .6s .25s both}
  @keyframes emuBravo{from{transform:translateY(18px) scale(.8);opacity:0}to{transform:none;opacity:1}}
  .emu-sub{color:#fff;font-size:1.05rem;opacity:.9;animation:emuBravo .6s .4s both}
  .emu-coin{position:absolute;top:-8vh;width:34px;height:34px;border-radius:50%;
    background:radial-gradient(circle at 34% 30%, #fff6c2, #ffcf3f 45%, #c9860f);
    box-shadow:0 0 6px rgba(255,196,0,.7), inset 0 -3px 4px rgba(150,90,0,.6);
    display:flex;align-items:center;justify-content:center;font-weight:900;color:#a9700a;font-size:18px;
    animation:emuCoinFall linear forwards}
  @keyframes emuCoinFall{0%{transform:translateY(0) rotate(0);opacity:1}
    85%{opacity:1}100%{transform:translateY(112vh) rotate(720deg);opacity:.9}}
  `;
  document.head.appendChild(s);
}

/* חלון "אופססס" לחסימת כפילות */
function showOops(html) {
  emuEnsureStyles();
  const ov = document.createElement('div');
  ov.className = 'emu-overlay';
  ov.innerHTML = `<div class="emu-oops">
      <div class="ic">🤚</div>
      <p>${html}</p>
      <button class="btn">הבנתי</button>
    </div>`;
  const close = () => ov.remove();
  ov.querySelector('button').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
}

/* הנפשת "כל הכבוד" — גביע זהב עם הלוגו + מטבעות נופלות */
function celebrate() {
  emuEnsureStyles();
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'emu-celebrate';

    // מטבעות
    let coins = '';
    const N = 34;
    for (let i = 0; i < N; i++) {
      const left = Math.random() * 100;
      const dur = 2.4 + Math.random() * 2.2;
      const delay = Math.random() * 1.6;
      const size = 22 + Math.random() * 20;
      coins += `<div class="emu-coin" style="left:${left}vw;width:${size}px;height:${size}px;
        animation-duration:${dur}s;animation-delay:${delay}s;font-size:${size * 0.5}px">₪</div>`;
    }

    // גביע זהב (SVG) עם הלוגו על הגביע
    const trophy = `
      <div class="emu-trophy">
        <svg viewBox="0 0 200 230" width="200" height="230" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#ffcf3f"/><stop offset="1" stop-color="#c9860f"/>
            </linearGradient>
          </defs>
          <!-- ידיות -->
          <path d="M40 44 C4 44 4 104 52 108" fill="none" stroke="url(#gold)" stroke-width="12" stroke-linecap="round"/>
          <path d="M160 44 C196 44 196 104 148 108" fill="none" stroke="url(#gold)" stroke-width="12" stroke-linecap="round"/>
          <!-- גביע -->
          <path d="M38 30 H162 V70 C162 118 132 150 100 150 C68 150 38 118 38 70 Z" fill="url(#gold)" stroke="#b9790a" stroke-width="2"/>
          <!-- רגל ובסיס -->
          <rect x="92" y="150" width="16" height="30" fill="url(#gold)"/>
          <rect x="66" y="180" width="68" height="14" rx="4" fill="url(#gold)"/>
          <rect x="56" y="194" width="88" height="16" rx="4" fill="url(#gold)" stroke="#b9790a" stroke-width="1.5"/>
        </svg>
        <img class="logo" src="img/logo.png" alt="@@PAPER_NAME@@"
             onerror="this.onerror=null;this.src='img/logo.svg'">
      </div>`;

    ov.innerHTML = `${coins}
      <div class="emu-cel-center">
        ${trophy}
        <div class="emu-bravo">כל הכבוד!</div>
        <div class="emu-sub">ליד חדש נסגר והפך ללקוח 🎉</div>
      </div>`;

    let done = false;
    const finish = () => { if (done) return; done = true; ov.remove(); resolve(); };
    ov.addEventListener('click', finish);
    document.body.appendChild(ov);
    setTimeout(finish, 5200);
  });
}

/* ---------- תזכורת פולו-אפ בכניסה + באדג' על "לידים" ---------- */
async function maybeFollowupReminder() {
  if (!['admin', 'sales'].includes(profile.role)) return;
  try {
    const { data } = await db.from('leads')
      .select('id,name,follow_up,agent_id,status,phone')
      .not('status', 'in', '("won","lost")')
      .not('follow_up', 'is', null)
      .lte('follow_up', today())
      .order('follow_up');
    let rows = data || [];
    // התזכורת אישית: קופצת רק אצל הסוכן שהליד משויך אליו — לא אצל שאר הסוכנים וגם לא אצל המנהל
    const mine = myAgentId();
    rows = rows.filter(l => l.agent_id === mine);

    // באדג' על פריט "לידים" בתפריט
    const badge = document.getElementById('badge-leads');
    if (badge) {
      if (rows.length) { badge.textContent = rows.length; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
    if (rows.length) showFollowupPopup(rows);
  } catch (e) { console.error('follow-up reminder', e); }
}

function showFollowupPopup(rows) {
  emuEnsureStyles();
  const ov = document.createElement('div');
  ov.className = 'emu-overlay';
  const list = rows.slice(0, 12).map(l =>
    `<li style="display:flex;justify-content:space-between;gap:10px;padding:8px 4px;border-bottom:1px solid #eee;cursor:pointer"
         data-id="${l.id}">
       <span><b>${esc(l.name)}</b>${l.phone ? ` · <span dir="ltr">${esc(l.phone)}</span>` : ''}</span>
       <span style="color:@@COLOR_GRAD@@;white-space:nowrap">${heDate(l.follow_up)}</span>
     </li>`).join('');
  ov.innerHTML = `<div class="emu-oops" style="max-width:440px;text-align:right">
      <div style="text-align:center" class="ic">⏰</div>
      <p style="text-align:center;margin:8px 0 6px"><b>תזכורת פולו-אפ</b><br>
        <span style="font-size:.9rem;color:#555">${rows.length} לידים למעקב היום או באיחור</span></p>
      <ul style="list-style:none;margin:6px 0 16px;padding:0;max-height:46vh;overflow:auto">${list}</ul>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn" id="emuGoLeads">פתח לידים</button>
        <button class="btn btn-ghost" id="emuLater">אחר כך</button>
      </div>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#emuLater').addEventListener('click', close);
  ov.querySelector('#emuGoLeads').addEventListener('click', () => { close(); openPage('leads'); });
  ov.querySelectorAll('li[data-id]').forEach(li =>
    li.addEventListener('click', () => { const id = Number(li.dataset.id); close(); openPage('leads').then(() => openLeadCard(id)); }));
  document.body.appendChild(ov);
}

/* ---------- תזכורת פולו-אפ מתוזמנת — קופצת בשעה שנקבעה, כל עוד הסוכן מחובר ---------- */
let _fuTimer = null;
let _fuSnooze = {}; // id -> חותמת זמן שאחריה מותר להתריע שוב (דחיינות)
function _fuKey() { return 'fu_notified_' + today(); }
function _fuSet() { try { return new Set(JSON.parse(localStorage.getItem(_fuKey()) || '[]')); } catch (e) { return new Set(); } }
function fuMark(id) { const s = _fuSet(); s.add(id); localStorage.setItem(_fuKey(), JSON.stringify([...s])); }
function fuUnmark(id) { const s = _fuSet(); s.delete(id); localStorage.setItem(_fuKey(), JSON.stringify([...s])); }
function fuClear(id) { fuUnmark(id); delete _fuSnooze[id]; } // בעריכת מעקב — מאפשר התרעה מחדש על השעה החדשה

function startFollowupScheduler() {
  if (_fuTimer) return;                       // כבר פועל
  checkTimedFollowups();                       // בדיקה מיידית בכניסה
  _fuTimer = setInterval(checkTimedFollowups, 45000); // בדיקה כל 45 שניות
}

async function checkTimedFollowups() {
  if (!['admin', 'sales'].includes(profile.role)) return;
  const mine = myAgentId();
  if (mine == null) return;                    // בלי סוכן משויך — אין למי להתריע
  try {
    const { data } = await db.from('leads')
      .select('id,name,phone,follow_up,follow_up_time,agent_id,status')
      .eq('agent_id', mine)
      .not('status', 'in', '("won","lost")')
      .not('follow_up', 'is', null)
      .not('follow_up_time', 'is', null)
      .lte('follow_up', today());
    const now = new Date();
    const notified = _fuSet();
    for (const l of (data || [])) {
      if (notified.has(l.id)) continue;
      if (_fuSnooze[l.id] && now.getTime() < _fuSnooze[l.id]) continue;
      const t = (l.follow_up_time.length <= 5 ? l.follow_up_time + ':00' : l.follow_up_time);
      const due = new Date(l.follow_up + 'T' + t);
      if (due <= now) { fuMark(l.id); popFollowupNow(l); }
    }
  } catch (e) { console.error('timed follow-up', e); }
}

function popFollowupNow(l) {
  emuEnsureStyles();
  const ov = document.createElement('div');
  ov.className = 'emu-overlay';
  const _t = new Date(Date.now() + 86400000);
  const tomStr = _t.getFullYear() + '-' + String(_t.getMonth() + 1).padStart(2, '0') + '-' + String(_t.getDate()).padStart(2, '0');
  ov.innerHTML = `<div class="emu-oops" style="max-width:440px">
      <div class="ic">⏰</div>
      <p style="margin:10px 0 6px"><b>הגיע הזמן לחזור ל${esc(l.name)}</b><br>
        ${l.phone ? `<span dir="ltr">${esc(l.phone)}</span> · ` : ''}מעקב ל-${heDate(l.follow_up)} ${esc((l.follow_up_time || '').slice(0, 5))}</p>
      <div id="fuMain" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-sm" id="fuDone">✓ בוצע</button>
        <button class="btn btn-sm btn-ghost" id="fuRemind">⏰ הזכר לי בעוד</button>
        ${l.phone ? `<a class="btn btn-sm btn-ghost" href="tel:${esc(l.phone)}">📞 חייג</a>` : ''}
      </div>
      <div id="fuSnoozeOpts" class="hidden">
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn-sm btn-ghost" data-h="1">שעה</button>
          <button class="btn btn-sm btn-ghost" data-h="2">שעתיים</button>
          <button class="btn btn-sm btn-ghost" data-h="3">3 שעות</button>
          <button class="btn btn-sm btn-ghost" data-h="4">4 שעות</button>
          <button class="btn btn-sm btn-ghost" id="fuOtherDay">📅 יום אחר</button>
        </div>
        <div id="fuDayPick" class="hidden" style="display:flex;gap:6px;justify-content:center;align-items:center;margin-top:10px">
          <input type="date" id="fuDayInput" value="${tomStr}" style="padding:6px 8px;border:1px solid var(--line,#e5e7eb);border-radius:8px">
          <button class="btn btn-sm" id="fuDayGo">אישור</button>
        </div>
        <div style="text-align:center;margin-top:8px"><a id="fuBack" style="cursor:pointer;color:#8890a6">↩ חזרה</a></div>
      </div>
    </div>`;
  const close = () => ov.remove();
  // אין סגירה בלחיצה בחוץ ואין כפתור סגירה — חייבים 'בוצע' או 'הזכר לי בעוד'
  ov.querySelector('#fuDone').addEventListener('click', async () => { await fuMarkDone(l.id); close(); });
  ov.querySelector('#fuRemind').addEventListener('click', () => {
    ov.querySelector('#fuMain').classList.add('hidden');
    ov.querySelector('#fuSnoozeOpts').classList.remove('hidden');
  });
  ov.querySelector('#fuBack').addEventListener('click', () => {
    ov.querySelector('#fuSnoozeOpts').classList.add('hidden');
    ov.querySelector('#fuDayPick').classList.add('hidden');
    ov.querySelector('#fuMain').classList.remove('hidden');
  });
  ov.querySelectorAll('#fuSnoozeOpts button[data-h]').forEach(b =>
    b.addEventListener('click', async () => { await fuSnoozeHours(l.id, Number(b.dataset.h)); close(); }));
  ov.querySelector('#fuOtherDay').addEventListener('click', () => ov.querySelector('#fuDayPick').classList.remove('hidden'));
  ov.querySelector('#fuDayGo').addEventListener('click', async () => {
    const v = ov.querySelector('#fuDayInput').value;
    if (!v) { toast('בחר תאריך', true); return; }
    await fuSnoozeDate(l.id, v); close();
  });
  document.body.appendChild(ov);
}

/* בוצע — מסיר את תזכורת המעקב הנוכחית */
async function fuMarkDone(id) {
  try {
    await run(db.from('leads').update({ follow_up: null, follow_up_time: null }).eq('id', id));
    const l = (typeof _leads !== 'undefined') ? _leads.find(x => x.id === id) : null;
    if (l) { l.follow_up = null; l.follow_up_time = null; }
    fuClear(id);
    try { await addInteraction('lead', id, 'תזכורת פולו-אפ — סומן כבוצע'); } catch (e) {}
    toast('סומן כבוצע ✓');
    if (typeof maybeFollowupReminder === 'function') maybeFollowupReminder();
  } catch (e) { toast('שגיאה', true); }
}
function _fuPad(n) { return String(n).padStart(2, '0'); }
async function fuSnoozeHours(id, hours) {
  const t = new Date(Date.now() + hours * 3600000);
  const date = `${t.getFullYear()}-${_fuPad(t.getMonth() + 1)}-${_fuPad(t.getDate())}`;
  const time = `${_fuPad(t.getHours())}:${_fuPad(t.getMinutes())}`;
  const label = hours === 1 ? 'שעה' : hours === 2 ? 'שעתיים' : hours + ' שעות';
  await _fuApplySnooze(id, date, time, 'אזכיר בעוד ' + label);
}
async function fuSnoozeDate(id, date) {
  const l = (typeof _leads !== 'undefined') ? _leads.find(x => x.id === id) : null;
  const time = (l && l.follow_up_time) ? l.follow_up_time.slice(0, 5) : '09:00';
  await _fuApplySnooze(id, date, time, 'המעקב נדחה ל-' + heDate(date));
}
async function _fuApplySnooze(id, date, time, msg) {
  try {
    await run(db.from('leads').update({ follow_up: date, follow_up_time: time }).eq('id', id));
    const l = (typeof _leads !== 'undefined') ? _leads.find(x => x.id === id) : null;
    if (l) { l.follow_up = date; l.follow_up_time = time; }
    fuClear(id);
    toast(msg);
    if (typeof maybeFollowupReminder === 'function') maybeFollowupReminder();
  } catch (e) { toast('שגיאה', true); }
}

/* ---------- זיהוי שיחה נכנסת (Voicenter Screen-Pop) ---------- */
async function handleIncomingCall() {
  const raw = new URLSearchParams(location.search).get('call');
  if (!raw) return;
  history.replaceState(null, '', location.pathname);
  const digits = normPhone(raw).slice(-9);
  if (!digits) return;
  try {
    const [ld, cu] = await Promise.all([
      db.from('leads').select('id,name,phone').ilike('phone', '%' + digits + '%').limit(5),
      db.from('customers').select('id,name,phone').ilike('phone', '%' + digits + '%').limit(5),
    ]);
    const leads = ld.data || [], custs = cu.data || [];
    if (custs.length && !leads.length) { openPage('customers').then(() => window.openCustomerCard && openCustomerCard(custs[0].id)); return; }
    if (leads.length && !custs.length) { openPage('leads').then(() => openLeadCard(leads[0].id)); return; }
    if (leads.length && custs.length) { showCallChooser(raw, leads[0], custs[0]); return; }
    openPage('leads').then(() => { leadQuickAdd(); setTimeout(() => { const el = document.getElementById('f_phone'); if (el) el.value = raw; }, 60); });
  } catch (e) { console.error('incoming call', e); }
}

function showCallChooser(phone, lead, cust) {
  emuEnsureStyles();
  const ov = document.createElement('div');
  ov.className = 'emu-overlay';
  ov.innerHTML = `<div class="emu-oops" style="max-width:400px">
      <div class="ic">📞</div>
      <p style="margin:10px 0 6px"><b>שיחה מ-${esc(phone)}</b><br>המספר קיים גם כליד וגם כלקוח — מה לפתוח?</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-sm" id="ccCust">לקוח: ${esc(cust.name)}</button>
        <button class="btn btn-sm btn-ghost" id="ccLead">ליד: ${esc(lead.name)}</button>
        <button class="btn btn-sm btn-ghost" id="ccClose">סגור</button>
      </div>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#ccClose').addEventListener('click', close);
  ov.querySelector('#ccCust').addEventListener('click', () => { close(); openPage('customers').then(() => window.openCustomerCard && openCustomerCard(cust.id)); });
  ov.querySelector('#ccLead').addEventListener('click', () => { close(); openPage('leads').then(() => openLeadCard(lead.id)); });
  document.body.appendChild(ov);
}

/* עטיפת afterLogin (מוגדר ב-app.js) כדי להפעיל את התזכורת אחרי הכניסה —
   בלי לגעת ב-app.js או ב-index.html */
(function () {
  const orig = window.afterLogin;
  if (typeof orig === 'function' && !orig._emuWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { await maybeFollowupReminder(); startFollowupScheduler(); handleIncomingCall(); } catch (e) { console.error(e); }
      return r;
    };
    wrapped._emuWrapped = true;
    window.afterLogin = wrapped;
  }
})();
