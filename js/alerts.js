/* ============================================================
   alerts.js — מנוע ההתראות הגנרי: פעמון מערכת + ניהול כללים
   ------------------------------------------------------------
   צד הלקוח של המנוע (Edge Function: alerts-engine):
   - פעמון 📣 בכותרת עם מונה לא-נקראו (טבלת alerts, ערוץ inapp)
   - מגירת התראות: סימון נקרא / הסרה / סמן הכל
   - כרטיס "התראות" במסך ההגדרות: מתג ראשי, מתגי ערוצים, ניהול כללים
   - בכניסת מנהל: מריץ את המנוע (scan+process+deliver) לכל היותר פעם בשעה
   כבוי כברירת מחדל (settings.alerts_enabled) — כשהוא כבוי אין פעמון בכלל.
   המנוע מודיע בלבד — שום פעולה כספית לא מתבצעת מכאן.
   ============================================================ */

'use strict';

const ALERTS_EVENT_NAMES = {
  debt_over_threshold: 'חוב שחצה סף',
  issue_deadline: 'דדליין מודעות לגיליון',
  payment_failed: 'תשלום שנכשל',
  check_bounced: "צ'ק שחזר"
};
const ALERTS_CHANNEL_NAMES = { inapp: 'מערכת', email: 'מייל', whatsapp: 'וואטסאפ' };
const ALERTS_SEV_ICONS = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

let _alertsList = [];
let _alertsRules = [];

function alertsOn() { return String((cache.settings || {}).alerts_enabled || '0') === '1'; }

/* ==================== פרסום אירוע — נקודת הכניסה למודולים ==================== */

// כל מודול במערכת מדווח אירוע למנוע בקריאה אחת, למשל:
//   alertsPublishEvent('check_bounced', { customer_id, customer_name, amount });
// המנוע (alerts-engine) יהפוך אותו להתראה לפי הכללים. כישלון — שקט,
// כדי שדיווח התראה לעולם לא יפיל את הפעולה העסקית שקראה לו.
async function alertsPublishEvent(eventType, payload, source) {
  if (!alertsOn()) return null;
  try {
    const { data, error } = await db.rpc('alerts_publish_event', {
      p_event_type: eventType,
      p_payload: payload || {},
      p_source: source || 'app'
    });
    if (error) throw error;
    return data;
  } catch (e) { return null; }
}

/* ==================== פעמון ומגירה ==================== */

function alertsInjectBell() {
  if (document.getElementById('alertsBell')) return;
  const notifWrap = document.querySelector('.topbar .notif-wrap');
  if (!notifWrap) return;
  const wrap = document.createElement('div');
  wrap.className = 'notif-wrap';
  wrap.id = 'alertsWrap';
  wrap.innerHTML = `
    <button id="alertsBell" class="notif-bell" onclick="alertsToggleDrop()" title="התראות מערכת" aria-label="התראות מערכת">📣<span id="alertsBadge" class="notif-badge hidden">0</span></button>
    <div id="alertsDrop" class="notif-drop hidden"></div>`;
  notifWrap.after(wrap);
}

async function alertsRefresh() {
  if (!alertsOn()) return;
  try {
    const { count } = await db.from('alerts').select('id', { count: 'exact', head: true }).eq('status', 'new');
    const b = document.getElementById('alertsBadge');
    if (b) { b.textContent = count || 0; b.classList.toggle('hidden', !count); }
  } catch (e) { /* אין הרשאה / טבלה חסרה — שקט */ }
}

async function alertsToggleDrop() {
  const dd = document.getElementById('alertsDrop'); if (!dd) return;
  if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
  dd.innerHTML = '<div class="notif-empty">טוען...</div>';
  dd.classList.remove('hidden');
  try {
    _alertsList = await run(db.from('alerts')
      .select('*, alert_events(payload)')
      .in('status', ['new', 'read'])
      .order('created_at', { ascending: false }).limit(30));
  } catch (e) { _alertsList = []; }
  alertsRenderDrop();
}

function alertsRenderDrop() {
  const dd = document.getElementById('alertsDrop'); if (!dd) return;
  const items = _alertsList || [];
  const unread = items.filter(a => a.status === 'new').length;
  dd.innerHTML = `<div class="notif-head" style="display:flex;justify-content:space-between;align-items:center">
      <span>התראות מערכת (${unread})</span>
      ${unread ? '<button class="btn btn-sm btn-ghost" onclick="alertsMarkAllRead()">סמן הכל כנקרא</button>' : ''}
    </div>` + (items.length ? items.map(a => {
    const payload = (a.alert_events && a.alert_events.payload) || {};
    const cid = payload.customer_id, iid = payload.issue_id;
    const openClick = cid ? `onclick="alertsCloseDrop();openCustomerCard(${Number(cid)})" style="cursor:pointer"` :
      iid ? `onclick="alertsCloseDrop();openFlatplan(${Number(iid)})" style="cursor:pointer"` : '';
    return `<div class="notif-item" style="${a.status === 'new' ? '' : 'opacity:.65'}">
      <div class="notif-row" ${openClick}>
        <span class="notif-ico">${ALERTS_SEV_ICONS[a.severity] || 'ℹ️'}</span>
        <div><div class="notif-text">${esc(a.title)}</div>
        <div class="notif-sub">${esc(a.body || '')}</div>
        <div class="notif-sub">${heDateTime(a.created_at)}</div></div>
      </div>
      <div class="notif-actions">
        ${a.status === 'new' ? `<button class="btn btn-sm btn-ghost" onclick="alertsMarkRead(${a.id})">✓ נקרא</button>` : ''}
        <button class="btn btn-sm btn-ghost" onclick="alertsDismiss(${a.id})">✕ הסר</button>
      </div>
    </div>`;
  }).join('') : '<div class="notif-empty">אין התראות מערכת 👍</div>');
}

function alertsCloseDrop() { const dd = document.getElementById('alertsDrop'); if (dd) dd.classList.add('hidden'); }

async function alertsMarkRead(id) {
  await run(db.from('alerts').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', id));
  const a = (_alertsList || []).find(x => x.id === id); if (a) a.status = 'read';
  alertsRenderDrop(); alertsRefresh();
}

async function alertsDismiss(id) {
  await run(db.from('alerts').update({ status: 'dismissed' }).eq('id', id));
  _alertsList = (_alertsList || []).filter(x => x.id !== id);
  alertsRenderDrop(); alertsRefresh();
}

async function alertsMarkAllRead() {
  await run(db.from('alerts').update({ status: 'read', read_at: new Date().toISOString() }).eq('status', 'new'));
  (_alertsList || []).forEach(a => { if (a.status === 'new') a.status = 'read'; });
  alertsRenderDrop(); alertsRefresh();
}

/* ==================== הרצת המנוע ==================== */

// מריץ את המנוע בשרת. בכניסה — לכל היותר פעם בשעה (throttle דרך settings).
async function alertsRunEngine(force) {
  if (!alertsOn() || profile.role !== 'admin') return null;
  if (!force) {
    const last = Date.parse((cache.settings || {}).alerts_last_run || 0);
    if (last && Date.now() - last < 60 * 60 * 1000) return null;
  }
  try {
    const { data, error } = await db.functions.invoke('alerts-engine', { body: { action: 'run' } });
    if (error) throw error;
    const now = new Date().toISOString();
    await db.from('settings').upsert({ key: 'alerts_last_run', value: now });
    cache.settings.alerts_last_run = now;
    return data;
  } catch (e) { return null; }
}

async function alertsInit() {
  if (!alertsOn()) return; // כבוי → אין פעמון, אין ריצות
  alertsInjectBell();
  await alertsRunEngine(false);
  await alertsRefresh();
  if (window._alertsTimer) clearInterval(window._alertsTimer);
  window._alertsTimer = setInterval(alertsRefresh, 5 * 60 * 1000);
  document.addEventListener('click', e => {
    const bell = document.getElementById('alertsBell'), dd = document.getElementById('alertsDrop');
    if (dd && !dd.classList.contains('hidden') && !dd.contains(e.target) && bell && !bell.contains(e.target)) dd.classList.add('hidden');
  });
}

/* ==================== כרטיס הגדרות ==================== */

function alertsSettingsCard() {
  const s = cache.settings || {};
  const on = alertsOn();
  return `
<div class="card card-pad">
<b>התראות מערכת 📣</b>
<p class="muted" style="font-size:.82rem">מנוע התראות: סריקה יומית + כללים. המנוע מודיע בלבד — לא מבצע שום פעולה כספית. שינוי סף/ערוצים — בטבלת הכללים למטה.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" id="setAlerts" ${on ? 'checked' : ''} onchange="alertsToggleMaster(this.checked)" style="width:18px;height:18px">
התראות פעילות (מציג פעמון 📣 בכותרת)
</label>
<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px">
<label style="display:flex;gap:8px;align-items:center;cursor:pointer">
<input type="checkbox" id="setAlertsEmail" ${String(s.alerts_email_enabled || '0') === '1' ? 'checked' : ''} onchange="alertsToggleChannel('email',this.checked)" style="width:18px;height:18px">
ערוץ מייל
</label>
<span class="field" style="margin:0;display:flex;gap:6px;align-items:center">נמען:
<input id="setAlertsEmailTo" type="email" value="${esc(s.alerts_email_to || '')}" dir="ltr" placeholder="name@example.com" style="width:200px">
<button class="btn btn-sm" onclick="alertsSaveEmailTo()">שמירה</button>
</span>
<label style="display:flex;gap:8px;align-items:center;cursor:pointer">
<input type="checkbox" id="setAlertsWa" ${String(s.alerts_whatsapp_enabled || '0') === '1' ? 'checked' : ''} onchange="alertsToggleChannel('whatsapp',this.checked)" style="width:18px;height:18px">
ערוץ וואטסאפ <span class="pill">בהכנה — אין ספק מוגדר</span>
</label>
</div>
<p class="muted" style="font-size:.78rem;margin-top:4px">ערוץ המייל שולח דרך send-email (Gmail) — דורש מתג דלוק + נמען. וואטסאפ לא שולח דבר עד שיוגדר ספק — גם כשהמתג דלוק.</p>
<div id="alertsRulesBox" style="margin-top:10px"><div class="empty">טוען כללים...</div></div>
<div style="display:flex;gap:8px;margin-top:10px">
<button class="btn btn-sm btn-ghost" onclick="alertsRunNow()">▶ הרץ סריקה עכשיו</button>
</div>
</div>`;
}

async function alertsSettingsMount() {
  const box = document.getElementById('alertsRulesBox'); if (!box) return;
  try {
    _alertsRules = await run(db.from('alert_rules').select('*').order('id'));
  } catch (e) { box.innerHTML = '<p class="muted">טבלאות ההתראות עוד לא קיימות — יש להריץ את המיגרציה alerts_engine.</p>'; return; }
  if (!_alertsRules.length) { box.innerHTML = '<p class="muted">אין כללים מוגדרים.</p>'; return; }
  box.innerHTML = _alertsRules.map(r => {
    const th = (r.condition && r.condition.threshold != null) ? r.condition.threshold : '';
    const hb = (r.condition && r.condition.hours_before != null) ? r.condition.hours_before : '';
    const chans = r.channels || [];
    return `<div class="notif-item" style="border:1px solid #eef1f7;border-radius:10px;margin-bottom:8px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;min-width:170px">
          <input type="checkbox" id="ruleOn_${r.id}" ${r.enabled ? 'checked' : ''} style="width:16px;height:16px">
          <b>${esc(ALERTS_EVENT_NAMES[r.event_type] || r.event_type)}</b>
        </label>
        ${th !== '' ? `<span class="field" style="margin:0">סף (₪): <input id="ruleTh_${r.id}" type="number" value="${esc(th)}" dir="ltr" style="width:90px"></span>` : ''}
        ${hb !== '' ? `<span class="field" style="margin:0">שעות לפני: <input id="ruleHb_${r.id}" type="number" value="${esc(hb)}" dir="ltr" style="width:70px"></span>` : ''}
        <span class="field" style="margin:0">בלימה (שעות): <input id="ruleHrs_${r.id}" type="number" value="${esc(r.throttle_hours)}" dir="ltr" style="width:64px"></span>
        <span style="display:flex;gap:10px">
          ${['inapp', 'email', 'whatsapp'].map(c => `<label style="display:flex;gap:4px;align-items:center;cursor:pointer">
            <input type="checkbox" id="ruleCh_${r.id}_${c}" ${chans.includes(c) ? 'checked' : ''}>${ALERTS_CHANNEL_NAMES[c]}</label>`).join('')}
        </span>
        <span class="muted" style="font-size:.78rem">נמענים: מנהל</span>
        <button class="btn btn-sm" onclick="alertsRuleSave(${r.id})">שמירה</button>
      </div>
    </div>`;
  }).join('');
}

async function alertsToggleMaster(on) {
  await run(db.from('settings').upsert({ key: 'alerts_enabled', value: on ? '1' : '0' }));
  cache.settings.alerts_enabled = on ? '1' : '0';
  toast(on ? 'התראות הופעלו' : 'התראות כובו');
  if (on) { alertsInit(); } else {
    const w = document.getElementById('alertsWrap'); if (w) w.remove();
    if (window._alertsTimer) clearInterval(window._alertsTimer);
  }
}

async function alertsToggleChannel(chan, on) {
  const key = chan === 'email' ? 'alerts_email_enabled' : 'alerts_whatsapp_enabled';
  await run(db.from('settings').upsert({ key, value: on ? '1' : '0' }));
  cache.settings[key] = on ? '1' : '0';
  if (chan === 'email') toast(on ? 'ערוץ המייל הופעל — ודא שהוגדר נמען' : 'ערוץ המייל כובה');
  else toast('נשמר. שים לב: וואטסאפ לא ישלח דבר עד שיוגדר ספק.');
}

async function alertsSaveEmailTo() {
  const v = String(document.getElementById('setAlertsEmailTo')?.value || '').trim();
  if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast('כתובת מייל לא תקינה', true); return; }
  await run(db.from('settings').upsert({ key: 'alerts_email_to', value: v }));
  cache.settings.alerts_email_to = v;
  toast(v ? 'נמען ההתראות נשמר' : 'הנמען נמחק — ערוץ המייל לא ישלח');
}

async function alertsRuleSave(id) {
  const r = (_alertsRules || []).find(x => x.id === id); if (!r) return;
  const patch = { enabled: !!document.getElementById('ruleOn_' + id)?.checked };
  const thEl = document.getElementById('ruleTh_' + id);
  if (thEl) {
    const th = Number(thEl.value);
    if (!Number.isFinite(th) || th <= 0) { toast('סף לא תקין', true); return; }
    patch.condition = Object.assign({}, r.condition, { threshold: th });
  }
  const hbEl = document.getElementById('ruleHb_' + id);
  if (hbEl) {
    const hb = Number(hbEl.value);
    if (!Number.isFinite(hb) || hb <= 0) { toast('מספר שעות לא תקין', true); return; }
    patch.condition = Object.assign({}, patch.condition || r.condition, { hours_before: Math.round(hb) });
  }
  const hrs = Number(document.getElementById('ruleHrs_' + id)?.value);
  patch.throttle_hours = (Number.isFinite(hrs) && hrs > 0) ? Math.round(hrs) : 24;
  patch.channels = ['inapp', 'email', 'whatsapp'].filter(c => document.getElementById(`ruleCh_${id}_${c}`)?.checked);
  if (!patch.channels.length) patch.channels = ['inapp'];
  await run(db.from('alert_rules').update(patch).eq('id', id));
  Object.assign(r, patch);
  toast('הכלל נשמר');
}

async function alertsRunNow() {
  toast('מריץ סריקה...');
  const res = await alertsRunEngine(true);
  if (!res) { toast(alertsOn() ? 'ההרצה נכשלה — בדוק שה-Edge Function פרוסה' : 'יש להפעיל קודם את המתג הראשי', true); return; }
  toast(`הסתיים: ${res.events_created ?? 0} אירועים, ${res.alerts_created ?? 0} התראות חדשות, ${res.suppressed ?? 0} נבלמו`);
  alertsRefresh();
}
