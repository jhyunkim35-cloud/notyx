const fetch = globalThis.fetch || require('node-fetch');
const { getAdmin } = require('./_firebase-admin');
const { recordUsage } = require('./_usage');

// Extract token counts from accumulated SSE text.
// message_start carries input/cache counts; message_delta carries output count.
function parseTokensFromSse(sseText) {
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.type === 'message_start' && j.message?.usage) {
        const u = j.message.usage;
        inputTokens  = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        cachedTokens = u.cache_read_input_tokens || 0;
      }
      if (j.type === 'message_delta' && j.usage) {
        outputTokens = j.usage.output_tokens || 0;
      }
    } catch { /* skip malformed events */ }
  }
  return { inputTokens, outputTokens, cachedTokens };
}

// P1-4: distributed rate limit.
//
// The old implementation used `const rateLimit = new Map()` keyed on IP.
// That is broken on Vercel: each concurrent request can land on a fresh
// lambda instance with its own empty Map, so the limit never actually
// bound anyone (a user could open 10 tabs and each got count=1). It also
// over-limited shared NATs — a problem for our user base (university
// students behind one campus IP).
//
// New model: a per-uid Firestore counter, bucketed per wall-clock minute.
// Key on the cryptographically-verified uid so the limit follows the user
// across IPs and cannot be reset by rotating a forged token; fall back to
// IP only for requests with no usable token (rare / abuse).
//
// One flat ceiling for everyone (RATE_LIMIT_PER_MIN). This is purely an
// anti-burst / DoS guard — economic abuse is already bounded by the B1
// monthly note quota, so there is no need for a free/paid split here. A
// tighter free limit would actually break a free user's own note
// pipeline, which legitimately fires 5–15 calls within a minute.
//
// Counter docs live in the top-level `rateLimits` collection with an
// `expireAt` Timestamp; a Firestore TTL policy on that field reaps them
// so the collection never grows unbounded.
// Raised from 60 to 200: a single user's batch run makes ~8-10 calls per
// note (classify + critic loop + patch + quiz), so 6-7 notes used to trip
// the abuse guard on the user themselves. Real quota is gated separately
// via analysisId, so this ceiling only needs to stop genuine abuse bursts.
const RATE_LIMIT_PER_MIN = 200;
const RATE_BUCKET_MS = 60 * 1000;
const RATE_DOC_TTL_MS = 2 * 60 * 1000; // keep the doc ~1 min past its window

async function checkRateLimitDistributed(admin, key) {
  // Returns true if the request is allowed, false if rate-limited.
  // Fail-open on any Firestore error — a transient hiccup must never block
  // legitimate traffic (consistent with the B1 billing fail-open policy).
  try {
    const bucket = Math.floor(Date.now() / RATE_BUCKET_MS);
    const ref = admin.firestore().collection('rateLimits').doc(`${key}_${bucket}`);
    return await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= RATE_LIMIT_PER_MIN) return false;
      tx.set(ref, {
        count: admin.firestore.FieldValue.increment(1),
        expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + RATE_DOC_TTL_MS),
      }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('[rateLimit] fail-open:', e.message);
    return true;
  }
}

const ALLOWED_ORIGINS = [
  'https://lazyuniv-ai.vercel.app',  // legacy (pre-rebrand) — keep until DNS swap
  'https://notyx.vercel.app',        // Vercel project alias
  'https://notyx.co.kr',             // current production (custom domain)
  'http://localhost:3000',           // local dev
];

const DEVELOPER_EMAILS = ['jhyun.kim35@gmail.com'];

// Server-side quota gate. Returns { allowed, reason?, uid?, slot?, email? }
async function checkQuota(idToken) {
  if (!idToken) {
    return { allowed: false, reason: 'missing_token' };
  }
  let admin;
  try {
    admin = getAdmin();
  } catch (e) {
    console.error('[checkQuota] admin init failed:', e.message);
    return { allowed: false, reason: 'admin_init_failed' };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    console.error('[checkQuota] token verify failed:', e.message);
    return { allowed: false, reason: 'invalid_token' };
  }

  const uid = decoded.uid;
  const email = decoded.email || '';

  // Developer bypass — unlimited
  if (DEVELOPER_EMAILS.includes(email)) {
    return { allowed: true, uid, email, slot: 'developer' };
  }

  const ref = admin.firestore().collection('users').doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};

  const now = new Date();
  const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const monthCount = (data.usage && data.usage[monthKey]) || 0;
  const plan = data.plan || 'free';
  const planExpiry = data.planExpiry ? new Date(data.planExpiry) : null;

  // Monthly plan with valid expiry — 무제한 (준현 지시: univ 대비 우위 유지).
  // U16 개정: 차단 캡 없음. usage[monthKey] 카운팅만 유지(원가 모니터링·고래 감지용)
  // — 손해 방지는 원가 절감(U11·U12 캐시)으로 달성.
  if (plan === 'monthly' && planExpiry && planExpiry > now) {
    return { allowed: true, uid, email, slot: 'monthly', monthKey };
  }

  // Free tier — 3 per month
  if (monthCount < 3) {
    return { allowed: true, uid, email, slot: 'free', monthKey };
  }

  // Single-purchase quota
  const singlePurchases = data.singlePurchases || 0;
  if (singlePurchases > 0) {
    return { allowed: true, uid, email, slot: 'single', monthKey };
  }

  return { allowed: false, reason: 'quota_exceeded', uid, email, monthCount };
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.some(o => origin === o)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const xff = req.headers['x-forwarded-for'] || '';
  const ip = xff.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  // ─────────────────────────────────────────────────────────────────
  // P1: authentication gate.
  //
  // Every feature this proxy serves — noteAnalysis, quiz, classify, ask,
  // essayGrade, vision — spends money on a paid upstream API. Until now only
  // noteAnalysis verified the caller: the rest reached Anthropic with no
  // identity at all, so anyone who sent an allowed Origin header could burn
  // our key from curl (ALLOWED_ORIGINS only constrains browsers).
  //
  // The verify happens once, here, and its uid feeds the rate limit, the B1
  // billing block and usage accounting below — three verifies collapse into
  // one. Signature checks are local once Google's certs are cached.
  //
  // Fail-closed on admin init failure: an unauthenticated open door on a
  // paid endpoint is a worse outage than a 503. Init failure is a config
  // problem (missing/unparseable FIREBASE_SERVICE_ACCOUNT), not a transient
  // Firebase hiccup, so failing open here would not buy availability — it
  // would only buy anonymous spend.
  // ─────────────────────────────────────────────────────────────────
  let admin;
  try {
    admin = getAdmin();
  } catch (e) {
    console.error('[auth] admin init failed — refusing request:', e.message);
    res.setHeader('Retry-After', '30');
    return res.status(503).json({ error: { type: 'auth_unavailable', message: '인증 서버에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해주세요.' } });
  }

  let authUid;
  try {
    const decoded = await admin.auth().verifyIdToken(req.body?.idToken);
    authUid = decoded.uid;
  } catch (e) {
    console.warn(`[auth] rejected — feature=${req.body?.feature || 'unknown'} ip=${ip}: ${e.message}`);
    // 403, not 401: api.js maps 401 to "API 키가 유효하지 않습니다", which would
    // tell a user with a merely-expired token to go check their own API key.
    // 403 falls through to err.error.message and shows the real reason.
    return res.status(403).json({ error: { type: 'unauthorized', message: '로그인이 필요합니다. 다시 로그인 후 시도해주세요.' } });
  }

  // P1-4: distributed rate limit, keyed on the verified uid so it follows the
  // user across IPs and cannot be reset by rotating a forged token. The old
  // `ip_<ip>` fallback existed only for tokenless requests, which no longer
  // reach this line.
  const rateAllowed = await checkRateLimitDistributed(admin, `u_${authUid}`);
  if (!rateAllowed) {
    res.setHeader('Retry-After', '30');
    return res.status(429).json({ error: { type: 'rate_limited', message: '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' } });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ─────────────────────────────────────────────────────────────────
  // B1: Quota check & billing — analysisId-based
  //
  // Old model: client sends `isFirstCall: true` on its first request of an
  // analysis. Quota was checked + decremented on that flag. Problem: the
  // client could just send `isFirstCall: false` on every call from the
  // browser console and bypass billing entirely.
  //
  // New model: client generates a UUID per analysis and sends it as
  // `analysisId` on EVERY call of that analysis (auto-injected from a
  // module-level variable in api.js). The server treats the FIRST request
  // for any given analysisId as the billable event, regardless of any
  // client-supplied flag. Subsequent calls with the same id pass through
  // for free because the analysis was already billed.
  //
  // Idempotency: writes are wrapped in a Firestore transaction that
  // creates an `analysisSessions/{analysisId}` doc and increments usage
  // atomically. Two concurrent requests with the same id race on the
  // create — only one wins, the other becomes a no-op replay.
  //
  // Backward compat: requests without analysisId fall back to the legacy
  // isFirstCall path so any old client / non-pipeline call (quiz,
  // classify, vision) keeps working unchanged.
  //
  // The analysisSessions collection is configured with a TTL on
  // `expireAt` in GCP Console → Firestore → TTL policies. We write
  // expireAt = now + 7 days so docs are deleted ~7 days after creation.
  // (Firestore TTL deletes when the timestamp value is older than the
  // current time, so we cannot use createdAt directly — that would
  // trigger immediate deletion.)
  // ─────────────────────────────────────────────────────────────────
  const analysisId = typeof req.body?.analysisId === 'string' ? req.body.analysisId : null;
  const feature = req.body?.feature || 'unknown';
  const isFirstCall = req.body?.isFirstCall === true;

  // billCtx records what the request needs at billOnSuccess time:
  //   { mode: 'analysisId', sessionRef, quota, alreadyBilled }  — new path
  //   { mode: 'legacy', uid, slot, monthKey }                   — old isFirstCall
  //   null                                                       — no billing
  let billCtx = null;

  // Only feature='noteAnalysis' is currently a billable feature. quiz,
  // classify, vision, essayGrade are part of the free tier — keep them
  // out of the quota system entirely so users can drill notes without
  // burning their analysis count.
  const isBillable = feature === 'noteAnalysis';

  // B1 strict mode: noteAnalysis MUST supply analysisId. Reject anything
  // that arrives without it — covers both the isFirstCall:false bypass (no
  // quota check at all) and the isFirstCall:true legacy path.
  if (isBillable && !analysisId) {
    console.warn(`[B1 strict] noteAnalysis rejected — missing analysisId (isFirstCall=${isFirstCall}, ip=${ip})`);
    return res.status(400).json({ error: 'analysisId required for noteAnalysis (strict mode)' });
  }

  if (isBillable && analysisId) {
    // New path: analysisId-driven idempotent billing.
    // Token already verified by the P1 gate above; reuse that uid.
    const uid = authUid;

    // Sanity-check the analysisId shape before using it as a doc id —
    // keep it tight to Firestore-safe characters and a sane length so a
    // hostile client can't pollute the collection with weird ids.
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(analysisId)) {
      return res.status(400).json({ error: { type: 'bad_analysis_id', message: '잘못된 분석 ID 형식.' } });
    }

    const sessionRef = admin.firestore()
      .collection('users').doc(uid)
      .collection('analysisSessions').doc(analysisId);

    let sessionDoc;
    try {
      sessionDoc = await sessionRef.get();
    } catch (e) {
      console.error('[B1] sessionRef.get failed:', e.message);
      // Fail open — don't block usable analyses on a Firestore hiccup.
      // Worst case: this call goes unbilled. Better than 500-erroring the
      // user mid-pipeline.
      sessionDoc = { exists: false, _readFailed: true };
    }

    if (sessionDoc.exists) {
      // Already billed earlier in this analysis — let the request through.
      billCtx = { mode: 'analysisId', alreadyBilled: true };
    } else if (sessionDoc._readFailed) {
      // Couldn't verify state. Don't bill, don't block.
      billCtx = { mode: 'analysisId', alreadyBilled: true, _readFailed: true };
    } else {
      // First call for this analysis — full quota check.
      const quota = await checkQuota(req.body?.idToken);
      if (!quota.allowed) {
        const message = quota.reason === 'quota_exceeded'
          ? '월 무료 한도(3회)를 초과했습니다.'
          : (quota.reason === 'invalid_token' || quota.reason === 'missing_token'
            ? '인증이 필요합니다. 다시 로그인 후 시도해주세요.'
            : '서버 설정 오류입니다. 관리자에게 문의해주세요.');
        return res.status(403).json({ error: { type: quota.reason, message } });
      }
      billCtx = { mode: 'analysisId', alreadyBilled: false, sessionRef, quota, uid };
    }
  } else if (isBillable && isFirstCall) {
    // Legacy path: old client without analysisId. Keep the existing
    // behavior so nothing breaks while clients are mid-roll-out.
    const quota = await checkQuota(req.body?.idToken);
    if (!quota.allowed) {
      const message = quota.reason === 'quota_exceeded'
        ? '월 무료 한도(3회)를 초과했습니다.'
        : (quota.reason === 'invalid_token' || quota.reason === 'missing_token'
          ? '인증이 필요합니다. 다시 로그인 후 시도해주세요.'
          : '서버 설정 오류입니다. 관리자에게 문의해주세요.');
      return res.status(403).json({ error: { type: quota.reason, message } });
    }
    billCtx = { mode: 'legacy', alreadyBilled: false, uid: quota.uid, slot: quota.slot, monthKey: quota.monthKey };
  }

  req._billCtx = billCtx;

  // Always a verified uid now — the P1 gate rejects anything else.
  const uidForUsage = billCtx?.uid || authUid;
  const usageKind = feature === 'noteAnalysis' ? 'note'
    : feature === 'quiz' ? 'quiz'
    : (feature === 'classify' || feature === 'grade') ? 'classify'
    : null;

  // Strip our custom fields before forwarding to Anthropic
  const upstreamBody = { ...req.body };
  delete upstreamBody.idToken;
  delete upstreamBody.isFirstCall;
  delete upstreamBody.feature;
  delete upstreamBody.analysisId;

  // Bill the user for this analysis on success. Idempotent at three levels:
  //   1. The `billed` flag prevents double-bill within a single request even
  //      if called from both stream + non-stream branches.
  //   2. analysisId mode wraps the create+increment in a Firestore transaction
  //      so two concurrent requests with the same analysisId race on the
  //      sessionDoc create — only one wins, the other becomes a no-op.
  //   3. alreadyBilled context flag short-circuits when an earlier call in
  //      the same analysis already paid.
  let billed = false;
  async function billOnSuccess() {
    if (billed) return;
    billed = true;

    const ctx = req._billCtx;
    if (!ctx || ctx.alreadyBilled) return;

    try {
      const admin = getAdmin();

      if (ctx.mode === 'analysisId') {
        // New path: atomic session create + usage decrement.
        const { sessionRef, quota, uid } = ctx;
        if (!sessionRef || !quota || !uid) return;
        // Developer/monthly slots are unlimited — still record the session
        // doc so future calls in the same analysis short-circuit on the
        // alreadyBilled branch (saves a quota check).
        await admin.firestore().runTransaction(async (tx) => {
          const fresh = await tx.get(sessionRef);
          if (fresh.exists) return; // another concurrent request already billed

          // expireAt = now + 7 days. Stored as a client-computed Timestamp
          // (not serverTimestamp) because TTL policies need a concrete
          // future time to compare against, not a sentinel.
          const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
          tx.create(sessionRef, {
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + SEVEN_DAYS_MS),
            feature: 'noteAnalysis',
            slot: quota.slot,
          });

          if (quota.slot === 'developer') return;

          const userRef = admin.firestore().collection('users').doc(uid);
          // U16: monthly counts into the same usage[monthKey] as free — the
          // fair-use cap in checkQuota reads this counter.
          if ((quota.slot === 'free' || quota.slot === 'monthly') && quota.monthKey) {
            tx.set(
              userRef,
              { usage: { [quota.monthKey]: admin.firestore.FieldValue.increment(1) } },
              { merge: true }
            );
          } else if (quota.slot === 'single') {
            tx.set(
              userRef,
              { singlePurchases: admin.firestore.FieldValue.increment(-1) },
              { merge: true }
            );
          }
        });
      } else if (ctx.mode === 'legacy') {
        // Old isFirstCall path — keep working for any client that hasn't
        // been updated to send analysisId yet.
        if (ctx.slot === 'developer') return;
        const ref = admin.firestore().collection('users').doc(ctx.uid);
        if ((ctx.slot === 'free' || ctx.slot === 'monthly') && ctx.monthKey) {
          await ref.set(
            { usage: { [ctx.monthKey]: admin.firestore.FieldValue.increment(1) } },
            { merge: true }
          );
        } else if (ctx.slot === 'single') {
          await ref.set(
            { singlePurchases: admin.firestore.FieldValue.increment(-1) },
            { merge: true }
          );
        }
      }
    } catch (e) {
      // Fail open — don't block the user response on billing error.
      console.error('[bill] failed:', e.message);
    }
  }

  try {
    const isStream = upstreamBody.stream === true;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    let response;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31,advisor-tool-2026-03-01',
        },
        body: JSON.stringify(upstreamBody),
      });

      if (response.status !== 529 || attempt === MAX_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Only bill if upstream returned 2xx — otherwise we're streaming an
      // error envelope and the user got nothing usable.
      const upstreamOk = response.ok;

      let sseAccum = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
          if (upstreamOk) sseAccum += chunk;
        }
        if (upstreamOk) {
          await billOnSuccess();
          if (uidForUsage) {
            try {
              const { inputTokens, outputTokens, cachedTokens } = parseTokensFromSse(sseAccum);
              await recordUsage({ uid: uidForUsage, kind: usageKind, increments: { inputTokens, outputTokens, cachedTokens } });
            } catch (e) {
              console.error('[usage] stream record failed:', e.message);
            }
          }
        }
      } finally {
        res.end();
      }
    } else {
      const data = await response.json();
      if (response.ok) {
        await billOnSuccess();
        if (uidForUsage) {
          try {
            const u = data.usage || {};
            await recordUsage({
              uid: uidForUsage,
              kind: usageKind,
              increments: {
                inputTokens:  (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                outputTokens: u.output_tokens || 0,
                cachedTokens: u.cache_read_input_tokens || 0,
              },
            });
          } catch (e) {
            console.error('[usage] record failed:', e.message);
          }
        }
      }
      res.status(response.status).json(data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
};
