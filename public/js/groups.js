// Cost-splitting groups — UI module.
// Depends on: constants.js (currentNoteId), firebase auth (idToken),
// ui.js (showToast, showSuccessToast).
// Backend: POST /api/group-create, POST /api/group-join.
//
// Flow: creator opens "친구랑 나누기" from a note detail → modal → form
// (lecture name, total cost, expected minutes, audio path) → API call →
// invite link displayed → share via system share sheet, KakaoTalk, or copy.

(function () {
  'use strict';

  // ── DOM helpers (no jQuery, no innerHTML interpolation of untrusted data) ─
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
    console.log('[groups]', msg);
  }

  async function getIdToken() {
    try {
      const u = firebase.auth().currentUser;
      if (!u) return null;
      return await u.getIdToken();
    } catch (e) {
      console.error('[groups] getIdToken failed', e);
      return null;
    }
  }

  // ── Style injection (scoped, idempotent) ──────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('groups-styles')) return;
    const css = `
      .groups-overlay {
        position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 16px;
      }
      .groups-modal {
        background: var(--surface, #fff); border-radius: 16px;
        max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto;
        padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      }
      .groups-modal h2 {
        margin: 0 0 4px; font-size: 18px; font-weight: 700;
        color: var(--text, #0f172a);
      }
      .groups-modal .subtitle {
        margin: 0 0 20px; font-size: 13px; color: var(--text-muted, #64748b);
      }
      .groups-field { margin-bottom: 14px; }
      .groups-field label {
        display: block; font-size: 12px; font-weight: 600;
        color: var(--text, #0f172a); margin-bottom: 6px;
      }
      .groups-field input {
        width: 100%; padding: 10px 12px; border: 1px solid var(--border, #e2e8f0);
        border-radius: 8px; font-size: 14px; box-sizing: border-box;
        background: var(--surface, #fff); color: var(--text, #0f172a);
      }
      .groups-field input:focus {
        outline: none; border-color: var(--primary);
        box-shadow: 0 0 0 3px var(--primary-dim);
      }
      .groups-field .hint {
        font-size: 11px; color: var(--text-muted, #94a3b8); margin-top: 4px;
      }
      .groups-actions {
        display: flex; gap: 8px; margin-top: 20px;
      }
      .groups-btn {
        flex: 1; padding: 10px 16px; border-radius: 8px; font-size: 14px;
        font-weight: 600; cursor: pointer; border: none; transition: all 0.15s;
      }
      .groups-btn-primary {
        background: var(--primary); color: var(--bg);
      }
      .groups-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
      .groups-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .groups-btn-secondary {
        background: transparent; color: var(--text, #0f172a);
        border: 1px solid var(--border, #e2e8f0);
      }
      .groups-btn-secondary:hover { background: var(--surface2, #f8fafc); }
      .groups-invite-box {
        background: var(--surface2, #f8fafc); border: 1px solid var(--border, #e2e8f0);
        border-radius: 10px; padding: 14px; margin: 16px 0;
      }
      .groups-invite-url {
        font-family: monospace; font-size: 13px; color: var(--primary);
        word-break: break-all; background: #fff; padding: 8px 10px;
        border-radius: 6px; border: 1px solid var(--border, #e2e8f0);
      }
      .groups-share-row {
        display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
      }
      .groups-share-btn {
        flex: 1; min-width: 100px; padding: 10px; border-radius: 8px;
        border: 1px solid var(--border, #e2e8f0); background: #fff;
        cursor: pointer; font-size: 13px; font-weight: 600;
        color: var(--text, #0f172a); display: flex; align-items: center;
        justify-content: center; gap: 6px; transition: all 0.15s;
      }
      .groups-share-btn:hover { border-color: var(--primary); }
      .groups-share-btn.kakao { background: #fee500; border-color: #fee500; }
      .groups-share-btn.kakao:hover { background: #fdd835; }
    `;
    const style = document.createElement('style');
    style.id = 'groups-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Group create modal ────────────────────────────────────────────────────
  function openGroupCreateModal(opts = {}) {
    ensureStyles();

    const defaults = {
      lectureName: opts.lectureName || '',
      totalCost: opts.totalCost || 1500,
      expectedMinutes: opts.expectedMinutes || 90,
      audioStoragePath: opts.audioStoragePath || '',
      noteId: opts.noteId || null,
    };

    // Hard gate: without a recording, there is nothing for friends to share.
    // The caller (the shareGroupBtn handler in index.html) is supposed to
    // check this first and toast, but defend-in-depth in case it's called
    // from somewhere else later.
    if (!defaults.audioStoragePath || !defaults.audioStoragePath.startsWith('users/')) {
      toast('이 노트는 녹음 파일이 없어 공유할 수 없습니다');
      return;
    }

    // Inputs (audio path is now derived from the note, not user-entered)
    const lectureInput = $('input', { type: 'text', placeholder: '예: 산업심리학 5주차', value: defaults.lectureName, maxlength: 100 });
    const costInput    = $('input', { type: 'number', min: 100, max: 50000, step: 100, value: defaults.totalCost });
    const minutesInput = $('input', { type: 'number', min: 1, max: 300, value: defaults.expectedMinutes });

    const inviteBox = $('div', { class: 'groups-invite-box', style: 'display:none' });
    const submitBtn = $('button', { class: 'groups-btn groups-btn-primary' }, '그룹 만들기');
    const cancelBtn = $('button', { class: 'groups-btn groups-btn-secondary' }, '취소');

    const overlay = $('div', { class: 'groups-overlay' });
    const modal = $('div', { class: 'groups-modal' });
    overlay.appendChild(modal);

    function close() {
      overlay.remove();
    }
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    submitBtn.addEventListener('click', async () => {
      const lectureName = lectureInput.value.trim();
      const totalCost = Number(costInput.value);
      const expectedMinutes = Number(minutesInput.value);
      const audioStoragePath = defaults.audioStoragePath; // pre-validated above

      if (!lectureName) return toast('강의명을 입력해주세요');
      if (!(totalCost > 0 && totalCost <= 50000)) return toast('총 비용은 100~50000원');
      if (!(expectedMinutes > 0 && expectedMinutes <= 300)) return toast('예상 시간은 1~300분');

      submitBtn.disabled = true;
      submitBtn.textContent = '만드는 중...';

      const idToken = await getIdToken();
      if (!idToken) {
        submitBtn.disabled = false;
        submitBtn.textContent = '그룹 만들기';
        return toast('로그인이 필요합니다');
      }

      try {
        const res = await fetch('/api/group-create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify({
            lectureName,
            totalCost,
            expectedMinutes,
            audioStoragePath,
            noteId: defaults.noteId,
            idempotencyKey: defaults.noteId ? `note-${defaults.noteId}` : null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || ('http_' + res.status));
        }
        showInviteResult(inviteBox, data, lectureName);
        submitBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[groups] create failed', e);
        toast('그룹 생성 실패: ' + (e.message || 'unknown'));
        submitBtn.disabled = false;
        submitBtn.textContent = '그룹 만들기';
      }
    });

    // Build modal body
    modal.appendChild($('h2', {}, '👥 친구랑 비용 나누기'));
    modal.appendChild($('p', { class: 'subtitle' }, '원작자가 선결제하고 친구들이 사후에 분담 송금합니다.'));

    modal.appendChild(field('강의명', lectureInput, '나중에 그룹 이름으로 표시됩니다'));
    modal.appendChild(field('총 STT 비용 (원)', costInput, '내가 결제한 실제 금액'));
    modal.appendChild(field('예상 강의 시간 (분)', minutesInput));

    // Info row: audio is auto-linked from the note — no user input required
    const audioInfo = $('div', { style: 'background:var(--surface2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--text-muted,#64748b);display:flex;align-items:center;gap:8px' });
    audioInfo.appendChild($('span', { style: 'flex-shrink:0' }, '🎙️'));
    audioInfo.appendChild($('span', {}, '녹음 파일이 이 노트에 자동 연결됩니다'));
    modal.appendChild(audioInfo);

    modal.appendChild(inviteBox);

    const actions = $('div', { class: 'groups-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
    setTimeout(() => lectureInput.focus(), 50);
  }

  function field(label, input, hint) {
    const wrap = $('div', { class: 'groups-field' });
    wrap.appendChild($('label', {}, label));
    wrap.appendChild(input);
    if (hint) wrap.appendChild($('div', { class: 'hint' }, hint));
    return wrap;
  }

  // ── Invite result panel ───────────────────────────────────────────────────
  function showInviteResult(box, data, lectureName) {
    box.style.display = 'block';
    box.replaceChildren();

    // Token rides in the URL FRAGMENT (#join=...) — fragments never reach the
    // server, so the token stays out of server/CDN logs and Referer headers.
    const url = `${location.origin}/#join=${encodeURIComponent(data.inviteToken)}`;

    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;margin-bottom:8px' }, '✅ 그룹 생성 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b);margin-bottom:8px' }, '아래 링크를 친구한테 공유하세요'));

    const urlBox = $('div', { class: 'groups-invite-url' }, url);
    box.appendChild(urlBox);

    const row = $('div', { class: 'groups-share-row' });

    // Copy button
    const copyBtn = $('button', { class: 'groups-share-btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = '✓ 복사됨';
          setTimeout(() => { copyBtn.replaceChildren(document.createTextNode('📋 복사')); }, 2000);
        } catch (e) {
          toast('복사 실패');
        }
      }
    }, '📋 복사');
    row.appendChild(copyBtn);

    // System share (works on mobile = native share sheet incl. KakaoTalk)
    if (navigator.share) {
      const shareBtn = $('button', { class: 'groups-share-btn',
        onclick: async () => {
          try {
            await navigator.share({
              title: 'Notyx 강의 그룹 초대',
              text: `${lectureName} 강의 노트/녹취록 공유 그룹에 참여하세요`,
              url,
            });
          } catch (e) {
            if (e.name !== 'AbortError') toast('공유 실패');
          }
        }
      }, '📤 공유');
      row.appendChild(shareBtn);
    }

    // KakaoTalk web share fallback (opens mobile Kakao or browser tab)
    const kakaoText = encodeURIComponent(`${lectureName} 강의 노트/녹취록 공유 그룹 ${url}`);
    const kakaoBtn = $('a', {
      class: 'groups-share-btn kakao',
      href: `https://accounts.kakao.com/weblogin/share?u=${encodeURIComponent(url)}&text=${kakaoText}`,
      target: '_blank',
      rel: 'noopener',
    }, '💬 카카오톡');
    row.appendChild(kakaoBtn);

    box.appendChild(row);

    // Open group page CTA (Phase 3B-3 hook)
    if (data.groupId) {
      const openPageBtn = $('button', {
        class: 'groups-btn groups-btn-primary',
        style: 'margin-top:12px;width:100%',
        onclick: () => {
          box.closest('.groups-overlay')?.remove();
          openGroupPage({ groupId: data.groupId });
        },
      }, '→ 그룹 페이지로 이동');
      box.appendChild(openPageBtn);
    }
  }

  // ── Group join modal ──────────────────────────────────────────────────────
  // Called when a friend clicks an invite link (?join=<token>) and auth is
  // ready. The modal shows a confirm gate first — joining is idempotent on
  // the backend (re-clicking is a no-op) but we still want explicit consent
  // so the user understands what they're entering.
  function openGroupJoinModal({ token } = {}) {
    ensureStyles();
    if (!token || typeof token !== 'string') {
      toast('초대 링크가 올바르지 않습니다');
      return;
    }

    const overlay = $('div', { class: 'groups-overlay' });
    const modal = $('div', { class: 'groups-modal' });
    overlay.appendChild(modal);

    function close() { overlay.remove(); }

    const joinBtn = $('button', { class: 'groups-btn groups-btn-primary' }, '합류하기');
    const cancelBtn = $('button', { class: 'groups-btn groups-btn-secondary' }, '취소');
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const statusBox = $('div', { class: 'groups-invite-box', style: 'display:none' });

    joinBtn.addEventListener('click', async () => {
      joinBtn.disabled = true;
      joinBtn.textContent = '합류 중...';
      const idToken = await getIdToken();
      if (!idToken) {
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
        return toast('로그인이 필요합니다');
      }
      try {
        const res = await fetch('/api/group-join', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken,
          },
          body: JSON.stringify({ inviteToken: token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 404) throw new Error('group_not_found');
          if (res.status === 403 && data.error === 'group_full') throw new Error('group_full');
          if (res.status === 403 && data.error === 'group_inactive') throw new Error('group_inactive');
          throw new Error(data.error || ('http_' + res.status));
        }
        showJoinSuccess(statusBox, data);
        joinBtn.style.display = 'none';
        cancelBtn.textContent = '닫기';
      } catch (e) {
        console.error('[groups] join failed', e);
        const msg = (
          e.message === 'group_not_found' ? '그룹을 찾을 수 없습니다 (만료된 링크일 수 있어요)' :
          e.message === 'group_full' ? '그룹 정원이 가득 찼습니다' :
          e.message === 'group_inactive' ? '비활성화된 그룹입니다' :
          e.message === 'bad_token' ? '초대 토큰이 올바르지 않습니다' :
          '합류 실패: ' + (e.message || 'unknown')
        );
        showJoinError(statusBox, msg);
        joinBtn.disabled = false;
        joinBtn.textContent = '합류하기';
      }
    });

    modal.appendChild($('h2', {}, '👥 강의 그룹 합류'));
    modal.appendChild($('p', { class: 'subtitle' }, '친구가 공유한 강의 노트/녹취록 그룹에 합류합니다.'));

    const summary = $('div', { style: 'background:var(--surface2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:14px;margin-bottom:8px;font-size:13px;line-height:1.6' });
    summary.appendChild($('div', { style: 'font-weight:600;margin-bottom:6px' }, '합류하면…'));
    const ul = $('ul', { style: 'margin:0;padding-left:18px;color:var(--text-muted,#64748b)' });
    ul.appendChild($('li', {}, '그룹의 강의 노트와 녹취록을 함께 볼 수 있어요'));
    ul.appendChild($('li', {}, '원작자가 결제한 STT 비용을 나중에 분담 송금할 수 있어요'));
    ul.appendChild($('li', {}, '내 학습 데이터는 그대로 비공개로 유지됩니다'));
    summary.appendChild(ul);
    modal.appendChild(summary);

    modal.appendChild(statusBox);

    const actions = $('div', { class: 'groups-actions' });
    actions.appendChild(cancelBtn);
    actions.appendChild(joinBtn);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
  }

  function showJoinSuccess(box, data) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:14px;color:var(--primary);margin-bottom:6px' },
      '✅ "' + (data.lectureName || '강의') + '" 그룹 합류 완료'));
    box.appendChild($('div', { style: 'font-size:12px;color:var(--text-muted,#64748b)' },
      '현재 멤버 ' + (data.memberCount || 1) + '명' + (data.already ? ' (이미 멤버였어요)' : '')));

    if (data.groupId) {
      const openPageBtn = $('button', {
        class: 'groups-btn groups-btn-primary',
        style: 'margin-top:12px;width:100%',
        onclick: () => {
          box.closest('.groups-overlay')?.remove();
          openGroupPage({ groupId: data.groupId });
        },
      }, '→ 그룹 페이지로 이동');
      box.appendChild(openPageBtn);
    }
  }

  function showJoinError(box, msg) {
    box.style.display = 'block';
    box.replaceChildren();
    box.appendChild($('div', { style: 'font-weight:600;font-size:13px;color:#dc2626' }, '❌ ' + msg));
  }

  // ── Group page (Phase 3B-3) ───────────────────────────────────────────────
  // Full UI for an active group: header with status + archive, member list
  // with per-row settlement state, my-row inline editor, transcript view.
  //
  // Reads three Firestore resources:
  //   lectureGroups/{gid}           — header metadata + invite token
  //   lectureGroups/{gid}/members   — list of all members + their settlement
  //   lectureGroups/{gid}/recording/meta — STT transcript + status
  //
  // Writes:
  //   members/{my-uid}    — only my settlement row (rule-enforced)
  //   lectureGroups/{gid} — only status flip (creator only; rule-enforced)
  async function openGroupPage({ groupId } = {}) {
    ensureStyles();
    ensurePageStyles();
    if (!groupId || typeof groupId !== 'string') {
      toast('그룹 ID가 올바르지 않습니다');
      return;
    }
    const uid = firebase.auth().currentUser?.uid;
    if (!uid) {
      toast('로그인이 필요합니다');
      return;
    }

    // Build shell first so the user sees a frame immediately
    const overlay = $('div', { class: 'groups-overlay' });
    const sheet = $('div', { class: 'groups-page' });
    overlay.appendChild(sheet);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const loadingEl = $('div', { class: 'groups-page-loading' }, '⏳ 그룹 정보 불러오는 중...');
    sheet.appendChild(loadingEl);
    document.body.appendChild(overlay);

    let groupData, membersData, recordingMeta;
    try {
      const db = firebase.firestore();
      const groupRef = db.collection('lectureGroups').doc(groupId);

      const [groupSnap, membersSnap, recSnap] = await Promise.all([
        groupRef.get(),
        groupRef.collection('members').orderBy('joinedAt').get(),
        groupRef.collection('recording').doc('meta').get().catch(() => null),
      ]);

      if (!groupSnap.exists) {
        loadingEl.remove();
        sheet.appendChild($('div', { class: 'groups-page-error' }, '❌ 그룹을 찾을 수 없습니다 (삭제되었거나 권한이 없습니다)'));
        return;
      }
      groupData = { id: groupSnap.id, ...groupSnap.data() };
      membersData = membersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      recordingMeta = recSnap?.exists ? recSnap.data() : null;
    } catch (e) {
      console.error('[group-page] fetch failed', e);
      loadingEl.remove();
      sheet.appendChild($('div', { class: 'groups-page-error' }, '❌ 그룹 정보를 불러오지 못했습니다: ' + (e.message || 'unknown')));
      return;
    }

    loadingEl.remove();
    renderGroupPage(sheet, { groupData, membersData, recordingMeta, uid, overlay });
  }

  function renderGroupPage(sheet, ctx) {
    const { groupData, membersData, recordingMeta, uid, overlay } = ctx;
    const isCreator = groupData.creatorUid === uid;
    const isArchived = groupData.status === 'archived';
    sheet.replaceChildren();

    // ── Header ────────────────────────────────────────────────────────────
    const header = $('div', { class: 'groups-page-header' });
    header.appendChild($('h2', {}, groupData.lectureName || '강의 그룹'));
    if (isArchived) {
      header.appendChild($('span', { class: 'groups-status-badge groups-status-badge--archived' }, '보관됨'));
    } else {
      header.appendChild($('span', { class: 'groups-status-badge' }, '진행 중'));
    }

    const closeBtn = $('button', { class: 'groups-page-close', 'aria-label': '닫기' }, '✕');
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    // ── Meta strip: cost + duration + member count + invite ───────────────
    const meta = $('div', { class: 'groups-page-meta' });
    meta.appendChild(metaItem('💰', '총 비용', (groupData.totalCost || 0).toLocaleString() + '원'));
    meta.appendChild(metaItem('⏱', '예상', (groupData.expectedMinutes || 0) + '분'));
    meta.appendChild(metaItem('👥', '멤버', membersData.length + '명'));
    if (!isArchived && groupData.inviteToken) {
      // `let` — the regen button below swaps in a fresh token in place.
      // Fragment (#join=) keeps the token out of server logs / Referer.
      let inviteUrl = `${location.origin}/#join=${encodeURIComponent(groupData.inviteToken)}`;
      const inviteBtn = $('button', {
        class: 'groups-meta-invite',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(inviteUrl);
            inviteBtn.textContent = '✓ 링크 복사됨';
            setTimeout(() => { inviteBtn.textContent = '🔗 초대 링크 복사'; }, 1800);
          } catch (e) {
            toast('복사 실패');
          }
        },
      }, '🔗 초대 링크 복사');
      meta.appendChild(inviteBtn);

      // Leak kill-switch (creator only): mint a new token server-side —
      // any previously shared link dies instantly. Rules whitelist blocks
      // client-side inviteToken writes, so this goes through /api/invite-regen.
      if (isCreator) {
        const regenBtn = $('button', {
          class: 'groups-meta-invite groups-meta-regen',
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
                body: JSON.stringify({ type: 'group', id: groupData.id }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.inviteToken) throw new Error(data.error || ('http_' + res.status));
              groupData.inviteToken = data.inviteToken;
              inviteUrl = `${location.origin}/#join=${encodeURIComponent(data.inviteToken)}`;
              toast('새 초대 링크가 발급되었습니다 — 이전 링크는 무효화됨', 'success');
            } catch (e) {
              console.error('[group-page] invite regen failed', e);
              toast('재발급 실패: ' + (e.message || 'unknown'));
            } finally {
              regenBtn.disabled = false;
              regenBtn.textContent = '♻️ 링크 재발급';
            }
          },
        }, '♻️ 링크 재발급');
        meta.appendChild(regenBtn);
      }
    }
    sheet.appendChild(meta);

    // ── Members section ───────────────────────────────────────────────────
    sheet.appendChild($('h3', { class: 'groups-page-section-title' }, '멤버 · 정산'));
    const membersList = $('div', { class: 'groups-members-list' });
    membersData.forEach(m => {
      membersList.appendChild(memberRow(m, { groupData, uid, isArchived }));
    });
    sheet.appendChild(membersList);

    // Settlement summary: how many paid / total cost split
    const paidCount = membersData.filter(m => m.sharePaid).length;
    const paidAmount = membersData.filter(m => m.sharePaid).reduce((s, m) => s + (Number(m.shareAmount) || 0), 0);
    const summaryNote = $('div', { class: 'groups-settlement-summary' });
    summaryNote.appendChild($('span', {}, `정산 ${paidCount}/${membersData.length}명`));
    summaryNote.appendChild($('span', { class: 'groups-summary-dot' }, '·'));
    summaryNote.appendChild($('span', {}, `확정 합계 ${paidAmount.toLocaleString()}원 / 총 ${(groupData.totalCost || 0).toLocaleString()}원`));
    sheet.appendChild(summaryNote);

    // ── Transcript section ────────────────────────────────────────────────
    sheet.appendChild($('h3', { class: 'groups-page-section-title' }, '강의 녹취록'));
    sheet.appendChild(renderTranscriptBox(recordingMeta));

    // ── Footer: archive (creator only) ────────────────────────────────────
    if (isCreator && !isArchived) {
      const footer = $('div', { class: 'groups-page-footer' });
      const archiveBtn = $('button', { class: 'groups-btn groups-btn-secondary groups-archive-btn' }, '📦 그룹 보관');
      archiveBtn.addEventListener('click', async () => {
        if (!await appConfirm('이 그룹을 보관하시겠습니까?\n보관 후엔 새 멤버를 받을 수 없고, 정산 마킹도 멈춥니다.', { danger: true })) return;
        archiveBtn.disabled = true;
        archiveBtn.textContent = '보관 중...';
        try {
          await firebase.firestore().collection('lectureGroups').doc(groupData.id).update({
            status: 'archived',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          toast('그룹이 보관되었습니다');
          overlay.remove();
        } catch (e) {
          console.error('[group-page] archive failed', e);
          toast('보관 실패: ' + (e.message || 'unknown'));
          archiveBtn.disabled = false;
          archiveBtn.textContent = '📦 그룹 보관';
        }
      });
      footer.appendChild(archiveBtn);
      sheet.appendChild(footer);
    }
  }

  function metaItem(icon, label, value) {
    const wrap = $('div', { class: 'groups-meta-item' });
    wrap.appendChild($('span', { class: 'groups-meta-icon' }, icon));
    const text = $('div', { class: 'groups-meta-text' });
    text.appendChild($('div', { class: 'groups-meta-label' }, label));
    text.appendChild($('div', { class: 'groups-meta-value' }, value));
    wrap.appendChild(text);
    return wrap;
  }

  function memberRow(member, { groupData, uid, isArchived }) {
    const isSelf = member.uid === uid;
    const isCreator = member.role === 'creator';
    const row = $('div', { class: 'groups-member-row' + (isSelf ? ' is-self' : '') });

    // Avatar (photoURL fallback to initial)
    const avatar = $('div', { class: 'groups-member-avatar' });
    if (member.photoURL) {
      const img = $('img', { src: member.photoURL, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        avatar.replaceChildren();
        avatar.textContent = (member.displayName || '?').charAt(0).toUpperCase();
        avatar.classList.add('groups-member-avatar--text');
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (member.displayName || '?').charAt(0).toUpperCase();
      avatar.classList.add('groups-member-avatar--text');
    }
    row.appendChild(avatar);

    // Name + role
    const info = $('div', { class: 'groups-member-info' });
    const nameRow = $('div', { class: 'groups-member-name' });
    nameRow.appendChild($('span', {}, member.displayName || '익명'));
    if (isSelf) nameRow.appendChild($('span', { class: 'groups-self-tag' }, '나'));
    if (isCreator) nameRow.appendChild($('span', { class: 'groups-role-tag' }, '원작자'));
    info.appendChild(nameRow);
    info.appendChild($('div', { class: 'groups-member-sub' },
      `분담 ${Number(member.shareAmount || 0).toLocaleString()}원` +
      (member.shareMethod ? ` · ${member.shareMethod}` : '')
    ));
    row.appendChild(info);

    // Badge (paid / unpaid)
    const badge = $('div', {
      class: 'groups-pay-badge ' + (member.sharePaid ? 'groups-pay-badge--paid' : 'groups-pay-badge--unpaid')
    }, member.sharePaid ? '✓ 정산' : '대기');
    row.appendChild(badge);

    // Inline editor for self (not creator — creator's row is already settled,
    // and not when group is archived)
    if (isSelf && !isCreator && !isArchived) {
      const editor = buildSettlementEditor(member, groupData);
      row.appendChild(editor);
    }

    return row;
  }

  function buildSettlementEditor(member, groupData) {
    const wrap = $('div', { class: 'groups-settlement-editor' });
    const totalCost = Number(groupData.totalCost) || 0;
    const memberCount = (groupData.memberUids || []).length || 1;
    const evenSplit = totalCost > 0 ? Math.round(totalCost / memberCount) : 0;

    const amountInput = $('input', {
      type: 'number',
      min: 0,
      max: totalCost,
      step: 100,
      value: Number(member.shareAmount) || evenSplit,
      placeholder: String(evenSplit),
    });

    const methodSelect = $('select', {});
    [
      ['', '방법 선택'],
      ['cash', '현금'],
      ['transfer', '계좌이체'],
      ['kakaopay', '카카오페이'],
      ['toss', '토스'],
      ['other', '기타'],
    ].forEach(([v, label]) => {
      const opt = $('option', { value: v }, label);
      if ((member.shareMethod || '') === v) opt.setAttribute('selected', 'selected');
      methodSelect.appendChild(opt);
    });

    const saveBtn = $('button', { class: 'groups-btn groups-btn-primary groups-settlement-save' },
      member.sharePaid ? '정산 취소' : '✓ 정산 완료');

    saveBtn.addEventListener('click', async () => {
      const amount = Number(amountInput.value);
      const method = methodSelect.value;
      if (!(amount >= 0 && amount <= totalCost)) {
        return toast(`분담 금액은 0 ~ ${totalCost.toLocaleString()}원`);
      }
      const willPay = !member.sharePaid;
      if (willPay && !method) return toast('정산 방법을 선택해주세요');

      saveBtn.disabled = true;
      saveBtn.textContent = '저장 중...';
      try {
        await firebase.firestore()
          .collection('lectureGroups').doc(groupData.id)
          .collection('members').doc(member.uid)
          .set({
            sharePaid: willPay,
            shareAmount: amount,
            shareMethod: willPay ? method : null,
            settledAt: willPay ? firebase.firestore.FieldValue.serverTimestamp() : null,
          }, { merge: true });
        toast(willPay ? '정산 완료!' : '정산 취소되었습니다', 'success');
        // Re-open page to reflect (simplest path — onSnapshot is a v2 nice-to-have)
        const overlay = wrap.closest('.groups-overlay');
        const gid = groupData.id;
        overlay?.remove();
        setTimeout(() => openGroupPage({ groupId: gid }), 80);
      } catch (e) {
        console.error('[group-page] settlement save failed', e);
        toast('저장 실패: ' + (e.message || 'unknown'));
        saveBtn.disabled = false;
        saveBtn.textContent = willPay ? '✓ 정산 완료' : '정산 취소';
      }
    });

    wrap.appendChild($('div', { class: 'groups-editor-row' },
      labeled('금액 (원)', amountInput),
      labeled('방법', methodSelect),
    ));
    wrap.appendChild(saveBtn);
    return wrap;
  }

  function labeled(label, input) {
    const w = $('div', { class: 'groups-editor-field' });
    w.appendChild($('label', {}, label));
    w.appendChild(input);
    return w;
  }

  function renderTranscriptBox(meta) {
    const box = $('div', { class: 'groups-transcript-box' });
    if (!meta) {
      box.appendChild($('div', { class: 'groups-transcript-empty' }, '녹취록 메타데이터가 없습니다.'));
      return box;
    }
    const status = meta.sttStatus || 'pending';
    if (status === 'pending') {
      box.appendChild($('div', { class: 'groups-transcript-empty' }, '⏳ STT가 아직 시작되지 않았어요. 원작자가 시작해야 합니다.'));
    } else if (status === 'processing') {
      box.appendChild($('div', { class: 'groups-transcript-empty' }, '🔄 텍스트 변환 중... 완료되면 여기에 표시됩니다.'));
    } else if (status === 'error') {
      box.appendChild($('div', { class: 'groups-transcript-error' }, '❌ 변환 중 오류가 발생했어요.'));
    } else if (status === 'completed' && meta.transcript) {
      const dur = meta.audioDuration ? Math.floor(meta.audioDuration / 60) + '분' : '';
      const speakers = meta.speakerCount ? `· 화자 ${meta.speakerCount}명` : '';
      if (dur || speakers) {
        box.appendChild($('div', { class: 'groups-transcript-meta' }, [dur, speakers].filter(Boolean).join(' ')));
      }
      const pre = $('pre', { class: 'groups-transcript-text' }, String(meta.transcript).slice(0, 50000));
      box.appendChild(pre);
    } else {
      box.appendChild($('div', { class: 'groups-transcript-empty' }, '녹취록 상태: ' + status));
    }
    return box;
  }

  // ── Group page styles ─────────────────────────────────────────────────────
  function ensurePageStyles() {
    if (document.getElementById('groups-page-styles')) return;
    const css = `
      .groups-page {
        background: var(--surface, #fff); border-radius: 16px;
        max-width: 640px; width: 100%; max-height: 92vh;
        overflow-y: auto; padding: 0; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
        display: flex; flex-direction: column;
      }
      .groups-page-loading, .groups-page-error {
        padding: 60px 24px; text-align: center;
        color: var(--text-muted, #64748b); font-size: 14px;
      }
      .groups-page-error { color: #dc2626; }

      .groups-page-header {
        display: flex; align-items: center; gap: 10px;
        padding: 20px 24px 14px;
        border-bottom: 1px solid var(--border, #e2e8f0); position: sticky;
        top: 0; background: var(--surface, #fff); z-index: 1;
      }
      .groups-page-header h2 {
        margin: 0; font-size: 18px; font-weight: 700;
        color: var(--text, #0f172a); flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .groups-status-badge {
        font-size: 11px; font-weight: 600; padding: 3px 9px;
        border-radius: 999px; background: var(--primary-dim);
        color: var(--primary);
      }
      .groups-status-badge--archived {
        background: rgba(148,163,184,0.18); color: #64748b;
      }
      .groups-page-close {
        background: none; border: none; font-size: 20px; cursor: pointer;
        color: var(--text-muted, #94a3b8); padding: 4px 8px; line-height: 1;
      }
      .groups-page-close:hover { color: var(--text, #0f172a); }

      .groups-page-meta {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 10px; padding: 16px 24px; align-items: center;
      }
      .groups-meta-item { display: flex; gap: 8px; align-items: center; }
      .groups-meta-icon { font-size: 18px; flex-shrink: 0; }
      .groups-meta-text { min-width: 0; }
      .groups-meta-label { font-size: 11px; color: var(--text-muted, #94a3b8); }
      .groups-meta-value { font-size: 14px; font-weight: 700; color: var(--text, #0f172a); }
      .groups-meta-invite {
        grid-column: 1 / -1; padding: 9px 14px; border-radius: 8px;
        border: 1px dashed var(--primary); background: var(--primary-dim);
        color: var(--primary); font-size: 13px; font-weight: 600;
        cursor: pointer; transition: background 0.15s;
      }
      .groups-meta-invite:hover { background: var(--primary-dim); }

      .groups-page-section-title {
        margin: 18px 24px 8px; font-size: 13px; font-weight: 700;
        color: var(--text, #0f172a); letter-spacing: 0.01em;
      }

      .groups-members-list {
        margin: 0 16px; display: flex; flex-direction: column; gap: 8px;
      }
      .groups-member-row {
        display: grid;
        grid-template-columns: 40px 1fr auto;
        align-items: center; gap: 12px; padding: 12px;
        background: var(--surface2, #f8fafc);
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 12px;
      }
      .groups-member-row.is-self {
        border-color: var(--primary);
        background: var(--primary-dim);
        grid-template-columns: 40px 1fr auto;
        grid-template-rows: auto auto;
      }
      .groups-member-avatar {
        width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
        display: flex; align-items: center; justify-content: center;
        background: var(--surface3, #e2e8f0); color: var(--text, #0f172a);
        font-weight: 700; font-size: 16px;
      }
      .groups-member-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .groups-member-info { min-width: 0; }
      .groups-member-name {
        display: flex; align-items: center; gap: 6px;
        font-weight: 600; font-size: 14px; color: var(--text, #0f172a);
        flex-wrap: wrap;
      }
      .groups-self-tag, .groups-role-tag {
        font-size: 10px; padding: 2px 6px; border-radius: 999px;
        background: var(--surface3, #e2e8f0); color: var(--text-muted, #64748b);
        font-weight: 600;
      }
      .groups-role-tag {
        background: var(--primary-dim); color: var(--primary);
      }
      .groups-member-sub {
        font-size: 12px; color: var(--text-muted, #94a3b8); margin-top: 2px;
      }
      .groups-pay-badge {
        font-size: 11px; font-weight: 700; padding: 4px 10px;
        border-radius: 999px; white-space: nowrap;
      }
      .groups-pay-badge--paid {
        background: rgba(34,197,94,0.15); color: #16a34a;
      }
      .groups-pay-badge--unpaid {
        background: var(--accent-dim); color: var(--accent);
      }

      .groups-settlement-editor {
        grid-column: 1 / -1; margin-top: 10px;
        padding-top: 10px; border-top: 1px dashed var(--border, #e2e8f0);
        display: flex; flex-direction: column; gap: 10px;
      }
      .groups-editor-row {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
      }
      .groups-editor-field { display: flex; flex-direction: column; gap: 4px; }
      .groups-editor-field label {
        font-size: 11px; color: var(--text-muted, #94a3b8); font-weight: 600;
      }
      .groups-editor-field input, .groups-editor-field select {
        padding: 8px 10px; border: 1px solid var(--border, #e2e8f0);
        border-radius: 6px; font-size: 13px;
        background: var(--surface, #fff); color: var(--text, #0f172a);
      }
      .groups-editor-field input:focus, .groups-editor-field select:focus {
        outline: none; border-color: var(--primary);
      }
      .groups-settlement-save { padding: 9px 14px; font-size: 13px; }

      .groups-settlement-summary {
        margin: 8px 24px 4px;
        padding: 10px 12px;
        background: var(--surface2, #f8fafc);
        border-radius: 8px;
        font-size: 12px; color: var(--text-muted, #64748b);
        display: flex; gap: 8px; flex-wrap: wrap;
      }
      .groups-summary-dot { opacity: 0.5; }

      .groups-transcript-box {
        margin: 0 24px 16px;
        background: var(--surface2, #f8fafc);
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 10px; padding: 14px;
        font-size: 13px; max-height: 320px; overflow-y: auto;
      }
      .groups-transcript-empty, .groups-transcript-error {
        color: var(--text-muted, #94a3b8); text-align: center; padding: 12px 0;
      }
      .groups-transcript-error { color: #dc2626; }
      .groups-transcript-meta {
        font-size: 11px; color: var(--text-muted, #94a3b8); margin-bottom: 8px;
      }
      .groups-transcript-text {
        margin: 0; white-space: pre-wrap; word-break: break-word;
        font-family: inherit; font-size: 13px; line-height: 1.55;
        color: var(--text, #0f172a);
      }

      .groups-page-footer {
        padding: 14px 24px 20px; border-top: 1px solid var(--border, #e2e8f0);
        margin-top: 16px;
      }
      .groups-archive-btn { width: 100%; }

      @media (max-width: 600px) {
        .groups-page { max-height: 100vh; border-radius: 0; }
        .groups-page-meta { grid-template-columns: 1fr 1fr; }
        .groups-meta-invite { grid-column: 1 / -1; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'groups-page-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  window.openGroupCreateModal = openGroupCreateModal;
  window.openGroupJoinModal = openGroupJoinModal;
  window.openGroupPage = openGroupPage;
})();
