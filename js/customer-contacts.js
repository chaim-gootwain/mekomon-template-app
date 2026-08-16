/* ============================================================
customer-contacts.js — אנשי קשר מרובים ללקוח (פיצ'ר 8)
------------------------------------------------------------
- מערך אנשי קשר בעמודת contacts (jsonb) בטבלת customers
- כל איש קשר: שם · תפקיד · טלפון · וואטסאפ · מייל · ראשי
- ניהול מתוך כרטיס הלקוח (טאב "אנשי קשר")
דורש עמודה: alter table customers add column contacts jsonb default '[]';
============================================================ */
'use strict';

function _custContacts(c) { return Array.isArray(c && c.contacts) ? c.contacts : []; }

/* תצוגת רשימת אנשי הקשר בכרטיס */
function custContactsRender(c) {
  const list = _custContacts(c);
  const canWrite = ['admin', 'sales'].includes(profile.role);
  const rows = list.map((ct, i) => {
    const phone = ct.phone || '';
    const wa = ct.whatsapp || ct.phone || '';
    return `<div style="border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:10px 12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <b>${esc(ct.name) || '—'}${ct.primary ? ' <span class="ctag" style="background:#dcfce7;color:#166534;border-color:#bbf7d0">ראשי</span>' : ''}</b>
        <span style="display:flex;gap:6px;flex-wrap:wrap">
          ${phone ? phoneBtn(phone) : ''}
          ${wa ? `<a class="btn btn-sm btn-ghost" target="_blank" rel="noopener" href="https://wa.me/${_ccIntl(wa)}">💬</a>` : ''}
          ${canWrite ? `<button class="btn btn-sm btn-ghost" onclick="custContactEdit(${c.id},${i})">✎</button>
          ${ct.primary ? '' : `<button class="btn btn-sm btn-ghost" title="הפוך לראשי" onclick="custContactPrimary(${c.id},${i})">⭐</button>`}
          <button class="btn btn-sm btn-danger-ghost" onclick="custContactRemove(${c.id},${i})">🗑</button>` : ''}
        </span>
      </div>
      <div style="font-size:.82rem;color:#475569;margin-top:4px;display:flex;gap:14px;flex-wrap:wrap">
        ${ct.role ? `<span>${esc(ct.role)}</span>` : ''}
        ${phone ? `<span dir="ltr">📞 ${esc(phone)}</span>` : ''}
        ${ct.email ? `<span dir="ltr">✉ ${esc(ct.email)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  return `${list.length ? rows : '<p class="muted">אין אנשי קשר נוספים</p>'}
    ${canWrite ? `<button class="btn btn-sm" onclick="custContactAdd(${c.id})">+ איש קשר</button>` : ''}`;
}

const _CONTACT_FIELDS = [
  { name: 'name', label: 'שם', required: true },
  { name: 'role', label: 'תפקיד' },
  { name: 'phone', label: 'טלפון', dir: 'ltr' },
  { name: 'whatsapp', label: 'וואטסאפ (אם שונה)', dir: 'ltr' },
  { name: 'email', label: 'מייל', dir: 'ltr' },
  { name: 'primary', label: 'איש קשר ראשי', type: 'checkbox' },
];

async function _custSaveContacts(id, contacts) {
  await run(db.from('customers').update({ contacts }).eq('id', id));
  const cc = (_customers || []).find(x => x.id === id); if (cc) cc.contacts = contacts;
  openCustomerCard(id);
}

function custContactAdd(id) {
  const c = (_customers || []).find(x => x.id === id);
  openForm('איש קשר חדש', _CONTACT_FIELDS, {}, async (rec) => {
    const list = _custContacts(c).slice();
    if (rec.primary) list.forEach(x => x.primary = false);
    list.push({ name: (rec.name || '').trim(), role: rec.role || '', phone: rec.phone || '', whatsapp: rec.whatsapp || '', email: rec.email || '', primary: !!rec.primary });
    await _custSaveContacts(id, list);
    toast('✓ איש קשר נוסף');
  });
}

function custContactEdit(id, idx) {
  const c = (_customers || []).find(x => x.id === id);
  const list = _custContacts(c).slice();
  const cur = list[idx]; if (!cur) return;
  openForm('עריכת איש קשר', _CONTACT_FIELDS, cur, async (rec) => {
    if (rec.primary) list.forEach(x => x.primary = false);
    list[idx] = { name: (rec.name || '').trim(), role: rec.role || '', phone: rec.phone || '', whatsapp: rec.whatsapp || '', email: rec.email || '', primary: !!rec.primary };
    await _custSaveContacts(id, list);
    toast('✓ עודכן');
  });
}

async function custContactPrimary(id, idx) {
  const c = (_customers || []).find(x => x.id === id);
  const list = _custContacts(c).slice();
  list.forEach((x, i) => x.primary = (i === idx));
  await _custSaveContacts(id, list);
  toast('✓ סומן כראשי');
}

async function custContactRemove(id, idx) {
  if (!confirm('להסיר את איש הקשר?')) return;
  const c = (_customers || []).find(x => x.id === id);
  const list = _custContacts(c).slice();
  list.splice(idx, 1);
  await _custSaveContacts(id, list);
  toast('הוסר');
}
