/* ============================================================
beni.js — בני, עוזר המייל
------------------------------------------------------------
דשבורד אישור לטיוטות שבני מכין מתוך תיבת המייל.
- קורא מטבלת beni_drafts (RLS: admin בלבד)
- כל טיוטה: פתיחה ב-Gmail ושליחה · עריכה · סימון טופל · דחייה
- שום דבר לא נשלח מהמערכת עצמה — השליחה תמיד ביד המשתמש (ב-Gmail)
המודול מוסיף את עצמו ל-NAV ואינו נוגע בקבצים אחרים.
============================================================ */

'use strict';

/* חשבון ה-Gmail בדפדפן (0 = הראשון). שנה אם התיבה אינה החשבון הראשון. */
const BENI_GMAIL_U = 0;

/* קטגוריות: תווית + צבע pill */
const BENI_CAT = {
  advertiser:  ['מפרסם קיים', 'green'],
  lead:        ['ליד / עסק חדש', 'blue'],
  reader:      ['קורא / תושב', ''],
  institution: ['עירייה / מוסד', 'gold'],
  financial:   ['כספי', 'amber'],
  spam:        ['ספאם', ''],
  other:       ['אחר', ''],
};
function beniCatPill(cat) {
  const c = BENI_CAT[cat] || [cat, ''];
  return `<span class="pill ${c[1]}">${esc(c[0])}</span>`;
}

/* קישור לשרשור ב-Gmail (הטיוטה שבני יצר יושבת בתוכו) */
function beniGmailLink(row) {
  if (row.gmail_thread_id) return `https://mail.google.com/mail/u/${BENI_GMAIL_U}/#all/${encodeURIComponent(row.gmail_thread_id)}`;
  return `https://mail.google.com/mail/u/${BENI_GMAIL_U}/#drafts`;
}

let _beniRows = [];

/* ---------- רישום בתפריט (מיד אחרי "לידים", בקבוצת מכירות) ---------- */
(function beniRegisterNav() {
  if (typeof NAV === 'undefined') return;
  if (NAV.some(n => n.id === 'beni')) return;
  const i = NAV.findIndex(n => n.id === 'leads');
  const item = { id: 'beni', title: 'בני — מייל', icon: '📬', roles: ['admin'], group: 'מכירות' };
  NAV.splice(i >= 0 ? i + 1 : NAV.length, 0, item);
})();

/* ---------- הדף ---------- */
Pages.beni = {
  render: async (el) => {
    _beniRows = await run(
      db.from('beni_drafts').select('*').in('status', ['pending', 'needs_you']),
      'שגיאה בטעינת טיוטות בני'
    );
    /* דחופים למעלה, ואז לפי זמן קבלה */
    _beniRows.sort((a, b) =>
      (b.is_urgent === true) - (a.is_urgent === true) ||
      String(b.received_at || '').localeCompare(String(a.received_at || '')));

    el.innerHTML = `
      <div class="page-head">
        <h2>בני — טיוטות מייל</h2>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" onclick="openPage('beni')">↻ רענון</button>
        </div>
      </div>
      <div class="stats" id="beniStats"></div>
      <div id="beniList" style="margin-top:14px"></div>`;

    beniDraw();
    beniRefreshBadge();
  }
};

function beniDraw() {
  const urg = _beniRows.filter(r => r.is_urgent).length;
  const needy = _beniRows.filter(r => r.status === 'needs_you').length;
  document.getElementById('beniStats').innerHTML =
    stat(_beniRows.length, 'טיוטות ממתינות') +
    stat(urg, 'דחופות', urg ? 'red' : '') +
    stat(needy, 'דורשות אותך', needy ? 'gold' : '');

  const list = document.getElementById('beniList');
  if (!_beniRows.length) {
    list.innerHTML = `<div class="card card-pad empty">אין טיוטות ממתינות. הכול טופל! 👍</div>`;
    return;
  }

  list.innerHTML = _beniRows.map(r => {
    const needy = r.status === 'needs_you';
    const body = r.edited_body || r.draft_body || '';
    const head = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <b style="font-size:1.02rem">${esc(r.from_name || r.from_email || '—')}</b>
          ${beniCatPill(r.category)}
          ${r.is_urgent ? `<span class="pill red">דחוף${r.urgency_reason ? ' · ' + esc(r.urgency_reason) : ''}</span>` : ''}
          ${needy ? `<span class="pill gold">דורש אותך</span>` : ''}
          <div class="muted" style="font-size:.82rem;margin-top:2px" dir="ltr">${esc(r.from_email || '')}</div>
          <div class="muted" style="font-size:.9rem">${esc(r.subject || r.summary || '')}</div>
        </div>
      </div>`;

    const bodyBox = needy
      ? `<div class="card-pad" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin-top:10px;font-size:.92rem">
           ⚠️ ${esc(r.needs_input_reason || 'הפנייה דורשת התייחסות אישית שלך — בני לא כתב טיוטה.')}
         </div>`
      : `<div style="white-space:pre-wrap;background:var(--bg,#f8f9fc);border:1px solid var(--line,#e2e8f0);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:.94rem;max-height:220px;overflow:auto">${esc(body)}</div>`;

    const actions = `
      <div class="m-actions" style="flex-wrap:wrap;margin-top:12px">
        ${(!needy && r.from_email) ? `<button class="btn btn-sm" style="background:var(--ok)" onclick="beniSendNow(${r.id})">✉️ אשר ושלח מהמערכת</button>` : ''}
        ${needy ? '' : `<a class="btn btn-sm btn-ghost" href="${beniGmailLink(r)}" target="_blank" rel="noopener" onclick="beniMarkSent(${r.id})">📤 פתח ב-Gmail ושלח</a>`}
        ${needy ? '' : `<button class="btn btn-sm btn-ghost" onclick="beniEdit(${r.id})">✎ עריכה</button>`}
        <button class="btn btn-sm btn-ghost" onclick="beniMarkSent(${r.id})">✓ סמן כטופל</button>
        <button class="btn btn-sm btn-danger-ghost" onclick="beniDismiss(${r.id})">דחה</button>
      </div>`;

    return `<div class="card card-pad" style="margin-bottom:12px${r.is_urgent ? ';border-right:4px solid var(--danger,@@COLOR_GRAD@@)' : ''}">
      ${head}${bodyBox}${actions}
    </div>`;
  }).join('');
}

/* עריכת הטיוטה לפני שליחה — נשמרת ל-edited_body */
function beniEdit(id) {
  const r = _beniRows.find(x => x.id === id);
  if (!r) return;
  openForm('עריכת טיוטה — בני', [
    { name: 'subject', label: 'נושא', default: r.subject || '' },
    { name: 'body', label: 'תוכן הטיוטה', type: 'textarea', rows: 12, default: r.edited_body || r.draft_body || '' },
  ], {}, async (rec) => {
    await run(db.from('beni_drafts').update({ edited_body: rec.body, subject: rec.subject }).eq('id', id),
      'שגיאה בשמירת הטיוטה');
    toast('הטיוטה נשמרה');
    openPage('beni');
  });
}

/* סימון כטופל/נשלח */
async function beniMarkSent(id) {
  try {
    await run(db.from('beni_drafts').update({ status: 'sent' }).eq('id', id), 'שגיאה בעדכון');
    const r = _beniRows.find(x => x.id === id);
    if (r) toast('סומן כטופל');
    _beniRows = _beniRows.filter(x => x.id !== id);
    beniDraw();
    beniRefreshBadge();
  } catch (e) { /* toast כבר הוצג */ }
}

/* דחיית טיוטה */
async function beniDismiss(id) {
  if (!confirm('לדחות את הטיוטה הזו? היא לא תישלח ותוסר מהרשימה.')) return;
  try {
    await run(db.from('beni_drafts').update({ status: 'dismissed' }).eq('id', id), 'שגיאה בדחייה');
    _beniRows = _beniRows.filter(x => x.id !== id);
    beniDraw();
    beniRefreshBadge();
  } catch (e) { /* toast כבר הוצג */ }
}

/* ---------- תג מונה בתפריט ---------- */
async function beniRefreshBadge() {
  const badge = document.getElementById('badge-beni');
  if (!badge || typeof db === 'undefined' || !db) return;
  try {
    const { count } = await db.from('beni_drafts')
      .select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'needs_you']);
    if (count && count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
  } catch (e) { /* שקט — התפריט לא חייב את המונה */ }
}

/* עדכון המונה אחרי התחברות, בלי לגעת ב-app.js */
(function beniBadgeInit() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof profile !== 'undefined' && profile && profile.role === 'admin') {
      clearInterval(t);
      beniRefreshBadge();
      setInterval(beniRefreshBadge, 5 * 60 * 1000);
    }
    if (tries > 90) clearInterval(t);
  }, 1000);
})();

/* ---------- שליחה בקליק מהדשבורד (פיצ'ר #26) ----------
   שולח את הטיוטה המאושרת דרך פונקציית send-email הקיימת (Gmail
   SMTP של המערכת). אישור אנושי מפורש לכל שליחה — שום דבר לא יוצא
   אוטומטית. אחרי שליחה מוצלחת הטיוטה מסומנת sent. */
async function beniSendNow(id) {
  const r = _beniRows.find(x => x.id === id);
  if (!r) return;
  const to = String(r.from_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { toast('אין כתובת מייל תקינה לנמען', true); return; }
  const body = r.edited_body || r.draft_body || '';
  if (!body.trim()) { toast('הטיוטה ריקה — ערוך אותה קודם', true); return; }
  const subject = r.subject ? (/^re:/i.test(r.subject) ? r.subject : 'Re: ' + r.subject) : 'תשובה מ@@PAPER_NAME@@';
  if (!confirm('לשלוח עכשיו את התשובה?\n\nאל: ' + to + '\nנושא: ' + subject + '\n\n' + body.slice(0, 300) + (body.length > 300 ? '...' : ''))) return;
  toast('שולח...');
  try {
    const { data, error } = await db.functions.invoke('send-email', { body: { to, subject, body } });
    if (error || !data?.ok) throw new Error(data?.detail || data?.error || (error && error.message) || 'שליחה נכשלה');
    await run(db.from('beni_drafts').update({ status: 'sent' }).eq('id', id), 'נשלח אך עדכון הסטטוס נכשל');
    _beniRows = _beniRows.filter(x => x.id !== id);
    beniDraw();
    beniRefreshBadge();
    toast('✉️ נשלח ל-' + to);
  } catch (e) { toast('השליחה נכשלה: ' + (e.message || e), true); }
}
