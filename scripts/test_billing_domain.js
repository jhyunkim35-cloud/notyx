'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const domain = require('../api/_billing-domain');

const {
  PRO_MONTHLY_AMOUNT_KRW,
  currency,
  BILLING_TIME_ZONE,
  FREE_MONTHLY_ANALYSES,
  RENEWAL_ATTEMPT_DAYS,
  addAnchoredMonth,
  periodFromAnchor,
  renewalOrderId,
  renewalIdempotencyKey,
  nextRenewalState,
  hasProEntitlement,
  sanitizeSubscription,
} = domain;

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function iso(value) {
  return new Date(value).toISOString();
}

function at(value) {
  return new Date(value);
}

function assertTypeError(fn) {
  assert.throws(fn, TypeError);
}

function assertRangeError(fn) {
  assert.throws(fn, RangeError);
}

function noBillingMutationKeys(value) {
  const forbidden = /refund|prorat|credit/i;
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      assert.equal(forbidden.test(key), false, `forbidden billing mutation key: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function baseSubscription(overrides = {}) {
  return {
    status: 'active',
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    anchorAt: '2024-01-31T00:00:00.000Z',
    currentCycle: 0,
    currentPeriodStart: '2024-01-31T00:00:00.000Z',
    currentPeriodEnd: '2024-02-29T00:00:00.000Z',
    nextAttemptAt: '2024-02-29T00:00:00.000Z',
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: '2024-01-31T00:00:00.000Z',
    lastPaymentFailedAt: null,
    updatedAt: '2024-01-31T00:00:00.000Z',
    ...overrides,
  };
}

test('exports the approved constants and freezes retry policy', () => {
  assert.equal(PRO_MONTHLY_AMOUNT_KRW, 8900);
  assert.equal(currency, 'KRW');
  assert.equal(BILLING_TIME_ZONE, 'Asia/Seoul');
  assert.equal(FREE_MONTHLY_ANALYSES, 3);
  assert.deepStrictEqual(RENEWAL_ATTEMPT_DAYS, [0, 1, 3]);
  assert.equal(Object.isFrozen(RENEWAL_ATTEMPT_DAYS), true);
});

test('adds a same-day Seoul calendar month and returns a new Date', () => {
  const source = at('2024-04-15T03:04:05.006Z');
  const result = addAnchoredMonth(source, 15, 'Asia/Seoul');
  assert.equal(result.toISOString(), '2024-05-15T03:04:05.006Z');
  assert.notStrictEqual(result, source);
  assert.equal(source.toISOString(), '2024-04-15T03:04:05.006Z');
});

test('clamps month-end anchors and preserves the Seoul wall-clock time', () => {
  assert.equal(
    addAnchoredMonth(at('2024-01-31T14:59:59.999Z'), 31, 'Asia/Seoul').toISOString(),
    '2024-02-29T14:59:59.999Z',
  );
  assert.equal(
    addAnchoredMonth(at('2023-01-31T14:59:59.999Z'), 31, 'Asia/Seoul').toISOString(),
    '2023-02-28T14:59:59.999Z',
  );
});

test('handles leap February and Seoul UTC crossover without host-local arithmetic', () => {
  assert.equal(
    addAnchoredMonth(at('2024-02-29T14:59:59.999Z'), 29, 'Asia/Seoul').toISOString(),
    '2024-03-29T14:59:59.999Z',
  );
  assert.equal(
    addAnchoredMonth(at('2024-01-31T14:59:59.999Z'), 31, 'Asia/Seoul').toISOString(),
    '2024-02-29T14:59:59.999Z',
  );
  const script = [
    "const d=require('./api/_billing-domain');",
    "process.stdout.write(d.addAnchoredMonth(new Date('2024-01-31T14:59:59.999Z'),31,'Asia/Seoul').toISOString());",
  ].join('');
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '2024-02-29T14:59:59.999Z');
  }
});

test('computes high-cycle periods directly from the original anchor and recovers month-end day', () => {
  const source = at('2024-01-31T00:00:00.000Z');
  const cycleOne = periodFromAnchor(source, 1);
  const cycleTwo = periodFromAnchor(source, 2);
  const cycleThirteen = periodFromAnchor(source, 13);
  assert.deepStrictEqual(
    { start: cycleOne.start.toISOString(), end: cycleOne.end.toISOString() },
    { start: '2024-02-29T00:00:00.000Z', end: '2024-03-31T00:00:00.000Z' },
  );
  assert.deepStrictEqual(
    { start: cycleTwo.start.toISOString(), end: cycleTwo.end.toISOString() },
    { start: '2024-03-31T00:00:00.000Z', end: '2024-04-30T00:00:00.000Z' },
  );
  assert.deepStrictEqual(
    { start: cycleThirteen.start.toISOString(), end: cycleThirteen.end.toISOString() },
    { start: '2025-02-28T00:00:00.000Z', end: '2025-03-31T00:00:00.000Z' },
  );
  assert.notStrictEqual(cycleOne.start, source);
  assert.equal(source.toISOString(), '2024-01-31T00:00:00.000Z');
});

test('rejects invalid calendar arguments with the contract error types', () => {
  assertTypeError(() => addAnchoredMonth('2024-01-01T00:00:00.000Z', 1, BILLING_TIME_ZONE));
  assertRangeError(() => addAnchoredMonth(new Date('invalid'), 1, BILLING_TIME_ZONE));
  assertTypeError(() => addAnchoredMonth(at('2024-01-01T00:00:00.000Z'), '1', BILLING_TIME_ZONE));
  assertRangeError(() => addAnchoredMonth(at('2024-01-01T00:00:00.000Z'), 0, BILLING_TIME_ZONE));
  assertRangeError(() => addAnchoredMonth(at('2024-01-01T00:00:00.000Z'), 32, BILLING_TIME_ZONE));
  assertRangeError(() => addAnchoredMonth(at('2024-01-01T00:00:00.000Z'), 1, 'UTC'));
  assertTypeError(() => periodFromAnchor('2024-01-01T00:00:00.000Z', 0));
  assertRangeError(() => periodFromAnchor(at('invalid'), 0));
  assertRangeError(() => periodFromAnchor(at('2024-01-01T00:00:00.000Z'), 0.5));
  assertRangeError(() => periodFromAnchor(at('2024-01-01T00:00:00.000Z'), -1));
  assertRangeError(() => periodFromAnchor(at('2024-01-01T00:00:00.000Z'), Number.MAX_SAFE_INTEGER + 1));
});

test('creates deterministic purpose-separated Toss-compatible identifiers', () => {
  const uid = '한글-user';
  const periodStart = '2024-01-31T00:00:00.000Z';
  const attempt = 3;
  const byteLength = Buffer.byteLength(uid, 'utf8');
  const orderPreimage = `notyx|billing|v1|order|${byteLength}:${uid}|${periodStart}|d${attempt}`;
  const idempotencyPreimage = `notyx|billing|v1|idempotency|${byteLength}:${uid}|${periodStart}|d${attempt}`;
  const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(renewalOrderId(uid, periodStart, attempt), `ntx_r_${hash(orderPreimage).slice(0, 48)}`);
  assert.equal(renewalIdempotencyKey(uid, periodStart, attempt), `ntx_i_${hash(idempotencyPreimage)}`);
  assert.equal(renewalOrderId(uid, periodStart, attempt).length, 54);
  assert.equal(renewalIdempotencyKey(uid, periodStart, attempt).length, 70);
  assert.notEqual(renewalOrderId(uid, periodStart, attempt), renewalOrderId(uid, periodStart, 1));
  assert.notEqual(renewalOrderId(uid, periodStart, attempt), renewalIdempotencyKey(uid, periodStart, attempt));
  assert.equal(renewalOrderId(uid, periodStart, attempt).includes(uid), false);
  assert.equal(renewalOrderId(uid, periodStart, attempt).includes(periodStart), false);
});

test('validates identifier inputs and canonical ISO period starts', () => {
  assertTypeError(() => renewalOrderId(123, '2024-01-01T00:00:00.000Z', 0));
  assertRangeError(() => renewalOrderId('', '2024-01-01T00:00:00.000Z', 0));
  assertRangeError(() => renewalOrderId('x'.repeat(129), '2024-01-01T00:00:00.000Z', 0));
  assertTypeError(() => renewalOrderId('u', new Date('2024-01-01T00:00:00.000Z'), 0));
  assertRangeError(() => renewalOrderId('u', '2024-01-01T09:00:00Z', 0));
  assertRangeError(() => renewalOrderId('u', 'not-a-date', 0));
  assertTypeError(() => renewalOrderId('u', '2024-01-01T00:00:00.000Z', '0'));
  assertRangeError(() => renewalOrderId('u', '2024-01-01T00:00:00.000Z', 2));
  assertRangeError(() => renewalOrderId('u', '2024-01-01T00:00:00.000Z', 4));
});

test('initial success anchors cycle zero at the actual success time', () => {
  const now = at('2024-05-15T03:04:05.006Z');
  const input = {
    status: 'incomplete',
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    anchorAt: null,
    currentCycle: 0,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextAttemptAt: null,
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: true,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: null,
    lastPaymentFailedAt: '2024-05-14T03:04:05.006Z',
    updatedAt: '2024-05-14T03:04:05.006Z',
  };
  const patch = nextRenewalState(input, { type: 'initial_payment_succeeded' }, now);
  assert.deepStrictEqual(patch, {
    status: 'active',
    anchorAt: '2024-05-15T03:04:05.006Z',
    currentCycle: 0,
    currentPeriodStart: '2024-05-15T03:04:05.006Z',
    currentPeriodEnd: '2024-06-15T03:04:05.006Z',
    nextAttemptAt: '2024-06-15T03:04:05.006Z',
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: '2024-05-15T03:04:05.006Z',
    lastPaymentFailedAt: null,
    updatedAt: '2024-05-15T03:04:05.006Z',
  });
  assert.equal(input.anchorAt, null);
  assert.equal(input.lastPaymentFailedAt, '2024-05-14T03:04:05.006Z');
  noBillingMutationKeys(patch);
});

test('initial failure stays incomplete, grants no Pro, and exposes manual retry', () => {
  const now = at('2024-05-15T03:04:05.006Z');
  const patch = nextRenewalState(baseSubscription({
    status: 'incomplete',
    anchorAt: null,
    currentCycle: 0,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextAttemptAt: null,
    retryCount: 0,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: null,
    lastPaymentFailedAt: null,
  }), { type: 'initial_payment_failed' }, now);
  assert.deepStrictEqual(patch, {
    status: 'incomplete',
    anchorAt: null,
    currentCycle: 0,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextAttemptAt: null,
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: true,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: null,
    lastPaymentFailedAt: '2024-05-15T03:04:05.006Z',
    updatedAt: '2024-05-15T03:04:05.006Z',
  });
  assert.equal(hasProEntitlement({ ...baseSubscription(), ...patch }, now), false);
});

test('renewal success attempt zero advances from the original due period', () => {
  const now = at('2024-03-01T00:00:00.000Z');
  const patch = nextRenewalState(baseSubscription(), { type: 'renewal_payment_succeeded', attempt: 0 }, now);
  assert.deepStrictEqual(patch, {
    status: 'active',
    currentCycle: 1,
    currentPeriodStart: '2024-02-29T00:00:00.000Z',
    currentPeriodEnd: '2024-03-31T00:00:00.000Z',
    nextAttemptAt: '2024-03-31T00:00:00.000Z',
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: '2024-03-01T00:00:00.000Z',
    lastPaymentFailedAt: null,
    updatedAt: '2024-03-01T00:00:00.000Z',
  });
});

test('renewal success after day one uses the old due boundary, not retry time', () => {
  const old = baseSubscription({
    status: 'past_due',
    retryCount: 1,
    nextAttemptAt: '2024-03-01T00:00:00.000Z',
    lastPaymentFailedAt: '2024-02-29T00:00:00.000Z',
  });
  const patch = nextRenewalState(old, { type: 'renewal_payment_succeeded', attempt: 1 }, at('2024-03-02T12:00:00.000Z'));
  assert.equal(patch.currentCycle, 1);
  assert.equal(patch.currentPeriodStart, '2024-02-29T00:00:00.000Z');
  assert.equal(patch.currentPeriodEnd, '2024-03-31T00:00:00.000Z');
  assert.equal(patch.lastPaymentAt, '2024-03-02T12:00:00.000Z');
  assert.equal(patch.lastPaymentFailedAt, null);
});

test('renewal success after day three resets retry state from the original period', () => {
  const old = baseSubscription({
    status: 'past_due',
    retryCount: 2,
    nextAttemptAt: '2024-03-03T00:00:00.000Z',
    lastPaymentFailedAt: '2024-03-01T00:00:00.000Z',
  });
  const patch = nextRenewalState(old, { type: 'renewal_payment_succeeded', attempt: 3 }, at('2024-03-04T00:00:00.000Z'));
  assert.equal(patch.currentCycle, 1);
  assert.equal(patch.currentPeriodStart, '2024-02-29T00:00:00.000Z');
  assert.equal(patch.currentPeriodEnd, '2024-03-31T00:00:00.000Z');
  assert.equal(patch.nextAttemptAt, '2024-03-31T00:00:00.000Z');
  assert.equal(patch.retryCount, 0);
});

test('renewal failures use exact day-zero, day-one, and day-three Seoul timestamps', () => {
  const day0 = nextRenewalState(baseSubscription(), { type: 'renewal_payment_failed_day_0' }, at('2024-02-29T00:00:00.000Z'));
  assert.deepStrictEqual(day0, {
    status: 'past_due',
    retryCount: 1,
    nextAttemptAt: '2024-03-01T00:00:00.000Z',
    lastPaymentFailedAt: '2024-02-29T00:00:00.000Z',
    updatedAt: '2024-02-29T00:00:00.000Z',
  });

  const day1Input = baseSubscription({
    status: 'past_due',
    retryCount: 1,
    nextAttemptAt: '2024-03-01T00:00:00.000Z',
  });
  const day1 = nextRenewalState(day1Input, { type: 'renewal_payment_failed_day_1' }, at('2024-03-01T00:00:00.000Z'));
  assert.deepStrictEqual(day1, {
    status: 'past_due',
    retryCount: 2,
    nextAttemptAt: '2024-03-03T00:00:00.000Z',
    lastPaymentFailedAt: '2024-03-01T00:00:00.000Z',
    updatedAt: '2024-03-01T00:00:00.000Z',
  });

  const day3Input = { ...day1Input, status: 'past_due', retryCount: 2, nextAttemptAt: '2024-03-03T00:00:00.000Z' };
  const day3 = nextRenewalState(day3Input, { type: 'renewal_payment_failed_day_3' }, at('2024-03-03T00:00:00.000Z'));
  assert.deepStrictEqual(day3, {
    status: 'expired',
    retryCount: 3,
    nextAttemptAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: true,
    lastPaymentFailedAt: '2024-03-03T00:00:00.000Z',
    updatedAt: '2024-03-03T00:00:00.000Z',
  });
  assert.equal(day3Input.currentPeriodEnd, '2024-02-29T00:00:00.000Z');
});

test('keeps Pro during structurally valid past_due grace before and after a missed retry', () => {
  const subscription = baseSubscription({
    status: 'past_due',
    retryCount: 1,
    nextAttemptAt: '2024-03-01T00:00:00.000Z',
  });
  assert.equal(hasProEntitlement(subscription, at('2024-02-29T00:00:00.000Z')), true);
  assert.equal(hasProEntitlement(subscription, at('2024-03-02T00:00:00.000Z')), true);
  assert.equal(hasProEntitlement({ ...subscription, retryCount: 2, nextAttemptAt: '2024-03-03T00:00:00.000Z' }, at('2024-03-04T00:00:00.000Z')), true);
  assert.equal(hasProEntitlement({ ...subscription, retryCount: 3 }, at('2024-03-04T00:00:00.000Z')), false);
});

test('rejects early attempts, invalid outcome keys, and invalid state/attempt combinations', () => {
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'renewal_payment_failed_day_0' }, at('2024-02-28T23:59:59.999Z')));
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'renewal_payment_succeeded', attempt: 1 }, at('2024-02-29T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription({ status: 'past_due', retryCount: 1, nextAttemptAt: '2024-03-01T00:00:00.000Z' }), { type: 'renewal_payment_succeeded', attempt: 3 }, at('2024-03-01T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription({ status: 'past_due', retryCount: 1, nextAttemptAt: '2024-03-01T00:00:00.000Z' }), { type: 'renewal_payment_failed_day_3' }, at('2024-03-03T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription({ cancelAtPeriodEnd: true }), { type: 'renewal_payment_failed_day_0' }, at('2024-02-29T00:00:00.000Z')));
  assertTypeError(() => nextRenewalState(baseSubscription(), 'renewal_payment_succeeded', at('2024-02-29T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'unknown' }, at('2024-02-29T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'renewal_payment_succeeded', attempt: 0, extra: true }, at('2024-02-29T00:00:00.000Z')));
  assertTypeError(() => nextRenewalState(baseSubscription(), { type: 'renewal_payment_succeeded', attempt: 0 }, '2024-02-29T00:00:00.000Z'));
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'renewal_payment_succeeded', attempt: 0 }, at('invalid')));
});

test('cancels at period end without refund/proration and preserves the original cancellation time', () => {
  const now = at('2024-02-10T00:00:00.000Z');
  const scheduled = nextRenewalState(baseSubscription(), { type: 'cancel_requested' }, now);
  assert.deepStrictEqual(scheduled, {
    cancelAtPeriodEnd: true,
    canceledAt: '2024-02-10T00:00:00.000Z',
    updatedAt: '2024-02-10T00:00:00.000Z',
  });
  assert.deepStrictEqual(nextRenewalState({ ...baseSubscription(), ...scheduled }, { type: 'cancel_requested' }, at('2024-02-11T00:00:00.000Z')), {});
  noBillingMutationKeys(scheduled);

  const expired = nextRenewalState(
    { ...baseSubscription(), ...scheduled },
    { type: 'period_expired' },
    at('2024-02-29T00:00:00.000Z'),
  );
  assert.deepStrictEqual(expired, {
    status: 'canceled',
    nextAttemptAt: null,
    updatedAt: '2024-02-29T00:00:00.000Z',
  });
  noBillingMutationKeys(expired);
});

test('resumes a scheduled cancellation only before period end and is idempotent when already resumed', () => {
  const scheduled = baseSubscription({ cancelAtPeriodEnd: true, canceledAt: '2024-02-10T00:00:00.000Z' });
  assert.deepStrictEqual(
    nextRenewalState(scheduled, { type: 'resume_requested' }, at('2024-02-11T00:00:00.000Z')),
    { cancelAtPeriodEnd: false, canceledAt: null, updatedAt: '2024-02-11T00:00:00.000Z' },
  );
  assert.deepStrictEqual(nextRenewalState(baseSubscription(), { type: 'resume_requested' }, at('2024-02-11T00:00:00.000Z')), {});
  assertRangeError(() => nextRenewalState(scheduled, { type: 'resume_requested' }, at('2024-02-29T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState({ ...scheduled, status: 'canceled' }, { type: 'resume_requested' }, at('2024-02-11T00:00:00.000Z')));
});

test('cancels past_due and at-or-after-end subscriptions immediately without a future attempt', () => {
  const pastDue = nextRenewalState(
    baseSubscription({ status: 'past_due', retryCount: 1, nextAttemptAt: '2024-03-01T00:00:00.000Z' }),
    { type: 'cancel_requested' },
    at('2024-03-01T00:00:00.000Z'),
  );
  assert.deepStrictEqual(pastDue, {
    status: 'canceled',
    nextAttemptAt: null,
    canceledAt: '2024-03-01T00:00:00.000Z',
    updatedAt: '2024-03-01T00:00:00.000Z',
  });
  const atEnd = nextRenewalState(baseSubscription(), { type: 'cancel_requested' }, at('2024-02-29T00:00:00.000Z'));
  assert.deepStrictEqual(atEnd, {
    status: 'canceled',
    nextAttemptAt: null,
    cancelAtPeriodEnd: true,
    canceledAt: '2024-02-29T00:00:00.000Z',
    updatedAt: '2024-02-29T00:00:00.000Z',
  });
});

test('entitlement is half-open for active periods and fails closed for malformed or KRW 500 records', () => {
  const subscription = baseSubscription();
  assert.equal(hasProEntitlement(subscription, at('2024-01-30T23:59:59.999Z')), false);
  assert.equal(hasProEntitlement(subscription, at('2024-01-31T00:00:00.000Z')), true);
  assert.equal(hasProEntitlement(subscription, at('2024-02-28T23:59:59.999Z')), true);
  assert.equal(hasProEntitlement(subscription, at('2024-02-29T00:00:00.000Z')), false);
  assert.equal(hasProEntitlement({ ...subscription, amount: 500 }, at('2024-02-01T00:00:00.000Z')), false);
  assert.equal(hasProEntitlement({ ...subscription, currency: 'USD' }, at('2024-02-01T00:00:00.000Z')), false);
  assert.equal(hasProEntitlement({ ...subscription, status: 'incomplete' }, at('2024-02-01T00:00:00.000Z')), false);
  assert.equal(hasProEntitlement(null, at('2024-02-01T00:00:00.000Z')), false);
  assertTypeError(() => hasProEntitlement(subscription, '2024-02-01T00:00:00.000Z'));
  assertRangeError(() => hasProEntitlement(subscription, at('invalid')));
});

test('free quota remains exactly three analyses and is unrelated to the KRW 500 product', () => {
  assert.equal(FREE_MONTHLY_ANALYSES, 3);
  assert.equal(PRO_MONTHLY_AMOUNT_KRW, 8900);
  assert.equal(hasProEntitlement({ ...baseSubscription(), amount: 500 }, at('2024-02-01T00:00:00.000Z')), false);
});

test('sanitizes with an exact field allowlist and does not leak nested server secrets', () => {
  const source = baseSubscription({
    status: 'active',
    customerKey: 'customer-secret',
    billingKeyCiphertext: { nested: 'billing-secret' },
    uid: 'uid-secret',
    authToken: 'auth-secret',
    orderId: 'order-secret',
    idempotencyKey: 'idempotency-secret',
    lease: { token: 'lease-secret' },
    error: { message: 'provider-secret' },
  });
  const sanitized = sanitizeSubscription(source);
  assert.deepStrictEqual(sanitized, {
    status: 'active',
    amount: 8900,
    currency: 'KRW',
    currentPeriodStart: '2024-01-31T00:00:00.000Z',
    currentPeriodEnd: '2024-02-29T00:00:00.000Z',
    nextBillingAt: '2024-02-29T00:00:00.000Z',
    nextRetryAt: null,
    accessEndsAt: null,
    cancelAtPeriodEnd: false,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
  });
  assert.deepStrictEqual(sanitizeSubscription(null), { status: 'free' });
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'customerKey'), false);
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);
});

test('sanitizes past_due, scheduled cancellation, and terminal status projections', () => {
  const pastDue = sanitizeSubscription(baseSubscription({
    status: 'past_due',
    retryCount: 1,
    nextAttemptAt: '2024-03-01T00:00:00.000Z',
  }));
  assert.equal(pastDue.status, 'past_due');
  assert.equal(pastDue.nextBillingAt, null);
  assert.equal(pastDue.nextRetryAt, '2024-03-01T00:00:00.000Z');
  assert.equal(pastDue.accessEndsAt, null);

  const scheduled = sanitizeSubscription(baseSubscription({
    cancelAtPeriodEnd: true,
    canceledAt: '2024-02-10T00:00:00.000Z',
  }));
  assert.equal(scheduled.nextBillingAt, null);
  assert.equal(scheduled.accessEndsAt, '2024-02-29T00:00:00.000Z');
  assert.equal(scheduled.cancelAtPeriodEnd, true);

  for (const status of ['canceled', 'expired']) {
    const terminal = sanitizeSubscription(baseSubscription({
      status,
      nextAttemptAt: null,
      retryCount: 3,
      cancelAtPeriodEnd: status === 'canceled',
      requiresBillingMethodRegistration: status === 'expired',
    }));
    assert.equal(terminal.status, status);
    assert.equal(terminal.nextBillingAt, null);
    assert.equal(terminal.nextRetryAt, null);
    assert.equal(terminal.accessEndsAt, '2024-02-29T00:00:00.000Z');
  }
});

test('rejects malformed subscriptions at state and sanitizer boundaries', () => {
  assertTypeError(() => sanitizeSubscription(undefined));
  assertTypeError(() => sanitizeSubscription('subscription'));
  assertTypeError(() => sanitizeSubscription(baseSubscription({ status: 123 })));
  assertRangeError(() => sanitizeSubscription({ status: 'active' }));
  assertRangeError(() => sanitizeSubscription(baseSubscription({ amount: 500 })));
  assertRangeError(() => sanitizeSubscription(baseSubscription({ currency: 'USD' })));
  assertRangeError(() => sanitizeSubscription(baseSubscription({ currentPeriodEnd: '2024-02-28T00:00:00.000Z' })));
  assertRangeError(() => sanitizeSubscription(baseSubscription({ retryCount: 4 })));
  assertRangeError(() => nextRenewalState(baseSubscription({ currentPeriodEnd: '2024-02-28T00:00:00.000Z' }), { type: 'cancel_requested' }, at('2024-02-10T00:00:00.000Z')));
  assertRangeError(() => nextRenewalState(baseSubscription(), { type: 'cancel_requested' }, at('invalid')));
});

test('emits canonical ISO dates and updatedAt on every nonempty transition patch', () => {
  const transitions = [
    [baseSubscription({ status: 'incomplete', anchorAt: null, currentPeriodStart: null, currentPeriodEnd: null, nextAttemptAt: null, lastPaymentAt: null }), { type: 'initial_payment_succeeded' }, at('2024-05-15T03:04:05.006Z')],
    [baseSubscription({ status: 'incomplete', anchorAt: null, currentPeriodStart: null, currentPeriodEnd: null, nextAttemptAt: null, lastPaymentAt: null }), { type: 'initial_payment_failed' }, at('2024-05-15T03:04:05.006Z')],
    [baseSubscription(), { type: 'renewal_payment_failed_day_0' }, at('2024-02-29T00:00:00.000Z')],
    [baseSubscription(), { type: 'cancel_requested' }, at('2024-02-10T00:00:00.000Z')],
  ];
  for (const [subscription, outcome, now] of transitions) {
    const patch = nextRenewalState(subscription, outcome, now);
    assert.notDeepEqual(patch, {});
    assert.equal(patch.updatedAt, now.toISOString());
    for (const [key, value] of Object.entries(patch)) {
      if (/At$/.test(key) && value !== null) assert.equal(iso(value), value, key);
    }
  }
});

process.stdout.write(`${passed} billing domain tests passed\n`);
