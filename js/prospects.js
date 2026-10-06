/* ============================================================
   prospects.js — מפרסמים פוטנציאליים מתוך קובצי PDF (מנהל בלבד)
   ------------------------------------------------------------
   מעלים PDF של עיתון מתחרה / מגזין / עלון / גיליון קודם שלנו.
   כל עמוד מומר לתמונה בדפדפן (pdf.js) ונשלח לבד ל-Edge Function
   בשם extract-advertisers (Claude Vision) — אין מגבלת עמודים.
   לכל מודעה של עסק:
     • השוואה ללקוחות ולידים (טלפון 9 ספרות אחרונות + שם מנורמל):
       לקוח פעיל / ליד קיים → לא נכנס לרשימה (מוצג בסיכום).
       לקוח בעבר (crm_status=past או בלי מודעה 180 יום) → נכנס עם תגית "להחזיר".
     • מפרסם שכבר ברשימה → מצטבר (appearances, sources, הגודל הגדול).
     • אזור רחוק / תוכן לא מתאים → status=filtered (לשונית "סוננו", ניתן להחזיר).
     • צילום המודעה נחתך מהעמוד ונשמר ב-ad-files/prospects/.
   "העבר ללידים" פותח טופס ליד ממולא → ליד רגיל + status=converted.
   הצילום מוצג גם בכרטיס הליד (עטיפה של openLeadCard — בלי לגעת ב-leads.js).
   דורש: migrations/2026-10-06_prospects.sql
   ============================================================ */

'use strict';

let _ps = null;            // מצב הדף
let _psScan = null;        // מצב סריקה פעילה
const PS_BUCKET = 'ad-files';

const PS_SIZE = {
  full: ['עמוד שלם', 7], half: ['חצי עמוד', 6], third: ['שליש עמוד', 5], quarter: ['רבע עמוד', 4],
  eighth: ['שמינית', 3], strip: ['סטריפ', 3], small: ['מודעה קטנה', 2], classified: ['מודעת לוח', 1],
};
const PS_KIND = { competitor: 'עיתון מתחרה', magazine: 'מגזין / עלון', own: 'גיליון קודם שלנו' };
const PS_FIT = { local: 'מקומי', serves_area: 'משרת את האזור', online_national: 'אונליין / ארצי', far: 'אזור רחוק' };
const PS_TABS = [
  { id: 'new', t: 'לטיפול' },
  { id: 'winback', t: 'לקוחות עבר — להחזיר' },
  { id: 'filtered', t: 'סוננו' },
  { id: 'converted', t: 'הועברו ללידים' },
  { id: 'rejected', t: 'לא רלוונטי' },
];

/* ---------- עזרי נרמול ---------- */
function psPhKey(p) { return String(p || '').replace(/\D/g, '').slice(-9); }
function psPhReal(k) { return k && k.length >= 7; }
function psNameKey(n) {
  return String(n || '').toLowerCase()
    .replace(/['"׳״`.,\-–_()!?:]/g, ' ')
    .replace(/(^| )(בע מ|בעמ|ltd)(?= |$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function psScore(p) { return (p.size_rank || 0) * 2 + (p.appearances || 1) * 3 + (p.winback ? 4 : 0); }
function psRegion() {
  const s = cache.settings || {};
  return (s.prospect_region || '').trim() || (s.paper_city || '').trim() || (s.paper_name || '@@PAPER_NAME@@');
}

/* ---------- הדף ---------- */
Pages.prospects = {
  title: 'מפרסמים פוטנציאליים',
  render: async (el) => {
    if (profile.role !== 'admin') { el.innerHTML = '<div class="empty">מסך זה זמין למנהל בלבד</div>'; return; }
    psEnsureStyles();
    if (!_ps) _ps = { tab: 'new', q: '', rows: [], urls: {} };
    el.innerHTML = `
      <div class="page-head"><h2>מפרסמים פוטנציאליים</h2>
        <div class="actions">
          <button class="btn btn-ghost" onclick="psSettings()">⚙ הגדרות סינון</button>
        </div>
      </div>
      <div id="psScanBox"></div>
      <div id="psList"><div class="empty">טוען...</div></div>`;
    psDrawScanBox();
    await psLoad();
  }
};

async function psLoad() {
  const { data, error } = await db.from('prospects').select('*').order('id', { ascending: false }).limit(5000);
  if (error) {
    const box = document.getElementById('psList');
    if (box) box.innerHTML = /prospects|42P01|does not exist|schema cache/i.test(error.message || '')
      ? '<div class="empty">התכונה תופעל לאחר עדכון מסד הנתונים (מיגרציה 2026-10-06_prospects.sql)</div>'
      : `<div class="empty">שגיאה בטעינה: ${esc(error.message)}</div>`;
    return;
  }
  _ps.rows = data || [];
  psDrawList();
}

/* ---------- אזור העלאה וסריקה ---------- */
function psDrawScanBox() {
  const box = document.getElementById('psScanBox');
  if (!box) return;
  if (_psScan && _psScan.running) { psDrawProgress(); return; }
  box.innerHTML = `
    <div class="card card-pad ps-upload">
      <b>📄 סריקת קובץ PDF לאיתור מפרסמים</b>
      <div class="ps-upl-grid">
        <div class="field"><label>קובץ PDF</label><input type="file" id="psFile" accept="application/pdf,.pdf"></div>
        <div class="field"><label>סוג המקור</label>
          <select id="psKind">${Object.entries(PS_KIND).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>
        <div class="field"><label>שם הפרסום (למשל שם העיתון)</label><input id="psPub" placeholder="לא חובה"></div>
        <div class="field"><label>תאריך הגיליון</label><input type="date" id="psDate" value="${today()}"></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <button class="btn" onclick="psStartScan()">🔍 סרוק ומצא מפרסמים</button>
        <span class="muted" style="font-size:.85rem">כמה עמודים נסרקים במקביל — הרשימה למטה מתמלאת תוך כדי. אפשר להמשיך לעבוד במסכים אחרים בזמן הסריקה.</span>
      </div>
    </div>`;
}

function psDrawProgress() {
  const box = document.getElementById('psScanBox');
  if (!box || !_psScan) return;
  const s = _psScan, pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  box.innerHTML = `
    <div class="card card-pad ps-upload">
      <b>${s.running ? '⏳ סורק' : '✓ הסריקה הסתיימה'}: ${esc(s.fileName)}</b>
      <div class="ps-bar"><div style="width:${pct}%"></div></div>
      <div style="font-size:.9rem">${s.done} מתוך ${s.total} עמודים
        · <b>${s.stats.added}</b> מפרסמים חדשים
        · ${s.stats.merged} הופיעו כבר ברשימה
        · ${s.stats.winback} לקוחות עבר
        · ${s.stats.existing.length} כבר במערכת
        · ${s.stats.filtered} סוננו
        ${s.stats.failedPages.length ? `· <span style="color:var(--danger)">${s.stats.failedPages.length} עמודים נכשלו (${s.stats.failedPages.join(', ')})</span>` : ''}
      </div>
      ${s.running ? `<button class="btn btn-sm btn-danger-ghost" style="margin-top:8px" onclick="psCancel()">עצור סריקה</button>` : `
        ${s.stats.existing.length ? `<details style="margin-top:8px;font-size:.85rem"><summary>כבר במערכת (${s.stats.existing.length}) — לא נוספו</summary>
          <div class="muted" style="margin-top:6px">${s.stats.existing.map(x => esc(x)).join(' · ')}</div></details>` : ''}
        <div style="margin-top:10px"><button class="btn btn-sm btn-ghost" onclick="_psScan=null;psDrawScanBox()">סריקת קובץ נוסף</button></div>`}
    </div>`;
}

function psCancel() { if (_psScan) _psScan.cancel = true; }

let _psPdfJsPromise = null;
function psEnsurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (_psPdfJsPromise) return _psPdfJsPromise;
  _psPdfJsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/pdf.min.js';
    s.onload = () => { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js'; } catch (e) { } res(); };
    s.onerror = () => { _psPdfJsPromise = null; rej(new Error('pdfjs load')); };
    document.head.appendChild(s);
  });
  return _psPdfJsPromise;
}

async function psStartScan() {
  if (_psScan && _psScan.running) { toast('סריקה כבר רצה', true); return; }
  const file = document.getElementById('psFile').files[0];
  if (!file) { toast('בחר קובץ PDF', true); return; }
  const kind = document.getElementById('psKind').value;
  const pub = document.getElementById('psPub').value.trim();
  const date = document.getElementById('psDate').value || today();

  let doc;
  try {
    await psEnsurePdfJs();
    doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) { console.error(e); toast('לא הצלחתי לפתוח את קובץ ה-PDF', true); return; }

  _psScan = {
    running: true, cancel: false, fileName: file.name, total: doc.numPages, done: 0,
    kind, pub, date,
    stats: { added: 0, merged: 0, winback: 0, filtered: 0, existing: [], failedPages: [] },
    serial: Promise.resolve(),
  };
  psDrawProgress();

  try {
    await psLoadIndex();
    // כמה עמודים נשלחים לזיהוי במקביל. רק הקריאה ל-AI רצה במקביל —
    // השמירה וההשוואה מול לקוחות/לידים/מפרסמים עוברות בתור אחד (psSerial),
    // כדי שמפרסם שמופיע בשני עמודים לא ייכנס פעמיים.
    const PAR = Math.max(1, Math.min(8, Number(cache.settings && cache.settings.prospect_parallel) || 6));
    let next = 1;
    const worker = async () => {
      while (!_psScan.cancel && next <= doc.numPages) {
        const p = next++;
        try { await psScanPage(doc, p); }
        catch (e) { console.error('prospects page', p, e); _psScan.stats.failedPages.push(p); }
        _psScan.done++;
        psDrawProgress();
        psLiveRefresh();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAR, doc.numPages) }, worker));
    await _psScan.serial; // לסיים את השמירות שבתור
  } catch (e) {
    console.error(e); toast('שגיאה בסריקה: ' + (e.message || e), true);
  } finally {
    _psScan.running = false;
    psDrawProgress();
    if (currentPage === 'prospects') await psLoad();
    toast(_psScan.cancel ? 'הסריקה נעצרה' : `✓ הסריקה הסתיימה — ${_psScan.stats.added} מפרסמים חדשים`);
  }
}

/* אינדקס השוואה: לקוחות, לידים ומפרסמים קיימים — נטען פעם אחת לסריקה */
async function psLoadIndex() {
  const [custs, leads, pros] = await Promise.all([
    runAll((f, t) => db.from('customers').select('id,name,phone,crm_status').order('id').range(f, t)),
    runAll((f, t) => db.from('leads').select('id,name,phone,whatsapp,status').order('id').range(f, t)),
    runAll((f, t) => db.from('prospects').select('id,name,name_key,phone_key,size_rank,best_size,appearances,sources,image_path,status').order('id').range(f, t)),
  ]);
  const ix = { custPh: {}, custName: {}, leadPh: {}, leadName: {}, proPh: {}, proName: {}, lastAd: {} };
  custs.forEach(c => {
    const k = psPhKey(c.phone); if (psPhReal(k)) ix.custPh[k] = c;
    const n = psNameKey(c.name); if (n) ix.custName[n] = c;
  });
  leads.forEach(l => {
    [l.phone, l.whatsapp].forEach(p => { const k = psPhKey(p); if (psPhReal(k)) ix.leadPh[k] = l; });
    const n = psNameKey(l.name); if (n) ix.leadName[n] = l;
  });
  pros.forEach(p => psIndexPro(ix, p));
  _psScan.ix = ix;
}
function psIndexPro(ix, p) {
  if (psPhReal(p.phone_key)) ix.proPh[p.phone_key] = p;
  if (p.name_key) ix.proName[p.name_key] = p;
}

/* לקוח בעבר: crm_status=past, או שאין לו מודעה ב-180 הימים האחרונים */
async function psIsPastCustomer(c) {
  if (c.crm_status === 'past') return true;
  const ix = _psScan.ix;
  if (!(c.id in ix.lastAd)) {
    const { data } = await db.from('ads').select('created_at').eq('customer_id', c.id).order('created_at', { ascending: false }).limit(1);
    ix.lastAd[c.id] = data && data[0] ? data[0].created_at : null;
  }
  const last = ix.lastAd[c.id];
  if (!last) return false; // לקוח שעוד לא פרסם (למשל חדש) — לא "לקוח עבר"
  return (Date.now() - new Date(last).getTime()) > 180 * 864e5;
}

/* ---------- סריקת עמוד ---------- */
async function psScanPage(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  // קנבס חד לחיתוך (צד ארוך ~2200px) + עותק מוקטן ל-AI (צד ארוך 1568px — הגודל שהמודל קורא)
  const hiScale = 2200 / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale: hiScale });
  const hi = document.createElement('canvas');
  hi.width = Math.round(vp.width); hi.height = Math.round(vp.height);
  const hctx = hi.getContext('2d');
  hctx.fillStyle = '#fff'; hctx.fillRect(0, 0, hi.width, hi.height);
  await page.render({ canvasContext: hctx, viewport: vp }).promise;

  const k = 1568 / Math.max(hi.width, hi.height);
  const lo = document.createElement('canvas');
  lo.width = Math.round(hi.width * k); lo.height = Math.round(hi.height * k);
  lo.getContext('2d').drawImage(hi, 0, 0, lo.width, lo.height);
  const b64 = lo.toDataURL('image/jpeg', 0.85).split(',')[1];

  const ads = await psExtract(b64);
  lo.width = lo.height = 0; // שחרור זיכרון
  // ההחלטות והשמירות — בתור אחד; העלאת צילומי המודעות — אחר כך, במקביל
  const jobs = [];
  await psSerial(async () => {
    for (const ad of ads) {
      if (_psScan.cancel) break;
      try { await psHandleAd(ad, pageNum, jobs); }
      catch (e) { console.error('prospects ad', ad, e); }
    }
  });
  await Promise.all(jobs.map(async j => {
    try {
      const path = await psUploadCrop(hi, j.bbox);
      if (path) await db.from('prospects').update({ image_path: path }).eq('id', j.id);
    } catch (e) { console.error('prospect crop', e); }
  }));
  hi.width = hi.height = 0;
}

/* רענון הרשימה תוך כדי סריקה — לכל היותר פעם ב-8 שניות */
let _psLiveAt = 0;
function psLiveRefresh() {
  if (currentPage !== 'prospects' || Date.now() - _psLiveAt < 8000) return;
  _psLiveAt = Date.now();
  psLoad().catch(() => { });
}

/* תור יחיד לשמירות — עמודים שהסתיימו במקביל נשמרים אחד אחרי השני */
function psSerial(fn) {
  const p = _psScan.serial.then(fn, fn);
  _psScan.serial = p.catch(() => { });
  return p;
}

async function psExtract(b64) {
  const body = {
    image_b64: b64, media_type: 'image/jpeg',
    paper_name: (cache.settings && cache.settings.paper_name) || '@@PAPER_NAME@@',
    region: psRegion(),
    content_rules: (cache.settings && cache.settings.prospect_content_rules) || '',
  };
  let lastErr = 'הסריקה נעצרה';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (_psScan && _psScan.cancel) break;
    let { data, error } = await db.functions.invoke('extract-advertisers', { body });
    if (!error && data && data.ok) return data.ads || [];
    // בשגיאת HTTP ‏supabase-js מחזיר data=null — קוראים את גוף התשובה מ-error.context
    if (error && !data && error.context && typeof error.context.json === 'function') {
      try { data = await error.context.json(); } catch (e) { }
    }
    lastErr = (data && data.error) || (error && error.message) || 'שגיאה';
    if (data && /ANTHROPIC_API_KEY|אין הרשאה|לא מזוהה/.test(data.error || '')) break;
    // עומס / מגבלת קצב (429, 529) — מחכים יותר; שגיאה אחרת — המתנה קצרה
    const busy = /\((429|529|503)\)|overload|rate/i.test(lastErr + ' ' + ((data && data.detail) || ''));
    await new Promise(r => setTimeout(r, (busy ? 6000 : 1500) * (attempt + 1) + Math.random() * 1000));
  }
  throw new Error(lastErr);
}

function psCrop(hi, bbox) {
  return new Promise((res) => {
    if (!bbox) { res(null); return; }
    const pad = 0.008;
    const x0 = Math.max(0, bbox[0] - pad), y0 = Math.max(0, bbox[1] - pad);
    const x1 = Math.min(1, bbox[2] + pad), y1 = Math.min(1, bbox[3] + pad);
    const sx = Math.round(x0 * hi.width), sy = Math.round(y0 * hi.height);
    const sw = Math.max(1, Math.round((x1 - x0) * hi.width)), sh = Math.max(1, Math.round((y1 - y0) * hi.height));
    const k = Math.min(1, 1400 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    c.getContext('2d').drawImage(hi, sx, sy, sw, sh, 0, 0, c.width, c.height);
    c.toBlob(b => res(b), 'image/jpeg', 0.85);
  });
}
async function psUploadCrop(hi, bbox) {
  const blob = await psCrop(hi, bbox);
  if (!blob) return null;
  const path = `prospects/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await db.storage.from(PS_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) { console.error('prospect crop upload', error); return null; }
  return path;
}

async function psHandleAd(ad, pageNum, jobs) {
  const s = _psScan, ix = s.ix;
  if (ad.kind !== 'business') return; // כתבות, מודעות העיתון, הודעות רשמיות ופרטיות — לא מפרסמים

  const phKeys = [ad.phone, ad.phone2].map(psPhKey).filter(psPhReal);
  const nKey = psNameKey(ad.business_name);
  const sizeRank = (PS_SIZE[ad.size] || PS_SIZE.small)[1];
  const src = { kind: s.kind, pub: s.pub || null, date: s.date, page: pageNum, size: ad.size, file: s.fileName, at: today() };

  // 1. לקוח / ליד קיים
  const cust = phKeys.map(k => ix.custPh[k]).find(Boolean) || (nKey && ix.custName[nKey]);
  let winback = false, customerId = null;
  if (cust) {
    if (await psIsPastCustomer(cust)) { winback = true; customerId = cust.id; }
    else { psNoteExisting(ad.business_name + ' (לקוח)'); return; }
  } else {
    const lead = phKeys.map(k => ix.leadPh[k]).find(Boolean) || (nKey && ix.leadName[nKey]);
    if (lead) { psNoteExisting(ad.business_name + ' (ליד)'); return; }
  }

  // 2. כבר ברשימת המפרסמים → מצטבר
  const pro = phKeys.map(k => ix.proPh[k]).find(Boolean) || (nKey && ix.proName[nKey]);
  if (pro) {
    const upd = {
      appearances: (pro.appearances || 1) + 1,
      sources: [...(Array.isArray(pro.sources) ? pro.sources : []), src].slice(-50),
      updated_at: new Date().toISOString(),
    };
    if (sizeRank > (pro.size_rank || 0)) {
      upd.size_rank = sizeRank; upd.best_size = ad.size;
      if (ad.bbox) jobs.push({ id: pro.id, bbox: ad.bbox }); // צילום חדש — של המודעה הגדולה יותר
    }
    if (winback) { upd.winback = true; upd.customer_id = customerId; }
    await run(db.from('prospects').update(upd).eq('id', pro.id), 'שגיאה בעדכון מפרסם');
    Object.assign(pro, upd);
    s.stats.merged++;
    return;
  }

  // 3. מפרסם חדש
  let status = 'new', reason = null;
  if (ad.content_ok === false) { status = 'filtered'; reason = 'תוכן לא מתאים' + (ad.content_reason ? ': ' + ad.content_reason : ''); }
  else if (ad.region_fit === 'far' && !ad.is_online) { status = 'filtered'; reason = 'עסק מאזור רחוק' + (ad.location ? ' (' + ad.location + ')' : ''); }

  const rec = {
    name: ad.business_name, name_key: nKey || null,
    phone: ad.phone, phone_key: phKeys[0] || null, phone2: ad.phone2,
    email: ad.email, website: ad.website, field: ad.field,
    location: ad.location, service_area: ad.service_area,
    is_online: !!ad.is_online, region_fit: ad.region_fit,
    best_size: ad.size, size_rank: sizeRank, appearances: 1, sources: [src],
    image_path: null,
    summary: ad.summary, status, filter_reason: reason,
    winback, customer_id: customerId, created_by: profile.id,
  };
  const saved = await run(db.from('prospects').insert(rec).select('id,name,name_key,phone_key,size_rank,best_size,appearances,sources,image_path,status').single(), 'שגיאה בשמירת מפרסם');
  psIndexPro(ix, saved);
  if (ad.bbox) jobs.push({ id: saved.id, bbox: ad.bbox });
  if (status === 'filtered') s.stats.filtered++;
  else { s.stats.added++; if (winback) s.stats.winback++; }
}
function psNoteExisting(label) {
  const arr = _psScan.stats.existing;
  if (!arr.includes(label)) arr.push(label);
}

/* ---------- רשימה ---------- */
function psTabRows(tab) {
  const rows = _ps.rows;
  if (tab === 'new') return rows.filter(r => r.status === 'new' && !r.winback);
  if (tab === 'winback') return rows.filter(r => r.status === 'new' && r.winback);
  return rows.filter(r => r.status === tab);
}

async function psDrawList() {
  const box = document.getElementById('psList');
  if (!box) return;
  const counts = Object.fromEntries(PS_TABS.map(t => [t.id, psTabRows(t.id).length]));
  const q = psNameKey(_ps.q);
  let rows = psTabRows(_ps.tab);
  if (q) rows = rows.filter(r => psNameKey([r.name, r.field, r.location, r.phone].join(' ')).includes(q));
  rows.sort((a, b) => psScore(b) - psScore(a) || b.id - a.id);

  box.innerHTML = `
    <div class="tabs">${PS_TABS.map(t => `<button class="${_ps.tab === t.id ? 'active' : ''}" onclick="_ps.tab='${t.id}';psDrawList()">${t.t} (${counts[t.id]})</button>`).join('')}</div>
    <div style="margin-bottom:12px"><input id="psQ" placeholder="חיפוש לפי שם, תחום, יישוב או טלפון" value="${esc(_ps.q)}"
      oninput="_ps.q=this.value;clearTimeout(window._psQt);window._psQt=setTimeout(()=>{psDrawList();const i=document.getElementById('psQ');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length)}},250)" style="max-width:360px"></div>
    ${rows.length ? `<div class="ps-grid">${rows.map(psCardHtml).join('')}</div>` : `<div class="empty">${_ps.tab === 'new' && !_ps.rows.length ? 'עוד לא נסרקו קבצים. העלה PDF למעלה כדי להתחיל.' : 'אין מפרסמים בלשונית הזו'}</div>`}`;
  psLoadThumbs(rows);
}

function psCardHtml(r) {
  const size = (PS_SIZE[r.best_size] || ['—'])[0];
  const srcs = Array.isArray(r.sources) ? r.sources : [];
  const pubs = [...new Set(srcs.map(s => s.pub || PS_KIND[s.kind] || ''))].filter(Boolean);
  const actions = [];
  if (r.status === 'new' || r.status === 'filtered') {
    actions.push(`<button class="btn btn-sm btn-gold" onclick="psToLead(${r.id})">➜ העבר ללידים</button>`);
  }
  if (r.status === 'new') actions.push(`<button class="btn btn-sm btn-danger-ghost" onclick="psSetStatus(${r.id},'rejected')">✕ לא רלוונטי</button>`);
  if (r.status === 'filtered' || r.status === 'rejected') actions.push(`<button class="btn btn-sm btn-ghost" onclick="psSetStatus(${r.id},'new')">↩ החזר לרשימה</button>`);
  if (r.status === 'converted' && r.lead_id) actions.push(`<button class="btn btn-sm btn-ghost" onclick="psOpenLead(${r.lead_id})">פתח ליד</button>`);
  actions.push(`<button class="btn btn-sm btn-ghost" onclick="psEdit(${r.id})">✎</button>`);
  return `
    <div class="card ps-card">
      <div class="ps-thumb" ${r.image_path ? `onclick="psZoom(${r.id})"` : ''}>
        ${r.image_path ? `<img data-ps="${r.id}" alt="">` : '<span class="muted">אין צילום</span>'}
      </div>
      <div class="ps-body">
        <div class="ps-title">${esc(r.name)}
          ${r.winback ? '<span class="pill gold">לקוח עבר — להחזיר</span>' : ''}
          ${r.is_online ? '<span class="pill blue">אונליין</span>' : ''}
        </div>
        ${r.phone ? `<a href="tel:${esc(normPhone(r.phone))}" dir="ltr" class="ps-phone">${esc(r.phone)}</a>` : '<span class="muted">אין טלפון</span>'}
        ${r.phone2 ? ` · <span dir="ltr">${esc(r.phone2)}</span>` : ''}
        <div class="ps-meta">
          ${r.field ? `<span>🏷 ${esc(r.field)}</span>` : ''}
          ${r.location ? `<span>📍 ${esc(r.location)}</span>` : ''}
          ${r.region_fit ? `<span>${esc(PS_FIT[r.region_fit] || r.region_fit)}</span>` : ''}
          <span>📐 ${esc(size)}</span>
          <span>🔁 ${r.appearances || 1} הופעות</span>
        </div>
        ${pubs.length ? `<div class="ps-meta muted">מקור: ${pubs.map(esc).join(', ')}${srcs.length ? ' · ' + heDate(srcs[srcs.length - 1].date) : ''}</div>` : ''}
        ${r.summary ? `<div class="ps-sum">${esc(r.summary)}</div>` : ''}
        ${r.website || r.email ? `<div class="ps-meta" dir="ltr" style="justify-content:flex-end">${[r.website, r.email].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${r.status === 'filtered' && r.filter_reason ? `<div class="ps-reason">סונן: ${esc(r.filter_reason)}</div>` : ''}
        <div class="ps-actions">${actions.join('')}</div>
      </div>
    </div>`;
}

async function psSignedUrl(path) {
  if (!path) return '';
  if (_ps.urls[path]) return _ps.urls[path];
  const { data } = await db.storage.from(PS_BUCKET).createSignedUrl(path, 3600);
  return (_ps.urls[path] = data ? data.signedUrl : '');
}
async function psLoadThumbs(rows) {
  const need = rows.filter(r => r.image_path && !_ps.urls[r.image_path]).map(r => r.image_path);
  for (let i = 0; i < need.length; i += 100) {
    try {
      const { data } = await db.storage.from(PS_BUCKET).createSignedUrls(need.slice(i, i + 100), 3600);
      (data || []).forEach(d => { if (d.signedUrl && d.path) _ps.urls[d.path] = d.signedUrl; });
    } catch (e) { console.error('prospect thumbs', e); }
  }
  rows.forEach(r => {
    const img = document.querySelector(`img[data-ps="${r.id}"]`);
    if (img && _ps.urls[r.image_path]) img.src = _ps.urls[r.image_path];
  });
}

async function psZoom(id) {
  const r = _ps.rows.find(x => x.id === id); if (!r) return;
  const url = await psSignedUrl(r.image_path);
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `<h3>${esc(r.name)}</h3>
    <div style="text-align:center"><img src="${esc(url)}" style="max-width:100%;max-height:75vh;border:1px solid var(--line);border-radius:8px"></div>
    <div class="m-actions"><button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button></div>`;
  document.getElementById('viewBack').classList.add('open');
}

async function psSetStatus(id, status) {
  await run(db.from('prospects').update({ status, updated_at: new Date().toISOString() }).eq('id', id));
  const r = _ps.rows.find(x => x.id === id); if (r) r.status = status;
  psDrawList();
}

function psEdit(id) {
  const r = _ps.rows.find(x => x.id === id); if (!r) return;
  openForm('עריכת מפרסם — ' + r.name, [
    { name: 'name', label: 'שם העסק', required: true },
    { name: 'phone', label: 'טלפון', dir: 'ltr', half: true },
    { name: 'phone2', label: 'טלפון נוסף', dir: 'ltr', half: true },
    { name: 'email', label: 'אימייל', dir: 'ltr', half: true },
    { name: 'website', label: 'אתר', dir: 'ltr', half: true },
    { name: 'field', label: 'תחום', half: true },
    { name: 'location', label: 'יישוב / כתובת', half: true },
    { name: 'summary', label: 'תיאור המודעה', type: 'textarea', rows: 2 },
  ], r, async (rec) => {
    rec.name_key = psNameKey(rec.name) || null;
    rec.phone_key = psPhKey(rec.phone) || null;
    rec.updated_at = new Date().toISOString();
    await run(db.from('prospects').update(rec).eq('id', id));
    Object.assign(r, rec);
    psDrawList();
  });
}

/* ---------- העברה ללידים ---------- */
function psToLead(id) {
  const r = _ps.rows.find(x => x.id === id); if (!r) return;
  const srcs = Array.isArray(r.sources) ? r.sources : [];
  const last = srcs[srcs.length - 1] || {};
  const competitor = [...new Set(srcs.filter(s => s.kind !== 'own').map(s => s.pub).filter(Boolean))].join(', ');
  const srcDetail = 'חילוץ מ-PDF: ' + [...new Set(srcs.map(s => (s.pub || PS_KIND[s.kind] || '') + (s.date ? ' ' + heDate(s.date) : '')).filter(Boolean))].slice(-3).join(' · ');
  const notes = [
    r.summary,
    r.winback ? 'לקוח עבר — להחזיר' : '',
    r.best_size ? 'פרסם ' + (PS_SIZE[r.best_size] || [r.best_size])[0] + ' · ' + (r.appearances || 1) + ' הופעות' : '',
    r.website ? 'אתר: ' + r.website : '',
    r.phone2 ? 'טלפון נוסף: ' + r.phone2 : '',
  ].filter(Boolean).join('\n');
  openForm('העברה ללידים — ' + r.name, [
    { name: 'name', label: 'שם', required: true },
    { name: 'phone', label: 'טלפון', dir: 'ltr', half: true },
    { name: 'email', label: 'אימייל', dir: 'ltr', half: true },
    { name: 'city', label: 'יישוב', half: true },
    { name: 'field', label: 'תחום העסק', half: true },
    { name: 'competitor', label: 'מפרסם היום אצל' },
    { name: 'agent_id', label: 'סוכן מטפל (ריק = מאגר ללא שיוך)', type: 'select', options: 'agents' },
    { name: 'notes', label: 'הערות', type: 'textarea', rows: 4 },
  ], { name: r.name, phone: r.phone, email: r.email, city: r.location, field: r.field, competitor, notes }, async (rec) => {
    // בדיקת כפילות אחרונה מול המסד
    const k = psPhKey(rec.phone);
    if (psPhReal(k)) {
      const [{ data: l }, { data: c }] = await Promise.all([
        db.from('leads').select('id,name,phone').ilike('phone', '%' + k.slice(-7) + '%').limit(20),
        db.from('customers').select('id,name,phone').ilike('phone', '%' + k.slice(-7) + '%').limit(20),
      ]);
      const hitL = (l || []).find(x => psPhKey(x.phone) === k);
      const hitC = (c || []).find(x => psPhKey(x.phone) === k);
      if (hitL && !confirm(`הטלפון כבר קיים אצל הליד "${hitL.name}". להוסיף ליד נוסף בכל זאת?`)) throw new Error('dup');
      if (hitC && !r.winback && !confirm(`הטלפון כבר קיים אצל הלקוח "${hitC.name}". להוסיף ליד בכל זאת?`)) throw new Error('dup');
    }
    const lead = await run(db.from('leads').insert({
      ...rec, source: 'חילוץ מ-PDF', source_detail: srcDetail, created_by: profile.id,
    }).select('id').single(), 'שגיאה ביצירת הליד');
    try { await addInteraction('lead', lead.id, 'הליד נוצר מסריקת PDF' + (last.pub ? ' (' + last.pub + ')' : '')); } catch (e) { }
    await run(db.from('prospects').update({ status: 'converted', lead_id: lead.id, updated_at: new Date().toISOString() }).eq('id', id));
    r.status = 'converted'; r.lead_id = lead.id;
    toast('✓ נוסף ליד — ' + rec.name);
    psDrawList();
  });
}

async function psOpenLead(leadId) {
  await openPage('leads');
  if (typeof openLeadCard === 'function') openLeadCard(leadId);
}

/* ---------- הגדרות סינון ---------- */
function psSettings() {
  const s = cache.settings || {};
  openForm('הגדרות סינון מפרסמים', [
    { type: 'html', html: '<div class="muted" style="font-size:.85rem">הבינה המלאכותית משתמשת בהגדרות האלה כדי להחליט מי רלוונטי. שינוי חל על סריקות חדשות.</div>' },
    { name: 'prospect_region', label: 'האזור שהעיתון משרת (יישובים / אזור)', type: 'textarea', rows: 2 },
    { name: 'prospect_content_rules', label: 'אילו מודעות לא מתאימות לאופי העיתון', type: 'textarea', rows: 3 },
  ], {
    prospect_region: s.prospect_region || s.paper_city || '',
    prospect_content_rules: s.prospect_content_rules || 'העיתון קהילתי-משפחתי ושמרני: מודעה שאינה צנועה, או שתוכנה לא הולם קהל משפחתי ושמרני, אינה מתאימה.',
  }, async (rec) => {
    for (const key of ['prospect_region', 'prospect_content_rules']) {
      await run(db.from('settings').upsert({ key, value: rec[key] || '' }));
      cache.settings[key] = rec[key] || '';
    }
    toast('✓ ההגדרות נשמרו');
  });
}

/* ---------- צילום המודעה בכרטיס הליד (עטיפה, בלי לגעת ב-leads.js) ---------- */
(function () {
  if (typeof openLeadCard !== 'function' || window._psLeadWrapped) return;
  window._psLeadWrapped = true;
  const orig = openLeadCard;
  openLeadCard = async function (id) {
    const res = await orig.apply(this, arguments);
    try {
      if (profile.role !== 'admin') return res;
      const { data } = await db.from('prospects').select('image_path,sources').eq('lead_id', id).not('image_path', 'is', null).limit(1);
      const p = data && data[0];
      if (!p) return res;
      const { data: su } = await db.storage.from(PS_BUCKET).createSignedUrl(p.image_path, 3600);
      const modal = document.getElementById('viewModal');
      if (!su || !modal || !document.getElementById('viewBack').classList.contains('open')) return res;
      const hr = modal.querySelector('hr');
      const div = document.createElement('div');
      div.style.marginTop = '14px';
      div.innerHTML = `<label style="display:block;font-size:.85rem;color:var(--muted)">צילום המודעה שנמצאה</label>
        <a href="${esc(su.signedUrl)}" target="_blank"><img src="${esc(su.signedUrl)}" style="max-width:100%;max-height:260px;border:1px solid var(--line);border-radius:8px"></a>`;
      if (hr) hr.parentNode.insertBefore(div, hr); else modal.appendChild(div);
    } catch (e) { /* תוספת בלבד — לא שוברת את הכרטיס */ }
    return res;
  };
})();

/* ---------- עיצוב ---------- */
function psEnsureStyles() {
  if (document.getElementById('psStyles')) return;
  const s = document.createElement('style');
  s.id = 'psStyles';
  s.textContent = `
  .ps-upload{margin-bottom:18px}
  .ps-upl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 14px;margin-top:10px}
  .ps-bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden;margin:10px 0}
  .ps-bar>div{height:100%;background:@@COLOR_BRAND@@;transition:width .3s}
  .ps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
  .ps-grid .card+.card{margin-top:0}
  .ps-card{display:flex;flex-direction:column}
  .ps-thumb{height:170px;background:#f4f5f8;display:flex;align-items:center;justify-content:center;cursor:zoom-in;border-bottom:1px solid var(--line)}
  .ps-thumb img{max-width:100%;max-height:100%;object-fit:contain}
  .ps-body{padding:12px 14px;display:flex;flex-direction:column;gap:5px;flex:1}
  .ps-title{font-weight:700;font-size:1.02rem;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .ps-phone{font-weight:600}
  .ps-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:.82rem}
  .ps-sum{font-size:.85rem}
  .ps-reason{font-size:.8rem;color:var(--warn)}
  .ps-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:8px}`;
  document.head.appendChild(s);
}

/* ---------- רישום בתפריט (מנהל בלבד, אחרי "ייבוא לידים"/"לידים") ---------- */
(function () {
  if (typeof NAV !== 'undefined' && !NAV.some(n => n.id === 'prospects')) {
    const item = { id: 'prospects', title: 'מפרסמים פוטנציאליים', icon: '🔎', roles: ['admin'], group: 'מכירות' };
    let idx = NAV.findIndex(n => n.id === 'lead-import');
    if (idx < 0) idx = NAV.findIndex(n => n.id === 'leads');
    if (idx >= 0) NAV.splice(idx + 1, 0, item); else NAV.push(item);
  }
})();
