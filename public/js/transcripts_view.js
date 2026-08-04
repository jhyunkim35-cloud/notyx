// Transcripts list view + preview modal + per-card actions.
//
// Two surfaces:
//   1. Full list view (#transcriptsView) — sidebar entry "🎙 내 녹취록"
//   2. Preview modal (lazy-built singleton) — opens when a card is clicked
//
// Depends on: transcripts_store.js (saveTranscriptFS / getAllTranscriptsFS /
//   getTranscriptFS / deleteTranscriptFS / renameTranscriptFS / saveSpeakerNamesFS),
//   ui.js (showToast, switchView), markdown.js (escHtml), constants.js
//   (currentUser).
//
// Mirrors the home/note-card patterns used elsewhere — same card metaphor,
// same hover/menu interactions — so users don't need to learn a new vocab.

(function () {

  // ── Helpers ─────────────────────────────────────────────
  function fmtDuration(sec) {
    if (!sec || sec < 1) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}초`;
    if (s === 0) return `${m}분`;
    return `${m}분 ${s}초`;
  }

  // "2026-05-02 16:35" — same shape as defaultTranscriptTitle so the title
  // and the meta line don't visually fight each other.
  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const yyyy = d.getFullYear();
      const mm   = String(d.getMonth() + 1).padStart(2, '0');
      const dd   = String(d.getDate()).padStart(2, '0');
      const hh   = String(d.getHours()).padStart(2, '0');
      const mi   = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    } catch { return ''; }
  }

  function previewText(text, maxChars = 180) {
    if (!text) return '';
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > maxChars ? collapsed.slice(0, maxChars) + '…' : collapsed;
  }

  // ── List view ───────────────────────────────────────────
  async function renderTranscriptsView() {
    const grid  = document.getElementById('transcriptsGrid');
    const empty = document.getElementById('emptyTranscriptsMsg');
    const count = document.getElementById('transcriptsViewCount');
    if (!grid) return;

    // Skeleton while loading (matches home_view.js pattern)
    if (!grid.querySelector('.transcript-card')) {
      grid.innerHTML = Array(3).fill(
        '<div class="skeleton-card"><div class="skeleton-line short"></div><div class="skeleton-line medium"></div><div class="skeleton-line long"></div></div>'
      ).join('');
    }

    const items = (typeof getAllTranscriptsFS === 'function')
      ? await getAllTranscriptsFS()
      : [];

    grid.innerHTML = '';
    if (count) count.textContent = items.length;

    if (!items.length) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    for (const t of items) {
      grid.appendChild(buildTranscriptCard(t));
    }
  }

  function buildTranscriptCard(t) {
    const card = document.createElement('div');
    card.className = 'transcript-card';
    card.dataset.transcriptId = t.id;

    const dur = fmtDuration(t.durationSec);
    const chars = (t.charCount || (t.text || '').length).toLocaleString();
    const date = fmtDateTime(t.createdAt);

    // Note: escHtml is from markdown.js (depended on by the rest of the app).
    const title = (typeof escHtml === 'function') ? escHtml(t.title || '제목 없음') : (t.title || '제목 없음');
    const preview = (typeof escHtml === 'function')
      ? escHtml(previewText(t.text || ''))
      : previewText(t.text || '');

    const truncatedTag = t.truncated
      ? '<span class="transcript-truncated-tag" title="원본 텍스트가 너무 길어 일부만 저장되었습니다">잘림</span>'
      : '';

    card.innerHTML = `
      <div class="transcript-card-head">
        <div class="transcript-card-title">${title} ${truncatedTag}</div>
        <button class="transcript-card-menu-btn" title="메뉴" aria-label="메뉴"><i data-lucide="more-horizontal" class="icon-sm"></i></button>
      </div>
      <div class="transcript-card-meta">
        <span>${date}</span>
        ${dur ? `<span>· ${dur}</span>` : ''}
        <span>· ${chars}자</span>
      </div>
      <div class="transcript-card-preview">${preview || '<span style="color:var(--text-muted)">(빈 녹취록)</span>'}</div>
      <div style="margin-top:0.6rem;">
        <button class="transcript-use-note-btn" style="font-size:0.78rem;padding:0.28rem 0.7rem;border-radius:6px;border:1px solid var(--primary);background:var(--primary-dim);color:var(--primary);cursor:pointer;font-weight:600;" title="이 녹취록으로 새 노트 만들기">+ 새 노트 만들기</button>
      </div>
    `;

    // Click anywhere except menu or the use-note button → open preview
    card.addEventListener('click', (e) => {
      if (e.target.closest('.transcript-card-menu-btn')) return;
      if (e.target.closest('.transcript-use-note-btn')) return;
      openTranscriptPreview(t.id);
    });

    // "새 노트 만들기" inline button
    const useNoteBtn = card.querySelector('.transcript-use-note-btn');
    if (useNoteBtn) {
      useNoteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        useTranscriptForNewNote(t);
      });
    }

    // Menu button → contextual menu
    const menuBtn = card.querySelector('.transcript-card-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCardMenu(menuBtn, t);
    });

    return card;
  }

  // ── Card menu (rename / download / delete) ──────────────
  let _openMenu = null;
  function closeCardMenu() {
    if (_openMenu) {
      _openMenu.remove();
      _openMenu = null;
      document.removeEventListener('click', _outsideMenuListener, true);
    }
  }
  function _outsideMenuListener(e) {
    if (_openMenu && !_openMenu.contains(e.target)) closeCardMenu();
  }
  function showCardMenu(anchorBtn, t) {
    closeCardMenu();
    const menu = document.createElement('div');
    menu.className = 'transcript-card-menu';
    menu.innerHTML = `
      <button data-act="preview">미리보기</button>
      <button data-act="new-note">새 노트 만들기</button>
      <button data-act="rename">이름 변경</button>
      <button data-act="copy">텍스트 복사</button>
      <button data-act="download">.txt 다운로드</button>
      <button data-act="delete" class="danger">삭제</button>
    `;
    document.body.appendChild(menu);
    _openMenu = menu;

    // Position below the anchor (right-aligned for sane behavior near edge).
    const rect = anchorBtn.getBoundingClientRect();
    const menuW = 180;
    const left = Math.max(8, Math.min(window.innerWidth - menuW - 8, rect.right - menuW));
    menu.style.left = `${left}px`;
    menu.style.top  = `${rect.bottom + 4 + window.scrollY}px`;

    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      closeCardMenu();
      if (act === 'preview')    openTranscriptPreview(t.id);
      else if (act === 'new-note')  useTranscriptForNewNote(t);
      else if (act === 'rename')    await renameTranscriptPrompt(t);
      else if (act === 'copy')      await copyTranscriptText(t);
      else if (act === 'download')  downloadTranscriptTxt(t);
      else if (act === 'delete')    await confirmDeleteTranscript(t);
    });

    // Close on outside click — defer to next tick so the click that opened
    // the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', _outsideMenuListener, true), 0);
  }

  // ── Action handlers ─────────────────────────────────────
  async function renameTranscriptPrompt(t) {
    const newTitle = await appPrompt('새 제목을 입력하세요:', t.title || '');
    if (newTitle == null) return;
    const trimmed = newTitle.trim();
    if (!trimmed || trimmed === t.title) return;
    try {
      await renameTranscriptFS(t.id, trimmed);
      window.showToast?.('✅ 이름이 변경되었습니다.');
      // Refresh both the list view (if we're on it) and the preview modal title.
      if (_currentView === 'transcripts') renderTranscriptsView();
      const titleEl = document.getElementById('transcriptPreviewTitle');
      if (titleEl && titleEl.dataset.transcriptId === t.id) {
        titleEl.textContent = trimmed;
      }
      updateMyTranscriptsCount(); // (count doesn't change on rename, but safe)
    } catch (e) {
      console.error('[renameTranscript] failed:', e);
      window.showToast?.('❌ 이름 변경에 실패했습니다.');
    }
  }

  async function copyTranscriptText(t) {
    // Re-fetch in case the card snapshot is stale.
    const fresh = (typeof getTranscriptFS === 'function') ? await getTranscriptFS(t.id) : t;
    const text = (fresh && fresh.text) || t.text || '';
    if (!text) {
      window.showToast?.('복사할 텍스트가 없습니다.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      window.showToast?.('📋 클립보드에 복사되었습니다.');
    } catch (e) {
      console.error('[copyTranscriptText] failed:', e);
      window.showToast?.('❌ 복사에 실패했습니다.');
    }
  }

  function downloadTranscriptTxt(t) {
    const text = t.text || '';
    if (!text) {
      window.showToast?.('내용이 없습니다.');
      return;
    }
    // Sanitize title for filename — keep Korean chars, drop OS-unsafe ones.
    const safeName = (t.title || 'transcript').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Shared builder: saved transcript record → analysis File with the id/raw-text
  // threading the deixis save path needs. Used by the preview's "새 노트 만들기"
  // and the new-note slot picker.
  function buildTranscriptAnalysisFile(t) {
    const raw = t.text || '';
    // U15: apply the display-only speaker-name mapping so the pipeline sees
    // "교수님:" instead of "발화자 1:" too — stored text itself stays untouched.
    const text = applySpeakerNames(raw, t.speakerNames);
    const safeName = (t.title || 'transcript').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const file = new File([text], safeName + '.txt', { type: 'text/plain' });
    file._transcriptId = t.id; // U17: thread record id so post-analysis deixis save can target it
    file._rawText = raw;       // U17: annotations must anchor in the RAW stored text the preview renders,
                               // not the name-applied analysis text (they differ when speakers are renamed)
    return file;
  }

  // U18: "내 녹취록에서 선택" picker for an empty new-note rec slot — fills the
  // slot in place instead of forcing a detour through the 내 녹취록 page.
  async function pickSavedTranscriptForSlot(slotId) {
    const ts = await getAllTranscriptsFS();
    if (!ts.length) { window.showToast?.('저장된 녹취록이 없습니다.'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.innerHTML = `
      <div class="db-modal">
        <h3 style="display:flex;align-items:center;gap:0.4rem;"><i data-lucide="mic" class="icon-sm" style="color:var(--primary);"></i><span>내 녹취록에서 선택</span></h3>
        <div class="db-modal-list">${ts.map(t => `
          <button type="button" class="tr-pick-item" data-id="${escHtml(t.id)}">
            <span class="tr-pick-title">${escHtml(t.title || '제목 없음')}</span>
            <span class="tr-pick-meta">${escHtml(fmtDateTime(t.createdAt))} · ${(t.charCount || (t.text || '').length).toLocaleString()}자</span>
          </button>`).join('')}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:0.6rem;">
          <button type="button" class="sr-btn-secondary" id="trPickCancel" style="padding:0.4rem 1rem;border-radius:8px;cursor:pointer;">취소</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#trPickCancel').addEventListener('click', close);
    overlay.querySelectorAll('.tr-pick-item').forEach(btn => btn.addEventListener('click', () => {
      const t = ts.find(x => x.id === btn.dataset.id);
      if (!t || !(t.text || '')) { window.showToast?.('녹취록 내용이 없습니다.'); return; }
      if (typeof setRecSlotFile === 'function') setRecSlotFile(slotId, buildTranscriptAnalysisFile(t));
      close();
      window.showToast?.('📝 녹취록을 슬롯에 추가했습니다.');
    }));
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function useTranscriptForNewNote(t) {
    if (!(t.text || '')) {
      window.showToast?.('녹취록 내용이 없습니다.');
      return;
    }
    const file = buildTranscriptAnalysisFile(t);
    hidePreviewModal();
    if (typeof switchView === 'function') switchView('new');
    // Slight delay so switchView finishes rendering before DOM manipulation
    setTimeout(() => {
      if (typeof addRecSlot === 'function') addRecSlot(file);
    }, 80);
    window.showToast?.('📝 녹취록을 새 노트 슬롯에 추가했습니다.');
  }

  async function confirmDeleteTranscript(t) {
    if (!await appConfirm(`"${t.title}" 녹취록을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`, { danger: true })) return;
    try {
      await deleteTranscriptFS(t.id);
      window.showToast?.('🗑 삭제되었습니다.');
      // Close preview if it was showing this transcript.
      const titleEl = document.getElementById('transcriptPreviewTitle');
      if (titleEl && titleEl.dataset.transcriptId === t.id) {
        hidePreviewModal();
      }
      if (_currentView === 'transcripts') renderTranscriptsView();
      updateMyTranscriptsCount();
    } catch (e) {
      console.error('[deleteTranscript] failed:', e);
      window.showToast?.('❌ 삭제에 실패했습니다.');
    }
  }

  // ── Preview modal (lazy singleton) ──────────────────────
  let _previewEl = null;

  function ensurePreviewModal() {
    if (_previewEl) return _previewEl;
    _previewEl = document.createElement('div');
    _previewEl.id = 'transcriptPreviewModal';
    _previewEl.className = 'transcript-preview-modal hidden';
    _previewEl.innerHTML = `
      <div class="transcript-preview-backdrop"></div>
      <div class="transcript-preview-panel" role="dialog" aria-modal="true">
        <header class="transcript-preview-head">
          <div class="transcript-preview-title-wrap">
            <div id="transcriptPreviewTitle" class="transcript-preview-title">제목</div>
            <div id="transcriptPreviewMeta" class="transcript-preview-meta"></div>
            <button id="transcriptSpeakerRenameBtn" style="display:none;margin-top:0.4rem;font-size:0.78rem;padding:0.28rem 0.7rem;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;">🏷 발화자 이름 바꾸기</button>
            <div id="transcriptPreviewUsedIn" class="transcript-preview-usedin"></div>
          </div>
          <button id="transcriptPreviewCloseBtn" class="transcript-preview-close" aria-label="닫기"><i data-lucide="x" class="icon-sm"></i></button>
        </header>
        <div id="transcriptPreviewBody" class="transcript-preview-body"></div>
        <footer class="transcript-preview-footer">
          <button id="transcriptPreviewUseNoteBtn"  class="ny-btn ny-btn-primary"><i data-lucide="file-plus" class="icon-sm"></i><span>새 노트 만들기</span></button>
          <button id="transcriptPreviewRenameBtn"   class="ny-btn ny-btn-secondary"><i data-lucide="pencil" class="icon-sm"></i><span>이름 변경</span></button>
          <button id="transcriptPreviewCopyBtn"     class="ny-btn ny-btn-secondary"><i data-lucide="copy" class="icon-sm"></i><span>텍스트 복사</span></button>
          <button id="transcriptPreviewDownloadBtn" class="ny-btn ny-btn-secondary"><i data-lucide="download" class="icon-sm"></i><span>.txt 다운로드</span></button>
          <button id="transcriptPreviewDeleteBtn"   class="ny-btn ny-btn-danger"><i data-lucide="trash-2" class="icon-sm"></i><span>삭제</span></button>
        </footer>
      </div>
    `;
    document.body.appendChild(_previewEl);

    _previewEl.querySelector('.transcript-preview-backdrop').addEventListener('click', hidePreviewModal);
    _previewEl.querySelector('#transcriptPreviewCloseBtn').addEventListener('click', hidePreviewModal);

    // Action buttons stash the current transcript on the title element via dataset.
    function currentTranscript() {
      const id = document.getElementById('transcriptPreviewTitle')?.dataset.transcriptId;
      if (!id) return null;
      const cached = _previewEl._currentTranscript;
      return cached && cached.id === id ? cached : null;
    }
    document.getElementById('transcriptPreviewUseNoteBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) useTranscriptForNewNote(t);
    });
    document.getElementById('transcriptPreviewRenameBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) renameTranscriptPrompt(t);
    });
    document.getElementById('transcriptPreviewCopyBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) copyTranscriptText(t);
    });
    document.getElementById('transcriptPreviewDownloadBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) downloadTranscriptTxt(t);
    });
    document.getElementById('transcriptPreviewDeleteBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) confirmDeleteTranscript(t);
    });
    document.getElementById('transcriptSpeakerRenameBtn').addEventListener('click', () => {
      const t = currentTranscript(); if (t) openSpeakerRenameModal(t);
    });

    // Esc to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !_previewEl.classList.contains('hidden')) {
        hidePreviewModal();
      }
    });

    return _previewEl;
  }

  async function openTranscriptPreview(id) {
    const t = (typeof getTranscriptFS === 'function') ? await getTranscriptFS(id) : null;
    if (!t) {
      window.showToast?.('녹취록을 찾을 수 없습니다.');
      return;
    }
    ensurePreviewModal();
    _previewEl._currentTranscript = t;

    const titleEl = document.getElementById('transcriptPreviewTitle');
    const metaEl  = document.getElementById('transcriptPreviewMeta');
    titleEl.textContent       = t.title || '제목 없음';
    titleEl.dataset.transcriptId = t.id;

    const dur   = fmtDuration(t.durationSec);
    const chars = (t.charCount || (t.text || '').length).toLocaleString();
    const date  = fmtDateTime(t.createdAt);
    const truncatedNote = t.truncated ? ' · ⚠ 일부 잘림' : '';
    metaEl.textContent = [date, dur, `${chars}자${truncatedNote}`].filter(Boolean).join(' · ');

    // Render as preformatted text — preserves paragraph breaks from the
    // STT output without trying to interpret it as markdown. Speaker-label
    // prefixes ("[hh:mm:ss] 발화자 N:") get minimal emphasis so multi-speaker
    // transcripts scan by speaker, and any saved speakerNames mapping (U15)
    // swaps in the custom name at display time only.
    renderTranscriptPreviewBody(t.text || '', t.speakerNames, t.deixisAnnotations);

    const renameBtn = document.getElementById('transcriptSpeakerRenameBtn');
    if (renameBtn) renameBtn.style.display = hasSpeakerLabels(t.text || '') ? '' : 'none';

    // U18: "이 녹취록으로 만든 노트" chips — usedInNoteIds is written by the
    // single-note pipeline; deleted notes resolve to null and are dropped.
    const usedEl = document.getElementById('transcriptPreviewUsedIn');
    if (usedEl) {
      usedEl.innerHTML = '';
      const ids = Array.isArray(t.usedInNoteIds) ? t.usedInNoteIds.slice(-5).reverse() : [];
      if (ids.length && typeof getNoteFS === 'function') {
        Promise.all(ids.map(id => getNoteFS(id).catch(() => null))).then(notes => {
          if (titleEl.dataset.transcriptId !== t.id) return; // preview moved on
          const found = notes.filter(Boolean);
          if (!found.length) return;
          usedEl.innerHTML = '<span class="usedin-label">이 녹취록으로 만든 노트</span>' +
            found.map(n => `<button class="usedin-chip" data-note-id="${escHtml(n.id)}">📄 ${escHtml(n.title || '제목없음')}</button>`).join('');
          usedEl.querySelectorAll('.usedin-chip').forEach(btn => btn.addEventListener('click', () => {
            hidePreviewModal();
            if (typeof openSavedNote === 'function') openSavedNote(btn.dataset.noteId);
          }));
        });
      }
    }

    _previewEl.classList.remove('hidden');

    // U7b: if this transcript was delivered before the local diarization
    // worker finished, fire-and-forget a one-shot check for the label
    // upgrade. Silent no-op if the worker still hasn't finished — the user
    // never sees a spinner for this, it just quietly relabels when ready.
    if (t.diarizationJobId) checkDiarizationLabels(t);
  }

  // ── U15: speaker rename (display-time only) ─────────────
  // Detects "발화자 N:" / "참석자 N:" labels (optionally "[hh:mm:ss] " prefixed).
  const SPEAKER_LABEL_RE = /(발화자|참석자)\s*(\d+)\s*:/;
  function hasSpeakerLabels(text) {
    return SPEAKER_LABEL_RE.test(text || '');
  }
  function extractSpeakerNumbers(text) {
    const re = new RegExp(SPEAKER_LABEL_RE, 'g');
    const nums = new Set();
    let m;
    while ((m = re.exec(text || ''))) nums.add(m[2]);
    return [...nums].sort((a, b) => Number(a) - Number(b));
  }
  // Rewrites "발화자 N:" / "참석자 N:" into "<name>:" for every mapped N —
  // used when handing transcript text off to the note pipeline. Never
  // mutates/persists the source text itself.
  function applySpeakerNames(text, speakerNames) {
    if (!text || !speakerNames || !Object.keys(speakerNames).length) return text;
    let out = text;
    for (const [num, name] of Object.entries(speakerNames)) {
      if (!name) continue;
      // replacer function — a literal `$` in the name must not trigger $-pattern expansion
      out = out.replace(new RegExp(`(발화자|참석자)\\s*${num}\\s*:`, 'g'), () => `${name}:`);
    }
    return out;
  }

  function renderTranscriptPreviewBody(rawText, speakerNames, deixisAnnotations) {
    const bodyEl = document.getElementById('transcriptPreviewBody');
    if (!bodyEl) return;
    if (typeof escHtml === 'function') {
      let escaped = escHtml(rawText);
      // U17: inject inferred-reference chips before the speaker-label pass — chips
      // wrap mid-line quoted spans, label spans wrap line-start prefixes, so order
      // doesn't create overlap as long as chip quotes never contain a line start.
      if (deixisAnnotations?.length && typeof injectDeixisChips === 'function' && typeof assignAnnotationsToRecordText === 'function') {
        escaped = injectDeixisChips(escaped, assignAnnotationsToRecordText(deixisAnnotations, rawText));
      }
      bodyEl.innerHTML = escaped.replace(
        /(^|\n)((?:\[[\d:]+\]\s*)?(발화자|참석자)\s*(\d+)\s*:)/g,
        (m, br, label, kind, num) => {
          const custom = speakerNames && speakerNames[num];
          const display = custom
            ? label.replace(new RegExp(`${kind}\\s*${num}\\s*:`), () => `${escHtml(custom)}:`)
            : label;
          return `${br}<span style="color:var(--primary);font-weight:600">${display}</span>`;
        }
      );
    } else {
      bodyEl.textContent = rawText;
    }
  }

  // Small modal (reuses .db-modal pattern) — one text input per distinct
  // speaker number found in the transcript text, prefilled from any
  // previously-saved mapping.
  function openSpeakerRenameModal(t) {
    const nums = extractSpeakerNumbers(t.text || '');
    if (!nums.length) return;
    const existing = t.speakerNames || {};

    const overlay = document.createElement('div');
    overlay.className = 'db-modal-overlay';
    overlay.innerHTML = `
      <div class="db-modal" style="max-width:420px;">
        <h3>🏷 발화자 이름 바꾸기</h3>
        <div class="db-modal-list">
          ${nums.map(n => `
            <div class="db-modal-row" style="flex-direction:column;align-items:stretch;gap:0.3rem;">
              <span>발화자 ${n} →</span>
              <input type="text" data-speaker-num="${n}" value="${escHtml(existing[n] || '')}" placeholder="예: 교수님" style="padding:0.4rem 0.6rem;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.85rem;box-sizing:border-box;" />
            </div>
          `).join('')}
        </div>
        <div class="db-modal-footer" style="justify-content:flex-end;">
          <button id="speakerRenameCancel" style="background:var(--surface3);color:var(--text);border:1px solid var(--border);">취소</button>
          <button id="speakerRenameOk">저장</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#speakerRenameCancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#speakerRenameOk').addEventListener('click', async () => {
      const speakerNames = {};
      overlay.querySelectorAll('input[data-speaker-num]').forEach(inp => {
        const v = inp.value.trim();
        if (v) speakerNames[inp.dataset.speakerNum] = v;
      });
      try {
        await saveSpeakerNamesFS(t.id, speakerNames);
        t.speakerNames = speakerNames;
        if (_previewEl?._currentTranscript?.id === t.id) _previewEl._currentTranscript.speakerNames = speakerNames;
        renderTranscriptPreviewBody(t.text || '', speakerNames, t.deixisAnnotations);
        window.showToast?.('✅ 발화자 이름이 저장되었습니다.');
        close();
      } catch (e) {
        console.error('[speakerRename] failed:', e);
        window.showToast?.('❌ 저장에 실패했습니다.');
      }
    });
  }

  async function checkDiarizationLabels(t) {
    try {
      if (!currentUser || typeof currentUser.getIdToken !== 'function') return;
      const idToken = await currentUser.getIdToken();
      const r = await fetch('/api/whisper-stt?action=labels&id=' + encodeURIComponent(t.diarizationJobId), {
        headers: { 'authorization': 'Bearer ' + idToken },
      });
      const j = await r.json();
      if (!r.ok || !j.ready) return; // not ready yet — silent, no retry (next preview open re-checks)

      await applyDiarizationLabelsFS(t.id, { text: j.text, charCount: j.text.length });

      // Update the in-memory record so re-renders (or a second check) see the upgrade.
      t.text = j.text;
      t.charCount = j.text.length;
      t.diarizationJobId = null;

      // Re-render only if this transcript's preview is still the one open.
      const titleEl = document.getElementById('transcriptPreviewTitle');
      if (titleEl && titleEl.dataset.transcriptId === t.id) {
        renderTranscriptPreviewBody(j.text, t.speakerNames, t.deixisAnnotations);
        const renameBtn = document.getElementById('transcriptSpeakerRenameBtn');
        if (renameBtn) renameBtn.style.display = hasSpeakerLabels(j.text) ? '' : 'none';
      }
      window.showToast?.('화자 라벨이 적용되었습니다');
    } catch (e) {
      console.warn('[checkDiarizationLabels] failed:', e.message);
    }
  }

  function hidePreviewModal() {
    if (_previewEl) _previewEl.classList.add('hidden');
  }

  // ── Home-card transcript count ──────────────────────────
  // The home page's record button has a "내 녹취록 N개" link in it. Updated
  // on:  login, after recordings finish, after rename/delete, on view switch.
  async function updateMyTranscriptsCount() {
    const el = document.getElementById('myTranscriptsCount');
    if (!el) return;
    if (!currentUser) { el.textContent = '0'; return; }
    try {
      const items = await getAllTranscriptsFS();
      el.textContent = String(items.length);
    } catch (e) {
      // best-effort
    }
  }

  // ── Public API ──────────────────────────────────────────
  window.renderTranscriptsView    = renderTranscriptsView;
  window.openTranscriptPreview    = openTranscriptPreview;
  window.updateMyTranscriptsCount = updateMyTranscriptsCount;
  window.pickSavedTranscriptForSlot = pickSavedTranscriptForSlot;

})();
