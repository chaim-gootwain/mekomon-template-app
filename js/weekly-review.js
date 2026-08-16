/* ============================================================
   weekly-review.js — סבב מעקב שבועי (יום שני), לקוח-אחר-לקוח
   ------------------------------------------------------------
   פעם בשבוע (מיום שני) קופץ חלון צף שרץ לקוח-אחר-לקוח על מודעות
   שדורשות טיפול: ללא שלב-עסקה / "סוכם" / "חשבונית הופקה".
   לכל לקוח אפשר: לשנות שלב, לסמן "שולם + תאריך" (מעדכן גם את
   המודעה וגם רושם תשלום בגבייה אם יש חיוב פתוח), לדלג, לדחות
   לשבוע הבא, או לפתוח כרטיס/להפיק חשבונית.
   נשמר "השבוע האחרון שהוצג" בהגדרות — מופיע פעם בשבוע.
   ============================================================ */
'use strict';

let _wrData = [];   // [{customer_id, name, phone, ads:[...]}]
let _wrIdx = 0;

/* מפתח שבוע ISO (מתאפס ביום שני) */
function _wrWeekKey(d) {
  const dt = new Date(d || Date.now()); dt.setHours(0, 0, 0, 0);
  const day = (dt.getDay() + 6) % 7;          // ראשון=6, שני=0
  dt.setDate(dt.getDate() - day + 3);         // חמישי של אותו שבוע
  const firstThu = new Date(dt.getFullYear(), 0, 4);
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return dt.getFullYear() + '-W' + String(week).padStart(2, '0');
}

function _wrSnoozeKey() { return 'wr_snooze_' + _wrWeekKey(); }
function _wrSnoozed() { try { return JSON.parse(localStorage.getItem(_wrSnoozeKey()) || '[]'); } catch (e) { return []; } }
function _wrAddSnooze(cid) { try { const s = _wrSnoozed(); if (!s.includes(cid)) { s.push(cid); localStorage.setItem(_wrSnoozeKey(), JSON.stringify(s)); } } catch (e) { } }

/* סימון "הוצג השבוע" — כך שלא יחזור באותו שבוע */
async function _wrMarkWeekDone() {
  const key = _wrWeekKey();
  try { await db.from('settings').upsert({ key: 'weekly_review_last', value: key }); } catch (e) { }
  if (typeof cache !== 'undefined' && cache.settings) cache.settings.weekly_review_last = key;
}

/* נקרא בכניסה — מציג את הסבב פעם בשבוע. מחזיר true אם נפתח. */
async function weeklyReviewCheckPending() {
  try {
    if (typeof profile === 'undefined' || !['admin', 'sales'].includes(profile.role)) return false;
    if ((cache.settings || {}).weekly_review_last === _wrWeekKey()) return false;
    const _vb = document.getElementById('viewBack');
    if (_vb && _vb.classList.contains('open')) return false; // חלון אחר פתוח

    const { data } = await db.from('ads')
      .select('id,customer_id,issue_id,title,price,discount,page_number,status,deal_stage')
      .or('deal_stage.is.null,deal_stage.eq.invoiced,deal_stage.eq.agreed')
      .gt('price', 0).not('status', 'in', '("cancelled","rejected")');
    let ads = (data || []).filter(a => Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)) > 0);
    if (!ads.length) return false;

    const snoozed = _wrSnoozed();
    const byCust = {};
    ads.forEach(a => {
      if (snoozed.includes(a.customer_id)) return;
      (byCust[a.customer_id] = byCust[a.customer_id] || []).push(a);
    });
    _wrData = Object.keys(byCust).map(cid => {
      const c = (cache.customers || []).find(x => String(x.id) === String(cid)) || {};
      return { customer_id: Number(cid), name: c.name || nameOf('customers', Number(cid)) || 'לקוח', phone: c.phone || '', ads: byCust[cid] };
    }).sort((a, b) => a.name.localeCompare(b.name, 'he'));
    if (!_wrData.length) return false;

    _wrIdx = 0;
    _wrRender();
    return true;
  } catch (e) { console.error('weekly-review', e); return false; }
}

function weeklyReviewClose(markDone) {
  document.getElementById('wrOv')?.remove();
  if (markDone !== false) _wrMarkWeekDone();
}

function _wrNet(a) { return Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)); }
function _wrIssLabel(a) {
  const i = (cache.issues || []).find(x => x.id === a.issue_id);
  return i ? ('גיליון ' + i.issue_number) : (a.issue_id ? 'גיליון ' + a.issue_id : '');
}

function _wrRender() {
  if (_wrIdx >= _wrData.length) { _wrFinish(); return; }
  const cur = _wrData[_wrIdx];
  const stageOpts = Object.entries(DEAL_STAGES).map(([v, t]) => `<option value="${v}">${t[0]}</option>`).join('');
  const total = cur.ads.reduce((s, a) => s + _wrNet(a), 0);
  const rows = cur.ads.map((a, i) => {
    const st = DEAL_STAGES[a.deal_stage];
    const badge = st ? `<span class="pill ${st[1]}">${st[0]}</span>` : '<span class="pill">ללא סטטוס</span>';
    return `<tr data-adid="${a.id}">
      <td>${esc(_wrIssLabel(a))}</td>
      <td>${esc(a.title || '')}${a.page_number ? ' · עמ׳ ' + a.page_number : ''}</td>
      <td style="white-space:nowrap">${money(_wrNet(a))}</td>
      <td>${badge}</td>
      <td><select onchange="wrSetStage(${a.id}, this.value, this)" style="font-size:.82rem;padding:3px 6px;border-radius:6px;border:1px solid var(--line,#d1d5db)">
        <option value="">— שנה —</option>${stageOpts}<option value="__clear__">— נקה —</option></select></td>
    </tr>`;
  }).join('');
  const phoneBtns = (typeof phoneBtn === 'function' && cur.phone) ? phoneBtn(cur.phone) : (cur.phone ? `<span dir="ltr" class="muted">${esc(cur.phone)}</span>` : '');

  document.getElementById('wrOv')?.remove();
  const ov = document.createElement('div');
  ov.id = 'wrOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,20,40,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:99997;padding:16px;overflow:auto;direction:rtl';
  ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:16px;padding:20px;max-width:680px;width:96%;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0;color:@@COLOR_DARK@@">🗓️ סבב מעקב שבועי</h3>
      <span class="muted" style="font-size:.85rem">לקוח ${_wrIdx + 1} מתוך ${_wrData.length}</span>
    </div>
    <div style="margin-top:10px;padding:10px 12px;background:#f6f8fc;border-radius:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <b style="font-size:1.05rem">${esc(cur.name)}</b>
        <span>${phoneBtns}</span>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:10px"><table class="data">
      <thead><tr><th>גיליון</th><th>מודעה</th><th>מחיר</th><th>סטטוס</th><th>שינוי</th></tr></thead>
      <tbody>${rows}</tbody></table></div>

    <div style="margin-top:12px;padding:12px;border:1px solid #cdebd4;background:#f4fbf6;border-radius:10px">
      <div style="font-weight:700;color:#1a7f37;margin-bottom:6px">🟢 סימון שולם — ${money(total)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <div class="field" style="margin:0"><label style="font-size:.8rem">תאריך תשלום</label><input id="wrPayDate" type="date" value="${today()}"></div>
        <div class="field" style="margin:0"><label style="font-size:.8rem">אמצעי</label>
          <select id="wrPayMethod">${INV_PAY_METHODS ? INV_PAY_METHODS.map(m => `<option value="${m.v}" ${m.v === 'transfer' ? 'selected' : ''}>${m.t}</option>`).join('') : '<option value="transfer">העברה</option><option value="cash">מזומן</option>'}</select></div>
        <button class="btn" onclick="wrMarkPaid()">✓ סמן שולם + רשום תשלום</button>
      </div>
      <div class="muted" style="font-size:.76rem;margin-top:6px">מסמן את כל המודעות של הלקוח כ"שולם" עם התאריך, ורושם תשלום בגבייה כנגד חיוב פתוח אם קיים.</div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-ghost btn-sm" onclick="weeklyReviewClose(false); openCustomerCard(${cur.customer_id})">כרטיס לקוח</button>
      ${typeof invIssueOrder === 'function' ? `<button class="btn btn-ghost btn-sm" onclick="wrInvoice(${cur.customer_id})">הפקת חשבונית</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="wrSnooze()">⏰ דחה לשבוע הבא</button>
      <div style="margin-right:auto;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="wrPrev()" ${_wrIdx === 0 ? 'disabled' : ''}>← הקודם</button>
        <button class="btn btn-sm" onclick="wrNext()">${_wrIdx === _wrData.length - 1 ? 'סיום ✓' : 'הבא →'}</button>
      </div>
    </div>
    <div style="margin-top:10px;text-align:left"><button class="btn btn-ghost btn-sm" onclick="weeklyReviewClose(true)">סגור (יופיע שוב בשבוע הבא)</button></div>
  </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) { /* לא סוגרים בטעות */ } });
  document.body.appendChild(ov);
}

function wrNext() { _wrIdx++; _wrRender(); }
function wrPrev() { if (_wrIdx > 0) { _wrIdx--; _wrRender(); } }

function wrSnooze() {
  const cur = _wrData[_wrIdx];
  if (cur) _wrAddSnooze(cur.customer_id);
  _wrData.splice(_wrIdx, 1);
  if (!_wrData.length) { _wrFinish(); return; }
  if (_wrIdx >= _wrData.length) _wrIdx = _wrData.length - 1;
  _wrRender();
}

async function wrSetStage(adId, stage, el) {
  const val = stage === '__clear__' ? null : (stage || undefined);
  if (val === undefined) return;
  try {
    await db.from('ads').update({ deal_stage: val }).eq('id', adId);
    const cur = _wrData[_wrIdx]; const a = cur && cur.ads.find(x => x.id === adId); if (a) a.deal_stage = val;
    toast(val ? ('סטטוס עודכן: ' + dealStageLabel(val)) : 'הסטטוס נוקה');
    if (el) { const tr = el.closest('tr'); if (tr) tr.querySelector('td:nth-child(4)').innerHTML = val ? `<span class="pill ${DEAL_STAGES[val][1]}">${DEAL_STAGES[val][0]}</span>` : '<span class="pill">ללא סטטוס</span>'; el.value = ''; }
  } catch (e) { toast('עדכון נכשל: ' + (e.message || e), true); }
}

async function wrInvoice(cid) { weeklyReviewClose(false); try { await invIssueOrder(cid); } catch (e) { } }

/* סימון שולם: מעדכן את המודעות (deal_stage=paid + paid_date) וגם רושם תשלום בגבייה */
async function wrMarkPaid() {
  const cur = _wrData[_wrIdx]; if (!cur) return;
  const date = document.getElementById('wrPayDate').value || today();
  const method = document.getElementById('wrPayMethod').value || 'transfer';
  const ids = cur.ads.map(a => a.id);
  const pool = cur.ads.reduce((s, a) => s + _wrNet(a), 0);
  toast('רושם...');
  // 1) עדכון המודעות — עם fallback אם עמודת paid_date עדיין לא קיימת
  try {
    await db.from('ads').update({ deal_stage: 'paid', paid_date: date }).in('id', ids);
  } catch (e1) {
    try { await db.from('ads').update({ deal_stage: 'paid' }).in('id', ids); } catch (e2) { toast('עדכון המודעות נכשל: ' + (e2.message || e2), true); return; }
  }
  // 2) רישום תשלום כנגד חיובים פתוחים של הלקוח (הישן ביותר קודם)
  let recorded = 0;
  try {
    const { data: chs } = await db.from('charges').select('id,amount,status,issued_date')
      .eq('customer_id', cur.customer_id).in('status', ['pending', 'invoiced', 'partial', 'overdue'])
      .order('issued_date', { ascending: true });
    let left = pool;
    for (const ch of (chs || [])) {
      if (left <= 0.001) break;
      const { data: pays } = await db.from('payments').select('amount').eq('charge_id', ch.id);
      const bal = Number(ch.amount) - (pays || []).reduce((s, p) => s + Number(p.amount), 0);
      if (bal <= 0.001) continue;
      const applied = Math.min(bal, left);
      await db.from('payments').insert({ charge_id: ch.id, customer_id: cur.customer_id, amount: Math.round(applied * 100) / 100, method, paid_date: date, notes: 'סבב מעקב שבועי — סומן שולם', created_by: (typeof profile !== 'undefined' ? profile.id : null) });
      await db.from('charges').update({ status: (applied >= bal - 0.001) ? 'paid' : 'partial' }).eq('id', ch.id);
      left -= applied; recorded += applied;
    }
  } catch (e) { console.error('wr payment', e); }
  try { await addInteraction('customer', cur.customer_id, '🟢 סבב שבועי — סומן שולם (' + money(pool) + ', ' + heDate(date) + ')' + (recorded ? ' · נרשם בגבייה ' + money(recorded) : '')); } catch (e) { }
  toast('✓ סומן שולם' + (recorded ? ' · נרשם בגבייה ' + money(recorded) : ' (אין חיוב פתוח לרישום)'));
  // הסרת הלקוח מהסבב והתקדמות
  _wrData.splice(_wrIdx, 1);
  if (!_wrData.length) { _wrFinish(); return; }
  if (_wrIdx >= _wrData.length) _wrIdx = _wrData.length - 1;
  _wrRender();
}

function _wrFinish() {
  document.getElementById('wrOv')?.remove();
  _wrMarkWeekDone();
  const ov = document.createElement('div');
  ov.id = 'wrOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,20,40,.5);display:flex;align-items:center;justify-content:center;z-index:99997;direction:rtl';
  ov.innerHTML = `<div style="background:#fff;border-radius:16px;padding:28px;text-align:center;max-width:360px">
    <div style="font-size:2rem">🎉</div>
    <h3 style="margin:8px 0 4px;color:@@COLOR_DARK@@">סיימת את הסבב השבועי</h3>
    <p class="muted" style="font-size:.86rem">נתראה בשבוע הבא (יום שני).</p>
    <button class="btn" onclick="weeklyReviewClose(true)" style="margin-top:8px">סגירה</button></div>`;
  document.body.appendChild(ov);
}
