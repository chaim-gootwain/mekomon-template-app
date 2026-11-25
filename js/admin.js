/* ============================================================
admin.js — ניהול המערכת (מנהל בלבד)
------------------------------------------------------------
users — אישור נרשמים והקצאת תפקידים
pricing — עריכת המחירון
settings — שם העיתון, פיצול עמלה, תקופת לקוח חדש, צ'קליסט,
יומן פעילות, גיבוי מלא לאקסל
============================================================ */

'use strict';

/* ==================== משתמשים ==================== */

let _usersList = [];

Pages.users = {
render: async (el) => {
const users = await run(db.from('profiles').select('*').order('created_at'));
_usersList = users;
el.innerHTML = `
<div class="page-head"><h2>משתמשים והרשאות</h2></div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">
עובד חדש נרשם בעצמו במסך הכניסה ← מופיע כאן כ"ממתין" ← אתה בוחר לו תפקיד.
תפקיד קובע בדיוק מה רואים ומה מותר — גם ברמת השרת.</p>
<button class="btn" onclick="userInvite()">+ הוסף משתמש</button><div class="card" id="usersTable"></div>`;
renderTable(document.getElementById('usersTable'), users, [
{ h: 'שם', f: r => `<b>${esc(r.full_name) || 'ללא שם'}</b> ${r.id === profile.id ? '<span class="pill blue">אני</span>' : ''}` },
{ h: 'טלפון', f: r => `<span dir="ltr">${esc(r.phone)}</span>` },
{ h: 'תפקיד', f: r => `
<select style="max-width:150px" ${r.id === profile.id ? 'disabled' : ''}
onchange="userSetRole('${r.id}', this.value)">
${Object.entries(ROLE_NAMES).map(([v, t]) => `<option value="${v}" ${r.role === v ? 'selected' : ''}>${t}</option>`).join('')}
</select>` },
{ h: 'מצב', f: r => r.role === 'pending' ? '<span class="pill amber">ממתין לאישור</span>'
: (r.active ? '<span class="pill green">פעיל</span>' : '<span class="pill red">מושבת</span>') },
{ h: '', f: r => r.id === profile.id ? '' :
`<button class="btn btn-sm btn-ghost" onclick="userEditProfile('${r.id}')">עריכה</button>
<button class="btn btn-sm btn-ghost" onclick="userToggleActive('${r.id}', ${!r.active})">${r.active ? 'השבתה' : 'הפעלה'}</button>
<button class="btn btn-sm btn-danger-ghost" onclick="userDelete('${r.id}')">מחיקה</button>` },
], { empty: 'אין משתמשים' });
}
};

/* קריאה לפונקציית השרת admin-users — מחזירה data או זורקת עם הודעה בעברית */
async function _adminUsersCall(body) {
const { data, error } = await db.functions.invoke('admin-users', { body });
if (error) {
let msg = error.message;
try { if (error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.error || msg; } } catch (e) { }
toast('שגיאה: ' + msg, true); throw new Error(msg);
}
if (data && data.error) { toast('שגיאה: ' + data.error, true); throw new Error(data.error); }
return data;
}

/* הזמנת משתמש חדש במייל */
function userInvite() {
openForm('הזמנת משתמש חדש', [
{ name: 'email', label: 'אימייל', type: 'email', required: true, dir: 'ltr' },
{ name: 'full_name', label: 'שם מלא', required: true },
{ name: 'phone', label: 'טלפון', dir: 'ltr' },
{ name: 'role', label: 'תפקיד', type: 'select', required: true, default: 'sales',
options: Object.entries(ROLE_NAMES).filter(([v]) => v !== 'pending').map(([v, t]) => ({ v, t })) },
{ name: '_info', type: 'html', html: '<p class="muted" style="font-size:.8rem">יישלח מייל עם קישור להגדרת סיסמה. אחרי שהעובד יגדיר סיסמה — הוא ייכנס לפי התפקיד שבחרת.</p>' },
], {}, async (rec) => {
toast('שולח הזמנה...');
await _adminUsersCall({ action: 'invite', email: rec.email, full_name: rec.full_name, phone: rec.phone, role: rec.role, redirectTo: location.origin + '/set-password.html' });
toast('הזמנה נשלחה למייל ' + rec.email);
await refreshCache();
openPage('users');
});
}

/* עריכת שם/טלפון של משתמש קיים */
function userEditProfile(id) {
const u = (_usersList || []).find(x => x.id === id);
if (!u) return;
openForm('עריכת פרטי משתמש', [
{ name: 'full_name', label: 'שם מלא', required: true },
{ name: 'phone', label: 'טלפון', dir: 'ltr' },
], { full_name: u.full_name, phone: u.phone }, async (rec) => {
await run(db.from('profiles').update({ full_name: rec.full_name, phone: rec.phone }).eq('id', id));
try { await db.from('agents').update({ name: rec.full_name }).eq('profile_id', id); } catch (e) { }
toast('נשמר');
await refreshCache();
openPage('users');
});
}

/* מחיקת משתמש לצמיתות */
async function userDelete(id) {
const u = (_usersList || []).find(x => x.id === id) || {};
if (!confirm('למחוק לצמיתות את ' + (u.full_name || 'המשתמש') + '?\nהפעולה בלתי הפיכה — המשתמש יימחק כולל ההתחברות שלו.\n(אם רק רוצים לחסום כניסה — עדיף "השבתה")')) return;
toast('מוחק...');
try {
await _adminUsersCall({ action: 'delete', id });
toast('המשתמש נמחק');
await refreshCache();
openPage('users');
} catch (e) { /* ההודעה כבר הוצגה */ }
}

async function userSetRole(userId, role) {
await run(db.from('profiles').update({ role }).eq('id', userId));
toast('התפקיד עודכן');
await refreshCache();
openPage('users');
}

async function userToggleActive(userId, active) {
if (!active && !confirm('להשבית את המשתמש? הוא לא יוכל להיכנס למערכת.')) return;
await run(db.from('profiles').update({ active }).eq('id', userId));
toast(active ? 'הופעל' : 'הושבת');
openPage('users');
}

/* ==================== מחירון ==================== */

Pages.pricing = {
render: async (el) => {
const items = await run(db.from('price_list').select('*').order('sort'));
el.innerHTML = `
<div class="page-head">
<h2>מחירון פרסומים</h2>
<button class="btn" onclick="priceAdd()">+ פריט חדש</button>
</div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">המחירים לפני מע"מ, כמו במחירון המודפס. שינוי כאן משפיע על מודעות והצעות מחיר חדשות בלבד.</p>
<div class="card" id="priceTable"></div>`;
renderTable(document.getElementById('priceTable'), items, [
{ h: 'פריט', f: r => `<b>${esc(r.name)}</b> ${r.premium ? '<span class="pill gold">פרימיום</span>' : ''}` },
{ h: 'מחיר', f: r => money(r.price) },
{ h: 'סדר', f: r => r.sort },
{ h: 'פעיל', f: r => r.active ? '<span class="pill green">כן</span>' : '<span class="pill">לא</span>' },
], { onRow: r => priceEdit(r), empty: 'המחירון ריק' });
}
};

const PRICE_FIELDS = [
{ name: 'name', label: 'שם הפריט', required: true },
{ name: 'price', label: 'מחיר (₪, לפני מע"מ)', type: 'number', required: true },
{ name: 'premium', label: 'עמוד פרימיום', type: 'checkbox' },
{ name: 'sort', label: 'מיקום בסדר', type: 'number', default: 10 },
{ name: 'active', label: 'פעיל', type: 'checkbox', default: true },
];

function priceAdd() {
openForm('פריט מחירון חדש', PRICE_FIELDS, {}, async (rec) => {
await run(db.from('price_list').insert(rec));
await refreshCache();
toast('נוסף');
openPage('pricing');
});
}

function priceEdit(item) {
openForm('עריכה — ' + item.name, PRICE_FIELDS, item, async (rec) => {
await run(db.from('price_list').update(rec).eq('id', item.id));
await refreshCache();
toast('נשמר');
openPage('pricing');
});
}

/* ==================== הגדרות ==================== */

Pages.settings = {
render: async (el) => {
const s = cache.settings;
el.innerHTML = `
<div class="page-head"><h2>הגדרות מערכת</h2></div>

<div class="card card-pad">
<b>הגדרות כלליות</b>
<div class="grid2" style="margin-top:12px">
<div class="field"><label>שם העיתון</label><input id="setPaper" value="${esc(s.paper_name || '')}"></div>
<div class="field"><label>עיר / יישוב (מציב {city} בנוסחים, למשל בברכת הבוקר)</label><input id="setCity" value="${esc(s.paper_city || '')}"></div>
<div class="field"><label>מספר עמודים ברירת מחדל לגיליון</label><input id="setPages" type="number" value="${esc(s.default_pages_count || s.default_pages || '32')}" dir="ltr"></div>
<div class="field"><label>% עמלה שמבשיל בחיוב (השאר בגבייה)</label><input id="setSplit" type="number" value="${esc(s.commission_split_billing || '50')}" dir="ltr"></div>
<div class="field"><label>תקופת "לקוח חדש" (חודשים)</label><input id="setNewMonths" type="number" value="${esc(s.new_customer_months || '3')}" dir="ltr"></div>
<div class="field"><label>מייל להתראות "בעיות לתיקון" (צ'אט צוות; ריק = מייל העיתון)</label><input id="setFixesEmail" type="email" value="${esc(s.fixes_notify_email || '')}" dir="ltr"></div>
</div>
<button class="btn" onclick="settingsSave()">שמירת הגדרות</button>
</div>

<div class="card card-pad">
<b>צ'קליסט סגירת גיליון</b>
<p class="muted" style="font-size:.82rem">הרשימה שנוצרת אוטומטית לכל גיליון חדש</p>
<div id="clList" style="margin-top:8px"></div>
<button class="btn btn-sm btn-ghost" style="margin-top:10px" onclick="checklistTemplateAdd()">+ סעיף</button>
</div>

<div class="card card-pad">
<b>גיבוי וייצוא</b>
<p class="muted" style="font-size:.82rem">Supabase מגבה אוטומטית כל יום. בנוסף אפשר לייצא הכל לאקסל:</p>
<button class="btn btn-ghost" style="margin-top:8px" onclick="fullBackup()">⬇ ייצוא כל הנתונים (CSV לכל טבלה)</button>
</div>

<div class="card card-pad">
<b>טלפוניה (Voicenter)</b>
<p class="muted" style="font-size:.82rem">הפעלת החייגן וזיהוי שיחות. קוד ה-API של Voicenter מוגדר ב-Supabase (Edge Function), לא כאן. שלוחת כל סוכן נקבעת במסך "סוכנים".</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setTel" ${telephonyOn() ? 'checked' : ''} onchange="telephonySave(this.checked)" style="width:18px;height:18px">
טלפוניה פעילה (מציגה כפתורי חייגן 📞)
</label>
</div>

<div class="card card-pad">
<b>תובנות AI (Voicenter)</b>
<p class="muted" style="font-size:.82rem">קליטת ניתוח השיחות של Voicenter (סיכום · סנטימנט · תמלול · הצעות לאישור) לתוך כרטיס הליד. דורש חיבור למקור הניתוח ב-Voicenter.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setAi" ${aiInsightsOn() ? 'checked' : ''} onchange="aiInsightsSave(this.checked)" style="width:18px;height:18px">
תובנות AI פעילות (פאנל תובנות בכרטיס הליד 🧠)
</label>
${aiInsightsOn() ? `<button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="aiReprocess(this)">🔄 עיבוד מחדש של ניתוחים קיימים (עברית · שדות תקינים)</button>` : ''}
</div>

<div class="card card-pad">
<b>חשבוניות (EZcount)</b>
<p class="muted" style="font-size:.82rem">הפקת חשבוניות דרך EZcount. מפתח ה-API מוגדר ב-Supabase (Edge Function), לא כאן. במצב "בדיקה" המסמכים אינם חוקיים — לאימות בלבד.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setEz" ${ezcountOn() ? 'checked' : ''} onchange="ezcountToggle(this.checked)" style="width:18px;height:18px">
חשבוניות פעילות (מציג פאנל חשבוניות בכרטיס הלקוח 🧾)
</label>
<div class="grid2" style="margin-top:10px">
<div class="field"><label>מצב עבודה</label>
<select id="setEzMode" onchange="ezcountModeSave(this.value)">
<option value="demo" ${(cache.settings.ezcount_mode || 'demo') !== 'production' ? 'selected' : ''}>בדיקה (demo)</option>
<option value="production" ${(cache.settings.ezcount_mode || '') === 'production' ? 'selected' : ''}>אמיתי (production)</option>
</select></div>
</div>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setEzSend" ${(cache.settings.ezcount_autosend || '0') === '1' ? 'checked' : ''} onchange="ezcountAutosendSave(this.checked)" style="width:18px;height:18px">
שליחת המסמך אוטומטית למייל הלקוח
</label>
</div>

${typeof adsAutoCard === 'function' ? adsAutoCard() : ''}

${typeof alertsSettingsCard === 'function' ? alertsSettingsCard() : ''}

${typeof weeklySummaryCard === 'function' ? weeklySummaryCard() : ''}

${typeof collSettingsCard === 'function' ? collSettingsCard() : ''}

${typeof pipSettingsCard === 'function' ? pipSettingsCard() : ''}

${typeof standingOrdersCard === 'function' ? standingOrdersCard() : ''}

${typeof agenciesCard === 'function' ? agenciesCard() : ''}

${typeof issueTypesCard === 'function' ? issueTypesCard() : ''}

${typeof issueRemindersCard === 'function' ? issueRemindersCard() : ''}

${typeof autoLayoutCard === 'function' ? autoLayoutCard() : ''}

${typeof printLayoutCard === 'function' ? printLayoutCard() : ''}

<div class="card card-pad">
<b>🏷️ מחירון</b>
<p class="muted" style="font-size:.82rem">עריכת מחיר הפרסומים. השינויים משפיעים על מודעות והצעות מחיר חדשות בלבד.</p>
<button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="openPage('pricing')">פתיחת המחירון ←</button>
</div>

<div class="card card-pad">
<b>יומן פעילות אחרון</b>
<div id="activityLog" style="margin-top:8px"><div class="empty">טוען...</div></div>
</div>`;

if (typeof alertsSettingsMount === 'function') alertsSettingsMount();

/* צ'קליסט */
const tmpl = await run(db.from('checklist_template').select('*').order('sort'));
document.getElementById('clList').innerHTML = tmpl.map(t => `
<div class="checklist-item">
<span style="flex:1">${esc(t.label)}</span>
<button class="btn-danger-ghost btn-sm" onclick="checklistTemplateToggle(${t.id}, ${!t.active})">${t.active ? 'כיבוי' : 'הפעלה'}</button>
</div>`).join('');

/* יומן פעילות — נקרא מ-audit_log (נכתבת ע"י טריגרי המעקב, מיגרציית 2026-08-30_audit_log).
   במופע שטרם הריץ את המיגרציה — מציגים הודעה שקטה במקום לשבור את המסך */
let log = [];
try {
const r = await db.from('audit_log').select('*').order('at', { ascending: false }).limit(40);
if (!r.error) log = r.data || [];
} catch (e) { }
const tableNames = { leads: 'ליד', customers: 'לקוח', ads: 'מודעה', charges: 'חיוב', payments: 'תשלום', contracts: 'חוזה', expenses: 'הוצאה', attendance: 'נוכחות', agents: 'סוכן' };
const actions = { insert: 'יצירה', update: 'עדכון', delete: 'מחיקה' };
document.getElementById('activityLog').innerHTML = log.length ? `
<ul class="timeline">${log.map(l => {
const who = cache.profiles.find(p => p.id === l.user_id);
return `<li><div class="tl-time">${heDateTime(l.at)} · ${esc(who ? who.full_name : 'מערכת')}</div>
${actions[l.action] || l.action} ${tableNames[l.table_name] || l.table_name} #${esc(l.row_id)}${l.field ? ' · <span class="muted">' + esc(l.field) + '</span>' : ''}</li>`;
}).join('')}</ul>` : '<p class="muted">אין פעילות עדיין</p>';
}
};

async function settingsSave() {
const updates = [
{ key: 'paper_name', value: document.getElementById('setPaper').value.trim() },
{ key: 'paper_city', value: document.getElementById('setCity').value.trim() },
// כל הקוראים (issues, issue-expenses, צ'אטים) קוראים default_pages_count —
// שמירה תחת default_pages בלבד הפכה את ההגדרה לחסרת השפעה
{ key: 'default_pages_count', value: document.getElementById('setPages').value },
{ key: 'commission_split_billing', value: document.getElementById('setSplit').value },
{ key: 'new_customer_months', value: document.getElementById('setNewMonths').value },
{ key: 'fixes_notify_email', value: (document.getElementById('setFixesEmail').value || '').trim() },
];
for (const u of updates) await run(db.from('settings').upsert(u));
updates.forEach(u => cache.settings[u.key] = u.value);
buildShell(); // רענון שם העיתון בתפריט
toast('ההגדרות נשמרו');
}

async function telephonySave(on) {
await run(db.from('settings').upsert({ key: 'telephony_enabled', value: on ? '1' : '0' }));
cache.settings.telephony_enabled = on ? '1' : '0';
toast(on ? 'טלפוניה הופעלה' : 'טלפוניה כובתה');
}

async function aiInsightsSave(on) {
await run(db.from('settings').upsert({ key: 'ai_insights_enabled', value: on ? '1' : '0' }));
cache.settings.ai_insights_enabled = on ? '1' : '0';
toast(on ? 'תובנות AI הופעלו' : 'תובנות AI כובו');
}

function ezcountOn() { return String((cache.settings || {}).ezcount_enabled || '0') === '1'; }
async function ezcountToggle(on) {
await run(db.from('settings').upsert({ key: 'ezcount_enabled', value: on ? '1' : '0' }));
cache.settings.ezcount_enabled = on ? '1' : '0';
toast(on ? 'חשבוניות הופעלו' : 'חשבוניות כובו');
}
async function ezcountModeSave(mode) {
await run(db.from('settings').upsert({ key: 'ezcount_mode', value: mode }));
cache.settings.ezcount_mode = mode;
toast(mode === 'production' ? 'מצב אמיתי הופעל' : 'מצב בדיקה');
}
async function ezcountAutosendSave(on) {
await run(db.from('settings').upsert({ key: 'ezcount_autosend', value: on ? '1' : '0' }));
cache.settings.ezcount_autosend = on ? '1' : '0';
toast('נשמר');
}

function checklistTemplateAdd() {
const label = prompt('נוסח הסעיף:');
if (!label) return;
run(db.from('checklist_template').insert({ label, sort: 99 })).then(() => { toast('נוסף'); openPage('settings'); });
}

async function checklistTemplateToggle(id, active) {
await run(db.from('checklist_template').update({ active }).eq('id', id));
openPage('settings');
}

/* גיבוי מלא: CSV לכל טבלה מרכזית */
async function fullBackup() {
toast('מייצא... זה יכול לקחת כמה שניות');
const tables = ['customers', 'leads', 'agents', 'ads', 'issues', 'articles', 'charges', 'payments', 'contracts', 'expenses', 'price_list', 'quotes'];
const failed = [], empty = [];
for (const t of tables) {
let data;
// customers: בלי portal_token (העמודה חסומה לקריאה ישירה)
const _cols = t === 'customers' ? await _custCols() : '*';
try { data = await runAll((f, to) => db.from(t).select(_cols).order('id').range(f, to), 'שגיאה בגיבוי ' + t); }
catch (e) { failed.push(t); continue; }
if (!data.length) { empty.push(t); continue; }
const headers = Object.keys(data[0]);
exportCsv('גיבוי_' + t + '_' + today(), headers, data.map(r => headers.map(h => typeof r[h] === 'object' && r[h] !== null ? JSON.stringify(r[h]) : r[h])));
await new Promise(r => setTimeout(r, 400)); // רווח בין הורדות
}
if (failed.length) toast('הגיבוי הסתיים אך נכשל בטבלאות: ' + failed.join(', '), true);
else toast('הייצוא הושלם' + (empty.length ? ' (טבלאות ריקות דולגו: ' + empty.join(', ') + ')' : '') + ' — בדוק את תיקיית ההורדות');
}
/* v: invoices module */

/* ==================== הגדרות כקוביות ====================
   כל כרטיס בדף ההגדרות (כולל כרטיסים שמודולים אחרים מזריקים) הופך לקובייה
   קטנה: אייקון + כותרת + תיאור קצר. לחיצה פותחת את הקובייה לרוחב מלא עם
   ההגדרות עצמן; קובייה אחת פתוחה בכל פעם. הרכיבים המקוריים מועברים כמו
   שהם (אותם id ו-onclick) — שום קוד שמירה לא משתנה.
   מותקן ב-app.js (_settingsTilesInstall) אחרי שכל המודולים עטפו את הדף. */
let _stOpen = null; // כותרת הקובייה הפתוחה — נשמרת גם כשהדף מצויר מחדש
const _ST_ICONS = [
  ['כללי', '⚙️'], ['צ\'קליסט', '✅'], ['גיבוי', '💾'], ['טלפוניה', '📞'], ['תובנות', '💡'],
  ['חשבוניות', '🧾'], ['צ׳אט חשבוניות', '💬'], ['יומן', '📜'], ['סוכן', '🤖'], ['התראות', '🔔'],
  ['בוקר', '🌅'], ['שיבוץ', '🧩'], ['דפוס', '🖨️'], ['הרכבה', '🖨️'],
];
function _stEnsureCss() {
  if (document.getElementById('stCss')) return;
  const s = document.createElement('style'); s.id = 'stCss';
  s.textContent = `
.st-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;align-items:start}
.st-grid>.card{margin:0;padding:0!important;overflow:hidden;transition:box-shadow .15s}
.st-grid>.card:not(.st-open):hover{box-shadow:0 4px 14px rgba(15,23,42,.10)}
.st-head{all:unset;box-sizing:border-box;display:flex;gap:12px;align-items:flex-start;width:100%;padding:14px 16px;cursor:pointer;min-height:86px}
.st-head:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
.st-ico{font-size:1.6rem;line-height:1;flex:none}
.st-txt{flex:1;min-width:0}
.st-ttl{font-weight:700;color:var(--brand-dark);font-size:.98rem}
.st-sub{color:var(--muted);font-size:.78rem;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.st-chev{flex:none;color:var(--muted);transition:transform .2s;margin-top:2px}
.st-body{display:none;padding:0 16px 16px;border-top:1px solid var(--line)}
.st-open{grid-column:1/-1;box-shadow:0 4px 18px rgba(15,23,42,.10)}
.st-open .st-body{display:block;padding-top:12px}
.st-open .st-chev{transform:rotate(180deg)}
.st-open .st-head{min-height:0;align-items:center}
.st-open .st-sub{display:none}
@media (max-width:600px){.st-head{min-height:0}}`;
  document.head.appendChild(s);
}
function settingsTilesApply(el) {
  if (!el || el.querySelector('.st-grid')) return;
  const cards = [...el.children].filter(c => c.classList && c.classList.contains('card'));
  if (!cards.length) return;
  _stEnsureCss();
  const grid = document.createElement('div'); grid.className = 'st-grid';
  cards[0].before(grid);
  cards.forEach(card => {
    const tEl = card.querySelector(':scope > b, :scope > h3') || card.querySelector('b, h3');
    const title = (tEl ? tEl.textContent : 'הגדרות').trim();
    const emo = (title.match(/\p{Extended_Pictographic}️?/u) || [])[0];
    const name = title.replace(/\p{Extended_Pictographic}️?/gu, '').trim() || title;
    const icon = emo || ((_ST_ICONS.find(([k]) => name.includes(k)) || [])[1]) || '⚙️';
    const pEl = card.querySelector(':scope > p.muted');
    const sub = pEl ? pEl.textContent.trim().replace(/\s+/g, ' ') : '';
    if (tEl && tEl.parentElement === card) tEl.remove();
    const body = document.createElement('div'); body.className = 'st-body';
    while (card.firstChild) body.appendChild(card.firstChild);
    const head = document.createElement('button'); head.type = 'button'; head.className = 'st-head';
    head.innerHTML = `<span class="st-ico">${esc(icon)}</span><span class="st-txt"><div class="st-ttl">${esc(name)}</div>${sub ? `<div class="st-sub">${esc(sub)}</div>` : ''}</span><span class="st-chev">▾</span>`;
    head.setAttribute('aria-expanded', 'false');
    head.onclick = () => {
      const was = card.classList.contains('st-open');
      grid.querySelectorAll(':scope > .st-open').forEach(c => { c.classList.remove('st-open'); c.querySelector('.st-head').setAttribute('aria-expanded', 'false'); });
      _stOpen = was ? null : name;
      if (!was) { card.classList.add('st-open'); head.setAttribute('aria-expanded', 'true'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    };
    card.append(head, body);
    grid.appendChild(card);
    if (_stOpen === name) { card.classList.add('st-open'); head.setAttribute('aria-expanded', 'true'); }
  });
}
