# 회귀 가드 — 랜딩 한정 모션 (2026-08-06)
#
# 결정 기록: 볼트 「결정 기록 2026-08-06 랜딩 한정 모션 도입」.
# 2026-08-01의 「모션 0」을 #landingView 안에서만 부분 번복한 결정이라, 게이트가
# 단일 규칙(파일 전체 animation 0건)에서 경계 규칙(랜딩 밖 0건)으로 바뀐다.
# 그 경계와, 협상 불가로 못박은 항목들을 여기서 기계로 고정한다.
#
# ① prefers-reduced-motion 블록 존재 — 결정 기록이 「문서가 아니라 테스트로」 지정한 유일 항목
# ② 애니메이트되는 속성이 transform/opacity 뿐 (레이아웃 리플로 금지)
# ③ 값은 system.css 토큰이 정본 — JS가 숫자를 직접 들고 있으면 「랜딩만」 경계가 흐려진다
# ④ ScrollTrigger cleanup — ny-logged-out으로 셸이 죽고 사는 구조라 누수가 실재 위험
# ⑤ 빠른 스크롤 시 즉시 최종 상태 (늦게 발화하는 애니메이션 줄줄이 금지)
# ⑥ 하지 않기로 한 것들의 부재 (패럴랙스·스크럽·핀·무한루프)
# ⑦ 빌드 스텝 0 — 배포는 <script src> + ?v= 교체다

MO_HTML=public/index.html
MO_CSS=public/css/system.css
MO_JS=public/js/landing_motion.js

MO_REGION="$(mktemp)"
sed -n '/<div id="landingView"/,/<!-- Main Content -->/p' "$MO_HTML" > "$MO_REGION"

# 추출이 깨지면 아래 구간 검사가 조용히 통과한다 — 먼저 못박는다 (LC-0과 같은 이유).
assert_contains "$MO_REGION" 'id="ny-more"' "MO-0: #landingView 구간 추출 성공"

assert_file "$MO_JS" "MO-0b: landing_motion.js 존재"

# ── ① prefers-reduced-motion (협상 불가) ─────────────────
assert_matches "$MO_CSS" '@media \(prefers-reduced-motion: reduce\)' \
  "MO-1a: system.css에 prefers-reduced-motion 블록 존재"
assert_contains "$MO_JS" 'prefers-reduced-motion: reduce' \
  "MO-1b: JS도 matchMedia로 reduced-motion을 직접 가드 (CSS만 믿지 않는다)"
# 형광펜은 「안 그린 게 아니라 이미 그려져 있다」 — 기본 상태가 최종 상태여야 한다.
# JS가 그리기로 결정할 때만 wash를 심으므로, GSAP CDN이 죽어도 마크는 칠해져 있다.
assert_matches "$MO_CSS" 'mark\.ny-hl' "MO-1c: mark.ny-hl 기본 배경(=이미 그어진 상태) 유지"

# ── ② transform / opacity 만 ─────────────────────────────
# 레이아웃을 리플로시키는 속성이 트윈 var로 들어가면 여기서 빨개진다.
MO_BANNED='(^|[[:space:]{,(])(top|left|right|bottom|width|height|margin[A-Za-z]*|padding[A-Za-z]*|fontSize|lineHeight|backgroundColor|boxShadow|borderRadius|filter|blur)[[:space:]]*:'
mo_n=$(grep -cE "$MO_BANNED" "$MO_JS" 2>/dev/null || true)
if [ "${mo_n:-0}" -eq 0 ]; then
  _pass "MO-2a: landing_motion.js가 애니메이트하는 속성에 레이아웃/페인트 속성 0건"
else
  _fail "MO-2a: landing_motion.js에 금지 속성 ${mo_n}건 (transform/opacity만 허용)"
  grep -nE "$MO_BANNED" "$MO_JS" | sed 's/^/      /'
fi
# 지우기만 해서 통과하는 걸 막는 짝 검사 — 실제로 transform/opacity를 쓰고 있어야 한다.
assert_contains "$MO_JS" 'opacity' "MO-2b: opacity 트윈 존재"
assert_matches  "$MO_JS" 'scaleX'  "MO-2c: 형광펜 획이 scaleX(transform)로 그려짐"

# ── ③ 값의 정본은 system.css 토큰 ────────────────────────
for t in --ny-motion-rise --ny-motion-dur --ny-motion-stagger --ny-motion-ease \
         --ny-motion-hl-dur --ny-motion-hl-delay; do
  assert_contains "$MO_CSS" "$t:" "MO-3: 토큰 $t 정의"
done
assert_contains "$MO_JS" "getPropertyValue" \
  "MO-3b: JS가 토큰을 읽어서 쓴다 (숫자 하드코딩 아님)"

# ── ④ ScrollTrigger cleanup ──────────────────────────────
assert_matches "$MO_JS" '\.kill\(' "MO-4a: ScrollTrigger kill() 경로 존재"
assert_contains "$MO_JS" 'ScrollTrigger.refresh' "MO-4b: refresh() 호출 존재"
# 훅이 실제로 배선돼 있어야 한다 — 함수만 있고 부르는 데가 없으면 누수는 그대로다.
assert_contains public/js/firebase_auth.js 'nyLandingMotion' \
  "MO-4c: 로그인/로그아웃 전환이 모션 start/stop을 실제로 호출"

# ── ⑤ 빠른 스크롤 = 아무 일도 없었던 것처럼 ──────────────
assert_contains "$MO_JS" 'getBoundingClientRect' \
  "MO-5a: 발화 시점에 요소 위치를 재확인 (이미 지나갔으면 애니메이션 없이 최종 상태)"
assert_matches "$MO_JS" 'once: *true' "MO-5b: 한 번만 발화 (되감기 없음)"
assert_matches "$MO_JS" 'function isAbove' \
  "MO-5c: 진입 분류는 「뷰포트 위로 지나갔는가」만 본다 (아래에 있는 요소를 지나간 것으로 세면 진입 모션이 통째로 죽는다 — 2026-08-06 브라우저 실측)"
assert_matches "$MO_JS" 'if \(isAbove\(el\)\)' \
  "MO-5d: start()가 isAbove로 분류 (isPast는 revealBatch의 빠른 스크롤 가드 전용)"

# ── ⑥ 하지 않기로 한 것 ──────────────────────────────────
MO_FORBIDDEN='scrub|pin: *true|repeat: *-1|yoyo: *true|parallax|ScrollSmoother|ScrollToPlugin'
mo_f=$(grep -cE "$MO_FORBIDDEN" "$MO_JS" 2>/dev/null || true)
if [ "${mo_f:-0}" -eq 0 ]; then
  _pass "MO-6a: 패럴랙스·스크럽·핀·무한루프 0건"
else
  _fail "MO-6a: 금지 모션 패턴 ${mo_f}건"
  grep -nE "$MO_FORBIDDEN" "$MO_JS" | sed 's/^/      /'
fi
# 경계 — 랜딩 밖은 여전히 모션 0. @keyframes는 GSAP이 대신하므로 system.css에 필요 없다.
mo_kf=$(grep -c '@keyframes' "$MO_CSS" 2>/dev/null || true)
if [ "${mo_kf:-0}" -eq 0 ]; then
  _pass "MO-6b: system.css @keyframes 0건 (모션은 랜딩 JS가 소유)"
else
  _fail "MO-6b: system.css에 @keyframes ${mo_kf}건 — 랜딩 경계 밖으로 샐 위험"
fi

# ── ⑦ 빌드 스텝 0 ────────────────────────────────────────
assert_matches "$MO_HTML" '<script[^>]+gsap[^>]+\.js' "MO-7a: GSAP을 CDN <script src>로 로드"
assert_matches "$MO_HTML" 'ScrollTrigger[^>]*\.js'    "MO-7b: ScrollTrigger 플러그인 로드"
assert_matches "$MO_HTML" 'landing_motion\.js\?v='    "MO-7c: landing_motion.js가 캐시버스트와 함께 참조됨"
# 이 레포는 번들러가 없다. import/require가 한 줄이라도 들어오면 배포가 조용히 깨진다
# (ES 모듈 아님 — <script src> 로드 순서가 계약이다).
assert_matches "$MO_HTML" 'src="https://[^"]*gsap' "MO-7d: GSAP은 CDN 절대 URL (로컬 번들 아님)"
mo_mod=$(grep -cE '^[[:space:]]*(import|export|const .* = require)\b' "$MO_JS" 2>/dev/null || true)
if [ "${mo_mod:-0}" -eq 0 ]; then
  _pass "MO-7e: landing_motion.js에 import/require 0건 (빌드 스텝 만들지 않음)"
else
  _fail "MO-7e: landing_motion.js에 모듈 구문 ${mo_mod}건 — 이 레포는 번들러가 없다"
fi

rm -f "$MO_REGION"
