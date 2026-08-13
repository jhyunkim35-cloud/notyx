# 회귀 가드 — /api/claude 인증 게이트 (2026-08-08, P1)
#
# 이전 상태: `isBillable = feature === 'noteAnalysis'` 하나만 토큰을 검증했고
# quiz·classify·ask·essayGrade·vision 은 **신원 없이** Anthropic 에 도달했다.
# 레이트리밋은 verifyIdToken 을 시도하되 실패하면 `ip_<ip>` 키로 계속 진행했고,
# admin 초기화가 실패하면 레이트리밋 자체를 건너뛰었다(의도된 fail-open).
# `ALLOWED_ORIGINS` 는 브라우저만 제약하므로 Origin 헤더를 붙인 curl 은 무제한이었다.
#
# 이 스펙이 지키는 것:
#   ① 모든 요청이 **검증된** idToken 을 요구한다 (feature 분기 없는 단일 게이트)
#   ② 토큰 없음/무효 → 403, admin 장애 → 503 (fail-closed — 준현 승인)
#      403인 이유: api.js:85·188 이 401 을 「API 키가 유효하지 않습니다」로 오역해서,
#      토큰이 만료됐을 뿐인 로그인 사용자가 자기 API 키를 의심하게 된다.
#   ③ 미검증 신원 잔재 0 — `ip_` 폴백·`quickDecodeUid`·레이트리밋 스킵 전부 제거
#   ④ 클라이언트 6개 feature 호출부가 여전히 idToken 을 실어 보낸다
#
# ⓪ 을 먼저 두는 이유: `assert_absent`/`assert_repo_absent` 는 대상 파일이 비거나
# 사라지면 **공짜로 통과**한다. 8/6·8/8 에 세 번 걸린 함정이라 absent 검사보다
# 앞에 「파일이 살아 있고 그 파일이 맞다」를 못박는다.

AUTH_API=api/claude.js

# ── ⓪ 대상 생존 못박기 (absent 단언의 짝) ───────────────────
assert_file     "$AUTH_API" "AUTH-0a: api/claude.js 존재"
assert_contains "$AUTH_API" 'module.exports = async (req, res) =>' "AUTH-0b: 핸들러 엔트리 생존"
assert_contains "$AUTH_API" 'ALLOWED_ORIGINS'                      "AUTH-0c: 대상 파일이 Claude 프록시가 맞음"
assert_contains "$AUTH_API" "https://api.anthropic.com/v1/messages" "AUTH-0d: 업스트림 호출부 생존"

# ── ① 단일 인증 게이트 ──────────────────────────────────────
# feature 별 예외 없이 핸들러 진입부에서 한 번 검증하고, 그 uid 를
# 레이트리밋·사용량 집계가 재사용한다(검증 3회 → 1회).
assert_contains "$AUTH_API" 'P1: authentication gate' "AUTH-1a: 인증 게이트 마커 주석 존재"
assert_contains "$AUTH_API" 'let authUid'             "AUTH-1b: 검증된 uid 를 담는 단일 변수"
assert_contains "$AUTH_API" 'authUid = decoded.uid'   "AUTH-1c: uid 가 verifyIdToken 결과에서만 나옴"

# ── ② 거부 응답 ─────────────────────────────────────────────
assert_contains "$AUTH_API" "res.status(403)"          "AUTH-2a: 토큰 없음/무효 → 403 (401은 api.js가 「API 키」 오류로 오역한다)"
assert_absent "$AUTH_API" 'res.status(401)'            "AUTH-2a2: 401 잔재 없음 (api.js:85·188이 401을 API 키 오류로 오역)"
assert_contains "$AUTH_API" "type: 'unauthorized'"     "AUTH-2b: 거부 에러 타입 명시"
assert_contains "$AUTH_API" '[auth] rejected'          "AUTH-2c: 거부 로그 마커 (남용 관측용)"
assert_contains "$AUTH_API" "res.status(503)"          "AUTH-2d: admin 초기화 실패 → 503 (fail-closed)"
assert_contains "$AUTH_API" "type: 'auth_unavailable'" "AUTH-2e: 503 에러 타입 명시"
assert_contains "$AUTH_API" '[auth] admin init failed' "AUTH-2f: admin 장애 로그 마커"

# ── ③ 미검증 신원 잔재 0 ────────────────────────────────────
# 셋 다 「토큰이 없어도 요청이 계속 나아가는」 경로였다.
assert_absent      "$AUTH_API" 'ip_${ip}'                              "AUTH-3a: 레이트리밋 IP 폴백 제거 (미검증 신원)"
assert_absent      "$AUTH_API" '[rateLimit] skipped (admin init failed)' "AUTH-3b: admin 장애 시 레이트리밋 스킵 제거"
assert_contains    "$AUTH_API" 'u_${authUid}'                          "AUTH-3c: 레이트리밋 키가 검증된 uid 뿐"
assert_repo_absent 'quickDecodeUid' "AUTH-3d: 미검증 JWT 디코더 전면 제거 (검증된 uid 로 대체)"

# ── ④ 클라이언트 6개 feature 호출부 회귀 가드 ───────────────
# 게이트가 서 있어도 클라이언트가 토큰을 안 실으면 로그인 사용자가 403 을 맞는다.
assert_contains public/js/api.js           'idToken = await firebase.auth().currentUser?.getIdToken()' "AUTH-4a: noteAnalysis(non-stream) 토큰 첨부"
assert_contains public/js/api.js           "feature: meta.feature || 'unknown'"                        "AUTH-4b: noteAnalysis feature 전달"
assert_contains public/js/quiz.js          "feature: 'quiz'"                                           "AUTH-4c: quiz 호출부 생존"
assert_contains public/js/quiz.js          "feature: 'essayGrade'"                                     "AUTH-4d: essayGrade 호출부 생존"
assert_contains public/js/quiz.js          "feature: 'classify'"                                       "AUTH-4e: classify 호출부 생존"
assert_contains public/js/viewers.js       "feature: 'ask'"                                            "AUTH-4f: ask 호출부 생존"
assert_contains public/js/image_gallery.js "feature: 'vision'"                                         "AUTH-4g: vision(이미지) 호출부 생존"
assert_contains public/js/pptx_parser.js   "feature: 'vision'"                                         "AUTH-4h: vision(슬라이드 전사) 호출부 생존"
