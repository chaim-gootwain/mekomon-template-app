/* ============================================================
manager-agent.js — סוכן המקומון (שלב א'): צ'אט סוכן למנהל
------------------------------------------------------------
- שיחה רציפה מול Edge Function ‏manager-agent (לולאת כלים של Claude):
  שאילתות נתונים (חוב, פרסומים, מי לא חויב) + הצעות פעולה כספית.
- הצעת פעולה (proposal) לא מבוצעת בשרת: היא נפתחת כאן ככרטיס
  האישור הקיים של צ'אט החשבוניות (issue / pay_existing / new_deal) —
  אותם כרטיסים, אותן הגנות, שום מסמך בלי [אשר והפק].
- תוצאת האישור/הביטול חוזרת לסוכן כ-tool_result, כדי שידע להמשיך
  ("הופק, מספר 1234") — עטיפת המאשרים בלי לגעת בקוד הקיים.
- כל שיחה נשמרת ב-agent_chats (המשכיות וביקורת); ההפקות עצמן
  ממשיכות להירשם ב-invoice_requests כמו היום.
- מאחורי דגל: settings.manager_agent_enabled ('0' כברירת מחדל),
  למנהל (admin) בלבד. מוזרק לתפריט ולהגדרות בעטיפות — בלי לגעת
  בקוד הקיים. תלוי ב-invoice-chat.js (סגנונות, בועות, כרטיסים) —
  חייב להיטען אחריו ב-ORDER של build.sh.
============================================================ */

'use strict';

function mgrAgentOn() { return String((cache.settings || {}).manager_agent_enabled || '0') === '1'; }

/* ---------- לוגיקה טהורה (ניתנת לבדיקה ב-node) ---------- */
/* תוכן הודעת המשתמש: טקסט רגיל, או סגירת הצעה תלויה + טקסט */
function mgrBuildUserContent(pendingToolUseId, text) {
  if (!pendingToolUseId) return text;
  return [
    { type: 'tool_result', tool_use_id: pendingToolUseId, content: 'המשתמש עדיין לא אישר את הכרטיס והמשיך בשיחה.' },
    { type: 'text', text }
  ];
}
/* גזירת תמליל ארוך מההתחלה, בלי לקטוע זוג tool_use/tool_result:
   ההודעה הראשונה שנשארת חייבת להיות הודעת משתמש רגילה (לא tool_result) */
function mgrTrimMessages(msgs, maxLen) {
  const max = maxLen || 40;
  const list = (msgs || []).slice();
  const isPlainUser = m => m && m.role === 'user' &&
    (typeof m.content === 'string' || !(m.content || []).some(b => b && b.type === 'tool_result'));
  while (list.length > max || (list.length && !isPlainUser(list[0]))) {
    list.shift();
    if (!list.length) break;
  }
  return list;
}

/* ---------- מצב השיחה ---------- */
let _mgrState = null;
function mgrResetState() {
  _mgrState = { chatId: null, messages: [], busy: false, pending: null, lastUserText: '', title: null };
}

/* ---------- הדף ---------- */
Pages.mgragent = {
  title: 'סוכן המקומון',
  render: async (el) => {
    invChatEnsureStyles();
    mgrResetState();
    if (!mgrAgentOn()) {
      el.innerHTML = `<div class="empty">סוכן המקומון כבוי במופע הזה.<br>מנהל יכול להדליק אותו במסך הגדרות ← "סוכן המקומון".</div>`;
      return;
    }
    el.innerHTML = `
    <div class="ic-wrap" id="mgrWrap">
      <div class="card card-pad" style="padding:12px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <b>🤖 סוכן המקומון</b>
          <button class="btn btn-sm btn-ghost" onclick="mgrNewChat()">🗨 שיחה חדשה</button>
        </div>
        <div class="muted" style="font-size:.83rem;margin-top:2px">
          כתוב מה שאתה צריך — שאלה על נתונים או פעולה. למשל:
          <i>"כמה חוב יש לגן ורדים?"</i> · <i>"מי עוד לא חויב על גיליון 300?"</i> ·
          <i>"תן לי את הגזירים של פסיפס"</i> · <i>"שלח תזכורת לכל מי שחייב מעל 1,000 ₪"</i> ·
          <i>"תזכיר לי להתקשר לגן ורדים ביום חמישי"</i> · <i>"תבדוק מה פתוח לפסיפס ותוציא לו מס-קבלה"</i>.
          שום מסמך לא מופק בלי אישור שלך בכרטיס.
        </div>
      </div>
      <div class="ic-log" id="icLog"></div>
      <div class="ic-inputrow">
        <input id="icInput" placeholder="מה תרצה?" autocomplete="off"
          onkeydown="if(event.key==='Enter')mgrAgentSend()">
        <button class="btn" id="icSendBtn" onclick="mgrAgentSend()">שלח</button>
      </div>
    </div>`;
    icSay('שלום! אני סוכן המקומון. אפשר לשאול אותי על חובות, פרסומים וגיליונות, או לבקש להפיק מסמכים ולפתוח עסקאות — הכול במשפט חופשי.');
    document.getElementById('icInput').focus();
  },
};

function mgrNewChat() {
  const wasOn = mgrAgentOn();
  mgrResetState();
  const log = document.getElementById('icLog');
  if (log) log.innerHTML = '';
  if (wasOn) icSay('שיחה חדשה — במה אפשר לעזור?');
  document.getElementById('icInput')?.focus();
}

function mgrSetBusy(b) {
  const btn = document.getElementById('icSendBtn');
  if (btn) { btn.disabled = b; btn.textContent = b ? '...' : 'שלח'; }
  if (_mgrState) _mgrState.busy = b;
}

/* תשובת הסוכן: escape + שורות חדשות + הדגשות **טקסט** + קישורי markdown
   [טקסט](https://...) — כך הסוכן יכול לצרף קישור PDF של מסמך שנפתח בלחיצה.
   הקלט עובר esc קודם, כך שה-URL בתוך href לא יכול לשבור את המאפיין. */
function mgrFormatReply(text) {
  return esc(String(text || ''))
    .replace(/\[([^\]\n]{1,100})\]\((https?:[^\s)<]{1,600})\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

/* ---------- שליחה ---------- */
async function mgrAgentSend() {
  const inp = document.getElementById('icInput');
  const text = (inp.value || '').trim();
  if (!text || (_mgrState && _mgrState.busy)) return;

  // כרטיס פתוח ששאל שם לקוח (זרימת צ'אט החשבוניות) — התשובה שייכת לכרטיס
  if (typeof _icState !== 'undefined' && _icState && _icState.pending === 'customer' && _icState.fields) {
    inp.value = '';
    icBubble(esc(text), 'ic-msg ic-user');
    mgrSetBusy(true);
    await invChatResolveCustomer(text);
    mgrSetBusy(false);
    return;
  }

  inp.value = '';
  icBubble(esc(text), 'ic-msg ic-user');
  const pendingId = _mgrState.pending && _mgrState.pending.tool_use_id;
  _mgrState.pending = null; // הכרטיס נשאר פתוח ועובד, אבל הסוכן ממשיך בלי לחכות לו
  _mgrState.messages = mgrTrimMessages(_mgrState.messages, 40);
  _mgrState.messages.push({ role: 'user', content: mgrBuildUserContent(pendingId, text) });
  _mgrState.lastUserText = text;
  await mgrCallAgent();
}

/* ---------- קריאה לסוכן וטיפול בתשובה ---------- */
async function mgrCallAgent() {
  mgrSetBusy(true);
  const thinking = icSay('חושב... ⏳');
  const r = await invChatFn('manager-agent', { messages: _mgrState.messages });
  thinking && thinking.remove();
  mgrSetBusy(false);
  if (r.errMsg || !r.data || !r.data.ok) {
    // ההודעה נשארת בתמליל — שליחה נוספת תנסה שוב עם אותו הקשר
    icSayErr('שגיאה: ' + esc(r.errMsg || (r.data && r.data.error) || 'תשובה ריקה'));
    return;
  }
  _mgrState.messages = r.data.messages || _mgrState.messages;
  if (r.data.reply) icSay(mgrFormatReply(r.data.reply));
  if (r.data.proposal) {
    if (r.data.proposal.name === 'show_customer_clips') {
      // הצגה בדפדפן בלבד — אין מה לאשר; מציגים, מדווחים לסוכן וממשיכים
      await mgrShowClips(r.data.proposal);
    } else if (r.data.proposal.name === 'propose_send_clips') {
      _mgrState.pending = { tool_use_id: r.data.proposal.tool_use_id, kind: 'send_clips' };
      await mgrProposeSendClips(r.data.proposal);
    } else if (r.data.proposal.name === 'propose_debt_reminders') {
      _mgrState.pending = { tool_use_id: r.data.proposal.tool_use_id, kind: 'debt_reminders' };
      await mgrProposeReminders(r.data.proposal);
    } else if (r.data.proposal.name === 'propose_add_task') {
      _mgrState.pending = { tool_use_id: r.data.proposal.tool_use_id, kind: 'add_task' };
      await mgrProposeTask(r.data.proposal);
    } else {
      _mgrState.pending = { tool_use_id: r.data.proposal.tool_use_id, kind: 'invoice' };
      await mgrOpenProposal(r.data.proposal);
    }
  }
  mgrSaveChat();
  document.getElementById('icInput')?.focus();
}

/* ---------- הצגת גזירים (כלי דפדפן, קריאה בלבד) ----------
   נשען על העוזרים של דוח היסטוריית לקוח (reports.js, נטען לפנינו
   בבאנדל): custPubsFetch לשליפה ו-reportCustClipsZip להורדת ה-ZIP —
   אותו מנגנון כמו בבוט הזנת הנתונים. אחרי ההצגה נשלח לסוכן tool_result
   עם סיכום, כדי שיוכל להגיב ולהמשיך. */
let _mgrClipsSeq = 0;
const _mgrClips = {};
async function mgrShowClips(p) {
  const inp = p.input || {};
  const cid = Number(inp.customer_id) || 0;
  const name = String(inp.customer_name || '');
  let summary;
  try {
    if (!cid) throw new Error('חסר מזהה לקוח');
    if (typeof custPubsFetch !== 'function') throw new Error('מודול הדוחות לא נטען — רענן את הדף');
    const wait = icSay('שולף את הגזירים של <b>' + esc(name) + '</b>... ⏳');
    const pubs = await custPubsFetch(cid, Number(inp.issue_from) || null, Number(inp.issue_to) || null);
    wait && wait.remove();
    const { ads, clipOf, proofOf, issNum } = pubs;
    if (!ads.length) {
      icSay('לא נמצאו מודעות ל<b>' + esc(name) + '</b>' + ((inp.issue_from || inp.issue_to) ? ' בטווח המבוקש' : '') + '.');
      summary = 'לא נמצאו מודעות ללקוח בטווח המבוקש.';
    } else {
      const qid = ++_mgrClipsSeq;
      _mgrClips[qid] = { clips: pubs.clips, name: name || ('לקוח_' + cid) };
      const published = ads.filter(a => a.status === 'published').length;
      const SHOW = 40;
      const rows = ads.slice(0, SHOW).map(a => `<tr>
        <td>${issNum[a.issue_id] != null ? 'גיליון ' + issNum[a.issue_id] : heDate(a.created_at)}</td>
        <td>${esc(a.title)}</td><td>${pill('ad', a.status)}</td>
        <td>${clipOf[a.id] ? `<button class="btn btn-sm btn-ghost" onclick="adFileOpen('${escJs(clipOf[a.id].storage_path)}')">📎</button>`
          : (proofOf && proofOf[a.id]) ? `<button class="btn btn-sm btn-ghost" onclick="adProofOpen(${a.issue_id}, ${a.customer_id})">🗞️</button>` : '—'}</td>
      </tr>`).join('');
      icSay('ל<b>' + esc(name) + '</b>: <b>' + ads.length + '</b> מודעות, מהן <b>' + published + '</b> פורסמו · <b>' + pubs.clips.length + '</b> גזירים זמינים.' +
        '<div class="table-wrap" style="margin-top:8px;max-height:280px;overflow:auto"><table class="data"><thead><tr><th>גיליון</th><th>מודעה</th><th>סטטוס</th><th>גזיר</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (ads.length > SHOW ? '<div class="muted" style="font-size:.78rem">מוצגות ' + SHOW + ' מתוך ' + ads.length + ' — הרשימה המלאה בדוח היסטוריית לקוח.</div>' : '') +
        '<div class="ic-choices" style="margin-top:8px">' +
        (pubs.clips.length ? `<button class="btn btn-sm" onclick="mgrClipsZip(${qid}, this)">⬇ הורדת הגזירים (${pubs.clips.length}) — ZIP</button>` : '') +
        '<button class="btn btn-sm btn-ghost" onclick="openPage(\'reports\')">📊 לדוח המלא</button></div>');
      summary = 'הוצגו למנהל ' + ads.length + ' מודעות ו-' + pubs.clips.length + ' גזירים' +
        (pubs.clips.length ? ', כולל כפתור הורדת ZIP.' : '. אין גזירים זמינים להורדה.');
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    icSayErr('שליפת הגזירים נכשלה: ' + esc(msg));
    summary = 'שגיאה בשליפת הגזירים: ' + msg.slice(0, 200);
  }
  _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, content: summary }] });
  await mgrCallAgent();
}
function mgrClipsZip(qid, btn) {
  const d = _mgrClips[qid];
  if (!d || typeof reportCustClipsZip !== 'function') { toast('הגזירים לא זמינים — בקש שוב', true); return; }
  reportCustClipsZip(btn, d.clips, d.name);
}

/* ---------- שליחת גזירים במייל (כרטיס אישור) ----------
   אותו מנגנון של "שלח גזיר" בחיוב הגיליון: Edge Function ‏send-clip
   חותכת את עמודי המודעות מ-PDF הגיליון ושולחת לכתובת שבכרטיס הלקוח,
   גיליון אחד בכל קריאה. שום מייל לא נשלח בלי [שלח במייל] בכרטיס. */
let _mgrSend = null; // הצעת השליחה הממתינה לאישור
async function mgrProposeSendClips(p) {
  const inp = p.input || {};
  const cid = Number(inp.customer_id) || 0;
  const name = String(inp.customer_name || '');
  const nums = [...new Set((inp.issue_numbers || []).map(Number).filter(n => n > 0))].sort((a, b) => a - b).slice(0, 12);
  const fail = async (why) => {
    icSayErr(esc(why));
    _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: p.tool_use_id, content: 'הכרטיס לא נפתח: ' + why }] });
    _mgrState.pending = null;
    await mgrCallAgent();
  };
  if (!cid || !nums.length) { await fail('חסר לקוח או מספרי גיליונות לשליחה.'); return; }
  let email = '';
  try {
    const { data } = await db.from('customers').select('email').eq('id', cid).single();
    email = String(data && data.email || '').trim();
  } catch (e) { }
  if (!email) { await fail('ללקוח ' + name + ' אין כתובת מייל בכרטיס — יש להשלים אותה בכרטיס הלקוח לפני שליחה.'); return; }
  // מיפוי מספרי גיליון לרשומות קיימות
  const byNum = {};
  (cache.issues || []).forEach(i => { byNum[Number(i.issue_number)] = i; });
  const issues = nums.filter(n => byNum[n]).map(n => ({ num: n, id: byNum[n].id }));
  const missing = nums.filter(n => !byNum[n]);
  if (!issues.length) { await fail('הגיליונות ' + nums.join(', ') + ' לא נמצאו במערכת.'); return; }
  _mgrSend = { toolUseId: p.tool_use_id, customerId: cid, name, email, issues };
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'mgrSendCard';
  card.innerHTML = `
    <div class="hd">📧 שליחת גזירים במייל — לאישור לפני שליחה</div>
    ${missing.length ? `<div class="ic-warn">⚠ גיליונות ${missing.join(', ')} לא קיימים במערכת — ידולגו.</div>` : ''}
    <div class="grid2">
      <div class="field"><label>לקוח</label><input type="text" value="${esc(name)}" disabled></div>
      <div class="field"><label>אל (מכרטיס הלקוח)</label><input type="text" value="${esc(email)}" disabled dir="ltr"></div>
    </div>
    <div class="field"><label>גזירים מגיליונות</label>
      <input type="text" value="${issues.map(i => i.num).join(', ')} (${issues.length})" disabled dir="ltr"></div>
    <div class="muted" style="font-size:.78rem">כל גיליון נשלח כמייל נפרד עם עמודי המודעות של הלקוח מצורפים כ-PDF.</div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="mgrSendBtn" onclick="mgrSendClipsApprove()">✅ שלח במייל</button>
      <button class="btn btn-ghost" onclick="mgrSendClipsCancel()">בטל</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
async function mgrSendClipsApprove() {
  const s = _mgrSend;
  if (!s) return;
  const btn = document.getElementById('mgrSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  mgrSetBusy(true);
  const sent = [], failed = [];
  for (const iss of s.issues) {
    try {
      const { data, error } = await db.functions.invoke('send-clip', { body: { customer_id: s.customerId, issue_id: iss.id } });
      if (!error && data && data.ok) { sent.push(iss.num); continue; }
      let msg = '';
      try { if (error && error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || ''; } } catch (e) { }
      if (!msg && data) msg = data.detail || data.error || '';
      failed.push({ num: iss.num, msg: msg || 'שגיאה' });
    } catch (e) { failed.push({ num: iss.num, msg: String(e && e.message || e) }); }
  }
  mgrSetBusy(false);
  document.getElementById('mgrSendCard')?.remove();
  if (sent.length) icSayOk('✅ נשלחו הגזירים במייל ל<b>' + esc(s.name) + '</b> (' + esc(s.email) + ') — גיליונות <b>' + sent.join(', ') + '</b>.');
  if (failed.length) icSayErr('חלק מהשליחות נכשלו: ' + failed.map(f => 'גיליון ' + f.num + ' (' + esc(f.msg) + ')').join(' · '));
  const outcome = 'המשתמש אישר. ' +
    (sent.length ? 'נשלחו גזירים לגיליונות ' + sent.join(', ') + ' לכתובת ' + s.email + '. ' : '') +
    (failed.length ? 'נכשלו: ' + failed.map(f => 'גיליון ' + f.num + ' — ' + f.msg).join('; ') : '');
  const id = s.toolUseId;
  _mgrSend = null;
  // אם המנהל המשיך בשיחה בינתיים, ההצעה כבר נסגרה מול הסוכן — לא שולחים tool_result כפול
  const stillPending = _mgrState.pending && _mgrState.pending.tool_use_id === id;
  if (stillPending) {
    _mgrState.pending = null;
    _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: outcome.trim() }] });
    await mgrCallAgent();
  } else {
    mgrSaveChat();
  }
}
async function mgrSendClipsCancel() {
  const s = _mgrSend;
  if (!s) return;
  document.getElementById('mgrSendCard')?.remove();
  icSay('השליחה בוטלה — לא נשלח מייל.');
  const id = s.toolUseId;
  _mgrSend = null;
  const stillPending = _mgrState.pending && _mgrState.pending.tool_use_id === id;
  if (stillPending) {
    _mgrState.pending = null;
    _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'המשתמש ביטל — לא נשלח מייל.' }] });
    await mgrCallAgent();
  }
}

/* ---------- סגירת הצעה מול הסוכן (משותף לכרטיסים החדשים) ---------- */
async function mgrResolveProposal(toolUseId, outcome) {
  const stillPending = _mgrState && _mgrState.pending && _mgrState.pending.tool_use_id === toolUseId;
  if (!stillPending) { mgrSaveChat(); return; }
  _mgrState.pending = null;
  _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: outcome }] });
  await mgrCallAgent();
}

/* ---------- תזכורות חוב (כרטיס אישור ושליחה) ----------
   וואטסאפ: אותו מנגנון של מסך הגבייה — debtReminderSend פותח wa.me
   לשליחה ידנית ורושם לוג. מייל: send-email מהמערכת + לוג ב-debt_reminders.
   שום תזכורת לא יוצאת בלי לחיצה בכרטיס. */
let _mgrRem = null;
async function mgrProposeReminders(p) {
  const inp = p.input || {};
  const channel = inp.channel === 'email' ? 'email' : 'whatsapp';
  const list = (inp.customers || []).filter(c => Number(c.customer_id) > 0).slice(0, 30);
  const fail = async (why) => {
    icSayErr(esc(why));
    await mgrResolveProposal(p.tool_use_id, 'הכרטיס לא נפתח: ' + why);
  };
  if (!list.length) { await fail('לא הועברו לקוחות לתזכורת.'); return; }
  if (channel === 'whatsapp' && typeof waRemindersOn === 'function' && !waRemindersOn()) {
    await fail('תזכורות הוואטסאפ כבויות במופע הזה — מדליקים במסך הגדרות, או שולחים במייל.');
    return;
  }
  mgrSetBusy(true);
  const wait = icSay('מחשב יתרות עדכניות ל-' + list.length + ' לקוחות... ⏳');
  const info = {};
  try {
    const { data: custs } = await db.from('customers').select('id,name,email,phone,whatsapp')
      .in('id', list.map(c => Number(c.customer_id)));
    (custs || []).forEach(c => info[c.id] = c);
  } catch (e) { }
  const rows = [];
  for (const c of list) {
    const cid = Number(c.customer_id);
    const cust = info[cid] || {};
    let bal = { total: 0, count: 0, oldestDue: null };
    try { bal = await customerOpenBalance(cid); } catch (e) { }
    let skip = '';
    if (!(bal.total > 0)) skip = 'אין חוב פתוח';
    else if (channel === 'email' && !String(cust.email || '').trim()) skip = 'אין מייל בכרטיס';
    else if (channel === 'whatsapp' && !String(cust.whatsapp || cust.phone || '').trim()) skip = 'אין טלפון בכרטיס';
    rows.push({
      cid, name: cust.name || c.customer_name || '', total: bal.total, count: bal.count,
      oldestDue: bal.oldestDue, email: String(cust.email || '').trim(), skip, sent: false
    });
  }
  wait && wait.remove();
  mgrSetBusy(false);
  _mgrRem = { toolUseId: p.tool_use_id, channel, rows };
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'mgrRemCard';
  card.innerHTML = `
    <div class="hd">${channel === 'email' ? '📧' : '💬'} תזכורות חוב ב${channel === 'email' ? 'מייל' : 'וואטסאפ'} — לאישור לפני שליחה</div>
    ${channel === 'whatsapp' ? '<div class="ic-warn">וואטסאפ נפתח עם הודעה מוכנה לכל לקוח — הלחיצה על "שלח" בוואטסאפ היא שלך (בלי API, בלי סיכון חסימה).</div>' : ''}
    <div class="table-wrap" style="max-height:300px;overflow:auto"><table class="data"><thead>
      <tr><th>לקוח</th><th>יתרה</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td>${esc(r.name)}</td>
        <td>${r.skip ? '<span class="muted">' + esc(r.skip) + '</span>' : money(r.total)}</td>
        <td id="mgrRemBtn${i}">${r.skip ? '—' : `<button class="btn btn-sm" onclick="mgrRemSend(${i}, this)">${channel === 'email' ? '✉ שלח' : '💬 שלח'}</button>`}</td>
      </tr>`).join('')}</tbody></table></div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px;flex-wrap:wrap">
      ${channel === 'email' && rows.some(r => !r.skip) ? '<button class="btn" id="mgrRemAllBtn" onclick="mgrRemSendAll(this)">✉ שלח לכל הרשימה</button>' : ''}
      <button class="btn btn-ghost" onclick="mgrRemFinish()">סיים ועדכן את הסוכן</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
async function _mgrRemEmailSend(r) {
  const ageTxt = r.oldestDue ? ' (הוותיק שבהם מ-' + heDate(r.oldestDue) + ')' : '';
  const body = 'שלום ' + (r.name || '') + ',\n\n' +
    'תזכורת ידידותית: קיימת יתרת חוב פתוחה של ' + money(r.total) + ' על ' + r.count + ' חיובים' + ageTxt + '.\n' +
    'נשמח להסדרה בהקדם. לפירוט מלא או לתיאום תשלום: @@PAPER_PHONE@@.\n\nתודה רבה,\n@@PAPER_NAME@@';
  const { data, error } = await db.functions.invoke('send-email', {
    body: { to: r.email, subject: 'תזכורת יתרה פתוחה — @@PAPER_NAME@@', body, customer_id: r.cid }
  });
  if (error || !data || !data.ok) {
    let msg = '';
    try { if (error && error.context && typeof error.context.json === 'function') { const j = await error.context.json(); msg = j.detail || j.error || ''; } } catch (e) { }
    if (!msg && data) msg = data.detail || data.error || '';
    throw new Error(msg || 'שליחת המייל נכשלה');
  }
  try {
    await db.from('debt_reminders').insert({
      customer_id: r.cid, amount: Math.round(r.total * 100) / 100,
      channel: 'email', message: body, status: 'sent', created_by: profile.id
    });
  } catch (e) { }
  try { await addInteraction('customer', r.cid, '📧 נשלחה תזכורת חוב במייל (' + money(r.total) + ')'); } catch (e) { }
}
async function mgrRemSend(i, btn) {
  const s = _mgrRem;
  const r = s && s.rows[i];
  if (!r || r.skip || r.sent) return;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    if (s.channel === 'email') await _mgrRemEmailSend(r);
    else await debtReminderSend(r.cid); // פותח wa.me + לוג — כמו במסך הגבייה
    r.sent = true;
    const cell = document.getElementById('mgrRemBtn' + i);
    if (cell) cell.innerHTML = s.channel === 'email' ? '✅ נשלח' : '✅ נפתח';
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = s.channel === 'email' ? '✉ שלח' : '💬 שלח'; }
    toast('נכשל: ' + String(e && e.message || e), true);
    r.err = String(e && e.message || e).slice(0, 120);
  }
}
async function mgrRemSendAll(btn) {
  const s = _mgrRem;
  if (!s || s.channel !== 'email') return;
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  for (let i = 0; i < s.rows.length; i++) {
    if (!s.rows[i].skip && !s.rows[i].sent) await mgrRemSend(i, document.querySelector('#mgrRemBtn' + i + ' button'));
  }
  if (btn) { btn.textContent = '✉ שלח לכל הרשימה'; btn.disabled = false; }
}
async function mgrRemFinish() {
  const s = _mgrRem;
  if (!s) return;
  document.getElementById('mgrRemCard')?.remove();
  const sent = s.rows.filter(r => r.sent), skipped = s.rows.filter(r => r.skip), failed = s.rows.filter(r => r.err && !r.sent);
  if (sent.length) icSayOk('✅ נשלחו תזכורות ' + (s.channel === 'email' ? 'במייל' : 'בוואטסאפ') + ' ל-<b>' + sent.length + '</b> לקוחות: ' + sent.map(r => esc(r.name)).join(', '));
  else icSay('לא נשלחו תזכורות.');
  const outcome = (sent.length ? 'נשלחו תזכורות ' + (s.channel === 'email' ? 'במייל' : 'בוואטסאפ (נפתחו לשליחה ידנית)') + ' ל: ' + sent.map(r => r.name + ' (' + money(r.total) + ')').join(', ') + '. ' : 'לא נשלחו תזכורות. ') +
    (skipped.length ? 'דולגו: ' + skipped.map(r => r.name + ' — ' + r.skip).join(', ') + '. ' : '') +
    (failed.length ? 'נכשלו: ' + failed.map(r => r.name + ' — ' + r.err).join(', ') : '');
  const id = s.toolUseId;
  _mgrRem = null;
  await mgrResolveProposal(id, outcome.trim());
}

/* ---------- הוספת משימה על כרטיס לקוח (כרטיס אישור) ---------- */
let _mgrTask = null;
async function mgrProposeTask(p) {
  const inp = p.input || {};
  const cid = Number(inp.customer_id) || 0;
  if (!cid || !String(inp.title || '').trim()) {
    icSayErr('חסר לקוח או נוסח משימה.');
    await mgrResolveProposal(p.tool_use_id, 'הכרטיס לא נפתח: חסר לקוח או נוסח משימה.');
    return;
  }
  _mgrTask = { toolUseId: p.tool_use_id, cid, name: String(inp.customer_name || '') };
  const card = document.createElement('div');
  card.className = 'ic-card';
  card.id = 'mgrTaskCard';
  card.innerHTML = `
    <div class="hd">✅ משימה חדשה — לאישור</div>
    <div class="grid2">
      <div class="field"><label>לקוח</label><input type="text" value="${esc(_mgrTask.name)}" disabled></div>
      <div class="field"><label>תאריך יעד</label><input id="mgrTaskDue" type="date" value="${esc(String(inp.due_date || '').slice(0, 10))}"></div>
    </div>
    <div class="field"><label>המשימה</label><input id="mgrTaskTitle" type="text" value="${esc(String(inp.title || '').trim())}"></div>
    <div class="muted" style="font-size:.78rem">המשימה תופיע בכרטיס הלקוח ובתזכורות המערכת.</div>
    <div class="m-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn" id="mgrTaskBtn" onclick="mgrTaskApprove()">✅ הוסף משימה</button>
      <button class="btn btn-ghost" onclick="mgrTaskCancel()">בטל</button>
    </div>`;
  document.getElementById('icLog').appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
async function mgrTaskApprove() {
  const t = _mgrTask;
  if (!t) return;
  const title = ((document.getElementById('mgrTaskTitle') || {}).value || '').trim();
  const due = (document.getElementById('mgrTaskDue') || {}).value || null;
  if (!title) { toast('נא להזין נוסח משימה', true); return; }
  const btn = document.getElementById('mgrTaskBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'מוסיף...'; }
  const { error } = await db.from('customer_tasks').insert({
    customer_id: t.cid, title, due_date: due, done: false, created_by: profile.id
  });
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = '✅ הוסף משימה'; }
    toast('שגיאה: ' + error.message, true);
    return;
  }
  try { await addInteraction('customer', t.cid, '✅ נוספה משימה מהסוכן: ' + title + (due ? ' (עד ' + heDate(due) + ')' : '')); } catch (e) { }
  document.getElementById('mgrTaskCard')?.remove();
  icSayOk('✅ נוספה משימה ל<b>' + esc(t.name) + '</b>: ' + esc(title) + (due ? ' · עד ' + heDate(due) : ''));
  const id = t.toolUseId;
  _mgrTask = null;
  await mgrResolveProposal(id, 'המשימה נוספה: "' + title + '"' + (due ? ' עד ' + due : '') + '.');
}
async function mgrTaskCancel() {
  const t = _mgrTask;
  if (!t) return;
  document.getElementById('mgrTaskCard')?.remove();
  icSay('המשימה בוטלה — לא נוסף דבר.');
  const id = t.toolUseId;
  _mgrTask = null;
  await mgrResolveProposal(id, 'המשתמש ביטל — המשימה לא נוספה.');
}

/* ---------- הצעת פעולה → כרטיס האישור הקיים של צ'אט החשבוניות ---------- */
async function mgrOpenProposal(p) {
  try {
    const ins = await run(db.from('invoice_requests')
      .insert({ raw_text: _mgrState.lastUserText || '(סוכן המקומון)', user_id: profile.id, status: 'draft' })
      .select('id').single(), 'שגיאה ברישום הבקשה');
    icResetState();
    _icState.reqId = ins.id;
    _icState.rawText = _mgrState.lastUserText || '';
    _icState.confidence = 'high';
    const inp = p.input || {};
    if (p.name === 'propose_issue_document') {
      _icState.mode = 'issue';
      _icState.fields = {
        doc_type: inp.doc_type || null,
        customer_id: inp.customer_id || null,
        customer_name: inp.customer_name || '',
        customer_source: inp.customer_id ? 'existing' : null,
        line_items: (inp.line_items && inp.line_items.length)
          ? inp.line_items.map(l => ({
            description: String(l.description || 'פרסום'),
            quantity: Number(l.quantity) || 1,
            unit_price: Number(l.unit_price) || 0,
            price_includes_vat: !!l.price_includes_vat
          }))
          : [{ description: 'פרסום', quantity: 1, unit_price: 0, price_includes_vat: false }],
        payment_method: inp.payment_method || null,
      };
      invChatNext();
    } else if (p.name === 'propose_pay_existing') {
      _icState.mode = 'pay_existing';
      _icState.fields = {
        doc_type: 'tax_invoice_receipt',
        customer_id: inp.customer_id || null,
        customer_name: inp.customer_name || '',
        customer_source: 'existing',
        line_items: [],
        payment_method: inp.payment_method || null,
      };
      invChatStartPayExisting();
    } else if (p.name === 'propose_new_deal') {
      _icState.mode = 'new_deal';
      _icState.fields = {
        doc_type: null,
        customer_id: inp.customer_id || null,
        customer_name: inp.customer_name || '',
        customer_source: 'existing',
        line_items: [],
        payment_method: null,
      };
      _icState.deal = {
        count: Number(inp.count) || 0,
        start_issue: Number(inp.start_issue) || 0,
        size_raw: inp.size_raw || null,
        unit_price: Number(inp.unit_price) || 0,
        price_includes_vat: !!inp.price_includes_vat,
      };
      invChatStartNewDeal();
    } else {
      icSayErr('הצעה לא מוכרת: ' + esc(String(p.name || '')));
    }
  } catch (e) {
    icSayErr('שגיאה בפתיחת הכרטיס: ' + esc(String(e && e.message || e)));
  }
}

/* ---------- סגירת מעגל: תוצאת הכרטיס חוזרת לסוכן ----------
   עטיפת המאשרים/המבטל של צ'אט החשבוניות (בלי לגעת בקוד הקיים):
   כשהכרטיס נסגר בהצלחה או בוטל — שולחים לסוכן tool_result כדי
   שיאשר בקצרה וימשיך אם נשארו שלבים. כרטיס שנשאר פתוח (הפקה
   נכשלה) לא מדווח — המשתמש מתקן ומנסה שוב. */
function mgrOnPage() { return !!document.getElementById('mgrWrap'); }
async function mgrAfterCard(fnName, reqId) {
  if (!mgrOnPage() || !_mgrState || !_mgrState.pending) return;
  if (_mgrState.pending.kind && _mgrState.pending.kind !== 'invoice') return; // כרטיס אחר (שליחת גזירים) — יש לו מאשרים משלו
  if (reqId && document.getElementById('icCard-' + reqId)) return; // הכרטיס עוד פתוח
  let outcome;
  if (fnName === 'invChatCancel') {
    outcome = 'המשתמש ביטל את הכרטיס — לא בוצע דבר.';
  } else {
    outcome = 'המשתמש אישר והפעולה בוצעה.';
    try {
      const { data } = await db.from('invoice_requests')
        .select('status,icount_doc_number,error_message').eq('id', reqId).single();
      if (data && data.status === 'issued') {
        outcome = 'המשתמש אישר והמסמך הופק' + (data.icount_doc_number ? ' (מספר ' + data.icount_doc_number + ')' : '') + '.';
      } else if (data && data.status === 'error') {
        outcome = 'המשתמש אישר אבל ההפקה נכשלה: ' + String(data.error_message || 'שגיאה').slice(0, 200);
      }
    } catch (e) { }
  }
  const id = _mgrState.pending.tool_use_id;
  _mgrState.pending = null;
  _mgrState.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: outcome }] });
  await mgrCallAgent();
}
(function () {
  ['invChatApprove', 'invChatPayApprove', 'invChatNewDealApprove', 'invChatCancel'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function' || orig._mgrWrapped) return;
    const wrapped = async function () {
      const reqId = (typeof _icState !== 'undefined' && _icState) ? _icState.reqId : null;
      const r = await orig.apply(this, arguments);
      try { await mgrAfterCard(name, reqId); } catch (e) { console.error('mgr resolve', e); }
      return r;
    };
    wrapped._mgrWrapped = true;
    window[name] = wrapped;
  });
})();

/* ---------- שמירת השיחה (המשכיות וביקורת) ---------- */
async function mgrSaveChat() {
  try {
    if (!_mgrState || !_mgrState.messages.length) return;
    if (!_mgrState.title) _mgrState.title = (_mgrState.lastUserText || 'שיחה').slice(0, 80);
    const rec = { user_id: profile.id, title: _mgrState.title, messages: _mgrState.messages, updated_at: new Date().toISOString() };
    if (_mgrState.chatId) {
      await db.from('agent_chats').update(rec).eq('id', _mgrState.chatId);
    } else {
      const { data } = await db.from('agent_chats').insert(rec).select('id').single();
      if (data) _mgrState.chatId = data.id;
    }
  } catch (e) { console.error('mgr save chat', e); }
}

/* ---------- הזרקה לתפריט (בלי לגעת ב-app.js) ---------- */
function mgrInjectNav() {
  const nav = document.getElementById('sideNav');
  if (!nav || !profile) return;
  const existing = document.getElementById('nav-mgragent');
  const allowed = profile.role === 'admin' && mgrAgentOn();
  if (!allowed) { existing?.remove(); return; }
  if (existing) return;
  const btn = document.createElement('button');
  btn.id = 'nav-mgragent';
  btn.innerHTML = '<span>🤖</span> סוכן המקומון';
  btn.onclick = () => openPage('mgragent');
  const anchor = document.getElementById('nav-invchat') || document.getElementById('nav-billing') || document.getElementById('nav-finhub');
  if (anchor && anchor.parentElement === nav) anchor.after(btn);
  else nav.appendChild(btn);
}
(function () {
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._mgrWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { mgrInjectNav(); } catch (e) { }
      return r;
    };
    wrapped._mgrWrapped = true;
    window.refreshCache = wrapped;
  }
})();

/* ---------- כרטיס במסך ההגדרות (עטיפת Pages.settings) ---------- */
async function mgrToggleSave(on) {
  await run(db.from('settings').upsert({ key: 'manager_agent_enabled', value: on ? '1' : '0' }));
  cache.settings.manager_agent_enabled = on ? '1' : '0';
  mgrInjectNav();
  toast(on ? 'סוכן המקומון הופעל' : 'סוכן המקומון כובה');
}
async function mgrProbe() {
  const el = document.getElementById('mgrProbeOut');
  if (el) el.textContent = 'בודק...';
  const r = await invChatFn('manager-agent', { probe: true });
  const ok = r.data && r.data.ok;
  if (el) el.innerHTML = ok
    ? '✅ הסוכן מחובר (מודל: ' + esc(String(r.data.model || '')) + ')'
    : '❌ ' + esc((r.data && r.data.error) || r.errMsg || 'הפונקציה manager-agent לא פרוסה או שהסוד חסר');
}
(function () {
  const orig = Pages.settings && Pages.settings.render;
  if (orig && !orig._mgrWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try {
        const card = document.createElement('div');
        card.className = 'card card-pad';
        card.innerHTML = `
        <b>סוכן המקומון (AI)</b>
        <p class="muted" style="font-size:.82rem">צ'אט סוכן למנהל: שאלות על נתונים (חובות, פרסומים, גיליונות)
        ופעולות כספיות — עם אותם כרטיסי אישור של צ'אט החשבוניות, שום מסמך לא מופק בלי אישור.
        דורש: הרצת המיגרציה 2026-09-17_manager_agent, פריסת פונקציית manager-agent,
        וסוד ANTHROPIC_API_KEY (קיים אם צ'אט החשבוניות עובד). למנהל בלבד.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
          <input type="checkbox" ${mgrAgentOn() ? 'checked' : ''} onchange="mgrToggleSave(this.checked)" style="width:18px;height:18px">
          סוכן המקומון פעיל (מוסיף "🤖 סוכן המקומון" לתפריט)
        </label>
        <button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="mgrProbe()">🔌 בדיקת חיבור הסוכן</button>
        <div id="mgrProbeOut" class="muted" style="font-size:.83rem;margin-top:6px"></div>`;
        const anchor = el.querySelector('#activityLog');
        const anchorCard = anchor ? anchor.closest('.card') : null;
        if (anchorCard) el.insertBefore(card, anchorCard); else el.appendChild(card);
      } catch (e) { console.error('mgr settings card', e); }
      return r;
    };
    wrapped._mgrWrapped = true;
    Pages.settings.render = wrapped;
  }
})();

/* חשיפת הלוגיקה הטהורה לבדיקות node (לא פעיל בדפדפן) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mgrBuildUserContent, mgrTrimMessages };
}
