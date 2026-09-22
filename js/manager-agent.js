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
          <i>"תן לי את הגזירים של פסיפס"</i> · <i>"תבדוק מה פתוח לפסיפס ותוציא לו מס-קבלה"</i>.
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

/* תשובת הסוכן: escape + שורות חדשות + הדגשות **טקסט** בלבד */
function mgrFormatReply(text) {
  return esc(String(text || ''))
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
    } else {
      _mgrState.pending = { tool_use_id: r.data.proposal.tool_use_id };
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
