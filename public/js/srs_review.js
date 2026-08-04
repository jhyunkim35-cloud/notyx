// SRS Review UI: flashcard review screen with SM-2 quality grading.
// Depends on: constants.js (db, currentUser, _currentView), srs.js (getDueCards, gradeCard, getSrsCard, saveSrsCard, cardIdFor), firestore_sync.js (getNoteFS), markdown.js (renderMarkdown, escHtml), ui.js (switchView, showToast).

(function () {

  let _queue   = [];
  let _current = 0;
  let _sessionDone = 0;
  let _fromFolderId = null;

  // ── Date helpers ──────────────────────────────────────────────

  function _todayYmd() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function _daysDiff(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const today  = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  // ── CSS injection ─────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('srs-review-styles')) return;
    const style = document.createElement('style');
    style.id = 'srs-review-styles';
    style.textContent = `
#reviewView {
  min-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
}
.srs-review-wrap {
  max-width: 640px;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  width: 100%;
}
.srs-review-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 2rem;
}
.srs-back-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 8px;
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.srs-back-btn:hover { background: var(--surface2); }
.srs-progress-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.srs-progress-bar {
  flex: 1;
  height: 6px;
  background: var(--surface2);
  border-radius: 3px;
  overflow: hidden;
}
.srs-progress-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
  transition: width 0.4s ease;
}
.srs-progress-label {
  font-size: 0.82rem;
  color: var(--text-muted);
  white-space: nowrap;
}
.srs-card {
  background: var(--surface);
  border-radius: 20px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.18);
  padding: 2rem;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.srs-card.flipped {
  animation: srsFlip 0.3s ease;
}
@keyframes srsFlip {
  0%   { transform: rotateY(0deg);  opacity: 1; }
  50%  { transform: rotateY(90deg); opacity: 0; }
  100% { transform: rotateY(0deg);  opacity: 1; }
}
.srs-card-front { text-align: center; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.srs-card-hint {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.6rem;
}
.srs-card-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.4;
  padding: 0.5rem 0;
}
.srs-card-note-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin-top: 0.5rem;
}
.srs-reveal-btn {
  width: 100%;
  background: var(--primary);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 1rem;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}
.srs-reveal-btn:hover { opacity: 0.88; }
.srs-card-answer {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
  max-height: 340px;
  overflow-y: auto;
}
.srs-answer-content {
  font-size: 0.92rem;
  line-height: 1.75;
  color: var(--text);
}
.srs-answer-content pre, .srs-answer-content code {
  font-family: Consolas, 'Courier New', monospace;
  background: var(--surface2);
  border-radius: 4px;
  padding: 0.15em 0.45em;
  font-size: 0.88em;
}
.srs-grade-btns {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}
@media (max-width: 480px) {
  .srs-grade-btns { grid-template-columns: repeat(2, 1fr); }
}
.srs-grade-btn {
  min-height: 60px;
  border: 1px solid transparent;
  border-radius: 10px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  font-family: inherit;
}
.srs-grade-btn:hover:not(:disabled) { opacity: 0.82; transform: translateY(-1px); }
.srs-grade-btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.srs-grade-red    { background: rgba(239,68,68,0.13);  color: #ef4444; border-color: rgba(239,68,68,0.28); }
.srs-grade-orange { background: color-mix(in srgb, var(--warning) 13%, transparent); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 28%, transparent); }
.srs-grade-green  { background: rgba(34,197,94,0.13);  color: #22c55e; border-color: rgba(34,197,94,0.28); }
.srs-grade-blue   { background: rgba(59,130,246,0.13); color: #3b82f6; border-color: rgba(59,130,246,0.28); }
.srs-grade-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.8rem;
  background: var(--surface2);
  border-radius: 8px;
  margin-top: 0.6rem;
  font-size: 0.84rem;
}
.srs-next-review { color: var(--text-muted); }
  100% { transform: translate(-50%, -180%); opacity: 0; }
}
.srs-summary {
  text-align: center;
  padding: 3rem 1rem;
}
.srs-summary-icon { font-size: 3.2rem; margin-bottom: 1rem; }
.srs-summary-title { font-size: 1.4rem; font-weight: 700; color: var(--text); margin-bottom: 2rem; }
.srs-summary-stats {
  display: flex;
  justify-content: center;
  gap: 3rem;
  margin-bottom: 2.5rem;
}
.srs-stat { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; }
.srs-stat-num { font-size: 1.7rem; font-weight: 800; color: var(--primary); }
.srs-stat-label { font-size: 0.8rem; color: var(--text-muted); }
.srs-done-btn {
  background: var(--primary);
  color: var(--bg);
  border: none;
  border-radius: 12px;
  padding: 0.9rem 3.5rem;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.srs-done-btn:hover { opacity: 0.88; }
.srs-empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }
.srs-empty h3 { font-size: 1.1rem; font-weight: 700; color: var(--text); margin-bottom: 0.5rem; }
.srs-empty p { margin-bottom: 1.5rem; }
.srs-add-btn {
  display: inline-flex;
  align-items: center;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  margin-left: 7px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--text-muted);
  vertical-align: middle;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  font-family: inherit;
  line-height: 1.6;
}
.srs-add-btn:hover:not(:disabled) {
  background: var(--primary-dim);
  color: var(--primary);
  border-color: var(--primary);
}
.srs-add-btn.active {
  background: var(--primary-dim);
  color: var(--primary);
  border-color: var(--primary);
  cursor: default;
}
`;
    document.head.appendChild(style);
  }

  // ── IDB all-cards fallback ────────────────────────────────────

  function _idbGetAllCards() {
    return openDB().then(conn => new Promise((res, rej) => {
      const req = conn.transaction('srsCards', 'readonly').objectStore('srsCards').getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  // ── Fetch due cards (null folderId = all folders) ─────────────

  async function _fetchDueCards(folderId) {
    const today = _todayYmd();
    if (folderId) {
      return getDueCards(folderId, today);
    }
    // All-folder: query Firestore directly
    let cards = [];
    if (typeof currentUser !== 'undefined' && currentUser && typeof db !== 'undefined') {
      try {
        const snap = await db.collection('users').doc(currentUser.uid).collection('srsCards').get();
        cards = snap.docs.map(d => d.data());
      } catch (e) {
        cards = await _idbGetAllCards();
      }
    } else {
      cards = await _idbGetAllCards();
    }
    return cards
      .filter(c => c.nextReviewDate && c.nextReviewDate <= today)
      .sort((a, b) => (a.nextReviewDate || '').localeCompare(b.nextReviewDate || ''));
  }

  // ── Section content extraction ────────────────────────────────

  function _extractSectionContent(text, sectionTitle) {
    if (!text || !sectionTitle) return '';
    const lines = text.split('\n');
    let inSection = false;
    const result  = [];
    const needle  = sectionTitle.trim().toLowerCase();

    for (const line of lines) {
      const m = line.match(/^(#{1,3})\s+(.+)/);
      if (m) {
        if (inSection) break;
        if (m[2].trim().toLowerCase() === needle) { inSection = true; continue; }
      } else if (inSection) {
        result.push(line);
      }
    }
    return result.join('\n').trim();
  }

  // ── View management ───────────────────────────────────────────

  function _showReviewView() {
    document.getElementById('homeView').style.display        = 'none';
    document.getElementById('newNoteView').style.display     = 'none';
    const tv = document.getElementById('transcriptsView');
    if (tv) tv.style.display = 'none';
    const rv = document.getElementById('reviewView');
    if (rv) rv.style.display = '';
    _currentView = 'review';
  }

  // ── Public: enter review mode ─────────────────────────────────

  async function enterReviewMode(folderId) {
    _injectStyles();
    _fromFolderId = folderId;
    _sessionDone  = 0;
    _current      = 0;

    _showReviewView();

    const rv = document.getElementById('reviewView');
    if (!rv) return;
    rv.innerHTML = '<div class="srs-review-wrap"><div style="color:var(--text-muted);padding:2rem 0;text-align:center;">카드 불러오는 중…</div></div>';

    try {
      _queue = await _fetchDueCards(folderId);
    } catch (e) {
      _queue = [];
    }

    if (!_queue.length) {
      _renderEmpty();
    } else {
      renderReviewCard(_queue[0]);
    }
  }

  // ── Render card front ─────────────────────────────────────────

  function renderReviewCard(card) {
    const rv  = document.getElementById('reviewView');
    if (!rv) return;
    const pct  = Math.round((_current / _queue.length) * 100);
    const prog = `${_current + 1} / ${_queue.length}`;

    const isCloze = card.type === 'cloze';
    const hint  = isCloze ? '암기 카드' : '섹션 복습';
    const title = escHtml((isCloze ? card.front : card.sectionTitle) || card.id || '?');
    rv.innerHTML = `
<div class="srs-review-wrap">
  <div class="srs-review-header">
    <button class="srs-back-btn" id="srsBackBtn">← 나가기</button>
    <div class="srs-progress-wrap">
      <div class="srs-progress-bar"><div class="srs-progress-fill" style="width:${pct}%"></div></div>
      <span class="srs-progress-label">${prog}</span>
    </div>
  </div>
  <div class="srs-card" id="srsCard">
    <div class="srs-card-front">
      <div class="srs-card-hint">${hint}</div>
      <div class="srs-card-title">${title}</div>
      <div class="srs-card-note-hint" id="srsNoteHint"></div>
    </div>
    <button class="srs-reveal-btn" id="srsRevealBtn">정답 보기</button>
  </div>
</div>`;

    rv.querySelector('#srsBackBtn').addEventListener('click', exitReviewMode);
    rv.querySelector('#srsRevealBtn').addEventListener('click', () => showAnswer(card));

    // Load note title hint asynchronously
    if (card.noteId && typeof getNoteFS === 'function') {
      getNoteFS(card.noteId).then(note => {
        const hint = rv.querySelector('#srsNoteHint');
        if (hint && note && note.title) hint.textContent = note.title;
      }).catch(() => {});
    }
  }

  // ── Reveal answer ─────────────────────────────────────────────

  async function showAnswer(card) {
    const srsCard = document.getElementById('srsCard');
    if (!srsCard) return;

    srsCard.classList.add('flipped');

    const isCloze = card.type === 'cloze';
    let contentHtml = '<em style="color:var(--text-muted);">(내용을 찾을 수 없습니다)</em>';
    try {
      if (isCloze) {
        contentHtml = card.back ? escHtml(card.back) : '<em style="color:var(--text-muted);">(내용이 없습니다)</em>';
      } else if (card.noteId && typeof getNoteFS === 'function') {
        const note = await getNoteFS(card.noteId);
        if (note) {
          const rawText = note.notesText || note.markdownContent || '';
          const excerpt = _extractSectionContent(rawText, card.sectionTitle || '');
          contentHtml = excerpt
            ? (typeof renderMarkdown === 'function' ? renderMarkdown(excerpt) : escHtml(excerpt))
            : '<em style="color:var(--text-muted);">(섹션 내용이 없습니다)</em>';
        }
      }
    } catch (e) {}

    const hint  = isCloze ? '암기 카드' : '섹션 복습';
    const title = escHtml((isCloze ? card.front : card.sectionTitle) || card.id || '?');
    srsCard.innerHTML = `
<div class="srs-card-front" style="text-align:left;align-items:flex-start;justify-content:flex-start;padding-bottom:0.5rem;">
  <div class="srs-card-hint">${hint}</div>
  <div class="srs-card-title" style="font-size:1.15rem;">${title}</div>
</div>
<div class="srs-card-answer">
  <div class="srs-answer-content">${contentHtml}</div>
</div>
<div class="srs-grade-btns">
  <button class="srs-grade-btn srs-grade-red"    data-q="0">완전 모름</button>
  <button class="srs-grade-btn srs-grade-orange" data-q="2">어려웠음</button>
  <button class="srs-grade-btn srs-grade-green"  data-q="4">괜찮음</button>
  <button class="srs-grade-btn srs-grade-blue"   data-q="5">쉬움</button>
</div>`;

    srsCard.querySelectorAll('.srs-grade-btn').forEach(btn => {
      btn.addEventListener('click', () => _onGradeClick(parseInt(btn.dataset.q), card));
    });
  }

  // ── Grade and advance ─────────────────────────────────────────

  async function _onGradeClick(quality, card) {
    const srsCard = document.getElementById('srsCard');
    if (!srsCard) return;
    srsCard.querySelectorAll('.srs-grade-btn').forEach(b => { b.disabled = true; });

    let updatedCard = card;
    try {
      updatedCard = await gradeCard(card.id, quality);
    } catch (e) {}

    _sessionDone += 1;

    // Next-review days
    let days = updatedCard.interval || 1;
    if (updatedCard.nextReviewDate) {
      const d = _daysDiff(updatedCard.nextReviewDate);
      if (d > 0) days = d;
    }

    const feedback = document.createElement('div');
    feedback.className = 'srs-grade-feedback';
    feedback.innerHTML = `<span class="srs-next-review">다음 복습: ${days}일 후</span>`;
    srsCard.appendChild(feedback);

    setTimeout(() => {
      _current++;
      if (_current < _queue.length) {
        renderReviewCard(_queue[_current]);
      } else {
        _renderSummary();
      }
    }, 1200);
  }

  // ── Summary screen ────────────────────────────────────────────

  function _renderSummary() {
    const rv = document.getElementById('reviewView');
    if (!rv) return;
    rv.innerHTML = `
<div class="srs-review-wrap">
  <div class="srs-summary">
    <div class="srs-summary-icon">🎉</div>
    <h2 class="srs-summary-title">오늘 ${_sessionDone}장 복습 완료!</h2>
    <div class="srs-summary-stats">
    </div>
    <button class="srs-done-btn" id="srsDoneBtn">확인</button>
  </div>
</div>`;
    rv.querySelector('#srsDoneBtn').addEventListener('click', exitReviewMode);
  }

  // ── Empty state ───────────────────────────────────────────────

  function _renderEmpty() {
    const rv = document.getElementById('reviewView');
    if (!rv) return;
    rv.innerHTML = `
<div class="srs-review-wrap">
  <div class="srs-review-header">
    <button class="srs-back-btn" id="srsBackBtn">← 나가기</button>
    <div class="srs-progress-wrap"><div class="srs-progress-bar"><div class="srs-progress-fill" style="width:100%"></div></div></div>
  </div>
  <div class="srs-empty">
    <h3>오늘 복습할 카드가 없습니다</h3>
    <p>노트의 섹션에서 "+ 복습 추가" 버튼으로 카드를 만들어 보세요.</p>
    <button class="srs-done-btn" id="srsDoneBtn">확인</button>
  </div>
</div>`;
    rv.querySelector('#srsBackBtn').addEventListener('click', exitReviewMode);
    rv.querySelector('#srsDoneBtn').addEventListener('click', exitReviewMode);
  }

  // ── Exit review mode ──────────────────────────────────────────

  function exitReviewMode() {
    const rv = document.getElementById('reviewView');
    if (rv) rv.style.display = 'none';
    if (typeof switchView === 'function') switchView('home');
  }

  // ── Public: total due count (used by home_view.js) ────────────

  async function getTotalDueCount() {
    try {
      const cards = await _fetchDueCards(null);
      return cards.length;
    } catch (e) {
      return 0;
    }
  }

  window.enterReviewMode  = enterReviewMode;
  window.renderReviewCard = renderReviewCard;
  window.showAnswer       = showAnswer;
  window.exitReviewMode   = exitReviewMode;
  window.getTotalDueCount = getTotalDueCount;

})();
