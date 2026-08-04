// Study rooms — UI module (Phase 4).
// Same-lecture peers share study time + progress only. Note CONTENT is
// never surfaced here; the only fields rendered from members docs are:
//   displayName, photoURL, joinedAt, studyMinutes, notesCount,
//   progressPct, lastActiveAt
// — the privacy contract of the feature. Anything else on a member doc
// is ignored even if the rules would let us read it.
//
// Depends on: firebase auth + firestore (loaded earlier in index.html),
// ui.js (showToast / showSuccessToast).
// Backend: POST /api/room-create, POST /api/room-join.
//
// Flow:
//   - Sidebar "📚 스터디 룸" → openStudyRoomEntryModal (choice: 만들기 / 합류)
//   - "만들기" → openStudyRoomCreateModal → POST /api/room-create → 페이지로
//   - "합류" → openStudyRoomJoinModal (token OR school+lecture code)
//   - ?roomJoin=<token> in URL → main.js calls openStudyRoomJoinModal({token})
//   - ?studyRoom=<rid> in URL → main.js calls openStudyRoomPage({roomId})

(function () {
  'use strict';

  // ── DOM helpers (no innerHTML interpolation of untrusted data) ────────────
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
    console.log('[study_rooms]', msg);
  }

  async function getIdToken() {
    try {
      const u = firebase.auth().currentUser;
      if (!u) return null;
      return await u.getIdToken();
    } catch (e) {
      console.error('[study_rooms] getIdToken failed', e);
      return null;
    }
  }

  // ── Style injection (scoped, idempotent) ──────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('study-rooms-styles')) return;
    const css = `
      .sr-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 16px;
      }
      .sr-modal {
        background: var(--surface, #fff); border-radius: 16px;
        max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto;
        padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      }
      .sr-modal h2 {
        margin: 0 0 4px; font-size: 18px; font-weight: 700;
        color: var(--text, #0f172a);
      }
      .sr-modal .sr-subtitle {
        margin: 0 0 20px; font-size: 13px; color: var(--text-muted, #64748b);
      }
      .sr-field { margin-bottom: 14px; }
      .sr-field label {
        display: block; font-size: 12px; font-weight: 600;
        color: var(--text, #0f172a); margin-bottom: 6px;
      }
      .sr-field input {
        width: 100%; padding: 10px 12px; border: 1px solid var(--border, #e2e8f0);
        border-radius: 8px; font-size: 14px; box-sizing: border-box;
        background: var(--surface, #fff); color: var(--text, #0f172a);
      }
      .sr-field input:focus {
        outline: none; border-color: var(--primary);
        box-shadow: 0 0 0 3px var(--primary-dim);
      }
      .sr-field .sr-hint {
        font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 4px;
      }
      .sr-field-row {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
      }
      .sr-actions {
        display: flex; gap: 8px; margin-top: 20px;
      }
      .sr-btn {
        flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 14px;
        font-weight: 600; cursor: pointer; border: none; transition: all 0.15s;
      }
      .sr-btn-primary {
        background: var(--primary); color: var(--bg);
      }
      .sr-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
      .sr-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .sr-btn-secondary {
        background: transparent; color: var(--text, #0f172a);
        border: 1px solid var(--border, #e2e8f0);
      }
      .sr-btn-secondary:hover { background: var(--surface2, #f8fafc); }
      .sr-status-box {
        background: var(--surface2, #f8fafc); border: 1px solid var(--border, #e2e8f0);
        border-radius: 10px; padding: 14px; margin: 16px 0;
      }

      /* Entry modal: choice tiles for create vs join */
      .sr-choice-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0 16px;
      }
      .sr-choice-tile {
        padding: 18px 14px; border-radius: 12px;
        border: 1px solid var(--border, #e2e8f0); background: var(--surface2, #f8fafc);
        cursor: pointer; text-align: left; transition: all 0.15s;
        display: flex; flex-direction: column; gap: 6px;
      }
      .sr-choice-tile:hover {
        border-color: var(--primary);
        background: var(--primary-dim);
      }
      .sr-choice-icon { font-size: 22px; }
      .sr-choice-title { font-size: 14px; font-weight: 700; color: var(--text, #0f172a); }
      .sr-choice-desc { font-size: 12px; color: var(--text-muted, #64748b); line-height: 1.4; }

      /* Join modal: tab switcher between token and code */
      .sr-tab-switcher {
        display: flex; gap: 4px; padding: 4px;
        background: var(--surface2, #f8fafc); border-radius: 8px; margin-bottom: 14px;
      }
      .sr-tab-switcher button {
        flex: 1; padding: 8px 12px; border-radius: 6px;
        background: transparent; border: none; cursor: pointer;
        font-size: 13px; font-weight: 600; color: var(--text-muted, #64748b);
        transition: all 0.15s;
      }
      .sr-tab-switcher button.active {
        background: var(--surface, #fff);
        color: var(--text, #0f172a);
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }

      /* Invite link box (after create) */
      .sr-invite-url {
        font-family: monospace; font-size: 13px; color: var(--primary);
        word-break: break-all; background: #fff; padding: 8px 10px;
        border-radius: 6px; border: 1px solid var(--border, #e2e8f0);
      }
      .sr-share-row {
        display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
      }
      .sr-share-btn {
        flex: 1; min-width: 100px; padding: 10px; border-radius: 8px;
        border: 1px solid var(--border, #e2e8f0); background: #fff;
        cursor: pointer; font-size: 13px; font-weight: 600;
        color: var(--text, #0f172a); display: flex; align-items: center;
        justify-content: center; gap: 6px; transition: all 0.15s;
      }
      .sr-share-btn:hover { border-color: var(--primary); }
    `;
    const style = document.createElement('style');
    style.id = 'study-rooms-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Entry modal: sidebar click lands here, picks create or join ───────────
  function openStudyRoomEntryModal() {
    ensureStyles();
    const overlay = $('div', { class: 'sr-overlay' });
    const modal = $('div', { class: 'sr-modal' });
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    modal.appendChild($('h2', {}, '📚 스터디 룸'));
    modal.appendChild($('p', { class: 'sr-subtitle' },
      '같은 강의를 듣는 친구들과 학습 시간·진도만 공유해요. 노트 내용은 비공개로 유지됩니다.'));

    const grid = $('div', { class: 'sr-choice-grid' });

    const createTile = $('button', {
      class: 'sr-choice-tile',
      onclick: () => {
        overlay.remove();
        openStudyRoomCreateModal({});
      },
    });
    createTile.appendChild($('span', { class: 'sr-choice-icon' }, '➕'));
    createTile.appendChild($('div', { class: 'sr-choice-title' }, '새 룸 만들기'));
    createTile.appendChild($('div', { class: 'sr-choice-desc' }, '강의명과 초대 코드를 정해서 친구를 부르세요'));
    grid.appendChild(createTile);

    const joinTile = $('button', {
      class: 'sr-choice-tile',
      onclick: () => {
        overlay.remove();
        openStudyRoomJoinModal({});
      },
    });
    joinTile.appendChild($('span', { class: 'sr-choice-icon' }, '🚪'));
    joinTile.appendChild($('div', { class: 'sr-choice-title' }, '초대로 합류'));
    joinTile.appendChild($('div', { class: 'sr-choice-desc' }, '친구가 알려준 초대 코드 또는 토큰을 입력해서 합류해요'));
    grid.appendChild(joinTile);

    modal.appendChild(grid);

    const cancel = $('button', { class: 'sr-btn sr-btn-secondary', style: 'width:100%', onclick: () => overlay.remove() }, '닫기');
    modal.appendChild(cancel);

    document.body.appendChild(overlay);
  }

  // ── Create modal ──────────────────────────────────────────────────────────
  function openStudyRoomCreateModal(opts = {}) {
    ensureStyles();

    const lectureInput = $('input', { type: 'text', placeholder: '예: 산업심리학 (월/수)', value: opts.lectureName || '', maxlength: 100 });
    const codeInput    = $('input', { type: 'text', placeholder: '예: PSYC301, 산심2026', value: opts.lectureCode || '', maxlength: 20 });

    // Fresh idempotency key per modal session. Server scopes lookup by
    // (uid, key) so a retry of the SAME submit returns the same room
    // instead of double-creating. Cancelling and reopening the modal
    // gives a new key, so a deliberate re-create works as expected.
    const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'ik_' + Date.now() + '_' + Math.random().toString(36).slice(2);

    const statusBox = $('div', { class: 'sr-status-box', style: 'display:none' });
    const submitBtn = $('button', { class: 'sr-btn sr-btn-primary' }, '룸 만들기');
    const cancelBtn = $('button', { class: 'sr-btn sr-btn-secondary' }, '취소');

    const overlay = $('div', { class: 'sr-overlay' });
    const modal = $('div', { class: 'sr-modal' });
    overlay.appendChild(modal);
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    submitBtn.addEventListener('click', async () => {
      const lectureName = lectureInput.value.trim();
      const lectureCode = codeInput.value.trim() || null;

      if (!lectureName) return toast('강의명을 입력해주세요');

      submitBtn.disabled = true;
      submitBtn.textContent = '만드는 중...';
      const idToken = await getIdToken();
      if (!idToken) {
        submitBtn.disabled = false;
        submitBtn.textContent = '룸 만들기';
        return toast('로그인이 필요합니다');
      }

      try {
        const res = await fetch('/api/room-create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify({ lectureName, lectureCode, idempotencyKey }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('http_' + res.status));

        showCreateSuccess(statusBox, data, lectureName);
        submitBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[study_rooms] create failed', e);
        const msg = (
          e.message === 'bad_lecture_name' ? '강의명이 너무 길거나 비어있어요' :
          e.message === 'bad_lecture_code' ? '초대 코드 형식이 올바르지 않아요 (영문/숫자/.-_ 1~20자)' :
          e.message === 'too_many_rooms' ? '활성 스터디 룸을 너무 많이 갖고 있어요 (최대 10개). 기존 룸을 보관한 뒤 다시 시도해주세요' :
          e.message === 'unauthorized' ? '로그인이 만료되었어요. 새로고침 후 다시 시도해주세요' :
          '룸 생성 실패: ' + (e.message || 'unknown')
        );
        toast(msg);
        submitBtn.disabled = false;
        submitBtn.textContent = '룸 만들기';
      }
    });

    modal.appendChild($('h2', {}, '➕ 새 스터디 룸 만들기'));
    modal.appendChild($('p', { class: 'sr-subtitle' },
      '강의명과 초대 코드를 정하면, 친구는 그 코드만 입력해서 바로 합류할 수 있어요.'));

    modal.appendChild(field('강의명', lectureInput, '룸 이름으로 표시됩니다 (필수)'));
    modal.appendChild(field('초대 코드 (선택)', codeInput, '친구에게 알려줄 짧은 코드. 영문/숫자/.-_ 1~20자'));

    modal.appendChild($('div', { class: 'sr-hint', style: 'margin:-4px 0 14px;font-size:11px;color:var(--text-muted,#94a3b8)' },
      '※ 비우면 초대 링크로만 합류 가능'));

    modal.appendChild(statusBox);

    const actions = $('div', { class: 'sr-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
    setTimeout(() => lectureInput.focus(), 50);
  }

  function field(label, input, hint) {
    const wrap = $('div', { class: 'sr-field' });
    wrap.appendChild($('label', {}, label));
    wrap.appendChild(input);
    if (hint) wrap.appendChild($('div', { class: 'sr-hint' }, hint));
    return wrap;
  }

  function showCreateSuccess(box, data, lectureName) {
    box.style.display = 'block';
    box.replaceChildren();
    // Fragment (#roomJoin=) keeps the token out of server logs / Referer.
    const url = `${location.origin}/#roomJoin=${encodeURIComponent(data.inviteToken)}`;

    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;margin-bottom:8px' }, '✅ 룸 생성 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b);margin-bottom:8px' },
      '아래 링크를 친구에게 공유하면 같은 룸에 합류할 수 있어요'));
    box.appendChild($('div', { class: 'sr-invite-url' }, url));

    const row = $('div', { class: 'sr-share-row' });
    const copyBtn = $('button', {
      class: 'sr-share-btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = '✓ 복사됨';
          setTimeout(() => copyBtn.replaceChildren(document.createTextNode('📋 복사')), 1800);
        } catch (e) { toast('복사 실패'); }
      },
    }, '📋 복사');
    row.appendChild(copyBtn);

    if (navigator.share) {
      const shareBtn = $('button', {
        class: 'sr-share-btn',
        onclick: async () => {
          try {
            await navigator.share({
              title: 'Notyx 스터디 룸 초대',
              text: `${lectureName} 스터디 룸에서 같이 공부해요`,
              url,
            });
          } catch (e) { if (e.name !== 'AbortError') toast('공유 실패'); }
        },
      }, '📤 공유');
      row.appendChild(shareBtn);
    }
    box.appendChild(row);

    // R3 onboarding: connect-to-folder step is the most-missed action.
    // Users create a room, share the link, and then wonder why no minutes
    // ever accumulate — because they never linked a folder. Call it out
    // explicitly with the actual code they should paste.
    const nextStep = $('div', {
      style: 'margin-top:14px;padding:10px 12px;background:var(--primary-dim);' +
             'border-left:3px solid var(--primary);border-radius:6px;' +
             'font-size:12px;line-height:1.5;color:var(--text,#0f172a);',
    });
    nextStep.appendChild($('div', { style: 'font-weight:700;margin-bottom:4px' }, '📝 다음 단계 — 폴더와 연결'));
    if (data.lectureCode || data.inviteToken) {
      // Backend currently returns roomId + inviteToken only, but lectureCode
      // is what the user typed in the form. Pull it from the form input via
      // closure if available, otherwise generic message.
    }
    nextStep.appendChild($('div', {},
      '폴더 관리 → 강의 폴더 편집 → "스터디 룸 초대 코드"에 ' +
      '위에서 정한 코드를 똑같이 입력하면, 그 폴더의 노트를 열 때마다 학습 시간이 친구들과 공유돼요. ' +
      '(코드 안 정했으면 폴더 코드 박지 않아도 됨 — 초대 링크 받은 친구만 합류)'));
    box.appendChild(nextStep);

    const openBtn = $('button', {
      class: 'sr-btn sr-btn-primary',
      style: 'margin-top:12px;width:100%',
      onclick: () => {
        box.closest('.sr-overlay')?.remove();
        openStudyRoomPage({ roomId: data.roomId });
      },
    }, '→ 룸 페이지로 이동');
    box.appendChild(openBtn);
  }

  // ── Join modal — token tab or code tab ────────────────────────────────────
  function openStudyRoomJoinModal({ token } = {}) {
    ensureStyles();
    const overlay = $('div', { class: 'sr-overlay' });
    const modal = $('div', { class: 'sr-modal' });
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // If a token came from a URL invite, pre-fill the token tab and skip the
    // tab switcher entirely — the user already chose by clicking the link.
    let currentTab = 'token';

    const tokenInput = $('input', { type: 'text', placeholder: '12자 초대 토큰', value: token || '', maxlength: 12 });
    const codeInput  = $('input', { type: 'text', placeholder: '예: PSYC301, 산심2026', maxlength: 20 });

    const tokenPanel = $('div', {});
    tokenPanel.appendChild(field('초대 토큰', tokenInput, '룸을 만든 사람이 공유한 12자 코드 (또는 초대 링크 사용)'));

    const codePanel = $('div', { style: 'display:none' });
    codePanel.appendChild(field('초대 코드', codeInput, '룸을 만든 사람이 정한 짧은 코드. 영문/숫자/.-_ 1~20자'));

    const switcher = $('div', { class: 'sr-tab-switcher' });
    const tokenTabBtn = $('button', { class: 'active' }, '🎟 초대 토큰');
    const codeTabBtn = $('button', {}, '🔤 초대 코드');
    function switchTab(name) {
      currentTab = name;
      tokenTabBtn.classList.toggle('active', name === 'token');
      codeTabBtn.classList.toggle('active', name === 'code');
      tokenPanel.style.display = name === 'token' ? '' : 'none';
      codePanel.style.display  = name === 'code' ? '' : 'none';
      setTimeout(() => (name === 'token' ? tokenInput : codeInput).focus(), 30);
    }
    tokenTabBtn.addEventListener('click', () => switchTab('token'));
    codeTabBtn.addEventListener('click', () => switchTab('code'));
    switcher.appendChild(tokenTabBtn);
    switcher.appendChild(codeTabBtn);

    const statusBox = $('div', { class: 'sr-status-box', style: 'display:none' });
    const joinBtn = $('button', { class: 'sr-btn sr-btn-primary' }, '합류하기');
    const cancelBtn = $('button', { class: 'sr-btn sr-btn-secondary' }, '취소');
    cancelBtn.addEventListener('click', () => overlay.remove());

    joinBtn.addEventListener('click', async () => {
      const body = currentTab === 'token'
        ? { inviteToken: tokenInput.value.trim() }
        : { lectureCode: codeInput.value.trim() };

      if (currentTab === 'token' && !body.inviteToken) return toast('초대 토큰을 입력해주세요');
      if (currentTab === 'code' && !body.lectureCode) return toast('초대 코드를 입력해주세요');

      joinBtn.disabled = true;
      joinBtn.textContent = '합류 중...';
      const idToken = await getIdToken();
      if (!idToken) {
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
        return toast('로그인이 필요합니다');
      }

      try {
        const res = await fetch('/api/room-join', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('http_' + res.status));
        showJoinSuccess(statusBox, data);
        joinBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[study_rooms] join failed', e);
        const msg = (
          e.message === 'room_not_found' ? '해당 룸을 찾을 수 없어요 (만료된 링크/잘못된 코드일 수 있어요)' :
          e.message === 'room_full' ? '룸 정원이 가득 찼습니다 (최대 30명)' :
          e.message === 'room_inactive' ? '비활성화된 룸입니다' :
          e.message === 'code_collision' ? '같은 초대 코드를 가진 룸이 여러 개 있어요. 친구가 보낸 초대 링크를 사용해 주세요 (🎟 토큰 탭)' :
          e.message === 'bad_token' ? '초대 토큰 형식이 올바르지 않습니다' :
          e.message === 'bad_lecture_code' ? '초대 코드 형식이 올바르지 않아요 (영문/숫자/.-_ 1~20자)' :
          e.message === 'missing_lookup' ? '초대 토큰 또는 초대 코드 중 하나는 입력해주세요' :
          '합류 실패: ' + (e.message || 'unknown')
        );
        showJoinError(statusBox, msg);
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
      }
    });

    modal.appendChild($('h2', {}, '🚪 스터디 룸 합류'));
    modal.appendChild($('p', { class: 'sr-subtitle' },
      '친구가 공유한 초대 토큰(링크) 또는 초대 코드로 합류해요. 노트 내용은 공유되지 않고 학습 시간·진도만 보입니다.'));

    // Skip the tab switcher when a token was passed in (URL invite path);
    // the user clicked the link, no point asking them to confirm which tab.
    if (!token) modal.appendChild(switcher);
    modal.appendChild(tokenPanel);
    modal.appendChild(codePanel);

    modal.appendChild(statusBox);

    const actions = $('div', { class: 'sr-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(joinBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
    setTimeout(() => tokenInput.focus(), 50);
  }

  function showJoinSuccess(box, data) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;color:var(--primary);margin-bottom:6px' },
      '✅ "' + (data.lectureName || '스터디 룸') + '" 합류 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b)' },
      '현재 멤버 ' + (data.memberCount || 1) + '명' + (data.already ? ' (이미 멤버였어요)' : '')));

    if (data.roomId) {
      const openBtn = $('button', {
        class: 'sr-btn sr-btn-primary',
        style: 'margin-top:12px;width:100%',
        onclick: () => {
          box.closest('.sr-overlay')?.remove();
          openStudyRoomPage({ roomId: data.roomId });
        },
      }, '→ 룸 페이지로 이동');
      box.appendChild(openBtn);
    }
  }

  function showJoinError(box, msg) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:13px;color:#dc2626' }, '❌ ' + msg));
  }

  // ── Study room page (with realtime listener) ──────────────────────────────
  // Reads two Firestore resources:
  //   studyRooms/{rid}           — header metadata + invite token
  //   studyRooms/{rid}/members   — counter rows; subscribed via onSnapshot
  //                                so other members' progress shows up live.
  //
  // Privacy contract — we ONLY read these fields off each member doc:
  //   displayName, photoURL, joinedAt, studyMinutes, notesCount,
  //   progressPct, lastActiveAt
  // Anything else is intentionally ignored even if rules permit it.
  const MEMBER_FIELD_WHITELIST = [
    'displayName', 'photoURL', 'joinedAt',
    'studyMinutes', 'notesCount', 'progressPct', 'lastActiveAt',
  ];

  function pickMemberFields(doc) {
    const raw = doc.data() || {};
    const out = { uid: doc.id };
    for (const k of MEMBER_FIELD_WHITELIST) {
      if (raw[k] !== undefined) out[k] = raw[k];
    }
    return out;
  }

  function ensurePageStyles() {
    if (document.getElementById('study-rooms-page-styles')) return;
    const css = `
      .sr-page {
        background: var(--surface, #fff); border-radius: 16px;
        max-width: 640px; width: 100%; max-height: 92vh;
        overflow-y: auto; padding: 0;
        box-shadow: 0 20px 60px rgba(0,0,0,0.2);
        display: flex; flex-direction: column;
      }
      .sr-page-loading, .sr-page-error {
        padding: 60px 24px; text-align: center;
        color: var(--text-muted, #64748b); font-size: 14px;
      }
      .sr-page-error { color: #dc2626; }
      .sr-page-header {
        display: flex; align-items: center; gap: 10px;
        padding: 20px 24px 14px;
        border-bottom: 1px solid var(--border, #e2e8f0);
        position: sticky; top: 0;
        background: var(--surface, #fff); z-index: 1;
      }
      .sr-page-header h2 {
        margin: 0; font-size: 18px; font-weight: 700;
        color: var(--text, #0f172a); flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sr-status-badge {
        font-size: 11px; font-weight: 600; padding: 3px 9px;
        border-radius: 999px; background: var(--primary-dim);
        color: var(--primary);
      }
      .sr-status-badge--archived {
        background: rgba(148,163,184,0.18); color: #64748b;
      }
      .sr-page-close {
        background: none; border: none; font-size: 20px; cursor: pointer;
        color: var(--text-muted, #94a3b8); padding: 4px 8px; line-height: 1;
      }
      .sr-page-close:hover { color: var(--text, #0f172a); }
      .sr-page-meta {
        display: flex; gap: 18px; padding: 16px 24px; flex-wrap: wrap;
      }
      .sr-meta-item { display: flex; gap: 8px; align-items: center; min-width: 0; }
      .sr-meta-icon { font-size: 18px; flex-shrink: 0; }
      .sr-meta-text { min-width: 0; }
      .sr-meta-label { font-size: 11px; color: var(--text-muted, #94a3b8); }
      .sr-meta-value { font-size: 14px; font-weight: 700; color: var(--text, #0f172a); word-break: break-all; }
      .sr-page-meta-invite {
        margin: 0 24px 12px; padding: 9px 14px; border-radius: 8px;
        border: 1px dashed var(--primary);
        background: var(--primary-dim);
        color: var(--primary); font-size: 13px; font-weight: 600;
        cursor: pointer; transition: background 0.15s; width: calc(100% - 48px);
      }
      .sr-page-meta-invite:hover { background: var(--primary-dim); }
      .sr-page-section-title {
        margin: 18px 24px 8px; font-size: 13px; font-weight: 700;
        color: var(--text, #0f172a); letter-spacing: 0.01em;
      }
      .sr-members-list {
        margin: 0 16px 20px; display: flex; flex-direction: column; gap: 8px;
      }
      .sr-member-row {
        display: grid; grid-template-columns: 40px 1fr auto;
        align-items: center; gap: 12px; padding: 12px;
        background: var(--surface2, #f8fafc);
        border: 1px solid var(--border, #e2e8f0); border-radius: 12px;
      }
      .sr-member-row.is-self {
        border-color: var(--primary);
        background: var(--primary-dim);
      }
      .sr-member-avatar {
        width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
        display: flex; align-items: center; justify-content: center;
        background: var(--surface3, #e2e8f0); color: var(--text, #0f172a);
        font-weight: 700; font-size: 16px;
      }
      .sr-member-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .sr-member-info { min-width: 0; }
      .sr-member-name {
        display: flex; align-items: center; gap: 6px;
        font-weight: 600; font-size: 14px; color: var(--text, #0f172a);
        flex-wrap: wrap;
      }
      .sr-self-tag {
        font-size: 10px; padding: 2px 6px; border-radius: 999px;
        background: var(--primary-dim); color: var(--primary);
        font-weight: 600;
      }
      .sr-member-last {
        font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 3px;
      }
      .sr-member-stats {
        display: flex; gap: 14px; align-items: center;
        text-align: right;
      }
      .sr-stat {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
      }
      .sr-stat-value {
        font-size: 15px; font-weight: 700; color: var(--text, #0f172a);
      }
      .sr-stat-label {
        font-size: 10px; color: var(--text-muted, #94a3b8);
        letter-spacing: 0.02em;
      }
      .sr-progress-bar {
        width: 60px; height: 6px; border-radius: 3px;
        background: var(--surface3, #e2e8f0); overflow: hidden;
      }
      .sr-progress-fill {
        height: 100%; background: var(--primary);
        transition: width 0.4s ease;
      }
      .sr-page-footer {
        padding: 14px 24px 20px;
        border-top: 1px solid var(--border, #e2e8f0); margin-top: 16px;
      }
      .sr-archive-btn { width: 100%; }
      @media (max-width: 600px) {
        .sr-page { max-height: 100vh; border-radius: 0; }
        .sr-page-meta { gap: 12px; }
        .sr-member-row { grid-template-columns: 36px 1fr auto; }
        .sr-member-stats { gap: 10px; }
        .sr-stat-value { font-size: 13px; }
        .sr-progress-bar { width: 44px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'study-rooms-page-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function relativeTime(ts) {
    // Firestore Timestamp -> "방금", "5분 전", "2시간 전", "어제", "3일 전"
    if (!ts) return '—';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return '방금';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    if (diff < 86400 * 2) return '어제';
    return Math.floor(diff / 86400) + '일 전';
  }

  async function openStudyRoomPage({ roomId } = {}) {
    ensureStyles();
    ensurePageStyles();
    if (!roomId || typeof roomId !== 'string') {
      toast('룸 ID가 올바르지 않습니다');
      return;
    }
    const uid = firebase.auth().currentUser?.uid;
    if (!uid) { toast('로그인이 필요합니다'); return; }

    const overlay = $('div', { class: 'sr-overlay' });
    const sheet = $('div', { class: 'sr-page' });
    overlay.appendChild(sheet);

    // Keep onSnapshot unsubscribe accessible for cleanup on close.
    let unsubscribe = null;
    function close() {
      try { unsubscribe?.(); } catch (_) {}
      overlay.remove();
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    sheet.appendChild($('div', { class: 'sr-page-loading' }, '⏳ 룸 정보 불러오는 중...'));
    document.body.appendChild(overlay);

    let roomData;
    try {
      const db = firebase.firestore();
      const roomRef = db.collection('studyRooms').doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) {
        sheet.replaceChildren();
        sheet.appendChild($('div', { class: 'sr-page-error' }, '❌ 룸을 찾을 수 없습니다 (삭제되었거나 권한이 없습니다)'));
        return;
      }
      roomData = { id: roomSnap.id, ...roomSnap.data() };

      // First render the shell with empty member list so the user sees the
      // room header instantly; the snapshot below populates members live.
      renderRoomShell(sheet, { roomData, uid, close });

      // Realtime subscription on members — other peers studying = their
      // counters tick up here without the user touching anything.
      const membersList = sheet.querySelector('.sr-members-list');
      unsubscribe = roomRef.collection('members')
        .orderBy('joinedAt', 'asc')
        .onSnapshot(
          (snap) => {
            const members = snap.docs.map(pickMemberFields);
            renderMembers(membersList, members, { uid });
          },
          (err) => {
            console.error('[study_rooms] members onSnapshot failed', err);
            membersList.replaceChildren();
            membersList.appendChild($('div', { class: 'sr-page-error', style: 'padding:20px' },
              '❌ 멤버 목록 구독 실패: ' + (err.code || err.message)));
          }
        );
    } catch (e) {
      console.error('[study_rooms] page fetch failed', e);
      sheet.replaceChildren();
      sheet.appendChild($('div', { class: 'sr-page-error' }, '❌ 룸 정보를 불러오지 못했습니다: ' + (e.message || 'unknown')));
    }
  }

  function renderRoomShell(sheet, ctx) {
    const { roomData, uid, close } = ctx;
    const isCreator = roomData.createdBy === uid;
    const isArchived = roomData.status === 'archived';
    sheet.replaceChildren();

    // Header
    const header = $('div', { class: 'sr-page-header' });
    header.appendChild($('h2', {}, roomData.lectureName || '스터디 룸'));
    header.appendChild($('span', {
      class: 'sr-status-badge' + (isArchived ? ' sr-status-badge--archived' : ''),
    }, isArchived ? '보관됨' : '진행 중'));
    const closeBtn = $('button', { class: 'sr-page-close', 'aria-label': '닫기' }, '✕');
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    // Meta strip — invite code + member count
    const meta = $('div', { class: 'sr-page-meta' });
    if (roomData.lectureCode) {
      meta.appendChild(metaItem('🎟', '초대 코드', roomData.lectureCode));
    }
    meta.appendChild(metaItem('👥', '멤버', (roomData.memberUids || []).length + '명'));
    sheet.appendChild(meta);

    // Invite link copy button (only when active)
    if (!isArchived && roomData.inviteToken) {
      // `let` — the regen button below swaps in a fresh token in place.
      // Fragment (#roomJoin=) keeps the token out of server logs / Referer.
      let inviteUrl = `${location.origin}/#roomJoin=${encodeURIComponent(roomData.inviteToken)}`;
      const inviteBtn = $('button', {
        class: 'sr-page-meta-invite',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(inviteUrl);
            inviteBtn.textContent = '✓ 링크 복사됨';
            setTimeout(() => { inviteBtn.textContent = '🔗 초대 링크 복사'; }, 1800);
          } catch (e) { toast('복사 실패'); }
        },
      }, '🔗 초대 링크 복사');
      sheet.appendChild(inviteBtn);

      // Leak kill-switch (creator only): mint a new token server-side —
      // any previously shared link dies instantly. Client-side inviteToken
      // writes are rule-blocked, so this goes through /api/invite-regen.
      if (isCreator) {
        const regenBtn = $('button', {
          class: 'sr-page-meta-invite sr-page-meta-regen',
          onclick: async () => {
            if (!await appConfirm('초대 링크를 재발급하시겠습니까?\n기존에 공유한 링크는 즉시 무효화됩니다.', { danger: true })) return;
            regenBtn.disabled = true;
            regenBtn.textContent = '재발급 중...';
            try {
              const idToken = await getIdToken();
              if (!idToken) throw new Error('로그인이 필요합니다');
              const res = await fetch('/api/invite-regen', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + idToken,
                },
                body: JSON.stringify({ type: 'room', id: roomData.id }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.inviteToken) throw new Error(data.error || ('http_' + res.status));
              roomData.inviteToken = data.inviteToken;
              inviteUrl = `${location.origin}/#roomJoin=${encodeURIComponent(data.inviteToken)}`;
              toast('새 초대 링크가 발급되었습니다 — 이전 링크는 무효화됨', 'success');
            } catch (e) {
              console.error('[study_rooms] invite regen failed', e);
              toast('재발급 실패: ' + (e.message || 'unknown'));
            } finally {
              regenBtn.disabled = false;
              regenBtn.textContent = '♻️ 링크 재발급';
            }
          },
        }, '♻️ 링크 재발급');
        sheet.appendChild(regenBtn);
      }
    }

    sheet.appendChild($('h3', { class: 'sr-page-section-title' }, '멤버 · 학습 진도'));
    // Empty list — onSnapshot fills this in.
    sheet.appendChild($('div', { class: 'sr-members-list' }));

    // Footer: archive (creator only, active rooms only)
    if (isCreator && !isArchived) {
      const footer = $('div', { class: 'sr-page-footer' });
      const archiveBtn = $('button', { class: 'sr-btn sr-btn-secondary sr-archive-btn' }, '📦 룸 보관');
      archiveBtn.addEventListener('click', async () => {
        if (!await appConfirm('이 룸을 보관하시겠습니까?\n보관 후엔 멤버들의 학습 시간이 더 이상 기록되지 않습니다.', { danger: true })) return;
        archiveBtn.disabled = true;
        archiveBtn.textContent = '보관 중...';
        try {
          await firebase.firestore().collection('studyRooms').doc(roomData.id).update({
            status: 'archived',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          toast('룸이 보관되었습니다', 'success');
          close();
        } catch (e) {
          console.error('[study_rooms] archive failed', e);
          toast('보관 실패: ' + (e.message || 'unknown'));
          archiveBtn.disabled = false;
          archiveBtn.textContent = '📦 룸 보관';
        }
      });
      footer.appendChild(archiveBtn);
      sheet.appendChild(footer);
    }
  }

  function renderMembers(listEl, members, { uid }) {
    listEl.replaceChildren();
    if (!members.length) {
      listEl.appendChild($('div', {
        style: 'padding:24px;text-align:center;color:var(--text-muted,#94a3b8);font-size:13px',
      }, '아직 멤버가 없어요'));
      return;
    }
    // Sort: self first, then by most recent activity (so active peers float
    // up — feels more alive than joinedAt order alone).
    members.sort((a, b) => {
      if (a.uid === uid) return -1;
      if (b.uid === uid) return 1;
      const ta = a.lastActiveAt?.toDate ? a.lastActiveAt.toDate().getTime() : 0;
      const tb = b.lastActiveAt?.toDate ? b.lastActiveAt.toDate().getTime() : 0;
      return tb - ta;
    });
    members.forEach(m => listEl.appendChild(memberRow(m, { uid })));
  }

  function memberRow(member, { uid }) {
    const isSelf = member.uid === uid;
    const row = $('div', { class: 'sr-member-row' + (isSelf ? ' is-self' : '') });

    // Avatar
    const avatar = $('div', { class: 'sr-member-avatar' });
    if (member.photoURL) {
      const img = $('img', { src: member.photoURL, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        avatar.replaceChildren();
        avatar.textContent = (member.displayName || '?').charAt(0).toUpperCase();
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (member.displayName || '?').charAt(0).toUpperCase();
    }
    row.appendChild(avatar);

    // Info
    const info = $('div', { class: 'sr-member-info' });
    const nameRow = $('div', { class: 'sr-member-name' });
    nameRow.appendChild($('span', {}, member.displayName || '익명'));
    if (isSelf) nameRow.appendChild($('span', { class: 'sr-self-tag' }, '나'));
    info.appendChild(nameRow);
    info.appendChild($('div', { class: 'sr-member-last' },
      '마지막 학습 ' + relativeTime(member.lastActiveAt)));
    row.appendChild(info);

    // Stats: studyMinutes + notesCount + progressBar
    const stats = $('div', { class: 'sr-member-stats' });

    const minutes = Number(member.studyMinutes) || 0;
    const minutesText = minutes >= 60
      ? `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`
      : `${minutes}분`;
    const stat1 = $('div', { class: 'sr-stat' });
    stat1.appendChild($('div', { class: 'sr-stat-value' }, minutesText));
    stat1.appendChild($('div', { class: 'sr-stat-label' }, '학습'));
    stats.appendChild(stat1);

    const stat2 = $('div', { class: 'sr-stat' });
    stat2.appendChild($('div', { class: 'sr-stat-value' }, String(Number(member.notesCount) || 0)));
    stat2.appendChild($('div', { class: 'sr-stat-label' }, '노트'));
    stats.appendChild(stat2);

    // progressPct intentionally not rendered until R3.x defines what
    // "progress" means (SRS review % / target note count / etc). Showing a
    // permanent 0% bar looks like a bug to early users — better to hide
    // until the metric is meaningful. Schema field still exists, just no UI.

    row.appendChild(stats);
    return row;
  }

  function metaItem(icon, label, value) {
    const wrap = $('div', { class: 'sr-meta-item' });
    wrap.appendChild($('span', { class: 'sr-meta-icon' }, icon));
    const text = $('div', { class: 'sr-meta-text' });
    text.appendChild($('div', { class: 'sr-meta-label' }, label));
    text.appendChild($('div', { class: 'sr-meta-value' }, value));
    wrap.appendChild(text);
    return wrap;
  }

  // ── R3: study activity sync ───────────────────────────────────────────────
  // Called from notes_crud.js when a saved note is opened. Maps note ->
  // folder.lectureCode -> matching active study rooms and bumps the user's
  // member doc in each: studyMinutes +=1, notesCount=fresh count, lastActiveAt.
  //
  // Rate-limit: same noteId within 60s = no-op. Stored in localStorage
  // (with in-memory fallback for private mode / quota errors) so multi-tab
  // abuse — opening the same note in two tabs to double-count minutes —
  // is blocked. The check is "best effort, never blocks sync": any storage
  // read/write error falls through to the in-memory map silently.
  //
  // Privacy: this function only ever touches the caller's own member doc
  // (rules enforce `request.auth.uid == memberId` for writes). Other
  // members' rows are not read here.
  //
  // Cost shape (per note open, after the rate-limit check passes):
  //   1 read  (folder doc)
  //   1 read  (rooms query, indexed)
  //   1 read  (notes-in-folder count query)
  //   N writes (one per matching room, usually 1)
  // Fire-and-forget on the caller side — errors get logged, never thrown.
  const _activitySyncFallbackMap = new Map();   // noteId -> Date.now()
  const _SYNC_STORAGE_PREFIX = 'notyx_syncts_';
  const _SYNC_RATE_LIMIT_MS = 60_000;

  function _getLastSyncTs(noteId) {
    // localStorage first (cross-tab), in-memory fallback if storage blocked.
    try {
      const v = localStorage.getItem(_SYNC_STORAGE_PREFIX + noteId);
      if (v) return Number(v) || 0;
    } catch (_) { /* private mode or quota — use map */ }
    return _activitySyncFallbackMap.get(noteId) || 0;
  }

  function _setLastSyncTs(noteId, ts) {
    try {
      localStorage.setItem(_SYNC_STORAGE_PREFIX + noteId, String(ts));
    } catch (_) { /* fall through to map */ }
    _activitySyncFallbackMap.set(noteId, ts);
  }

  function _normalizeCodeForMatch(s) {
    return String(s || '').trim().replace(/\s+/g, '').toUpperCase();
  }

  async function syncStudyActivityForNote(note) {
    if (!note || !note.id || !note.folderId) return;
    const uid = firebase.auth().currentUser?.uid;
    if (!uid) return;

    const last = _getLastSyncTs(note.id);
    if (last && Date.now() - last < _SYNC_RATE_LIMIT_MS) return;
    _setLastSyncTs(note.id, Date.now());

    const db = firebase.firestore();
    const FV = firebase.firestore.FieldValue;

    try {
      // 1. Folder's lectureCode (no code -> nothing to sync against)
      const folderSnap = await db.collection('users').doc(uid)
        .collection('folders').doc(note.folderId).get();
      if (!folderSnap.exists) return;
      const rawCode = folderSnap.data()?.lectureCode;
      if (!rawCode) return;
      const code = _normalizeCodeForMatch(rawCode);
      if (!code) return;

      // 2. User's active rooms with matching lectureCode. We split this
      //    into (memberUids array-contains + status=='active') as the
      //    indexed query, then filter lectureCode client-side. Avoids a
      //    3-way composite index and the room count per user is small.
      const roomsSnap = await db.collection('studyRooms')
        .where('memberUids', 'array-contains', uid)
        .where('status', '==', 'active')
        .get();
      const matching = roomsSnap.docs.filter(d => {
        const rc = d.data()?.lectureCode;
        return rc && _normalizeCodeForMatch(rc) === code;
      });
      if (!matching.length) return;

      // 3. Count notes in this folder (own, all queried via Firestore so
      //    the count matches what peers see, not what IDB happens to have)
      const notesSnap = await db.collection('users').doc(uid)
        .collection('notes')
        .where('folderId', '==', note.folderId)
        .get();
      const notesCount = notesSnap.size;

      // 4. Update each matching room's member doc. `set` with merge so
      //    rooms the user joined before R3 (no fields populated) bootstrap
      //    cleanly. studyMinutes uses increment for atomic accumulation.
      await Promise.all(matching.map(roomDoc =>
        roomDoc.ref.collection('members').doc(uid).set({
          studyMinutes: FV.increment(1),
          notesCount,
          lastActiveAt: FV.serverTimestamp(),
          // progressPct intentionally left at whatever it was (R3.x will
          // compute this properly — for now 0 from room-create stays 0)
        }, { merge: true })
      ));

      console.log('[study_rooms] activity sync ok',
        'note=' + note.id, 'code=' + code,
        'rooms=' + matching.length, 'notesCount=' + notesCount);
    } catch (e) {
      console.warn('[study_rooms] syncStudyActivityForNote failed:', e);
    }
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  window.openStudyRoomEntryModal = openStudyRoomEntryModal;
  window.openStudyRoomCreateModal = openStudyRoomCreateModal;
  window.openStudyRoomJoinModal = openStudyRoomJoinModal;
  window.openStudyRoomPage = openStudyRoomPage;
  window.syncStudyActivityForNote = syncStudyActivityForNote;
})();
