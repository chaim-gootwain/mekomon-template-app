/* ============================================================
issues.js — גיליונות, פלטפלן, צ'קליסט סגירה וארכיון
------------------------------------------------------------
- רשימת גיליונות + כפתור יצירת גיליונות קדימה
- פלטפלן: מפת עמודים, גרירת מודעות/כתבות לעמוד
- בדיקות לפני סגירה + צ'קליסט
- ארכיון: העלאת PDF של גיליון שיצא
============================================================ */

'use strict';

let _issues = [];
let _fpIssue = null; // הגיליון הפתוח בפלטפלן
let _fpAds = [], _fpArticles = [];
let _fpWarnings = [], _fpChecklistIncomplete = 0;
let _fpChecklist = [], _fpSelChip = null;
const _AD_FULL_PRICE = 500; // בסיס לאומדן שווי שטח (מחיר עמוד שלם)

/* חלק-השטח שמודעה תופסת בעמוד: לפי המחירון (area_fraction) או לפי שם הגודל */
function _plFraction(pl) {
if (pl && pl.area_fraction != null && !isNaN(pl.area_fraction)) return Number(pl.area_fraction);
const n = (pl && pl.name) || '';
if (/שמינית/.test(n)) return 0.125;
if (/רבע\s+עמוד/.test(n)) return 0.25;
if (/חצי\s+עמוד/.test(n)) return 0.5;
return 1;
}
function _adFraction(a) {
if (!a || !a.price_item_id) return 0.25;
return _plFraction((cache.priceList || []).find(p => p.id === a.price_item_id));
}
function _pageFill(p) { return _fpAds.filter(a => a.page_number === p).reduce((s, a) => s + _adFraction(a), 0); }

/* תווית מודעה לתצוגה: תמיד מזהה את הלקוח (לפי customer_id); שם המודעה = תוספת אופציונלית */
function _adLabel(a) {
if (a && a.is_system) return '🏛 ' + (((a.title || '').trim()) || 'תוכן מערכת');
const cn = (typeof nameOf === 'function') ? (nameOf('customers', a.customer_id) || '') : '';
const t = (a.title || '').trim();
if (cn && t && t !== cn) return cn + ' · ' + t;
return cn || t || 'מודעה';
}

/* באנר מוכנוּת + ספירה לדדליין המודעות */
function _fpDeadlineBanner() {
const dl = _fpIssue.ads_deadline; if (!dl) return '';
const ms = new Date(dl).getTime() - Date.now();
const past = ms < 0;
const abs = Math.abs(ms), hrs = Math.round(abs / 36e5);
const when = hrs < 48 ? hrs + ' שעות' : Math.round(hrs / 24) + ' ימים';
const head = past ? ('❗ עבר דדליין המודעות (לפני ' + when + ')') : ('⏳ דדליין מודעות בעוד ' + when);
const blk = [];
if (_fpWarnings.length) blk.push(_fpWarnings.length + ' אזהרות פתוחות');
if (_fpChecklistIncomplete) blk.push(_fpChecklistIncomplete + " פריטי צ'קליסט חסרים");
const ok = !past && !blk.length;
const bg = ok ? '#f0fdf4' : past ? '#fef2f2' : '#fffbeb';
const bd = ok ? '#bbf7d0' : past ? '#fecaca' : '#fde68a';
const col = ok ? '#15803d' : past ? '#991b1b' : '#92400e';
return '<div style="margin-bottom:14px;padding:10px 14px;border-radius:10px;background:' + bg + ';border:1px solid ' + bd + ';color:' + col + ';font-size:.9rem"><b>' + head + '</b>' + (blk.length ? ' — ' + blk.join(' · ') : (ok ? " · הכל מוכן לסגירה ✓" : '')) + '</div>';
}

/* שיבוץ אוטומטי לפי מיקומי הגיליון הקודם (אותו לקוח + אותו גודל) */
async function fpPlaceLikePrev() {
if (!['admin', 'editor'].includes(profile.role)) return;
const prev = (cache.issues || []).filter(i => i.issue_number < _fpIssue.issue_number).sort((a, b) => b.issue_number - a.issue_number)[0];
if (!prev) { toast('אין גיליון קודם במטמון', true); return; }
const prevAds = await run(db.from('ads').select('customer_id,price_item_id,page_number').eq('issue_id', prev.id).not('page_number', 'is', null));
if (!prevAds.length) { toast('בגיליון ' + prev.issue_number + ' אין מודעות משובצות', true); return; }
const key = a => a.customer_id + '|' + a.price_item_id;
const prevMap = {}; prevAds.forEach(a => { if (prevMap[key(a)] == null) prevMap[key(a)] = a.page_number; });
const targets = _fpAds.filter(a => !a.page_number && ['approved', 'placed'].includes(a.status) && prevMap[key(a)] != null && prevMap[key(a)] <= _fpIssue.pages_count);
if (!targets.length) { toast('לא נמצאו מודעות עם התאמה לגיליון הקודם', true); return; }
if (!confirm('לשבץ ' + targets.length + ' מודעות לאותם עמודים כמו בגיליון ' + prev.issue_number + '?')) return;
for (const a of targets) { a.page_number = prevMap[key(a)]; a.status = 'placed'; }
_fpPaint();
for (const a of targets) await run(db.from('ads').update({ page_number: a.page_number, status: 'placed' }).eq('id', a.id));
toast('✓ שובצו ' + targets.length + ' מודעות כמו בגיליון ' + prev.issue_number);
}

Pages.issues = {
render: async (el) => {
_issues = await run(db.from('issues').select('*').order('issue_number', { ascending: false }));
const _t = today();
// סגירה אוטומטית: גיליון פתוח שעבר 23:59 של תאריך דדליין המודעות → נסגר
const _nowMs = Date.now();
const _toClose = _issues.filter(i => {
if (!i.ads_deadline || ['closed', 'published'].includes(i.status)) return false;
const d = new Date(i.ads_deadline); if (isNaN(d)) return false;
const closeAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
return _nowMs > closeAt;
});
if (_toClose.length) { try { await run(db.from('issues').update({ status: 'closed' }).in('id', _toClose.map(i => i.id))); _toClose.forEach(i => i.status = 'closed'); } catch (e) { } }
const _pub = _issues.filter(i => (i.publish_date || '') < _t && i.status === 'closed');
if (_pub.length) { try { await run(db.from('issues').update({ status: 'published' }).in('id', _pub.map(i => i.id))); _pub.forEach(i => i.status = 'published'); } catch (e) { } }
const _canFin = ['admin', 'sales'].includes(profile.role);
let _revByIssue = {}, _costByIssue = {};
if (_canFin) {
try {
const [_adsF, _expF] = await Promise.all([
run(db.from('ads').select('issue_id,price,discount,status').limit(8000)),
run(db.from('expenses').select('notes').ilike('notes', '%#issue:%').limit(4000)),
]);
(_adsF || []).forEach(a => {
if (!a.issue_id || ['cancelled', 'rejected'].includes(a.status)) return;
_revByIssue[a.issue_id] = (_revByIssue[a.issue_id] || 0) + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
});
(_expF || []).forEach(e => {
const mi = String(e.notes || '').match(/#issue:(\d+);/); const mn = String(e.notes || '').match(/#net:([0-9.]+)/);
if (mi) _costByIssue[mi[1]] = (_costByIssue[mi[1]] || 0) + (mn ? Number(mn[1]) : 0);
});
} catch (e) {}
}
const canEdit = ['admin', 'editor'].includes(profile.role);
el.innerHTML = `
<div class="page-head">
<h2>גיליונות</h2>
<div class="actions">
${canEdit ? `<button class="btn btn-ghost" onclick="issuesGenerate()">⚡ יצירת גיליונות קדימה</button>` : ''}
${['admin', 'sales'].includes(profile.role) ? `<button class="btn btn-ghost" onclick="contractAdsGenerate()">📄 יצירת מודעות מחוזים</button>` : ''}
${['admin', 'sales'].includes(profile.role) ? `<button class="btn btn-ghost" onclick="icoApplyAll()">💸 עלויות לכל הגיליונות</button>` : ''}
${['admin', 'sales'].includes(profile.role) ? `<button class="btn btn-ghost" onclick="pdfImportOpen(294)">📥 ייבוא 294 מ-PDF</button>` : ''}
</div>
</div>
${typeof hebHolidayBanner === 'function' ? hebHolidayBanner(_issues) : ''}
<div class="card" id="issuesTable"></div>
<div id="issuesTrends"></div>`;
renderTable(document.getElementById('issuesTable'), _issues, [
{ h: 'גיליון', f: r => `<b>גיליון ${r.issue_number}</b>` },
{ h: 'חלוקה (מוצ"ש)', f: r => (typeof hebIssueDateCell === 'function' ? hebIssueDateCell(r.publish_date) : heDate(r.publish_date)) },
{ h: 'דפוס', f: r => heDate(r.print_date) },
{ h: 'דדליין מודעות', f: r => heDateTime(r.ads_deadline) + (typeof hebDeadlineWarn === 'function' ? hebDeadlineWarn(r.ads_deadline) : '') },
{ h: 'עמודים', f: r => r.pages_count },
{ h: 'סטטוס', f: r => pill('issue', r.status) + (((r.publish_date || '') < _t && !['closed', 'published'].includes(r.status)) ? ' <span title="עבר תאריך החלוקה והגיליון לא נסגר" style="color:#b91c1c">⚠ דורש טיפול</span>' : '') },
{ h: 'רווח', f: r => { if (!_canFin) return ''; const _rv = _revByIssue[r.id] || 0, _ct = _costByIssue[r.id] || 0; if (!_rv && !_ct) return '<span class="muted">—</span>'; const _p = _rv - _ct; return `<b style="color:${_p >= 0 ? 'var(--ok)' : 'var(--danger)'}" title="הכנסות ${money(_rv)} − עלויות ${money(_ct)} (נטו)">${money(_p)}</b>`; } },
{ h: '', f: r => `<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openIssueEntry(${r.id})">＋ הזנה</button> <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openFlatplan(${r.id})">פלטפלן</button>${['admin','sales'].includes(profile.role) ? ` <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openIssueCosts(${r.id})">💸 עלויות</button>` : ''}${['admin','sales'].includes(profile.role) && typeof invoicesOn === 'function' && invoicesOn() ? ` <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();issueBillingOpen(${r.id})">🧾 חיוב</button>` : ''}` },
], { onRow: r => openFlatplan(r.id), empty: 'אין גיליונות — לחץ "יצירת גיליונות קדימה"' });
_issuesTrends();
}
};

async function issuesGenerate() {
const weeks = Number(prompt('כמה שבועות קדימה ליצור?', '4'));
if (!weeks || weeks < 1) return;
const _before = new Set((_issues || []).map(i => i.id));
const n = await run(db.rpc('generate_issues', { p_weeks: weeks }));
try {
const _dpc = Number((cache.settings || {}).default_pages_count) || 40;
const { data: _all } = await db.from('issues').select('id');
const _newIds = (_all || []).map(i => i.id).filter(id => !_before.has(id));
if (_newIds.length) await db.from('issues').update({ pages_count: _dpc }).in('id', _newIds);
} catch (e) { }
await refreshCache();
toast(`נוצרו ${n} גיליונות`);
openPage('issues');
}

async function contractAdsGenerate() {
const open = _issues.filter(i => !['published', 'closed'].includes(i.status));
if (!open.length) { toast('אין גיליון פתוח', true); return; }
const _up = _issues.filter(i => !['published', 'closed'].includes(i.status) && (i.publish_date || '') >= today()).sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')));
const target = _up[0] || open[open.length - 1];
if (!confirm(`ליצור מודעות מהחוזים הפעילים לגיליון ${target.issue_number}?`)) return;
const n = await run(db.rpc('generate_contract_ads', { p_issue_id: target.id }));
toast(`נוצרו ${n} מודעות מחוזים`);
}

/* ==================== פלטפלן ==================== */

async function openFlatplan(issueId) {
_fpIssue = _issues.find(i => i.id === issueId) || (cache.issues || []).find(i => i.id === issueId);
const el = document.getElementById('content');
el.innerHTML = '<div class="empty">טוען פלטפלן...</div>';
[_fpAds, _fpArticles] = await Promise.all([
run(db.from('ads').select('*').eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")')),
run(db.from('articles').select('*').eq('issue_id', issueId).not('status', 'in', '("idea")')),
]);
_fpChecklist = await run(db.from('issue_checklist').select('*, checklist_template(label)').eq('issue_id', issueId).order('template_id'));
_fpSelChip = null;
_fpPaint();
}

/* עמודים מיוחדים (פרימיום) — שער / אחורי / כפולה אמצעית */
function _fpSpecialPages() {
const n = _fpIssue.pages_count, sp = {};
sp[1] = '⭐ שער';
if (n >= 2) sp[n] = '⭐ אחורי';
if (n >= 6) { const m = Math.floor(n / 2); sp[m] = '⭐ אמצע'; sp[m + 1] = '⭐ אמצע'; }
return sp;
}

/* ציור מלא מהנתונים המקומיים — בלי טעינה מחדש מהשרת (מהיר ושומר גלילה) */
function _fpPaint() {
const el = document.getElementById('content'); if (!el || !_fpIssue) return;
const canEdit = ['admin', 'editor'].includes(profile.role);
const soldAmount = _fpAds.reduce((s, a) => s + Number(a.price) - Number(a.discount), 0);
const placedAds = _fpAds.filter(a => a.page_number);
const unplacedAds = _fpAds.filter(a => !a.page_number && ['approved', 'placed'].includes(a.status));
const unplacedArticles = _fpArticles.filter(a => !a.page_number && ['ready', 'placed'].includes(a.status));
const inProcessAds = _fpAds.filter(a => !a.page_number && ['received', 'in_graphics', 'proof', 'committee'].includes(a.status));
const warnings = [];
if (unplacedAds.length) warnings.push(`${unplacedAds.length} מודעות מאושרות שטרם שובצו לעמוד`);
const noGraphics = _fpAds.filter(a => a.status === 'in_graphics').length;
if (noGraphics) warnings.push(`${noGraphics} מודעות עדיין בגרפיקה`);
const inCommittee = _fpAds.filter(a => a.status === 'committee').length;
if (inCommittee) warnings.push(`${inCommittee} מודעות ממתינות לוועדה`);
const usedPages = new Set([..._fpAds, ..._fpArticles].filter(x => x.page_number).map(x => x.page_number));
const emptyPages = [];
for (let p = 1; p <= _fpIssue.pages_count; p++) if (!usedPages.has(p)) emptyPages.push(p);
if (emptyPages.length) warnings.push(`עמודים ללא שיבוץ: ${emptyPages.slice(0, 12).join(', ')}${emptyPages.length > 12 ? '...' : ''}`);
const overPages = [];
for (let p = 1; p <= _fpIssue.pages_count; p++) if (_pageFill(p) > 1.01) overPages.push(p);
if (overPages.length) warnings.push(`עמודים בחריגת שטח (מעל 100%): ${overPages.join(', ')}`);
let freeArea = 0;
for (let p = 1; p <= _fpIssue.pages_count; p++) { const f = _pageFill(p); if (f > 0.001 && f < 0.999) freeArea += (1 - f); }
const soldArea = placedAds.reduce((s, a) => s + _adFraction(a), 0);
let _fullPages = 0, _partialPages = 0;
for (let p = 1; p <= _fpIssue.pages_count; p++) { const _f = _pageFill(p); if (_f >= 0.99) _fullPages++; else if (_f > 0.001) _partialPages++; }
const _totalAdArea = _fpAds.reduce((s, a) => s + _adFraction(a), 0);
const artPages = new Set(_fpArticles.filter(a => a.page_number).map(a => a.page_number)).size;
const adPct = _fpIssue.pages_count ? Math.round(soldArea / _fpIssue.pages_count * 100) : 0;
_fpWarnings = warnings;
_fpChecklistIncomplete = _fpChecklist.filter(c => !c.done).length;

el.innerHTML = `
<div class="page-head">
<h2>פלטפלן — גיליון ${_fpIssue.issue_number} ${pill('issue', _fpIssue.status)}</h2>
<div class="actions">
<button class="btn btn-ghost btn-sm" onclick="openPage('issues')">→ לרשימה</button>
${canEdit ? `<button class="btn btn-sm btn-ghost" onclick="fpPlaceLikePrev()">↩ כמו קודם</button>` : ''}
${canEdit ? `<button class="btn btn-sm btn-ghost" onclick="fpAutoArrange()">🧩 סידור אוטומטי</button>` : ''}
<button class="btn btn-sm btn-ghost" onclick="fpPrint()">🖨 הדפסה</button>
<button class="btn btn-sm btn-ghost" onclick="fpEmailToGraphics()">✉️ שלח לגרפיקאית</button>
${canEdit ? `<button class="btn btn-sm btn-ghost" onclick="openPrintVerify(${_fpIssue.id})">🖨️ אמת מול מודפס</button>` : ''}
${canEdit ? `<button class="btn btn-sm" onclick="openIssueEntry(${_fpIssue.id})">＋ הזנת מודעות</button>` : ''}
${canEdit ? `<button class="btn btn-sm btn-ghost" onclick="fpPrevAdsList()">📋 מגיליון קודם</button>` : ''}
${canEdit && _fpAds.filter(a => a.deal_stage === 'in_progress').length ? `<button class="btn btn-sm btn-ghost" onclick="dealReviewOpen(${_fpIssue.id})">🟡 עסקאות באמצע (${_fpAds.filter(a => a.deal_stage === 'in_progress').length})</button>` : ''}
${canEdit ? `<button class="btn btn-sm btn-ghost" onclick="issueStatusChange()">שינוי סטטוס</button>` : ''}
${['admin','sales'].includes(profile.role) ? `<button class="btn btn-sm btn-ghost" onclick="openIssueCosts(${_fpIssue.id})">💸 עלויות הגיליון</button>` : ''}
</div>
</div>

${_fpDeadlineBanner()}

<div class="stats">
${stat(money(soldAmount) || '₪0', 'שטח פרסום שנמכר')}
${stat(placedAds.length + '/' + _fpAds.length, 'מודעות משובצות')}
${stat(_totalAdArea.toFixed(1) + '/' + _fpIssue.pages_count + " עמ'", 'שווה-ערך עמודים מלאים · מכל ' + _fpAds.length + ' המודעות שהוזנו')}
${stat(_fullPages + ' מלאים · ' + _partialPages + ' חלקיים', 'עמודים משובצים בפועל')}
${stat(_fpIssue.pages_count - emptyPages.length + '/' + _fpIssue.pages_count, 'עמודים מאוישים')}
${stat(soldArea.toFixed(2) + " עמ'", 'שטח מודעות')}
${stat(freeArea > 0.01 ? freeArea.toFixed(2) + " עמ' ≈ " + money(Math.round(freeArea * _AD_FULL_PRICE)) : '—', 'מלאי פנוי')}
${stat('פרסום ' + adPct + "% · מערכת " + artPages + " עמ'", 'יחס פרסום/מערכת')}
</div>

${warnings.length ? `<div class="card card-pad" style="border-right:4px solid var(--warn);margin-bottom:16px">
<b style="color:var(--warn)">בדיקות לפני סגירה:</b>
<ul style="margin:6px 18px 0">${warnings.map(w => `<li style="font-size:.88rem">${w}</li>`).join('')}</ul>
</div>` : `<div class="card card-pad" style="border-right:4px solid var(--ok);margin-bottom:16px">
<b style="color:var(--ok)">✓ כל הבדיקות עברו — אפשר לסגור את הגיליון</b></div>`}

<div class="dash-grid" style="grid-template-columns:280px 1fr">
<div>
<div class="card card-pad">
<b>ממתינים לשיבוץ</b>
<p class="muted" style="font-size:.78rem;margin:4px 0 8px">${canEdit ? (_fpSelChip ? '👉 הקש/י על עמוד לשיבוץ · או גרור' : 'גרור פריט לעמוד — או הקש עליו ואז על עמוד') : 'תצוגה בלבד'}</p>
<div id="fpUnplaced">
${unplacedAds.map(a => fpChip(a, 'ad')).join('')}
${unplacedArticles.map(a => fpChip(a, 'article')).join('')}
${!unplacedAds.length && !unplacedArticles.length ? '<p class="muted" style="font-size:.85rem">הכל שובץ 👍</p>' : ''}
</div>
${inProcessAds.length ? `
<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
<b style="font-size:.85rem">⏳ בתהליך — טרם זמינות לשיבוץ (${inProcessAds.length})</b>
<p class="muted" style="font-size:.72rem;margin:2px 0 6px">יופיעו לשיבוץ אחרי אישור ועדה/גרפיקה · הקשה פותחת את הכרטיס</p>
${inProcessAds.map(a => fpPendingChip(a)).join('')}
</div>` : ''}
</div>
<div class="card card-pad">
<b>צ'קליסט סגירה</b>
<div style="margin-top:6px">
${_fpChecklist.map(c => `
<div class="checklist-item ${c.done ? 'done' : ''}">
<input type="checkbox" ${c.done ? 'checked' : ''} ${canEdit ? '' : 'disabled'}
onchange="checklistToggle(${c.id}, this.checked)">
<label>${esc(c.checklist_template?.label || '')}</label>
</div>`).join('')}
</div>
</div>
</div>
<div class="card card-pad">
<b>מפת העמודים</b>
<div class="flatplan" style="margin-top:10px" id="fpGrid">${fpGridHtml(canEdit)}</div>
</div>
</div>`;
}

/* פריט "בתהליך" — מודעה שטרם אושרה לשיבוץ (ועדה/גרפיקה/פרוף) — תצוגה בלבד, הקשה פותחת כרטיס */
function fpPendingChip(a) {
const base = _adLabel(a);
return `<div class="fp-item ad" style="margin-bottom:6px;opacity:.55;cursor:pointer" onclick="openAdCard(${a.id})"
title="${esc(base)} — ${esc((STATUS.ad[a.status] || [a.status])[0])}">${esc(base.length > 22 ? base.slice(0, 22) + '…' : base)} ${pill('ad', a.status)}</div>`;
}

/* פריט בעמודת ההמתנה — גרירה או הקשה לבחירה */
function fpChip(item, kind) {
const base = kind === 'ad' ? _adLabel(item) : '✍ ' + item.title;
const frac = kind === 'ad' ? ' · ' + Math.round(_adFraction(item) * 100) + '%' : '';
const pos = kind === 'ad' && item.requested_placement ? ' 📍' + esc(item.requested_placement) : '';
const stg = kind === 'ad' && item.deal_stage && typeof dealStageLabel === 'function' ? dealStageLabel(item.deal_stage) : '';
const sel = _fpSelChip && _fpSelChip.kind === kind && _fpSelChip.id === item.id;
const _chipEdit = ['admin', 'editor'].includes(profile.role);
const invBtn = (kind === 'ad' && _chipEdit) ? `<span onclick="event.stopPropagation();fpMarkInvoiced(${item.id})" style="cursor:pointer;font-weight:700;${['invoiced', 'paid'].includes(item.deal_stage) ? 'color:#9333ea' : 'opacity:.4'}" title="${['invoiced', 'paid'].includes(item.deal_stage) ? 'חשבונית הופקה — בטל סימון' : 'סמן: חשבונית הופקה'}">🧾</span> ` : '';
return `<div class="fp-item ${kind}" draggable="true" style="margin-bottom:6px${sel ? ';outline:2px solid var(--brand);outline-offset:1px' : ''}"
ondragstart="event.dataTransfer.setData('text/plain','${kind}:${item.id}')"
onclick="fpSelectChip('${kind}',${item.id})"
title="${esc(base)}${frac}${pos}${stg ? ' · ' + stg : ''}">${invBtn}${esc(base.length > 26 ? base.slice(0, 26) + '…' : base)}${frac}${stg ? ' <span style=\"font-size:.62rem\">' + stg.slice(0,2) + '</span>' : ''}</div>`;
}

/* רשת העמודים — מד מילוי, עמודים מיוחדים, גרירה בין עמודים, הקשה לשיבוץ */
function fpGridHtml(canEdit) {
const sp = _fpSpecialPages();
let html = '';
for (let p = 1; p <= _fpIssue.pages_count; p++) {
const ads = _fpAds.filter(a => a.page_number === p);
const arts = _fpArticles.filter(a => a.page_number === p);
const hasItems = ads.length || arts.length;
const fill = ads.reduce((s, a) => s + _adFraction(a), 0);
const pct = Math.round(fill * 100);
const over = fill > 1.01, fullp = fill >= 0.99 && !over;
const barCol = over ? '#dc2626' : fullp ? '#16a34a' : fill > 0 ? '#f59e0b' : '#e5e7eb';
const brd = over ? 'border-color:#dc2626;box-shadow:0 0 0 1px #dc2626 inset' : fullp ? 'border-color:#16a34a' : '';
const special = sp[p];
html += `<div class="fp-page ${hasItems ? 'full' : ''}" data-page="${p}" style="${brd}"
${canEdit ? `ondragover="event.preventDefault();this.classList.add('drag-over')"
ondragleave="this.classList.remove('drag-over')"
ondrop="fpDrop(event, ${p})" onclick="fpTapPage(${p})"` : ''}>
<div class="fp-num" style="display:flex;justify-content:space-between;align-items:center;gap:4px"><span>עמוד ${p}${special ? ` <span style="color:#b45309;font-size:.6rem">${special}</span>` : ''}</span>${ads.length ? `<span style="font-size:.68rem;font-weight:700;color:${barCol}">${pct}%${over ? ' ⚠' : ''}</span>` : ''}</div>
${ads.length ? `<div style="height:3px;background:#eef2f7;border-radius:2px;overflow:hidden"><div style="height:3px;width:${Math.min(100, pct)}%;background:${barCol}"></div></div>` : ''}
<div class="fp-items">
${ads.map(a => `<div class="fp-item ad" draggable="${canEdit}" ondragstart="event.stopPropagation();event.dataTransfer.setData('text/plain','ad:${a.id}')" title="${esc(_adLabel(a))} — ${Math.round(_adFraction(a) * 100)}% מעמוד">${canEdit ? `<span onclick="event.stopPropagation();fpMarkInvoiced(${a.id})" style="cursor:pointer;font-weight:700;${['invoiced', 'paid'].includes(a.deal_stage) ? 'color:#9333ea' : 'opacity:.4'}" title="${['invoiced', 'paid'].includes(a.deal_stage) ? 'חשבונית הופקה — בטל סימון' : 'סמן: חשבונית הופקה'}">🧾</span> <span onclick="event.stopPropagation();fpEditAd(${a.id})" style="cursor:pointer;color:#2563eb;font-weight:700" title="עריכה">✎</span> <span onclick="event.stopPropagation();fpUnplace('ad',${a.id})" style="cursor:pointer;color:#b91c1c;font-weight:700" title="הסרה">✕</span> ` : ''}${esc(_adLabel(a).slice(0, 24))}</div>`).join('')}
${arts.map(a => `<div class="fp-item article" draggable="${canEdit}" ondragstart="event.stopPropagation();event.dataTransfer.setData('text/plain','article:${a.id}')" title="${esc(a.title)}">${canEdit ? `<span onclick="event.stopPropagation();fpUnplace('article',${a.id})" style="cursor:pointer;color:#b91c1c;font-weight:700">✕</span> ` : ''}✍ ${esc(a.title.slice(0, 22))}</div>`).join('')}
</div></div>`;
}
return html;
}

/* עריכת מודעה מתוך הפלטפלן — עדכון מקומי + ציור מחדש (בלי לצאת) */
function fpEditAd(id) {
if (!['admin', 'editor'].includes(profile.role)) return;
const a = _fpAds.find(x => x.id === id); if (!a) return;
const stageOpts = (typeof DEAL_STAGES !== 'undefined') ? [{ v: '', t: '(ללא)' }].concat(Object.entries(DEAL_STAGES).map(([v, t]) => ({ v, t: t[0] }))) : [{ v: '', t: '(ללא)' }];
openForm('עריכת מודעה — ' + (nameOf('customers', a.customer_id) || ''), [
{ type: 'html', html: `<div style="grid-column:1/-1;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 10px;font-size:.85rem">לקוח: <b>${esc(nameOf('customers', a.customer_id) || '—')}</b> · שינוי הכותרת כאן <b>לא</b> משנה את שם הלקוח</div>` },
{ name: 'title', label: 'כותרת המודעה (תווית לתצוגה — לא שם הלקוח)', required: true },
{ name: 'price_item_id', label: 'גודל', type: 'select', options: 'priceList' },
{ name: 'price', label: 'מחיר (₪)', type: 'number' },
{ name: 'discount', label: 'הנחה (₪)', type: 'number' },
{ name: 'page_number', label: 'עמוד', type: 'number' },
{ name: 'deal_stage', label: 'שלב עסקה', type: 'select', options: stageOpts },
{ name: 'requested_placement', label: 'מיקום מבוקש / הערה' },
], a, async (rec) => {
const upd = {
title: (rec.title || '').trim() || a.title,
price_item_id: rec.price_item_id || a.price_item_id || null,
price: rec.price != null ? Number(rec.price) : (a.price || 0),
discount: rec.discount != null ? Number(rec.discount) : (a.discount || 0),
page_number: rec.page_number != null ? (Number(rec.page_number) || null) : a.page_number,
deal_stage: rec.deal_stage || null,
requested_placement: rec.requested_placement || null,
};
await run(db.from('ads').update(upd).eq('id', id));
Object.assign(a, upd);
if (upd.page_number && a.status === 'approved') a.status = 'placed';
if (!upd.page_number && a.status === 'placed') a.status = 'approved';
toast('✓ המודעה עודכנה');
_fpPaint();
});
}

/* רשימת מודעות מהגיליון הקודם — עם הוספה מהירה לגיליון הנוכחי (חזרת מפרסמים קבועים) */
window.fpPrevAdsList = async function () {
if (!['admin', 'editor', 'sales'].includes(profile.role)) return;
const curNum = _fpIssue.issue_number;
const prev = (cache.issues || []).filter(i => i.issue_number < curNum).sort((a, b) => b.issue_number - a.issue_number)[0];
if (!prev) { toast('אין גיליון קודם', true); return; }
toast('טוען מגיליון ' + prev.issue_number + '...');
const prevAds = await run(db.from('ads').select('*').eq('issue_id', prev.id).not('status', 'in', '("cancelled","rejected")').order('page_number', { ascending: true }));
if (!prevAds || !prevAds.length) { toast('אין מודעות בגיליון ' + prev.issue_number, true); return; }
const curCust = new Set((_fpAds || []).map(a => a.customer_id));
window._fpPrev = { prevNum: prev.issue_number, ads: prevAds };
const rows = prevAds.map(a => {
const already = a.customer_id && curCust.has(a.customer_id);
const nm = nameOf('customers', a.customer_id) || a.title || '—';
const sz = nameOf('priceList', a.price_item_id) || '';
const pr = Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0));
return `<tr id="fpp-row-${a.id}">
<td><b>${esc(nm)}</b>${a.title && a.title !== nm ? ' <span class="muted" style="font-size:.8rem">' + esc(a.title) + '</span>' : ''}</td>
<td>${esc(sz)}</td>
<td style="white-space:nowrap">${a.is_system ? '<span class="pill">מערכת</span>' : money(pr)}</td>
<td style="white-space:nowrap">${already ? '<span class="pill green">כבר בגיליון</span>' : `<button class="btn btn-sm" onclick="fpAddFromPrev(${a.id}, this)">➕ הוסף</button>`}</td>
</tr>`;
}).join('');
const newCount = prevAds.filter(a => !(a.customer_id && curCust.has(a.customer_id))).length;
document.getElementById('viewModal').innerHTML = `
<h3>📋 מודעות מגיליון ${prev.issue_number} → הוספה לגיליון ${curNum}</h3>
<p class="muted" style="font-size:.83rem">מפרסמים שהיו בגיליון הקודם. "הוסף" מעתיק את המודעה (לקוח, גודל, מחיר) לגיליון הנוכחי — ללא שיבוץ עמוד, לבחירת סטטוס בהמשך.</p>
<div style="margin:8px 0">${newCount ? `<button class="btn btn-sm" onclick="fpAddAllPrev(this)">➕ הוסף את כל ה-${newCount} החדשים</button>` : '<span class="muted">כל המפרסמים כבר בגיליון</span>'}</div>
<div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="data">
<thead><tr><th>לקוח / מודעה</th><th>גודל</th><th>מחיר</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="m-actions" style="margin-top:12px"><button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open'); openFlatplan(${_fpIssue.id})">סגירה ורענון</button></div>`;
document.getElementById('viewBack').classList.add('open');
};

async function _fpCopyAd(src) {
const gfxNote = src.graphics_note || null;
const rec = {
title: src.title || nameOf('customers', src.customer_id) || 'מודעה',
customer_id: src.customer_id, issue_id: _fpIssue.id,
price_item_id: src.price_item_id || null, page_number: null,
// מודעת מערכת (is_system) ממשיכה לדלג ישר ל-approved; מודעה רגילה מנותבת
// לפי הנחיית העיצוב שהייתה למודעה המקורית — מלא=לגרפיקה, ריק=לוועדה
status: src.is_system ? 'approved' : (gfxNote ? 'in_graphics' : 'committee'),
graphics_note: src.is_system ? null : gfxNote,
source: 'manual', created_by: profile.id,
price: src.is_system ? 0 : (Number(src.price) || 0), discount: Number(src.discount) || 0,
is_system: !!src.is_system, deal_stage: null,
};
if (src.agent_id) rec.agent_id = src.agent_id;
const ins = await db.from('ads').insert(rec).select('id').single();
if (ins.error) throw new Error(ins.error.message);
return ins.data.id;
}
window.fpAddFromPrev = async function (prevAdId, btn) {
const src = (window._fpPrev && window._fpPrev.ads || []).find(a => a.id === prevAdId);
if (!src) { toast('לא נמצא', true); return; }
if (btn) { btn.disabled = true; btn.textContent = '...'; }
try {
await _fpCopyAd(src);
if (btn) { const td = btn.closest('td'); if (td) td.innerHTML = '<span class="pill green">✓ נוסף</span>'; }
toast('✓ נוסף: ' + (nameOf('customers', src.customer_id) || src.title));
} catch (e) { toast('שגיאה: ' + (e.message || e), true); if (btn) { btn.disabled = false; btn.textContent = '➕ הוסף'; } }
};
window.fpAddAllPrev = async function (btn) {
if (!window._fpPrev) return;
const curCust = new Set((_fpAds || []).map(a => a.customer_id));
const toAdd = window._fpPrev.ads.filter(a => !(a.customer_id && curCust.has(a.customer_id)));
if (!toAdd.length) { toast('אין חדשים להוספה'); return; }
if (!confirm('להוסיף ' + toAdd.length + ' מודעות מגיליון ' + window._fpPrev.prevNum + ' לגיליון הנוכחי?')) return;
if (btn) { btn.disabled = true; btn.textContent = 'מוסיף...'; }
let ok = 0;
for (const a of toAdd) { try { await _fpCopyAd(a); ok++; const td = document.querySelector('#fpp-row-' + a.id + ' td:last-child'); if (td) td.innerHTML = '<span class="pill green">✓ נוסף</span>'; } catch (e) { console.error('copy', e); } }
toast('✓ נוספו ' + ok + ' מודעות');
if (btn) { btn.textContent = '✓ נוספו ' + ok; }
};

/* סימון מהיר מתוך הגיליון: "חשבונית הופקה" (לחיצה שנייה מבטלת). לא נוגע ב"שולם". */
window.fpMarkInvoiced = async function (id) {
if (!['admin', 'editor'].includes(profile.role)) return;
const a = (typeof _fpAds !== 'undefined') ? _fpAds.find(x => x.id === id) : null; if (!a) return;
let next;
if (a.deal_stage === 'paid') { toast('המודעה כבר מסומנת כשולם'); return; }
next = (a.deal_stage === 'invoiced') ? null : 'invoiced';
const up = await db.from('ads').update({ deal_stage: next }).eq('id', id);
if (up.error) { toast('שגיאה: ' + up.error.message, true); return; }
a.deal_stage = next;
try { await addInteraction('customer', a.customer_id, `שלב העסקה עודכן ל: ${next ? dealStageLabel(next) : '—'} (גיליון ${_fpIssue.issue_number})`); } catch (e) { }
toast(next ? '✓ סומן: חשבונית הופקה' : 'הסימון בוטל');
if (typeof _fpPaint === 'function') _fpPaint();
};

/* שיבוץ פריט לעמוד — משותף לגרירה ולהקשה. עדכון מקומי + שמירה ברקע */
async function _fpPlace(kind, id, page) {
if (!['admin', 'editor'].includes(profile.role)) return;
if (kind === 'ad') {
const a = _fpAds.find(x => x.id === id); if (!a) return;
if (a.page_number === page) { _fpSelChip = null; _fpPaint(); return; }
const cur = _pageFill(page);
const frac = _adFraction(a);
if (cur + frac > 1.01 && !confirm(`עמוד ${page} יתמלא ל-${Math.round((cur + frac) * 100)}% (מעל 100%). לשבץ בכל זאת?`)) return;
a.page_number = page; a.status = 'placed';
_fpSelChip = null; _fpPaint();
run(db.from('ads').update({ page_number: page, status: 'placed' }).eq('id', id))
.then(() => addInteraction('ad', id, `שובצה לעמוד ${page} בגיליון ${_fpIssue.issue_number}`))
.catch(() => openFlatplan(_fpIssue.id));
} else {
const a = _fpArticles.find(x => x.id === id); if (!a) return;
a.page_number = page; a.status = 'placed';
_fpSelChip = null; _fpPaint();
run(db.from('articles').update({ page_number: page, status: 'placed' }).eq('id', id)).catch(() => openFlatplan(_fpIssue.id));
}
toast(`שובץ לעמוד ${page}`);
}

async function fpDrop(ev, page) {
ev.preventDefault();
ev.currentTarget.classList.remove('drag-over');
const data = ev.dataTransfer.getData('text/plain'); if (!data) return;
const [kind, idStr] = data.split(':');
_fpPlace(kind, Number(idStr), page);
}

/* הקשה לבחירה (מגע) */
function fpSelectChip(kind, id) {
if (!['admin', 'editor'].includes(profile.role)) return;
if (_fpSelChip && _fpSelChip.kind === kind && _fpSelChip.id === id) _fpSelChip = null;
else _fpSelChip = { kind, id };
_fpPaint();
}
function fpTapPage(page) {
if (!_fpSelChip) return;
const s = _fpSelChip;
_fpPlace(s.kind, s.id, page);
}

/* הסרת פריט מעמוד — עדכון מקומי + שמירה ברקע */
function fpUnplace(kind, id) {
if (!['admin', 'editor'].includes(profile.role)) return;
if (kind === 'ad') { const a = _fpAds.find(x => x.id === id); if (a) { a.page_number = null; a.status = 'approved'; } run(db.from('ads').update({ page_number: null, status: 'approved' }).eq('id', id)).catch(() => openFlatplan(_fpIssue.id)); }
else { const a = _fpArticles.find(x => x.id === id); if (a) { a.page_number = null; a.status = 'ready'; } run(db.from('articles').update({ page_number: null, status: 'ready' }).eq('id', id)).catch(() => openFlatplan(_fpIssue.id)); }
_fpPaint();
}

/* סידור אוטומטי — ממלא עמודים לפי מקום פנוי (הגדול קודם) */
async function fpAutoArrange() {
if (!['admin', 'editor'].includes(profile.role)) return;
const unplaced = _fpAds.filter(a => !a.page_number && ['approved', 'placed'].includes(a.status)).sort((a, b) => _adFraction(b) - _adFraction(a));
if (!unplaced.length) { toast('אין מודעות ממתינות לשיבוץ', true); return; }
const plan = [];
for (const a of unplaced) {
const frac = _adFraction(a);
for (let p = 1; p <= _fpIssue.pages_count; p++) {
if (_pageFill(p) + frac <= 1.001) { a.page_number = p; a.status = 'placed'; plan.push({ id: a.id, page: p }); break; }
}
}
if (!plan.length) { toast('אין מקום פנוי בעמודים הקיימים', true); return; }
if (!confirm(`לשבץ אוטומטית ${plan.length} מודעות לפי מקום פנוי בעמודים?`)) {
plan.forEach(x => { const a = _fpAds.find(y => y.id === x.id); a.page_number = null; a.status = 'approved'; });
return;
}
_fpPaint();
for (const x of plan) await run(db.from('ads').update({ page_number: x.page, status: 'placed' }).eq('id', x.id));
toast(`✓ שובצו ${plan.length} מודעות`);
}

/* הדפסת/ייצוא הפלטפלן — עמוד נקי למעצב/דפוס */
function fpPrint() {
let rows = '';
for (let p = 1; p <= _fpIssue.pages_count; p++) {
const ads = _fpAds.filter(a => a.page_number === p);
const arts = _fpArticles.filter(a => a.page_number === p);
const fill = Math.round(ads.reduce((s, a) => s + _adFraction(a), 0) * 100);
const items = [...ads.map(a => esc(a.title) + ' (' + Math.round(_adFraction(a) * 100) + '%)'), ...arts.map(a => '✍ ' + esc(a.title))].join(' · ') || '—';
rows += `<tr><td style="font-weight:700;white-space:nowrap">עמוד ${p}</td><td>${fill ? fill + '%' : ''}</td><td>${items}</td></tr>`;
}
const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>פלטפלן גיליון ${_fpIssue.issue_number}</title>
<style>body{font-family:Arial,Heebo,sans-serif;padding:22px;color:#111}h2{margin:0 0 4px}.sub{color:#555;font-size:13px;margin-bottom:10px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #cbd5e1;padding:6px 9px;font-size:13px;text-align:right;vertical-align:top}th{background:#f1f5f9}</style></head>
<body><h2>פלטפלן — גיליון ${_fpIssue.issue_number}</h2>
<div class="sub">חלוקה: ${heDate(_fpIssue.publish_date)} · ${_fpIssue.pages_count} עמודים</div>
<table><thead><tr><th style="width:70px">עמוד</th><th style="width:55px">מילוי</th><th>תוכן</th></tr></thead><tbody>${rows}</tbody></table>
<scr` + `ipt>window.onload=function(){setTimeout(function(){window.print()},250)}</scr` + `ipt></body></html>`;
const w = window.open('', '_blank');
if (!w) { toast('חלון ההדפסה נחסם — יש לאפשר חלונות קופצים', true); return; }
w.document.open(); w.document.write(html); w.document.close();
}

/* שליחת הפלטפלן ישירות לגרפיקאית במייל (דרך send-email).
כתובת הגרפיקאית נשמרת בהגדרות (graphics_email) — נשמרת בפעם הראשונה. */
let _fpPdfLibsPromise = null;
function _fpEnsurePdfLibs() {
if (window.jspdf && window.jspdf.jsPDF && window.html2canvas) return Promise.resolve();
if (_fpPdfLibsPromise) return _fpPdfLibsPromise;
const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
_fpPdfLibsPromise = Promise.all([
(window.jspdf && window.jspdf.jsPDF) ? Promise.resolve() : load('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'),
window.html2canvas ? Promise.resolve() : load('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js')
]);
return _fpPdfLibsPromise;
}

async function fpEmailToGraphics() {
if (!_fpIssue) return;
const cur = (cache.settings || {}).graphics_email || '';
const entered = prompt('מייל הגרפיקאית (יישמר לפעם הבאה):', cur);
if (entered === null) return;
const to = entered.trim();
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { toast('כתובת מייל לא תקינה', true); return; }
if (to !== cur) { try { await db.from('settings').upsert({ key: 'graphics_email', value: to }); if (cache.settings) cache.settings.graphics_email = to; } catch (e) { } }

const lines = ['עימוד — גיליון ' + _fpIssue.issue_number, 'חלוקה: ' + heDate(_fpIssue.publish_date) + ' · ' + _fpIssue.pages_count + ' עמודים', ''];
for (let p = 1; p <= _fpIssue.pages_count; p++) {
const ads = _fpAds.filter(a => a.page_number === p);
const arts = _fpArticles.filter(a => a.page_number === p);
const fill = Math.round(ads.reduce((s, a) => s + _adFraction(a), 0) * 100);
const items = [...ads.map(a => a.title + ' (' + Math.round(_adFraction(a) * 100) + '%)'), ...arts.map(a => '✍ ' + a.title)].join(' · ') || '—';
lines.push('עמוד ' + p + (fill ? ' [' + fill + '%]' : '') + ': ' + items);
}
const unplaced = _fpAds.filter(a => !a.page_number && ['approved', 'placed'].includes(a.status)).map(a => a.title).join(' · ');
if (unplaced) { lines.push(''); lines.push('ממתינים לשיבוץ: ' + unplaced); }
const body = lines.join('\n');

const tdS = 'border:1px solid #cbd5e1;padding:6px 9px;font-size:13px;text-align:right;vertical-align:top';
let rows = '';
for (let p = 1; p <= _fpIssue.pages_count; p++) {
const ads = _fpAds.filter(a => a.page_number === p);
const arts = _fpArticles.filter(a => a.page_number === p);
const fill = Math.round(ads.reduce((s, a) => s + _adFraction(a), 0) * 100);
const items = [...ads.map(a => esc(a.title) + ' (' + Math.round(_adFraction(a) * 100) + '%)'), ...arts.map(a => '✍ ' + esc(a.title))].join(' · ') || '—';
rows += `<tr><td style="${tdS};font-weight:700;white-space:nowrap">עמוד ${p}</td><td style="${tdS}">${fill ? fill + '%' : ''}</td><td style="${tdS}">${items}</td></tr>`;
}
const html = `<div style="font-family:Arial,Heebo,sans-serif;direction:rtl;text-align:right;color:#111">
<h2 style="margin:0 0 4px">עימוד — גיליון ${_fpIssue.issue_number}</h2>
<div style="color:#555;font-size:13px;margin-bottom:10px">חלוקה: ${heDate(_fpIssue.publish_date)} · ${_fpIssue.pages_count} עמודים</div>
<table style="width:100%;border-collapse:collapse">
<thead><tr><th style="${tdS};background:#f1f5f9;width:70px">עמוד</th><th style="${tdS};background:#f1f5f9;width:55px">מילוי</th><th style="${tdS};background:#f1f5f9">תוכן</th></tr></thead>
<tbody>${rows}</tbody></table>
${unplaced ? `<p style="font-size:13px;color:#b45309;margin-top:10px"><b>ממתינים לשיבוץ:</b> ${esc(unplaced)}</p>` : ''}
</div>`;

toast('מכין PDF ושולח לגרפיקאית...');
let attachments = [];
try {
await _fpEnsurePdfLibs();
const wrap = document.createElement('div');
wrap.style.cssText = 'position:fixed;left:-99999px;top:0;width:760px;background:#fff;padding:24px;box-sizing:border-box';
wrap.innerHTML = html;
document.body.appendChild(wrap);
let base64 = '';
try {
const canvas = await window.html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff' });
const JsPDF = window.jspdf.jsPDF;
const pdf = new JsPDF('p', 'pt', 'a4');
const pw = pdf.internal.pageSize.getWidth();
const ph = pdf.internal.pageSize.getHeight();
const imgH = canvas.height * pw / canvas.width;
const imgData = canvas.toDataURL('image/jpeg', 0.92);
let heightLeft = imgH, position = 0;
pdf.addImage(imgData, 'JPEG', 0, position, pw, imgH);
heightLeft -= ph;
while (heightLeft > 0) { position -= ph; pdf.addPage(); pdf.addImage(imgData, 'JPEG', 0, position, pw, imgH); heightLeft -= ph; }
base64 = _commB64(new Uint8Array(pdf.output('arraybuffer')));
} finally { wrap.remove(); }
if (base64) attachments = [{ filename: 'עימוד-' + _fpIssue.issue_number + '.pdf', content: base64, contentType: 'application/pdf' }];
} catch (e) { toast('יצירת ה-PDF נכשלה — נשלח כטבלה בגוף המייל', true); }

try {
const payload = { to, subject: 'עימוד ' + _fpIssue.issue_number, body: attachments.length ? 'מצורף העימוד.' : body };
if (attachments.length) payload.attachments = attachments; else payload.html = html;
const { data, error } = await db.functions.invoke('send-email', { body: payload });
if (!error && data && data.ok) { toast('✅ העימוד נשלח ל' + to + (attachments.length ? ' (PDF מצורף)' : '')); return; }
let msg = ''; try { if (error && error.context && error.context.json) { const j = await error.context.json(); msg = j.detail || j.error || ''; } } catch (e) { }
if (!msg && data) msg = data.detail || data.error || '';
toast('השליחה נכשלה' + (msg ? ' (' + msg + ')' : ''), true);
} catch (e) { toast('שגיאה: ' + (e && e.message || e), true); }
}

function checklistToggle(id, done) {
const c = _fpChecklist.find(x => x.id === id); if (c) c.done = done;
_fpChecklistIncomplete = _fpChecklist.filter(x => !x.done).length;
run(db.from('issue_checklist').update({ done, done_by: done ? profile.id : null, done_at: done ? new Date().toISOString() : null }).eq('id', id));
toast(done ? 'סומן ✓' : 'בוטל הסימון');
}

function issueStatusChange() {
openForm('סטטוס גיליון ' + _fpIssue.issue_number, [
{ name: 'status', label: 'סטטוס', type: 'select', required: true,
options: Object.entries(STATUS.issue).map(([v, t]) => ({ v, t: t[0] })) },
{ name: 'pages_count', label: 'מספר עמודים', type: 'number', required: true },
{ name: 'print_qty', label: 'כמות הדפסה', type: 'number' },
{ name: 'notes', label: 'הערות', type: 'textarea' },
], _fpIssue, async (rec) => {
if (['closed', 'published'].includes(rec.status) && (_fpWarnings.length || _fpChecklistIncomplete)) {
if (!confirm(`יש ${_fpWarnings.length} אזהרות פתוחות${_fpChecklistIncomplete ? " ו-" + _fpChecklistIncomplete + " פריטי צ'קליסט לא סומנו" : ''}.\nלסגור את הגיליון בכל זאת?`)) return;
}
await run(db.from('issues').update(rec).eq('id', _fpIssue.id));
_issues = await run(db.from('issues').select('*').order('issue_number', { ascending: false }));
toast('עודכן');
openFlatplan(_fpIssue.id);
});
}

/* מגמות — סיכום 8 גיליונות אחרונים (הכנסה ואחוז מילוי) */
async function _issuesTrends() {
const box = document.getElementById('issuesTrends'); if (!box) return;
const recent = (_issues || []).slice(0, 8);
if (!recent.length) return;
const ids = recent.map(i => i.id);
let ads;
try { ads = await run(db.from('ads').select('issue_id,page_number,price,discount,price_item_id,status').in('issue_id', ids).not('status', 'in', '("cancelled","rejected")')); }
catch (e) { return; }
const byIssue = {};
ads.forEach(a => { const o = byIssue[a.issue_id] = byIssue[a.issue_id] || { rev: 0, area: 0 }; o.rev += Number(a.price || 0) - Number(a.discount || 0); if (a.page_number) o.area += _adFraction(a); });
const rows = recent.map(i => {
const o = byIssue[i.id] || { rev: 0, area: 0 };
const fill = i.pages_count ? Math.round(o.area / i.pages_count * 100) : 0;
return `<tr><td><b>גיליון ${i.issue_number}</b></td><td>${heDate(i.publish_date)}</td><td>${money(o.rev)}</td><td>${o.area.toFixed(2)} עמ'</td><td>${fill}%</td></tr>`;
}).join('');
box.innerHTML = `<div class="card card-pad" style="margin-top:16px"><b>מגמות — 8 גיליונות אחרונים</b>
<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th>גיליון</th><th>חלוקה</th><th>הכנסת מודעות</th><th>שטח מודעות</th><th>מילוי</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/* ==================== ארכיון גיליונות ==================== */

Pages.archive = {
render: async (el) => {
const published = await run(db.from('issues').select('*').order('issue_number', { ascending: false }).limit(500));
const withPdf = published.filter(i => i.pdf_path);
const isAdmin = profile.role === 'admin';
el.innerHTML = `
<div class="page-head">
<h2>ארכיון גיליונות</h2>
${isAdmin ? `
<div class="actions">
<button class="btn btn-ghost" onclick="archiveOldIssue()">📚 העלאת גיליון ישן</button>
<select id="archIssue" style="width:auto">
${published.map(i => `<option value="${i.id}">גיליון ${i.issue_number}</option>`).join('')}
</select>
<input type="file" id="archFile" accept=".pdf" class="hidden" onchange="archiveUpload()">
<button class="btn" onclick="document.getElementById('archFile').click()">⬆ העלאת PDF</button>
</div>` : ''}
</div>
<p class="muted" style="margin-bottom:12px;font-size:.85rem">
לגיליון קיים: בחר גיליון ולחץ "העלאת PDF". לגיליונות היסטוריים שלפני המערכת: "העלאת גיליון ישן" —
נותנים מספר ותאריך, והגיליון נכנס לארכיון.</p>
${isAdmin ? (() => {
const on = String((cache.settings || {}).public_archive_enabled || '0') === '1';
const url = location.href.replace(/index\.html.*$/, '').replace(/\/$/, '') + '/portal/archive.html';
return `<div class="card card-pad" style="margin-bottom:14px;border-right:4px solid ${on ? 'var(--ok)' : 'var(--line)'}">
<b>🌍 ארכיון ציבורי</b>
<p class="muted" style="font-size:.82rem">דף פתוח לקהל עם גיליונות שפורסמו (רק כאלה שיש להם PDF). כבוי — הדף והקבצים חסומים לגמרי.</p>
<label style="display:flex;gap:8px;align-items:center;margin-top:6px;cursor:pointer">
<input type="checkbox" ${on ? 'checked' : ''} onchange="archivePublicToggle(this.checked)" style="width:18px;height:18px">
הארכיון הציבורי פעיל
</label>
${on ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
<input readonly value="${esc(url)}" dir="ltr" style="font-size:.78rem;flex:1;min-width:220px" onclick="this.select()">
<button class="btn btn-sm btn-ghost" onclick="navigator.clipboard.writeText('${esc(url)}').then(()=>toast('הקישור הועתק'))">העתקה</button>
<a class="btn btn-sm btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">פתיחה</a>
</div>` : ''}
</div>`;
})() : ''}
<div class="card" id="archTable"></div>`;
renderTable(document.getElementById('archTable'), withPdf, [
{ h: 'גיליון', f: r => `<b>גיליון ${r.issue_number}</b>` },
{ h: 'תאריך', f: r => heDate(r.publish_date) },
{ h: '', f: r => `<button class="btn btn-sm btn-ghost" onclick="archiveOpen('${esc(r.pdf_path)}')">📖 פתיחה</button>` },
], { empty: 'אין עדיין גיליונות בארכיון — העלה את ה-PDF הראשון' });
}
};

/* העלאת PDF לגיליון קיים */
async function archiveUpload() {
const file = document.getElementById('archFile').files[0];
const issueId = Number(document.getElementById('archIssue').value);
if (!file) return;
const issue = cache.issues.find(i => i.id === issueId);
const path = `issue_${issue ? issue.issue_number : issueId}.pdf`;
const { error } = await db.storage.from('issues-archive').upload(path, file, { upsert: true });
if (error) { toast('שגיאה: ' + error.message, true); return; }
await run(db.from('issues').update({ pdf_path: path }).eq('id', issueId));
toast('הגיליון נשמר בארכיון');
openPage('archive');
}

/* ---------- גיליון היסטורי: מספר + תאריך + PDF במסך אחד ---------- */
function archiveOldIssue() {
document.getElementById('viewModal').innerHTML = `
<h3>📚 העלאת גיליון ישן לארכיון</h3>
<div class="grid2">
<div class="field"><label>מספר הגיליון *</label><input id="oldNum" type="number" dir="ltr"></div>
<div class="field"><label>תאריך היציאה (בערך) *</label><input id="oldDate" type="date"></div>
</div>
<div class="field"><label>קובץ ה-PDF של הגיליון *</label><input id="oldPdf" type="file" accept=".pdf"></div>
<div class="m-actions">
<button class="btn" onclick="archiveOldSave()">שמירה בארכיון</button>
<button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
</div>`;
document.getElementById('viewBack').classList.add('open');
}

async function archiveOldSave() {
const num = Number(document.getElementById('oldNum').value);
const date = document.getElementById('oldDate').value;
const file = document.getElementById('oldPdf').files[0];
if (!num || !date || !file) { toast('נא למלא מספר, תאריך ולבחור קובץ', true); return; }

const dup = await run(db.from('issues').select('id').eq('issue_number', num));
if (dup.length) { toast('מספר גיליון ' + num + ' כבר קיים במערכת', true); return; }

// העלאת הקובץ קודם — אם נכשלת, לא נוצרת רשומה מיותמת
const path = `issue_${num}.pdf`;
const { error } = await db.storage.from('issues-archive').upload(path, file, { upsert: true });
if (error) { toast('שגיאה בהעלאה: ' + error.message, true); return; }

await run(db.from('issues').insert({
issue_number: num, publish_date: date, status: 'published',
pdf_path: path, notes: 'גיליון היסטורי — הועלה לארכיון',
}));
await refreshCache();
document.getElementById('viewBack').classList.remove('open');
toast('✓ גיליון ' + num + ' נשמר בארכיון');
openPage('archive');
}

async function archiveOpen(path) {
const { data, error } = await db.storage.from('issues-archive').createSignedUrl(path, 600);
if (error) { toast('שגיאה: ' + error.message, true); return; }
window.open(data.signedUrl, '_blank');
}

/* ============================================================
   לוח שנה עברי בתכנון גיליונות (פיצ'ר #18)
   ------------------------------------------------------------
   נשען על לוח השנה העברי המובנה בדפדפן (Intl, ca-hebrew) — בלי
   שום ספרייה חיצונית. מזהה חגים ומועדים לפי התאריך העברי, מסמן
   גיליונות סמוכים לחג ומתריע על דדליין שנופל על חג/ערב חג.
   ============================================================ */

const _HEB_HE = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long' });
const _HEB_EN = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long' });

function hebDateStr(d) {
  try { return _HEB_HE.format(d instanceof Date ? d : new Date(d + 'T12:00:00')); } catch (e) { return ''; }
}
function _hebParts(d) {
  try {
    const parts = _HEB_EN.formatToParts(d instanceof Date ? d : new Date(d + 'T12:00:00'));
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    return { day: Number(get('day')), month: get('month') };
  } catch (e) { return null; }
}

/* חגים ומועדים לפי תאריך עברי. 'Adar' תופס גם אדר ב' בשנה מעוברת. */
function hebHolidayOn(d) {
  const h = _hebParts(d); if (!h) return null;
  const m = h.month, day = h.day;
  const inM = (name, from, to) => m === name && day >= from && day <= (to || from);
  if (inM('Elul', 29)) return 'ערב ראש השנה';
  if (inM('Tishri', 1, 2)) return 'ראש השנה';
  if (inM('Tishri', 9)) return 'ערב יום כיפור';
  if (inM('Tishri', 10)) return 'יום כיפור';
  if (inM('Tishri', 14)) return 'ערב סוכות';
  if (inM('Tishri', 15, 21)) return day === 21 ? 'הושענא רבה' : 'סוכות';
  if (inM('Tishri', 22)) return 'שמחת תורה';
  if (inM('Kislev', 25, 30) || inM('Tevet', 1, 2)) return 'חנוכה';
  if (inM('Shevat', 15)) return 'ט"ו בשבט';
  if ((m === 'Adar' || m === 'Adar II') && day === 13) return 'תענית אסתר';
  if ((m === 'Adar' || m === 'Adar II') && day === 14) return 'פורים';
  if ((m === 'Adar' || m === 'Adar II') && day === 15) return 'שושן פורים';
  if (inM('Nisan', 14)) return 'ערב פסח';
  if (inM('Nisan', 15, 21)) return day === 21 ? 'שביעי של פסח' : 'פסח';
  if (inM('Iyar', 18)) return 'ל"ג בעומר';
  if (inM('Sivan', 5)) return 'ערב שבועות';
  if (inM('Sivan', 6)) return 'שבועות';
  if (inM('Av', 9)) return 'תשעה באב';
  if (inM('Av', 15)) return 'ט"ו באב';
  return null;
}

/* החג הקרוב בטווח ±days סביב תאריך (לסימון "גיליון סמוך לחג") */
function hebHolidayNear(dateStr, days) {
  if (!dateStr) return null;
  const base = new Date(dateStr + 'T12:00:00');
  if (isNaN(base)) return null;
  const span = days == null ? 3 : days;
  for (let off = 0; off <= span; off++) {
    for (const sign of (off === 0 ? [0] : [-1, 1])) {
      const d = new Date(base); d.setDate(d.getDate() + off * (sign || 1));
      const name = hebHolidayOn(d);
      if (name) return { name, offset: off * (sign || 1) };
    }
  }
  return null;
}

/* תא תאריך עם התאריך העברי + תגית חג */
function hebIssueDateCell(dateStr) {
  if (!dateStr) return '—';
  const hol = hebHolidayNear(dateStr, 3);
  return heDate(dateStr) +
    `<div style="font-size:.72rem;color:var(--muted,#6b7280)">${esc(hebDateStr(dateStr))}</div>` +
    (hol ? `<span class="pill gold" style="font-size:.68rem" title="${hol.offset === 0 ? 'ביום החלוקה' : Math.abs(hol.offset) + ' ימים ' + (hol.offset > 0 ? 'אחרי' : 'לפני')}">🕎 ${esc(hol.name)}</span>` : '');
}

/* אזהרת דדליין שנופל על חג/ערב חג — הצעה להקדים */
function hebDeadlineWarn(deadline) {
  if (!deadline) return '';
  const dOnly = String(deadline).slice(0, 10);
  const hol = hebHolidayOn(dOnly);
  if (!hol) return '';
  return ` <span style="color:#b45309;font-weight:700" title="הדדליין נופל על ${esc(hol)} — שקול להקדים">⚠ ${esc(hol)}</span>`;
}

/* באנר גיליונות-חג קרובים — לראש עמוד הגיליונות */
function hebHolidayBanner(issues) {
  try {
    const T = today();
    const soon = (issues || []).filter(i => (i.publish_date || '') >= T && !['closed', 'published'].includes(i.status))
      .map(i => ({ i, hol: hebHolidayNear(i.publish_date, 3) }))
      .filter(x => x.hol).slice(0, 4);
    if (!soon.length) return '';
    return `<div class="card card-pad" style="border-right:4px solid #b45309;margin-bottom:14px">
      <b style="color:#b45309">🕎 גיליונות חג קרובים:</b>
      <span style="font-size:.9rem"> ${soon.map(x => `גיליון ${x.i.issue_number} — ${esc(x.hol.name)}${hebHolidayOn(String(x.i.ads_deadline || '').slice(0, 10)) ? ' (הדדליין על החג! ⚠)' : ''}`).join(' · ')}</span>
      <span class="muted" style="font-size:.8rem"> — שקול להקדים דדליינים ולתגבר מכירות.</span>
    </div>`;
  } catch (e) { return ''; }
}

/* מתג הארכיון הציבורי (פיצ'ר #20) — נאכף גם ב-DB (RPC + מדיניות storage) */
async function archivePublicToggle(on) {
  await run(db.from('settings').upsert({ key: 'public_archive_enabled', value: on ? '1' : '0' }));
  cache.settings.public_archive_enabled = on ? '1' : '0';
  toast(on ? '🌍 הארכיון הציבורי הופעל' : 'הארכיון הציבורי כובה — הדף והקבצים חסומים');
  openPage('archive');
}
