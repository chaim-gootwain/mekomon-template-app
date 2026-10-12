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
      ? db.functions.invoke('voicenter-stats', { body: { from: y, to: t } })
        .then(r => (r.data && r.data.ok) ? r.data : { ok: false, error: r.data?.error || r.error?.message })
        .catch(e => ({ ok: false, error: String(e?.message || e) }))
      : Promise.resolve(_abVc);

    const [calls, att, audit, notes, quotes, vc] = await Promise.all([
      safe(runAll((f, to) => db.from('call_log').select('created_at,entity_type,entity_id').eq('user_id', uid).gte('created_at', fromTs).order('id').range(f, to), 'שיחות')),
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
    _abData = { today: D[t], yest: D[y], vcOk, vcErr: vcOk ? null : vc?.error };
    _abRender();
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
    <div class="ab-tile${opts.cls ? ' ' + opts.cls : ''}"${opts.tip || ''}>
      <div class="ab-lbl">${icon} ${label}</div>
      <div class="ab-val">${val}${cmp}</div>
      <div class="ab-y">אתמול: ${yVal}</div>
    </div>`;

  const n = v => v == null ? '—' : v;
  const pct = v => v == null ? '—' : v + '%';
  const tiles = [
    tile('📞', 'שיחות', n(T.calls), n(Y.calls), delta(T.calls, Y.calls)),
    tile('✅', 'נענו', n(T.answered), n(Y.answered), delta(T.answered, Y.answered), { tip: vcTip }),
    tile('📵', 'לא נענו', n(T.unanswered), n(Y.unanswered), '', { tip: vcTip, cls: 'muted-tile' }),
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
