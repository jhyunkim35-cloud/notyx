// Payment: usage quota, one-time payments, and Toss recurring billing.
// Depends on: constants.js (currentUser, db, DEVELOPER_EMAILS), ui.js (showToast).

const PRO_MONTHLY_AMOUNT_KRW = 8900;
const PAYMENT_CONFIG_ENDPOINT = '/api/payment-config';
const BILLING_ENDPOINT = '/api/billing';
let _paymentConfigPromise = null;
let _billingStatusPromise = null;
let _billingStatus = null;
let _billingStatusUid = null;

function paymentError(message, code) {
  const error = new Error(message || '결제 요청을 처리할 수 없습니다.');
  error.code = code || 'payment_error';
  return error;
}

async function getPaymentConfig() {
  if (!_paymentConfigPromise) {
    _paymentConfigPromise = fetch(PAYMENT_CONFIG_ENDPOINT, { cache: 'no-store' })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body || typeof body !== 'object') throw paymentError('결제 설정을 불러오지 못했습니다.', 'config_error');
        return body;
      })
      .catch(error => {
        _paymentConfigPromise = null;
        throw error;
      });
  }
  return _paymentConfigPromise;
}

async function billingRequest(action, fields = {}) {
  if (!currentUser || typeof currentUser.getIdToken !== 'function') throw paymentError('로그인이 필요합니다.', 'unauthorized');
  const idToken = await currentUser.getIdToken();
  const response = await fetch(BILLING_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify({ action, ...fields }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = paymentError(body.error?.message || '정기결제 요청을 처리하지 못했습니다.', body.error?.code);
    error.response = body;
    throw error;
  }
  return body;
}

function billingDateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ko-KR');
}

function billingActionButton(label, action, variant = 'ny-btn-secondary') {
  return `<button type="button" class="ny-btn ${variant}" data-billing-action="${action}" onclick="${action}()">${label}</button>`;
}

function getStatusPresentation(subscription, legacy) {
  if (legacy && legacy.status === 'active_nonrenewing') {
    return {
      showUpgrade: true,
      title: '기존 월정액 이용 중',
      html: `기존 월정액은 <strong>갱신되지 않는</strong> 이용권입니다. ${billingDateLabel(legacy.accessEndsAt)}까지 이용할 수 있습니다. 새 구독은 월 <strong>8,900원</strong>입니다.`,
    };
  }
  if (!subscription || subscription.status === 'free') {
    return {
      showUpgrade: true,
      title: 'Notyx Pro로 업그레이드',
      html: '매달 <strong>무료 3회</strong>까지 이용할 수 있으며, 이후 1회 이용권은 <strong>500원</strong>, Pro는 <strong>8,900원/월</strong>입니다.',
    };
  }
  if (subscription.paymentReview === 'in_progress') {
    return { showUpgrade: false, title: '결제 결과 확인 중', html: '결제 결과 확인 중입니다. 잠시 후 상태를 다시 확인해 주세요.' };
  }
  if (subscription.paymentReview === 'manual_review') {
    return { showUpgrade: false, title: '수동 확인 필요', html: '결제 결과를 수동 확인 중입니다. 확인이 끝날 때까지 구독 상태를 변경할 수 없습니다.' };
  }
  if (subscription.status === 'past_due') {
    const retryAt = billingDateLabel(subscription.nextRetryAt);
    return {
      showUpgrade: false,
      title: '결제수단 확인 필요',
      html: `현재 Pro 이용은 유지됩니다. ${retryAt ? `<strong>${retryAt}</strong>에 다음 재시도를 진행합니다.` : '다음 재시도를 준비 중입니다.'} 결제수단을 확인해 주세요.`,
    };
  }
  if (subscription.status === 'expired' || subscription.status === 'canceled') {
    return {
      showUpgrade: true,
      title: 'Pro 이용 종료',
      html: 'Pro 이용이 종료되었습니다. 계속 이용하려면 결제수단을 <strong>다시 등록</strong>해 주세요.',
    };
  }
  if (subscription.status === 'incomplete') {
    return {
      showUpgrade: true,
      title: '결제 등록을 완료해 주세요',
      html: subscription.manualRetryRequired
        ? '첫 결제가 완료되지 않았습니다. 결제수단을 다시 확인하거나 <strong>다시 등록</strong>해 주세요.'
        : '결제수단 등록을 진행하면 Pro를 이용할 수 있습니다.',
    };
  }
  if (subscription.cancelAtPeriodEnd) {
    return {
      showUpgrade: false,
      title: 'Pro 해지 예약됨',
      html: `${billingDateLabel(subscription.accessEndsAt)}까지 이용할 수 있습니다. 해지는 현재 이용기간 종료 시 적용되며 자동 환불되지 않습니다. 종료 전에는 구독을 <strong>재개</strong>할 수 있습니다.`,
    };
  }
  return {
    showUpgrade: false,
    title: 'Notyx Pro 구독 중',
    html: `${subscription.nextBillingAt ? `<strong>다음 결제일 ${billingDateLabel(subscription.nextBillingAt)}</strong>` : '다음 결제일을 확인 중입니다.'} · 월 ${PRO_MONTHLY_AMOUNT_KRW.toLocaleString('ko-KR')}원 자동 결제`,
  };
}

function shouldHideUpgradeButtons(subscription) {
  return Boolean(subscription && (subscription.status === 'active' || subscription.status === 'past_due'));
}

function updateUpgradeButtons(subscription) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  const hidden = shouldHideUpgradeButtons(subscription);
  document.querySelectorAll('[data-upgrade-button], #sidebarUpgradeBtn').forEach(button => {
    button.hidden = hidden;
    button.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  });
}

function currentBillingUid() {
  return typeof currentUser !== 'undefined' && currentUser && typeof currentUser.uid === 'string'
    ? currentUser.uid
    : null;
}

function clearBillingStatusCache() {
  _billingStatusPromise = null;
  _billingStatus = null;
  _billingStatusUid = null;
}

async function getBillingStatus(force = false) {
  const uid = currentBillingUid();
  if (_billingStatusUid !== uid) {
    clearBillingStatusCache();
    _billingStatusUid = uid;
  }
  if (!uid) throw paymentError('로그인이 필요합니다.', 'unauthorized');
  if (force) {
    _billingStatusPromise = null;
    _billingStatus = null;
  }
  if (!_billingStatusPromise) {
    _billingStatusPromise = billingRequest('status')
      .then(result => {
        if (_billingStatusUid === uid && currentBillingUid() === uid) {
          _billingStatus = result;
          updateUpgradeButtons(result.subscription);
        }
        return result;
      })
      .catch(error => {
        if (_billingStatusUid === uid) _billingStatusPromise = null;
        throw error;
      });
  }
  return _billingStatusPromise;
}

function billingStatusActions(status) {
  const subscription = status && status.subscription;
  if (!subscription) return `<div class="ny-payment-actions">${billingActionButton('Pro 시작하기', 'startProSubscription', 'ny-btn-primary')}</div>`;
  if (subscription.status === 'active' && subscription.paymentReview === 'none') {
    if (subscription.cancelAtPeriodEnd) return `<div class="ny-payment-actions">${billingActionButton('구독 재개', 'resumeSubscription', 'ny-btn-primary')}</div>`;
    return `<div class="ny-payment-actions">${billingActionButton('기간 종료 시 해지', 'cancelSubscription')}</div>`;
  }
  if (subscription.status === 'past_due') return `<div class="ny-payment-actions">${billingActionButton('결제수단 확인 후 재시도', 'retryBilling', 'ny-btn-primary')}</div>`;
  if (subscription.status === 'expired' || subscription.status === 'canceled' || subscription.status === 'incomplete') {
    return `<div class="ny-payment-actions">${billingActionButton('결제수단 다시 등록', 'startProSubscription', 'ny-btn-primary')}</div>`;
  }
  return '';
}

async function startProSubscription() {
  document.querySelector('.ny-payment-overlay')?.remove();
  if (!currentUser) { showToast('로그인이 필요합니다.'); return; }
  try {
    const [config, prepared] = await Promise.all([getPaymentConfig(), billingRequest('prepare')]);
    if (!config.billingClientKey) throw paymentError('현재 정기결제를 이용할 수 없습니다.', 'billing_unavailable');
    const tossPayments = TossPayments(config.billingClientKey);
    const payment = tossPayments.payment({ customerKey: prepared.customerKey });
    await payment.requestBillingAuth({
      method: 'CARD',
      customerEmail: currentUser.email,
      customerName: currentUser.displayName || '사용자',
      successUrl: prepared.successUrl,
      failUrl: prepared.failUrl,
    });
  } catch (error) {
    if (error.code === 'USER_CANCEL') return;
    showToast('❌ 정기결제 등록 실패: ' + error.message);
  }
}

async function activateBilling(authKey, customerKey) {
  return billingRequest('activate', { authKey, customerKey });
}

async function performBillingAction(action) {
  try {
    const result = await billingRequest(action);
    _billingStatusPromise = null;
    await getBillingStatus(true).catch(() => null);
    if (result.outcome === 'pending') showToast('결제 결과를 확인 중입니다. 잠시 후 다시 확인해 주세요.');
    else if (result.outcome === 'active') showSuccessToast('✅ Notyx Pro가 활성화되었습니다.');
    else showToast('요청이 처리되었습니다.');
    return result;
  } catch (error) {
    const response = error.response;
    if (response && response.subscription) {
      _billingStatus = { subscription: response.subscription, legacy: null };
      updateUpgradeButtons(response.subscription);
    }
    showToast('❌ ' + error.message);
    return null;
  }
}

function cancelSubscription() { return performBillingAction('cancel'); }
function resumeSubscription() { return performBillingAction('resume'); }
function retryBilling() { return performBillingAction('retry'); }

window.NotyxBillingUI = Object.freeze({
  getStatusPresentation,
  shouldHideUpgradeButtons,
  getBillingStatus,
  clearBillingStatusCache,
});

/* ═══════════════════════════════════════════════
   STT per-use pricing
═══════════════════════════════════════════════ */

function priceFor(audioMinutes) {
  const n = Math.max(1, Math.ceil(audioMinutes / 30));
  const minutes = n * 30;
  let priceKRW;
  if (n <= 5) {
    priceKRW = 500 + n * 1000;
  } else if (n === 6) {
    priceKRW = 6600;
  } else {
    priceKRW = 6600 + (n - 6) * 1000;
  }
  return { minutes, priceKRW };
}

function payForSttEntitlement(audioMinutes) {
  return new Promise(function (resolve, reject) {
    var _ref = priceFor(audioMinutes);
    var minutes = _ref.minutes;
    var priceKRW = _ref.priceKRW;
    var orderId = 'stt_' + currentUser.uid.substring(0, 8) + '_' + Date.now();

    var popupUrl = window.location.origin + '/stt-pay.html'
      + '?orderId=' + encodeURIComponent(orderId)
      + '&amount=' + priceKRW
      + '&minutes=' + minutes
      + '&ck=' + encodeURIComponent(currentUser.uid)
      + '&email=' + encodeURIComponent(currentUser.email || '')
      + '&name=' + encodeURIComponent(currentUser.displayName || '사용자');

    var popup = window.open(popupUrl, 'stt_payment_popup', 'width=700,height=600,scrollbars=yes');
    if (!popup) {
      reject(new Error('팝업이 차단되었습니다. 팝업 차단을 해제해주세요.'));
      return;
    }

    var settled = false;

    function cleanup() {
      window.removeEventListener('message', onMessage);
      clearInterval(popupCheckInterval);
    }

    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      var d = event.data || {};
      if (d.orderId !== orderId) return;

      if (d.type === 'stt_payment_done') {
        if (settled) return;
        settled = true;
        cleanup();
        // Get fresh Firebase ID token — backend verifies and uses it
        // as the canonical uid; we no longer trust currentUser.uid alone.
        currentUser.getIdToken().then(function (idToken) {
          return fetch('/api/toss', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + idToken,
            },
            body: JSON.stringify({
              paymentKey: d.paymentKey,
              orderId: orderId,
              amount: d.amount,
              kind: 'sttEntitlement',
              minutes: minutes,
            }),
          });
        }).then(function (r) { return r.json(); }).then(function (result) {
          if (result.success) resolve({ minutes: minutes, priceKRW: priceKRW });
          else reject(new Error(result.message || '결제 확인 실패'));
        }).catch(reject);

      } else if (d.type === 'stt_payment_cancelled' || d.type === 'stt_payment_error') {
        if (settled) return;
        settled = true;
        cleanup();
        var err = new Error(d.type === 'stt_payment_cancelled' ? 'USER_CANCEL' : (d.message || '결제 실패'));
        err.code = d.type === 'stt_payment_cancelled' ? 'USER_CANCEL' : 'PAYMENT_ERROR';
        reject(err);
      }
    }

    window.addEventListener('message', onMessage);

    var popupCheckInterval = setInterval(function () {
      if (popup.closed && !settled) {
        settled = true;
        cleanup();
        var err = new Error('USER_CANCEL');
        err.code = 'USER_CANCEL';
        reject(err);
      }
    }, 500);
  });
}

// R5: showPaymentModal accepts a context so the same modal can serve
// (a) hard quota-exceeded paths (api/claude.js bounces the request back),
// (b) voluntary upgrades from the sidebar Pro button, and
// (c) "you're almost out" nudges before the user is blocked.
// We read getUserUsage() asynchronously so the headline can reflect the
// real monthlyCount/plan instead of the hardcoded "3회 모두 사용" string
// that fired even when the user had 0/3.
async function showPaymentModal(context = 'quota_exceeded') {
  let usage = { monthlyCount: 0, plan: 'free' };
  let status = _billingStatus;
  try { usage = await getUserUsage(); } catch (_) {}
  try { status = await getBillingStatus(); } catch (_) {}
  const presentation = getStatusPresentation(status && status.subscription, status && status.legacy);
  const headline = presentation.title || (context === 'low_remaining' ? '무료 이용 안내' : '결제 안내');
  const sub = presentation.html || `이번 달 무료 3회(${usage.monthlyCount}/3)를 모두 사용했습니다.`;
  const buttonsHtml = presentation.showUpgrade ? `
      <div class="ny-payment-options">
        <button type="button" class="ny-payment-option" onclick="startPayment('single')">
          <span class="ny-payment-option-title">1회 이용권 — ₩500</span>
          <span class="ny-payment-option-detail">이번 분석 1회만 결제</span>
        </button>
        <button type="button" class="ny-payment-option ny-payment-option-primary" onclick="startProSubscription()">
          <span class="ny-payment-option-title">Notyx Pro — ₩8,900/월</span>
          <span class="ny-payment-option-detail">부가세 포함 · 매월 자동 결제 · 현재 이용기간 종료 시 해지</span>
        </button>
      </div>` : billingStatusActions(status);

  const overlay = document.createElement('div');
  overlay.className = 'ny-payment-overlay';
  overlay.innerHTML = `
    <div class="ny-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="ny-payment-title">
      <h2 id="ny-payment-title" class="ny-payment-title">${headline}</h2>
      <p class="ny-payment-copy">${sub}</p>
      ${buttonsHtml}
      <button type="button" class="ny-btn ny-btn-ghost ny-payment-close" onclick="this.closest('.ny-payment-overlay').remove()">닫기</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('button')?.focus();
}

async function startPayment(plan) {
  // Close payment modal
  document.querySelector('.ny-payment-overlay')?.remove();

  if (plan === 'monthly') return startProSubscription();

  const amount = 500;
  const orderName = 'Notyx 1회 이용권';
  const orderId = 'order_' + currentUser.uid.substring(0, 8) + '_' + Date.now();

  try {
    const config = await getPaymentConfig();
    if (!config.oneTimeClientKey) throw paymentError('현재 1회 결제를 이용할 수 없습니다.', 'payment_unavailable');
    const tossPayments = TossPayments(config.oneTimeClientKey);
    const payment = tossPayments.payment({ customerKey: currentUser.uid });

    await payment.requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: amount },
      orderId,
      orderName,
      customerEmail: currentUser.email,
      customerName: currentUser.displayName || '사용자',
      successUrl: window.location.origin + '?payment=success&plan=' + plan + '&orderId=' + orderId,
      failUrl: window.location.origin + '?payment=fail',
    });
  } catch (e) {
    if (e.code === 'USER_CANCEL') return;
    showToast('❌ 결제 실패: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════
   Usage quota and plan functions (moved from firestore_sync.js)
═══════════════════════════════════════════════ */

async function getUserUsage() {
  if (!currentUser) return { monthlyCount: 0, plan: 'free', planExpiry: null };
  const ref = db.collection('users').doc(currentUser.uid);
  const doc = await ref.get();
  if (!doc.exists) return { monthlyCount: 0, plan: 'free', planExpiry: null };
  const data = doc.data();
  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const count = (data.usage && data.usage[monthKey]) || 0;
  let plan = 'free';
  let planExpiry = null;
  try {
    const status = await getBillingStatus();
    if (status.subscription && (status.subscription.status === 'active' || status.subscription.status === 'past_due')) plan = 'monthly';
    if (status.legacy && status.legacy.status === 'active_nonrenewing') {
      plan = 'monthly';
      planExpiry = status.legacy.accessEndsAt;
    }
  } catch (_) {
    // The server remains authoritative; this fallback only keeps the legacy UI usable offline.
    plan = data.plan || 'free';
    planExpiry = data.planExpiry || null;
    if (plan === 'monthly' && planExpiry && new Date(planExpiry) < now) {
      plan = 'free';
      planExpiry = null;
    }
  }
  return { monthlyCount: count, plan, planExpiry };
}

async function incrementUsage() {
  // C1: Deprecated client-side increment. Usage is now tracked server-side
  // in api/claude.js (see billOnSuccess in the proxy handler) so the user
  // can't bypass billing by skipping this call. Kept as a no-op in case
  // any future code path still calls it; safe to delete entirely once
  // verified there are no callers.
  if (!currentUser) return;
}

async function canAnalyze() {
  if (DEVELOPER_EMAILS.includes(currentUser?.email)) return { allowed: true, reason: '' };
  const usage = await getUserUsage();
  if (usage.plan === 'monthly') return { allowed: true, reason: '' };
  if (usage.monthlyCount < 3) return { allowed: true, reason: '', remaining: 3 - usage.monthlyCount };
  return { allowed: false, reason: 'monthly_limit', monthlyCount: usage.monthlyCount };
}

async function setPaidPlan(plan, orderId) {
  if (!currentUser) return;
  const ref = db.collection('users').doc(currentUser.uid);
  if (plan === 'single') {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    await ref.set({ singlePurchases: firebase.firestore.FieldValue.increment(1), lastOrderId: orderId }, { merge: true });
  }
}
