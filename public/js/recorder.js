// In-app recorder + audio file STT pipeline.
//
// Three entry points wire into the existing multi-rec list:
//   1. Live mic recording (web MediaRecorder)         — works PC, Android well; iOS limited (foreground only)
//   2. Audio file upload (m4a/mp3/wav/webm/aac/etc.)  — universal fallback, including iOS
//
// After audio is captured we:
//   1. Upload audio blob to Firebase Storage at users/{uid}/recordings/{ts}.{ext}
//   2. Get a downloadURL
//   3. POST that URL to /api/assemblyai?action=transcribe
//   4. Poll /api/assemblyai?action=status&id=...   every 6 seconds
//   5. When completed, wrap text into a File object and feed addRecSlot(file)
//
// Depends on: constants.js (storage, currentUser, txtFiles, _currentView), pptx_parser.js (addRecSlot, setRecSlotFile),
//             ui.js (showToast), firebase_auth.js (currentUser ID token), api.js (none),
//             transcripts_store.js (saveTranscriptFS) — optional; if absent, recorder still works
//             but transcripts won't be persisted to the user's transcript store.

(function () {
  // U7b live: GROQ_API_KEY registered in Vercel 2026-07-10. Diarization runs on
  // the local worker (worker/diarize_worker.py) — if it's offline, transcripts
  // still deliver unlabeled after the grace window.
  const USE_WHISPER = true; // rollback: false → AssemblyAI

  // ── Audio MIME detection (browser quirks) ───────────────
  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function extFromMime(mime) {
    if (!mime) return 'webm';
    if (mime.startsWith('audio/webm')) return 'webm';
    if (mime.startsWith('audio/mp4'))  return 'm4a';
    if (mime.startsWith('audio/ogg'))  return 'ogg';
    if (mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav')) return 'wav';
    if (mime.startsWith('audio/mpeg')) return 'mp3';
    return 'bin';
  }

  function isiOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // ── Pill drag state ─────────────────────────────────────
  let pillPos = null; // {x, y} pixels from viewport top-left, or null for default

  function loadPillPos() {
    try {
      const s = localStorage.getItem('recorder.pillPos');
      if (s) pillPos = JSON.parse(s);
    } catch (e) {}
  }

  function savePillPos(x, y) {
    pillPos = { x, y };
    try { localStorage.setItem('recorder.pillPos', JSON.stringify({ x, y })); } catch (e) {}
  }

  // ── Inline SVG icons for pill buttons (no lucide dependency) ──
  const SVG_PAUSE  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const SVG_PLAY   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  const SVG_STOP   = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  const SVG_EXPAND = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  // ── CSS injection ────────────────────────────────────────
  function injectPillStyles() {
    if (document.getElementById('recorder-pill-styles')) return;
    const style = document.createElement('style');
    style.id = 'recorder-pill-styles';
    style.textContent = `
      /* Minimized: whole modal wrapper becomes click-through */
      .recorder-modal--minimized {
        pointer-events: none !important;
      }

      /* Minimized: backdrop is invisible + click-through.
         IMPORTANT: also kill backdrop-filter, otherwise the blur(2px)
         from .recorder-backdrop in index.html stays applied to the
         whole viewport (the element keeps inset:0) and the page looks
         hazy while the pill floats. */
      .recorder-modal--minimized .recorder-backdrop {
        display: none !important;
      }

      /* Minimized: panel becomes a compact floating pill */
      .recorder-modal--minimized .recorder-panel {
        position: fixed !important;
        width: 280px !important;
        min-height: 0 !important;
        height: auto !important;
        border-radius: 999px !important;
        padding: 0 !important;
        transform: none !important;
        z-index: 10001 !important;
        box-shadow: 0 4px 28px rgba(0,0,0,0.28) !important;
        display: flex !important;
        align-items: center !important;
        overflow: hidden !important;
        cursor: grab !important;
        flex-direction: row !important;
        pointer-events: auto !important;
      }
      .recorder-modal--minimized .recorder-panel:active {
        cursor: grabbing !important;
      }

      /* Hide full modal chrome while minimized */
      .recorder-modal--minimized .recorder-head,
      .recorder-modal--minimized .recorder-body {
        display: none !important;
      }

      /* Pill content — hidden in full mode, shown in minimized mode */
      .recorder-pill {
        display: none;
      }
      .recorder-modal--minimized .recorder-pill {
        display: flex !important;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        width: 100%;
        user-select: none;
        -webkit-user-select: none;
      }

      .rec-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        flex-shrink: 0;
        animation: recDotBlink 1.2s ease-in-out infinite;
      }
      .rec-dot--paused {
        animation: none !important;
        opacity: 0.35;
      }
      @keyframes recDotBlink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.2; }
      }

      .rec-pill-timer {
        font-size: 13px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
        flex: 1;
        min-width: 0;
        white-space: nowrap;
      }

      .rec-pill-btn {
        background: none;
        border: none;
        padding: 5px;
        cursor: pointer;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.12s;
        line-height: 0;
      }
      .rec-pill-btn:hover { background: rgba(128,128,128,0.15); }
      .rec-pill-btn svg   { width: 15px; height: 15px; }
      .rec-pill-btn--stop   { color: #ef4444; }
      .rec-pill-btn--expand { opacity: 0.65; }
      .rec-pill-btn--expand:hover { opacity: 1; }

      /* ── Top-center grabber (replaces header minimize button) ──
         Mobile-sheet pattern: a wide horizontal handle at the very
         top of the panel. On hover/touch, the handle highlights and
         a "작게 보기" label fades in below it so the affordance is
         unambiguous on first encounter — far more discoverable than
         a tiny corner icon. Click the whole area to minimize. */
      /* Mini "작게 보기" affordance pinned to the top-center of the
         recorder panel. Uses a Picture-in-Picture icon + label so the
         action is unambiguous on first encounter — far more discoverable
         than a tiny corner icon. Click the whole area to minimize. */
      .recorder-grabber {
        display: none;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: auto;
        margin: 8px auto 4px;
        padding: 6px 14px;
        background: var(--primary-dim);
        border: 1px solid var(--primary);
        border-radius: 999px;
        cursor: pointer;
        color: var(--primary);
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        flex-shrink: 0;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        line-height: 1;
      }
      .recorder-grabber.is-visible { display: inline-flex; }
      .recorder-grabber-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        display: block;
      }
      .recorder-grabber-label {
        white-space: nowrap;
      }
      .recorder-grabber:hover,
      .recorder-grabber:focus-visible {
        background: var(--primary-dim);
        border-color: var(--primary);
        outline: none;
      }
      .recorder-grabber:active {
        transform: scale(0.97);
      }
      /* Hide entirely while minimized — pill replaces it */
      .recorder-modal--minimized .recorder-grabber { display: none !important; }

      /* ── STT 3-stage progress tracker ─────────── */
      .rec-stt-stages {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        margin: 0 0 1.1rem;
        width: 100%;
      }
      .rec-stt-stage {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }
      .rec-stt-stage-line {
        flex: 1;
        height: 2px;
        min-width: 14px;
        max-width: 44px;
        background: var(--border, #252545);
      }
      .rec-stt-stage-dot {
        width: 30px; height: 30px;
        border-radius: 50%;
        background: var(--surface3, #1e1e36);
        border: 2px solid var(--border, #252545);
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700;
        color: var(--text-muted, #8888aa);
        transition: border-color 0.3s, background 0.3s;
        position: relative; overflow: hidden;
      }
      .rec-stt-stage--done .rec-stt-stage-dot {
        background: rgba(74,222,128,0.15);
        border-color: #4ade80; color: #4ade80;
      }
      .rec-stt-stage--active .rec-stt-stage-dot {
        background: var(--primary-dim);
        border-color: var(--primary);
        color: transparent;
      }
      .rec-stt-stage-dot--spinner::after {
        content: '';
        position: absolute;
        width: 14px; height: 14px;
        border: 2.5px solid transparent;
        border-top-color: var(--primary);
        border-radius: 50%;
        animation: recSttSpin 0.8s linear infinite;
      }
      @keyframes recSttSpin { to { transform: rotate(360deg); } }
      .rec-stt-stage-label {
        font-size: 10px;
        color: var(--text-muted, #8888aa);
        white-space: nowrap; text-align: center;
        max-width: 72px; line-height: 1.3;
      }
      .rec-stt-stage--active .rec-stt-stage-label {
        color: var(--primary); font-weight: 600;
      }
      .rec-stt-stage--done .rec-stt-stage-label { color: #4ade80; }

      /* ── STT elapsed + hint strips ─────────────── */
      .rec-stt-elapsed {
        font-size: 0.95rem; font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text, #e2e2f2);
        margin-bottom: 0.55rem; letter-spacing: 0.04em;
      }
      .rec-stt-close-note {
        font-size: 0.78rem;
        color: var(--primary);
        background: var(--primary-dim);
        border-radius: 6px; padding: 0.4rem 0.75rem;
        margin: 0.5rem 0; text-align: center; line-height: 1.4;
      }
      .rec-stt-long-warn {
        display: none;
        font-size: 0.78rem; color: #fbbf24;
        background: rgba(251,191,36,0.10);
        border-radius: 6px; padding: 0.4rem 0.75rem;
        margin-top: 0.4rem; text-align: center;
      }

      /* ── Engine selector ─────────────────────────── */
      .rec-engine-header {
        font-size: 1.05rem; font-weight: 700;
        color: var(--text, #e2e2f2); margin-bottom: 0.35rem;
      }
      .rec-engine-duration {
        font-size: 0.82rem; color: var(--text-muted, #8888aa); margin-bottom: 1.1rem;
      }
      .rec-engine-options { display: flex; flex-direction: column; gap: 0.55rem; margin-bottom: 1.2rem; }
      .rec-engine-option {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.85rem 1rem; border: 2px solid var(--border, #252545);
        border-radius: 10px; cursor: pointer; transition: border-color 0.15s, background 0.15s;
      }
      .rec-engine-option--selected {
        border-color: var(--primary);
        background: var(--primary-dim);
      }
      .rec-engine-option input[type="radio"] {
        flex-shrink: 0; accent-color: var(--primary); width: 16px; height: 16px; cursor: pointer;
      }
      .rec-engine-option-title { font-weight: 600; font-size: 0.93rem; color: var(--text, #e2e2f2); }
      .rec-engine-option-desc  { font-size: 0.78rem; color: var(--text-muted, #8888aa); margin-top: 0.18rem; }

      /* ── Secondary button variant (done modal) ─── */
      .rec-btn-secondary {
        background: var(--surface2, #16162a);
        color: var(--text, #e2e2f2);
        border: 1px solid var(--border, #252545);
      }
      .rec-btn-secondary:hover { background: var(--surface3, #1e1e36); }

      /* ── STT background pill ─────────────────────────── */
      .rec-pill-stt-spinner {
        width: 14px; height: 14px;
        border: 2px solid rgba(96,165,250,0.25);
        border-top-color: #60a5fa;
        border-radius: 50%;
        animation: recSttSpin 0.8s linear infinite;
        flex-shrink: 0;
      }
      .rec-pill-stt-label {
        font-size: 13px; font-weight: 600;
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #93c5fd;
      }
      .rec-pill-stt-elapsed {
        font-size: 12px; font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
        color: rgba(147,197,253,0.7); flex-shrink: 0; white-space: nowrap;
      }
      .recorder-modal--minimized.recorder-modal--stt .recorder-panel {
        background: #0c1424 !important;
        border: 1px solid rgba(96,165,250,0.22) !important;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .recorder-panel {
        border-color: rgba(251,191,36,0.35) !important;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-label,
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-elapsed {
        color: #fbbf24;
      }
      .recorder-modal--minimized.recorder-modal--stt-long .rec-pill-stt-spinner {
        border-top-color: #fbbf24;
        border-color: rgba(251,191,36,0.25);
      }
    `;
    document.head.appendChild(style);
  }

  // ── Modal singleton ─────────────────────────────────────
  let modalEl = null;
  let modalState = {
    phase: 'idle', // idle | requesting | recording | paused | uploading | transcribing | completed | error
    rec: null,
    chunks: [],
    stream: null,
    mime: '',
    startTime: 0,
    elapsedAtPause: 0,
    timerHandle: null,
    levelHandle: null,
    audioCtx: null,
    analyser: null,
    pollHandle: null,
    targetSlotId: null,
    objectUrl: null,
    audioStoragePath: null,
    recordingDurationSec: null,
    pollStart: 0,           // timestamp when STT polling started (for elapsed display)
    sttElapsedHandle: null, // setInterval handle for MM:SS elapsed display during STT
    pendingFile: null,      // transcript File held for "다음: 강의 자료 추가하기" CTA
    sttEngine: 'assemblyai', // 'assemblyai' | 'google' — set by engine selector
    pendingBlob: null,       // audio Blob held between engine selector and handleAudioBlob
    pendingFilename: null,
    lastBlob: null,          // Q2: retained audio Blob/File — survives upload/STT failure for retry
    lastFilename: null,
    transcriptId: null,      // Q2: AssemblyAI/Google job id — lets retry resume polling instead of re-uploading
    sttApi: null,            // Q2: which STT endpoint the current transcriptId belongs to
    pollFailCount: 0,        // Q2: consecutive poll() failures — only fail after 5
  };

  function ensureModal() {
    if (modalEl) return modalEl;
    injectPillStyles();

    modalEl = document.createElement('div');
    modalEl.id = 'recorderModal';
    modalEl.className = 'recorder-modal hidden';
    modalEl.innerHTML = `
      <div class="recorder-backdrop"></div>
      <div class="recorder-panel" role="dialog" aria-modal="true" aria-label="녹음">
        <button class="recorder-grabber" id="recMinimizeBtn" aria-label="작게 보기 (PIP)" title="작게 보기 (PIP)">
          <svg class="recorder-grabber-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/>
            <rect x="13" y="13" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>
          </svg>
          <span class="recorder-grabber-label">작게 보기</span>
        </button>
        <div class="recorder-head">
          <div class="recorder-title" id="recTitle">녹음하기</div>
          <button class="recorder-close" id="recCloseBtn" aria-label="닫기" title="닫기"><i data-lucide="x" class="icon-sm"></i></button>
        </div>

        <div class="recorder-body" id="recBody">
          <!-- Idle: pick mode -->
          <div class="rec-screen rec-screen-idle" data-screen="idle">
            <p class="rec-help">강의를 직접 녹음하거나, 이미 녹음된 오디오 파일을 업로드하세요. STT가 끝나면 자동으로 녹취록 슬롯에 채워집니다.</p>
            <div class="rec-ios-warn" id="recIosWarn" style="display:none">
              <strong>iOS 사용자 안내</strong><br>
              녹음 도중 화면을 끄거나 다른 앱으로 전환하면 마이크가 멈춥니다. 녹음 동안 Notyx 화면을 켜둔 상태로 유지해주세요.
            </div>
            <div class="rec-mode-grid">
              <button class="rec-mode-card" id="recPickLive">
                <div class="rec-mode-icon"><i data-lucide="mic"></i></div>
                <div class="rec-mode-title">직접 녹음</div>
                <div class="rec-mode-sub">PC · 안드로이드 권장</div>
              </button>
              <label class="rec-mode-card" for="recFileInput">
                <div class="rec-mode-icon"><i data-lucide="upload"></i></div>
                <div class="rec-mode-title">오디오 파일 업로드</div>
                <div class="rec-mode-sub">mp3 · m4a · wav · webm</div>
              </label>
              <input type="file" id="recFileInput" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac,.flac" style="display:none" />
            </div>
            <div class="rec-speakers-row">
              <label class="rec-speakers-label" for="recSpeakersHint">발화자 수</label>
              <select id="recSpeakersHint" class="rec-speakers-select">
                <option value="" selected>자동 감지</option>
                <option value="1">1명 (혼자 강의)</option>
                <option value="2">2명</option>
                <option value="3">3명</option>
                <option value="4">4명</option>
                <option value="5">5명</option>
                <option value="6">6명</option>
                <option value="7">7명</option>
                <option value="8">8명</option>
              </select>
            </div>
          </div>

          <!-- Recording / paused -->
          <div class="rec-screen rec-screen-live" data-screen="live">
            <div class="rec-timer" id="recTimer">00:00</div>
            <div class="rec-meter"><div class="rec-meter-bar" id="recMeterBar"></div></div>
            <div class="rec-status" id="recLiveStatus">녹음 중…</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-secondary" id="recPauseBtn">일시정지</button>
              <button class="rec-btn rec-btn-stop" id="recStopBtn">녹음 종료</button>
            </div>
            <button class="rec-cancel-link" id="recCancelLiveBtn">취소</button>
          </div>

          <!-- Engine selector (live recording only) -->
          <div class="rec-screen rec-screen-engine-select" data-screen="engine-select">
            <div class="rec-engine-header">STT 엔진 선택</div>
            <div class="rec-engine-duration" id="recEngineDurationLabel">녹음 시간: 계산 중…</div>
            <div class="rec-engine-options">
              <label class="rec-engine-option rec-engine-option--selected" id="recEngineOptAAI">
                <input type="radio" name="sttEngine" value="assemblyai" id="recEngineAssemblyAI" checked>
                <div>
                  <div class="rec-engine-option-title">기본 엔진 (무료)</div>
                  <div class="rec-engine-option-desc">무료 · 빠름 · 정확도 보통</div>
                </div>
              </label>
              <label class="rec-engine-option" id="recEngineOptGoogle">
                <input type="radio" name="sttEngine" value="google" id="recEngineGoogle">
                <div>
                  <div class="rec-engine-option-title">Google STT (Chirp_2)</div>
                  <div class="rec-engine-option-desc">한국어 정확도 최상 · <span id="recEnginePriceLabel">1,500원~</span></div>
                </div>
              </label>
            </div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recEngineProceedBtn">계속 →</button>
            </div>
            <button class="rec-cancel-link" id="recEngineCancelBtn">취소 (녹음 파기)</button>
          </div>

          <!-- Uploading -->
          <div class="rec-screen rec-screen-upload" data-screen="upload">
            <div class="rec-progress-wrap">
              <div class="rec-progress-bar" id="recUploadBar"></div>
            </div>
            <div class="rec-status" id="recUploadStatus">업로드 준비 중…</div>
          </div>

          <!-- Transcribing (AssemblyAI polling) -->
          <div class="rec-screen rec-screen-stt" data-screen="stt">
            <div class="rec-stt-stages">
              <div class="rec-stt-stage rec-stt-stage--done" id="recSttStage1">
                <div class="rec-stt-stage-dot">✓</div>
                <div class="rec-stt-stage-label">① 업로드</div>
              </div>
              <div class="rec-stt-stage-line"></div>
              <div class="rec-stt-stage rec-stt-stage--active" id="recSttStage2">
                <div class="rec-stt-stage-dot rec-stt-stage-dot--spinner"></div>
                <div class="rec-stt-stage-label" id="recSttStage2Label">② 변환 대기 중</div>
              </div>
              <div class="rec-stt-stage-line"></div>
              <div class="rec-stt-stage rec-stt-stage--pending" id="recSttStage3">
                <div class="rec-stt-stage-dot">③</div>
                <div class="rec-stt-stage-label">슬롯 채우기</div>
              </div>
            </div>
            <div class="rec-status" id="recSttStatus">텍스트 변환 시작 중…</div>
            <div class="rec-stt-elapsed" id="recSttElapsed">경과 00:00</div>
            <div class="rec-stt-hint">보통 강의 길이의 30~50% 시간이 소요됩니다 (90분 강의 ≈ 30~45분)</div>
            <div class="rec-stt-close-note">💡 이 창을 닫아도 변환은 계속됩니다. 결과는 자동으로 녹취록 슬롯에 추가됩니다.</div>
            <div class="rec-stt-long-warn" id="recSttLongWarn">⚠️ 긴 강의는 시간이 더 걸릴 수 있습니다. 조금만 기다려주세요.</div>
            <button class="rec-cancel-link" id="recHideSttBtn">창 닫기 (백그라운드 진행)</button>
          </div>

          <!-- Completed -->
          <div class="rec-screen rec-screen-done" data-screen="done">
            <div class="rec-done-icon"><i data-lucide="check"></i></div>
            <div class="rec-status" id="recDoneStatus">변환 완료</div>
            <div class="rec-done-hint" id="recDoneHint">녹취록 슬롯에 텍스트가 추가되었습니다. 분석을 시작하세요.</div>
            <div class="rec-done-byo-hint" id="recDoneBYOHint" style="font-size:0.75rem;color:var(--text-muted,#aaa);margin:0.4rem 0 0;line-height:1.45">💡 정확도가 부족하면 <a href="https://clovanote.naver.com" target="_blank" rel="noopener" style="color:var(--accent,#7c9ef8)">클로바노트</a>에서 변환 후 .txt 업로드 가능</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-secondary" id="recDoneCloseBtn">확인</button>
              <button class="rec-btn rec-btn-primary" id="recDoneGoNewBtn" style="display:none">다음: 강의 자료 추가하기 →</button>
            </div>
          </div>

          <!-- Error -->
          <div class="rec-screen rec-screen-error" data-screen="error">
            <div class="rec-error-icon"><i data-lucide="alert-triangle"></i></div>
            <div class="rec-status" id="recErrorStatus">오류가 발생했습니다.</div>
            <div class="rec-actions">
              <button class="rec-btn rec-btn-primary" id="recErrorRetryBtn">다시 시도</button>
            </div>
          </div>
        </div>

        <!-- Compact pill content (visible only when minimized) -->
        <div class="recorder-pill" id="recorderPill">
          <!-- Recording pill content -->
          <div id="recPillRecContent" style="display:flex;align-items:center;gap:8px;width:100%">
            <div class="rec-dot" id="recPillDot"></div>
            <div class="rec-pill-timer" id="recPillTimer">00:00</div>
            <button class="rec-pill-btn rec-pill-btn--pause"  id="recPillPauseBtn"  aria-label="일시정지"></button>
            <button class="rec-pill-btn rec-pill-btn--stop"   id="recPillStopBtn"   aria-label="녹음 종료"></button>
            <button class="rec-pill-btn rec-pill-btn--expand" id="recPillExpandBtn" aria-label="확장"></button>
          </div>
          <!-- STT pill content -->
          <div id="recPillSttContent" style="display:none;align-items:center;gap:8px;width:100%">
            <div class="rec-pill-stt-spinner"></div>
            <div class="rec-pill-stt-label" id="recPillSttLabel">변환 중…</div>
            <div class="rec-pill-stt-elapsed" id="recPillSttElapsed">00:00</div>
            <button class="rec-pill-btn rec-pill-btn--expand" id="recPillSttExpandBtn" aria-label="확장"></button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Set pill button icons (inline SVG — no lucide mounting needed)
    modalEl.querySelector('#recPillPauseBtn').innerHTML     = SVG_PAUSE;
    modalEl.querySelector('#recPillStopBtn').innerHTML      = SVG_STOP;
    modalEl.querySelector('#recPillExpandBtn').innerHTML    = SVG_EXPAND;
    modalEl.querySelector('#recPillSttExpandBtn').innerHTML = SVG_EXPAND;

    // Wire static handlers
    modalEl.querySelector('#recCloseBtn').addEventListener('click', closeModalIfSafe);
    modalEl.querySelector('.recorder-backdrop').addEventListener('click', handleBackdropClick);
    modalEl.querySelector('#recMinimizeBtn').addEventListener('click', minimizePill);
    modalEl.querySelector('#recPickLive').addEventListener('click', startLiveRecording);
    modalEl.querySelector('#recFileInput').addEventListener('change', onFilePicked);
    modalEl.querySelector('#recPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recCancelLiveBtn').addEventListener('click', cancelLiveRecording);
    modalEl.querySelector('#recHideSttBtn').addEventListener('click', minimizePill);
    modalEl.querySelector('#recDoneCloseBtn').addEventListener('click', hideModal);
    modalEl.querySelector('#recDoneGoNewBtn').addEventListener('click', () => {
      const file = modalState.pendingFile;
      hideModal();
      if (typeof switchView === 'function') switchView('new');
      if (file && typeof addRecSlot === 'function') {
        // Small delay so switchView finishes rendering before DOM manipulation
        setTimeout(() => addRecSlot(file), 80);
      }
    });
    modalEl.querySelector('#recErrorRetryBtn').addEventListener('click', () => {
      // Q2: prefer resuming an in-flight STT job over redoing the whole upload,
      // fall back to re-uploading the retained blob, else nothing to salvage.
      if (modalState.transcriptId) {
        resumePolling();
      } else if (modalState.lastBlob) {
        const blob = modalState.lastBlob, filename = modalState.lastFilename;
        handleAudioBlob(blob, filename);
      } else {
        switchScreen('idle');
      }
    });

    // Engine selector
    modalEl.querySelector('#recEngineProceedBtn').addEventListener('click', onEngineProceed);
    modalEl.querySelector('#recEngineCancelBtn').addEventListener('click', cancelFromEngineSelect);
    modalEl.querySelectorAll('input[name="sttEngine"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        modalEl.querySelector('#recEngineOptAAI').classList.toggle('rec-engine-option--selected',
          modalEl.querySelector('#recEngineAssemblyAI').checked);
        modalEl.querySelector('#recEngineOptGoogle').classList.toggle('rec-engine-option--selected',
          modalEl.querySelector('#recEngineGoogle').checked);
      });
    });

    // Pill controls
    modalEl.querySelector('#recPillPauseBtn').addEventListener('click', togglePause);
    modalEl.querySelector('#recPillStopBtn').addEventListener('click', stopRecording);
    modalEl.querySelector('#recPillExpandBtn').addEventListener('click', expandPill);
    modalEl.querySelector('#recPillSttExpandBtn').addEventListener('click', expandPill);

    // Drag
    initPillDrag(
      modalEl.querySelector('#recorderPill'),
      modalEl.querySelector('.recorder-panel')
    );

    // Block ESC while minimized — prevents accidental cancel via any external handler
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape'
          && modalEl
          && !modalEl.classList.contains('hidden')
          && modalEl.classList.contains('recorder-modal--minimized')) {
        e.stopImmediatePropagation();
      }
    }, true);

    return modalEl;
  }

  // ── Backdrop click: auto-minimize during active recording or STT ──
  function handleBackdropClick() {
    if (modalState.phase === 'recording' || modalState.phase === 'paused' || modalState.phase === 'transcribing') {
      minimizePill();
    } else {
      closeModalIfSafe();
    }
  }

  // ── Pill minimize / expand ───────────────────────────────
  function minimizePill() {
    ensureModal();
    loadPillPos();

    const panelEl = modalEl.querySelector('.recorder-panel');

    modalEl.classList.add('recorder-modal--minimized');
    modalEl.classList.remove('hidden');

    // Position after the CSS `position: fixed` has taken effect
    requestAnimationFrame(function () {
      const pillWidth  = 280;
      const pillHeight = panelEl.offsetHeight || 52;
      let x, y;
      if (pillPos && typeof pillPos.x === 'number' && typeof pillPos.y === 'number') {
        x = Math.max(0, Math.min(window.innerWidth  - pillWidth,  pillPos.x));
        y = Math.max(0, Math.min(window.innerHeight - pillHeight, pillPos.y));
      } else {
        x = window.innerWidth  - pillWidth  - 24;
        y = window.innerHeight - pillHeight - 24;
      }
      panelEl.style.left = x + 'px';
      panelEl.style.top  = y + 'px';
    });

    updatePillUI();
  }

  function expandPill() {
    ensureModal();
    const panelEl = modalEl.querySelector('.recorder-panel');

    modalEl.classList.remove('recorder-modal--minimized');
    panelEl.style.left = '';
    panelEl.style.top  = '';

    updatePillUI();
  }

  function updatePillUI() {
    if (!modalEl) return;
    const phase      = modalState.phase;
    const recContent = modalEl.querySelector('#recPillRecContent');
    const sttContent = modalEl.querySelector('#recPillSttContent');

    if (phase === 'transcribing') {
      if (recContent) recContent.style.display = 'none';
      if (sttContent) sttContent.style.display = 'flex';
      modalEl.classList.add('recorder-modal--stt');
    } else {
      if (recContent) recContent.style.display = 'flex';
      if (sttContent) sttContent.style.display = 'none';
      modalEl.classList.remove('recorder-modal--stt');
      modalEl.classList.remove('recorder-modal--stt-long');

      const dot      = modalEl.querySelector('#recPillDot');
      const pauseBtn = modalEl.querySelector('#recPillPauseBtn');
      if (dot && pauseBtn) {
        const paused = phase === 'paused';
        dot.classList.toggle('rec-dot--paused', paused);
        pauseBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
        pauseBtn.setAttribute('aria-label', paused ? '재개' : '일시정지');
        const mainTimer = document.getElementById('recTimer');
        const pillTimer = document.getElementById('recPillTimer');
        if (mainTimer && pillTimer) pillTimer.textContent = mainTimer.textContent;
      }
    }
  }

  // ── Pill drag (mouse + touch) ────────────────────────────
  function initPillDrag(pillEl, panelEl) {
    let dragging  = false;
    let startX    = 0, startY    = 0;
    let startLeft = 0, startTop  = 0;

    function dragStart(clientX, clientY) {
      dragging   = true;
      startX     = clientX;
      startY     = clientY;
      const rect = panelEl.getBoundingClientRect();
      startLeft  = rect.left;
      startTop   = rect.top;
      panelEl.style.transition  = 'none';
      document.body.style.userSelect = 'none';
    }

    function dragMove(clientX, clientY) {
      if (!dragging) return;
      const w = panelEl.offsetWidth  || 280;
      const h = panelEl.offsetHeight || 52;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - w, startLeft + (clientX - startX)));
      const newTop  = Math.max(0, Math.min(window.innerHeight - h, startTop  + (clientY - startY)));
      panelEl.style.left = newLeft + 'px';
      panelEl.style.top  = newTop  + 'px';
    }

    function dragEnd() {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      panelEl.style.transition = '';
      const rect = panelEl.getBoundingClientRect();
      savePillPos(rect.left, rect.top);
    }

    // Mouse events
    pillEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      dragStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', function (e) { if (dragging) dragMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup',   function ()  { dragEnd(); });

    // Touch events
    pillEl.addEventListener('touchstart', function (e) {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const t = e.touches[0];
      dragStart(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      const t = e.touches[0];
      dragMove(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', function () { dragEnd(); });
  }

  // ── Screen switching ─────────────────────────────────────
  function switchScreen(name) {
    if (!modalEl) return;
    modalEl.querySelectorAll('.rec-screen').forEach(el => {
      el.classList.toggle('active', el.dataset.screen === name);
    });
    modalState.screen = name;

    // Show minimize button on screens where backgrounding makes sense:
    // - 'live'         (recording in progress — let it run in the background)
    // - 'stt'          (transcribing in progress — same idea)
    // The grabber has `display: none` by default and switches to flex via
    // .is-visible — toggling style.display directly would lose the flex
    // and break the bar/label layout.
    const minimizeBtn = modalEl.querySelector('#recMinimizeBtn');
    if (minimizeBtn) minimizeBtn.classList.toggle('is-visible', name === 'live' || name === 'stt');

    if (name === 'error') updateErrorRetryButton();

    window.mountLucideIcons?.();
  }

  // Q2: label the error-screen retry button based on what's salvageable —
  // resuming a still-running STT job beats re-uploading, which beats a bare restart.
  function updateErrorRetryButton() {
    const btn = document.getElementById('recErrorRetryBtn');
    if (!btn) return;
    if (modalState.transcriptId)   btn.textContent = '이어서 확인';
    else if (modalState.lastBlob)  btn.textContent = '다시 업로드';
    else                            btn.textContent = '처음으로';
  }

  function showModal(targetSlotId = null) {
    ensureModal();
    // If already minimized (recording in background), just surface it
    if (modalEl.classList.contains('recorder-modal--minimized')) {
      expandPill();
      return;
    }
    modalState.targetSlotId = targetSlotId;
    modalEl.classList.remove('hidden');
    document.getElementById('recIosWarn').style.display = isiOS() ? 'block' : 'none';
    switchScreen('idle');
  }

  function hideModal() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    modalEl.classList.remove('recorder-modal--minimized');
    const panelEl = modalEl.querySelector('.recorder-panel');
    if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
  }

  async function closeModalIfSafe() {
    if (modalState.phase === 'recording' || modalState.phase === 'paused') {
      if (!await appConfirm('녹음을 취소하시겠습니까? 현재까지 녹음한 내용은 사라집니다.', { danger: true })) return;
      cancelLiveRecording();
      return;
    }
    if (modalState.phase === 'uploading') {
      if (!await appConfirm('업로드를 취소하시겠습니까?', { danger: true })) return;
    }
    if (modalState.phase === 'transcribing') {
      minimizePill();
      return;
    }
    hideModal();
  }

  // ── Live recording ──────────────────────────────────────
  async function startLiveRecording() {
    if (modalState.phase === 'transcribing') {
      window.showToast?.('⚠️ 이전 변환이 끝난 후 시작하세요.');
      return;
    }
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '이 브라우저는 녹음을 지원하지 않습니다. 오디오 파일 업로드를 사용해주세요.';
      return;
    }

    modalState.chunks = [];
    modalState.startTime = 0;
    modalState.elapsedAtPause = 0;

    try {
      modalState.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.error('[recorder] getUserMedia denied', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크 사용을 허용해주세요.';
      return;
    }

    modalState.mime = pickMimeType();
    try {
      // audioBitsPerSecond: 32000 keeps a 90-min opus recording ~22MB — well
      // inside Groq's file-size limit — with no audible speech-quality loss.
      const recOpts = modalState.mime ? { mimeType: modalState.mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 };
      modalState.rec = new MediaRecorder(modalState.stream, recOpts);
    } catch (err) {
      console.error('[recorder] MediaRecorder init failed', err);
      releaseStream();
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent = '녹음을 시작할 수 없습니다.';
      return;
    }

    modalState.rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) modalState.chunks.push(e.data);
    });
    modalState.rec.addEventListener('error', (e) => {
      console.error('[recorder] MediaRecorder error', e);
      handleMicDeath();
    });
    modalState.rec.addEventListener('stop', onRecorderStopped);

    // Mic-death detection: if a track ends unexpectedly (device unplugged,
    // OS killed the input, etc.) salvage what's recorded instead of losing it.
    modalState.stream.getTracks().forEach((t) => { t.onended = handleMicDeath; });

    // Small timeslice keeps memory bounded and enables partial-crash recovery
    modalState.rec.start(5000);
    modalState.startTime = Date.now();
    modalState.elapsedAtPause = 0;

    setupAudioMeter(modalState.stream);
    startTimer();
    switchScreen('live');
    document.getElementById('recPauseBtn').textContent = '일시정지';
    document.getElementById('recLiveStatus').textContent = '녹음 중…';
  }

  function startTimer() {
    if (modalState.timerHandle) clearInterval(modalState.timerHandle);
    modalState.timerHandle = setInterval(() => {
      const ms = (modalState.phase === 'recording')
        ? (modalState.elapsedAtPause + (Date.now() - modalState.startTime))
        : modalState.elapsedAtPause;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = String(Math.floor(totalSec / 60) % 60).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      const timeStr = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
      const el = document.getElementById('recTimer');
      if (el) el.textContent = timeStr;
      // Mirror to pill timer while minimized
      const pillTimer = document.getElementById('recPillTimer');
      if (pillTimer) pillTimer.textContent = timeStr;
    }, 250);
    // Must set phase AFTER wiring the interval — phase drives the ms calculation above
    modalState.phase = 'recording';
  }

  function setupAudioMeter(stream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      modalState.audioCtx = new Ctx();
      const src = modalState.audioCtx.createMediaStreamSource(stream);
      modalState.analyser = modalState.audioCtx.createAnalyser();
      modalState.analyser.fftSize = 256;
      src.connect(modalState.analyser);
      const buf = new Uint8Array(modalState.analyser.frequencyBinCount);
      const bar = document.getElementById('recMeterBar');
      modalState.levelHandle = setInterval(() => {
        if (!modalState.analyser) return;
        // While paused, freeze the meter at 0 so users see clearly that
        // nothing is being captured. The MediaStream itself stays live
        // (MediaRecorder.pause() doesn't stop the underlying track), so
        // without this guard the bar would keep dancing despite pause.
        if (modalState.phase === 'paused') {
          if (bar) bar.style.width = '0%';
          return;
        }
        modalState.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const pct = Math.min(100, Math.round(rms * 240));
        if (bar) bar.style.width = pct + '%';
      }, 80);
    } catch (e) {
      // Audio meter is decorative — silent fallback is fine
    }
  }

  function togglePause() {
    if (!modalState.rec) return;
    if (modalState.rec.state === 'recording') {
      modalState.rec.pause();
      modalState.elapsedAtPause += Date.now() - modalState.startTime;
      modalState.phase = 'paused';
      document.getElementById('recPauseBtn').textContent = '재개';
      document.getElementById('recLiveStatus').textContent = '일시정지됨';
    } else if (modalState.rec.state === 'paused') {
      modalState.rec.resume();
      modalState.startTime = Date.now();
      modalState.phase = 'recording';
      document.getElementById('recPauseBtn').textContent = '일시정지';
      document.getElementById('recLiveStatus').textContent = '녹음 중…';
    }
    updatePillUI();
  }

  function stopRecording() {
    if (!modalState.rec) return;
    // Expand first so the user can see upload/STT progress
    if (modalEl && modalEl.classList.contains('recorder-modal--minimized')) {
      expandPill();
    }
    if (modalState.rec.state !== 'inactive') {
      modalState.rec.stop(); // triggers onRecorderStopped
    }
  }

  function cancelLiveRecording() {
    if (modalState.rec && modalState.rec.state !== 'inactive') {
      // Detach stop handler so we don't try to upload a half-blob
      modalState.rec.removeEventListener('stop', onRecorderStopped);
      try { modalState.rec.stop(); } catch (e) {}
    }
    teardownLiveCapture();
    modalState.chunks = [];
    hideModal();
  }

  function teardownLiveCapture() {
    if (modalState.timerHandle) { clearInterval(modalState.timerHandle); modalState.timerHandle = null; }
    if (modalState.levelHandle) { clearInterval(modalState.levelHandle); modalState.levelHandle = null; }
    if (modalState.audioCtx)    { try { modalState.audioCtx.close(); } catch(e){} modalState.audioCtx = null; }
    modalState.analyser = null;
    releaseStream();
  }

  function releaseStream() {
    if (modalState.stream) {
      try {
        modalState.stream.getTracks().forEach(t => {
          t.onended = null; // detach before intentional stop — avoid double-firing handleMicDeath
          t.stop();
        });
      } catch (e) {}
      modalState.stream = null;
    }
  }

  // Fires on MediaRecorder 'error' or a track's 'ended' event (mic unplugged,
  // OS revoked access, etc). Auto-stop via the normal stop path so whatever
  // chunks were captured still flow into the usual blob→upload pipeline.
  function handleMicDeath() {
    if (!modalState.rec || modalState.rec.state === 'inactive') return;
    window.showToast?.('⚠️ 마이크 연결이 끊겨 녹음을 종료했습니다 — 지금까지 녹음은 저장됩니다');
    stopRecording();
  }

  async function onRecorderStopped() {
    teardownLiveCapture();
    const ext  = extFromMime(modalState.mime);
    const blob = new Blob(modalState.chunks, { type: modalState.mime || 'audio/webm' });
    modalState.chunks = [];

    if (blob.size < 5 * 1024) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '녹음된 내용이 너무 짧습니다. 다시 시도해주세요.';
      return;
    }

    // Capture total duration; paused time already in elapsedAtPause
    const finalMs = modalState.phase === 'recording'
      ? modalState.elapsedAtPause + (Date.now() - modalState.startTime)
      : modalState.elapsedAtPause;
    modalState.recordingDurationSec = Math.max(1, Math.floor(finalMs / 1000));

    const filename = 'recording_' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;

    // Store pending audio, reset engine choice, show selector
    modalState.pendingBlob = blob;
    modalState.pendingFilename = filename;
    modalState.sttEngine = 'assemblyai';
    showEngineSelector();
  }

  // ── Engine selector (live recording only) ──────────────
  function showEngineSelector() {
    const durationMin = Math.ceil(modalState.recordingDurationSec / 60);
    const { minutes, priceKRW } = (typeof priceFor === 'function')
      ? priceFor(durationMin)
      : { minutes: Math.ceil(durationMin / 30) * 30, priceKRW: 1500 };

    const durLbl = document.getElementById('recEngineDurationLabel');
    if (durLbl) durLbl.textContent = '녹음 시간: ' + durationMin + '분';

    const priceLbl = document.getElementById('recEnginePriceLabel');
    if (priceLbl) priceLbl.textContent = priceKRW.toLocaleString() + '원~';

    // Reset to default
    const aaiRadio = document.getElementById('recEngineAssemblyAI');
    if (aaiRadio) aaiRadio.checked = true;
    if (modalEl) {
      modalEl.querySelector('#recEngineOptAAI')?.classList.add('rec-engine-option--selected');
      modalEl.querySelector('#recEngineOptGoogle')?.classList.remove('rec-engine-option--selected');
    }

    switchScreen('engine-select');
  }

  async function onEngineProceed() {
    const selected = modalEl?.querySelector('input[name="sttEngine"]:checked')?.value || 'assemblyai';
    modalState.sttEngine = selected;

    if (selected === 'google') {
      const durationMin = Math.ceil(modalState.recordingDurationSec / 60);
      const { minutes, priceKRW } = (typeof priceFor === 'function')
        ? priceFor(durationMin)
        : { minutes: Math.ceil(durationMin / 30) * 30, priceKRW: 1500 };

      const confirmed = await appConfirm(
        `이 강의는 ${minutes}분입니다.\nGoogle STT 변환 비용: ${priceKRW.toLocaleString()}원\n결제하시겠습니까?`,
        { okText: '결제하기' }
      );
      if (!confirmed) return; // stay on engine selector

      try {
        if (typeof payForSttEntitlement !== 'function') throw new Error('결제 모듈이 로드되지 않았습니다.');
        await payForSttEntitlement(durationMin);
        // payment succeeded — sttEngine stays 'google'
      } catch (e) {
        // payment cancelled or failed — fall back to assemblyai automatically
        modalState.sttEngine = 'assemblyai';
        window.showToast?.('결제 취소 — 기본 STT로 진행합니다');
      }
    }

    const blob = modalState.pendingBlob;
    const filename = modalState.pendingFilename;
    modalState.pendingBlob = null;
    modalState.pendingFilename = null;
    handleAudioBlob(blob, filename);
  }

  function cancelFromEngineSelect() {
    modalState.pendingBlob = null;
    modalState.pendingFilename = null;
    modalState.sttEngine = 'assemblyai';
    hideModal();
  }

  // ── File upload entry ───────────────────────────────────
  function onFilePicked(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (modalState.phase === 'transcribing') {
      window.showToast?.('⚠️ 이전 변환이 끝난 후 시작하세요.');
      return;
    }
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '파일이 너무 큽니다 (최대 500MB). 더 작은 파일을 사용해주세요.';
      return;
    }
    modalState.sttEngine = 'assemblyai'; // file uploads always use the free engine (routed via USE_WHISPER below)
    handleAudioBlob(file, file.name);
  }

  // ── Build a Whisper vocabulary-biasing prompt from attached lecture material ───
  // Best-effort: never throws — a parse failure must not block recording delivery.
  async function buildSttTermsPrompt() {
    if (!pptFile) return null;
    try {
      const text = await extractPresentationText(pptFile);
      const tokens = text.match(/[A-Za-z][A-Za-z0-9-]+|[가-힣]{2,}/g) || [];
      const stoplist = new Set(['페이지', '슬라이드']);
      const counts = new Map();
      for (const t of tokens) {
        if (stoplist.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
      const terms = [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([term]) => term)
        .reverse(); // ascending frequency — Whisper only keeps the final ~224 tokens of the prompt
      if (!terms.length) return null;
      return terms.join(', ').slice(-300);
    } catch (err) {
      console.warn('[recorder] STT terms prompt extraction failed (non-fatal)', err);
      return null;
    }
  }

  // ── Upload to Firebase Storage + AssemblyAI pipeline ───
  async function handleAudioBlob(blob, filename) {
    if (!currentUser) {
      window.showToast?.('🔑 로그인 후 이용할 수 있습니다.');
      return;
    }
    modalState.phase = 'uploading';
    // Q2: retain the blob until STT completes so a failed upload/transcribe/poll
    // can retry without asking the user to re-record.
    modalState.lastBlob = blob;
    modalState.lastFilename = filename;
    modalState.transcriptId = null;
    modalState.pollFailCount = 0;
    // Kick off term extraction now so it runs in parallel with the upload below.
    const sttPromptPromise = buildSttTermsPrompt();
    switchScreen('upload');
    document.getElementById('recUploadStatus').textContent = '업로드 중…';
    document.getElementById('recUploadBar').style.width = '0%';

    const path = 'users/' + currentUser.uid + '/recordings/'
               + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
               + '_' + filename.replace(/[^\w.-]/g, '_');

    modalState.audioStoragePath = path;

    let downloadUrl;
    try {
      const ref = storage.ref(path);
      const task = ref.put(blob, { contentType: blob.type || 'application/octet-stream' });
      task.on('state_changed', (snap) => {
        const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes * 100) : 0;
        const bar = document.getElementById('recUploadBar');
        const lbl = document.getElementById('recUploadStatus');
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (lbl) lbl.textContent = `업로드 중… ${pct.toFixed(0)}%`;
      });
      await task;
      downloadUrl = await ref.getDownloadURL();
    } catch (err) {
      console.error('[recorder] storage upload failed', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '업로드에 실패했습니다. 인터넷 연결을 확인해주세요.';
      return;
    }

    switchScreen('stt');
    modalState.phase = 'transcribing';
    document.getElementById('recSttStatus').textContent = '텍스트 변환 시작 중…';

    // Determine STT endpoint based on selected engine
    const sttApi = modalState.sttEngine === 'google' ? '/api/google-stt'
      : (USE_WHISPER ? '/api/whisper-stt' : '/api/assemblyai');

    modalState.sttApi = sttApi;

    // Track when polling started for elapsed display and long-wait warning
    modalState.pollStart = Date.now();
    startSttElapsedTimer();

    let transcriptId;
    try {
      const idToken = await currentUser.getIdToken();
      const reqBody = { audio_url: downloadUrl };
      if (sttApi === '/api/whisper-stt') {
        const sttPrompt = await sttPromptPromise;
        if (sttPrompt) reqBody.prompt = sttPrompt;
        // U7e: optional speaker-count hint → pyannote exact-N clustering.
        // Unset ("자동 감지") sends nothing = unknown-N auto, today's behavior.
        const hintVal = parseInt(document.getElementById('recSpeakersHint')?.value, 10);
        if (hintVal >= 1) reqBody.speakers_hint = hintVal;
      }
      const tr = await fetch(sttApi + '?action=transcribe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + idToken,
        },
        body: JSON.stringify(reqBody),
      });
      const trJson = await tr.json();
      if (!tr.ok || !trJson.transcript_id) {
        throw new Error(trJson.error || 'transcribe_failed');
      }
      transcriptId = trJson.transcript_id;
    } catch (err) {
      console.error('[recorder] transcribe start failed', err);
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '텍스트 변환을 시작하지 못했습니다. (' + (err.message || 'unknown') + ')';
      return;
    }

    modalState.transcriptId = transcriptId;
    document.getElementById('recSttStatus').textContent = '대기열에서 차례를 기다리는 중…';
    modalState.pollHandle = setTimeout(pollOnce, 1500);
  }

  // MM:SS elapsed counter — updates every second while STT is in progress.
  // Shared by the initial upload flow and resumePolling() after a retry.
  function startSttElapsedTimer() {
    if (modalState.sttElapsedHandle) clearInterval(modalState.sttElapsedHandle);
    modalState.sttElapsedHandle = setInterval(() => {
      const sec = Math.floor((Date.now() - modalState.pollStart) / 1000);
      const mm  = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss  = String(sec % 60).padStart(2, '0');
      const el  = document.getElementById('recSttElapsed');
      if (el) el.textContent = `경과 ${mm}:${ss}`;
      const pillElapsed = document.getElementById('recPillSttElapsed');
      if (pillElapsed) pillElapsed.textContent = `${mm}:${ss}`;
      if (sec >= 300) {
        const warn = document.getElementById('recSttLongWarn');
        if (warn) warn.style.display = '';
        if (modalEl) modalEl.classList.add('recorder-modal--stt-long');
      }
    }, 1000);
  }

  const POLL_INTERVAL = 6000;
  const MAX_POLL_MS = 90 * 60 * 1000;

  // Q2: single poll step, reads transcriptId/sttApi off modalState so both the
  // original upload flow and resumePolling() (after a retry) can drive it.
  // Only escalates to the error screen after 5 CONSECUTIVE failures — one
  // flaky fetch no longer discards a transcription job that's still running
  // server-side.
  async function pollOnce() {
    try {
      const idToken = await currentUser.getIdToken();
      const r = await fetch(modalState.sttApi + '?action=status&id=' + encodeURIComponent(modalState.transcriptId), {
        headers: { 'authorization': 'Bearer ' + idToken },
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.error || 'status_failed');
      }
      modalState.pollFailCount = 0;

      const lbl      = document.getElementById('recSttStatus');
      const stLabel  = document.getElementById('recSttStage2Label');
      const pillLbl  = document.getElementById('recPillSttLabel');

      if (j.status === 'queued') {
        lbl.textContent = '대기열에서 차례를 기다리는 중…';
        if (stLabel)  stLabel.textContent = '② 변환 대기 중';
        if (pillLbl)  pillLbl.textContent = '대기 중…';
      } else if (j.status === 'processing') {
        lbl.textContent = '텍스트 변환 중…';
        if (stLabel)  stLabel.textContent = '② 텍스트 변환 중';
        if (pillLbl)  pillLbl.textContent = '변환 중…';
      } else if (j.status === 'completed') {
        deliverTranscript(j.text || '', modalState.lastFilename, j.diarization_job || null);
        return;
      } else if (j.status === 'error') {
        // Terminal: the job itself failed server-side — re-polling it is useless.
        // Clear transcriptId so the retry button falls back to re-upload (blob
        // is still retained), and escalate immediately instead of 5 retries.
        modalState.transcriptId = null;
        modalState.pollFailCount = 4;
        throw new Error(j.error_msg || 'transcription_error');
      }

      if (Date.now() - modalState.pollStart > MAX_POLL_MS) {
        modalState.transcriptId = null;  // terminal, same as above
        modalState.pollFailCount = 4;
        throw new Error('처리 시간이 너무 오래 걸립니다. 잠시 후 다시 시도해주세요.');
      }
      modalState.pollHandle = setTimeout(pollOnce, POLL_INTERVAL);
    } catch (err) {
      modalState.pollFailCount = (modalState.pollFailCount || 0) + 1;
      console.error('[recorder] poll failed (' + modalState.pollFailCount + '/5)', err);
      if (modalState.pollFailCount < 5) {
        // Transient — the AssemblyAI/Google job keeps running server-side, just retry.
        modalState.pollHandle = setTimeout(pollOnce, POLL_INTERVAL);
        return;
      }
      if (modalState.sttElapsedHandle) { clearInterval(modalState.sttElapsedHandle); modalState.sttElapsedHandle = null; }
      modalState.phase = 'error';
      if (modalEl) {
        modalEl.classList.remove('recorder-modal--minimized');
        modalEl.classList.remove('recorder-modal--stt');
        modalEl.classList.remove('recorder-modal--stt-long');
        modalEl.classList.remove('hidden');
        const panelEl = modalEl.querySelector('.recorder-panel');
        if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
      }
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '변환 중 오류가 발생했습니다. (' + (err.message || 'unknown') + ')';
    }
  }

  // Q2: retry button when a transcriptId survived a terminal poll failure —
  // resumes checking that same job instead of re-uploading the audio.
  function resumePolling() {
    if (!modalState.transcriptId) { switchScreen('idle'); return; }
    modalState.pollFailCount = 0;
    modalState.phase = 'transcribing';
    switchScreen('stt');
    document.getElementById('recSttStatus').textContent = '이어서 확인하는 중…';
    startSttElapsedTimer();
    modalState.pollHandle = setTimeout(pollOnce, 500);
  }

  function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s}초`;
    return `${m}분 ${s}초`;
  }

  async function deliverTranscript(text, sourceFilename, diarizationJobId) {
    if (modalState.pollHandle) { clearTimeout(modalState.pollHandle); modalState.pollHandle = null; }

    const cleanText = (text || '').trim();
    if (!cleanText) {
      switchScreen('error');
      document.getElementById('recErrorStatus').textContent =
        '변환된 텍스트가 비어있습니다. 녹음 파일을 확인해주세요.';
      return;
    }

    // Q2: STT succeeded — nothing left to retry, drop the retained blob/job id.
    modalState.lastBlob = null;
    modalState.lastFilename = null;
    modalState.transcriptId = null;
    modalState.pollFailCount = 0;

    // Step 1: persist to transcript store
    let savedTranscript = null;
    if (typeof saveTranscriptFS === 'function') {
      try {
        savedTranscript = await saveTranscriptFS({
          text: cleanText,
          audioFilename: sourceFilename || '',
          durationSec: modalState.recordingDurationSec,
          diarizationJobId: diarizationJobId || null,
        });
      } catch (err) {
        console.error('[recorder] saveTranscriptFS failed:', err);
        window.showToast?.('⚠️ 녹취록 자동 저장에 실패했습니다. 슬롯에는 추가됩니다.');
      }
    }

    // Step 2: cache the audio path for the upcoming note (Phase 3B-4).
    // We used to delete the original audio from Storage here, but the
    // cost-splitting flow ("친구랑 나누기") needs the source audio to copy
    // into the group bucket on demand. Now we just stash the path so the
    // next autoSaveNote can write it to the note doc; the audio is then
    // either copied + cleaned up by api/group-create, or eventually swept
    // by a Storage lifecycle rule (configured separately in Firebase
    // Console — see ops backlog).
    if (modalState.audioStoragePath) {
      window.recorderLastAudioPath = modalState.audioStoragePath;
      modalState.audioStoragePath = null;
    }

    // Clear STT elapsed interval now that we're done processing
    if (modalState.sttElapsedHandle) { clearInterval(modalState.sttElapsedHandle); modalState.sttElapsedHandle = null; }
    modalState.phase = 'completed';

    // Briefly advance stage tracker: stage 2 → done, stage 3 → active
    const _st2 = document.getElementById('recSttStage2');
    const _st3 = document.getElementById('recSttStage3');
    if (_st2) _st2.className = 'rec-stt-stage rec-stt-stage--done';
    if (_st3) _st3.className = 'rec-stt-stage rec-stt-stage--active';

    // Step 3: feed text into new-note slots (existing behavior)
    const baseName = (sourceFilename || 'recording').replace(/\.[^.]+$/, '');
    const file = new File([cleanText], baseName + '.txt', { type: 'text/plain' });
    if (savedTranscript?.id) file._transcriptId = savedTranscript.id; // U17: thread record id for post-analysis deixis save

    // Always keep a reference so the "다음" CTA can add it later if needed
    modalState.pendingFile = file;

    let didFillSlot = false;
    if (modalState.targetSlotId != null && typeof setRecSlotFile === 'function') {
      setRecSlotFile(modalState.targetSlotId, file);
      didFillSlot = true;
    } else {
      const emptySlot = (typeof txtFiles !== 'undefined') ? txtFiles.find(s => !s.file) : null;
      if (emptySlot && typeof setRecSlotFile === 'function') {
        setRecSlotFile(emptySlot.id, file);
        didFillSlot = true;
      } else if (typeof addRecSlot === 'function' && _currentView === 'new') {
        addRecSlot(file);
        didFillSlot = true;
      }
    }

    switchScreen('done');
    const status = document.getElementById('recDoneStatus');
    if (status) {
      const lenLabel   = `${cleanText.length.toLocaleString()}자`;
      const savedLabel = savedTranscript ? ' · 내 녹취록에 저장됨' : '';
      status.textContent = `변환 완료 · ${lenLabel}${savedLabel}`;
    }

    // Tailor done-screen hint and CTA based on whether the slot was filled
    const doneHint = document.getElementById('recDoneHint');
    const goNewBtn = document.getElementById('recDoneGoNewBtn');
    const closeBtn = document.getElementById('recDoneCloseBtn');
    if (didFillSlot && _currentView === 'new') {
      // User already on new-note view, slot populated → just confirm
      if (doneHint) doneHint.textContent = 'PPT/PDF를 추가하면 AI 노트 분석을 바로 시작할 수 있습니다.';
      if (goNewBtn) goNewBtn.style.display = 'none';
      if (closeBtn) { closeBtn.textContent = '확인'; closeBtn.className = 'rec-btn rec-btn-primary'; }
    } else {
      // User on home/transcripts or slot not filled → show navigation CTA
      if (doneHint) doneHint.textContent = '내 녹취록에 저장되었습니다. 새 노트에서 강의 자료와 함께 AI 분석을 시작해보세요.';
      if (goNewBtn) goNewBtn.style.display = '';
      if (closeBtn) { closeBtn.textContent = '닫기'; closeBtn.className = 'rec-btn rec-btn-secondary'; }
    }

    // Surface the modal if the user had hidden or minimized it during background processing
    if (modalEl && (modalEl.classList.contains('hidden') || modalEl.classList.contains('recorder-modal--minimized'))) {
      modalEl.classList.remove('hidden');
      modalEl.classList.remove('recorder-modal--minimized');
      modalEl.classList.remove('recorder-modal--stt');
      modalEl.classList.remove('recorder-modal--stt-long');
      const panelEl = modalEl.querySelector('.recorder-panel');
      if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; }
    }

    if (didFillSlot && savedTranscript) {
      window.showToast?.('🎙️ 녹취록이 슬롯에 추가되고 내 녹취록에도 저장되었습니다.');
    } else if (savedTranscript) {
      window.showToast?.('🎙️ 내 녹취록에 저장되었습니다. 새 노트에서 활용해보세요!');
    } else if (didFillSlot) {
      window.showToast?.('🎙️ 녹취록이 추가되었습니다.');
    }
  }

  // ── Public entry ────────────────────────────────────────
  window.openRecorderModal = function (targetSlotId) {
    showModal(targetSlotId);
  };

  // Q2: modalState is module-scoped — expose a getter so main_inline.js's
  // beforeunload handler can warn on unsaved recording/upload/STT work too.
  window.recorderIsActive = function () {
    return modalState.phase === 'recording' || modalState.phase === 'paused'
        || modalState.phase === 'uploading' || modalState.phase === 'transcribing';
  };
})();
