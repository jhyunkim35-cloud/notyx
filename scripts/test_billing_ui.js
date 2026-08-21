'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const paymentSource = fs.readFileSync(path.join(repo, 'public/js/payment.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(repo, 'public/js/main.js'), 'utf8');
const sttSource = fs.readFileSync(path.join(repo, 'public/stt-pay.html'), 'utf8');
const systemSource = fs.readFileSync(path.join(repo, 'public/css/system.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');

function loadPaymentUi() {
  const context = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(paymentSource, context, { filename: 'public/js/payment.js' });
  return context.window.NotyxBillingUI;
}

function loadPaymentContext(user) {
  const calls = [];
  const context = {
    window: {}, console, setTimeout, clearTimeout, currentUser: user,
    fetch: async () => {
      calls.push(context.currentUser && context.currentUser.uid);
      return { ok: true, async json() { return { subscription: { status: 'active' }, legacy: null }; } };
    },
  };
  vm.runInNewContext(paymentSource, context, { filename: 'public/js/payment.js' });
  return { context, calls, ui: context.window.NotyxBillingUI };
}

function testSourceContract() {
  assert.match(paymentSource, /\/api\/payment-config/);
  assert.match(paymentSource, /\/api\/billing/);
  assert.match(paymentSource, /requestBillingAuth/);
  assert.match(paymentSource, /billingRequest\(['"]prepare['"]/);
  assert.match(paymentSource, /billingRequest\(['"]activate['"]/);
  assert.match(paymentSource, /billingRequest\(['"]status['"]/);
  for (const action of ['cancel', 'resume', 'retry']) assert.match(paymentSource, new RegExp(`performBillingAction\\(['"]${action}['"]`), action);
  assert.doesNotMatch(paymentSource, /(?:test|live)_[ck]k_[A-Za-z0-9]+/);
  assert.doesNotMatch(sttSource, /(?:test|live)_[ck]k_[A-Za-z0-9]+/);
  assert.match(sttSource, /\/api\/payment-config/);
  assert.match(mainSource, /authKey/);
  assert.match(mainSource, /customerKey/);
  assert.match(mainSource, /history\.replaceState/);
  assert.match(mainSource, /clearBillingStatusCache/);
  assert.match(paymentSource, /paymentReview === 'in_progress'/);
  assert.match(paymentSource, /paymentReview === 'manual_review'/);
  assert.match(paymentSource, /className = 'ny-payment-overlay'/);
  assert.match(paymentSource, /class="ny-payment-dialog"/);
  assert.match(paymentSource, /class="ny-payment-option/);
  assert.match(paymentSource, /class="ny-payment-actions"/);
  assert.doesNotMatch(paymentSource, /billingActionButton\([^\n]+style=/);
  assert.doesNotMatch(paymentSource, /div\[style\*=["']position:fixed/);
  for (const className of ['ny-payment-overlay', 'ny-payment-dialog', 'ny-payment-option', 'ny-payment-actions']) {
    assert.match(systemSource, new RegExp(`\\.${className}\\b`), `${className} must have a shared style`);
  }
  assert.match(indexSource, /ny-nav-cta/);
}

function testStatusPresentation() {
  const ui = loadPaymentUi();
  assert.ok(ui, 'payment.js must expose the testable billing UI helpers');

  const cases = [
    ['free', { status: 'free' }, true, ['8,900', '500', '무료 3회']],
    ['single', { status: 'free', singlePurchase: true }, true, ['500']],
    ['active', { status: 'active', nextBillingAt: '2026-09-20T00:00:00.000Z' }, false, ['다음 결제일']],
    ['scheduled cancellation', { status: 'active', cancelAtPeriodEnd: true, accessEndsAt: '2026-09-20T00:00:00.000Z' }, false, ['재개']],
    ['past due', { status: 'past_due', nextRetryAt: '2026-08-22T00:00:00.000Z' }, false, ['다음 재시도', '결제수단']],
    ['renewal review', { status: 'active', paymentReview: 'in_progress' }, false, ['결제 결과 확인']],
    ['manual review', { status: 'active', paymentReview: 'manual_review' }, false, ['수동 확인']],
    ['final failure', { status: 'expired', requiresBillingMethodRegistration: true }, true, ['다시 등록']],
    ['legacy monthly', null, true, ['갱신되지 않는', '8,900']],
  ];

  for (const [name, status, showUpgrade, text] of cases) {
    const presentation = ui.getStatusPresentation(status, name === 'legacy monthly'
      ? { status: 'active_nonrenewing', accessEndsAt: '2026-09-20T00:00:00.000Z', autoRenew: false }
      : null);
    assert.equal(presentation.showUpgrade, showUpgrade, name);
    for (const fragment of text) assert.match(presentation.html, new RegExp(fragment), name);
  }
}

function testUpgradeVisibility() {
  const ui = loadPaymentUi();
  assert.equal(ui.shouldHideUpgradeButtons({ status: 'active' }), true);
  assert.equal(ui.shouldHideUpgradeButtons({ status: 'past_due' }), true);
  assert.equal(ui.shouldHideUpgradeButtons({ status: 'expired' }), false);
  assert.equal(ui.shouldHideUpgradeButtons({ status: 'free' }), false);
}

async function testBillingStatusCacheScope() {
  const firstUser = { uid: 'uid-a', async getIdToken() { return 'token-a'; } };
  const secondUser = { uid: 'uid-b', async getIdToken() { return 'token-b'; } };
  const loaded = loadPaymentContext(firstUser);
  await loaded.ui.getBillingStatus();
  assert.deepEqual(loaded.calls, ['uid-a']);

  loaded.context.currentUser = secondUser;
  await loaded.ui.getBillingStatus();
  assert.deepEqual(loaded.calls, ['uid-a', 'uid-b']);

  loaded.context.currentUser = null;
  loaded.ui.clearBillingStatusCache();
  loaded.context.currentUser = firstUser;
  await loaded.ui.getBillingStatus();
  assert.deepEqual(loaded.calls, ['uid-a', 'uid-b', 'uid-a']);
}

testSourceContract();
testStatusPresentation();
testUpgradeVisibility();
testBillingStatusCacheScope().then(() => console.log('billing UI tests passed')).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
