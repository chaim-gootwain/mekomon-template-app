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
let _tcImg = null;       // צילום מסך שמחכה לשליחה (File)
const _tcImgUrls = {};   // נתיב באחסון -> קישור חתום (מטמון)
/* תמונה בהודעה נשמרת בגוף ההודעה כסמן [img:<נתיב>] — הקובץ עצמו בדלי ad-files
   תחת team-chat/ (העלאה מותרת לכל הצוות לפי files_insert, צפייה לצוות) */
const _TC_IMG_RE = /\[img:([^\]\n]+)\]/g;

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
  // ערוץ "בעיות לתיקון": עורך/גרפיקה/סוכנים מדווחים למנהל על תקלות ושיפורים במערכת
  // (מיגרציות 2026-11-25_team_chat_fixes_channel.sql + 2026-11-25_fixes_channel_sales.sql)
  if (['admin', 'editor', 'graphics', 'sales'].includes(profile.role)) out.push({ id: 'fixes', name: 'בעיות לתיקון', icon: '🛠' });
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
  .tc-img{display:block;max-width:min(320px,100%);max-height:260px;border-radius:10px;margin-top:6px;cursor:zoom-in;background:#eef1f7;min-height:40px}
  .tc-imgprev{display:flex;align-items:center;gap:10px;padding:8px 10px 0}
  .tc-imgprev img{height:56px;border-radius:8px;border:1px solid var(--line)}
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
  const showWho = _tcChannel === 'group' || _tcChannel === 'fixes' || profile.role === 'admin';
  log.innerHTML = msgs.length ? msgs.map(m => {
    const mine = m.sender_user === profile.id;
    const sys = !m.sender_user; // הודעת מערכת (ברכת הבוקר וכד') — בועה ממורכזת
    return `<div class="tc-msg ${sys ? 'tc-sys' : mine ? 'tc-mine' : 'tc-other'}">
      ${sys ? '<div class="who">🌅 מערכת</div>' : (!mine && showWho) ? `<div class="who">${esc(tcSenderName(m.sender_user))}</div>` : ''}
      <div>${tcBodyHtml(m.body)}</div>
      <div class="when">${heDateTime(m.created_at)}</div>
    </div>`;
  }).join('') : '<div class="empty">אין הודעות עדיין — כתבו הודעה ראשונה 👋</div>';
  log.dataset.lastId = lastId;
  if (scrollDown || nearBottom) log.scrollTop = log.scrollHeight;
  tcHydrateImgs(log, scrollDown || nearBottom);
}

/* גוף הודעה: טקסט + תמונות (הסמן [img:...] מוסר מהטקסט ומוצג כתמונה) */
function tcBodyHtml(body) {
  const raw = String(body || '');
  const paths = [...raw.matchAll(_TC_IMG_RE)].map(x => x[1]);
  const text = raw.replace(_TC_IMG_RE, '').trim();
  return esc(text).replace(/\n/g, '<br>') +
    paths.map(p => `<img class="tc-img" data-path="${esc(p)}" alt="צילום מסך" onclick="tcOpenImg(this)">`).join('');
}
async function tcHydrateImgs(log, stick) {
  const imgs = [...log.querySelectorAll('img.tc-img:not([src])')];
  for (const im of imgs) {
    const p = im.dataset.path;
    try {
      if (!_tcImgUrls[p]) {
        const { data } = await db.storage.from('ad-files').createSignedUrl(p, 3600);
        if (data && data.signedUrl) _tcImgUrls[p] = data.signedUrl;
      }
      if (_tcImgUrls[p]) {
        if (stick) im.onload = () => { log.scrollTop = log.scrollHeight; };
        im.src = _tcImgUrls[p];
      } else im.alt = '(התמונה לא נמצאה)';
    } catch (e) { im.alt = '(התמונה לא נטענה)'; }
  }
}
function tcOpenImg(im) { if (im && im.src) window.open(im.src, '_blank', 'noopener'); }

/* בחירת / הדבקת צילום מסך */
function tcPickImg(f) {
  if (!f) return;
  if (!/^image\//.test(f.type || '')) { toast('אפשר לצרף רק תמונה', true); return; }
  if (f.size > 8 * 1024 * 1024) { toast('התמונה גדולה מדי (עד 8MB)', true); return; }
  _tcImg = f;
  tcRenderImgPrev();
  const inp = document.getElementById('tcInput'); if (inp) inp.focus();
}
function tcPaste(ev) {
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      ev.preventDefault();
      const f = it.getAsFile();
      if (f) tcPickImg(new File([f], 'screenshot.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type }));
      return;
    }
  }
}
function tcClearImg() { _tcImg = null; tcRenderImgPrev(); }
function tcRenderImgPrev() {
  const box = document.getElementById('tcImgPrev'); if (!box) return;
  if (!_tcImg) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  const url = URL.createObjectURL(_tcImg);
  box.classList.remove('hidden');
  box.innerHTML = `<img src="${url}" alt="תצוגה מקדימה"><span class="muted" style="font-size:.82rem">צילום מסך מצורף</span>
    <button class="btn btn-sm btn-ghost" onclick="tcClearImg()" title="הסרה">✕</button>`;
}
async function tcUploadImg(img, channel) {
  const ext = ((img.name || '').split('.').pop() || (img.type.split('/')[1] || 'png')).replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
  const path = `team-chat/${String(channel).replace(/[^a-z0-9_-]/gi, '-')}/${profile.id}/${Date.now()}.${ext}`;
  const up = await db.storage.from('ad-files').upload(path, img, { contentType: img.type || 'image/png' });
  if (up.error) { toast('העלאת התמונה נכשלה: ' + up.error.message, true); throw up.error; }
  return path;
}
function _tcFileB64(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
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

/* ערוץ "בעיות לתיקון": כל הודעה נשלחת גם במייל (ברקע — כשל במייל לא מפיל את הצ'אט).
   הנושא קבוע ("[בעיות לתיקון]") כדי שאפשר יהיה לסנן/לחפש את המיילים. */
function tcFixesNotify(body, imgFile) {
  try {
    const who = profile.full_name || 'משתמש';
    const subject = '[בעיות לתיקון] @@PAPER_NAME@@ — ' + who;
    const clean = String(body || '').replace(_TC_IMG_RE, '').trim();
    const text = `דיווח חדש בערוץ "בעיות לתיקון"\nמאת: ${who}\nזמן: ${new Date().toLocaleString('he-IL')}\n\n${clean}${imgFile ? '\n\n(צילום מסך מצורף)' : ''}`;
    // תוצאה גלויה למשתמש — כשל שקט הסתיר תקלות במייל (25.11.2026)
    const fail = (m) => toast('ההודעה נשמרה, אבל המייל לא נשלח: ' + m, true);
    // הכתובת נקראת מהשרת (get_fixes_notify_email, מיגרציה 2026-11-25_fixes_notify_email_rpc):
    // לגרפיקה אין הרשאת קריאה להגדרות, והמייל נפל לכתובת העיתון במקום לכתובת שהוגדרה
    let to = '';
    const pick = async () => {
      try { const { data, error } = await db.rpc('get_fixes_notify_email'); if (!error && data) to = String(data).trim(); } catch (_e) { }
      if (!to) to = String((cache.settings || {}).fixes_notify_email || '').trim() || '@@PAPER_EMAIL@@';
    };
    let attachments = [];
    const prep = async () => {
      await pick();
      if (imgFile) {
        try { attachments = [{ filename: imgFile.name || 'screenshot.png', content: await _tcFileB64(imgFile), contentType: imgFile.type || 'image/png' }]; }
        catch (_e) { /* בלי צירוף — התמונה עדיין בצ'אט */ }
      }
    };
    prep().then(() => db.functions.invoke('send-email', { body: { to, subject, body: text, attachments } }))
      .then(async r => {
        if (r && r.error) {
          let m = r.error.message || 'שגיאה';
          try { const j = await r.error.context.json(); if (j && j.error) m = j.error; } catch (_e) { }
          fail(m); return;
        }
        if (r && r.data && r.data.ok === false) { fail(r.data.error || 'שגיאה'); return; }
        toast('✓ נשלח גם במייל ל-' + to);
      })
      .catch(e => fail(e.message || String(e)));
  } catch (e) { toast('המייל לא נשלח: ' + (e.message || e), true); }
}

/* ---------- שליחה ---------- */
async function tcSend() {
  const inp = document.getElementById('tcInput');
  const btn = document.getElementById('tcSendBtn');
  if (!inp || _tcBusy) return;
  let body = inp.value.trim();
  const img = _tcImg;
  if ((!body && !img) || !_tcChannel) return;
  _tcBusy = true;
  if (btn) btn.disabled = true;
  try {
    if (img) body = (body || '📷 צילום מסך') + '\n[img:' + await tcUploadImg(img, _tcChannel) + ']';
    await run(db.from('team_messages').insert({
      channel: _tcChannel, sender_user: profile.id, body,
    }), 'שליחת ההודעה נכשלה');
    inp.value = '';
    _tcImg = null; tcRenderImgPrev();
    if (_tcChannel === 'fixes') tcFixesNotify(body, img);
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
        <div id="tcImgPrev" class="tc-imgprev hidden"></div>
        <div class="tc-inputrow">
          <button class="btn btn-ghost" type="button" title="צירוף צילום מסך (או הדבקה עם Ctrl+V)" aria-label="צירוף צילום מסך" onclick="document.getElementById('tcFile').click()">📎</button>
          <input type="file" id="tcFile" accept="image/*" style="display:none" onchange="tcPickImg(this.files[0]);this.value=''">
          <input id="tcInput" placeholder="כתוב הודעה... (אפשר להדביק צילום מסך)" maxlength="2000"
                 onpaste="tcPaste(event)"
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
  fxBubbleInit();
}

/* ==================== בועת "דיווח על בעיה" ====================
   בועה צפה קטנה בכל דף (לתפקידים שרואים את ערוץ "בעיות לתיקון").
   לחיצה: צילום אוטומטי של המסך הנוכחי (html2canvas — בלי חלון הרשאה של הדפדפן),
   ואז חלון קטן: תיאור הבעיה + שליחה. ההודעה נכנסת לערוץ fixes עם הצילום,
   שם הדף, ונשלחת גם במייל (tcFixesNotify) — בדיוק כמו שליחה מהצ'אט. */
let _fxShot = null; // File של הצילום
function fxAllowed() { return profile && ['admin', 'editor', 'graphics', 'sales'].includes(profile.role); }
function fxEnsureCss() {
  if (document.getElementById('fxCss')) return;
  const st = document.createElement('style'); st.id = 'fxCss';
  st.textContent = `
  #fxBubble{position:fixed;left:18px;bottom:18px;z-index:900;width:52px;height:52px;border-radius:50%;border:0;cursor:pointer;
    background:var(--brand);color:#fff;font-size:1.35rem;box-shadow:0 6px 18px rgba(15,23,42,.28);display:flex;align-items:center;justify-content:center;transition:transform .15s}
  #fxBubble:hover{transform:scale(1.07)}
  #fxBubble:focus-visible{outline:3px solid var(--brand-light);outline-offset:2px}
  #fxBubble[disabled]{opacity:.6;cursor:wait}
  #fxPanel{position:fixed;left:18px;bottom:80px;z-index:901;width:min(360px,calc(100vw - 36px));background:#fff;border:1px solid var(--line);
    border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.25);padding:14px;display:none}
  #fxPanel.open{display:block}
  #fxPanel h4{margin:0 0 8px;color:var(--brand-dark);font-size:1rem;display:flex;justify-content:space-between;align-items:center}
  #fxPanel .fx-shot{position:relative;margin-bottom:8px}
  #fxPanel .fx-shot img{width:100%;max-height:170px;object-fit:contain;border:1px solid var(--line);border-radius:10px;background:var(--bg);cursor:zoom-in}
  #fxPanel .fx-shot button{position:absolute;top:6px;left:6px}
  #fxPanel textarea{width:100%;box-sizing:border-box;min-height:80px;resize:vertical}
  #fxPanel .fx-row{display:flex;gap:8px;margin-top:8px;align-items:center}
  @media print{#fxBubble,#fxPanel{display:none!important}}`;
  document.head.appendChild(st);
}
function fxBubbleInit() {
  if (!fxAllowed() || document.getElementById('fxBubble')) return;
  fxEnsureCss();
  const b = document.createElement('button');
  b.id = 'fxBubble'; b.type = 'button';
  b.title = 'דיווח על בעיה — מצלם את המסך אוטומטית';
  b.setAttribute('aria-label', 'דיווח על בעיה');
  b.textContent = '🛠';
  b.onclick = fxOpen;
  const p = document.createElement('div');
  p.id = 'fxPanel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'דיווח על בעיה');
  document.body.append(b, p);
}
function _fxLoadH2C() {
  if (window.html2canvas) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = 'js/vendor/html2canvas.min.js';
    sc.onload = res; sc.onerror = () => rej(new Error('html2canvas'));
    document.head.appendChild(sc);
  });
}
async function fxCapture() {
  await _fxLoadH2C();
  const canvas = await window.html2canvas(document.body, {
    x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
    windowWidth: document.documentElement.clientWidth,
    scale: Math.min(window.devicePixelRatio || 1, 1.5), useCORS: true, logging: false,
    ignoreElements: el => el.id === 'fxBubble' || el.id === 'fxPanel',
  });
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return blob ? new File([blob], 'screenshot.jpg', { type: 'image/jpeg' }) : null;
}
function _fxPageName() {
  try {
    const n = (typeof NAV !== 'undefined' && NAV.find(x => x.id === currentPage)) || null;
    return (document.getElementById('pageTitle') || {}).textContent || (n && n.title) || currentPage || '';
  } catch (e) { return ''; }
}
async function fxOpen() {
  const b = document.getElementById('fxBubble'), p = document.getElementById('fxPanel');
  if (!b || !p) return;
  if (p.classList.contains('open')) { fxClose(); return; }
  b.disabled = true; b.textContent = '⏳';
  _fxShot = null;
  try { _fxShot = await fxCapture(); }
  catch (e) { console.warn('fx capture', e); toast('הצילום האוטומטי לא הצליח — אפשר לשלוח בלי צילום', true); }
  b.disabled = false; b.textContent = '🛠';
  fxRender();
  p.classList.add('open');
  const ta = document.getElementById('fxText'); if (ta) ta.focus();
}
function fxClose() { const p = document.getElementById('fxPanel'); if (p) p.classList.remove('open'); _fxShot = null; }
function fxRender() {
  const p = document.getElementById('fxPanel'); if (!p) return;
  const url = _fxShot ? URL.createObjectURL(_fxShot) : '';
  p.innerHTML = `<h4><span>🛠 דיווח על בעיה</span><button class="btn btn-sm btn-ghost" onclick="fxClose()" aria-label="סגירה">✕</button></h4>
    ${_fxShot ? `<div class="fx-shot"><img src="${url}" alt="צילום המסך" onclick="window.open(this.src,'_blank','noopener')">
      <button class="btn btn-sm" onclick="_fxShot=null;fxRender()" title="שליחה בלי הצילום">✕</button></div>`
      : '<p class="muted" style="font-size:.82rem;margin:0 0 8px">בלי צילום מסך</p>'}
    <textarea id="fxText" placeholder="מה הבעיה? מה ניסית לעשות ומה קרה?" maxlength="2000"></textarea>
    <div class="fx-row"><button class="btn" id="fxSend" onclick="fxSend()">שליחה</button>
      <span class="muted" style="font-size:.75rem">נשלח לערוץ "בעיות לתיקון" · דף: ${esc(_fxPageName())}</span></div>`;
}
async function fxSend() {
  const ta = document.getElementById('fxText'), btn = document.getElementById('fxSend');
  const text = (ta && ta.value || '').trim();
  if (!text && !_fxShot) { toast('כתוב מה הבעיה', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'שולח...'; }
  const img = _fxShot;
  try {
    const page = _fxPageName();
    let body = (text || '📷 צילום מסך') + (page ? '\n📍 דף: ' + page : '');
    if (img) body += '\n[img:' + await tcUploadImg(img, 'fixes') + ']';
    await run(db.from('team_messages').insert({ channel: 'fixes', sender_user: profile.id, body }), 'שליחת הדיווח נכשלה');
    tcFixesNotify(body, img);
    fxClose();
    toast('✓ הדיווח נשלח');
    if (typeof currentPage !== 'undefined' && currentPage === 'team-chat' && _tcChannel === 'fixes') tcLoadThread(true);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'שליחה'; }
  }
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
