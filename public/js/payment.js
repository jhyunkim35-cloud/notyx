// Payment: usage quota, plan management, Toss payment flow.
// Depends on: constants.js (currentUser, db, DEVELOPER_EMAILS), ui.js (showToast).

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
  // Best-effort usage fetch — modal still works if Firestore is offline.
  let usage = { monthlyCount: 0, plan: 'free', planExpiry: null };
  try { usage = await getUserUsage(); } catch (_) {}

  let headline;
  let sub;
  // If the user is already on monthly, every entry point should congratulate
  // them rather than try to upsell — selling a plan they already have is
  // the most embarrassing failure mode for this modal.
  if (usage.plan === 'monthly') {
    headline = '✨ Notyx Pro 구독 중';
    const expiryStr = usage.planExpiry
      ? new Date(usage.planExpiry).toLocaleDateString('ko-KR')
      : '';
    sub = expiryStr
      ? `${expiryStr}까지 무제한 이용 가능합니다.`
      : '무제한 이용 중입니다.';
  } else if (context === 'voluntary') {
    headline = '💎 Notyx Pro로 업그레이드';
    sub = `무제한 노트 생성 · 강의당 ₩500 없음 · 현재 이번 달 ${usage.monthlyCount}/3회 사용`;
  } else if (context === 'low_remaining') {
    const remaining = Math.max(0, 3 - usage.monthlyCount);
    headline = `⚡ 무료 ${remaining}회 남았어요`;
    sub = '무제한 이용권으로 끊김 없이 분석하세요.';
  } else {
    // 'quota_exceeded' (default)
    headline = '🔒 무료 이용 한도 초과';
    sub = `이번 달 무료 3회(${usage.monthlyCount}/3)를 모두 사용했습니다.`;
  }

  // For monthly subscribers, hide the purchase buttons entirely — show
  // only the close button and a friendly thanks.
  const buttonsHtml = usage.plan === 'monthly' ? '' : `
      <div style="display:flex;flex-direction:column;gap:0.8rem;margin-bottom:1.5rem;">
        <button onclick="startPayment('single')" style="padding:1rem;border:2px solid var(--primary);border-radius:12px;background:transparent;color:var(--text);cursor:pointer;text-align:left;">
          <div style="font-weight:700;font-size:1rem;">📝 1회 이용권 — ₩500</div>
          <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.3rem;">이번 분석 1회만 결제</div>
        </button>
        <button onclick="startPayment('monthly')" style="padding:1rem;border:2px solid var(--secondary);border-radius:12px;background:var(--primary-dim);color:var(--text);cursor:pointer;text-align:left;">
          <div style="font-weight:700;font-size:1rem;">🎓 월정액 — ₩7,900/월</div>
          <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.3rem;">한 달간 무제한 이용</div>
        </button>
      </div>`;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <h2 style="margin:0 0 0.5rem;font-size:1.3rem;color:var(--text);">${headline}</h2>
      <p style="color:var(--text-muted);font-size:0.9rem;margin-bottom:1.5rem;">${sub}</p>
      ${buttonsHtml}
      <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:0.7rem;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer;font-size:0.85rem;">닫기</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function startPayment(plan) {
  // Close payment modal
  document.querySelector('div[style*="position:fixed"][style*="z-index:10000"]')?.remove();

  const amount = plan === 'monthly' ? 7900 : 500;
  const orderName = plan === 'monthly' ? 'Notyx 월정액' : 'Notyx 1회 이용권';
  const orderId = 'order_' + currentUser.uid.substring(0, 8) + '_' + Date.now();

  try {
    const tossPayments = TossPayments('test_ck_mBZ1gQ4YVXBjEx6651Wj8l2KPoqN');
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
  const plan = data.plan || 'free';
  const planExpiry = data.planExpiry || null;
  // Check if paid plan expired
  if (plan === 'monthly' && planExpiry && new Date(planExpiry) < now) {
    return { monthlyCount: count, plan: 'free', planExpiry: null };
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
  if (plan === 'monthly') {
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 1);
    await ref.set({ plan: 'monthly', planExpiry: expiry.toISOString(), lastOrderId: orderId }, { merge: true });
  } else if (plan === 'single') {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    await ref.set({ singlePurchases: firebase.firestore.FieldValue.increment(1), lastOrderId: orderId }, { merge: true });
  }
}
