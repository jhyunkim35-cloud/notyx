'use strict';

const assert = require('node:assert/strict');
const { createBillingCronHandler } = require('../api/billing-cron');
const { TossProviderError } = require('../api/_billing');

const NOW = new Date('2026-09-21T00:00:00.000Z');

function responseHarness() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function main() {
  const calls = [];
  const subscription = {
    uid: 'user-1', status: 'active', customerKey: 'ntx_c_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    billingMethodStatus: 'ready', billingKeyFingerprint: 'bkf1_fixture',
    currentPeriodEnd: NOW.toISOString(), nextAttemptAt: NOW.toISOString(),
    retryCount: 0,
    billingWorkDueAt: NOW.toISOString(), renewalReconciliationState: 'none',
    cancelAtPeriodEnd: false, requiresBillingMethodRegistration: false,
  };
  const order = {
    orderId: 'ntx_r_fixture', kind: 'renewal', attempt: 0, customerKey: subscription.customerKey,
    resolution: 'ready', idempotencyKey: 'ntx_i_fixture', providerRequestStartedAt: null,
  };
  const repository = {
    listDueSubscriptions: async () => [subscription],
    prepareRenewalOrder: async (input) => { calls.push(['prepareRenewalOrder', input]); return { subscription, order, created: true }; },
    acquireOrderLease: async (input) => { calls.push(['acquireOrderLease', input]); return { acquired: true, leaseToken: 'lease-1', subscription, order: { ...order, leaseToken: 'lease-1' } }; },
    markOrderProviderRequestStarted: async (input) => { calls.push(['markOrderProviderRequestStarted', input]); return { ...order, resolution: 'unknown', providerRequestStartedAt: NOW.toISOString() }; },
    finalizeOrderSuccess: async (input) => { calls.push(['finalizeOrderSuccess', input]); return { subscription: { ...subscription, status: 'active' } }; },
    finalizeOrderFailure: async (input) => { calls.push(['finalizeOrderFailure', input]); return { subscription: { ...subscription, status: 'past_due' } }; },
    releaseOrderLease: async (input) => { calls.push(['releaseOrderLease', input]); return order; },
  };
  const provider = {
    chargeBillingKey: async (input) => { calls.push(['chargeBillingKey', input]); },
    refetchBillingPayment: async () => ({ paymentKey: 'pay-1', orderId: order.orderId, status: 'DONE', type: 'BILLING', amount: 8900, currency: 'KRW', method: 'CARD', approvedAt: NOW.toISOString() }),
  };
  const handler = createBillingCronHandler({
    getAdminFn: () => ({ firestore: () => ({}) }),
    env: { BILLING_CRON_SECRET: 'cron-fixture', TOSS_BILLING_ENABLED: 'true', BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TOSS_BILLING_SECRET_KEY: 'test_sk_fixture' },
    now: () => NOW,
    createRepository: () => repository,
    createProvider: () => provider,
    decryptBillingKeyFn: () => 'billing-key-fixture',
    logger: { info() {}, warn() {}, error() {} },
  });
  const req = { method: 'POST', headers: { 'x-cron-secret': 'cron-fixture' } };
  const res = responseHarness();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 1, JSON.stringify({ body: res.body, calls }));
  assert.equal(calls.filter(([name]) => name === 'chargeBillingKey').length, 1, JSON.stringify(calls));
  assert.equal(calls.find(([name]) => name === 'chargeBillingKey')[1].amount, 8900);

  const rejectedCalls = [];
  const rejectedRepository = {
    ...repository,
    listDueSubscriptions: async () => [subscription],
    prepareRenewalOrder: async () => ({ subscription, order, created: true }),
    acquireOrderLease: async () => ({ acquired: true, leaseToken: 'lease-1', subscription, order: { ...order, leaseToken: 'lease-1' } }),
    markOrderProviderRequestStarted: async (input) => { rejectedCalls.push(['mark', input]); return { ...order, resolution: 'unknown', providerRequestStartedAt: NOW.toISOString() }; },
    finalizeOrderFailure: async (input) => { rejectedCalls.push(['failure', input]); return { subscription }; },
    releaseOrderLease: async (input) => { rejectedCalls.push(['release', input]); return order; },
  };
  const rejectedHandler = createBillingCronHandler({
    getAdminFn: () => ({ firestore: () => ({}) }),
    env: { BILLING_CRON_SECRET: 'cron-fixture', TOSS_BILLING_ENABLED: 'true', BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TOSS_BILLING_SECRET_KEY: 'test_sk_fixture' },
    now: () => NOW,
    createRepository: () => rejectedRepository,
    createProvider: () => ({
      chargeBillingKey: async () => { throw new TossProviderError('charge', 'http', 402, 'DECLINED', 'rejected'); },
      refetchBillingPayment: async () => { throw new Error('refetch forbidden'); },
    }),
    decryptBillingKeyFn: () => 'billing-key-fixture',
    logger: { info() {}, warn() {}, error() {} },
  });
  const rejectedRes = responseHarness();
  await rejectedHandler(req, rejectedRes);
  assert.equal(rejectedRes.body.failed, 1);
  assert.equal(rejectedCalls.filter(([name]) => name === 'failure').length, 1);
  assert.equal(rejectedCalls.filter(([name]) => name === 'release').length, 0);

  const canceledCalls = [];
  const canceledRepository = {
    listDueSubscriptions: async () => [{ ...subscription, cancelAtPeriodEnd: true }],
    transitionSubscription: async (input) => { canceledCalls.push(input); return subscription; },
  };
  const canceledHandler = createBillingCronHandler({
    getAdminFn: () => ({ firestore: () => ({}) }),
    env: { BILLING_CRON_SECRET: 'cron-fixture', TOSS_BILLING_ENABLED: 'true', BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TOSS_BILLING_SECRET_KEY: 'test_sk_fixture' },
    now: () => NOW,
    createRepository: () => canceledRepository,
    createProvider: () => ({ chargeBillingKey: async () => { throw new Error('charge forbidden'); } }),
    logger: { info() {}, warn() {}, error() {} },
  });
  const canceledRes = responseHarness();
  await canceledHandler(req, canceledRes);
  assert.equal(canceledRes.body.processed, 1);
  assert.deepEqual(canceledCalls, [{ uid: 'user-1', outcome: { type: 'period_expired' } }]);

  const reconciliationCalls = [];
  const reconciliationSubscription = {
    ...subscription,
    renewalReconciliationState: 'unknown',
    billingWorkDueAt: NOW.toISOString(),
  };
  const reconciliationOrder = {
    ...order,
    resolution: 'unknown',
    providerRequestStartedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    providerLastLookupAt: null,
  };
  let lookupCount = 0;
  const reconciliationRepository = {
    listDueSubscriptions: async () => [reconciliationSubscription],
    getBillingOrder: async (input) => {
      reconciliationCalls.push(['getBillingOrder', input]);
      return reconciliationOrder;
    },
    acquireRenewalReconciliationLease: async (input) => {
      reconciliationCalls.push(['acquireRenewalReconciliationLease', input]);
      return { acquired: true, leaseToken: 'reconciliation-lease' };
    },
    claimOrderReconciliationSlot: async (input) => {
      reconciliationCalls.push(['claimOrderReconciliationSlot', input]);
      return { claimed: true, subscription: reconciliationSubscription, order: { ...reconciliationOrder, leaseToken: input.leaseToken } };
    },
    finalizeOrderSuccess: async (input) => {
      reconciliationCalls.push(['finalizeOrderSuccess', input]);
      return { subscription: reconciliationSubscription };
    },
    releaseOrderLease: async (input) => {
      reconciliationCalls.push(['releaseOrderLease', input]);
      return reconciliationOrder;
    },
  };
  const reconciliationProvider = {
    refetchBillingPayment: async () => {
      lookupCount += 1;
      if (lookupCount === 1) throw new TossProviderError('lookup', 'http', 404, 'NOT_FOUND', 'order_not_found');
      return { paymentKey: 'pay-retried', orderId: reconciliationOrder.orderId, status: 'DONE', type: 'BILLING', amount: 8900, currency: 'KRW', method: 'CARD', approvedAt: NOW.toISOString() };
    },
    chargeBillingKey: async (input) => {
      reconciliationCalls.push(['chargeBillingKey', input]);
    },
  };
  const reconciliationHandler = createBillingCronHandler({
    getAdminFn: () => ({ firestore: () => ({}) }),
    env: { BILLING_CRON_SECRET: 'cron-fixture', TOSS_BILLING_ENABLED: 'true', BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TOSS_BILLING_SECRET_KEY: 'test_sk_fixture' },
    now: () => NOW,
    createRepository: () => reconciliationRepository,
    createProvider: () => reconciliationProvider,
    decryptBillingKeyFn: () => 'billing-key-fixture',
    logger: { info() {}, warn() {}, error() {} },
  });
  const reconciliationRes = responseHarness();
  await reconciliationHandler(req, reconciliationRes);
  assert.equal(reconciliationRes.body.succeeded, 1, JSON.stringify({ body: reconciliationRes.body, calls: reconciliationCalls }));
  const retry = reconciliationCalls.find(([name]) => name === 'chargeBillingKey');
  assert.deepEqual(retry[1], {
    billingKey: 'billing-key-fixture',
    customerKey: reconciliationOrder.customerKey,
    orderId: reconciliationOrder.orderId,
    orderName: 'Notyx Pro 월간 구독',
    amount: 8900,
    idempotencyKey: reconciliationOrder.idempotencyKey,
  });
  assert.equal(reconciliationCalls.filter(([name]) => name === 'getBillingOrder').length, 1);

  const unauthorizedRes = responseHarness();
  await handler({ method: 'POST', headers: { 'x-cron-secret': 'wrong' } }, unauthorizedRes);
  assert.equal(unauthorizedRes.statusCode, 401);
  process.stdout.write('billing renewal tests: 4 passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
