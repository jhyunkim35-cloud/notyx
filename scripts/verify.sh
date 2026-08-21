#!/usr/bin/env bash
# verify.sh — Notyx 빌드 한 방 검증 (무인 루프의 토대).
#
# 로컬 검사(항상): ① JS 문법 node --check  ② 한글 모지바케(U+FFFD) 스캔
#                  ③ index.html 캐시버전 일관성
# 라이브 스모크(--live): ④ home 200  ⑤ index.html이 참조하는 모든 JS가
#                        현재 ?v= 로 프로덕션에서 200 (참조됐는데 미배포 잡음)
#
# exit 0 = ALL GREEN. 0이 아니면 무언가 실패(목록 출력).
# 에이전트 루프용: 수정 → verify → 빨강이면 고침 → 초록이면 커밋.
#
# 사용:
#   bash scripts/verify.sh          # 로컬만 (빠름, 커밋 전)
#   bash scripts/verify.sh --live   # 로컬 + 프로덕션 스모크 (배포 후)
#   NOTYX_PROD_URL=https://... 로 대상 오버라이드 가능

set -u
cd "$(dirname "$0")/.." || exit 2   # 호출 위치와 무관하게 repo 루트

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1
[ "${VERIFY_LIVE:-}" = "1" ] && LIVE=1
PROD="${NOTYX_PROD_URL:-https://notyx.co.kr}"

fail=0
red()  { fail=$((fail+1)); printf '❌ %s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
hdr()  { printf '\n── %s ──\n' "$*"; }

# ① JS 문법 ----------------------------------------------------------------
hdr "JS 문법 (node --check)"
js_n=0; js_bad=0
while IFS= read -r f; do
  js_n=$((js_n+1))
  if ! node --check "$f" 2>/tmp/verify_chk.err; then
    red "syntax: $f"; sed 's/^/      /' /tmp/verify_chk.err; js_bad=$((js_bad+1))
  fi
done < <(find public/js api -name '*.js' -type f 2>/dev/null | sort)
[ "$js_bad" -eq 0 ] && ok "JS ${js_n}개 문법 OK"

# ①b STORAGE2 결정론적 계약 스위트 ------------------------------------------
# Keep running every suite after a failure so the verifier reports the full
# gate result instead of masking later failures behind the first one.
hdr "STORAGE2 결정론적 테스트"
storage2_n=0; storage2_bad=0
run_storage2_suite() {
  local f="$1" output status
  storage2_n=$((storage2_n+1))
  output=$(node "$f" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "STORAGE2: $f"
  else
    red "STORAGE2: $f"
    printf '%s\n' "$output" | sed 's/^/      /'
    storage2_bad=$((storage2_bad+1))
  fi
}
run_storage2_suite scripts/test_note_images.js
run_storage2_suite scripts/test_storage2_task4_ui.js
run_storage2_suite scripts/test_storage2_sync.js
run_storage2_suite scripts/test_storage2_lifecycle.js
[ "$storage2_bad" -eq 0 ] && ok "STORAGE2 결정론적 테스트 ${storage2_n}개 통과"

# ①c Recurring billing deterministic contract suites -----------------------
hdr "Recurring billing deterministic tests"
billing_n=0; billing_bad=0
run_billing_suite() {
  local f="$1" output status
  billing_n=$((billing_n+1))
  output=$(node "$f" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "billing: $f"
  else
    red "billing: $f"
    printf '%s\n' "$output" | sed 's/^/      /'
    billing_bad=$((billing_bad+1))
  fi
}
run_billing_suite scripts/test_billing_domain.js
run_billing_suite scripts/test_billing_crypto.js
run_billing_suite scripts/test_billing_provider.js
run_billing_suite scripts/test_billing_repository.js
run_billing_suite scripts/test_billing_api.js
run_billing_suite scripts/test_billing_renewal.js
run_billing_suite scripts/test_billing_entitlement.js
run_billing_suite scripts/test_billing_ui.js
run_billing_suite scripts/test_toss_webhook.js
run_billing_suite scripts/test_toss_products.js
[ "$billing_bad" -eq 0 ] && ok "Recurring billing deterministic tests ${billing_n} passed"

# ② 모지바케 (U+FFFD) — 추적 텍스트 전체 -----------------------------------
hdr "한글 모지바케 스캔 (U+FFFD)"
FFFD=$(printf '\xEF\xBF\xBD')
moji=$(LC_ALL=C git grep -lFI "$FFFD" -- public api '*.md' 2>/dev/null || true)
if [ -n "$moji" ]; then
  red "모지바케 발견:"; printf '%s\n' "$moji" | sed 's/^/      /'
else
  ok "모지바케 없음"
fi

# ③ 캐시버전 일관성 (index.html 의 ?v= 가 전부 동일해야) -------------------
hdr "캐시버전 일관성 (index.html)"
vers=$(grep -oE '\?v=[A-Za-z0-9]+' public/index.html | sort -u)
vcnt=$(printf '%s\n' "$vers" | grep -c .)
if [ "$vcnt" -le 1 ]; then
  ok "캐시버전 단일: ${vers:-(없음)}"
else
  red "캐시버전 섞임 (배포 stale 위험):"; printf '%s\n' "$vers" | sed 's/^/      /'
fi

# ④⑤ 라이브 스모크 ---------------------------------------------------------
if [ "$LIVE" -eq 1 ]; then
  hdr "라이브 스모크 ($PROD)"
  home=$(curl -s -o /dev/null -w '%{http_code}' "$PROD/?cb=$RANDOM")
  if [ "$home" = "200" ]; then ok "home 200"; else red "home HTTP $home"; fi

  refs=$(grep -oE '/js/[A-Za-z0-9_]+\.js\?v=[A-Za-z0-9]+' public/index.html | sort -u)
  ref_n=0; ref_bad=0
  for r in $refs; do
    ref_n=$((ref_n+1))
    code=$(curl -s -o /dev/null -w '%{http_code}' "$PROD$r&cb=$RANDOM")
    [ "$code" = "200" ] || { red "live: $r → $code"; ref_bad=$((ref_bad+1)); }
  done
  [ "$ref_bad" -eq 0 ] && ok "참조 JS ${ref_n}개 전부 라이브 200"
else
  printf '\n(라이브 스모크 생략 — --live 로 활성화)\n'
fi

# 요약 ---------------------------------------------------------------------
echo
if [ "$fail" -eq 0 ]; then
  ok "ALL GREEN"
  exit 0
else
  printf '❌ 실패 %d건 ↑ — 고치고 다시 verify\n' "$fail"
  exit 1
fi
