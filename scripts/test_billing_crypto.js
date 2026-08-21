'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const billing = require('../api/_billing');

const {
  BILLING_ENVELOPE_VERSION,
  BillingConfigurationError,
  BillingCryptoError,
  validateCustomerKey,
  generateCustomerKey,
  fingerprintBillingKey,
  encryptBillingKey,
  decryptBillingKey,
  redactSensitive,
} = billing;

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const alternateEncryptionKey = Buffer.alloc(32, 8).toString('base64');
const billingKey = 'billing_fixture_secret_α';
const authKey = 'auth_fixture_secret';
const customerKey = 'ntx_c_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const secretKey = 'secret_fixture_key';
const bearerToken = 'bearer_fixture_token';
const basicCredential = Buffer.from('basic_fixture:').toString('base64');

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
}

function assertSafeError(fn, ErrorType, code, message) {
  assert.throws(fn, (error) => {
    assert(error instanceof ErrorType);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
    return true;
  });
}

test('encrypts and decrypts a frozen canonical AES-GCM envelope', () => {
  const envelope = encryptBillingKey(billingKey, encryptionKey);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'fingerprint', 'iv', 'tag', 'version']);
  assert.equal(envelope.version, BILLING_ENVELOPE_VERSION);
  assert.match(envelope.iv, /^[A-Za-z0-9+/]{16}$/);
  assert.match(envelope.tag, /^[A-Za-z0-9+/]{22}==$/);
  assert.match(envelope.ciphertext, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(envelope.ciphertext.length, 0);
  assert.match(envelope.fingerprint, /^bkf1_[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(decryptBillingKey(envelope, encryptionKey), billingKey);
  assert.equal(JSON.stringify(envelope).includes(billingKey), false);
});

test('uses a stable fingerprint but fresh IV and ciphertext for each encryption', () => {
  const first = encryptBillingKey(billingKey, encryptionKey);
  const second = encryptBillingKey(billingKey, encryptionKey);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.fingerprint, fingerprintBillingKey('other_billing_key', encryptionKey));
  assert.notEqual(first.fingerprint, fingerprintBillingKey(billingKey, alternateEncryptionKey));
  assert.equal(first.fingerprint.includes('fixture_secret'), false);
});

test('fails closed with one safe crypto error for wrong keys and every envelope tamper', () => {
  const envelope = encryptBillingKey(billingKey, encryptionKey);
  const tampered = [
    { ...envelope, version: 2 },
    { ...envelope, iv: Buffer.alloc(12, 1).toString('base64') },
    { ...envelope, tag: Buffer.alloc(16, 1).toString('base64') },
    { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') },
    { ...envelope, fingerprint: `bkf1_${'A'.repeat(43)}` },
  ];
  for (const candidate of tampered) {
    assertSafeError(() => decryptBillingKey(candidate, encryptionKey), BillingCryptoError, 'BILLING_DECRYPT_FAILED', 'Billing key decryption failed');
  }
  assertSafeError(() => decryptBillingKey(envelope, alternateEncryptionKey), BillingCryptoError, 'BILLING_DECRYPT_FAILED', 'Billing key decryption failed');
});

test('rejects malformed master keys without retaining the fixture value', () => {
  const invalidKeys = [
    encryptionKey.replace(/=$/, ''),
    encryptionKey.replace(/[A-Za-z]/, '-'),
    Buffer.alloc(31, 7).toString('base64'),
    Buffer.alloc(33, 7).toString('base64'),
    ` ${encryptionKey}`,
  ];
  for (const invalid of invalidKeys) {
    assertSafeError(() => fingerprintBillingKey(billingKey, invalid), BillingConfigurationError, 'BILLING_CONFIGURATION_INVALID', 'Billing encryption configuration is invalid');
    assert.equal(JSON.stringify(new BillingConfigurationError()).includes(invalid), false);
  }
});

test('rejects empty, oversized, and control-character billing keys before crypto', () => {
  for (const invalid of ['', 'x'.repeat(201), 'billing\nkey', 'billing\rkey', 'billing\u0000key']) {
    assert.throws(() => encryptBillingKey(invalid, encryptionKey), (error) => error instanceof TypeError || error instanceof RangeError);
  }
});

test('generates and validates exactly 192-bit random customer keys', () => {
  const bytes = Buffer.from(Array.from({ length: 24 }, (_, index) => index));
  let requestedLength = null;
  const generated = generateCustomerKey({
    randomBytes(length) {
      requestedLength = length;
      return bytes;
    },
  });
  assert.equal(requestedLength, 24);
  assert.equal(generated, `ntx_c_${bytes.toString('base64url')}`);
  assert.equal(generated.length, 38);
  assert.match(generated, /^ntx_c_[A-Za-z0-9_-]{32}$/);
  assert.equal(validateCustomerKey(generated), generated);
  assert.throws(() => generateCustomerKey({ randomBytes: () => Buffer.alloc(23) }), RangeError);
  assert.throws(() => generateCustomerKey({ randomBytes: () => Buffer.alloc(25) }), RangeError);
  assert.throws(() => validateCustomerKey('uid@example.com'), RangeError);
  assert.equal(new Set(Array.from({ length: 100 }, () => generateCustomerKey())).size, 100);
});

test('redacts nested sensitive data, credentials, URLs, binaries, errors, accessors, depth, and cycles', () => {
  const envelope = encryptBillingKey(billingKey, encryptionKey);
  const source = {
    Authorization: `Bearer ${bearerToken}`,
    'billing-key': billingKey,
    nested: [{ Auth_Key: authKey, safeOrderId: 'order_123', fingerprint: envelope.fingerprint }],
    url: `https://example.test/callback?authKey=${authKey}&safe=kept&customerKey=${customerKey}`,
    basic: `Basic ${basicCredential}`,
    error: Object.assign(new Error(`provider said Bearer ${bearerToken}`), { code: 'PROVIDER_BAD', secretKey, safe: 'kept' }),
    binary: Buffer.from('binary secret'),
    typed: new Uint8Array([1, 2]),
  };
  let getterRead = false;
  Object.defineProperty(source, 'lazy', {
    enumerable: true,
    get() {
      getterRead = true;
      return secretKey;
    },
  });
  source.self = source;
  let deep = {};
  source.deep = deep;
  for (let index = 0; index < 22; index += 1) {
    deep.next = {};
    deep = deep.next;
  }

  const redacted = redactSensitive(source);
  assert.equal(getterRead, false);
  assert.equal(redacted.Authorization, '[REDACTED]');
  assert.equal(redacted['billing-key'], '[REDACTED]');
  assert.equal(redacted.nested[0].Auth_Key, '[REDACTED]');
  assert.equal(redacted.nested[0].safeOrderId, 'order_123');
  assert.equal(redacted.nested[0].fingerprint, envelope.fingerprint);
  assert.equal(redacted.url.includes(authKey), false);
  assert.equal(redacted.url.includes(customerKey), false);
  assert.equal(redacted.url.includes('safe=kept'), true);
  assert.equal(redacted.basic, 'Basic [REDACTED]');
  assert.deepEqual(redacted.error, { name: 'Error', code: 'PROVIDER_BAD', message: 'provider said Bearer [REDACTED]', secretKey: '[REDACTED]', safe: 'kept' });
  assert.equal(redacted.binary, '[REDACTED_BINARY]');
  assert.equal(redacted.typed, '[REDACTED_BINARY]');
  assert.equal(redacted.lazy, '[Accessor]');
  assert.equal(redacted.self, '[Circular]');
  let truncated = false;
  let deepValue = redacted.deep;
  for (let index = 0; index < 30 && deepValue && typeof deepValue === 'object'; index += 1) {
    if (deepValue.next === '[Truncated]') truncated = true;
    deepValue = deepValue.next;
  }
  assert.equal(truncated, true);
  assert.deepEqual(source.nested[0], { Auth_Key: authKey, safeOrderId: 'order_123', fingerprint: envelope.fingerprint });
});

test('redacts a billing envelope at the root and preserves safe operational identifiers', () => {
  const envelope = encryptBillingKey(billingKey, encryptionKey);
  assert.equal(redactSensitive(envelope), '[REDACTED]');
  const safe = redactSensitive({ orderId: 'ntx_r_abc', paymentKey: 'pay_abc', billingKeyFingerprint: envelope.fingerprint });
  assert.deepEqual(safe, { orderId: 'ntx_r_abc', paymentKey: 'pay_abc', billingKeyFingerprint: envelope.fingerprint });
});

test('keeps safe errors and redacted fixtures free of every credential fixture', () => {
  const safeError = new BillingCryptoError();
  const output = JSON.stringify({ safeError, redacted: redactSensitive({ authKey, billingKey, customerKey, secretKey, encryptionKey, bearerToken, authorization: `Basic ${basicCredential}` }) });
  for (const fixture of [billingKey, authKey, customerKey, secretKey, encryptionKey, bearerToken, basicCredential]) {
    assert.equal(output.includes(fixture), false);
  }
});

process.stdout.write(`${passed} billing crypto tests passed\n`);
