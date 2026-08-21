'use strict';

const crypto = require('node:crypto');

const PRO_MONTHLY_AMOUNT_KRW = 8900;
const currency = 'KRW';
const BILLING_TIME_ZONE = 'Asia/Seoul';
const FREE_MONTHLY_ANALYSES = 3;
const RENEWAL_ATTEMPT_DAYS = Object.freeze([0, 1, 3]);
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATUSES = new Set(['incomplete', 'active', 'past_due', 'canceled', 'expired']);
const OUTCOME_TYPES = new Set([
  'initial_payment_succeeded',
  'initial_payment_failed',
  'renewal_payment_succeeded',
  'renewal_payment_failed_day_0',
  'renewal_payment_failed_day_1',
  'renewal_payment_failed_day_3',
  'cancel_requested',
  'resume_requested',
  'period_expired',
]);

function isDate(value) {
  return value instanceof Date;
}

function requireDate(value, name) {
  if (!isDate(value)) throw new TypeError(`${name} must be a Date`);
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be valid`);
  return value;
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function requireInteger(value, name, minimum, maximum) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new RangeError(`${name} is out of range`);
  }
  return value;
}

function requireCanonicalIso(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a canonical ISO string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RangeError(`${name} must be canonical ISO`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

function localParts(date) {
  const shifted = new Date(date.getTime() + SEOUL_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function fromLocalParts(parts) {
  const utc = new Date(0);
  utc.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  utc.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return new Date(utc.getTime() - SEOUL_OFFSET_MS);
}

function daysInMonth(year, month) {
  const end = new Date(0);
  end.setUTCFullYear(year, month, 0);
  return end.getUTCDate();
}

function monthPartsFromAnchor(anchor, anchorDay, months) {
  const source = localParts(anchor);
  const monthIndex = source.month - 1 + months;
  const year = source.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return {
    year,
    month,
    day: Math.min(anchorDay, daysInMonth(year, month)),
    hour: source.hour,
    minute: source.minute,
    second: source.second,
    millisecond: source.millisecond,
  };
}

function addAnchoredMonth(date, anchorDay, timeZone) {
  requireDate(date, 'date');
  requireInteger(anchorDay, 'anchorDay', 1, 31);
  if (typeof timeZone !== 'string') throw new TypeError('timeZone must be a string');
  if (timeZone !== BILLING_TIME_ZONE) throw new RangeError('unsupported time zone');
  return fromLocalParts(monthPartsFromAnchor(date, anchorDay, 1));
}

function periodFromAnchor(anchor, cycle) {
  requireDate(anchor, 'anchor');
  requireInteger(cycle, 'cycle', 0);
  const anchorDay = localParts(anchor).day;
  return {
    start: fromLocalParts(monthPartsFromAnchor(anchor, anchorDay, cycle)),
    end: fromLocalParts(monthPartsFromAnchor(anchor, anchorDay, cycle + 1)),
  };
}

function addSeoulDays(date, days) {
  const source = localParts(requireDate(date, 'date'));
  const day = new Date(0);
  day.setUTCFullYear(source.year, source.month - 1, source.day + days);
  day.setUTCHours(source.hour, source.minute, source.second, source.millisecond);
  return new Date(day.getTime() - SEOUL_OFFSET_MS);
}

function validateUid(uid) {
  if (typeof uid !== 'string') throw new TypeError('uid must be a string');
  if (uid.length === 0 || uid.length > 128) throw new RangeError('uid length is invalid');
  return uid;
}

function validateIdentifierInputs(uid, periodStart, attempt) {
  validateUid(uid);
  requireCanonicalIso(periodStart, 'periodStart');
  requireInteger(attempt, 'attempt', 0, 3);
  if (!RENEWAL_ATTEMPT_DAYS.includes(attempt)) throw new RangeError('attempt is not a retry day');
}

function identifier(uid, periodStart, attempt, purpose, prefix, length) {
  validateIdentifierInputs(uid, periodStart, attempt);
  const byteLength = Buffer.byteLength(uid, 'utf8');
  const preimage = `notyx|billing|v1|${purpose}|${byteLength}:${uid}|${periodStart}|d${attempt}`;
  const digest = crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
  return prefix + digest.slice(0, length);
}

function renewalOrderId(uid, periodStart, attempt) {
  return identifier(uid, periodStart, attempt, 'order', 'ntx_r_', 48);
}

function renewalIdempotencyKey(uid, periodStart, attempt) {
  return identifier(uid, periodStart, attempt, 'idempotency', 'ntx_i_', 64);
}

function validateOptionalDate(subscription, field) {
  if (!Object.prototype.hasOwnProperty.call(subscription, field)) return;
  requireCanonicalIso(subscription[field], field, true);
}

function requireOwn(subscription, field) {
  if (!Object.prototype.hasOwnProperty.call(subscription, field)) throw new RangeError(`${field} is required`);
}

function validateSubscription(subscription) {
  requirePlainObject(subscription, 'subscription');
  for (const field of [
    'status',
    'amount',
    'currency',
    'anchorAt',
    'currentCycle',
    'currentPeriodStart',
    'currentPeriodEnd',
    'nextAttemptAt',
    'retryCount',
    'cancelAtPeriodEnd',
    'canceledAt',
    'manualRetryRequired',
    'requiresBillingMethodRegistration',
  ]) requireOwn(subscription, field);
  if (typeof subscription.status !== 'string') throw new TypeError('status must be a string');
  if (!STATUSES.has(subscription.status)) throw new RangeError('invalid subscription status');
  if (typeof subscription.amount !== 'number') throw new TypeError('amount must be a number');
  if (subscription.amount !== PRO_MONTHLY_AMOUNT_KRW) throw new RangeError('invalid subscription amount');
  if (typeof subscription.currency !== 'string') throw new TypeError('currency must be a string');
  if (subscription.currency !== currency) throw new RangeError('invalid subscription currency');
  requireInteger(subscription.currentCycle, 'currentCycle', 0);
  requireInteger(subscription.retryCount, 'retryCount', 0, 3);
  requireBoolean(subscription.cancelAtPeriodEnd, 'cancelAtPeriodEnd');
  requireBoolean(subscription.manualRetryRequired, 'manualRetryRequired');
  requireBoolean(subscription.requiresBillingMethodRegistration, 'requiresBillingMethodRegistration');
  requireCanonicalIso(subscription.anchorAt, 'anchorAt', true);
  requireCanonicalIso(subscription.currentPeriodStart, 'currentPeriodStart', true);
  requireCanonicalIso(subscription.currentPeriodEnd, 'currentPeriodEnd', true);
  requireCanonicalIso(subscription.nextAttemptAt, 'nextAttemptAt', true);
  requireCanonicalIso(subscription.canceledAt, 'canceledAt', true);
  validateOptionalDate(subscription, 'lastPaymentAt');
  validateOptionalDate(subscription, 'lastPaymentFailedAt');
  validateOptionalDate(subscription, 'updatedAt');

  if (subscription.status === 'incomplete') {
    if (subscription.anchorAt !== null || subscription.currentPeriodStart !== null || subscription.currentPeriodEnd !== null || subscription.nextAttemptAt !== null) {
      throw new RangeError('incomplete subscription cannot have a period');
    }
    if (subscription.currentCycle !== 0 || subscription.retryCount !== 0) throw new RangeError('invalid incomplete counters');
    if (subscription.cancelAtPeriodEnd || subscription.canceledAt !== null) throw new RangeError('incomplete subscription cannot be canceled');
    return subscription;
  }

  if (subscription.anchorAt === null || subscription.currentPeriodStart === null || subscription.currentPeriodEnd === null) {
    throw new RangeError('subscription period is incomplete');
  }
  const anchor = new Date(subscription.anchorAt);
  const period = periodFromAnchor(anchor, subscription.currentCycle);
  if (period.start.toISOString() !== subscription.currentPeriodStart || period.end.toISOString() !== subscription.currentPeriodEnd) {
    throw new RangeError('subscription period does not match anchor');
  }
  if (new Date(subscription.currentPeriodEnd).getTime() <= new Date(subscription.currentPeriodStart).getTime()) {
    throw new RangeError('subscription period is empty');
  }

  if (subscription.status === 'active') {
    if (subscription.retryCount !== 0 || subscription.nextAttemptAt !== subscription.currentPeriodEnd) {
      throw new RangeError('invalid active retry state');
    }
    if (subscription.cancelAtPeriodEnd && subscription.canceledAt === null) throw new RangeError('missing cancellation time');
    if (!subscription.cancelAtPeriodEnd && subscription.canceledAt !== null) throw new RangeError('unexpected cancellation time');
  } else if (subscription.status === 'past_due') {
    if (subscription.retryCount !== 1 && subscription.retryCount !== 2) throw new RangeError('invalid past_due retry count');
    const expectedDays = subscription.retryCount === 1 ? 1 : 3;
    const expected = addSeoulDays(new Date(subscription.currentPeriodEnd), expectedDays).toISOString();
    if (subscription.nextAttemptAt !== expected || subscription.cancelAtPeriodEnd || subscription.canceledAt !== null) {
      throw new RangeError('invalid past_due retry state');
    }
  } else if (subscription.status === 'canceled' || subscription.status === 'expired') {
    if (subscription.nextAttemptAt !== null) throw new RangeError('terminal subscription has a next attempt');
  }
  return subscription;
}

function validateOutcome(outcome) {
  requirePlainObject(outcome, 'outcome');
  const keys = Object.keys(outcome).sort();
  if (typeof outcome.type !== 'string') throw new TypeError('outcome.type must be a string');
  if (!OUTCOME_TYPES.has(outcome.type)) throw new RangeError('unknown outcome');
  if (outcome.type === 'renewal_payment_succeeded') {
    if (keys.length !== 2 || keys[0] !== 'attempt' || keys[1] !== 'type') throw new RangeError('invalid renewal success outcome');
    requireInteger(outcome.attempt, 'outcome.attempt', 0, 3);
    if (!RENEWAL_ATTEMPT_DAYS.includes(outcome.attempt)) throw new RangeError('invalid renewal attempt');
  } else if (keys.length !== 1 || keys[0] !== 'type') {
    throw new RangeError('outcome has extra keys');
  }
  return outcome;
}

function nowIso(now) {
  return requireDate(now, 'now').toISOString();
}

function initialSuccessPatch(now) {
  const isoNow = now.toISOString();
  const period = periodFromAnchor(now, 0);
  return {
    status: 'active',
    anchorAt: isoNow,
    currentCycle: 0,
    currentPeriodStart: isoNow,
    currentPeriodEnd: period.end.toISOString(),
    nextAttemptAt: period.end.toISOString(),
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: isoNow,
    lastPaymentFailedAt: null,
    updatedAt: isoNow,
  };
}

function initialFailurePatch(now) {
  const isoNow = now.toISOString();
  return {
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
    lastPaymentFailedAt: isoNow,
    updatedAt: isoNow,
  };
}

function renewalSuccessPatch(subscription, now) {
  const isoNow = now.toISOString();
  const period = periodFromAnchor(new Date(subscription.anchorAt), subscription.currentCycle + 1);
  return {
    status: 'active',
    currentCycle: subscription.currentCycle + 1,
    currentPeriodStart: period.start.toISOString(),
    currentPeriodEnd: period.end.toISOString(),
    nextAttemptAt: period.end.toISOString(),
    retryCount: 0,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    manualRetryRequired: false,
    requiresBillingMethodRegistration: false,
    lastPaymentAt: isoNow,
    lastPaymentFailedAt: null,
    updatedAt: isoNow,
  };
}

function renewalFailurePatch(subscription, day, now) {
  const isoNow = now.toISOString();
  if (day === 3) {
    return {
      status: 'expired',
      retryCount: 3,
      nextAttemptAt: null,
      manualRetryRequired: false,
      requiresBillingMethodRegistration: true,
      lastPaymentFailedAt: isoNow,
      updatedAt: isoNow,
    };
  }
  const retryCount = day === 0 ? 1 : 2;
  const nextAttemptAt = addSeoulDays(new Date(subscription.currentPeriodEnd), day === 0 ? 1 : 3).toISOString();
  return {
    status: 'past_due',
    retryCount,
    nextAttemptAt,
    lastPaymentFailedAt: isoNow,
    updatedAt: isoNow,
  };
}

function nextRenewalState(subscription, outcome, now) {
  const checkedSubscription = validateSubscription(subscription);
  const checkedOutcome = validateOutcome(outcome);
  const isoNow = nowIso(now);
  const checkedNow = new Date(isoNow);
  const periodEnd = checkedSubscription.currentPeriodEnd === null ? null : new Date(checkedSubscription.currentPeriodEnd);

  if (checkedOutcome.type === 'initial_payment_succeeded') {
    if (checkedSubscription.status !== 'incomplete') throw new RangeError('initial success requires incomplete state');
    return initialSuccessPatch(checkedNow);
  }
  if (checkedOutcome.type === 'initial_payment_failed') {
    if (checkedSubscription.status !== 'incomplete') throw new RangeError('initial failure requires incomplete state');
    return initialFailurePatch(checkedNow);
  }
  if (checkedOutcome.type === 'renewal_payment_succeeded') {
    const { attempt } = checkedOutcome;
    const validState = (attempt === 0 && checkedSubscription.status === 'active' && checkedSubscription.retryCount === 0)
      || (attempt === 1 && checkedSubscription.status === 'past_due' && checkedSubscription.retryCount === 1)
      || (attempt === 3 && checkedSubscription.status === 'past_due' && checkedSubscription.retryCount === 2);
    if (!validState || checkedSubscription.cancelAtPeriodEnd) throw new RangeError('invalid renewal success transition');
    const due = attempt === 0 ? periodEnd : new Date(checkedSubscription.nextAttemptAt);
    if (checkedNow.getTime() < due.getTime()) throw new RangeError('renewal attempt is early');
    return renewalSuccessPatch(checkedSubscription, checkedNow);
  }
  if (checkedOutcome.type.startsWith('renewal_payment_failed_day_')) {
    const day = Number(checkedOutcome.type.slice(-1));
    const validState = (day === 0 && checkedSubscription.status === 'active' && checkedSubscription.retryCount === 0)
      || (day === 1 && checkedSubscription.status === 'past_due' && checkedSubscription.retryCount === 1)
      || (day === 3 && checkedSubscription.status === 'past_due' && checkedSubscription.retryCount === 2);
    if (!validState || checkedSubscription.cancelAtPeriodEnd) throw new RangeError('invalid renewal failure transition');
    const due = day === 0 ? periodEnd : new Date(checkedSubscription.nextAttemptAt);
    if (checkedNow.getTime() < due.getTime()) throw new RangeError('renewal attempt is early');
    return renewalFailurePatch(checkedSubscription, day, checkedNow);
  }
  if (checkedOutcome.type === 'cancel_requested') {
    if (checkedSubscription.status === 'canceled' || checkedSubscription.status === 'expired') return {};
    if (checkedSubscription.status === 'active') {
      if (checkedSubscription.cancelAtPeriodEnd && checkedNow.getTime() < periodEnd.getTime()) return {};
      if (checkedNow.getTime() < periodEnd.getTime()) {
        return { cancelAtPeriodEnd: true, canceledAt: isoNow, updatedAt: isoNow };
      }
      return {
        status: 'canceled',
        nextAttemptAt: null,
        cancelAtPeriodEnd: true,
        canceledAt: checkedSubscription.canceledAt || isoNow,
        updatedAt: isoNow,
      };
    }
    if (checkedSubscription.status === 'past_due') {
      return { status: 'canceled', nextAttemptAt: null, canceledAt: isoNow, updatedAt: isoNow };
    }
    throw new RangeError('cannot cancel incomplete subscription');
  }
  if (checkedOutcome.type === 'resume_requested') {
    if (checkedSubscription.status !== 'active') throw new RangeError('resume requires active state');
    if (!checkedSubscription.cancelAtPeriodEnd) return {};
    if (checkedNow.getTime() >= periodEnd.getTime()) throw new RangeError('cannot resume at or after period end');
    return { cancelAtPeriodEnd: false, canceledAt: null, updatedAt: isoNow };
  }
  if (checkedOutcome.type === 'period_expired') {
    if (checkedSubscription.status === 'canceled' || checkedSubscription.status === 'expired') return {};
    if (checkedSubscription.status !== 'active' || !checkedSubscription.cancelAtPeriodEnd || checkedNow.getTime() < periodEnd.getTime()) {
      throw new RangeError('period expiry requires scheduled active state at period end');
    }
    return { status: 'canceled', nextAttemptAt: null, updatedAt: isoNow };
  }
  throw new RangeError('unhandled outcome');
}

function hasProEntitlement(subscription, now) {
  const checkedNow = requireDate(now, 'now');
  if (subscription === null) return false;
  try {
    const checked = validateSubscription(subscription);
    if (checked.status === 'active') {
      const start = new Date(checked.currentPeriodStart).getTime();
      const end = new Date(checked.currentPeriodEnd).getTime();
      return checkedNow.getTime() >= start && checkedNow.getTime() < end;
    }
    if (checked.status === 'past_due') {
      return checked.retryCount === 1 || checked.retryCount === 2;
    }
  } catch (error) {
    return false;
  }
  return false;
}

function sanitizeSubscription(subscription) {
  if (subscription === null) return { status: 'free' };
  if (subscription === undefined) throw new TypeError('subscription is required');
  const checked = validateSubscription(subscription);
  const scheduledAccessEnd = (checked.status === 'active' && checked.cancelAtPeriodEnd)
    || checked.status === 'canceled'
    || checked.status === 'expired';
  return {
    status: checked.status,
    amount: checked.amount,
    currency: checked.currency,
    currentPeriodStart: checked.currentPeriodStart,
    currentPeriodEnd: checked.currentPeriodEnd,
    nextBillingAt: checked.status === 'active' && !checked.cancelAtPeriodEnd ? checked.currentPeriodEnd : null,
    nextRetryAt: checked.status === 'past_due' ? checked.nextAttemptAt : null,
    accessEndsAt: scheduledAccessEnd ? checked.currentPeriodEnd : null,
    cancelAtPeriodEnd: checked.cancelAtPeriodEnd,
    manualRetryRequired: checked.manualRetryRequired,
    requiresBillingMethodRegistration: checked.requiresBillingMethodRegistration,
  };
}

module.exports = {
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
};
