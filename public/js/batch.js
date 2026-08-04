// Batch mode: batchBuddy drag IIFE, batch session/queue management, result cards.
// Depends on: constants.js, markdown.js (renderMarkdown, escHtml), ui.js (agentLog, showToast, showSuccessToast, triggerDownload, dateStamp, setProgress), viewers.js (openPdfPopup), pipeline.js (runAgentPipeline), pptx_parser.js (extractPresentationText, separateSpeakers, extractPptxImages, extractPdfPageImages), firestore_sync.js (saveNoteFS, getAllFoldersFS), folders.js (buildFolderSelectOptions), api.js.

// U14: folder list cache for the batch staging select + per-queue-item
// selects. renderBatchQueue() runs synchronously and often (item add/remove,
// status changes), so it reads from this cache instead of re-fetching each
// time. Refreshed whenever multi-mode is entered (see setMode below).
// ponytail: doesn't live-refresh if a folder is created/renamed while
// already in multi mode — re-enter multi mode (or reload) to pick it up.
let _batchFoldersCache = [];

/* ── Batch buddy: drag + interaction ──────────────────────────────────── */
(function () {
  const buddy = document.getElementById('batchBuddy');
  if (!buddy) return;

  let isDragging  = false;
  let didDrag     = false;   // flag to suppress dblclick after drag
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  // Switch from bottom/right to top/left coords during drag for easier math
  let usingTopLeft = false;

  function toTopLeft() {
    if (usingTopLeft) return;
    const rect = buddy.getBoundingClientRect();
    buddy.style.top    = rect.top  + 'px';
    buddy.style.left   = rect.left + 'px';
    buddy.style.bottom = 'auto';
    buddy.style.right  = 'auto';
    usingTopLeft = true;
  }

  function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

  buddy.addEventListener('pointerdown', e => {
    // Only primary button
    if (e.button !== undefined && e.button !== 0) return;
    isDragging  = true;
    didDrag     = false;
    toTopLeft();
    const rect  = buddy.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    buddy.setPointerCapture(e.pointerId);
    buddy.classList.add('dragging');
    // Surprised eyes during drag
    const eyes = buddy.querySelectorAll('.buddy-eye-normal');
    eyes.forEach(el => { el.setAttribute('r', '3.5'); });
    e.preventDefault();
  });

  buddy.addEventListener('pointermove', e => {
    if (!isDragging) return;
    didDrag = true;
    const w = buddy.offsetWidth;
    const h = buddy.offsetHeight;
    const x = clamp(e.clientX - dragOffsetX, 0, window.innerWidth  - w);
    const y = clamp(e.clientY - dragOffsetY, 0, window.innerHeight - h);
    buddy.style.left = x + 'px';
    buddy.style.top  = y + 'px';
  });

  buddy.addEventListener('pointerup', e => {
    if (!isDragging) return;
    isDragging = false;
    buddy.releasePointerCapture(e.pointerId);
    buddy.classList.remove('dragging');
    // Restore normal eyes
    const eyes = buddy.querySelectorAll('.buddy-eye-normal');
    eyes.forEach(el => { el.setAttribute('r', '2.5'); });
    // Drop squish
    if (didDrag) {
      const char = document.getElementById('batchBuddyChar');
      if (char) {
        char.classList.remove('squish');
        // Force reflow to restart animation
        void char.offsetWidth;
        char.classList.add('squish');
        // Remove class after animation so working/done class still applies
        setTimeout(() => char.classList.remove('squish'), 400);
      }
    }
  });

  // Single click: blink eyes
  buddy.addEventListener('click', e => {
    if (didDrag) { didDrag = false; return; }
    const eyeGroup = buddy.querySelector('.buddy-eyes');
    if (eyeGroup) {
      eyeGroup.classList.remove('buddy-eyes-blink');
      void eyeGroup.offsetWidth;
      eyeGroup.classList.add('buddy-eyes-blink');
      setTimeout(() => eyeGroup.classList.remove('buddy-eyes-blink'), 350);
    }
  });

  // Double-click: navigate back to batch view (only if no drag happened)
  buddy.addEventListener('dblclick', e => {
    if (didDrag) return;
    _batchBuddyVisible = false;
    if (typeof switchView === 'function') switchView('new');
  });
})();

function setMode(mode) {
  isBatchMode = (mode === 'batch');
  document.getElementById('modeSingle').classList.toggle('active', !isBatchMode);
  document.getElementById('modeBatch').classList.toggle('active',   isBatchMode);
  document.getElementById('uploadGrid').style.display      = isBatchMode ? 'none' : '';
  document.getElementById('analyzeRow').style.display      = isBatchMode ? 'none' : '';
  document.getElementById('batchSection').classList.toggle('visible', isBatchMode);
  document.getElementById('singleNoteCard').style.display  = isBatchMode ? 'none' : '';
  document.getElementById('batchResultsList').style.display = isBatchMode ? '' : 'none';
  if (isBatchMode && batchSessionStaging.length === 0) addBatchSession();
  if (isBatchMode) refreshBatchFolderSelect();
  checkReady();
}

// U14: (re)loads the folder list into the staging select + shared cache
// (used by renderBatchQueue's per-item selects).
async function refreshBatchFolderSelect() {
  const sel = document.getElementById('batchFolderSelect');
  if (!sel) return;
  const folders = await getAllFoldersFS().catch(() => []);
  _batchFoldersCache = folders;
  const prevValue = sel.value;
  sel.innerHTML = buildFolderSelectOptions(folders, prevValue);
}

function addBatchSession() {
  batchSessionStaging.push({ id: ++batchSessionIdCounter, txtFile: null, professorNum: 1 });
  renderBatchSessions();
}

function removeBatchSession(id) {
  batchSessionStaging = batchSessionStaging.filter(s => s.id !== id);
  renderBatchSessions();
  checkAddPairReady();
}

function renderBatchSessions() {
  const container = document.getElementById('batchSessionList');
  container.innerHTML = batchSessionStaging.map((s, i) => `
    <div class="batch-session-row">
      <span class="batch-session-num">${i + 1}교시</span>
      <label class="batch-file-btn ${s.txtFile ? 'has-file' : ''}" style="flex:1; margin:0; min-width:0;">
        <input type="file" accept=".txt" data-session-id="${s.id}" class="batch-session-file-input" style="display:none;" />
        <span class="batch-file-btn-icon">🎙️</span>
        <span class="batch-file-btn-label">${s.txtFile ? escHtml(s.txtFile.name) : '녹취록 선택'}</span>
      </label>
      <select data-session-id="${s.id}" class="batch-prof-select batch-session-prof-select">
        ${[1,2,3,4,5].map(n => `<option value="${n}" ${s.professorNum === n ? 'selected' : ''}>참석자${n}</option>`).join('')}
      </select>
      <button class="batch-session-remove" data-session-id="${s.id}" title="삭제">✕</button>
    </div>
  `).join('');
}


function checkAddPairReady() {
  const hasPpt = !!batchPptStaging;
  const hasAnySession = batchSessionStaging.some(s => s.txtFile);
  document.getElementById('addPairBtn').disabled = !(hasPpt || hasAnySession);
}

function renderBatchQueue() {
  const container = document.getElementById('batchQueue');
  if (batchQueue.length === 0) {
    container.innerHTML = '<div class="batch-queue-empty">여러 강의 자료를 한 번에 노트로 만들어요. 위에서 자료를 고르고 "목록에 추가"를 누르면 여기에 쌓입니다.</div>';
    return;
  }
  const statusMap = {
    waiting:    ['waiting',    '대기 중'],
    processing: ['processing', '처리 중…'],
    done:       ['done',       '완료 ✓'],
    error:      ['error',      '오류'],
  };
  container.innerHTML = batchQueue.map((item, i) => {
    const [cls, label] = statusMap[item.status];
    const canRemove = item.status === 'waiting';
    const baseName  = (item.pptFile?.name || item.sessions?.[0]?.txtFile?.name || '항목').replace(/\.[^.]+$/, '');
    const notesName = item.notesName !== undefined ? item.notesName : baseName;
    const sessCount = item.sessions?.length || 0;
    const pptLabel  = item.pptFile ? escHtml(item.pptFile.name) : '<span style="color:var(--text-dim)">(발표 자료 없음)</span>';
    return `<div class="batch-queue-item ${item.status}" data-item-id="${item.id}">
      <div class="batch-queue-item-row">
        <div class="batch-item-num">${i + 1}</div>
        <div class="batch-item-files">
          <div class="batch-item-ppt">📊 ${pptLabel}</div>
          <div class="batch-item-txt">🎙️ ${sessCount}개 교시${sessCount > 0 ? ' · ' + item.sessions.map((s,j) => `${j+1}교시`).join(', ') : ''}</div>
        </div>
        <span class="batch-item-status ${cls}">${label}</span>
        ${canRemove
          ? `<button class="batch-item-remove" data-item-id="${item.id}" title="제거">✕</button>`
          : '<span style="width:1.5rem;display:inline-block"></span>'}
      </div>
      ${canRemove ? `<div class="batch-item-name-row">
        <span class="batch-item-name-label">노트 이름</span>
        <input type="text" class="batch-item-name-input" data-item-id="${item.id}" value="${escHtml(notesName)}" placeholder="노트 제목 입력…" />
      </div>
      <div class="batch-item-name-row">
        <span class="batch-item-name-label">저장 폴더</span>
        <select class="batch-item-folder-select folder-save-select" data-item-id="${item.id}">${buildFolderSelectOptions(_batchFoldersCache, item.folderId)}</select>
      </div>` : ''}
    </div>`;
  }).join('');
}

function checkBatchReady() {
  const btn = document.getElementById('batchStartBtn');
  const waiting = batchQueue.filter(i => i.status === 'waiting').length;
  btn.textContent = waiting > 0
    ? `🚀 노트 ${waiting}개 한번에 만들기`
    : '🚀 한번에 만들기';
  btn.disabled = isRunning || !batchQueue.some(i => i.status === 'waiting');
}

function removeBatchItem(id) {
  batchQueue = batchQueue.filter(item => item.id !== id);
  renderBatchQueue();
  checkBatchReady();
}

function updateBatchItemName(id, value) {
  const item = batchQueue.find(i => i.id === id);
  if (item) item.notesName = value;
}

function updateBatchProgress(current, total) {
  _batchRunning  = true;
  _batchProgress = { done: current - 1, total };

  const banner = document.getElementById('batchOverallBanner');
  banner.className = 'batch-overall-banner visible';
  banner.innerHTML = `<div class="spinner"></div><span>${total}개 중 ${current}번째 처리 중…</span>`;

  // Show the "go home" button once batch is underway
  const goHomeRow = document.getElementById('batchGoHomeRow');
  if (goHomeRow) goHomeRow.style.display = '';

  updateBatchBuddy();
}

function updateBatchBuddy() {
  const buddy  = document.getElementById('batchBuddy');
  const speech = document.getElementById('batchBuddySpeech');
  const char   = document.getElementById('batchBuddyChar');
  if (!buddy) return;

  // Hide when not running or when buddy hasn't been sent home yet
  if (!_batchRunning || !_batchBuddyVisible) {
    buddy.style.display = 'none';
    return;
  }

  const { done, total } = _batchProgress;
  if (speech) speech.textContent = total === 1 ? '📝 노트 생성 중…' : `📝 ${done}/${total} 완료!`;
  if (char)   { char.classList.add('working'); char.classList.remove('done'); }
  buddy.style.display = 'flex';
}

function finalizeBatchProgress(total, failed) {
  _batchRunning = false;

  // Hide "go home" button
  const goHomeRow = document.getElementById('batchGoHomeRow');
  if (goHomeRow) goHomeRow.style.display = 'none';

  // Update in-page banner
  const banner = document.getElementById('batchOverallBanner');
  banner.className = 'batch-overall-banner visible done';
  banner.innerHTML = `✅ ${total}개 중 ${total - failed}개 완료${failed > 0 ? ` (${failed}개 오류)` : ''}`;

  // If user navigated away: show celebration on buddy, then hide after 3s
  const buddy  = document.getElementById('batchBuddy');
  const speech = document.getElementById('batchBuddySpeech');
  const char   = document.getElementById('batchBuddyChar');
  if (buddy && buddy.style.display !== 'none') {
    if (speech) speech.textContent = '✅ 완료!';
    if (char)   { char.classList.remove('working'); char.classList.add('done'); }
    setTimeout(() => { if (buddy) buddy.style.display = 'none'; _batchBuddyVisible = false; }, 3000);
  }

  // If user navigated to home while batch ran, show toast and refresh home grid
  if (_currentView === 'home') {
    showToast(`✅ 다중 노트 완료 — ${total - failed}개 노트 생성됨`);
    renderHomeView();
  }
}

/* Auto-download PDF via html2pdf.js */
async function autoDownloadPdf(notesBodyEl, filename) {
  const contentEl = notesBodyEl.querySelector('.md-content') || notesBodyEl;
  const uid = 'bpdf' + Date.now();

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .${uid} { font-family: Arial,"Malgun Gothic","Apple SD Gothic Neo",sans-serif; font-size:12px; line-height:1.7; color:#1a1a1a !important; background:#fff !important; }
    .${uid} * { color:#1a1a1a !important; -webkit-text-fill-color:#1a1a1a !important; background:transparent !important; }
    .${uid} h1 { font-size:22px; font-weight:700; border-bottom:2px solid #333; padding-bottom:0.4em; margin:0 0 1em; }
    .${uid} h2 { font-size:17px; font-weight:700; border-bottom:1px solid #ccc; padding-bottom:0.25em; margin:1.5em 0 0.5em; }
    .${uid} h3 { font-size:14px; font-weight:700; margin:1.2em 0 0.35em; }
    .${uid} p { margin:0.35em 0; }
    .${uid} p:empty { margin:0.1em 0; }
    .${uid} ul, .${uid} ol { padding-left:1.5em; margin:0.3em 0; }
    .${uid} li { margin:0.2em 0; }
    .${uid} strong, .${uid} b { font-weight:700; }
    .${uid} hr { border:none !important; border-top:1px solid #ccc !important; margin:1.2em 0; }
    .${uid} code { font-family:monospace; font-size:10px; background:#f3f4f6 !important; padding:0.1em 0.4em; border-radius:3px; color:#1a1a1a !important; -webkit-text-fill-color:#1a1a1a !important; }
    .${uid} .highlight-important,
    .${uid} .highlight-important * { background:#fff3cd !important; color:#856404 !important; -webkit-text-fill-color:#856404 !important; }
    .${uid} figure { margin:1em 0; page-break-inside:avoid; }
    .${uid} .inserted-slide-img { width:100%; max-width:100%; border:1px solid #ddd; border-radius:4px; display:block; background:#fff !important; }
    .${uid} .inserted-slide-caption { font-size:10px; color:#666 !important; -webkit-text-fill-color:#666 !important; text-align:center; margin-top:0.3em; }
  `;
  document.head.appendChild(styleEl);

  const wrapper = document.createElement('div');
  wrapper.className = uid;
  wrapper.style.cssText = 'position:absolute;left:-9999px;top:0;width:170mm;padding:0;background:#fff';
  wrapper.innerHTML = contentEl.innerHTML;
  document.body.appendChild(wrapper);

  try {
    await html2pdf()
      .set({
        margin: [15, 15, 15, 15],
        filename: filename,
        html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      })
      .from(wrapper)
      .save();
  } finally {
    document.body.removeChild(wrapper);
    document.head.removeChild(styleEl);
  }
}

/* Create a per-lecture result card and return its body element */
function createBatchResultCard(item, index) {
  const baseName = item.notesName || (item.pptFile?.name || item.txtFile?.name || '항목').replace(/\.[^.]+$/, '');
  const list     = document.getElementById('batchResultsList');

  const card = document.createElement('div');
  card.className       = 'batch-result-card processing';
  card.dataset.itemId  = item.id;
  card.innerHTML = `
    <div class="batch-result-card-header">
      <div class="batch-result-card-title">
        <span class="batch-result-num">${index + 1}</span>
        <span class="status-dot loading" id="batchDot_${item.id}"></span>
        <span class="name">📊 ${escHtml(baseName)}</span>
      </div>
      <div class="batch-result-actions" id="batchActions_${item.id}">
        <span style="font-size:0.78rem;color:var(--text-muted)">처리 중…</span>
      </div>
    </div>
    <div class="batch-result-body" id="batchBody_${item.id}">
      <div class="loading-row"><div class="spinner"></div><span>분석 준비 중…</span></div>
    </div>`;

  list.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return document.getElementById('batchBody_' + item.id);
}

/* Attach download buttons to a finished card */
function finalizeCard(item, notesText) {
  const baseName  = item.notesName || (item.pptFile?.name || item.txtFile?.name || '항목').replace(/\.[^.]+$/, '');
  const card      = document.querySelector(`.batch-result-card[data-item-id="${item.id}"]`);
  const dot       = document.getElementById('batchDot_'    + item.id);
  const actionsEl = document.getElementById('batchActions_' + item.id);
  const bodyEl    = document.getElementById('batchBody_'   + item.id);

  if (card)      card.className = 'batch-result-card done';
  if (dot)       dot.className  = 'status-dot done';
  if (!actionsEl) return;

  actionsEl.innerHTML = '';

  const txtBtn = document.createElement('button');
  txtBtn.className   = 'ny-btn ny-btn-secondary';
  txtBtn.textContent = '⬇ .txt';
  txtBtn.addEventListener('click', () => {
    triggerDownload(bodyEl.innerText, `학습노트_${baseName}_${dateStamp()}.txt`);
    txtBtn.textContent = '✅ 저장됨';
    setTimeout(() => { txtBtn.textContent = '⬇ .txt'; }, 2000);
  });

  const mdBtn = document.createElement('button');
  mdBtn.className   = 'ny-btn ny-btn-secondary';
  mdBtn.textContent = '⬇ .md';
  mdBtn.addEventListener('click', () => {
    triggerDownload(notesText, `학습노트_${baseName}_${dateStamp()}.md`);
    mdBtn.textContent = '✅ 저장됨';
    setTimeout(() => { mdBtn.textContent = '⬇ .md'; }, 2000);
  });

  const pdfBtn = document.createElement('button');
  pdfBtn.className   = 'ny-btn ny-btn-secondary';
  pdfBtn.textContent = '⬇ PDF';
  pdfBtn.addEventListener('click', () => {
    // Use print-popup (same as single mode) — more reliable than html2pdf for batch
    const tempEl = document.createElement('div');
    tempEl.innerHTML = renderMarkdown(notesText);
    openPdfPopup(tempEl);
  });

  const dbgBtn = document.createElement('button');
  dbgBtn.className   = 'ny-btn ny-btn-secondary';
  dbgBtn.textContent = '📋 디버그';
  dbgBtn.addEventListener('click', () => copyDebugReport());

  actionsEl.append(dbgBtn, txtBtn, mdBtn, pdfBtn);
}

/* Mark a card as errored */
function errorCard(item, msg) {
  const card = document.querySelector(`.batch-result-card[data-item-id="${item.id}"]`);
  const dot  = document.getElementById('batchDot_'    + item.id);
  const act  = document.getElementById('batchActions_' + item.id);
  const body = document.getElementById('batchBody_'   + item.id);
  if (card) card.className = 'batch-result-card error';
  if (dot)  dot.className  = 'status-dot';
  if (act)  act.innerHTML  = `<span style="font-size:0.78rem;color:#fca5a5">오류</span>`;
  if (body) body.innerHTML = `<span class="placeholder-msg" style="color:#fca5a5">❌ ${escHtml(msg)}</span>`;
}
