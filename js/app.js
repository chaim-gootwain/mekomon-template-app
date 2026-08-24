/* ============================================================
app.js — לב האפליקציה
------------------------------------------------------------
1. זרימת התחברות (הגדרה ← כניסה ← ממתין ← מערכת)
2. תפריט לפי תפקיד
3. ניתוב בין דפים: כל מודול רושם את הדפים שלו ב-Pages
4. דשבורד
5. שעון נוכחות בתפריט + חיפוש גלובלי
============================================================ */

'use strict';

/* ---------- רישום דפים ----------
כל מודול מוסיף: Pages['שם'] = { title, render: async (el) => {} }
להוספת דף חדש למערכת: קובץ js חדש + שורה ב-NAV + שורה ב-index.html */
const Pages = {};

/* התפריט: id, כותרת, אייקון, תפקידים מורשים, קבוצה */
const NAV = [
{ id: 'dash', title: 'ראשי', icon: '🏠', roles: ['admin', 'sales', 'editor', 'graphics'], group: '' },
{ id: 'leads', title: 'לידים', icon: '📞', roles: ['admin', 'sales'], group: 'מכירות' },
{ id: 'customers', title: 'לקוחות', icon: '🏪', roles: ['admin', 'sales', 'editor', 'graphics'], group: 'מכירות' },
{ id: 'contracts', title: 'חוזים', icon: '📄', roles: ['admin', 'sales'], group: 'מכירות' },
{ id: 'quotes', title: 'הצעות מחיר', icon: '📋', roles: ['admin', 'sales'], group: 'מכירות' },
{ id: 'ads', title: 'מודעות', icon: '📣', roles: ['admin', 'sales', 'editor'], group: 'עיתון' },
{ id: 'graphics', title: 'תור גרפיקה', icon: '🎨', roles: ['admin', 'graphics'], group: 'עיתון' },
{ id: 'committee', title: 'ועדה', icon: '🕮', roles: ['admin', 'committee'], group: 'עיתון' },
{ id: 'issues', title: 'גיליונות ופלטפלן', icon: '🗞️', roles: ['admin', 'editor', 'graphics'], group: 'עיתון' },
{ id: 'articles', title: 'תוכן וכתבות', icon: '✍️', roles: ['admin', 'editor'], group: 'עיתון' },
{ id: 'archive', title: 'ארכיון', icon: '🗄️', roles: ['admin', 'sales', 'editor', 'graphics'], group: 'עיתון' },
{ id: 'finhub', title: 'מרכז כספים', icon: '💰', roles: ['admin'], group: 'כספים' },
{ id: 'billing', title: 'גבייה', icon: '💳', roles: ['admin', 'sales'], group: 'כספים' },
{ id: 'commissions',title: 'עמלות', icon: '🤝', roles: ['admin', 'sales'], group: 'כספים' },
{ id: 'cashflow', title: 'תזרים', icon: '📈', roles: ['admin'], group: 'כספים' },
{ id: 'reports', title: 'דו״חות', icon: '📊', roles: ['admin', 'sales', 'editor'], group: 'כספים' },
{ id: 'attendance', title: 'נוכחות', icon: '⏱️', roles: ['admin', 'sales', 'editor', 'graphics', 'committee'], group: 'ניהול' },
{ id: 'agents', title: 'סוכנים', icon: '👤', roles: ['admin'], group: 'ניהול' },
{ id: 'pricing', title: 'מחירון', icon: '🏷️', roles: ['admin'], group: 'ניהול' },
{ id: 'users', title: 'משתמשים', icon: '👥', roles: ['admin'], group: 'ניהול' },
{ id: 'settings', title: 'הגדרות', icon: '⚙️', roles: ['admin'], group: 'ניהול' },
];

let currentPage = 'dash';

/* ---------- 1. אתחול וזרימת התחברות ---------- */
async function boot() {
if (!initSupabase()) { show('setupScreen'); return; }
const { data } = await db.auth.getSession();
session = data.session;
if (!session) { show('authScreen'); return; }
await afterLogin();
}

async function afterLogin() {
const { data, error } = await db.from('profiles').select('*').eq('id', session.user.id).single();
if (error || !data) {
show('authScreen');
document.getElementById('authErr').textContent = 'שגיאה בטעינת פרופיל — ודא שקובצי ה-SQL הורצו';
return;
}
profile = data;
if (profile.role === 'pending' || !profile.active) { show('pendingScreen'); return; }
if (profile.role === 'committee') { // לוועדה ממשק ממוקד משלה
buildShell(); show('app'); await refreshCache(); openPage('committee'); return;
}
buildShell();
show('app');
await refreshCache();
await updateClockButton();
if (typeof notifInit === 'function') notifInit();
openPage('dash');
setTimeout(async () => {
  try { if (typeof pdfImportCheckPending === 'function' && await pdfImportCheckPending()) return; } catch (e) { }
  try { if (typeof invReconcileCheckPending === 'function' && await invReconcileCheckPending()) return; } catch (e) { }
  try { if (typeof subMaybeReminder === 'function' && await subMaybeReminder()) return; } catch (e) { }
  try { if (typeof pvCheckPending === 'function' && await pvCheckPending()) return; } catch (e) { }
  try { if (typeof weeklyReviewCheckPending === 'function' && await weeklyReviewCheckPending()) return; } catch (e) { }
  try { if (typeof adStatusCheckPending === 'function') await adStatusCheckPending(); } catch (e) { }
}, 1200);
}

function show(id) {
['setupScreen', 'authScreen', 'pendingScreen', 'app'].forEach(s =>
document.getElementById(s).classList.toggle('hidden', s !== id));
}

let signupMode = false;
function toggleAuthMode() {
signupMode = !signupMode;
document.getElementById('nameField').classList.toggle('hidden', !signupMode);
document.getElementById('authBtn').textContent = signupMode ? 'הרשמה' : 'כניסה';
document.getElementById('authToggle').innerHTML = signupMode
? 'כבר יש לך חשבון? <a onclick="toggleAuthMode()">כניסה</a>'
: 'אין לך חשבון? <a onclick="toggleAuthMode()">הרשמה</a>';
document.getElementById('authErr').textContent = '';
}

async function doAuth() {
const email = document.getElementById('authEmail').value.trim();
const pass = document.getElementById('authPass').value;
const errEl = document.getElementById('authErr');
errEl.textContent = '';
if (!email || pass.length < 8) { errEl.textContent = 'נא להזין אימייל וסיסמה (8 תווים לפחות)'; return; }
const errMap = {
'Invalid login credentials': 'אימייל או סיסמה שגויים',
'User already registered': 'משתמש עם אימייל זה כבר רשום',
'Email not confirmed': 'יש לאמת את האימייל לפני הכניסה',
};
if (signupMode) {
const name = document.getElementById('authName').value.trim();
if (!name) { errEl.textContent = 'נא למלא שם מלא'; return; }
const { error } = await db.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
if (error) { errEl.textContent = errMap[error.message] || error.message; return; }
} else {
const { error } = await db.auth.signInWithPassword({ email, password: pass });
if (error) { errEl.textContent = errMap[error.message] || error.message; return; }
}
const { data } = await db.auth.getSession();
session = data.session;
if (session) await afterLogin();
else errEl.textContent = 'נשלח מייל אימות — אשר אותו והתחבר';
}

async function logout() { await db.auth.signOut(); location.reload(); }

/* ---------- 2. בניית המסך הראשי ---------- */
function buildShell() {
document.querySelectorAll('.paper-name-slot').forEach(el =>
el.textContent = cache.settings.paper_name || '@@PAPER_NAME@@');
// תפריט צד לפי תפקיד
const nav = document.getElementById('sideNav');
let html = '', lastGroup = null;
NAV.filter(n => n.roles.includes(profile.role)).forEach(n => {
if (n.group && n.group !== lastGroup) { html += `<div class="nav-group">${n.group}</div>`; lastGroup = n.group; }
html += `<button id="nav-${n.id}" onclick="openPage('${n.id}')">
<span>${n.icon}</span> ${n.title} <span class="badge hidden" id="badge-${n.id}"></span>
</button>`;
});
nav.innerHTML = html;
document.getElementById('userName').textContent = profile.full_name || session.user.email;
document.getElementById('userRole').textContent = ROLE_NAMES[profile.role];
}

/* ---------- 3. ניתוב ---------- */
async function openPage(id) {
const page = Pages[id];
if (!page) { toast('הדף עדיין לא קיים: ' + id, true); return; }
currentPage = id;
document.querySelectorAll('.sidebar nav button').forEach(b => b.classList.toggle('active', b.id === 'nav-' + id));
const navItem = NAV.find(n => n.id === id);
document.getElementById('pageTitle').textContent = navItem ? navItem.title : page.title || '';
const el = document.getElementById('content');
el.innerHTML = '<div class="empty">טוען...</div>';
try { await page.render(el); }
catch (e) { console.error('שגיאה בדף', id, e); el.innerHTML = `<div class="empty">שגיאה בטעינת הדף — פרטים בקונסולה (F12)</div>`; }
}

/* ---------- 4. דשבורד לפי תפקיד ---------- */
Pages.dash = {
render: async (el) => {
const role = profile.role;
const q = {};
const jobs = [];
const myAgent = cache.agents.find(a => a.profile_id === profile.id);

// הנתונים נטענים לפי מה שהתפקיד רשאי לראות — RLS שומר גם אם ננסה יותר
if (['admin', 'sales'].includes(role)) {
jobs.push(db.from('leads').select('id,name,status,follow_up,agent_id').not('status', 'in', '("won","lost")').then(r => q.leads = r.data || []));
jobs.push(db.from('charges').select('id,amount,status,due_date,customer_id,agent_id').in('status', ['pending', 'invoiced', 'partial', 'overdue']).then(r => q.charges = r.data || []));
jobs.push(db.from('ads').select('id,title,status,customer_id').eq('status', 'received').then(r => q.newAds = r.data || []));
}
if (['admin', 'editor'].includes(role))
jobs.push(db.from('articles').select('id,title,status,deadline').not('status', 'in', '("published")').then(r => q.articles = r.data || []));
jobs.push(db.from('issues').select('*').gte('publish_date', today()).order('publish_date').limit(1).then(r => q.nextIssue = (r.data || [])[0]));
if (role === 'admin')
jobs.push(db.from('attendance').select('id,profile_id').is('clock_out', null).then(r => q.present = r.data || []));
await Promise.all(jobs);

/* --- קוביות מספרים --- */
let stats = '';
if (q.leads) {
const mine = role === 'sales' && myAgent ? q.leads.filter(l => l.agent_id === myAgent.id) : q.leads;
const due = mine.filter(l => l.follow_up && l.follow_up <= today()).length;
stats += stat(mine.length, 'לידים פתוחים' + (due ? ` · <b style="color:var(--danger)">${due} למעקב היום</b>` : ''), due ? 'red' : '');
}
if (q.newAds) stats += stat(q.newAds.length, 'מודעות חדשות ממתינות לניתוב', q.newAds.length ? 'gold' : '');
if (q.charges) {
const open = q.charges.reduce((s, c) => s + Number(c.amount), 0);
stats += stat(money(open), 'חוב פתוח (' + q.charges.length + ' חיובים)');
}
if (q.articles) stats += stat(q.articles.length, 'כתבות בעבודה');
if (q.present) stats += stat(q.present.length, 'נוכחים כעת');

/* --- הגיליון הקרוב --- */
let issueBox = '';
if (q.nextIssue) {
const i = q.nextIssue;
issueBox = `<div class="card card-pad">
<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
<div><b style="font-size:1.05rem">גיליון ${i.issue_number}</b>
<span class="muted"> · חלוקה ${heDate(i.publish_date)} · דדליין מודעות ${heDateTime(i.ads_deadline)}</span></div>
${pill('issue', i.status)}
</div></div>`;
}

/* --- רשימות עבודה --- */
let lists = '<div class="dash-grid">';
if (q.leads) {
const followups = q.leads.filter(l => l.follow_up && l.follow_up <= today()).slice(0, 8);
lists += dashList('לידים למעקב היום', followups.map(l =>
`<li onclick="openPage('leads')" style="cursor:pointer"><span>${esc(l.name)}</span>${pill('lead', l.status)}</li>`), 'אין לידים למעקב 👍');
}
if (q.newAds) {
lists += dashList('מודעות שהתקבלו — לניתוב', q.newAds.slice(0, 8).map(a =>
`<li onclick="openPage('ads')" style="cursor:pointer"><span>${esc(a.title)}</span><span class="muted">${esc(nameOf('customers', a.customer_id))}</span></li>`), 'אין מודעות ממתינות');
}
if (q.articles) {
const late = q.articles.filter(a => a.deadline && a.deadline < today());
lists += dashList('כתבות באיחור', late.slice(0, 8).map(a =>
`<li onclick="openPage('articles')" style="cursor:pointer"><span>${esc(a.title)}</span><span style="color:var(--danger)">${heDate(a.deadline)}</span></li>`), 'אין איחורים 👍');
}
lists += '</div>';

el.innerHTML = `
<div class="page-head"><h2>שלום, ${esc(profile.full_name)} 👋</h2>
<span class="muted">${new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
<div class="stats">${stats}</div>
${issueBox}
<div style="height:18px"></div>
${lists}`;
}
};

function stat(num, label, cls = '') { return `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${label}</div></div>`; }
function dashList(title, items, emptyText) {
return `<div class="card card-pad"><b>${title}</b><ul class="dash-list" style="margin-top:8px">
${items.length ? items.join('') : `<li class="muted">${emptyText}</li>`}</ul></div>`;
}

/* ---------- 5. שעון נוכחות בתפריט ---------- */
async function updateClockButton() {
const btn = document.getElementById('clockBtn');
if (!btn) return;
const { data } = await db.from('attendance').select('id').eq('profile_id', profile.id).is('clock_out', null).limit(1);
const isIn = data && data.length > 0;
btn.textContent = isIn ? '⏹ יציאה' : '▶ כניסה';
btn.classList.toggle('clocked', isIn);
btn.dataset.state = isIn ? 'in' : 'out';
}

async function toggleClock() {
const btn = document.getElementById('clockBtn');
try {
if (btn.dataset.state === 'in') { await run(db.rpc('clock_out')); toast('יציאה נרשמה. יום טוב!'); }
else { await run(db.rpc('clock_in')); toast('כניסה נרשמה. בהצלחה!'); }
await updateClockButton();
} catch (e) { /* הוצג toast */ }
}

/* ---------- 6. חיפוש גלובלי ---------- */
let _searchTimer = null;
function globalSearch(term) {
clearTimeout(_searchTimer);
const box = document.getElementById('searchResults');
if (!term || term.length < 2) { box.classList.add('hidden'); return; }
_searchTimer = setTimeout(async () => {
const like = `%${term}%`;
const [leads, customers, ads, articles] = await Promise.all([
['admin', 'sales'].includes(profile.role) ? db.from('leads').select('id,name,phone').or(`name.ilike.${like},phone.ilike.${like}`).limit(5) : { data: [] },
db.from('customers').select('id,name,phone').or(`name.ilike.${like},phone.ilike.${like}`).limit(5),
db.from('ads').select('id,title').ilike('title', like).limit(5),
['admin', 'editor'].includes(profile.role) ? db.from('articles').select('id,title').ilike('title', like).limit(5) : { data: [] },
]);
const items = [
...(leads.data || []).map(r => ({ kind: 'ליד', label: r.name + (r.phone ? ' · ' + r.phone : ''), page: 'leads' })),
...(customers.data || []).map(r => ({ kind: 'לקוח', label: r.name, page: 'customers', id: r.id })),
...(ads.data || []).map(r => ({ kind: 'מודעה', label: r.title, page: 'ads' })),
...(articles.data || []).map(r => ({ kind: 'כתבה', label: r.title, page: 'articles' })),
];
box.innerHTML = items.length
? items.map(i => `<div class="sr-item" onclick="searchGo('${i.page}',${i.id || 'null'})">
<div class="sr-kind">${i.kind}</div>${esc(i.label)}</div>`).join('')
: '<div class="sr-item muted">לא נמצא</div>';
box.classList.remove('hidden');
}, 300);
}

function searchGo(page, id) {
document.getElementById('searchResults').classList.add('hidden');
document.getElementById('searchInput').value = '';
if (page === 'customers' && id) { openPage('customers').then(() => window.openCustomerCard && openCustomerCard(id)); }
else openPage(page);
}

document.addEventListener('click', ev => {
if (!ev.target.closest('.search-wrap')) {
const box = document.getElementById('searchResults');
if (box) box.classList.add('hidden');
}
});

/* התחלה */
window.addEventListener('DOMContentLoaded', boot);
