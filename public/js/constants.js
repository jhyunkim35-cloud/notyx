// Global constants, shared state, DOM refs, Firebase init.
// Loaded BEFORE the main inline script. Everything else depends on this.

// ===== Production console silence + breadcrumb capture =====
// In production the user should not see any developer logs in their
// DevTools console — it leaks internal state, looks noisy, and a couple
// of strings could theoretically read like bugs to a non-technical user.
//
// But we still need the logs available when triaging real bug reports.
// Strategy:
//   1. Keep a rolling in-memory buffer (last N entries). Exposed via
//      `window.getRecentLogs()` so the bug-report modal (Phase B) can
//      attach it to the Firestore feedback document.
//   2. Forward each call to Sentry as a breadcrumb so any error that
//      hits Sentry afterwards arrives with the last ~100 log lines
//      attached automatically.
//   3. In production, suppress the actual console output. Dev keeps
//      the noise so we can debug normally on localhost.
//
// `console.error` is left wrapped-but-still-printing because (a) Sentry
// auto-captures it as an event regardless, and (b) suppressing real
// browser/runtime errors entirely makes JS exceptions invisible even
// to us when we screenshare with a tester. Trade-off accepted.
(function () {
  const IS_PROD = location.hostname !== 'localhost'
                && !location.hostname.startsWith('127.')
                && !location.hostname.startsWith('192.168.');

  // Larger than the debugLog buffer below — captures ALL console.* calls,
  // not just debugLog ones. 300 is comfortable for a single user session
  // without bloating memory (each entry capped at 1000 chars).
  const BUFFER_MAX = 300;
  const buffer = [];

  function stringifyArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
    try { return JSON.stringify(a); } catch { return String(a); }
  }

  function pushBuffer(level, args) {
    const ts = ((performance.now()) / 1000).toFixed(1) + 's';
    const msg = args.map(stringifyArg).join(' ');
    const entry = `[${ts}][${level}] ${msg}`.slice(0, 1000);
    buffer.push(entry);
    if (buffer.length > BUFFER_MAX) buffer.shift();
    return entry;
  }

  function sendBreadcrumb(level, entry) {
    try {
      if (window.Sentry && typeof Sentry.addBreadcrumb === 'function') {
        Sentry.addBreadcrumb({
          category: 'console:' + level,
          level: level === 'warn' ? 'warning' : level === 'error' ? 'error' : 'info',
          message: entry.slice(0, 500),
        });
      }
    } catch (_) { /* never let logging break the app */ }
  }

  // Keep original references so we can restore visible output for ERROR
  // and so dev mode can keep emitting normally.
  const originals = {
    log:   console.log.bind(console),
    debug: console.debug.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  ['log', 'debug', 'info', 'warn', 'error'].forEach(level => {
    console[level] = function (...args) {
      const entry = pushBuffer(level, args);
      sendBreadcrumb(level, entry);
      if (!IS_PROD) {
        originals[level](...args);            // dev: same as before
      } else if (level === 'error') {
        originals.error(...args);             // prod: errors stay visible
      }
      // prod log/debug/info/warn → silent. Buffer + Sentry still get them.
    };
  });

  // Exposed for the bug-report modal (Phase B) to attach the last N lines
  // to a feedback document. Returns a snapshot copy so callers can't mutate
  // our buffer.
  window.getRecentLogs = function (n = BUFFER_MAX) {
    return buffer.slice(-n);
  };

  // Also expose env flag for code that wants to gate behaviour on prod
  // without re-doing the hostname check.
  window.__NOTYX_IS_PROD = IS_PROD;
})();

// ===== Firebase init =====
const firebaseConfig = {
  apiKey: "AIzaSyC68aMiCvyfR3QycxUknmxB3z7NS0qRE2g",
  authDomain: "lazyuniv-ai.firebaseapp.com",
  projectId: "lazyuniv-ai",
  storageBucket: "lazyuniv-ai.firebasestorage.app",
  messagingSenderId: "152431469306",
  appId: "1:152431469306:web:a7292a51bd41b31a229f43"
};
firebase.initializeApp(firebaseConfig);
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();
let currentUser = null;

// ===== PDF.js lazy-load slot =====
let pdfjsLib = null;

// ===== Debug logger =====
// Kept for backward compatibility — callers still pass a tag and structured
// data. Internally now just delegates to the wrapped console.log above,
// which handles the buffer + Sentry breadcrumb + prod-silence concerns.
// The _debugLog array stays for any code that introspects it directly.
const _debugLog = [];
function debugLog(tag, msg, data = null) {
  const ts = ((performance.now()) / 1000).toFixed(1) + 's';
  const entry = `[${ts}][${tag}] ${msg}` + (data != null ? ' | ' + (typeof data === 'string' ? data : (() => { try { return JSON.stringify(data); } catch { return String(data); } })()) : '');
  _debugLog.push(entry);
  if (_debugLog.length > 500) _debugLog.shift();
  console.log(entry);   // wrapped — silent in prod, captured to buffer + Sentry
}

// ===== Constants =====
const MAX_ITERATIONS        = 2;
const USE_ADVISOR = false;  // DISABLED: advisor never invoked, only adds latency
const MAX_FILE_SIZE_BYTES  = 200 * 1024 * 1024;  // 200MB hard limit
const WARN_FILE_SIZE_BYTES = 100 * 1024 * 1024;  // 100MB soft warning
const MAX_PDF_PAGES        = 200;                  // hard page count limit
const WARN_PDF_PAGES       = 100;                  // soft page count warning
const MAX_IMAGE_UPLOAD_COUNT = 30;                 // U8: standalone image upload page cap
const DEVELOPER_EMAILS = ['jhyun.kim35@gmail.com'];
const MAX_TOKENS_NOTES      = 24000;
const MAX_TOKENS_CRITIQUE   = 8192;
const DONE_SIGNAL           = '검토 완료 — 수정 필요 없음';
const TOAST_DURATION_MS     = 5000;
const PROGRESS_HIDE_DELAY_MS = 1200;  // used by setProgress(null)

const FOLDER_COLORS = [
  { name: '기본', value: 'var(--text-muted)' },
  { name: '빨강', value: '#ef4444' },
  { name: '주황', value: '#f97316' },
  { name: '노랑', value: '#eab308' },
  { name: '초록', value: '#22c55e' },
  { name: '파랑', value: '#3b82f6' },
  { name: '보라', value: '#8b5cf6' },
  { name: '분홍', value: '#ec4899' },
];

const REC_ORDINALS = ['1교시','2교시','3교시','4교시','5교시','6교시','7교시','8교시','9교시','10교시'];
const QUIZ_CHOICES_PREFIX = ['①', '②', '③', '④', '⑤'];
const CLASSIFY_LABELS = { theory: '이론', research: '연구', case: '사례', other: '기타' };
// Phase B: category badges are neutral now — CLASSIFY_LABELS ships the meaning
// as a word next to every badge, so hue was never carrying information here.
// (FOLDER_COLORS above stays chromatic: those are user-picked, persisted, and
// whitelist-validated in firestore_sync.js — changing the values would fail
// validation on folders users already coloured.)
const CLASSIFY_COLORS = { theory: 'var(--text)', research: 'var(--text-muted)', case: 'var(--text-muted)', other: 'var(--text-dim)' };
const DB_NAME    = 'meetingAppDB';
const DB_VERSION = 6;

const AGENT_META = {
  1: { icon: '📝', name: '노트 작성자' },
  2: { icon: '🔍', name: '비평가'      },
};

// ===== Mutable shared state =====
let pptFile  = null;
let imageFiles = [];  // U8: standalone image upload (photos of slides/handwritten notes), mutually exclusive with pptFile
let txtFiles = [];   // [{id, file}] — ordered slots for multi-recording
let recIdCounter   = 0;

let storedPptText              = '';
let storedFilteredText         = '';
let storedNotesText            = '';
let storedHighlightedTranscript = '';
let currentSummaryLayers       = null;  // R4: { tldr, bullets, paragraph, chapters } from synthesizeSummary, or null
let _draftSummary              = null;  // U10: { tldr, bullets } fast-draft summary — never persisted, cleared once currentSummaryLayers lands
let _verifiedSummaryDone       = false; // U10: true once the verified synthesizeSummary attempt (success or fail) has completed for this analysis
let _summarySynthNeeded        = false; // U11: set by agent1 paths; consumed by runAgentPipeline to run synth concurrently with critique∥highlight
let currentStudyTools = null;  // R8+R9: { mindmap: string|null, memorize: array|null, concepts: array|null }

let extractedImages    = [];   // [{slideNumber, imageBase64, mimeType, fileName}]
let recommendedSlides  = [];   // [slideNumber, ...]
let imageAnalysisMode  = 'text';   // 'text' = Mode 1 (free) | 'vision' = Mode 2 (paid)
let visionModel        = 'haiku';  // 'haiku' | 'sonnet'
let imageDescriptions  = {};       // slideNumber → description (Mode 2 only)

let isRunning      = false;      // double-click guard
let abortController = null;      // cancel support
let currentNoteId  = null;       // id of the note currently loaded
let _noteSaveInFlight = false;   // Q5: true while draftSaveNote()'s write is in flight — beforeunload guard
let _accordionOpenLabels = new Set();
let _noteDrag      = null;       // active pointer-drag state object
let _lastGenerationError = '';   // last pipeline error message for debug report
let _wakeLock = null;            // Screen Wake Lock sentinel held during generation
let _genWasHidden = false;       // set if tab/app was backgrounded mid-generation

let _classifyCache = null;       // { noteId, items } — cleared when different note loaded

let isBatchMode = false;
let batchQueue  = [];   // [{id, pptFile, txtFile, status}]
let batchIdCounter = 0;
let _batchRunning      = false;
let _batchProgress     = { done: 0, total: 0 };
let _batchBuddyVisible = false; // true while buddy should float over non-batch views
let batchPptStaging = null;
let batchSessionStaging = []; // [{id, txtFile, professorNum}]
let batchSessionIdCounter = 0;

let _currentNotionNoteId = null;
let _currentView = 'home';
let _activeFolderId = null; // null=all, 'none'=uncategorized, uuid=folder

// B1: per-analysis UUID, set in pipeline.js runAgentPipeline start, cleared
// in finally. api.js auto-injects this into every billable fetch body so
// the server can bill the analysis exactly once regardless of how many
// agent calls happen inside it. null when no pipeline is running.
let _currentAnalysisId = null;

let toastTimer;

let _bulkSelectMode = false;
const _selectedNoteIds = new Set();

let feedStartTime = null;
let elapsedTimer = null;
let elapsedStart = null;
let iterChipData = [];
let _notesCollapsed = false;
let progressHideTimer = null;

// ===== Cached DOM refs =====
// CAUTION: this file is loaded just before the main inline <script> in <body>,
// so all elements below are already parsed when these lines run.
const apiKeyEl   = document.getElementById('apiKey');
const analyzeBtn = document.getElementById('analyzeBtn');
const resultsEl  = document.getElementById('results');
const toast      = document.getElementById('toast');

const quizBtn         = document.getElementById('quizBtn');
const notionCopyBtn   = document.getElementById('notionCopyBtn');
const dlNotionFileBtn = document.getElementById('dlNotionFileBtn');
const copyNotesBtn    = document.getElementById('copyNotesBtn');
const dlTxtBtn        = document.getElementById('dlTxtBtn');
const dlMdBtn         = document.getElementById('dlMdBtn');
const dlPdfBtn        = document.getElementById('dlPdfBtn');
const splitViewBtn    = document.getElementById('splitViewBtn');

const progressWrap  = document.getElementById('progressWrap');
const progressFill  = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const progressPct   = document.getElementById('progressPct');

// ===== Helpers =====
/* Sleep that rejects immediately when the user clicks cancel.
   Plain setTimeout ignores AbortSignal, so a 429 retry wait of up to
   30 s would appear frozen after the user presses the cancel button. */
function abortableSleep(ms) {
  return new Promise((resolve, reject) => {
    if (abortController?.signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    abortController?.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function isMobileDevice() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

// ===== Screen Wake Lock (best-effort) =====
// A long note generation streams for minutes. On mobile, the screen auto-lock
// suspends the page and kills the in-flight streaming request — the note then
// silently stops (this is the iPad bug from the reports). Holding a screen
// Wake Lock keeps the page alive while the screen is on. It's auto-released
// when the tab is hidden, so the visibilitychange handler re-acquires it on
// return. Silently no-ops where the API is unavailable (older Safari, etc.).
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !_wakeLock) {
      _wakeLock = await navigator.wakeLock.request('screen');
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    }
  } catch (_) { /* unsupported or denied — best-effort, ignore */ }
}
function releaseWakeLock() {
  try { if (_wakeLock) { _wakeLock.release(); _wakeLock = null; } } catch (_) {}
}
