/* ============================================================
   graphics-proof.js — שלב א': תור גרפיקה משודרג + פרוף ואישורים (פנימי)
   ------------------------------------------------------------
   זרימה: בגרפיקה → פרוף מוכן → אישור הנהלה ‖ אישור לקוח (מקביל)
           → בקשת תיקון (ללא הגבלה) → מאושרת (מוכן לשיבוץ)
   אישור הלקוח כאן ידני-זמני (הנציג מסמן); דף האישור החיצוני = שלב ב'.
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
    <div class="page-head"><h2>תור גרפיקה <span class="muted">(${queue.length})</span></h2></div>
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

/* הגרפיקאית סיימה — פרוף מוכן (דורש קובץ עיצוב) */
async function proofReady(id) {
  const designs = await run(db.from('ad_files').select('id').eq('ad_id', id).eq('kind', 'design').limit(1));
  if (!designs.length) { toast('העלה קודם את קובץ העיצוב בכרטיס המודעה', true); return; }
  const a = _ads.find(x => x.id === id) || await run(db.from('ads').select('*').eq('id', id).single());
  const round = (Number(a.proof_round) || 0) + 1;
  await run(db.from('ads').update({ status: 'proof', proof_round: round, proof_mgmt_at: null, proof_mgmt_by: null, proof_cust_at: null, revision_note: null }).eq('id', id));
  await addInteraction('ad', id, 'פרוף מוכן (סבב ' + round + ') — ממתין לאישור הנהלה ולקוח');
  toast('הפרוף סומן כמוכן — ממתין לאישורים');
  document.getElementById('viewBack')?.classList.remove('open');
  openPage(currentPage === 'graphics' ? 'graphics' : currentPage);
}

async function _proofFinalizeIfReady(id) {
  const a = await run(db.from('ads').select('proof_mgmt_at,proof_cust_at,status').eq('id', id).single());
  if (a.status === 'proof' && a.proof_mgmt_at && a.proof_cust_at) {
    await run(db.from('ads').update({ status: 'approved' }).eq('id', id));
    await addInteraction('ad', id, '✓ אושר סופית (הנהלה + לקוח) — מוכן לשיבוץ');
    return true;
  }
  return false;
}

async function proofMgmtApprove(id) {
  await run(db.from('ads').update({ proof_mgmt_by: profile.id, proof_mgmt_at: new Date().toISOString() }).eq('id', id));
  await addInteraction('ad', id, 'אישור הנהלה — ' + (profile.full_name || ''));
  const done = await _proofFinalizeIfReady(id);
  toast(done ? 'אושר סופית — מוכן לשיבוץ' : 'אישור הנהלה נרשם — ממתין ללקוח');
  document.getElementById('viewBack')?.classList.remove('open');
  openPage(currentPage);
}

/* אישור לקוח ידני-זמני (יוחלף בדף אישור חיצוני בשלב ב') */
async function proofCustApproveManual(id) {
  if (!confirm('לסמן שהלקוח אישר את הפרוף? (זמני — עד שיופעל דף האישור ללקוח)')) return;
  await run(db.from('ads').update({ proof_cust_at: new Date().toISOString() }).eq('id', id));
  await addInteraction('ad', id, 'הלקוח אישר את הפרוף (סומן ידנית ע"י ' + (profile.full_name || '') + ')');
  const done = await _proofFinalizeIfReady(id);
  toast(done ? 'אושר סופית — מוכן לשיבוץ' : 'אישור לקוח נרשם — ממתין להנהלה');
  document.getElementById('viewBack')?.classList.remove('open');
  openPage(currentPage);
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
      <button class="btn btn-sm btn-danger-ghost" onclick="proofRequestRevision(${a.id})">✎ בקשת תיקון</button>
    </div>
    <p class="muted" style="font-size:.76rem;margin-top:6px">כששני האישורים יתקבלו — המודעה תעבור אוטומטית ל"מוכן לשיבוץ".</p>
  </div>`;
}
