/* ============================================================
customer-comm.js — תקשורת מובנית עם הלקוח (פיצ'ר 1)
------------------------------------------------------------
- כפתור "✉️ שלח הודעה" בכרטיס הלקוח → מייל (דרך Edge Function send-email)
  או וואטסאפ (קישור wa.me עם הודעה מוכנה).
- תבניות מוכנות (תזכורת תשלום / אישור מודעה / ברכה) עם מילוי שם ויתרה.
- כל שליחה מתועדת אוטומטית בציר הזמן.
============================================================ */

'use strict';

let _commBalance = 0;

function _commCust(id) {
  return (typeof _customers !== 'undefined' && _customers.find(x => x.id === id)) || (cache.customers || []).find(x => x.id === id) || { id, name: '' };
}
function _commIntl(p) { let s = String(p || '').replace(/\D/g, ''); if (s.startsWith('0')) s = '972' + s.slice(1); else if (s && !s.startsWith('972')) s = '972' + s; return s; }
function _commB64(bytes) { let bin = ''; const ch = 0x8000; for (let i = 0; i < bytes.length; i += ch) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + ch)); return btoa(bin); }

/* תבניות — מחזירות {subject, body} עם מילוי */
function _commTemplate(key, c) {
  const name = c.contact_person || c.name || '';
  const bal = (typeof money === 'function') ? money(_commBalance) : ('₪' + _commBalance);
  const T = {
    payment: {
      subject: 'תזכורת תשלום — @@PAPER_NAME@@',
      body: `שלום ${name},\n\nברצוננו להזכיר בנועם כי קיימת יתרה לתשלום בסך ${bal}.\nנשמח להסדרת התשלום בהקדם.\n\nתודה רבה,\nמערכת @@PAPER_NAME@@`,
    },
    ad_ok: {
      subject: 'אישור קליטת מודעה — @@PAPER_NAME@@',
      body: `שלום ${name},\n\nמודעתכם התקבלה אצלנו ותפורסם בגיליון הקרוב.\nתודה שאתם מפרסמים ב@@PAPER_NAME@@!\n\nבברכה,\nמערכת @@PAPER_NAME@@`,
    },
    thanks: {
      subject: 'תודה שאתם איתנו — @@PAPER_NAME@@',
      body: `שלום ${name},\n\nתודה שאתם חלק ממשפחת המפרסמים של @@PAPER_NAME@@.\nנשמח להמשיך ולשרת אתכם.\n\nבברכה,\nמערכת @@PAPER_NAME@@`,
    },
    blank: { subject: '', body: `שלום ${name},\n\n` },
  };
  return T[key] || T.blank;
}

async function commOpen(customerId, channel) {
  channel = channel || 'email';
  const c = _commCust(customerId);
  _commBalance = 0;
  try { if (typeof customerOpenBalance === 'function') { const b = await customerOpenBalance(customerId); _commBalance = (b && b.total) || 0; } } catch (e) { }
  _commRender(customerId, channel, 'blank');
}

function _commRender(customerId, channel, tplKey) {
  const c = _commCust(customerId);
  const tpl = _commTemplate(tplKey || 'blank', c);
  const modal = document.getElementById('viewModal');
  const tplBar = `<div class="field"><label>תבנית</label>
    <select onchange="_commRender(${customerId}, '${channel}', this.value)">
      <option value="blank" ${tplKey === 'blank' ? 'selected' : ''}>— ללא —</option>
      <option value="payment" ${tplKey === 'payment' ? 'selected' : ''}>תזכורת תשלום${_commBalance > 0 ? ' (' + (typeof money === 'function' ? money(_commBalance) : _commBalance) + ')' : ''}</option>
      <option value="ad_ok" ${tplKey === 'ad_ok' ? 'selected' : ''}>אישור קליטת מודעה</option>
      <option value="thanks" ${tplKey === 'thanks' ? 'selected' : ''}>תודה / ברכה</option>
    </select></div>`;
  modal.innerHTML = `
    <h3>📨 שליחת הודעה — ${esc(c.name || '')}</h3>
    <div class="tabs" style="margin:8px 0">
      <button class="${channel === 'email' ? 'active' : ''}" onclick="_commRender(${customerId},'email','${tplKey}')">✉️ מייל</button>
      <button class="${channel === 'whatsapp' ? 'active' : ''}" onclick="_commRender(${customerId},'whatsapp','${tplKey}')">💬 וואטסאפ</button>
    </div>
    ${tplBar}
    ${channel === 'email' ? `
      <div class="field"><label>אל (מייל)</label><input id="commTo" dir="ltr" value="${esc(c.email || '')}"></div>
      <div class="field"><label>נושא</label><input id="commSubj" value="${esc(tpl.subject)}"></div>
      <div class="field"><label>תוכן</label><textarea id="commBody" rows="7">${esc(tpl.body)}</textarea></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:.85rem;margin:4px 0"><input type="checkbox" id="commAttach"> צרף הוכחת פרסום מהגיליון האחרון (אם קיים)</label>
      <div class="m-actions" style="margin-top:10px">
        <button class="btn" onclick="commSendEmail(${customerId})">✉️ שלח מייל</button>
        <button class="btn btn-ghost" onclick="openCustomerCard(${customerId})">סגירה</button>
      </div>
    ` : `
      <div class="field"><label>מספר וואטסאפ</label><input id="commWa" dir="ltr" value="${esc(c.whatsapp || c.phone || '')}"></div>
      <div class="field"><label>הודעה</label><textarea id="commBody" rows="6">${esc(tpl.body)}</textarea></div>
      <div class="m-actions" style="margin-top:10px">
        <button class="btn" onclick="commWhatsApp(${customerId})">💬 פתח וואטסאפ ותעד</button>
        <button class="btn btn-ghost" onclick="openCustomerCard(${customerId})">סגירה</button>
      </div>
      <p class="muted" style="font-size:.8rem">הוואטסאפ ייפתח עם ההודעה מוכנה — לוחצים שלח בוואטסאפ.</p>
    `}`;
  document.getElementById('viewBack').classList.add('open');
}

/* צירוף הוכחת פרסום מהגיליון האחרון של הלקוח (base64) */
async function _commLastProof(customerId) {
  try {
    if (typeof _apBuild !== 'function') return null;
    const ads = await run(db.from('ads').select('issue_id,created_at').eq('customer_id', customerId).not('issue_id', 'is', null).order('created_at', { ascending: false }).limit(1));
    if (!ads.length) return null;
    const r = await _apBuild(ads[0].issue_id, customerId);
    return { filename: `הוכחת_פרסום_גיליון_${r.issueNumber}.pdf`, content: _commB64(r.bytes), contentType: 'application/pdf' };
  } catch (e) { return null; }
}

async function commSendEmail(customerId) {
  const to = (document.getElementById('commTo') || {}).value || '';
  const subject = (document.getElementById('commSubj') || {}).value || '';
  const body = (document.getElementById('commBody') || {}).value || '';
  if (!to) { toast('חסרה כתובת מייל', true); return; }
  if (!subject && !body) { toast('נא למלא נושא או תוכן', true); return; }
  toast('שולח מייל...');
  let attachments = [];
  if ((document.getElementById('commAttach') || {}).checked) { const p = await _commLastProof(customerId); if (p) attachments = [p]; else toast('אין הוכחת פרסום זמינה — נשלח בלי צירוף', true); }
  try {
    const { data, error } = await db.functions.invoke('send-email', { body: { to, subject, body, customer_id: customerId, attachments } });
    if (!error && data && data.ok) {
      try { await addInteraction('customer', customerId, `📧 נשלח מייל: ${subject || '(ללא נושא)'}${attachments.length ? ' + הוכחת פרסום' : ''}`); } catch (e) { }
      toast('✅ המייל נשלח ל' + to);
      openCustomerCard(customerId);
      return;
    }
    let msg = ''; try { if (error && error.context && error.context.json) { const j = await error.context.json(); msg = j.detail || j.error || ''; } } catch (e) { }
    if (!msg && data) msg = data.detail || data.error || '';
    toast('שליחת המייל נכשלה' + (msg ? ' (' + msg + ')' : '') + '. ייתכן שפונקציית המייל עדיין לא נפרסה.', true);
  } catch (e) { toast('שגיאה: ' + (e && e.message || e), true); }
}

async function commWhatsApp(customerId) {
  const num = _commIntl((document.getElementById('commWa') || {}).value || '');
  const body = (document.getElementById('commBody') || {}).value || '';
  if (!num) { toast('חסר מספר וואטסאפ', true); return; }
  const url = 'https://wa.me/' + num + (body ? '?text=' + encodeURIComponent(body) : '');
  window.open(url, '_blank', 'noopener');
  try { await addInteraction('customer', customerId, '💬 נשלחה הודעת וואטסאפ'); } catch (e) { }
  toast('וואטסאפ נפתח — ההודעה תועדה');
}

/* עטיפת openCustomerCard — כפתור "שלח הודעה" */
(function () {
  const orig = window.openCustomerCard;
  if (typeof orig === 'function' && !orig._commWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      try {
        if (['admin', 'sales'].includes(profile.role)) {
          const modal = document.getElementById('viewModal');
          const _menu = document.getElementById('ccMoreMenu');
          if (modal && !document.getElementById('commBtn')) {
            if (_menu) {
              _menu.insertAdjacentHTML('beforeend', `<button id="commBtn" class="btn btn-sm btn-ghost" onclick="commOpen(${id})">📨 שלח הודעה</button>`);
            } else {
              const div = document.createElement('div');
              div.style.cssText = 'margin-top:8px';
              div.innerHTML = `<button id="commBtn" class="btn btn-sm" onclick="commOpen(${id})">📨 שלח הודעה ללקוח</button>`;
              modal.appendChild(div);
            }
          }
        }
      } catch (e) { console.error('comm wrap', e); }
      return r;
    };
    wrapped._commWrapped = true;
    window.openCustomerCard = wrapped;
  }
})();
