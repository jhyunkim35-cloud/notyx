# 회귀 가드 — UI Phase B: 로그인 후 화면 무채색 이관 (2026-08-04)
#
# Phase A(8/1, ee402db)는 로그아웃 랜딩까지만 무채색으로 바꿨다. 로그인하는 순간
# 보라(#7c3aed) 팔레트로 뒤바뀌는 게 Phase B가 없애는 결함이다. 이 스펙은 그 결함이
# 되돌아오지 못하게 막는다.
#
# ① 보라 하드코딩 0 — 토큰을 안 쓰고 색을 직접 박은 자리 (index.html + 서빙되는 JS)
# ② gradient 0 — 형광펜(앰버 --ny-hl)은 rgba 단색이라 gradient가 아니다. 따라서 예외 0건.
# ③ action-btn → ny-btn 이관 완료 (B3-pilot)
#
# ③이 잔여 0건 하나로 끝나지 않는 이유: 클래스를 통째로 지워도 잔여는 0이 된다.
# "index.html 마크업만 바꾸고 JS가 emit하는 문자열을 빠뜨리는" 사고가 실제 위험이므로,
# 이전에 action-btn을 emit하던 JS 3파일이 지금 ny-btn을 emit하는지 짝으로 확인한다.

# ── 로컬 헬퍼 ─────────────────────────────────────────────
# _assert.sh의 assert_absent는 파일 하나 + 리터럴만 받는다. 여기서는 여러 파일에
# 정규식을 걸고 "몇 건 남았는지"를 세야 해서 카운트 기반 헬퍼를 스펙 안에 둔다.
# ponytail: 이 스펙 전용이라 _assert.sh를 건드리지 않는다. 다른 스펙이 쓰게 되면 그때 승격.

pb_absent() { # REGEX MSG FILE...
  local re="$1" msg="$2"; shift 2
  local n; n=$(grep -ohE "$re" "$@" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${n:-0}" -eq 0 ]; then _pass "$msg"; else _fail "$msg  (잔여 ${n}건: /$re/)"; fi
}

pb_present() { # REGEX MSG FILE...
  local re="$1" msg="$2"; shift 2
  local n; n=$(grep -ohE "$re" "$@" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${n:-0}" -gt 0 ]; then _pass "$msg (${n}건)"; else _fail "$msg  (0건: /$re/)"; fi
}

PB_HTML=public/index.html
PB_JS=$(echo public/js/*.js)
PB_CSS=public/css/system.css

# ── ① 보라(및 동반 유채색) 하드코딩 0 ────────────────────
# 폐기된 보라 팔레트 전체: primary/secondary/bright/deep + 폴백으로 박혀 있던 #7c4dff.
# 보라와 짝으로만 등장하던 청록/파랑/오렌지(gradient 상대편, 벌크 버튼)도 같이 잡는다 —
# 보라만 지우면 그 자리에 시안이 남아 여전히 유채색 화면이다.
# rgba를 통째로 막으면 무채색인 --ny-scrim/--ny-hl까지 걸리므로 해당 RGB 삼중항만 잡는다.
# 상태색(success/warning/danger)과 형광펜 앰버는 의도적으로 제외 — 확정 결정상 허용.
PB_CHROMA='#7c3aed|#8b5cf6|#a78bfa|#5b21b6|#a855f7|#7c4dff|#00b4d8|#5b8ef7|#2563eb|#f97316|#fb923c'
PB_CHROMA="$PB_CHROMA"'|124, ?58, ?237|139, ?92, ?246|124, ?77, ?255|249, ?115, ?22|0, ?180, ?216'

# shellcheck disable=SC2086
pb_absent "$PB_CHROMA" "PB-1a: index.html에 폐기된 유채색 하드코딩 0" $PB_HTML
# constants.js는 유일한 예외라 따로 잰다. FOLDER_COLORS는 사용자가 고르는 폴더 라벨
# 색이고, 값이 Firestore에 저장된 뒤 firestore_sync.js의 화이트리스트로 검증된다
# (CSS 인젝션 가드). 값을 무채색으로 바꾸면 이미 색을 고른 폴더가 검증에 떨어져
# 색이 날아간다 — 스타일이 아니라 데이터다. 그래서 팔레트만 남기고,
# "예외가 딱 그 팔레트뿐"임을 개수로 못박는다. 늘어나면 이 스펙이 빨개진다.
PB_JS_NOCONST=$(echo public/js/*.js | tr ' ' '\n' | grep -v 'constants\.js' | tr '\n' ' ')
# shellcheck disable=SC2086
pb_absent "$PB_CHROMA" "PB-1b: 서빙 JS(constants.js 제외)에 폐기된 유채색 하드코딩 0" $PB_JS_NOCONST

pb_const_n=$(grep -ohE "$PB_CHROMA" public/js/constants.js 2>/dev/null | wc -l | tr -d ' ')
if [ "${pb_const_n:-0}" -le 2 ]; then
  _pass "PB-1b2: constants.js 유채색은 FOLDER_COLORS 팔레트뿐 (${pb_const_n}건 ≤ 2)"
else
  _fail "PB-1b2: constants.js에 FOLDER_COLORS 외 유채색 유입 (${pb_const_n}건 > 2)"
fi
assert_contains public/js/constants.js "FOLDER_COLORS" "PB-1b3: FOLDER_COLORS 팔레트 유지 (저장된 사용자 폴더 색 보존)"
assert_absent   public/js/constants.js "'#7c3aed'" "PB-1b4: CLASSIFY_COLORS 카테고리 배지 무채색화"
# shellcheck disable=SC2086
pb_absent "$PB_CHROMA" "PB-1c: system.css에 폐기된 유채색 하드코딩 0" $PB_CSS

# 레거시 :root 토큰이 무채색으로 재정의됐는지 (이름은 유지 — 함정 1)
assert_matches public/index.html '--primary: *#[0-9a-fA-F]{6}' "PB-1d: --primary 토큰 정의 존재 (이름 유지)"
assert_absent  public/index.html "--accent: #f97316" "PB-1e: 폐기된 오렌지 --accent 값 제거"
assert_matches public/index.html ':root\.light \{' "PB-1f: 라이트 테마 블록 유지"

# ── ② gradient 0 ─────────────────────────────────────────
PB_GRAD='linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient'
# shellcheck disable=SC2086
pb_absent "$PB_GRAD" "PB-2a: index.html에 gradient 0 (형광펜은 rgba 단색이라 예외 없음)" $PB_HTML
# shellcheck disable=SC2086
pb_absent "$PB_GRAD" "PB-2b: 서빙 JS에 gradient 0" $PB_JS
# shellcheck disable=SC2086
pb_absent "$PB_GRAD" "PB-2c: system.css에 gradient 0" $PB_CSS

# 렌더되지 않는 죽은 규칙(<header> 엘리먼트 부재) 제거 확인
assert_absent public/index.html "header h1" "PB-2d: 죽은 header h1 그라데이션 규칙 제거"

# ── ③ action-btn → ny-btn 이관 (B3-pilot) ────────────────
# shellcheck disable=SC2086
pb_absent "action-btn" "PB-3a: index.html에 action-btn 잔여 0" $PB_HTML
# shellcheck disable=SC2086
pb_absent "action-btn" "PB-3b: 서빙 JS에 action-btn 잔여 0" $PB_JS

# 지우기만 해서 통과하는 걸 막는 짝 검사 — JS가 실제로 ny-btn을 emit해야 한다.
pb_present "ny-btn" "PB-3c: batch.js가 ny-btn emit" public/js/batch.js
pb_present "ny-btn" "PB-3d: exam_plan.js가 ny-btn emit" public/js/exam_plan.js
pb_present "ny-btn" "PB-3e: transcripts_view.js가 ny-btn emit" public/js/transcripts_view.js
pb_present "ny-btn" "PB-3f: index.html이 ny-btn 마크업 보유" public/index.html

# action-btn을 잡던 CSS 자손 셀렉터도 같이 옮겨졌는지. 마크업만 바꾸고 이걸 빠뜨리면
# 클래스는 깨끗한데 좁은 화면 툴바가 조용히 깨진다 — grep으로는 안 보이는 사고.
assert_matches public/index.html '#splitTopBar \.ny-btn' "PB-3g: #splitTopBar 좁은화면 규칙이 ny-btn으로 이관"
assert_matches public/index.html '\.ny-btn svg\.lucide' "PB-3h: 버튼 안 lucide 아이콘 크기 규칙이 ny-btn으로 이관"
# .action-btn.primary / .action-btn.danger 모디파이어는 ny- 프리미티브로 흡수됐다.
assert_contains public/js/exam_plan.js       "ny-btn-primary" "PB-3i: exam_plan.js primary 버튼이 ny-btn-primary"
assert_contains public/js/transcripts_view.js "ny-btn-danger"  "PB-3j: transcripts_view.js 삭제 버튼이 ny-btn-danger"

# B3-pilot 범위 밖 클래스는 건드리지 않았어야 한다 (goal 명시 금지 사항).
# 파일럿은 action-btn 하나뿐이고, 나머지 이관은 준현 승인 전까지 자동 진행 금지.
assert_contains public/index.html "sidebar-btn"  "PB-3k: 범위 밖 sidebar-btn 유지"
assert_contains public/index.html "analyze-btn"  "PB-3l: 범위 밖 analyze-btn 유지"
assert_contains public/index.html "add-rec-btn"  "PB-3m: 범위 밖 add-rec-btn 유지"
assert_contains public/index.html "mode-btn"     "PB-3n: 범위 밖 mode-btn 유지"
assert_contains public/index.html "cancel-btn"   "PB-3o: 범위 밖 cancel-btn 유지"
assert_contains public/index.html "tab-btn"      "PB-3p: 범위 밖 tab-btn 유지"
assert_contains public/index.html "icon-btn"     "PB-3q: 범위 밖 icon-btn 유지"
