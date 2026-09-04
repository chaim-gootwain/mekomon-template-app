/* ============================================================
data-entry-chat.js — בוט הזנת נתונים (צ'אט תפעולי לסוכנים)
------------------------------------------------------------
בוט נפרד מצ'אט החשבוניות, על אותו שלד מוכח:
- כותבים משפט חופשי → פענוח (Edge: parse-entry, Claude בצד השרת)
- התאמת לקוח fuzzy (Edge: match-customer) — לעולם לא מנחשים,
  והמועמדים מסוננים מול המטמון (RLS): סוכן רואה רק את הלקוחות שלו
- כרטיס תצוגה מקדימה לעריכה ואישור → כתיבת חוזה (contracts) +
  מודעות (ads) — אותו מבנה רשומות כמו new_deal בצ'אט החשבוניות
- אחרי הקמה: התראה למנהל דרך מנוע ההתראות (agent_deal_closed);
  המנהל מפיק את המסמך הכספי מצ'אט החשבוניות (כפתור "הפק מסמך"
  בהתראה טוען לו כרטיס ממולא) — הבוט עצמו לעולם לא מפיק מסמך כספי.
- כל הזנה נרשמת בטבלת entry_requests (draft/committed/cancelled/error)
- מאחורי דגל: settings.data_entry_bot_enabled ('0' כברירת מחדל) —
  עובד גם במופע בלי EZcount. מוזרק לתפריט ולהגדרות בלי לגעת
  בקוד הקיים (עטיפות refreshCache ו-Pages.settings).
============================================================ */

'use strict';

function deBotOn() { return String((cache.settings || {}).data_entry_bot_enabled || '0') === '1'; }
function deVatPct() { const v = Number((cache.settings || {}).vat_rate); return v > 0 ? v : 18; }

/* ---------- לוגיקה טהורה (ניתנת לבדיקה ב-node עם תלויות מוזרקות) ---------- */
function deNorm(s) { return String(s || '').replace(/["'`״׳.\-]/g, '').replace(/\s+/g, '').trim(); }
/* התאמת גודל חופשי ("רבע עמוד") לפריט מחירון */
function deMatchSize(raw, priceList) {
  const list = priceList || [];
  if (!list.length || !raw) return null;
  const q = deNorm(raw);
  let hit = list.find(p => deNorm(p.name) === q);
  if (!hit) hit = list.find(p => { const n = deNorm(p.name); return n.includes(q) || q.includes(n); });
  return hit || null;
}
/* רצף מספרי הגיליונות של העסקה */
function deDealNums(count, startIssue) {
  const n = Math.max(0, Number(count) || 0), s = Number(startIssue) || 0;
  const out = []; for (let i = 0; i < n && s > 0; i++) out.push(s + i); return out;
}
/* מיפוי מספרי גיליון לרשומות קיימות */
function deMapIssues(nums, issues) {
  const byNum = {};
  (issues || []).forEach(i => { byNum[Number(i.issue_number)] = i; });
  const existing = [], missing = [];
  nums.forEach(n => { if (byNum[n]) existing.push({ num: n, id: byNum[n].id }); else missing.push(n); });
  const maxExisting = Math.max(0, ...(issues || []).map(i => Number(i.issue_number) || 0));
  return { existing, missing, maxExisting, byNum };
}
/* חישוב סכומי העסקה — אותה נוסחה כמו כרטיס ה-new_deal בצ'אט החשבוניות */
function deDealTotals(count, unitPrice, includesVat, ratePct) {
  const base = (Number(count) || 0) * (Number(unitPrice) || 0);
  const totalBase = includesVat ? Math.round(base / (1 + ratePct / 100) * 100) / 100 : base;
  const vat = Math.round(totalBase * ratePct / 100 * 100) / 100;
  const total = Math.round((totalBase + vat) * 100) / 100;
  return { base: totalBase, vat, total };
}

/* ---------- קריאת Edge Function עם הודעת שגיאה קריאה ---------- */
async function deFn(name, body) {
  try {
    const { data, error } = await db.functions.invoke(name, { body });
    if (error) {
      let msg = error.message || 'שגיאה';
      try { if (error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || msg; } } catch (e) { }
      return { errMsg: msg };
    }
    if (data && data.error) return { errMsg: data.error, data };
    return { data };
  } catch (e) { return { errMsg: String(e && e.message || e) }; }
}

/* ---------- מצב הצ'אט ---------- */
let _deState = null;
function deResetState() {
  _deState = { reqId: null, rawText: '', pending: null, candidates: [], confidence: 'high', busy: false, customer: null, deal: null };
}

/* ---------- הדף ---------- */
Pages.entrychat = {
  title: 'הזנת נתונים',
  render: async (el) => {
    // עיצוב: אותן מחלקות .ic-* של צ'אט החשבוניות (הקובץ נטען תמיד בבאנדל)
    if (typeof invChatEnsureStyles === 'function') invChatEnsureStyles();
    deResetState();
    if (!deBotOn()) {
      el.innerHTML = `<div class="empty">בוט הזנת הנתונים כבוי במופע הזה.<br>מנהל יכול להדליק אותו במסך הגדרות ← "בוט הזנת נתונים".</div>`;
      return;
    }
    el.innerHTML = `
    <div class="ic-wrap">
      <div class="card card-pad" style="padding:12px 16px">
        <b>📝 הזנת נתונים</b>
        <div class="muted" style="font-size:.83rem;margin-top:2px">
          כתוב משפט חופשי על עסקה שסגרת — למשל: <i>"עסקה של 4 פרסומים רבע עמוד מגיליון 295 לפסיפס"</i>.
          שום דבר לא נכתב למערכת בלי אישור שלך בכרטיס. הבוט לא מפיק מסמכים כספיים — המנהל מקבל התראה ומפיק.
        </div>
      </div>
      <div class="ic-log" id="deLog"></div>
      <div class="ic-inputrow">
        <input id="deInput" placeholder="מה להזין?" autocomplete="off"
          onkeydown="if(event.key==='Enter')deChatSend()">
        <button class="btn" id="deSendBtn" onclick="deChatSend()">שלח</button>
      </div>
      <div class="card card-pad">
        <b>הזנות אחרונות</b>
        <div id="deHist" style="margin-top:8px"><div class="muted">טוען...</div></div>
      </div>
    </div>`;
    deLoadHistory();
    document.getElementById('deInput').focus();
  },
};

/* ---------- בועות בצ'אט ---------- */
function deBubble(html, cls) {
  const log = document.getElementById('deLog');
  if (!log) return null;
  const d = document.createElement('div');
  d.className = cls || 'ic-msg ic-bot';
  d.innerHTML = html;
  log.appendChild(d);
  d.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return d;
}
function deSay(html) { return deBubble(html, 'ic-msg ic-bot'); }
function deSayErr(html) { return deBubble(html, 'ic-msg ic-bot err'); }
function deSayOk(html) { return deBubble(html, 'ic-msg ic-bot ok'); }
function deSetBusy(b) {
  const btn = document.getElementById('deSendBtn');
  if (btn) { btn.disabled = b; btn.textContent = b ? '...' : 'שלח'; }
  if (_deState) _deState.busy = b;
}

/* ---------- שליחת מלל ---------- */
async function deChatSend() {
  const inp = document.getElementById('deInput');
  const text = (inp.value || '').trim();
  if (!text || (_deState && _deState.busy)) return;
  inp.value = '';
  deBubble(esc(text), 'ic-msg ic-user');

  // תשובה לשאלה פתוחה ("איזה לקוח?") — לא בקשה חדשה
  if (_deState && _deState.pending === 'customer' && _deState.deal) {
    deSetBusy(true);
    await deResolveCustomer(text);
    deSetBusy(false);
    return;
  }

  // בקשה חדשה
  deResetState();
  _deState.rawText = text;
  deSetBusy(true);
  const thinking = deSay('מפענח... ⏳');
  try {
    // 1. רישום draft בלוג
    const ins = await run(db.from('entry_requests')
      .insert({ raw_text: text, user_id: profile.id, status: 'draft' }).select('id').single(), 'שגיאה ברישום ההזנה');
    _deState.reqId = ins.id;

    // 2. פענוח
    const p = await deFn('parse-entry', { text });
    thinking.remove();
    if (p.errMsg || !p.data || !p.data.parsed) {
      deSayErr('הפענוח נכשל: ' + esc(p.errMsg || 'תשובה ריקה'));
      return;
    }
    const parsed = p.data.parsed;
    db.from('entry_requests').update({ parsed_json: parsed }).eq('id', _deState.reqId).then(() => { });
    if (parsed.action !== 'new_deal') {
      db.from('entry_requests').update({ status: 'cancelled' }).eq('id', _deState.reqId).then(() => { });
      deSay('בשלב הזה אני יודע להזין רק <b>עסקת פרסומים על לקוח קיים</b> — למשל: <i>"עסקה של 4 פרסומים רבע עמוד מגיליון 295 לפסיפס"</i>.<br>הפקת מסמכים כספיים נשארת בצ׳אט החשבוניות (למנהל).');
      return;
    }
    _deState.confidence = parsed.confidence || 'low';
    const d = parsed.deal || {};
    _deState.deal = {
      count: Number(d.count) || 0,
      start_issue: Number(d.start_issue) || 0,
      size_raw: d.size_raw || null,
      unit_price: Number(d.unit_price) || 0,
      price_includes_vat: !!d.price_includes_vat,
    };

    // 3. התאמת לקוח (חובה — עסקה נפתחת רק על כרטיס קיים)
    if (parsed.customer_name_raw) await deResolveCustomer(parsed.customer_name_raw);
    else deAskCustomerAgain();
  } catch (e) {
    thinking.remove();
    deSayErr('שגיאה: ' + esc(String(e && e.message || e)));
  } finally {
    deSetBusy(false);
  }
}

/* ---------- התאמת לקוח ----------
   שימוש חוזר ב-match-customer (fuzzy), ואז סינון מול המטמון:
   cache.customers נטען דרך המשתמש המחובר, כך ש-RLS כבר צמצם אותו —
   סוכן (sales) מקבל בו רק את הלקוחות המשויכים אליו. מועמד שלא במטמון
   פשוט לא מוצג. גם אם משהו יחמוק — ה-RLS על contracts/ads חוסם כתיבה. */
function deVisibleCustomer(id) { return (cache.customers || []).some(c => c.id === id); }
async function deResolveCustomer(name) {
  _deState.pending = null;
  const m = await deFn('match-customer', { name });
  if (m.errMsg || !m.data) {
    deSayErr('התאמת הלקוח נכשלה: ' + esc(m.errMsg || ''));
    deAskCustomerAgain();
    return;
  }
  const visible = (m.data.candidates || []).filter(c => deVisibleCustomer(c.id));
  if (visible.length === 1 && m.data.match === 'single') {
    deSetCustomer(visible[0]);
  } else if (visible.length >= 1) {
    // גם מועמד גלוי יחיד שההתאמה שלו לא ודאית מוצג לבחירה — לא מנחשים
    _deState.candidates = visible;
    _deState.pending = 'customer_pick';
    deSay('נמצאו כמה לקוחות דומים ל"' + esc(name) + '" — למי הכוונה?' +
      '<div class="ic-choices">' +
      visible.map((c, i) => `<button class="btn btn-sm btn-ghost" onclick="dePickCustomer(${i})">${esc(c.name)}${c.business_id ? ' <span class="muted">(' + esc(c.business_id) + ')</span>' : ''}</button>`).join('') +
      `<button class="btn btn-sm btn-ghost" onclick="deAskCustomerAgain()">✎ שם אחר</button>` +
      '</div>');
  } else {
    const foundHidden = (m.data.candidates || []).length > 0;
    deSay((foundHidden && profile.role === 'sales'
      ? 'לא נמצא לקוח בשם "' + esc(name) + '" בין הלקוחות המשויכים אליך.'
      : 'לא נמצא לקוח קיים בשם "' + esc(name) + '".') +
      ' עסקה נפתחת על כרטיס לקוח קיים בלבד (פתיחת לקוח חדש — דרך מסך הלקוחות).' +
      '<div class="ic-choices"><button class="btn btn-sm btn-ghost" onclick="deAskCustomerAgain()">✎ נסה שם אחר</button></div>');
  }
}
function deSetCustomer(c) {
  _deState.customer = { id: c.id, name: c.name };
  _deState.pending = null;
  deStartNewDeal();
}
function dePickCustomer(i) {
  const c = _deState.candidates[i];
  if (!c) return;
  deSetCustomer(c);
}
function deAskCustomerAgain() {
  _deState.pending = 'customer';
  deSay('על איזה לקוח העסקה? כתוב את שם הלקוח למטה.');
  document.getElementById('deInput')?.focus();
}

/* ---------- כרטיס העסקה ---------- */
function deStartNewDeal() {
  const d = _deState.deal || {};
  // גודל + מחיר ברירת מחדל מהמחירון (כמו new_deal בצ'אט החשבוניות)
  const sizeHit = deMatchSize(d.size_raw, cache.priceList);
  _deState.deal = {
    count: Number(d.count) || 0,
    start_issue: Number(d.start_issue) || 0,
    unit_price: (Number(d.unit_price) > 0) ? Number(d.unit_price) : (sizeHit ? Number(sizeHit.price) || 0 : 0),
    price_includes_vat: !!d.price_includes_vat,
    size_id: sizeHit ? sizeHit.id : ((cache.priceList || [])[0] ? cache.priceList[0].id : null),
    opts: { contract: true, ads: true, autoIssues: true },
  };
  deNewDealCard();
}
function deNewDealCard() {
  const cst = _deState.customer, d = _deState.deal;
  document.getElementById('deCard-' + _deState.reqId)?.remove();
  const pct = deVatPct();
  const nums = deDealNums(d.count, d.start_issue);
  const map = deMapIssues(nums, cache.issues);
  const t = deDealTotals(d.count, d.unit_price, d.price_includes_vat, pct);
  const sizeOpts = (cache.priceList || []).map(p => `<option value="${p.id}" ${p.id === d.size_id ? 'selected' : ''}>${esc(p.name)} — ${money(p.price)}</option>`).join('');
  const rangeTxt = nums.length ? (nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '')) : '—';
  const missFuture = map.missing.filter(x => x > map.maxExisting);
  const missPast = map.missing.filter(x => x <= map.maxExisting);
  const warns = [];
  if (_deState.confidence === 'low') warns.push('⚠ רמת ודאות נמוכה בפענוח — בדוק את כל השדות לפני אישור.');
  if (d.opts.ads && missFuture.length) warns.push('גיליונות ' + missFuture.join(', ') + ' עדיין לא קיימים — ' + (d.opts.autoIssues ? 'ייווצרו אוטומטית לפי מספור רץ.' : 'סמן "השלמת גיליונות" כדי ליצור אותם, אחרת המודעות עליהם ידולגו.'));
  if (d.opts.ads && missPast.length) warns.push('⚠ גיליונות ' + missPast.join(', ') + ' חסרים ואי אפשר ליצור אותם אוטומטית (הם לפני הגיליון האחרון). המודעות עליהם ידולגו.');
  if (!d.size_id) warns.push('⚠ בחר גודל מהמחירון.');
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'deCard-' + _deState.reqId;
  const cb = (k, label) => `<label style="display:flex;gap:7px;align-items:center;cursor:pointer;font-size:.9rem">
    <input type="checkbox" ${d.opts[k] ? 'checked' : ''} onchange="deDealToggle('${k}',this.checked)" style="width:16px;height:16px">${label}</label>`;
  card.innerHTML = `
    <div class="hd">📝 עסקת פרסומים — לאישור לפני כתיבה למערכת</div>
    ${warns.map(w => `<div class="ic-warn">${w}</div>`).join('')}
    <div class="grid2">
      <div class="field"><label>לקוח <span class="ic-src exist">✓ מכרטיס</span></label>
        <input type="text" value="${esc(cst.name || '')}" disabled></div>
      <div class="field"><label>גודל (מחירון)</label>
        <select onchange="deDealSetSize(this.value)">${sizeOpts}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>מספר פרסומים</label>
        <input type="number" min="1" value="${Number(d.count) || ''}" onchange="deDealSet('count',this.value)"></div>
      <div class="field"><label>מגיליון</label>
        <input type="number" min="1" value="${Number(d.start_issue) || ''}" dir="ltr" onchange="deDealSet('start_issue',this.value)"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>מחיר לפרסום</label>
        <input type="number" step="any" value="${Number(d.unit_price) || ''}" onchange="deDealSet('unit_price',this.value)"></div>
      <div class="field"><label>גיליונות</label>
        <input type="text" value="${esc(rangeTxt)} (${nums.length})" disabled dir="ltr"></div>
    </div>
    <label class="vat" style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" ${d.price_includes_vat ? 'checked' : ''} onchange="deDealSet('price_includes_vat',this.checked)" style="width:15px;height:15px">המחיר כולל מע"מ</label>
    <div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:6px">
      <div class="muted" style="font-size:.8rem">מה להקים (אפשר לבחור):</div>
      ${cb('contract', 'חוזה/עסקה (' + (Number(d.count) || 0) + ' פרסומים)')}
      ${cb('ads', 'מודעות פר גיליון (' + nums.length + ')')}
      ${cb('autoIssues', 'השלמת גיליונות חסרים אוטומטית')}
    </div>
    <div class="ic-sum">
      <div class="row"><span>לפני מע"מ</span><span>${money(t.base)}</span></div>
      <div class="row"><span>מע"מ ${pct}%</span><span>${money(t.vat)}</span></div>
      <div class="row tot"><span>סה"כ העסקה (כולל מע"מ)</span><span>${money(t.total)}</span></div>
      <div class="muted" style="font-size:.75rem;margin-top:3px">לא מופק שום מסמך כספי — המנהל יקבל התראה ויפיק מצ׳אט החשבוניות.</div>
    </div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="deApproveBtn" onclick="deApprove()">✅ אשר וכתוב למערכת</button>
      <button class="btn btn-ghost" onclick="deCancel()">בטל</button>
    </div>`;
  document.getElementById('deLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function deDealSet(k, v) {
  const d = _deState.deal;
  if (k === 'price_includes_vat') d.price_includes_vat = !!v;
  else if (k === 'count' || k === 'start_issue') d[k] = Math.max(0, Math.floor(Number(v) || 0));
  else if (k === 'unit_price') d.unit_price = Math.max(0, Number(v) || 0);
  deNewDealCard();
}
function deDealSetSize(id) {
  const d = _deState.deal; d.size_id = Number(id) || null;
  const it = (cache.priceList || []).find(p => p.id === d.size_id);
  if (it && !(Number(d.unit_price) > 0)) d.unit_price = Number(it.price) || 0;
  deNewDealCard();
}
function deDealToggle(k, on) { _deState.deal.opts[k] = !!on; deNewDealCard(); }

/* ---------- אישור: כתיבה למערכת + התראה למנהל ---------- */
async function deApprove() {
  const cst = _deState.customer, d = _deState.deal;
  const nums = deDealNums(d.count, d.start_issue);
  if (!nums.length) { toast('חסר מספר פרסומים / גיליון התחלה', true); return; }
  if ((d.opts.contract || d.opts.ads) && !(Number(d.unit_price) > 0)) { toast('חסר מחיר לפרסום', true); return; }
  if ((d.opts.contract || d.opts.ads) && !d.size_id) { toast('בחר גודל מהמחירון', true); return; }
  if (!d.opts.contract && !d.opts.ads) { toast('בחר לפחות דבר אחד להקים', true); return; }
  const btn = document.getElementById('deApproveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'כותב...'; }
  deSetBusy(true);
  const done = [];
  try {
    // ----- שלב 1: השלמת גיליונות חסרים (רק אם יוצרים מודעות) -----
    let issueMap = deMapIssues(nums, cache.issues);
    if (d.opts.ads && d.opts.autoIssues) {
      const missFuture = issueMap.missing.filter(x => x > issueMap.maxExisting);
      if (missFuture.length) {
        const weeks = Math.min(52, Math.max(...missFuture) - issueMap.maxExisting);
        try {
          const before = new Set((cache.issues || []).map(i => i.id));
          await run(db.rpc('generate_issues', { p_weeks: weeks }), 'שגיאה ביצירת גיליונות');
          try {
            const dpc = Number((cache.settings || {}).default_pages_count) || 40;
            const { data: allI } = await db.from('issues').select('id');
            const newIds = (allI || []).map(i => i.id).filter(id => !before.has(id));
            if (newIds.length) await db.from('issues').update({ pages_count: dpc }).in('id', newIds);
          } catch (e) { }
          if (typeof refreshCache === 'function') await refreshCache();
          issueMap = deMapIssues(nums, cache.issues);
          done.push('נוצרו גיליונות עד ' + Math.max(...nums));
        } catch (e) { deSayErr('לא הצלחתי ליצור גיליונות (' + esc(String(e && e.message || e)) + '). ' + (done.length ? 'הוקמו: ' + done.join(', ') : 'לא הוקם דבר') + '.'); if (btn) { btn.disabled = false; btn.textContent = '✅ אשר וכתוב למערכת'; } return; }
      }
    }
    // ----- שלב 2: חוזה (לא נוצר שוב אם כבר הוקם בניסיון קודם) -----
    const c = (cache.customers || []).find(x => x.id === cst.id) || null;
    let contractId = d._contractId || null;
    if (d.opts.contract && !contractId) {
      const row = await run(db.from('contracts').insert({
        customer_id: cst.id, agent_id: (c && c.agent_id) || null,
        price_item_id: d.size_id, total_inserts: Number(d.count) || nums.length,
        total_price: (Number(d.unit_price) || 0) * (Number(d.count) || nums.length),
        active: true, cadence: 'every', start_date: today(), created_by: profile.id,
        notes: 'נפתחה מבוט הזנת הנתונים',
      }).select().single(), 'שגיאה בפתיחת חוזה');
      contractId = row.id; d._contractId = contractId;
      done.push('חוזה #' + contractId);
    }
    // ----- שלב 3: מודעות פר גיליון (לא נוצרות שוב אם כבר הוקמו) -----
    if (d.opts.ads && !d._adsDone) {
      const targets = issueMap.existing; // רק גיליונות שקיימים בפועל
      const missingSkipped = nums.length - targets.length;
      let made = 0, failed = 0;
      for (const t of targets) {
        const price = Number(d.unit_price) || 0;
        const rec = {
          customer_id: cst.id, title: (c && c.name) || cst.name || 'לקוח',
          price_item_id: d.size_id, price: price,
          discount: (typeof custFixedDiscountAmount === 'function' ? (custFixedDiscountAmount(cst.id, price) || 0) : 0),
          agent_id: (c && c.agent_id) || null, requested_placement: null,
          issue_id: t.id, page_number: null, status: 'committee',
          graphics_note: null, deal_stage: 'in_progress', contract_id: contractId, created_by: profile.id,
        };
        try { await db.from('ads').insert(rec).select('id').single().then(r => { if (r.error) throw r.error; }); made++; }
        catch (e1) {
          if (String(e1.message || e1).includes('deal_stage')) {
            const r2 = { ...rec }; delete r2.deal_stage;
            try { await db.from('ads').insert(r2).select('id').single().then(r => { if (r.error) throw r.error; }); made++; }
            catch (e2) { failed++; console.error('ad insert failed', e2); }
          } else { failed++; console.error('ad insert failed', e1); }
        }
      }
      if (made > 0) d._adsDone = true; // ננעל רק אחרי שנוצרה לפחות מודעה אחת — מונע כפילויות בלחיצה חוזרת
      done.push(made + ' מודעות' +
        (missingSkipped > 0 ? ' (' + missingSkipped + ' דולגו — גיליון חסר)' : '') +
        (failed > 0 ? ' (⚠ ' + failed + ' נכשלו — אפשר להוסיף ידנית)' : ''));
    }
    // ----- שלב 4: לוג + ציר זמן -----
    const sizeName = ((cache.priceList || []).find(p => p.id === d.size_id) || {}).name || '';
    const t = deDealTotals(d.count, d.unit_price, d.price_includes_vat, deVatPct());
    const scope = (Number(d.count) || nums.length) + ' × ' + (sizeName || 'פרסום') + ' מגיליון ' + (nums[0] || '');
    const finalFields = {
      customer_id: cst.id, customer_name: cst.name, count: d.count, start_issue: d.start_issue,
      size_id: d.size_id, size_name: sizeName, unit_price: d.unit_price,
      price_includes_vat: d.price_includes_vat, opts: d.opts, total_incl_vat: t.total,
    };
    if (_deState.reqId) db.from('entry_requests').update({
      status: 'committed', final_fields: finalFields, error_message: null,
      result_json: { contract_id: contractId || null, summary: done },
    }).eq('id', _deState.reqId).then(() => { });
    if (typeof addInteraction === 'function') {
      try { await addInteraction('customer', cst.id, 'עסקת פרסומים מבוט ההזנה: ' + scope + ' · סה"כ ' + money(t.total)); } catch (e) { }
    }
    // ----- שלב 5: התראה למנהל (מנוע ההתראות הקיים) -----
    let alertNote = '';
    if (!d._alertSent) {
      const myAgent = (cache.agents || []).find(a => a.profile_id === profile.id);
      const agentName = (myAgent && myAgent.name) || profile.full_name || 'סוכן';
      // בלי מפתח customer_id ברמה העליונה בכוונה — dedup במנוע נופל אז
      // ל-payload.id (ייחודי פר הזנה), כך ששתי עסקאות לאותו לקוח לא ייבלמו.
      const payload = {
        entry_kind: 'agent_deal', id: _deState.reqId,
        cust_id: cst.id, customer_name: cst.name, agent_name: agentName,
        scope, amount: money(t.total),
        count: Number(d.count) || nums.length, start_issue: d.start_issue,
        size_name: sizeName, unit_price: d.unit_price, price_includes_vat: d.price_includes_vat,
        contract_id: contractId || null,
        doc_label: 'פרסום' + (sizeName ? ' ' + sizeName : '') + ' — גיליונות ' + (nums[0] + (nums.length > 1 ? '–' + nums[nums.length - 1] : '')) + ' (' + (Number(d.count) || nums.length) + ' פרסומים)',
      };
      const evId = (typeof alertsPublishEvent === 'function') ? await alertsPublishEvent('agent_deal_closed', payload, 'data_entry_bot') : null;
      if (evId) { d._alertSent = true; deKickAlertsEngine(); }
      else alertNote = '<div class="muted" style="font-size:.78rem;margin-top:4px">⚠ ההתראה למנהל לא נשלחה (מנוע ההתראות כבוי או לא מותקן) — עדכן אותו ידנית.</div>';
    }
    if (typeof refreshCache === 'function') { try { await refreshCache(); } catch (e) { } }
    document.getElementById('deCard-' + _deState.reqId)?.remove();
    deSayOk('✅ נכתב למערכת ל<b>' + esc(cst.name || '') + '</b>: ' + done.map(x => '<b>' + esc(x) + '</b>').join(' · ') +
      ' · סה"כ <b>' + money(t.total) + '</b>' +
      (d._alertSent ? '<div class="muted" style="font-size:.78rem;margin-top:4px">📣 נשלחה התראה למנהל להפקת המסמך.</div>' : alertNote));
    deResetState();
    deLoadHistory();
    document.getElementById('deInput')?.focus();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ אשר וכתוב למערכת'; }
    if (_deState.reqId) db.from('entry_requests').update({ status: 'error', error_message: String(e && e.message || e).slice(0, 300) }).eq('id', _deState.reqId).then(() => { });
    deSayErr('שגיאה בהקמת העסקה: ' + esc(String(e && e.message || e)) + (done.length ? ' · הוקם עד כה: ' + esc(done.join(', ')) : '') + '. אפשר לתקן וללחוץ שוב — מה שכבר הוקם לא ייווצר שוב.');
  } finally {
    deSetBusy(false);
  }
}
async function deCancel() {
  document.getElementById('deCard-' + _deState.reqId)?.remove();
  if (_deState.reqId) db.from('entry_requests').update({ status: 'cancelled' }).eq('id', _deState.reqId).then(() => { });
  deSay('ההזנה בוטלה — שום דבר לא נכתב.');
  deResetState();
  deLoadHistory();
}

/* דחיפת עיבוד ההתראה מיד (best effort) — במסלול הקריאה המתוזמנת של
   alerts-engine (Bearer = מפתח ה-anon). אם המפתח לא מתאים למסלול הזה
   במופע — נכשל בשקט, וההתראה תעובד בכניסת המנהל הבאה. */
function deKickAlertsEngine() {
  try {
    if (typeof BUILT_IN_URL !== 'string' || !BUILT_IN_URL.startsWith('https://')) return;
    fetch(BUILT_IN_URL + '/functions/v1/alerts-engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BUILT_IN_KEY, apikey: BUILT_IN_KEY },
      body: JSON.stringify({ action: 'run' }),
    }).catch(() => { });
  } catch (e) { }
}

/* ---------- כפתור "הפק מסמך" בהתראת המנהל ----------
   נקרא ממגירת ההתראות (alerts.js) על התראת agent_deal_closed.
   פותח את צ׳אט החשבוניות עם כרטיס תצוגה-מקדימה ממולא (חשבון עסקה),
   בלי לעבור דרך הפרסר — כדי שלא תרוץ שוב אורקסטרציית new_deal
   ותיווצר עסקה כפולה. נשען על ה-state הפנימי של invoice-chat.js
   (אותו bundle) — משתמש בו בלבד, לא משנה אותו. */
async function deAlertInvoice(alertId) {
  const a = (typeof _alertsList !== 'undefined' ? (_alertsList || []) : []).find(x => x.id === alertId);
  const p = a && a.alert_events && a.alert_events.payload;
  if (!p) { toast('פרטי העסקה לא נמצאו בהתראה', true); return; }
  if (typeof invoiceChatOn !== 'function' || !invoiceChatOn()) {
    toast('צ׳אט החשבוניות כבוי במופע הזה — הפק את המסמך מכרטיס הלקוח', true);
    return;
  }
  await openPage('invchat');
  icResetState();
  _icState.rawText = '[מהתראת עסקה] ' + (p.scope || '') + ' — ' + (p.customer_name || '');
  try {
    const ins = await run(db.from('invoice_requests')
      .insert({ raw_text: _icState.rawText, user_id: profile.id, status: 'draft' }).select('id').single(), 'שגיאה ברישום הבקשה');
    _icState.reqId = ins.id;
  } catch (e) { return; }
  _icState.mode = 'issue';
  _icState.confidence = 'high';
  _icState.fields = {
    doc_type: 'proforma',
    customer_id: Number(p.cust_id) || null,
    customer_name: p.customer_name || '',
    customer_source: p.cust_id ? 'existing' : null,
    line_items: [{
      description: p.doc_label || ('פרסום — ' + (p.scope || '')),
      quantity: Number(p.count) || 1,
      unit_price: Number(p.unit_price) || 0,
      price_includes_vat: !!p.price_includes_vat,
    }],
    payment_method: null,
  };
  icBubble(esc(_icState.rawText), 'ic-msg ic-user');
  icSay('העסקה נטענה מהתראת הסוכן — בדוק את הפרטים ואשר להפקה.');
  invChatRenderCard();
}

/* ---------- היסטוריה ---------- */
async function deLoadHistory() {
  const el = document.getElementById('deHist');
  if (!el) return;
  try {
    const { data } = await db.from('entry_requests')
      .select('id,created_at,raw_text,status,error_message')
      .order('created_at', { ascending: false }).limit(10);
    const rows = data || [];
    if (!rows.length) { el.innerHTML = '<div class="muted">אין הזנות עדיין</div>'; return; }
    const st = { draft: '<span class="pill">טיוטה</span>', committed: '<span class="pill green">נכתב</span>', cancelled: '<span class="pill">בוטל</span>', error: '<span class="pill red">שגיאה</span>' };
    el.innerHTML = `<div class="table-wrap"><table class="data ic-hist"><tbody>` + rows.map(r => `<tr>
      <td class="muted" style="white-space:nowrap">${heDateTime(r.created_at)}</td>
      <td>${esc((r.raw_text || '').slice(0, 60))}${(r.raw_text || '').length > 60 ? '…' : ''}</td>
      <td>${st[r.status] || esc(r.status)}${r.status === 'error' && r.error_message ? `<div class="muted" style="font-size:.72rem">${esc(r.error_message.slice(0, 80))}</div>` : ''}</td>
    </tr>`).join('') + `</tbody></table></div>`;
  } catch (e) { el.innerHTML = '<div class="muted">שגיאה בטעינת ההיסטוריה</div>'; }
}

/* ---------- הזרקה לתפריט (בלי לגעת ב-app.js) ---------- */
function deInjectNav() {
  const nav = document.getElementById('sideNav');
  if (!nav || !profile) return;
  const existing = document.getElementById('nav-entrychat');
  const allowed = ['admin', 'sales'].includes(profile.role) && deBotOn();
  if (!allowed) { existing?.remove(); return; }
  if (existing) return;
  const btn = document.createElement('button');
  btn.id = 'nav-entrychat';
  btn.innerHTML = '<span>📝</span> הזנת נתונים <span class="badge hidden" id="badge-entrychat"></span>';
  btn.onclick = () => openPage('entrychat');
  const anchor = document.getElementById('nav-quotes') || document.getElementById('nav-contracts') || document.getElementById('nav-leads');
  if (anchor && anchor.parentElement === nav) anchor.after(btn);
  else nav.appendChild(btn);
}
(function () {
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._deChatWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { deInjectNav(); } catch (e) { }
      return r;
    };
    wrapped._deChatWrapped = true;
    window.refreshCache = wrapped;
  }
})();

/* ---------- כרטיס במסך ההגדרות (עטיפת Pages.settings) ---------- */
async function deToggleSave(on) {
  await run(db.from('settings').upsert({ key: 'data_entry_bot_enabled', value: on ? '1' : '0' }));
  cache.settings.data_entry_bot_enabled = on ? '1' : '0';
  deInjectNav();
  toast(on ? 'בוט הזנת הנתונים הופעל' : 'בוט הזנת הנתונים כובה');
}
async function deProbe() {
  const el = document.getElementById('deProbeOut');
  if (el) el.textContent = 'בודק...';
  const pc = await deFn('parse-entry', { probe: true });
  const ok = pc.data && pc.data.ok;
  if (el) el.innerHTML = ok ? '✅ פענוח (Claude) מחובר' : '❌ פענוח: ' + esc((pc.data && pc.data.error) || pc.errMsg || 'לא מחובר');
}
(function () {
  const orig = Pages.settings && Pages.settings.render;
  if (orig && !orig._deChatWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try {
        const card = document.createElement('div');
        card.className = 'card card-pad';
        card.innerHTML = `
        <b>בוט הזנת נתונים 📝</b>
        <p class="muted" style="font-size:.82rem">צ׳אט תפעולי לסוכנים: הזנת עסקת פרסומים (חוזה + מודעות) ממשפט חופשי,
        עם אישור לפני כל כתיבה. הבוט לא מפיק מסמכים כספיים — בעסקה נשלחת התראה למנהל שמפיק
        מצ׳אט החשבוניות. עובד גם במופע בלי EZcount. דורש את מיגרציית data_entry_bot
        ואת ANTHROPIC_API_KEY ב-Supabase → Edge Functions → Secrets.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
          <input type="checkbox" ${deBotOn() ? 'checked' : ''} onchange="deToggleSave(this.checked)" style="width:18px;height:18px">
          בוט הזנת נתונים פעיל (מוסיף "📝 הזנת נתונים" לתפריט — למנהל ולסוכנים)
        </label>
        <button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="deProbe()">🔌 בדיקת חיבור הפענוח</button>
        <div id="deProbeOut" class="muted" style="font-size:.83rem;margin-top:6px"></div>`;
        const anchor = el.querySelector('#activityLog');
        const anchorCard = anchor ? anchor.closest('.card') : null;
        if (anchorCard) el.insertBefore(card, anchorCard); else el.appendChild(card);
      } catch (e) { console.error('data-entry settings card', e); }
      return r;
    };
    wrapped._deChatWrapped = true;
    Pages.settings.render = wrapped;
  }
})();

/* חשיפת הלוגיקה הטהורה לבדיקות node (לא פעיל בדפדפן) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { deNorm, deMatchSize, deDealNums, deMapIssues, deDealTotals };
}
