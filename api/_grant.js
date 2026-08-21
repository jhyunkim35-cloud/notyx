// Shared payment fulfillment. Given a Toss-VERIFIED payment, grant the
// entitlement exactly once. Used by:
//   - api/toss.js          (browser confirm flow; uid from Firebase ID token)
//   - api/toss-webhook.js  (server-to-server fallback; uid from Toss customerKey)
//
// Idempotency: users/{uid}/paymentLog/{paymentKey} is the guard. Whichever path
// runs first seals it; the other becomes a no-op. This is what makes it safe for
// the confirm flow and the webhook to both fire for the same payment.
//
// SECURITY: callers must pass an amount that Toss itself confirmed (confirm
// response totalAmount, or a re-fetched payment's totalAmount) — never a
// client-supplied amount.

const { getAdmin } = require('./_firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { recordUsage } = require('./_usage');
const { FREE_MONTHLY_ANALYSES, hasProEntitlement } = require('./_billing-domain');

const LEGACY_MONTHLY_AMOUNT_KRW = 7900;

// STT per-use price for n thirty-minute blocks.
// MUST stay in sync with public/js/payment.js priceFor().
function sttPriceForUnits(n) {
  return n <= 5 ? 500 + n * 1000 : n === 6 ? 6600 : 6600 + (n - 6) * 1000;
}

// Map a Toss-verified amount to a plan, or null if it isn't a plan amount.
// Plan amounts (500, 7900) do not collide with any STT amount (1500, 2500, …).
function planForAmount(amount) {
  if (amount === LEGACY_MONTHLY_AMOUNT_KRW) return 'monthly';
  if (amount === 500) return 'single';
  return null;
}

function currentMonthKey(now) {
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

// Subscription state is authoritative for recurring Pro. The legacy monthly
// projection is consulted only when no subscription document exists.
function resolveAnalysisEntitlement({ subscription, user = {}, now = new Date() }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const monthKey = currentMonthKey(now);
  const usage = user && user.usage && typeof user.usage === 'object' ? user.usage : {};
  const monthCount = Number.isSafeInteger(usage[monthKey]) ? usage[monthKey] : 0;

  if (subscription !== null && subscription !== undefined && hasProEntitlement(subscription, now)) {
    return { allowed: true, slot: 'monthly', monthKey };
  }

  if (subscription === null || subscription === undefined) {
    const expiry = typeof user.planExpiry === 'string' ? new Date(user.planExpiry) : null;
    if (user.plan === 'monthly' && expiry && !Number.isNaN(expiry.getTime())
      && expiry.toISOString() === user.planExpiry && expiry > now) {
      return { allowed: true, slot: 'monthly', monthKey };
    }
  }

  if (monthCount < FREE_MONTHLY_ANALYSES) return { allowed: true, slot: 'free', monthKey };
  if (Number.isSafeInteger(user.singlePurchases) && user.singlePurchases > 0) {
    return { allowed: true, slot: 'single', monthKey };
  }
  return { allowed: false, reason: 'quota_exceeded', monthCount };
}

// Returns { ok:true, ... } on success or idempotent hit;
//         { ok:false, status, message } on rejection.
async function grantEntitlement({ uid, kind, minutes, paymentKey, orderId, verifiedAmount }) {
  if (!uid || !paymentKey) return { ok: false, status: 400, message: 'missing uid/paymentKey' };

  const admin = getAdmin();
  const db = admin.firestore();
  const idemRef = db.collection('users').doc(uid).collection('paymentLog').doc(paymentKey);

  // Idempotency guard — already fulfilled? return the cached record, no re-grant.
  try {
    const snap = await idemRef.get();
    if (snap.exists) return { ok: true, idempotent: true, ...snap.data() };
  } catch (e) {
    console.warn('[grant] idempotency precheck skipped:', e.message);
  }

  // ── STT per-use entitlement ──────────────────────────────────────────
  if (kind === 'sttEntitlement') {
    const n = Math.max(1, Math.ceil((Number(minutes) || 0) / 30));
    const expectedPrice = sttPriceForUnits(n);
    if (verifiedAmount !== expectedPrice) {
      console.error('[grant] STT amount mismatch:', verifiedAmount, 'expected', expectedPrice);
      return { ok: false, status: 400, message: 'Amount mismatch for STT entitlement' };
    }
    try {
      await db.collection('users').doc(uid)
        .collection('sttEntitlements').doc(paymentKey)
        .set({
          minutes: n * 30,
          priceKRW: verifiedAmount,
          paidAt: FieldValue.serverTimestamp(),
          consumed: false,
          consumedAt: null,
          transcriptId: null,
          orderId,
          paymentKey,
        });
    } catch (e) {
      console.error('[grant] sttEntitlement write failed:', e);
      return { ok: false, status: 500, message: 'Entitlement creation failed: ' + e.message };
    }
    try {
      await recordUsage({ uid, kind: 'sttPayment', increments: { sttPaymentCount: 1, sttPaymentTotalKRW: verifiedAmount } });
    } catch (e) { console.error('[usage] stt payment record failed:', e.message); }
    try {
      await idemRef.set({
        kind: 'sttEntitlement', orderId, paymentKey,
        priceKRW: verifiedAmount, minutes: n * 30,
        processedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('[grant] paymentLog seal failed:', e.message); }
    return { ok: true, minutes: n * 30, priceKRW: verifiedAmount };
  }

  // ── Plan purchase (monthly / single) ─────────────────────────────────
  // Plan is derived from the Toss-verified amount, never a client/url value.
  const verifiedPlan = planForAmount(verifiedAmount);
  if (!verifiedPlan) {
    console.error('[grant] unrecognized amount:', verifiedAmount);
    return { ok: false, status: 400, message: 'Unrecognized payment amount: ' + verifiedAmount };
  }
  try {
    const userRef = db.collection('users').doc(uid);
    if (verifiedPlan === 'monthly') {
      // Stack onto remaining time: if the current plan hasn't expired yet,
      // extend from its expiry; otherwise start from now. (Idempotency guard
      // above means a given paymentKey can only stack once.)
      let base = new Date();
      try {
        const cur = await userRef.get();
        const curExpiry = cur.exists ? cur.data().planExpiry : null;
        if (curExpiry) {
          const d = new Date(curExpiry);
          if (!isNaN(d.getTime()) && d > base) base = d;
        }
      } catch (e) {
        console.warn('[grant] planExpiry read for stacking skipped:', e.message);
      }
      const expiry = new Date(base);
      expiry.setDate(expiry.getDate() + 30);
      await userRef.set({
        plan: 'monthly',
        planExpiry: expiry.toISOString(),
        lastOrderId: orderId,
        lastPaymentAt: new Date().toISOString(),
      }, { merge: true });
    } else {
      await userRef.set({
        singlePurchases: FieldValue.increment(1),
        lastOrderId: orderId,
        lastPaymentAt: new Date().toISOString(),
      }, { merge: true });
    }
  } catch (e) {
    console.error('[grant] plan write failed:', e);
    return { ok: false, status: 500, message: 'Plan update failed: ' + e.message };
  }
  try {
    await recordUsage({ uid, kind: 'payment', increments: { paymentCount: 1, paymentTotalKRW: verifiedAmount } });
  } catch (e) { console.error('[usage] payment record failed:', e.message); }
  try {
    await idemRef.set({
      kind: verifiedPlan, orderId, paymentKey,
      priceKRW: verifiedAmount,
      processedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[grant] paymentLog seal failed:', e.message); }
  return { ok: true, plan: verifiedPlan };
}

module.exports = { grantEntitlement, sttPriceForUnits, planForAmount, resolveAnalysisEntitlement };
