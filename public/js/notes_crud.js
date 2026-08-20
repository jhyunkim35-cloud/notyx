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
  let note = null;
  try {
    const notes = await getAllNotesFS();
    note = notes.find(candidate => candidate && candidate.id === id) || null;
  } catch (error) {
    console.warn('[moveSavedNote] metadata list failed, falling back to one-note read:', error);
  }
  if (!note) note = await getNoteFS(id);
  const folders = await getAllFoldersFS();
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
      const updated = {
        id: note.id,
        title: note.title,
        notesText: note.notesText,
        markdownContent: note.markdownContent,
        type: note.type,
        folderId: folder.id,
        sortOrder: newSortOrder,
      };
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
function _exportImageMetadata(entry) {
  const metadata = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (['blob', 'dataUrl', 'imageBase64', 'src', 'data', 'payload', 'base64', 'imageData'].includes(key)) continue;
    metadata[key] = value;
  }
  return metadata;
}

async function _buildNoteExport(metadata) {
  const hydrated = await getNoteFS(metadata.id);
  const source = hydrated || metadata;
  const detached = detachNoteImages(source);
  const images = [];
  for (const entry of detached.imageRecord.images) {
    if (!entry || !entry.blob) continue;
    images.push(Object.assign(_exportImageMetadata(entry), {
      dataUrl: await blobToDataUrl(entry.blob),
    }));
  }
  return { note: stripNoteImagePayloads(source), images };
}

async function exportAllNotes() {
  const [notes, folders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const exportedNotes = [];
  for (const note of notes) exportedNotes.push(await _buildNoteExport(note));
  const data = JSON.stringify({
    schema: 'notyx.storage2',
    version: 2,
    notes: exportedNotes,
    folders,
    exportedAt: new Date().toISOString(),
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `meeting-notes-export-${dateStamp()}.json` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showSuccessToast('⬇ 내보내기 완료');
}

const _IMPORT_IMAGE_FIELDS = new Set(['html', 'extractedImages', 'slideImages']);
const _IMPORT_IMAGE_METADATA_FIELDS = new Set([
  'markerId', 'mimeType', 'fileName', 'slideNumber', 'alt', 'width', 'height', 'sourceKey',
]);
const _IMPORT_IMAGE_PAYLOAD_KEYS = new Set([
  'dataUrl', 'dataURL', 'imageBase64', 'src', 'data', 'payload', 'base64', 'imageData', 'blob',
]);

function _importObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob);
}

function _importReject(reason) {
  throw new Error('가져오기 파일을 검증할 수 없습니다: ' + reason);
}

function _validPortableImageDataUrl(value) {
  if (typeof value !== 'string' || !isDataImageSource(value)) return false;
  try {
    const parsed = noteImageParseDataUrl(value);
    if (parsed.isBase64) {
      const compact = noteImageNormaliseBase64(parsed.encoded);
      if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false;
      atob(compact);
    } else if (!decodeURIComponent(parsed.encoded)) {
      return false;
    }
    return dataUrlToBlob(value).size > 0;
  } catch (error) {
    return false;
  }
}

function _validateV2MetadataValue(value, label, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (noteImageIsBlob(value)) _importReject(label + ' contains a Blob payload');
  if (typeof value === 'string') {
    if (isDataImageSource(value)) _importReject(label + ' contains a local image data URL');
    if (noteImageInferMimeFromRawBase64(value)) _importReject(label + ' contains a raw image payload');
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => _validateV2MetadataValue(entry, label + '[' + index + ']', seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (_IMPORT_IMAGE_PAYLOAD_KEYS.has(key)) {
      if (child === null || child === undefined) continue;
      if (typeof child === 'string' && isRemoteImageSource(child)) continue;
      _importReject(label + '.' + key + ' contains a local image payload');
    }
    _validateV2MetadataValue(child, label + '.' + key, seen);
  }
}

function _htmlImageMarkersAndSources(html) {
  const markers = new Map();
  String(html).replace(/<img\b([^>]*)>/gi, (whole, attrs) => {
    const sourceMatch = /\bsrc\s*=\s*(?:(['"])([\s\S]*?)\1|([^\s>]+))/i.exec(attrs);
    const source = sourceMatch ? (sourceMatch[2] !== undefined ? sourceMatch[2] : sourceMatch[3]) : '';
    if (source && !isRemoteImageSource(source)) _importReject('v2 note HTML contains a local image source');
    const markerMatch = /\bdata-note-image-ref\s*=\s*(?:(['"])([^"']+)\1|([^\s>]+))/i.exec(attrs);
    if (markerMatch) {
      const marker = markerMatch[2] !== undefined ? markerMatch[2] : markerMatch[3];
      const current = markers.get(marker) || { count: 0, requiresOwner: false };
      current.count += 1;
      current.requiresOwner = current.requiresOwner || !source;
      current.sourceType = current.sourceType || (source ? 'remote' : 'placeholder');
      markers.set(marker, current);
    }
    return whole;
  });
  return markers;
}

function _validateSlideImageUrls(value, label) {
  if (!Array.isArray(value)) _importReject(label + ' must be an array');
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) continue;
    const entry = value[index];
    if (entry === null) continue;
    if (typeof entry !== 'string' || !isRemoteImageSource(entry)) {
      _importReject(label + ' entries must be null or remote URL strings');
    }
  }
}

function _validateDetachedNote(note) {
  if (!_importObject(note)) _importReject('v2 note must be an object');
  if (Object.prototype.hasOwnProperty.call(note, 'images')) _importReject('v2 note cannot contain an image payload field');
  if (Object.prototype.hasOwnProperty.call(note, 'notesHtml') && typeof note.notesHtml !== 'string') {
    _importReject('v2 notesHtml must be a string');
  }
  _validateV2MetadataValue(note, 'v2 note');
  const htmlMarkers = typeof note.notesHtml === 'string'
    ? _htmlImageMarkersAndSources(note.notesHtml)
    : new Map();
  for (const field of ['extractedImages', 'slideImages']) {
    if (!Object.prototype.hasOwnProperty.call(note, field)) continue;
    if (!Array.isArray(note[field])) _importReject(field + ' must be an array');
    for (let index = 0; index < note[field].length; index++) {
      if (!(index in note[field])) continue;
      const entry = note[field][index];
      if (entry === null || entry === undefined) continue;
      if (!_importObject(entry)) _importReject(field + '[' + index + '] must be a metadata object');
      if (!entry) continue;
      if (noteImageIsBlob(entry)) _importReject('v2 note contains a Blob outside images[]');
    }
  }
  if (Object.prototype.hasOwnProperty.call(note, 'slideImageUrls')) {
    _validateSlideImageUrls(note.slideImageUrls, 'slideImageUrls');
  }
  return htmlMarkers;
}

function _validatePortableImages(images, htmlMarkers) {
  if (!Array.isArray(images)) _importReject('v2 images must be an array');
  const owners = new Set();
  const markers = new Set();
  for (const image of images) {
    if (!_importObject(image)) _importReject('portable image must be an object');
    if (!_IMPORT_IMAGE_FIELDS.has(image.field)) _importReject('unsupported portable image field');
    if (!Number.isSafeInteger(image.index) || image.index < 0) _importReject('portable image index must be nonnegative');
    for (const key of _IMPORT_IMAGE_PAYLOAD_KEYS) {
      if (key !== 'dataUrl' && Object.prototype.hasOwnProperty.call(image, key)) {
        _importReject('portable image contains an unsupported payload alias');
      }
    }
    if (!_validPortableImageDataUrl(image.dataUrl)) _importReject('portable image dataUrl is invalid');
    const owner = image.field + ':' + image.index;
    if (owners.has(owner)) _importReject('duplicate portable image owner');
    owners.add(owner);
    if (image.markerId !== undefined) {
      if (!noteImageMarkerIsStable(image.markerId)) _importReject('portable image marker is invalid');
      if (markers.has(image.markerId)) _importReject('duplicate portable image marker');
      markers.add(image.markerId);
      const markerInfo = htmlMarkers.get(image.markerId);
      if (markerInfo?.sourceType === 'remote') {
        _importReject('portable image marker collides with a remote HTML source');
      }
    }
    if (image.field === 'html') {
      if (!noteImageMarkerIsStable(image.markerId)) _importReject('HTML portable image needs a stable marker');
      const markerInfo = htmlMarkers.get(image.markerId);
      if (!markerInfo || markerInfo.count !== 1 || !markerInfo.requiresOwner) {
        _importReject('HTML portable image marker must occur exactly once on a local placeholder');
      }
    }
    for (const [key, value] of Object.entries(image)) {
      if (key === 'dataUrl') continue;
      _validateV2MetadataValue(value, 'portable image.' + key);
    }
  }
  for (const [marker, markerInfo] of htmlMarkers) {
    if (markerInfo.count !== 1) _importReject('HTML marker occurs more than once: ' + marker);
    if (markerInfo.requiresOwner && !markers.has(marker)) {
      _importReject('HTML marker has no portable image owner: ' + marker);
    }
  }
}

const _LEGACY_DIRECT_SOURCE_KEYS = new Set([
  'imageBase64', 'src', 'data', 'blob', 'payload', 'base64', 'imageData',
]);

function _validateLegacyDirectSource(value, mimeType, label) {
  if (noteImageIsBlob(value)) return;
  if (typeof value !== 'string') _importReject(label + ' must be a supported image source');
  if (isRemoteImageSource(value) || noteImageLooksLikeRawBase64(value, mimeType)) return;
  if (isDataImageSource(value)) {
    try {
      if (dataUrlToBlob(value).size > 0) return;
    } catch (error) {
      // Fall through to the common validation error.
    }
  }
  _importReject(label + ' must be a supported image source');
}

function _normaliseLegacyRemoteSource(value) {
  const trimmed = String(value).trim();
  const isProtocolRelative = trimmed.startsWith('//');
  if (typeof URL !== 'function' || (!isProtocolRelative && !/^https?:\/\//i.test(trimmed))) return '';
  try {
    const parsed = new URL(isProtocolRelative ? 'https:' + trimmed : trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const href = parsed.href;
    return (isProtocolRelative ? 'protocol-relative:' : 'absolute:')
      + (isProtocolRelative ? href.slice(parsed.protocol.length) : href);
  } catch (error) {
    return '';
  }
}

function _legacyBytesSignature(bytes, mimeType) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return String(mimeType || '').toLowerCase() + '\u0000' + btoa(binary);
}

function _legacyCanonicalSource(value, mimeType, label) {
  _validateLegacyDirectSource(value, mimeType, label);
  if (noteImageIsBlob(value)) return { kind: 'blob', value };
  const source = value.trim();
  if (isRemoteImageSource(source, mimeType)) {
    const signature = _normaliseLegacyRemoteSource(source);
    if (!signature) _importReject(label + ' must be a valid remote image URL');
    return { kind: 'remote', signature };
  }
  try {
    if (isDataImageSource(source)) {
      const parsed = noteImageParseDataUrl(source);
      let bytes;
      if (parsed.isBase64) {
        const binary = atob(noteImageNormaliseBase64(parsed.encoded));
        bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(parsed.encoded));
      }
      return { kind: 'local', signature: _legacyBytesSignature(bytes, parsed.mimeType) };
    }
    if (noteImageLooksLikeRawBase64(source, mimeType)) {
      const binary = atob(noteImageNormaliseBase64(source));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return { kind: 'local', signature: _legacyBytesSignature(bytes, mimeType) };
    }
  } catch (error) {
    _importReject(label + ' must contain decodable image bytes');
  }
  _importReject(label + ' must be a supported image source');
}

function _legacySourcesEquivalent(left, right) {
  if (left.kind === 'blob' || right.kind === 'blob') {
    return left.kind === 'blob' && right.kind === 'blob' && left.value === right.value;
  }
  return left.kind === right.kind && left.signature === right.signature;
}

function _validateLegacyNestedMetadata(value, label, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (noteImageIsBlob(value)) _importReject(label + ' contains a nested Blob payload');
  if (typeof value === 'string') {
    if (isDataImageSource(value) || noteImageInferMimeFromRawBase64(value)) {
      _importReject(label + ' contains a nested image payload');
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => _validateLegacyNestedMetadata(entry, label + '[' + index + ']', seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (_IMPORT_IMAGE_PAYLOAD_KEYS.has(key)) _importReject(label + '.' + key + ' is a nested image payload alias');
    _validateLegacyNestedMetadata(child, label + '.' + key, seen);
  }
}

function _validateLegacyCanonicalEntry(entry, label) {
  if (typeof entry === 'string') {
    _legacyCanonicalSource(entry, '', label);
    return;
  }
  if (noteImageIsBlob(entry)) {
    _validateLegacyDirectSource(entry, '', label);
    return;
  }
  if (!noteImageIsPlainObject(entry)) _importReject(label + ' must be a direct source or plain metadata object');
  const sources = [];
  for (const [key, value] of Object.entries(entry)) {
    if (_LEGACY_DIRECT_SOURCE_KEYS.has(key)) {
      if (value === null || value === undefined || value === '') continue;
      _validateLegacyDirectSource(value, entry.mimeType, label + '.' + key);
      sources.push({ key, source: _legacyCanonicalSource(value, entry.mimeType, label + '.' + key) });
    } else {
      _validateLegacyNestedMetadata(value, label + '.' + key);
    }
  }
  for (let index = 1; index < sources.length; index++) {
    if (!_legacySourcesEquivalent(sources[0].source, sources[index].source)) {
      _importReject(label + ' has conflicting image sources: ' + sources[0].key + ' vs ' + sources[index].key);
    }
  }
}

function _validateLegacyCanonicalArray(value, label) {
  if (!Array.isArray(value)) _importReject(label + ' must be an array');
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) continue;
    const entry = value[index];
    if (entry === null || entry === undefined) continue;
    _validateLegacyCanonicalEntry(entry, label + '[' + index + ']');
  }
}

function _rejectPersistedHtmlPayloads(html, label) {
  const source = String(html || '');
  if (/data:image\/[^;\s,]+(?:;[^,]*)?,/i.test(source)) {
    _importReject(label + ' contains an image data URL outside an img source');
  }
  const quotedValues = [...source.matchAll(/=\s*(["'])([\s\S]*?)\1/g)].map(match => match[2]);
  const unquotedValues = [...source.matchAll(/=\s*([^\s>]+)/g)].map(match => match[1]);
  for (const value of [...quotedValues, ...unquotedValues]) {
    if (noteImageInferMimeFromRawBase64(value)) _importReject(label + ' contains a raw image payload');
  }
  const tokens = source.match(/[A-Za-z0-9+/]{12,}={0,2}/g) || [];
  if (tokens.some(token => noteImageInferMimeFromRawBase64(token))) {
    _importReject(label + ' contains a raw image payload');
  }
}

function _validateLegacyImportPayloadAliases(note, label) {
  for (const [key, value] of Object.entries(note)) {
    if (key === 'notesHtml') {
      if (typeof value !== 'string') _importReject(label + ' notesHtml must be a string');
      const strippedHtml = stripNoteImagePayloads(note).notesHtml;
      _rejectPersistedHtmlPayloads(strippedHtml, label + '.notesHtml');
      continue;
    }
    if (key === 'extractedImages' || key === 'slideImages') {
      _validateLegacyCanonicalArray(value, label + '.' + key);
      continue;
    }
    if (key === 'slideImageUrls') {
      _validateSlideImageUrls(value, label + '.slideImageUrls');
      continue;
    }
    _validateV2MetadataValue(value, label + '.' + key);
  }
}

function _validateImportNote(note, seenIds, label) {
  if (!_importObject(note)) _importReject(label + ' must be an object');
  if (typeof note.id !== 'string' || !note.id.trim()) _importReject(label + ' needs a nonempty id');
  if (seenIds.has(note.id)) _importReject('duplicate note id: ' + note.id);
  const title = typeof note.title === 'string' ? note.title.trim() : '';
  const body = typeof note.markdownContent === 'string'
    ? note.markdownContent.trim()
    : (typeof note.notesText === 'string' ? note.notesText.trim() : '');
  if (Object.prototype.hasOwnProperty.call(note, 'notesHtml') && typeof note.notesHtml !== 'string') {
    _importReject(label + ' notesHtml must be a string');
  }
  if (!title && !body) _importReject(label + ' needs a title or body');
  _validateLegacyImportPayloadAliases(note, label);
  seenIds.add(note.id);
}

function _validateImportFolder(folder, seenIds) {
  if (!_importObject(folder)) _importReject('folder must be an object');
  if (typeof folder.id !== 'string' || !folder.id.trim()) _importReject('folder needs a nonempty id');
  if (typeof folder.name !== 'string' || !folder.name.trim()) _importReject('folder needs a nonempty name');
  if (seenIds.has(folder.id)) _importReject('duplicate folder id: ' + folder.id);
  seenIds.add(folder.id);
}

function _buildImportPlan(data) {
  if (!_importObject(data)) _importReject('top-level value must be an object');
  const hasSchema = Object.prototype.hasOwnProperty.call(data, 'schema');
  const hasVersion = Object.prototype.hasOwnProperty.call(data, 'version');
  if (hasSchema !== hasVersion) _importReject('schema and version must be declared together');
  const isLegacy = !hasSchema && !hasVersion;
  if (!isLegacy && data.schema !== 'notyx.storage2') _importReject('unsupported schema');
  if (!isLegacy && data.version !== 2) _importReject('unsupported version');
  if (!Array.isArray(data.notes)) _importReject('notes must be an array');
  const topLevelKeys = new Set(['schema', 'version', 'notes', 'folders', 'exportedAt']);
  for (const [key, value] of Object.entries(data)) {
    if (key === 'exportedAt') _validateV2MetadataValue(value, 'import.exportedAt');
    else if (!topLevelKeys.has(key)) _validateV2MetadataValue(value, 'import.' + key);
  }
  // Legacy exports historically omitted folders; only that schema-less shape defaults to [].
  const folders = data.folders === undefined && isLegacy ? [] : data.folders;
  if (!Array.isArray(folders)) _importReject('folders must be an array');
  const folderIds = new Set();
  folders.forEach((folder, index) => {
    _validateV2MetadataValue(folder, (isLegacy ? 'legacy' : 'v2') + ' folder ' + index);
    _validateImportFolder(folder, folderIds);
  });
  const noteIds = new Set();
  const notes = data.notes.map((bundle, index) => {
    if (isLegacy) {
      _validateImportNote(bundle, noteIds, 'legacy note ' + index);
      return { note: _normaliseImportedNote(bundle), id: bundle.id };
    }
    if (!_importObject(bundle) || !_importObject(bundle.note) || !Array.isArray(bundle.images)) {
      _importReject('v2 note bundle must contain note and images[]');
    }
    for (const [key, value] of Object.entries(bundle)) {
      if (key !== 'note' && key !== 'images') _validateV2MetadataValue(value, 'v2 note bundle.' + key);
    }
    const htmlMarkers = _validateDetachedNote(bundle.note);
    _validatePortableImages(bundle.images, htmlMarkers);
    _validateImportNote(bundle.note, noteIds, 'v2 note ' + index);
    return { note: _normaliseImportedNote(bundle), id: bundle.note.id };
  });
  return { folders, notes };
}

function _normaliseImportedNote(bundle) {
  const source = bundle && bundle.note && typeof bundle.note === 'object' ? bundle.note : bundle;
  const note = typeof noteImageClone === 'function'
    ? noteImageClone(source || {})
    : Object.assign({}, source || {});
  const portableImages = Array.isArray(bundle?.images)
    ? bundle.images
    : [];
  delete note.note;
  delete note.images;
  delete note.imageRecord;
  for (const image of portableImages) {
    if (!image || !image.field || !Number.isInteger(image.index)) continue;
    const dataUrl = image.dataUrl || image.dataURL || image.imageBase64;
    if (typeof dataUrl !== 'string' || !dataUrl) continue;
    const marker = image.markerId;
    if (marker && typeof note.notesHtml === 'string') {
      note.notesHtml = note.notesHtml.replace(/<img\b[^>]*>/gi, whole => {
        const markerMatch = /data-note-image-ref\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/i.exec(whole);
        const foundMarker = markerMatch ? (markerMatch[2] !== undefined ? markerMatch[2] : markerMatch[3]) : '';
        if (foundMarker !== marker) return whole;
        const sourceMatch = /\bsrc\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))/i.exec(whole);
        const currentSource = sourceMatch ? (sourceMatch[2] !== undefined ? sourceMatch[2] : sourceMatch[3]) : '';
        if (sourceMatch && currentSource.trim()) return whole;
        if (sourceMatch) {
          return whole.replace(/\bsrc\s*=\s*(?:(["'])[^"']*\1|[^\s>]+)/i, 'src="' + dataUrl + '"');
        }
        return whole.replace(/>$/, ' src="' + dataUrl + '">');
      });
    }
    if (image.field === 'html') {
      continue;
    }
    if (!Array.isArray(note[image.field])) note[image.field] = [];
    const metadata = {};
    for (const key of _IMPORT_IMAGE_METADATA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(image, key)) metadata[key] = image[key];
    }
    note[image.field][image.index] = Object.assign({}, note[image.field][image.index] || {}, metadata, {
      imageBase64: dataUrl,
      mimeType: image.mimeType || note[image.field][image.index]?.mimeType || 'application/octet-stream',
    });
  }
  return note;
}

async function importNotes(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const plan = _buildImportPlan(data);
    const notes = plan.notes;
    const folders = plan.folders;
    const [existingNotes, existingFolders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
    const existingNoteIds   = new Set(existingNotes.map(n => n.id));
    const existingFolderIds = new Set(existingFolders.map(f => f.id));
    let imported = 0;
    for (const folder of folders) {
      if (!existingFolderIds.has(folder.id)) {
        await saveFolderFS(folder);
        existingFolderIds.add(folder.id);
      }
    }
    for (const item of notes) {
      const note = item.note;
      if (!existingNoteIds.has(note.id)) {
        const saveResult = await saveNoteFS(note);
        showImageDegradationWarning(saveResult);
        existingNoteIds.add(note.id);
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
