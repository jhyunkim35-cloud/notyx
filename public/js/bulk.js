// Bulk select/delete/export: toggle bulk mode, select-all, PDF export, delete selected.
// Depends on: constants.js (_bulkSelectMode, _selectedNoteIds, currentNoteId), firestore_sync.js (deleteNoteFS, getNoteFS), ui.js (showToast), markdown.js (renderMarkdown, escHtml), home_view.js (renderHomeView).

/* ═══════════════════════════════════════════════
   Bulk Delete
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

function toggleBulkSelectMode() {
  _bulkSelectMode = !_bulkSelectMode;
  _selectedNoteIds.clear();
  const grid = document.getElementById('allNotesGrid');
  const btn  = document.getElementById('bulkSelectToggleBtn');
  const bar  = document.getElementById('bulkDeleteBar');
  if (grid)  grid.classList.toggle('bulk-select-mode', _bulkSelectMode);
  if (btn)   btn.classList.toggle('active', _bulkSelectMode);
  if (bar)   bar.classList.toggle('visible', _bulkSelectMode);
  // reset checkboxes
  grid && grid.querySelectorAll('.note-card-checkbox').forEach(cb => { cb.checked = false; });
  grid && grid.querySelectorAll('.note-card').forEach(c => c.classList.remove('bulk-selected'));
  const allChk = document.getElementById('bulkSelectAllChk');
  if (allChk) allChk.checked = false;
  _updateBulkBar();
}

function _updateBulkBar() {
  const count = document.getElementById('bulkSelectCount');
  const allChk = document.getElementById('bulkSelectAllChk');
  if (count) count.textContent = `${_selectedNoteIds.size}개 선택됨`;
  if (allChk) {
    const grid = document.getElementById('allNotesGrid');
    const total = grid ? grid.querySelectorAll('.note-card[data-note-id]').length : 0;
    allChk.checked = total > 0 && _selectedNoteIds.size === total;
    allChk.indeterminate = _selectedNoteIds.size > 0 && _selectedNoteIds.size < total;
  }
}

function toggleBulkSelectAll(checked) {
  const grid = document.getElementById('allNotesGrid');
  if (!grid) return;
  grid.querySelectorAll('.note-card[data-note-id]').forEach(card => {
    const id = card.dataset.noteId;
    const cb = card.querySelector('.note-card-checkbox');
    if (checked) { _selectedNoteIds.add(id); card.classList.add('bulk-selected'); if (cb) cb.checked = true; }
    else          { _selectedNoteIds.delete(id); card.classList.remove('bulk-selected'); if (cb) cb.checked = false; }
  });
  _updateBulkBar();
}

async function bulkExportPdf() {
  if (!_selectedNoteIds.size) return;
  const ids = [..._selectedNoteIds];
  showToast(`📄 ${ids.length}개 노트 PDF 준비 중...`);

  const notes = await Promise.all(ids.map(id => getNoteFS(id)));
  const valid = notes.filter(Boolean);
  if (!valid.length) return;

  const win = window.open('', '_blank');
  if (!win) { showToast('⚠️ 팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.'); return; }

  const sectionsHtml = valid.map((note, i) => {
    const html = note.notesHtml || renderMarkdown(note.notesText || '');
    const title = escHtml(note.title || '제목없음');
    const breakStyle = i > 0 ? ' style="page-break-before:always"' : '';
    return `<div class="note-section"${breakStyle}>\n<h1 class="note-title">${title}</h1>\n<div class="note-body">${html}</div>\n</div>`;
  }).join('\n');

  win.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>노트 ${valid.length}개 묶음 PDF</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    * { font-family: 'Noto Sans KR', 'Segoe UI', 'Apple SD Gothic Neo', sans-serif; box-sizing:border-box; margin:0; padding:0; color:#1a1a1a; }
    body { background:#fff; font-size:11pt; line-height:1.8; padding:1.5cm 2cm; max-width:21cm; margin:0 auto; padding-top:calc(1.5cm + 44px); }
    h1 { font-size:18pt; font-weight:700; border-bottom:2px solid #333; padding-bottom:0.4em; margin:0 0 1em; }
    h2 { font-size:14pt; font-weight:700; border-bottom:1px solid #ccc; padding-bottom:0.25em; margin:1.8em 0 0.6em; }
    h3 { font-size:12pt; font-weight:700; margin:1.4em 0 0.4em; }
    p { margin:0.4em 0; }
    p:empty { margin:0.15em 0; }
    ul, ol { padding-left:1.6em; margin:0.3em 0 0.5em; }
    li { margin:0.2em 0; }
    strong { font-weight:700; }
    em { font-style:italic; }
    hr { border:none; border-top:1px solid #ccc; margin:1.4em 0; }
    code { font-family:'Courier New',monospace; font-size:10pt; background:#f3f4f6; padding:0.1em 0.4em; border-radius:3px; }
    blockquote { border-left:3px solid #333; margin:0.5em 0; padding:0.4em 0.8em; background:#f5f5f5; border-radius:0 4px 4px 0; }
    blockquote p { margin:0.15em 0; color:#555; }
    table { width:auto; border-collapse:collapse; margin:0.8em 0; font-size:10pt; }
    th, td { border:1px solid #999; padding:0.3em 0.6em; text-align:left; }
    th { background:#e8e8e8; font-weight:700; }
    .highlight-important { background:#fff3cd; color:#856404; border:1px solid #ffc107; padding:0.1em 0.35em; border-radius:3px; }
    figure { margin:1.2em 0; page-break-inside:avoid; }
    .inserted-slide-img { width:100%; max-width:100%; border:1px solid #ddd; border-radius:4px; }
    .inserted-slide-caption { font-size:9pt; color:#666; text-align:center; margin-top:0.3em; }
    .note-title { font-size:16pt; font-weight:700; border-bottom:2px solid #333; padding-bottom:0.4em; margin:0 0 1em; }
    .note-section + .note-section { page-break-before:always; padding-top:0.5cm; }
    #printBar { position:fixed; top:0; left:0; right:0; background:#f0f0f0; border-bottom:2px solid #ccc; padding:8px 16px; display:flex; align-items:center; gap:12px; z-index:9999; }
    #printBar button { padding:6px 16px; font-size:10pt; font-weight:600; border:none; border-radius:4px; cursor:pointer; }
    #printBtn { background:#333; color:#fff; }
    #printBtn:hover { background:#1a1a1a; }
    #closeBtn { background:#e5e7eb; color:#333; }
    #closeBtn:hover { background:#d1d5db; }
    @media print {
      #printBar { display:none !important; }
      body { padding:0; }
      h2, h3 { page-break-after:avoid; }
      ul, ol, p { page-break-inside:avoid; }
      figure { page-break-inside:avoid; }
      table, th, td { border:1px solid #333 !important; }
      th { background:#e0e0e0 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .highlight-important { background:#fff3cd !important; color:#856404 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .note-section + .note-section { page-break-before:always; }
    }
  </style>
</head>
<body>
  <div id="printBar">
    <button id="printBtn" onclick="window.print()">📄 PDF로 저장 (Ctrl+P)</button>
    <button id="closeBtn" onclick="window.close()">✕ 닫기</button>
    <span style="font-size:9pt;color:#666;">인쇄 대화상자에서 'PDF로 저장' 선택 · ${valid.length}개 노트</span>
  </div>
  ${sectionsHtml}
</body>
</html>`);
  win.document.close();
  setTimeout(() => { try { win.print(); } catch(e) {} }, 800);
}

async function bulkDeleteSelected() {
  if (!_selectedNoteIds.size) return;
  if (!await appConfirm(`${_selectedNoteIds.size}개의 노트를 삭제하시겠습니까?`, { danger: true })) return;
  for (const id of _selectedNoteIds) {
    await deleteNoteFS(id);
    if (currentNoteId === id) currentNoteId = null;
  }
  showToast(`🗑 ${_selectedNoteIds.size}개 노트 삭제 완료`);
  _selectedNoteIds.clear();
  _bulkSelectMode = false;
  const bar = document.getElementById('bulkDeleteBar');
  const btn = document.getElementById('bulkSelectToggleBtn');
  if (bar) bar.classList.remove('visible');
  if (btn) btn.classList.remove('active');
  renderHomeView();
}
