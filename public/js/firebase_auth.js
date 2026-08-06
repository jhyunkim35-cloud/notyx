// Firebase auth UI helpers: update DOM on login/logout, Google sign-in, sign-out.
// Depends on: constants.js (currentUser, auth), ui.js (showToast, showSuccessToast), firestore_sync.js (syncNotesOnLogin), home_view.js (renderHomeView).

function updateAuthUI() {
  const loginBtn = document.getElementById('loginBtn');
  const userInfo = document.getElementById('userInfo');
  const userName = document.getElementById('userName');
  const userAvatar = document.getElementById('userAvatar');
  const landingView = document.getElementById('landingView');
  const sidebar = document.getElementById('sidebar');
  const homeView = document.getElementById('homeView');
  const newNoteView = document.getElementById('newNoteView');

  if (currentUser) {
    document.documentElement.classList.remove('ny-logged-out');
    loginBtn.style.display = 'none';
    userInfo.style.display = 'flex';
    userName.textContent = currentUser.displayName || currentUser.email;
    userAvatar.src = currentUser.photoURL || '';
    landingView.style.display = 'none';
    // Landing is being hidden — stop the entrance motion here so ScrollTrigger instances don't leak across shell teardown/rebuild.
    if (window.nyLandingMotion) window.nyLandingMotion.stop();
    sidebar.style.display = '';
    // Which view to show is decided by bootAppView()/switchView() in main.js,
    // gated on auth. Guessing here raced with it and flashed an empty home.
    syncNotesOnLogin().then(() => renderHomeView());
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    const sidebarUserName = document.getElementById('sidebarUserName');
    if (sidebarAvatar) sidebarAvatar.src = currentUser.photoURL || '';
    if (sidebarUserName) sidebarUserName.textContent = currentUser.displayName || currentUser.email;
  } else {
    document.documentElement.classList.add('ny-logged-out');
    loginBtn.style.display = '';
    userInfo.style.display = 'none';
    landingView.style.display = '';
    // Landing is actually becoming visible here — the only point where the entrance motion should start.
    if (window.nyLandingMotion) window.nyLandingMotion.start();
    sidebar.style.display = 'none';
    homeView.style.display = 'none';
    newNoteView.style.display = 'none';
    const transcriptsView = document.getElementById('transcriptsView');
    if (transcriptsView) transcriptsView.style.display = 'none';
  }
}

async function loginWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  } catch (e) {
    // popup-closed-by-user / cancelled-popup-request are normal user actions
    // (they dismissed the chooser, or a rapid second click superseded the
    // first), so stay silent. Anything else is a real failure we want to
    // diagnose — log the auth error code and report to Sentry so intermittent
    // popup/cookie failures leave a trace instead of vanishing without a clue.
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    console.error('[loginWithGoogle] sign-in failed:', e.code, e.message);
    if (typeof Sentry !== 'undefined' && Sentry.captureException) {
      Sentry.captureException(e, { tags: { area: 'auth-login', authCode: e.code } });
    }
    showToast('❌ 로그인 실패: ' + e.message);
  }
}

async function logout() {
  await auth.signOut();
  showSuccessToast('로그아웃 완료');
}
