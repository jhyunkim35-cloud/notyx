// Exam plan registration: per-folder examDate / prepStartDate / dailyTarget.
//
// Why this exists:
//   Duolingo's "5 minutes a day forever" cadence doesn't fit cramming for a
//   uni exam — exams are a finite game with a deadline. So this layer lets
//   the user register an exam on any folder and pick how far in advance to
//   start reviewing. The window length determines a "mode" (cram / standard /
//   relaxed / long) that downstream features (the SRS scheduler, the home
//   "today" recommendation, mastery decay) consult to decide pacing.
//
// Storage:
//   We store the plan as a nested `examPlan` object on the existing folder
//   document at users/{uid}/folders/{id}.examPlan. saveFolderFS already does
//   { merge: true }, so partial updates leave the rest of the folder intact.
//
// Schema:
//   examPlan: {
//     examDate:         'YYYY-MM-DD'  (the test day, local)
//     prepStartDate:    'YYYY-MM-DD'  (when daily review begins; default
//                                      examDate - 21 days)
//     prepMode:         'cram' | 'standard' | 'relaxed' | 'long'
//     dailyTargetMode:  'auto' | 'custom'
//     dailyTargetCount: number | null   (null → derive from auto recommendation
//                                        each render, so adding notes auto-bumps)
//     createdAt, updatedAt
//   }
//
// Public API (window globals consumed elsewhere):
//   - setFolderExamPlan(folderId, plan)
//   - clearFolderExamPlan(folderId)
//   - openExamPlanModal(folderId)              // opens the registration UI
//   - getDaysUntil(yyyymmdd)                    // negative if past
//   - computeExamPlanMode(windowDays)
//   - recommendedDailyTarget(notesCount, windowDays, mode)
//   - examPlanBadgeHtml(plan, notesCount)       // small "D-N · 매일 N개" label
//
// Depends on: constants.js (db, currentUser, FOLDER_COLORS), firestore_sync.js
//   (saveFolderFS), home_view.js (renderHomeView for refresh), ui.js (showToast).

(function () {

  // ── Date helpers ──────────────────────────────────────────────
  // We use 'YYYY-MM-DD' strings rather than ISO timestamps because exam
  // dates are calendar days, not instants — comparing across timezones is
  // simpler when day is the unit.
  function todayStr() {
    const d = new Date();
    return formatDate(d);
  }
  function formatDate(d) {
    return d.getFullYear() + '-'
         + String(d.getMonth() + 1).padStart(2, '0') + '-'
         + String(d.getDate()).padStart(2, '0');
  }
  function parseDate(s) {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d); // local-time midnight
  }
  function addDays(yyyymmdd, n) {
    const d = parseDate(yyyymmdd);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return formatDate(d);
  }
  // Days from today to target. Negative = past.
  function daysBetween(fromYmd, toYmd) {
    const a = parseDate(fromYmd), b = parseDate(toYmd);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }
  function getDaysUntil(yyyymmdd) {
    return daysBetween(todayStr(), yyyymmdd);
  }

  // ── Mode + daily target recommendation ────────────────────────
  // The thresholds encode the conversation we had upfront: <=7d means
  // cramming (no spacing benefit, just one pass per day with weak-first
  // ordering), 8-14d still tight, 15-28d is the sweet spot for spaced
  // repetition, >28d is long-form. The 21-day default sits in the
  // "relaxed" band on purpose — that's where the SRS algorithm earns its
  // keep without feeling either pointless (too short) or sluggish (too
  // long).
  function computeExamPlanMode(windowDays) {
    if (windowDays == null || windowDays <= 0) return 'cram';
    if (windowDays <= 7)  return 'cram';
    if (windowDays <= 14) return 'standard';
    if (windowDays <= 28) return 'relaxed';
    return 'long';
  }

  // Returns HTML — callers always splice this into innerHTML, never as
  // textContent. The Mutation observer in icons.js will mount the SVG.
  function modeLabel(mode) {
    const map = {
      cram:     { icon: 'zap',      label: '벼락치기' },
      standard: { icon: 'target',   label: '표준' },
      relaxed:  { icon: 'calendar', label: '여유' },
      long:     { icon: 'sprout',   label: '장기' },
    };
    const m = map[mode];
    if (!m) return mode;
    return `<i data-lucide="${m.icon}" class="icon-sm"></i><span>${m.label}</span>`;
  }

  function modeDescription(mode) {
    return ({
      cram:     '시험까지 1주 이내 — 시간 부족, 매일 1바퀴 + 약점 우선',
      standard: '시험까지 2주 — 충분히 나눠서, 시험 직전 한 바퀴',
      relaxed:  '시험까지 3-4주 — 간격 반복 효과 최대화, 추천 모드',
      long:     '시험까지 4주 이상 — 천천히 익히고 시험 임박 시 자동 강화',
    })[mode] || '';
  }

  // Pass count = how many times each note should be reviewed across the
  // window on average. Cram crams (1x), standard goes a bit over (1.5x),
  // relaxed actually leverages spacing (2x), long is throttled because
  // SRS will naturally space things out anyway.
  function passesForMode(mode) {
    return ({ cram: 1.0, standard: 1.5, relaxed: 2.0, long: 1.5 })[mode] || 1.5;
  }

  function recommendedDailyTarget(notesCount, windowDays, mode) {
    if (!notesCount || !windowDays || windowDays <= 0) return 1;
    const passes = passesForMode(mode);
    const total  = notesCount * passes;
    const perDay = Math.ceil(total / windowDays);
    return Math.max(1, perDay);
  }

  // ── Storage layer ─────────────────────────────────────────────
  async function setFolderExamPlan(folderId, plan) {
    if (!folderId || !plan) return null;
    if (typeof userFoldersRef !== 'function') return null;
    const ref = userFoldersRef();
    if (!ref) return null;

    const now = new Date().toISOString();
    const doc = await ref.doc(folderId).get();
    if (!doc.exists) return null;
    const folder = doc.data();
    const existingPlan = folder.examPlan || {};

    const merged = {
      examDate:         plan.examDate,
      prepStartDate:    plan.prepStartDate,
      prepMode:         plan.prepMode || computeExamPlanMode(
        daysBetween(plan.prepStartDate, plan.examDate) + 1
      ),
      dailyTargetMode:  plan.dailyTargetMode || 'auto',
      dailyTargetCount: typeof plan.dailyTargetCount === 'number'
                        ? plan.dailyTargetCount
                        : null,
      createdAt: existingPlan.createdAt || now,
      updatedAt: now,
    };

    await ref.doc(folderId).set({ examPlan: merged }, { merge: true });

    // Mirror to IndexedDB so renderHomeView (which reads via getAllFoldersFS,
    // which falls back to IDB on Firestore failure) stays consistent.
    try {
      const updatedFolder = Object.assign({}, folder, { examPlan: merged });
      if (typeof saveFolder === 'function') await saveFolder(updatedFolder);
    } catch {}

    return merged;
  }

  async function clearFolderExamPlan(folderId) {
    if (!folderId) return;
    if (typeof userFoldersRef !== 'function') return;
    const ref = userFoldersRef();
    if (!ref) return;

    // Firestore doesn't have an "unset field" sentinel via merge, so we use
    // FieldValue.delete() explicitly.
    try {
      await ref.doc(folderId).update({
        examPlan: firebase.firestore.FieldValue.delete(),
      });
    } catch (e) {
      console.warn('[clearFolderExamPlan] firestore failed:', e.message);
    }

    // Mirror to IDB
    try {
      const doc = await ref.doc(folderId).get();
      if (doc.exists && typeof saveFolder === 'function') {
        const f = doc.data();
        delete f.examPlan;
        await saveFolder(f);
      }
    } catch {}
  }

  // ── Render-side helpers ───────────────────────────────────────
  // Small badge string (HTML-safe) for inline display next to a folder
  // name. Returns '' when there's no plan so callers can `+= ` blindly.
  function examPlanBadgeHtml(plan, notesCount) {
    if (!plan || !plan.examDate) return '';
    const d = getDaysUntil(plan.examDate);
    if (d == null) return '';

    let label;
    if (d < 0) label = `D+${-d} (시험 종료)`;
    else if (d === 0) label = 'D-Day';
    else label = `D-${d}`;

    // Class drives color: red <=7, orange <=14, green otherwise, gray after
    let cls = 'exam-badge-green';
    if (d < 0) cls = 'exam-badge-gray';
    else if (d <= 7) cls = 'exam-badge-red';
    else if (d <= 14) cls = 'exam-badge-orange';

    return `<span class="exam-badge ${cls}" title="시험: ${plan.examDate}"><i data-lucide="calendar" class="icon-xs"></i>${label}</span>`;
  }

  // Resolved daily target for a folder's plan against its current note count.
  // 'auto' returns the recommendation, 'custom' returns the saved number.
  function effectiveDailyTarget(plan, notesCount) {
    if (!plan) return 0;
    if (plan.dailyTargetMode === 'custom' && typeof plan.dailyTargetCount === 'number') {
      return plan.dailyTargetCount;
    }
    const start = plan.prepStartDate;
    const end   = plan.examDate;
    const window = daysBetween(start, end) + 1; // inclusive
    return recommendedDailyTarget(notesCount, window, plan.prepMode);
  }

  // ── Modal singleton (lazy-built) ──────────────────────────────
  let _modalEl = null;
  let _modalCtx = null; // { folderId, notesCount, plan }

  function ensureModal() {
    if (_modalEl) return _modalEl;
    _modalEl = document.createElement('div');
    _modalEl.id = 'examPlanModal';
    _modalEl.className = 'exam-plan-modal hidden';
    _modalEl.innerHTML = `
      <div class="exam-plan-backdrop"></div>
      <div class="exam-plan-panel" role="dialog" aria-modal="true">
        <header class="exam-plan-head">
          <div>
            <div class="exam-plan-title" id="examPlanTitle">시험 등록</div>
            <div class="exam-plan-sub" id="examPlanSub">폴더 이름</div>
          </div>
          <button id="examPlanCloseBtn" class="exam-plan-close" aria-label="닫기">×</button>
        </header>

        <div class="exam-plan-body">
          <div class="exam-plan-field">
            <label for="examPlanDateInput"><i data-lucide="calendar" class="icon-sm"></i><span>시험일</span></label>
            <input type="date" id="examPlanDateInput" />
          </div>

          <div class="exam-plan-field">
            <label for="examPlanStartInput"><i data-lucide="play" class="icon-sm"></i><span>복습 시작일</span>
              <span class="exam-plan-hint">(추천: 시험 21일 전)</span>
            </label>
            <input type="date" id="examPlanStartInput" />
          </div>

          <div class="exam-plan-preview" id="examPlanPreview">
            <!-- filled dynamically -->
          </div>

          <div class="exam-plan-field">
            <label><i data-lucide="target" class="icon-sm"></i><span>매일 목표 노트 수</span></label>
            <div class="exam-plan-target-modes">
              <label class="exam-plan-radio">
                <input type="radio" name="examPlanTargetMode" value="auto" checked />
                <span>자동 (<span id="examPlanRecommendedTarget">-</span>개 권장)</span>
              </label>
              <label class="exam-plan-radio">
                <input type="radio" name="examPlanTargetMode" value="custom" />
                <span>직접 입력</span>
                <input type="number" id="examPlanCustomTarget" min="1" max="50" value="2" disabled />
                <span style="color:var(--text-muted); font-size:0.78rem;">개</span>
              </label>
            </div>
          </div>
        </div>

        <footer class="exam-plan-footer">
          <button id="examPlanDeleteBtn" class="ny-btn ny-btn-danger" style="display:none;">시험 등록 해제</button>
          <div style="flex:1"></div>
          <button id="examPlanCancelBtn" class="ny-btn ny-btn-secondary">취소</button>
          <button id="examPlanSaveBtn" class="ny-btn ny-btn-primary">등록</button>
        </footer>
      </div>
    `;
    document.body.appendChild(_modalEl);

    _modalEl.querySelector('#examPlanCloseBtn').addEventListener('click', closeModal);
    _modalEl.querySelector('#examPlanCancelBtn').addEventListener('click', closeModal);
    _modalEl.querySelector('.exam-plan-backdrop').addEventListener('click', closeModal);
    _modalEl.querySelector('#examPlanSaveBtn').addEventListener('click', onSave);
    _modalEl.querySelector('#examPlanDeleteBtn').addEventListener('click', onDelete);

    // Reflow the preview whenever any input changes — gives instant feedback.
    ['examPlanDateInput', 'examPlanStartInput', 'examPlanCustomTarget'].forEach(id => {
      _modalEl.querySelector('#' + id).addEventListener('input', refreshPreview);
    });
    _modalEl.querySelectorAll('input[name="examPlanTargetMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const isCustom = _modalEl.querySelector('input[name="examPlanTargetMode"]:checked').value === 'custom';
        _modalEl.querySelector('#examPlanCustomTarget').disabled = !isCustom;
        refreshPreview();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !_modalEl.classList.contains('hidden')) closeModal();
    });

    return _modalEl;
  }

  function closeModal() {
    if (_modalEl) _modalEl.classList.add('hidden');
    _modalCtx = null;
  }

  async function openExamPlanModal(folderId) {
    if (!folderId) return;

    // Need folder + note count. Pull folders + notes once and find ours.
    const [folders, notes] = await Promise.all([
      typeof getAllFoldersFS === 'function' ? getAllFoldersFS() : Promise.resolve([]),
      typeof getAllNotesFS   === 'function' ? getAllNotesFS()   : Promise.resolve([]),
    ]);
    const folder = folders.find(f => f.id === folderId);
    if (!folder) {
      window.showToast?.('폴더를 찾을 수 없습니다.');
      return;
    }
    const notesCount = notes.filter(n => n.folderId === folderId).length;

    ensureModal();
    _modalCtx = { folderId, notesCount, plan: folder.examPlan || null };

    const isEdit = !!folder.examPlan;
    const titleEl  = document.getElementById('examPlanTitle');
    const subEl    = document.getElementById('examPlanSub');
    const dateEl   = document.getElementById('examPlanDateInput');
    const startEl  = document.getElementById('examPlanStartInput');
    const customEl = document.getElementById('examPlanCustomTarget');
    const deleteBtn = document.getElementById('examPlanDeleteBtn');
    const saveBtn   = document.getElementById('examPlanSaveBtn');

    titleEl.textContent = isEdit ? '시험 일정 수정' : '시험 등록';
    // Folder name: prefer escHtml from markdown.js. Cheap safety guard for
    // the (unlikely) load-order race where this fires before markdown.js
    // is parsed.
    const safeName = (typeof escHtml === 'function') ? escHtml(folder.name) : folder.name;
    subEl.innerHTML = `<i data-lucide="folder" class="icon-xs"></i><span>${safeName} · 노트 ${notesCount}개</span>`;
    deleteBtn.style.display = isEdit ? '' : 'none';
    saveBtn.textContent = isEdit ? '저장' : '등록';

    // Pre-fill defaults
    if (isEdit) {
      const p = folder.examPlan;
      dateEl.value  = p.examDate || '';
      startEl.value = p.prepStartDate || '';
      const targetMode = p.dailyTargetMode || 'auto';
      _modalEl.querySelector(`input[name="examPlanTargetMode"][value="${targetMode}"]`).checked = true;
      customEl.value = (typeof p.dailyTargetCount === 'number' ? p.dailyTargetCount : 2);
      customEl.disabled = (targetMode !== 'custom');
    } else {
      // Default: exam in 21 days, prep starts today.
      // (Users almost always click "register exam" *now*, so the 21-day
      // window default lands the start at today rather than awkwardly in
      // the past. They override the exam date freely.)
      const defaultExam  = addDays(todayStr(), 21);
      const defaultStart = todayStr();
      dateEl.value  = defaultExam;
      startEl.value = defaultStart;
      _modalEl.querySelector('input[name="examPlanTargetMode"][value="auto"]').checked = true;
      customEl.disabled = true;
    }

    refreshPreview();
    _modalEl.classList.remove('hidden');
  }

  function refreshPreview() {
    if (!_modalCtx) return;
    const dateEl   = document.getElementById('examPlanDateInput');
    const startEl  = document.getElementById('examPlanStartInput');
    const customEl = document.getElementById('examPlanCustomTarget');
    const recEl    = document.getElementById('examPlanRecommendedTarget');
    const previewEl = document.getElementById('examPlanPreview');

    const examDate  = dateEl.value;
    const startDate = startEl.value;
    const notesCount = _modalCtx.notesCount;

    if (!examDate || !startDate) {
      previewEl.innerHTML = '<div class="exam-plan-preview-placeholder">날짜를 선택하면 추천 계획이 표시됩니다.</div>';
      recEl.textContent = '-';
      return;
    }

    const windowDays = (daysBetween(startDate, examDate) || 0) + 1;
    if (windowDays <= 0) {
      previewEl.innerHTML = '<div class="exam-plan-preview-warn"><i data-lucide="alert-triangle" class="icon-sm"></i><span>복습 시작일이 시험일보다 늦습니다.</span></div>';
      recEl.textContent = '-';
      return;
    }

    const mode = computeExamPlanMode(windowDays);
    const recommended = recommendedDailyTarget(notesCount, windowDays, mode);
    recEl.textContent = recommended;

    // Update the custom input default to track the recommendation when
    // it's still in default-ish territory (don't overwrite if user typed
    // something).
    if (customEl.disabled || customEl.value === '' || Number(customEl.value) <= 0) {
      customEl.value = recommended;
    }

    const targetMode = _modalEl.querySelector('input[name="examPlanTargetMode"]:checked').value;
    const effectiveTarget = targetMode === 'custom'
      ? Math.max(1, Number(customEl.value) || recommended)
      : recommended;

    const totalReviews = effectiveTarget * windowDays;
    const passesShown  = notesCount > 0 ? (totalReviews / notesCount).toFixed(1) : '?';

    let warn = '';
    if (windowDays <= 7) {
      warn = `<div class="exam-plan-preview-warn"><i data-lucide="alert-triangle" class="icon-sm"></i><span>1주일 이내 — 벼락치기 모드. 가능하면 시작일을 더 앞당기세요.</span></div>`;
    } else if (notesCount === 0) {
      warn = `<div class="exam-plan-preview-warn"><i data-lucide="info" class="icon-sm"></i><span>이 폴더에 노트가 없습니다. 먼저 노트를 추가하면 권장값이 정확해집니다.</span></div>`;
    }

    previewEl.innerHTML = `
      <div class="exam-plan-mode-row">
        <div class="exam-plan-mode-label">${modeLabel(mode)}</div>
        <div class="exam-plan-mode-desc">${modeDescription(mode)}</div>
      </div>
      <div class="exam-plan-stats">
        <div class="exam-plan-stat">
          <div class="exam-plan-stat-num">${windowDays}</div>
          <div class="exam-plan-stat-label">일</div>
        </div>
        <div class="exam-plan-stat">
          <div class="exam-plan-stat-num">${notesCount}</div>
          <div class="exam-plan-stat-label">노트</div>
        </div>
        <div class="exam-plan-stat">
          <div class="exam-plan-stat-num">${effectiveTarget}</div>
          <div class="exam-plan-stat-label">매일 목표</div>
        </div>
        <div class="exam-plan-stat">
          <div class="exam-plan-stat-num">~${passesShown}회</div>
          <div class="exam-plan-stat-label">노트당 평균</div>
        </div>
      </div>
      ${warn}
    `;
  }

  async function onSave() {
    if (!_modalCtx) return;
    const dateEl   = document.getElementById('examPlanDateInput');
    const startEl  = document.getElementById('examPlanStartInput');
    const customEl = document.getElementById('examPlanCustomTarget');
    const targetMode = _modalEl.querySelector('input[name="examPlanTargetMode"]:checked').value;

    const examDate  = dateEl.value;
    const startDate = startEl.value;
    if (!examDate || !startDate) {
      window.showToast?.('시험일과 시작일을 모두 입력하세요.');
      return;
    }
    const windowDays = (daysBetween(startDate, examDate) || 0) + 1;
    if (windowDays <= 0) {
      window.showToast?.('시작일이 시험일보다 늦습니다.');
      return;
    }
    const mode = computeExamPlanMode(windowDays);
    const customCount = targetMode === 'custom'
      ? Math.max(1, Math.min(50, Number(customEl.value) || 1))
      : null;

    const plan = {
      examDate,
      prepStartDate: startDate,
      prepMode: mode,
      dailyTargetMode: targetMode,
      dailyTargetCount: customCount,
    };

    const saveBtn = document.getElementById('examPlanSaveBtn');
    saveBtn.disabled = true;
    try {
      await setFolderExamPlan(_modalCtx.folderId, plan);
      window.showToast?.('🎓 시험 일정이 등록되었습니다.');
      closeModal();
      if (typeof renderHomeView === 'function') renderHomeView();
    } catch (e) {
      console.error('[examPlan save] failed:', e);
      window.showToast?.('❌ 저장에 실패했습니다.');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function onDelete() {
    if (!_modalCtx) return;
    if (!await appConfirm('이 폴더의 시험 등록을 해제하시겠습니까?', { danger: true })) return;
    try {
      await clearFolderExamPlan(_modalCtx.folderId);
      window.showToast?.('🗑 시험 등록이 해제되었습니다.');
      closeModal();
      if (typeof renderHomeView === 'function') renderHomeView();
    } catch (e) {
      console.error('[examPlan delete] failed:', e);
      window.showToast?.('❌ 해제에 실패했습니다.');
    }
  }

  // ── Public API ────────────────────────────────────────────────
  window.setFolderExamPlan      = setFolderExamPlan;
  window.clearFolderExamPlan    = clearFolderExamPlan;
  window.openExamPlanModal      = openExamPlanModal;
  window.getDaysUntil           = getDaysUntil;
  window.computeExamPlanMode    = computeExamPlanMode;
  window.recommendedDailyTarget = recommendedDailyTarget;
  window.examPlanBadgeHtml      = examPlanBadgeHtml;
  window.effectiveDailyTarget   = effectiveDailyTarget;
  window.modeLabel              = modeLabel;

})();
