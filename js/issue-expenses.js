/* ============================================================
   issue-expenses.js — ניהול הוצאות לפי גיליון (עלויות הגיליון)
   ------------------------------------------------------------
   - קטגוריות קבועות לכל גיליון (דפוס, הפצה, שכר...) — הזנת נטו
   - המערכת מחשבת מע"מ (18% כברירת מחדל, ניתן לשנות ב-settings.vat_rate)
     נטו → מע"מ → ברוטו. הברוטו נשמר ב-expenses.amount (מתחבר לתזרים).
   - רווח נקי לגיליון = הכנסות מודעות (נטו) − הוצאות (נטו)
   - ללא סכימה חדשה: תיוג ב-notes  #issue:<id>;#cat:<שם>;#net:<נטו>;
   ============================================================ */

'use strict';

const ICO_DEFAULT_CATS = ['דפוס', 'הפצה', 'שכר כתבים', 'גרפיקה', 'צילום', 'אחר'];
function icoRate() { const r = Number((cache.settings || {}).vat_rate); return isFinite(r) && r > 0 ? r : 18; }
function icoCats() { try { const a = JSON.parse((cache.settings || {}).issue_cost_categories || 'null'); return Array.isArray(a) && a.length ? a : ICO_DEFAULT_CATS; } catch (e) { return ICO_DEFAULT_CATS; } }
function icoPrintTable() { try { const t = JSON.parse((cache.settings || {}).print_price_table || 'null'); if (t && typeof t === 'object') return t; } catch (e) {} return { 32: 2600, 40: 3580, 48: 4100, 56: 4695 }; }
function icoDistrib() { const v = Number((cache.settings || {}).distribution_cost); return isFinite(v) && v > 0 ? v : 500; }
function _icoTag(id) { return '#issue:' + id + ';'; }
function _icoNet(notes) { const m = String(notes || '').match(/#net:([0-9.]+)/); return m ? Number(m[1]) : null; }
function _icoCat(notes) { const m = String(notes || '').match(/#cat:([^;]+);/); return m ? m[1] : ''; }
function _icoNum(v) { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }

let _icoState = null;

async function openIssueCosts(issueId) {
  if (!['admin', 'sales'].includes(profile.role)) { toast('אין הרשאה', true); return; }
  let issue = (cache.issues || []).find(i => i.id === issueId);
  if (!issue || issue.pages_count == null) issue = await run(db.from('issues').select('*').eq('id', issueId).single());

  const [rows, ads] = await Promise.all([
    run(db.from('expenses').select('*').ilike('notes', '%' + _icoTag(issueId) + '%')),
    run(db.from('ads').select('price,discount,status').eq('issue_id', issueId)),
  ]);
  const revenue = ads.filter(a => !['cancelled', 'rejected'].includes(a.status))
    .reduce((s, a) => s + Math.max(0, (Number(a.price) || 0) - (Number(a.discount) || 0)), 0);

  const byCat = {};
  rows.forEach(r => { const c = _icoCat(r.notes); if (c) byCat[c] = { id: r.id, net: _icoNet(r.notes) != null ? _icoNet(r.notes) : Number(r.amount || 0) }; });

  const _pt = icoPrintTable();
  const _printNet = _pt[issue.pages_count] != null ? _pt[issue.pages_count] : (_pt[String(issue.pages_count)] != null ? _pt[String(issue.pages_count)] : null);
  const defaults = { 'דפוס': _printNet, 'הפצה': icoDistrib() };
  _icoState = { issueId, issue, revenue, byCat, rate: icoRate(), cats: icoCats(), defaults, printMissing: (defaults['דפוס'] == null) };

  const dateStr = issue.print_date || issue.publish_date;
  const modal = document.getElementById('viewModal');
  modal.innerHTML = `
    <h3>💸 עלויות הגיליון — גיליון ${issue.issue_number}
      <span class="muted" style="font-size:.8rem">${dateStr ? heDate(dateStr) : ''}</span></h3>
    <p class="muted" style="font-size:.82rem;margin-top:-8px">מזינים סכום <b>נטו</b> (לפני מע"מ) — המערכת מחשבת מע"מ ${_icoState.rate}% והברוטו לתזרים.
      דפוס והפצה מולאו אוטומטית לפי מספר העמודים${_icoState.printMissing ? ' <b style="color:#b91c1c">· אין מחיר דפוס לספירת עמודים ' + (issue.pages_count || '?') + ' — הזן ידנית</b>' : ''}.</p>

    <div class="table-wrap"><table class="data" id="icoTable">
      <thead><tr><th>קטגוריה</th><th>נטו (₪)</th><th>מע"מ ${_icoState.rate}%</th><th>ברוטו</th></tr></thead>
      <tbody>
        ${_icoState.cats.map((c, i) => {
          const net = _icoState.byCat[c] ? _icoState.byCat[c].net : (_icoState.defaults[c] != null ? _icoState.defaults[c] : '');
          return `<tr>
            <td>${esc(c)}</td>
            <td><input type="number" min="0" step="0.01" id="icoNet${i}" value="${net}" oninput="icoRecalc()" style="width:110px;text-align:left" placeholder="0"></td>
            <td id="icoVat${i}" style="color:var(--muted)">—</td>
            <td id="icoGross${i}" style="font-weight:600">—</td>
          </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid var(--line)">
          <td><b>סה"כ</b></td>
          <td><b id="icoNetTot">₪0</b></td>
          <td><b id="icoVatTot" style="color:var(--brand)">₪0</b></td>
          <td><b id="icoGrossTot">₪0</b></td>
        </tr>
      </tfoot>
    </table></div>

    <div class="stats" style="margin-top:14px">
      ${stat(money(revenue) || '₪0', 'הכנסות מודעות (נטו)')}
      <div class="stat"><div class="num" id="icoExpNum">₪0</div><div class="lbl">הוצאות הגיליון (נטו)</div></div>
      <div class="stat gold"><div class="num" id="icoProfitNum">—</div><div class="lbl">רווח נקי לגיליון</div></div>
      <div class="stat"><div class="num" id="icoVatNum">₪0</div><div class="lbl">מע"מ תשומות (לקיזוז)</div></div>
    </div>

    <div class="m-actions" style="margin-top:16px">
      <button class="btn" onclick="icoSave()">💾 שמירה</button>
      <button class="btn btn-ghost" style="margin-right:auto" onclick="document.getElementById('viewBack').classList.remove('open')">סגירה</button>
    </div>`;
  document.getElementById('viewBack').classList.add('open');
  icoRecalc();
}

function icoRecalc() {
  if (!_icoState) return;
  const rate = _icoState.rate;
  let netTot = 0, vatTot = 0, grossTot = 0;
  _icoState.cats.forEach((c, i) => {
    const net = _icoNum(document.getElementById('icoNet' + i).value);
    const vat = Math.round(net * rate) / 100; // net*rate/100 rounded to agorot
    const gross = Math.round((net + vat) * 100) / 100;
    document.getElementById('icoVat' + i).textContent = net ? money(vat) : '—';
    document.getElementById('icoGross' + i).textContent = net ? money(gross) : '—';
    netTot += net; vatTot += vat; grossTot += gross;
  });
  document.getElementById('icoNetTot').textContent = money(netTot) || '₪0';
  document.getElementById('icoVatTot').textContent = money(vatTot) || '₪0';
  document.getElementById('icoGrossTot').textContent = money(grossTot) || '₪0';
  document.getElementById('icoExpNum').textContent = money(netTot) || '₪0';
  document.getElementById('icoVatNum').textContent = money(vatTot) || '₪0';
  const profit = _icoState.revenue - netTot;
  const pn = document.getElementById('icoProfitNum');
  pn.textContent = money(profit);
  pn.parentElement.classList.toggle('red', profit < 0);
  pn.parentElement.classList.toggle('gold', profit >= 0);
}

async function icoSave() {
  if (!_icoState) return;
  const { issueId, issue, cats, byCat, rate } = _icoState;
  const dateStr = (issue.print_date || issue.publish_date || today()).slice(0, 10);
  let saved = 0, removed = 0;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const net = _icoNum(document.getElementById('icoNet' + i).value);
    const existing = byCat[c];
    if (net > 0) {
      const vat = Math.round(net * rate) / 100;
      const gross = Math.round((net + vat) * 100) / 100;
      const payload = {
        expense_date: dateStr,
        supplier: 'גיליון ' + issue.issue_number + ' · ' + c,
        amount: gross,
        status: 'expected',
        notes: _icoTag(issueId) + '#cat:' + c + ';#net:' + net + ';',
      };
      if (existing) await run(db.from('expenses').update(payload).eq('id', existing.id));
      else await run(db.from('expenses').insert(payload));
      saved++;
    } else if (existing) {
      await run(db.from('expenses').delete().eq('id', existing.id));
      removed++;
    }
  }
  toast('נשמר ✓ ' + (saved ? saved + ' קטגוריות' : '') + (removed ? ' · הוסרו ' + removed : ''));
  document.getElementById('viewBack').classList.remove('open');
}

/* החלת עלויות (דפוס+הפצה) על כל הגיליונות שעדיין לא נסגרו — בלי לדרוס קיים */
async function icoApplyAll() {
  if (!['admin', 'sales'].includes(profile.role)) { toast('אין הרשאה', true); return; }
  if (!confirm('למלא עלויות דפוס + הפצה לכל הגיליונות שחסרות בהם?\nכולל גיליונות שפורסמו · לא דורס עלויות שכבר הוזנו.')) return;
  const issues = await run(db.from('issues').select('id,issue_number,pages_count,print_date,publish_date,status'));
  const existing = await run(db.from('expenses').select('notes').ilike('notes', '%#issue:%'));
  const has = {};
  existing.forEach(e => { const mi = String(e.notes || '').match(/#issue:(\d+);/); const mc = String(e.notes || '').match(/#cat:([^;]+);/); if (mi && mc) has[mi[1] + '|' + mc[1]] = true; });
  const pt = icoPrintTable(), dist = icoDistrib(), rate = icoRate();
  let created = 0, noPrice = 0;
  for (const iss of issues) {
    const date = (iss.print_date || iss.publish_date || today()).slice(0, 10);
    const printNet = pt[iss.pages_count] != null ? pt[iss.pages_count] : (pt[String(iss.pages_count)] != null ? pt[String(iss.pages_count)] : null);
    const rows = [];
    if (printNet != null) { if (!has[iss.id + '|דפוס']) rows.push(['דפוס', printNet]); } else noPrice++;
    if (!has[iss.id + '|הפצה']) rows.push(['הפצה', dist]);
    for (const [cat, net] of rows) {
      const vat = Math.round(net * rate) / 100, gross = Math.round((net + vat) * 100) / 100;
      await run(db.from('expenses').insert({ expense_date: date, supplier: 'גיליון ' + iss.issue_number + ' · ' + cat, amount: gross, status: 'expected', notes: _icoTag(iss.id) + '#cat:' + cat + ';#net:' + net + ';' }));
      created++;
    }
  }
  toast('נוצרו ' + created + ' שורות עלות' + (noPrice ? ' · ' + noPrice + ' גיליונות בלי מחיר דפוס לספירת העמודים' : ''));
  if (typeof openPage === 'function') openPage('issues');
}
