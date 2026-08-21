'use strict';

const crypto = require('node:crypto');
const { getAdmin } = require('./_firebase-admin');
const {
  PRO_MONTHLY_AMOUNT_KRW,
  currency,
  RENEWAL_ATTEMPT_DAYS,
} = require('./_billing-domain');
const {
  BillingConfigurationError,
  BillingCryptoError,
  BillingPaymentValidationError,
  BillingRecordNotFoundError,
  BillingStateConflictError,
  BillingLeaseLostError,
  TossProviderError,
  isOrderLookupNotFound,
  RENEWAL_UNKNOWN_CUTOFF_MS,
  encryptBillingKey,
  decryptBillingKey,
  createTossClient,
  createBillingRepository,
  redactSensitive,
} = require('./_billing');

const MAX_BATCH = 100;
const CRON_SECRET_HEADER = 'x-cron-secret';
const ORDER_NAME = 'Notyx Pro 월간 구독';

function validSecret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function readCronConfig(env) {
  if (!env || env.TOSS_BILLING_ENABLED !== 'true' || !validSecret(env.BILLING_CRON_SECRET)
    || typeof env.TOSS_BILLING_SECRET_KEY !== 'string' || !env.TOSS_BILLING_SECRET_KEY.startsWith('test_sk_')
    || typeof env.BILLING_ENCRYPTION_KEY !== 'string') throw new BillingConfigurationError();
  encryptBillingKey('runtime_validation', env.BILLING_ENCRYPTION_KEY);
  return Object.freeze({
    cronSecret: env.BILLING_CRON_SECRET,
    secretKey: env.TOSS_BILLING_SECRET_KEY,
    encryptionKey: env.BILLING_ENCRYPTION_KEY,
  });
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function attemptFor(subscription) {
  if (subscription.status === 'active' && subscription.retryCount === 0) return 0;
  if (subscription.status === 'past_due' && subscription.retryCount === 1) return 1;
  if (subscription.status === 'past_due' && subscription.retryCount === 2) return 3;
  return null;
}

function isDue(subscription, now) {
  return typeof subscription.billingWorkDueAt === 'string'
    && new Date(subscription.billingWorkDueAt).getTime() <= now.getTime();
}

function createBillingCronHandler({
  getAdminFn = getAdmin,
  env = process.env,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  logger = console,
  createRepository = createBillingRepository,
  createProvider = createTossClient,
  decryptBillingKeyFn = decryptBillingKey,
  maxBatch = MAX_BATCH,
} = {}) {
  for (const [name, value] of Object.entries({ getAdminFn, now, randomBytes, createRepository, createProvider, decryptBillingKeyFn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!logger || !['info', 'warn', 'error'].every((key) => typeof logger[key] === 'function')) throw new TypeError('logger is invalid');
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > MAX_BATCH) throw new RangeError('maxBatch is invalid');

  function log(level, details) {
    try { logger[level](redactSensitive(details)); } catch (_) { /* logging must not change behavior */ }
  }

  async function release(repository, input, resolution) {
    try { await repository.releaseOrderLease({ ...input, resolution }); } catch (error) { log('warn', { event: 'billing_lease_release_failed', code: error.code }); }
  }

  async function lookupAndFinalize({ repository, provider, uid, subscription, order, leaseToken, onOrderLookupNotFound }) {
    try {
      const payment = await provider.refetchBillingPayment({
        orderId: order.orderId,
        customerKey: order.customerKey,
        amount: PRO_MONTHLY_AMOUNT_KRW,
        currency,
      });
      await repository.finalizeOrderSuccess({ uid, orderId: order.orderId, leaseToken, payment });
      return 'succeeded';
    } catch (error) {
      if (error instanceof BillingPaymentValidationError && error.disposition === 'terminal_failure') {
        await repository.finalizeOrderFailure({ uid, orderId: order.orderId, leaseToken, failure: { code: 'payment_terminal', providerCode: null } });
        return 'failed';
      }
      if (error instanceof BillingLeaseLostError || error instanceof BillingStateConflictError) return 'contended';
      if (isOrderLookupNotFound(error) && typeof onOrderLookupNotFound === 'function') {
        return onOrderLookupNotFound();
      }
      await release(repository, { uid, orderId: order.orderId, leaseToken }, error instanceof TossProviderError ? 'lookup_unknown' : 'worker_error');
      return 'pending';
    }
  }

  async function retrySameRenewalOrder({ repository, provider, config, uid, subscription, order, leaseToken }) {
    let billingKey = null;
    try {
      try {
        billingKey = decryptBillingKeyFn(subscription.billingKeyCiphertext, config.encryptionKey);
      } catch (error) {
        await release(repository, { uid, orderId: order.orderId, leaseToken }, 'worker_error');
        if (error instanceof BillingCryptoError) {
          await repository.invalidateBillingMethod({ uid, reason: 'billing_key_decrypt_failed', expectedFingerprint: subscription.billingKeyFingerprint });
        }
        return 'pending';
      }
      try {
        await provider.chargeBillingKey({
          billingKey,
          customerKey: order.customerKey,
          orderId: order.orderId,
          orderName: ORDER_NAME,
          amount: PRO_MONTHLY_AMOUNT_KRW,
          idempotencyKey: order.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof TossProviderError && error.disposition === 'rejected') {
          await repository.finalizeOrderFailure({ uid, orderId: order.orderId, leaseToken, failure: { code: 'provider_rejected', providerCode: error.providerCode } });
          return 'failed';
        }
      }
      return await lookupAndFinalize({ repository, provider, uid, subscription, order, leaseToken });
    } catch (error) {
      if (!(error instanceof BillingLeaseLostError) && !(error instanceof BillingStateConflictError)) log('warn', { event: 'billing_renewal_retry_failed', uid, code: error.code });
      await release(repository, { uid, orderId: order.orderId, leaseToken }, 'worker_error');
      return 'pending';
    } finally {
      billingKey = null;
    }
  }

  async function reconcileUnknown({ repository, provider, config, uid, subscription, order, currentNow }) {
    const lease = await repository.acquireRenewalReconciliationLease({ uid, orderId: order.orderId, source: 'cron' });
    if (!lease.acquired) return 'contended';
    const leaseToken = lease.leaseToken;
    const dueAt = subscription.billingWorkDueAt;
    try {
      const cutoffAt = new Date(new Date(order.providerRequestStartedAt).getTime() + RENEWAL_UNKNOWN_CUTOFF_MS);
      if (currentNow.getTime() >= cutoffAt.getTime()) {
        await repository.markRenewalManualReconciliation({ uid, orderId: order.orderId, leaseToken });
        return 'manual';
      }
      const claimed = await repository.claimOrderReconciliationSlot({ uid, orderId: order.orderId, leaseToken, slotAt: dueAt });
      if (!claimed.claimed) {
        await release(repository, { uid, orderId: order.orderId, leaseToken }, 'lookup_unknown');
        return 'contended';
      }
      return await lookupAndFinalize({
        repository,
        provider,
        uid,
        subscription: claimed.subscription,
        order: claimed.order,
        leaseToken,
        onOrderLookupNotFound: () => retrySameRenewalOrder({
          repository,
          provider,
          config,
          uid,
          subscription: claimed.subscription,
          order: claimed.order,
          leaseToken,
        }),
      });
    } catch (error) {
      if (error instanceof BillingLeaseLostError || error instanceof BillingStateConflictError) return 'contended';
      await release(repository, { uid, orderId: order.orderId, leaseToken }, 'worker_error');
      return 'pending';
    }
  }

  async function processDue({ repository, provider, config, record, currentNow }) {
    const uid = record.uid;
    const subscription = record;
    if (!uid || !isDue(subscription, currentNow)) return 'skipped';

    if (subscription.cancelAtPeriodEnd) {
      if (new Date(subscription.currentPeriodEnd).getTime() <= currentNow.getTime()) {
        try {
          await repository.transitionSubscription({ uid, outcome: { type: 'period_expired' } });
          return 'expired';
        } catch (error) {
          log('warn', { event: 'billing_period_expiry_failed', uid, code: error.code });
        }
      }
      return 'skipped';
    }

    const attempt = attemptFor(subscription);
    if (!RENEWAL_ATTEMPT_DAYS.includes(attempt)) return 'skipped';

    if (subscription.renewalReconciliationState === 'unknown') {
      const { renewalOrderId } = require('./_billing-domain');
      const order = await repository.getBillingOrder({ orderId: renewalOrderId(uid, subscription.currentPeriodEnd, attempt) });
      if (!order) return 'skipped';
      return reconcileUnknown({ repository, provider, config, uid, subscription, order, currentNow });
    }
    if (subscription.renewalReconciliationState !== 'none') return 'skipped';

    let prepared;
    try {
      prepared = await repository.prepareRenewalOrder({ uid, attempt });
    } catch (error) {
      if (!(error instanceof BillingStateConflictError) && !(error instanceof BillingRecordNotFoundError)) log('warn', { event: 'billing_prepare_failed', uid, code: error.code });
      return 'skipped';
    }
    const lease = await repository.acquireOrderLease({ uid, orderId: prepared.order.orderId });
    if (!lease.acquired) return 'contended';
    const leaseToken = lease.leaseToken;
    let billingKey;
    try {
      if (lease.order.resolution === 'unknown' || lease.order.providerRequestStartedAt !== null) {
        return await lookupAndFinalize({ repository, provider, uid, subscription: lease.subscription, order: lease.order, leaseToken });
      }
      try {
        billingKey = decryptBillingKeyFn(lease.subscription.billingKeyCiphertext, config.encryptionKey);
      } catch (error) {
        await release(repository, { uid, orderId: lease.order.orderId, leaseToken }, 'worker_error');
        if (error instanceof BillingCryptoError) {
          await repository.invalidateBillingMethod({ uid, reason: 'billing_key_decrypt_failed', expectedFingerprint: lease.subscription.billingKeyFingerprint });
        }
        return 'pending';
      }

      const started = await repository.markOrderProviderRequestStarted({ uid, orderId: lease.order.orderId, leaseToken });
      try {
        await provider.chargeBillingKey({
          billingKey,
          customerKey: started.customerKey,
          orderId: started.orderId,
          orderName: ORDER_NAME,
          amount: PRO_MONTHLY_AMOUNT_KRW,
          idempotencyKey: started.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof TossProviderError && error.disposition === 'rejected') {
          await repository.finalizeOrderFailure({ uid, orderId: started.orderId, leaseToken, failure: { code: 'provider_rejected', providerCode: error.providerCode } });
          return 'failed';
        }
      }
      return await lookupAndFinalize({ repository, provider, uid, subscription: lease.subscription, order: started, leaseToken });
    } catch (error) {
      if (!(error instanceof BillingLeaseLostError) && !(error instanceof BillingStateConflictError)) log('warn', { event: 'billing_renewal_failed', uid, code: error.code });
      await release(repository, { uid, orderId: lease.order.orderId, leaseToken }, 'worker_error');
      return 'pending';
    } finally {
      billingKey = null;
    }
  }

  return async function handler(req, res) {
    setHeaders(res);
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '지원하지 않는 요청 방식입니다.' } });
    let config;
    try { config = readCronConfig(env); } catch (_) { return json(res, 503, { ok: false, error: { code: 'billing_unavailable', message: '현재 정기결제를 이용할 수 없습니다.' } }); }
    const provided = req.headers && req.headers[CRON_SECRET_HEADER];
    if (provided !== config.cronSecret) return json(res, 401, { ok: false, error: { code: 'unauthorized', message: '인증이 필요합니다.' } });

    const currentNow = now();
    if (!(currentNow instanceof Date) || Number.isNaN(currentNow.getTime())) return json(res, 503, { ok: false, error: { code: 'billing_unavailable', message: '현재 정기결제를 이용할 수 없습니다.' } });
    try {
      const admin = getAdminFn();
      const repository = createRepository({ firestore: admin.firestore(), now, randomBytes });
      const provider = createProvider({ secretKey: config.secretKey });
      const due = await repository.listDueSubscriptions({ at: currentNow, limit: maxBatch });
      const summary = { ok: true, processed: 0, succeeded: 0, failed: 0, pending: 0, manual: 0, skipped: 0, contended: 0 };
      for (const record of due) {
        const result = await processDue({ repository, provider, config, record, currentNow });
        if (Object.prototype.hasOwnProperty.call(summary, result)) summary[result] += 1;
        if (['succeeded', 'failed', 'pending', 'expired'].includes(result)) summary.processed += 1;
      }
      return json(res, 200, summary);
    } catch (error) {
      log('error', { event: 'billing_cron_failed', code: error.code });
      return json(res, 503, { ok: false, error: { code: 'billing_unavailable', message: '현재 정기결제를 이용할 수 없습니다.' } });
    }
  };
}

module.exports = createBillingCronHandler();
module.exports.createBillingCronHandler = createBillingCronHandler;
module.exports.readCronConfig = readCronConfig;
