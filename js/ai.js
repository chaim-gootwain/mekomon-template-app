/* ============================================================
ai.js — תובנות AI (קליטת ניתוח שיחות מ-Voicenter / Analytic Center)
------------------------------------------------------------
- מוזרק לכרטיס הליד בלי לגעת בקוד הקיים (עטיפת openLeadCard)
- מאחורי דגל: settings.ai_insights_enabled ('0' כברירת מחדל)
- מציג: סיכום · סנטימנט · שדות הניתוח · תמלול (נפתח) · הצעות לאישור
============================================================ */

'use strict';

function aiInsightsOn() {
  return String((cache.settings || {}).ai_insights_enabled || '0') === '1';
}

function aiEnsureStyles() {
  if (document.getElementById('aiFxStyles')) return;
  const s = document.createElement('style');
  s.id = 'aiFxStyles';
  s.textContent = `
  .ai-panel{margin-top:16px;border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:14px;
    background:linear-gradient(180deg,#fbfbff,#f3f4ff)}
  .ai-head{display:flex;align-items:center;gap:8px;font-weight:800;color:@@COLOR_BRAND@@;margin-bottom:10px;flex-wrap:wrap}
  .ai-badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.78rem;font-weight:700}
  .ai-pos{background:#e7f7ec;color:#1a7f37}.ai-neu{background:#eef0f5;color:#555}.ai-neg{background:#fdecec;color:#c0392b}
  .ai-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:600px){.ai-grid{grid-template-columns:1fr}}
  .ai-cell{border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:8px 10px;background:#fff}
  .ai-cell .lbl{font-size:.72rem;color:#8890a6;font-weight:700;margin-bottom:2px}
  .ai-cell .val{font-size:.9rem;color:#1c2438;white-space:pre-line}
  .ai-sugg .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff7e6;border:1px solid #ffe0a3;
    border-radius:10px;padding:8px 10px;margin-top:8px}
  .ai-sugg .row b{color:#8a5a00}
  .ai-done{color:#1a7f37;font-weight:700}
  .ai-transcript{margin-top:10px}
  .ai-transcript pre{white-space:pre-wrap;font-family:inherit;background:#fff;border:1px solid var(--line,#e5e7eb);
    border-radius:10px;padding:10px;max-height:40vh;overflow:auto;font-size:.85rem}
  `;
  document.head.appendChild(s);
}

async function loadLeadAnalysis(leadId) {
  try {
    const { data } = await db.from('call_analysis').select('*')
      .eq('lead_id', leadId).order('created_at', { ascending: false });
    return data || [];
  } catch (e) { return []; }
}

function aiSentimentBadge(s) {
  if (s === 'positive') return '<span class="ai-badge ai-pos">חיובי 🙂</span>';
  if (s === 'negative') return '<span class="ai-badge ai-neg">שלילי 🙁</span>';
  if (s === 'neutral') return '<span class="ai-badge ai-neu">ניטרלי 😐</span>';
  return '';
}

const AI_FIELDS = [
  ['deal_outcome', 'תוצאת השיחה'], ['sale_product', 'מוצר'], ['sales_size', 'גודל עסקה'],
  ['needs', 'צרכים'], ['objections', 'התנגדויות'], ['action_items', 'משימות המשך'],
  ['key_client_questions', 'שאלות מפתח'], ['sales_techniques', 'טכניקות מכירה'],
  ['missed_opportunities', 'הזדמנויות שהוחמצו'], ['trust_sentences', 'משפטי אמון'],
];

function aiPanelHtml(list) {
  if (!list.length) return '';
  aiEnsureStyles();
  return list.map(a => {
    const cells = AI_FIELDS
      .filter(([k]) => a[k] != null && String(a[k]).trim() !== '')
      .map(([k, lbl]) => `<div class="ai-cell"><div class="lbl">${lbl}</div><div class="val">${esc(String(a[k]))}</div></div>`)
      .join('');
    const sugg = (a.suggestions || []).map((s, i) => {
      if (s.status === 'approved') return `<div class="row"><span class="ai-done">✓ ${esc(s.label)} → ${esc(String(s.to))} (אושר)</span></div>`;
      if (s.status === 'rejected') return `<div class="row" style="opacity:.55"><span>✗ ${esc(s.label)} (נדחה)</span></div>`;
      return `<div class="row"><b>המערכת מציעה:</b> ${esc(s.label)} → <b>${esc(String(s.to))}</b>
        <span style="margin-inline-start:auto;display:flex;gap:6px">
          <button class="btn btn-sm" onclick="aiApprove(${a.id},${i})">אשר</button>
          <button class="btn btn-sm btn-ghost" onclick="aiEdit(${a.id},${i})">ערוך</button>
          <button class="btn btn-sm btn-ghost" onclick="aiReject(${a.id},${i})">דחה</button>
        </span></div>`;
    }).join('');
    const tid = 'aitr_' + a.id;
    const when = a.call_time ? heDateTime(a.call_time) : heDateTime(a.created_at);
    return `<div class="ai-panel">
      <div class="ai-head">🧠 תובנות AI · שיחה ${when} ${aiSentimentBadge(a.sentiment)}</div>
      ${a.summary ? `<div class="ai-cell" style="margin-bottom:10px"><div class="lbl">סיכום</div><div class="val">${esc(a.summary)}</div></div>` : ''}
      ${cells ? `<div class="ai-grid">${cells}</div>` : ''}
      ${sugg ? `<div class="ai-sugg">${sugg}</div>` : ''}
      ${a.transcript ? `<div class="ai-transcript">
        <button class="btn btn-sm btn-ghost" onclick="document.getElementById('${tid}').classList.toggle('hidden')">הצג / הסתר תמלול</button>
        <div id="${tid}" class="hidden"><pre>${esc(a.transcript)}</pre></div></div>` : ''}
    </div>`;
  }).join('');
}

/* מיפוי שדה-הצעה -> עמודת ליד + המרה מתאימה */
function aiApplyToLead(leadId, field, value) {
  const upd = {};
  if (field === 'temperature') upd.temperature = value === 'חם' ? 'hot' : value === 'קר' ? 'cold' : 'warm';
  else if (field === 'est_value') upd.est_value = Number(String(value).replace(/\D/g, '')) || null;
  else if (field === 'objection') upd.objection = value;
  else upd[field] = value;
  return db.from('leads').update(upd).eq('id', leadId);
}

async function _aiSetStatus(analysisId, idx, status, newVal) {
  const { data: row } = await db.from('call_analysis').select('suggestions,lead_id').eq('id', analysisId).single();
  const sug = (row.suggestions || []).slice();
  if (!sug[idx]) return;
  if (newVal != null) sug[idx].to = newVal;
  sug[idx].status = status;
  if (status === 'approved' && row.lead_id) {
    await aiApplyToLead(row.lead_id, sug[idx].field, sug[idx].to);
    await addInteraction('lead', row.lead_id, `הצעת AI אושרה: ${sug[idx].label} ← ${sug[idx].to}`);
    const l = (typeof _leads !== 'undefined') ? _leads.find(x => x.id === row.lead_id) : null;
    if (l) {
      if (sug[idx].field === 'temperature') l.temperature = sug[idx].to === 'חם' ? 'hot' : sug[idx].to === 'קר' ? 'cold' : 'warm';
      else if (sug[idx].field === 'objection') l.objection = sug[idx].to;
      else if (sug[idx].field === 'est_value') l.est_value = Number(String(sug[idx].to).replace(/\D/g, '')) || null;
    }
  }
  await db.from('call_analysis').update({ suggestions: sug }).eq('id', analysisId);
}

let _curAiLead = null;

async function aiApprove(id, idx) {
  try { await _aiSetStatus(id, idx, 'approved'); toast('אושר ✓'); if (_curAiLead) openLeadCard(_curAiLead); }
  catch (e) { toast('שגיאה באישור', true); }
}
async function aiReject(id, idx) {
  try { await _aiSetStatus(id, idx, 'rejected'); toast('נדחה'); if (_curAiLead) openLeadCard(_curAiLead); }
  catch (e) { toast('שגיאה', true); }
}
async function aiEdit(id, idx) {
  const v = prompt('ערך מעודכן לאישור:');
  if (v == null) return;
  try { await _aiSetStatus(id, idx, 'approved', v); toast('עודכן ואושר ✓'); if (_curAiLead) openLeadCard(_curAiLead); }
  catch (e) { toast('שגיאה', true); }
}

/* עטיפת openLeadCard — מזריק את פאנל תובנות ה-AI אחרי רינדור הכרטיס */
(function () {
  const orig = window.openLeadCard;
  if (typeof orig === 'function' && !orig._aiWrapped) {
    const wrapped = async function (id) {
      const r = await orig.apply(this, arguments);
      _curAiLead = id;
      try {
        if (aiInsightsOn()) {
          const list = await loadLeadAnalysis(id);
          const html = aiPanelHtml(list);
          if (html) {
            const modal = document.getElementById('viewModal');
            if (modal) { const div = document.createElement('div'); div.innerHTML = html; modal.appendChild(div); }
          }
        }
      } catch (e) { console.error('ai panel', e); }
      return r;
    };
    wrapped._aiWrapped = true;
    window.openLeadCard = wrapped;
  }
})();
