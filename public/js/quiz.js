// Quiz generation, grading, weakness analysis, exam review, classify.
// Depends on: constants.js (QUIZ_CHOICES_PREFIX, CLASSIFY_LABELS, CLASSIFY_COLORS, currentNoteId, storedNotesText, uuidv4),
//             storage.js (saveQuizResult, getQuizResultsByNote),
//             firestore_sync.js (getAllNotesFS, getAllFoldersFS),
//             markdown.js (renderMarkdown, escHtml),
//             pipeline.js (stripLeadingSummary, buildToolsCachePrefix — Fix 5 Q3 cache reuse).

/* ═══════════════════════════════════════════════
   Quiz
═══════════════════════════════════════════════ */

// Module-level abort controller for in-flight quiz generation
let _quizAbortController = null;

// Abort in-flight quiz on page unload (saves tokens when user closes tab)
window.addEventListener('beforeunload', () => {
  _quizAbortController?.abort();
});

// Try to extract the first complete JSON object from a streaming text buffer.
// Returns { obj, rest } where rest is the unparsed remainder, or null if incomplete.
function tryExtractJsonObject(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape)                    { escape = false; continue; }
    if (ch === '\\' && inString)   { escape = true;  continue; }
    if (ch === '"')                { inString = !inString; continue; }
    if (inString)                  continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (--depth === 0) {
        let obj;
        try { obj = JSON.parse(str.slice(start, i + 1)); } catch(e) { return null; }
        // Consume trailing comma/array-close and whitespace
        const rest = str.slice(i + 1).replace(/^\s*[,\]]\s*/, '');
        return { obj, rest };
      }
    }
  }
  return null; // object is incomplete — need more data
}

// Streaming quiz generator (the only generator path used).
// Calls onQuestion(questionObj, index) each time a complete question object is parsed from the stream.
// Returns { questions, debugInfo } after the stream ends.
async function generateQuizStream(noteText, settings = {}, prevQuestions = [], onQuestion, isNotion = false, signal = undefined) {
  const count        = settings.count        || 10;
  const answerFormat = settings.answerFormat || 'mc';
  const style        = settings.style        || 'mixed';
  const difficulty   = settings.difficulty   || 'medium';

  const styleDesc = {
    mixed:       '개념 이해, 적용/예시, 비교 문제를 골고루 섞어서',
    concept:     '핵심 개념 정의와 이해 중심으로',
    application: '응용, 사례, 예시 기반 문제 위주로',
  }[style] || '골고루';
  const diffDesc = {
    easy:   '기본 개념 확인 수준으로 쉽게',
    medium: '이해와 적용을 요하는 중간 난이도로',
    hard:   '심화 이해와 복합 추론이 필요한 어렵게',
  }[difficulty] || '중간 난이도로';

  const formatSchemas = {
    mc: {
      desc: `five-choice multiple choice`,
      schema: `{"q":"question","choices":["A","B","C","D","E"],"answer":0,"explanation":"why correct + why key wrong answers are wrong","hint":"정답을 직접 언급하지 않는 단서 한 문장","section":"h2 section title"}`,
      validate(q, i) {
        if (!q.q || !Array.isArray(q.choices) || q.choices.length !== 5 ||
            typeof q.answer !== 'number' || q.answer < 0 || q.answer > 4 || !q.explanation)
          throw new Error(`문제 ${i+1} 형식 오류 (객관식)`);
      },
    },
    short: {
      desc: `short-answer`,
      schema: `{"q":"question","type":"short","keywords":["key answer 1","key answer 2"],"fullAnswer":"1-2 sentence model answer","explanation":"brief explanation","hint":"정답을 직접 언급하지 않는 단서 한 문장","section":"h2 section title"}`,
      validate(q, i) {
        if (!q.q || !Array.isArray(q.keywords) || q.keywords.length < 1 || !q.fullAnswer)
          throw new Error(`문제 ${i+1} 형식 오류 (단답형)`);
      },
    },
    essay: {
      desc: `essay / long-answer`,
      schema: `{"q":"question","type":"essay","rubric":["criterion 1","criterion 2","criterion 3"],"modelAnswer":"2-4 sentence model answer","explanation":"what a perfect answer covers","section":"h2 section title"}`,
      validate(q, i) {
        if (!q.q || !Array.isArray(q.rubric) || q.rubric.length < 2 || !q.modelAnswer)
          throw new Error(`문제 ${i+1} 형식 오류 (서술형)`);
      },
    },
  };

  let formatInstruction, validateFn;
  if (answerFormat === 'mixed') {
    formatInstruction =
      `Randomly mix all three question types in roughly equal proportion. ` +
      `Each element must include a "type" field: "mc" | "short" | "essay". ` +
      `MC schema: ${formatSchemas.mc.schema}. ` +
      `Short-answer schema: ${formatSchemas.short.schema}. ` +
      `Essay schema: ${formatSchemas.essay.schema}.`;
    validateFn = (q, i) => {
      const t = q.type;
      if (!t || !formatSchemas[t]) throw new Error(`문제 ${i+1} type 필드 오류 (${t})`);
      formatSchemas[t].validate(q, i);
    };
  } else {
    const f = formatSchemas[answerFormat] || formatSchemas.mc;
    formatInstruction = `Generate only ${f.desc} questions. Each element schema: ${f.schema}.`;
    validateFn = f.validate;
  }

  const PREFERRED_MODEL = 'claude-sonnet-4-6';
  const FALLBACK_MODEL = 'claude-sonnet-4-5';
  let MODEL = PREFERRED_MODEL;
  const recentPrev = prevQuestions.slice(0, 30);
  const dedupClause = recentPrev.length > 0
    ? `\n\nCRITICAL DUPLICATION RULE: The user has recently taken quizzes containing the following questions. You MUST NOT generate:
1. Questions that are identical or nearly identical to these
2. Questions that test THE SAME CONCEPT using similar wording or similar example scenarios
3. Questions where the correct answer choice has the same content, even if phrased differently
4. Questions that approach a topic from the same angle (e.g., if a previous question asked about the "definition of X", do not ask about the "meaning of X" or "what X refers to")

Instead, cover DIFFERENT concepts from the source material, OR if you must revisit a concept, approach it from a genuinely different angle (e.g., application vs. definition, comparison vs. identification, cause vs. effect).

Previous questions to avoid duplicating (${recentPrev.length} total):
${recentPrev.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Before finalizing each question you generate, check it against the list above. If it overlaps in concept, angle, or phrasing, discard it and generate a different one.`
    : '';
  const notionClause = isNotion
    ? `This content is from a Notion page (markdown). Generate quiz questions based on the key concepts in this text. `
    : '';
  const systemPrompt =
    `You are a quiz generator for Korean university exam preparation. ` +
    notionClause +
    `Generate exactly ${count} questions from the provided study notes. ` +
    `IMPORTANT: If you sense you're running low on output space, keep explanations SHORTER rather than leaving questions out. Completing all ${count} questions is more important than long explanations. Never emit an incomplete trailing question. ` +
    `Rules: 1) ${styleDesc} 문제를 출제하세요. 2) ${diffDesc} 출제하세요. ` +
    `3) Cover different sections of the notes evenly. 4) All content in Korean. ` +
    `5) Output ONLY a valid JSON array — no markdown, no preamble, no backticks. ` +
    formatInstruction +
    dedupClause;

  const maxTokens = Math.max(16000, count * 1500); // scale with question count
  const t0  = Date.now();
  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  // Fix 5 (Q3): cache the note text with the exact same layout as the summary/
  // mindmap/암기 tools in pipeline.js (all claude-sonnet-4-6, via buildToolsCachePrefix)
  // so a quiz generated soon after one of those reuses the cache instead of
  // re-paying full input cost.
  const cachePrefix = buildToolsCachePrefix(stripLeadingSummary(noteText));
  const makeStreamBody = () => JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    stream: true,
    system: systemPrompt,
    messages: [{ role: 'user', content: [
      { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '위 학습 노트를 바탕으로 문제를 출제하세요.' }
    ]}],
    idToken,
    isFirstCall: false,
    feature: 'quiz',
  });
  let res = await fetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: makeStreamBody(), signal });
  if (!res.ok && MODEL === PREFERRED_MODEL) {
    let errText = ''; try { errText = await res.clone().text(); } catch {}
    if (/model|not.found|invalid/i.test(errText) || res.status === 404 || res.status === 400) {
      console.warn(`[quiz] ${PREFERRED_MODEL} failed, falling back to ${FALLBACK_MODEL}`);
      MODEL = FALLBACK_MODEL;
      res = await fetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: makeStreamBody(), signal });
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 오류 (${res.status})`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let sseRaw   = ''; // raw SSE bytes waiting to be processed
  let textBuf  = ''; // accumulated model text (partial JSON)
  let questionIndex = 0;
  const questions = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseRaw += decoder.decode(value, { stream: true });

      // Split by double-newline to isolate complete SSE events; keep trailing incomplete part
      const events = sseRaw.split('\n\n');
      sseRaw = events.pop();

      for (const event of events) {
        const dataLine = event.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = dataLine.slice(6);
        if (data === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(data); } catch(e) { continue; }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          textBuf += evt.delta.text;

          // Extract and deliver every complete JSON object as it arrives
          let extracted;
          while ((extracted = tryExtractJsonObject(textBuf)) !== null) {
            textBuf = extracted.rest;
            try {
              validateFn(extracted.obj, questionIndex);
              questions.push(extracted.obj);
              onQuestion(extracted.obj, questionIndex++);
            } catch(e) {
              console.warn('generateQuizStream: skipping invalid question object:', e.message);
            }
          }
        }
      }
    }
  } finally {
    // D2: cancel() actively closes the underlying body stream and releases
    // the connection. releaseLock alone leaves the stream open until GC,
    // which leaks connections on aborted/early-exit paths. Matches api.js.
    reader.cancel().catch(() => {});
  }

  const responseTimeMs = Date.now() - t0;

  // Fallback: if streaming missed objects (e.g. model output was not well-formed incrementally),
  // try to parse any remaining buffer content
  if (textBuf.trim() && questions.length < count) {
    try {
      const fallback = JSON.parse(textBuf.replace(/^[^\[]*/, '').replace(/[^\]]*$/, '') || '[]');
      if (Array.isArray(fallback)) {
        for (const q of fallback) {
          try {
            validateFn(q, questionIndex);
            questions.push(q);
            onQuestion(q, questionIndex++);
          } catch(e) { /* skip invalid */ }
        }
      }
    } catch(e) { /* ignore fallback parse error */ }
  }

  if (questions.length < 1) throw new Error('문제를 생성하지 못했습니다');

  const sliced = questions.slice(0, count);
  return {
    questions: sliced,
    debugInfo: {
      model:         MODEL,
      responseTimeMs,
      rawResponse:   JSON.stringify(sliced, null, 2),
      noteTextLen:   noteText.length,
    },
  };
}

function clearQuizInlineArea(containerEl) {
  const area = containerEl || document.getElementById('quizInlineArea');
  if (!area) return;
  area.innerHTML = '';
  area.style.display = 'none';
  // If using the split viewer quiz area and quiz tab was active, switch back to notes tab
  if (!containerEl && document.getElementById('quizBtn')?.classList.contains('active')) {
    switchSplitTab('notes');
  }
}

async function showQuizSettings(noteTitle, noteId, noteText, containerEl) {
  const area = containerEl || document.getElementById('quizInlineArea');
  area.style.display = 'flex';

  const settings = { count: 10, answerFormat: 'mc', style: 'mixed', difficulty: 'medium' };

  let _weaknessCardHtml = '';
  if (noteId) {
    try {
      const _prevRes = await getQuizResultsByNote(noteId);
      const _totalAnswered = _prevRes.reduce((sum, r) => sum + (r.answeredCount || r.total || 0), 0);
      if (_totalAnswered >= 30) {
        _weaknessCardHtml = `<div class="weakness-preview-card" id="weaknessPreviewCard">
          <div class="weakness-preview-header" id="weaknessPreviewHeader">
            <span><i data-lucide="presentation" class="icon-sm"></i> 내 약점 분석 (총 ${_totalAnswered}문제 풀이)</span>
            <span class="weakness-preview-toggle" id="weaknessPreviewToggle">▼ 펼쳐서 보기</span>
          </div>
          <div class="weakness-preview-body" id="weaknessPreviewBody" style="display:none;"></div>
        </div>`;
      }
    } catch (_e) { /* silent */ }
  }

  area.innerHTML = _weaknessCardHtml + `
    <div class="quiz-settings-panel">
      <div class="quiz-settings-title"><i data-lucide="flask-conical" class="icon-sm"></i> 퀴즈 설정 — ${escHtml(noteTitle)}</div>
      <div class="quiz-setting-row">
        <span class="quiz-setting-label">문제 수</span>
        <div class="quiz-seg-group" id="qsCount">
          <button class="quiz-seg-btn" data-val="5">5문제</button>
          <button class="quiz-seg-btn" data-val="7">7문제</button>
          <button class="quiz-seg-btn active" data-val="10">10문제</button>
        </div>
        <span style="font-size:0.78rem;color:var(--text-muted);margin-top:0.2rem;">한 번에 한 문제씩 풀이 · 최대 10문제</span>
      </div>
      <div class="quiz-setting-row">
        <span class="quiz-setting-label">답안 형식</span>
        <div class="quiz-seg-group" id="qsFormat">
          <button class="quiz-seg-btn active" data-val="mc">객관식</button>
          <button class="quiz-seg-btn" data-val="short">단답형</button>
          <button class="quiz-seg-btn" data-val="essay">서술형</button>
          <button class="quiz-seg-btn" data-val="mixed">혼합</button>
        </div>
      </div>
      <div class="quiz-setting-row">
        <span class="quiz-setting-label">문제 유형</span>
        <div class="quiz-seg-group" id="qsStyle">
          <button class="quiz-seg-btn active" data-val="mixed">혼합</button>
          <button class="quiz-seg-btn" data-val="concept">개념</button>
          <button class="quiz-seg-btn" data-val="application">응용</button>
        </div>
      </div>
      <div class="quiz-setting-row">
        <span class="quiz-setting-label">난이도</span>
        <div class="quiz-seg-group" id="qsDiff">
          <button class="quiz-seg-btn" data-val="easy">쉬움</button>
          <button class="quiz-seg-btn active" data-val="medium">보통</button>
          <button class="quiz-seg-btn" data-val="hard">어려움</button>
        </div>
      </div>
      <div class="quiz-setting-row" style="justify-content:flex-end;gap:0.5rem;padding-top:0.25rem;">
        <button id="qsCloseBtn" style="padding:0.5rem 1rem;border-radius:7px;border:1px solid var(--border);background:var(--surface3);color:var(--text);font-size:0.88rem;cursor:pointer;">닫기</button>
        <button id="qsStartBtn" class="quiz-grade-btn">퀴즈 시작</button>
      </div>
    </div>`;

  const _wpHeader = area.querySelector('#weaknessPreviewHeader');
  const _wpBody   = area.querySelector('#weaknessPreviewBody');
  const _wpToggle = area.querySelector('#weaknessPreviewToggle');
  let _wpExpanded = false;
  let _wpRendered = false;
  if (_wpHeader) {
    _wpHeader.addEventListener('click', async () => {
      _wpExpanded = !_wpExpanded;
      _wpBody.style.display = _wpExpanded ? 'block' : 'none';
      _wpToggle.innerHTML = _wpExpanded
        ? '<i data-lucide="chevron-up" class="icon-xs"></i> 접기'
        : '<i data-lucide="chevron-down" class="icon-xs"></i> 펼쳐서 보기';
      if (_wpExpanded && !_wpRendered) {
        _wpRendered = true;
        _wpBody.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted);">분석 중...</div>';
        try {
          const report = await getWeaknessReport(noteId);
          _wpBody.innerHTML = buildWeaknessPreviewHtml(report);
          wireWeaknessReviewButtons(_wpBody);
        } catch (_e) {
          _wpBody.innerHTML = '<div style="padding:1rem;color:var(--text-muted);">약점 데이터를 불러올 수 없어요.</div>';
        }
      }
    });
  }

  area.querySelectorAll('.quiz-seg-group').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.quiz-seg-btn');
      if (!btn) return;
      group.querySelectorAll('.quiz-seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const key = { qsCount: 'count', qsFormat: 'answerFormat', qsStyle: 'style', qsDiff: 'difficulty' }[group.id];
      const val = btn.dataset.val;
      settings[key] = key === 'count' ? Number(val) : val;
    });
  });

  area.querySelector('#qsCloseBtn').addEventListener('click', clearQuizInlineArea);
  area.querySelector('#qsStartBtn').addEventListener('click', async () => {
    // Show loading UI with rotating status messages and elapsed timer
    const statusMessages = [
      '문제를 구상하는 중...',
      '핵심 개념을 분석하는 중...',
      '보기를 만드는 중...',
      '난이도를 조절하는 중...',
      '거의 다 됐어요!',
    ];
    let msgIndex = 0;
    let elapsedSec = 0;

    area.innerHTML = `
      <div class="quiz-loading-container">
        <div class="quiz-loading-spinner"></div>
        <div class="quiz-loading-msg" id="qlMsg">${statusMessages[0]}</div>
        <div class="quiz-loading-timer" id="qlTimer">경과 시간: 0:00</div>
      </div>`;

    const msgEl   = area.querySelector('#qlMsg');
    const timerEl = area.querySelector('#qlTimer');

    // Rotate status messages every 2s with a brief fade
    const msgInterval = setInterval(() => {
      msgIndex = (msgIndex + 1) % statusMessages.length;
      msgEl.classList.add('fade-out');
      setTimeout(() => {
        msgEl.textContent = statusMessages[msgIndex];
        msgEl.classList.remove('fade-out');
      }, 350);
    }, 2000);

    // Tick elapsed timer every second
    const timerInterval = setInterval(() => {
      elapsedSec++;
      const m = Math.floor(elapsedSec / 60);
      const s = String(elapsedSec % 60).padStart(2, '0');
      timerEl.textContent = `경과 시간: ${m}:${s}`;
    }, 1000);

    // Streaming state
    let firstArrived = false;
    const streamedQuestions = [];
    const totalExpected = settings.count;
    let quizApi = null;

    function appendStreamCard(q, idx) {
      if (!firstArrived) {
        firstArrived = true;
        // runInlineQuiz sets container.innerHTML which clears the loading UI
        quizApi = runInlineQuiz(
          streamedQuestions,  // live reference — grows as questions arrive
          area, noteId, noteTitle, noteText, settings, {}
        );
        area._quizApi = quizApi;
      }
      if (quizApi) quizApi.onNewQuestion(idx);
    }

    function finalizeStreamedQuiz(qs, debugInfo) {
      if (quizApi) quizApi.onStreamDone();
    }

    try {
      const prevResults   = noteId ? await getQuizResultsByNote(noteId) : [];
      const prevQuestions = prevResults
        .flatMap(r => (r.questions || []).map(q => q.questionText))
        .filter(Boolean);

      const isNotionQuiz = area === document.getElementById('notionQuizArea');
      // D1: cancel any in-flight quiz before starting a new one. Without this,
      // re-clicking Generate while a quiz is mid-stream leaks the old request —
      // both run concurrently, doubling server load and burning tokens.
      _quizAbortController?.abort();
      _quizAbortController = new AbortController();
      const { questions, debugInfo } = await generateQuizStream(
        noteText, settings, prevQuestions,
        (q, idx) => { streamedQuestions.push(q); appendStreamCard(q, idx); },
        isNotionQuiz,
        _quizAbortController.signal
      );

      clearInterval(msgInterval);
      clearInterval(timerInterval);

      if (streamedQuestions.length < totalExpected) {
        console.warn(`[quiz] under-generation: expected ${totalExpected}, got ${streamedQuestions.length}`);
      }

      if (!firstArrived) {
        showToast('❌ 문제를 생성하지 못했어요');
        clearQuizInlineArea();
      } else {
        finalizeStreamedQuiz(streamedQuestions, debugInfo);
      }
    } catch(e) {
      clearInterval(msgInterval);
      clearInterval(timerInterval);
      if (e.name === 'AbortError') {
        console.log('[quiz] generation aborted');
        return;
      }
      if (firstArrived && streamedQuestions.length > 0) {
        showToast('❌ 스트리밍 중 오류: ' + e.message);
        finalizeStreamedQuiz(streamedQuestions, {});
      } else {
        showToast('❌ 퀴즈 생성 실패: ' + e.message);
        clearQuizInlineArea();
      }
    }
  });

  area.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Grade an essay question via Claude Haiku — returns {score, feedback, rubricResults}
async function gradeEssay(q, userAnswer) {
  const systemPrompt = `You are a grading assistant. Grade this student answer against the rubric. Output ONLY valid JSON: {"score":0,"feedback":"1-2 sentences","rubricResults":[{"criterion":"...","met":true}]}`;
  const userMsg = `Question: ${q.q}\nRubric: ${JSON.stringify(q.rubric)}\nModel answer: ${q.modelAnswer}\nStudent answer: ${userAnswer}`;
  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  // M3: 60s timeout via AbortController to prevent hung essay grading requests
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        idToken,
        isFirstCall: false,
        feature: 'essayGrade',
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('채점 시간 초과 (60초). 다시 시도해주세요.');
    throw e;
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  const raw = (data.content?.[0]?.text || data.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('gradeEssay: JSON parse failed:', e.message, raw?.slice(0, 200));
    return { score: 50, feedback: '채점 결과를 파싱하는데 실패했습니다. 다시 시도해주세요.', rubricResults: [] };
  }
}

// Normalize text for short-answer keyword matching
function normalizeAnswer(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ''); }

// Check if a short-answer response matches any keyword
function matchesKeywords(userVal, keywords) {
  const u = normalizeAnswer(userVal);
  if (u.length < 2) return false;
  return (keywords || []).some(kw => {
    const k = normalizeAnswer(kw);
    if (k.length < 2) return false;
    return u.includes(k) || k.includes(u);
  });
}

function _quizUpdateStatusBar(ctx) {
  const curEl = ctx.container.querySelector('#scStatusCurrent');
  const genEl = ctx.container.querySelector('#scStatusGenerated');
  if (curEl) curEl.textContent = `문제 ${ctx.currentIndex + 1} / ${ctx.questions.length}`;
  if (genEl) {
    const target = ctx.settings.count || ctx.questions.length;
    genEl.textContent = ctx.streamingDone
      ? `생성 완료 (${ctx.questions.length}${ctx.questions.length < target ? '/' + target : ''})`
      : `생성됨: ${ctx.questions.length} / ${target}`;
  }
}

function _quizRenderCurrentCard(ctx, idx) {
  const area = ctx.container.querySelector('#scCardArea');
  if (!area) return;
  const q = ctx.questions[idx];
  if (!q) { area.innerHTML = '<div class="quiz-sc-placeholder">문제 없음</div>'; return; }

  const type = q.type || 'mc';
  const typeLabel = type === 'short' ? ' · 단답형' : type === 'essay' ? ' · 서술형' : '';

  let inputHtml = '';
  if (type === 'mc') {
    inputHtml = `<div class="quiz-card-choices">
        ${q.choices.map((c, ci) => `<button class="qi-choice" data-ci="${ci}">${QUIZ_CHOICES_PREFIX[ci]} ${escHtml(c)}</button>`).join('')}
      </div>`;
  } else if (type === 'short') {
    inputHtml = `<div class="quiz-card-open">
        <input class="qi-text-input" type="text" placeholder="답을 입력하세요" autocomplete="off">
        <button class="quiz-submit-btn" type="button">제출</button>
      </div>`;
  } else if (type === 'essay') {
    inputHtml = `<div class="quiz-card-open">
        <textarea class="qi-essay-input" rows="5" placeholder="서술하세요"></textarea>
        <button class="quiz-submit-btn" type="button">제출</button>
      </div>`;
  }

  // U2 Task 1: MCQ/단답형 get an optional hint reveal button (essay excluded).
  // Old saved/streamed questions simply lack q.hint, so the button just doesn't render.
  const hintHtml = (type !== 'essay' && q.hint)
    ? `<div class="qi-hint-row"><button type="button" class="qi-hint-btn">💡 힌트</button><div class="qi-hint-text" style="display:none;"></div></div>`
    : '';

  area.innerHTML = `<div class="quiz-card quiz-card-enter visible" data-qi="${idx}" data-type="${type}">
      <div class="quiz-card-header">
        <div class="quiz-card-num">문제 ${idx + 1} / ${ctx.questions.length}${q.section ? ' · ' + escHtml(q.section) : ''}${typeLabel}</div>
        <button type="button" class="qi-flag-btn${ctx.flagged[idx] ? ' qi-flagged' : ''}" aria-label="나중에 복습 표시">🚩</button>
      </div>
      <div class="quiz-card-q">${escHtml(q.q)}</div>
      ${hintHtml}
      ${inputHtml}
      <div class="qi-explanation"></div>
    </div>`;

  const cardEl = area.querySelector('.quiz-card');

  const hintBtn = cardEl.querySelector('.qi-hint-btn');
  if (hintBtn) {
    hintBtn.addEventListener('click', () => {
      const hintText = cardEl.querySelector('.qi-hint-text');
      hintText.textContent = q.hint;
      hintText.style.display = 'block';
      hintBtn.style.display = 'none';
    });
  }

  // U2 Task 2: in-session flag toggle, available on every question type.
  const flagBtn = cardEl.querySelector('.qi-flag-btn');
  flagBtn.addEventListener('click', () => {
    ctx.flagged[idx] = !ctx.flagged[idx];
    flagBtn.classList.toggle('qi-flagged', !!ctx.flagged[idx]);
  });

  if (type === 'mc') {
    cardEl.querySelectorAll('.qi-choice').forEach(btn => {
      btn.addEventListener('click', () => {
        if (ctx.submitted[idx]) return;
        const ci = Number(btn.dataset.ci);
        cardEl.querySelectorAll('.qi-choice').forEach(b => b.classList.remove('qi-selected'));
        btn.classList.add('qi-selected');
        ctx.answers[idx] = ci;
        _quizSubmitAnswer(ctx, idx, cardEl);
      });
    });
  } else {
    const submitBtn = cardEl.querySelector('.quiz-submit-btn');
    submitBtn.addEventListener('click', () => {
      if (ctx.submitted[idx]) return;
      const inp = cardEl.querySelector('.qi-text-input, .qi-essay-input');
      const val = inp ? inp.value.trim() : '';
      if (!val) { showToast('답을 입력해주세요'); return; }
      ctx.answers[idx] = val;
      _quizSubmitAnswer(ctx, idx, cardEl);
    });
  }

  if (ctx.submitted[idx]) {
    if (type === 'mc' && typeof ctx.answers[idx] === 'number') {
      const picked = cardEl.querySelector(`.qi-choice[data-ci="${ctx.answers[idx]}"]`);
      if (picked) picked.classList.add('qi-selected');
    } else if (type !== 'mc') {
      const inp = cardEl.querySelector('.qi-text-input, .qi-essay-input');
      if (inp) inp.value = ctx.answers[idx] || '';
    }
    _quizShowFeedback(ctx, idx, cardEl);
  }

  _quizUpdateStatusBar(ctx);
}

async function _quizSubmitAnswer(ctx, idx, cardEl) {
  if (ctx.submitted[idx]) return;
  const q = ctx.questions[idx];
  const type = q.type || 'mc';

  if (type === 'essay') {
    const expEl = cardEl.querySelector('.qi-explanation');
    if (expEl) { expEl.textContent = '채점 중...'; expEl.style.display = 'block'; }
    try {
      ctx.essayGradeResults[idx] = await gradeEssay(q, ctx.answers[idx]);
    } catch (e) {
      ctx.essayGradeResults[idx] = { score: 0, feedback: '채점 실패: ' + (e.message || '알 수 없는 오류'), rubricResults: [] };
    }
  }

  ctx.submitted[idx] = true;
  _quizShowFeedback(ctx, idx, cardEl);

  const nextBtn = ctx.container.querySelector('#scNextBtn');
  if (nextBtn) {
    if (idx === ctx.questions.length - 1 && ctx.streamingDone) nextBtn.textContent = '결과 보기';
    nextBtn.classList.add('pulse');
  }
}

function _quizShowFeedback(ctx, idx, cardEl) {
  const q = ctx.questions[idx];
  const type = q.type || 'mc';
  const expEl = cardEl.querySelector('.qi-explanation');

  if (type === 'mc') {
    const correctIdx = Number(q.answer);
    cardEl.querySelectorAll('.qi-choice').forEach(btn => {
      const ci = Number(btn.dataset.ci);
      btn.disabled = true;
      btn.style.pointerEvents = 'none';
      if (ci === correctIdx) btn.classList.add('qi-correct');
      else if (ci === ctx.answers[idx] && ci !== correctIdx) btn.classList.add('qi-wrong');
    });
    if (expEl) { expEl.innerHTML = escHtml(q.explanation || '해설 없음'); expEl.style.display = 'block'; }
  } else if (type === 'short') {
    const inp = cardEl.querySelector('.qi-text-input');
    if (inp) inp.disabled = true;
    const submitBtn = cardEl.querySelector('.quiz-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.style.display = 'none'; }
    if (expEl) {
      const matched = matchesKeywords(ctx.answers[idx], q.keywords);
      const badge = matched
        ? '<span style="color:#22c55e;font-weight:700;">✅ 정답</span><br>'
        : '<span style="color:#ef4444;font-weight:700;">❌ 오답</span><br>';
      expEl.innerHTML = badge + escHtml(q.fullAnswer || q.explanation || '');
      expEl.style.display = 'block';
    }
  } else if (type === 'essay') {
    const ta = cardEl.querySelector('.qi-essay-input');
    if (ta) ta.disabled = true;
    const submitBtn = cardEl.querySelector('.quiz-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.style.display = 'none'; }
    if (expEl) {
      const r = ctx.essayGradeResults[idx];
      expEl.innerHTML = r
        ? `<strong>점수: ${r.score}/10</strong><br>${escHtml(r.feedback || '')}<br><br><strong>해설:</strong> ${escHtml(q.explanation || '')}`
        : escHtml(q.explanation || '');
      expEl.style.display = 'block';
    }
  }
}

function _quizAdvanceToNext(ctx) {
  if (!ctx.submitted[ctx.currentIndex]) {
    if (!ctx.skipWarningShown[ctx.currentIndex]) {
      showToast('아직 답을 선택하지 않았어요');
      ctx.skipWarningShown[ctx.currentIndex] = true;
      return;
    }
    ctx.answers[ctx.currentIndex] = null;
    ctx.submitted[ctx.currentIndex] = true;
  }

  const nextBtn = ctx.container.querySelector('#scNextBtn');
  if (nextBtn) { nextBtn.classList.remove('pulse'); nextBtn.textContent = '다음 ▶'; }

  ctx.currentIndex++;

  if (ctx.currentIndex >= ctx.questions.length) {
    if (ctx.streamingDone) {
      ctx.currentIndex = ctx.questions.length - 1;
      _quizRunGrading(ctx);
      return;
    }
    ctx.waitingForStream = true;
    const area = ctx.container.querySelector('#scCardArea');
    if (area) area.innerHTML = '<div class="quiz-sc-placeholder">다음 문제 생성 중...</div>';
    if (nextBtn) nextBtn.disabled = true;
    _quizUpdateStatusBar(ctx);
    return;
  }

  _quizRenderCurrentCard(ctx, ctx.currentIndex);
}

function _quizAppendDebugSection(ctx) {
  const notePreview  = (ctx.noteText || '').slice(0, 500);
  const noteFullLen  = (ctx.noteText || '').length;
  const hasTrunc     = noteFullLen > 500;
  const debugEl      = document.createElement('details');
  debugEl.className  = 'quiz-debug-details';
  debugEl.innerHTML  = `
    <summary class="quiz-debug-summary">🔧 디버그</summary>
    <div class="quiz-debug-body">
      <div class="quiz-debug-row"><span class="quiz-debug-key">모델</span><span>${escHtml(ctx.debugInfo.model || '—')}</span></div>
      <div class="quiz-debug-row"><span class="quiz-debug-key">응답 시간</span><span>${ctx.debugInfo.responseTimeMs != null ? (ctx.debugInfo.responseTimeMs / 1000).toFixed(2) + 's' : '—'}</span></div>
      <div class="quiz-debug-row"><span class="quiz-debug-key">설정</span><span>문제 ${ctx.settings.count || '?'}개 · ${ctx.settings.style || '?'} · ${ctx.settings.difficulty || '?'}</span></div>
      <div class="quiz-debug-row"><span class="quiz-debug-key">노트 길이</span><span>${noteFullLen.toLocaleString()}자</span></div>
      <div class="quiz-debug-label">노트 입력 (앞 500자)</div>
      <pre class="quiz-debug-pre">${escHtml(notePreview)}${hasTrunc ? '\n…' : ''}</pre>
      ${hasTrunc ? `<details class="quiz-debug-full-wrap"><summary class="quiz-debug-full-toggle">전체 보기 (${noteFullLen.toLocaleString()}자)</summary><pre class="quiz-debug-pre">${escHtml(ctx.noteText)}</pre></details>` : ''}
      <div class="quiz-debug-label">JSON 응답</div>
      <pre class="quiz-debug-pre">${escHtml(ctx.debugInfo.rawResponse || '—')}</pre>
    </div>`;
  ctx.container.appendChild(debugEl);
}

async function _quizRunGrading(ctx) {
  const { questions, container, noteId, noteTitle, noteText, startTime, answers, essayGradeResults } = ctx;

  const scNextBtn = container.querySelector('#scNextBtn');
  if (scNextBtn) { scNextBtn.disabled = true; scNextBtn.textContent = '채점 중...'; }

  // Fire all essay grading calls in parallel
  const essayIndices = questions.reduce((acc, q, i) => {
    if ((q.type || 'mc') === 'essay') acc.push(i);
    return acc;
  }, []);

  if (essayIndices.length > 0) {
    const settled = await Promise.all(
      essayIndices.map(i => {
        if (essayGradeResults[i]) return Promise.resolve({ i, r: essayGradeResults[i] });
        return gradeEssay(questions[i], answers[i] || '')
          .then(r  => ({ i, r }))
          .catch(e => ({ i, r: { score: 0, feedback: '채점 오류: ' + e.message, rubricResults: [] } }));
      })
    );
    settled.forEach(({ i, r }) => { essayGradeResults[i] = r; });
  }

  // Render per-question results and accumulate stats
  let mcCorrect = 0, mcTotal = 0;
  let shortCorrect = 0, shortTotal = 0;
  let essayScoreSum = 0, essayTotal = 0;

  questions.forEach((q, idx) => {
    const type  = q.type || 'mc';
    const card  = container.querySelector(`.quiz-card[data-qi="${idx}"]`);
    if (!card) {
      if (type === 'mc') { mcTotal++; if (answers[idx] === q.answer) mcCorrect++; }
      else if (type === 'short') { shortTotal++; if (matchesKeywords(answers[idx], q.keywords)) shortCorrect++; }
      else if (type === 'essay') { essayTotal++; essayScoreSum += (essayGradeResults[idx]?.score || 0); }
      return;
    }
    const expEl = card.querySelector('.qi-explanation');

    if (type === 'mc') {
      mcTotal++;
      const chosen  = answers[idx];
      const correct = q.answer;
      card.querySelectorAll('.qi-choice').forEach(b => {
        b.disabled = true;
        b.classList.remove('qi-selected');
        const ci = Number(b.dataset.ci);
        if (ci === correct) b.classList.add('qi-correct');
        else if (ci === chosen && chosen !== correct) b.classList.add('qi-wrong');
      });
      expEl.textContent   = q.explanation;
      expEl.style.display = 'block';
      if (chosen === correct) mcCorrect++;

    } else if (type === 'short') {
      shortTotal++;
      const inputEl = card.querySelector('.qi-text-input');
      if (inputEl) inputEl.disabled = true;
      const matched = matchesKeywords(answers[idx], q.keywords);
      if (matched) {
        shortCorrect++;
        expEl.innerHTML = `<span style="color:#22c55e;font-weight:700;">✅ 정답</span><div style="margin-top:0.4rem;font-size:0.88rem;">${escHtml(q.fullAnswer)}</div>`;
      } else {
        expEl.innerHTML = `<span style="color:#ef4444;font-weight:700;">❌ 오답</span><div style="margin-top:0.4rem;font-size:0.88rem;">${escHtml(q.fullAnswer)}</div>`;
      }
      expEl.style.display = 'block';

    } else if (type === 'essay') {
      essayTotal++;
      const textareaEl = card.querySelector('.qi-essay-input');
      if (textareaEl) textareaEl.disabled = true;
      const gr = essayGradeResults[idx] || { score: 0, feedback: '채점 실패', rubricResults: [] };
      essayScoreSum += gr.score;
      const scoreColor = gr.score >= 80 ? '#22c55e' : gr.score >= 50 ? '#f59e0b' : '#ef4444';
      const rubricHtml = (gr.rubricResults || []).map(r =>
        `<div style="font-size:0.82rem;margin:0.15rem 0;">${r.met ? '✅' : '❌'} ${escHtml(r.criterion)}</div>`
      ).join('');
      expEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.4rem;flex-wrap:wrap;">
            <span style="font-size:1.05rem;font-weight:800;color:${scoreColor};background:${scoreColor}22;padding:0.2rem 0.6rem;border-radius:6px;">${gr.score}점</span>
            <span style="font-size:0.85rem;color:var(--text-muted);">${escHtml(gr.feedback)}</span>
          </div>
          ${rubricHtml}
          <details style="margin-top:0.5rem;">
            <summary style="font-size:0.82rem;color:var(--text-muted);cursor:pointer;">모범 답안 보기</summary>
            <div style="font-size:0.85rem;margin-top:0.3rem;padding:0.5rem;background:var(--surface2);border-radius:6px;">${escHtml(q.modelAnswer)}</div>
          </details>`;
      expEl.style.display = 'block';
    }
  });

  // Build result banner score lines
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins    = Math.floor(elapsed / 60);
  const secs    = elapsed % 60;

  let scoreLines = '';
  if (mcTotal + shortTotal > 0) {
    const objCorrect = mcCorrect + shortCorrect;
    const objTotal   = mcTotal + shortTotal;
    const pct        = Math.round(objCorrect / objTotal * 100);
    scoreLines += `<div class="quiz-result-score">${objCorrect} / ${objTotal} (${pct}%)</div>`;
  }
  if (essayTotal > 0) {
    const avgScore = Math.round(essayScoreSum / essayTotal);
    const avgColor = avgScore >= 80 ? '#22c55e' : avgScore >= 50 ? '#f59e0b' : '#ef4444';
    scoreLines += `<div style="font-size:1rem;font-weight:700;color:${avgColor};margin-top:0.15rem;">서술형 평균: ${avgScore}/100</div>`;
  }

  // Wrong list for mc and short only
  const wrongs = questions.reduce((acc, q, i) => {
    const type = q.type || 'mc';
    if (type === 'mc' && answers[i] !== q.answer) {
      acc.push({ q, chosen: answers[i], i, type });
    } else if (type === 'short' && !matchesKeywords(answers[i], q.keywords)) {
      acc.push({ q, chosen: answers[i], i, type });
    }
    return acc;
  }, []);

  const wrongHtml = (wrongs.length === 0 && essayTotal === 0)
    ? '<div style="color:var(--text-muted);font-size:0.88rem;padding:0.25rem 0;">모두 정답입니다! 🎉</div>'
    : wrongs.map(({ q, chosen, i, type }) => {
        if (type === 'mc') {
          return `<div class="quiz-wrong-item">
              <div class="qwi-q">Q${i+1}. ${escHtml(q.q)}</div>
              <div class="qwi-ans">✅ 정답: ${QUIZ_CHOICES_PREFIX[q.answer]} ${escHtml(q.choices[q.answer])}</div>
              <div style="color:#ef4444;margin-bottom:0.2rem;">❌ 내 답: ${chosen !== null ? QUIZ_CHOICES_PREFIX[chosen] + ' ' + escHtml(q.choices[chosen]) : '(미응답)'}</div>
              <div class="qwi-exp">${escHtml(q.explanation)}</div>
            </div>`;
        } else {
          return `<div class="quiz-wrong-item">
              <div class="qwi-q">Q${i+1}. ${escHtml(q.q)}</div>
              <div class="qwi-ans">✅ 키워드: ${escHtml((q.keywords || []).join(', '))}</div>
              <div style="color:#ef4444;margin-bottom:0.2rem;">❌ 내 답: ${escHtml(chosen || '(미응답)')}</div>
              <div class="qwi-exp">${escHtml(q.fullAnswer)}</div>
            </div>`;
        }
      }).join('');

  // U2 Task 2: 🚩 표시한 문항 리뷰 — 정답 여부와 무관하게 flagged된 문항만 모아 보여줌
  const flaggedList = questions.reduce((acc, q, i) => {
    if (ctx.flagged[i]) acc.push({ q, i, type: q.type || 'mc' });
    return acc;
  }, []);
  const flaggedHtml = flaggedList.map(({ q, i, type }) => {
    const ansLine = type === 'mc'
      ? `✅ 정답: ${QUIZ_CHOICES_PREFIX[q.answer]} ${escHtml(q.choices[q.answer])}`
      : type === 'short'
        ? `✅ 키워드: ${escHtml((q.keywords || []).join(', '))}`
        : `✅ 모범 답안: ${escHtml(q.modelAnswer || '')}`;
    return `<div class="quiz-wrong-item">
        <div class="qwi-q">Q${i+1}. ${escHtml(q.q)}</div>
        <div class="qwi-ans">${ansLine}</div>
        <div class="qwi-exp">${escHtml(q.explanation || '')}</div>
      </div>`;
  }).join('');

  const banner = document.createElement('div');
  banner.className = 'quiz-results-banner';
  banner.innerHTML = `
      ${scoreLines}
      <div class="quiz-result-time">소요 시간: ${mins > 0 ? mins + '분 ' : ''}${secs}초</div>
      <div id="quizWeaknessInline"></div>
      ${wrongs.length > 0 ? '<div style="font-size:0.82rem;font-weight:600;color:var(--text-muted);margin-top:0.25rem;">오답 목록</div>' : ''}
      <div class="quiz-wrong-list">${wrongHtml}</div>
      ${flaggedList.length > 0 ? '<div style="font-size:0.82rem;font-weight:600;color:var(--text-muted);margin-top:0.25rem;">🚩 표시한 문항</div>' : ''}
      ${flaggedList.length > 0 ? `<div class="quiz-wrong-list">${flaggedHtml}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;padding-top:0.4rem;">
        <button id="quizHistInlineBtn" style="display:none;padding:0.5rem 1rem;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text-muted);font-size:0.85rem;cursor:pointer;"><i data-lucide="presentation" class="icon-sm"></i> 퀴즈 이력</button>
        <div style="display:flex;gap:0.5rem;margin-left:auto;">
          <button id="quizRetryBtn" class="quiz-grade-btn">다시 풀기</button>
          <button id="quizCloseInlineBtn" style="padding:0.6rem 1rem;border-radius:7px;border:1px solid var(--border);background:var(--surface3);color:var(--text);font-size:0.88rem;cursor:pointer;">닫기</button>
        </div>
      </div>`;

  const replaceTarget = container.querySelector('.quiz-sc-container') || container.querySelector('#quizGradeBtn');
  if (replaceTarget) replaceTarget.replaceWith(banner);
  else container.appendChild(banner);
  banner.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (noteId) {
    // For score persistence: mc+short count as objective; essay ≥60 counts as correct
    const totalObjective = questions.length; // keep total as full count for history
    const correctCount   = questions.reduce((sum, q, i) => {
      const type = q.type || 'mc';
      if (type === 'mc')    return sum + (answers[i] === q.answer ? 1 : 0);
      if (type === 'short') return sum + (matchesKeywords(answers[i], q.keywords) ? 1 : 0);
      if (type === 'essay') return sum + ((essayGradeResults[i]?.score || 0) >= 60 ? 1 : 0);
      return sum;
    }, 0);

    const record = {
      id:        uuidv4(),
      noteId,
      noteTitle: noteTitle || '',
      timestamp: new Date().toISOString(),
      score:     correctCount,
      total:     totalObjective,
      timeTaken: elapsed,
      questions: questions.map((q, i) => {
        const type    = q.type || 'mc';
        let   correct = false;
        if (type === 'mc')    correct = answers[i] === q.answer;
        if (type === 'short') correct = matchesKeywords(answers[i], q.keywords);
        if (type === 'essay') correct = (essayGradeResults[i]?.score || 0) >= 60;
        return { section: q.section || '', correct, questionText: q.q || '', flagged: !!ctx.flagged[i] };
      }),
    };
    await saveQuizResult(record).catch(e => console.warn('quiz save failed:', e));
    if (noteId) updateNoteWeaknessBadges(noteId).catch(() => {}); // refresh h2 accuracy badges

    const histBtn = banner.querySelector('#quizHistInlineBtn');
    if (histBtn) {
      histBtn.style.display = 'inline-block';
      histBtn.addEventListener('click', () => showQuizHistory(null, noteId, noteTitle));
    }
    const weaknessEl = banner.querySelector('#quizWeaknessInline');
    if (weaknessEl) {
      try {
        const allResults = await getQuizResultsByNote(noteId);
        const report     = await getWeaknessReport(noteId);
        renderWeaknessReport(weaknessEl, report, allResults.length);
      } catch(_) { /* non-critical */ }
    }
  }

  banner.querySelector('#quizRetryBtn').addEventListener('click', () => {
    const isDefaultArea = container === document.getElementById('quizInlineArea');
    const retryText = isDefaultArea ? storedNotesText : noteText;
    showQuizSettings(noteTitle, noteId, retryText, isDefaultArea ? null : container);
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const defaultArea = document.getElementById('quizInlineArea');
  banner.querySelector('#quizCloseInlineBtn').addEventListener('click', () =>
    clearQuizInlineArea(container === defaultArea ? null : container));
}

function _quizOnNewQuestion(ctx, idx) {
  _quizUpdateStatusBar(ctx);
  if (ctx.waitingForStream && idx === ctx.currentIndex) {
    ctx.waitingForStream = false;
    const nextBtn = ctx.container.querySelector('#scNextBtn');
    if (nextBtn) nextBtn.disabled = false;
    _quizRenderCurrentCard(ctx, ctx.currentIndex);
  }
}

function _quizOnStreamDone(ctx) {
  ctx.streamingDone = true;
  _quizUpdateStatusBar(ctx);

  if (ctx.waitingForStream) {
    ctx.waitingForStream = false;
    const nextBtn = ctx.container.querySelector('#scNextBtn');
    if (nextBtn) nextBtn.disabled = false;
    if (ctx.questions.length > 0) {
      ctx.currentIndex = ctx.questions.length - 1;
      _quizRenderCurrentCard(ctx, ctx.currentIndex);
      showToast(`문제를 ${ctx.questions.length}개만 생성했어요`);
    }
  }

  if (ctx.currentIndex === ctx.questions.length - 1 && ctx.submitted[ctx.currentIndex]) {
    const nextBtn = ctx.container.querySelector('#scNextBtn');
    if (nextBtn) nextBtn.textContent = '결과 보기';
  }
}

async function _quizSavePartial(ctx) {
  if (ctx._savedAlready) return;
  if (!ctx.noteId) return;

  const submittedCount = ctx.submitted.filter(Boolean).length;
  if (submittedCount < Math.ceil(ctx.questions.length * 0.5)) return;

  ctx._savedAlready = true;
  try {
    const elapsed = Math.round((Date.now() - ctx.startTime) / 1000);
    let correctCount = 0;
    const savedQuestions = [];

    ctx.questions.forEach((q, i) => {
      if (!ctx.submitted[i]) return;
      const type = q.type || 'mc';
      let correct = false;
      if (type === 'mc')    correct = ctx.answers[i] === q.answer;
      if (type === 'short') correct = matchesKeywords(ctx.answers[i], q.keywords);
      if (type === 'essay') correct = (ctx.essayGradeResults[i]?.score || 0) >= 60;
      if (correct) correctCount++;
      savedQuestions.push({ section: q.section || '', correct, questionText: q.q || '', flagged: !!ctx.flagged[i] });
    });

    const record = {
      id:        uuidv4(),
      noteId:    ctx.noteId,
      noteTitle: ctx.noteTitle || '',
      timestamp: new Date().toISOString(),
      score:     correctCount,
      total:     submittedCount,
      timeTaken: elapsed,
      partial:   true,
      questions: savedQuestions,
    };
    await saveQuizResult(record);
    console.log(`[quiz] 부분 저장 완료: ${submittedCount}/${ctx.questions.length} (${correctCount}/${submittedCount} 정답)`);
  } catch (e) {
    console.warn('[quiz] 부분 저장 실패:', e.message);
    ctx._savedAlready = false;
  }
}

function runInlineQuiz(questions, container, noteId, noteTitle, noteText, settings = {}, debugInfo = {}) {
  const ctx = {
    questions, container, noteId, noteTitle, noteText, settings, debugInfo,
    startTime:         Date.now(),
    answers:           questions.map(q => (q.type && q.type !== 'mc') ? '' : null),
    currentIndex:      0,
    skipWarningShown:  [],
    submitted:         [],
    flagged:           [], // U2 Task 2: in-session flag-for-review per question index
    streamingDone:     false,
    waitingForStream:  false,
    _savedAlready:     false,
    essayGradeResults: {},
  };

  container.innerHTML = `
    <div class="quiz-sc-container">
      <div class="quiz-sc-status">
        <span id="scStatusCurrent">문제 1 / ${questions.length}</span>
        <span id="scStatusGenerated">생성됨: ${questions.length} / ${settings.count || questions.length}</span>
      </div>
      <div class="quiz-sc-card-area" id="scCardArea"></div>
      <div class="quiz-sc-nav">
        <button class="quiz-next-btn" id="scNextBtn">다음 ▶</button>
      </div>
    </div>
  `;

  _quizAppendDebugSection(ctx);

  const nextBtn = container.querySelector('#scNextBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const btn = container.querySelector('#scNextBtn');
      if (btn && btn.textContent === '결과 보기') {
        _quizRunGrading(ctx);
      } else {
        _quizAdvanceToNext(ctx);
      }
    });
  }

  _quizRenderCurrentCard(ctx, 0);

  return {
    onNewQuestion:         (idx) => _quizOnNewQuestion(ctx, idx),
    onStreamDone:          ()    => _quizOnStreamDone(ctx),
    savePartialIfEligible: ()    => _quizSavePartial(ctx),
  };
}

async function getWeaknessReport(noteId) {
  const results = await getQuizResultsByNote(noteId);
  if (!results.length) return null;
  const allQs = results.flatMap(r => r.questions || []);
  const map = new Map();
  for (const q of allQs) {
    const sec = q.section || '기타';
    if (!map.has(sec)) map.set(sec, { name: sec, total: 0, correct: 0 });
    const entry = map.get(sec);
    entry.total++;
    if (q.correct) entry.correct++;
  }
  const sections = [...map.values()].map(s => {
    const accuracy = s.total ? Math.round(s.correct / s.total * 100) : 0;
    const status   = accuracy < 60 ? 'weak' : accuracy <= 80 ? 'medium' : 'good';
    return { ...s, accuracy, status };
  }).sort((a, b) => a.accuracy - b.accuracy);
  return { totalQuizzes: results.length, totalQuestions: allQs.length, sections };
}

/* ═══════════════════════════════════════════════
   Exam Review — data collection (Part 1)
═══════════════════════════════════════════════ */

// Parse notesText into a map of { h2Title → sectionText }
function parseNoteSections(notesText) {
  const sections = new Map();
  if (!notesText) return sections;
  // Split on lines that start with ## (h2), keeping the header line
  const parts = notesText.split(/(?=^## .+)/m);
  for (const part of parts) {
    const firstLine = part.split('\n')[0].replace(/^##\s*/, '').trim();
    if (firstLine) sections.set(firstLine, part.trim());
  }
  return sections;
}

async function examReviewData(folderId) {
  const [allNotes, allFolders] = await Promise.all([getAllNotesFS(), getAllFoldersFS()]);
  const folderNotes = allNotes.filter(n => n.folderId === folderId);
  const folder      = allFolders.find(f => f.id === folderId);

  // Aggregate per-section stats across all notes in the folder
  // sectionKey = "noteId::sectionName" to keep sections from different notes separate
  const sectionStats = new Map(); // sectionKey → { sectionName, noteTitle, noteId, correct, total, content }

  for (const note of folderNotes) {
    const results    = await getQuizResultsByNote(note.id);
    const sectionMap = parseNoteSections(note.notesText || '');

    for (const result of results) {
      for (const q of (result.questions || [])) {
        const secName = q.section || '기타';
        const key     = note.id + '::' + secName;
        if (!sectionStats.has(key)) {
          sectionStats.set(key, {
            sectionName:    secName,
            noteTitle:      note.title || '제목없음',
            noteId:         note.id,
            correct:        0,
            total:          0,
            content:        sectionMap.get(secName) || '',
          });
        }
        const entry = sectionStats.get(key);
        entry.total++;
        if (q.correct) entry.correct++;
      }
    }
  }

  // Build enriched section objects with accuracy
  const allSectionList = [...sectionStats.values()].map(s => ({
    ...s,
    accuracy:      s.total ? Math.round(s.correct / s.total * 100) : null,
    questionCount: s.total,
  }));

  // Sort by accuracy ascending (weakest first); sections with no quiz data go last
  allSectionList.sort((a, b) => {
    if (a.accuracy === null && b.accuracy === null) return 0;
    if (a.accuracy === null) return 1;
    if (b.accuracy === null) return -1;
    return a.accuracy - b.accuracy;
  });

  const weakSections      = allSectionList.filter(s => s.accuracy !== null && s.accuracy < 70);
  const importantSections = [...allSectionList]
    .filter(s => s.questionCount > 0)
    .sort((a, b) => b.questionCount - a.questionCount)
    .slice(0, 10); // top 10 most-quizzed sections

  const totalQuizQuestions = allSectionList.reduce((sum, s) => sum + s.questionCount, 0);

  return {
    folderName:         folder?.name || '폴더',
    totalNotes:         folderNotes.length,
    totalQuizQuestions,
    weakSections,
    importantSections,
    allSections:        allSectionList,
  };
}

function launchExamReview() {
  if (!_activeFolderId) return;

  // Build overlay immediately so user sees the modal opening
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.innerHTML = `
    <div class="db-modal" style="max-width:720px;width:96vw;max-height:92vh;display:flex;flex-direction:column;gap:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:0.8rem;border-bottom:1px solid var(--border);flex-shrink:0;">
        <h3 style="margin:0;font-size:1.05rem;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="clipboard-list" class="icon-sm" style="color:var(--primary);"></i><span>시험 대비 요약</span></h3>
        <button id="examReviewCloseBtn" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:0.2rem 0.4rem;display:inline-flex;align-items:center;" aria-label="닫기"><i data-lucide="x" class="icon-sm"></i></button>
      </div>
      <div id="examReviewBody" style="overflow-y:auto;flex:1;padding:1rem 0.2rem 0.5rem;">
        <div style="display:flex;align-items:center;gap:0.6rem;color:var(--text-muted);font-size:0.88rem;padding:2rem 0;justify-content:center;">
          <div class="spinner"></div> 데이터 수집 중…
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let onKey;
  const closeModal = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  overlay.querySelector('#examReviewCloseBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  onKey = e => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);

  examReviewData(_activeFolderId).then(data => {
    const body = overlay.querySelector('#examReviewBody');
    if (!body) return;
    body.innerHTML = renderExamReviewHTML(data, closeModal);
    // Attach collapsible toggles
    body.querySelectorAll('.er-section-header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const card = hdr.closest('.er-section-card');
        card.classList.toggle('er-open');
      });
    });
    // "해당 노트로 이동" links (buttons) + all-sections rows (divs) — both use data-goto-note
    body.querySelectorAll('[data-goto-note]').forEach(btn => {
      btn.addEventListener('click', () => {
        const noteId  = btn.dataset.gotoNote;
        const section = btn.dataset.gotoSection || '';
        closeModal();
        openSavedNote(noteId).then(() => {
          if (section) setTimeout(() => scrollToNoteSection(section), 600);
        });
      });
    });
  }).catch(e => {
    console.error('[ExamReview]', e);
    const body = overlay.querySelector('#examReviewBody');
    if (body) body.innerHTML = `<div style="color:#ef4444;padding:1rem;">❌ 데이터 수집 오류: ${escHtml(e.message)}</div>`;
  });
}

function renderExamReviewHTML(data, _closeModal) {
  const pct    = n => n === null ? '—' : n + '%';
  const clr    = n => n === null ? 'var(--text-muted)' : n >= 80 ? '#22c55e' : n >= 50 ? '#eab308' : '#ef4444';
  // background uses color-mix (not the old `${color}22` hex-alpha-suffix trick) so
  // this also works when `color` is a CSS var(), not just a literal hex string.
  const badge  = (text, color) =>
    `<span style="font-size:0.72rem;padding:0.1rem 0.45rem;border-radius:8px;background:color-mix(in srgb, ${color} 13%, transparent);color:${color};font-weight:600;white-space:nowrap;">${escHtml(String(text))}</span>`;
  const noteTag = title =>
    `<span style="font-size:0.72rem;padding:0.1rem 0.4rem;background:var(--surface3);color:var(--text-muted);border-radius:6px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle;">${escHtml(title)}</span>`;
  const gotoBtn = (noteId, section) =>
    `<button data-goto-note="${escHtml(noteId)}" data-goto-section="${escHtml(section)}"
      style="font-size:0.78rem;background:none;border:1px solid var(--border);border-radius:6px;padding:0.2rem 0.6rem;cursor:pointer;color:var(--primary);white-space:nowrap;">해당 노트로 이동 →</button>`;

  // ── Stats bar ──
  const statsBar = `
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.2rem;">
      ${badge(data.totalNotes + '개 노트', 'var(--primary)')}
      ${badge(data.totalQuizQuestions + '문제 분석', '#0ea5e9')}
      ${badge('약점 ' + data.weakSections.length + '개', data.weakSections.length ? '#ef4444' : '#22c55e')}
    </div>`;

  // ── Section 2: Weak sections ──
  const weakHTML = data.weakSections.length === 0
    ? `<div style="color:var(--text-muted);font-size:0.88rem;padding:0.5rem 0;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="party-popper" class="icon-sm" style="color:#22c55e;"></i><span>약점 섹션이 없습니다!</span></div>`
    : data.weakSections.map(s => `
      <div class="er-section-card" style="border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;overflow:hidden;">
        <div class="er-section-header" style="display:flex;align-items:center;gap:0.5rem;padding:0.65rem 0.8rem;cursor:pointer;background:var(--surface2);">
          <span style="flex:1;font-size:0.88rem;font-weight:600;color:var(--text);">${escHtml(s.sectionName)}</span>
          ${noteTag(s.noteTitle)}
          ${badge(pct(s.accuracy), clr(s.accuracy))}
          <span style="color:var(--text-muted);font-size:0.8rem;margin-left:0.2rem;">▼</span>
        </div>
        <div class="er-section-body" style="display:none;padding:0.8rem 1rem;border-top:1px solid var(--border);background:var(--surface);">
          <div style="font-size:0.82rem;color:var(--text);line-height:1.7;max-height:320px;overflow-y:auto;">
            ${s.content ? renderMarkdown(s.content) : '<span style="color:var(--text-muted)">섹션 내용 없음</span>'}
          </div>
          <div style="margin-top:0.7rem;">${gotoBtn(s.noteId, s.sectionName)}</div>
        </div>
      </div>`).join('');

  // ── Section 3: Important sections ──
  const importantHTML = data.importantSections.length === 0
    ? `<div style="color:var(--text-muted);font-size:0.88rem;padding:0.5rem 0;">퀴즈 데이터가 없습니다.</div>`
    : data.importantSections.map(s => `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0.7rem;background:var(--surface2);border:1px solid var(--border);border-radius:6px;margin-bottom:0.35rem;">
        <span style="flex:1;font-size:0.85rem;font-weight:600;color:var(--text);">${escHtml(s.sectionName)}</span>
        ${noteTag(s.noteTitle)}
        ${badge(s.questionCount + '문제', 'var(--primary)')}
        ${badge(pct(s.accuracy), clr(s.accuracy))}
        ${gotoBtn(s.noteId, s.sectionName)}
      </div>`).join('');

  // ── Section 4: All sections sorted by accuracy ──
  const allHTML = data.allSections.length === 0
    ? `<div style="color:var(--text-muted);font-size:0.88rem;padding:0.5rem 0;">데이터 없음</div>`
    : data.allSections.map(s => {
        const acc   = s.accuracy;
        const fill  = acc === null ? 0 : acc;
        const color = acc === null ? 'var(--surface3)' : clr(acc);
        return `
          <div style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;cursor:pointer;" data-goto-note="${escHtml(s.noteId)}" data-goto-section="${escHtml(s.sectionName)}">
            <span style="min-width:140px;max-width:180px;font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(s.sectionName)}</span>
            ${noteTag(s.noteTitle)}
            <div style="flex:1;height:7px;background:var(--surface3);border-radius:4px;overflow:hidden;min-width:60px;">
              <div style="height:100%;width:${fill}%;background:${color};border-radius:4px;transition:width 0.4s;"></div>
            </div>
            <span style="font-size:0.78rem;min-width:34px;text-align:right;font-weight:600;color:${color};">${pct(acc)}</span>
          </div>`;
      }).join('');

  // sec() now takes a Lucide icon name + a tint color. The icon and title
  // are placed in a single inline-flex row so they line up cleanly.
  const sec = (iconName, iconColor, title, content) => `
    <div style="margin-bottom:1.4rem;">
      <div style="font-size:0.92rem;font-weight:700;color:var(--text);margin-bottom:0.6rem;display:flex;align-items:center;gap:0.4rem;"><i data-lucide="${iconName}" class="icon-sm" style="color:${iconColor};"></i><span>${escHtml(title)}</span></div>
      ${content}
    </div>`;

  return `
    <div style="font-size:0.88rem;font-weight:700;color:var(--text-muted);margin-bottom:0.8rem;display:flex;align-items:center;gap:0.35rem;"><i data-lucide="folder" class="icon-xs"></i><span>${escHtml(data.folderName)}</span></div>
    ${statsBar}
    ${sec('trending-down', '#ef4444', '약점 섹션 (정답률 70% 미만)', weakHTML)}
    ${sec('star',          '#eab308', '중요 섹션 (출제 빈도 상위)', importantHTML)}
    ${sec('bar-chart-3',   'var(--primary)', '전체 섹션 정답률', allHTML)}`;
}

function renderWeaknessReport(containerEl, report, quizCount) {
  const minQuestions  = 30;
  const totalAnswered = report ? report.totalQuestions : 0;
  const hasEnough     = totalAnswered >= minQuestions;
  if (!hasEnough) {
    containerEl.innerHTML = `<div style="font-size:0.8rem;color:var(--text-muted);padding:0.4rem 0;"><i data-lucide="presentation" class="icon-sm"></i> 약점 분석은 누적 ${minQuestions}문제 이상 풀면 제공됩니다 (${totalAnswered}/${minQuestions})</div>`;
    return;
  }
  if (!report || !report.sections.length) return;

  const colorClass = s => s.status === 'weak' ? 'weakness-red' : s.status === 'medium' ? 'weakness-yellow' : 'weakness-green';
  const weakNames  = report.sections.filter(s => s.status === 'weak').map(s => escHtml(s.name)).join(', ');

  containerEl.innerHTML = `
    <div style="font-size:0.82rem;font-weight:700;color:var(--text);margin-bottom:0.4rem;"><i data-lucide="presentation" class="icon-sm"></i> 약점 분석 (퀴즈 ${report.totalQuizzes}회 기준)</div>
    ${report.sections.map(s => `
      <div class="weakness-section-row">
        <span class="weakness-label weakness-label-link" title="${escHtml(s.name)}" data-section="${escHtml(s.name)}">${escHtml(s.name)}</span>
        <div class="weakness-bar-bg"><div class="weakness-bar-fill ${colorClass(s)}" style="width:${s.accuracy}%;"></div></div>
        <span class="weakness-pct ${colorClass(s)}">${s.correct || 0}/${s.total || 0} · ${s.accuracy}%</span>
      </div>`).join('')}
    <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.3rem;">총 ${report.totalQuizzes}회 퀴즈, ${report.totalQuestions}문제 풀이</div>
    ${weakNames ? `<div style="font-size:0.8rem;color:#ef4444;margin-top:0.2rem;"><i data-lucide="lightbulb" class="icon-xs"></i> 약점 섹션에 집중해서 복습하세요: ${weakNames}</div>` : ''}`;

  // Attach click handlers to section labels — scroll to matching h2 in splitNotes
  containerEl.querySelectorAll('.weakness-label-link[data-section]').forEach(el => {
    el.addEventListener('click', () => scrollToNoteSection(el.dataset.section));
  });
}

function scrollToNoteSection(sectionName) {
  switchSplitTab('notes');
  const splitNotes = document.getElementById('splitNotes');
  if (!splitNotes) return;
  // Find matching h2 by exact text or partial match
  const h2s = Array.from(splitNotes.querySelectorAll('h2'));
  const target = h2s.find(h => h.textContent.trim() === sectionName)
               || h2s.find(h => h.textContent.trim().includes(sectionName) || sectionName.includes(h.textContent.trim()));
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('section-highlight-flash');
  target.addEventListener('animationend', () => target.classList.remove('section-highlight-flash'), { once: true });
}

function buildWeaknessPreviewHtml(report) {
  if (!report || !Array.isArray(report.sections) || !report.sections.length) {
    return '<div style="padding:1rem;color:var(--text-muted);">아직 분석할 데이터가 부족해요.</div>';
  }
  const sorted = [...report.sections].sort((a, b) => (a.accuracy || 0) - (b.accuracy || 0));
  return `<div class="weakness-preview-rows">${sorted.map(s => {
    const acc   = Math.round(s.accuracy || 0);
    const color = acc >= 80 ? '#22c55e' : acc >= 50 ? '#eab308' : '#ef4444';
    return `<div class="weakness-preview-row">
      <span class="weakness-preview-name" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
      <span class="weakness-preview-bar"><span class="weakness-preview-bar-fill" style="width:${acc}%;background:${color};"></span></span>
      <span class="weakness-preview-stats" style="color:${color};">${s.correct || 0}/${s.total || 0} · ${acc}%</span>
      <button class="weakness-preview-review-btn" data-section="${escHtml(s.name)}">복습</button>
    </div>`;
  }).join('')}</div>`;
}

function wireWeaknessReviewButtons(body) {
  body.querySelectorAll('.weakness-preview-review-btn').forEach(btn => {
    btn.addEventListener('click', () => scrollToNoteSection(btn.dataset.section));
  });
}

async function updateNoteWeaknessBadges(noteId) {
  if (!noteId) return;
  const splitNotes = document.getElementById('splitNotes');
  if (!splitNotes) return;
  const h2s = Array.from(splitNotes.querySelectorAll('h2'));
  if (!h2s.length) return;

  const report = await getWeaknessReport(noteId).catch(() => null);
  if (!report || !report.sections.length) return;

  const sectionMap = new Map(report.sections.map(s => [s.name, s]));

  h2s.forEach(h2 => {
    // Remove any existing badge from a previous call
    h2.querySelector('.weakness-badge')?.remove();

    const text = h2.textContent.trim();
    // Exact match first, then partial
    const sec = sectionMap.get(text)
      || [...sectionMap.values()].find(s => text.includes(s.name) || s.name.includes(text));
    if (!sec) return;

    const cls = sec.accuracy >= 80 ? 'green' : sec.accuracy >= 50 ? 'yellow' : 'red';
    const badge = document.createElement('span');
    badge.className = `weakness-badge ${cls}`;
    badge.textContent = sec.accuracy + '%';
    h2.appendChild(badge);
  });
}

async function showQuizHistory(parentOverlay, noteId, noteTitle) {
  const histOverlay = document.createElement('div');
  histOverlay.className = 'db-modal-overlay';
  histOverlay.style.zIndex = '10001';
  histOverlay.addEventListener('click', e => { if (e.target === histOverlay) histOverlay.remove(); });

  histOverlay.innerHTML = `
    <div class="db-modal" style="max-width:500px;display:flex;flex-direction:column;max-height:85vh;">
      <h3><i data-lucide="presentation" class="icon-sm"></i> 퀴즈 이력 — ${escHtml(noteTitle || '노트')}</h3>
      <div class="db-modal-list" id="quizHistList" style="overflow-y:auto;flex:1;"></div>
      <div class="db-modal-footer" style="justify-content:flex-end;">
        <button onclick="this.closest('.db-modal-overlay').remove()" style="background:var(--surface3);color:var(--text);">닫기</button>
      </div>
    </div>`;

  document.body.appendChild(histOverlay);

  const listEl = histOverlay.querySelector('#quizHistList');
  listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0;">불러오는 중...</div>';

  try {
    const results = await getQuizResultsByNote(noteId);
    if (!results.length) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0;">저장된 이력이 없습니다.</div>';
      return;
    }
    listEl.innerHTML = results.map(r => {
      const d   = new Date(r.timestamp);
      const dateStr = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const pct = Math.round(r.score / r.total * 100);
      const m   = Math.floor(r.timeTaken / 60);
      const s   = r.timeTaken % 60;
      const timeStr = (m > 0 ? m + '분 ' : '') + s + '초';
      const color = pct >= 80 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
      return `<div class="db-modal-row">
        <span style="font-size:0.82rem;color:var(--text-muted);min-width:110px;">${escHtml(dateStr)}</span>
        <span style="font-weight:700;color:${color};min-width:80px;">${r.score}/${r.total} (${pct}%)</span>
        <span style="font-size:0.82rem;color:var(--text-muted);">${escHtml(timeStr)}</span>
      </div>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = `<div style="color:#ef4444;font-size:0.85rem;">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

// ── Classify tab ────────────────────────────────────────────────────────────

async function classifyNoteContent(noteText) {
  const systemPrompt =
    'You are an academic content classifier. Classify each paragraph/section of the study notes into exactly one category: theory (이론), research (연구), case (사례), or other (기타). ' +
    'Output ONLY a valid JSON array. Each element: {"category":"theory|research|case|other","title":"short descriptive title","content":"the original text of that section"}. ' +
    'Keep the original text intact. Merge consecutive paragraphs of the same category into one element. All output in Korean.';

  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  // B2: 30s timeout — classify is a single Haiku call, should be fast
  const classifyCtl = new AbortController();
  const classifyTimer = setTimeout(() => classifyCtl.abort(), 30000);
  let res;
  try {
    res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: noteText }],
        idToken,
        isFirstCall: false,
        feature: 'classify',
      }),
      signal: classifyCtl.signal,
    });
  } catch (e) {
    clearTimeout(classifyTimer);
    if (e.name === 'AbortError') throw new Error('분류 시간 초과 (30초). 다시 시도해주세요.');
    throw e;
  }
  clearTimeout(classifyTimer);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 오류 (${res.status})`);
  }

  const data = await res.json();
  const raw  = data?.content?.[0]?.text ?? '';
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('분류 결과를 파싱할 수 없습니다.');
  const items = JSON.parse(match[0]);
  if (!Array.isArray(items)) throw new Error('분류 결과가 배열이 아닙니다.');
  return items;
}

function renderClassifyArea(items) {
  const area = document.getElementById('classifyArea');
  if (!items.length) {
    area.innerHTML = '<span class="placeholder-msg">분류 결과가 없습니다.</span>';
    return;
  }

  // Count items per category
  const counts = {};
  items.forEach(item => { counts[item.category] = (counts[item.category] || 0) + 1; });

  // Render filter toggle buttons — only for categories that appear in results
  const filterBtnsHtml = Object.entries(counts).map(([cat, n]) => {
    const label = CLASSIFY_LABELS[cat] || cat;
    const color = CLASSIFY_COLORS[cat] || '#6b7280';
    return `<button data-filter-cat="${cat}" onclick="toggleClassifyFilter(this)" style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.25rem 0.75rem;border-radius:14px;border:1.5px solid ${color};background:${color}22;color:${color};font-size:0.8rem;font-weight:700;cursor:pointer;transition:opacity 0.15s;">${label}<span style="background:${color};color:#fff;border-radius:8px;padding:0.05rem 0.4rem;font-size:0.72rem;">${n}</span></button>`;
  }).join('');

  // Render cards — each card tagged with data-cat for filter targeting
  const cardsHtml = items.map(item => {
    const label = CLASSIFY_LABELS[item.category] || item.category;
    const color = CLASSIFY_COLORS[item.category] || '#6b7280';
    return `
      <div data-cat="${item.category}" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.55rem 0.9rem;background:var(--surface2);border-bottom:1px solid var(--border);">
          <span style="padding:0.15rem 0.55rem;border-radius:10px;background:${color}22;color:${color};font-size:0.75rem;font-weight:700;">${label}</span>
          <span style="font-size:0.88rem;font-weight:600;color:var(--text);">${escHtml(item.title)}</span>
        </div>
        <div style="padding:0.75rem 0.9rem;font-size:0.84rem;line-height:1.7;color:var(--text);white-space:pre-wrap;word-break:keep-all;">${escHtml(item.content)}</div>
      </div>`;
  }).join('');

  area.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0.25rem 0 0.5rem;" id="classifyFilters">${filterBtnsHtml}</div>
    <div style="display:flex;flex-direction:column;gap:0.6rem;" id="classifyCards">${cardsHtml}</div>`;
}

function toggleClassifyFilter(btn) {
  const cat = btn.dataset.filterCat;
  const filters = document.querySelectorAll('#classifyFilters [data-filter-cat]');

  // Count currently active buttons excluding this one
  const activeOthers = Array.from(filters).filter(b => b !== btn && b.style.opacity !== '0.4');

  // Prevent turning off the last active filter
  const isCurrentlyActive = btn.style.opacity !== '0.4';
  if (isCurrentlyActive && activeOthers.length === 0) return;

  // Toggle this button's active state
  btn.style.opacity = isCurrentlyActive ? '0.4' : '1';

  // Show/hide matching cards — no re-render
  document.querySelectorAll('#classifyCards [data-cat]').forEach(card => {
    if (card.dataset.cat !== cat) return;
    card.style.display = isCurrentlyActive ? 'none' : '';
  });
}

function launchQuiz() {
  const noteText  = storedNotesText;
  const noteTitle = document.getElementById('notesCardTitle').textContent.replace(/^📚\s*/, '').trim() || '노트';
  const noteId    = currentNoteId || null;
  if (!noteText) { showToast('먼저 AI 분석을 실행해주세요.'); return; }
  showQuizSettings(noteTitle, noteId, noteText);
}
