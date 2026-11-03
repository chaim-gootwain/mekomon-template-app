/* ============================================================
sales-hub.js — "מוקד מכירות" (מנהל בלבד)
------------------------------------------------------------
סביבת ניהול לצוות המכירות: מרכז בקרה, צוות ויעדים, קליטה והכשרה
(שבוע ראשון), קורסים, נהלים, שגרת ניהול, דיווחים יומיים והודעות
לצוות. מבוסס על "הכפלה — ניהול מוקד מכירות".

- הסוכנים הם הסוכנים הפעילים מטבלת agents; היעד החודשי הוא
  agents.monthly_target (אותו שדה של מסך "סוכנים").
- דיווחי סוף יום: טבלת sales_hub_reports (דיווח אחד לסוכן ליום).
- שאר המצב (סימוני הכשרה, קורסים, משוב, נהלים והודעות שנערכו):
  טבלת sales_hub_store — מפתח → JSONB. מפתח חסר = ברירת המחדל כאן.
- מתג: settings.sales_hub_enabled ('0' כברירת מחדל). כבוי — הפריט
  מוסתר מהתפריט. RLS בשתי הטבלאות: מנהל פעיל בלבד.
- מיגרציה: migrations/2026-10-23_sales_hub.sql
============================================================ */

'use strict';

function shOn() { return String((cache.settings || {}).sales_hub_enabled || '0') === '1'; }

let _shTab = 'dash';
let _shAgent = null;   // id של הסוכן הנבחר בהכשרה/קורסים
let _shDay = 0;        // יום בשבוע הקליטה (0–4)
let _shStore = {};     // key → data
let _shReports = [];

const SH_TABS = [
  ['dash', '◫ מרכז הבקרה'],
  ['team', '♧ צוות ויעדים'],
  ['training', '▥ קליטה והכשרה'],
  ['courses', '▷ קורסים'],
  ['procedures', '☷ נהלים וכללים'],
  ['routine', '◷ שגרת ניהול'],
  ['reports', '▤ דיווחים יומיים'],
  ['messages', '✉ הודעות לצוות'],
  ['contract', '✍ הסכם עבודה'],
];

const SH_TASKS = [
  ['הרשאות, טלפוניה ושעון נוכחות', 'היכרות עם המותג וההצעה', 'הדרכת מערכת של שעה', 'צפייה בפרק פתיחה וסיכום', 'שתי סימולציות ו־10 ניסיונות חיוג'],
  ['תרגול פתיחה ואבחון צורך', 'האזנה לשתי שיחות לדוגמה', '40 ניסיונות חיוג בכפוף למוכנות', 'בדיקת תיעוד ומשוב אישי'],
  ['פרק בסדנה ותרגול התנגדויות', 'חזרה ללקוחות מימים קודמים', 'שני בלוקים של עבודה עצמאית', 'פעולה הבאה ומועד לכל ליד'],
  ['תרגול הצעה וסגירה', 'פולואפים להצעות פתוחות', 'האזנה לשתי שיחות של הסוכן', 'יישום תיקון אחד בשיחה הבאה'],
  ['סימולציה מלאה', 'סקירת שיחות ותיעוד', 'שיחת סיכום עם המנהל', 'קביעת יעד והחלטת מוכנות לשבוע הבא'],
];

const SH_DEFAULTS = {
  courses: [
    { name: 'קורס המכירות המלא', description: 'קישור לקורס המכירות. הגישה כפופה להרשאות הקורס.', url: '' },
    { name: 'סדנת מכירות', description: 'הכשרת מכירות ותרגול שיחות. יש להוסיף את קישור הסדנה.', url: '' },
    { name: 'היכרות עם המותג והמערכת', description: 'הקלטת הדרכה: מוצרים, קהל יעד, CRM וקבלת לידים.', url: '' },
  ],
  procedures: [
    { title: 'פתיחת יום ונוכחות', body: 'כניסה לשעון הנוכחות לפי העבודה בפועל. פתיחת המערכת, בדיקת חזרות ומשימות וקביעת יעד אישי. איחור או היעדרות מדווחים למנהל.' },
    { title: 'בעלות וחלוקת לידים', body: 'לכל ליד אחראי יחיד. המנהל מחלק לידים בהתאם לזמינות, עומס והתאמה. כל העברה בין סוכנים מתועדת. אין שינוי בעלות ללא תיאום.' },
    { title: 'תיעוד ופעולה הבאה', body: 'בסיום כל שיחה מתעדים צורך, תוצאה, התנגדות וסטטוס. לכל ליד פעיל קובעים פעולה הבאה עם תאריך ושעה. אין להשאיר משימה באיחור בלי החלטה מתועדת.' },
    { title: 'מחירים והבטחות ללקוח', body: 'משתמשים במחירון ובהצעה המאושרים בלבד. הנחה, תנאי תשלום או התחייבות חריגה מחייבים אישור המנהל לפני מסירתם ללקוח.' },
    { title: 'פולואפ וחזרות', body: 'חוזרים ללקוח במועד שנקבע. המנהל מגדיר חלון תגובה לליד חדש בהתאם לשעות המוקד. מתעדים גם אי־מענה ואת הניסיון הבא.' },
    { title: 'הכשרה ומשוב', body: 'אחרי כל פרק: שלוש תובנות ויישום אחד. בכל משוב: חיזוק אחד, תיקון אחד ובדיקה בשיחה הבאה. צפייה לבדה אינה אישור מוכנות.' },
    { title: 'הצפת חסמים', body: 'מציפים בזמן אמת: מה קרה, מה נוסה ומה העזרה הנדרשת. מחיר חריג, תלונה או חוסר בהירות במוצר מועברים למנהל.' },
    { title: 'סגירת יום', body: 'מעדכנים את המערכת, מדווחים פעילות ותוצאות, מציפים חסמים ומכינים את מחר. הדוח מסכם את היום; אינו מחליף תיעוד לקוחות.' },
    { title: 'מידע והרשאות', body: 'משתמשים בחשבון אישי ובהרשאות המתאימות לתפקיד. אין לשתף סיסמאות.' },
    { title: 'שכר ועמלות · טיוטה לבירור', body: '50 ₪ לשעה; עד 15,000 ₪ — 10%; בין 15,000 ל־30,000 ₪ — 14%; מעל 30,000 ₪ — 17%. בונוס של 500 ₪ בחודש שבו המכירות מגיעות ל־30,000 ₪. נדרש להבהיר אם החישוב מדורג או על כלל המכירות, תקופת החישוב, בסיס גבייה או חתימה, מע״מ וביטולים.' },
  ],
  messages: [
    { title: 'בוקר טוב', body: '*בוקר טוב צוות 🔥*\n\nהיעד הצוותי היום: ___\nהמיקוד המקצועי: ___\n\nנכנסים לשעון נוכחות, פותחים את המערכת ובודקים חזרות.\n\nכל אחד משתף:\n*היעד שלי:* ___\n*הפעולה שלי להשגת היעד:* ___\n\nנתקעתם? מציפים בזמן.\n*יום של עשייה ותוצאות!*' },
    { title: 'אמצע יום', body: '*עדכון אמצע יום | שם: ___*\n\nחיוגים: ___\nשיחות משמעותיות: ___\nהצעות: ___\nעסקאות: ___\nמכירות: ___ ₪\n\nהפער מול היעד: ___\nהמיקוד עד סוף היום: ___\nהעזרה שאני צריך: ___' },
    { title: 'סיכום שבוע', body: '*צוות, מסכמים שבוע 💪*\n\nהיעד: ___ ₪\nמכירות בפועל: ___ ₪\nעסקאות שנסגרו: ___\n\nהניצחון של השבוע: ___\nפרגון על התקדמות: ___\nמה למדנו: ___\nמה נשפר: ___\n\n*המיקוד לשבוע הבא: ___*\n\nממשיכים לעלות רמה, שיחה אחרי שיחה.' },
  ],
  checks: {},   // 'agentId-day-task' → true
  lessons: {},  // 'agentId-courseIdx' → true
  notes: {},    // agentId → טקסט משוב
  // הסכם עבודה: תנאים כלליים (זהים לכל הסוכנים) + פרטים אישיים לכל סוכן
  contract: {
    employer: '', employer_id: '', employer_address: '', signer: '',
    role: 'נציג/ת מכירות פרסום', scope: 'משרה חלקית, לפי סידור עבודה שבועי שייקבע מראש בתיאום',
    hourly: 50, tier1_cap: 15000, tier1_pct: 10, tier2_cap: 30000, tier2_pct: 14, tier3_pct: 17,
    bonus_threshold: 30000, bonus_amount: 500,
    tier_mode: 'graded', basis: 'collected', trial_months: 3, trial_unit: 'months', weekly_target: 5000, tail_days: 30, extra: '',  // trial_months = אורך תקופת הניסיון ביחידות trial_unit
  },
  contract_people: {},  // agentId → { id_number, address, start_date }
};

const SH_SCHEDULE = [
  ['09:00', 'פותחים יום', 'נוכחות, מערכת ויעד אישי'],
  ['09:10', 'התנעה קצרה', 'מיקוד והתחייבות לפעולה'],
  ['12:30', 'בדיקת אמצע יום', 'פערים, חסמים ועזרה'],
  ['14:40', 'אימון ומשוב', 'לפי התוכנית השבועית'],
  ['16:40', 'סגירת יום', 'דוח, תיעוד והכנת מחר'],
];

const SH_REPORT_NUMS = [
  ['hours', 'שעות עבודה'], ['dials', 'ניסיונות חיוג'], ['conversations', 'שיחות משמעותיות'],
  ['offers', 'הצעות שנשלחו'], ['followups', 'פולואפים שבוצעו'], ['deals', 'עסקאות שנסגרו'],
  ['sales', 'מכירות ₪'], ['collected', 'גבייה בפועל ₪'],
];

/* ---------- נתונים ---------- */
function shAgents() { return (cache.agents || []).filter(a => a.active !== false); }
function shGet(key) { return _shStore[key] !== undefined ? _shStore[key] : JSON.parse(JSON.stringify(SH_DEFAULTS[key])); }
async function shSet(key, data) {
  await run(db.from('sales_hub_store').upsert({ key, data, updated_at: new Date().toISOString() }), 'שמירה נכשלה');
  _shStore[key] = data;
}
async function shLoad() {
  const since = new Date(); since.setDate(since.getDate() - 120);
  const [store, reports] = await Promise.all([
    run(db.from('sales_hub_store').select('key,data'), 'טעינת מוקד המכירות'),
    runAll((f, t) => db.from('sales_hub_reports').select('*').gte('report_date', localDay(since)).order('id').range(f, t), 'טעינת דיווחים'),
  ]);
  _shStore = {};
  (store || []).forEach(r => _shStore[r.key] = r.data);
  _shReports = reports || [];
}
function shSum(rows, k) { return rows.reduce((s, r) => s + Number(r[k] || 0), 0); }
function shCompletion(agentId) {
  const checks = shGet('checks'), total = SH_TASKS.flat().length;
  const n = Object.entries(checks).filter(([k, v]) => v && k.startsWith(agentId + '-')).length;
  return Math.round(n / total * 100);
}
function shBar(pct) {
  return `<div style="height:7px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:var(--brand)"></div></div>`;
}
function shAgentSelect() {
  const ags = shAgents();
  if (!ags.some(a => a.id === _shAgent)) _shAgent = ags[0] ? ags[0].id : null;
  return `<select style="width:auto" onchange="_shAgent=Number(this.value);shRender()">${ags.map(a => `<option value="${a.id}" ${a.id === _shAgent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
}

/* ---------- דף ---------- */
Pages['sales-hub'] = {
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">למנהל בלבד</div>'; return; }
    if (!shOn()) { el.innerHTML = '<div class="card card-pad"><p class="empty">מוקד המכירות כבוי. מפעילים בהגדרות → "🎯 מוקד מכירות".</p></div>'; return; }
    try { await shLoad(); }
    catch (e) { el.innerHTML = '<div class="card card-pad"><p class="empty">לא ניתן לטעון את מוקד המכירות — ודאו שהורצה המיגרציה 2026-10-23_sales_hub.sql</p></div>'; return; }
    el.innerHTML = `<div class="tabs" id="shTabs">${SH_TABS.map(([id, t]) => `<button class="${_shTab === id ? 'active' : ''}" onclick="shGo('${id}')">${t}</button>`).join('')}</div><div id="shBody"></div>`;
    shRender();
  }
};

function shGo(tab) {
  _shTab = tab;
  document.querySelectorAll('#shTabs button').forEach((b, i) => b.classList.toggle('active', SH_TABS[i][0] === tab));
  shRender();
}

function shRender() {
  const body = document.getElementById('shBody');
  if (!body) return;
  body.innerHTML = (SH_VIEWS[_shTab] || SH_VIEWS.dash)();
  if (_shTab === 'reports') shDrawReports();
}

const SH_VIEWS = {
  dash() {
    const ags = shAgents(), d = today(), ym = thisMonth();
    const todays = _shReports.filter(r => r.report_date === d);
    const monthly = _shReports.filter(r => String(r.report_date).slice(0, 7) === ym);
    const goal = shSum(ags, 'monthly_target'), sales = shSum(monthly, 'sales');
    const reported = new Set(todays.map(r => r.agent_id));
    const blockers = todays.filter(r => (r.blockers || '').trim());
    return `
<div class="page-head"><h2>מרכז הבקרה</h2><button class="btn" onclick="shReportForm()">＋ דיווח יומי חדש</button></div>
<div class="stats">
<div class="stat"><div class="num">${money(sales) || '₪0'}</div><div class="lbl">מכירות החודש ${goal ? 'מתוך יעד ' + money(goal) : '· יש להגדיר יעדים'}</div></div>
<div class="stat"><div class="num">${shSum(todays, 'dials')}</div><div class="lbl">חיוגים היום</div></div>
<div class="stat"><div class="num">${shSum(todays, 'deals')}</div><div class="lbl">עסקאות היום</div></div>
<div class="stat"><div class="num">${reported.size} / ${ags.length}</div><div class="lbl">דיווחים היום</div></div>
</div>
<div class="grid2" style="gap:16px;margin-top:16px;align-items:start">
<div>
<div class="card card-pad" style="margin-bottom:16px"><div class="page-head" style="margin:0 0 8px"><b>הצוות במבט אחד</b><button class="btn btn-sm btn-ghost" onclick="shGo('team')">ניהול הצוות ←</button></div>
${ags.length ? ags.map(a => {
      const val = shSum(monthly.filter(r => r.agent_id === a.id), 'sales'), t = Number(a.monthly_target || 0);
      return `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
<div style="flex:1"><b>${esc(a.name)}</b><div class="muted" style="font-size:.78rem">הכשרה: ${shCompletion(a.id)}%</div></div>
<div style="min-width:120px"><b>${money(val) || '₪0'}</b><div class="muted" style="font-size:.76rem">${t ? 'מתוך ' + money(t) : 'יעד טרם הוגדר'}</div>${shBar(t ? val / t * 100 : 0)}</div>
<span class="pill ${reported.has(a.id) ? 'green' : ''}">${reported.has(a.id) ? 'דיווח התקבל' : 'ממתין לדיווח'}</span></div>`;
    }).join('') : '<div class="empty">אין סוכנים פעילים — מוסיפים במסך "סוכנים"</div>'}
</div>
<div class="card card-pad"><div class="page-head" style="margin:0 0 8px"><b>קליטה והתקדמות</b><button class="btn btn-sm btn-ghost" onclick="shGo('training')">לגאנט ההכשרה ←</button></div>
${ags.map(a => `<div style="display:flex;gap:10px;align-items:center;padding:4px 0"><span style="width:110px">${esc(a.name)}</span><div style="flex:1">${shBar(shCompletion(a.id))}</div><b>${shCompletion(a.id)}%</b></div>`).join('')}
</div>
</div>
<div>
<div class="card card-pad" style="margin-bottom:16px"><b>סדר היום</b> <span class="pill">תכנון לדוגמה</span>
${SH_SCHEDULE.map(x => `<div style="display:flex;gap:12px;padding:7px 0;border-top:1px solid var(--line)"><b dir="ltr" style="min-width:48px">${x[0]}</b><div><b>${x[1]}</b><div class="muted" style="font-size:.78rem">${x[2]}</div></div></div>`).join('')}
</div>
<div class="card card-pad"><b>דורש תשומת לב</b>
<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line);margin-top:8px"><span>יעדים שלא הוגדרו</span><b>${ags.filter(a => !Number(a.monthly_target)).length}</b></div>
<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)"><span>קורסים ללא קישור</span><b>${shGet('courses').filter(c => !c.url).length}</b></div>
<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)"><span>חסמים בדיווחי היום</span><b>${blockers.length}</b></div>
${blockers.map(r => `<div class="muted" style="font-size:.8rem;padding:2px 0">• <b>${esc(nameOf('agents', r.agent_id))}:</b> ${esc(r.blockers)}</div>`).join('')}
<button class="btn btn-sm btn-ghost" style="margin-top:8px" onclick="shGo('reports')">פתיחת הדיווחים</button>
</div>
</div>
</div>`;
  },

  team() {
    const ym = thisMonth();
    const monthly = _shReports.filter(r => String(r.report_date).slice(0, 7) === ym);
    const notes = shGet('notes');
    return `
<div class="page-head"><h2>צוות ויעדים</h2><button class="btn" onclick="shOnboard()">＋ איש/אשת מכירות חדש/ה</button></div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">יעדים חודשיים — אותו יעד של מסך "סוכנים". הסכומים מחושבים מהדיווחים היומיים של החודש הנוכחי.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px">
${shAgents().map(a => {
      const val = shSum(monthly.filter(r => r.agent_id === a.id), 'sales'), t = Number(a.monthly_target || 0);
      return `<div class="card card-pad"><b style="font-size:1.05rem">${esc(a.name)}</b>
<div class="muted" style="margin-top:12px;font-size:.8rem">יעד חודשי</div>
<div style="font-size:1.4rem;font-weight:800">${t ? money(t) : 'טרם הוגדר'}</div>
<div class="muted" style="font-size:.8rem">בוצע החודש: ${money(val) || '₪0'}</div>${shBar(t ? val / t * 100 : 0)}
<div class="muted" style="font-size:.8rem;margin-top:10px">${shCompletion(a.id)}% מתוכנית ההכשרה</div>${shBar(shCompletion(a.id))}
${notes[a.id] ? `<div class="muted" style="font-size:.78rem;margin-top:8px;white-space:pre-wrap">📝 ${esc(String(notes[a.id]).slice(0, 140))}${String(notes[a.id]).length > 140 ? '…' : ''}</div>` : ''}
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
<button class="btn btn-sm btn-ghost" onclick="shGoalForm(${a.id})">יעד</button>
<button class="btn btn-sm btn-ghost" onclick="_shAgent=${a.id};shGo('training')">תיק הכשרה</button>
<button class="btn btn-sm btn-ghost" onclick="shCoach(${a.id})">משוב אישי</button>
<button class="btn btn-sm btn-ghost" onclick="shContractForm(${a.id})">📄 הסכם עבודה</button>
</div></div>`;
    }).join('') || '<div class="empty">אין סוכנים פעילים</div>'}
</div>`;
  },

  training() {
    const sel = shAgentSelect(), checks = shGet('checks');
    const gantt = [
      ['מותג ומערכת', 1, 2, 'בסיס', 'var(--accent)'],
      ['סדנת מכירות', 1, 4, 'למידה ויישום', 'var(--accent)'],
      ['סימולציות ושיחות', 1, 5, 'פתיחה · אבחון · התנגדויות · סגירה', 'var(--brand)'],
      ['עבודה עצמאית', 3, 6, 'שיחות ופולואפים עם בקרה', 'var(--brand)'],
      ['משוב ודיווח', 1, 6, 'האזנה · תיקון אחד · דוח סוף יום', 'var(--ok)'],
    ];
    return `
<div class="card card-pad" style="margin-bottom:16px;overflow-x:auto"><b>גאנט הכשרה · שבוע ראשון</b> <span class="pill">5 ימי עבודה</span>
<div style="display:grid;grid-template-columns:140px repeat(5,minmax(70px,1fr));gap:6px;margin-top:12px;min-width:560px;font-size:.82rem">
<div class="muted">מסלול</div>${[1, 2, 3, 4, 5].map(d => `<div class="muted" style="text-align:center">יום ${d}</div>`).join('')}
${gantt.map(([n, from, to, t, c]) => `<div>${n}</div><div style="grid-column:${from + 1}/${to + 1};background:${c};color:#fff;border-radius:6px;padding:4px 8px;text-align:center">${t}</div>${to <= 5 ? `<div style="grid-column:${to + 1}/7"></div>` : ''}`).join('')}
</div></div>
<div class="card card-pad"><div class="page-head" style="margin:0 0 8px"><b>תיק הכשרה אישי</b>${sel}</div>
${_shAgent == null ? '<div class="empty">אין סוכנים פעילים</div>' : `
<div class="tabs" style="margin-bottom:10px">${SH_TASKS.map((_, i) => `<button class="${_shDay === i ? 'active' : ''}" onclick="_shDay=${i};shRender()">יום ${i + 1}</button>`).join('')}</div>
${SH_TASKS[_shDay].map((t, i) => { const k = `${_shAgent}-${_shDay}-${i}`; return `<label style="display:flex;gap:10px;align-items:center;padding:8px 0;cursor:pointer;border-top:1px solid var(--line)"><input type="checkbox" ${checks[k] ? 'checked' : ''} onchange="shCheck('${k}',this.checked)" style="width:18px;height:18px"><span>${t}</span></label>`; }).join('')}
<p class="muted" style="font-size:.8rem;margin-top:10px">10 ו־40 הם ניסיונות חיוג. הגדלת כמות מותנית במוכנות ובזמינות לידים.</p>
${_shDay === 4 ? `<button class="btn btn-sm" onclick="shCoach(${_shAgent})">תיעוד החלטת מוכנות ומשוב</button>` : ''}`}
</div>`;
  },

  courses() {
    const sel = shAgentSelect(), lessons = shGet('lessons');
    return `
<div class="page-head"><h2>ספריית ההכשרה</h2><div style="display:flex;gap:8px;align-items:center">${sel}<button class="btn" onclick="shCourseForm()">＋ הוספת קורס</button></div></div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">הקישורים נפתחים אצל ספק התוכן. סימון ההשלמה ידני ואינו מודד צפייה.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px">
${shGet('courses').map((c, i) => `<div class="card card-pad"><b>▷ ${esc(c.name)}</b>
<p class="muted" style="font-size:.82rem;margin:6px 0">${esc(c.description)}</p>
<span class="pill ${c.url ? 'green' : ''}">${c.url ? 'קישור הוגדר' : 'ממתין לקישור'}</span>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
${c.url ? `<a class="btn btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">פתיחת הקורס ↗</a>` : ''}
<button class="btn btn-sm btn-ghost" onclick="shCourseForm(${i})">עריכה</button>
<button class="btn btn-sm btn-ghost" onclick="shCourseDelete(${i})">מחיקה</button></div>
${_shAgent != null ? `<label style="display:flex;gap:8px;align-items:center;margin-top:12px;cursor:pointer"><input type="checkbox" ${lessons[_shAgent + '-' + i] ? 'checked' : ''} onchange="shLesson('${_shAgent}-${i}',this.checked)" style="width:18px;height:18px">סיים/ה צפייה ותרגול</label>` : ''}
</div>`).join('')}
</div>
<div class="card card-pad" style="margin-top:16px"><b>אחרי כל פרק</b><p class="muted">3 תובנות מהצפייה · יישום אחד בשיחה · שיתוף במשוב.</p>
${_shAgent != null ? `<button class="btn btn-sm btn-ghost" onclick="shCoach(${_shAgent})">תיעוד תובנות ויישום</button>` : ''}</div>`;
  },

  procedures() {
    return `
<div class="page-head"><h2>שיטה ברורה. עבודה מסודרת.</h2><button class="btn btn-ghost" onclick="shListEdit('procedures')">✏️ עריכת הנהלים</button></div>
<div class="card card-pad" style="margin-bottom:14px"><b>לכל ליד אחראי. לכל שיחה תיעוד. לכל המשך מועד.</b><div class="muted" style="font-size:.85rem">שלושת הכללים שמחזיקים את רצף העבודה של הצוות.</div></div>
${shGet('procedures').map(p => `<details class="card card-pad" style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:700">${esc(p.title)}</summary><p style="margin-top:8px;white-space:pre-wrap">${esc(p.body)}</p></details>`).join('')}`;
  },

  contract() {
    const c = shGet('contract'), people = shGet('contract_people');
    const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--line)"><span class="muted">${k}</span><b>${v || '<span style="color:#b91c1c">חסר</span>'}</b></div>`;
    return `
<div class="page-head"><h2>הסכם עבודה לאנשי מכירות</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" onclick="shOnboard()">＋ איש/אשת מכירות חדש/ה</button><button class="btn btn-ghost" onclick="shContractTerms()">✏️ עריכת תנאי ההסכם</button></div></div>
<div class="card card-pad" style="margin-bottom:14px;background:#fff8e6;border-color:#f3d48a"><b>⚠ נוסח לדוגמה</b><div class="muted" style="font-size:.85rem">ההסכם מבוסס על דיני העבודה בישראל ומהווה גם הודעה לעובד על תנאי העבודה. מומלץ לעבור עליו פעם אחת עם עו״ד או רו״ח לפני החתימה הראשונה.</div></div>
<div class="grid2" style="gap:16px;align-items:start">
<div class="card card-pad"><b>תנאים כלליים</b>
${row('המעסיק', esc(c.employer || (cache.settings || {}).paper_name || ''))}
${row('ח.פ / ע.מ', esc(c.employer_id))}
${row('כתובת המעסיק', esc(c.employer_address))}
${row('חותם בשם המעסיק', esc(c.signer))}
${row('תפקיד', esc(c.role))}
${row('שכר שעתי', money(c.hourly))}
${row('עמלות', esc(shTiersText(c, true)))}
${row('בונוס חודשי', Number(c.bonus_amount) ? money(c.bonus_amount) + ' במכירות של ' + money(c.bonus_threshold) + ' ומעלה' : 'ללא')}
${row('בסיס העמלה', c.basis === 'signed' ? 'הזמנות חתומות' : 'נגבה בפועל')}
${row('יעד מכירות שבועי', Number(c.weekly_target) ? 'לפחות ' + money(c.weekly_target) : 'ללא')}
${row('תקופת ניסיון', shTrialText(c) || 'ללא')}
</div>
<div class="card card-pad"><b>הפקת הסכם לסוכן</b>
${shAgents().map(a => `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
<div style="flex:1"><b>${esc(a.name)}</b><div class="muted" style="font-size:.78rem">${people[a.id] && people[a.id].start_date ? 'תחילת עבודה: ' + heDate(people[a.id].start_date) : 'פרטים אישיים טרם הוזנו'}</div></div>
<button class="btn btn-sm" onclick="shContractForm(${a.id})">📄 הפקת הסכם</button></div>`).join('') || '<div class="empty">אין סוכנים פעילים</div>'}
</div>
</div>`;
  },

  routine() {
    const week = [['יום ראשון', 'זריקת אנרגיה', '30 דקות · הצלחות ויעדים'], ['יום שני', 'אימון פתיחת שיחה', '15 דקות · אבחון צורך'], ['יום שלישי', 'בקרת אמצע שבוע', '20 דקות · פערים וחסמים'], ['יום רביעי', 'התנגדויות ופולואפ', '20 דקות · מקרים אמיתיים'], ['יום חמישי', 'סיכום ותכנון', '25 דקות · למידה ויעדים']];
    const sunday = [['ניצחונות והצלחות', 5], ['זריקת אנרגיה וסיפור לקוח', 5], ['יעד מול ביצוע', 7], ['תרגול מיומנות אחת', 8], ['התחייבות אישית לשבוע', 5]];
    const anchors = [['פתיחת משמרת', 'נוכחות, הודעת בוקר ויעד'], ['אמצע יום', 'פעילות, פער ועזרה נדרשת'], ['סיום משמרת', 'דוח תוצאות ותכנון מחר'], ['משוב אישי', '15 דקות לכל סוכן בשבוע']];
    return `
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:16px">
${week.map(w => `<div class="card card-pad"><div class="muted" style="font-size:.78rem">${w[0]}</div><b>${w[1]}</b><div class="muted" style="font-size:.78rem">${w[2]}</div></div>`).join('')}
</div>
<div class="grid2" style="gap:16px;align-items:start">
<div class="card card-pad"><b>ישיבת ראשון · 30 דקות</b>
${sunday.map(s => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--line)"><span>${s[0]}</span><span class="muted">${s[1]} דקות</span></div>`).join('')}</div>
<div class="card card-pad"><b>העוגנים היומיים</b>
${anchors.map(s => `<div style="padding:7px 0;border-top:1px solid var(--line)"><b>${s[0]}</b><div class="muted" style="font-size:.8rem">${s[1]}</div></div>`).join('')}
<div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-sm btn-ghost" onclick="shGo('messages')">לתבניות ההודעות</button><button class="btn btn-sm btn-ghost" onclick="shGo('reports')">דוחות הצוות</button></div></div>
</div>
<p class="muted" style="font-size:.8rem;margin-top:12px">המסגרת לדוגמה היא ראשון עד חמישי, 09:00–17:00. שעות והפסקות מותאמות לעבודה בפועל.</p>`;
  },

  reports() {
    return `
<div class="page-head"><h2>יומן דיווחים</h2><div style="display:flex;gap:8px"><button class="btn btn-ghost" onclick="shReportsCsv()">⬇ ייצוא</button><button class="btn" onclick="shReportForm()">＋ דיווח חדש</button></div></div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">פעילות, תוצאות וחסמים. כל דיווח מעדכן את מרכז הבקרה. מוצגים 120 הימים האחרונים.</p>
<div class="card" id="shReportsTable"></div>`;
  },

  messages() {
    return `
<div class="page-head"><h2>מילים שמניעות את הצוות</h2><button class="btn btn-ghost" onclick="shListEdit('messages')">✏️ עריכת התבניות</button></div>
<p class="muted" style="font-size:.85rem;margin-bottom:12px">תבניות מוכנות להעתקה. משלימים יעדים ונתונים לפני שליחה.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
${shGet('messages').map((m, i) => `<div class="card card-pad"><b>${esc(m.title)}</b><pre style="white-space:pre-wrap;font-family:inherit;font-size:.85rem;margin:8px 0">${esc(m.body)}</pre><button class="btn btn-sm" onclick="shCopyMsg(${i})">העתקת ההודעה</button></div>`).join('')}
</div>`;
  },
};

function shSortedReports() {
  return [..._shReports].sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)) || b.id - a.id);
}
function shDrawReports() {
  const box = document.getElementById('shReportsTable');
  if (!box) return;
  renderTable(box, shSortedReports(), [
        { h: 'תאריך', f: r => heDate(r.report_date) },
        { h: 'סוכן', f: r => `<b>${esc(nameOf('agents', r.agent_id))}</b>` },
        { h: 'שעות', f: r => r.hours ?? '' },
        { h: 'חיוגים', f: r => r.dials ?? '' },
        { h: 'שיחות', f: r => r.conversations ?? '' },
        { h: 'הצעות', f: r => r.offers ?? '' },
        { h: 'עסקאות', f: r => r.deals ?? '' },
        { h: 'מכירות', f: r => money(r.sales) },
        { h: 'גבייה', f: r => money(r.collected) },
        { h: 'חסם', f: r => r.blockers ? `<span class="pill amber" title="${esc(r.blockers)}">חסם</span>` : '' },
  ], { onRow: r => shReportForm(r.id), empty: 'לא הוזנו דיווחים עדיין' });
}

/* ---------- פעולות ---------- */
function shReportForm(id) {
  const r = _shReports.find(x => x.id === id) || { report_date: today(), agent_id: _shAgent || (shAgents()[0] || {}).id };
  const fields = [
    { name: 'report_date', label: 'תאריך', type: 'date', required: true, half: true },
    { name: 'agent_id', label: 'סוכן', type: 'select', required: true, half: true, options: shAgents().map(a => ({ v: a.id, t: a.name })) },
    ...SH_REPORT_NUMS.map(([name, label]) => ({ name, label, type: 'number', half: true, default: 0 })),
    { name: 'blockers', label: 'חסם ועזרה נדרשת', type: 'textarea' },
    { name: 'learning', label: 'הצלחה, למידה ומיקוד למחר', type: 'textarea' },
  ];
  if (id) fields.push({ type: 'html', html: `<button type="button" class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="shReportDelete(${id})">🗑 מחיקת הדיווח</button>` });
  openForm(id ? 'עריכת דיווח' : 'דיווח סוף יום', fields, r, async (rec) => {
    SH_REPORT_NUMS.forEach(([k]) => { rec[k] = Math.max(0, Number(rec[k] || 0)); });
    if (rec.hours > 24) { toast('שעות עבודה — עד 24', true); throw new Error('hours'); }
    const dup = _shReports.find(x => x.id !== id && x.agent_id === rec.agent_id && x.report_date === rec.report_date);
    if (dup) { toast('כבר קיים דיווח לסוכן בתאריך זה — פתחו אותו לעריכה מהיומן', true); throw new Error('dup'); }
    if (id) await run(db.from('sales_hub_reports').update(rec).eq('id', id));
    else await run(db.from('sales_hub_reports').insert(rec));
    toast('הדיווח נשמר והמדדים עודכנו');
    await shLoad(); shRender();
  });
}

async function shReportDelete(id) {
  if (!confirm('למחוק את הדיווח?')) return;
  await run(db.from('sales_hub_reports').delete().eq('id', id));
  closeForm(); toast('הדיווח נמחק');
  await shLoad(); shRender();
}

function shReportsCsv() {
  const rows = shSortedReports().reverse();
  exportCsv('דיווחי_מוקד_' + today(),
    ['תאריך', 'סוכן', ...SH_REPORT_NUMS.map(x => x[1]), 'חסם', 'למידה'],
    rows.map(r => [r.report_date, nameOf('agents', r.agent_id), ...SH_REPORT_NUMS.map(([k]) => r[k]), r.blockers || '', r.learning || '']));
}

function shGoalForm(agentId) {
  const a = (cache.agents || []).find(x => x.id === agentId);
  if (!a) return;
  openForm('יעד חודשי · ' + a.name, [{ name: 'monthly_target', label: 'יעד מכירות חודשי (₪)', type: 'number' }], a, async (rec) => {
    await run(db.from('agents').update({ monthly_target: rec.monthly_target }).eq('id', agentId));
    a.monthly_target = rec.monthly_target;
    toast('היעד נשמר'); shRender();
  });
}

function shCoach(agentId) {
  const notes = shGet('notes');
  openForm('משוב אישי · ' + nameOf('agents', agentId), [
    { name: 'notes', label: 'חיזוק, תיקון, תובנות והחלטת מוכנות', type: 'textarea', rows: 8 },
  ], { notes: notes[agentId] || '' }, async (rec) => {
    notes[agentId] = rec.notes;
    await shSet('notes', notes);
    toast('המשוב נשמר'); shRender();
  });
}

async function shCheck(key, on) {
  const checks = shGet('checks');
  if (on) checks[key] = true; else delete checks[key];
  await shSet('checks', checks);
}

async function shLesson(key, on) {
  const lessons = shGet('lessons');
  if (on) lessons[key] = true; else delete lessons[key];
  await shSet('lessons', lessons);
}

function shCourseForm(i) {
  const list = shGet('courses');
  const c = list[i] || { name: '', description: '', url: '' };
  openForm(i === undefined ? 'קורס חדש' : 'עריכת קורס', [
    { name: 'name', label: 'שם הקורס', required: true },
    { name: 'description', label: 'תיאור', type: 'textarea' },
    { name: 'url', label: 'קישור לקורס (https://)', dir: 'ltr' },
  ], c, async (rec) => {
    if (rec.url && !/^https:\/\//i.test(rec.url)) { toast('יש להזין קישור שמתחיל ב-https://', true); throw new Error('url'); }
    if (i === undefined) list.push(rec); else list[i] = rec;
    await shSet('courses', list);
    toast('הקורס נשמר'); shRender();
  });
}

async function shCourseDelete(i) {
  const list = shGet('courses');
  if (!confirm('למחוק את הקורס "' + list[i].name + '"?')) return;
  list.splice(i, 1);
  // הסימונים נשמרים לפי מיקום — מזיזים אותם כדי שלא יעברו לקורס הבא
  const lessons = shGet('lessons'), next = {};
  Object.entries(lessons).forEach(([k, v]) => {
    const [ag, idx] = k.split('-').map(Number);
    if (idx < i) next[k] = v; else if (idx > i) next[ag + '-' + (idx - 1)] = v;
  });
  await shSet('courses', list);
  await shSet('lessons', next);
  toast('הקורס נמחק'); shRender();
}

/* עריכת נהלים/תבניות: כותרת בשורה שמתחילה ב-## והטקסט מתחתיה */
function shListEdit(key) {
  const text = shGet(key).map(x => '## ' + x.title + '\n' + x.body).join('\n\n');
  openForm(key === 'procedures' ? 'עריכת הנהלים' : 'עריכת תבניות ההודעות', [
    { type: 'html', html: '<p class="muted" style="font-size:.8rem">כל פריט מתחיל בשורה "## כותרת", והטקסט מתחתיה. ריקון מלא = חזרה לברירת המחדל.</p>' },
    { name: 'text', label: 'תוכן', type: 'textarea', rows: 18 },
  ], { text }, async (rec) => {
    const items = [];
    String(rec.text || '').split(/^##\s*/m).forEach(chunk => {
      const lines = chunk.split('\n'), title = lines.shift().trim();
      if (title) items.push({ title, body: lines.join('\n').trim() });
    });
    if (items.length) await shSet(key, items);
    else { await run(db.from('sales_hub_store').delete().eq('key', key)); delete _shStore[key]; }
    toast('נשמר'); shRender();
  });
}

/* ---------- הסכם עבודה ---------- */
function shTiersText(c, short) {
  const n = v => Number(v || 0).toLocaleString('he-IL');
  const top = c.tier3_pct === '' || c.tier3_pct == null ? c.tier2_pct : c.tier3_pct;
  const t = [
    `עד ${n(c.tier1_cap)} ₪ — ${Number(c.tier1_pct || 0)}%`,
    `מעל ${n(c.tier1_cap)} ₪ ועד ${n(c.tier2_cap)} ₪ — ${Number(c.tier2_pct || 0)}%`,
    `מעל ${n(c.tier2_cap)} ₪ — ${Number(top || 0)}%`,
  ];
  if (short) return t.join(' · ') + (c.tier_mode === 'whole' ? ' (על כל הסכום)' : ' (מדורג)');
  return t;
}

function shTrialText(c) {
  const k = Number(c.trial_months || 0);
  if (!k) return '';
  const w = c.trial_unit === 'weeks';
  if (k === 1) return w ? 'שבוע אחד' : 'חודש אחד';
  if (k === 2) return w ? 'שבועיים' : 'חודשיים';
  return k + (w ? ' שבועות' : ' חודשים');
}

function shContractTerms() {
  const c = shGet('contract');
  const rec0 = Object.assign({}, c, { employer: c.employer || (cache.settings || {}).paper_name || '' });
  openForm('תנאי הסכם העבודה', [
    { type: 'section', label: 'פרטי המעסיק' },
    { name: 'employer', label: 'שם המעסיק (כפי שרשום)' },
    { name: 'employer_id', label: 'ח.פ / ע.מ', dir: 'ltr' },
    { name: 'employer_address', label: 'כתובת המעסיק' },
    { name: 'signer', label: 'שם החותם בשם המעסיק' },
    { type: 'section', label: 'התפקיד' },
    { name: 'role', label: 'תואר התפקיד' },
    { name: 'scope', label: 'היקף המשרה' },
    { name: 'trial_months', label: 'אורך תקופת הניסיון (0 = ללא)', type: 'number' },
    { name: 'trial_unit', label: 'יחידת תקופת הניסיון', type: 'select', options: [{ v: 'months', t: 'חודשים' }, { v: 'weeks', t: 'שבועות' }] },
    { name: 'weekly_target', label: 'יעד מכירות שבועי מינימלי (₪, 0 = ללא)', type: 'number' },
    { type: 'section', label: 'שכר ועמלות' },
    { name: 'hourly', label: 'שכר שעתי ברוטו (₪)', type: 'number', required: true },
    { name: 'tier1_cap', label: 'מדרגה 1 — עד (₪ לחודש)', type: 'number' },
    { name: 'tier1_pct', label: 'מדרגה 1 — עמלה %', type: 'number' },
    { name: 'tier2_cap', label: 'מדרגה 2 — עד (₪ לחודש)', type: 'number' },
    { name: 'tier2_pct', label: 'מדרגה 2 — עמלה %', type: 'number' },
    { name: 'tier3_pct', label: 'מעל מדרגה 2 — עמלה %', type: 'number' },
    { name: 'tier_mode', label: 'אופן החישוב', type: 'select', options: [{ v: 'graded', t: 'מדורג — כל חלק לפי המדרגה שלו' }, { v: 'whole', t: 'על כל הסכום — לפי המדרגה שהושגה' }] },
    { name: 'basis', label: 'בסיס העמלה', type: 'select', options: [{ v: 'collected', t: 'סכומים שנגבו בפועל' }, { v: 'signed', t: 'הזמנות חתומות' }] },
    { name: 'bonus_threshold', label: 'בונוס — רף מכירות חודשי (₪)', type: 'number' },
    { name: 'bonus_amount', label: 'בונוס — סכום (₪, 0 = ללא)', type: 'number' },
    { name: 'tail_days', label: 'עמלה על גבייה אחרי סיום העבודה — עד כמה ימים', type: 'number' },
    { name: 'extra', label: 'סעיפים נוספים (יודפסו כסעיף "הוראות נוספות")', type: 'textarea', rows: 4 },
  ], rec0, async (rec) => {
    await shSet('contract', Object.assign({}, c, rec));
    toast('תנאי ההסכם נשמרו'); shRender();
  });
}

function shContractForm(agentId) {
  const a = (cache.agents || []).find(x => x.id === agentId);
  if (!a) return;
  const people = shGet('contract_people');
  const p = Object.assign({ start_date: today() }, people[agentId] || {});
  openForm('הסכם עבודה · ' + a.name, [
    { type: 'html', html: '<p class="muted" style="font-size:.8rem">הפרטים נשמרים להפקה חוזרת. התנאים הכלליים (שכר, עמלות, פרטי המעסיק) נערכים בלשונית "הסכם עבודה" במוקד המכירות.</p>' },
    { name: 'id_number', label: 'ת.ז של העובד', dir: 'ltr' },
    { name: 'address', label: 'כתובת העובד' },
    { name: 'start_date', label: 'תאריך תחילת עבודה', type: 'date', required: true },
  ], p, async (rec) => {
    // חלון ההדפסה נפתח לפני השמירה — כדי שלא ייחסם כחלון קופץ
    shContractPrint(a, rec);
    people[agentId] = rec;
    await shSet('contract_people', people);
  });
}

/* קליטת איש מכירות חדש במקום אחד: הזמנה למערכת (משתמש בתפקיד מכירות),
   רשומת סוכן, פרטי ההסכם ויעד — ואז הפקת הסכם העבודה */
function shOnboard() {
  openForm('איש/אשת מכירות חדש/ה', [
    { type: 'section', label: 'פרטים אישיים' },
    { name: 'name', label: 'שם מלא', required: true },
    { name: 'phone', label: 'טלפון', dir: 'ltr' },
    { name: 'email', label: 'אימייל', type: 'email', dir: 'ltr' },
    { name: 'id_number', label: 'ת.ז', dir: 'ltr' },
    { name: 'address', label: 'כתובת' },
    { type: 'section', label: 'עבודה' },
    { name: 'start_date', label: 'תאריך תחילת עבודה', type: 'date', required: true },
    { name: 'monthly_target', label: 'יעד מכירות חודשי (₪)', type: 'number' },
    { name: 'voicenter_ext', label: 'שלוחה (Voicenter) — אם יש', dir: 'ltr' },
    { type: 'section', label: 'מה לעשות עכשיו' },
    { name: 'invite', label: 'לשלוח הזמנה לכניסה למערכת (תפקיד מכירות — נדרש אימייל)', type: 'checkbox' },
    { name: 'print', label: 'להפיק הסכם עבודה מיד', type: 'checkbox' },
  ], { start_date: today(), invite: true, print: true }, async (rec) => {
    if (rec.invite && !rec.email) { toast('לשליחת הזמנה למערכת צריך אימייל — או לבטל את הסימון', true); throw new Error('email'); }
    // החלון נפתח מיד, לפני הפעולות מול השרת, כדי שלא ייחסם כחלון קופץ
    const win = rec.print ? window.open('', '_blank') : null;
    try {
      let profileId = null;
      if (rec.invite) {
        toast('שולח הזמנה...');
        const r = await _adminUsersCall({ action: 'invite', email: rec.email, full_name: rec.name, phone: rec.phone, role: 'sales', redirectTo: location.origin + '/set-password.html' });
        profileId = (r && r.id) || null;
      }
      const agent = await run(db.from('agents').insert({
        name: rec.name, phone: rec.phone || null, email: rec.email || null, voicenter_ext: rec.voicenter_ext || null,
        profile_id: profileId, monthly_target: rec.monthly_target, pct_new: 15, pct_renew: 7, bonus_type: 'none', active: true,
      }).select().single(), 'הוספת הסוכן נכשלה');
      const person = { id_number: rec.id_number, address: rec.address, start_date: rec.start_date };
      const people = shGet('contract_people');
      people[agent.id] = person;
      await shSet('contract_people', people);
      await refreshCache();
      if (win) shContractPrint(agent, person, win);
      toast(rec.name + ' נוסף/ה לצוות' + (rec.invite ? ' · הזמנה נשלחה ל-' + rec.email : ''));
      _shAgent = agent.id;
      shRender();
    } catch (e) {
      if (win) win.close();
      throw e;
    }
  });
}

function shContractPrint(a, p, win) {
  const c = shGet('contract');
  const employer = c.employer || (cache.settings || {}).paper_name || '@@PAPER_NAME@@';
  const blank = v => v ? esc(v) : '<span class="blank"></span>';
  // הלוגו של המופע — כתובת מלאה, כי חלון ההדפסה נפתח ריק (about:blank)
  const logo = new URL('img/logo.png', location.href).href;
  const n = v => Number(v || 0).toLocaleString('he-IL');
  const trial = shTrialText(c);
  const mode = c.tier_mode === 'whole'
    ? 'שיעור העמלה נקבע לפי סך המכירות של החודש וחל על כל הסכום, כדלקמן:'
    : 'העמלה מדורגת: כל חלק מסך המכירות החודשי מזכה בשיעור של המדרגה שבה הוא נמצא, כדלקמן:';
  const basis = c.basis === 'signed'
    ? 'העמלה תחושב על הזמנות פרסום חתומות שנסגרו על ידי העובד באותו חודש קלנדרי, לפני מע״מ ובניכוי הנחות. הזמנה שבוטלה או שלא נגבתה — העמלה בגינה תקוזז מהעמלות הבאות.'
    : 'העמלה תחושב על סכומים שנגבו בפועל באותו חודש קלנדרי מעסקאות שנסגרו על ידי העובד, לפני מע״מ ובניכוי הנחות, זיכויים וביטולים.';
  const sec = [
    ['התפקיד', `העובד מועסק בתפקיד <b>${esc(c.role)}</b>. תפקידו כולל איתור ופנייה למפרסמים, מכירת שטחי פרסום ושירותים נלווים של המעסיק, תיעוד מלא של כל פנייה, שיחה ותוצאה במערכת המעסיק, קביעת פעולת המשך לכל ליד, ביצוע פולואפים, וכל משימה נוספת הקשורה לתפקיד שתוטל עליו מעת לעת.<br>העובד יפעל לפי נהלי המכירות של המעסיק, ישתמש במחירון ובהצעות המאושרים בלבד, ולא ייתן ללקוח הנחה, תנאי תשלום או התחייבות חריגה ללא אישור מראש מהמעסיק.` + (Number(c.weekly_target) ? `<br>יעד המכירות השבועי של העובד הוא <b>לפחות ${n(c.weekly_target)} ₪</b> (לפי בסיס חישוב העמלה שבסעיף העמלות). העמידה ביעד תיבחן במסגרת המשוב והמעקב השוטפים.` : '')],
    ['תחילת העבודה ותקופת ניסיון', `העסקת העובד מתחילה ביום <b>${blank(heDate(p.start_date))}</b> והיא לתקופה בלתי קצובה.` + (trial ? ` תקופת הניסיון היא ${trial} מיום תחילת העבודה, ובמהלכה רשאי כל צד לסיים את ההעסקה בהודעה מוקדמת כקבוע בדין.` : '')],
    ['היקף המשרה ושעות העבודה', `${esc(c.scope)}. העובד ידווח על שעות עבודתו בשעון הנוכחות של המעסיק בכל יום עבודה. שעות נוספות יבוצעו רק באישור מראש של המעסיק וישולמו לפי חוק שעות עבודה ומנוחה. בסוף כל יום עבודה ימסור העובד דיווח פעילות כנדרש בנהלי המעסיק.`],
    ['שכר יסוד', `בעבור כל שעת עבודה ישולם לעובד שכר של <b>${n(c.hourly)} ₪ ברוטו</b>. השכר ישולם עד ה-9 בכל חודש בעבור החודש הקודם, בצירוף תלוש שכר.`],
    ['עמלות מכירה', `בנוסף לשכר היסוד תשולם לעובד עמלה חודשית. ${mode}<ul>${shTiersText(c).map(t => `<li>${esc(t)}</li>`).join('')}</ul>${basis}${Number(c.bonus_amount) ? `<br>בנוסף, בכל חודש שבו סך המכירות של העובד (לפי אותו בסיס חישוב) יגיע ל-${n(c.bonus_threshold)} ₪ ומעלה, ישולם לו בונוס של <b>${n(c.bonus_amount)} ₪ ברוטו</b>.` : ''}${Number(c.bonus_amount) ? '<br>העמלה והבונוס ישולמו יחד עם השכר של החודש שלאחר החודש שבו קמה הזכאות להם, ויפורטו בתלוש השכר.' : '<br>העמלה תשולם יחד עם השכר של החודש שלאחר החודש שבו קמה הזכאות לה, ותפורט בתלוש השכר.'} עסקה המיוחסת ליותר מעובד אחד תחולק לפי החלטת המעסיק שתימסר מראש. בעד עסקאות שנסגרו על ידי העובד לפני סיום ההעסקה ונגבו עד ${n(c.tail_days)} ימים לאחר סיומה — תשולם עמלה לפי סעיף זה.`],
    ['זכויות סוציאליות', 'העובד יהיה זכאי לכל הזכויות על פי דין, ובכלל זה: הפרשות לפנסיה ולפיצויי פיטורים לפי צו ההרחבה לביטוח פנסיוני מקיף במשק, ימי חופשה לפי חוק חופשה שנתית, דמי מחלה לפי חוק דמי מחלה, דמי הבראה, החזר הוצאות נסיעה לעבודה וימי חג — הכול לפי הדין וצווי ההרחבה החלים, ובהתאם להיקף משרתו.'],
    ['סודיות ומאגר הלקוחות', 'מאגר הלקוחות, הלידים, המחירונים, תנאי ההתקשרות עם לקוחות וכל מידע עסקי שיגיע לעובד במסגרת עבודתו הם רכוש המעסיק וסוד מסחרי שלו. העובד ישמור עליהם בסודיות מלאה במהלך העבודה ולאחריה, לא יעתיק, לא יוריד ולא יעביר אותם לאחר, ולא ישתמש בהם אלא לצורך עבודתו אצל המעסיק. העובד ישתמש רק בחשבון האישי שניתן לו במערכת, לא ישתף סיסמאות, וישמור על פרטיות הלקוחות לפי חוק הגנת הפרטיות.'],
    ['ציוד ומסמכים', 'כל ציוד, חומר שיווקי, מסמך או הרשאת גישה שיימסרו לעובד יוחזרו למעסיק עם סיום ההעסקה, וגישתו למערכות המעסיק תיחסם.'],
    ['סיום ההעסקה', 'כל צד רשאי לסיים את ההעסקה בהודעה מוקדמת בכתב, לפי חוק הודעה מוקדמת לפיטורים ולהתפטרות. המעסיק רשאי לוותר על עבודת העובד בתקופת ההודעה ולשלם לו את שכרו בעדה. עם סיום ההעסקה יועבר לעובד כל המגיע לו על פי דין והסכם זה.'],
  ];
  if ((c.extra || '').trim()) sec.push(['הוראות נוספות', esc(c.extra).replace(/\n/g, '<br>')]);
  sec.push(['כללי', 'הסכם זה מהווה גם הודעה לעובד על תנאי עבודתו לפי חוק הודעה לעובד ולמועמד לעבודה (תנאי עבודה), התשס״ב-2002. ההסכם הוא אישי ואינו כפוף להסכם קיבוצי. כל שינוי בו ייעשה בכתב ובחתימת שני הצדדים. אין באמור בהסכם זה כדי לגרוע מזכות המגיעה לעובד על פי דין.']);

  const w = win || window.open('', '_blank');
  if (!w) { toast('הדפדפן חסם חלון קופץ — אפשרו חלונות קופצים לאתר ונסו שוב', true); return; }
  w.document.write(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>הסכם עבודה — ${esc(a.name)}</title>
<style>
body{font-family:'Segoe UI',Arial,sans-serif;max-width:760px;margin:0 auto;padding:36px 30px;color:#1c2438;font-size:14px;line-height:1.7}
h1{color:@@COLOR_BRAND@@;font-size:22px;text-align:center;border-bottom:3px solid @@COLOR_GRAD@@;padding-bottom:8px;margin-bottom:4px}
.logo{text-align:center;margin-bottom:6px}.logo img{height:90px}
.sub{text-align:center;color:#64748b;margin-bottom:22px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
.parties div{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}
h3{font-size:15px;margin:16px 0 4px;color:@@COLOR_DARK@@}
ul{margin:4px 0;padding-right:22px}
.blank{display:inline-block;min-width:130px;border-bottom:1px solid #1c2438}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:48px}
.sign div{border-top:1px solid #1c2438;padding-top:6px;text-align:center}
.toolbar{text-align:center;margin-bottom:18px}
@media print{.toolbar{display:none}body{padding:0}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">🖨️ הדפסה / שמירה כ-PDF</button></div>
<div class="logo"><img src="${logo}" alt="${esc(employer)}" onerror="this.parentNode.remove()"></div>
<h1>הסכם עבודה</h1>
<div class="sub">שנערך ונחתם ביום ${heDate(today())}</div>
<div class="parties">
<div><b>המעסיק:</b> ${esc(employer)}<br>ח.פ / ע.מ: ${blank(c.employer_id)}<br>כתובת: ${blank(c.employer_address)}</div>
<div><b>העובד:</b> ${esc(a.name)}<br>ת.ז: ${blank(p.id_number)}<br>כתובת: ${blank(p.address)}${a.phone ? '<br>טלפון: <span dir="ltr">' + esc(a.phone) + '</span>' : ''}</div>
</div>
<p>הואיל והמעסיק מעוניין להעסיק את העובד בתפקיד מכירות, והעובד מעוניין להיות מועסק על ידו — הוסכם בין הצדדים כדלקמן:</p>
${sec.map(([t, b], i) => `<h3>${i + 1}. ${t}</h3><div>${b}</div>`).join('')}
<p style="margin-top:22px">ולראיה באו הצדדים על החתום:</p>
<div class="sign"><div>המעסיק${c.signer ? ' — ' + esc(c.signer) : ''}</div><div>העובד — ${esc(a.name)}</div></div>
</body></html>`);
  w.document.close();
}

async function shCopyMsg(i) {
  const m = shGet('messages')[i];
  try { await navigator.clipboard.writeText(m.body); toast('ההודעה הועתקה'); }
  catch (e) { openForm('בחרו והעתיקו את הנוסח', [{ name: 'body', label: m.title, type: 'textarea', rows: 14 }], { body: m.body }, async () => { }); }
}

async function shToggleSave(on) {
  await run(db.from('settings').upsert({ key: 'sales_hub_enabled', value: on ? '1' : '0' }));
  cache.settings.sales_hub_enabled = on ? '1' : '0';
  shNavSync();
  toast(on ? 'מוקד המכירות הופעל' : 'מוקד המכירות כובה');
}

/* ---------- הגדרות: כרטיס הפעלה ---------- */
(function () {
  const orig = typeof Pages !== 'undefined' && Pages.settings && Pages.settings.render;
  if (orig && !orig._shWrapped) {
    const wrapped = async function (el) {
      const r = await orig.apply(this, arguments);
      try {
        const card = document.createElement('div');
        card.className = 'card card-pad';
        card.innerHTML = `
<b>🎯 מוקד מכירות</b>
<p class="muted" style="font-size:.82rem">סביבת ניהול לצוות המכירות: מרכז בקרה, יעדים, שבוע קליטה, קורסים, נהלים, שגרת ניהול, דיווחי סוף יום ותבניות הודעות.
למנהל בלבד. דורש את המיגרציה 2026-10-23_sales_hub.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer">
<input type="checkbox" ${shOn() ? 'checked' : ''} onchange="shToggleSave(this.checked)" style="width:18px;height:18px">
המודול פעיל
</label>`;
        const anchor = el.querySelector('#activityLog');
        const anchorCard = anchor ? anchor.closest('.card') : null;
        if (anchorCard) el.insertBefore(card, anchorCard); else el.appendChild(card);
      } catch (e) { console.error('sales hub settings card', e); }
      return r;
    };
    wrapped._shWrapped = true;
    Pages.settings.render = wrapped;
  }
})();

/* ---------- תפריט: מנהל בלבד, מוסתר כשהמודול כבוי ---------- */
(function () {
  if (typeof NAV === 'undefined' || NAV.some(n => n.id === 'sales-hub')) return;
  const item = { id: 'sales-hub', title: 'מוקד מכירות', icon: '🎯', roles: ['admin'], group: 'ניהול' };
  const idx = NAV.findIndex(n => n.id === 'agent-perf');
  if (idx >= 0) NAV.splice(idx + 1, 0, item); else NAV.push(item);
})();
function shNavSync() {
  const b = document.getElementById('nav-sales-hub');
  if (b) b.classList.toggle('hidden', !shOn());
}
(function () {
  const orig = window.refreshCache;
  if (typeof orig === 'function' && !orig._shWrapped) {
    const wrapped = async function () {
      const r = await orig.apply(this, arguments);
      try { shNavSync(); } catch (e) { }
      return r;
    };
    wrapped._shWrapped = true;
    window.refreshCache = wrapped;
  }
  // לפני שההגדרות נטענות — מוסתר (כבוי כברירת מחדל)
  const origShell = window.buildShell;
  if (typeof origShell === 'function' && !origShell._shWrapped) {
    const w = function () { const r = origShell.apply(this, arguments); try { shNavSync(); } catch (e) { } return r; };
    w._shWrapped = true;
    window.buildShell = w;
  }
})();
