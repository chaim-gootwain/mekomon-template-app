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
    { title: 'שכר ועמלות · טיוטה לבירור', body: '50 ₪ לשעה; עד 15,000 ₪ — 10%; בין 15,000 ל־30,000 ₪ — 15%. נדרש להבהיר אם החישוב מדורג או על כלל המכירות, תקופת החישוב, בסיס גבייה או חתימה, מע״מ וביטולים.' },
  ],
  messages: [
    { title: 'בוקר טוב', body: '*בוקר טוב צוות 🔥*\n\nהיעד הצוותי היום: ___\nהמיקוד המקצועי: ___\n\nנכנסים לשעון נוכחות, פותחים את המערכת ובודקים חזרות.\n\nכל אחד משתף:\n*היעד שלי:* ___\n*הפעולה שלי להשגת היעד:* ___\n\nנתקעתם? מציפים בזמן.\n*יום של עשייה ותוצאות!*' },
    { title: 'אמצע יום', body: '*עדכון אמצע יום | שם: ___*\n\nחיוגים: ___\nשיחות משמעותיות: ___\nהצעות: ___\nעסקאות: ___\nמכירות: ___ ₪\n\nהפער מול היעד: ___\nהמיקוד עד סוף היום: ___\nהעזרה שאני צריך: ___' },
    { title: 'סיכום שבוע', body: '*צוות, מסכמים שבוע 💪*\n\nהיעד: ___ ₪\nמכירות בפועל: ___ ₪\nעסקאות שנסגרו: ___\n\nהניצחון של השבוע: ___\nפרגון על התקדמות: ___\nמה למדנו: ___\nמה נשפר: ___\n\n*המיקוד לשבוע הבא: ___*\n\nממשיכים לעלות רמה, שיחה אחרי שיחה.' },
  ],
  checks: {},   // 'agentId-day-task' → true
  lessons: {},  // 'agentId-courseIdx' → true
  notes: {},    // agentId → טקסט משוב
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
