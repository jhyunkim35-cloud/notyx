'use strict';

const assert = require('node:assert/strict');

const billing = require('../api/_billing');
const domain = require('../api/_billing-domain');

const {
  PRO_MONTHLY_AMOUNT_KRW,
  currency,
  renewalOrderId,
  renewalIdempotencyKey,
} = domain;

const UID = 'repository-user-fixture';
const CUSTOMER_A = 'ntx_c_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CUSTOMER_B = 'ntx_c_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = '2026-08-21T00:00:00.000Z';
const PAYMENT_KEY = 'pay_fixture_repository_001';
const CANARY = {
  billingKey: 'billing-secret-fixture',
  authKey: 'auth-secret-fixture',
  customerKey: CUSTOMER_A,
  secretKey: 'server-secret-fixture',
  encryptionKey: MASTER_KEY,
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pathFor(collection, id) {
  return `${collection}/${id}`;
}

class Snapshot {
  constructor(ref, data) {
    this.exists = data !== undefined;
    this.id = ref.id;
    this.ref = ref;
    this._data = clone(data);
  }

  data() {
    return clone(this._data);
  }
}

class Query {
  constructor(adapter, collection) {
    this.adapter = adapter;
    this.collection = collection;
    this.filters = [];
    this.order = null;
    this.max = null;
  }

  where(field, operator, value) {
    this.filters.push({ field, operator, value: clone(value) });
    return this;
  }

  orderBy(field, direction) {
    this.order = { field, direction };
    return this;
  }

  limit(value) {
    this.max = value;
    return this;
  }

  async get() {
    const dueShape = this.collection === 'subscriptions'
      && this.filters.length === 3
      && this.filters[0].field === 'status'
      && this.filters[0].operator === 'in'
      && JSON.stringify(this.filters[0].value) === JSON.stringify(['active', 'past_due'])
      && this.filters[1].field === 'renewalReconciliationState'
      && this.filters[1].operator === 'in'
      && JSON.stringify(this.filters[1].value) === JSON.stringify(['none', 'unknown'])
      && this.filters[2].field === 'billingWorkDueAt'
      && this.filters[2].operator === '<='
      && this.order && this.order.field === 'billingWorkDueAt'
      && this.order.direction === 'asc'
      && Number.isInteger(this.max) && this.max >= 1 && this.max <= 100;
    const fingerprintShape = this.collection === 'subscriptions'
      && this.filters.length === 1
      && this.filters[0].field === 'billingKeyFingerprint'
      && this.filters[0].operator === '=='
      && this.order === null
      && this.max === 2;
    if (!dueShape && !fingerprintShape) throw new Error('unsupported query shape');
    this.adapter.queries.push({
      collection: this.collection,
      filters: clone(this.filters),
      order: clone(this.order),
      limit: this.max,
    });
    let docs = [];
    for (const [path, data] of this.adapter.documents) {
      const [collection, id] = path.split('/');
      if (collection !== this.collection) continue;
      if (this.filters.every(({ field, operator, value }) => {
        const actual = data[field];
        if (operator === '==') return actual === value;
        if (operator === '<=') return typeof actual === 'string' && actual <= value;
        if (operator === 'in') return Array.isArray(value) && value.includes(actual);
        throw new Error(`unsupported query operator: ${operator}`);
      })) docs.push(new Snapshot(this.adapter.doc(collection, id), data));
    }
    if (this.order) {
      const { field, direction } = this.order;
      docs.sort((left, right) => {
        const a = left.data()[field];
        const b = right.data()[field];
        return direction === 'desc' ? (a < b ? 1 : a > b ? -1 : 0) : (a < b ? -1 : a > b ? 1 : 0);
      });
    }
    if (this.max !== null) docs = docs.slice(0, this.max);
    return { empty: docs.length === 0, size: docs.length, docs };
  }
}

class Transaction {
  constructor(adapter) {
    this.adapter = adapter;
    this.reads = new Map();
    this.writes = [];
  }

  async get(ref) {
    if (!this.reads.has(ref.path)) this.reads.set(ref.path, clone(this.adapter.documents.get(ref.path)));
    return new Snapshot(ref, this.reads.get(ref.path));
  }

  create(ref, data) {
    this.writes.push({ op: 'create', ref, data: clone(data) });
    return this;
  }

  set(ref, data, options) {
    if (!options || options.merge !== true) throw new Error('adapter only supports merge set');
    this.writes.push({ op: 'set', ref, data: clone(data), merge: true });
    return this;
  }

  update(ref, patch) {
    this.writes.push({ op: 'update', ref, data: clone(patch) });
    return this;
  }
}

class MemoryFirestore {
  constructor() {
    this.documents = new Map();
    this.writeLog = [];
    this.queries = [];
    this.failNextCommit = false;
    this.queue = Promise.resolve();
  }

  collection(name) {
    return {
      doc: (id) => this.doc(name, id),
      where: (field, operator, value) => new Query(this, name).where(field, operator, value),
    };
  }

  doc(collection, id) {
    return {
      collection,
      id,
      path: pathFor(collection, id),
      get: async () => new Snapshot(this.doc(collection, id), this.documents.get(pathFor(collection, id))),
    };
  }

  async runTransaction(callback) {
    const run = this.queue.then(async () => {
      const tx = new Transaction(this);
      const result = await callback(tx);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('injected adapter commit failure');
      }
      const staged = new Map([...this.documents].map(([path, data]) => [path, clone(data)]));
      const stagedLog = [];
      for (const write of tx.writes) {
        const path = write.ref.path;
        if (write.op === 'create') {
          if (staged.has(path)) throw new Error('create-on-existing');
          staged.set(path, clone(write.data));
        } else if (write.op === 'update') {
          if (!staged.has(path)) throw new Error('update-on-missing');
          staged.set(path, { ...staged.get(path), ...clone(write.data) });
        } else if (write.op === 'set') {
          const prior = staged.get(path);
          staged.set(path, write.merge && prior ? { ...prior, ...clone(write.data) } : clone(write.data));
        }
        stagedLog.push({ op: write.op, path, data: clone(write.data), merge: write.merge === true });
      }
      this.documents = staged;
      this.writeLog.push(...stagedLog);
      return result;
    });
    run.catch((error) => { this.lastError = error; });
    this.queue = run.catch(() => undefined);
    return run;
  }

  seed(collection, id, data) {
    this.documents.set(pathFor(collection, id), clone(data));
  }

  read(collection, id) {
    return clone(this.documents.get(pathFor(collection, id)));
  }
}

class Clock {
  constructor(value = NOW) {
    this.value = value;
    this.calls = 0;
  }

  now = () => {
    this.calls += 1;
    return new Date(this.value);
  };

  set(value) {
    this.value = value;
  }
}

function repository(adapter = new MemoryFirestore(), clock = new Clock(), randomBytes) {
  return {
    adapter,
    clock,
    repo: billing.createBillingRepository({
      firestore: adapter,
      now: clock.now,
      randomBytes: randomBytes || (() => Buffer.alloc(16, 1)),
      leaseMs: 120000,
    }),
  };
}

function assertNoUndefined(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      assert.notEqual(child, undefined);
      assertNoUndefined(child);
    }
  }
}

function assertProjection(adapter, expected) {
  assert.deepEqual(adapter.read('users', UID), { ...expected, usage: 4, singleCredits: 1 });
  const projectionWrites = adapter.writeLog.filter((entry) => entry.path === `users/${UID}`);
  for (const write of projectionWrites) {
    assert.equal(write.merge, true);
    assert.deepEqual(Object.keys(write.data).sort(), ['plan', 'planExpiry']);
    assert.equal(JSON.stringify(write.data).includes(CANARY.customerKey), false);
    assert.equal(JSON.stringify(write.data).includes(CANARY.encryptionKey), false);
  }
}

function validPayment(orderId, approvedAt = NOW) {
  return {
    paymentKey: PAYMENT_KEY,
    orderId,
    status: 'DONE',
    type: 'BILLING',
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    method: 'CARD',
    approvedAt,
  };
}

async function expectSafeError(fn, ErrorType, fields = {}) {
  await assert.rejects(fn, (error) => {
    assert.equal(error instanceof ErrorType, true);
    assert.equal(error.message, 'Billing repository operation failed');
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    for (const [key, value] of Object.entries(fields)) assert.equal(error[key], value);
    const serialized = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(billing.redactSensitive(error))}`;
    for (const secret of Object.values(CANARY)) assert.equal(serialized.includes(secret), false);
    return true;
  });
}

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
  };

  await test('preserves Task 2 exports and appends exact frozen repository API', async () => {
    for (const name of [
      'BILLING_ENVELOPE_VERSION', 'TOSS_API_BASE_URL', 'TOSS_TIMEOUT_MS',
      'BillingConfigurationError', 'BillingCryptoError', 'TossProviderError',
      'BillingPaymentValidationError', 'validateCustomerKey', 'generateCustomerKey',
      'fingerprintBillingKey', 'encryptBillingKey', 'decryptBillingKey', 'redactSensitive',
      'normalizeBillingIssue', 'normalizeBillingPayment', 'createTossClient',
    ]) assert.equal(typeof billing[name] === 'function' || billing[name] !== undefined, true, name);
    assert.equal(billing.BILLING_SCHEMA_VERSION, 1);
    assert.equal(billing.BILLING_LEASE_MS, 120000);
    assert.equal(billing.MAX_DUE_SUBSCRIPTIONS, 100);
    assert.equal(billing.SUBSCRIPTIONS_COLLECTION, 'subscriptions');
    assert.equal(billing.BILLING_ORDERS_COLLECTION, 'billingOrders');
    assert.deepEqual(billing.RENEWAL_RECONCILIATION_STATES, ['none', 'unknown', 'manual']);
    assert.equal(Object.isFrozen(billing.RENEWAL_RECONCILIATION_STATES), true);
    assert.deepEqual(billing.RENEWAL_UNKNOWN_RETRY_OFFSETS_MS, [300000, 1800000, 7200000, 21600000, 86400000, 259200000, 604800000, 1209600000]);
    assert.equal(billing.RENEWAL_UNKNOWN_CUTOFF_MS, 1296000000);
    const { repo } = repository();
    assert.equal(Object.isFrozen(repo), true);
    assert.deepEqual(Object.keys(repo).sort(), [
      'abandonInitialRegistration', 'acquireOrderLease', 'acquireRenewalReconciliationLease', 'claimOrderReconciliationSlot', 'findSubscriptionByBillingKeyFingerprint',
      'finalizeOrderFailure', 'finalizeOrderSuccess', 'getBillingOrder', 'getSubscription',
      'invalidateBillingMethod', 'listDueSubscriptions', 'markOrderProviderRequestStarted', 'markRenewalManualReconciliation',
      'prepareInitialRetry', 'prepareRenewalOrder', 'prepareSubscription', 'releaseOrderLease',
      'storeBillingMethod', 'transitionSubscription',
    ].sort());
  });

  await test('atomically prepares exact schemas, explicit nulls, and free projection', async () => {
    const adapter = new MemoryFirestore();
    adapter.seed('users', UID, { usage: 4, singleCredits: 1 });
    const state = repository(adapter);
    const result = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    assert.equal(result.created, true);
    assert.equal(result.subscription.status, 'incomplete');
    assert.equal(result.subscription.initialAttempt, 0);
    assert.equal(result.subscription.initialOrderId, result.order.orderId);
    assert.equal(result.order.kind, 'initial');
    assert.equal(result.order.attempt, 0);
    assert.equal(result.order.resolution, 'ready');
    assertNoUndefined(result.subscription);
    assertNoUndefined(result.order);
    assertProjection(adapter, { plan: 'free', planExpiry: null });
    assert.equal(adapter.writeLog.filter((entry) => entry.path === `users/${UID}`).length, 1);
    assert.equal(state.clock.calls, 1);
  });

  await test('reuses the winning registration under sequential and concurrent prepare calls', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter);
    const first = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const second = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_B });
    const concurrent = await Promise.all([
      state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_B }),
      state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A }),
    ]);
    for (const result of [second, ...concurrent]) {
      assert.equal(result.created, false);
      assert.equal(result.subscription.customerKey, CUSTOMER_A);
      assert.equal(result.order.orderId, first.order.orderId);
    }
    assert.equal(adapter.documents.size, 3);
  });

  await test('uses exact purpose-separated initial identifiers for every sequential attempt', async () => {
    const order0 = billing.initialOrderId(UID, CUSTOMER_A, 0);
    const idem0 = billing.initialIdempotencyKey(UID, CUSTOMER_A, 0);
    const order1 = billing.initialOrderId(UID, CUSTOMER_A, 1);
    const idem1 = billing.initialIdempotencyKey(UID, CUSTOMER_A, 1);
    assert.match(order0, /^ntx_p_[0-9a-f]{48}$/);
    assert.match(idem0, /^ntx_pi_[0-9a-f]{64}$/);
    assert.equal(order0.length, 54);
    assert.equal(idem0.length, 71);
    assert.notEqual(order0, order1);
    assert.notEqual(idem0, idem1);
    for (const value of [order0, idem0, order1, idem1]) {
      assert.equal(value.includes(UID), false);
      assert.equal(value.includes(CUSTOMER_A), false);
    }
    assert.equal(billing.initialOrderId(UID, CUSTOMER_A, 0), order0);
    assert.equal(billing.initialIdempotencyKey(UID, CUSTOMER_A, 0), idem0);
  });

  await test('rejects prepare for entitled states without writes', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const prepared = await state.repo.acquireOrderLease({ uid: UID, orderId: billing.initialOrderId(UID, CUSTOMER_A, 0) });
    const payment = validPayment(prepared.order.orderId);
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: prepared.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: prepared.leaseToken });
    await state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: prepared.leaseToken, payment });
    const writes = adapter.writeLog.length;
    await expectSafeError(() => state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_B }), billing.BillingStateConflictError, { reason: 'subscription_already_entitled' });
    assert.equal(adapter.writeLog.length, writes);
  });

  await test('leases exactly once, supports expiry takeover, and rejects stale workers', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    let randomCounter = 0;
    const state = repository(adapter, clock, () => {
      randomCounter += 1;
      return Buffer.alloc(16, randomCounter);
    });
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const [one, two] = await Promise.all([
      state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId }),
      state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId }),
    ]);
    const held = one.acquired ? two : one;
    const owner = one.acquired ? one : two;
    assert.equal(owner.acquired, true);
    assert.equal(held.acquired, false);
    assert.equal(held.reason, 'held');
    assert.equal(owner.leaseExpiresAt, '2026-08-21T00:02:00.000Z');
    clock.set(owner.leaseExpiresAt);
    const takeover = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    assert.equal(takeover.acquired, true);
    assert.notEqual(takeover.leaseToken, owner.leaseToken);
    await assert.rejects(
      state.repo.releaseOrderLease({ uid: UID, orderId: prepared.order.orderId, leaseToken: owner.leaseToken, resolution: 'not_sent' }),
      billing.BillingLeaseLostError,
    );
    assert.equal(randomCounter, 2);
  });

  await test('permits a token owner to finalize after nominal expiry until takeover', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    clock.set('2026-08-21T00:03:00.000Z');
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    const result = await state.repo.finalizeOrderFailure({
      uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken,
      failure: { code: 'provider_rejected', providerCode: 'DECLINED' },
    });
    assert.equal(result.order.resolution, 'failed');
    assert.equal(result.order.leaseToken, null);
  });

  await test('checkpoints unknown conservatively and releases every lease field', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    const marked = await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    assert.equal(marked.resolution, 'unknown');
    const released = await state.repo.releaseOrderLease({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, resolution: 'charge_unknown' });
    assert.equal(released.resolution, 'unknown');
    assert.equal(released.leaseToken, null);
    assert.equal(released.leaseAcquiredAt, null);
    assert.equal(released.leaseExpiresAt, null);
    const retry = await state.repo.prepareInitialRetry({ uid: UID });
    assert.equal(retry.created, false);
    assert.equal(retry.order.orderId, prepared.order.orderId);
    assert.equal(retry.subscription.initialAttempt, 0);
  });

  async function failedInitial(state) {
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    const envelope = billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY);
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    return state.repo.finalizeOrderFailure({
      uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken,
      failure: { code: 'provider_rejected', providerCode: 'DECLINED' },
    });
  }

  await test('makes known initial failure terminal and explicitly creates exactly attempt n+1', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter, new Clock(NOW));
    const failed = await failedInitial(state);
    assert.equal(failed.subscription.manualRetryRequired, true);
    assert.equal(failed.subscription.billingMethodStatus, 'ready');
    const oldOrder = await state.repo.getBillingOrder({ orderId: failed.order.orderId });
    assert.equal(oldOrder.resolution, 'failed');
    assert.equal((await state.repo.acquireOrderLease({ uid: UID, orderId: oldOrder.orderId })).reason, 'failed');
    const retry = await state.repo.prepareInitialRetry({ uid: UID });
    assert.equal(retry.created, true);
    assert.equal(retry.subscription.initialAttempt, 1);
    assert.equal(retry.order.attempt, 1);
    assert.equal(retry.order.idempotencyKey, billing.initialIdempotencyKey(UID, CUSTOMER_A, 1));
    assert.equal(retry.subscription.billingKeyFingerprint, failed.subscription.billingKeyFingerprint);
    assert.equal((await state.repo.getBillingOrder({ orderId: oldOrder.orderId })).resolution, 'failed');
    const second = await state.repo.prepareInitialRetry({ uid: UID });
    assert.equal(second.created, false);
    assert.equal(second.order.orderId, retry.order.orderId);
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: oldOrder.orderId, leaseToken: 'ntx_l_' + '1'.repeat(32), payment: validPayment(oldOrder.orderId) }), billing.BillingStateConflictError);
  });

  await test('concurrent explicit retries converge and only one next attempt is chargeable', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter, new Clock(NOW));
    await failedInitial(state);
    const results = await Promise.all([
      state.repo.prepareInitialRetry({ uid: UID }),
      state.repo.prepareInitialRetry({ uid: UID }),
      state.repo.prepareInitialRetry({ uid: UID }),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.order.orderId)).size, 1);
    const leases = await Promise.all(results.map((result) => state.repo.acquireOrderLease({ uid: UID, orderId: result.order.orderId })));
    assert.equal(leases.filter((result) => result.acquired).length, 1);
  });

  await test('stores exact envelope material only on the leased current attempt', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter, new Clock(NOW));
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    const envelope = billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY);
    const stored = await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope });
    assert.deepEqual(stored.billingKeyCiphertext, envelope);
    assert.equal(stored.billingKeyFingerprint, envelope.fingerprint);
    const replay = await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: clone(envelope) });
    assert.deepEqual(replay.billingKeyCiphertext, envelope);
    await assert.rejects(
      state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: { ...envelope, fingerprint: 'bkf1_' + 'A'.repeat(43) } }),
      billing.BillingRepositoryInvariantError,
    );
    await assert.rejects(
      state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: { billingKey: CANARY.billingKey } }),
      TypeError,
    );
  });

  await test('finalizes normalized success atomically and replays it without a lease', async () => {
    const adapter = new MemoryFirestore();
    adapter.seed('users', UID, { usage: 4, singleCredits: 1 });
    const state = repository(adapter, new Clock(NOW));
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    const result = await state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: validPayment(prepared.order.orderId) });
    assert.equal(result.replayed, false);
    assert.equal(result.subscription.status, 'active');
    assert.equal(result.order.resolution, 'succeeded');
    assert.equal(result.order.providerStatus, 'DONE');
    assert.equal(result.order.providerType, 'BILLING');
    assert.equal(result.order.providerMethod, 'CARD');
    assert.equal(result.subscription.lastSuccessfulOrderId, prepared.order.orderId);
    assertProjection(adapter, { plan: 'monthly', planExpiry: result.subscription.currentPeriodEnd });
    const writes = adapter.writeLog.length;
    const replay = await state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: 'ntx_l_' + '2'.repeat(32), payment: validPayment(prepared.order.orderId) });
    assert.equal(replay.replayed, true);
    assert.equal(adapter.writeLog.length, writes);
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: 'ntx_l_' + '2'.repeat(32), payment: { ...validPayment(prepared.order.orderId), paymentKey: 'different-payment' } }), billing.BillingRepositoryInvariantError);
  });

  await test('rejects raw, extra, mismatched, and success-after-failure payment evidence', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter, new Clock(NOW));
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: { ...validPayment(prepared.order.orderId), extra: true } }), TypeError);
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: { ...validPayment('wrong-order') } }), billing.BillingRepositoryInvariantError);
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: { ...validPayment(prepared.order.orderId), status: 'READY' } }), RangeError);
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: { paymentKey: CANARY.billingKey } }), TypeError);
    await state.repo.finalizeOrderFailure({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, failure: { code: 'payment_terminal', providerCode: null } });
    await assert.rejects(state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: validPayment(prepared.order.orderId) }), billing.BillingStateConflictError);
  });

  async function activeSubscription(state, at = NOW) {
    state.clock.set(at);
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const lease = await state.repo.acquireOrderLease({ uid: UID, orderId: prepared.order.orderId });
    await state.repo.storeBillingMethod({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, customerKey: CUSTOMER_A, envelope: billing.encryptBillingKey(CANARY.billingKey, MASTER_KEY) });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken });
    return state.repo.finalizeOrderSuccess({ uid: UID, orderId: prepared.order.orderId, leaseToken: lease.leaseToken, payment: validPayment(prepared.order.orderId, at) });
  }

  await test('replays a valid active initial success from prepareInitialRetry with zero writes', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    await state.repo.transitionSubscription({ uid: UID, outcome: { type: 'cancel_requested' } });
    const writes = adapter.writeLog.length;
    const replay = await state.repo.prepareInitialRetry({ uid: UID });
    assert.equal(replay.created, false);
    assert.equal(replay.subscription.initialOrderId, active.subscription.initialOrderId);
    assert.equal(replay.order.orderId, active.order.orderId);
    assert.equal(replay.order.resolution, 'succeeded');
    assert.equal(replay.subscription.lastSuccessfulOrderId, replay.order.orderId);
    assert.equal(adapter.writeLog.length, writes);

    const malformedActive = adapter.read('subscriptions', UID);
    malformedActive.lastSuccessfulOrderId = null;
    adapter.seed('subscriptions', UID, malformedActive);
    await assert.rejects(state.repo.prepareInitialRetry({ uid: UID }), billing.BillingRepositoryInvariantError);
    const pastDueNext = new Date(new Date(malformedActive.currentPeriodEnd).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const pastDue = { ...malformedActive, status: 'past_due', retryCount: 1, nextAttemptAt: pastDueNext, billingWorkDueAt: pastDueNext, cancelAtPeriodEnd: false, canceledAt: null, lastSuccessfulOrderId: replay.order.orderId };
    adapter.seed('subscriptions', UID, pastDue);
    await assert.rejects(state.repo.prepareInitialRetry({ uid: UID }), billing.BillingStateConflictError);
  });

  await test('creates deterministic renewal orders only at the exact due state and reuses them', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    clock.set(active.subscription.currentPeriodEnd);
    const renewal = await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 });
    assert.equal(renewal.created, true);
    assert.equal(renewal.order.kind, 'renewal');
    assert.equal(renewal.order.cycle, 1);
    assert.equal(renewal.order.periodStart, active.subscription.currentPeriodEnd);
    assert.equal(renewal.order.orderId, renewalOrderId(UID, active.subscription.currentPeriodEnd, 0));
    assert.equal(renewal.order.idempotencyKey, renewalIdempotencyKey(UID, active.subscription.currentPeriodEnd, 0));
    const replay = await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 });
    assert.equal(replay.created, false);
    assert.equal(replay.order.orderId, renewal.order.orderId);
    await assert.rejects(state.repo.prepareRenewalOrder({ uid: UID, attempt: 1 }), billing.BillingStateConflictError);
  });

  await test('atomically marks, advances, leases, and closes the absolute reconciliation schedule', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    clock.set(active.subscription.currentPeriodEnd);
    const renewal = (await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 })).order;
    const chargeLease = await state.repo.acquireOrderLease({ uid: UID, orderId: renewal.orderId });
    const marked = await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: renewal.orderId, leaseToken: chargeLease.leaseToken });
    assert.equal(marked.resolution, 'unknown');
    const markedSubscription = await state.repo.getSubscription({ uid: UID });
    assert.equal(markedSubscription.renewalReconciliationState, 'unknown');
    assert.equal(markedSubscription.billingWorkDueAt, active.subscription.currentPeriodEnd);
    await state.repo.releaseOrderLease({ uid: UID, orderId: renewal.orderId, leaseToken: chargeLease.leaseToken, resolution: 'charge_unknown' });

    const reconciliation = await state.repo.acquireRenewalReconciliationLease({ uid: UID, orderId: renewal.orderId, source: 'cron' });
    const initialSlot = await state.repo.claimOrderReconciliationSlot({ uid: UID, orderId: renewal.orderId, leaseToken: reconciliation.leaseToken, slotAt: marked.providerRequestStartedAt });
    assert.equal(initialSlot.claimed, true);
    assert.equal(initialSlot.subscription.billingWorkDueAt, new Date(new Date(marked.providerRequestStartedAt).getTime() + 5 * 60 * 1000).toISOString());
    const duplicate = await state.repo.claimOrderReconciliationSlot({ uid: UID, orderId: renewal.orderId, leaseToken: reconciliation.leaseToken, slotAt: marked.providerRequestStartedAt });
    assert.equal(duplicate.claimed, false);
    await state.repo.releaseOrderLease({ uid: UID, orderId: renewal.orderId, leaseToken: reconciliation.leaseToken, resolution: 'lookup_unknown' });

    const start = new Date(marked.providerRequestStartedAt).getTime();
    const offsets = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000, 168 * 60 * 60 * 1000, 336 * 60 * 60 * 1000];
    for (const offset of offsets.slice(1)) {
      const slot = new Date(start + offset).toISOString();
      clock.set(slot);
      const lease = await state.repo.acquireRenewalReconciliationLease({ uid: UID, orderId: renewal.orderId, source: 'cron' });
      const result = await state.repo.claimOrderReconciliationSlot({ uid: UID, orderId: renewal.orderId, leaseToken: lease.leaseToken, slotAt: slot });
      assert.equal(result.claimed, true);
      await state.repo.releaseOrderLease({ uid: UID, orderId: renewal.orderId, leaseToken: lease.leaseToken, resolution: 'lookup_unknown' });
    }
    const cutoff = new Date(start + billing.RENEWAL_UNKNOWN_CUTOFF_MS).toISOString();
    clock.set(cutoff);
    const finalLease = await state.repo.acquireRenewalReconciliationLease({ uid: UID, orderId: renewal.orderId, source: 'cron' });
    const manual = await state.repo.markRenewalManualReconciliation({ uid: UID, orderId: renewal.orderId, leaseToken: finalLease.leaseToken });
    assert.equal(manual.subscription.renewalReconciliationState, 'manual');
    assert.equal(manual.subscription.billingWorkDueAt, null);
    assert.equal(manual.order.leaseToken, null);
    const manualLease = await state.repo.acquireRenewalReconciliationLease({ uid: UID, orderId: renewal.orderId, source: 'webhook' });
    assert.equal(manualLease.acquired, true);
  });

  await test('preserves an unresolved renewal across billing deletion and finalizes late success without restoring the method', async () => {
    const adapter = new MemoryFirestore();
    adapter.seed('users', UID, { usage: 4, singleCredits: 1 });
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    const fingerprint = active.subscription.billingKeyFingerprint;
    clock.set(active.subscription.currentPeriodEnd);
    const renewal = (await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 })).order;
    const chargeLease = await state.repo.acquireOrderLease({ uid: UID, orderId: renewal.orderId });
    const marked = await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: renewal.orderId, leaseToken: chargeLease.leaseToken });
    await state.repo.releaseOrderLease({ uid: UID, orderId: renewal.orderId, leaseToken: chargeLease.leaseToken, resolution: 'charge_unknown' });
    const invalidated = await state.repo.invalidateBillingMethod({ uid: UID, reason: 'provider_billing_key_deleted', expectedFingerprint: fingerprint });
    assert.equal(invalidated.renewalReconciliationState, 'unknown');
    assert.equal(invalidated.billingWorkDueAt, marked.providerRequestStartedAt);
    assert.equal(invalidated.billingMethodStatus, 'invalid');
    assert.equal(invalidated.requiresBillingMethodRegistration, true);
    const lookupLease = await state.repo.acquireRenewalReconciliationLease({ uid: UID, orderId: renewal.orderId, source: 'webhook' });
    const result = await state.repo.finalizeOrderSuccess({ uid: UID, orderId: renewal.orderId, leaseToken: lookupLease.leaseToken, payment: validPayment(renewal.orderId) });
    assert.equal(result.subscription.status, 'active');
    assert.equal(result.subscription.cancelAtPeriodEnd, true);
    assert.equal(result.subscription.billingMethodStatus, 'invalid');
    assert.equal(result.subscription.requiresBillingMethodRegistration, true);
    assert.equal(result.subscription.billingWorkDueAt, result.subscription.currentPeriodEnd);
    assert.equal(result.order.resolution, 'succeeded');
    assertProjection(adapter, { plan: 'monthly', planExpiry: result.subscription.currentPeriodEnd });
  });

  await test('applies renewal day 0/day 1/day 3 failure transitions and clears method at final failure', async () => {
    const adapter = new MemoryFirestore();
    adapter.seed('users', UID, { usage: 4, singleCredits: 1 });
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    let current = await activeSubscription(state);
    clock.set(current.subscription.currentPeriodEnd);
    let order = (await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 })).order;
    let lease = await state.repo.acquireOrderLease({ uid: UID, orderId: order.orderId });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken });
    current = await state.repo.finalizeOrderFailure({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken, failure: { code: 'provider_rejected', providerCode: 'DECLINED' } });
    assert.equal(current.subscription.status, 'past_due');
    assert.equal(current.subscription.retryCount, 1);
    clock.set(current.subscription.nextAttemptAt);
    order = (await state.repo.prepareRenewalOrder({ uid: UID, attempt: 1 })).order;
    lease = await state.repo.acquireOrderLease({ uid: UID, orderId: order.orderId });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken });
    current = await state.repo.finalizeOrderFailure({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken, failure: { code: 'payment_terminal', providerCode: null } });
    assert.equal(current.subscription.retryCount, 2);
    clock.set(current.subscription.nextAttemptAt);
    order = (await state.repo.prepareRenewalOrder({ uid: UID, attempt: 3 })).order;
    lease = await state.repo.acquireOrderLease({ uid: UID, orderId: order.orderId });
    await state.repo.markOrderProviderRequestStarted({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken });
    current = await state.repo.finalizeOrderFailure({ uid: UID, orderId: order.orderId, leaseToken: lease.leaseToken, failure: { code: 'provider_rejected', providerCode: 'DECLINED' } });
    assert.equal(current.subscription.status, 'expired');
    assert.equal(current.subscription.billingMethodStatus, 'invalid');
    assert.equal(current.subscription.billingKeyCiphertext, null);
    assert.equal(current.subscription.requiresBillingMethodRegistration, true);
    assertProjection(adapter, { plan: 'free', planExpiry: null });
  });

  await test('supports cancel, resume, period expiry, invalidation, and fingerprint lookup', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    const fingerprint = active.subscription.billingKeyFingerprint;
    assert.equal((await state.repo.findSubscriptionByBillingKeyFingerprint({ fingerprint })).customerKey, CUSTOMER_A);
    const canceled = await state.repo.transitionSubscription({ uid: UID, outcome: { type: 'cancel_requested' } });
    assert.equal(canceled.status, 'active');
    assert.equal(canceled.cancelAtPeriodEnd, true);
    const resumed = await state.repo.transitionSubscription({ uid: UID, outcome: { type: 'resume_requested' } });
    assert.equal(resumed.cancelAtPeriodEnd, false);
    const invalidated = await state.repo.invalidateBillingMethod({ uid: UID, reason: 'billing_deleted', expectedFingerprint: fingerprint });
    assert.equal(invalidated.billingMethodStatus, 'invalid');
    assert.equal(invalidated.cancelAtPeriodEnd, true);
    await assert.rejects(state.repo.invalidateBillingMethod({ uid: UID, reason: 'billing_deleted', expectedFingerprint: fingerprint }), billing.BillingRepositoryInvariantError);
    assert.equal(await state.repo.findSubscriptionByBillingKeyFingerprint({ fingerprint: 'bkf1_' + 'Z'.repeat(43) }), null);
  });

  await test('lists only bounded due subscriptions with the exact query shape', async () => {
    const adapter = new MemoryFirestore();
    const clock = new Clock(NOW);
    const state = repository(adapter, clock);
    const active = await activeSubscription(state);
    clock.set(active.subscription.currentPeriodEnd);
    await state.repo.prepareRenewalOrder({ uid: UID, attempt: 0 });
    const due = await state.repo.listDueSubscriptions({ at: new Date(active.subscription.currentPeriodEnd), limit: 1 });
    assert.equal(due.length, 1);
    assert.deepEqual(adapter.queries.at(-1), {
      collection: 'subscriptions',
      filters: [
        { field: 'status', operator: 'in', value: ['active', 'past_due'] },
        { field: 'renewalReconciliationState', operator: 'in', value: ['none', 'unknown'] },
        { field: 'billingWorkDueAt', operator: '<=', value: active.subscription.currentPeriodEnd },
      ],
      order: { field: 'billingWorkDueAt', direction: 'asc' },
      limit: 1,
    });
    await assert.rejects(state.repo.listDueSubscriptions({ at: new Date(NOW), limit: 101 }), RangeError);
  });

  await test('rolls back subscription, order, and projection on injected commit failure', async () => {
    const adapter = new MemoryFirestore();
    adapter.seed('users', UID, { usage: 4, singleCredits: 1 });
    const state = repository(adapter, new Clock(NOW));
    adapter.failNextCommit = true;
    await assert.rejects(state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A }), billing.BillingStorageError);
    assert.equal(adapter.read('subscriptions', UID), undefined);
    assert.equal(adapter.read('billingOrders', billing.initialOrderId(UID, CUSTOMER_A, 0)), undefined);
    assert.deepEqual(adapter.read('users', UID), { usage: 4, singleCredits: 1 });
    assert.equal(adapter.writeLog.length, 0);
  });

  await test('fails closed on malformed records, duplicate fingerprints, and storage errors', async () => {
    const adapter = new MemoryFirestore();
    const state = repository(adapter, new Clock(NOW));
    const prepared = await state.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const malformed = adapter.read('subscriptions', UID);
    malformed.amount = 500;
    adapter.seed('subscriptions', UID, malformed);
    await expectSafeError(() => state.repo.getSubscription({ uid: UID }), billing.BillingRepositoryInvariantError, { field: 'document' });
    const second = new MemoryFirestore();
    const other = repository(second, new Clock(NOW));
    await other.repo.prepareSubscription({ uid: UID, customerKey: CUSTOMER_A });
    const otherUid = 'repository-user-fixture-2';
    const otherPrepared = await other.repo.prepareSubscription({ uid: otherUid, customerKey: CUSTOMER_B });
    const firstSub = second.read('subscriptions', UID);
    const secondSub = second.read('subscriptions', otherUid);
    firstSub.billingKeyFingerprint = 'bkf1_' + 'A'.repeat(43);
    secondSub.billingKeyFingerprint = firstSub.billingKeyFingerprint;
    second.seed('subscriptions', UID, firstSub);
    second.seed('subscriptions', otherUid, secondSub);
    await expectSafeError(() => other.repo.findSubscriptionByBillingKeyFingerprint({ fingerprint: firstSub.billingKeyFingerprint }), billing.BillingRepositoryInvariantError, { field: 'document' });
    const failing = new MemoryFirestore();
    const failingState = repository(failing, new Clock(NOW));
    failing.collection = () => { throw new Error(CANARY.secretKey); };
    await expectSafeError(() => failingState.repo.getSubscription({ uid: UID }), billing.BillingStorageError, { operation: 'read' });
    void prepared;
    void otherPrepared;
  });

  process.stdout.write(`${passed} billing repository tests passed\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
