'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createBillingHandler,
  readBillingRuntimeConfig,
  getPublicPaymentConfig,
  buildBillingReturnUrls,
} = require('../api/billing');
const { createPaymentConfigHandler } = require('../api/payment-config');

const KEY = Buffer.alloc(32, 7).toString('base64');
const CUSTOMER = `ntx_c_${Buffer.alloc(24, 1).toString('base64url')}`;
const NOW = new Date('2026-08-21T00:00:00.000Z');
const ENV = Object.freeze({
  TOSS_BILLING_ENABLED: 'true',
  TOSS_BILLING_CLIENT_KEY: 'test_ck_billing_fixture',
  TOSS_BILLING_SECRET_KEY: 'test_sk_billing_fixture',
  BILLING_ENCRYPTION_KEY: KEY,
  NOTYX_PUBLIC_ORIGIN: 'http://localhost:3000',
  TOSS_CLIENT_KEY: 'test_ck_onetime_fixture',
});

function subscription(overrides = {}) {
  return {
    status: 'incomplete', amount: 8900, currency: 'KRW', customerKey: CUSTOMER,
    initialAttempt: 0, initialOrderId: 'ntx_p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    billingMethodStatus: 'absent', billingKeyCiphertext: null, billingKeyFingerprint: null,
    billingMethodInvalidatedAt: null, anchorAt: null, currentCycle: 0,
    currentPeriodStart: null, currentPeriodEnd: null, nextAttemptAt: null,
    retryCount: 0, cancelAtPeriodEnd: false, canceledAt: null,
    manualRetryRequired: false, requiresBillingMethodRegistration: false,
    lastPaymentAt: null, lastPaymentFailedAt: null, lastSuccessfulOrderId: null,
    renewalReconciliationState: 'none', billingWorkDueAt: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function activeSubscription(overrides = {}) {
  return subscription({
    status: 'active', billingMethodStatus: 'ready',
    billingKeyCiphertext: { version: 1, iv: 'fixture', tag: 'fixture', ciphertext: 'fixture', fingerprint: 'bkf1_fixture' },
    billingKeyFingerprint: 'bkf1_fixture', anchorAt: NOW.toISOString(), currentCycle: 0,
    currentPeriodStart: NOW.toISOString(), currentPeriodEnd: '2026-09-21T00:00:00.000Z',
    nextAttemptAt: '2026-09-21T00:00:00.000Z', billingWorkDueAt: '2026-09-21T00:00:00.000Z',
    lastPaymentAt: NOW.toISOString(), lastSuccessfulOrderId: 'ntx_p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...overrides,
  });
}

function order(overrides = {}) {
  return {
    orderId: 'ntx_p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', uid: 'user-1', kind: 'initial',
    cycle: 0, attempt: 0, periodStart: null, amount: 8900, currency: 'KRW', customerKey: CUSTOMER,
    idempotencyKey: 'ntx_pi_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    resolution: 'ready', terminalResult: null, failureCode: null, providerCode: null,
    leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, providerRequestStartedAt: null,
    providerLastLookupAt: null, providerPaymentKey: null, providerStatus: null,
    providerType: null, providerMethod: null, providerApprovedAt: null,
    ...overrides,
  };
}

function responseHarness() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

async function invoke(handler, { method = 'POST', body = { action: 'status' }, headers = {} } = {}) {
  const req = { method, body, headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers } };
  const res = responseHarness();
  await handler(req, res);
  return res;
}

function makeAdmin(userData = null) {
  return {
    auth() { return { verifyIdToken: async (token, revoked) => { assert.equal(token, 'token'); assert.equal(revoked, true); return { uid: 'user-1' }; } }; },
    firestore() {
      return {
        collection(name) {
          assert.equal(name, 'users');
          return { doc(uid) { assert.equal(uid, 'user-1'); return { get: async () => ({ exists: userData !== null, data: () => userData }) }; } };
        },
      };
    },
  };
}

function makeRepository(initial = subscription()) {
  let current = initial;
  let currentOrder = order();
  const calls = [];
  const repository = {
    calls,
    getSubscription: async ({ uid }) => { calls.push(['getSubscription', uid]); return current; },
    getBillingOrder: async ({ orderId }) => { calls.push(['getBillingOrder', orderId]); return currentOrder; },
    prepareSubscription: async ({ uid, customerKey }) => { calls.push(['prepareSubscription', uid, customerKey]); current = subscription({ customerKey }); currentOrder = order({ customerKey }); return { subscription: current, order: currentOrder, created: true }; },
    prepareInitialRetry: async ({ uid }) => { calls.push(['prepareInitialRetry', uid]); return { subscription: current, order: currentOrder, created: false }; },
    acquireOrderLease: async ({ uid, orderId }) => { calls.push(['acquireOrderLease', uid, orderId]); return { acquired: true, leaseToken: 'ntx_l_fixture', subscription: current, order: { ...currentOrder, leaseToken: 'ntx_l_fixture' } }; },
    storeBillingMethod: async ({ envelope }) => { calls.push(['storeBillingMethod', envelope]); current = subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: envelope, billingKeyFingerprint: envelope.fingerprint }); return current; },
    markOrderProviderRequestStarted: async () => { calls.push(['markOrderProviderRequestStarted']); currentOrder = order({ resolution: 'unknown', providerRequestStartedAt: NOW.toISOString() }); return currentOrder; },
    finalizeOrderSuccess: async ({ payment }) => { calls.push(['finalizeOrderSuccess', payment]); current = activeSubscription(); currentOrder = order({ resolution: 'succeeded', terminalResult: 'succeeded' }); return { subscription: current, order: currentOrder, payment }; },
    finalizeOrderFailure: async ({ failure }) => { calls.push(['finalizeOrderFailure', failure]); current = subscription({ billingMethodStatus: 'ready', manualRetryRequired: true }); currentOrder = order({ resolution: 'failed', terminalResult: 'failed', failureCode: failure.code, providerCode: failure.providerCode }); return { subscription: current, order: currentOrder }; },
    releaseOrderLease: async (input) => { calls.push(['releaseOrderLease', input.resolution]); return currentOrder; },
    abandonInitialRegistration: async ({ reason }) => { calls.push(['abandonInitialRegistration', reason]); current = subscription({ billingMethodStatus: 'invalid', requiresBillingMethodRegistration: true }); return { subscription: current, order: currentOrder }; },
    invalidateBillingMethod: async () => { calls.push(['invalidateBillingMethod']); current = subscription({ billingMethodStatus: 'invalid', requiresBillingMethodRegistration: true }); return current; },
    transitionSubscription: async ({ outcome }) => { calls.push(['transitionSubscription', outcome.type]); current = activeSubscription({ cancelAtPeriodEnd: outcome.type === 'cancel_requested', canceledAt: outcome.type === 'cancel_requested' ? NOW.toISOString() : null }); return current; },
  };
  return repository;
}

function handlerWith(repository, overrides = {}) {
  const provider = overrides.provider || {
    issueBillingKey: async ({ customerKey }) => ({ billingKey: 'billing-key-fixture', customerKey }),
    chargeBillingKey: async () => undefined,
    refetchBillingPayment: async ({ orderId }) => ({ paymentKey: 'pay-fixture', orderId, status: 'DONE', type: 'BILLING', amount: 8900, currency: 'KRW', method: 'CARD', approvedAt: NOW.toISOString() }),
  };
  return createBillingHandler({
    getAdminFn: () => makeAdmin(overrides.userData || null), env: overrides.env || ENV,
    fetchImpl: async () => { throw new Error('network forbidden'); }, now: () => new Date(NOW),
    randomBytes: (n) => Buffer.alloc(n, 1), logger: { info() {}, warn() {}, error() {} },
    createRepository: () => repository, createProvider: () => provider,
    generateCustomerKeyFn: () => CUSTOMER,
    encryptBillingKeyFn: () => Object.freeze({ version: 1, iv: 'fixture', tag: 'fixture', ciphertext: 'fixture', fingerprint: 'bkf1_fixture' }),
    decryptBillingKeyFn: () => 'billing-key-fixture',
    ...overrides.dependencies,
  });
}

async function main() {
  let passed = 0;
  function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed += 1; }, (error) => { error.message = `${name}: ${error.message}`; throw error; }); }

  await test('runtime config is fail closed and exact', () => {
    const config = readBillingRuntimeConfig(ENV);
    assert.deepEqual(config, { clientKey: ENV.TOSS_BILLING_CLIENT_KEY, secretKey: ENV.TOSS_BILLING_SECRET_KEY, encryptionKey: KEY, publicOrigin: 'http://localhost:3000' });
    assert.throws(() => readBillingRuntimeConfig({ ...ENV, TOSS_BILLING_ENABLED: 'TRUE' }));
    assert.throws(() => readBillingRuntimeConfig({ ...ENV, TOSS_BILLING_SECRET_KEY: 'live_sk_fixture' }));
    assert.deepEqual(getPublicPaymentConfig({ ...ENV, TOSS_BILLING_ENABLED: 'false' }), { oneTimeClientKey: ENV.TOSS_CLIENT_KEY, billingClientKey: null });
    assert(Object.isFrozen(buildBillingReturnUrls('http://localhost:3000')));
  });

  await test('payment config exposes public keys only', async () => {
    const handler = createPaymentConfigHandler({ env: ENV });
    const res = await invoke(handler, { method: 'GET', body: undefined, headers: { origin: 'http://localhost:3000' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { oneTimeClientKey: ENV.TOSS_CLIENT_KEY, billingClientKey: ENV.TOSS_BILLING_CLIENT_KEY });
    assert.equal(JSON.stringify(res.body).includes('secret'), false);
    assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  });

  await test('method origin media and auth gates fail before repository', async () => {
    const repo = makeRepository();
    const handler = handlerWith(repo);
    assert.equal((await invoke(handler, { method: 'GET' })).statusCode, 405);
    assert.equal((await invoke(handler, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await invoke(handler, { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
    assert.equal((await invoke(handler, { headers: { authorization: '' } })).statusCode, 401);
    assert.equal(repo.calls.length, 0);
    const preflight = await invoke(handler, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
    assert.equal(preflight.statusCode, 204);
  });

  await test('malformed and oversized bodies are rejected', async () => {
    const handler = handlerWith(makeRepository());
    assert.equal((await invoke(handler, { body: '{' })).statusCode, 400);
    assert.equal((await invoke(handler, { body: { action: 'status', uid: 'other' } })).statusCode, 400);
    assert.equal((await invoke(handler, { body: { action: 'status' }, headers: { 'content-length': '9000' } })).statusCode, 413);
  });

  await test('prepare returns exact 8900 product data', async () => {
    const repo = makeRepository();
    const res = await invoke(handlerWith(repo), { body: { action: 'prepare' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['action', 'amount', 'customerKey', 'failUrl', 'ok', 'orderId', 'product', 'successUrl'].sort());
    assert.deepEqual(res.body.amount, { value: 8900, currency: 'KRW' });
    assert.match(res.body.product.price, /8,900/);
    assert.match(res.body.product.cancellation, /자동 환불되지 않습니다/);
  });

  await test('activation issues, stores, charges, refetches, and activates', async () => {
    const repo = makeRepository();
    const res = await invoke(handlerWith(repo), { body: { action: 'activate', authKey: 'auth-fixture', customerKey: CUSTOMER } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.outcome, 'active');
    assert.equal(res.body.subscription.status, 'active');
    const names = repo.calls.map((entry) => entry[0]);
    assert.deepEqual(names.slice(-5), ['getBillingOrder', 'acquireOrderLease', 'storeBillingMethod', 'markOrderProviderRequestStarted', 'finalizeOrderSuccess']);
    assert.equal(JSON.stringify(res.body).includes('billing-key-fixture'), false);
  });

  await test('unknown activation refetches without a second charge', async () => {
    const repo = makeRepository(subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: { version: 1 }, billingKeyFingerprint: 'bkf1_fixture' }));
    repo.getBillingOrder = async () => order({ resolution: 'unknown', providerRequestStartedAt: NOW.toISOString() });
    repo.acquireOrderLease = async () => ({ acquired: true, leaseToken: 'ntx_l_fixture', subscription: await repo.getSubscription({ uid: 'user-1' }), order: await repo.getBillingOrder({ orderId: 'x' }) });
    let charges = 0;
    const provider = { issueBillingKey: async () => { throw new Error('issue forbidden'); }, chargeBillingKey: async () => { charges += 1; }, refetchBillingPayment: async ({ orderId }) => ({ paymentKey: 'pay', orderId, status: 'DONE', type: 'BILLING', amount: 8900, currency: 'KRW', method: 'CARD', approvedAt: NOW.toISOString() }) };
    const res = await invoke(handlerWith(repo, { provider, dependencies: { logger: { info() {}, warn() {}, error(value) { process.stderr.write(`known-failure-log:${JSON.stringify(value)}\\n`); } } } }), { body: { action: 'activate', authKey: 'ignored', customerKey: CUSTOMER } });
    assert.equal(res.statusCode, 200);
    assert.equal(charges, 0);
  });

  await test('retry begins with repository retry preparation', async () => {
    const repo = makeRepository(subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: { version: 1 }, billingKeyFingerprint: 'bkf1_fixture', initialAttempt: 1 }));
    const res = await invoke(handlerWith(repo), { body: { action: 'retry' } });
    assert.equal(res.statusCode, 200);
    assert.equal(repo.calls[0][0], 'prepareInitialRetry');
  });

  await test('prepare fails closed when billing configuration is disabled', async () => {
    const repo = makeRepository();
    const res = await invoke(handlerWith(repo, { env: { ...ENV, TOSS_BILLING_ENABLED: 'false' } }), { body: { action: 'prepare' } });
    assert.equal(res.statusCode, 503);
    assert.equal(repo.calls.some(([name]) => name === 'prepareSubscription'), false);
  });

  await test('activation returns terminal known failure without issuing or charging again', async () => {
    const repo = makeRepository();
    repo.getBillingOrder = async () => order({ resolution: 'failed', terminalResult: 'failed', failureCode: 'provider_rejected' });
    let issueCalls = 0;
    let chargeCalls = 0;
    const provider = {
      issueBillingKey: async () => { issueCalls += 1; },
      chargeBillingKey: async () => { chargeCalls += 1; },
      refetchBillingPayment: async () => { throw new Error('refetch forbidden'); },
    };
    const res = await invoke(handlerWith(repo, { provider }), { body: { action: 'activate', authKey: 'ignored', customerKey: CUSTOMER } });
    assert.equal(res.statusCode, 402);
    assert.equal(issueCalls, 0);
    assert.equal(chargeCalls, 0);
  });

  await test('a held retry lease converges to pending without a second provider POST', async () => {
    const repo = makeRepository(subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: { version: 1 }, billingKeyFingerprint: 'bkf1_fixture', initialAttempt: 1 }));
    repo.acquireOrderLease = async () => ({ acquired: false, reason: 'held', leaseExpiresAt: '2026-08-21T00:02:00.000Z' });
    let chargeCalls = 0;
    const provider = {
      issueBillingKey: async () => { throw new Error('issue forbidden'); },
      chargeBillingKey: async () => { chargeCalls += 1; },
      refetchBillingPayment: async () => { throw new Error('refetch forbidden'); },
    };
    const res = await invoke(handlerWith(repo, { provider }), { body: { action: 'retry' } });
    assert.equal(res.statusCode, 202);
    assert.equal(chargeCalls, 0);
  });

  await test('retry does not reopen a terminal known-failed attempt', async () => {
    const repo = makeRepository(subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: { version: 1 }, billingKeyFingerprint: 'bkf1_fixture', initialAttempt: 1 }));
    repo.prepareInitialRetry = async () => ({
      subscription: subscription({ billingMethodStatus: 'ready', billingKeyCiphertext: { version: 1 }, billingKeyFingerprint: 'bkf1_fixture', initialAttempt: 1 }),
      order: order({ resolution: 'failed', terminalResult: 'failed', failureCode: 'provider_rejected' }),
      created: false,
    });
    repo.acquireOrderLease = async () => ({ acquired: false, reason: 'failed', failure: { code: 'provider_rejected', providerCode: null } });
    const res = await invoke(handlerWith(repo), { body: { action: 'retry' } });
    assert.equal(res.statusCode, 402);
  });

  await test('cancel resume and status do not require billing runtime', async () => {
    const repo = makeRepository(activeSubscription());
    const disabled = { ...ENV, TOSS_BILLING_ENABLED: 'false' };
    assert.equal((await invoke(handlerWith(repo, { env: disabled }), { body: { action: 'cancel' } })).statusCode, 200);
    assert.equal((await invoke(handlerWith(repo, { env: disabled }), { body: { action: 'resume' } })).statusCode, 200);
    const status = await invoke(handlerWith(repo, { env: disabled }), { body: { action: 'status' } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.subscription.status, 'active');
  });

  await test('legacy monthly is nonrenewing only when subscription is absent', async () => {
    const repo = makeRepository(null);
    const res = await invoke(handlerWith(repo, { userData: { plan: 'monthly', planExpiry: '2026-09-21T00:00:00.000Z' } }), { body: { action: 'status' } });
    assert.deepEqual(res.body.subscription, { status: 'free' });
    assert.deepEqual(res.body.legacy, { status: 'active_nonrenewing', accessEndsAt: '2026-09-21T00:00:00.000Z', autoRenew: false });
  });

  await test('all responses are no-store and do not leak credentials', async () => {
    const res = await invoke(handlerWith(makeRepository()), { body: { action: 'prepare' } });
    assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
    const serialized = JSON.stringify(res.body);
    for (const secret of [ENV.TOSS_BILLING_SECRET_KEY, KEY, 'Bearer token']) assert.equal(serialized.includes(secret), false);
  });

  process.stdout.write(`billing API tests: ${passed} passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
