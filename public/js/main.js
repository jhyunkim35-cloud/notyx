// App bootstrap: auth listener, init, initial display state, debug panel ticker, payment callback.
// MUST load last — depends on all other /js/ files.

let _authResolved = false;
let _appViewBooted = false;

// Single entry point for "auth state is now known". Everything that must not
// run before auth resolves hangs off this. Kept as a named global (not an
// inline arrow) so the boot sequence can be exercised directly in tests.
function applyAuthState(user) {
  _authResolved = true;
  currentUser = user;
  updateAuthUI();
  if (user) {
    // Pick the initial app view ONCE, after auth resolved. Doing this at page
    // load (as we used to) selected 'new' for logged-out visitors, which
    // rendered the whole app shell behind the landing screen.
    if (!_appViewBooted) { _appViewBooted = true; bootAppView(); }
  } else {
    _appViewBooted = false;
  }
}

// Initial view for an authenticated user: home if they have notes, new if not.
async function bootAppView() {
  try {
    const notes = await getAllNotesFS();
    switchView(notes.length > 0 ? 'home' : 'new');
  } catch (_) {
    switchView('new');
  }
}

auth.onAuthStateChanged(applyAuthState);

/* ═══════════════════════════════════════════════
   Init — load saved notes on page load
═══════════════════════════════════════════════ */
(async function init() {
  // Load theme preference. The button shows the icon for the OPPOSITE
  // theme — in light mode the button shows a moon (click → go dark),
  // and vice versa. This mirrors what toggleTheme does at runtime.
  if (localStorage.getItem('theme') !== 'dark') {
    document.documentElement.classList.add('light');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.innerHTML = '<i data-lucide="moon"></i>';
      if (typeof window.mountLucideIcons === 'function') window.mountLucideIcons();
    }
  }
})();

// Initial state: keep all top-level views hidden until the first auth
// callback fires. Previously we force-showed landingView here, which made a
// logged-in user flash the landing/login screen for a few hundred ms while
// Firebase restored the session from IndexedDB — it looked like "not logged
// in" until it suddenly resolved ("logged in out of nowhere"). Let
// onAuthStateChanged decide instead, so there is no flash either way.
document.documentElement.classList.add('ny-logged-out');
document.getElementById('sidebar').style.display = 'none';
document.getElementById('homeView').style.display = 'none';
document.getElementById('landingView').style.display = 'none';
// Safety net: if Firebase never initializes (SDK load / network failure) the
// auth callback never fires and the user would stare at a blank page. After
// 3s with no resolution, fall back to showing the landing/login screen.
setTimeout(() => {
  if (!_authResolved) document.getElementById('landingView').style.display = '';
}, 3000);

// L1: keep interval handle so we can clean it up on unload (defensive — also lets us throttle when hidden)
const _debugPanelInterval = setInterval(() => {
  const panel = document.getElementById('debugPanel');
  if (panel && panel.style.display === 'flex') {
    const c = document.getElementById('debugLogContent');
    if (c) {
      c.textContent = _debugLog.join('\n');
      c.scrollTop = c.scrollHeight;
    }
  }
}, 1000);
window.addEventListener('beforeunload', () => clearInterval(_debugPanelInterval));

// Handle Toss payment callback
(async function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get('payment');
  if (!paymentStatus) return;

  // Clean only payment params from URL — preserve `join` and any future
  // deeplinks. paymentKey never leaks to history because we strip it here.
  try {
    const url = new URL(window.location.href);
    ['payment', 'paymentKey', 'orderId', 'amount', 'plan'].forEach(k => url.searchParams.delete(k));
    const q = url.searchParams.toString();
    window.history.replaceState({}, '', url.pathname + (q ? '?' + q : '') + url.hash);
  } catch (_) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (paymentStatus === 'success') {
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = params.get('amount');
    const plan = params.get('plan'); // kept for diagnostics; not used for state

    try {
      // P1-2: bound the auth wait with a timeout. If the user's session
      // expired while they sat on the Toss checkout page, the old
      // `onAuthStateChanged(u => if(u) resolve())` never fired — it
      // resolves only on a *logged-in* user, so a null callback left this
      // await hanging forever. Toss charged the card but we never confirmed
      // the payment and the user just saw a dead spinner. Resolve to a flag
      // and time out (8s) so we always surface actionable feedback. The
      // server's paymentLog idempotency makes a later retry safe.
      const authed = await new Promise(resolve => {
        if (currentUser) { resolve(true); return; }
        let settled = false;
        let unsub = null;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          if (typeof unsub === 'function') { try { unsub(); } catch (_) {} }
          resolve(v);
        };
        unsub = auth.onAuthStateChanged(u => { if (u) finish(true); });
        setTimeout(() => finish(false), 8000);
      });

      if (!authed) {
        console.error('[payment] auth wait timed out; payment unconfirmed. orderId=', orderId);
        showToast('⚠️ 결제는 완료됐지만 로그인이 만료되어 자동 확인에 실패했습니다. 다시 로그인 후 새로고침해 주세요. 문제가 계속되면 문의 시 주문번호를 알려주세요: ' + (orderId || '알 수 없음'));
        return;
      }

      // Get fresh Firebase ID token — backend now requires this and
      // ignores any uid in the body. Without the header the server
      // would reject the request with 401 auth_required.
      const idToken = await currentUser.getIdToken();

      // Verify payment on server — server derives plan from Toss-verified amount and writes Firestore
      const res = await fetch('/api/toss', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + idToken,
        },
        body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) })
      });
      const result = await res.json();

      if (result.success) {
        const planLabel = result.plan === 'monthly' ? '월간 무제한' : '단건';
        showSuccessToast(`✅ 결제 완료! ${planLabel} 플랜이 활성화되었습니다.`);
        if (typeof renderHomeView === 'function') await renderHomeView();
      } else {
        showToast('❌ 결제 확인 실패: ' + (result.message || ''));
      }
    } catch (e) {
      showToast('❌ 결제 확인 오류: ' + e.message);
    }
  } else if (paymentStatus === 'fail') {
    showToast('❌ 결제가 취소되었습니다.');
  }
})();

// ── Invite param helpers (fragment-first, query fallback) ──────────────────
// New invite links carry the token in the URL FRAGMENT (#join=<token>) so
// the secret never leaves the browser: fragments are not sent to the server
// (no server/CDN log exposure) and are stripped from Referer headers.
// Old links used query params (?join=<token>) — we keep reading those for
// backward compat so already-shared links don't break.
function readInviteParam(name) {
  try {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get(name);
    if (fromHash) return fromHash;
  } catch (_) { /* malformed hash: fall through to query */ }
  return new URLSearchParams(window.location.search).get(name);
}

// Strip the param from BOTH hash and query so a refresh doesn't re-trigger
// the modal, preserving any other params/fragments (future deeplinks).
function stripInviteParam(name) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    hashParams.delete(name);
    const q = url.searchParams.toString();
    const h = hashParams.toString();
    window.history.replaceState({}, '', url.pathname + (q ? '?' + q : '') + (h ? '#' + h : ''));
  } catch (_) { /* old browsers without URL constructor: ignore */ }
}

// Handle invite link (#join=<token>, legacy ?join=): wait for auth, then
// open join modal. Runs AFTER the payment IIFE — by the time we get here
// payment has already cleaned its own params from the URL, but `join`
// survives because payment's replaceState was triggered only on
// `?payment=...` and preserves url.hash. We grab `join` fresh.
(async function handleJoinCallback() {
  const token = readInviteParam('join');
  if (!token) return;

  // Wait for auth — user may still need to click "Google 로그인"
  await new Promise(resolve => {
    if (currentUser) resolve();
    else auth.onAuthStateChanged(u => { if (u) resolve(); });
  });

  stripInviteParam('join');

  if (typeof openGroupJoinModal === 'function') {
    openGroupJoinModal({ token });
  } else {
    console.error('[main] openGroupJoinModal not available — groups.js failed to load');
    if (typeof showToast === 'function') showToast('초대 링크 처리 실패 — 새로고침 후 다시 시도해주세요');
  }
})();

// Handle direct group-page link (?group=<gid>): wait for auth, then open page.
// Used by:
//   - "그룹 페이지 열기" buttons in invite-result and join-success panels
//   - future "내 그룹" sidebar entries that list past groups
//   - any external bookmark / pasted URL
(async function handleGroupPageCallback() {
  const params = new URLSearchParams(window.location.search);
  const gid = params.get('group');
  if (!gid) return;

  await new Promise(resolve => {
    if (currentUser) resolve();
    else auth.onAuthStateChanged(u => { if (u) resolve(); });
  });

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('group');
    const q = url.searchParams.toString();
    window.history.replaceState({}, '', url.pathname + (q ? '?' + q : '') + url.hash);
  } catch (_) {}

  if (typeof openGroupPage === 'function') {
    openGroupPage({ groupId: gid });
  } else {
    console.error('[main] openGroupPage not available');
    if (typeof showToast === 'function') showToast('그룹 페이지 로드 실패');
  }
})();

// Handle study-room invite link (#roomJoin=<token>, legacy ?roomJoin=):
// wait for auth, then open the study-room join modal. Separate param from
// join because group and room tokens have the same shape but live in
// different collections — we don't want a stale group token to accidentally
// route to room-join.
(async function handleStudyRoomJoinCallback() {
  const token = readInviteParam('roomJoin');
  if (!token) return;

  await new Promise(resolve => {
    if (currentUser) resolve();
    else auth.onAuthStateChanged(u => { if (u) resolve(); });
  });

  stripInviteParam('roomJoin');

  if (typeof openStudyRoomJoinModal === 'function') {
    openStudyRoomJoinModal({ token });
  } else {
    console.error('[main] openStudyRoomJoinModal not available — study_rooms.js failed to load');
    if (typeof showToast === 'function') showToast('초대 링크 처리 실패 — 새로고침 후 다시 시도해주세요');
  }
})();

// Handle direct study-room page link (?studyRoom=<rid>): wait for auth,
// then open the page. Used by the "→ 룸 페이지로 이동" buttons inside the
// create/join success panels and by any externally pasted/bookmarked URL.
(async function handleStudyRoomPageCallback() {
  const params = new URLSearchParams(window.location.search);
  const rid = params.get('studyRoom');
  if (!rid) return;

  await new Promise(resolve => {
    if (currentUser) resolve();
    else auth.onAuthStateChanged(u => { if (u) resolve(); });
  });

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('studyRoom');
    const q = url.searchParams.toString();
    window.history.replaceState({}, '', url.pathname + (q ? '?' + q : '') + url.hash);
  } catch (_) {}

  if (typeof openStudyRoomPage === 'function') {
    openStudyRoomPage({ roomId: rid });
  } else {
    console.error('[main] openStudyRoomPage not available');
    if (typeof showToast === 'function') showToast('스터디 룸 페이지 로드 실패');
  }
})();
