/* ============================================================
   team-chat.js — צ'אט צוות פנימי (שלב 1)
   ------------------------------------------------------------
   תקשורת פנימית בתוך המערכת, ללא וואטסאפ/מייל:
   - ערוץ קבוצתי אחד לכל הצוות (מנהל, מכירות, עורך וגרפיקה)
   - ערוץ אישי בין המנהל לכל סוכן (dm:<agent_id>)
   - מנהל רואה: קבוצה + ערוץ לכל סוכן מקושר; סוכן רואה: קבוצה + מנהל;
     עורך/גרפיקה רואים את הקבוצה בלבד
   - רענון בפולינג פשוט כל ~10 שניות (בלי Supabase Realtime בשלב זה)
   - באדג' "לא נקרא" על לשונית התפריט ועל כל ערוץ ברשימה
   - "נקרא" נשמר בטבלת team_message_reads (שורה לערוץ למשתמש)
   טבלאות: team_messages, team_message_reads —
   מיגרציה: migrations/2026-09-13_team_chat.sql (RLS בצד השרת)
   ============================================================ */

'use strict';

/* ---------- מצב ---------- */
let _tcChannel = null;   // הערוץ הפתוח כרגע
let _tcTimer = null;     // interval הפולינג הגלובלי
let _tcTick = 0;         // מונה טיקים — באדג' מתרענן גם כשהדף סגור, בקצב איטי
let _tcUnread = {};      // channel -> כמות לא-נקראו
let _tcBusy = false;     // שליחה בתהליך

function tcAllowed() { return profile && ['admin', 'sales', 'editor', 'graphics'].includes(profile.role); }

/* הערוץ האישי שלי (לסוכן): לפי רשומת הסוכן המקושרת למשתמש */
function tcMyDmChannel() {
  const a = (cache.agents || []).find(x => x.profile_id === profile.id);
  return a ? 'dm:' + a.id : null;
}

/* רשימת הערוצים שהמשתמש הנוכחי רואה */
function tcChannels() {
  const out = [{ id: 'group', name: 'קבוצה', icon: '👥' }];
  if (profile.role === 'admin') {
    // ערוץ לכל סוכן שמקושר למשתמש אמיתי — לסוכן בלי משתמש אין למי לענות
    (cache.agents || []).filter(a => a.profile_id)
      .forEach(a => out.push({ id: 'dm:' + a.id, name: a.name, icon: '👤' }));
  } else if (profile.role === 'sales') {
    const dm = tcMyDmChannel();
    if (dm) out.push({ id: dm, name: 'מנהל', icon: '👤' });
  }
  // עורך/גרפיקה: הערוץ הקבוצתי בלבד (ערוץ אישי הוא מנהל↔סוכן)
  return out;
}

let _tcProfiles = []; // גיבוי שמות: cache.profiles לא נטען לתפקיד גרפיקה
function tcSenderName(uid) {
  if (!uid) return 'מערכת'; // הודעת מערכת (למשל ברכת הבוקר) — אין שולח
  if (uid === profile.id) return 'אני';
  const p = (cache.profiles || []).find(x => x.id === uid) || _tcProfiles.find(x => x.id === uid);
  return p ? (p.full_name || 'משתמש') : 'משתמש';
}
async function tcLoadProfiles() {
  if ((cache.profiles || []).length || _tcProfiles.length) return;
  try {
    const r = await db.from('profiles').select('id,full_name');
    _tcProfiles = r.data || [];
  } catch (e) { /* RLS חוסם — יוצג "משתמש" */ }
}

/* ---------- עיצוב ---------- */
function tcEnsureStyles() {
  if (document.getElementById('teamChatStyles')) return;
  const s = document.createElement('style');
  s.id = 'teamChatStyles';
  s.textContent = `
  .tc-wrap{display:flex;gap:14px;height:calc(100vh - 150px);min-height:340px}
  .tc-side{width:210px;flex-shrink:0;background:#fff;border:1px solid var(--line);border-radius:14px;padding:8px;overflow-y:auto}
  .tc-side button{display:flex;align-items:center;gap:8px;width:100%;text-align:right;border:0;background:none;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:.93rem;color:var(--ink)}
  .tc-side button:hover{background:var(--bg)}
  .tc-side button.active{background:var(--brand);color:#fff}
  .tc-side .badge{margin-right:auto;background:var(--accent);color:#fff;font-size:.7rem;border-radius:99px;padding:1px 7px;font-weight:700}
  .tc-main{flex:1;display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .tc-head{padding:10px 16px;border-bottom:1px solid var(--line);font-weight:800;color:var(--brand)}
  .tc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:var(--bg)}
  .tc-msg{max-width:80%;border-radius:14px;padding:8px 12px;font-size:.93rem;line-height:1.45}
  .tc-mine{align-self:flex-start;background:var(--brand);color:#fff;border-bottom-right-radius:4px}
  .tc-other{align-self:flex-end;background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
  .tc-sys{align-self:center;background:#fffbe8;border:1px solid #f3e2ac;text-align:center;max-width:90%}
  .tc-msg .who{font-size:.72rem;font-weight:700;opacity:.85;margin-bottom:2px}
  .tc-msg .when{font-size:.68rem;opacity:.65;margin-top:3px;text-align:left}
  .tc-inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
  .tc-inputrow input{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:.95rem}
  @media(max-width:700px){.tc-wrap{flex-direction:column;height:auto}.tc-side{width:auto;display:flex;overflow-x:auto}.tc-side button{width:auto;white-space:nowrap}.tc-log{min-height:260px;max-height:50vh}}
  `;
  document.head.appendChild(s);
}

/* ---------- לא-נקראו ---------- */
async function tcRefreshUnread() {
  if (!tcAllowed()) return;
  try {
    const chans = tcChannels();
    const reads = await db.from('team_message_reads')
      .select('channel,last_read_at').eq('user_id', profile.id);
    const lr = {};
    (reads.data || []).forEach(r => lr[r.channel] = r.last_read_at);
    // שאילתה אחת לכל הערוצים במקום ספירה נפרדת פר ערוץ — ה-RLS כבר מסנן
    // לערוצים שמותר לראות, והספירה נעשית כאן בצד הלקוח. חוסך N שאילתות בכל טיק.
    let q = db.from('team_messages').select('channel,sender_user,created_at')
      .order('created_at', { ascending: false }).limit(300);
    // כשלכל הערוצים יש חותמת "נקרא" אפשר לצמצם את המשיכה מהמוקדמת שבהן;
    // ערוץ בלי חותמת מחייב את כל ההיסטוריה (עד תקרת ה-300 — הבאדג' ממילא ויזואלי)
    const stamps = chans.map(c => lr[c.id]);
    if (stamps.length && stamps.every(Boolean)) q = q.gt('created_at', stamps.sort()[0]);
    const r = await q;
    if (r.error) return;
    _tcUnread = {};
    chans.forEach(c => _tcUnread[c.id] = 0);
    (r.data || []).forEach(m => {
      if (m.sender_user === profile.id) return;           // שלי — לא "לא נקרא"
      if (!(m.channel in _tcUnread)) return;               // ערוץ שלא ברשימה שלי
      if (lr[m.channel] && m.created_at <= lr[m.channel]) return;
      _tcUnread[m.channel]++;
    });
    tcPaintBadges();
  } catch (e) { /* רשת/הרשאות — ננסה בטיק הבא */ }
}

function tcPaintBadges() {
  const total = Object.values(_tcUnread).reduce((s, n) => s + n, 0);
  const navBadge = document.getElementById('badge-team-chat');
  if (navBadge) {
    navBadge.textContent = total;
    navBadge.classList.toggle('hidden', !total);
  }
  Object.keys(_tcUnread).forEach(ch => {
    const b = document.getElementById('tcb-' + ch.replace(':', '-'));
    if (b) {
      b.textContent = _tcUnread[ch];
      b.classList.toggle('hidden', !_tcUnread[ch]);
    }
  });
}

async function tcMarkRead(channel) {
  try {
    await db.from('team_message_reads').upsert(
      { channel, user_id: profile.id, last_read_at: new Date().toISOString() },
      { onConflict: 'channel,user_id' });
    _tcUnread[channel] = 0;
    tcPaintBadges();
  } catch (e) { }
}

/* ---------- שרשור ההודעות ---------- */
async function tcLoadThread(scrollDown) {
  const log = document.getElementById('tcLog');
  if (!log || !_tcChannel) return;
  const r = await db.from('team_messages')
    .select('id,channel,sender_user,body,created_at')
    .eq('channel', _tcChannel)
    .order('id', { ascending: false }).limit(200);
  if (r.error) { log.innerHTML = '<div class="empty">שגיאה בטעינת ההודעות</div>'; return; }
  const msgs = (r.data || []).reverse();
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
  // רינדור מחדש רק כשיש הודעה חדשה — שלא נקפיץ את הגלילה בכל פולינג
  if (!scrollDown && Number(log.dataset.lastId || -1) === lastId) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const showWho = _tcChannel === 'group' || profile.role === 'admin';
  log.innerHTML = msgs.length ? msgs.map(m => {
    const mine = m.sender_user === profile.id;
    const sys = !m.sender_user; // הודעת מערכת (ברכת הבוקר וכד') — בועה ממורכזת
    return `<div class="tc-msg ${sys ? 'tc-sys' : mine ? 'tc-mine' : 'tc-other'}">
      ${sys ? '<div class="who">🌅 מערכת</div>' : (!mine && showWho) ? `<div class="who">${esc(tcSenderName(m.sender_user))}</div>` : ''}
      <div>${esc(m.body).replace(/\n/g, '<br>')}</div>
      <div class="when">${heDateTime(m.created_at)}</div>
    </div>`;
  }).join('') : '<div class="empty">אין הודעות עדיין — כתבו הודעה ראשונה 👋</div>';
  log.dataset.lastId = lastId;
  if (scrollDown || nearBottom) log.scrollTop = log.scrollHeight;
}

async function tcOpenChannel(id) {
  _tcChannel = id;
  tcRenderSide();
  const chans = tcChannels();
  const c = chans.find(x => x.id === id);
  const head = document.getElementById('tcHead');
  if (head) head.textContent = c ? (c.icon + ' ' + c.name) : '';
  const log = document.getElementById('tcLog');
  if (log) { log.dataset.lastId = ''; log.innerHTML = '<div class="empty">טוען...</div>'; }
  await tcLoadThread(true);
  await tcMarkRead(id);
  const inp = document.getElementById('tcInput');
  if (inp) inp.focus();
}

function tcRenderSide() {
  const side = document.getElementById('tcSide');
  if (!side) return;
  side.innerHTML = tcChannels().map(c => `
    <button class="${c.id === _tcChannel ? 'active' : ''}" onclick="tcOpenChannel('${escJs(c.id)}')">
      <span>${c.icon}</span> ${esc(c.name)}
      <span class="badge ${_tcUnread[c.id] ? '' : 'hidden'}" id="tcb-${esc(c.id.replace(':', '-'))}">${_tcUnread[c.id] || ''}</span>
    </button>`).join('');
}

/* ---------- שליחה ---------- */
async function tcSend() {
  const inp = document.getElementById('tcInput');
  const btn = document.getElementById('tcSendBtn');
  if (!inp || _tcBusy) return;
  const body = inp.value.trim();
  if (!body || !_tcChannel) return;
  _tcBusy = true;
  if (btn) btn.disabled = true;
  try {
    await run(db.from('team_messages').insert({
      channel: _tcChannel, sender_user: profile.id, body,
    }), 'שליחת ההודעה נכשלה');
    inp.value = '';
    await tcLoadThread(true);
    await tcMarkRead(_tcChannel);
  } catch (e) { /* toast הוצג ע"י run */ }
  _tcBusy = false;
  if (btn) btn.disabled = false;
  inp.focus();
}

/* ---------- הדף ---------- */
Pages['team-chat'] = {
  title: 'צ\'אט צוות',
  render: async (el) => {
    if (!tcAllowed()) { el.innerHTML = '<div class="empty">הדף זמין למנהל ולמכירות בלבד</div>'; return; }
    tcEnsureStyles();
    const chans = tcChannels();
    if (!_tcChannel || !chans.some(c => c.id === _tcChannel)) _tcChannel = chans[0].id;
    el.innerHTML = `<div class="tc-wrap">
      <div class="tc-side" id="tcSide"></div>
      <div class="tc-main">
        <div class="tc-head" id="tcHead"></div>
        <div class="tc-log" id="tcLog"></div>
        <div class="tc-inputrow">
          <input id="tcInput" placeholder="כתוב הודעה..." maxlength="2000"
                 onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();tcSend();}">
          <button class="btn" id="tcSendBtn" onclick="tcSend()">שלח</button>
        </div>
      </div>
    </div>`;
    await tcOpenChannel(_tcChannel);
    tcRefreshUnread();
  }
};

/* ---------- פולינג ---------- */
/* ריסון עומס על המסד (חבילת nano): טיק כל 30 שניות (היה 10). כשהדף פתוח —
   רענון השרשור + הבאדג'ים; "נקרא" נכתב רק כשבאמת יש חדש (לא כתיבה עיוורת
   בכל טיק). כשהדף סגור — רק הבאדג' בתפריט, אחת ל-3 דקות (כל טיק שישי).
   טאב ברקע לא שולח שאילתות בכלל — רוב היום הטאבים ברקע, וזה היה עיקר העומס. */
function tcPollTick() {
  if (!tcAllowed()) return;
  if (document.hidden) return; // טאב ברקע — אפס שאילתות; רענון מיידי בחזרה (ראה מאזין)
  _tcTick++;
  if (typeof currentPage !== 'undefined' && currentPage === 'team-chat') {
    tcLoadThread(false);
    tcRefreshUnread().then(() => {
      // כתיבת "נקרא" רק אם הצטברו לא-נקראו בערוץ הפתוח — חוסך upsert בכל טיק
      if (_tcChannel && currentPage === 'team-chat' && _tcUnread[_tcChannel] > 0) tcMarkRead(_tcChannel);
    });
  } else if (_tcTick % 6 === 0) {
    tcRefreshUnread();
  }
}

function teamChatInit() {
  if (!tcAllowed()) return;
  if (_tcTimer) clearInterval(_tcTimer);
  _tcTimer = setInterval(tcPollTick, 30 * 1000);
  if (!teamChatInit._visBound) {
    teamChatInit._visBound = true;
    // חזרה לטאב אחרי רקע — רענון מיידי במקום להמתין לטיק הבא
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && _tcTimer && tcAllowed()) {
        if (typeof currentPage !== 'undefined' && currentPage === 'team-chat') tcLoadThread(false);
        tcRefreshUnread();
      }
    });
  }
  tcLoadProfiles();
  tcRefreshUnread();
}

/* ---------- רישום בתפריט ואתחול (בלי לגעת ב-app.js) ---------- */
(function () {
  // שורה סטטית ב-NAV — buildShell כבר מסנן לפי תפקיד ויוצר badge-team-chat
  if (typeof NAV !== 'undefined' && !NAV.some(n => n.id === 'team-chat')) {
    const item = { id: 'team-chat', title: 'צ\'אט צוות', icon: '💬', roles: ['admin', 'sales', 'editor', 'graphics'], group: '' };
    const idx = NAV.findIndex(n => n.id === 'dash');
    if (idx >= 0) NAV.splice(idx + 1, 0, item); else NAV.push(item);
  }
  // התנעה אחרי התחברות — עטיפת refreshCache, באותו דפוס של שאר מודולי הצ'אט
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._teamChatWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { setTimeout(teamChatInit, 3000); } catch (e) { }
      return r;
    };
    wrapped._teamChatWrapped = true;
    window.refreshCache = wrapped;
  }
})();
