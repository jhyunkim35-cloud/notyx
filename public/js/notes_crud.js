// Notes CRUD: auto-save, list rendering, open/load, Notion file import, delete, move, rename, detect splits.
// Depends on: constants.js (currentNoteId, _noteSaveInFlight, storedNotesText, storedPptText, storedFilteredText, storedHighlightedTranscript, extractedImages, currentSummaryLayers, currentStudyTools, pptFile, currentUser), storage.js, firestore_sync.js (saveNoteFS, getNoteFS, getAllNotesFS, deleteNoteFS, searchNotesFS, getAllFoldersFS, getStorageSize, getNextSortOrder, saveFolderFS), ui.js (showToast, showSuccessToast), markdown.js (escHtml, renderMarkdown), quiz.js (clearQuizInlineArea), pipeline.js (renderSummaryHero, renderStudyTools), folders.js (buildFolderSelectOptions).
// Q5: draftSaveNote()/autoSaveNote() are called from note_creation.js right after a single-note pipeline finishes — draftSaveNote() writes a silent draft BEFORE the name/folder modal, autoSaveNote() finalizes it.

/* ═══════════════════════════════════════════════
   Auto-save after pipeline
═══════════════════════════════════════════════ */
// U14: also lets the user pick a destination folder at save time (instead of
// always landing in 미분류). Returns {title, folderId} — folderId is '' /
// null when 미분류 stays selected. Cancel/Escape still saves (matches prior
// behavior: only the title falls back to defaultTitle, the folder choice —
// whatever was selected — is kept either way).
async function promptNoteName(defaultTitle) {
  const folders = await getAllFoldersFS().catch(() => []);
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.innerHTML = `
      <div class="db-modal" style="max-width:380px;">
        <div style="font-size:0.9rem; line-height:1.5; margin-bottom:0.6rem; color:var(--text);">노트 이름을 입력하세요:</div>
        <input class="appPromptInput" type="text" style="width:100%; padding:0.5rem 0.7rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.9rem; box-sizing:border-box; margin-bottom:0.7rem;" />
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">저장 폴더</label>
        <select class="folder-save-select" style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;">${buildFolderSelectOptions(folders, '')}</select>
        <div class="db-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1rem;">
          <button class="appPromptCancel" style="background:var(--surface3); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">취소</button>
          <button class="appPromptOk" style="background:var(--primary); color:var(--bg); border:none; border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">확인</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input        = overlay.querySelector('.appPromptInput');
    const folderSelect = overlay.querySelector('.folder-save-select');
    input.value = defaultTitle;
    const onKey = e => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter' && document.activeElement === input) done(input.value);
    };
    const done = val => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      const title = val && val.trim() ? val.trim() : defaultTitle;
      resolve({ title, folderId: folderSelect.value || null });
    };
    overlay.querySelector('.appPromptOk').addEventListener('click', () => done(input.value));
    overlay.querySelector('.appPromptCancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); }); // backdrop click = cancel (title falls back, folder kept)
    document.addEventListener('keydown', onKey);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// Q5: id of the note draftSaveNote() silently created for the note currently
// being finalized — lets autoSaveNote() tell "this currentNoteId is my own
// unconfirmed draft from this same flow" apart from "this is a genuinely
// pre-existing note the caller opened". Single-use: cleared once consumed.
let _draftSaveNoteId = null;

function computeAutoNoteTitle() {
  const slide1Section = storedPptText.match(/\[슬라이드 1\]([\s\S]*?)(?=\[슬라이드 \d+\]|$)/);
  const slide1Title   = slide1Section?.[1].match(/^제목: (.+)/m)?.[1].trim();
  const headingMatch  = storedNotesText.match(/^#\s+(.+)/m);
  const headingTitle  = headingMatch?.[1].replace(/\*\*/g, '').trim();
  const fileTitle     = pptFile?.name?.replace(/\.[^.]+$/, '') || document.getElementById('pptTagName')?.textContent || '새 노트';
  return slide1Title || headingTitle || fileTitle;
}

// Q5: shared field-set for both draftSaveNote() and autoSaveNote() so the two
// saves (silent draft, then user-confirmed finalize) can't drift out of sync
// when a field gets added to notes later.
function buildNoteSaveFields({ title, folderId }) {
  const notesHtml = document.getElementById('finalNotesBody')?.innerHTML || '';
  // Phase 3B-4: pick up the most-recent recorder audio path so the note
  // doc knows which Storage object backs it. Cleared by the caller after a
  // successful save so the path doesn't leak into the next unrelated note.
  const audioStoragePath = window.recorderLastAudioPath || null;
  return {
    title,
    folderId,
    notesText:            storedNotesText,
    notesHtml,
    pptText:              storedPptText,
    filteredText:         storedFilteredText,
    highlightedTranscript: storedHighlightedTranscript,
    extractedImages:      extractedImages,
    audioStoragePath:     audioStoragePath,
    summaryLayers:        currentSummaryLayers || null,  // R4: multilayer summary (한줄/핵심/문단/챕터)
    studyTools:           currentStudyTools || null,     // R8+R9: 마인드맵/암기/개념
  };
}

function showImageDegradationWarning(saveResult) {
  const result = saveResult?.localSaveResult?.saveStatus === 'image-degraded'
    ? saveResult.localSaveResult
    : saveResult;
  if (!result || result.saveStatus !== 'image-degraded'
      || result.degradation?.resource !== 'noteImages'
      || result.degradation?.reason !== 'quota') return false;
  const guidance = currentUser
    ? '저장 공간을 정리한 뒤 다시 저장해 주세요.'
    : '로그인하면 이미지를 Firebase Storage로 옮길 수 있습니다.';
  showToast(`⚠️ 이미지 저장이 완료되지 않았습니다. 노트 내용은 저장되었습니다. ${guidance}`);
  return true;
}

// Q5: silent draft save — called right after the pipeline finishes, BEFORE
// the name/folder modal shows. Writes the note under its auto-generated
// title into 미분류 so a tab close/crash between "generation done" and "user
// confirmed the modal" can't lose the note outright — worst case it survives
// under the auto title. autoSaveNote() finalizes this same note id right
// after (title/folder from the modal), or the auto title stands forever if
// the user never confirms.
async function draftSaveNote() {
  if (!storedNotesText || !storedNotesText.trim()) return; // ghost-note guard — same rule as autoSaveNote
  _noteSaveInFlight = true;
  let record;
  try {
    const fields = buildNoteSaveFields({ title: computeAutoNoteTitle(), folderId: null });
    record = await saveNoteFS(Object.assign(fields, { sortOrder: await getNextSortOrder(null) }));
    showImageDegradationWarning(record);
  } catch (e) {
    showImageDegradationWarning(e);
    console.error('[draftSaveNote] failed:', e);
    return;
  } finally {
    _noteSaveInFlight = false;
  }
  currentNoteId    = record.id;
  _draftSaveNoteId = record.id;
  // ponytail: best-effort — rehydrate extractedImages to the already-uploaded
  // URL shape so the autoSaveNote() finalize save right after this doesn't
  // re-upload the same slide images to Storage a second time. A failure here
  // just costs one harmless re-upload on finalize, not data loss.
  if (currentUser && extractedImages && extractedImages.length) {
    const hydrated = await getNoteFS(record.id).catch(() => null);
    if (hydrated?.extractedImages) extractedImages = hydrated.extractedImages;
  }
}

async function autoSaveNote() {
  try {
    const { title, folderId: chosenFolderId } = await promptNoteName(computeAutoNoteTitle());
    // GUARD: prevent ghost notes — both title and content must be non-empty
    const _titleOk = title && title.trim();
    const _contentOk = storedNotesText && storedNotesText.trim();
    if (!_titleOk || !_contentOk) {
      console.warn('[autoSaveNote] skipped empty note save', { titleOk: !!_titleOk, contentOk: !!_contentOk });
      return;
    }
    // Q5: draftSaveNote() (called just before this, right after the pipeline
    // finished) may have already silently saved this exact note under its
    // auto title. If so, finalize IN PLACE — same id, folderId now follows
    // the user's modal choice — instead of the "existing note keeps its
    // folder" rule below, which is for genuinely pre-existing notes that
    // this modal doesn't move.
    const isDraftFinalize = !!currentNoteId && currentNoteId === _draftSaveNoteId;
    // U14: new notes (including a just-finalized draft) save straight into
    // the chosen folder (with a sortOrder, same as the moveSavedNote path,
    // so it doesn't get stuck at Infinity vs manually-ordered notes already
    // in that folder). Genuinely existing notes keep whatever folder
    // they're already in — this modal doesn't move them.
    const isNewNote = !currentNoteId || isDraftFinalize;
    const fields = buildNoteSaveFields({
      title,
      folderId: isNewNote ? chosenFolderId : (await getNoteFS(currentNoteId))?.folderId ?? null,
    });
    const record = await saveNoteFS(Object.assign(fields, {
      id: currentNoteId || undefined,
      ...(isNewNote ? { sortOrder: await getNextSortOrder(chosenFolderId) } : {}),
    }));
    showImageDegradationWarning(record);
    if (fields.audioStoragePath) window.recorderLastAudioPath = null;
    currentNoteId    = record.id;
    _draftSaveNoteId = null;
    showSuccessToast('💾 저장 완료');
    renderHomeView();
  } catch (e) {
    showImageDegradationWarning(e);
    console.error('autoSaveNote error:', e);
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}


/* ═══════════════════════════════════════════════
   Open saved note
═══════════════════════════════════════════════ */
async function openSavedNote(id) {
  const note = await getNoteFS(id);
  if (!note) { showToast('노트를 찾을 수 없습니다.'); return; }

  // Branch: notion notes use a dedicated viewer
  if (note.type === 'notion') {
    openNotionNote(note);
    return;
  }

  // Regenerate notesHtml from notesText if missing (Firestore excludes it to stay under 1MB)
  if (!note.notesHtml && note.notesText) {
    note.notesHtml = renderMarkdown(note.notesText);
  }

  clearQuizInlineArea();
  storedNotesText            = note.notesText            || '';
  storedPptText              = note.pptText              || '';
  storedFilteredText         = note.filteredText         || '';
  storedHighlightedTranscript = note.highlightedTranscript || '';
  extractedImages            = note.extractedImages      || [];
  currentSummaryLayers       = note.summaryLayers         || null;  // R4: restore multilayer summary
  currentStudyTools          = note.studyTools            || null;  // R8+R9: restore 마인드맵/암기/개념
  currentNoteId              = note.id;

  const body = document.getElementById('finalNotesBody');
  if (note.notesHtml) {
    body.innerHTML = note.notesHtml;
  } else if (note.notesText) {
    body.innerHTML = renderMarkdown(note.notesText);
  } else {
    body.innerHTML = '<span class="placeholder-msg">노트 내용이 없습니다.</span>';
  }
  renderSummaryHero(storedNotesText);  // R4: restore hero (multilayer if saved, legacy fallback otherwise)
  renderStudyTools();  // R8+R9: restore 학습 도구 카드 (마인드맵/암기/개념)

  // Clear cached split-viewer content so it re-renders from restored state
  const splitNotes      = document.getElementById('splitNotes');
  const splitTranscript = document.getElementById('splitTranscript');
  const splitAccordion  = document.getElementById('splitAccordion');
  if (splitNotes)      splitNotes.innerHTML      = '';
  if (splitTranscript) splitTranscript.innerHTML = '';
  if (splitAccordion)  splitAccordion.innerHTML  = '';
  const splitClassify = document.getElementById('classifyArea');
  if (splitClassify)   splitClassify.innerHTML   = '';
  _classifyCache = null;

  // Enable action buttons (they start disabled until a pipeline runs)
  [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = false; });
  const _shareGroupBtn = document.getElementById('shareGroupBtn');
  if (_shareGroupBtn) _shareGroupBtn.disabled = false;
  const _dbgBtnRestore = document.getElementById('splitDebugBtn');
  if (_dbgBtnRestore) _dbgBtnRestore.style.display = '';
  document.getElementById('notesActions')?.classList.add('visible');
  document.getElementById('collapseBtn')?.classList.add('visible');

  // Auto-open split viewer
  setTimeout(() => {
    const splitBtn = document.getElementById('splitViewBtn');
    if (splitBtn) splitBtn.click();
  }, 100);

  // R3: sync study activity to matching study rooms (fire-and-forget,
  // error-tolerant — never block note open on this). The sync function
  // self-rate-limits per noteId (60s window) and bails out fast if the
  // folder has no lectureCode, so it's cheap for the common case.
  if (typeof window.syncStudyActivityForNote === 'function') {
    window.syncStudyActivityForNote(note).catch(e =>
      console.warn('[study_rooms] sync failed', e));
  }
}

/* ═══════════════════════════════════════════════
   Notion file parser
═══════════════════════════════════════════════ */
async function collectMdFromZip(zip, pathPrefix = '', depth = 0) {
  if (depth > 5) return []; // zip-bomb guard
  const results = [];
  const nestedZips = [];

  zip.forEach((path, entry) => {
    if (entry.dir) return;
    const lp = path.toLowerCase();
    if (lp.endsWith('.md')) {
      results.push({ path: pathPrefix + path, getText: () => entry.async('string') });
    } else if (lp.endsWith('.zip')) {
      nestedZips.push({ path, entry });
    }
  });

  for (const { path, entry } of nestedZips) {
    const innerBlob = await entry.async('blob');
    const innerZip  = await JSZip.loadAsync(innerBlob);
    const inner     = await collectMdFromZip(innerZip, pathPrefix + path + '/', depth + 1);
    results.push(...inner);
  }

  return results;
}

async function parseNotionFile(file) {
  // C1: OOM guard — Notion exports can be large; a 500MB zip would crash
  // the JSZip loader. Same 200MB cap as PPT/PDF for consistency.
  if (file.size > MAX_FILE_SIZE_BYTES) {
    showToast(`파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
    return null;
  }

  let combinedMd = '';

  if (file.name.toLowerCase().endsWith('.md')) {
    combinedMd = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('파일 읽기 실패'));
      reader.readAsText(file, 'UTF-8');
    });
  } else if (file.name.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const mdEntries = await collectMdFromZip(zip);
    if (mdEntries.length === 0) {
      showToast('마크다운 파일이 없습니다');
      return null;
    }
    mdEntries.sort((a, b) => a.path.localeCompare(b.path));
    const parts = await Promise.all(mdEntries.map(m => m.getText()));
    combinedMd = parts.join('\n\n---\n\n');
  } else {
    showToast('.md 또는 .zip 파일만 지원됩니다');
    return null;
  }

  if (!combinedMd.trim()) {
    showToast('빈 파일입니다');
    return null;
  }

  // Cleanup: remove Notion UUID suffixes from inline links
  combinedMd = combinedMd.replace(/([^\s\(\)]+?)\s+[a-f0-9]{32}(\.md|\))/g, '$1$2');

  // Extract title from first H1
  let title = '';
  const h1Match = combinedMd.match(/^#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1].trim();
    combinedMd = combinedMd.replace(/^#\s+.+\n?/m, '');
  } else {
    title = file.name.replace(/\.(md|zip)$/i, '');
  }

  // Strip Notion metadata block (lines after title removal like Created:, Last edited time:, etc.)
  const metaPattern = /^(Created|Last edited time|Tags|Status|Owner|Type|Date|Priority):\s/i;
  const lines = combinedMd.split('\n');
  let i = 0;
  // Skip leading blank lines then check up to 6 lines for metadata
  while (i < lines.length && lines[i].trim() === '') i++;
  const metaStart = i;
  let metaEnd = i;
  while (metaEnd < metaStart + 6 && metaEnd < lines.length && (lines[metaEnd].trim() === '' || metaPattern.test(lines[metaEnd]))) {
    metaEnd++;
  }
  if (metaEnd > metaStart) {
    lines.splice(metaStart, metaEnd - metaStart);
    combinedMd = lines.join('\n');
  }

  combinedMd = combinedMd.trim();

  if (!combinedMd) {
    showToast('빈 파일입니다');
    return null;
  }

  if (combinedMd.length > 500000) {
    const ok = await appConfirm(`파일이 큽니다 (${combinedMd.length.toLocaleString()}자). 계속하시겠습니까?`);
    if (!ok) return null;
  }

  return { title, markdown: combinedMd };
}

/* ═══════════════════════════════════════════════
   Delete note
═══════════════════════════════════════════════ */
// Actual delete. Confirmation is handled inline by the 2-step delete button in
// home_view.js (first click arms "삭제?", second click calls this) — matching
// the folder-card pattern. No appConfirm modal: a browser extension at max
// z-index could paint over it so the OK click never landed.
async function deleteNoteNow(id) {
  try {
    await deleteNoteFS(id);
    if (currentNoteId === id) currentNoteId = null;
    showToast('🗑 노트 삭제 완료');
  } catch (e) {
    console.error('[deleteNoteNow] failed:', e);
    showToast('❌ 노트 삭제 실패: ' + (e.message || '알 수 없는 오류') + ' (콘솔 확인)');
  }
  await renderHomeView(); // refresh grid and folder note counts
}

/* ═══════════════════════════════════════════════
   Move note to folder
═══════════════════════════════════════════════ */
async function moveSavedNote(id) {
  const [note, folders] = await Promise.all([getNoteFS(id), getAllFoldersFS()]);
  if (!note) return;

  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.innerHTML = `
    <div class="db-modal" style="max-height:60vh;">
      <h3>📁 폴더 이동</h3>
      <div class="db-modal-list" id="moveFolderList"></div>
      <div class="db-modal-footer">
        <button onclick="this.closest('.db-modal-overlay').remove()">취소</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#moveFolderList');
  const allChoices = [{ id: null, name: '미분류 (폴더 없음)' }, ...folders];
  for (const folder of allChoices) {
    const row = document.createElement('div');
    row.className = 'db-modal-row';
    row.style.cursor = 'pointer';
    row.innerHTML = `<span>${folder.id ? '📁 ' : '📄 '}${escHtml(folder.name)}</span>`;
    row.onclick = async () => {
      const newSortOrder = await getNextSortOrder(folder.id, note.id);
      const updated = Object.assign({}, note, { folderId: folder.id, sortOrder: newSortOrder });
      try {
        const saveResult = await saveNoteFS(updated);
        showImageDegradationWarning(saveResult);
        showSuccessToast(`📁 "${note.title || '노트'}" 이동 완료`);
      } catch (e) {
        showImageDegradationWarning(e);
        console.warn('moveSavedNote save failed:', e);
        showToast('❌ 폴더 이동 실패: ' + e.message);
      } finally {
        overlay.remove();
      }
      await renderHomeView();
    };
    listEl.appendChild(row);
  }
}

/* ═══════════════════════════════════════════════
   Folder manager modal
═══════════════════════════════════════════════ */
function detectNoteSplits(htmlContent) {
  const root = document.createElement('div');
  root.innerHTML = htmlContent;

  // Walk top-level nodes collecting text of each
  const nodes = [...root.childNodes];

  // --- Try 주차 pattern first ---
  // Match elements whose text looks like "N주차 ..." or "- N주차 ..."
  const weekRegex = /^[-•\s]*(\d+)\s*주차\s*[-–—:：]?\s*(.+)?/;
  const splits = [];

  let currentTitle = null;
  let currentNodes = [];

  const flush = () => {
    if (currentTitle !== null) {
      const frag = document.createElement('div');
      currentNodes.forEach(n => frag.appendChild(n.cloneNode(true)));
      const html = frag.innerHTML.trim();
      const plainText = frag.innerText?.trim() || frag.textContent.trim();
      if (html) splits.push({ title: currentTitle, html, plainText });
    }
  };

  let foundWeek = false;
  for (const node of nodes) {
    const text = (node.textContent || '').trim();
    const m    = weekRegex.exec(text);
    if (m && text.length < 120) {
      // This node is a split marker
      flush();
      foundWeek = true;
      const weekNum  = m[1];
      const subtitle = (m[2] || '').trim().replace(/[<>()[\]]/g, '').trim();
      currentTitle   = subtitle ? `${weekNum}주차 - ${subtitle}` : `${weekNum}주차`;
      currentNodes   = [];
    } else {
      currentNodes.push(node);
    }
  }
  flush();

  if (foundWeek && splits.length > 0) return splits;

  // --- Fallback: split on <h1> or <h2> elements ---
  const headingNodes = [...root.querySelectorAll('h1, h2')];
  if (headingNodes.length >= 2) {
    currentTitle = null;
    currentNodes = [];
    const allChildren = [...root.childNodes];
    for (const node of allChildren) {
      const tag = node.nodeName;
      if (tag === 'H1' || tag === 'H2') {
        flush();
        currentTitle = (node.textContent || '').trim() || '가져온 노트';
        currentNodes = [];
      } else {
        currentNodes.push(node);
      }
    }
    flush();
    if (splits.length > 0) return splits;
  }

  // --- No markers: single note ---
  const plainText = root.innerText?.trim() || root.textContent.trim();
  return [{ title: '가져온 노트', html: htmlContent, plainText }];
}

function showImportNoteModal() {
  const existing = document.getElementById('importNoteOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'importNoteOverlay';
  overlay.className = 'db-modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div class="db-modal" style="max-width:620px;display:flex;flex-direction:column;max-height:92vh;gap:0.7rem;">
      <h3 style="flex-shrink:0;">📥 노트 가져오기</h3>
      <div id="importNoteBody" contenteditable="true"
        style="min-height:200px;max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:1rem;background:var(--surface2);color:var(--text);font-size:0.88rem;line-height:1.6;outline:none;cursor:text;flex-shrink:0;"
        data-placeholder="노션에서 복사한 내용을 여기에 붙여넣기 (Ctrl+V)"></div>
      <div style="display:flex;align-items:center;gap:0.6rem;flex-shrink:0;">
        <button id="importPreviewBtn" style="padding:0.45rem 1rem;border-radius:6px;border:1px solid var(--border);background:var(--surface3);color:var(--text);font-size:0.85rem;cursor:pointer;">🔍 미리보기</button>
        <span id="importPreviewCount" style="font-size:0.82rem;color:var(--text-muted);"></span>
      </div>
      <div id="importPreviewArea" style="display:none;flex-direction:column;gap:0.4rem;overflow-y:auto;flex:1;min-height:0;"></div>
      <div class="db-modal-footer" style="justify-content:flex-end;flex-shrink:0;">
        <button onclick="this.closest('.db-modal-overlay').remove()" style="background:var(--surface3);color:var(--text);">취소</button>
        <button id="importNoteSaveBtn" disabled style="padding:0.5rem 1.2rem;border-radius:6px;border:none;background:var(--primary);color:var(--bg);font-size:0.85rem;cursor:pointer;opacity:0.5;">저장</button>
      </div>
    </div>`;

  const body       = overlay.querySelector('#importNoteBody');
  const previewBtn = overlay.querySelector('#importPreviewBtn');
  const previewArea= overlay.querySelector('#importPreviewArea');
  const countEl    = overlay.querySelector('#importPreviewCount');
  const saveBtn    = overlay.querySelector('#importNoteSaveBtn');

  let detectedSplits = [];

  previewBtn.addEventListener('click', () => {
    const html = body.innerHTML.trim();
    if (!html || html === '<br>') { showToast('내용을 붙여넣기 해주세요.'); return; }

    detectedSplits = detectNoteSplits(html);
    countEl.textContent = `${detectedSplits.length}개의 노트가 감지되었습니다`;

    previewArea.innerHTML = detectedSplits.map((s, i) => `
      <div class="import-preview-item">
        <input type="checkbox" checked data-idx="${i}">
        <div class="import-preview-item-body">
          <div class="import-preview-title">${escHtml(s.title)}</div>
          <div class="import-preview-snippet">${escHtml(s.plainText.slice(0, 140))}</div>
        </div>
      </div>`).join('');

    previewArea.style.display = 'flex';
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
  });

  saveBtn.addEventListener('click', async () => {
    const checked = [...previewArea.querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => detectedSplits[parseInt(cb.dataset.idx)]).filter(Boolean);

    if (!checked.length) { showToast('저장할 노트를 선택해주세요.'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중…';

    try {
      const now = new Date().toISOString();
      for (const s of checked) {
        if (!s.title?.trim() || !s.plainText?.trim()) {
          console.warn('[import] skipped empty split');
          continue;
        }
        const id = uuidv4();
        const note = {
          id,
          title:     s.title,
          notesHtml: s.html,
          notesText: s.plainText,
          createdAt: now,
          folderId:  null,
          source:    'import',
          extractedImages: [],
        };
        const saveResult = await saveNote(note);
        showImageDegradationWarning(saveResult);
        const updatedAt = new Date().toISOString();
        safeNotePartialUpdate(id, {
          id, title: s.title, notesText: s.plainText, createdAt: now,
          source: 'import', folderId: null, updatedAt,
        }).catch(e => console.warn('import Firestore sync failed:', e));
      }
      showToast(`📥 ${checked.length}개 노트 저장 완료`);
      overlay.remove();
      await renderHomeView();
    } catch(e) {
      showToast('❌ 저장 실패: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
    }
  });

  document.body.appendChild(overlay);
  body.focus();
}

async function renameSavedNote(id) {
  const note = await getNoteFS(id);
  if (!note) return;
  const newTitle = await appPrompt('노트 이름:', note.title || '');
  if (!newTitle || newTitle.trim() === note.title) return;
  const trimmedTitle = newTitle.trim();
  const updatedAt = new Date().toISOString();

  // Update IndexedDB local cache
  const updated = Object.assign({}, note, { title: trimmedTitle, updatedAt });
  const saveResult = await saveNote(updated);
  showImageDegradationWarning(saveResult);

  // Patch only title + updatedAt to Firestore (no image re-upload).
  // safeNotePartialUpdate refuses to create a ghost doc when the Firestore
  // record doesn't exist yet — protects renames done before the first sync.
  try {
    await safeNotePartialUpdate(id, { title: trimmedTitle, updatedAt });
  } catch (e) {
    console.warn('Firestore rename sync failed:', e);
  }

  await renderHomeView();
}

/* ═══════════════════════════════════════════════
   Export / Import
═══════════════════════════════════════════════ */
async function exportAllNotes() {
  const [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const data = JSON.stringify({ notes, folders, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `meeting-notes-export-${dateStamp()}.json` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showSuccessToast('⬇ 내보내기 완료');
}

async function importNotes(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const notes   = data.notes   || [];
    const folders = data.folders || [];
    const [existingNotes, existingFolders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
    const existingNoteIds   = new Set(existingNotes.map(n => n.id));
    const existingFolderIds = new Set(existingFolders.map(f => f.id));
    let imported = 0;
    for (const folder of folders) {
      if (!existingFolderIds.has(folder.id)) { await saveFolderFS(folder); }
    }
    for (const note of notes) {
      const _hasTitle = note.title && note.title.trim();
      const _hasContent = (note.notesText || note.markdownContent) &&
                          (note.notesText || note.markdownContent).trim();
      if (!_hasTitle && !_hasContent) {
        console.warn('[importNotes] skipping ghost note:', note.id);
        continue;
      }
      if (!existingNoteIds.has(note.id)) {
        const saveResult = await saveNoteFS(note);
        showImageDegradationWarning(saveResult);
        imported++;
      }
    }
    input.value = '';
    showSuccessToast(`⬆ ${imported}개 노트 가져오기 완료`);
    renderHomeView();
  } catch (e) {
    showImageDegradationWarning(e);
    showToast(`❌ 가져오기 실패: ${e.message}`);
  }
}
