/* ============================================================
lead-import.js — ייבוא לידים (מנהל בלבד)
------------------------------------------------------------
אשף ייבוא רב-שלבי עם שני שערי אישור מפורשים:
1. העלאת קובץ CSV/Excel (פענוח בצד הלקוח — XLSX שכבר טעון)
2. מיפוי עמודות הקובץ לשדות הליד (נחשים אוטומטית לפי שמות נפוצים)
3. זיהוי כפילויות: טלפון מנורמל (9 ספרות אחרונות) מול לידים ולקוחות,
   שם זהה מול לידים, וכפילויות בתוך הקובץ עצמו
--- שער 1: סקירת הרשימה — טבלה מלאה + ייצוא CSV. שום דבר לא נכתב ---
4. שיוך לסוכנים: סבב (round-robin) / סוכן אחד / ללא שיוך (מאגר)
--- שער 2: תצוגה מקדימה של השיוך + אישור סופי → הכנסה ל-DB ---
הכנסה במנות של 50, source ברירת מחדל "ייבוא", ותיעוד הקובץ ב-source_detail.
הרצה חוזרת של אותו קובץ במצב "דלג על כפולים" לא יוצרת כפילויות —
הטלפונים הקיימים נבדקים שוב מול המסד ממש לפני ההכנסה.
============================================================ */

'use strict';

/* מצב האשף — מתאפס בכל כניסה לדף */
let _li = null;

/* שדות הליד שאפשר למפות מהקובץ + ניחוש אוטומטי לפי שמות עמודה נפוצים */
const LI_FIELDS = [
  { name: 'name', label: 'שם העסק / הליד', required: true, guess: ['שם העסק', 'שם הליד', 'שם עסק', 'עסק', 'לקוח', 'שם', 'name', 'business'] },
  { name: 'contact_person', label: 'איש קשר', guess: ['איש קשר', 'איש הקשר', 'contact'] },
  { name: 'phone', label: 'טלפון', guess: ['טלפון', 'נייד', 'פלאפון', 'סלולרי', 'phone', 'mobile'] },
  { name: 'whatsapp', label: 'וואטסאפ / טלפון נוסף', guess: ['וואטסאפ', 'ווצאפ', 'טלפון נוסף', 'whatsapp'] },
  { name: 'email', label: 'אימייל', guess: ['אימייל', 'מייל', 'דוא"ל', 'email', 'mail'] },
  { name: 'city', label: 'יישוב', guess: ['יישוב', 'ישוב', 'עיר', 'כתובת', 'city'] },
  { name: 'field', label: 'תחום העסק', guess: ['תחום', 'ענף', 'קטגוריה', 'עיסוק'] },
  { name: 'source', label: 'מקור', guess: ['מקור', 'source'] },
  { name: 'interest', label: 'מה מעניין אותו', guess: ['מתעניין', 'התעניינות', 'מה מעניין', 'מוצר'] },
  { name: 'notes', label: 'הערות', guess: ['הערות', 'הערה', 'תיאור', 'notes'] },
];

Pages['lead-import'] = {
  title: 'ייבוא לידים',
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">מסך זה זמין למנהל בלבד</div>'; return; }
    _li = { step: 1, fileName: '', rows: [], headers: [], map: {}, items: [], dupMode: 'skip', assignMode: 'rr', rrAgents: [], oneAgent: null, assigned: false };
    liDraw(el);
  }
};

/* ---------- עזרי נרמול ---------- */
/* טלפון ישראלי: +972/972 → 0, ואם אקסל בלע את האפס המוביל — מחזירים אותו */
function liCleanPhone(v) {
  let s = normPhone(v); // מ-api.js: מסיר תווים, ממיר 972 ל-0
  if (/^[1-9]\d{7,8}$/.test(s)) s = '0' + s;
  return s;
}
/* מפתח השוואה: 9 הספרות האחרונות — 050-1234567 ו-0501234567 זהים */
function liPhKey(p) { return String(p || '').replace(/\D/g, '').slice(-9); }
function liPhoneReal(k) { return k.length >= 7; }
/* מפתח שם להשוואה משנית: רווחים מכווצים, גרשיים מוסרים */
function liNameKey(n) { return String(n || '').replace(/['"׳״]/g, '').replace(/\s+/g, ' ').trim(); }

/* ---------- ציור האשף ---------- */
function liDraw(el) {
  el = el || document.getElementById('content');
  const steps = ['העלאת קובץ', 'מיפוי עמודות', 'סקירת הרשימה', 'שיוך לסוכנים', 'סיכום'];
  const bar = steps.map((s, i) =>
    `<span class="pill ${i + 1 === _li.step ? 'blue' : (i + 1 < _li.step ? 'green' : '')}">${i + 1}. ${s}</span>`).join(' ← ');
  el.innerHTML = `
    <div class="page-head"><h2>ייבוא לידים</h2></div>
    <div style="margin-bottom:14px;font-size:.85rem">${bar}</div>
    <div id="liBody"></div>`;
  const body = document.getElementById('liBody');
  if (_li.step === 1) liDrawUpload(body);
  else if (_li.step === 2) liDrawMapping(body);
  else if (_li.step === 3) liDrawReview(body);
  else if (_li.step === 4) liDrawAssign(body);
  else liDrawDone(body);
}

/* ---------- שלב 1: העלאה ---------- */
function liDrawUpload(body) {
  body.innerHTML = `
    <div class="card card-pad" style="max-width:560px">
      <b>העלאת קובץ לידים (CSV / Excel)</b>
      <p class="muted" style="font-size:.85rem;margin:8px 0 14px">
        הקובץ נקרא בדפדפן בלבד — <b>שום דבר לא נכתב למערכת</b> עד לאישור הסופי בשלב האחרון.
        שורת הכותרות הראשונה בקובץ משמשת לזיהוי העמודות.</p>
      <input type="file" id="liFile" accept=".xlsx,.xls,.csv" onchange="liFileChosen()">
    </div>`;
}

async function liFileChosen() {
  const input = document.getElementById('liFile');
  const file = input.files[0];
  if (!file) return;
  let rows;
  try { rows = await readSpreadsheet(file); }
  catch (e) { toast('לא הצלחתי לקרוא את הקובץ: ' + e.message, true); input.value = ''; return; }
  if (!rows.length) { toast('הקובץ ריק או שאין שורת כותרות', true); input.value = ''; return; }
  // איחוד כותרות מכל השורות — עמודה שריקה בשורה הראשונה לא תיעלם
  const headers = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!headers.includes(k)) headers.push(k); }));
  _li.fileName = file.name;
  _li.rows = rows;
  _li.headers = headers;
  // ניחוש מיפוי ראשוני לפי שמות עמודה נפוצים (התאמה מלאה קודמת לחלקית)
  _li.map = {};
  for (const f of LI_FIELDS) {
    let hit = headers.find(h => f.guess.some(g => h.trim() === g));
    if (!hit) hit = headers.find(h => f.guess.some(g => h.trim().includes(g)));
    if (hit && !Object.values(_li.map).includes(hit)) _li.map[f.name] = hit;
  }
  _li.step = 2;
  liDraw();
}

/* ---------- שלב 2: מיפוי עמודות ---------- */
function liDrawMapping(body) {
  const selects = LI_FIELDS.map(f => `
    <div class="field half"><label>${f.label}${f.required ? ' *' : ''}</label>
      <select id="liMap_${f.name}">
        <option value="">— לא בקובץ —</option>
        ${_li.headers.map(h => `<option value="${esc(h)}" ${_li.map[f.name] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
      </select></div>`).join('');
  // תצוגה מקדימה של 5 השורות הראשונות כפי שהן בקובץ — עוזרת למפות נכון
  const prevHead = _li.headers.map(h => `<th>${esc(h)}</th>`).join('');
  const prevRows = _li.rows.slice(0, 5).map(r =>
    `<tr>${_li.headers.map(h => `<td dir="auto">${esc(r[h])}</td>`).join('')}</tr>`).join('');
  body.innerHTML = `
    <div class="card card-pad">
      <b>מיפוי עמודות — ${esc(_li.fileName)}</b>
      <span class="muted" style="font-size:.85rem"> · ${_li.rows.length} שורות</span>
      <p class="muted" style="font-size:.85rem;margin:6px 0 12px">בחר לכל שדה במערכת את העמודה המתאימה בקובץ. שדות שלא ימופו יישארו ריקים.</p>
      <div class="grid2">${selects}</div>
      <div style="margin-top:14px">
        <button class="btn" onclick="liApplyMapping()">המשך — בדיקת כפילויות וסקירה</button>
        <button class="btn btn-ghost" onclick="_li.step=1;liDraw()">↩ קובץ אחר</button>
      </div>
    </div>
    <div class="card card-pad" style="margin-top:14px">
      <b>5 השורות הראשונות בקובץ</b>
      <div class="table-wrap" style="margin-top:8px"><table class="data">
        <thead><tr>${prevHead}</tr></thead><tbody>${prevRows}</tbody></table></div>
    </div>`;
}

async function liApplyMapping() {
  for (const f of LI_FIELDS) _li.map[f.name] = document.getElementById('liMap_' + f.name).value || '';
  if (!_li.map.name) { toast('חובה למפות עמודה לשדה "שם העסק / הליד"', true); return; }
  toast('בודק כפילויות מול המערכת...');
  // כל הלידים והלקוחות הקיימים — להשוואת טלפון ושם (עימוד, כמו בשאר המערכת)
  const [exLeads, exCustomers] = await Promise.all([
    runAll((f, t) => db.from('leads').select('id,name,phone').order('id').range(f, t)),
    runAll((f, t) => db.from('customers').select('id,name,phone').order('id').range(f, t)),
  ]);
  const phoneMap = {}; // מפתח טלפון → תיאור הרשומה הקיימת
  exCustomers.forEach(c => { const k = liPhKey(c.phone); if (liPhoneReal(k) && !phoneMap[k]) phoneMap[k] = 'לקוח "' + c.name + '"'; });
  exLeads.forEach(l => { const k = liPhKey(l.phone); if (liPhoneReal(k) && !phoneMap[k]) phoneMap[k] = 'ליד "' + l.name + '"'; });
  const nameMap = {}; // מפתח שם → ליד קיים (השוואה משנית, רק מול לידים)
  exLeads.forEach(l => { const k = liNameKey(l.name); if (k && !nameMap[k]) nameMap[k] = 'ליד "' + l.name + '"'; });

  const seenPhones = {}, seenNames = {}; // כפילויות בתוך הקובץ עצמו
  _li.items = _li.rows.map((row, idx) => {
    const get = f => _li.map[f] ? String(row[_li.map[f]] ?? '').trim() : '';
    const data = {
      name: get('name'), contact_person: get('contact_person'),
      phone: liCleanPhone(get('phone')), whatsapp: liCleanPhone(get('whatsapp')),
      email: get('email'), city: get('city'), field: get('field'),
      source: get('source'), interest: get('interest'), notes: get('notes'),
    };
    const item = { idx: idx + 2, data, status: 'new', dupWith: '' }; // idx+2 = מספר השורה בקובץ (אחרי הכותרות)
    const pk = liPhKey(data.phone), nk = liNameKey(data.name);
    if (!data.name) item.status = 'noname';
    else if (liPhoneReal(pk) && phoneMap[pk]) { item.status = 'dup'; item.dupWith = 'טלפון קיים אצל ' + phoneMap[pk]; }
    else if (nk && nameMap[nk]) { item.status = 'dup'; item.dupWith = 'שם זהה ל' + nameMap[nk]; }
    else if (liPhoneReal(pk) && seenPhones[pk]) { item.status = 'dupfile'; item.dupWith = 'טלפון זהה לשורה ' + seenPhones[pk] + ' בקובץ'; }
    else if (nk && seenNames[nk]) { item.status = 'dupfile'; item.dupWith = 'שם זהה לשורה ' + seenNames[nk] + ' בקובץ'; }
    if (item.status === 'new') { if (liPhoneReal(pk)) seenPhones[pk] = item.idx; if (nk) seenNames[nk] = item.idx; }
    return item;
  });
  _li.step = 3;
  liDraw();
}

/* ---------- שלב 3: שער 1 — סקירת הרשימה (שום דבר לא נכתב) ---------- */
function liCounts() {
  const c = { total: _li.items.length, fresh: 0, dup: 0, dupfile: 0, noname: 0 };
  _li.items.forEach(i => { if (i.status === 'new') c.fresh++; else if (i.status === 'dup') c.dup++; else if (i.status === 'dupfile') c.dupfile++; else c.noname++; });
  return c;
}
/* השורות שייכנסו בפועל, לפי בחירת מצב הכפולים */
function liToImport() {
  return _li.items.filter(i => i.status === 'new' || (_li.dupMode === 'import' && (i.status === 'dup' || i.status === 'dupfile')));
}
function liStatusPill(i) {
  if (i.status === 'new') return '<span class="pill green">חדש</span>';
  if (i.status === 'noname') return '<span class="pill red">בלי שם — לא ייובא</span>';
  return `<span class="pill amber">${i.status === 'dup' ? 'כפול' : 'כפול בקובץ'}</span> <span class="muted" style="font-size:.78rem">${esc(i.dupWith)}</span>`;
}

function liDrawReview(body) {
  const c = liCounts();
  const flagged = c.dup + c.dupfile;
  const SHOW = 300; // תצוגה חסכונית — הרשימה המלאה זמינה בייצוא CSV
  const rowsHtml = _li.items.slice(0, SHOW).map(i => `
    <tr>
      <td class="muted">${i.idx}</td>
      <td><b>${esc(i.data.name) || '—'}</b>${i.data.contact_person ? `<br><span class="muted" style="font-size:.78rem">${esc(i.data.contact_person)}</span>` : ''}</td>
      <td dir="ltr">${esc(i.data.phone)}</td>
      <td dir="ltr">${esc(i.data.email)}</td>
      <td>${esc(i.data.city)}</td>
      <td>${esc(i.data.field)}</td>
      <td>${esc(i.data.source)}</td>
      <td dir="auto">${esc(i.data.notes)}</td>
      <td>${liStatusPill(i)}</td>
    </tr>`).join('');
  body.innerHTML = `
    <div class="card card-pad" style="border-inline-start:4px solid var(--accent)">
      <b>🛑 שער אישור 1 — סקירת הרשימה שחולצה מהקובץ</b>
      <p class="muted" style="font-size:.85rem;margin:6px 0 0">
        <b>שום ליד עדיין לא נכתב למערכת ואף סוכן לא שויך.</b>
        עבור על הרשימה (או הורד אותה כ-CSV), ורק אחרי שאתה מרוצה — המשך לשלב השיוך.</p>
    </div>
    <div class="stats" style="margin-top:14px">
      <div class="stat"><div class="num">${c.total}</div><div class="lbl">שורות בקובץ</div></div>
      <div class="stat"><div class="num">${c.fresh}</div><div class="lbl">חדשים</div></div>
      <div class="stat ${flagged ? 'gold' : ''}"><div class="num">${flagged}</div><div class="lbl">מסומנים ככפולים</div></div>
      <div class="stat ${c.noname ? 'red' : ''}"><div class="num">${c.noname}</div><div class="lbl">בלי שם (מדולגים)</div></div>
    </div>
    ${flagged ? `
    <div class="card card-pad" style="margin-top:14px">
      <b>מה לעשות עם ${flagged} השורות המסומנות ככפולות?</b>
      <div style="margin-top:8px;display:flex;gap:18px;flex-wrap:wrap">
        <label style="cursor:pointer"><input type="radio" name="liDupMode" value="skip" ${_li.dupMode === 'skip' ? 'checked' : ''} onchange="liSetDupMode(this.value)"> דלג עליהן (מומלץ — מונע כפילויות)</label>
        <label style="cursor:pointer"><input type="radio" name="liDupMode" value="import" ${_li.dupMode === 'import' ? 'checked' : ''} onchange="liSetDupMode(this.value)"> ייבא אותן בכל זאת</label>
      </div>
      <p class="muted" style="font-size:.8rem;margin:8px 0 0" id="liDupSummary">${liDupSummaryText()}</p>
    </div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="table-wrap"><table class="data">
        <thead><tr><th>שורה</th><th>שם</th><th>טלפון</th><th>אימייל</th><th>יישוב</th><th>תחום</th><th>מקור</th><th>הערות</th><th>סטטוס</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>
      ${_li.items.length > SHOW ? `<p class="muted" style="font-size:.8rem;padding:8px 12px">מוצגות ${SHOW} שורות ראשונות מתוך ${_li.items.length} — הרשימה המלאה בייצוא ה-CSV</p>` : ''}
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-ghost" onclick="liExportCsv()">⬇ הורדת הרשימה (CSV)</button>
      <button class="btn btn-ghost" onclick="_li.step=2;liDraw()">↩ חזרה למיפוי</button>
      <button class="btn btn-gold" onclick="liApproveList()">✔ אני מאשר את הרשימה — המשך לשיוך לסוכנים</button>
    </div>`;
}

function liSetDupMode(v) {
  _li.dupMode = v;
  const el = document.getElementById('liDupSummary');
  if (el) el.textContent = liDupSummaryText();
}
function liDupSummaryText() {
  return `ייובאו ${liToImport().length} לידים לפי הבחירה הנוכחית`;
}

function liExportCsv() {
  exportCsv('רשימת_ייבוא_' + (_li.fileName || '').replace(/\.[^.]*$/, ''),
    ['שורה בקובץ', 'שם', 'איש קשר', 'טלפון', 'וואטסאפ', 'אימייל', 'יישוב', 'תחום', 'מקור', 'מתעניין', 'הערות', 'סטטוס', 'פירוט כפילות'],
    _li.items.map(i => [i.idx, i.data.name, i.data.contact_person, i.data.phone, i.data.whatsapp, i.data.email,
      i.data.city, i.data.field, i.data.source, i.data.interest, i.data.notes,
      i.status === 'new' ? 'חדש' : i.status === 'noname' ? 'בלי שם' : 'כפול', i.dupWith]));
}

function liApproveList() {
  const n = liToImport().length;
  if (!n) { toast('אין שורות לייבוא לפי הבחירה הנוכחית', true); return; }
  if (!confirm(`לאשר את הרשימה?\n${n} לידים ימשיכו לשלב השיוך לסוכנים.\n(עדיין שום דבר לא נכתב למערכת)`)) return;
  _li.assigned = false;
  _li.step = 4;
  liDraw();
}

/* ---------- שלב 4: שער 2 — שיוך לסוכנים + אישור סופי ---------- */
function liDrawAssign(body) {
  const items = liToImport();
  const active = cache.agents.filter(a => a.active);
  const agentChecks = active.map(a => `
    <label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px">
      <input type="checkbox" class="liRrAgent" value="${a.id}" ${_li.rrAgents.includes(a.id) || !_li.rrAgents.length ? 'checked' : ''} onchange="liAssignChanged()"> ${esc(a.name)}</label>`).join('');
  const agentOpts = active.map(a => `<option value="${a.id}" ${_li.oneAgent === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  body.innerHTML = `
    <div class="card card-pad" style="border-inline-start:4px solid var(--brand)">
      <b>🛑 שער אישור 2 — שיוך ${items.length} הלידים המאושרים לסוכנים</b>
      <p class="muted" style="font-size:.85rem;margin:6px 0 0">בחר איך לחלק, בדוק את התצוגה המקדימה, ורק האישור הסופי כותב למערכת.</p>
    </div>
    <div class="card card-pad" style="margin-top:14px">
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="cursor:pointer"><input type="radio" name="liAssign" value="rr" ${_li.assignMode === 'rr' ? 'checked' : ''} onchange="liAssignChanged()">
          <b>חלוקה בסבב (round-robin)</b> בין הסוכנים הפעילים המסומנים:
          <span style="display:inline-flex;gap:14px;flex-wrap:wrap;margin-inline-start:8px">${agentChecks || '<span class="muted">אין סוכנים פעילים</span>'}</span></label>
        <label style="cursor:pointer"><input type="radio" name="liAssign" value="one" ${_li.assignMode === 'one' ? 'checked' : ''} onchange="liAssignChanged()">
          <b>הכל לסוכן אחד:</b>
          <select id="liOneAgent" style="margin-inline-start:8px" onchange="liAssignChanged()">${agentOpts}</select></label>
        <label style="cursor:pointer"><input type="radio" name="liAssign" value="none" ${_li.assignMode === 'none' ? 'checked' : ''} onchange="liAssignChanged()">
          <b>ללא שיוך</b> — הלידים ייכנסו למאגר המשותף והסוכנים יוכלו לתפוס אותם</label>
      </div>
    </div>
    <div id="liAssignPreview" style="margin-top:14px"></div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-ghost" onclick="_li.step=3;liDraw()">↩ חזרה לסקירת הרשימה</button>
      <button class="btn" style="background:#16a34a;color:#fff" onclick="liFinalImport()">✅ אישור סופי — ייבוא ${items.length} לידים למערכת</button>
    </div>`;
  liAssignChanged();
}

/* קריאת בחירת השיוך מהמסך + חישוב agent_id לכל שורה + תצוגה מקדימה */
function liAssignChanged() {
  _li.assignMode = document.querySelector('input[name="liAssign"]:checked')?.value || 'rr';
  _li.rrAgents = [...document.querySelectorAll('.liRrAgent:checked')].map(c => Number(c.value));
  _li.oneAgent = Number(document.getElementById('liOneAgent')?.value) || null;
  const items = liToImport();
  if (_li.assignMode === 'rr') {
    items.forEach((it, i) => it.agent_id = _li.rrAgents.length ? _li.rrAgents[i % _li.rrAgents.length] : null);
  } else if (_li.assignMode === 'one') {
    items.forEach(it => it.agent_id = _li.oneAgent);
  } else {
    items.forEach(it => it.agent_id = null);
  }
  // תצוגה מקדימה: כמה לכל סוכן + מי מקבל את מי (עד 300 שורות)
  const perAgent = {};
  items.forEach(it => { const k = it.agent_id == null ? 'ללא שיוך (מאגר)' : nameOf('agents', it.agent_id); perAgent[k] = (perAgent[k] || 0) + 1; });
  const box = document.getElementById('liAssignPreview');
  if (!box) return;
  box.innerHTML = `
    <div class="card card-pad">
      <b>תצוגה מקדימה של החלוקה</b>
      <div class="stats" style="margin-top:10px">
        ${Object.entries(perAgent).map(([k, n]) => `<div class="stat"><div class="num">${n}</div><div class="lbl">${esc(k)}</div></div>`).join('') || '<span class="muted">אין לידים</span>'}
      </div>
      <div class="table-wrap" style="margin-top:10px"><table class="data">
        <thead><tr><th>שם</th><th>טלפון</th><th>סוכן</th></tr></thead>
        <tbody>${items.slice(0, 300).map(it => `<tr><td>${esc(it.data.name)}</td><td dir="ltr">${esc(it.data.phone)}</td>
          <td>${it.agent_id == null ? '<span class="pill amber">ללא שיוך</span>' : esc(nameOf('agents', it.agent_id))}</td></tr>`).join('')}</tbody></table></div>
      ${items.length > 300 ? `<p class="muted" style="font-size:.8rem;margin-top:6px">מוצגות 300 שורות ראשונות מתוך ${items.length}</p>` : ''}
    </div>`;
}

/* ---------- האישור הסופי — כאן ורק כאן נכתב למסד ---------- */
let _liBusy = false; // לחיצה כפולה = ייבוא כפול
async function liFinalImport() {
  if (_liBusy) return;
  liAssignChanged(); // מקבע את הבחירה הנוכחית שעל המסך
  if (_li.assignMode === 'rr' && !_li.rrAgents.length) { toast('בחר לפחות סוכן אחד לסבב, או עבור ל"ללא שיוך"', true); return; }
  if (_li.assignMode === 'one' && !_li.oneAgent) { toast('בחר סוכן', true); return; }
  let items = liToImport();
  if (!items.length) { toast('אין לידים לייבוא', true); return; }
  if (!confirm(`אישור סופי: לייבא ${items.length} לידים למערכת עם השיוך שבתצוגה המקדימה?\nזו הפעולה שכותבת בפועל למסד הנתונים.`)) return;
  _liBusy = true;
  try {
    // בדיקת-אמת אחרונה מול המסד (מגן מפני הרצה כפולה של אותו קובץ):
    // במצב "דלג על כפולים" — טלפון שנכנס בינתיים למערכת יידלג גם עכשיו
    let lastMinuteSkipped = 0;
    if (_li.dupMode === 'skip') {
      const [exL, exC] = await Promise.all([
        runAll((f, t) => db.from('leads').select('phone').order('id').range(f, t)),
        runAll((f, t) => db.from('customers').select('phone').order('id').range(f, t)),
      ]);
      const known = new Set([...exL, ...exC].map(x => liPhKey(x.phone)).filter(liPhoneReal));
      const before = items.length;
      items = items.filter(it => { const k = liPhKey(it.data.phone); return !(liPhoneReal(k) && known.has(k)); });
      lastMinuteSkipped = before - items.length;
      if (!items.length) {
        toast('כל הלידים בקובץ כבר קיימים במערכת — לא נוסף כלום');
        _li.step = 5; _li.result = { inserted: 0, skippedDup: liCounts().dup + liCounts().dupfile + lastMinuteSkipped, skippedNoname: liCounts().noname };
        liDraw();
        return;
      }
    }
    const srcDetail = 'ייבוא מקובץ: ' + _li.fileName + ' · ' + heDate(today());
    const recs = items.map(it => ({
      name: it.data.name,
      contact_person: it.data.contact_person || null,
      phone: it.data.phone || null,
      whatsapp: it.data.whatsapp || null,
      email: it.data.email || null,
      city: it.data.city || null,
      field: it.data.field || null,
      interest: it.data.interest || null,
      notes: it.data.notes || null,
      source: it.data.source || 'ייבוא',
      source_detail: srcDetail,
      agent_id: it.agent_id,
      created_by: profile.id,
    }));
    for (let i = 0; i < recs.length; i += 50)
      await run(db.from('leads').insert(recs.slice(i, i + 50)), 'שגיאה בייבוא (מנה ' + (Math.floor(i / 50) + 1) + ')');
    const c = liCounts();
    const skippedDup = (_li.dupMode === 'skip' ? c.dup + c.dupfile : 0) + lastMinuteSkipped;
    _li.result = { inserted: recs.length, skippedDup, skippedNoname: c.noname };
    _li.step = 5;
    toast(`✓ יובאו ${recs.length} לידים` + (skippedDup ? ` · דולגו ${skippedDup} כפולים` : ''));
    liDraw();
  } catch (e) { /* השגיאה כבר הוצגה ב-run */ }
  finally { _liBusy = false; }
}

/* ---------- שלב 5: סיכום ---------- */
function liDrawDone(body) {
  const r = _li.result || { inserted: 0, skippedDup: 0, skippedNoname: 0 };
  body.innerHTML = `
    <div class="card card-pad" style="max-width:560px">
      <b>✅ הייבוא הושלם</b>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><div class="num">${r.inserted}</div><div class="lbl">לידים נוספו</div></div>
        <div class="stat"><div class="num">${r.skippedDup}</div><div class="lbl">דולגו — כפולים</div></div>
        <div class="stat"><div class="num">${r.skippedNoname}</div><div class="lbl">דולגו — בלי שם</div></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn" onclick="openPage('leads')">מעבר ללידים</button>
        <button class="btn btn-ghost" onclick="openPage('lead-import')">ייבוא קובץ נוסף</button>
      </div>
    </div>`;
}

/* ---------- רישום בתפריט (מנהל בלבד, אחרי "לידים") — בלי לגעת ב-app.js ---------- */
(function () {
  if (typeof NAV !== 'undefined' && !NAV.some(n => n.id === 'lead-import')) {
    const item = { id: 'lead-import', title: 'ייבוא לידים', icon: '📥', roles: ['admin'], group: 'מכירות' };
    const idx = NAV.findIndex(n => n.id === 'leads');
    if (idx >= 0) NAV.splice(idx + 1, 0, item); else NAV.push(item);
  }
})();
