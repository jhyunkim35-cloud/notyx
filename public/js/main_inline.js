// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// auth state listener + updateAuthUI/loginWithGoogle/logout moved to /js/main.js and /js/firebase_auth.js

// updateAuthUI moved to /js/firebase_auth.js

// loginWithGoogle moved to /js/firebase_auth.js

// logout moved to /js/firebase_auth.js

// Firestore sync moved to /js/firestore_sync.js

// showPaymentModal moved to /js/payment.js

// startPayment moved to /js/payment.js

// Firestore sync moved to /js/firestore_sync.js

// Constants, state, DOM refs, Firebase init moved to /js/constants.js
// PDF.js loader + PPTX/PDF parsers moved to /js/pptx_parser.js

// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// Constants, state, DOM refs, Firebase init moved to /js/constants.js
let dragSrcRecId   = null;
let draggedNoteId  = null;       // id of the note being dragged (legacy, kept for safety)

// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// File handling + multi-recording slot management moved to /js/pptx_parser.js

// renderRecSlots moved to /js/pptx_parser.js

/* ── Zone-level drop: drop .txt file(s) to auto-add slots ── */
{
  const zone = document.getElementById('multiRecZone');
  zone.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      zone.classList.add('drag-over');
    }
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (!e.dataTransfer.types.includes('Files')) return;
    const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.txt'));
    if (!files.length) { showToast('⚠️ .txt 파일만 업로드할 수 있습니다.'); return; }
    files.forEach(f => addRecSlot(f));
  });
}

document.getElementById('addRecBtn').addEventListener('click', () => addRecSlot());
document.getElementById('sortRecBtn')?.addEventListener('click', () => {
  if (typeof sortRecSlotsByName === 'function') {
    sortRecSlotsByName();
    showToast('📑 파일명 순으로 정렬했습니다');
  }
});
document.getElementById('recordBtn').addEventListener('click', () => {
  if (typeof window.openRecorderModal === 'function') window.openRecorderModal();
});

/* U1: paste-text memo — smallest modal, reuses .db-modal-overlay/.db-modal CSS
   (same classes as appConfirm/appPrompt in ui.js) with a textarea swapped in for
   the single-line input. Confirm wraps the text as a .txt File and feeds it
   through the exact same setRecSlotFile/addRecSlot path the file picker uses. */
document.getElementById('pasteMemoBtn').addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.innerHTML = `
    <div class="db-modal" style="max-width:480px;">
      <h3>📝 텍스트 붙여넣기</h3>
      <textarea id="memoPasteInput" rows="10" placeholder="강의 내용을 붙여넣거나 직접 입력하세요" style="width:100%; box-sizing:border-box; padding:0.6rem 0.7rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.88rem; font-family:inherit; resize:vertical;"></textarea>
      <div class="db-modal-footer" style="justify-content:flex-end;">
        <button id="memoPasteCancel" style="background:var(--surface3); color:var(--text); border:1px solid var(--border);">취소</button>
        <button id="memoPasteOk">추가</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector('#memoPasteInput');
  const close = () => overlay.remove();
  overlay.querySelector('#memoPasteCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#memoPasteOk').addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) { showToast('⚠️ 붙여넣을 텍스트를 입력하세요.'); return; }
    const file = new File([text], '메모.txt', { type: 'text/plain' });
    const emptySlot = txtFiles.find(s => s.file === null);
    if (emptySlot) setRecSlotFile(emptySlot.id, file);
    else addRecSlot(file);
    close();
    showToast('📝 메모가 녹취록으로 추가되었습니다.');
  });
  setTimeout(() => ta.focus(), 50);
});

// Screen Wake Lock is auto-released when the tab is hidden, so re-acquire it
// when the user returns mid-generation. Also flag that a background trip
// happened during generation so we can warn that a mobile browser may have
// suspended (and interrupted) the streaming request while we were away.
document.addEventListener('visibilitychange', () => {
  const generating = (typeof isRunning !== 'undefined' && isRunning) ||
                     (typeof _batchRunning !== 'undefined' && _batchRunning);
  if (document.hidden) {
    if (generating) _genWasHidden = true;
  } else if (generating) {
    acquireWakeLock();
    if (_genWasHidden) {
      _genWasHidden = false;
      showToast('⚠️ 화면을 벗어난 사이 생성이 멈췄을 수 있어요. 진행이 안 보이면 다시 시도해주세요.');
    }
  } else {
    _genWasHidden = false;
  }
});

// Home-page record button — same handler as the new-note record button,
// but the modal logic in recorder.js detects _currentView and skips the
// "auto-add a new rec slot" branch when fired from home (the transcript is
// saved to the store either way).
document.getElementById('homeRecordBtn').addEventListener('click', () => {
  if (typeof window.openRecorderModal === 'function') window.openRecorderModal();
});

document.getElementById('pptInput').addEventListener('change', e => {
  // U8: pptInput now allows multi-select (images = pages of one lecture) —
  // pass the whole FileList so onPptChange can tell single vs multiple apart.
  if (e.target.files.length) onPptChange(e.target.files);
});


setupDrop('pptZone', onPptChange);

// setupDrop + checkReady moved to /js/pptx_parser.js

// extractPresentationText + all parse functions moved to /js/pptx_parser.js

// findSlideRelationships moved to /js/pptx_parser.js

// extractChartData moved to /js/pptx_parser.js

// extractDiagramText moved to /js/pptx_parser.js

// extractPptxText moved to /js/pptx_parser.js

// extractSlideContent + extractPptxImages + extractPdfText + extractPdfPageImages + separateSpeakers moved to /js/pptx_parser.js

// callClaudeOnce + callClaudeStream moved to /js/api.js

/* ═══════════════════════════════════════════════
   Image gallery — render / recommend / insert
═══════════════════════════════════════════════ */
// insertImagesIntoNotes + image gallery functions moved to /js/image_gallery.js
// populateSplitImagePanel moved to /js/viewers.js
// showSuccessToast moved to /js/ui.js

document.getElementById('imageConfirmBtn').addEventListener('click', () => {
  const selected = [];
  document.querySelectorAll('.image-thumb-wrap').forEach(wrap => {
    const cb = wrap.querySelector('.image-thumb-cb');
    if (cb.checked) selected.push(extractedImages[parseInt(wrap.dataset.index)]);
  });
  if (!selected.length) { showToast('선택된 이미지가 없습니다.'); return; }

  selected.sort((a, b) => a.slideNumber - b.slideNumber);
  insertImagesIntoNotes(selected);

  // UX fix: keep the bar visible so users can adjust and re-insert.
  // Just flash the button briefly instead of hiding the bar.
  const btn = document.getElementById('imageConfirmBtn');
  btn.textContent = `✅ ${selected.length}개 삽입됨`;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = '✅ 선택 완료 — 노트에 삽입';
    btn.disabled = false;
    document.getElementById('imageSelectionHint').textContent =
      '선택을 바꾸고 다시 삽입할 수 있습니다.';
  }, 2000);

  showToast(`✅ ${selected.length}개 이미지가 노트에 삽입되었습니다.`);
});

/* ═══════════════════════════════════════════════
   Main analysis flow — runs everything automatically
═══════════════════════════════════════════════ */
analyzeBtn.addEventListener('click', runSingleNoteAnalysis);
// analyzeBtn handler body moved to /js/note_creation.js

document.getElementById('cancelBtn').addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
    agentLog(0, '사용자가 분석을 취소했습니다.');
    stopElapsedTimer();
  }
});

// R6: hero 카드의 요약 재생성 버튼 — 단일 노트 뷰 전제 (regenerateSummary 참고)
document.getElementById('summaryRegenBtn')?.addEventListener('click', regenerateSummary);

// R8+R9: 학습 도구 카드 탭 칩 — 클릭 시 탭 전환 + 해당 탭 렌더 (pipeline.js)
document.querySelectorAll('.study-tools-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    currentStudyToolsTab = chip.dataset.tool;
    renderStudyToolsBody();
  });
});

/* ═══════════════════════════════════════════════
   Debug report
═══════════════════════════════════════════════ */
// copyDebugReport moved to /js/ui.js

// transformToNotionToggles, copyToNotionClipboard, bulkNotionCopy, showNotionReorderModal, executeNotionBulkCopy, buildNotionToggleHtml, generateNotionHtmlFile moved to /js/notion_clipboard.js

/* ═══════════════════════════════════════════════
   Download button handlers
═══════════════════════════════════════════════ */
copyNotesBtn.addEventListener('click', async () => {
  const text = document.getElementById('finalNotesBody').innerText;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = Object.assign(document.createElement('textarea'), { value: text, style: 'position:fixed;opacity:0' });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  copyNotesBtn.textContent = '✅ 복사됨!';
  setTimeout(() => { copyNotesBtn.textContent = '📋 복사'; }, 2000);
});

notionCopyBtn.addEventListener('click', async (e) => {
  const bodyEl     = document.getElementById('finalNotesBody');
  const html       = (bodyEl.querySelector('.md-content') || bodyEl).innerHTML;
  const useToggles = !e.shiftKey;
  await copyToNotionClipboard(html, storedNotesText || '', useToggles);
  notionCopyBtn.textContent = '✅ 복사됨!';
  setTimeout(() => { notionCopyBtn.textContent = '📋 노션'; }, 2000);
});

dlNotionFileBtn.addEventListener('click', () => {
  const bodyEl  = document.getElementById('finalNotesBody');
  const rawHtml = (bodyEl.querySelector('.md-content') || bodyEl).innerHTML;
  const title   = document.getElementById('notesCardTitle').textContent.replace(/^📚\s*/, '').trim() || '노트';
  const noteObj = { title, notesHtml: rawHtml, notesText: storedNotesText || '' };
  generateNotionHtmlFile([noteObj], `노트_${dateStamp()}.html`);
  dlNotionFileBtn.textContent = '✅ 저장됨';
  setTimeout(() => { dlNotionFileBtn.textContent = '📄 노션파일'; }, 2000);
});

document.getElementById('splitNotionBtn').addEventListener('click', async (e) => {
  const splitEl    = document.getElementById('splitNotes');
  const html       = splitEl ? (splitEl.querySelector('.md-content') || splitEl).innerHTML : '';
  await copyToNotionClipboard(html, storedNotesText || '', !e.shiftKey);
});

dlTxtBtn.addEventListener('click', () => {
  triggerDownload(document.getElementById('finalNotesBody').innerText, `학습노트_${dateStamp()}.txt`);
  dlTxtBtn.textContent = '✅ 저장됨';
  setTimeout(() => { dlTxtBtn.textContent = '⬇ .txt'; }, 2000);
});

dlMdBtn.addEventListener('click', () => {
  triggerDownload(storedNotesText, `학습노트_${dateStamp()}.md`);
  dlMdBtn.textContent = '✅ 저장됨';
  setTimeout(() => { dlMdBtn.textContent = '⬇ .md'; }, 2000);
});

dlPdfBtn.addEventListener('click', () => {
  openPdfPopup(document.getElementById('finalNotesBody'));
});

// Quiz functions (tryExtractJsonObject through launchQuiz) moved to /js/quiz.js

// Cost-splitting groups: open modal with sensible defaults derived from current note.
// Phase 3B-4: audio path is now auto-fetched from the saved note doc rather
// than typed by the user. Notes without a recording (legacy or PPT-only)
// silently fail closed with a friendly toast.
document.getElementById('shareGroupBtn')?.addEventListener('click', async () => {
  if (typeof openGroupCreateModal !== 'function') {
    showToast('그룹 기능 로드 실패 — 새로고침 후 다시 시도해주세요');
    return;
  }
  let lectureName = '';
  if (typeof storedNotesText === 'string' && storedNotesText) {
    const h1 = storedNotesText.match(/^#\s+(.+)$/m);
    if (h1) lectureName = h1[1].replace(/\*\*/g, '').trim().slice(0, 100);
  }
  if (!lectureName) {
    lectureName = document.getElementById('pptTagName')?.textContent?.trim() || '';
  }
  // Pull audioStoragePath from the saved note doc. Fall back gracefully
  // when there's no current note (just-finished pipeline before save) or
  // the doc fetch fails — modal's own gate will toast in that case.
  let audioStoragePath = null;
  if (typeof currentNoteId !== 'undefined' && currentNoteId && typeof getNoteFS === 'function') {
    try {
      const note = await getNoteFS(currentNoteId);
      if (note && typeof note.audioStoragePath === 'string' && note.audioStoragePath.startsWith('users/')) {
        audioStoragePath = note.audioStoragePath;
      }
    } catch (e) {
      console.warn('[shareGroup] note fetch failed', e);
    }
  }
  // Fallback for the brand-new-note window: pipeline just finished, autoSave
  // hasn't run yet, so the path is still in the recorder cache.
  if (!audioStoragePath && window.recorderLastAudioPath) {
    audioStoragePath = window.recorderLastAudioPath;
  }
  if (!audioStoragePath) {
    showToast('이 노트는 녹음 파일이 없어 공유할 수 없어요 (녹음으로 만든 노트만 가능)');
    return;
  }
  openGroupCreateModal({
    noteId: typeof currentNoteId !== 'undefined' ? currentNoteId : null,
    lectureName,
    totalCost: 1500,
    expectedMinutes: 90,
    audioStoragePath,
  });
});

// Named so the logged-out demo can open the same viewer directly:
// #splitViewBtn is disabled+hidden after switchView('new') (ui.js), and a
// disabled button fires no click, so a synthetic click cannot reach this.
async function openSplitViewer() {
  const splitViewer = document.getElementById('splitViewer');
  const splitSlides = document.getElementById('splitSlides');
  const splitNotes  = document.getElementById('splitNotes');

  splitNotes.innerHTML = document.getElementById('finalNotesBody').innerHTML;
  // Round 1: convert "p.N" / "p.N-M" text refs into clickable slide-jump anchors.
  linkifySlideRefs(splitNotes);
  // Clear stale secondary-tab content so each re-open re-populates from fresh stored data
  document.getElementById('splitTranscript').innerHTML = '';
  document.getElementById('splitAccordion').innerHTML = '';
  document.getElementById('classifyArea').innerHTML = '';
  _classifyCache = null;

  splitSlides.innerHTML = '';
  if (extractedImages.length) {
    const sortedImages = [...extractedImages].sort((a, b) => a.slideNumber - b.slideNumber);
    const seen = new Set();
    for (const img of sortedImages) {
      if (seen.has(img.slideNumber)) continue;
      seen.add(img.slideNumber);
      const wrap = document.createElement('div');
      wrap.className = 'split-slide-item';
      wrap.dataset.slideNumber = String(img.slideNumber);
      const imgEl = document.createElement('img');
      imgEl.src = getImgSrc(img);
      wrap.appendChild(imgEl);
      const label = document.createElement('div');
      label.className = 'slide-label';
      label.textContent = `슬라이드 ${img.slideNumber}`;
      wrap.appendChild(label);
      splitSlides.appendChild(wrap);
    }
  } else if (pptFile && pptFile.name.toLowerCase().endsWith('.pdf')) {
    try {
      const pdfjs = await getPdfjsLib();
      const arrayBuffer = await pptFile.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const wrap = document.createElement('div');
        wrap.className = 'split-slide-item';
        wrap.dataset.slideNumber = String(i);
        const imgEl = document.createElement('img');
        imgEl.src = canvas.toDataURL();
        wrap.appendChild(imgEl);
        const label = document.createElement('div');
        label.className = 'slide-label';
        label.textContent = `슬라이드 ${i}`;
        wrap.appendChild(label);
        splitSlides.appendChild(wrap);
      }
      pdf.destroy();
    } catch (e) {
      showToast(`❌ PDF 슬라이드 렌더링 오류: ${e.message}`);
      debugLog('UI', `Split viewer PDF render error: ${e.message}`);
    }
  }

  // Transcript-only / text-only notes have no slides — say so instead of
  // leaving a silent blank pane that reads as a rendering failure.
  if (!splitSlides.children.length) {
    splitSlides.innerHTML =
      '<div class="split-no-slides"><i data-lucide="mic" style="width:26px;height:26px;"></i>' +
      '<div>슬라이드 없는 노트</div><span>녹취록·텍스트만으로 만든 노트예요</span></div>';
  }

  populateSplitImagePanel();
  // Round 2: bind IntersectionObserver to mark the currently-visible slide.
  initActiveSlideObserver();
  // Round 3: clicking a slide in the left list jumps notes to its first p.N ref.
  initSlideListClickHandler();
  // Round 6: reset ask state for this note + init the selection-based question feature.
  const splitAsk = document.getElementById('splitAsk');
  if (splitAsk) {
    splitAsk._history = [];
    splitAsk._context = null;
    splitAsk._pendingContext = null;
    splitAsk.innerHTML = '';
  }
  initAskFeature();
  closeSidebar();
  // #debugToggle is hidden by CSS when logged out; this one is not, and
  // copyDebugReport (ui.js) dumps pipeline internals.
  const _dbgBtn = document.getElementById('splitDebugBtn');
  if (_dbgBtn && (typeof currentUser === 'undefined' || !currentUser)) _dbgBtn.style.display = 'none';
  splitViewer.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  debugLog('UI', 'Split viewer opened');
}
splitViewBtn.addEventListener('click', openSplitViewer);

document.getElementById('splitCloseBtn').addEventListener('click', () => {
  // Logged-out demo: the viewer IS the whole experience, so closing must not
  // fall through to switchView('home') and uncover the app shell.
  if (window.nyDemoActive) { closeNotyxDemo(); return; }
  const _sqArea = document.getElementById('quizInlineArea');
  if (_sqArea && _sqArea._quizApi) _sqArea._quizApi.savePartialIfEligible();
  document.getElementById('splitViewer').style.display = 'none';
  document.body.style.overflow = '';
  switchView('home');
});

// Round 1: delegate p.N anchor clicks anywhere inside the split viewer to jumpToSlide.
// R7: page-cite-chip buttons carry the same data-slide-start dataset, so a
// click there also scrolls the left slide list (in addition to opening the
// slide-cite overlay via the document-level listener in ui.js).
document.getElementById('splitViewer').addEventListener('click', (e) => {
  const a = e.target.closest('a.slide-ref, .page-cite-chip');
  if (!a) return;
  e.preventDefault();
  const start = parseInt(a.dataset.slideStart, 10);
  if (!isNaN(start)) jumpToSlide(start);
});


// switchSplitTab, buildAccordionView moved to /js/viewers.js

document.getElementById('splitPdfBtn').addEventListener('click', () => {
  openPdfPopup(document.getElementById('splitNotes'));
});


// openPdfPopup moved to /js/viewers.js

// Collapse/expand IIFE moved to /js/ui.js

// dateStamp, triggerDownload moved to /js/ui.js

/* ═══════════════════════════════════════════════
   Progress bar
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// setProgress moved to /js/ui.js

/* tab switching — kept generic in case tabs are added later */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    btn.closest('.agent-tabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.closest('.agent-tabs').querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

/* ═══════════════════════════════════════════════
   Agent metadata (icon + name per agent)
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

/* ═══════════════════════════════════════════════
   Activity feed
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// agentLog + activity/timer/pipeline UI functions moved to /js/ui.js

/* ═══════════════════════════════════════════════
   Agent pipeline orchestration (critic loop)
═══════════════════════════════════════════════ */
// Pipeline functions (runAgentPipeline + agents) moved to /js/pipeline.js

/* ═══════════════════════════════════════════════
   Batch mode
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

/* Mode switching */
document.getElementById('modeSingle').addEventListener('click', () => setMode('single'));
document.getElementById('modeBatch').addEventListener('click',  () => setMode('batch'));

// setMode moved to /js/batch.js

/* Batch PPT input */
document.getElementById('batchPptInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const n = f.name.toLowerCase();
  if (!n.endsWith('.pptx') && !n.endsWith('.pdf') && !n.endsWith('.docx')) {
    showToast('⚠️ .pptx, .pdf 또는 .docx 파일만 업로드할 수 있습니다.');
    return;
  }
  if (f.size > MAX_FILE_SIZE_BYTES) {
    showToast(`⚠️ 파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
    e.target.value = '';
    return;
  }
  if (f.size > WARN_FILE_SIZE_BYTES) {
    if (!await appConfirm(`파일 크기가 ${(f.size / 1024 / 1024).toFixed(0)}MB입니다. 처리 시간이 길어질 수 있습니다. 계속하시겠습니까?`)) {
      e.target.value = '';
      return;
    }
  }
  batchPptStaging = f;
  const btn = document.getElementById('batchPptBtn');
  btn.classList.add('has-file');
  btn.querySelector('.batch-file-btn-label').textContent = f.name;
  checkAddPairReady();
});

// addBatchSession + removeBatchSession + renderBatchSessions + checkAddPairReady moved to /js/batch.js

document.getElementById('addSessionBtn').addEventListener('click', addBatchSession);

/* Event delegation for session list (file change, prof select, remove) */
document.getElementById('batchSessionList').addEventListener('change', e => {
  const sessionId = parseInt(e.target.dataset.sessionId, 10);
  if (!sessionId) return;
  if (e.target.classList.contains('batch-session-file-input')) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) {
      showToast('⚠️ .txt 파일만 업로드할 수 있습니다.');
      return;
    }
    const session = batchSessionStaging.find(s => s.id === sessionId);
    if (session) session.txtFile = file;
    renderBatchSessions();
    checkAddPairReady();
  } else if (e.target.classList.contains('batch-session-prof-select')) {
    const session = batchSessionStaging.find(s => s.id === sessionId);
    if (session) session.professorNum = Number(e.target.value);
  }
});

document.getElementById('batchSessionList').addEventListener('click', e => {
  const btn = e.target.closest('.batch-session-remove');
  if (!btn) return;
  const sessionId = parseInt(btn.dataset.sessionId, 10);
  removeBatchSession(sessionId);
});

/* Event delegation for batch queue (remove + name input) */
document.getElementById('batchQueue').addEventListener('click', e => {
  const btn = e.target.closest('.batch-item-remove');
  if (!btn) return;
  const id = parseInt(btn.dataset.itemId, 10);
  removeBatchItem(id);
});

document.getElementById('batchQueue').addEventListener('input', e => {
  if (!e.target.classList.contains('batch-item-name-input')) return;
  const id = parseInt(e.target.dataset.itemId, 10);
  updateBatchItemName(id, e.target.value);
});

// U14: per-card folder select — lets the user change a queued item's save
// destination while it's still 대기 중 (the select is only rendered for
// waiting items; see renderBatchQueue).
document.getElementById('batchQueue').addEventListener('change', e => {
  if (!e.target.classList.contains('batch-item-folder-select')) return;
  const id = parseInt(e.target.dataset.itemId, 10);
  const item = batchQueue.find(i => i.id === id);
  if (item) item.folderId = e.target.value || null;
});

document.getElementById('addPairBtn').addEventListener('click', () => {
  if (!batchPptStaging && !batchSessionStaging.some(s => s.txtFile)) {
    showToast('발표 자료 또는 녹취록 중 하나 이상 업로드하세요.');
    return;
  }
  const defaultName = batchPptStaging
    ? batchPptStaging.name.replace(/\.[^.]+$/, '')
    : (batchSessionStaging.find(s => s.txtFile)?.txtFile?.name || '항목').replace(/\.[^.]+$/, '');
  batchQueue.push({
    id: ++batchIdCounter,
    pptFile: batchPptStaging,
    notesName: defaultName,
    sessions: batchSessionStaging.filter(s => s.txtFile).map(s => ({ txtFile: s.txtFile, professorNum: s.professorNum })),
    status: 'waiting',
    folderId: document.getElementById('batchFolderSelect')?.value || null, // U14
  });

  // reset staging
  batchPptStaging = null;
  batchSessionStaging = [];
  const pBtn = document.getElementById('batchPptBtn');
  pBtn.classList.remove('has-file');
  pBtn.querySelector('.batch-file-btn-label').textContent = 'PPT / PDF 파일 선택';
  document.getElementById('batchPptInput').value = '';
  document.getElementById('batchSessionList').innerHTML = '';
  addBatchSession(); // pre-populate one session row for the next pair
  checkAddPairReady();
  renderBatchQueue();
  checkBatchReady();

  // Flash the queue so the user sees where the item landed
  const queueEl = document.getElementById('batchQueue');
  queueEl.classList.remove('flash-highlight');
  void queueEl.offsetWidth; // restart animation
  queueEl.classList.add('flash-highlight');
});

// renderBatchQueue + batch result card functions moved to /js/batch.js

/* Batch cancel */
document.getElementById('batchCancelBtn').addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
    agentLog(0, '사용자가 다중 노트를 취소했습니다.');
    stopElapsedTimer();
  }
});

/* Run batch */
document.getElementById('batchStartBtn').addEventListener('click', async () => {
  if (!currentUser) { showToast('🔑 로그인 후 이용할 수 있습니다.'); return; }
  if (isRunning) return;
  const usageCheck = await canAnalyze();
  if (!usageCheck.allowed) { showPaymentModal(); return; }
  const apiKey = 'server-proxied';

  const pending = batchQueue.filter(item => item.status === 'waiting');
  if (pending.length === 0) return;

  isRunning = true;
  abortController = new AbortController();

  // Keep the screen awake across the (possibly long) batch run so a mobile
  // auto-lock doesn't suspend the page and kill the streaming requests.
  acquireWakeLock();
  _genWasHidden = false;
  if (isMobileDevice()) showToast('📱 생성 중에는 화면을 켜두세요 — 화면을 벗어나면 중단될 수 있어요.');

  const batchStartBtn  = document.getElementById('batchStartBtn');
  const batchCancelBtn = document.getElementById('batchCancelBtn');
  batchStartBtn.disabled = true;
  batchCancelBtn.classList.add('visible');

  // Clear only cards that belong to pending items (preserve done cards from prior partial run)
  const pendingIds = new Set(pending.map(p => String(p.id)));
  document.querySelectorAll('.batch-result-card').forEach(card => {
    if (pendingIds.has(card.dataset.itemId)) card.remove();
  });

  resultsEl.classList.add('visible');
  document.getElementById('agentSection').classList.add('visible');

  setTimeout(() => resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);

  let failCount = 0;
  let firstSuccessData = null;

  try {
    for (let i = 0; i < pending.length; i++) {
      if (abortController.signal.aborted) break;

      const item = pending[i];

      // CHANGE 1: per-item payment check
      const itemUsageCheck = await canAnalyze();
      if (!itemUsageCheck.allowed) {
        item.status = 'error';
        errorCard(item, '이용 한도 초과');
        failCount++;
        renderBatchQueue();
        showToast('이용 한도를 초과하여 다중 노트를 중단합니다.');
        break;
      }

      item.status = 'processing';
      renderBatchQueue();
      updateBatchProgress(i + 1, pending.length);
      setProgress(5 + Math.round(i / pending.length * 85), `${pending.length}개 중 ${i + 1}번째 처리 중…`);

      // Create a dedicated card for this lecture; pipeline streams into its body
      const cardBodyEl = createBatchResultCard(item, i);
      if (isBatchMode) agentLog(0, `══════ ${i + 1}/${pending.length}: ${escHtml(item.notesName || 'item')} ══════`);

      // CHANGE 3a: snapshot global state before processing this item
      const prevPptText      = storedPptText;
      const prevFilteredText = storedFilteredText;
      const prevNotesText    = storedNotesText;
      const prevImages       = extractedImages;

      try {
        setProgress(5 + Math.round(i / pending.length * 85), `${i + 1}번째: 파일 읽는 중…`);
        const pptText = item.pptFile ? await extractPresentationText(item.pptFile) : '';
        let filteredParts = [];
        if (item.sessions && item.sessions.length > 0) {
          for (const sess of item.sessions) {
            if (!sess.txtFile) continue;
            const sessText = await sess.txtFile.text();
            const sessSeparated = separateSpeakers(sessText, sess.professorNum || 1);
            filteredParts.push(sessSeparated.text);
          }
        } else if (item.txtFile) {
          const raw = await item.txtFile.text();
          const sep = separateSpeakers(raw, 1);
          filteredParts.push(sep.text);
        }
        const separatedText = filteredParts.join('\n\n');
        storedPptText = pptText;

        // CHANGE 2: extract images for this item
        extractedImages = [];
        if (item.pptFile) {
          try {
            const isPdf = item.pptFile.name.toLowerCase().endsWith('.pdf');
            extractedImages = isPdf
              ? await extractPdfPageImages(item.pptFile)
              : await extractPptxImages(item.pptFile);
          } catch (imgErr) {
            if (imgErr.name === 'AbortError' || imgErr.name === 'PageLimitError') throw imgErr;
            console.warn('Batch image extraction:', imgErr.message);
          }
        }

        storedFilteredText = separatedText;
        storedNotesText    = ''; // reset so previous item's notes don't leak into this pipeline

        // Full agent loop streams into this lecture's card body
        await runAgentPipeline(apiKey, cardBodyEl);

        // storedNotesText is now the final notes for this item
        finalizeCard(item, storedNotesText);
        item.status = 'done';

        // Auto-save this item
        const itemName = item.notesName || (item.pptFile?.name || '항목').replace(/\.[^.]+$/, '');
        const batchBodyHtml = document.getElementById('batchBody_' + item.id)?.innerHTML || '';
        // GUARD: prevent ghost notes — skip if title or content is empty
        const _t = itemName.trim();
        const _c = (storedNotesText || '').trim();
        if (!_t || !_c) {
          console.warn('[batch] skipped empty note save for item', item?.notesName || '(no name)');
        } else {
          // U14: save straight into the folder chosen for this queue item
          // (staging default or per-card override), with a sortOrder so it
          // doesn't sit at Infinity vs manually-ordered notes in that folder.
          const itemFolderId = item.folderId || null;
          await saveNoteFS({
            title: itemName,
            folderId: itemFolderId,
            sortOrder: await getNextSortOrder(itemFolderId),
            notesText: storedNotesText,
            notesHtml: batchBodyHtml,
            pptText: storedPptText,
            filteredText: storedFilteredText,
            extractedImages: [...(extractedImages || [])],
            summaryLayers: currentSummaryLayers || null,  // R4: batch path parity with autoSaveNote
          }).then(() => renderHomeView()).catch(e => console.error('[batch] save failed:', e));
        }
        // Usage is now incremented server-side by /api/claude on first call.

        // Track first success for split viewer
        if (!firstSuccessData) {
          firstSuccessData = {
            notesText: storedNotesText,
            notesHtml: batchBodyHtml,
            pptText: storedPptText,
            filteredText: storedFilteredText,
            extractedImages: [...(extractedImages || [])],
          };
        }
        // Update background progress bar after successful completion
        _batchProgress.done = i + 1;
        updateBatchBuddy();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        item.status = 'error';
        failCount++;
        // CHANGE 3b: restore global state to pre-item snapshot on failure
        storedPptText      = prevPptText;
        storedFilteredText = prevFilteredText;
        storedNotesText    = prevNotesText;
        extractedImages    = prevImages;
        errorCard(item, err.message);
        showToast(`❌ ${i + 1}번째 오류: ${err.message}`);
        agentLog(0, `오류: ${err.message}`);
        // Update background progress bar after error too
        _batchProgress.done = i + 1;
        updateBatchBuddy();
      }

      renderBatchQueue();
    }

    setProgress(100, '완료!');
    setTimeout(() => setProgress(null), 800);
    finalizeBatchProgress(pending.length, failCount);

    // Auto-open split viewer with first successful result
    if (firstSuccessData) {
      storedNotesText    = firstSuccessData.notesText;
      storedPptText      = firstSuccessData.pptText;
      storedFilteredText = firstSuccessData.filteredText;
      extractedImages    = firstSuccessData.extractedImages;
      const finalBody = document.getElementById('finalNotesBody');
      if (finalBody) finalBody.innerHTML = firstSuccessData.notesHtml;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // splitViewBtn may be disabled in batch mode; enable it temporarily so the click fires
      const splitBtn = document.getElementById('splitViewBtn');
      if (splitBtn) {
        const wasDisabled = splitBtn.disabled;
        splitBtn.disabled = false;
        splitBtn.click();
        splitBtn.disabled = wasDisabled;
      }
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      // Reset any items still stuck in 'processing' so they can be retried
      batchQueue.filter(it => it.status === 'processing').forEach(it => { it.status = 'waiting'; });
      renderBatchQueue();
      checkBatchReady();
      showToast('다중 노트가 취소되었습니다.');
      setProgress(null);
    } else {
      console.error(err);
      showToast(`❌ 오류: ${err.message}`);
      setProgress(null);
    }
  } finally {
    isRunning = false;
    _batchRunning = false;
    abortController = null;
    releaseWakeLock();
    _genWasHidden = false;
    batchCancelBtn.classList.remove('visible');
    // Hide buddy and go-home button on any exit path
    const _bar = document.getElementById('batchBuddy');
    if (_bar) _bar.style.display = 'none';
    const _goHomeRow = document.getElementById('batchGoHomeRow');
    if (_goHomeRow) _goHomeRow.style.display = 'none';
    checkBatchReady();
  }
});

/* ═══════════════════════════════════════════════
   Image analysis mode controls
═══════════════════════════════════════════════ */
document.getElementById('imgModeToggleBtn').addEventListener('click', () => {
  imageAnalysisMode = imageAnalysisMode === 'text' ? 'vision' : 'text';
  const btn     = document.getElementById('imgModeToggleBtn');
  const costEl  = document.getElementById('imgCostWarning');
  const modelEl = document.getElementById('imgModelSelector');

  if (imageAnalysisMode === 'vision') {
    btn.classList.add('active');
    costEl.classList.add('visible');
    modelEl.classList.add('visible');
    updateVisionCostEstimate();
  } else {
    btn.classList.remove('active');
    costEl.classList.remove('visible');
    modelEl.classList.remove('visible');
    updateModeBadge('text');
    // Re-apply Mode 1 heuristic to clear stale Mode 2 selections
    if (extractedImages.length) {
      document.querySelectorAll('.image-thumb-wrap').forEach(wrap => {
        const cb = wrap.querySelector('.image-thumb-cb');
        cb.checked = false;
        wrap.classList.remove('selected', 'recommended');
      });
      recommendImagesMode1();
    }
  }
});

document.getElementById('imgModelHaiku').addEventListener('click', () => {
  visionModel = 'haiku';
  document.getElementById('imgModelHaiku').classList.add('active');
  document.getElementById('imgModelSonnet').classList.remove('active');
  updateVisionCostEstimate();
});

document.getElementById('imgModelSonnet').addEventListener('click', () => {
  visionModel = 'sonnet';
  document.getElementById('imgModelSonnet').classList.add('active');
  document.getElementById('imgModelHaiku').classList.remove('active');
  updateVisionCostEstimate();
});

document.getElementById('imgVisionRunBtn').addEventListener('click', async () => {
  const apiKey = 'server-proxied';
  if (!extractedImages.length) { showToast('분석할 이미지가 없습니다.'); return; }
  if (!storedNotesText) { showToast('먼저 AI 분석을 실행해주세요.'); return; }
  try {
    await recommendImagesWithVision(apiKey, storedNotesText);
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('이미지 분석이 취소되었습니다.');
    } else {
      console.error('imgVisionRunBtn 오류:', e);
      showToast(`❌ AI 이미지 분석 오류: ${e.message}`);
    }
  }
});

/* ═══════════════════════════════════════════════
   Toast helper
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js
// showToast moved to /js/ui.js

// IndexedDB layer moved to /js/storage.js

// IndexedDB layer moved to /js/storage.js

// promptNoteName, autoSaveNote moved to /js/notes_crud.js

// fmtDate moved to /js/notes_crud.js

// openSavedNote moved to /js/notes_crud.js

// collectMdFromZip, parseNotionFile moved to /js/notes_crud.js

// openNotionNote, _closeNotionViewer, _switchNotionTab, updateNotionWeaknessBadges moved to /js/notion_viewer.js

/* ═══════════════════════════════════════════════
   Notion upload handler
═══════════════════════════════════════════════ */
(function initNotionUpload() {
  const fileInput  = document.getElementById('notionFileInput');
  const fileTag    = document.getElementById('notionFileTag');
  const fileTagName = document.getElementById('notionFileTagName');
  const processBtn = document.getElementById('notionProcessBtn');
  let _selectedNotionFile = null;

  if (!fileInput) return;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    _selectedNotionFile = file;
    fileTagName.textContent = file.name;
    fileTag.classList.add('visible');
    processBtn.classList.add('visible');
  });

  processBtn.addEventListener('click', async () => {
    if (!_selectedNotionFile) return;
    processBtn.disabled   = true;
    processBtn.textContent = '처리 중...';

    try {
      const result = await parseNotionFile(_selectedNotionFile);
      if (!result) {
        processBtn.disabled   = false;
        processBtn.textContent = '✨ 퀴즈 노트 생성';
        return;
      }

      const note = {
        id:              uuidv4(),
        title:           result.title,
        type:            'notion',
        markdownContent: result.markdown,
        createdAt:       new Date().toISOString(),
        folderId:        null,
        quizHistory:     [],
      };

      await saveNoteFS(note);
      showSuccessToast('📓 노션 노트 생성 완료');

      // Reset upload UI
      _selectedNotionFile  = null;
      fileInput.value      = '';
      fileTag.classList.remove('visible');
      processBtn.classList.remove('visible');
      processBtn.disabled   = false;
      processBtn.textContent = '✨ 퀴즈 노트 생성';

      // Open the viewer directly
      openNotionNote(note);

      renderHomeView();
    } catch (e) {
      showToast('❌ 노션 파일 처리 실패: ' + e.message);
      processBtn.disabled   = false;
      processBtn.textContent = '✨ 퀴즈 노트 생성';
    }
  });
})();

// confirmDeleteNote moved to /js/notes_crud.js

// moveSavedNote moved to /js/notes_crud.js

// detectNoteSplits moved to /js/notes_crud.js

// showImportNoteModal moved to /js/notes_crud.js

// showFolderManager, refreshFolderManagerList, createFolderFromInput, renameFolderPrompt, showFolderEditModal moved to /js/folders.js

// renameSavedNote moved to /js/notes_crud.js

// deleteFolderConfirm moved to /js/folders.js

// exportAllNotes, importNotes moved to /js/notes_crud.js

/* ═══════════════════════════════════════════════
   Theme toggle
═══════════════════════════════════════════════ */
// toggleTheme moved to /js/ui.js

/* ═══════════════════════════════════════════════
   Settings panel
═══════════════════════════════════════════════ */
// toggleSettings moved to /js/ui.js
document.addEventListener('click', e => {
  const panel = document.getElementById('settingsPanel');
  const btn   = document.getElementById('settingsBtn');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

/* ═══════════════════════════════════════════════
   Sidebar toggle (mobile)
═══════════════════════════════════════════════ */
// toggleSidebar, closeSidebar moved to /js/ui.js

/* ═══════════════════════════════════════════════
   View switching
═══════════════════════════════════════════════ */
// Constants, state, DOM refs, Firebase init moved to /js/constants.js

// switchView moved to /js/ui.js

// buildFolderCard, moveNoteToFolder, renderHomeView, buildNoteCard, attachNoteDrag, renderSidebarFolders, filterByFolder, createFolderFromSidebar moved to /js/home_view.js

/* ═══════════════════════════════════════════════
   Global search (top bar)
═══════════════════════════════════════════════ */
let _globalSearchTimer;
document.getElementById('globalSearchInput').addEventListener('input', function() {
  clearTimeout(_globalSearchTimer);
  const query = this.value.trim();
  _globalSearchTimer = setTimeout(async () => {
    if (_currentView !== 'home') switchView('home');
    if (!query) { renderHomeView(); return; }
    const results = await searchNotesFS(query);
    renderHomeView(results, query);
  }, 300);
});
document.getElementById('globalSearchInput').addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && this.value) {
    e.stopPropagation(); // don't let the global Esc handler close viewers too
    this.value = '';
    this.dispatchEvent(new Event('input'));
    this.blur();
  }
});

// IndexedDB layer moved to /js/storage.js

/* ═══════════════════════════════════════════════
   Keyboard shortcuts
═══════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  // Block browser's Ctrl+S "save page" dialog
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    return;
  }
  // Esc — close split viewer or settings panel
  if (e.key === 'Escape') {
    const splitViewer = document.getElementById('splitViewer');
    if (splitViewer && splitViewer.style.display === 'flex') {
      document.getElementById('splitCloseBtn')?.click();
      return;
    }
    const settings = document.getElementById('settingsPanel');
    if (settings && settings.classList.contains('open')) {
      settings.classList.remove('open');
    }
  }
});

window.addEventListener('beforeunload', e => {
  // Q2: also warn while a recording/upload/STT job is in flight — recorder.js
  // keeps that state module-scoped, so we go through its exposed getter.
  // Q5: also warn while the post-generation silent draft save is still writing —
  // by then isRunning is already false, so without this the tab could still
  // close in the narrow window between "pipeline done" and "draft saved".
  if (isRunning || window.recorderIsActive?.() || _noteSaveInFlight) { e.preventDefault(); e.returnValue = ''; }
});

// toggleBulkSelectMode, _updateBulkBar, toggleBulkSelectAll, bulkExportPdf, bulkDeleteSelected moved to /js/bulk.js

// init() IIFE, initial display state moved to /js/main.js
