/* ============================================================
article-layout.js — קבצי כתבה ושליחה לגרפיקאית לעימוד
------------------------------------------------------------
- עורך/מנהל: מתוך "תוכן וכתבות" → 📎 קבצים: העלאת כמה קבצים לכתבה,
  הנחיה לגרפיקאית ו"שלח לגרפיקאית" (+ הודעה בצ'אט הצוות).
- גרפיקה: דף "כתבות לעימוד" — הכתבות שנשלחו, הורדת קבצים,
  סימון "בעימוד" / "עומד" (דרך RPC graphics_articles / graphics_article_set_layout).
- כתבה שבועית קבועה: "שכפל לגיליון הבא" (בלי הקבצים).
טבלאות: article_files + עמודות layout_* ב-articles
(מיגרציה 2026-11-25_article_files_layout.sql).
============================================================ */

'use strict';

const LAYOUT_STATUS = { sent: ['נשלח לגרפיקה', 'amber'], in_layout: ['בעימוד', 'blue'], done: ['עומד', 'green'] };

function layoutPill(s) {
  const t = LAYOUT_STATUS[s];
  return t ? `<span class="pill ${t[1]}">${t[0]}</span>` : '<span class="muted">—</span>';
}

function _alClose() { document.getElementById('viewBack').classList.remove('open'); }

/* --- עורך: חלון קבצים ושליחה לגרפיקה --- */
async function articleFiles(id) {
  const a = (_articles || []).find(x => x.id === id) || (await run(db.from('articles').select('*').eq('id', id)))[0];
  if (!a) return;
  const files = await run(db.from('article_files').select('*').eq('article_id', id).order('id'));
  const sent = !!a.layout_status;
  document.getElementById('viewModal').innerHTML = `
<h3>📎 קבצי הכתבה — ${esc(a.title)}</h3>
<p class="muted" style="margin-top:-6px">${a.issue_id ? esc(nameOf('issues', a.issue_id, 'issue')) + ' · ' : ''}עימוד: ${layoutPill(a.layout_status)}</p>
<div id="alFiles">${files.length ? `<table class="data"><tbody>${files.map(f => `<tr>
<td><a href="#" onclick="event.preventDefault();adFileOpen('${esc(f.storage_path)}')">📄 ${esc(f.file_name || 'קובץ')}</a></td>
<td style="width:1%"><button class="btn btn-sm btn-ghost" title="הסרה" onclick="articleFileDelete(${f.id},${id})">🗑</button></td>
</tr>`).join('')}</tbody></table>` : '<p class="muted">אין עדיין קבצים</p>'}</div>
<div style="margin:10px 0">
<input type="file" id="alFileInput" multiple style="display:none" onchange="articleFilesUpload(${id}, this.files)">
<button class="btn btn-sm" onclick="document.getElementById('alFileInput').click()">+ העלאת קבצים (אפשר כמה ביחד)</button>
</div>
<label style="display:block;font-size:.85rem;margin-top:8px">🎨 הנחיה לגרפיקאית (לא חובה)</label>
<textarea id="alNote" rows="2" style="width:100%">${esc(a.layout_note || '')}</textarea>
<div class="m-actions">
<button class="btn" style="background:var(--ok)" onclick="articleSendToLayout(${id})">${sent ? '↻ שלח שוב לגרפיקאית' : '✉️ שלח לגרפיקאית'}</button>
<button class="btn btn-sm btn-ghost" onclick="articleCloneNext(${id})">⧉ שכפל לגיליון הבא</button>
<button class="btn btn-sm btn-ghost" style="margin-right:auto" onclick="_alClose()">סגירה</button>
</div>`;
  document.getElementById('viewBack').classList.add('open');
}

async function articleFilesUpload(id, fileList) {
  const list = Array.from(fileList || []);
  if (!list.length) return;
  toast(`מעלה ${list.length} קבצים...`);
  let ok = 0;
  for (const file of list) {
    const path = `articles/${id}/${Date.now()}_${safeKey(file.name)}`;
    const { error } = await db.storage.from('ad-files').upload(path, file);
    if (error) { toast('שגיאה בהעלאת ' + file.name + ': ' + error.message, true); continue; }
    await run(db.from('article_files').insert({ article_id: id, storage_path: path, file_name: file.name }), 'שמירת קובץ');
    ok++;
  }
  if (ok) toast(`✓ הועלו ${ok} קבצים`);
  articleFiles(id);
}

async function articleFileDelete(fileId, articleId) {
  if (!confirm('להסיר את הקובץ מהכתבה?')) return;
  const f = (await run(db.from('article_files').select('storage_path').eq('id', fileId)))[0];
  await run(db.from('article_files').delete().eq('id', fileId), 'הסרת קובץ');
  // מחיקה מה-storage מותרת רק למנהל/מכירות — לעורך נשאר האובייקט (לא חוסם)
  if (f && profile.role === 'admin') await db.storage.from('ad-files').remove([f.storage_path]);
  articleFiles(articleId);
}

async function articleSendToLayout(id) {
  const a = (_articles || []).find(x => x.id === id);
  const note = (document.getElementById('alNote')?.value || '').trim();
  const files = await run(db.from('article_files').select('id').eq('article_id', id));
  if (!files.length && !confirm('אין קבצים בכתבה. לשלוח בכל זאת?')) return;
  await run(db.from('articles').update({ layout_status: 'sent', layout_note: note || null, layout_sent_at: new Date().toISOString() }).eq('id', id), 'שליחה לגרפיקה');
  if (a) Object.assign(a, { layout_status: 'sent', layout_note: note || null });
  // הודעה בקבוצת הצוות — הגרפיקאית רואה אותה (לא חוסם אם נכשל)
  try {
    const iss = a && a.issue_id ? ' · ' + nameOf('issues', a.issue_id, 'issue') : '';
    await db.from('team_messages').insert({ channel: 'group', sender_user: profile.id,
      body: `📰 כתבה לעימוד: ${a ? a.title : '#' + id}${iss} (${files.length} קבצים)${note ? '\n🎨 ' + note : ''}\nבדף "כתבות לעימוד"` });
  } catch (e) { /* לא קריטי */ }
  toast('✓ נשלח לגרפיקאית');
  _alClose();
  if (currentPage === 'articles') articlesDraw();
}

/* כתבה שבועית: עותק לגיליון הבא — אותם כותרת/כותב/מדור/אורך, בלי קבצים ובלי סטטוס עימוד */
async function articleCloneNext(id) {
  const a = (_articles || []).find(x => x.id === id);
  if (!a) return;
  // הגיליון שאחרי גיליון הכתבה (לפי מספר); כתבה בלי גיליון → הגיליון הקרוב
  const cur = (cache.issues || []).find(i => i.id === a.issue_id);
  const target = cur
    ? (cache.issues || []).filter(i => Number(i.issue_number) > Number(cur.issue_number))
        .sort((x, y) => Number(x.issue_number) - Number(y.issue_number))[0]
    : (cache.issues || []).find(i => i.id === nextIssueId());
  if (!confirm(`לשכפל את "${a.title}" ל${target ? 'גיליון ' + target.issue_number : 'גיליון הבא'}?`)) return;
  const rec = { title: a.title, author_profile_id: a.author_profile_id, author_name: a.author_name,
    section_id: a.section_id, est_length: a.est_length, issue_id: target ? target.id : null,
    status: 'writing', editor_notes: a.editor_notes };
  await run(db.from('articles').insert(rec), 'שכפול כתבה');
  toast('✓ שוכפל — עכשיו מעלים את הקבצים של השבוע');
  _alClose();
  openPage('articles');
}

/* --- גרפיקה: דף "כתבות לעימוד" --- */
let _layoutRows = [];

Pages.layout = {
  render: async (el) => {
    const showDone = !!document.getElementById('alShowDone')?.checked;
    const { data, error } = await db.rpc('graphics_articles', { p_include_done: showDone });
    if (error) { el.innerHTML = `<div class="card">שגיאה בטעינה: ${esc(error.message)}<br><span class="muted">ייתכן שהמיגרציה 2026-11-25_article_files_layout.sql טרם הורצה</span></div>`; return; }
    _layoutRows = data || [];
    el.innerHTML = `
<div class="page-head"><h2>כתבות לעימוד <span class="muted">(${_layoutRows.length})</span></h2>
<label style="font-size:.85rem"><input type="checkbox" id="alShowDone" ${showDone ? 'checked' : ''} onchange="openPage('layout')"> הצג גם שעומדו</label></div>
<div class="card" id="alTable"></div>`;
    renderTable(document.getElementById('alTable'), _layoutRows, [
      { h: 'כתבה', f: r => `<b>${esc(r.title)}</b>${r.author ? `<br><span class="muted" style="font-size:.8rem">${esc(r.author)}</span>` : ''}` },
      { h: 'מדור', f: r => esc(r.section_name) || '—' },
      { h: 'גיליון', f: r => r.issue_number ? 'גיליון ' + esc(r.issue_number) : '<span class="muted">—</span>' },
      { h: 'נשלח', f: r => r.layout_sent_at ? heDateTime(r.layout_sent_at) : '—' },
      { h: 'קבצים', f: r => (r.files || []).length
          ? (r.files || []).map(f => `<a href="#" style="display:block" onclick="event.preventDefault();event.stopPropagation();adFileOpen('${esc(f.path)}')">📄 ${esc(f.name || 'קובץ')}</a>`).join('')
          : '<span class="muted">אין</span>' },
      { h: 'הנחיה', f: r => esc(r.layout_note) || '—' },
      { h: 'סטטוס', f: r => layoutPill(r.layout_status) },
      { h: '', f: r => (r.layout_status === 'sent' ? `<button class="btn btn-sm" onclick="event.stopPropagation();layoutSet(${r.id},'in_layout')">▶ בעימוד</button> ` : '') +
          (r.layout_status !== 'done' ? `<button class="btn btn-sm" style="background:var(--ok)" onclick="event.stopPropagation();layoutSet(${r.id},'done')">✓ עומד</button>` : '') },
    ], { empty: 'אין כתבות שממתינות לעימוד 👍' });
  }
};

async function layoutSet(id, status) {
  const { error } = await db.rpc('graphics_article_set_layout', { p_id: id, p_status: status });
  if (error) { toast('שגיאה: ' + error.message, true); return; }
  toast(status === 'done' ? '✓ סומן כעומד' : 'סומן בעימוד');
  openPage('layout');
}
