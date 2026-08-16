/* ============================================================
articles.js — תוכן וכתבות (מנהל + עורך)
------------------------------------------------------------
- רשימת כתבות עם סינון לפי גיליון/מדור/סטטוס
- "המשימות שלי" לכותבים, איחורים מודגשים
- ניהול מדורים
============================================================ */

'use strict';

let _articles = [];

Pages.articles = {
render: async (el) => {
_articles = await run(db.from('articles').select('*').order('created_at', { ascending: false }).limit(300));
el.innerHTML = `
<div class="page-head">
<h2>תוכן וכתבות</h2>
<div class="actions">
<button class="btn btn-ghost btn-sm" onclick="sectionsManage()">ניהול מדורים</button>
<button class="btn" onclick="articleAdd()">+ כתבה חדשה</button>
</div>
</div>
<div class="filter-bar">
<input id="artSearch" placeholder="חיפוש..." oninput="articlesDraw()" style="min-width:180px">
<select id="artIssue" onchange="articlesDraw()">
<option value="">כל הגיליונות</option>
${cache.issues.map(i => `<option value="${i.id}">גיליון ${i.issue_number}</option>`).join('')}
</select>
<select id="artSection" onchange="articlesDraw()">
<option value="">כל המדורים</option>
${cache.sections.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
</select>
<select id="artStatus" onchange="articlesDraw()">
<option value="open">בעבודה</option>
<option value="">הכל</option>
${Object.entries(STATUS.article).map(([v, t]) => `<option value="${v}">${t[0]}</option>`).join('')}
</select>
</div>
<div class="card" id="artTable"></div>`;
articlesDraw();
}
};

function articlesDraw() {
const term = (document.getElementById('artSearch')?.value || '').trim();
const issue = document.getElementById('artIssue')?.value || '';
const section = document.getElementById('artSection')?.value || '';
const status = document.getElementById('artStatus')?.value ?? 'open';
const rows = _articles.filter(a =>
(status === '' || (status === 'open' ? a.status !== 'published' : a.status === status)) &&
(!issue || a.issue_id === Number(issue)) &&
(!section || a.section_id === Number(section)) &&
(!term || [a.title, a.author_name, a.editor_notes].some(v => (v || '').includes(term))));

renderTable(document.getElementById('artTable'), rows, [
{ h: 'כותרת', f: r => `<b>${esc(r.title)}</b>` },
{ h: 'כותב', f: r => esc(r.author_name) || esc((cache.profiles.find(p => p.id === r.author_profile_id) || {}).full_name) || '—' },
{ h: 'מדור', f: r => esc(nameOf('sections', r.section_id)) },
{ h: 'גיליון', f: r => esc(nameOf('issues', r.issue_id, 'issue')) || '—' },
{ h: 'דדליין', f: r => r.deadline && r.deadline < today() && r.status !== 'published'
? `<span class="pill red">${heDate(r.deadline)}</span>` : heDate(r.deadline) },
{ h: 'סטטוס', f: r => pill('article', r.status) },
], { onRow: r => articleEdit(r.id), empty: 'אין כתבות' });
}

const ARTICLE_FIELDS = () => [
{ name: 'title', label: 'כותרת', required: true },
{ name: 'author_profile_id', label: 'כותב (משתמש מערכת)', type: 'select',
options: cache.profiles.filter(p => p.active).map(p => ({ v: p.id, t: p.full_name })) },
{ name: 'author_name', label: 'או כותב חיצוני (שם חופשי)' },
{ name: 'section_id', label: 'מדור', type: 'select', options: 'sections' },
{ name: 'issue_id', label: 'גיליון יעד', type: 'select', options: 'issues' },
{ name: 'deadline', label: 'דדליין', type: 'date' },
{ name: 'est_length', label: 'אורך משוער (מילים/עמוד)' },
{ name: 'status', label: 'סטטוס', type: 'select', required: true, default: 'idea',
options: Object.entries(STATUS.article).map(([v, t]) => ({ v, t: t[0] })) },
{ name: 'file_url', label: 'קישור לקובץ הכתבה', dir: 'ltr' },
{ name: 'editor_notes', label: 'הערות עורך', type: 'textarea' },
];

function articleAdd() {
openForm('כתבה חדשה', ARTICLE_FIELDS(), {}, async (rec) => {
await run(db.from('articles').insert(rec));
toast('הכתבה נוספה');
openPage('articles');
});
}

function articleEdit(id) {
const a = _articles.find(x => x.id === id);
openForm('עריכת כתבה — ' + a.title, ARTICLE_FIELDS(), a, async (rec) => {
await run(db.from('articles').update(rec).eq('id', id));
toast('נשמר');
openPage('articles');
});
}

/* --- ניהול מדורים --- */
async function sectionsManage() {
const sections = await run(db.from('sections').select('*').order('sort'));
document.getElementById('viewModal').innerHTML = `
<h3>ניהול מדורים</h3>
<table class="data"><thead><tr><th>מדור</th><th>סדר</th><th>פעיל</th></tr></thead><tbody>
${sections.map(s => `<tr>
<td>${esc(s.name)}</td><td>${s.sort}</td>
<td>${s.active ? '<span class="pill green">כן</span>' : '<span class="pill">לא</span>'}</td>
</tr>`).join('')}
</tbody></table>
<div class="m-actions">
<button class="btn btn-sm" onclick="sectionAdd()">+ מדור חדש</button>
<button class="btn btn-sm btn-ghost" style="margin-right:auto"
onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
</div>`;
document.getElementById('viewBack').classList.add('open');
}

function sectionAdd() {
document.getElementById('viewBack').classList.remove('open');
openForm('מדור חדש', [
{ name: 'name', label: 'שם המדור', required: true },
{ name: 'sort', label: 'מיקום בסדר', type: 'number', default: 10 },
], {}, async (rec) => {
await run(db.from('sections').insert(rec));
await refreshCache();
toast('המדור נוסף');
sectionsManage();
});
}
