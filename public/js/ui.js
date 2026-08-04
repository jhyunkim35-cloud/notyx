// UI utilities: toasts, progress bar, activity feed, timers, theme, sidebar, view switching.
// Depends on: constants.js (toast, toastTimer, TOAST_DURATION_MS, progressWrap, progressFill, progressLabel, progressPct, PROGRESS_HIDE_DELAY_MS, progressHideTimer, feedStartTime, AGENT_META, elapsedStart, elapsedTimer, iterChipData, _notesCollapsed, _currentView, _batchRunning, isBatchMode, currentNoteId, extractedImages, storedPptText), markdown.js (escHtml, getImgSrc), quiz.js (clearQuizInlineArea, updateNoteWeaknessBadges).

function showSuccessToast(msg) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add('show', 'success');
  toastTimer = setTimeout(() => { toast.classList.remove('show', 'success'); }, TOAST_DURATION_MS);
}

async function copyDebugReport() {
  const sep = '\n' + '='.repeat(60) + '\n';

  const notesMd = storedNotesText
    || document.getElementById('splitNotes')?.innerText
    || document.getElementById('finalNotesBody')?.innerText
    || '(없음)';

  const critiqueEl = document.getElementById('tab-critique');
  const pipelineLog = [
    ..._debugLog,
    ...(critiqueEl ? ['--- 비평 피드백 ---', critiqueEl.innerText.trim()] : []),
  ].join('\n') || '(없음)';

  const slideText = storedPptText || '(없음)';

  const errors = _lastGenerationError || '(없음)';

  const report = [
    `디버그 리포트 — ${new Date().toLocaleString('ko-KR')}`,
    sep,
    '## Generated Note',
    notesMd,
    sep,
    '## Pipeline Log',
    pipelineLog,
    sep,
    '## Slide Text Input',
    slideText,
    sep,
    '## Errors',
    errors,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(report);
  } catch (_) {
    const ta = Object.assign(document.createElement('textarea'), { value: report, style: 'position:fixed;opacity:0' });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  showToast('복사 완료!');
}

/* ═══════════════════════════════════════════════
   Collapse / expand notes hero body
═══════════════════════════════════════════════ */
(function() {
  const btn  = document.getElementById('collapseBtn');
  const body = document.getElementById('finalNotesBody');
  btn.addEventListener('click', () => {
    _notesCollapsed = !_notesCollapsed;
    if (_notesCollapsed) {
      body.style.maxHeight = '0'; body.style.overflow = 'hidden';
      body.style.padding = '0 1.75rem'; btn.innerHTML = '<i data-lucide="chevron-down" class="icon-xs"></i> 펼치기';
    } else {
      body.style.maxHeight = ''; body.style.overflow = '';
      body.style.padding = ''; btn.innerHTML = '<i data-lucide="chevron-up" class="icon-xs"></i> 접기';
    }
  });
})();

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════
   Progress bar
═══════════════════════════════════════════════ */
function setProgress(pct, label) {
  clearTimeout(progressHideTimer);

  if (pct === null) {
    progressHideTimer = setTimeout(() => {
      progressWrap.classList.remove('visible');
      progressWrap.style.display = 'none';
    }, PROGRESS_HIDE_DELAY_MS);
    return;
  }

  progressFill.style.width  = pct + '%';
  progressLabel.textContent = label;
  progressPct.textContent   = pct + '%';
  if (progressWrap.style.display === 'none') {
    progressWrap.style.display = 'flex';
    // Force reflow so the transition animates from the hidden transform position
    progressWrap.getBoundingClientRect();
  }
  progressWrap.classList.add('visible');
}

/* ═══════════════════════════════════════════════
   Activity feed
═══════════════════════════════════════════════ */
function agentLog(agentNum, msg) {
  const feed  = document.getElementById('activityFeed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const secs  = feedStartTime ? Math.floor((Date.now() - feedStartTime) / 1000) : 0;
  const tStr  = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const meta  = agentNum > 0 ? AGENT_META[agentNum] : { icon: '⚙️' };

  const entry = document.createElement('div');
  entry.className    = 'feed-entry';
  entry.dataset.agent = String(agentNum);
  entry.innerHTML    = `<span class="feed-time">${tStr}</span>`
                     + `<span class="feed-icon">${meta.icon}</span>`
                     + `<span class="feed-msg">${escHtml(msg)}</span>`;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function clearActivityFeed() {
  document.getElementById('activityFeed').innerHTML =
    '<div class="feed-empty">분석이 시작되면 실시간 활동 로그가 여기에 표시됩니다.</div>';
}

/* ═══════════════════════════════════════════════
   Elapsed timer
═══════════════════════════════════════════════ */
function startElapsedTimer() {
  elapsedStart  = Date.now();
  feedStartTime = elapsedStart;
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - elapsedStart) / 1000);
    document.getElementById('elapsedTime').textContent =
      `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

/* ═══════════════════════════════════════════════
   ETA + iteration counter
═══════════════════════════════════════════════ */
function updateETA(iterTimings, itersLeft) {
  const el = document.getElementById('etaDisplay');
  if (!iterTimings.length || itersLeft <= 0) { el.classList.add('hidden'); return; }
  const avgMs   = iterTimings.reduce((a, b) => a + b, 0) / iterTimings.length;
  const etaSecs = Math.round(avgMs * itersLeft / 1000);
  const m = Math.floor(etaSecs / 60), s = etaSecs % 60;
  document.getElementById('etaTime').textContent = m > 0 ? `~${m}분 ${s}초` : `~${s}초`;
  el.classList.remove('hidden');
}

function updateIterCounter(state, iter) {
  const el   = document.getElementById('iterCounter');
  const text = document.getElementById('iterCounterText');
  el.className = 'iter-counter ' + state;
  if      (state === 'idle')    text.textContent = '대기 중';
  else if (state === 'running') text.textContent = `🔄 ${iter}차 반복 진행 중`;
  else if (state === 'done')    text.textContent = `✅ ${iter}차 반복 완료`;
}

/* ═══════════════════════════════════════════════
   Pipeline node helpers
═══════════════════════════════════════════════ */
function setAgentNode(n, state, statusText) {
  const node   = document.getElementById('anode' + n);
  const status = document.getElementById('astatus' + n);
  node.className     = 'agent-node' + (state ? ' ' + state : '');
  status.textContent = statusText || '';
  if (state === 'loading' || state === 'done') {
    const conn = document.getElementById('aconn' + (n - 1));
    if (conn) conn.classList.add('active');
  }
}

function resetAgentNodes() {
  for (let i = 0; i <= 2; i++) {
    document.getElementById('anode'   + i).className   = 'agent-node';
    document.getElementById('astatus' + i).textContent = '대기 중';
  }
  ['aconn0', 'aconn1'].forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById('agentFinalBar').classList.remove('visible');
  document.getElementById('dotNotes').className = 'status-dot';
  document.getElementById('notesCardTitle').textContent = '📚 통합 학습 노트';
  document.getElementById('scoreTrack').innerHTML =
    '<span style="color:var(--text-dim);font-size:0.84rem">시작하면 이력이 여기에 표시됩니다.</span>';
  document.getElementById('etaDisplay').classList.add('hidden');
  document.getElementById('elapsedTime').textContent = '0:00';
  updateIterCounter('idle', 0);
  feedStartTime = null;
  if (!isBatchMode) clearActivityFeed();
  document.getElementById('tab-critique').innerHTML =
    '<span class="placeholder-msg">검토가 완료되면 비평 내용이 여기에 표시됩니다.</span>';
}

// Routes dotEl.className changes → pipeline node state
function makeAgentDot(nodeNum) {
  return {
    set className(val) {
      if      (val.includes('loading')) setAgentNode(nodeNum, 'loading', '실행 중…');
      else if (val.includes('done'))    setAgentNode(nodeNum, 'done',    '완료');
    },
  };
}

/* ═══════════════════════════════════════════════
   Iteration history chips
═══════════════════════════════════════════════ */
function addIterChip(iter, passed) {
  iterChipData.push({ iter, passed });
  const track = document.getElementById('scoreTrack');
  let html = '';
  iterChipData.forEach((d, idx) => {
    const cls  = d.passed ? 'pass' : 'fail';
    const label = d.passed ? `${d.iter}차: 검토 통과 ✅` : `${d.iter}차: 수정 필요`;
    html += `<span class="score-chip ${cls}">${label}</span>`;
    if (idx < iterChipData.length - 1) html += '<span class="score-arrow">→</span>';
  });
  track.innerHTML = html;
}

function showToast(msg) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_DURATION_MS);
}

/* ═══════════════════════════════════════════════
   In-app confirm / prompt modals
   ────────────────────────────────────────────────
   Replacements for the native window.confirm/prompt, which Chrome silently
   disables ("이 페이지에서 추가 대화상자를 표시하지 않도록 차단") once a few
   dialogs fire in quick succession. When that block is active, native
   confirm() returns false and prompt() returns null with NO dialog shown —
   so every delete/rename guarded by `if (!confirm(...)) return;` dies
   silently. These DOM modals are immune to that block.
   Both return Promises; callers must `await`.
═══════════════════════════════════════════════ */
function appConfirm(message, opts = {}) {
  const okText     = opts.okText || '확인';
  const cancelText = opts.cancelText || '취소';
  const danger     = !!opts.danger;
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.innerHTML = `
      <div class="db-modal" style="max-width:380px;">
        <div style="font-size:0.92rem; line-height:1.5; white-space:pre-line; margin-bottom:1.1rem; color:var(--text);">${escHtml(message)}</div>
        <div class="db-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button class="appConfirmCancel" style="background:var(--surface3); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">${escHtml(cancelText)}</button>
          <button class="appConfirmOk" style="background:${danger ? '#e5484d' : 'var(--primary)'}; color:${danger ? '#fff' : 'var(--bg)'}; border:none; border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">${escHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const onKey = e => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };
    const done = val => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    overlay.querySelector('.appConfirmOk').addEventListener('click', () => done(true));
    overlay.querySelector('.appConfirmCancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); }); // backdrop click = cancel
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('.appConfirmOk')?.focus(), 50);
  });
}

function appPrompt(message, defaultValue = '', opts = {}) {
  const okText     = opts.okText || '확인';
  const cancelText = opts.cancelText || '취소';
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.innerHTML = `
      <div class="db-modal" style="max-width:380px;">
        <div style="font-size:0.9rem; line-height:1.5; white-space:pre-line; margin-bottom:0.6rem; color:var(--text);">${escHtml(message)}</div>
        <input class="appPromptInput" type="text" style="width:100%; padding:0.5rem 0.7rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.9rem; box-sizing:border-box; margin-bottom:1rem;" />
        <div class="db-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button class="appPromptCancel" style="background:var(--surface3); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">${escHtml(cancelText)}</button>
          <button class="appPromptOk" style="background:var(--primary); color:var(--bg); border:none; border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">${escHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.appPromptInput');
    input.value = defaultValue;
    const onKey = e => {
      if (e.key === 'Escape') done(null);
      else if (e.key === 'Enter') done(input.value);
    };
    const done = val => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    overlay.querySelector('.appPromptOk').addEventListener('click', () => done(input.value));
    overlay.querySelector('.appPromptCancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); }); // backdrop click = cancel
    document.addEventListener('keydown', onKey);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

/* ═══════════════════════════════════════════════
   R7: Page-citation chip overlay
   ────────────────────────────────────────────────
   markdown.js renders "p.N" / "p.N-M" refs as clickable
   <button class="page-cite-chip" data-slide="N"> elements (in every note
   view — renderMarkdown is the single choke point). This delegated
   listener opens the original slide (image if extracted, else the raw
   PPT text section) in a lightweight overlay so users can check the
   source without leaving the note.
═══════════════════════════════════════════════ */
function openSlideCite(n) {
  const overlay = document.getElementById('slideCiteOverlay');
  const title   = document.getElementById('slideCiteTitle');
  const body    = document.getElementById('slideCiteBody');
  if (!overlay || !title || !body) return;

  const img = extractedImages.find(i => i.slideNumber === n);
  body.innerHTML = ''; // cleared; refilled below with createElement + textContent only (no raw HTML)

  if (img) {
    const el = document.createElement('img');
    el.src = getImgSrc(img);
    el.alt = `슬라이드 ${n}`;
    el.style.cssText = 'max-width:100%; display:block; margin:0 auto; border-radius:6px;';
    body.appendChild(el);
  } else {
    const m = storedPptText.match(new RegExp(`\\[슬라이드 ${n}\\]([\\s\\S]*?)(?=\\[슬라이드 \\d+\\]|$)`));
    if (!m) {
      showToast('원본 슬라이드를 찾을 수 없습니다');
      return;
    }
    // ponytail: batch mode reuses storedPptText per active card, so in a
    // batch view this can show a different session's slide text if the
    // chip belongs to a non-active card. Known limitation, not fixed here.
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap; font-family:inherit; font-size:0.85rem; line-height:1.6; color:var(--text); margin:0;';
    pre.textContent = m[0].trim();
    body.appendChild(pre);
  }

  title.textContent = `슬라이드 ${n}`;
  overlay.style.display = 'flex';
}

function closeSlideCite() {
  const overlay = document.getElementById('slideCiteOverlay');
  if (overlay) overlay.style.display = 'none';
}

document.addEventListener('click', e => {
  const chip = e.target.closest('.page-cite-chip');
  if (chip) {
    const n = parseInt(chip.dataset.slide, 10);
    if (!isNaN(n)) openSlideCite(n);
    return;
  }
  if (e.target.id === 'slideCiteOverlay' || e.target.closest('#slideCiteCloseBtn')) closeSlideCite();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSlideCite();
});

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  // The button's icon flips between sun (in light mode → click to go dark)
  // and moon (in dark mode → click to go light). We replace the inner
  // <i data-lucide="…">; the MutationObserver in icons.js mounts the
  // SVG automatically, but we trigger it explicitly too in case the
  // observer is throttled.
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    btn.innerHTML = `<i data-lucide="${isLight ? 'moon' : 'sun'}"></i>`;
    if (typeof window.mountLucideIcons === 'function') window.mountLucideIcons();
  }
}

/* ═══════════════════════════════════════════════
   Settings panel
═══════════════════════════════════════════════ */
function toggleSettings() {
  document.getElementById('settingsPanel').classList.toggle('open');
}

/* ═══════════════════════════════════════════════
   Sidebar toggle (mobile)
═══════════════════════════════════════════════ */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const open = sidebar.classList.toggle('open');
  overlay.style.display = open ? 'block' : 'none';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').style.display = 'none';
}

/* ═══════════════════════════════════════════════
   View switching
═══════════════════════════════════════════════ */
function switchView(view) {
  // All pipelines (batch and single note) run in the background — free navigation allowed
  // When leaving the note view while a pipeline runs, hide the top progress bar visually
  if (_batchRunning && _currentView === 'new' && view !== 'new') {
    document.querySelector('.progress-wrap')?.classList.remove('visible');
  }
  _currentView = view;
  document.getElementById('homeView').style.display    = view === 'home' ? '' : 'none';
  document.getElementById('newNoteView').style.display = view === 'new'  ? '' : 'none';
  const transcriptsViewEl = document.getElementById('transcriptsView');
  if (transcriptsViewEl) transcriptsViewEl.style.display = view === 'transcripts' ? '' : 'none';
  document.querySelectorAll('#sidebar .sidebar-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  closeSidebar();
  if (view === 'home') renderHomeView();
  if (view === 'transcripts' && typeof renderTranscriptsView === 'function') renderTranscriptsView();
  if (view === 'new') {
    // Clear stale action-button state from any previously loaded note
    [quizBtn, classifyBtn, notionCopyBtn, dlNotionFileBtn, copyNotesBtn, dlTxtBtn, dlMdBtn, dlPdfBtn, splitViewBtn].forEach(b => { b.disabled = true; });
    document.getElementById('notesActions')?.classList.remove('visible');
    document.getElementById('collapseBtn')?.classList.remove('visible');
    clearQuizInlineArea();
  }
  // Show/hide batch buddy based on new view
  updateBatchBuddy();
}
