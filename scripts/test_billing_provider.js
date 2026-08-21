'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const billing = require('../api/_billing');

const {
  BillingPaymentValidationError,
  TossProviderError,
  createTossClient,
  normalizeBillingIssue,
  normalizeBillingPayment,
  validateCustomerKey,
} = billing;

const customerKey = 'ntx_c_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const otherCustomerKey = 'ntx_c_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const authKey = 'auth_fixture_secret';
const providerBillingKey = 'billing_fixture_secret';
const secretKey = 'secret_fixture_key';
const orderId = 'ntx_order_fixture';
const paymentKey = 'payment_fixture_secret';
const providerMessage = 'provider fixture message';

const validIssue = {
  customerKey,
  billingKey: providerBillingKey,
  method: '카드',
  authenticatedAt: '2026-08-21T00:00:00.000Z',
  card: { issuerCode: '41', number: '****' },
  ignoredFutureField: { secretKey },
};

const validPayment = {
  paymentKey,
  type: 'BILLING',
  orderId,
  currency: 'KRW',
  method: '카드',
  totalAmount: 8900,
  status: 'DONE',
  approvedAt: '2026-08-21T00:01:00.000Z',
  card: { amount: 8900, number: '****' },
  ignoredFutureField: providerMessage,
};

let passed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
  });
}

function expectValidation(fn, field, disposition = 'security_mismatch', stage = 'payment') {
  assert.throws(fn, (error) => {
    assert(error instanceof BillingPaymentValidationError);
    assert.equal(error.code, 'BILLING_PROVIDER_VALIDATION_FAILED');
    assert.equal(error.stage, stage);
    assert.equal(error.field, field);
    assert.equal(error.disposition, disposition);
    assert.equal(error.message, 'Billing provider validation failed');
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    return true;
  });
}

function expectProvider(fn, operation, kind, disposition, httpStatus = null, providerCode = null) {
  return assert.rejects(fn, (error) => {
    assert(error instanceof TossProviderError);
    assert.deepEqual({
      name: error.name,
      code: error.code,
      operation: error.operation,
      kind: error.kind,
      httpStatus: error.httpStatus,
      providerCode: error.providerCode,
      disposition: error.disposition,
    }, {
      name: 'TossProviderError',
      code: 'TOSS_REQUEST_FAILED',
      operation,
      kind,
      httpStatus,
      providerCode,
      disposition,
    });
    assert.equal(error.message, `Toss ${operation} request failed`);
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    return true;
  });
}

async function observeBoundedTimeout(operation, operationName, realSetTimeout) {
  const outcome = { settled: false, error: null };
  const operationPromise = operation().then(
    () => {
      outcome.settled = true;
    },
    (error) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  await new Promise((resolve) => realSetTimeout(resolve, 30));
  assert.equal(outcome.settled, true, `${operationName} did not reject before the bounded observer`);
  assert(outcome.error instanceof TossProviderError);
  assert.equal(outcome.error.operation, operationName);
  assert.equal(outcome.error.kind, 'timeout');
  assert.equal(outcome.error.disposition, operationName === 'issue' ? 'reregister' : 'lookup_again');
  await operationPromise;
  return outcome.error;
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function fixtureFetch(responses, calls, delays = {}) {
  return async (url, options) => {
    calls.push({ url, options: { ...options, headers: { ...options.headers } } });
    if (delays[url]) await new Promise((resolve) => setTimeout(resolve, delays[url]));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

async function run() {
  await test('normalizes valid billing issuance and rejects identity evidence mismatches', () => {
    const normalized = normalizeBillingIssue(validIssue, customerKey);
    assert.deepEqual(normalized, {
      billingKey: providerBillingKey,
      customerKey,
      method: 'CARD',
      authenticatedAt: '2026-08-21T00:00:00.000Z',
    });
    assert.equal(Object.isFrozen(normalized), true);
    for (const [field, value] of [['customerKey', otherCustomerKey], ['billingKey', ''], ['method', 'BANK'], ['card', null], ['authenticatedAt', 'invalid']]) {
      expectValidation(() => normalizeBillingIssue({ ...validIssue, [field]: value }, customerKey), field, 'security_mismatch', 'issue');
    }
  });

  await test('normalizes only complete DONE billing-card payments with exact expectations', () => {
    const normalized = normalizeBillingPayment(validPayment, { orderId, customerKey, amount: 8900, currency: 'KRW' });
    assert.deepEqual(normalized, {
      paymentKey,
      orderId,
      status: 'DONE',
      type: 'BILLING',
      amount: 8900,
      currency: 'KRW',
      method: 'CARD',
      approvedAt: '2026-08-21T00:01:00.000Z',
    });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(normalized.customerKey, undefined);
    assert.equal(normalized.card, undefined);
    expectValidation(() => normalizeBillingPayment({ ...validPayment, customerKey: otherCustomerKey }, { orderId, customerKey, amount: 8900, currency: 'KRW' }), 'customerKey');
    assert.doesNotThrow(() => normalizeBillingPayment({ ...validPayment }, { orderId, customerKey, amount: 8900, currency: 'KRW' }));
  });

  await test('rejects each payment identity, amount, type, method, card, and approval mismatch', () => {
    const cases = [
      ['paymentKey', undefined], ['type', 'CARD'], ['orderId', 'other_order'], ['totalAmount', 500],
      ['currency', 'USD'], ['method', '간편결제'], ['card', []], ['approvedAt', null],
      ['status', undefined], ['status', 'READY'], ['status', 'IN_PROGRESS'], ['status', 'WAITING_FOR_DEPOSIT'],
      ['status', 'CANCELED'], ['status', 'PARTIAL_CANCELED'], ['status', 'ABORTED'], ['status', 'EXPIRED'],
      ['status', 'UNKNOWN'],
    ];
    for (const [field, value] of cases) {
      const fixture = { ...validPayment };
      if (value === undefined) delete fixture[field];
      else fixture[field] = value;
      const disposition = ['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT'].includes(value)
        ? 'pending'
        : ['CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED'].includes(value)
          ? 'terminal_failure'
          : 'security_mismatch';
      expectValidation(() => normalizeBillingPayment(fixture, { orderId, customerKey, amount: 8900, currency: 'KRW' }), field, disposition);
    }
    for (const amount of [500, 7900, '8900']) {
      expectValidation(() => normalizeBillingPayment({ ...validPayment, totalAmount: amount }, { orderId, customerKey, amount: 8900, currency: 'KRW' }), 'totalAmount');
    }
    for (const card of [undefined, null, [], 'card']) {
      const fixture = { ...validPayment };
      if (card === undefined) delete fixture.card;
      else fixture.card = card;
      expectValidation(() => normalizeBillingPayment(fixture, { orderId, customerKey, amount: 8900, currency: 'KRW' }), 'card');
    }
  });

  await test('uses fixed URLs, Basic authentication, exact bodies, idempotency, signals, and timer cleanup', async () => {
    const calls = [];
    const responses = [response(200, validIssue), response(200, { ignored: true }), response(200, validPayment)];
    const client = createTossClient({
      secretKey,
      fetchImpl: fixtureFetch(responses, calls),
      timeoutMs: { issue: 100, charge: 100, lookup: 100 },
    });
    assert.deepEqual(Object.keys(client).sort(), ['chargeBillingKey', 'issueBillingKey', 'refetchBillingPayment']);
    assert.equal(Object.isFrozen(client), true);
    const issued = await client.issueBillingKey({ authKey, customerKey });
    assert.equal(issued.billingKey, providerBillingKey);
    const chargeResult = await client.chargeBillingKey({ billingKey: providerBillingKey, customerKey, orderId, orderName: 'Notyx Pro', amount: 8900, idempotencyKey: 'idem_fixture' });
    assert.equal(chargeResult, undefined);
    const payment = await client.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' });
    assert.equal(payment.paymentKey, paymentKey);
    assert.equal(calls[0].url, 'https://api.tosspayments.com/v1/billing/authorizations/issue');
    assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { authKey, customerKey });
    assert.equal(calls[1].url, `https://api.tosspayments.com/v1/billing/${encodeURIComponent(providerBillingKey)}`);
    assert.deepEqual(JSON.parse(calls[1].options.body), { amount: 8900, customerKey, orderId, orderName: 'Notyx Pro' });
    assert.equal(calls[1].options.headers['Idempotency-Key'], 'idem_fixture');
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(calls[1].options.body), 'currency'), false);
    assert.equal(calls[2].url, `https://api.tosspayments.com/v1/payments/orders/${encodeURIComponent(orderId)}`);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[2].options, 'body'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[2].options.headers, 'Idempotency-Key'), false);
    for (const call of calls) {
      assert.equal(call.options.headers.Accept, 'application/json');
      assert.equal(call.options.headers['Accept-Language'], 'en');
      assert(call.options.signal instanceof AbortSignal);
    }
  });

  await test('rejects invalid operation inputs before any provider call', async () => {
    const calls = [];
    const client = createTossClient({ secretKey, fetchImpl: fixtureFetch([], calls), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await assert.rejects(client.issueBillingKey({ authKey, customerKey, extra: true }), TypeError);
    await assert.rejects(client.chargeBillingKey({ billingKey: providerBillingKey, customerKey, orderId, orderName: ' Notyx', amount: 8900, idempotencyKey: 'idem' }), RangeError);
    await assert.rejects(client.chargeBillingKey({ billingKey: providerBillingKey, customerKey, orderId, orderName: 'Notyx', amount: 500, idempotencyKey: 'idem' }), RangeError);
    await assert.rejects(client.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'USD' }), RangeError);
    assert.equal(calls.length, 0);
  });

  await test('classifies successful non-plain provider JSON at the client boundary', async () => {
    const issueClient = createTossClient({ secretKey, fetchImpl: fixtureFetch([response(200, null)], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await expectProvider(() => issueClient.issueBillingKey({ authKey, customerKey }), 'issue', 'invalid_response', 'reregister');
    const lookupClient = createTossClient({ secretKey, fetchImpl: fixtureFetch([response(200, [])], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await expectProvider(() => lookupClient.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' }), 'lookup', 'invalid_response', 'lookup_again');
    expectValidation(() => normalizeBillingIssue(null, customerKey), 'shape', 'security_mismatch', 'issue');
    expectValidation(() => normalizeBillingPayment([], { orderId, customerKey, amount: 8900, currency: 'KRW' }), 'shape', 'security_mismatch', 'payment');
  });

  await test('maps timeout, network, HTTP, malformed, and unsafe-code fixtures to safe errors', async () => {
    const cases = [
      [new Error('timeout transport'), 'network', 'lookup_again', null, null],
      [new Error('network provider message'), 'network', 'lookup_again', null, null],
      [response(400, { code: 'BAD_REQUEST', message: providerMessage }), 'http', 'rejected', 400, 'BAD_REQUEST'],
      [response(401, { code: 'UNAUTHORIZED_KEY', message: secretKey }), 'http', 'configuration', 401, 'UNAUTHORIZED_KEY'],
      [response(404, { code: 'NOT_FOUND' }), 'http', 'lookup_again', 404, 'NOT_FOUND'],
      [response(409, { code: 'DUPLICATED_ORDER_ID' }), 'http', 'lookup_again', 409, 'DUPLICATED_ORDER_ID'],
      [response(429, { code: 'RATE_LIMITED' }), 'http', 'lookup_again', 429, 'RATE_LIMITED'],
      [response(500, { code: 'SERVER_ERROR' }), 'http', 'lookup_again', 500, 'SERVER_ERROR'],
      [response(400, { code: 'unsafe-code!', message: providerMessage }), 'http', 'rejected', 400, null],
      [response(200, new Error('malformed provider body')), 'invalid_response', 'lookup_again', null, null],
    ];
    for (const [fixture, kind, disposition, status, code] of cases) {
      const client = createTossClient({ secretKey, fetchImpl: fixtureFetch([fixture], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
      await expectProvider(() => client.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' }), 'lookup', kind, disposition, status, code);
    }
    const issueClient = createTossClient({ secretKey, fetchImpl: fixtureFetch([response(401, { code: 'UNAUTHORIZED_KEY' })], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await expectProvider(() => issueClient.issueBillingKey({ authKey, customerKey }), 'issue', 'http', 'configuration', 401, 'UNAUTHORIZED_KEY');
    const chargeCases = [
      [response(400, { code: 'NOT_SUPPORTED_METHOD' }), 'rejected', 400, 'NOT_SUPPORTED_METHOD'],
      [response(401, { code: 'UNAUTHORIZED_KEY' }), 'configuration', 401, 'UNAUTHORIZED_KEY'],
      [response(400, { code: 'INCORRECT_BASIC_AUTH_FORMAT' }), 'configuration', 400, 'INCORRECT_BASIC_AUTH_FORMAT'],
      [response(400, { code: 'NOT_SUPPORTED_BILLING_MERCHANT' }), 'configuration', 400, 'NOT_SUPPORTED_BILLING_MERCHANT'],
      [response(409, { code: 'DUPLICATED_ORDER_ID' }), 'refetch', 409, 'DUPLICATED_ORDER_ID'],
      [response(503, { code: 'SERVER_ERROR' }), 'refetch', 503, 'SERVER_ERROR'],
    ];
    for (const [fixture, disposition, status, code] of chargeCases) {
      const chargeClient = createTossClient({ secretKey, fetchImpl: fixtureFetch([fixture], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
      await expectProvider(() => chargeClient.chargeBillingKey({ billingKey: providerBillingKey, customerKey, orderId, orderName: 'Notyx', amount: 8900, idempotencyKey: 'idem' }), 'charge', 'http', disposition, status, code);
    }
    const issueMethodClient = createTossClient({ secretKey, fetchImpl: fixtureFetch([response(400, { code: 'NOT_SUPPORTED_METHOD' })], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await expectProvider(() => issueMethodClient.issueBillingKey({ authKey, customerKey }), 'issue', 'http', 'configuration', 400, 'NOT_SUPPORTED_METHOD');
  });

  await test('enforces the owned deadline when fetch or JSON ignores AbortSignal', async () => {
    const delayedFetchClient = createTossClient({
      secretKey,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return response(200, validIssue);
      },
      timeoutMs: { issue: 5, charge: 5, lookup: 5 },
    });
    await expectProvider(() => delayedFetchClient.issueBillingKey({ authKey, customerKey }), 'issue', 'timeout', 'reregister');

    const delayedJsonClient = createTossClient({
      secretKey,
      fetchImpl: async () => ({
        status: 200,
        async json() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return validPayment;
        },
      }),
      timeoutMs: { issue: 5, charge: 5, lookup: 5 },
    });
    await expectProvider(() => delayedJsonClient.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' }), 'lookup', 'timeout', 'lookup_again');
  });

  await test('rejects never-settling fetch and JSON with a bounded timeout and clears each deadline timer', async () => {
    const savedSetTimeout = globalThis.setTimeout;
    const savedClearTimeout = globalThis.clearTimeout;
    let fetchCreated = 0;
    let fetchCleared = 0;
    try {
      globalThis.setTimeout = (...args) => {
        fetchCreated += 1;
        return savedSetTimeout(...args);
      };
      globalThis.clearTimeout = (...args) => {
        fetchCleared += 1;
        return savedClearTimeout(...args);
      };
      const neverFetchClient = createTossClient({
        secretKey,
        fetchImpl: () => new Promise(() => {}),
        timeoutMs: { issue: 5, charge: 5, lookup: 5 },
      });
      await observeBoundedTimeout(() => neverFetchClient.issueBillingKey({ authKey, customerKey }), 'issue', savedSetTimeout);
      assert.equal(fetchCreated, 1);
      assert.equal(fetchCleared, 1);
    } finally {
      globalThis.setTimeout = savedSetTimeout;
      globalThis.clearTimeout = savedClearTimeout;
    }
    assert.equal(globalThis.setTimeout, savedSetTimeout);
    assert.equal(globalThis.clearTimeout, savedClearTimeout);

    let jsonCreated = 0;
    let jsonCleared = 0;
    try {
      globalThis.setTimeout = (...args) => {
        jsonCreated += 1;
        return savedSetTimeout(...args);
      };
      globalThis.clearTimeout = (...args) => {
        jsonCleared += 1;
        return savedClearTimeout(...args);
      };
      const neverJsonClient = createTossClient({
        secretKey,
        fetchImpl: async () => ({ status: 200, json: () => new Promise(() => {}) }),
        timeoutMs: { issue: 5, charge: 5, lookup: 5 },
      });
      await observeBoundedTimeout(() => neverJsonClient.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' }), 'lookup', savedSetTimeout);
      assert.equal(jsonCreated, 1);
      assert.equal(jsonCleared, 1);
    } finally {
      globalThis.setTimeout = savedSetTimeout;
      globalThis.clearTimeout = savedClearTimeout;
    }
    assert.equal(globalThis.setTimeout, savedSetTimeout);
    assert.equal(globalThis.clearTimeout, savedClearTimeout);
  });

  await test('handles late provider resolve and reject without changing timeout or causing unhandled rejection', async () => {
    const savedSetTimeout = globalThis.setTimeout;
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateResolveClient = createTossClient({
        secretKey,
        fetchImpl: async () => {
          await new Promise((resolve) => savedSetTimeout(resolve, 25));
          return response(200, validIssue);
        },
        timeoutMs: { issue: 5, charge: 5, lookup: 5 },
      });
      await observeBoundedTimeout(() => lateResolveClient.issueBillingKey({ authKey, customerKey }), 'issue', savedSetTimeout);

      const lateRejectClient = createTossClient({
        secretKey,
        fetchImpl: async () => {
          await new Promise((resolve) => savedSetTimeout(resolve, 25));
          throw new Error('late provider fixture rejection');
        },
        timeoutMs: { issue: 5, charge: 5, lookup: 5 },
      });
      await observeBoundedTimeout(() => lateRejectClient.issueBillingKey({ authKey, customerKey }), 'issue', savedSetTimeout);
      await new Promise((resolve) => savedSetTimeout(resolve, 35));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  await test('creates and clears exactly one real operation timer and restores instrumentation', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let created = 0;
    let cleared = 0;
    try {
      globalThis.setTimeout = (...args) => {
        created += 1;
        return originalSetTimeout(...args);
      };
      globalThis.clearTimeout = (...args) => {
        cleared += 1;
        return originalClearTimeout(...args);
      };
      const client = createTossClient({ secretKey, fetchImpl: fixtureFetch([response(200, validIssue)], []), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
      await client.issueBillingKey({ authKey, customerKey });
      assert.equal(created, 1);
      assert.equal(cleared, 1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
    assert.equal(globalThis.setTimeout, originalSetTimeout);
    assert.equal(globalThis.clearTimeout, originalClearTimeout);
  });

  await test('does not retry an unknown charge after an immediate lookup 404', async () => {
    const calls = [];
    const responses = [new Error('network failure'), response(404, { code: 'NOT_FOUND' })];
    const client = createTossClient({ secretKey, fetchImpl: fixtureFetch(responses, calls), timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
    await expectProvider(() => client.chargeBillingKey({ billingKey: providerBillingKey, customerKey, orderId, orderName: 'Notyx', amount: 8900, idempotencyKey: 'idem' }), 'charge', 'network', 'refetch', null, null);
    await expectProvider(() => client.refetchBillingPayment({ orderId, customerKey, amount: 8900, currency: 'KRW' }), 'lookup', 'http', 'lookup_again', 404, 'NOT_FOUND');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers['Idempotency-Key'], 'idem');
    assert.equal(calls[1].options.headers['Idempotency-Key'], undefined);
  });

  await test('keeps provider errors free of credentials and raw provider messages', () => {
    const child = spawnSync(process.execPath, ['-e', `
      const b = require('./api/_billing');
      const response = { status: 400, async json() { return { code: 'BAD_REQUEST', message: '${providerMessage}', secretKey: '${secretKey}' }; } };
      const client = b.createTossClient({ secretKey: '${secretKey}', fetchImpl: async () => response, timeoutMs: { issue: 100, charge: 100, lookup: 100 } });
      client.refetchBillingPayment({ orderId: '${orderId}', customerKey: '${customerKey}', amount: 8900, currency: 'KRW' }).catch((error) => {
        process.stdout.write(String(error) + '\\n' + JSON.stringify(error) + '\\n' + JSON.stringify(b.redactSensitive(error)));
        process.stderr.write('diagnostic ' + JSON.stringify(error));
      });
    `], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const output = `${child.stdout}\n${child.stderr}`;
    for (const fixture of [authKey, providerBillingKey, customerKey, secretKey, providerMessage]) assert.equal(output.includes(fixture), false);
    assert.equal(output.includes('Toss lookup request failed'), true);
    assert.equal(output.includes('TOSS_REQUEST_FAILED'), true);
  });
}

run().then(() => process.stdout.write(`${passed} billing provider tests passed\n`));
