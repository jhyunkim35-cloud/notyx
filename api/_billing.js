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
  if (kind === 'timeout' || kind === 'network' || status === 404 || isRetryableStatus(status)) return 'lookup_again';
  if (status >= 400 && status < 500 && AUTH_CONFIGURATION_CODES.has(providerCode)) return 'configuration';
  return kind === 'invalid_response' ? 'lookup_again' : 'rejected';
}

function tossError(operation, kind, status = null, providerCode = null) {
  return new TossProviderError(operation, kind, status, providerCode, dispositionFor(operation, kind, status, providerCode));
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
