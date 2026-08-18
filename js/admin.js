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
<div class="field"><label>מספר עמודים ברירת מחדל לגיליון</label><input id="setPages" type="number" value="${esc(s.default_pages || '32')}" dir="ltr"></div>
<div class="field"><label>% עמלה שמבשיל בחיוב (השאר בגבייה)</label><input id="setSplit" type="number" value="${esc(s.commission_split_billing || '50')}" dir="ltr"></div>
<div class="field"><label>תקופת "לקוח חדש" (חודשים)</label><input id="setNewMonths" type="number" value="${esc(s.new_customer_months || '3')}" dir="ltr"></div>
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

<div class="card card-pad">
<b>יומן פעילות אחרון</b>
<div id="activityLog" style="margin-top:8px"><div class="empty">טוען...</div></div>
</div>`;

/* צ'קליסט */
const tmpl = await run(db.from('checklist_template').select('*').order('sort'));
document.getElementById('clList').innerHTML = tmpl.map(t => `
<div class="checklist-item">
<span style="flex:1">${esc(t.label)}</span>
<button class="btn-danger-ghost btn-sm" onclick="checklistTemplateToggle(${t.id}, ${!t.active})">${t.active ? 'כיבוי' : 'הפעלה'}</button>
</div>`).join('');

/* יומן פעילות */
const log = await run(db.from('activity_log').select('*').order('created_at', { ascending: false }).limit(40));
const tableNames = { leads: 'ליד', customers: 'לקוח', ads: 'מודעה', charges: 'חיוב', payments: 'תשלום', contracts: 'חוזה', expenses: 'הוצאה', attendance: 'נוכחות', agents: 'סוכן' };
const actions = { insert: 'יצירה', update: 'עדכון', delete: 'מחיקה' };
document.getElementById('activityLog').innerHTML = log.length ? `
<ul class="timeline">${log.map(l => {
const who = cache.profiles.find(p => p.id === l.user_id);
return `<li><div class="tl-time">${heDateTime(l.created_at)} · ${esc(who ? who.full_name : 'מערכת')}</div>
${actions[l.action] || l.action} ${tableNames[l.table_name] || l.table_name} #${esc(l.row_id)}</li>`;
}).join('')}</ul>` : '<p class="muted">אין פעילות עדיין</p>';
}
};

async function settingsSave() {
const updates = [
{ key: 'paper_name', value: document.getElementById('setPaper').value.trim() },
{ key: 'default_pages', value: document.getElementById('setPages').value },
{ key: 'commission_split_billing', value: document.getElementById('setSplit').value },
{ key: 'new_customer_months', value: document.getElementById('setNewMonths').value },
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
for (const t of tables) {
const { data, error } = await db.from(t).select('*').limit(5000);
if (error || !data || !data.length) continue;
const headers = Object.keys(data[0]);
exportCsv('גיבוי_' + t + '_' + today(), headers, data.map(r => headers.map(h => typeof r[h] === 'object' && r[h] !== null ? JSON.stringify(r[h]) : r[h])));
await new Promise(r => setTimeout(r, 400)); // רווח בין הורדות
}
toast('הייצוא הושלם — בדוק את תיקיית ההורדות');
}
/* v: invoices module */
