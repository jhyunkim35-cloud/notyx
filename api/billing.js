'use strict';

const crypto = require('node:crypto');
const { getAdmin } = require('./_firebase-admin');
const {
  PRO_MONTHLY_AMOUNT_KRW,
  currency,
  sanitizeSubscription,
} = require('./_billing-domain');
const {
  BillingConfigurationError,
  BillingCryptoError,
  TossProviderError,
  BillingPaymentValidationError,
  BillingRecordNotFoundError,
  BillingStateConflictError,
  BillingLeaseLostError,
  BillingRepositoryInvariantError,
  BillingStorageError,
  validateCustomerKey,
  generateCustomerKey,
  encryptBillingKey,
  decryptBillingKey,
  redactSensitive,
  createTossClient,
  createBillingRepository,
} = require('./_billing');

const ALLOWED_ORIGINS = Object.freeze([
  'https://lazyuniv-ai.vercel.app',
  'https://notyx.vercel.app',
  'https://notyx.co.kr',
  'http://localhost:3000',
]);
const ACTION_KEYS = Object.freeze({
  prepare: ['action'],
  activate: ['action', 'authKey', 'customerKey'],
  status: ['action'],
  retry: ['action'],
  cancel: ['action'],
  resume: ['action'],
});
const MAX_BODY_BYTES = 8192;
const ORDER_NAME = 'Notyx Pro 월간 구독';
const PENDING_MESSAGE = '결제 결과를 확인 중입니다. 잠시 후 다시 확인해 주세요.';
const PRODUCT = Object.freeze({
  name: 'Notyx Pro',
  orderName: ORDER_NAME,
  price: '월 8,900원 (부가세 포함)',
  renewal: '매월 자동 결제',
  cancellation: '해지는 현재 이용기간 종료 시 적용되며 자동 환불되지 않습니다.',
  refund: '환불 요청은 고객지원에서 수동으로 처리됩니다.',
});
const ERRORS = Object.freeze({
  invalid_request: [400, '요청을 확인해 주세요.'],
  unauthorized: [401, '로그인이 필요합니다.'],
  origin_not_allowed: [403, '허용되지 않은 요청입니다.'],
  method_not_allowed: [405, '지원하지 않는 요청 방식입니다.'],
  request_too_large: [413, '요청이 너무 큽니다.'],
  unsupported_media_type: [415, 'JSON 요청만 지원합니다.'],
  payment_failed: [402, '결제에 실패했습니다. 결제수단을 확인한 뒤 다시 시도해 주세요.'],
  prepare_required: [409, '먼저 결제수단 등록을 시작해 주세요.'],
  billing_state_conflict: [409, '현재 구독 상태에서는 요청을 처리할 수 없습니다.'],
  billing_return_mismatch: [409, '결제수단 등록 정보를 확인할 수 없습니다. 다시 등록해 주세요.'],
  billing_method_required: [422, '결제수단을 다시 등록해 주세요.'],
  provider_validation_failed: [502, '결제 정보를 안전하게 확인하지 못했습니다. 고객지원에 문의해 주세요.'],
  billing_unavailable: [503, '현재 정기결제를 이용할 수 없습니다.'],
  internal_error: [500, '요청 처리 중 오류가 발생했습니다.'],
});

class BillingRuntimeUnavailableError extends Error {
  constructor() {
    super('Billing runtime is unavailable');
    this.name = 'BillingRuntimeUnavailableError';
    this.code = 'BILLING_RUNTIME_UNAVAILABLE';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validUntrimmed(value, prefix, maximum = 300) {
  return typeof value === 'string'
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') > prefix.length
    && Buffer.byteLength(value, 'utf8') <= maximum
    && value.startsWith(prefix)
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPublicOrigin(value) {
  if (typeof value !== 'string' || !ALLOWED_ORIGINS.includes(value) || value.endsWith('/')) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.pathname === '/' && parsed.username === '' && parsed.password === ''
      && parsed.search === '' && parsed.hash === '';
  } catch (_) {
    return false;
  }
}

function readBillingRuntimeConfig(env) {
  try {
    if (!isPlainObject(env) && typeof env !== 'object') throw new Error('env');
    if (env.TOSS_BILLING_ENABLED !== 'true') throw new Error('enabled');
    if (!validUntrimmed(env.TOSS_BILLING_CLIENT_KEY, 'test_ck_')) throw new Error('client');
    if (!validUntrimmed(env.TOSS_BILLING_SECRET_KEY, 'test_sk_')) throw new Error('secret');
    // Validation is delegated to the frozen Task 2 crypto boundary.
    encryptBillingKey('runtime_validation', env.BILLING_ENCRYPTION_KEY);
    if (!validPublicOrigin(env.NOTYX_PUBLIC_ORIGIN)) throw new Error('origin');
    return Object.freeze({
      clientKey: env.TOSS_BILLING_CLIENT_KEY,
      secretKey: env.TOSS_BILLING_SECRET_KEY,
      encryptionKey: env.BILLING_ENCRYPTION_KEY,
      publicOrigin: env.NOTYX_PUBLIC_ORIGIN,
    });
  } catch (_) {
    throw new BillingRuntimeUnavailableError();
  }
}

function getPublicPaymentConfig(env) {
  const oneTimeClientKey = validUntrimmed(env && env.TOSS_CLIENT_KEY, 'test_ck_')
    || validUntrimmed(env && env.TOSS_CLIENT_KEY, 'live_ck_') ? env.TOSS_CLIENT_KEY : null;
  let billingClientKey = null;
  try {
    billingClientKey = readBillingRuntimeConfig(env).clientKey;
  } catch (_) {
    billingClientKey = null;
  }
  return Object.freeze({ oneTimeClientKey, billingClientKey });
}

function buildBillingReturnUrls(publicOrigin) {
  if (!validPublicOrigin(publicOrigin)) throw new BillingRuntimeUnavailableError();
  return Object.freeze({
    successUrl: `${publicOrigin}/?billing=success`,
    failUrl: `${publicOrigin}/?billing=fail`,
  });
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function errorResponse(res, code, subscription) {
  const [status, message] = ERRORS[code] || ERRORS.internal_error;
  const body = { ok: false, error: { code, message } };
  if ((code === 'payment_failed' || code === 'billing_method_required') && subscription !== undefined) {
    body.subscription = sanitizeSubscription(subscription);
  }
  return json(res, status, body);
}

function applyCors(req, res, methods, headers) {
  const origin = req.headers && req.headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || !ALLOWED_ORIGINS.includes(origin))) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  if (headers) res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function readAuthorization(headers) {
  const value = headers && headers.authorization;
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\u0000\r\n]/u.test(value)) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match ? match[1] : null;
}

function parseBody(req) {
  const lengthHeader = req.headers && req.headers['content-length'];
  if (lengthHeader !== undefined) {
    if (Array.isArray(lengthHeader) || !/^(?:0|[1-9][0-9]*)$/u.test(String(lengthHeader))) return { error: 'invalid_request' };
    if (Number(lengthHeader) > MAX_BODY_BYTES) return { error: 'request_too_large' };
  }
  let body = req.body;
  let bytes;
  if (Buffer.isBuffer(body)) {
    bytes = body.byteLength;
    body = body.toString('utf8');
  } else if (typeof body === 'string') {
    bytes = Buffer.byteLength(body, 'utf8');
  } else {
    try {
      bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch (_) {
      return { error: 'invalid_request' };
    }
  }
  if (bytes > MAX_BODY_BYTES) return { error: 'request_too_large' };
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return { error: 'invalid_request' }; }
  }
  if (!isPlainObject(body) || typeof body.action !== 'string' || !ACTION_KEYS[body.action]
    || !exactKeys(body, ACTION_KEYS[body.action])) return { error: 'invalid_request' };
  if (body.action === 'activate') {
    if (typeof body.authKey !== 'string' || Buffer.byteLength(body.authKey, 'utf8') < 1
      || Buffer.byteLength(body.authKey, 'utf8') > 300 || /[\u0000\r\n]/u.test(body.authKey)) return { error: 'invalid_request' };
    try { validateCustomerKey(body.customerKey); } catch (_) { return { error: 'invalid_request' }; }
  }
  return { body };
}

function safeLog(logger, level, details) {
  try { logger[level](redactSensitive(details)); } catch (_) { /* logging must not change behavior */ }
}

function pending(res, action, subscription) {
  return json(res, 202, {
    ok: true,
    action,
    outcome: 'pending',
    message: PENDING_MESSAGE,
    subscription: sanitizeSubscription(subscription),
  });
}

function active(res, action, subscription) {
  return json(res, 200, { ok: true, action, outcome: 'active', subscription: sanitizeSubscription(subscription) });
}

function isDueReview(subscription) {
  return subscription && (subscription.renewalReconciliationState === 'unknown' || subscription.renewalReconciliationState === 'manual');
}

function createBillingHandler({
  getAdminFn = getAdmin,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  logger = console,
  createRepository = createBillingRepository,
  createProvider = createTossClient,
  generateCustomerKeyFn = generateCustomerKey,
  encryptBillingKeyFn = encryptBillingKey,
  decryptBillingKeyFn = decryptBillingKey,
  sanitizeSubscriptionFn = sanitizeSubscription,
} = {}) {
  for (const [name, value] of Object.entries({ getAdminFn, fetchImpl, now, randomBytes, createRepository, createProvider, generateCustomerKeyFn, encryptBillingKeyFn, decryptBillingKeyFn, sanitizeSubscriptionFn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!logger || !['info', 'warn', 'error'].every((key) => typeof logger[key] === 'function')) throw new TypeError('logger is invalid');

  function sanitized(subscription) { return sanitizeSubscriptionFn(subscription); }
  function localPending(res, action, subscription) {
    return json(res, 202, { ok: true, action, outcome: 'pending', message: PENDING_MESSAGE, subscription: sanitized(subscription) });
  }
  function localActive(res, action, subscription) {
    return json(res, 200, { ok: true, action, outcome: 'active', subscription: sanitized(subscription) });
  }
  async function release(repository, uid, orderId, leaseToken, resolution) {
    try { await repository.releaseOrderLease({ uid, orderId, leaseToken, resolution }); } catch (_) { /* best effort */ }
  }
  async function knownFailure(res, action, repository, uid, fallbackSubscription, failure) {
    let subscription = fallbackSubscription;
    try { subscription = await repository.getSubscription({ uid }); } catch (_) { /* retain detached state */ }
    if (failure && (failure.code === 'provider_rejected' || failure.code === 'payment_terminal')) return errorResponse(res, 'payment_failed', subscription);
    if (failure && failure.code === 'authorization_failed') return errorResponse(res, 'billing_method_required', subscription);
    return errorResponse(res, 'billing_state_conflict');
  }
  async function reconcileLeaseLoss(res, action, repository, uid, orderId, fallbackSubscription) {
    try {
      const [subscription, order] = await Promise.all([
        repository.getSubscription({ uid }), repository.getBillingOrder({ orderId }),
      ]);
      if (order && order.resolution === 'succeeded') return localActive(res, action, subscription);
      if (order && order.resolution === 'failed') return knownFailure(res, action, repository, uid, subscription, { code: order.failureCode, providerCode: order.providerCode });
      return localPending(res, action, subscription || fallbackSubscription);
    } catch (_) {
      return localPending(res, action, fallbackSubscription);
    }
  }
  async function handleLookup({ res, action, repository, provider, uid, subscription, order, leaseToken }) {
    try {
      const payment = await provider.refetchBillingPayment({
        orderId: order.orderId,
        customerKey: order.customerKey,
        amount: PRO_MONTHLY_AMOUNT_KRW,
        currency,
      });
      const finalized = await repository.finalizeOrderSuccess({ uid, orderId: order.orderId, leaseToken, payment });
      return localActive(res, action, finalized.subscription);
    } catch (error) {
      if (error instanceof BillingLeaseLostError) return reconcileLeaseLoss(res, action, repository, uid, order.orderId, subscription);
      if (error instanceof BillingPaymentValidationError) {
        if (error.disposition === 'terminal_failure') {
          try {
            const finalized = await repository.finalizeOrderFailure({ uid, orderId: order.orderId, leaseToken, failure: { code: 'payment_terminal', providerCode: null } });
            return errorResponse(res, 'payment_failed', finalized.subscription);
          } catch (finalizeError) {
            if (finalizeError instanceof BillingLeaseLostError) return reconcileLeaseLoss(res, action, repository, uid, order.orderId, subscription);
            await release(repository, uid, order.orderId, leaseToken, 'worker_error');
            return localPending(res, action, subscription);
          }
        }
        if (error.disposition === 'pending') {
          await release(repository, uid, order.orderId, leaseToken, 'lookup_pending');
          return localPending(res, action, subscription);
        }
        await release(repository, uid, order.orderId, leaseToken, 'security_mismatch');
        return errorResponse(res, 'provider_validation_failed');
      }
      if (error instanceof TossProviderError) {
        if (error.disposition === 'lookup_again' || error.disposition === 'order_not_found') {
          await release(repository, uid, order.orderId, leaseToken, 'lookup_unknown');
          return localPending(res, action, subscription);
        }
        if (error.disposition === 'configuration') {
          await release(repository, uid, order.orderId, leaseToken, 'configuration_error');
          return errorResponse(res, 'billing_unavailable');
        }
        await release(repository, uid, order.orderId, leaseToken, 'worker_error');
        return errorResponse(res, 'provider_validation_failed');
      }
      await release(repository, uid, order.orderId, leaseToken, 'worker_error');
      return localPending(res, action, subscription);
    }
  }
  async function chargeAndReconcile({ res, action, repository, provider, uid, subscription, order, leaseToken, billingKey }) {
    let marked = false;
    try {
      const markedOrder = await repository.markOrderProviderRequestStarted({ uid, orderId: order.orderId, leaseToken });
      marked = true;
      order = markedOrder;
    } catch (error) {
      if (error instanceof BillingLeaseLostError) return reconcileLeaseLoss(res, action, repository, uid, order.orderId, subscription);
      await release(repository, uid, order.orderId, leaseToken, 'not_sent');
      return errorResponse(res, 'billing_unavailable');
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
      if (error instanceof TossProviderError) {
        if (error.disposition === 'refetch') return handleLookup({ res, action, repository, provider, uid, subscription, order, leaseToken });
        if (error.disposition === 'rejected') {
          try {
            const finalized = await repository.finalizeOrderFailure({ uid, orderId: order.orderId, leaseToken, failure: { code: 'provider_rejected', providerCode: error.providerCode } });
            return errorResponse(res, 'payment_failed', finalized.subscription);
          } catch (finalizeError) {
            if (finalizeError instanceof BillingLeaseLostError) return reconcileLeaseLoss(res, action, repository, uid, order.orderId, subscription);
            await release(repository, uid, order.orderId, leaseToken, 'worker_error');
            return localPending(res, action, subscription);
          }
        }
        if (error.disposition === 'configuration') {
          await release(repository, uid, order.orderId, leaseToken, 'configuration_error');
          return errorResponse(res, 'billing_unavailable');
        }
      }
      if (marked) await release(repository, uid, order.orderId, leaseToken, 'worker_error');
      return localPending(res, action, subscription);
    }
    return handleLookup({ res, action, repository, provider, uid, subscription, order, leaseToken });
  }

  return async function handler(req, res) {
    setCommonHeaders(res);
    if (!applyCors(req, res, 'POST, OPTIONS', 'Content-Type, Authorization')) return errorResponse(res, 'origin_not_allowed');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return errorResponse(res, 'method_not_allowed');
    }
    const contentType = req.headers && req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;.*)?$/iu.test(contentType)) return errorResponse(res, 'unsupported_media_type');
    const parsed = parseBody(req);
    if (parsed.error) return errorResponse(res, parsed.error);
    const body = parsed.body;
    const token = readAuthorization(req.headers);
    if (!token) return errorResponse(res, 'unauthorized');

    let admin;
    let uid;
    try {
      admin = getAdminFn();
      const decoded = await admin.auth().verifyIdToken(token, true);
      uid = decoded && decoded.uid;
      if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128) throw new Error('uid');
    } catch (_) {
      return errorResponse(res, 'unauthorized');
    }

    let repository;
    try {
      repository = createRepository({ firestore: admin.firestore(), now, randomBytes });
    } catch (_) {
      safeLog(logger, 'warn', { event: 'billing_repository_unavailable', action: body.action, httpStatus: 503, code: 'billing_unavailable' });
      return errorResponse(res, 'billing_unavailable');
    }

    try {
      if (body.action === 'status') {
        const subscription = await repository.getSubscription({ uid });
        let legacy = null;
        if (subscription === null) {
          const snapshot = await admin.firestore().collection('users').doc(uid).get();
          if (snapshot.exists) {
            const data = snapshot.data();
            if (data && data.plan === 'monthly' && typeof data.planExpiry === 'string') {
              const expiry = new Date(data.planExpiry);
              const requestNow = now();
              if (!Number.isNaN(expiry.getTime()) && expiry.toISOString() === data.planExpiry && expiry.getTime() > requestNow.getTime()) {
                legacy = { status: 'active_nonrenewing', accessEndsAt: data.planExpiry, autoRenew: false };
              }
            }
          }
        }
        return json(res, 200, { ok: true, action: 'status', subscription: sanitized(subscription), legacy });
      }
      if (body.action === 'cancel' || body.action === 'resume') {
        const current = await repository.getSubscription({ uid });
        if (current === null) return errorResponse(res, 'billing_state_conflict');
        if (isDueReview(current)) return errorResponse(res, 'billing_state_conflict');
        const subscription = await repository.transitionSubscription({ uid, outcome: { type: body.action === 'cancel' ? 'cancel_requested' : 'resume_requested' } });
        return json(res, 200, { ok: true, action: body.action, subscription: sanitized(subscription) });
      }

      let config;
      try { config = readBillingRuntimeConfig(env); } catch (_) { return errorResponse(res, 'billing_unavailable'); }
      if (body.action === 'prepare') {
        const candidate = generateCustomerKeyFn({ randomBytes });
        const prepared = await repository.prepareSubscription({ uid, customerKey: candidate });
        const urls = buildBillingReturnUrls(config.publicOrigin);
        return json(res, 200, {
          ok: true,
          action: 'prepare',
          customerKey: prepared.subscription.customerKey,
          orderId: prepared.order.orderId,
          amount: { value: PRO_MONTHLY_AMOUNT_KRW, currency },
          product: { ...PRODUCT },
          ...urls,
        });
      }

      const provider = createProvider({ secretKey: config.secretKey, fetchImpl });
      let prepared;
      if (body.action === 'retry') {
        prepared = await repository.prepareInitialRetry({ uid });
        if (prepared.created === false && prepared.subscription.status === 'active' && prepared.order.resolution === 'succeeded') {
          return localActive(res, 'retry', prepared.subscription);
        }
      } else {
        const subscription = await repository.getSubscription({ uid });
        if (subscription === null) return errorResponse(res, 'prepare_required');
        const order = await repository.getBillingOrder({ orderId: subscription.initialOrderId });
        if (!order) return errorResponse(res, 'prepare_required');
        if (subscription.customerKey !== body.customerKey || order.customerKey !== body.customerKey) return errorResponse(res, 'billing_return_mismatch');
        if (order.resolution === 'succeeded') return localActive(res, 'activate', subscription);
        if (order.resolution === 'failed') return knownFailure(res, 'activate', repository, uid, subscription, { code: order.failureCode, providerCode: order.providerCode });
        if (subscription.initialAttempt !== 0 && order.resolution === 'ready') return localPending(res, 'activate', subscription);
        prepared = { subscription, order, created: false };
      }

      const lease = await repository.acquireOrderLease({ uid, orderId: prepared.order.orderId });
      if (!lease.acquired) {
        if (lease.reason === 'succeeded') return localActive(res, body.action, await repository.getSubscription({ uid }));
        if (lease.reason === 'failed') return knownFailure(res, body.action, repository, uid, prepared.subscription, lease.failure);
        return localPending(res, body.action, prepared.subscription);
      }
      let { subscription, order } = lease;
      const leaseToken = lease.leaseToken;
      if (order.resolution === 'unknown' || order.providerRequestStartedAt !== null) {
        return handleLookup({ res, action: body.action, repository, provider, uid, subscription, order, leaseToken });
      }

      let billingKey = null;
      if (body.action === 'activate' && subscription.billingMethodStatus === 'absent') {
        try {
          const issued = await provider.issueBillingKey({ authKey: body.authKey, customerKey: subscription.customerKey });
          try {
            billingKey = issued.billingKey;
            const envelope = encryptBillingKeyFn(billingKey, config.encryptionKey);
            subscription = await repository.storeBillingMethod({ uid, orderId: order.orderId, leaseToken, customerKey: subscription.customerKey, envelope });
          } finally {
            if (billingKey !== null) billingKey = null;
          }
        } catch (error) {
          if (error instanceof TossProviderError && error.disposition === 'reregister') {
            const result = await repository.abandonInitialRegistration({ uid, orderId: order.orderId, leaseToken, reason: 'authorization_failed' });
            return errorResponse(res, 'billing_method_required', result.subscription);
          }
          if (error instanceof TossProviderError && error.disposition === 'configuration') {
            await release(repository, uid, order.orderId, leaseToken, 'not_sent');
            return errorResponse(res, 'billing_unavailable');
          }
          if (error instanceof BillingPaymentValidationError) {
            await repository.abandonInitialRegistration({ uid, orderId: order.orderId, leaseToken, reason: 'provider_validation_failed' });
            return errorResponse(res, 'provider_validation_failed');
          }
          try { await repository.abandonInitialRegistration({ uid, orderId: order.orderId, leaseToken, reason: 'encryption_failed' }); } catch (_) { /* best effort */ }
          return errorResponse(res, 'internal_error');
        }
      }
      if (subscription.billingMethodStatus !== 'ready' || subscription.billingKeyCiphertext === null) {
        await release(repository, uid, order.orderId, leaseToken, 'not_sent');
        return errorResponse(res, 'billing_method_required', subscription);
      }
      try {
        billingKey = decryptBillingKeyFn(subscription.billingKeyCiphertext, config.encryptionKey);
      } catch (error) {
        await release(repository, uid, order.orderId, leaseToken, 'not_sent');
        if (error instanceof BillingConfigurationError) return errorResponse(res, 'billing_unavailable');
        if (error instanceof BillingCryptoError) {
          const invalid = await repository.invalidateBillingMethod({ uid, reason: 'billing_key_decrypt_failed', expectedFingerprint: subscription.billingKeyFingerprint });
          return errorResponse(res, 'billing_method_required', invalid);
        }
        return errorResponse(res, 'internal_error');
      }
      try {
        return await chargeAndReconcile({ res, action: body.action, repository, provider, uid, subscription, order, leaseToken, billingKey });
      } finally {
        billingKey = null;
      }
    } catch (error) {
      if (error instanceof BillingRecordNotFoundError) return errorResponse(res, body.action === 'activate' ? 'prepare_required' : 'billing_state_conflict');
      if (error instanceof BillingStateConflictError) return errorResponse(res, 'billing_state_conflict');
      if (error instanceof BillingStorageError) {
        safeLog(logger, 'warn', { event: 'billing_storage_error', action: body.action, httpStatus: 503, code: 'billing_unavailable' });
        return errorResponse(res, 'billing_unavailable');
      }
      if (error instanceof BillingRepositoryInvariantError || error instanceof TypeError || error instanceof RangeError) {
        safeLog(logger, 'error', { event: 'billing_invariant_error', action: body.action, httpStatus: 500, code: 'internal_error' });
        return errorResponse(res, 'internal_error');
      }
      safeLog(logger, 'error', { event: 'billing_unexpected_error', action: body.action, httpStatus: 500, code: 'internal_error' });
      return errorResponse(res, 'internal_error');
    }
  };
}

const productionHandler = createBillingHandler();
module.exports = productionHandler;
module.exports.createBillingHandler = createBillingHandler;
module.exports.readBillingRuntimeConfig = readBillingRuntimeConfig;
module.exports.getPublicPaymentConfig = getPublicPaymentConfig;
module.exports.buildBillingReturnUrls = buildBillingReturnUrls;
module.exports.BillingRuntimeUnavailableError = BillingRuntimeUnavailableError;
module.exports.ALLOWED_ORIGINS = ALLOWED_ORIGINS;
