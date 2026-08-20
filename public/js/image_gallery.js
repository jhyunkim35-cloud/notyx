// Image gallery: gallery rendering, AI recommendation, inline insertion.
// Depends on: constants.js (extractedImages, recommendedSlides, imageDescriptions, imageAnalysisMode, visionModel, storedPptText, storedFilteredText, abortController, debugLog), markdown.js (getImgSrc), ui.js (agentLog, showToast, showSuccessToast), firestore_sync.js (saveNoteFS, getNoteFS).

function updateGalleryConfirmCount() {
  const n = document.querySelectorAll('.image-thumb-wrap .image-thumb-cb:checked').length;
  const btn = document.getElementById('imageConfirmBtn');
  if (!btn) return;
  if (!btn.disabled) {
    btn.textContent = n > 0
      ? `✅ 선택 완료 — ${n}개 노트에 삽입`
      : '✅ 선택 완료 — 노트에 삽입';
  }
}

function noteImageMarkerForGallery(image) {
  if (image && /^note-image-\d+$/.test(image.markerId || '')) return image.markerId;
  const index = Array.isArray(extractedImages) ? extractedImages.indexOf(image) : -1;
  return `note-image-${index >= 0 ? index : (Number.isFinite(image?.slideNumber) ? image.slideNumber : 0)}`;
}

function renderImageGallery(images) {
  extractedImages = images;
  recommendedSlides = [];
  imageDescriptions = {};
  imageAnalysisMode = 'text';

  // Reset mode controls
  const toggleBtn = document.getElementById('imgModeToggleBtn');
  if (toggleBtn) toggleBtn.classList.remove('active');
  document.getElementById('imgCostWarning')?.classList.remove('visible');
  document.getElementById('imgModelSelector')?.classList.remove('visible');
  const badge = document.getElementById('imgModeBadge');
  if (badge) { badge.textContent = '📝 텍스트 기반 추천 (무료)'; badge.classList.remove('mode-vision'); }

  if (!images.length) { return; }

  document.getElementById('imageGalleryCount').textContent = `슬라이드 이미지 (${images.length}개 발견)`;
  document.getElementById('imageSelectionBar').classList.remove('visible');

  const grid = document.getElementById('imageGalleryGrid');
  grid.innerHTML = '';

  images.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'image-thumb-wrap';
    wrap.dataset.index = i;

    const badge = document.createElement('span');
    badge.className = 'recommended-badge';
    badge.textContent = 'AI 추천';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'image-thumb-cb';
    cb.id = `imgcb_${i}`;

    const thumb = document.createElement('img');
    thumb.className = 'image-thumb';
    thumb.src = getImgSrc(img);
    thumb.alt = `슬라이드 ${img.slideNumber}`;
    thumb.loading = 'lazy';

    const label = document.createElement('label');
    label.htmlFor = `imgcb_${i}`;
    label.className = 'image-thumb-label';
    label.textContent = `슬라이드 ${img.slideNumber}`;

    wrap.append(badge, cb, thumb, label);

    wrap.addEventListener('click', e => {
      // Bug fix: clicking the label fires both the native htmlFor checkbox toggle
      // AND this wrap handler — two toggles = net-zero change.  Guard against it.
      if (e.target === cb || e.target === label) return;
      cb.checked = !cb.checked;
      wrap.classList.toggle('selected', cb.checked);
      updateGalleryConfirmCount();
    });
    cb.addEventListener('change', () => {
      wrap.classList.toggle('selected', cb.checked);
      updateGalleryConfirmCount();
    });

    grid.appendChild(wrap);
  });
}

function applyImageRecommendations() {
  if (!recommendedSlides.length) return;
  document.querySelectorAll('.image-thumb-wrap').forEach(wrap => {
    const img = extractedImages[parseInt(wrap.dataset.index)];
    const cb  = wrap.querySelector('.image-thumb-cb');
    if (recommendedSlides.includes(img.slideNumber)) {
      wrap.classList.add('recommended', 'selected');
      cb.checked = true;
    }
  });
  document.getElementById('imageSelectionBar').classList.add('visible');
}

/* ── Mode 1: text-only heuristic recommendation (no API call) ── */
function buildSlideTitleMap(pptText) {
  const map = new Map(); // slideNum → title
  const lines = pptText.split('\n');
  let currentSlide = null;
  for (const line of lines) {
    const slideMatch = line.match(/^\[슬라이드 (\d+)\]$/);
    if (slideMatch) { currentSlide = parseInt(slideMatch[1], 10); continue; }
    if (currentSlide !== null) {
      const titleMatch = line.match(/^제목: (.+)$/);
      if (titleMatch) { map.set(currentSlide, titleMatch[1].trim()); currentSlide = null; }
    }
  }
  return map;
}

/* Inline insertion: finds each recommended slide's matching ## heading by
   title substring or p.N reference and inserts a figure right after it.
   Idempotent — skips slides already inserted. */
function insertImagesInline(containerEl) {
  if (!containerEl || !storedPptText || !recommendedSlides.length || !extractedImages.length) return;

  const slideMap = buildSlideTitleMap(storedPptText); // slideNum → title

  // One representative image per slide (first encountered)
  const imageBySlide = new Map();
  for (const img of extractedImages) {
    if (!imageBySlide.has(img.slideNumber)) imageBySlide.set(img.slideNumber, img);
  }

  const mdContent = containerEl.querySelector('.md-content') || containerEl;
  const h2Els = Array.from(mdContent.querySelectorAll('h2'));

  let insertedCount = 0;

  for (const slideNum of recommendedSlides) {
    const img = imageBySlide.get(slideNum);
    if (!img) continue;

    const slideTitle = (slideMap.get(slideNum) || '').toLowerCase().trim();

    const targetH2 = h2Els.find(h2 => {
      const t = (h2.textContent || '').toLowerCase();

      // 1. Check p.N exact match
      if (t.includes(`p.${slideNum} `) || t.includes(`p.${slideNum}\n`) || t.endsWith(`p.${slideNum}`)) return true;

      // 2. Check p.X-Y range match (e.g. p.2-4 should match slides 2,3,4)
      const rangeMatches = t.matchAll(/p\.(\d+)-(\d+)/g);
      for (const rm of rangeMatches) {
        const start = parseInt(rm[1]), end = parseInt(rm[2]);
        if (slideNum >= start && slideNum <= end) return true;
      }

      // 3. Check p.X~Y or p.X,Y formats
      const commaMatches = t.matchAll(/p\.(\d+(?:[,~]\d+)*)/g);
      for (const cm of commaMatches) {
        const nums = cm[1].split(/[,~]/).map(Number);
        if (nums.includes(slideNum)) return true;
      }

      // 4. Fuzzy title match: if 3+ words from slide title appear in heading
      if (slideTitle && slideTitle.length > 3) {
        const titleWords = slideTitle.split(/[\s,·]+/).filter(w => w.length > 1);
        const matchCount = titleWords.filter(w => t.includes(w)).length;
        if (titleWords.length > 0 && matchCount >= Math.min(3, titleWords.length)) return true;
      }

      return false;
    });
    if (!targetH2) continue;

    // Idempotent: skip if figure already inserted right after this h2
    if (targetH2.nextElementSibling?.tagName === 'FIGURE' &&
        targetH2.nextElementSibling.dataset.slideInserted === String(slideNum)) continue;

    const figure = document.createElement('figure');
    figure.className = 'inserted-slide-figure';
    figure.dataset.slideInserted = String(slideNum);
    const imgEl = document.createElement('img');
    imgEl.src = getImgSrc(img);
    imgEl.dataset.noteImageRef = noteImageMarkerForGallery(img);
    imgEl.className = 'inserted-slide-img';
    imgEl.alt = `슬라이드 ${slideNum}`;
    const caption = document.createElement('figcaption');
    caption.className = 'inserted-slide-caption';
    caption.textContent = `슬라이드 ${slideNum}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'img-remove-btn';
    removeBtn.title = '이미지 제거';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => figure.remove());
    figure.append(imgEl, caption, removeBtn);
    targetH2.insertAdjacentElement('afterend', figure);
    insertedCount++;
  }

  debugLog('IMG', `insertImagesInline: ${insertedCount} images inserted into notes`);
}

function recommendImagesMode1() {
  if (!extractedImages.length) return;

  const hintEl = document.getElementById('imageSelectionHint');
  const bar    = document.getElementById('imageSelectionBar');

  // Parse slide text lengths + keywords from storedPptText (free, no API)
  const slideTextLen = {};
  const slideKeywords = {};
  const rx = /\[슬라이드 (\d+)\]([\s\S]*?)(?=\[슬라이드 \d+\]|$)/g;
  let m;
  while ((m = rx.exec(storedPptText)) !== null) {
    const num = parseInt(m[1]);
    const body = m[2].trim();
    slideTextLen[num] = body.length;
    // Extract title + key nouns (words longer than 2 chars, lowercased)
    slideKeywords[num] = body.split(/\s+/).filter(w => w.length > 2).map(w => w.toLowerCase());
  }

  // Transcript keyword hit ratio per slide
  const keywordHitRatio = {};
  const transcriptLower = (storedFilteredText || '').toLowerCase();
  for (const [numStr, words] of Object.entries(slideKeywords)) {
    const n = parseInt(numStr);
    if (!words.length) { keywordHitRatio[n] = 0; continue; }
    const hits = words.filter(w => transcriptLower.includes(w)).length;
    keywordHitRatio[n] = hits / words.length;
  }

  const uniqueSlides = [...new Set(extractedImages.map(img => img.slideNumber))];
  const scored = uniqueSlides
    .filter(n => {
      // Skip likely title/blank slides: very short text + single small image
      const len = slideTextLen[n] ?? 0;
      const imgCount = extractedImages.filter(i => i.slideNumber === n).length;
      return len > 0 || imgCount > 1; // keep if has any text OR multiple images
    })
    .map(n => {
      const textLen = slideTextLen[n] ?? 0;
      const hitRatio = keywordHitRatio[n] ?? 0;
      // Low text = image-dependent, high transcript mention = professor explained it
      const textScore = textLen === 0 ? 50 : Math.max(1, 200 - textLen);
      const transcriptScore = Math.round(hitRatio * 150);
      const score = textScore + transcriptScore;
      return { slide: n, score };
    })
    .sort((a, b) => b.score - a.score);

  // Recommend top 50%, min 2, max 8
  const topN = Math.min(8, Math.max(2, Math.round(scored.length * 0.5)));
  recommendedSlides = scored.slice(0, topN).map(s => s.slide);
  debugLog('IMG', `Recommended slides: [${recommendedSlides.join(',')}]`);

  document.getElementById('imageGalleryCount').textContent =
    `슬라이드 이미지 (${extractedImages.length}개 발견)`;

  if (recommendedSlides.length) {
    applyImageRecommendations();
    hintEl.textContent = 'PPT 텍스트 분석 기반 추천 이미지가 선택됐습니다. 조정 후 삽입하세요.';
    agentLog(1, `텍스트 기반 이미지 추천 완료: 슬라이드 ${recommendedSlides.join(', ')}`);
  } else {
    hintEl.textContent = '삽입할 이미지를 직접 선택하세요.';
    bar.classList.add('visible');
  }
  updateGalleryConfirmCount();
}

/* ── Cost estimate for Mode 2 ── */
function updateVisionCostEstimate() {
  const uniqueSlides = [...new Set(extractedImages.map(img => img.slideNumber))].length;
  const toAnalyze    = Math.min(uniqueSlides, 10);  // cap at 10
  const TOKENS_PER_IMAGE = 1568;
  const textTokens       = 200;
  const totalTokens      = toAnalyze * TOKENS_PER_IMAGE + textTokens;
  const KRW = 1350;
  const haikuWon  = Math.max(1, Math.round(totalTokens * 0.80 / 1_000_000 * KRW));
  const sonnetWon = Math.max(1, Math.round(totalTokens * 3.00 / 1_000_000 * KRW));
  document.getElementById('imgCostHaiku').textContent  = `Haiku: 약 ${haikuWon}원`;
  document.getElementById('imgCostSonnet').textContent = `Sonnet: 약 ${sonnetWon}원`;
  document.getElementById('imgCostSlideCount').textContent = String(toAnalyze);
}

/* ── Update mode badge ── */
function updateModeBadge(mode) {
  const badge = document.getElementById('imgModeBadge');
  if (!badge) return;
  if (mode === 'vision') {
    const modelName = visionModel === 'sonnet' ? 'Sonnet' : 'Haiku';
    badge.textContent = `🔍 AI 비전 추천 (${modelName})`;
    badge.classList.add('mode-vision');
  } else {
    badge.textContent = '📝 텍스트 기반 추천 (무료)';
    badge.classList.remove('mode-vision');
  }
}

/* ── Mode 2: send images to Claude Vision for descriptions ── */
async function analyzeImagesWithVision(apiKey) {
  const modelId = visionModel === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  // Deduplicate: one representative image per slide
  const seen = new Set();
  const slideImages = [];
  for (const img of extractedImages) {
    if (!seen.has(img.slideNumber)) {
      seen.add(img.slideNumber);
      slideImages.push(img);
    }
  }

  if (!slideImages.length) return {};

  // Cap at 10 slides to keep request manageable
  const toAnalyze = slideImages.slice(0, 10);
  if (slideImages.length > 10) {
    agentLog(0, `이미지 분석: 처음 10개 슬라이드만 분석합니다 (전체 ${slideImages.length}개 중)`);
  }

  // Build multimodal content array
  const content = [];
  for (const img of toAnalyze) {
    content.push({ type: 'text', text: `[슬라이드 ${img.slideNumber}]` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.imageBase64 },
    });
  }
  content.push({
    type: 'text',
    text: '위 각 슬라이드 이미지를 한 줄씩 분석해주세요.\n형식: 슬라이드 N: [HIGH/LOW] [이미지 종류] — [핵심 내용]\n\n이미지 유형 분류 시 다음을 HIGH로 표시: 구조 모형, 흐름도, 비교 차트, 개념도, 다이어그램, 관계도\n다음은 LOW로 표시: 제목 슬라이드, 목차, 텍스트만 있는 슬라이드, 단순 장식 이미지\n\n예시:\n슬라이드 1: [LOW] 제목 슬라이드 — 강의 주제 및 목차\n슬라이드 3: [HIGH] 다이어그램 — 시스템 구조와 데이터 흐름\n슬라이드 7: [HIGH] 그래프 — 분기별 매출 비교\n\n모든 슬라이드를 위 형식으로 출력하세요. 추가 설명 없이 목록만 출력하세요.',
  });

  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: abortController?.signal,
    body: JSON.stringify({ model: modelId, max_tokens: 1024, messages: [{ role: 'user', content }], idToken, isFirstCall: false, feature: 'vision' }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `이미지 분석 API 오류 (${res.status})`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  const descriptions = {};
  for (const line of text.split('\n')) {
    const lm = line.match(/슬라이드\s*(\d+)\s*:\s*(.+)/);
    if (lm) descriptions[parseInt(lm[1])] = lm[2].trim();
  }
  return descriptions;
}

/* ── Mode 2: recommend images using Vision descriptions ── */
async function recommendImagesWithVision(apiKey, notesText) {
  if (!extractedImages.length) return;

  const hintEl   = document.getElementById('imageSelectionHint');
  const bar      = document.getElementById('imageSelectionBar');
  const visionBtn = document.getElementById('imgVisionRunBtn');

  const showBar = (hint) => {
    hintEl.textContent = hint;
    bar.classList.add('visible');
    document.getElementById('imageGalleryCount').textContent =
      `슬라이드 이미지 (${extractedImages.length}개 발견)`;
    updateGalleryConfirmCount();
  };

  try {
    if (visionBtn) { visionBtn.disabled = true; visionBtn.textContent = '🔄 이미지 분석 중…'; }
    document.getElementById('imageGalleryCount').textContent =
      `슬라이드 이미지 (${extractedImages.length}개) — AI 비전 분석 중…`;

    const modelName = visionModel === 'sonnet' ? 'Sonnet' : 'Haiku';
    agentLog(1, `AI 비전 분석 시작 (${modelName} 모델)…`);

    imageDescriptions = await analyzeImagesWithVision(apiKey);
    const descCount = Object.keys(imageDescriptions).length;
    agentLog(1, `이미지 분석 완료 — ${descCount}개 슬라이드 설명 획득`);

    if (!descCount) {
      showBar('이미지 분석 결과 없음 — 직접 선택하세요.');
      return;
    }

    // Show descriptions in activity feed
    Object.entries(imageDescriptions).forEach(([n, d]) => agentLog(1, `슬라이드 ${n}: ${d}`));

    // Use descriptions to make smarter recommendation (text-only API call using haiku)
    const descText = Object.entries(imageDescriptions)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([n, d]) => `슬라이드 ${n}: ${d}`)
      .join('\n');

    const slideNums = [...new Set(extractedImages.map(img => img.slideNumber))].sort((a, b) => a - b);
    const slideList = slideNums.map(n => `슬라이드 ${n}`).join(', ');

    let visionIdToken = null;
    try { visionIdToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController?.signal,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `다음 학습 노트와 AI가 분석한 슬라이드 이미지 설명을 바탕으로, 노트 이해에 실질적으로 도움이 되는 이미지를 추천해주세요.

[학습 노트 (앞부분)]
${notesText.slice(0, 2000)}

[AI 비전 분석 결과 — 슬라이드별 이미지 설명]
${descText}

[전체 이미지 목록]
${slideList}

반드시 아래 형식만 출력하세요:
IMAGES: 슬라이드 3 (다이어그램), 슬라이드 7 (그래프)
추천할 이미지가 없으면: IMAGES: 없음`,
        }],
        idToken: visionIdToken,
        isFirstCall: false,
        feature: 'vision',
      }),
    });

    if (!resp.ok) {
      showBar('추천 분석 실패 — 직접 선택하세요.');
      return;
    }

    const rdata = await resp.json();
    const rtext = (rdata.content?.[0]?.text || '').trim();
    agentLog(1, `비전 기반 추천 결과: ${rtext}`);

    const rm = rtext.match(/IMAGES:\s*([\s\S]+)/i);
    const payload = rm ? rm[1].split('\n')[0].trim() : '';

    recommendedSlides = [];
    if (payload && !/없음/.test(payload)) {
      for (const part of payload.split(',')) {
        const nm = part.match(/슬라이드\s*(\d+)/);
        if (nm) recommendedSlides.push(parseInt(nm[1]));
      }
    }
    // Always include HIGH-priority slides flagged by vision analysis
    const highSlides = Object.entries(imageDescriptions)
      .filter(([, d]) => /\[HIGH\]/i.test(d))
      .map(([n]) => parseInt(n));
    for (const n of highSlides) {
      if (!recommendedSlides.includes(n)) recommendedSlides.push(n);
    }
    if (recommendedSlides.length) {
      // Clear previous selection, then apply new recommendations
      document.querySelectorAll('.image-thumb-wrap').forEach(wrap => {
        const cb = wrap.querySelector('.image-thumb-cb');
        cb.checked = false;
        wrap.classList.remove('selected', 'recommended');
      });
      applyImageRecommendations();
      showBar(`AI 비전 분석(${modelName}) 기반 추천 이미지가 선택됐습니다. 조정 후 삽입하세요.`);
    } else {
      showBar('AI 추천 없음 — 직접 선택하세요.');
    }

    updateModeBadge('vision');
    // Sync mode state so the toggle button reflects the actual current mode
    imageAnalysisMode = 'vision';
    const toggleBtn2 = document.getElementById('imgModeToggleBtn');
    if (toggleBtn2) {
      toggleBtn2.classList.add('active');
      document.getElementById('imgCostWarning')?.classList.add('visible');
      document.getElementById('imgModelSelector')?.classList.add('visible');
      updateVisionCostEstimate();
    }

  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('비전 분석 오류:', e);
    showToast(`❌ AI 이미지 분석 오류: ${e.message}`);
    showBar('분석 오류 — 직접 선택하세요.');
  } finally {
    if (visionBtn) {
      visionBtn.disabled  = false;
      visionBtn.textContent = '🔍 AI 이미지 분석 실행';
    }
  }
}

function insertImagesIntoNotes(images) {
  const notesBody = document.getElementById('finalNotesBody');
  const mdContent = notesBody.querySelector('.md-content') || notesBody;

  // Bug fix: remove any previously inserted section so clicking "선택 완료"
  // multiple times replaces rather than stacks the image block.
  const existing = mdContent.querySelector('.inserted-images-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.className = 'inserted-images-section';
  const hr = document.createElement('hr');
  const heading = document.createElement('h2');
  heading.textContent = '📎 슬라이드 이미지';
  section.append(hr, heading);

  images.forEach(img => {
    const figure = document.createElement('figure');
    figure.className = 'inserted-slide-figure';

    const imgEl = document.createElement('img');
    imgEl.src = getImgSrc(img);
    imgEl.dataset.noteImageRef = noteImageMarkerForGallery(img);
    imgEl.alt = `슬라이드 ${img.slideNumber}`;
    imgEl.className = 'inserted-slide-img';

    const caption = document.createElement('figcaption');
    caption.className = 'inserted-slide-caption';
    caption.textContent = `📎 슬라이드 ${img.slideNumber}`;

    figure.append(imgEl, caption);
    section.appendChild(figure);
  });

  mdContent.appendChild(section);
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
