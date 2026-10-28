/* ============================================================
agent-bar.js — "פאנל הביצועים היומי" של סוכן המכירות
------------------------------------------------------------
פס קבוע בראש המסך (מתחת לסרגל העליון) שהסוכן רואה כל הזמן:
  שיחות · נענו · לא נענו · זמן שיחה · לידים שטופלו · שינויי סטטוס ·
  הערות · אחוז המרה שיחה→פגישה — של היום, וליד כל מדד מה היה אתמול.
  בצד: ציון יומי בצבע ("מצוין" / "ראוי לשבח" / "דרוש טיפול" / "על הפנים")
  והשוואת היום מול אתמול.

מקורות:
• שיחות, נענו/לא נענו, זמן שיחה — Voicenter (Edge ‏voicenter-stats,
  לפי השלוחה agents.voicenter_ext). אם Voicenter לא מוגדר/נכשל — מספר
  השיחות נלקח מ-call_log (לחיצות "חייג"), ונענו/זמן מוצגים "—".
• לידים שטופלו — לידים ייחודיים שהסוכן נגע בהם היום: שינוי בליד
  (audit_log), הערה על ליד (interactions) או חיוג לליד (call_log).
• שינויי סטטוס — עדכוני status של לידים (audit_log).
• הערות — רשומות interactions שהסוכן כתב.
• פגישה — ליד שהסוכן העביר לסטטוס "במשא ומתן" (meeting) היום.
  המרה = פגישות ÷ שיחות שנענו (ובלי Voicenter — ÷ שיחות).
• הציון — אותו מדד פרודוקטיביות 1–10 של "ביצועי סוכנים"
  (apWeights/apPoints/apDayScore מ-agent-perf.js, נטען לפניו ב-ORDER),
  לפי שעות הנוכחות של אותו יום. בלי שעות נוכחות — אין ציון.

כל סוכן רואה רק את הנתונים של עצמו (שאילתות לפי המשתמש + RLS).
מוצג לתפקיד sales, ולמנהל שיש לו כרטיס סוכן. כיבוי: settings
agent_bar_enabled = '0'. רענון: נתוני המערכת כל דקה, Voicenter כל
3 דקות (מגבלת ה-API), רק כשהלשונית פעילה.

שיחות חוזרות + "חייג שוב" (28.10.2026):
voicenter-stats נקרא עם detail ומחזיר גם רשימת שיחות — יוצאות של
הסוכן + נכנסות (לכל הארגון) ממספרים שהסוכן חייג אליהם אתמול/היום.
לחיצה על "לא נענו" פותחת את "השיחות שלי": פר מספר — שם הלקוח/הליד,
סטטוס אחרון (לא ענה / חזר אליך ולא נענה / חזר ודיברתם / נענה),
וכפתור "📞 חייג שוב" (phoneCall הרגיל — פונקציית החיוג לא שונתה). לקוח שחזר
ולא נענה מסומן 🔔 על הפס, וכשמגיעה שיחה חוזרת חדשה קופצת הודעה.
בלי Voicenter — הרשימה נבנית מ-call_log (בלי סטטוס ובלי שיחות חוזרות).
============================================================ */

'use strict';

const AB_LEVELS = [
  { min: 8, label: 'מצוין', icon: '🏆', bg: '#16a34a', soft: '#dcfce7' },
  { min: 6, label: 'ראוי לשבח', icon: '👏', bg: '#0284c7', soft: '#e0f2fe' },
  { min: 4, label: 'דרוש טיפול', icon: '⚠️', bg: '#d97706', soft: '#fef3c7' },
  { min: 0, label: 'על הפנים', icon: '🚨', bg: '#dc2626', soft: '#fee2e2' },
];
function abLevel(score) {
  if (score == null) return null;
  return AB_LEVELS.find(l => score >= l.min);
}

let _abTimer = null, _abVcAt = 0, _abVc = null, _abData = null, _abBusy = false;
let _abCalls = [], _abCbSeen = null, _abCallsTab = 'todo';

function _abD(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _abFmtTalk(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} דק'`;
}
function _abMe() {
  return (cache.agents || []).find(a => a.profile_id === profile?.id) || null;
}

/* נקרא מ-app.js אחרי הכניסה */
function agentBarInit() {
  try {
    if (!profile || !['sales', 'admin'].includes(profile.role)) return;
    if (String(cache.settings?.agent_bar_enabled ?? '1') === '0') return;
    if (!_abMe()) return;
    if (!document.getElementById('agentBar')) {
      const top = document.querySelector('#app .topbar');
      if (!top) return;
      const bar = document.createElement('div');
      bar.id = 'agentBar';
      top.insertAdjacentElement('afterend', bar);
      const stick = () => { bar.style.top = top.offsetHeight + 'px'; };
      stick(); window.addEventListener('resize', stick);
      _abInjectCss();
      bar.innerHTML = `<div class="ab-wrap"><div class="ab-loading">טוען את הביצועים שלך...</div></div>`;
    }
    agentBarRefresh();
    clearInterval(_abTimer);
    _abTimer = setInterval(() => { if (!document.hidden) agentBarRefresh(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) agentBarRefresh(); });
  } catch (e) { console.error('agent-bar', e); }
}

async function agentBarRefresh(forceVc) {
  if (_abBusy) return;
  _abBusy = true;
  try {
    const me = _abMe(); if (!me) return;
    const now = new Date();
    const t = _abD(now);
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    const y = _abD(yd);
    const fromTs = new Date(y + 'T00:00:00').toISOString();
    const safe = p => p.catch(() => []);
    const uid = profile.id;

    const vcDue = forceVc || !_abVc || Date.now() - _abVcAt > 180000;
    const vcP = vcDue
      ? db.functions.invoke('voicenter-stats', { body: { from: y, to: t, detail: true } })
        .then(r => (r.data && r.data.ok) ? r.data : { ok: false, error: r.data?.error || r.error?.message })
        .catch(e => ({ ok: false, error: String(e?.message || e) }))
      : Promise.resolve(_abVc);

    const [calls, att, audit, notes, quotes, vc] = await Promise.all([
      safe(runAll((f, to) => db.from('call_log').select('created_at,target,entity_type,entity_id').eq('user_id', uid).gte('created_at', fromTs).order('id').range(f, to), 'שיחות')),
      safe(runAll((f, to) => db.from('attendance').select('clock_in,clock_out').eq('profile_id', uid).gte('clock_in', fromTs).order('id').range(f, to), 'נוכחות')),
      safe(runAll((f, to) => db.from('audit_log').select('table_name,row_id,action,field,new_value,at').eq('user_id', uid).in('table_name', ['leads', 'charges', 'payments']).gte('at', fromTs).order('id').range(f, to), 'פעולות')),
      safe(runAll((f, to) => db.from('interactions').select('entity_type,entity_id,created_at').eq('user_id', uid).gte('created_at', fromTs).order('id').range(f, to), 'הערות')),
      safe(runAll((f, to) => db.from('quotes').select('created_at').eq('created_by', uid).gte('created_at', fromTs).order('id').range(f, to), 'הצעות')),
      vcP,
    ]);
    if (vcDue) { _abVc = vc; _abVcAt = Date.now(); }

    const B = () => ({
      calls: 0, answered: null, unanswered: null, talk: null, leads: new Set(), statusCh: 0, notes: 0, meetings: 0,
      leadNotes: 0, custNotes: 0, newLeads: 0, statusAdv: 0, quotes: 0, chargesIns: 0, paymentsIns: 0, closings: 0, hours: 0,
    });
    const D = { [t]: B(), [y]: B() };
    const dayOf = ts => _abD(new Date(ts));
    const at = (ts) => D[dayOf(ts)];

    calls.forEach(c => { const b = at(c.created_at); if (!b) return; b.calls++; if (c.entity_type === 'lead' && c.entity_id) b.leads.add(Number(c.entity_id)); });
    notes.forEach(n => {
      const b = at(n.created_at); if (!b) return;
      b.notes++;
      if (n.entity_type === 'lead') { b.leadNotes++; if (n.entity_id) b.leads.add(Number(n.entity_id)); } else b.custNotes++;
    });
    quotes.forEach(q => { const b = at(q.created_at); if (b) b.quotes++; });
    audit.forEach(r => {
      const b = at(r.at); if (!b) return;
      if (r.table_name === 'leads') {
        if (r.row_id) b.leads.add(Number(r.row_id));
        if (r.action === 'insert') b.newLeads++;
        else if (r.action === 'update' && r.field === 'status') {
          b.statusCh++;
          if (r.new_value === 'meeting') b.meetings++;
          if (r.new_value === 'won') b.closings++;
          else if (typeof AP_STATUS_ADV !== 'undefined' && AP_STATUS_ADV.includes(r.new_value)) b.statusAdv++;
        }
      } else if (r.action === 'insert') {
        if (r.table_name === 'charges') b.chargesIns++; else b.paymentsIns++;
      }
    });
    att.forEach(r => {
      const b = at(r.clock_in); if (!b) return;
      const ms = (r.clock_out ? Date.parse(r.clock_out) : Date.now()) - Date.parse(r.clock_in);
      if (ms > 0) b.hours += ms / 3600000;
    });

    /* Voicenter גובר על call_log כשהוא זמין */
    const vcOk = !!(vc && vc.ok);
    if (vcOk) {
      [t, y].forEach(d => {
        const v = vc.days?.[d] || { calls: 0, answered: 0, unanswered: 0, talk_sec: 0 };
        D[d].calls = v.calls; D[d].answered = v.answered; D[d].unanswered = v.unanswered; D[d].talk = v.talk_sec;
      });
    }

    const W = typeof apWeights === 'function' ? apWeights() : { call: 1, note: 1, status: 2, quote: 3, charge: 3, payment: 3, close: 8, target: 10 };
    [t, y].forEach(d => {
      const b = D[d];
      b.score = (typeof apPoints === 'function' && typeof apDayScore === 'function') ? apDayScore(apPoints(b, W), b.hours, W) : null;
      const base = vcOk ? b.answered : b.calls;
      b.conv = base > 0 ? Math.round(b.meetings / base * 100) : null;
    });
    _abCalls = _abBuildCalls(calls, vcOk ? vc.calls : null);
    _abNotifyCallbacks();
    _abData = { today: D[t], yest: D[y], vcOk, vcErr: vcOk ? null : vc?.error };
    _abRender();
    if (document.getElementById('abCallsOv')) abCallsRender();
  } catch (e) { console.error('agent-bar', e); }
  finally { _abBusy = false; }
}

function _abRender() {
  const bar = document.getElementById('agentBar');
  if (!bar || !_abData) return;
  const { today: T, yest: Y, vcOk, vcErr } = _abData;
  let collapsed = false;
  try { collapsed = localStorage.getItem('agentBarCollapsed') === '1'; } catch (e) { }

  const delta = (a, b, lowerBetter) => {
    if (a == null || b == null) return '';
    const d = a - b;
    if (!d) return `<span class="ab-dl eq">=</span>`;
    const good = lowerBetter ? d < 0 : d > 0;
    return `<span class="ab-dl ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}</span>`;
  };
  const vcTip = vcOk ? '' : ` title="${esc('לא מחובר ל-Voicenter' + (vcErr ? ': ' + vcErr : ''))}"`;
  const tile = (icon, label, val, yVal, cmp, opts = {}) => `
    <div class="ab-tile${opts.cls ? ' ' + opts.cls : ''}"${opts.tip || ''}${opts.click ? ` onclick="${opts.click}" role="button"` : ''}>
      <div class="ab-lbl">${icon} ${label}${opts.badge || ''}</div>
      <div class="ab-val">${val}${cmp}</div>
      <div class="ab-y">אתמול: ${yVal}</div>
    </div>`;

  const n = v => v == null ? '—' : v;
  const cbN = _abCalls.filter(r => r.state === 'cb_missed').length;
  const pct = v => v == null ? '—' : v + '%';
  const tiles = [
    tile('📞', 'שיחות', n(T.calls), n(Y.calls), delta(T.calls, Y.calls)),
    tile('✅', 'נענו', n(T.answered), n(Y.answered), delta(T.answered, Y.answered), { tip: vcTip }),
    tile('📵', 'לא נענו', n(T.unanswered), n(Y.unanswered), '', {
      cls: 'muted-tile ab-click', click: 'abCallsOpen()',
      tip: ` title="${esc('השיחות שלי — מי לא ענה, מי חזר אליך, חייג שוב' + (vcOk ? '' : ' (לא מחובר ל-Voicenter' + (vcErr ? ': ' + vcErr : '') + ')'))}"`,
      badge: cbN ? ` <span class="ab-cb">🔔${cbN}</span>` : '',
    }),
    tile('⏱️', 'זמן שיחה', _abFmtTalk(T.talk), _abFmtTalk(Y.talk), delta(T.talk, Y.talk), { tip: vcTip }),
    tile('👥', 'לידים שטופלו', T.leads.size, Y.leads.size, delta(T.leads.size, Y.leads.size)),
    tile('🔄', 'שינויי סטטוס', T.statusCh, Y.statusCh, delta(T.statusCh, Y.statusCh)),
    tile('📝', 'הערות', T.notes, Y.notes, delta(T.notes, Y.notes)),
    tile('🎯', 'שיחה ← פגישה', pct(T.conv), pct(Y.conv), delta(T.conv, Y.conv), { cls: 'ab-conv', tip: ` title="${T.meetings} פגישות היום"` }),
  ].join('');

  const lvT = abLevel(T.score), lvY = abLevel(Y.score);
  const scoreCard = lvT
    ? `<div class="ab-score" style="background:${lvT.bg}">
         <div class="ab-score-ic">${lvT.icon}</div>
         <div><div class="ab-score-lb">${lvT.label}</div><div class="ab-score-n">ציון היום ${T.score}/10</div></div>
       </div>`
    : `<div class="ab-score ab-score-none"><div class="ab-score-ic">⏱️</div>
         <div><div class="ab-score-lb">עוד אין ציון</div><div class="ab-score-n">הציון נפתח עם שעון הנוכחות</div></div></div>`;
  const vsCard = `<div class="ab-vs">
      <div class="ab-vs-h">היום מול אתמול</div>
      <div class="ab-vs-row"><span>היום</span>${lvT ? `<span class="ab-pill" style="background:${lvT.soft};color:${lvT.bg}">${lvT.label} · ${T.score}</span>` : '<span class="ab-pill">—</span>'}</div>
      <div class="ab-vs-row"><span>אתמול</span>${lvY ? `<span class="ab-pill" style="background:${lvY.soft};color:${lvY.bg}">${lvY.label} · ${Y.score}</span>` : '<span class="ab-pill">—</span>'}</div>
    </div>`;

  bar.innerHTML = `<div class="ab-wrap${collapsed ? ' ab-collapsed' : ''}">
    ${scoreCard}
    <div class="ab-tiles">${tiles}</div>
    ${vsCard}
    <div class="ab-tools">
      <button title="רענון" onclick="agentBarRefresh(true)">↻</button>
      <button title="${collapsed ? 'הרחב' : 'כווץ'}" onclick="agentBarToggle()">${collapsed ? '▾' : '▴'}</button>
    </div>
  </div>`;
}

/* ---------- השיחות שלי: מי לא ענה, מי חזר, חייג שוב ---------- */
const AB_CALL_ST = {
  cb_missed: '🔔 חזר אליך — לא נענה',
  cb_answered: '✅ חזר אליך — נענה',
  no_answer: '📵 לא ענה',
  answered: '✅ נענה',
  dialed: '📞 חויג',
};
const AB_CALL_RANK = { cb_missed: 0, no_answer: 1, dialed: 2, cb_answered: 3, answered: 4 };
let _abLeadNames = {};

/* שורה פר מספר. logRows — call_log (לייחוס לקוח/ליד), vcCalls — מ-voicenter-stats (או null) */
function _abBuildCalls(logRows, vcCalls) {
  const ent = {};
  (logRows || []).forEach(r => {
    const num = normPhone(r.target);
    if (num && r.entity_type && r.entity_id != null) ent[num] = { type: r.entity_type, id: Number(r.entity_id) };
  });
  const by = {};
  const row = num => by[num] ||= { number: num, outs: 0, ins: 0, inIds: [], last: null };
  if (vcCalls) {
    vcCalls.forEach(c => {
      const r = row(c.number);
      if (c.dir === 'in') { r.ins++; if (c.id) r.inIds.push(c.id); } else r.outs++;
      if (!r.last || c.at >= r.last.at) r.last = c;
    });
  } else {
    (logRows || []).forEach(l => {
      const num = normPhone(l.target); if (!num) return;
      const r = row(num); r.outs++;
      const at = Date.parse(l.created_at) / 1000;
      if (!r.last || at >= r.last.at) r.last = { at, dir: 'out', answered: null };
    });
  }
  const custBy = {};
  (cache.customers || []).forEach(c => [c.phone, c.whatsapp].forEach(p => { const n = normPhone(p); if (n && !custBy[n]) custBy[n] = c.id; }));
  return Object.values(by).map(r => {
    const L = r.last;
    r.state = L.answered == null ? 'dialed'
      : L.dir === 'in' ? (L.answered ? 'cb_answered' : 'cb_missed')
        : (L.answered ? 'answered' : 'no_answer');
    r.at = L.at;
    r.ent = ent[r.number] || (custBy[r.number] != null ? { type: 'customer', id: custBy[r.number] } : null);
    return r;
  }).sort((a, b) => (AB_CALL_RANK[a.state] - AB_CALL_RANK[b.state]) || (b.at - a.at));
}

function _abCallName(r) {
  if (!r.ent) return '';
  if (r.ent.type === 'customer') return nameOf('customers', r.ent.id) || 'לקוח #' + r.ent.id;
  const l = (typeof _leads !== 'undefined' ? _leads : []).find(x => x.id === r.ent.id);
  return (l && l.name) || _abLeadNames[r.ent.id] || 'ליד #' + r.ent.id;
}

/* הודעה קופצת כשנכנסת שיחה חוזרת חדשה (לא בטעינה הראשונה) */
function _abNotifyCallbacks() {
  const fresh = [];
  const ids = new Set();
  _abCalls.forEach(r => r.inIds.forEach(id => {
    ids.add(id);
    if (_abCbSeen && !_abCbSeen.has(id)) fresh.push(r);
  }));
  const first = !_abCbSeen;
  _abCbSeen = ids;
  if (first || !fresh.length) return;
  const r = fresh[0];
  const who = _abCallName(r) || r.number;
  toast(fresh.length > 1 ? `🔔 ${fresh.length} לקוחות חזרו אליך — ראה "לא נענו"` : `🔔 ${who} חזר/ה אליך${r.state === 'cb_missed' ? ' (לא נענה)' : ''}`);
}

async function abCallsOpen() {
  if (typeof emuEnsureStyles === 'function') emuEnsureStyles();
  let ov = document.getElementById('abCallsOv');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'abCallsOv';
    ov.className = 'emu-overlay';
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }
  abCallsRender();
  /* שמות לידים שלא במטמון */
  const miss = [...new Set(_abCalls.filter(r => r.ent?.type === 'lead' && !_abLeadNames[r.ent.id]).map(r => r.ent.id))]
    .filter(id => !(typeof _leads !== 'undefined' && _leads.some(x => x.id === id)));
  if (miss.length) {
    try {
      const { data } = await db.from('leads').select('id,name').in('id', miss);
      (data || []).forEach(l => { _abLeadNames[l.id] = l.name; });
      abCallsRender();
    } catch (e) { console.error('agent-bar leads', e); }
  }
}

function abCallsTab(t) { _abCallsTab = t; abCallsRender(); }

function abCallsRender() {
  const ov = document.getElementById('abCallsOv'); if (!ov) return;
  const todo = _abCalls.filter(r => r.state === 'cb_missed' || r.state === 'no_answer' || r.state === 'dialed');
  const list = _abCallsTab === 'todo' ? todo : _abCalls;
  const today = _abD(new Date());
  const when = at => {
    const d = new Date(at * 1000);
    const hm = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return _abD(d) === today ? hm : 'אתמול ' + hm;
  };
  const rows = list.map(r => {
    const name = _abCallName(r);
    const st = AB_CALL_ST[r.state] + (r.state === 'no_answer' && r.outs > 1 ? ` (${r.outs} ניסיונות)` : '');
    const ctx = r.ent ? `,'${r.ent.type}',${r.ent.id}` : '';
    const dial = telephonyOn()
      ? `<button class="btn btn-sm" onclick="abCallsRedial('${escJs(r.number)}'${ctx})">📞 חייג שוב</button>`
      : `<a class="btn btn-sm" href="tel:${esc(r.number)}">📞 חייג שוב</a>`;
    const card = r.ent ? `<button class="btn btn-sm btn-ghost" onclick="abCallsOpenCard('${r.ent.type}',${r.ent.id})">כרטיס</button>` : '';
    return `<li class="abc-row">
      <span style="min-width:0">
        <b>${esc(name || r.number)}</b>${name ? ` <span class="muted" dir="ltr">${esc(r.number)}</span>` : ''}
        <span class="muted" style="font-size:.8rem"> · ${when(r.at)}</span><br>
        <span class="abc-st ${r.state}">${st}</span>
      </span>
      <span style="display:flex;gap:6px;flex-shrink:0">${dial}${card}</span>
    </li>`;
  }).join('');
  const vcOk = !!_abData?.vcOk;
  ov.innerHTML = `<div class="emu-oops" style="max-width:560px;text-align:right">
    <p style="text-align:center;margin:4px 0 6px"><b>📞 השיחות שלי — אתמול והיום</b></p>
    <div class="abc-tabs">
      <button class="btn btn-sm ${_abCallsTab === 'todo' ? '' : 'btn-ghost'}" onclick="abCallsTab('todo')">דורש חזרה (${todo.length})</button>
      <button class="btn btn-sm ${_abCallsTab === 'all' ? '' : 'btn-ghost'}" onclick="abCallsTab('all')">כל השיחות (${_abCalls.length})</button>
    </div>
    ${vcOk ? '' : `<div class="muted" style="font-size:.8rem;text-align:center;margin-bottom:6px">לא מחובר ל-Voicenter — מוצגים החיוגים מהמערכת, בלי סטטוס מענה ובלי שיחות חוזרות</div>`}
    <ul style="list-style:none;margin:0 0 12px;padding:0;max-height:55vh;overflow:auto">${rows || `<li class="muted" style="text-align:center;padding:14px">${_abCallsTab === 'todo' ? 'אין למי לחזור 👍' : 'אין שיחות'}</li>`}</ul>
    <div style="display:flex;gap:8px;justify-content:center">
      <button class="btn btn-sm btn-ghost" onclick="agentBarRefresh(true)">↻ רענון</button>
      <button class="btn btn-sm btn-ghost" onclick="document.getElementById('abCallsOv')?.remove()">סגור</button>
    </div>
  </div>`;
}

function abCallsRedial(number, entityType, entityId) {
  document.getElementById('abCallsOv')?.remove();
  phoneCall(number, entityType, entityId);
}

function abCallsOpenCard(type, id) {
  document.getElementById('abCallsOv')?.remove();
  if (type === 'lead') openPage('leads').then(() => window.openLeadCard && openLeadCard(id));
  else openPage('customers').then(() => window.openCustomerCard && openCustomerCard(id));
}

function agentBarToggle() {
  try {
    const c = localStorage.getItem('agentBarCollapsed') === '1';
    localStorage.setItem('agentBarCollapsed', c ? '0' : '1');
  } catch (e) { }
  _abRender();
}

function _abInjectCss() {
  if (document.getElementById('abCss')) return;
  const s = document.createElement('style');
  s.id = 'abCss';
  s.textContent = `
#agentBar{position:sticky;z-index:14;background:linear-gradient(100deg,var(--brand-dark),var(--brand));color:#fff;box-shadow:0 2px 10px rgba(16,42,67,.18)}
#agentBar .ab-wrap{display:flex;align-items:stretch;gap:10px;padding:8px 14px;max-width:1500px;margin:0 auto}
#agentBar .ab-loading{opacity:.8;font-size:.85rem;padding:6px}
#agentBar .ab-score{display:flex;align-items:center;gap:10px;border-radius:12px;padding:8px 14px;min-width:170px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.25)}
#agentBar .ab-score-none{background:rgba(255,255,255,.12)}
#agentBar .ab-score-ic{font-size:1.7rem;line-height:1}
#agentBar .ab-score-lb{font-weight:800;font-size:1.05rem}
#agentBar .ab-score-n{font-size:.75rem;opacity:.9}
#agentBar .ab-tiles{flex:1;display:grid;grid-template-columns:repeat(8,minmax(84px,1fr));gap:6px}
#agentBar .ab-tile{background:rgba(255,255,255,.1);border-radius:10px;padding:6px 8px;min-width:0}
#agentBar .ab-tile.ab-conv{background:rgba(255,255,255,.2)}
#agentBar .ab-tile.ab-click{cursor:pointer}
#agentBar .ab-tile.ab-click:hover{background:rgba(255,255,255,.22)}
#agentBar .ab-cb{background:#dc2626;color:#fff;border-radius:99px;padding:0 6px;font-weight:800;font-size:.68rem;animation:abPulse 1.6s infinite}
@keyframes abPulse{50%{opacity:.6}}
.abc-tabs{display:flex;gap:6px;justify-content:center;margin:4px 0 10px}
.abc-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid #eee}
.abc-st{display:inline-block;border-radius:99px;padding:1px 8px;font-size:.75rem;font-weight:700;margin-top:2px}
.abc-st.cb_missed{background:#fee2e2;color:#b91c1c}.abc-st.no_answer{background:#fef3c7;color:#92400e}
.abc-st.cb_answered,.abc-st.answered{background:#dcfce7;color:#166534}.abc-st.dialed{background:#e5e7eb;color:#374151}
#agentBar .ab-lbl{font-size:.7rem;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#agentBar .ab-val{font-size:1.3rem;font-weight:800;line-height:1.2;display:flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
#agentBar .ab-y{font-size:.66rem;opacity:.7;white-space:nowrap}
#agentBar .ab-dl{font-size:.62rem;font-weight:700}
#agentBar .ab-dl.up{color:#86efac}#agentBar .ab-dl.down{color:#fca5a5}#agentBar .ab-dl.eq{opacity:.6}
#agentBar .ab-vs{background:rgba(255,255,255,.1);border-radius:10px;padding:6px 10px;min-width:150px;font-size:.75rem}
#agentBar .ab-vs-h{font-weight:700;margin-bottom:3px;opacity:.9}
#agentBar .ab-vs-row{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:3px}
#agentBar .ab-pill{border-radius:99px;padding:1px 8px;font-weight:700;background:rgba(255,255,255,.2)}
#agentBar .ab-tools{display:flex;flex-direction:column;gap:4px}
#agentBar .ab-tools button{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:6px;width:26px;height:24px;font-size:.85rem}
#agentBar .ab-tools button:hover{background:rgba(255,255,255,.3)}
#agentBar .ab-collapsed .ab-tile:not(:nth-child(-n+3)),#agentBar .ab-collapsed .ab-vs,#agentBar .ab-collapsed .ab-y{display:none}
#agentBar .ab-collapsed .ab-tiles{grid-template-columns:repeat(3,minmax(84px,120px))}
#agentBar .ab-collapsed .ab-score{padding:4px 12px}
@media (max-width:1200px){#agentBar .ab-tiles{grid-template-columns:repeat(4,minmax(80px,1fr))}}
@media (max-width:820px){
 #agentBar{position:static}
 #agentBar .ab-wrap{flex-wrap:wrap}
 #agentBar .ab-score{flex:1}
 #agentBar .ab-tiles{order:3;flex-basis:100%;grid-template-columns:repeat(4,1fr)}
 #agentBar .ab-vs{flex:1}
 #agentBar .ab-tools{flex-direction:row;align-self:flex-start}
}`;
  document.head.appendChild(s);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _abBuildCalls };
}
