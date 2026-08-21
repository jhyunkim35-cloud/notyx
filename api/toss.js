const { getAdmin } = require('./_firebase-admin');
const { grantEntitlement, sttPriceForUnits } = require('./_grant');

function isAllowedSttAmount(amount) {
  for (let units = 1; units <= 200; units += 1) {
    if (sttPriceForUnits(units) === amount) return true;
  }
  return false;
}

function isAllowedOneTimeProduct(amount, kind) {
  if (!Number.isSafeInteger(amount)) return false;
  if (amount === 500) return kind === undefined || kind === 'single';
  return kind === 'sttEntitlement' && isAllowedSttAmount(amount);
}

module.exports = async function handler(req, res) {
  // CORS — both legacy and post-rebrand origins until DNS swap is complete
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://lazyuniv-ai.vercel.app',
    'https://notyx.vercel.app',
    'https://notyx.co.kr',
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ─── Auth: verify Firebase ID token; the uid comes from the *token*,
  //          NEVER the request body. Without this, any client could pass
  //          someone else's uid and cause STT entitlements / plan upgrades
  //          to be written to that user's record. ──────────────────────
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ success: false, message: 'auth_required' });
  let uid;
  try {
    const adminSdk = getAdmin();
    const decoded = await adminSdk.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ success: false, message: 'invalid_token' });
  }

  const { paymentKey, orderId, amount, kind, minutes } = req.body;
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }
  const requestedAmount = Number(amount);
  if (!isAllowedOneTimeProduct(requestedAmount, kind)) {
    return res.status(400).json({ success: false, message: 'Unsupported one-time payment product' });
  }

  // ─── Idempotency: refuse to re-process the same paymentKey. Without
  //          this, a client retry between Toss confirm and our response
  //          would re-increment singlePurchases or duplicate the
  //          entitlement. Toss itself rejects the same paymentKey twice
  //          after DONE, but we double-guard at our layer. ─────────────
  try {
    const adminSdk = getAdmin();
    const db = adminSdk.firestore();
    const idemRef = db.collection('users').doc(uid).collection('paymentLog').doc(paymentKey);
    const idemSnap = await idemRef.get();
    if (idemSnap.exists) {
      // Already processed — return cached result so retries are no-ops.
      return res.status(200).json({ success: true, idempotent: true, ...idemSnap.data() });
    }
  } catch (e) {
    // Idempotency check failure shouldn't block payment — log and continue.
    console.warn('[toss] idempotency precheck skipped:', e.message);
  }

  const secretKey = process.env.TOSS_SECRET_KEY;
  const encoded = Buffer.from(secretKey + ':').toString('base64');

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: requestedAmount }),
    });

    const data = await response.json();

    if (response.ok && data.status === 'DONE' && data.totalAmount === requestedAmount) {
      const result = await grantEntitlement({
        uid, kind, minutes,
        paymentKey, orderId,
        verifiedAmount: data.totalAmount,
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, message: result.message });
      }
      const extra = result.plan
        ? { plan: result.plan }
        : { minutes: result.minutes, priceKRW: result.priceKRW };
      return res.status(200).json({ success: true, data, ...extra });
    } else {
      return res.status(400).json({ success: false, message: data.message || 'Payment failed' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

module.exports.isAllowedOneTimeProduct = isAllowedOneTimeProduct;
