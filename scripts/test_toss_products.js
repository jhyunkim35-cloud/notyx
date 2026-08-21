'use strict';

const assert = require('node:assert/strict');
const { isAllowedOneTimeProduct } = require('../api/toss');
const { planForAmount } = require('../api/_grant');

assert.equal(isAllowedOneTimeProduct(500, 'single'), true);
assert.equal(isAllowedOneTimeProduct(500), true);
assert.equal(isAllowedOneTimeProduct(500, 'monthly'), false);
assert.equal(isAllowedOneTimeProduct(7900, 'single'), false);
assert.equal(isAllowedOneTimeProduct(8900, 'single'), false);
assert.equal(isAllowedOneTimeProduct(7900, 'sttEntitlement'), false);
assert.equal(isAllowedOneTimeProduct(8900, 'sttEntitlement'), false);
assert.equal(isAllowedOneTimeProduct(1500, 'sttEntitlement'), true);
assert.equal(planForAmount(7900), 'monthly');
assert.equal(planForAmount(8900), null);
process.stdout.write('toss product tests: 10 passed\n');
