/* ============================================================
attendance.js — שעון נוכחות
------------------------------------------------------------
- עובד: כניסה/יציאה (הכפתור בתפריט הצד), היומן שלו, בקשת תיקון
- מנהל: מי נוכח כעת, דו"ח חודשי לכל עובד, אישור תיקונים
- השעות נרשמות בשרת (clock_in/clock_out) — אין הזנה ידנית
============================================================ */

'use strict';

/* החודש הנבחר נשמר כאן — openPage מוחק את התוכן (והקלט attMonth) לפני הרינדור */
let _attMonth = null;
function attSetMonth(v) { _attMonth = v || null; openPage('attendance'); }

Pages.attendance = {
render: async (el) => {
const isAdmin = profile.role === 'admin';
const month = _attMonth || thisMonth();
// גבולות החודש בשעון מקומי, מומרים ל-UTC לשאילתה — השוואה למחרוזת תאריך
// גולמית פירשה את הגבולות כ-UTC וכניסות לילה זלגו לחודש השכן
const [_ay, _am] = month.split('-').map(Number);
const fromIso = new Date(_ay, _am - 1, 1).toISOString();
const toIso = new Date(_ay, _am, 1).toISOString();

const [rows, requests] = await Promise.all([
run(db.from('attendance').select('*').gte('clock_in', fromIso).lt('clock_in', toIso).order('clock_in', { ascending: false })),
run(db.from('attendance_requests').select('*').eq('status', 'pending').order('created_at')),
]);

/* חישוב שעות לכל רישום — פשוט וגלוי */
const hours = r => r.clock_out ? (new Date(r.clock_out) - new Date(r.clock_in)) / 3600000 : 0;
const fmtH = h => { const m = Math.round(h * 60); return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };

/* סיכום לפי עובד */
const byUser = {};
rows.forEach(r => {
const u = byUser[r.profile_id] = byUser[r.profile_id] || { days: new Set(), total: 0, open: false };
u.days.add(localDay(r.clock_in));
u.total += hours(r);
if (!r.clock_out) u.open = true;
});

el.innerHTML = `
<div class="page-head">
<h2>נוכחות</h2>
<div class="actions">
<input type="month" id="attMonth" value="${month}" onchange="attSetMonth(this.value)" style="width:auto">
${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="attendanceExport(${JSON.stringify(month).replace(/"/g, '&quot;')})">⬇ ייצוא לשכר</button>` : ''}
<button class="btn btn-ghost btn-sm" onclick="attRequestFix()">בקשת תיקון</button>
</div>
</div>

${isAdmin && requests.length ? `<div class="card card-pad" style="border-right:4px solid var(--warn);margin-bottom:16px">
<b style="color:var(--warn)">בקשות תיקון ממתינות:</b>
<ul class="dash-list" style="margin-top:6px">
${requests.map(q => `<li>
<span><b>${esc((cache.profiles.find(p => p.id === q.profile_id) || {}).full_name || '')}</b>
— ${heDate(q.work_date)}: ${heDateTime(q.requested_in)} עד ${q.requested_out ? heDateTime(q.requested_out) : '?'}
<span class="muted">(${esc(q.reason)})</span></span>
<span>
<button class="btn btn-sm" style="background:var(--ok)" onclick="attApprove(${q.id}, true)">אישור</button>
<button class="btn btn-sm btn-danger-ghost" onclick="attApprove(${q.id}, false)">דחייה</button>
</span></li>`).join('')}
</ul></div>` : ''}

${isAdmin ? `<div class="card card-pad" style="margin-bottom:16px">
<b>סיכום חודשי לפי עובד</b>
<div class="table-wrap"><table class="data" style="margin-top:8px">
<thead><tr><th>עובד</th><th>ימי עבודה</th><th>סה"כ שעות</th><th>כעת</th></tr></thead>
<tbody>${Object.entries(byUser).map(([pid, u]) => `<tr>
<td><b>${esc((cache.profiles.find(p => p.id === pid) || {}).full_name || '')}</b></td>
<td>${u.days.size}</td><td>${fmtH(u.total)}</td>
<td>${u.open ? '<span class="pill green">נוכח/ת</span>' : ''}</td>
</tr>`).join('') || '<tr><td colspan="4" class="empty">אין רישומים החודש</td></tr>'}</tbody>
</table></div></div>` : ''}

${isAdmin ? `<div class="card card-pad" style="margin-bottom:16px">
<b>נוכחות אוטומטית</b> <span class="muted">— מחתים לבד כשעובדים בתוכנה, ונסגר אחרי 30 דק' בלי פעילות</span>
<div id="attAutoList" style="display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px"><span class="muted">טוען…</span></div>
</div>` : ''}

<div class="card">
<div class="card-pad"><b>${isAdmin ? 'כל הרישומים' : 'הרישומים שלי'}</b></div>
<div id="attTable"></div>
</div>`;

renderTable(document.getElementById('attTable'), rows, [
...(isAdmin ? [{ h: 'עובד', f: r => esc((cache.profiles.find(p => p.id === r.profile_id) || {}).full_name || '') }] : []),
{ h: 'תאריך', f: r => heDate(localDay(r.clock_in)) },
{ h: 'כניסה', f: r => new Date(r.clock_in).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) },
{ h: 'יציאה', f: r => r.clock_out ? new Date(r.clock_out).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '<span class="pill green">פתוח</span>' },
{ h: 'שעות', f: r => r.clock_out ? fmtH(hours(r)) : '' },
{ h: '', f: r => r.manual ? '<span class="pill amber">תיקון ידני</span>' : (r.auto ? '<span class="pill">אוטומטי</span>' : '') },
...(isAdmin ? [{ h: '', f: r => `<button class="btn btn-ghost btn-sm" onclick="attAdminFix(${r.id})" title="תיקון שעות">✎</button>` }] : []),
], { empty: 'אין רישומי נוכחות החודש' });

if (isAdmin) attRenderAutoList();
}
};

/* רשימת העובדים עם מתג "נוכחות אוטומטית" (מסך המנהל) */
async function attRenderAutoList() {
const box = document.getElementById('attAutoList');
if (!box) return;
const { data, error } = await db.from('profiles').select('id,full_name,role,active,auto_attendance').eq('active', true).order('full_name');
if (error || !data || (data.length && !('auto_attendance' in data[0]))) {
box.innerHTML = '<span class="muted">יש להריץ את מיגרציית הנוכחות האוטומטית (2026-10-11_auto_attendance.sql)</span>';
return;
}
const staff = data.filter(p => !['pending', 'committee'].includes(p.role));
box.innerHTML = staff.map(p => `<label style="display:flex;align-items:center;gap:6px;cursor:pointer">
<input type="checkbox" ${p.auto_attendance ? 'checked' : ''} onchange="attSetAuto('${p.id}', this.checked, this)" style="width:auto">
${esc(p.full_name || '')}</label>`).join('') || '<span class="muted">אין עובדים פעילים</span>';
}

async function attSetAuto(pid, on, cb) {
try {
await run(db.rpc('set_auto_attendance', { p_profile: pid, p_on: on }));
if (profile && pid === profile.id) { profile.auto_attendance = on; if (on) attAutoBeat(true); else await updateClockButton(); }
toast(on ? 'נוכחות אוטומטית הופעלה' : 'נוכחות אוטומטית כובתה');
} catch (e) { if (cb) cb.checked = !on; }
}

/* בקשת תיקון — עובד ששכח להחתים */
function attRequestFix() {
openForm('בקשת תיקון נוכחות', [
{ name: 'work_date', label: 'תאריך העבודה', type: 'date', required: true, default: today() },
{ name: 'in_time', label: 'שעת כניסה (למשל 08:30)', required: true, dir: 'ltr' },
{ name: 'out_time', label: 'שעת יציאה (למשל 16:00)', dir: 'ltr' },
{ name: 'reason', label: 'סיבה', required: true },
], {}, async (rec) => {
const mk = (d, t) => t && /^\d{1,2}:\d{2}$/.test(t) ? new Date(d + 'T' + t.padStart(5, '0') + ':00').toISOString() : null;
const rin = mk(rec.work_date, rec.in_time);
if (!rin) { toast('שעת כניסה לא תקינה — פורמט 08:30', true); return; }
await run(db.from('attendance_requests').insert({
profile_id: profile.id, work_date: rec.work_date,
requested_in: rin, requested_out: mk(rec.work_date, rec.out_time), reason: rec.reason,
}));
toast('הבקשה נשלחה למנהל');
openPage('attendance');
});
}

/* תיקון מנהל — עריכת שעות רישום קיים, למשל עובד ששכח להחתים יציאה.
   רץ דרך פונקציית שרת (admin_fix_attendance) שמוודאת הרשאת מנהל,
   והרישום מסומן "תיקון ידני" כדי לשמור על שקיפות מול העובד. */
async function attAdminFix(id) {
const [r] = await run(db.from('attendance').select('*').eq('id', id).limit(1));
if (!r) { toast('הרישום לא נמצא', true); return; }
const workDate = localDay(r.clock_in);
const t = v => v ? new Date(v).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
const who = (cache.profiles.find(p => p.id === r.profile_id) || {}).full_name || '';
openForm('תיקון שעות — ' + who, [
{ name: 'work_date', label: 'תאריך העבודה', type: 'date', required: true, default: workDate },
{ name: 'in_time', label: 'שעת כניסה (למשל 08:30)', required: true, dir: 'ltr', default: t(r.clock_in) },
{ name: 'out_time', label: 'שעת יציאה (למשל 16:00)', dir: 'ltr', default: t(r.clock_out) },
], {}, async (rec) => {
const mk = (d, tm) => tm && /^\d{1,2}:\d{2}$/.test(tm) ? new Date(d + 'T' + tm.padStart(5, '0') + ':00').toISOString() : null;
const rin = mk(rec.work_date, rec.in_time);
if (!rin) { toast('שעת כניסה לא תקינה — פורמט 08:30', true); return; }
const rout = mk(rec.work_date, rec.out_time);
if (rout && rout <= rin) { toast('שעת היציאה חייבת להיות אחרי הכניסה', true); return; }
await run(db.rpc('admin_fix_attendance', { p_id: r.id, p_clock_in: rin, p_clock_out: rout }));
toast('הרישום עודכן וסומן כתיקון ידני');
openPage('attendance');
});
}

async function attApprove(requestId, approve) {
await run(db.rpc('approve_attendance_request', { p_request_id: requestId, p_approve: approve }));
toast(approve ? 'אושר ונוסף ליומן' : 'נדחה');
openPage('attendance');
}

/* ייצוא חודשי להכנת שכר */
async function attendanceExport(month) {
// אותם גבולות חודש מקומיים כמו במסך — שדוח השכר יתאים למה שרואים
const [_ey, _em] = month.split('-').map(Number);
const rows = await run(db.from('attendance').select('*').gte('clock_in', new Date(_ey, _em - 1, 1).toISOString()).lt('clock_in', new Date(_ey, _em, 1).toISOString()).order('clock_in'));
exportCsv('נוכחות_' + month,
['עובד', 'תאריך', 'כניסה', 'יציאה', 'שעות', 'תיקון ידני'],
rows.map(r => {
const h = r.clock_out ? ((new Date(r.clock_out) - new Date(r.clock_in)) / 3600000).toFixed(2) : '';
return [(cache.profiles.find(p => p.id === r.profile_id) || {}).full_name || '',
localDay(r.clock_in),
new Date(r.clock_in).toLocaleTimeString('he-IL'),
r.clock_out ? new Date(r.clock_out).toLocaleTimeString('he-IL') : '',
h, r.manual ? 'כן' : ''];
}));
}

/* ============================================================
   באנר "הפעל שעון נוכחות" בכניסה + תזכורת "כבה את השעון" ביציאה
   (מוזרק בלי לגעת ב-app.js/index.html — עטיפת afterLogin ו-logout)
============================================================ */
function attEnsureBannerStyles() {
  if (document.getElementById('attBnStyles')) return;
  const s = document.createElement('style'); s.id = 'attBnStyles';
  s.textContent = `
  .att-banner{position:fixed;top:0;left:0;right:0;z-index:9998;display:flex;align-items:center;gap:12px;
    justify-content:center;flex-wrap:wrap;padding:10px 16px;color:#fff;font-weight:700;
    background:linear-gradient(90deg,@@COLOR_BRAND@@,#3a4bc0);box-shadow:0 2px 12px rgba(0,0,0,.25)}
  .att-banner .att-b-go{cursor:pointer;background:#fff;color:@@COLOR_BRAND@@;border:none;border-radius:8px;padding:6px 14px;font-weight:800}
  .att-banner .att-b-x{cursor:pointer;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:8px;padding:6px 12px}
  `;
  document.head.appendChild(s);
}

async function attIsClockedIn() {
  try {
    const { data } = await db.from('attendance').select('id').eq('profile_id', profile.id).is('clock_out', null).limit(1);
    return !!(data && data.length);
  } catch (e) { return false; }
}

async function attMaybeClockInBanner() {
  if (!profile || profile.role === 'committee') return;
  if (!document.getElementById('clockBtn')) return;        // רק למי שיש שעון נוכחות
  if (attIsAuto()) return;                                  // נוכחות אוטומטית — אין צורך בתזכורת
  if (document.getElementById('attClockBanner')) return;    // כבר מוצג
  if (await attIsClockedIn()) return;                       // כבר מוחתם — אין צורך
  attEnsureBannerStyles();
  const bn = document.createElement('div');
  bn.id = 'attClockBanner';
  bn.className = 'att-banner';
  bn.innerHTML = `<span>⏱️ אל תשכח/י להפעיל את שעון הנוכחות</span>
    <button class="att-b-go" id="attBnGo">▶ הפעל שעון</button>
    <button class="att-b-x" id="attBnX">אחר כך</button>`;
  document.body.appendChild(bn);
  const close = () => bn.remove();
  bn.querySelector('#attBnX').addEventListener('click', close);
  bn.querySelector('#attBnGo').addEventListener('click', async () => {
    try { await toggleClock(); } catch (e) { /* toast כבר הוצג */ }
    close();
  });
}

function attShowClockOutReminder(origLogout) {
  emuEnsureStyles();
  const ov = document.createElement('div');
  ov.className = 'emu-overlay';
  ov.innerHTML = `<div class="emu-oops" style="max-width:420px">
      <div class="ic">⏱️</div>
      <p style="margin:10px 0 6px"><b>שעון הנוכחות עדיין פועל</b><br>
        <span style="font-size:.9rem;color:#555">לכבות את השעון לפני היציאה?</span></p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn-sm" id="attCoOut">⏹ כבה שעון והתנתק</button>
        <button class="btn btn-sm btn-ghost" id="attCoSkip">התנתק בלי לכבות</button>
        <button class="btn btn-sm btn-ghost" id="attCoCancel">ביטול</button>
      </div>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#attCoCancel').addEventListener('click', close);
  ov.querySelector('#attCoSkip').addEventListener('click', () => { close(); origLogout(); });
  ov.querySelector('#attCoOut').addEventListener('click', async () => {
    try { await run(db.rpc('clock_out')); } catch (e) { /* בכל מקרה מתנתקים */ }
    close(); origLogout();
  });
  document.body.appendChild(ov);
}

/* ============================================================
   נוכחות אוטומטית — למי שמסומן auto_attendance (ברירת מחדל: מנהלים)
   כל פעילות בתוכנה (עכבר/מקלדת/מגע/חזרה ללשונית) שולחת "דופק" לשרת,
   לכל היותר פעם ב-4 דקות. השרת (attendance_heartbeat) פותח משמרת אם אין,
   וסוגר משמרת שנזנחה (30 דק' בלי דופק) בשעת הפעילות האחרונה.
============================================================ */
const ATT_BEAT_MS = 4 * 60 * 1000;
let _attLastBeat = 0, _attBeatBusy = false, _attAutoOn = false;

function attIsAuto() { return !!(profile && profile.auto_attendance && profile.role !== 'committee'); }

async function attAutoBeat(force) {
  if (!attIsAuto() || _attBeatBusy) return;
  if (!force && Date.now() - _attLastBeat < ATT_BEAT_MS) return;
  _attBeatBusy = true; _attLastBeat = Date.now();
  try {
    const { data, error } = await db.rpc('attendance_heartbeat');
    if (error) { console.warn('attendance_heartbeat', error.message); return; }
    if (data === 'off') { profile.auto_attendance = false; }
    if (data === 'started' || data === 'off') await updateClockButton();
  } catch (e) { /* רשת — ננסה בפעילות הבאה */ }
  finally { _attBeatBusy = false; }
}

function attAutoStart() {
  if (!attIsAuto()) return;
  attAutoBeat(true);
  if (_attAutoOn) return;
  _attAutoOn = true;
  const onAct = () => attAutoBeat(false);
  ['pointerdown', 'keydown', 'mousemove', 'touchstart', 'wheel'].forEach(ev =>
    document.addEventListener(ev, onAct, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onAct(); });
}

/* כפתור השעון בתפריט — למשתמש אוטומטי מציג סטטוס (הלחיצה עדיין סוגרת/פותחת ידנית) */
(function () {
  const orig = window.updateClockButton;
  if (typeof orig === 'function' && !orig._attWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      const btn = document.getElementById('clockBtn');
      if (btn && attIsAuto()) {
        btn.textContent = btn.dataset.state === 'in' ? '⏱ נוכח (אוטומטי)' : '⏱ אוטומטי';
        btn.title = 'נוכחות אוטומטית: נרשמת כניסה כשעובדים בתוכנה, ויציאה אחרי 30 דק\' בלי פעילות';
      } else if (btn) btn.title = '';
      return r;
    };
    wrapped._attWrapped = true;
    window.updateClockButton = wrapped;
  }
})();

/* עטיפת afterLogin — הצגת הבאנר אחרי הכניסה */
(function () {
  const orig = window.afterLogin;
  if (typeof orig === 'function' && !orig._attWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { attAutoStart(); } catch (e) { console.error('att auto', e); }
      try { await attMaybeClockInBanner(); } catch (e) { console.error('att banner', e); }
      return r;
    };
    wrapped._attWrapped = true;
    window.afterLogin = wrapped;
  }
})();

/* עטיפת logout — תזכורת לכבות את השעון אם הוא עדיין פועל */
(function () {
  const orig = window.logout;
  if (typeof orig === 'function' && !orig._attWrapped) {
    const wrapped = async function () {
      try {
        if (attIsAuto()) {                                     // אוטומטי — סוגרים משמרת בשקט
          if (await attIsClockedIn()) { try { await db.rpc('clock_out'); } catch (e) { /* ממשיכים */ } }
          return orig.apply(this, arguments);
        }
        if (await attIsClockedIn()) { attShowClockOutReminder(orig); return; }
      } catch (e) { /* אם הבדיקה נכשלה — ממשיכים ליציאה רגילה */ }
      return orig.apply(this, arguments);
    };
    wrapped._attWrapped = true;
    window.logout = wrapped;
  }
})();
