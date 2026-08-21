'use strict';

const assert = require('node:assert/strict');
const { resolveAnalysisEntitlement, planForAmount, sttPriceForUnits } = require('../api/_grant');

const NOW = new Date('2026-08-21T00:00:00.000Z');

function subscription(overrides = {}) {
  return {
    status: 'active',
    amount: 8900,
    currency: 'KRW',
    anchorAt: '2026-08-01T00:00:00.000Z',
    currentCycle: 0,
    currentPeriodStart: '2026-08-01T00:00:00.000Z',
    currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    nextAttemptAt: '2026-09-01T00:00:00.000Z',
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    renewalReconciliationState: 'none',
    billingWorkDueAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function main() {
  assert.equal(planForAmount(500), 'single');
  assert.equal(planForAmount(7900), 'monthly');
  assert.equal(planForAmount(8900), null);
  assert.equal(sttPriceForUnits(1), 1500);
  assert.equal(sttPriceForUnits(6), 6600);

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription(),
    user: { plan: 'free', planExpiry: null, usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: true, slot: 'monthly', monthKey: '2026-08' });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ status: 'canceled' }),
    user: { plan: 'monthly', planExpiry: '2026-12-01T00:00:00.000Z', usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: false, reason: 'quota_exceeded', monthCount: 99 });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: null,
    user: { plan: 'free', planExpiry: null, usage: { '2026-08': 2 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: true, slot: 'free', monthKey: '2026-08' });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ cancelAtPeriodEnd: true, canceledAt: NOW.toISOString() }),
    user: { plan: 'free', usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: true, slot: 'monthly', monthKey: '2026-08' });

  const pastDue = subscription({
    status: 'past_due', retryCount: 1, nextAttemptAt: '2026-09-02T00:00:00.000Z',
    billingWorkDueAt: '2026-09-02T00:00:00.000Z',
  });
  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: pastDue,
    user: { plan: 'free', usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: new Date('2026-09-01T00:00:00.000Z'),
  }), { allowed: true, slot: 'monthly', monthKey: '2026-09' });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ renewalReconciliationState: 'unknown', billingWorkDueAt: '2026-09-01T00:00:00.000Z' }),
    user: { plan: 'free', usage: { '2026-09': 99 }, singlePurchases: 0 },
    now: new Date('2026-09-05T00:00:00.000Z'),
  }), { allowed: true, slot: 'monthly', monthKey: '2026-09' });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ status: 'expired', nextAttemptAt: null, billingWorkDueAt: null }),
    user: { plan: 'free', usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: false, reason: 'quota_exceeded', monthCount: 99 });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ status: 'canceled', nextAttemptAt: null, billingWorkDueAt: null }),
    user: { plan: 'monthly', planExpiry: '2026-12-01T00:00:00.000Z', usage: { '2026-08': 99 }, singlePurchases: 1 },
    now: NOW,
  }), { allowed: true, slot: 'single', monthKey: '2026-08' });

  assert.deepEqual(resolveAnalysisEntitlement({
    subscription: subscription({ status: 'incomplete', anchorAt: null, currentPeriodStart: null, currentPeriodEnd: null, nextAttemptAt: null, billingWorkDueAt: null }),
    user: { plan: 'free', usage: { '2026-08': 99 }, singlePurchases: 0 },
    now: NOW,
  }), { allowed: false, reason: 'quota_exceeded', monthCount: 99 });

  process.stdout.write('billing entitlement tests: 10 passed\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
