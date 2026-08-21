'use strict';

const { getPublicPaymentConfig, ALLOWED_ORIGINS } = require('./billing');

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function createPaymentConfigHandler({ env = process.env } = {}) {
  if (env === null || typeof env !== 'object') throw new TypeError('env must be an object');
  return async function handler(req, res) {
    setCommonHeaders(res);
    const origin = req.headers && req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !ALLOWED_ORIGINS.includes(origin))) {
      return json(res, 403, { ok: false, error: { code: 'origin_not_allowed', message: '허용되지 않은 요청입니다.' } });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return json(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '지원하지 않는 요청 방식입니다.' } });
    }
    return json(res, 200, getPublicPaymentConfig(env));
  };
}

const productionHandler = createPaymentConfigHandler();
module.exports = productionHandler;
module.exports.createPaymentConfigHandler = createPaymentConfigHandler;
