# 회귀 가드 — U17 지시어 해석(deixis-resolution) (2026-07-12)
# 녹취록의 "이거"/"저 식"/"여기" 같은 지시어를 PPT 대조로 해석해 노트 작성 전
# 주석으로 붙이는 기능. agent1의 캐시 프리픽스를 그대로 재사용하는 별도
# Sonnet 호출(agent1_writeNotes 이전 단계) + 미리보기 칩 렌더 + 고신뢰(high)만
# 채택하는 임계치 정책 + 저장 텍스트 원문 불변(주석은 옆에 별도 필드로 저장).
# 순수 헬퍼 단위테스트(6개 함수, 파싱/검증 엣지케이스)는 node scripts/test_deixis.js.
#
# 이 스펙은 acceptance.sh(전체 실행 시 _assert.sh 사전 소싱)와 단독 실행
# (bash scripts/acceptance/u17_deixis.spec.sh) 둘 다를 지원한다.

if ! declare -f _pass >/dev/null 2>&1; then
  _u17_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$_u17_dir/../.." || exit 2
  . scripts/acceptance/_assert.sh
fi

# ── 1) 순수 헬퍼 단위테스트 (파싱/검증 엣지케이스) ──────────
_u17_test_out=$(node scripts/test_deixis.js 2>&1)
if [ $? -eq 0 ]; then
  _pass "U17-1: node scripts/test_deixis.js 전체 통과"
else
  _fail "U17-1: node scripts/test_deixis.js 실패 ($(printf '%s' "$_u17_test_out" | tail -3 | tr '\n' ' '))"
fi

# ── 2) deixis.js — Task 1 순수 헬퍼 6종 전부 정의 ───────────
assert_contains public/js/deixis.js "function detectDeixisCandidates("      "U17-2a: 지시어 후보 감지 게이트 함수 존재"
assert_contains public/js/deixis.js "function buildDeixisUserPrompt("       "U17-2b: 해석 요청 프롬프트 빌더 존재"
assert_contains public/js/deixis.js "function parseDeixisAnnotations("     "U17-2c: 모델 응답 파싱+검증 함수 존재"
assert_contains public/js/deixis.js "function buildDeixisSection("        "U17-2d: 노트작성 프롬프트용 주석 섹션 빌더 존재"
assert_contains public/js/deixis.js "function assignAnnotationsToRecordText(" "U17-2e: 레코드별 주석 재귀속 함수 존재"
assert_contains public/js/deixis.js "function injectDeixisChips("         "U17-2f: 미리보기 HTML 칩 주입 함수 존재"

# ── 3) pipeline.js — agent1 캐시 프리픽스 단일 출처 + 재사용 ─
assert_contains public/js/pipeline.js "function buildAgent1CachePrefix(pptText, recText)" "U17-3a: agent1 캐시 프리픽스 단일 출처 함수 존재"
assert_contains public/js/pipeline.js "let cachePrefix = buildAgent1CachePrefix(pptText, recText);" "U17-3b: agent1_writeNotes가 단일 출처 함수로 프리픽스 생성"

# ── 4) 해석 호출: agent1 프리픽스 재사용 + MINIMAL_SYSTEM + claude-sonnet-4-6 (캐시 공유 계약) ─
assert_contains public/js/pipeline.js "const prefix = buildAgent1CachePrefix(storedPptText, storedFilteredText);" "U17-4a: 해석 단계가 agent1과 동일 인자로 프리픽스 생성 (바이트 동일 → 캐시 히트)"
assert_contains public/js/pipeline.js "const raw = await callClaudeOnce(apiKey, buildDeixisUserPrompt(), MINIMAL_SYSTEM," "U17-4b: 해석 호출이 MINIMAL_SYSTEM 사용 (agent1과 시스템 프롬프트 동일 → 캐시 매칭)"
assert_contains public/js/pipeline.js "8192, 'claude-sonnet-4-6', prefix, { isFirstCall: false, feature: 'noteAnalysis' });" "U17-4c: 해석 호출이 claude-sonnet-4-6 + 공유 프리픽스 + max_tokens 8192(40개 주석 잘림 방지)로 전송"

# ── 5) 임계치 정책: high 신뢰도만 채택 ──────────────────────
assert_contains public/js/deixis.js "if (a.conf !== 'high') continue;" "U17-5: parseDeixisAnnotations가 고신뢰(high)만 채택 (medium/low 드롭)"

# ── 6) 저장 계층: 주석은 별도 필드, 저장 텍스트 원문 불변(zero-mutation) ─
assert_contains public/js/transcripts_store.js "async function saveDeixisAnnotationsFS" "U17-6a: deixisAnnotations 저장 API 존재"
assert_contains public/js/transcripts_store.js "window.saveDeixisAnnotationsFS" "U17-6b: saveDeixisAnnotationsFS 전역 노출"
_u17_save_fn=$(awk '/^async function saveDeixisAnnotationsFS/,/^}/' public/js/transcripts_store.js)
if printf '%s' "$_u17_save_fn" | grep -Fq "deixisAnnotations:"; then
  _pass "U17-6c: set() payload가 deixisAnnotations 필드를 포함"
else
  _fail "U17-6c: set() payload가 deixisAnnotations 필드를 포함  (없음 in saveDeixisAnnotationsFS)"
fi
if printf '%s' "$_u17_save_fn" | grep -Fq "text:"; then
  _fail "U17-6d: zero-mutation 가드 — saveDeixisAnnotationsFS가 text 필드를 쓰지 않음  (발견됨: 'text:' in saveDeixisAnnotationsFS)"
else
  _pass "U17-6d: zero-mutation 가드 — saveDeixisAnnotationsFS가 text 필드를 쓰지 않음 (원문 불변, 주석은 옆 필드)"
fi

# ── 7) index.html — deixis.js가 pipeline.js보다 먼저 로드 + 캐시버스트 ─
_u17_d_line=$(grep -n 'deixis\.js?v=' public/index.html | head -1 | cut -d: -f1)
_u17_p_line=$(grep -n 'pipeline\.js?v=' public/index.html | head -1 | cut -d: -f1)
if [ -n "$_u17_d_line" ] && [ -n "$_u17_p_line" ] && [ "$_u17_d_line" -lt "$_u17_p_line" ]; then
  _pass "U17-7a: index.html이 deixis.js를 pipeline.js보다 먼저 로드 (전역 함수 선언 순서)"
else
  _fail "U17-7a: index.html이 deixis.js를 pipeline.js보다 먼저 로드  (deixis@${_u17_d_line:-없음}, pipeline@${_u17_p_line:-없음})"
fi
assert_contains public/index.html "deixis.js?v=billingui3" "U17-7b: 캐시버스트 마커 적용 (랜딩 미리보기 라운드에서 전체 통일)"

# ── 9) u17fix 라운드 — 확정 결함 픽스 회귀 가드 ─────────────
assert_contains public/js/deixis.js "function _extractJsonArray(" "U17-9a: 문자열 인지 브래킷 매칭 추출기 존재 (프리앰블/포스트앰블/잘림 내성)"
assert_contains public/js/deixis.js "if (a.slide !== null && a.slide !== undefined && !Number.isInteger(a.slide)) continue;" "U17-9b: 문자열 slide 거부 (환각 게이트 우회 차단)"
assert_contains public/js/deixis.js "if (/\n/.test(q) || /(발화자|참석자)" "U17-9c: 개행·발화자 라벨 포함 인용문 거부 (미리보기 라벨 패스 보호)"
assert_contains public/js/pipeline.js "storedDeixisRan = true;" "U17-9d: 스테이지 실행 플래그 — 파싱 성공 후에만 true (API 실패가 기존 주석 못 지움)"
assert_contains public/js/note_creation.js "storedDeixisRan" "U17-9e: 저장 루프가 실행 플래그 게이트 (빈 결과도 덮어써 스테일 주석 제거)"
assert_contains public/js/transcripts_view.js "file._rawText = raw;" "U17-9f: raw 텍스트 스레딩 (검증·저장·렌더 앵커 텍스트 통일)"
assert_contains public/js/note_creation.js "_countOccurrences(t2, a.q) === 0" "U17-9g: 교차 녹취록 오귀속 가드 (다른 파일에 같은 인용문 있으면 배정 안 함)"
assert_contains public/js/transcripts_store.js "patch.deixisAnnotations = assignAnnotationsToRecordText(existing, text || '');" "U17-9h: 화자분리 사후 text 교체 시 주석 재검증"

# ── 8) node --check — 이번 기능이 건드린 JS 전부 문법 검증 ──
for _u17_f in public/js/deixis.js public/js/pipeline.js public/js/transcripts_store.js public/js/transcripts_view.js public/js/note_creation.js scripts/test_deixis.js; do
  if node --check "$_u17_f" >/dev/null 2>&1; then
    _pass "U17-8: node --check 통과 ($_u17_f)"
  else
    _fail "U17-8: node --check 실패 ($_u17_f)"
  fi
done

# ── 단독 실행 지원: acceptance.sh를 거치지 않고 직접 실행됐을 때 요약+종료코드 ─
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo
  if [ "$AFAIL" -eq 0 ]; then
    echo "✅ u17_deixis ALL GREEN"
    exit 0
  else
    echo "❌ u17_deixis 실패 ${AFAIL}건"
    exit 1
  fi
fi
