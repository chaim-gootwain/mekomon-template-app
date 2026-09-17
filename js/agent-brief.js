/* ============================================================
agent-brief.js — "דוח בוקר אישי" לסוכן מכירות
------------------------------------------------------------
מוצג פעם ביום, בכניסה הראשונה של סוכן מכירות המקושר לכרטיס סוכן:
המצב שלו מאתמול (שיחות, שעות, פעולות, סגירות, הכנסה, ציון 1–10),
המצב מתחילת השבוע ומתחילת החודש, התקדמות מול היעד החודשי —
ומילת עידוד שנבחרת לפי המצב (יום חזק / חלש / קרוב ליעד / עבר יעד).

כל סוכן רואה רק את הנתונים של עצמו — השאילתות מסוננות למשתמש
המחובר וה-RLS ממילא אוכף זאת. שאילתה שנכשלת (למשל טבלה שטרם
הותקנה במופע) פשוט מוצגת כ-0 — הדוח לעולם לא חוסם כניסה.
נסמך על apWeights/apPoints/apDayScore מ-agent-perf.js (נטען לפניו
ב-ORDER). כיבוי: settings key agent_brief_enabled = '0'.
"נזכר" פעם ביום לכל משתמש דרך localStorage (פר דפדפן).
============================================================ */

'use strict';

const BRIEF_MSGS = {
  passed: [
    'עברת את היעד החודשי — אלוף אמיתי! 🏆 עכשיו כל סגירה היא בונוס',
    'היעד מאחוריך והחודש עוד לא נגמר — תראה כמה גבוה אפשר להגיע! 🚀',
    'עברת את היעד! הצוות צריך ללמוד ממך — תמשיך באותה אנרגיה 🏆',
  ],
  near: [
    'אתה נושם לעורף של היעד — עוד דחיפה קטנה ואתה שם! 🎯',
    'כמעט ביעד! הסגירות הבאות שלך כבר מחכות בטלפון 🎯',
    'המרחק ליעד קטן מתמיד — ספרינט אחד טוב וסגרת את החודש 💪',
    'רואים את קו הסיום — אל תוריד את הרגל מהגז! 🏁',
  ],
  strong: [
    'אתמול היה יום של אלופים — שמור על הקצב הזה! 🔥',
    'ככה נראה יום עבודה מנצח. היום עוד יותר! 💪',
    'הקצב שלך אתמול היה מעולה — הלקוחות מרגישים את זה 🔥',
    'יום חזק מאחוריך — המומנטום הזה שווה זהב, תרכב עליו 🏇',
    'אתמול הוכחת מה אתה שווה — היום מכפילים! ⚡',
  ],
  weak: [
    'כל שיחה היום היא התחלה חדשה — הרם טלפון וקדימה! ☀️',
    'יום חדש, לוח נקי — הסגירה הבאה שלך מחכה בטלפון הראשון 📞',
    'אתמול מאחורינו. היום זה היום שלך — תתחיל בשיחה אחת קטנה 💪',
    'גם האלופים הכי גדולים התחילו מחדש כל בוקר — קדימה לעבודה! ☀️',
    'הדרך הכי טובה לשפר את המספרים: השיחה הבאה. עכשיו 📞',
  ],
  generic: [
    'בוקר של עשייה — שיהיה יום מלא סגירות! ☀️',
    'ההצלחה אוהבת את מי שמרים טלפון ראשון — קדימה! 📞',
    'יום חדש, הזדמנויות חדשות — לך תפוס אותן! 🚀',
    'תזכור: כל לקוח גדול התחיל משיחה אחת. בהצלחה היום! 💪',
  ],
};

function _abDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* נקרא משרשרת הבדיקות הנדחות ב-app.js אחרי ההתחברות.
   מחזיר true אם הדוח הוצג (כדי לא להציג עוד חלון באותו רגע). */
async function agentBriefCheckPending() {
  try {
    if (!profile || profile.role !== 'sales') return false;
    if (String(cache.settings.agent_brief_enabled ?? '1') === '0') return false;
    const me = (cache.agents || []).find(a => a.profile_id === profile.id);
    if (!me) return false;
    const t = today();
    const key = 'agentBrief:' + profile.id;
    try { if (localStorage.getItem(key) === t) return false; } catch (e) { }

    /* טווחים: אתמול, מתחילת השבוע (ראשון), מתחילת החודש */
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    const yesterday = _abDay(yd);
    const ws = new Date(); ws.setDate(ws.getDate() - ws.getDay());
    const weekStart = _abDay(ws);
    const monthStart = t.slice(0, 8) + '01';
    const fromDate = [yesterday, weekStart, monthStart].sort()[0];
    const fromTs = new Date(fromDate + 'T00:00:00').toISOString();

    /* שליפות — רק הנתונים של הסוכן עצמו. כשל בשליפה = 0, לא חסימה */
    const safe = p => p.catch(() => []);
    const [calls, att, charges, auditMine, notes, quotes] = await Promise.all([
      safe(runAll((f, to) => db.from('call_log').select('created_at').eq('user_id', profile.id).gte('created_at', fromTs).order('id').range(f, to), 'שיחות')),
      safe(runAll((f, to) => db.from('attendance').select('clock_in,clock_out').eq('profile_id', profile.id).gte('clock_in', fromTs).order('id').range(f, to), 'נוכחות')),
      safe(runAll((f, to) => db.from('charges').select('amount,issued_date').eq('agent_id', me.id).gte('issued_date', fromDate).not('status', 'in', '("cancelled","lost")').order('id').range(f, to), 'חיובים')),
      safe(runAll((f, to) => db.from('audit_log').select('table_name,action,field,new_value,at').eq('user_id', profile.id).in('table_name', ['leads', 'charges', 'payments']).gte('at', fromTs).order('id').range(f, to), 'פעולות')),
      safe(runAll((f, to) => db.from('interactions').select('entity_type,created_at').eq('user_id', profile.id).gte('created_at', fromTs).order('id').range(f, to), 'הערות')),
      safe(runAll((f, to) => db.from('quotes').select('created_at').eq('created_by', profile.id).gte('created_at', fromTs).order('id').range(f, to), 'הצעות')),
    ]);

    /* צבירה לשלושה דליים: אתמול / השבוע / החודש (עד עכשיו, כולל היום) */
    const B = () => ({ calls: 0, leadNotes: 0, custNotes: 0, newLeads: 0, statusAdv: 0, quotes: 0, chargesIns: 0, paymentsIns: 0, closings: 0, revenue: 0 });
    const buckets = { y: B(), w: B(), m: B() };
    const add = (dayStr, field, amount = 1) => {
      if (dayStr === yesterday) buckets.y[field] += amount;
      if (dayStr >= weekStart) buckets.w[field] += amount;
      if (dayStr >= monthStart) buckets.m[field] += amount;
    };
    const dayOf = ts => _abDay(new Date(ts));
    calls.forEach(c => add(dayOf(c.created_at), 'calls'));
    notes.forEach(n => add(dayOf(n.created_at), n.entity_type === 'lead' ? 'leadNotes' : 'custNotes'));
    quotes.forEach(q => add(dayOf(q.created_at), 'quotes'));
    auditMine.forEach(r => {
      const d = dayOf(r.at);
      if (r.table_name === 'leads') {
        if (r.action === 'insert') add(d, 'newLeads');
        else if (r.action === 'update' && r.field === 'status') {
          if (r.new_value === 'won') add(d, 'closings');
          else if (typeof AP_STATUS_ADV !== 'undefined' && AP_STATUS_ADV.includes(r.new_value)) add(d, 'statusAdv');
        }
      } else if (r.action === 'insert') {
        add(d, r.table_name === 'charges' ? 'chargesIns' : 'paymentsIns');
      }
    });
    charges.forEach(ch => add(ch.issued_date, 'revenue', Number(ch.amount || 0)));

    /* שעות העבודה של אתמול + ציון */
    let yHours = 0;
    att.forEach(r => {
      if (_abDay(new Date(r.clock_in)) !== yesterday) return;
      const ms = (r.clock_out ? Date.parse(r.clock_out) : Date.now()) - Date.parse(r.clock_in);
      if (ms > 0) yHours += ms / 3600000;
    });
    const W = typeof apWeights === 'function' ? apWeights() : { call: 1, note: 1, status: 2, quote: 3, charge: 3, payment: 3, close: 8, target: 10 };
    const yActions = buckets.y.calls + buckets.y.leadNotes + buckets.y.custNotes + buckets.y.newLeads + buckets.y.statusAdv + buckets.y.quotes + buckets.y.chargesIns + buckets.y.paymentsIns;
    const yScore = (typeof apPoints === 'function' && typeof apDayScore === 'function')
      ? apDayScore(apPoints(buckets.y, W), yHours, W) : null;

    /* בחירת מילת העידוד לפי המצב, מגוונת לפי היום בחודש */
    const target = Number(me.monthly_target) || 0;
    let pool = BRIEF_MSGS.generic;
    if (target > 0 && buckets.m.revenue >= target) pool = BRIEF_MSGS.passed;
    else if (target > 0 && buckets.m.revenue >= target * 0.8) pool = BRIEF_MSGS.near;
    else if (buckets.y.closings > 0 || (yScore != null && yScore >= 8)) pool = BRIEF_MSGS.strong;
    else if (yScore != null && yScore <= 3) pool = BRIEF_MSGS.weak;
    else if (buckets.y.calls === 0 && yActions === 0) pool = BRIEF_MSGS.weak;
    const msg = pool[Number(t.slice(8, 10)) % pool.length];

    const firstName = (profile.full_name || me.name || '').trim().split(/\s+/)[0] || 'אלוף';
    const line = b => [
      b.calls + ' שיחות',
      (b === buckets.y ? (yHours ? yHours.toFixed(1) + ' שעות' : null) : null),
      (b === buckets.y ? yActions + ' פעולות' : null),
      b.closings ? b.closings + ' סגירות' : null,
      money(b.revenue) ? money(b.revenue) + ' הופקו' : null,
    ].filter(Boolean).join(' · ');
    const pct = target > 0 ? Math.round(buckets.m.revenue / target * 100) : null;
    const targetHtml = target > 0 ? (buckets.m.revenue >= target
      ? `<div style="margin-top:8px"><b>היעד החודשי:</b> ${money(target)} — <span class="pill green">עברת אותו! ${pct}% 🏆</span></div>`
      : `<div style="margin-top:8px"><b>היעד החודשי:</b> ${money(target)} — אתה ב-<b>${pct}%</b>, חסרים ${money(target - buckets.m.revenue)} 🎯
         <div style="background:var(--line,#e5e7eb);border-radius:6px;height:8px;margin-top:6px;overflow:hidden"><div style="width:${Math.min(pct, 100)}%;height:100%;background:@@COLOR_BRAND@@"></div></div></div>`) : '';

    document.getElementById('abOv')?.remove();
    const ov = document.createElement('div');
    ov.id = 'abOv';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(17,20,40,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:99996;padding:16px;direction:rtl';
    ov.innerHTML = `<div style="background:var(--card,#fff);border-radius:16px;padding:22px;max-width:460px;width:96%;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 2px">בוקר טוב, ${esc(firstName)}! ☀️</h3>
      <p class="muted" style="font-size:.8rem;margin:0 0 12px">הדוח האישי שלך · ${heDate(t)}</p>
      <div style="border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:10px 14px;margin-bottom:8px">
        <b>אתמול:</b> ${line(buckets.y) || 'יום שקט'}
        ${yScore != null ? ` · ציון <span class="pill ${yScore >= 8 ? 'green' : yScore >= 5 ? 'gold' : 'red'}">${yScore}/10</span>` : ''}
      </div>
      <div style="border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:10px 14px;margin-bottom:8px">
        <b>השבוע עד עכשיו:</b> ${line(buckets.w) || 'עוד לא נרשם כלום'}
      </div>
      <div style="border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:10px 14px">
        <b>החודש עד עכשיו:</b> ${line(buckets.m) || 'עוד לא נרשם כלום'}
        ${targetHtml}
      </div>
      <p style="font-style:italic;text-align:center;margin:14px 0 12px;font-size:.95rem;color:@@COLOR_DARK@@">"${msg}"</p>
      <div style="text-align:center"><button class="btn" onclick="document.getElementById('abOv').remove()">יאללה, מתחילים 💪</button></div>
    </div>`;
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    try { localStorage.setItem(key, t); } catch (e) { }
    return true;
  } catch (e) { console.error('agent-brief', e); return false; }
}
