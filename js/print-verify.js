/* ============================================================
   print-verify.js — אימות גיליון מודפס מול העימוד (יום ראשון)
   ------------------------------------------------------------
   כל יום ראשון (מנהל): המערכת מבקשת לאמת את הגיליון האחרון מול העימוד.
   אשף מודרך עמוד-אחר-עמוד: מצד אחד מה שהעימוד מצפה, מצד שני העמוד
   המודפס האמיתי (נחתך מה-PDF, כולל כפולות RTL). המשתמש מאשר/מתקן:
   - מודעה שלא הודפסה → מוסרת מהעימוד (page_number=null)
   - מודעה שעברה עמוד → עדכון מספר העמוד
   - מודעה שנוספה → שיבוץ לעמוד הנוכחי
   השינויים נשמרים מיד (הפעולה באשף = האישור). בסיום הגיליון מסומן כמאומת.
   מסתמך על _apEnsureLib + _apPageMap מתוך ad-proof.js.
   ============================================================ */
'use strict';

let _pvState = null;
function _pvKey(n) { return 'pv_done_' + n; }
function _pvIsDone(n) { return String((cache.settings || {})[_pvKey(n)] || '') === '1'; }
async function _pvMarkDone(n) {
  try { await db.from('settings').upsert({ key: _pvKey(n), value: '1' }); if (cache.settings) cache.settings[_pvKey(n)] = '1'; } catch (e) { }
}

/* ---------- תזכורת יום ראשון בכניסה ---------- */
async function pvCheckPending() {
  try {
    if (typeof profile === 'undefined' || profile.role !== 'admin') return false;
    if (new Date().getDay() !== 0) return false; // רק יום ראשון
    const _vb = document.getElementById('viewBack');
    if (_vb && _vb.classList.contains('open')) return false;
    const cand = (cache.issues || []).slice().sort((a, b) => b.issue_number - a.issue_number)
      .find(i => !_pvIsDone(i.issue_number));
    if (!cand) return false;
    const ads = await run(db.from('ads').select('id').eq('issue_id', cand.id)
      .not('status', 'in', '("cancelled","rejected")').gt('page_number', 0).limit(1));
    if (!ads || !ads.length) return false; // אין עימוד לגיליון הזה
    _pvReminder(cand);
    return true;
  } catch (e) { console.error('pv', e); return false; }
}

function _pvReminder(issue) {
  document.getElementById('viewModal').innerHTML = `
    <h3>🖨️ אימות גיליון מודפס — גיליון ${issue.issue_number}</h3>
    <p class="muted">היום יום ראשון. כדאי לאמת שהגיליון שהודפס תואם לעימוד, ולעדכן הבדלים באישורך.</p>
    <div class="m-actions" style="flex-wrap:wrap">
      <button class="btn" onclick="openPrintVerify(${issue.id})">התחל אימות ←</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">השבוע לא</button>
      <button class="btn btn-ghost" style="margin-right:auto" onclick="_pvSkip(${issue.issue_number})">כבר אימתתי / דלג</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}
async function _pvSkip(num) { await _pvMarkDone(num); document.getElementById('viewBack').classList.remove('open'); toast('סומן כמאומת'); }

/* ---------- טעינת הגיליון וה-PDF ---------- */
async function openPrintVerify(issueId) {
  try {
    toast('טוען את הגיליון...');
    const issue = (cache.issues || []).find(i => i.id === issueId) || await run(db.from('issues').select('*').eq('id', issueId).single());
    if (!issue) { toast('גיליון לא נמצא', true); return; }
    const ads = await run(db.from('ads').select('id,customer_id,title,page_number,status,price,discount')
      .eq('issue_id', issueId).not('status', 'in', '("cancelled","rejected")'));
    if (!issue.pdf_path) {
      const cand = 'issue_' + issue.issue_number + '.pdf';
      if (await _pvStorageHas(cand)) {
        issue.pdf_path = cand;
        try { await db.from('issues').update({ pdf_path: cand }).eq('id', issueId); const ci = (cache.issues || []).find(i => i.id === issueId); if (ci) ci.pdf_path = cand; } catch (e) { }
      }
    }
    if (!issue.pdf_path) { _pvUploadPrompt(issue, ads || []); return; }
    await _pvLoadPdfAndStart(issue, ads || []);
  } catch (e) { toast('שגיאה: ' + (e && e.message || e), true); }
}

async function _pvStorageHas(name) {
  try { const r = await db.storage.from('issues-archive').list('', { limit: 200, search: name }); return !!(r.data && r.data.some(f => f.name === name)); } catch (e) { return false; }
}

function _pvUploadPrompt(issue, ads) {
  window.__pvPending = { issue, ads };
  document.getElementById('viewModal').innerHTML = `
    <h3>🖨️ אימות גיליון ${issue.issue_number} — העלאת ה-PDF המודפס</h3>
    <p class="muted">עדיין לא הועלה PDF לגיליון זה. העלה את קובץ הגיליון המודפס (2 עמודים בכל דף — כפולות).</p>
    <div class="field"><label>קובץ PDF של הגיליון המודפס *</label><input id="pvFile" type="file" accept=".pdf"></div>
    <div class="m-actions">
      <button class="btn" onclick="_pvUploadGo(${issue.id})">העלה והמשך ←</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">ביטול</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
}
async function _pvUploadGo(issueId) {
  const p = window.__pvPending; if (!p) return;
  const file = document.getElementById('pvFile').files[0];
  if (!file) { toast('נא לבחור קובץ', true); return; }
  toast('מעלה...');
  const path = `issue_${p.issue.issue_number}.pdf`;
  const { error } = await db.storage.from('issues-archive').upload(path, file, { upsert: true });
  if (error && !(await _pvStorageHas(path))) { toast('שגיאה בהעלאה: ' + error.message, true); return; }
  await run(db.from('issues').update({ pdf_path: path }).eq('id', issueId));
  p.issue.pdf_path = path;
  const ci = (cache.issues || []).find(i => i.id === issueId); if (ci) ci.pdf_path = path;
  await _pvLoadPdfAndStart(p.issue, p.ads);
}

async function _pvLoadPdfAndStart(issue, ads) {
  toast('טוען PDF...');
  const { data: signed, error: sErr } = await db.storage.from('issues-archive').createSignedUrl(issue.pdf_path, 900);
  if (sErr || !signed) { toast('אין גישה ל-PDF', true); return; }
  const resp = await fetch(signed.signedUrl);
  if (!resp.ok) { toast('הורדת PDF נכשלה (' + resp.status + ')', true); return; }
  const srcBytes = new Uint8Array(await resp.arrayBuffer());
  const PDFLib = await _apEnsureLib();
  const src = await PDFLib.PDFDocument.load(srcBytes);
  const { map, pageCount } = _apPageMap(src);
  _pvState = { issue, ads, PDFLib, src, map, pageCount, page: 1, changes: [], url: null, pdfjsDoc: null, thumbs: {} };
  try { await _pvEnsurePdfJs(); _pvState.pdfjsDoc = await window.pdfjsLib.getDocument({ data: new Uint8Array(srcBytes) }).promise; } catch (e) { }
  _pvRenderGrid();
}

let _pvPdfJsPromise = null;
function _pvEnsurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (_pvPdfJsPromise) return _pvPdfJsPromise;
  _pvPdfJsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
    s.onload = () => { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; } catch (e) { } res(); };
    s.onerror = () => rej(new Error('pdfjs load'));
    document.head.appendChild(s);
  });
  return _pvPdfJsPromise;
}

/* תמונה ממוזערת של עמוד עיתון בודד (נחתך מהכפולה) */
async function _pvThumb(N) {
  const st = _pvState; const e = st.map[N]; if (!e || !st.pdfjsDoc) return null;
  const page = await st.pdfjsDoc.getPage(e.idx + 1);
  const vp = page.getViewport({ scale: 0.5 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  let out = c;
  if (e.half !== 'full') {
    const hw = Math.floor(c.width / 2);
    const c2 = document.createElement('canvas'); c2.width = hw; c2.height = c.height;
    const sx = e.half === 'right' ? (c.width - hw) : 0;
    c2.getContext('2d').drawImage(c, sx, 0, hw, c.height, 0, 0, hw, c.height);
    out = c2;
  }
  return out.toDataURL('image/jpeg', 0.7);
}

function _pvOpenPage(p) { const st = _pvState; if (!st) return; st.page = p; _pvRender(); }

/* מסך רשת: תמונות של כל העמודים + מה שהעימוד מצפה. לוחצים רק על מה שצריך תיקון */
async function _pvRenderGrid() {
  const st = _pvState; if (!st) return;
  if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) { } st.url = null; }
  let cells = '';
  for (let p = 1; p <= st.pageCount; p++) {
    const exp = st.ads.filter(a => a.page_number === p);
    const names = exp.map(a => esc(nameOf('customers', a.customer_id))).join(' · ') || '—';
    cells += `<div onclick="_pvOpenPage(${p})" style="cursor:pointer;border:1px solid var(--line,#e5e7eb);border-radius:10px;overflow:hidden;background:#fff">
      <div id="pvth_${p}" style="height:150px;background:#f1f5f9;display:flex;align-items:center;justify-content:center"><span class="muted" style="font-size:.72rem">טוען…</span></div>
      <div style="padding:6px 8px"><div style="font-weight:700;color:@@COLOR_BRAND@@">עמוד ${p}</div><div class="muted" style="font-size:.74rem;max-height:34px;overflow:hidden">${names}</div></div>
    </div>`;
  }
  document.getElementById('viewModal').innerHTML = `
    <h3>🖨️ אימות גיליון ${st.issue.issue_number} — סקירת עמודים</h3>
    <p class="muted" style="font-size:.83rem;margin-top:-6px">השווה כל תמונה למה שהעימוד מצפה (למטה). לחץ רק על עמוד שצריך תיקון.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:64vh;overflow:auto">${cells}</div>
    <div class="m-actions" style="margin-top:12px">
      <button class="btn" onclick="_pvFinish()">סיום ושמירה</button>
      <button class="btn btn-ghost" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  for (let p = 1; p <= st.pageCount; p++) {
    try {
      const url = st.thumbs[p] || (st.thumbs[p] = await _pvThumb(p));
      const cell = document.getElementById('pvth_' + p);
      if (cell) cell.innerHTML = url ? `<img src="${url}" style="width:100%;height:100%;object-fit:contain">` : '<span class="muted" style="font-size:.7rem">אין תצוגה</span>';
    } catch (e) { const cell = document.getElementById('pvth_' + p); if (cell) cell.innerHTML = '<span class="muted" style="font-size:.7rem">—</span>'; }
  }
}

/* בונה blob של עמוד עיתון בודד (נחתך מהכפולה) */
async function _pvPageBlob(N) {
  const st = _pvState; const e = st.map[N];
  if (!e) return null;
  const out = await st.PDFLib.PDFDocument.create();
  const [cp] = await out.copyPages(st.src, [e.idx]);
  if (e.half !== 'full') {
    const b = cp.getMediaBox();
    if (e.half === 'right') { cp.setMediaBox(b.x + b.width / 2, b.y, b.width / 2, b.height); cp.setCropBox(b.x + b.width / 2, b.y, b.width / 2, b.height); }
    else { cp.setMediaBox(b.x, b.y, b.width / 2, b.height); cp.setCropBox(b.x, b.y, b.width / 2, b.height); }
  }
  out.addPage(cp);
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function _pvRender() {
  const st = _pvState; if (!st) return; const p = st.page;
  if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) { } st.url = null; }
  const expected = st.ads.filter(a => a.page_number === p);
  const rows = expected.map(a => `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:6px 8px;margin-bottom:6px">
      <b style="flex:1;min-width:90px">${esc(nameOf('customers', a.customer_id))}</b>
      <span class="muted" style="font-size:.8rem">${esc(a.title || '')}</span>
      <button class="btn btn-sm btn-ghost" onclick="_pvNotPrinted(${a.id})">🚫 לא הודפס</button>
      <button class="btn btn-sm btn-ghost" onclick="_pvMove(${a.id})">↔ עבר עמוד</button>
    </div>`).join('') || '<p class="muted">העימוד לא מצפה למודעות בעמוד זה.</p>';
  document.getElementById('viewModal').innerHTML = `
    <h3>🖨️ אימות גיליון ${st.issue.issue_number} — עמוד ${p} מתוך ${st.pageCount}</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-weight:700;color:@@COLOR_BRAND@@;margin-bottom:6px">העימוד מצפה בעמוד ${p}:</div>
        ${rows}
        <button class="btn btn-sm" style="margin-top:6px" onclick="_pvAddPrompt()">➕ מודעה שנוספה בעמוד זה</button>
        <div id="pvAddBox"></div>
      </div>
      <div>
        <div style="font-weight:700;color:@@COLOR_BRAND@@;margin-bottom:6px">העמוד המודפס:</div>
        <div id="pvViewer" style="height:58vh;border:1px solid var(--line,#e5e7eb);border-radius:8px;overflow:hidden;background:#f8f8f8">טוען עמוד...</div>
      </div>
    </div>
    <div class="m-actions" style="flex-wrap:wrap;margin-top:12px">
      <button class="btn" onclick="_pvRenderGrid()">⊞ חזרה לרשת</button>
      <button class="btn btn-ghost" onclick="_pvGo(${p - 1})" ${p <= 1 ? 'disabled' : ''}>→ הקודם</button>
      <button class="btn btn-ghost" onclick="_pvGo(${p + 1})" ${p >= st.pageCount ? 'disabled' : ''}>הבא ←</button>
      <button class="btn btn-ghost" style="margin-right:auto" onclick="_pvFinish()">סיום ושמירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  try {
    const blob = await _pvPageBlob(p);
    const el = document.getElementById('pvViewer'); if (!el) return;
    if (blob) { st.url = URL.createObjectURL(blob); el.innerHTML = `<iframe src="${st.url}#toolbar=0&navpanes=0" style="width:100%;height:100%;border:0"></iframe>`; }
    else el.innerHTML = '<p class="muted" style="padding:10px">העמוד לא נמצא ב-PDF</p>';
  } catch (e) { const el = document.getElementById('pvViewer'); if (el) el.innerHTML = '<p class="muted" style="padding:10px">שגיאה בהצגת העמוד</p>'; }
}

function _pvGo(n) {
  const st = _pvState; if (!st) return;
  if (n < 1) return;
  if (n > st.pageCount) { _pvRenderGrid(); return; }
  st.page = n; _pvRender();
}

async function _pvNotPrinted(adId) {
  const st = _pvState; if (!st) return; const a = st.ads.find(x => x.id === adId); if (!a) return;
  if (!confirm('לסמן שהמודעה של "' + nameOf('customers', a.customer_id) + '" לא הודפסה ולהסירה מהעימוד?')) return;
  await run(db.from('ads').update({ page_number: null }).eq('id', adId));
  st.changes.push({ t: 'not_printed', cust: nameOf('customers', a.customer_id), from: a.page_number });
  a.page_number = null;
  toast('סומן כלא הודפס');
  _pvRender();
}

async function _pvMove(adId) {
  const st = _pvState; if (!st) return; const a = st.ads.find(x => x.id === adId); if (!a) return;
  const to = prompt('לאיזה עמוד עברה המודעה של "' + nameOf('customers', a.customer_id) + '"?', '');
  if (to === null) return;
  const N = Number(to);
  if (!N || N < 1 || N > st.pageCount) { toast('מספר עמוד לא תקין', true); return; }
  const from = a.page_number;
  await run(db.from('ads').update({ page_number: N, status: 'placed' }).eq('id', adId));
  st.changes.push({ t: 'moved', cust: nameOf('customers', a.customer_id), from, to: N });
  a.page_number = N; a.status = 'placed';
  toast('עודכן לעמוד ' + N);
  _pvRender();
}

function _pvAddPrompt() {
  const box = document.getElementById('pvAddBox'); if (!box) return;
  box.innerHTML = `
    <div style="border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:8px;margin-top:6px">
      <input id="pvAddSearch" placeholder="חפש מודעה/לקוח בגיליון..." oninput="_pvAddSearch(this.value)" autocomplete="off" style="width:100%">
      <div id="pvAddRes" style="max-height:150px;overflow:auto;margin-top:4px"></div>
    </div>`;
  const s = document.getElementById('pvAddSearch'); if (s) s.focus();
}
function _pvAddSearch(q) {
  const st = _pvState; if (!st) return; q = (q || '').trim();
  const res = document.getElementById('pvAddRes'); if (!res) return;
  if (!q) { res.innerHTML = ''; return; }
  const cand = st.ads.filter(a => a.page_number !== st.page).filter(a => {
    const nm = nameOf('customers', a.customer_id) || '';
    return nm.indexOf(q) >= 0 || (a.title || '').indexOf(q) >= 0;
  }).slice(0, 12);
  res.innerHTML = cand.map(a => `<div style="padding:5px 6px;border-bottom:1px solid #eee;cursor:pointer" onclick="_pvAddDo(${a.id})">${esc(nameOf('customers', a.customer_id))} <span class="muted" style="font-size:.78rem">${esc(a.title || '')}${a.page_number ? ' · כרגע עמ׳ ' + a.page_number : ' · לא משובצת'}</span></div>`).join('') || '<div class="muted" style="padding:5px">לא נמצא</div>';
}
async function _pvAddDo(adId) {
  const st = _pvState; if (!st) return; const a = st.ads.find(x => x.id === adId); if (!a) return;
  const from = a.page_number;
  await run(db.from('ads').update({ page_number: st.page, status: 'placed' }).eq('id', adId));
  st.changes.push({ t: 'added', cust: nameOf('customers', a.customer_id), from, to: st.page });
  a.page_number = st.page; a.status = 'placed';
  toast('נוספה לעמוד ' + st.page);
  _pvRender();
}

async function _pvFinish() {
  const st = _pvState; if (!st) return;
  if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) { } }
  await _pvMarkDone(st.issue.issue_number);
  const ch = st.changes;
  const summary = ch.length ? ch.map(c => {
    if (c.t === 'not_printed') return '• ' + c.cust + ' — לא הודפס (הוסר מעמ׳ ' + (c.from || '?') + ')';
    if (c.t === 'moved') return '• ' + c.cust + ' — עבר מעמ׳ ' + (c.from || '?') + ' לעמ׳ ' + c.to;
    if (c.t === 'added') return '• ' + c.cust + ' — נוסף לעמ׳ ' + c.to;
    return '';
  }).join('<br>') : 'לא בוצעו שינויים — העימוד תואם למודפס. 👍';
  document.getElementById('viewModal').innerHTML = `
    <h3>✓ האימות הושלם — גיליון ${st.issue.issue_number}</h3>
    <p style="line-height:1.7">${summary}</p>
    <div class="m-actions"><button class="btn" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`;
  document.getElementById('viewBack').classList.add('open');
  _pvState = null;
}
