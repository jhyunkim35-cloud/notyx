// Split-view panels and PDF popup.
// Depends on: constants.js (extractedImages, recommendedSlides, currentNoteId, storedHighlightedTranscript, storedFilteredText, storedNotesText, _accordionOpenLabels, _classifyCache, debugLog), markdown.js (escHtml), ui.js (showSuccessToast, showToast), image_gallery.js (insertImagesInline), quiz.js (launchQuiz, clearQuizInlineArea, classifyNoteContent, renderClassifyArea), firestore_sync.js (saveNoteFS, getNoteFS).

function populateSplitImagePanel() {
  const panel  = document.getElementById('splitImagePanel');
  const grid   = document.getElementById('splitImageGrid');
  const countEl  = document.getElementById('splitImageCount');
  const insertBtn = document.getElementById('splitImageInsertBtn');
  if (!panel || !grid) return;

  if (!extractedImages.length) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  grid.innerHTML = '';

  const sortedImages = [...extractedImages].sort((a, b) => a.slideNumber - b.slideNumber);
  const seen = new Set();
  for (const img of sortedImages) {
    if (seen.has(img.slideNumber)) continue;
    seen.add(img.slideNumber);

    const item = document.createElement('div');
    item.className = 'img-pick-item';
    item.dataset.slide = String(img.slideNumber);

    const thumbImg = document.createElement('img');
    thumbImg.src = getImgSrc(img);
    thumbImg.style.cssText = 'width:120px; height:90px; object-fit:cover; border-radius:4px; display:block;';

    const label = document.createElement('div');
    label.style.cssText = 'text-align:center; font-size:0.72rem; color:var(--text-muted); padding:2px;';
    label.textContent = `슬라이드 ${img.slideNumber}`;

    item.append(thumbImg, label);
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      const selCount = grid.querySelectorAll('.img-pick-item.selected').length;
      countEl.textContent = selCount ? `${selCount}장 선택됨` : '';
      insertBtn.style.display = selCount ? '' : 'none';
    });
    grid.appendChild(item);
  }

  // Header toggle
  document.getElementById('splitImageHeader').onclick = () => {
    const hidden = grid.style.display === 'none';
    grid.style.display = hidden ? 'flex' : 'none';
    document.getElementById('splitImageToggle').innerHTML = hidden
      ? '<i data-lucide="chevron-up" class="icon-xs"></i>'
      : '<i data-lucide="chevron-down" class="icon-xs"></i>';
  };

  // Insert button
  insertBtn.onclick = async () => {
    const selected = Array.from(grid.querySelectorAll('.img-pick-item.selected'));
    if (!selected.length) return;

    const selectedSlides = selected.map(el => parseInt(el.dataset.slide));
    const prevRecommended = recommendedSlides.slice();
    recommendedSlides = selectedSlides;

    const splitNotes = document.getElementById('splitNotes');
    insertImagesInline(splitNotes);

    recommendedSlides = prevRecommended;

    selected.forEach(el => el.classList.remove('selected'));
    countEl.textContent = '';
    insertBtn.style.display = 'none';
    switchSplitTab('notes');

    // Persist the updated HTML (with images) back to IndexedDB
    if (currentNoteId) {
      try {
        const existing = await getNoteFS(currentNoteId);
        if (existing) {
          const prevInserted = existing.insertedSlideNumbers || [];
          const merged = [...new Set([...prevInserted, ...selectedSlides])].sort((a, b) => a - b);
          await saveNoteFS(Object.assign({}, existing, {
            notesHtml:            splitNotes.innerHTML,
            insertedSlideNumbers: merged,
          }));
          showSuccessToast('💾 저장 업데이트됨');
        }
      } catch (e) {
        console.error('Image insert save error:', e);
        showToast(`❌ 저장 실패: ${e.message}`);
      }
    } else {
      showSuccessToast(`${selectedSlides.length}장 삽입 완료`);
    }
  };
}

// Round 1: Walk text nodes under rootEl and replace "p.3" / "p.3-4" patterns
// with anchor elements that jump to the corresponding slide on click.
// Skips text already inside an <a> to avoid double-linking.
// R7: also skips <button> — markdown.js's renderMarkdown now renders p.N
// refs as .page-cite-chip buttons directly, so by the time this runs on a
// copy of that HTML (splitViewBtn), those refs are already "linked" and
// must not be re-wrapped in a nested <a>.
function linkifySlideRefs(rootEl) {
  if (!rootEl) return;
  const re = /\bp\.(\d+)(?:-(\d+))?\b/gi;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !/p\./i.test(node.textContent)) return NodeFilter.FILTER_SKIP;
      if (node.parentElement && node.parentElement.closest('a, button')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets = [];
  let node;
  while ((node = walker.nextNode())) targets.push(node);
  for (const textNode of targets) {
    const text = textNode.textContent;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let matched = false;
    let m;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      const a = document.createElement('a');
      a.className = 'slide-ref';
      a.href = '#';
      a.dataset.slideStart = m[1];
      if (m[2]) a.dataset.slideEnd = m[2];
      a.textContent = m[0];
      frag.appendChild(a);
      lastIdx = m.index + m[0].length;
    }
    if (!matched) continue;
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// Round 1: Scroll the left slide list to the requested slide and flash-highlight it.
function jumpToSlide(slideNumber) {
  const target = document.querySelector(
    `#splitSlides .split-slide-item[data-slide-number="${slideNumber}"]`
  );
  if (!target) {
    showToast(`슬라이드 ${slideNumber}를 찾을 수 없어요`);
    return;
  }
  // Round 4: on mobile the slide list lives behind a tab; activate it first
  // so scrollIntoView has a visible target.
  if (window.innerWidth <= 768) switchSplitTab('slides');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash-highlight');
  // Force reflow so the animation re-triggers on consecutive clicks.
  void target.offsetWidth;
  target.classList.add('flash-highlight');
}

// Round 2: Highlight the slide currently most-visible inside the left list,
// using IntersectionObserver. Rebinds on each split-viewer open so switching
// notes does not leak observers from prior sessions.
function initActiveSlideObserver() {
  const splitSlides = document.getElementById('splitSlides');
  if (!splitSlides) return;

  // Tear down any prior observer/state from a previous session.
  if (splitSlides._activeSlideObserver) {
    splitSlides._activeSlideObserver.disconnect();
  }
  splitSlides._activeSlideVisibility = new Map();
  splitSlides.querySelectorAll('.split-slide-item.active')
    .forEach(el => el.classList.remove('active'));

  const items = splitSlides.querySelectorAll('.split-slide-item');
  if (!items.length) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      splitSlides._activeSlideVisibility.set(entry.target, entry.intersectionRatio);
    }
    let best = null;
    let bestRatio = 0;
    for (const [el, ratio] of splitSlides._activeSlideVisibility) {
      if (ratio > bestRatio) {
        best = el;
        bestRatio = ratio;
      }
    }
    if (!best || bestRatio <= 0) return;

    const previousActive = splitSlides.querySelector('.split-slide-item.active');
    if (previousActive === best) return;
    if (previousActive) previousActive.classList.remove('active');
    best.classList.add('active');
  }, {
    root: splitSlides,
    threshold: [0, 0.25, 0.5, 0.75, 1],
  });

  splitSlides._activeSlideObserver = observer;
  items.forEach(item => observer.observe(item));
}

// Round 3: Reverse navigation — clicking a slide in the left list scrolls
// the notes pane to the first p.N reference that covers that slide number,
// then flash-highlights the anchor. If no reference exists, toast politely.
function scrollNotesToFirstSlideRef(slideNumber) {
  const splitNotes = document.getElementById('splitNotes');
  const splitAccordion = document.getElementById('splitAccordion');
  if (!splitNotes) return;

  // Always search inside the notes pane (source of truth, accordion is derived).
  // R7: page-cite-chip buttons carry the same data-slide-start/-end dataset
  // as a.slide-ref, so they're matched here too — otherwise this reverse
  // lookup would always miss now that most p.N refs render as chips.
  const anchors = splitNotes.querySelectorAll('a.slide-ref, .page-cite-chip');
  let target = null;
  for (const a of anchors) {
    const start = parseInt(a.dataset.slideStart, 10);
    if (!Number.isFinite(start)) continue;
    const end = a.dataset.slideEnd ? parseInt(a.dataset.slideEnd, 10) : start;
    if (slideNumber >= start && slideNumber <= end) {
      target = a;
      break;
    }
  }
  if (!target) {
    showToast(`p.${slideNumber} 참조가 노트에 없어요`);
    return;
  }

  // If the user is currently looking at the accordion (or another tab), bring
  // them back to the notes tab so the scroll target is actually visible.
  const notesIsVisible = splitNotes.style.display !== 'none';
  if (!notesIsVisible) switchSplitTab('notes');

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('ref-flash');
  void target.offsetWidth;
  target.classList.add('ref-flash');
}

// Round 3: attach the click-on-slide -> scroll-notes handler exactly once.
function initSlideListClickHandler() {
  const splitSlides = document.getElementById('splitSlides');
  if (!splitSlides || splitSlides._slideListClickHandlerAttached) return;
  splitSlides.addEventListener('click', (e) => {
    const item = e.target.closest('.split-slide-item');
    if (!item) return;
    const slideNumber = parseInt(item.dataset.slideNumber, 10);
    if (Number.isFinite(slideNumber)) scrollNotesToFirstSlideRef(slideNumber);
  });
  splitSlides._slideListClickHandlerAttached = true;
}

function switchSplitTab(tab) {
  const _sqArea = document.getElementById('quizInlineArea');
  if (_sqArea && _sqArea._quizApi) _sqArea._quizApi.savePartialIfEligible();
  // Logged-out demo: quiz / classify / ask are the LLM round trip itself.
  // Let the tab activate normally, then answer with a login CTA instead of
  // firing a request — classify in particular fires on click alone.
  const _demoBlocked = window.nyDemoActive && (tab === 'quiz' || tab === 'classify' || tab === 'ask');
  // Quiz/classify tabs: only activate if notes are available
  if ((tab === 'quiz' || tab === 'classify') && !storedNotesText) return;

  document.querySelectorAll('#splitTabs .split-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Round 4: toggle a class on splitViewer so mobile CSS can show/hide the
  // slide-list panel based on the active tab. The class is harmless on
  // desktop because the relevant CSS lives inside the mobile media query.
  const splitViewer = document.getElementById('splitViewer');
  if (splitViewer) splitViewer.classList.toggle('tab-slides', tab === 'slides');
  // Quiz fix: the bottom "슬라이드 이미지 선택" picker steals vertical space
  // from the active tab content and partially hides the quiz "다음 ▶" button.
  // The picker is irrelevant during quiz play (you can't insert images into
  // a quiz), so we hide it for the quiz tab on every viewport size. CSS rule
  // lives outside the mobile media query in index.html so it applies on
  // desktop too. `classify` gets the same treatment for the same reason.
  if (splitViewer) {
    splitViewer.classList.toggle('tab-quiz', tab === 'quiz');
    splitViewer.classList.toggle('tab-classify', tab === 'classify');
  }

  const notesEl      = document.getElementById('splitNotes');
  const transcriptEl = document.getElementById('splitTranscript');
  const accordionEl  = document.getElementById('splitAccordion');
  const quizAreaEl   = document.getElementById('quizInlineArea');
  const classifyEl   = document.getElementById('classifyArea');
  const askEl        = document.getElementById('splitAsk');

  notesEl.style.display      = tab === 'notes'      ? 'flex'  : 'none';
  transcriptEl.style.display = tab === 'transcript' ? 'flex'  : 'none';
  accordionEl.style.display  = tab === 'accordion'  ? 'block' : 'none';
  quizAreaEl.style.display   = tab === 'quiz'       ? 'flex'  : 'none';
  classifyEl.style.display   = tab === 'classify'   ? 'flex'  : 'none';
  if (askEl) askEl.style.display = tab === 'ask' ? 'flex' : 'none';

  if (_demoBlocked) { renderDemoLoginCta(tab); return; }

  if (tab === 'transcript' && !transcriptEl.innerHTML.trim()) {
    if (storedHighlightedTranscript) {
      transcriptEl.innerHTML = `<div class="transcript-content">${storedHighlightedTranscript}</div>`;
    } else if (storedFilteredText) {
      transcriptEl.innerHTML = `<div class="transcript-content">${escHtml(storedFilteredText)}</div>`;
    } else {
      transcriptEl.innerHTML = '<span class="placeholder-msg">녹취록이 없습니다.</span>';
    }
  }

  if (tab !== 'accordion') {
    // Save open state before leaving accordion tab
    _accordionOpenLabels = new Set(
      Array.from(accordionEl.querySelectorAll('.acc-section.open .acc-header'))
        .map(h => h.textContent.trim())
    );
  }

  if (tab === 'accordion' && !accordionEl.innerHTML.trim()) {
    // Round 5: delegate to renderAccordion so heading/slide modes share one path.
    renderAccordion(accordionEl, notesEl, accordionEl._mode || 'heading');
  }

  // Refresh weakness badges whenever notes tab is shown
  if (tab === 'notes' && currentNoteId) {
    updateNoteWeaknessBadges(currentNoteId).catch(() => {});
  }

  // Launch quiz settings when switching to quiz tab (only if area is empty)
  if (!_demoBlocked && tab === 'quiz' && !quizAreaEl.innerHTML.trim()) {
    launchQuiz();
  }

  // Round 6: render or refresh the ask panel when it becomes active.
  // Don't rebuild if user has an in-progress draft (input value would be lost),
  // unless a new selection-based context just arrived.
  if (!_demoBlocked && tab === 'ask' && askEl && (!askEl.innerHTML.trim() || askEl._pendingContext)) {
    renderAskPanel();
  }

  // Classify tab: use cache or fetch from API
  if (!_demoBlocked && tab === 'classify') {
    const noteId = currentNoteId;
    // Invalidate cache when a different note is active
    if (_classifyCache && _classifyCache.noteId !== noteId) {
      _classifyCache = null;
      classifyEl.innerHTML = '';
    }
    if (_classifyCache) {
      // Already rendered — nothing to do (content persists in the DOM)
      return;
    }
    if (classifyEl.innerHTML.trim()) return; // currently loading, don't re-trigger

    // Show loading spinner
    classifyEl.innerHTML = `<div class="quiz-inline-loading"><span class="qi-spinner"></span><span>분류 분석 중…</span></div>`;

    classifyNoteContent(storedNotesText)
      .then(items => {
        _classifyCache = { noteId, items };
        renderClassifyArea(items);
      })
      .catch(err => {
        classifyEl.innerHTML = `<span class="placeholder-msg" style="color:#ef4444;">오류: ${escHtml(err.message)}</span>`;
        _classifyCache = null;
      });
  }
}

function buildAccordionView(sourceEl) {
  const container = sourceEl.querySelector('.md-content') || sourceEl;
  const nodes = Array.from(container.childNodes);

  let html = '';
  let h1Section = null; // { label, body }
  let h2Section = null; // { label, body }

  function closeH2() {
    if (!h2Section) return;
    const content = h2Section.body || '';
    const h2Html = `<div class="acc-sub open">` +
      `<div class="acc-sub-header" onclick="this.closest('.acc-sub').classList.toggle('open')">► ${h2Section.label}</div>` +
      `<div class="acc-sub-body">${content}</div>` +
      `</div>`;
    if (h1Section) h1Section.body += h2Html;
    else html += h2Html;
    h2Section = null;
  }

  function closeH1() {
    closeH2();
    if (!h1Section) return;
    html += `<div class="acc-section open">` +
      `<div class="acc-header" onclick="this.closest('.acc-section').classList.toggle('open')">${h1Section.label}</div>` +
      `<div class="acc-body">${h1Section.body}</div>` +
      `</div>`;
    h1Section = null;
  }

  for (const node of nodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();

    if (tag === 'h1') {
      closeH1();
      h1Section = { label: node.innerHTML, body: '' };
    } else if (tag === 'h2') {
      closeH2();
      h2Section = { label: node.innerHTML, body: '' };
    } else if (tag === 'hr') {
      // skip
    } else {
      const content = node.outerHTML;
      if (h2Section) h2Section.body += content;
      else if (h1Section) h1Section.body += content;
      else html += content;
    }
  }
  closeH1();

  return html || '<span class="placeholder-msg">내용이 없습니다.</span>';
}

// Round 5: Group note elements by the slide they reference (first a.slide-ref
// inside each top-level element). Consecutive elements pointing to the same
// slide range merge into one section. Content appearing before any reference
// goes into a "도입" group.
function buildSlideAccordion(sourceEl) {
  const container = sourceEl.querySelector('.md-content') || sourceEl;
  const nodes = Array.from(container.childNodes)
    .filter(n => n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() !== 'hr');

  const groups = []; // { label, slideStart, slideEnd, body }
  let current = null;

  for (const el of nodes) {
    // R7: page-cite-chip buttons carry the same data-slide-start/-end dataset
    // as a.slide-ref (see linkifySlideRefs) — match either.
    const firstRef = el.querySelector && el.querySelector('a.slide-ref, .page-cite-chip');
    if (firstRef) {
      const start = parseInt(firstRef.dataset.slideStart, 10);
      if (Number.isFinite(start)) {
        const end = firstRef.dataset.slideEnd
          ? parseInt(firstRef.dataset.slideEnd, 10)
          : start;
        const label = firstRef.dataset.slideEnd
          ? `슬라이드 ${start}–${end}`
          : `슬라이드 ${start}`;
        if (!current || current.slideStart !== start || current.slideEnd !== end) {
          current = { label, slideStart: start, slideEnd: end, body: '' };
          groups.push(current);
        }
      }
    }
    if (!current) {
      current = { label: '도입', slideStart: 0, slideEnd: 0, body: '' };
      groups.push(current);
    }
    current.body += el.outerHTML;
  }

  if (!groups.length) {
    return '<span class="placeholder-msg">슬라이드 참조가 없는 노트입니다.</span>';
  }

  return groups.map(g =>
    `<div class="acc-section open">` +
      `<div class="acc-header" onclick="this.closest('.acc-section').classList.toggle('open')">${g.label}</div>` +
      `<div class="acc-body">${g.body}</div>` +
    `</div>`
  ).join('');
}

// Round 5: Build the accordion in either heading or slide grouping mode.
// Re-applies open-section state and SRS buttons only for the heading mode
// (slide groups don't map cleanly to flashcard section titles).
function renderAccordion(accordionEl, notesEl, mode) {
  if (!accordionEl || !notesEl) return;
  accordionEl._mode = mode;

  if (!notesEl.innerHTML.trim()) {
    accordionEl.innerHTML = '<span class="placeholder-msg">노트가 없습니다.</span>';
    return;
  }

  const builder = mode === 'slide' ? buildSlideAccordion : buildAccordionView;
  const body    = builder(notesEl);
  const hAct    = mode === 'heading' ? 'active' : '';
  const sAct    = mode === 'slide'   ? 'active' : '';

  accordionEl.innerHTML =
    `<div class="acc-mode-toggle">` +
      `<button class="acc-mode-btn ${hAct}" onclick="setAccordionMode('heading')">헤딩별</button>` +
      `<button class="acc-mode-btn ${sAct}" onclick="setAccordionMode('slide')">슬라이드별</button>` +
    `</div>` +
    `<div class="acc-content">${body}</div>`;

  if (mode === 'heading' && _accordionOpenLabels && _accordionOpenLabels.size) {
    accordionEl.querySelectorAll('.acc-header').forEach(h => {
      const sec = h.closest('.acc-section');
      if (!sec) return;
      if (_accordionOpenLabels.has(h.textContent.trim())) sec.classList.add('open');
      else sec.classList.remove('open');
    });
  }

  if (mode === 'heading' && currentNoteId) {
    _attachAccordionSrsButtons(accordionEl, currentNoteId);
  }
}

// Round 5: exposed for the inline onclick on .acc-mode-btn buttons.
function setAccordionMode(mode) {
  const accordionEl = document.getElementById('splitAccordion');
  const notesEl     = document.getElementById('splitNotes');
  if (!accordionEl || !notesEl) return;
  renderAccordion(accordionEl, notesEl, mode);
}

// Round 6: Selection-based ask feature. Drag-select text in the notes or
// accordion view, click the floating "❓ 질문하기" button that appears, and
// jump into the ask tab with that selection as context. Each split-viewer
// session re-runs initAskFeature so listeners can rebind without piling up.
function initAskFeature() {
  const splitViewer = document.getElementById('splitViewer');
  if (!splitViewer || splitViewer._askInitialized) return;
  splitViewer._askInitialized = true;

  let floatBtn = document.getElementById('askFloatBtn');
  if (!floatBtn) {
    floatBtn = document.createElement('button');
    floatBtn.id = 'askFloatBtn';
    floatBtn.innerHTML = '❓ 질문하기';
    // Prevent the mousedown from collapsing the selection before our click fires.
    floatBtn.addEventListener('mousedown', (e) => e.preventDefault());
    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text) return;
      const splitAsk = document.getElementById('splitAsk');
      if (splitAsk) splitAsk._pendingContext = text;
      floatBtn.style.display = 'none';
      switchSplitTab('ask');
    });
    document.body.appendChild(floatBtn);
  }

  function updateFloatBtn() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      floatBtn.style.display = 'none';
      return;
    }
    const text = sel.toString().trim();
    if (!text || text.length < 2) {
      floatBtn.style.display = 'none';
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const containerEl = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!containerEl) return;
    // Restrict to notes/accordion content — selections inside slide labels or
    // the carousel shouldn't show the button.
    if (!containerEl.closest('#splitNotes') && !containerEl.closest('#splitAccordion')) {
      floatBtn.style.display = 'none';
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      floatBtn.style.display = 'none';
      return;
    }
    // Anchor near the selection's top-right, clamped to the viewport.
    floatBtn.style.left = `${Math.min(rect.right - 60, window.innerWidth - 140)}px`;
    floatBtn.style.top  = `${Math.max(rect.top - 40, 8)}px`;
    floatBtn.style.display = 'flex';
  }

  document.addEventListener('mouseup', () => setTimeout(updateFloatBtn, 0));
  document.addEventListener('touchend', () => setTimeout(updateFloatBtn, 0));
  // Hide on internal scroll so the button doesn't float over stale geometry.
  splitViewer.addEventListener('scroll', () => { floatBtn.style.display = 'none'; }, true);
}

// Round 6: Render the ask panel (context card + history + input). Called
// when the ask tab activates or after a question round-trip completes.
function renderAskPanel() {
  const askEl = document.getElementById('splitAsk');
  if (!askEl) return;
  if (!askEl._history) askEl._history = [];
  if (askEl._pendingContext) {
    askEl._context = askEl._pendingContext;
    askEl._pendingContext = null;
  }

  const ctx = askEl._context;
  const ctxPreview = ctx && ctx.length > 200 ? ctx.slice(0, 200) + '…' : ctx;
  const ctxHtml = ctx
    ? `<div class="ask-context-card">` +
        `<span class="ask-context-label">선택한 부분</span>` +
        `<span class="ask-context-text">${escHtml(ctxPreview)}</span>` +
        `<button class="ask-context-clear" onclick="clearAskContext()" title="컨텍스트 지우기">×</button>` +
      `</div>`
    : '';

  const historyHtml = askEl._history.length
    ? askEl._history.map(m =>
        m.role === 'user'
          ? `<div class="ask-msg user">${escHtml(m.text)}</div>`
          : `<div class="ask-msg bot">${renderMarkdown(m.text)}</div>`
      ).join('')
    : `<div class="ask-empty">` +
        `<i data-lucide="help-circle" class="icon-lg"></i>` +
        `<div>${ctx ? '선택한 부분에 대해 질문해보세요' : '노트 전체에 대해 질문해보세요'}</div>` +
        `<div style="font-size:0.75rem;">예: "이게 무슨 뜻이야?" / "예시 들어줄 수 있어?"</div>` +
      `</div>`;

  askEl.innerHTML =
    `<div class="ask-container">` +
      ctxHtml +
      `<div class="ask-history" id="askHistory">${historyHtml}</div>` +
      `<div class="ask-input-area">` +
        `<textarea class="ask-input" id="askInput" placeholder="질문 입력... (Ctrl+Enter로 보내기)" rows="1"></textarea>` +
        `<button class="ask-send-btn" id="askSendBtn" onclick="sendAskQuestion()"><i data-lucide="send" class="icon-sm"></i>보내기</button>` +
      `</div>` +
    `</div>`;

  if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();

  const input = document.getElementById('askInput');
  if (input) {
    input.focus();
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendAskQuestion();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  const histEl = document.getElementById('askHistory');
  if (histEl) histEl.scrollTop = histEl.scrollHeight;
}

// Round 6: clear the selection context and re-render. Exposed for inline onclick.
function clearAskContext() {
  const askEl = document.getElementById('splitAsk');
  if (!askEl) return;
  askEl._context = null;
  renderAskPanel();
}

// Round 6: send the typed question to /api/claude with the current context
// (selection or whole-note fallback) and append the answer to the history.
async function sendAskQuestion() {
  const askEl = document.getElementById('splitAsk');
  const input = document.getElementById('askInput');
  if (!askEl || !input) return;
  const question = input.value.trim();
  if (!question) return;

  if (!askEl._history) askEl._history = [];
  askEl._history.push({ role: 'user', text: question });

  // Build a tutor-style system prompt with the relevant context.
  const ctx = askEl._context;
  let systemPrompt = '너는 학생의 강의 학습을 돕는 친절한 한국어 튜터야. 사용자의 질문에 명확하고 간결하게 답변해줘. 필요하면 예시를 들고, 답을 모르면 솔직히 모른다고 말해.';
  if (ctx) {
    systemPrompt += `\n\n학생이 선택한 노트 부분:\n${ctx}`;
  } else if (typeof storedNotesText !== 'undefined' && storedNotesText) {
    const snippet = storedNotesText.length > 4000
      ? storedNotesText.slice(0, 4000) + '\n\n[노트 일부만 첨부됨]'
      : storedNotesText;
    systemPrompt += `\n\n학생의 학습 노트 전체:\n${snippet}`;
  }

  // Anthropic Messages API expects role-tagged messages; map our history.
  const priorHistory = askEl._history.slice(0, -1);
  const messages = priorHistory.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));
  messages.push({ role: 'user', content: question });

  input.value = '';
  input.style.height = 'auto';
  renderAskPanel();

  const histEl = document.getElementById('askHistory');
  if (histEl) {
    const loader = document.createElement('div');
    loader.className = 'ask-loading';
    loader.innerHTML = '<span class="qi-spinner"></span>답변 생성 중…';
    loader.id = 'askLoader';
    histEl.appendChild(loader);
    histEl.scrollTop = histEl.scrollHeight;
  }
  const sendBtn = document.getElementById('askSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  try {
    let idToken = null;
    try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}

    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages,
        idToken,
        feature: 'ask',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || err?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const answer = data?.content?.[0]?.text || '(빈 응답)';
    askEl._history.push({ role: 'bot', text: answer });
  } catch (e) {
    askEl._history.push({ role: 'bot', text: `오류: ${e.message}` });
  }

  renderAskPanel();
}

function openPdfPopup(bodyEl) {
  const contentEl = bodyEl.querySelector('.md-content') || bodyEl;
  const titleEl = contentEl.querySelector('h1');
  const pageTitle = titleEl ? titleEl.textContent.trim() : '통합 학습 노트';

  debugLog('PDF', 'Opening print-ready page');

  const win = window.open('', '_blank');
  if (!win) {
    showToast('⚠️ 팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
    return;
  }

  // Clone content and convert base64 images to blob URLs to avoid megabytes in document.write
  const cloned = contentEl.cloneNode(true);
  cloned.querySelectorAll('img[src^="data:"]').forEach(img => {
    try {
      const [header, b64] = img.src.split(',');
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      img.src = URL.createObjectURL(new Blob([arr], { type: mime }));
    } catch(e) {}
  });

  win.document.write(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>${pageTitle}</title>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    * { font-family: 'Noto Sans KR', 'Segoe UI', 'Apple SD Gothic Neo', sans-serif; box-sizing:border-box; margin:0; padding:0; color:#1a1a1a; }
    body { background:#fff; font-size:11pt; line-height:1.8; padding:1.5cm 2cm; max-width:21cm; margin:0 auto; }
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
    #printBar { position:fixed; top:0; left:0; right:0; background:#f0f0f0; border-bottom:2px solid #ccc; padding:8px 16px; display:flex; align-items:center; gap:12px; z-index:9999; }
    #printBar button { padding:6px 16px; font-size:10pt; font-weight:600; border:none; border-radius:4px; cursor:pointer; }
    #printBtn { background:#333; color:#fff; }
    #printBtn:hover { background:#1a1a1a; }
    #closeBtn { background:#e5e7eb; color:#333; }
    #closeBtn:hover { background:#d1d5db; }
    body { padding-top:calc(1.5cm + 44px); }
    @media print {
      #printBar { display:none !important; }
      body { padding:0; padding-top:0; }
      h2, h3 { page-break-after:avoid; }
      ul, ol, p { page-break-inside:avoid; }
      figure { page-break-inside:avoid; }
      table, th, td { border:1px solid #333 !important; }
      th { background:#e0e0e0 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .highlight-important { background:#fff3cd !important; color:#856404 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .inserted-slide-img { max-width:100% !important; }
    }
  </style>
</head>
<body>
  <div id="printBar">
    <button id="printBtn" onclick="window.print()">📄 PDF로 저장 (Ctrl+P)</button>
    <button id="closeBtn" onclick="window.close()">✕ 닫기</button>
    <span style="font-size:9pt; color:#666;">인쇄 대화상자에서 'PDF로 저장'을 선택하세요</span>
  </div>
  ${cloned.innerHTML}
</body>
</html>`);
  win.document.close();
  debugLog('PDF', 'Print-ready page opened');
}

function _accSrsToday() {
  const d = new Date();
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

async function _attachAccordionSrsButtons(container, noteId) {
  if (!noteId || typeof cardIdFor !== 'function' || typeof saveSrsCard !== 'function') return;
  let folderId = '';
  try {
    const note = await getNoteFS(noteId);
    if (note) folderId = note.folderId || '';
  } catch (e) {}

  container.querySelectorAll('.acc-sub-header').forEach(header => {
    const raw = header.textContent || '';
    const sectionTitle = raw.replace(/^[►▶]\s*/, '').trim();
    if (!sectionTitle) return;

    const cardId = cardIdFor(folderId, noteId, sectionTitle);
    const btn = document.createElement('button');
    btn.className = 'srs-add-btn';
    btn.textContent = '+ 복습 추가';

    const setActive = () => {
      btn.textContent = '✓ 복습 중';
      btn.disabled = true;
      btn.classList.add('active');
    };

    if (typeof getSrsCard === 'function') {
      getSrsCard(cardId).then(existing => {
        if (existing) {
          setActive();
        } else {
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            await saveSrsCard({
              id: cardId, folderId, noteId, sectionTitle,
              nextReviewDate: _accSrsToday(),
              interval: 0, repetitions: 0, easeFactor: 2.5,
            }).catch(() => {});
            setActive();
            if (typeof showToast === 'function') showToast('✓ 복습 카드에 추가됨');
          });
        }
      }).catch(() => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          await saveSrsCard({
            id: cardId, folderId, noteId, sectionTitle,
            nextReviewDate: _accSrsToday(),
            interval: 0, repetitions: 0, easeFactor: 2.5,
          }).catch(() => {});
          setActive();
          if (typeof showToast === 'function') showToast('✓ 복습 카드에 추가됨');
        });
      });
    }

    header.appendChild(btn);
  });
}
