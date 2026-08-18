/* ============================================================
agents.js — מודול סוכנים (מנהל בלבד)
------------------------------------------------------------
- סוכן פנימי (מקושר למשתמש) או חיצוני (רשומה בלבד)
- פרופיל עמלה: % לקוח חדש, % מתחדש, יעד חודשי, בונוס
============================================================ */

'use strict';

let _agents = [];

Pages.agents = {
render: async (el) => {
_agents = await run(db.from('agents').select('*').order('name'));
el.innerHTML = `
<div class="page-head">
<h2>סוכנים ועמלות</h2>
<button class="btn" onclick="agentAdd()">+ סוכן חדש</button>
</div>
<p class="muted" style="margin-bottom:12px;font-size:.85rem">
פיצול העמלה (חיוב/גבייה) מוגדר במסך ההגדרות — כרגע:
${cache.settings.commission_split_billing || 50}% בחיוב,
${100 - Number(cache.settings.commission_split_billing || 50)}% בגבייה.
תקופת "לקוח חדש": ${cache.settings.new_customer_months || 3} חודשים.
</p>
<div class="card" id="agentsTable"></div>`;
renderTable(document.getElementById('agentsTable'), _agents, [
{ h: 'שם', f: r => `<b>${esc(r.name)}</b>` + (r.profile_id ? '' : ' <span class="pill">חיצוני</span>') + (r.active ? '' : ' <span class="pill red">לא פעיל</span>') },
{ h: 'טלפון', f: r => `<span dir="ltr">${esc(r.phone)}</span>` },
{ h: '% לקוח חדש', f: r => r.pct_new + '%' },
{ h: '% מתחדש', f: r => r.pct_renew + '%' },
{ h: 'יעד חודשי', f: r => money(r.monthly_target) || '—' },
{ h: 'בונוס', f: r => r.bonus_type === 'none' ? '—' : (r.bonus_type === 'fixed' ? money(r.bonus_value) : r.bonus_value + '%') },
], { onRow: r => agentEdit(r.id), empty: 'אין סוכנים עדיין — הוסף את הראשון' });
}
};

const AGENT_FIELDS = () => [
{ name: 'name', label: 'שם הסוכן', required: true },
{ name: 'profile_id', label: 'משתמש מערכת (ריק = סוכן חיצוני)', type: 'select',
options: cache.profiles.filter(p => ['admin', 'sales'].includes(p.role)).map(p => ({ v: p.id, t: p.full_name })) },
{ name: 'phone', label: 'טלפון', dir: 'ltr' },
{ name: 'voicenter_ext', label: 'שלוחה (Voicenter)', dir: 'ltr' },
{ name: 'email', label: 'אימייל', dir: 'ltr' },
{ name: 'payment_details', label: 'פרטי תשלום (לסוכן חיצוני)' },
{ name: 'pct_new', label: '% עמלה — לקוח חדש', type: 'number', required: true, default: 15 },
{ name: 'pct_renew', label: '% עמלה — לקוח מתחדש', type: 'number', required: true, default: 7 },
{ name: 'monthly_target', label: 'יעד מכירות חודשי (₪)', type: 'number' },
{ name: 'bonus_type', label: 'סוג בונוס בעמידה ביעד', type: 'select', required: true, default: 'none',
options: [{ v: 'none', t: 'ללא בונוס' }, { v: 'fixed', t: 'סכום קבוע' }, { v: 'percent', t: 'אחוז תוספת על העמלה' }] },
{ name: 'bonus_value', label: 'ערך הבונוס (₪ או %)', type: 'number' },
{ name: 'active', label: 'פעיל', type: 'checkbox', default: true },
{ name: 'notes', label: 'הערות', type: 'textarea' },
];

function agentAdd() {
openForm('סוכן חדש', AGENT_FIELDS(), {}, async (rec) => {
await run(db.from('agents').insert(rec));
await refreshCache();
toast('הסוכן נוסף');
openPage('agents');
});
}

function agentEdit(id) {
const a = _agents.find(x => x.id === id);
openForm('עריכת סוכן — ' + a.name, AGENT_FIELDS(), a, async (rec) => {
await run(db.from('agents').update(rec).eq('id', id));
if (rec.name && a.profile_id && rec.name !== a.name) { try { await db.from('profiles').update({ full_name: rec.name }).eq('id', a.profile_id); } catch (e) { } }
await refreshCache();
toast('נשמר');
openPage('agents');
});
}
