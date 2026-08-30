/* ============================================================
graphics-proof.js — תור גרפיקה + פרוף ואישורים
------------------------------------------------------------
זרימה: בגרפיקה → פרוף מוכן (מייל אוטומטי ללקוח, ר' proofSendCustomerEmail)
→ אישור הנהלה ‖ אישור לקוח (מקביל, הלקוח דרך portal/../approve/) →
כששניהם קיימים → עוברת לוועדה (committee) → שיבוץ.
בקשת תיקון (מהלקוח או מהצוות) — ללא הגבלת סבבים, חוזרת ל-in_graphics.
דף האישור הציבורי ללקוח: approve/index.html (טוקן, RPCs proof_by_token/proof_customer_decision).
proofCustApproveManual נשאר כגיבוי ידני (למשל אישור בטלפון).
============================================================ */

'use strict';

let _gfxQueue = [];

function _gfxDeadlineCell(iss) {
if (!iss || !iss.ads_deadline) return '<span class="muted">—</span>';
const past = new Date(iss.ads_deadline).getTime() < Date.now();
return `<span style="${past ? 'color:#b91c1c;font-weight:700' : ''}">${heDateTime(iss.ads_deadline)}${past ? ' ❗' : ''}</span>`;
}

async function gfxQueueRender(el) {
const queue = await loadAds(['in_graphics']);
_ads = queue; _gfxQueue = queue;
const ids = queue.map(a => a.id);
const issIds = [...new Set(queue.map(a => a.issue_id).filter(Boolean))];
const [issRows, srcFiles] = await Promise.all([
issIds.length ? run(db.from('issues').select('id,issue_number,ads_deadline').in('id', issIds)) : [],
ids.length ? run(db.from('ad_files').select('ad_id,storage_path,file_name,kind').in('ad_id', ids)) : [],
]);
const issMap = {}; issRows.forEach(i => issMap[i.id] = i);
const srcMap = {}; srcFiles.forEach(f => { if (f.kind === 'source' && !srcMap[f.ad_id]) srcMap[f.ad_id] = f; });

// מיון: לפי queue_order (ריק בסוף), ואז לפי ותק בתור
queue.sort((a, b) => {
const ao = a.queue_order == null ? 1e9 : a.queue_order, bo = b.queue_order == null ? 1e9 : b.queue_order;
return ao - bo || String(a.created_at).localeCompare(String(b.created_at));
});
_gfxQueue = queue;

el.innerHTML = `
<div class="page-head"><h2>תור גרפיקה <span class="muted">(${queue.length})</span></h2>
<button class="btn btn-ghost btn-sm" onclick="gfxBoardRender(document.getElementById('content'))">🗂 לוח עומסים</button></div>
<p class="muted" style="font-size:.82rem;margin-top:-8px">גרור עם ▲▼ לקביעת קדימות · דדליין אדום = עבר (מתריע, לא חוסם)</p>
<div class="card" id="gfxTable"></div>`;

renderTable(document.getElementById('gfxTable'), queue, [
{ h: '#', f: (r, i) => `<div style="display:flex;flex-direction:column;gap:1px">
<button class="btn btn-sm btn-ghost" style="padding:1px 6px" onclick="event.stopPropagation();gfxMove(${r.id},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
<button class="btn btn-sm btn-ghost" style="padding:1px 6px" onclick="event.stopPropagation();gfxMove(${r.id},1)" ${i === queue.length - 1 ? 'disabled' : ''}>▼</button>
</div>` },
{ h: 'מודעה', f: r => `<b>${esc(r.title)}</b>${r.revision_note ? ' <span class="pill amber">בתיקון' + (r.proof_round ? ' · סבב ' + (r.proof_round + 1) : '') + '</span>' : ''}` },
{ h: 'לקוח', f: r => esc(nameOf('customers', r.customer_id)) },
{ h: 'גודל', f: r => esc(nameOf('priceList', r.price_item_id)) },
{ h: 'גיליון', f: r => r.issue_id && issMap[r.issue_id] ? 'גיליון ' + issMap[r.issue_id].issue_number : '<span class="muted">טרם</span>' },
{ h: 'דדליין', f: r => _gfxDeadlineCell(issMap[r.issue_id]) },
{ h: 'מקור', f: r => srcMap[r.id] ? `<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();adFileOpen('${esc(srcMap[r.id].storage_path)}')">📎 מקור</button>` : '<span class="muted">—</span>' },
{ h: 'הנחיה', f: r => esc(r.revision_note || r.graphics_note) || '—' },
{ h: '', f: r => `<button class="btn btn-sm" style="background:var(--ok)" onclick="event.stopPropagation();proofReady(${r.id})">✓ פרוף מוכן</button>` },
], { onRow: r => openAdCard(r.id), empty: 'התור ריק — כל הכבוד! 🎉' });
}

/* שינוי קדימות ידני — מספור מחדש ושמירה */
async function gfxMove(id, dir) {
const arr = _gfxQueue.slice();
const idx = arr.findIndex(a => a.id === id);
const j = idx + dir;
if (idx < 0 || j < 0 || j >= arr.length) return;
const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
// מספור סדרתי חדש לכל התור
for (let k = 0; k < arr.length; k++) { arr[k].queue_order = k; }
try {
await Promise.all(arr.map(a => db.from('ads').update({ queue_order: a.queue_order }).eq('id', a.id)));
} catch (e) {}
_gfxQueue = arr;
openPage('graphics');
}

/* הגרפיקאית סיימה — פרוף מוכן (דורש קובץ עיצוב) — שולח אוטומטית מייל אישור ללקוח */
async function proofReady(id) {
const designs = await run(db.from('ad_files').select('id').eq('ad_id', id).eq('kind', 'design').limit(1));
if (!designs.length) { toast('העלה קודם את קובץ העיצוב בכרטיס המודעה', true); return; }
const a = _ads.find(x => x.id === id) || await run(db.from('ads').select('*').eq('id', id).single());
const round = (Number(a.proof_round) || 0) + 1;
await run(db.from('ads').update({ status: 'proof', proof_round: round, proof_mgmt_at: null, proof_mgmt_by: null, proof_cust_at: null, revision_note: null }).eq('id', id));
await addInteraction('ad', id, 'פרוף מוכן (סבב ' + round + ') — ממתין לאישור הנהלה ולקוח');
const sent = await proofSendCustomerEmail(id, { ...a, proof_round: round });
toast(sent ? '✓ הפרוף סומן כמוכן — מייל אישור נשלח ללקוח' : 'הפרוף סומן כמוכן — ממתין לאישורים (המייל לא נשלח, ר\' פרטים)');
document.getElementById('viewBack')?.classList.remove('open');
openPage(currentPage === 'graphics' ? 'graphics' : currentPage);
}

async function _proofFinalizeIfReady(id) {
const a = await run(db.from('ads').select('proof_mgmt_at,proof_cust_at,status').eq('id', id).single());
if (a.status === 'proof' && a.proof_mgmt_at && a.proof_cust_at) {
await run(db.from('ads').update({ status: 'committee' }).eq('id', id));
await addInteraction('ad', id, '✓ אושר סופית (הנהלה + לקוח) — הועבר לוועדה');
return true;
}
return false;
}

async function proofMgmtApprove(id) {
await run(db.from('ads').update({ proof_mgmt_by: profile.id, proof_mgmt_at: new Date().toISOString() }).eq('id', id));
await addInteraction('ad', id, 'אישור הנהלה — ' + (profile.full_name || ''));
const done = await _proofFinalizeIfReady(id);
toast(done ? 'אושר סופית — עבר לוועדה' : 'אישור הנהלה נרשם — ממתין ללקוח');
document.getElementById('viewBack')?.classList.remove('open');
openPage(currentPage);
}

/* אישור לקוח ידני — גיבוי לצוות (למשל אישור בטלפון); בפועל הלקוח מאשר בעצמו דרך approve/ */
async function proofCustApproveManual(id) {
if (!confirm('לסמן שהלקוח אישר את הפרוף? (לשימוש כשהלקוח אישר בטלפון/בעל-פה ולא דרך הקישור)')) return;
await run(db.from('ads').update({ proof_cust_at: new Date().toISOString() }).eq('id', id));
await addInteraction('ad', id, 'הלקוח אישר את הפרוף (סומן ידנית ע"י ' + (profile.full_name || '') + ')');
const done = await _proofFinalizeIfReady(id);
toast(done ? 'אושר סופית — עבר לוועדה' : 'אישור לקוח נרשם — ממתין להנהלה');
document.getElementById('viewBack')?.classList.remove('open');
openPage(currentPage);
}

/* --- שליחת מייל אוטומטית ללקוח כשהפרוף מוכן (ותמיכה בשליחה חוזרת ידנית) --- */
async function _proofDesignSignedUrl(id) {
try {
const files = await run(db.from('ad_files').select('storage_path').eq('ad_id', id).eq('kind', 'design').order('created_at', { ascending: false }).limit(1));
if (!files.length) return null;
const { data, error } = await db.storage.from('ad-files').createSignedUrl(files[0].storage_path, 60 * 60 * 24 * 7);
if (error || !data) return null;
return data.signedUrl;
} catch (e) { return null; }
}

async function proofSendCustomerEmail(id, a) {
a = a || _ads.find(x => x.id === id) || await run(db.from('ads').select('*').eq('id', id).single());
let cust = (cache.customers || []).find(c => c.id === a.customer_id);
if (!cust || !cust.email) { try { cust = await run(db.from('customers').select('id,name,email').eq('id', a.customer_id).single()); } catch (e) { } }
if (!cust || !cust.email) { toast('ללקוח אין כתובת מייל — אפשר לשלוח לו את הקישור בוואטסאפ', true); return false; }
const url = _proofApproveUrl(a.proof_token);
const issue = nameOf('issues', a.issue_id, 'issue');
const imgUrl = await _proofDesignSignedUrl(id);
const text = 'שלום ' + (cust.name || '') + ',\n\nמצורף העיצוב לאישור עבור המודעה שלך' + (issue ? ' בגיליון ' + issue : '') + '.\nלצפייה ואישור מהיר: ' + url;
const html = `<div dir="rtl" style="font-family:Arial,Heebo,sans-serif;max-width:480px;margin:0 auto;color:#1c2438">
<p>שלום ${esc(cust.name || '')},</p>
<p>מצורף העיצוב לאישור עבור המודעה שלך${issue ? ' בגיליון <b>' + esc(issue) + '</b>' : ''}. נא לבדוק ולאשר, או לבקש תיקון.</p>
${imgUrl ? `<img src="${imgUrl}" alt="עיצוב המודעה" style="max-width:100%;border:1px solid #dfe2f0;border-radius:8px;margin:12px 0">` : ''}
<p style="text-align:center;margin:22px 0">
<a href="${url}" style="background:#1e7e34;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;display:inline-block">✓ לצפייה ואישור העיצוב</a>
</p>
<p style="font-size:.8rem;color:#64748b">אם הכפתור לא עובד, אפשר להעתיק את הקישור: ${url}</p>
</div>`;
try {
const { error } = await db.functions.invoke('send-email', { body: { to: cust.email, subject: 'אישור עיצוב מודעה', body: text, html, customer_id: cust.id } });
if (error) throw error;
await addInteraction('ad', id, '📧 נשלח מייל אישור עיצוב ל-' + cust.email);
return true;
} catch (e) {
console.error('proof email', e);
let msg = ''; try { if (e && e.context && e.context.json) { const j = await e.context.json(); msg = j.detail || j.error || ''; } } catch (e2) { }
await addInteraction('ad', id, '⚠️ שליחת מייל אישור עיצוב נכשלה' + (msg ? ' — ' + msg : ''));
return false;
}
}

async function proofRequestRevision(id) {
const note = prompt('מה צריך לתקן? (ההערה תעבור לגרפיקאית)');
if (!note) return;
await run(db.from('ads').update({ status: 'in_graphics', revision_note: note, proof_mgmt_at: null, proof_mgmt_by: null, proof_cust_at: null }).eq('id', id));
await addInteraction('ad', id, 'בקשת תיקון: ' + note);
toast('חזר לגרפיקה עם הערת התיקון');
document.getElementById('viewBack')?.classList.remove('open');
openPage(currentPage);
}

function _proofApproverName(pid) {
if (!pid) return '';
const ag = (cache.agents || []).find(a => a.profile_id === pid);
return ag ? ag.name : '';
}

function _proofApproveUrl(token) {
const base = location.href.replace(/index\.html.*$/, '').replace(/\/$/, '');
return base + '/approve/?t=' + (token || '');
}
function _proofSendLinks(a) {
const url = _proofApproveUrl(a.proof_token);
const cust = (cache.customers || []).find(c => c.id === a.customer_id);
const issue = nameOf('issues', a.issue_id, 'issue');
const txt = 'שלום, מצורף לאישור העיצוב של המודעה' + (issue ? ' לגיליון ' + issue : '') + '. לצפייה ואישור מהיר: ' + url;
let wa = '';
if (cust && cust.phone) { let ph = String(cust.phone).replace(/\D/g, ''); if (ph.startsWith('0')) ph = '972' + ph.slice(1); wa = `<a class="btn btn-sm" style="background:#25d366;color:#fff" target="_blank" rel="noopener" href="https://wa.me/${ph}?text=${encodeURIComponent(txt)}">💬 שלח לאישור בוואטסאפ</a>`; }
let mail = '';
if (cust && cust.email) { mail = `<a class="btn btn-sm btn-ghost" href="mailto:${cust.email}?subject=${encodeURIComponent('אישור עיצוב — @@PAPER_NAME@@')}&body=${encodeURIComponent(txt)}">✉️ שלח במייל</a>`; }
const copy = `<button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText('${url}').then(()=>toast('הקישור הועתק'))">🔗 העתק קישור</button>`;
return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">${wa}${mail}${copy}</div><p class="muted" style="font-size:.74rem">שלח ללקוח את העיצוב (תמונה) יחד עם הקישור לאישור.</p>`;
}

/* בלוק פרוף בכרטיס המודעה */
function proofCardBlock(a) {
if (!['admin', 'sales'].includes(profile.role)) return '';
if (a.status !== 'proof') return '';
const mgmt = !!a.proof_mgmt_at, cust = !!a.proof_cust_at;
const chip = ok => ok ? '<span class="pill green">✓ אושר</span>' : '<span class="pill amber">ממתין</span>';
return `<div class="card card-pad" style="margin:12px 0;border-right:4px solid var(--brand)">
<b>פרוף — סבב ${a.proof_round || 1}</b>
<div style="display:flex;gap:18px;flex-wrap:wrap;margin:8px 0;font-size:.9rem">
<span>אישור הנהלה: ${chip(mgmt)}${mgmt ? ' <span class="muted">(' + esc(_proofApproverName(a.proof_mgmt_by)) + ')</span>' : ''}</span>
<span>אישור לקוח: ${chip(cust)}</span>
</div>
${!cust ? _proofSendLinks(a) : ''}
<div class="m-actions" style="flex-wrap:wrap;margin-top:4px">
${!mgmt ? `<button class="btn btn-sm" style="background:var(--ok)" onclick="proofMgmtApprove(${a.id})">✓ אישור הנהלה</button>` : ''}
${!cust ? `<button class="btn btn-sm btn-ghost" onclick="proofCustApproveManual(${a.id})">👤 סמן ידנית: הלקוח אישר</button>` : ''}
${!cust ? `<button class="btn btn-sm btn-ghost" onclick="proofSendCustomerEmail(${a.id}).then(ok=>toast(ok?'✓ מייל נשלח מחדש':'שליחת המייל נכשלה', !ok))">📧 שלח שוב מייל ללקוח</button>` : ''}
<button class="btn btn-sm btn-danger-ghost" onclick="proofRequestRevision(${a.id})">✎ בקשת תיקון</button>
</div>
<p class="muted" style="font-size:.76rem;margin-top:6px">כששני האישורים יתקבלו — המודעה תעבור אוטומטית לוועדה.</p>
</div>`;
}

/* ============================================================
   לוח עומסים לגרפיקה (פיצ'ר #19) — קנבן קריאה-בלבד
   ------------------------------------------------------------
   שלוש עמודות: 🔥 דחוף (בעבודה + דדליין עבר/קרוב) · 🎨 בעבודה ·
   👀 ממתין לאישור (פרוף — עם חיווי מי מעכב: לקוח / הנהלה).
   לחיצה על כרטיס פותחת את כרטיס המודעה. מעבר חזרה לתצוגת התור.
   ============================================================ */

async function gfxBoardRender(el) {
  el.innerHTML = '<div class="empty">טוען את הלוח...</div>';
  const open = await loadAds(['in_graphics', 'proof']);
  _ads = open;
  const issIds = [...new Set(open.map(a => a.issue_id).filter(Boolean))];
  const issRows = issIds.length ? await run(db.from('issues').select('id,issue_number,ads_deadline').in('id', issIds)) : [];
  const issMap = {}; issRows.forEach(i => issMap[i.id] = i);

  const now = Date.now(), soon = now + 48 * 3600 * 1000;
  const urgency = a => {
    const iss = issMap[a.issue_id];
    if (!iss || !iss.ads_deadline) return 0;
    const t = new Date(iss.ads_deadline).getTime();
    if (isNaN(t)) return 0;
    return t < now ? 2 : (t <= soon ? 1 : 0);
  };
  const daysIn = a => Math.max(0, Math.floor((now - (Date.parse(a.updated_at || a.created_at) || now)) / 86400000));

  const cols = [
    { key: 'urgent', title: '🔥 דחוף', hint: 'בעבודה ודדליין המודעות עבר או בתוך 48 שעות', color: '#b91c1c', items: [] },
    { key: 'working', title: '🎨 בעבודה', hint: 'בתור הגרפיקה, בלי לחץ דדליין', color: '@@COLOR_BRAND@@', items: [] },
    { key: 'waiting', title: '👀 ממתין לאישור', hint: 'פרוף נשלח — מי שמסומן ⏳ מעכב', color: '#a16207', items: [] },
  ];
  open.forEach(a => {
    if (a.status === 'proof') cols[2].items.push(a);
    else if (urgency(a) > 0) cols[0].items.push(a);
    else cols[1].items.push(a);
  });
  cols[0].items.sort((a, b) => urgency(b) - urgency(a));
  cols[2].items.sort((a, b) => String(a.updated_at || a.created_at).localeCompare(String(b.updated_at || b.created_at)));

  const cardHtml = a => {
    const iss = issMap[a.issue_id];
    const u = urgency(a);
    const dl = iss && iss.ads_deadline ? `<div style="font-size:.74rem;color:${u === 2 ? '#b91c1c' : u === 1 ? '#a16207' : 'var(--muted,#6b7280)'}">${u === 2 ? '❗ עבר: ' : '⏰ '}${heDateTime(iss.ads_deadline)}</div>` : '';
    const approvals = a.status === 'proof'
      ? `<div style="display:flex;gap:6px;margin-top:4px">
          <span class="pill ${a.proof_cust_at ? 'green' : 'amber'}" style="font-size:.68rem">${a.proof_cust_at ? '✓ לקוח' : '⏳ לקוח'}</span>
          <span class="pill ${a.proof_mgmt_at ? 'green' : 'amber'}" style="font-size:.68rem">${a.proof_mgmt_at ? '✓ הנהלה' : '⏳ הנהלה'}</span>
          ${a.proof_round > 1 ? `<span class="pill" style="font-size:.68rem">סבב ${a.proof_round}</span>` : ''}
        </div>` : (a.revision_note ? '<span class="pill amber" style="font-size:.68rem">בתיקון</span>' : '');
    return `<div onclick="openAdCard(${a.id})" style="background:var(--card,#fff);border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:9px 11px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.05)">
      <b style="font-size:.88rem">${esc(a.title || 'מודעה')}</b>
      <div style="font-size:.78rem;color:var(--muted,#6b7280)">${esc(nameOf('customers', a.customer_id))}${iss ? ' · גיליון ' + iss.issue_number : ''}</div>
      ${dl}${approvals}
      <div style="font-size:.7rem;color:var(--muted,#9ca3af);margin-top:3px">${daysIn(a)} ימים בסטטוס</div>
    </div>`;
  };

  el.innerHTML = `
<div class="page-head"><h2>לוח עומסים — גרפיקה <span class="muted">(${open.length})</span></h2>
<button class="btn btn-ghost btn-sm" onclick="openPage('graphics')">📋 חזרה לתור</button></div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;align-items:start">
${cols.map(c => `<div style="background:#f4f6fb;border-radius:12px;padding:10px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
    <b style="color:${c.color}">${c.title}</b><span class="pill">${c.items.length}</span>
  </div>
  <div class="muted" style="font-size:.72rem;margin-bottom:8px">${c.hint}</div>
  <div style="display:flex;flex-direction:column;gap:8px">
    ${c.items.map(cardHtml).join('') || '<div class="muted" style="font-size:.8rem;text-align:center;padding:12px">ריק 👍</div>'}
  </div>
</div>`).join('')}
</div>`;
}
