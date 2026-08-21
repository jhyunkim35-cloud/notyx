'use strict';

const crypto = require('node:crypto');
const {
  PRO_MONTHLY_AMOUNT_KRW,
  currency,
} = require('./_billing-domain');

const BILLING_ENVELOPE_VERSION = 1;
const TOSS_API_BASE_URL = 'https://api.tosspayments.com';
const TOSS_TIMEOUT_MS = Object.freeze({ issue: 10000, charge: 65000, lookup: 10000 });
const REDACTED = '[REDACTED]';
const REDACTED_BINARY = '[REDACTED_BINARY]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const ACCESSOR = '[Accessor]';
const AUTH_CONFIGURATION_CODES = new Set([
  'UNAUTHORIZED_KEY',
  'INCORRECT_BASIC_AUTH_FORMAT',
  'NOT_SUPPORTED_METHOD',
]);

class BillingConfigurationError extends Error {
  constructor() {
    super('Billing encryption configuration is invalid');
    this.name = 'BillingConfigurationError';
    this.code = 'BILLING_CONFIGURATION_INVALID';
  }
}

class BillingCryptoError extends Error {
  constructor() {
    super('Billing key decryption failed');
    this.name = 'BillingCryptoError';
    this.code = 'BILLING_DECRYPT_FAILED';
  }
}

class TossProviderError extends Error {
  constructor(operation, kind, httpStatus, providerCode, disposition) {
    super(`Toss ${operation} request failed`);
    this.name = 'TossProviderError';
    this.code = 'TOSS_REQUEST_FAILED';
    this.operation = operation;
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.disposition = disposition;
  }
}

class BillingPaymentValidationError extends Error {
  constructor(stage, field, disposition) {
    super('Billing provider validation failed');
    this.name = 'BillingPaymentValidationError';
    this.code = 'BILLING_PROVIDER_VALIDATION_FAILED';
    this.stage = stage;
    this.field = field;
    this.disposition = disposition;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function requireExactObject(value, required, optional = [], name = 'input') {
  requirePlainObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${name}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function validateOpaqueString(value, name, maximum) {
  requireString(value, name);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > maximum) throw new RangeError(`${name} length is invalid`);
  if (/[\u0000\r\n]/u.test(value)) throw new RangeError(`${name} contains a control character`);
  return value;
}

function validateMasterKey(encryptionKeyBase64) {
  if (typeof encryptionKeyBase64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encryptionKeyBase64)) {
    throw new BillingConfigurationError();
  }
  const key = Buffer.from(encryptionKeyBase64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encryptionKeyBase64) throw new BillingConfigurationError();
  return key;
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function validateCanonicalBase64(value, name, expectedLength, nonempty = true) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new BillingCryptoError();
  }
  const decoded = Buffer.from(value, 'base64');
  if ((nonempty && decoded.length === 0) || (expectedLength !== undefined && decoded.length !== expectedLength) || decoded.toString('base64') !== value) {
    throw new BillingCryptoError();
  }
  return decoded;
}

function validateBillingKey(billingKey) {
  return validateOpaqueString(billingKey, 'billingKey', 200);
}

function validateCustomerKey(customerKey) {
  requireString(customerKey, 'customerKey');
  if (!/^ntx_c_[A-Za-z0-9_-]{32}$/u.test(customerKey)) throw new RangeError('customerKey format is invalid');
  return customerKey;
}

function generateCustomerKey(options = {}) {
  requireExactObject(options, [], ['randomBytes'], 'options');
  const { randomBytes = crypto.randomBytes } = options;
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  const bytes = randomBytes(24);
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== 24) {
    throw new RangeError('randomBytes must return 24 bytes');
  }
  return validateCustomerKey(`ntx_c_${toBase64Url(Buffer.from(bytes))}`);
}

function fingerprintBillingKey(billingKey, encryptionKeyBase64) {
  validateBillingKey(billingKey);
  const masterKey = validateMasterKey(encryptionKeyBase64);
  const subkey = crypto.createHmac('sha256', masterKey).update('notyx|billing-key-fingerprint-key|v1', 'utf8').digest();
  const preimage = `notyx|billing-key|v1|${Buffer.byteLength(billingKey, 'utf8')}:${billingKey}`;
  const digest = crypto.createHmac('sha256', subkey).update(preimage, 'utf8').digest();
  return `bkf1_${toBase64Url(digest)}`;
}

function encryptBillingKey(billingKey, encryptionKeyBase64) {
  validateBillingKey(billingKey);
  const masterKey = validateMasterKey(encryptionKeyBase64);
  const fingerprint = fingerprintBillingKey(billingKey, encryptionKeyBase64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(`notyx|billing-key-envelope|v1|${fingerprint}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(billingKey, 'utf8')), cipher.final()]);
  const envelope = {
    version: BILLING_ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    fingerprint,
  };
  return Object.freeze(envelope);
}

function isFingerprint(value) {
  return typeof value === 'string' && /^bkf1_[A-Za-z0-9_-]{43}$/u.test(value);
}

function decryptBillingKey(envelope, encryptionKeyBase64) {
  const masterKey = validateMasterKey(encryptionKeyBase64);
  try {
    if (!isPlainObject(envelope) || Object.keys(envelope).sort().join('|') !== 'ciphertext|fingerprint|iv|tag|version') throw new Error('envelope');
    if (envelope.version !== BILLING_ENVELOPE_VERSION || !isFingerprint(envelope.fingerprint)) throw new Error('envelope');
    const iv = validateCanonicalBase64(envelope.iv, 'iv', 12);
    const tag = validateCanonicalBase64(envelope.tag, 'tag', 16);
    const ciphertext = validateCanonicalBase64(envelope.ciphertext, 'ciphertext');
    const fingerprintBytes = Buffer.from(envelope.fingerprint.slice(5).replace(/-/gu, '+').replace(/_/gu, '/') + '===', 'base64');
    if (fingerprintBytes.length !== 32) throw new Error('fingerprint');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAAD(Buffer.from(`notyx|billing-key-envelope|v1|${envelope.fingerprint}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    validateBillingKey(plaintext);
    const expected = fingerprintBillingKey(plaintext, encryptionKeyBase64);
    const expectedBytes = Buffer.from(expected.slice(5).replace(/-/gu, '+').replace(/_/gu, '/') + '===', 'base64');
    if (expectedBytes.length !== fingerprintBytes.length || !crypto.timingSafeEqual(expectedBytes, fingerprintBytes)) throw new Error('fingerprint');
    return plaintext;
  } catch (error) {
    if (error instanceof BillingConfigurationError) throw error;
    throw new BillingCryptoError();
  }
}

function normalizedKey(key) {
  return String(key).replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (normalized === 'billingkeyfingerprint') return false;
  return new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'secret', 'ciphertext']).has(normalized)
    || normalized.includes('billingkey')
    || normalized.includes('authkey')
    || normalized.includes('secretkey')
    || normalized.includes('encryptionkey')
    || normalized.includes('customerkey')
    || normalized.endsWith('token');
}

function isBillingEnvelope(value) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).sort().join('|') === 'ciphertext|fingerprint|iv|tag|version';
}

function scrubString(value) {
  let result = value.replace(/\b(Basic|Bearer)\s+[^\s"'`]+/giu, '$1 [REDACTED]');
  result = result.replace(/([?&])((?:authKey|billingKey|customerKey|secretKey|token|[A-Za-z0-9_]*Token))=([^&#]*)/giu, '$1$2=[REDACTED]');
  return result;
}

function readDataProperty(value, key) {
  let current = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor.get || descriptor.set ? undefined : descriptor.value;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function redactSensitive(value) {
  const seen = new WeakSet();

  function clone(current, depth) {
    if (current === null) return null;
    if (typeof current === 'string') return scrubString(current);
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'boolean') return current;
    if (typeof current === 'undefined') return null;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'function' || typeof current === 'symbol') return '[UNSERIALIZABLE]';
    if (depth > 20) return TRUNCATED;
    if (Buffer.isBuffer(current) || ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return REDACTED_BINARY;
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? '[InvalidDate]' : current.toISOString();
    if (isBillingEnvelope(current)) return REDACTED;
    if (seen.has(current)) return CIRCULAR;
    seen.add(current);

    if (current instanceof Error) {
      const result = {};
      const errorName = readDataProperty(current, 'name');
      const errorCode = readDataProperty(current, 'code');
      const errorMessage = readDataProperty(current, 'message');
      const name = typeof errorName === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(errorName) ? errorName : undefined;
      const code = typeof errorCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(errorCode) ? errorCode : undefined;
      if (name !== undefined) result.name = name;
      if (code !== undefined) result.code = code;
      result.message = scrubString(typeof errorMessage === 'string' ? errorMessage : String(errorMessage));
      for (const key of Object.keys(current)) {
        if (key === 'name' || key === 'code' || key === 'message') continue;
        if (['stack', 'cause', 'request', 'response', 'config'].includes(key.toLowerCase())) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || descriptor.get || descriptor.set) result[key] = ACCESSOR;
        else if (isSensitiveKey(key)) result[key] = REDACTED;
        else result[key] = clone(descriptor.value, depth + 1);
      }
      return result;
    }

    if (Array.isArray(current)) {
      const result = [];
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          result[key] = !descriptor || descriptor.get || descriptor.set ? ACCESSOR : clone(descriptor.value, depth + 1);
        } else if (isSensitiveKey(key)) {
          result[key] = REDACTED;
        } else {
          result[key] = !descriptor || descriptor.get || descriptor.set ? ACCESSOR : clone(descriptor.value, depth + 1);
        }
      }
      return result;
    }
    const result = {};
    for (const key of Object.keys(current)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || descriptor.get || descriptor.set) result[key] = ACCESSOR;
      else result[key] = clone(descriptor.value, depth + 1);
    }
    return result;
  }

  return clone(value, 0);
}

function validationError(stage, field, disposition = 'security_mismatch') {
  return new BillingPaymentValidationError(stage, field, disposition);
}

function normalizeBillingIssue(rawBilling, expectedCustomerKey) {
  try {
    validateCustomerKey(expectedCustomerKey);
  } catch (error) {
    throw validationError('issue', 'customerKey');
  }
  if (!isPlainObject(rawBilling)) throw validationError('issue', 'shape');
  if (rawBilling.customerKey !== expectedCustomerKey) throw validationError('issue', 'customerKey');
  try {
    validateBillingKey(rawBilling.billingKey);
  } catch (error) {
    throw validationError('issue', 'billingKey');
  }
  if (rawBilling.method !== '카드') throw validationError('issue', 'method');
  if (!isPlainObject(rawBilling.card)) throw validationError('issue', 'card');
  const authenticatedAt = new Date(rawBilling.authenticatedAt);
  if (rawBilling.authenticatedAt === null || Number.isNaN(authenticatedAt.getTime())) throw validationError('issue', 'authenticatedAt');
  return Object.freeze({
    billingKey: rawBilling.billingKey,
    customerKey: expectedCustomerKey,
    method: 'CARD',
    authenticatedAt: authenticatedAt.toISOString(),
  });
}

function validateOrderId(orderId) {
  requireString(orderId, 'orderId');
  if (!/^[A-Za-z0-9_-]{6,64}$/u.test(orderId)) throw new RangeError('orderId format is invalid');
  return orderId;
}

function validateExpectation(expectations) {
  requireExactObject(expectations, ['orderId', 'customerKey', 'amount', 'currency'], [], 'expectations');
  validateOrderId(expectations.orderId);
  validateCustomerKey(expectations.customerKey);
  if (!Number.isSafeInteger(expectations.amount) || expectations.amount !== PRO_MONTHLY_AMOUNT_KRW) throw new RangeError('amount is invalid');
  if (expectations.currency !== currency) throw new RangeError('currency is invalid');
  return expectations;
}

function normalizeBillingPayment(rawPayment, expectations) {
  validateExpectation(expectations);
  if (!isPlainObject(rawPayment)) throw validationError('payment', 'shape');
  const status = rawPayment.status;
  if (['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT'].includes(status)) throw validationError('payment', 'status', 'pending');
  if (['CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED'].includes(status)) throw validationError('payment', 'status', 'terminal_failure');
  try {
    validateOpaqueString(rawPayment.paymentKey, 'paymentKey', 200);
  } catch (error) {
    throw validationError('payment', 'paymentKey');
  }
  if (status !== 'DONE') throw validationError('payment', 'status');
  if (rawPayment.type !== 'BILLING') throw validationError('payment', 'type');
  if (rawPayment.orderId !== expectations.orderId) throw validationError('payment', 'orderId');
  if (!Number.isSafeInteger(rawPayment.totalAmount) || rawPayment.totalAmount !== expectations.amount) throw validationError('payment', 'totalAmount');
  if (rawPayment.currency !== expectations.currency) throw validationError('payment', 'currency');
  if (rawPayment.method !== '카드') throw validationError('payment', 'method');
  if (!isPlainObject(rawPayment.card)) throw validationError('payment', 'card');
  if (Object.prototype.hasOwnProperty.call(rawPayment, 'customerKey') && rawPayment.customerKey !== expectations.customerKey) throw validationError('payment', 'customerKey');
  if (rawPayment.approvedAt === null || rawPayment.approvedAt === undefined) throw validationError('payment', 'approvedAt');
  const approvedAt = new Date(rawPayment.approvedAt);
  if (Number.isNaN(approvedAt.getTime())) throw validationError('payment', 'approvedAt');
  return Object.freeze({
    paymentKey: rawPayment.paymentKey,
    orderId: expectations.orderId,
    status: 'DONE',
    type: 'BILLING',
    amount: expectations.amount,
    currency: expectations.currency,
    method: 'CARD',
    approvedAt: approvedAt.toISOString(),
  });
}

function validateSecretKey(secretKey) {
  requireString(secretKey, 'secretKey');
  if (secretKey.length < 1 || secretKey.length > 300 || /[\u0000\r\n]/u.test(secretKey)) throw new RangeError('secretKey is invalid');
  return secretKey;
}

function validateTimeouts(timeoutMs) {
  requireExactObject(timeoutMs, ['issue', 'charge', 'lookup'], [], 'timeoutMs');
  for (const key of ['issue', 'charge', 'lookup']) {
    if (!Number.isSafeInteger(timeoutMs[key]) || timeoutMs[key] <= 0 || timeoutMs[key] > 120000) throw new RangeError(`${key} timeout is invalid`);
  }
  return Object.freeze({ ...timeoutMs });
}

function providerCodeFrom(body) {
  if (!isPlainObject(body) || typeof body.code !== 'string' || !/^[A-Z0-9_]{1,100}$/u.test(body.code)) return null;
  return body.code;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function dispositionFor(operation, kind, status, providerCode) {
  if (operation === 'issue') {
    if (kind === 'invalid_response') return 'reregister';
    if (status === 401 || AUTH_CONFIGURATION_CODES.has(providerCode)) return 'configuration';
    return 'reregister';
  }
  if (operation === 'charge') {
    if (kind === 'timeout' || kind === 'network' || isRetryableStatus(status) || providerCode === 'DUPLICATED_ORDER_ID') return 'refetch';
    if (status === 401 || providerCode === 'UNAUTHORIZED_KEY' || providerCode === 'INCORRECT_BASIC_AUTH_FORMAT' || providerCode === 'NOT_SUPPORTED_BILLING_MERCHANT') return 'configuration';
    return 'rejected';
  }
  if (operation === 'lookup' && kind === 'http' && status === 404) return 'order_not_found';
  if (kind === 'timeout' || kind === 'network' || isRetryableStatus(status)) return 'lookup_again';
  if (status >= 400 && status < 500 && AUTH_CONFIGURATION_CODES.has(providerCode)) return 'configuration';
  return kind === 'invalid_response' ? 'lookup_again' : 'rejected';
}

function tossError(operation, kind, status = null, providerCode = null) {
  return new TossProviderError(operation, kind, status, providerCode, dispositionFor(operation, kind, status, providerCode));
}

function isOrderLookupNotFound(error) {
  return error instanceof TossProviderError
    && error.operation === 'lookup'
    && error.kind === 'http'
    && error.httpStatus === 404
    && error.disposition === 'order_not_found';
}

function validateAuthKey(authKey) {
  return validateOpaqueString(authKey, 'authKey', 300);
}

function validateOrderName(orderName) {
  requireString(orderName, 'orderName');
  if (orderName.length < 1 || orderName.length > 100 || orderName !== orderName.trim() || /[\u0000\r\n]/u.test(orderName)) throw new RangeError('orderName is invalid');
  return orderName;
}

function validateIdempotencyKey(idempotencyKey) {
  requireString(idempotencyKey, 'idempotencyKey');
  if (!/^[\x21-\x7E]{1,300}$/u.test(idempotencyKey)) throw new RangeError('idempotencyKey is invalid');
  return idempotencyKey;
}

function validateResponseStatus(response) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('invalid status');
  return response.status;
}

function createTossClient({ secretKey, fetchImpl = globalThis.fetch, timeoutMs = TOSS_TIMEOUT_MS }) {
  const input = arguments[0];
  requireExactObject(input, ['secretKey'], ['fetchImpl', 'timeoutMs'], 'options');
  validateSecretKey(secretKey);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const timeouts = validateTimeouts(timeoutMs);

  async function request(operation, url, method, body, timeout, idempotencyKey) {
    const controller = new AbortController();
    let timedOut = false;
    let rejectDeadline;
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      rejectDeadline(tossError(operation, 'timeout'));
      try {
        controller.abort();
      } catch (error) {
        // Abort is best-effort; the deadline rejection is authoritative.
      }
    }, timeout);
    const headers = {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`,
      Accept: 'application/json',
      'Accept-Language': 'en',
    };
    const options = { method, headers, signal: controller.signal };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
      if (operation === 'charge') headers['Idempotency-Key'] = idempotencyKey;
    }
    const providerWork = (async () => {
      try {
      const response = await fetchImpl(url, options);
      if (timedOut) throw tossError(operation, 'timeout');
      let status;
      try {
        status = validateResponseStatus(response);
      } catch (error) {
        throw tossError(operation, 'invalid_response');
      }
      if (status < 200 || status >= 300) {
        let parsed = null;
        try {
          if (typeof response.json === 'function') parsed = await response.json();
        } catch (error) {
          parsed = null;
        }
        if (timedOut) throw tossError(operation, 'timeout');
        throw tossError(operation, 'http', status, providerCodeFrom(parsed));
      }
      if (operation === 'charge') return undefined;
      try {
        if (typeof response.json !== 'function') throw new Error('json');
        const parsed = await response.json();
        if (timedOut) throw tossError(operation, 'timeout');
        if ((operation === 'issue' || operation === 'lookup') && !isPlainObject(parsed)) throw tossError(operation, 'invalid_response');
        return parsed;
      } catch (error) {
        if (timedOut) throw tossError(operation, 'timeout');
        if (error instanceof TossProviderError) throw error;
        throw tossError(operation, 'invalid_response');
      }
      } catch (error) {
        if (timedOut) throw tossError(operation, 'timeout');
        if (error instanceof TossProviderError) throw error;
        if (error instanceof BillingPaymentValidationError) throw error;
        throw tossError(operation, 'network');
      }
    })();
    try {
      return await Promise.race([providerWork, deadline]);
    } catch (error) {
      if (timedOut) throw tossError(operation, 'timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const client = {
    async issueBillingKey(input) {
      requireExactObject(input, ['authKey', 'customerKey'], [], 'issueBillingKey');
      validateAuthKey(input.authKey);
      validateCustomerKey(input.customerKey);
      const raw = await request('issue', `${TOSS_API_BASE_URL}/v1/billing/authorizations/issue`, 'POST', {
        authKey: input.authKey,
        customerKey: input.customerKey,
      }, timeouts.issue);
      return normalizeBillingIssue(raw, input.customerKey);
    },
    async chargeBillingKey(input) {
      requireExactObject(input, ['billingKey', 'customerKey', 'orderId', 'orderName', 'amount', 'idempotencyKey'], [], 'chargeBillingKey');
      validateBillingKey(input.billingKey);
      validateCustomerKey(input.customerKey);
      validateOrderId(input.orderId);
      validateOrderName(input.orderName);
      if (!Number.isSafeInteger(input.amount) || input.amount !== PRO_MONTHLY_AMOUNT_KRW) throw new RangeError('amount is invalid');
      validateIdempotencyKey(input.idempotencyKey);
      await request('charge', `${TOSS_API_BASE_URL}/v1/billing/${encodeURIComponent(input.billingKey)}`, 'POST', {
        amount: input.amount,
        customerKey: input.customerKey,
        orderId: input.orderId,
        orderName: input.orderName,
      }, timeouts.charge, input.idempotencyKey);
      return undefined;
    },
    async refetchBillingPayment(input) {
      requireExactObject(input, ['orderId', 'customerKey', 'amount', 'currency'], [], 'refetchBillingPayment');
      validateExpectation(input);
      const raw = await request('lookup', `${TOSS_API_BASE_URL}/v1/payments/orders/${encodeURIComponent(input.orderId)}`, 'GET', null, timeouts.lookup);
      return normalizeBillingPayment(raw, input);
    },
  };
  return Object.freeze(client);
}

module.exports = {
  BILLING_ENVELOPE_VERSION,
  TOSS_API_BASE_URL,
  TOSS_TIMEOUT_MS,
  BillingConfigurationError,
  BillingCryptoError,
  TossProviderError,
  BillingPaymentValidationError,
  isOrderLookupNotFound,
  validateCustomerKey,
  generateCustomerKey,
  fingerprintBillingKey,
  encryptBillingKey,
  decryptBillingKey,
  redactSensitive,
  normalizeBillingIssue,
  normalizeBillingPayment,
  createTossClient,
};

// Task 3: Firestore-independent repository. Composition supplies the Admin
// Firestore instance; this module never initializes Firebase or reads env.
const BILLING_DOMAIN = require('./_billing-domain');
const BILLING_SCHEMA_VERSION = 1;
const BILLING_LEASE_MS = 120000;
const MAX_DUE_SUBSCRIPTIONS = 100;
const SUBSCRIPTIONS_COLLECTION = 'subscriptions';
const BILLING_ORDERS_COLLECTION = 'billingOrders';
const RENEWAL_RECONCILIATION_STATES = Object.freeze(['none', 'unknown', 'manual']);
const RENEWAL_UNKNOWN_RETRY_OFFSETS_MS = Object.freeze([
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  72 * 60 * 60 * 1000,
  168 * 60 * 60 * 1000,
  336 * 60 * 60 * 1000,
]);
const RENEWAL_UNKNOWN_CUTOFF_MS = 15 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_FIELDS = [
  'schemaVersion', 'status', 'amount', 'currency', 'customerKey', 'initialAttempt',
  'initialOrderId', 'billingMethodStatus', 'billingKeyCiphertext', 'billingKeyFingerprint',
  'billingMethodInvalidatedAt', 'anchorAt', 'currentCycle', 'currentPeriodStart',
  'currentPeriodEnd', 'nextAttemptAt', 'retryCount', 'cancelAtPeriodEnd', 'canceledAt',
  'manualRetryRequired', 'requiresBillingMethodRegistration', 'lastPaymentAt',
  'lastPaymentFailedAt', 'lastSuccessfulOrderId', 'renewalReconciliationState',
  'billingWorkDueAt', 'createdAt', 'updatedAt',
];
const ORDER_FIELDS = [
  'schemaVersion', 'orderId', 'uid', 'kind', 'cycle', 'attempt', 'periodStart', 'amount',
  'currency', 'customerKey', 'idempotencyKey', 'resolution', 'terminalResult', 'failureCode',
  'providerCode', 'leaseToken', 'leaseAcquiredAt', 'leaseExpiresAt', 'providerRequestStartedAt',
  'providerLastLookupAt', 'providerPaymentKey', 'providerStatus', 'providerType',
  'providerMethod', 'providerApprovedAt', 'createdAt', 'updatedAt', 'completedAt',
];
const INITIAL_ORDER_RE = /^ntx_p_[0-9a-f]{48}$/u;
const INITIAL_IDEMPOTENCY_RE = /^ntx_pi_[0-9a-f]{64}$/u;
const LEASE_TOKEN_RE = /^ntx_l_[0-9a-f]{32}$/u;
const FINGERPRINT_RE = /^bkf1_[A-Za-z0-9_-]{43}$/u;
const SAFE_PROVIDER_CODE_RE = /^[A-Z0-9_]{1,100}$/u;
const RELEASE_RESOLUTIONS = new Set([
  'not_sent', 'charge_unknown', 'lookup_pending', 'lookup_unknown',
  'configuration_error', 'security_mismatch', 'worker_error',
]);

class BillingRepositoryError extends Error {
  constructor(name, code, metadata = {}) {
    super('Billing repository operation failed');
    this.name = name;
    this.code = code;
    Object.assign(this, metadata);
  }
}

class BillingRecordNotFoundError extends BillingRepositoryError {
  constructor(recordType) {
    super('BillingRecordNotFoundError', 'BILLING_RECORD_NOT_FOUND', { recordType });
  }
}

class BillingStateConflictError extends BillingRepositoryError {
  constructor(reason) {
    super('BillingStateConflictError', 'BILLING_STATE_CONFLICT', { reason });
  }
}

class BillingLeaseLostError extends BillingRepositoryError {
  constructor() {
    super('BillingLeaseLostError', 'BILLING_LEASE_LOST');
  }
}

class BillingRepositoryInvariantError extends BillingRepositoryError {
  constructor(field = 'document') {
    super('BillingRepositoryInvariantError', 'BILLING_REPOSITORY_INVARIANT', { field });
  }
}

class BillingStorageError extends BillingRepositoryError {
  constructor(operation) {
    super('BillingStorageError', 'BILLING_STORAGE_FAILED', { operation });
  }
}

function repositoryClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function repositoryUid(uid) {
  if (typeof uid !== 'string') throw new TypeError('uid must be a string');
  if (uid.length === 0 || uid.length > 128) throw new RangeError('uid length is invalid');
  return uid;
}

function repositoryIso(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a canonical ISO string`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new RangeError(`${name} must be canonical ISO`);
  return value;
}

function repositoryDate(value, name) {
  if (!(value instanceof Date)) throw new TypeError(`${name} must be a Date`);
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be valid`);
  return value;
}

function repositoryInteger(value, name, minimum, maximum) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) throw new RangeError(`${name} is out of range`);
  return value;
}

function exactKeys(value, fields, name) {
  requirePlainObject(value, name);
  const expected = [...fields].sort().join('|');
  if (Object.keys(value).sort().join('|') !== expected) throw new TypeError(`${name} has invalid keys`);
  return value;
}

function safeProviderCode(value, name = 'providerCode') {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${name} must be a string or null`);
  if (value !== null && !SAFE_PROVIDER_CODE_RE.test(value)) throw new RangeError(`${name} is invalid`);
  return value;
}

function validateInitialAttempt(attempt) {
  return repositoryInteger(attempt, 'attempt', 0);
}

function initialOrderId(uid, customerKey, attempt) {
  repositoryUid(uid);
  validateCustomerKey(customerKey);
  validateInitialAttempt(attempt);
  const preimage = `notyx|billing|v1|initial-order|${Buffer.byteLength(uid, 'utf8')}:${uid}|${customerKey}|a${attempt}`;
  return `ntx_p_${crypto.createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 48)}`;
}

function initialIdempotencyKey(uid, customerKey, attempt) {
  repositoryUid(uid);
  validateCustomerKey(customerKey);
  validateInitialAttempt(attempt);
  const preimage = `notyx|billing|v1|initial-idempotency|${Buffer.byteLength(uid, 'utf8')}:${uid}|${customerKey}|a${attempt}`;
  return `ntx_pi_${crypto.createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

function validateEnvelope(envelope) {
  exactKeys(envelope, ['version', 'iv', 'tag', 'ciphertext', 'fingerprint'], 'envelope');
  if (envelope.version !== BILLING_ENVELOPE_VERSION) throw new RangeError('envelope version is invalid');
  if (!FINGERPRINT_RE.test(envelope.fingerprint)) throw new RangeError('envelope fingerprint is invalid');
  const canonicalBase64 = (value, length, nonempty = true) => {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new RangeError('envelope encoding is invalid');
    const bytes = Buffer.from(value, 'base64');
    if (nonempty && bytes.length === 0) throw new RangeError('envelope encoding is empty');
    if (bytes.length !== length && length !== undefined) throw new RangeError('envelope encoding length is invalid');
    if (bytes.toString('base64') !== value) throw new RangeError('envelope encoding is noncanonical');
  };
  canonicalBase64(envelope.iv, 12);
  canonicalBase64(envelope.tag, 16);
  canonicalBase64(envelope.ciphertext);
  return envelope;
}

function sameEnvelope(left, right) {
  return left.version === right.version && left.iv === right.iv && left.tag === right.tag
    && left.ciphertext === right.ciphertext && left.fingerprint === right.fingerprint;
}

function renewalAttemptForSubscription(subscription) {
  if (subscription.status === 'active' && subscription.retryCount === 0) return 0;
  if (subscription.status === 'past_due' && subscription.retryCount === 1) return 1;
  if (subscription.status === 'past_due' && subscription.retryCount === 2) return 3;
  return null;
}

function reconciliationBoundaries(providerRequestStartedAt) {
  const start = new Date(providerRequestStartedAt).getTime();
  return [
    start,
    ...RENEWAL_UNKNOWN_RETRY_OFFSETS_MS.map((offset) => start + offset),
    start + RENEWAL_UNKNOWN_CUTOFF_MS,
  ].map((value) => new Date(value).toISOString());
}

function nextReconciliationBoundary(order) {
  const boundaries = reconciliationBoundaries(order.providerRequestStartedAt);
  if (order.providerLastLookupAt === null) return boundaries[0];
  const last = new Date(order.providerLastLookupAt).getTime();
  return boundaries.find((boundary) => new Date(boundary).getTime() > last) || null;
}

function validateSubscriptionRecord(subscription, uid) {
  exactKeys(subscription, SUBSCRIPTION_FIELDS, 'subscription');
  repositoryUid(uid);
  if (subscription.schemaVersion !== BILLING_SCHEMA_VERSION) throw new RangeError('schemaVersion is invalid');
  if (!['incomplete', 'active', 'past_due', 'canceled', 'expired'].includes(subscription.status)) throw new RangeError('status is invalid');
  if (subscription.amount !== PRO_MONTHLY_AMOUNT_KRW) throw new RangeError('amount is invalid');
  if (subscription.currency !== currency) throw new RangeError('currency is invalid');
  validateCustomerKey(subscription.customerKey);
  validateInitialAttempt(subscription.initialAttempt);
  if (!INITIAL_ORDER_RE.test(subscription.initialOrderId) || subscription.initialOrderId !== initialOrderId(uid, subscription.customerKey, subscription.initialAttempt)) throw new BillingRepositoryInvariantError('initialOrderId');
  if (!['absent', 'ready', 'invalid'].includes(subscription.billingMethodStatus)) throw new RangeError('billingMethodStatus is invalid');
  if (subscription.billingKeyCiphertext === null) {
    if (subscription.billingKeyFingerprint !== null) throw new BillingRepositoryInvariantError('billingKeyFingerprint');
  } else {
    validateEnvelope(subscription.billingKeyCiphertext);
  }
  if (subscription.billingKeyFingerprint !== null && !FINGERPRINT_RE.test(subscription.billingKeyFingerprint)) throw new RangeError('billingKeyFingerprint is invalid');
  if (subscription.billingKeyCiphertext !== null && subscription.billingKeyCiphertext.fingerprint !== subscription.billingKeyFingerprint) throw new BillingRepositoryInvariantError('billingKeyFingerprint');
  repositoryIso(subscription.billingMethodInvalidatedAt, 'billingMethodInvalidatedAt', true);
  if (subscription.billingMethodStatus === 'ready' && (subscription.billingKeyCiphertext === null || subscription.billingKeyFingerprint === null || subscription.billingMethodInvalidatedAt !== null)) throw new BillingRepositoryInvariantError('billingMethodStatus');
  if (subscription.billingMethodStatus === 'absent' && (subscription.billingKeyCiphertext !== null || subscription.billingKeyFingerprint !== null || subscription.billingMethodInvalidatedAt !== null)) throw new BillingRepositoryInvariantError('billingMethodStatus');
  if (subscription.billingMethodStatus === 'invalid' && (subscription.billingKeyCiphertext !== null || subscription.billingKeyFingerprint !== null || subscription.billingMethodInvalidatedAt === null)) throw new BillingRepositoryInvariantError('billingMethodStatus');
  repositoryIso(subscription.anchorAt, 'anchorAt', true);
  repositoryInteger(subscription.currentCycle, 'currentCycle', 0);
  repositoryIso(subscription.currentPeriodStart, 'currentPeriodStart', true);
  repositoryIso(subscription.currentPeriodEnd, 'currentPeriodEnd', true);
  repositoryIso(subscription.nextAttemptAt, 'nextAttemptAt', true);
  repositoryInteger(subscription.retryCount, 'retryCount', 0, 3);
  if (typeof subscription.cancelAtPeriodEnd !== 'boolean') throw new TypeError('cancelAtPeriodEnd must be boolean');
  repositoryIso(subscription.canceledAt, 'canceledAt', true);
  if (typeof subscription.manualRetryRequired !== 'boolean') throw new TypeError('manualRetryRequired must be boolean');
  if (typeof subscription.requiresBillingMethodRegistration !== 'boolean') throw new TypeError('requiresBillingMethodRegistration must be boolean');
  if (subscription.requiresBillingMethodRegistration && subscription.billingMethodStatus !== 'invalid') throw new BillingRepositoryInvariantError('requiresBillingMethodRegistration');
  if (!RENEWAL_RECONCILIATION_STATES.includes(subscription.renewalReconciliationState)) throw new RangeError('renewalReconciliationState is invalid');
  repositoryIso(subscription.billingWorkDueAt, 'billingWorkDueAt', true);
  repositoryIso(subscription.lastPaymentAt, 'lastPaymentAt', true);
  repositoryIso(subscription.lastPaymentFailedAt, 'lastPaymentFailedAt', true);
  if (subscription.lastSuccessfulOrderId !== null) validateOrderId(subscription.lastSuccessfulOrderId);
  repositoryIso(subscription.createdAt, 'createdAt');
  repositoryIso(subscription.updatedAt, 'updatedAt');
  try {
    BILLING_DOMAIN.sanitizeSubscription(subscription);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new BillingRepositoryInvariantError('document');
  }
  return subscription;
}

function validateOrderRecord(order, expectedId) {
  exactKeys(order, ORDER_FIELDS, 'order');
  if (order.schemaVersion !== BILLING_SCHEMA_VERSION) throw new RangeError('schemaVersion is invalid');
  if (order.orderId !== expectedId) throw new BillingRepositoryInvariantError('orderId');
  repositoryUid(order.uid);
  if (!['initial', 'renewal'].includes(order.kind)) throw new RangeError('kind is invalid');
  repositoryInteger(order.cycle, 'cycle', 0);
  validateInitialAttempt(order.attempt);
  repositoryIso(order.periodStart, 'periodStart', true);
  if (order.kind === 'initial' && (order.cycle !== 0 || order.periodStart !== null || order.orderId !== initialOrderId(order.uid, order.customerKey, order.attempt) || order.idempotencyKey !== initialIdempotencyKey(order.uid, order.customerKey, order.attempt))) throw new BillingRepositoryInvariantError('document');
  if (order.kind === 'renewal' && (!BILLING_DOMAIN.RENEWAL_ATTEMPT_DAYS.includes(order.attempt) || order.periodStart === null || order.orderId !== BILLING_DOMAIN.renewalOrderId(order.uid, order.periodStart, order.attempt) || order.idempotencyKey !== BILLING_DOMAIN.renewalIdempotencyKey(order.uid, order.periodStart, order.attempt))) throw new BillingRepositoryInvariantError('document');
  if (order.amount !== PRO_MONTHLY_AMOUNT_KRW) throw new RangeError('amount is invalid');
  if (order.currency !== currency) throw new RangeError('currency is invalid');
  validateCustomerKey(order.customerKey);
  if (typeof order.idempotencyKey !== 'string' || order.idempotencyKey.length < 1 || order.idempotencyKey.length > 300 || !/^[\x21-\x7E]+$/u.test(order.idempotencyKey)) throw new RangeError('idempotencyKey is invalid');
  if (!['ready', 'unknown', 'succeeded', 'failed'].includes(order.resolution)) throw new RangeError('resolution is invalid');
  if (order.terminalResult !== null && !['succeeded', 'failed'].includes(order.terminalResult)) throw new RangeError('terminalResult is invalid');
  if (order.failureCode !== null && !['provider_rejected', 'payment_terminal', 'authorization_failed', 'billing_method_invalid'].includes(order.failureCode)) throw new RangeError('failureCode is invalid');
  safeProviderCode(order.providerCode);
  const leaseValues = [order.leaseToken, order.leaseAcquiredAt, order.leaseExpiresAt];
  if (leaseValues.some((value) => value !== null) && leaseValues.some((value) => value === null)) throw new BillingRepositoryInvariantError('leaseToken');
  if (order.leaseToken !== null && !LEASE_TOKEN_RE.test(order.leaseToken)) throw new RangeError('leaseToken is invalid');
  repositoryIso(order.leaseAcquiredAt, 'leaseAcquiredAt', true);
  repositoryIso(order.leaseExpiresAt, 'leaseExpiresAt', true);
  repositoryIso(order.providerRequestStartedAt, 'providerRequestStartedAt', true);
  repositoryIso(order.providerLastLookupAt, 'providerLastLookupAt', true);
  if (order.providerPaymentKey !== null) validateOpaqueString(order.providerPaymentKey, 'providerPaymentKey', 200);
  if (order.providerStatus !== null && order.providerStatus !== 'DONE') throw new RangeError('providerStatus is invalid');
  if (order.providerType !== null && order.providerType !== 'BILLING') throw new RangeError('providerType is invalid');
  if (order.providerMethod !== null && order.providerMethod !== 'CARD') throw new RangeError('providerMethod is invalid');
  repositoryIso(order.providerApprovedAt, 'providerApprovedAt', true);
  repositoryIso(order.createdAt, 'createdAt');
  repositoryIso(order.updatedAt, 'updatedAt');
  repositoryIso(order.completedAt, 'completedAt', true);
  if (order.resolution === 'ready' || order.resolution === 'unknown') {
    if (order.terminalResult !== null || order.completedAt !== null || order.failureCode !== null || order.providerCode !== null || order.providerPaymentKey !== null || order.providerStatus !== null || order.providerType !== null || order.providerMethod !== null || order.providerApprovedAt !== null) throw new BillingRepositoryInvariantError('resolution');
  } else if (order.resolution === 'succeeded') {
    if (order.terminalResult !== 'succeeded' || order.completedAt === null || order.failureCode !== null || order.providerCode !== null || order.providerPaymentKey === null || order.providerStatus !== 'DONE' || order.providerType !== 'BILLING' || order.providerMethod !== 'CARD' || order.providerApprovedAt === null) throw new BillingRepositoryInvariantError('resolution');
  } else if (order.terminalResult !== 'failed' || order.failureCode === null || order.completedAt === null || order.providerPaymentKey !== null || order.providerStatus !== null || order.providerType !== null || order.providerMethod !== null || order.providerApprovedAt !== null) throw new BillingRepositoryInvariantError('resolution');
  return order;
}

function validateSubscriptionDocument(subscription, uid) {
  try {
    return validateSubscriptionRecord(subscription, uid);
  } catch (error) {
    if (error instanceof BillingRepositoryInvariantError) throw error;
    throw new BillingRepositoryInvariantError('document');
  }
}

function validateOrderDocument(order, orderId) {
  try {
    return validateOrderRecord(order, orderId);
  } catch (error) {
    if (error instanceof BillingRepositoryInvariantError) throw error;
    throw new BillingRepositoryInvariantError('document');
  }
}

function newOrder({ uid, customerKey, kind, cycle, attempt, periodStart, now }) {
  const orderId = kind === 'initial' ? initialOrderId(uid, customerKey, attempt) : BILLING_DOMAIN.renewalOrderId(uid, periodStart, attempt);
  const idempotencyKey = kind === 'initial' ? initialIdempotencyKey(uid, customerKey, attempt) : BILLING_DOMAIN.renewalIdempotencyKey(uid, periodStart, attempt);
  return {
    schemaVersion: BILLING_SCHEMA_VERSION,
    orderId,
    uid,
    kind,
    cycle,
    attempt,
    periodStart: periodStart || null,
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    customerKey,
    idempotencyKey,
    resolution: 'ready',
    terminalResult: null,
    failureCode: null,
    providerCode: null,
    leaseToken: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    providerRequestStartedAt: null,
    providerLastLookupAt: null,
    providerPaymentKey: null,
    providerStatus: null,
    providerType: null,
    providerMethod: null,
    providerApprovedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function newSubscription({ uid, customerKey, now, createdAt = now }) {
  return {
    schemaVersion: BILLING_SCHEMA_VERSION,
    status: 'incomplete',
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    customerKey,
    initialAttempt: 0,
    initialOrderId: initialOrderId(uid, customerKey, 0),
    billingMethodStatus: 'absent',
    billingKeyCiphertext: null,
    billingKeyFingerprint: null,
    billingMethodInvalidatedAt: null,
    anchorAt: null,
    currentCycle: 0,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextAttemptAt: null,
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: null,
    lastPaymentFailedAt: null,
    lastSuccessfulOrderId: null,
    renewalReconciliationState: 'none',
    billingWorkDueAt: null,
    createdAt,
    updatedAt: now,
  };
}

function projectionFor(subscription) {
  if (subscription.status === 'active') return { plan: 'monthly', planExpiry: subscription.currentPeriodEnd };
  if (subscription.status === 'past_due') return { plan: 'monthly', planExpiry: subscription.nextAttemptAt };
  return { plan: 'free', planExpiry: null };
}

function writeProjection(transaction, uid, subscription) {
  transaction.set({ collection: 'users', id: uid, path: `users/${uid}` }, projectionFor(subscription), { merge: true });
}

function captureNow(now) {
  const value = now();
  return repositoryDate(value, 'now').toISOString();
}

function validateLeaseToken(value) {
  if (typeof value !== 'string') throw new TypeError('leaseToken must be a string');
  if (!LEASE_TOKEN_RE.test(value)) throw new RangeError('leaseToken format is invalid');
  return value;
}

function leaseExpiry(iso, leaseMs) {
  const expiry = new Date(new Date(iso).getTime() + leaseMs);
  if (Number.isNaN(expiry.getTime())) throw new RangeError('lease expiry is invalid');
  return expiry.toISOString();
}

function validatePayment(payment) {
  exactKeys(payment, ['paymentKey', 'orderId', 'status', 'type', 'amount', 'currency', 'method', 'approvedAt'], 'payment');
  validateOpaqueString(payment.paymentKey, 'paymentKey', 200);
  validateOrderId(payment.orderId);
  if (payment.status !== 'DONE' || payment.type !== 'BILLING' || payment.amount !== PRO_MONTHLY_AMOUNT_KRW || payment.currency !== currency || payment.method !== 'CARD') throw new RangeError('payment evidence is invalid');
  repositoryIso(payment.approvedAt, 'approvedAt');
  return payment;
}

function normalizedPaymentFromOrder(order) {
  return Object.freeze({
    paymentKey: order.providerPaymentKey,
    orderId: order.orderId,
    status: 'DONE',
    type: 'BILLING',
    amount: PRO_MONTHLY_AMOUNT_KRW,
    currency,
    method: 'CARD',
    approvedAt: order.providerApprovedAt,
  });
}

function paymentMatchesOrder(order, payment) {
  return order.providerPaymentKey === payment.paymentKey
    && order.orderId === payment.orderId
    && order.providerStatus === payment.status
    && order.providerType === payment.type
    && order.providerMethod === payment.method
    && order.providerApprovedAt === payment.approvedAt;
}

function initialCurrent(subscription, order) {
  return subscription.status === 'incomplete'
    && subscription.requiresBillingMethodRegistration === false
    && subscription.initialAttempt === order.attempt
    && subscription.initialOrderId === order.orderId;
}

function renewalCurrent(subscription, order) {
  return subscription.status !== 'incomplete'
    && subscription.currentPeriodEnd === order.periodStart
    && subscription.currentCycle + 1 === order.cycle;
}

function transactionRead(transaction, collection, id) {
  return transaction.get({ collection, id, path: `${collection}/${id}` });
}

function snapshotData(snapshot, recordType) {
  if (!snapshot.exists) throw new BillingRecordNotFoundError(recordType);
  return snapshot.data();
}

function createBillingRepository(options) {
  requireExactObject(options, ['firestore'], ['now', 'randomBytes', 'leaseMs'], 'options');
  const { firestore } = options;
  if (!firestore || typeof firestore.collection !== 'function' || typeof firestore.runTransaction !== 'function') throw new TypeError('firestore adapter is invalid');
  const now = options.now === undefined ? () => new Date() : options.now;
  const randomBytes = options.randomBytes === undefined ? crypto.randomBytes : options.randomBytes;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  const leaseMs = options.leaseMs === undefined ? BILLING_LEASE_MS : options.leaseMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 600000) throw new RangeError('leaseMs is invalid');
  const subscriptionRef = (uid) => firestore.collection(SUBSCRIPTIONS_COLLECTION).doc(uid);
  const orderRef = (orderId) => firestore.collection(BILLING_ORDERS_COLLECTION).doc(orderId);
  const runTransaction = async (callback) => {
    try {
      return repositoryClone(await firestore.runTransaction(callback));
    } catch (error) {
      if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new BillingStorageError('transaction');
    }
  };
  const readDocument = async (collection, id, recordType, validator) => {
    try {
      const snapshot = await firestore.collection(collection).doc(id).get();
      if (!snapshot.exists) return null;
      return repositoryClone(validator(snapshot.data(), id));
    } catch (error) {
      if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new BillingStorageError('read');
    }
  };
  const readSubscriptionTx = async (transaction, uid) => {
    const snapshot = await transactionRead(transaction, SUBSCRIPTIONS_COLLECTION, uid);
    if (!snapshot.exists) throw new BillingRecordNotFoundError('subscription');
    const subscription = validateSubscriptionDocument(snapshot.data(), uid);
    await validateSubscriptionCrossDocument(transaction, uid, subscription);
    return subscription;
  };
  const readOrderTx = async (transaction, orderId) => {
    const snapshot = await transactionRead(transaction, BILLING_ORDERS_COLLECTION, orderId);
    if (!snapshot.exists) throw new BillingRecordNotFoundError('order');
    return validateOrderDocument(snapshot.data(), orderId);
  };
  const leaseOwner = (order, leaseToken) => {
    if (order.leaseToken === null || order.leaseToken !== leaseToken) throw new BillingLeaseLostError();
  };
  const checkOrderIdentity = (order, uid, orderId) => {
    if (order.uid !== uid || order.orderId !== orderId) throw new BillingRepositoryInvariantError('document');
  };

  async function validateSubscriptionCrossDocument(transaction, uid, subscription) {
    if (subscription.renewalReconciliationState === 'none') return null;
    const attempt = renewalAttemptForSubscription(subscription);
    if (attempt === null || subscription.cancelAtPeriodEnd || subscription.canceledAt !== null) throw new BillingRepositoryInvariantError('renewalReconciliationState');
    const orderId = BILLING_DOMAIN.renewalOrderId(uid, subscription.currentPeriodEnd, attempt);
    const snapshot = await transactionRead(transaction, BILLING_ORDERS_COLLECTION, orderId);
    if (!snapshot.exists) throw new BillingRepositoryInvariantError('renewalReconciliationState');
    const order = validateOrderDocument(snapshot.data(), orderId);
    if (order.uid !== uid || order.kind !== 'renewal' || order.customerKey !== subscription.customerKey
      || order.cycle !== subscription.currentCycle + 1 || order.periodStart !== subscription.currentPeriodEnd
      || order.attempt !== attempt || order.resolution !== 'unknown' || order.providerRequestStartedAt === null) {
      throw new BillingRepositoryInvariantError('renewalReconciliationState');
    }
    if (subscription.renewalReconciliationState === 'unknown') {
      if (subscription.billingWorkDueAt !== nextReconciliationBoundary(order)) throw new BillingRepositoryInvariantError('billingWorkDueAt');
    } else {
      const cutoff = new Date(order.providerRequestStartedAt).getTime() + RENEWAL_UNKNOWN_CUTOFF_MS;
      const finalAutomaticBoundary = new Date(order.providerRequestStartedAt).getTime() + RENEWAL_UNKNOWN_RETRY_OFFSETS_MS.at(-1);
      if (subscription.billingWorkDueAt !== null || order.providerLastLookupAt === null || new Date(order.providerLastLookupAt).getTime() < finalAutomaticBoundary) {
        throw new BillingRepositoryInvariantError('renewalReconciliationState');
      }
    }
    return order;
  }

  async function getSubscription(input) {
    exactKeys(input, ['uid'], [], 'getSubscription');
    repositoryUid(input.uid);
    captureNow(now);
    const subscription = await readDocument(SUBSCRIPTIONS_COLLECTION, input.uid, 'subscription', validateSubscriptionDocument);
    if (subscription && subscription.renewalReconciliationState !== 'none') {
      try {
        await validateSubscriptionCrossDocument({ get: (ref) => firestore.collection(ref.collection).doc(ref.id).get() }, input.uid, subscription);
      } catch (error) {
        if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
        throw new BillingStorageError('read');
      }
    }
    return repositoryClone(subscription);
  }

  async function getBillingOrder(input) {
    exactKeys(input, ['orderId'], [], 'getBillingOrder');
    validateOrderId(input.orderId);
    captureNow(now);
    return readDocument(BILLING_ORDERS_COLLECTION, input.orderId, 'order', validateOrderDocument);
  }

  async function prepareSubscription(input) {
    exactKeys(input, ['uid', 'customerKey'], [], 'prepareSubscription');
    repositoryUid(input.uid);
    validateCustomerKey(input.customerKey);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subSnapshot = await transactionRead(transaction, SUBSCRIPTIONS_COLLECTION, input.uid);
      if (!subSnapshot.exists) {
        const subscription = newSubscription({ uid: input.uid, customerKey: input.customerKey, now: nowIso });
        const order = newOrder({ uid: input.uid, customerKey: input.customerKey, kind: 'initial', cycle: 0, attempt: 0, periodStart: null, now: nowIso });
        transaction.create(subscriptionRef(input.uid), subscription);
        transaction.create(orderRef(order.orderId), order);
        writeProjection(transaction, input.uid, subscription);
        return { subscription, order, created: true };
      }
      const existing = validateSubscriptionDocument(subSnapshot.data(), input.uid);
      await validateSubscriptionCrossDocument(transaction, input.uid, existing);
      if (existing.status === 'active' || existing.status === 'past_due') throw new BillingStateConflictError('subscription_already_entitled');
      if ((existing.status === 'canceled' || existing.status === 'expired') || existing.requiresBillingMethodRegistration) {
        const subscription = newSubscription({ uid: input.uid, customerKey: input.customerKey, now: nowIso, createdAt: existing.createdAt });
        const order = newOrder({ uid: input.uid, customerKey: input.customerKey, kind: 'initial', cycle: 0, attempt: 0, periodStart: null, now: nowIso });
        transaction.set(subscriptionRef(input.uid), subscription, { merge: true });
        transaction.create(orderRef(order.orderId), order);
        writeProjection(transaction, input.uid, subscription);
        return { subscription, order, created: true };
      }
      const orderSnapshot = await transactionRead(transaction, BILLING_ORDERS_COLLECTION, existing.initialOrderId);
      let order;
      if (orderSnapshot.exists) order = validateOrderDocument(orderSnapshot.data(), existing.initialOrderId);
      else {
        order = newOrder({ uid: input.uid, customerKey: existing.customerKey, kind: 'initial', cycle: 0, attempt: existing.initialAttempt, periodStart: null, now: nowIso });
        transaction.create(orderRef(order.orderId), order);
      }
      if (order.uid !== input.uid || order.customerKey !== existing.customerKey) throw new BillingRepositoryInvariantError('document');
      return { subscription: existing, order, created: false };
    });
  }

  async function prepareInitialRetry(input) {
    exactKeys(input, ['uid'], [], 'prepareInitialRetry');
    repositoryUid(input.uid);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const current = await readOrderTx(transaction, subscription.initialOrderId);
      if (subscription.status === 'active') {
        const exactSucceededInitial = current.uid === input.uid
          && current.kind === 'initial'
          && current.customerKey === subscription.customerKey
          && current.orderId === initialOrderId(input.uid, subscription.customerKey, subscription.initialAttempt)
          && current.resolution === 'succeeded'
          && current.terminalResult === 'succeeded'
          && current.providerPaymentKey !== null
          && current.providerStatus === 'DONE'
          && current.providerType === 'BILLING'
          && current.providerMethod === 'CARD'
          && current.providerApprovedAt !== null
          && subscription.lastSuccessfulOrderId === subscription.initialOrderId;
        if (!exactSucceededInitial) throw new BillingRepositoryInvariantError('document');
        return { subscription, order: current, created: false };
      }
      if (subscription.status !== 'incomplete') throw new BillingStateConflictError('initial_retry_not_allowed');
      if (current.uid !== input.uid || current.kind !== 'initial' || current.customerKey !== subscription.customerKey || !initialCurrent(subscription, current)) throw new BillingRepositoryInvariantError('initialOrderId');
      if (current.resolution === 'unknown') return { subscription, order: current, created: false };
      if (current.resolution === 'ready') {
        if (subscription.initialAttempt > 0) return { subscription, order: current, created: false };
        throw new BillingStateConflictError('initial_retry_not_allowed');
      }
      if (current.resolution === 'succeeded') throw new BillingStateConflictError('order_terminal');
      if (current.failureCode !== 'provider_rejected' && current.failureCode !== 'payment_terminal') throw new BillingStateConflictError('order_not_retryable');
      if (subscription.status !== 'incomplete' || subscription.manualRetryRequired !== true || subscription.requiresBillingMethodRegistration || subscription.billingMethodStatus !== 'ready' || subscription.lastSuccessfulOrderId !== null) throw new BillingStateConflictError('initial_retry_not_allowed');
      if (subscription.initialAttempt === Number.MAX_SAFE_INTEGER) throw new BillingRepositoryInvariantError('initialAttempt');
      const nextAttempt = subscription.initialAttempt + 1;
      const nextOrderId = initialOrderId(input.uid, subscription.customerKey, nextAttempt);
      const nextSnapshot = await transactionRead(transaction, BILLING_ORDERS_COLLECTION, nextOrderId);
      let order;
      let created = false;
      if (nextSnapshot.exists) order = validateOrderDocument(nextSnapshot.data(), nextOrderId);
      else {
        order = newOrder({ uid: input.uid, customerKey: subscription.customerKey, kind: 'initial', cycle: 0, attempt: nextAttempt, periodStart: null, now: nowIso });
        transaction.create(orderRef(order.orderId), order);
        created = true;
      }
      if (order.uid !== input.uid || order.customerKey !== subscription.customerKey || order.attempt !== nextAttempt || order.resolution === 'failed' || order.resolution === 'succeeded') throw new BillingRepositoryInvariantError('document');
      const updated = { ...subscription, initialAttempt: nextAttempt, initialOrderId: order.orderId, manualRetryRequired: false, updatedAt: nowIso };
      transaction.update(subscriptionRef(input.uid), { initialAttempt: nextAttempt, initialOrderId: order.orderId, manualRetryRequired: false, updatedAt: nowIso });
      writeProjection(transaction, input.uid, updated);
      return { subscription: updated, order, created };
    });
  }

  async function prepareRenewalOrder(input) {
    exactKeys(input, ['uid', 'attempt'], [], 'prepareRenewalOrder');
    repositoryUid(input.uid);
    repositoryInteger(input.attempt, 'attempt', 0, 3);
    if (!BILLING_DOMAIN.RENEWAL_ATTEMPT_DAYS.includes(input.attempt)) throw new RangeError('attempt is not a retry day');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      if (subscription.status === 'incomplete' || subscription.status === 'canceled' || subscription.status === 'expired' || subscription.cancelAtPeriodEnd || subscription.billingMethodStatus !== 'ready' || subscription.billingKeyCiphertext === null || subscription.renewalReconciliationState !== 'none' || subscription.billingWorkDueAt !== subscription.nextAttemptAt) throw new BillingStateConflictError('subscription_terminal');
      const validAttempt = (input.attempt === 0 && subscription.status === 'active' && subscription.retryCount === 0)
        || (input.attempt === 1 && subscription.status === 'past_due' && subscription.retryCount === 1)
        || (input.attempt === 3 && subscription.status === 'past_due' && subscription.retryCount === 2);
      if (!validAttempt) throw new BillingStateConflictError('action_not_allowed');
      if (new Date(nowIso).getTime() < new Date(subscription.nextAttemptAt).getTime()) throw new BillingStateConflictError('subscription_not_due');
      const orderId = BILLING_DOMAIN.renewalOrderId(input.uid, subscription.currentPeriodEnd, input.attempt);
      const snapshot = await transactionRead(transaction, BILLING_ORDERS_COLLECTION, orderId);
      if (snapshot.exists) {
        const order = validateOrderDocument(snapshot.data(), orderId);
        if (order.uid !== input.uid || order.customerKey !== subscription.customerKey || order.cycle !== subscription.currentCycle + 1 || order.periodStart !== subscription.currentPeriodEnd) throw new BillingRepositoryInvariantError('document');
        return { subscription, order, created: false };
      }
      const order = newOrder({ uid: input.uid, customerKey: subscription.customerKey, kind: 'renewal', cycle: subscription.currentCycle + 1, attempt: input.attempt, periodStart: subscription.currentPeriodEnd, now: nowIso });
      transaction.create(orderRef(order.orderId), order);
      return { subscription, order, created: true };
    });
  }

  async function listDueSubscriptions(input) {
    exactKeys(input, ['at', 'limit'], [], 'listDueSubscriptions');
    repositoryDate(input.at, 'at');
    repositoryInteger(input.limit, 'limit', 1, MAX_DUE_SUBSCRIPTIONS);
    captureNow(now);
    const atIso = input.at.toISOString();
    try {
      const snapshot = await firestore.collection(SUBSCRIPTIONS_COLLECTION)
        .where('status', 'in', ['active', 'past_due'])
        .where('renewalReconciliationState', 'in', ['none', 'unknown'])
        .where('billingWorkDueAt', '<=', atIso)
        .orderBy('billingWorkDueAt', 'asc')
        .limit(input.limit)
        .get();
      const records = [];
      for (const item of snapshot.docs) {
        const subscription = validateSubscriptionDocument(item.data(), item.id);
        await validateSubscriptionCrossDocument({ get: (ref) => firestore.collection(ref.collection).doc(ref.id).get() }, item.id, subscription);
        if ((subscription.status === 'active' || subscription.status === 'past_due') && subscription.billingWorkDueAt !== null && subscription.billingWorkDueAt <= atIso) {
          records.push({ uid: item.id, ...repositoryClone(subscription) });
        }
      }
      return records;
    } catch (error) {
      if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new BillingStorageError('query');
    }
  }

  async function findSubscriptionByBillingKeyFingerprint(input) {
    exactKeys(input, ['fingerprint'], [], 'findSubscriptionByBillingKeyFingerprint');
    if (typeof input.fingerprint !== 'string') throw new TypeError('fingerprint must be a string');
    if (!FINGERPRINT_RE.test(input.fingerprint)) throw new RangeError('fingerprint is invalid');
    captureNow(now);
    try {
      const snapshot = await firestore.collection(SUBSCRIPTIONS_COLLECTION).where('billingKeyFingerprint', '==', input.fingerprint).limit(2).get();
      if (snapshot.size === 0) return null;
      if (snapshot.size > 1) throw new BillingRepositoryInvariantError('document');
       const subscription = validateSubscriptionDocument(snapshot.docs[0].data(), snapshot.docs[0].id);
       if (subscription.renewalReconciliationState !== 'none') {
         await validateSubscriptionCrossDocument({ get: (ref) => firestore.collection(ref.collection).doc(ref.id).get() }, snapshot.docs[0].id, subscription);
       }
       return repositoryClone(subscription);
    } catch (error) {
      if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new BillingStorageError('query');
    }
  }

  async function findSubscriptionUidByBillingKeyFingerprint(input) {
    exactKeys(input, ['fingerprint'], [], 'findSubscriptionUidByBillingKeyFingerprint');
    if (typeof input.fingerprint !== 'string') throw new TypeError('fingerprint must be a string');
    if (!FINGERPRINT_RE.test(input.fingerprint)) throw new RangeError('fingerprint is invalid');
    captureNow(now);
    try {
      const snapshot = await firestore.collection(SUBSCRIPTIONS_COLLECTION)
        .where('billingKeyFingerprint', '==', input.fingerprint).limit(2).get();
      if (snapshot.size === 0) return null;
      if (snapshot.size > 1) throw new BillingRepositoryInvariantError('document');
      const uid = snapshot.docs[0].id;
      const subscription = validateSubscriptionDocument(snapshot.docs[0].data(), uid);
      if (subscription.renewalReconciliationState !== 'none') {
        await validateSubscriptionCrossDocument({ get: (ref) => firestore.collection(ref.collection).doc(ref.id).get() }, uid, subscription);
      }
      return uid;
    } catch (error) {
      if (error instanceof BillingRepositoryError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new BillingStorageError('read');
    }
  }

  async function acquireOrderLease(input) {
    exactKeys(input, ['uid', 'orderId'], [], 'acquireOrderLease');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      if (order.resolution === 'succeeded') return { acquired: false, reason: 'succeeded', payment: normalizedPaymentFromOrder(order) };
      if (order.resolution === 'failed') return { acquired: false, reason: 'failed', failure: { code: order.failureCode, providerCode: order.providerCode } };
      if (order.kind === 'initial' && !initialCurrent(subscription, order)) throw new BillingStateConflictError('initial_attempt_not_current');
      if (order.kind === 'initial' && (subscription.status !== 'incomplete' || subscription.requiresBillingMethodRegistration || subscription.billingMethodStatus === 'invalid')) throw new BillingStateConflictError('order_not_retryable');
      if (order.kind === 'renewal' && !renewalCurrent(subscription, order)) throw new BillingStateConflictError('action_not_allowed');
      if (order.kind === 'renewal' && subscription.renewalReconciliationState !== 'none') throw new BillingStateConflictError('renewal_reconciliation_pending');
      if (order.leaseToken !== null && new Date(nowIso).getTime() < new Date(order.leaseExpiresAt).getTime()) return { acquired: false, reason: 'held', leaseExpiresAt: order.leaseExpiresAt };
      const bytes = randomBytes(16);
      if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new RangeError('randomBytes must return 16 bytes');
      const leaseToken = `ntx_l_${Buffer.from(bytes).toString('hex')}`;
      const expiresAt = leaseExpiry(nowIso, leaseMs);
      transaction.update(orderRef(input.orderId), { leaseToken, leaseAcquiredAt: nowIso, leaseExpiresAt: expiresAt, updatedAt: nowIso });
      const updatedOrder = { ...order, leaseToken, leaseAcquiredAt: nowIso, leaseExpiresAt: expiresAt, updatedAt: nowIso };
      return { acquired: true, leaseToken, leaseExpiresAt: expiresAt, subscription, order: updatedOrder };
    });
  }

  async function storeBillingMethod(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'customerKey', 'envelope'], [], 'storeBillingMethod');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    validateCustomerKey(input.customerKey);
    validateEnvelope(input.envelope);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (order.kind !== 'initial' || !initialCurrent(subscription, order) || subscription.status !== 'incomplete' || subscription.customerKey !== input.customerKey || subscription.requiresBillingMethodRegistration) throw new BillingStateConflictError('billing_method_not_ready');
      if (subscription.billingMethodStatus === 'ready') {
        if (!sameEnvelope(subscription.billingKeyCiphertext, input.envelope)) throw new BillingRepositoryInvariantError('billingKeyCiphertext');
        return subscription;
      }
      if (subscription.billingMethodStatus !== 'absent') throw new BillingStateConflictError('registration_required');
      const updated = { ...subscription, billingMethodStatus: 'ready', billingKeyCiphertext: repositoryClone(input.envelope), billingKeyFingerprint: input.envelope.fingerprint, billingMethodInvalidatedAt: null, updatedAt: nowIso };
      transaction.update(subscriptionRef(input.uid), { billingMethodStatus: 'ready', billingKeyCiphertext: repositoryClone(input.envelope), billingKeyFingerprint: input.envelope.fingerprint, billingMethodInvalidatedAt: null, updatedAt: nowIso });
      return updated;
    });
  }

  async function markOrderProviderRequestStarted(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken'], [], 'markOrderProviderRequestStarted');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (order.resolution === 'succeeded' || order.resolution === 'failed') throw new BillingStateConflictError('order_terminal');
      if (order.providerRequestStartedAt !== null) return order;
      if (order.kind === 'initial') {
        if (!initialCurrent(subscription, order) || subscription.status !== 'incomplete' || subscription.requiresBillingMethodRegistration || subscription.billingMethodStatus !== 'ready') throw new BillingStateConflictError('action_not_allowed');
        transaction.update(orderRef(input.orderId), { resolution: 'unknown', providerRequestStartedAt: nowIso, updatedAt: nowIso });
        return { ...order, resolution: 'unknown', providerRequestStartedAt: nowIso, updatedAt: nowIso };
      }
      if (!renewalCurrent(subscription, order) || subscription.renewalReconciliationState !== 'none'
        || subscription.billingWorkDueAt !== subscription.nextAttemptAt || subscription.billingWorkDueAt === null
        || new Date(subscription.billingWorkDueAt).getTime() > new Date(nowIso).getTime()
        || subscription.cancelAtPeriodEnd || subscription.billingMethodStatus !== 'ready'
        || subscription.requiresBillingMethodRegistration) throw new BillingStateConflictError('action_not_allowed');
      transaction.update(orderRef(input.orderId), { resolution: 'unknown', providerRequestStartedAt: nowIso, updatedAt: nowIso });
      transaction.update(subscriptionRef(input.uid), { renewalReconciliationState: 'unknown', billingWorkDueAt: nowIso, updatedAt: nowIso });
      return { ...order, resolution: 'unknown', providerRequestStartedAt: nowIso, updatedAt: nowIso };
    });
  }

  async function acquireRenewalReconciliationLease(input) {
    exactKeys(input, ['uid', 'orderId', 'source'], [], 'acquireRenewalReconciliationLease');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    if (typeof input.source !== 'string') throw new TypeError('source must be a string');
    if (!['cron', 'webhook', 'manual_repair'].includes(input.source)) throw new RangeError('source is invalid');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      if (order.resolution === 'succeeded') return { acquired: false, reason: 'succeeded', payment: normalizedPaymentFromOrder(order) };
      if (order.resolution === 'failed') return { acquired: false, reason: 'failed', failure: { code: order.failureCode, providerCode: order.providerCode } };
      if (order.kind !== 'renewal' || order.resolution !== 'unknown' || order.providerRequestStartedAt === null || !renewalCurrent(subscription, order)) throw new BillingStateConflictError('reconciliation_not_allowed');
      if (input.source === 'cron' && (subscription.renewalReconciliationState !== 'unknown' || subscription.billingWorkDueAt === null || subscription.billingWorkDueAt > nowIso)) throw new BillingStateConflictError('reconciliation_not_allowed');
      if (input.source !== 'cron' && subscription.renewalReconciliationState === 'unknown' && (subscription.billingWorkDueAt === null || subscription.billingWorkDueAt > nowIso)) throw new BillingStateConflictError('reconciliation_not_allowed');
      if (input.source !== 'cron' && subscription.renewalReconciliationState === 'manual' && subscription.billingWorkDueAt !== null) throw new BillingRepositoryInvariantError('billingWorkDueAt');
      if (input.source !== 'cron' && subscription.renewalReconciliationState !== 'unknown' && subscription.renewalReconciliationState !== 'manual') throw new BillingStateConflictError('reconciliation_not_allowed');
      if (order.leaseToken !== null && new Date(nowIso).getTime() < new Date(order.leaseExpiresAt).getTime()) return { acquired: false, reason: 'held', leaseExpiresAt: order.leaseExpiresAt };
      const bytes = randomBytes(16);
      if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new RangeError('randomBytes must return 16 bytes');
      const leaseToken = `ntx_l_${Buffer.from(bytes).toString('hex')}`;
      const expiresAt = leaseExpiry(nowIso, leaseMs);
      transaction.update(orderRef(input.orderId), { leaseToken, leaseAcquiredAt: nowIso, leaseExpiresAt: expiresAt, updatedAt: nowIso });
      return { acquired: true, leaseToken, leaseExpiresAt: expiresAt, subscription, order: { ...order, leaseToken, leaseAcquiredAt: nowIso, leaseExpiresAt: expiresAt, updatedAt: nowIso } };
    });
  }

  async function claimOrderReconciliationSlot(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'slotAt'], [], 'claimOrderReconciliationSlot');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    repositoryIso(input.slotAt, 'slotAt');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (order.kind !== 'renewal' || order.resolution !== 'unknown' || order.providerRequestStartedAt === null || subscription.renewalReconciliationState !== 'unknown') throw new BillingStateConflictError('reconciliation_not_allowed');
      const boundaries = reconciliationBoundaries(order.providerRequestStartedAt);
      const slotIndex = boundaries.indexOf(input.slotAt);
      if (slotIndex < 0 || slotIndex === boundaries.length - 1 || new Date(input.slotAt).getTime() > new Date(nowIso).getTime()) throw new BillingStateConflictError('reconciliation_slot_invalid');
      if (order.providerLastLookupAt !== null && new Date(input.slotAt).getTime() <= new Date(order.providerLastLookupAt).getTime()) return { claimed: false, subscription, order };
      const cutoff = new Date(boundaries.at(-1)).getTime();
      if (new Date(nowIso).getTime() >= cutoff) throw new BillingStateConflictError('reconciliation_slot_invalid');
      const latestDueIndex = boundaries.reduce((latest, boundary, index) => {
        if (index < boundaries.length - 1 && new Date(boundary).getTime() <= new Date(nowIso).getTime()) return index;
        return latest;
      }, -1);
      if (latestDueIndex < 0 || slotIndex !== latestDueIndex) throw new BillingStateConflictError('reconciliation_slot_invalid');
      const expected = nextReconciliationBoundary(order);
      if (subscription.billingWorkDueAt !== expected) throw new BillingStateConflictError('reconciliation_slot_invalid');
      const next = boundaries[slotIndex + 1];
      const patch = { providerLastLookupAt: input.slotAt, updatedAt: nowIso };
      transaction.update(orderRef(input.orderId), patch);
      transaction.update(subscriptionRef(input.uid), { billingWorkDueAt: next, updatedAt: nowIso });
      return { claimed: true, subscription: { ...subscription, billingWorkDueAt: next, updatedAt: nowIso }, order: { ...order, ...patch } };
    });
  }

  async function markRenewalManualReconciliation(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken'], [], 'markRenewalManualReconciliation');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (order.kind !== 'renewal' || order.resolution !== 'unknown' || order.providerRequestStartedAt === null || subscription.renewalReconciliationState !== 'unknown') throw new BillingStateConflictError('reconciliation_not_allowed');
      const cutoff = new Date(order.providerRequestStartedAt).getTime() + RENEWAL_UNKNOWN_CUTOFF_MS;
      if (new Date(nowIso).getTime() < cutoff) throw new BillingStateConflictError('reconciliation_cutoff_not_reached');
      if (subscription.billingWorkDueAt !== new Date(cutoff).toISOString()) throw new BillingRepositoryInvariantError('billingWorkDueAt');
      const patch = { renewalReconciliationState: 'manual', billingWorkDueAt: null, updatedAt: nowIso };
      transaction.update(subscriptionRef(input.uid), patch);
      transaction.update(orderRef(input.orderId), { leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, updatedAt: nowIso });
      return { subscription: { ...subscription, ...patch }, order: { ...order, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, updatedAt: nowIso } };
    });
  }

  async function releaseOrderLease(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'resolution'], [], 'releaseOrderLease');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    if (typeof input.resolution !== 'string') throw new TypeError('resolution must be a string');
    if (!RELEASE_RESOLUTIONS.has(input.resolution)) throw new RangeError('resolution is invalid');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (input.resolution === 'not_sent' && (order.providerRequestStartedAt !== null || order.resolution !== 'ready')) throw new BillingStateConflictError('action_not_allowed');
      const nextResolution = input.resolution === 'not_sent' ? 'ready' : 'unknown';
      transaction.update(orderRef(input.orderId), { resolution: nextResolution, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, updatedAt: nowIso });
      return { ...order, resolution: nextResolution, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, updatedAt: nowIso };
    });
  }

  async function finalizeOrderSuccess(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'payment'], [], 'finalizeOrderSuccess');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    validatePayment(input.payment);
    if (input.payment.orderId !== input.orderId) throw new BillingRepositoryInvariantError('orderId');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      if (order.resolution === 'succeeded') {
        if (!paymentMatchesOrder(order, input.payment)) throw new BillingRepositoryInvariantError('providerPaymentKey');
        return { replayed: true, subscription, order, payment: normalizedPaymentFromOrder(order) };
      }
      if (order.resolution === 'failed') throw new BillingStateConflictError('order_terminal');
      leaseOwner(order, input.leaseToken);
      if (order.providerRequestStartedAt === null) throw new BillingStateConflictError('action_not_allowed');
      if (order.kind === 'initial' && !initialCurrent(subscription, order)) throw new BillingStateConflictError('initial_attempt_not_current');
      if (order.kind === 'renewal' && !renewalCurrent(subscription, order)) throw new BillingStateConflictError('action_not_allowed');
      const outcome = order.kind === 'initial'
        ? { type: 'initial_payment_succeeded' }
        : (subscription.requiresBillingMethodRegistration && subscription.billingMethodStatus === 'invalid'
          ? { type: 'renewal_payment_succeeded_method_invalid', attempt: order.attempt }
          : { type: 'renewal_payment_succeeded', attempt: order.attempt });
      let patch;
      try {
        patch = BILLING_DOMAIN.nextRenewalState(subscription, outcome, new Date(nowIso));
      } catch (error) {
        throw new BillingStateConflictError('subscription_not_due');
      }
      const updatedSubscription = { ...subscription, ...patch, lastSuccessfulOrderId: order.orderId };
      const orderPatch = {
        resolution: 'succeeded', terminalResult: 'succeeded', failureCode: null, providerCode: null,
        leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
        providerPaymentKey: input.payment.paymentKey, providerStatus: 'DONE', providerType: 'BILLING', providerMethod: 'CARD', providerApprovedAt: input.payment.approvedAt,
        updatedAt: nowIso, completedAt: nowIso,
      };
      transaction.update(subscriptionRef(input.uid), { ...patch, lastSuccessfulOrderId: order.orderId });
      transaction.update(orderRef(input.orderId), orderPatch);
      writeProjection(transaction, input.uid, updatedSubscription);
      return { replayed: false, subscription: updatedSubscription, order: { ...order, ...orderPatch }, payment: Object.freeze({ ...input.payment }) };
    });
  }

  function failureOutcome(order, subscription) {
    if (order.kind === 'initial') return { type: 'initial_payment_failed' };
    if (subscription.requiresBillingMethodRegistration && subscription.billingMethodStatus === 'invalid'
      && (subscription.renewalReconciliationState === 'unknown' || subscription.renewalReconciliationState === 'manual')) {
      return { type: 'renewal_payment_failed_method_invalid', attempt: order.attempt };
    }
    return { type: `renewal_payment_failed_day_${order.attempt}` };
  }

  async function finalizeOrderFailure(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'failure'], [], 'finalizeOrderFailure');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    exactKeys(input.failure, ['code', 'providerCode'], [], 'failure');
    if (!['provider_rejected', 'payment_terminal'].includes(input.failure.code)) throw new RangeError('failure code is invalid');
    safeProviderCode(input.failure.providerCode);
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      if (order.resolution === 'failed') {
        if (order.failureCode !== input.failure.code || order.providerCode !== input.failure.providerCode) throw new BillingRepositoryInvariantError('failureCode');
        return { replayed: true, subscription, order };
      }
      if (order.resolution === 'succeeded') throw new BillingStateConflictError('order_terminal');
      leaseOwner(order, input.leaseToken);
      if (order.providerRequestStartedAt === null) throw new BillingStateConflictError('action_not_allowed');
      if (order.kind === 'initial' && !initialCurrent(subscription, order)) throw new BillingStateConflictError('initial_attempt_not_current');
      if (order.kind === 'renewal' && !renewalCurrent(subscription, order)) throw new BillingStateConflictError('action_not_allowed');
      let patch;
      try {
        patch = BILLING_DOMAIN.nextRenewalState(subscription, failureOutcome(order, subscription), new Date(nowIso));
      } catch (error) {
        throw new BillingStateConflictError('subscription_not_due');
      }
      const isFinalRenewal = order.kind === 'renewal' && order.attempt === 3
        && !(subscription.requiresBillingMethodRegistration && subscription.billingMethodStatus === 'invalid');
      const methodPatch = isFinalRenewal ? {
        billingMethodStatus: 'invalid', billingKeyCiphertext: null, billingKeyFingerprint: null,
        billingMethodInvalidatedAt: nowIso, requiresBillingMethodRegistration: true,
      } : {};
      const updatedSubscription = { ...subscription, ...patch, ...methodPatch };
      const orderPatch = {
        resolution: 'failed', terminalResult: 'failed', failureCode: input.failure.code, providerCode: input.failure.providerCode,
        leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null,
        providerPaymentKey: null, providerStatus: null, providerType: null, providerMethod: null, providerApprovedAt: null,
        updatedAt: nowIso, completedAt: nowIso,
      };
      transaction.update(subscriptionRef(input.uid), { ...patch, ...methodPatch });
      transaction.update(orderRef(input.orderId), orderPatch);
      writeProjection(transaction, input.uid, updatedSubscription);
      return { replayed: false, subscription: updatedSubscription, order: { ...order, ...orderPatch } };
    });
  }

  async function abandonInitialRegistration(input) {
    exactKeys(input, ['uid', 'orderId', 'leaseToken', 'reason'], [], 'abandonInitialRegistration');
    repositoryUid(input.uid);
    validateOrderId(input.orderId);
    validateLeaseToken(input.leaseToken);
    if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 100 || /[\u0000\r\n]/u.test(input.reason)) throw new RangeError('reason is invalid');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      const order = await readOrderTx(transaction, input.orderId);
      checkOrderIdentity(order, input.uid, input.orderId);
      leaseOwner(order, input.leaseToken);
      if (order.kind !== 'initial' || !initialCurrent(subscription, order) || subscription.status !== 'incomplete') throw new BillingStateConflictError('action_not_allowed');
      const updatedSubscription = { ...subscription, billingMethodStatus: 'invalid', billingKeyCiphertext: null, billingKeyFingerprint: null, billingMethodInvalidatedAt: nowIso, requiresBillingMethodRegistration: true, updatedAt: nowIso };
      const orderPatch = { resolution: 'failed', terminalResult: 'failed', failureCode: 'authorization_failed', providerCode: null, leaseToken: null, leaseAcquiredAt: null, leaseExpiresAt: null, providerPaymentKey: null, providerStatus: null, providerType: null, providerMethod: null, providerApprovedAt: null, updatedAt: nowIso, completedAt: nowIso };
      transaction.update(subscriptionRef(input.uid), { billingMethodStatus: 'invalid', billingKeyCiphertext: null, billingKeyFingerprint: null, billingMethodInvalidatedAt: nowIso, requiresBillingMethodRegistration: true, updatedAt: nowIso });
      transaction.update(orderRef(input.orderId), orderPatch);
      writeProjection(transaction, input.uid, updatedSubscription);
      return { replayed: false, subscription: updatedSubscription, order: { ...order, ...orderPatch } };
    });
  }

  async function transitionSubscription(input) {
    exactKeys(input, ['uid', 'outcome'], [], 'transitionSubscription');
    repositoryUid(input.uid);
    exactKeys(input.outcome, ['type'], [], 'outcome');
    if (!['cancel_requested', 'resume_requested', 'period_expired'].includes(input.outcome.type)) throw new BillingStateConflictError('action_not_allowed');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      let patch;
      try {
        patch = BILLING_DOMAIN.nextRenewalState(subscription, input.outcome, new Date(nowIso));
      } catch (error) {
        throw new BillingStateConflictError('action_not_allowed');
      }
      if (Object.keys(patch).length === 0) return subscription;
      const terminal = patch.status === 'canceled' || patch.status === 'expired';
      const cleanup = terminal ? { billingMethodStatus: 'invalid', billingKeyCiphertext: null, billingKeyFingerprint: null, billingMethodInvalidatedAt: subscription.billingMethodInvalidatedAt || nowIso, requiresBillingMethodRegistration: true } : {};
      const updated = { ...subscription, ...patch, ...cleanup };
      transaction.update(subscriptionRef(input.uid), { ...patch, ...cleanup });
      writeProjection(transaction, input.uid, updated);
      return updated;
    });
  }

  async function invalidateBillingMethod(input) {
    exactKeys(input, ['uid', 'reason', 'expectedFingerprint'], [], 'invalidateBillingMethod');
    repositoryUid(input.uid);
    if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 100 || /[\u0000\r\n]/u.test(input.reason)) throw new RangeError('reason is invalid');
    if (input.expectedFingerprint !== null && (typeof input.expectedFingerprint !== 'string' || !FINGERPRINT_RE.test(input.expectedFingerprint))) throw new RangeError('expectedFingerprint is invalid');
    const nowIso = captureNow(now);
    return runTransaction(async (transaction) => {
      const subscription = await readSubscriptionTx(transaction, input.uid);
      if (input.expectedFingerprint !== null && subscription.billingKeyFingerprint !== input.expectedFingerprint) throw new BillingRepositoryInvariantError('billingKeyFingerprint');
      if (input.expectedFingerprint === null && (subscription.billingKeyFingerprint !== null || subscription.status !== 'incomplete' || subscription.billingMethodStatus !== 'absent')) throw new BillingRepositoryInvariantError('billingKeyFingerprint');
      const alreadyInvalid = subscription.billingMethodStatus === 'invalid' && subscription.billingKeyCiphertext === null && subscription.billingKeyFingerprint === null;
      if (alreadyInvalid && subscription.status !== 'active' && subscription.status !== 'past_due') return subscription;
      const updates = { billingMethodStatus: 'invalid', billingKeyCiphertext: null, billingKeyFingerprint: null, billingMethodInvalidatedAt: subscription.billingMethodInvalidatedAt || nowIso, requiresBillingMethodRegistration: true };
      const unresolved = subscription.renewalReconciliationState === 'unknown' || subscription.renewalReconciliationState === 'manual';
      if (unresolved) {
        // A deletion during reconciliation changes only billing material. The
        // unresolved order and scheduler remain authoritative and lookup-only.
      } else if (subscription.status === 'active') {
        if (new Date(nowIso).getTime() >= new Date(subscription.currentPeriodEnd).getTime()) Object.assign(updates, { status: 'canceled', nextAttemptAt: null });
        else Object.assign(updates, { cancelAtPeriodEnd: true, canceledAt: subscription.canceledAt || nowIso });
      } else if (subscription.status === 'past_due') Object.assign(updates, { status: 'canceled', nextAttemptAt: null, canceledAt: subscription.canceledAt || nowIso });
      if (!unresolved) {
        updates.renewalReconciliationState = 'none';
        const resultingStatus = updates.status || subscription.status;
        updates.billingWorkDueAt = resultingStatus === 'active' || resultingStatus === 'past_due' ? (updates.nextAttemptAt || subscription.nextAttemptAt) : null;
      }
      const updated = { ...subscription, ...updates, updatedAt: nowIso };
      transaction.update(subscriptionRef(input.uid), { ...updates, updatedAt: nowIso });
      if (!unresolved) writeProjection(transaction, input.uid, updated);
      return updated;
    });
  }

  return Object.freeze({
    getSubscription,
    getBillingOrder,
    prepareSubscription,
    prepareInitialRetry,
    prepareRenewalOrder,
    listDueSubscriptions,
    findSubscriptionByBillingKeyFingerprint,
    findSubscriptionUidByBillingKeyFingerprint,
    acquireOrderLease,
    acquireRenewalReconciliationLease,
    storeBillingMethod,
    markOrderProviderRequestStarted,
    claimOrderReconciliationSlot,
    markRenewalManualReconciliation,
    releaseOrderLease,
    finalizeOrderSuccess,
    finalizeOrderFailure,
    abandonInitialRegistration,
    transitionSubscription,
    invalidateBillingMethod,
  });
}

module.exports = {
  ...module.exports,
  BILLING_SCHEMA_VERSION,
  BILLING_LEASE_MS,
  MAX_DUE_SUBSCRIPTIONS,
  SUBSCRIPTIONS_COLLECTION,
  BILLING_ORDERS_COLLECTION,
  RENEWAL_RECONCILIATION_STATES,
  RENEWAL_UNKNOWN_RETRY_OFFSETS_MS,
  RENEWAL_UNKNOWN_CUTOFF_MS,
  BillingRepositoryError,
  BillingRecordNotFoundError,
  BillingStateConflictError,
  BillingLeaseLostError,
  BillingRepositoryInvariantError,
  BillingStorageError,
  initialOrderId,
  initialIdempotencyKey,
  createBillingRepository,
};
