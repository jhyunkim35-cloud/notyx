// Bug report modal — sidebar entry point + Firestore submission.
//
// What goes in:
//   - User-typed message (required, capped at 2000 chars by rules)
//   - Optional user-supplied email (defaults to currentUser.email)
//   - Recent console log buffer from window.getRecentLogs() (Phase A)
//   - Page context (URL, currentNoteId, _activeFolderId, cache version)
//   - Browser context (userAgent, viewport, language, timezone offset)
//   - Auth (userId from firebase.auth().currentUser.uid)
//
// What does NOT go in:
//   - Note content / transcript text / quiz questions — even if the bug
//     happens during note rendering, the message field is the right place
//     for the user to paste a snippet if needed. We never silently grab
//     storedNotesText. Privacy-first.
//   - Firebase ID tokens, payment keys, anything else that could become
//     an account-takeover vector if the Firestore doc leaks.
//
// Storage: top-level `bugReports/{autoId}` Firestore collection. Rules:
//   - create allowed for any authenticated user (with userId == auth.uid)
//   - read/update/delete forbidden client-side; only Admin SDK or the
//     Firestore console (developer) can read them.

(function () {
  'use strict';

  function $(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function toast(msg, kind = 'info') {
    if (kind === 'success' && typeof showSuccessToast === 'function') return showSuccessToast(msg);
    if (typeof showToast === 'function') return showToast(msg);
  }

  // Idempotent style injection so the modal looks native to the rest of
  // the app without polluting global.css.
  function ensureStyles() {
    if (document.getElementById('bug-report-styles')) return;
    const css = `
      .br-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; padding: 16px;
      }
      .br-modal {
        background: var(--surface, #fff); border-radius: 14px;
        max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto;
        padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.18);
      }
      .br-modal h2 { margin: 0 0 4px; font-size: 17px; font-weight: 700; color: var(--text, #0f172a); }
      .br-subtitle { margin: 0 0 18px; font-size: 12.5px; color: var(--text-muted, #64748b); line-height: 1.5; }
      .br-field { margin-bottom: 12px; }
      .br-field label { display: block; font-size: 12px; font-weight: 600; color: var(--text, #0f172a); margin-bottom: 5px; }
      .br-field textarea, .br-field input {
        width: 100%; padding: 9px 11px; border: 1px solid var(--border, #e2e8f0);
        border-radius: 7px; font-size: 13.5px; box-sizing: border-box;
        background: var(--surface, #fff); color: var(--text, #0f172a);
        font-family: inherit;
      }
      .br-field textarea { min-height: 110px; resize: vertical; }
      .br-field textarea:focus, .br-field input:focus {
        outline: none; border-color: var(--primary);
        box-shadow: 0 0 0 3px var(--primary-dim);
      }
      .br-hint { font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 4px; line-height: 1.4; }
      .br-attach {
        margin: 12px 0 14px; padding: 10px 12px; border-radius: 8px;
        background: var(--surface2, #f8fafc); border: 1px solid var(--border, #e2e8f0);
        font-size: 12px; color: var(--text-muted, #64748b); line-height: 1.5;
      }
      .br-attach-label { display: flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 600; color: var(--text, #0f172a); margin-bottom: 4px; }
      .br-attach-label input { margin: 0; }
      .br-actions { display: flex; gap: 8px; margin-top: 16px; }
      .br-btn {
        flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 13.5px;
        font-weight: 600; cursor: pointer; border: none;
      }
      .br-btn-primary { background: var(--primary); color: var(--bg); }
      .br-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
      .br-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .br-btn-secondary { background: transparent; color: var(--text, #0f172a); border: 1px solid var(--border, #e2e8f0); }
      .br-btn-secondary:hover { background: var(--surface2, #f8fafc); }

      /* Sidebar trigger — sits between the user-info block and the storage
         indicator. Subtle by default so we don't distract from the main
         folder list, but with enough visual weight that a frustrated user
         can find it without thinking. */
      .br-sidebar-btn {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 8px; margin: 4px 0 6px;
        background: transparent; border: 1px dashed var(--border, #e2e8f0);
        border-radius: 6px; cursor: pointer; width: 100%;
        font-size: 11.5px; color: var(--text-muted, #64748b);
        transition: all 0.15s;
      }
      .br-sidebar-btn:hover {
        border-color: var(--primary); border-style: solid;
        color: var(--primary); background: var(--primary-dim);
      }
    `;
    const style = document.createElement('style');
    style.id = 'bug-report-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function openBugReportModal() {
    ensureStyles();

    const user = (typeof firebase !== 'undefined' && firebase.auth)
      ? firebase.auth().currentUser : null;

    const messageInput = $('textarea', {
      placeholder: '예: 퀴즈 풀다가 다음 버튼이 안 보였어요 / 노트 저장이 안 됐어요 / 어떤 화면에서 어떤 행동을 했는지 적어주시면 도움이 돼요',
      maxlength: 2000,
    });
    const emailInput = $('input', {
      type: 'email',
      placeholder: 'you@example.com',
      value: user?.email || '',
      maxlength: 200,
    });
    const attachCheckbox = $('input', { type: 'checkbox', checked: 'checked' });
    const submitBtn = $('button', { class: 'br-btn br-btn-primary' }, '제출');
    const cancelBtn = $('button', { class: 'br-btn br-btn-secondary' }, '취소');

    const overlay = $('div', { class: 'br-overlay' });
    const modal = $('div', { class: 'br-modal' });
    overlay.appendChild(modal);
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    submitBtn.addEventListener('click', async () => {
      const message = messageInput.value.trim();
      const email = emailInput.value.trim() || null;
      const attachLogs = attachCheckbox.checked;

      if (!message) { toast('어떤 문제인지 적어주세요'); return; }
      if (!user) { toast('로그인이 필요합니다'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = '제출 중...';

      // Collect context. Anything wrapped in try/catch — never let a missing
      // global crash the submit.
      let recentLogs = [];
      if (attachLogs) {
        try {
          if (typeof window.getRecentLogs === 'function') {
            recentLogs = window.getRecentLogs(200);
          }
        } catch (_) {}
      }

      let activeFolderId = null;
      try { activeFolderId = (typeof _activeFolderId !== 'undefined') ? _activeFolderId : null; } catch (_) {}
      let noteId = null;
      try { noteId = (typeof currentNoteId !== 'undefined') ? currentNoteId : null; } catch (_) {}
      let cacheVersion = null;
      try {
        cacheVersion = document.querySelector('script[src*="constants.js"]')?.src.match(/v=([^&]+)/)?.[1] || null;
      } catch (_) {}

      // Try to capture a Sentry event so a bug-report doc and a Sentry
      // event can be cross-referenced later. captureMessage returns a
      // string event id when Sentry is fully loaded.
      let sentryEventId = null;
      try {
        if (window.Sentry && typeof Sentry.captureMessage === 'function') {
          sentryEventId = Sentry.captureMessage('[user bug report] ' + message.slice(0, 140), {
            level: 'info',
            tags: { source: 'bug_report_modal' },
          }) || null;
        }
      } catch (_) {}

      const payload = {
        source: 'manual',
        userId: user.uid,
        userDisplayName: user.displayName || null,
        email,
        message: message.slice(0, 2000),
        attachedLogs: attachLogs && recentLogs.length > 0,
        recentLogs: attachLogs ? recentLogs : null,
        url: location.href,
        userAgent: (navigator.userAgent || '').slice(0, 500),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        language: navigator.language || null,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        currentNoteId: noteId,
        activeFolderId,
        cacheVersion,
        sentryEventId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      try {
        await firebase.firestore().collection('bugReports').add(payload);
        // Replace modal contents with a tiny thank-you and let the user
        // close it themselves — abruptly disappearing is jarring.
        modal.replaceChildren();
        modal.appendChild($('h2', {}, '✅ 신고가 접수됐어요'));
        modal.appendChild($('p', { class: 'br-subtitle' },
          '확인해보고 빠르게 고칠게요. 시간 내서 보내주셔서 고마워요.'));
        const closeBtn = $('button', {
          class: 'br-btn br-btn-primary', style: 'width:100%',
          onclick: () => overlay.remove(),
        }, '닫기');
        modal.appendChild(closeBtn);
        toast('버그 신고가 접수됐어요', 'success');
      } catch (e) {
        // Use the original (un-wrapped) console.error for our own logging
        // — wrapping is fine here, the error already bypasses prod silence.
        console.error('[bug_report] submit failed', e);
        toast('제출 실패: ' + (e?.message || 'unknown') + ' — 잠시 후 다시 시도해주세요');
        submitBtn.disabled = false;
        submitBtn.textContent = '제출';
      }
    });

    modal.appendChild($('h2', {}, '🐛 버그 신고 · 의견 보내기'));
    modal.appendChild($('p', { class: 'br-subtitle' },
      '어떤 화면에서 어떤 일이 일어났는지 알려주시면 큰 도움이 돼요. ' +
      '디버그 로그(클릭한 버튼, 발생한 오류 등)도 함께 보내주시면 더 빠르게 고칠 수 있어요.'));

    const msgField = $('div', { class: 'br-field' });
    msgField.appendChild($('label', {}, '무슨 일이 있었나요? (필수)'));
    msgField.appendChild(messageInput);
    msgField.appendChild($('div', { class: 'br-hint' },
      '최대 2000자 · 노트 내용은 자동 첨부되지 않아요 (필요하면 직접 붙여넣어 주세요)'));
    modal.appendChild(msgField);

    const emailField = $('div', { class: 'br-field' });
    emailField.appendChild($('label', {}, '답변받을 이메일 (선택)'));
    emailField.appendChild(emailInput);
    emailField.appendChild($('div', { class: 'br-hint' },
      '비워두셔도 괜찮아요 — 로그인 이메일이 자동으로 들어가 있어요'));
    modal.appendChild(emailField);

    const attachWrap = $('div', { class: 'br-attach' });
    const attachLabel = $('label', { class: 'br-attach-label' });
    attachLabel.appendChild(attachCheckbox);
    attachLabel.appendChild(document.createTextNode('디버그 로그 함께 보내기 (권장)'));
    attachWrap.appendChild(attachLabel);
    attachWrap.appendChild($('div', {},
      '최근 200개의 내부 로그(어떤 버튼을 눌렀는지, 어떤 화면 전환이 있었는지 등). ' +
      '노트 본문·녹취록 내용은 절대 포함되지 않아요. 끄셔도 신고는 정상 접수됩니다.'));
    modal.appendChild(attachWrap);

    const actions = $('div', { class: 'br-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
    setTimeout(() => messageInput.focus(), 50);
  }

  // Inject the sidebar trigger button as soon as the storage indicator
  // exists. Some early page loads call this before #sidebarStorageSize is
  // in the DOM (it's near the bottom of index.html), so we retry briefly.
  function injectSidebarButton() {
    if (document.getElementById('bugReportSidebarBtn')) return true;
    const userInfo = document.getElementById('sidebarUserInfo');
    if (!userInfo) return false;

    ensureStyles();
    const btn = document.createElement('button');
    btn.id = 'bugReportSidebarBtn';
    btn.className = 'br-sidebar-btn';
    btn.type = 'button';
    btn.innerHTML = '<span aria-hidden="true">🐛</span><span>버그 신고 · 의견 보내기</span>';
    btn.addEventListener('click', openBugReportModal);

    // Insert directly after the userInfo block, before the storage indicator.
    userInfo.insertAdjacentElement('afterend', btn);
    return true;
  }

  function init() {
    if (injectSidebarButton()) return;
    // Retry up to a couple of seconds in case the sidebar renders late.
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (injectSidebarButton() || attempts > 20) clearInterval(timer);
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Expose for programmatic access (e.g. an error boundary could trigger
  // the modal with a pre-filled message).
  window.openBugReportModal = openBugReportModal;
})();
