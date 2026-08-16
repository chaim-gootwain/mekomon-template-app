/* ============================================================
   ad-status.js — חלון בכניסה: מודעות ללא סטטוס (deal_stage) + סימון ידני
   ------------------------------------------------------------
   - בכניסה למערכת מוצג חלון עם כל המודעות שעדיין לא הוגדר להן שלב-עסקה.
   - לכל מודעה אפשר לבחור סטטוס (כולל "חשבונית הופקה") — גם בלי לעבור דרך
     חיוב הגיליון.
   ============================================================ */
'use strict';

/* עדכון שלב-עסקה למודעה (deal_stage). ריק => מנקה. */
async function adStatusSet(adId, stage) {
  try {
    const val = stage || null;
    await db.from('ads').update({ deal_stage: val }).eq('id', adId);
    if (typeof toast === 'function') toast(val ? ('סטטוס עודכן: ' + (typeof dealStageLabel === 'function' ? dealStageLabel(val) : val)) : 'הסטטוס נוקה');
    return true;
  } catch (e) { if (typeof toast === 'function') toast('עדכון נכשל: ' + (e && e.message || e), true); return false; }
}

/* בחירת סטטוס מתוך חלון הכניסה — מסמן את השורה ומעדכן את המונה */
async function adStatusPick(adId, stage, el) {
  if (!stage) return;
  const ok = await adStatusSet(adId, stage);
  if (ok && el) {
    const tr = el.closest('tr'); if (tr) { tr.style.opacity = '.4'; tr.querySelectorAll('select,button').forEach(x => x.disabled = true); }
    const cnt = document.getElementById('adStatusCount');
    if (cnt) { const n = Math.max(0, (parseInt(cnt.dataset.n || '0', 10) - 1)); cnt.dataset.n = n; cnt.textContent = n; if (n === 0) setTimeout(adStatusClose, 400); }
  }
}

function adStatusClose() { document.getElementById('adStatusOv')?.remove(); }

/* נקרא בכניסה למערכת — בודק מודעות ללא סטטוס ומציג חלון אם יש */
async function adStatusCheckPending() {
  try {
    if (typeof profile === 'undefined' || !['admin', 'sales'].includes(profile.role)) return;
    const _vb = document.getElementById('viewBack');
    if (_vb && _vb.classList.contains('open')) return; // חלון אחר פתוח (למשל אשף ייבוא) — לא דורסים
    const ads = await run(db.from('ads').select('id,customer_id,issue_id,title,price,discount,page_number,status,deal_stage')
      .is('deal_stage', null).gt('price', 0).not('status', 'in', '("cancelled","rejected")'));
    const list = (ads || []).filter(a => Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) > 0);
    if (!list.length) return;
    adStatusRender(list);
  } catch (e) { console.error('ad-status', e); }
}

function adStatusRender(list) {
  const issMap = {}; ((typeof cache !== 'undefined' && cache.issues) || []).forEach(i => issMap[i.id] = i);
  const byIss = {};
  list.forEach(a => { (byIss[a.issue_id] = byIss[a.issue_id] || []).push(a); });
  const _eff = (i) => (i && (i.print_date || i.publish_date)) || '';
  const issueIds = Object.keys(byIss).map(Number).sort((x, y) => String(_eff(issMap[y])).localeCompare(String(_eff(issMap[x]))));
  const stageOpts = (typeof DEAL_STAGES !== 'undefined') ? Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}">${t[0]}</option>`).join('') : '';
  const sections = issueIds.map(iid => {
    const iss = issMap[iid] || {};
    const rows = byIss[iid].map(a => {
      const price = Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
      return `<tr>
        <td><b>${esc(nameOf('customers', a.customer_id))}</b></td>
        <td>${esc(a.title || '')}${a.page_number ? ` · עמ׳ ${a.page_number}` : ''}</td>
        <td style="white-space:nowrap">${money(price)}</td>
        <td><select onchange="adStatusPick(${a.id}, this.value, this)" style="font-size:.82rem;padding:3px 6px;border-radius:6px;border:1px solid var(--line,#d1d5db)">
          <option value="">— בחר סטטוס —</option>${stageOpts}</select></td>
        <td><button class="btn btn-sm btn-ghost" onclick="adStatusClose(); openCustomerCard(${a.customer_id})">כרטיס</button></td>
      </tr>`;
    }).join('');
    return `<div style="margin-top:12px"><div style="font-weight:700;color:@@COLOR_DARK@@">גיליון ${iss.issue_number || iid}${_eff(iss) ? ' · ' + (typeof heDate === 'function' ? heDate(_eff(iss)) : '') : ''} <span class="muted" style="font-weight:400">(${byIss[iid].length})</span></div>
      <div class="table-wrap" style="margin-top:4px"><table class="data"><thead><tr><th>לקוח</th><th>מודעה</th><th>מחיר</th><th>סטטוס</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');
  document.getElementById('adStatusOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'adStatusOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99998;padding:20px';
  ov.addEventListener('click', e => { if (e.target === ov) adStatusClose(); });
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:14px;padding:18px;max-width:760px;width:96%;max-height:86vh;overflow:auto;direction:rtl">
    <h3 style="margin:0 0 2px">🔔 מודעות ללא סטטוס — <span id="adStatusCount" data-n="${list.length}">${list.length}</span></h3>
    <p class="muted" style="font-size:.83rem;margin:0 0 4px">מודעות שעדיין לא הוגדר להן שלב-עסקה. עדכן/י לכל אחת סטטוס (כולל "🟣 חשבונית הופקה"), או "אחר כך".</p>
    ${sections}
    <div style="margin-top:16px;text-align:left"><button class="btn btn-ghost" onclick="adStatusClose()">אחר כך</button></div>
  </div>`;
  document.body.appendChild(ov);
}
