'use strict';

const assert = require('node:assert/strict');
const { createTossWebhookHandler, BILLING_DELETED_AUTH_HEADER, BILLING_DELETED_SECRET_ENV } = require('../api/toss-webhook');

function responseHarness() {
  return {
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function billingDeletedRequest(headerValue) {
  return {
    method: 'POST',
    headers: headerValue === undefined ? {} : { [BILLING_DELETED_AUTH_HEADER]: headerValue },
    body: { eventType: 'BILLING_DELETED', data: { billingKey: 'billing_fixture_secret' } },
  };
}

async function main() {
  let fingerprintCalls = 0;
  let repositoryCalls = 0;
  const handler = createTossWebhookHandler({
    env: {
      TOSS_BILLING_ENABLED: 'true',
      BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      [BILLING_DELETED_SECRET_ENV]: 'deletion-secret-fixture',
    },
    fingerprintBillingKeyFn: () => { fingerprintCalls += 1; return 'bkf1_fixture'; },
    createRepositoryFn: () => { repositoryCalls += 1; return {}; },
    getAdminFn: () => ({ firestore: () => ({}) }),
  });

  for (const headerValue of [undefined, 'wrong-secret']) {
    const res = responseHarness();
    await handler(billingDeletedRequest(headerValue), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, error: 'unauthorized' });
    assert.equal(fingerprintCalls, 0);
    assert.equal(repositoryCalls, 0);
  }

  const validHandler = createTossWebhookHandler({
    env: {
      TOSS_BILLING_ENABLED: 'true',
      BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      [BILLING_DELETED_SECRET_ENV]: 'deletion-secret-fixture',
    },
    fingerprintBillingKeyFn: (billingKey) => {
      assert.equal(billingKey, 'billing_fixture_secret');
      fingerprintCalls += 1;
      return 'bkf1_fixture';
    },
    createRepositoryFn: () => ({
      findSubscriptionUidByBillingKeyFingerprint: async () => null,
    }),
    getAdminFn: () => ({ firestore: () => ({}) }),
  });
  const validRes = responseHarness();
  await validHandler(billingDeletedRequest('deletion-secret-fixture'), validRes);
  assert.equal(validRes.statusCode, 200);
  assert.deepEqual(validRes.body, { ok: true, ignored: 'unknown_billing_key' });
  assert.equal(fingerprintCalls, 1);
  assert.equal(repositoryCalls, 0);
  process.stdout.write('toss webhook tests: 3 passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
