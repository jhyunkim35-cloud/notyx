// Toss Payments webhook (server-to-server fallback).
//
// WHY: the browser confirm flow (api/toss.js) can be missed — user closes the
// tab/popup before the redirect, or the auth wait times out on return. Toss
// still captured the payment, so without this the user is charged but never
// entitled. This endpoint runs independently of the browser.
//
// SECURITY: this URL is public and unauthenticated, so we NEVER trust the POST
// body's amount/status. We take only the paymentKey/orderId from the body, then
// RE-FETCH the payment from the Toss API with our secret key and treat that as
// the sole source of truth. uid comes from the payment's customerKey (both the
// plan and STT flows set customerKey = full Firebase uid). Fulfillment goes
// through the same idempotent grantEntitlement() the confirm flow uses, so if
// both fire for one payment there is no double grant.
//
// SETUP (manual, not done by code): register this URL as a webhook in the Toss
// developer console → https://notyx.co.kr/api/toss-webhook

const crypto = require('node:crypto');
const { getAdmin } = require('./_firebase-admin');
const {
  createBillingRepository,
  fingerprintBillingKey,
  normalizeBillingPayment,
  BillingPaymentValidationError,
  BillingLeaseLostError,
  BillingStateConflictError,
} = require('./_billing');
const { grantEntitlement, sttPriceForUnits, planForAmount } = require('./_grant');

const BILLING_ORDER_RE = /^ntx_[pr]_[0-9a-f]{48}$/u;
const BILLING_DELETED_AUTH_HEADER = 'x-notyx-billing-deleted-secret';
const BILLING_DELETED_SECRET_ENV = 'BILLING_DELETED_WEBHOOK_SECRET';
const BILLING_DELETED_SECRET_MAX_BYTES = 300;

// Production gate: the reverse proxy must inject this dedicated header only
// after authenticating the provider deletion notification. Set the matching
// server secret in BILLING_DELETED_WEBHOOK_SECRET; Toss general webhooks have
// no signature, so this event must never trust its public body by itself.
function boundedSecretMatches(expected, provided) {
  const expectedBuffer = Buffer.alloc(BILLING_DELETED_SECRET_MAX_BYTES);
  const providedBuffer = Buffer.alloc(BILLING_DELETED_SECRET_MAX_BYTES);
  const valid = value => typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= BILLING_DELETED_SECRET_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
  if (valid(expected)) expectedBuffer.write(expected, 'utf8');
  if (valid(provided)) providedBuffer.write(provided, 'utf8');
  const equal = crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  return valid(expected) && valid(provided) && equal;
}

async function reconcileBillingOrder({ order, payment, repository, uid }) {
  if (order.resolution === 'succeeded' || order.resolution === 'failed') return { ok: true, idempotent: true };
  let lease;
  if (order.kind === 'renewal' && order.resolution === 'unknown') {
    lease = await repository.acquireRenewalReconciliationLease({ uid, orderId: order.orderId, source: 'webhook' });
  } else {
    lease = await repository.acquireOrderLease({ uid, orderId: order.orderId });
  }
  if (!lease.acquired) return { ok: true, idempotent: true, contended: true };
  try {
    const normalized = normalizeBillingPayment(payment, {
      orderId: order.orderId,
      customerKey: order.customerKey,
      amount: order.amount,
      currency: order.currency,
    });
    await repository.finalizeOrderSuccess({ uid, orderId: order.orderId, leaseToken: lease.leaseToken, payment: normalized });
    return { ok: true };
  } catch (error) {
    if (error instanceof BillingPaymentValidationError && error.disposition === 'terminal_failure') {
      await repository.finalizeOrderFailure({ uid, orderId: order.orderId, leaseToken: lease.leaseToken, failure: { code: 'payment_terminal', providerCode: null } });
      return { ok: true, failed: true };
    }
    if (error instanceof BillingLeaseLostError || error instanceof BillingStateConflictError) return { ok: true, contended: true };
    try {
      await repository.releaseOrderLease({ uid, orderId: order.orderId, leaseToken: lease.leaseToken, resolution: 'worker_error' });
    } catch (_) { /* Toss retries the event; state remains authoritative. */ }
    return { ok: false, transient: true };
  }
}

async function handleBillingDeleted({ payload, res, headers, env, getAdminFn, createRepositoryFn, fingerprintBillingKeyFn }) {
  if (!boundedSecretMatches(env[BILLING_DELETED_SECRET_ENV], headers[BILLING_DELETED_AUTH_HEADER])) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (env.TOSS_BILLING_ENABLED !== 'true' || !env.BILLING_ENCRYPTION_KEY) {
    return res.status(503).json({ ok: false, message: 'server_misconfigured' });
  }
  const billingKey = payload.billingKey || null;
  if (typeof billingKey !== 'string' || billingKey.length < 1) {
    return res.status(200).json({ ok: true, ignored: 'no_billing_key' });
  }
  try {
    const admin = getAdminFn();
    const repository = createRepositoryFn({ firestore: admin.firestore() });
    const fingerprint = fingerprintBillingKeyFn(billingKey, env.BILLING_ENCRYPTION_KEY);
    const uid = await repository.findSubscriptionUidByBillingKeyFingerprint({ fingerprint });
    if (!uid) return res.status(200).json({ ok: true, ignored: 'unknown_billing_key' });
    await repository.invalidateBillingMethod({ uid, reason: 'provider_billing_key_deleted', expectedFingerprint: fingerprint });
    return res.status(200).json({ ok: true, invalidated: true });
  } catch (error) {
    console.error('[toss-webhook] billing deletion reconciliation failed:', error.message);
    return res.status(503).json({ ok: false, message: 'billing_unavailable' });
  }
}

// Find the STT unit count n whose price equals the verified amount (or null).
function sttUnitsForAmount(amount) {
  for (let n = 1; n <= 200; n++) {
    if (sttPriceForUnits(n) === amount) return n;
  }
  return null;
}

function createTossWebhookHandler({
  env = process.env,
  getAdminFn = getAdmin,
  createRepositoryFn = createBillingRepository,
  fingerprintBillingKeyFn = fingerprintBillingKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Body may arrive parsed or as a raw string depending on content-type.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};
  const payload = body.data && typeof body.data === 'object' ? body.data : body;
  const paymentKey = payload.paymentKey || body.paymentKey || null;
  const orderId = payload.orderId || body.orderId || null;
  const eventType = body.eventType || body.type || payload.eventType || payload.type || null;

  if (eventType === 'BILLING_DELETED') {
    return handleBillingDeleted({
      payload,
      res,
      headers: req.headers || {},
      env,
      getAdminFn,
      createRepositoryFn,
      fingerprintBillingKeyFn,
    });
  }

  if (!paymentKey && !orderId) {
    // Nothing actionable — ack so Toss doesn't retry forever.
    console.warn('[toss-webhook] no paymentKey/orderId in payload');
    return res.status(200).json({ ok: true, ignored: 'no_identifier' });
  }

  let billingRepository = null;
  let billingOrder = null;
  if (typeof orderId === 'string' && BILLING_ORDER_RE.test(orderId)) {
    if (env.TOSS_BILLING_ENABLED !== 'true' || !env.TOSS_BILLING_SECRET_KEY) {
      return res.status(503).json({ ok: false, message: 'server_misconfigured' });
    }
    try {
      const admin = getAdminFn();
      billingRepository = createRepositoryFn({ firestore: admin.firestore() });
      billingOrder = await billingRepository.getBillingOrder({ orderId });
    } catch (e) {
      console.error('[toss-webhook] billing order lookup failed:', e.message);
      return res.status(503).json({ ok: false, message: 'billing_unavailable' });
    }
  }

  const secretKey = billingOrder ? env.TOSS_BILLING_SECRET_KEY : env.TOSS_SECRET_KEY;
  if (!secretKey) {
    console.error('[toss-webhook] TOSS_SECRET_KEY missing');
    return res.status(500).json({ ok: false, message: 'server_misconfigured' });
  }
  const encoded = Buffer.from(secretKey + ':').toString('base64');
  const url = paymentKey
    ? 'https://api.tosspayments.com/v1/payments/' + encodeURIComponent(paymentKey)
    : 'https://api.tosspayments.com/v1/payments/orders/' + encodeURIComponent(orderId);

  // Authoritative re-fetch from Toss.
  let payment;
  try {
      const r = await fetchImpl(url, { headers: { 'Authorization': 'Basic ' + encoded } });
    if (r.status >= 500) {
      // Toss transient — let Toss retry the webhook later.
      console.error('[toss-webhook] Toss lookup 5xx:', r.status);
      return res.status(502).json({ ok: false, message: 'toss_lookup_failed' });
    }
    payment = await r.json();
    if (!r.ok) {
      console.warn('[toss-webhook] Toss lookup not ok:', r.status, payment && payment.code);
      return res.status(200).json({ ok: true, ignored: 'lookup_not_ok' });
    }
  } catch (e) {
    console.error('[toss-webhook] Toss lookup error:', e.message);
    return res.status(502).json({ ok: false, message: 'toss_lookup_error' });
  }

  if (billingOrder) {
    const result = await reconcileBillingOrder({ order: billingOrder, payment, repository: billingRepository, uid: billingOrder.uid });
    if (result.ok) return res.status(200).json({ ok: true, idempotent: !!result.idempotent, reconciled: !result.contended });
    return res.status(502).json({ ok: false, message: 'billing_reconciliation_failed' });
  }

  if (payment.status !== 'DONE') {
    return res.status(200).json({ ok: true, ignored: 'status_' + payment.status });
  }

  const uid = payment.customerKey;
  if (!uid) {
    console.warn('[toss-webhook] payment has no customerKey, cannot attribute. orderId=', payment.orderId);
    return res.status(200).json({ ok: true, ignored: 'no_customerKey' });
  }

  const verifiedAmount = payment.totalAmount;
  let kind, minutes;
  if (planForAmount(verifiedAmount)) {
    kind = 'plan';            // grantEntitlement derives monthly/single from amount
  } else {
    const n = sttUnitsForAmount(verifiedAmount);
    if (!n) {
      console.warn('[toss-webhook] amount matches no plan or STT tier:', verifiedAmount);
      return res.status(200).json({ ok: true, ignored: 'unknown_amount' });
    }
    kind = 'sttEntitlement';
    minutes = n * 30;
  }

  const result = await grantEntitlement({
    uid, kind, minutes,
    paymentKey: payment.paymentKey,
    orderId: payment.orderId,
    verifiedAmount,
  });

  if (result.ok) {
    return res.status(200).json({ ok: true, idempotent: !!result.idempotent });
  }
  // Transient write failure → let Toss retry; permanent rejection → ack.
  if (result.status === 500) {
    return res.status(500).json({ ok: false, message: result.message });
  }
  console.warn('[toss-webhook] grant rejected:', result.message);
  return res.status(200).json({ ok: true, ignored: 'grant_rejected' });
  };
}

module.exports = createTossWebhookHandler();
module.exports.createTossWebhookHandler = createTossWebhookHandler;
module.exports.BILLING_DELETED_AUTH_HEADER = BILLING_DELETED_AUTH_HEADER;
module.exports.BILLING_DELETED_SECRET_ENV = BILLING_DELETED_SECRET_ENV;
