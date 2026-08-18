# 회귀 가드 — 로그아웃 라이브 데모 (2026-08-08, P2)
#
# 랜딩 방문자가 로그인 없이 **진짜 노트 뷰어**를 연다. 서버 호출 0으로 되는 것만
# 열고, 원리상 LLM 왕복인 것(퀴즈·분류·질문)은 캔으로 채우지 않고 로그인 CTA 로 막는다.
# 미리 구운 결과를 보여주면 이 라운드가 없애려는 「가짜」를 다시 만드는 것이다.
#
# 이 스펙이 지키는 것:
#   ① 정적 픽스처가 실재한다 (노트 마크다운·슬라이드 webp·CC BY 크레딧)
#   ② 열기 핸들러가 **이름 있는 함수**다 — disabled 버튼은 클릭을 안 쏘므로
#      합성 클릭으로는 데모를 열 수 없다
#   ③ 닫기가 `currentUser` 로 분기한다 — 로그아웃 방문자에게 앱 셸이 드러나면 안 된다
#   ④ 퀴즈·분류·질문은 캔 결과가 아니라 CTA (픽스처에 정답/문항이 없음을 못박는다)
#   ⑤ 로그아웃 시 `#splitDebugBtn` 숨김 — copyDebugReport 가 파이프라인 내부를 덤프한다
#   ⑥ 포스터 칩에 `data-slide` 없음 — 달면 실제 오버레이가 열리려다 실패한다
#
# ⓪ 을 먼저 두는 이유는 api_auth / landing_preview 와 같다: absent 단언은 대상이
# 사라지면 공짜로 통과한다. 8/6·8/8 에 세 번 걸린 함정.

LD_HTML=public/index.html
LD_MAIN=public/js/main_inline.js
LD_VIEW=public/js/viewers.js
LD_DEMO=public/js/demo.js
LD_JSON=public/demo/demo.json

# ── ⓪b 인증 전환 행동 검증 ─────────────────────────────────
# Execute the real auth/demo scripts with a minimal Node DOM boundary. This
# catches the bug where a successful popup login leaves the live demo active.
assert_file scripts/test_demo_auth_transition.js "LD-0f: 데모 인증 전환 행동 테스트 존재"
LD_AUTH_OUT="$(node scripts/test_demo_auth_transition.js 2>&1)"
if [ "$?" -eq 0 ]; then
  _pass "LD-0g: 성공/취소 인증 전환 행동 테스트 통과"
else
  _fail "LD-0g: 성공/취소 인증 전환 행동 테스트 실패 (${LD_AUTH_OUT//$'\n'/ })"
fi

# ── ⓪ 대상 생존 못박기 ──────────────────────────────────────
assert_file     "$LD_HTML" "LD-0a: index.html 존재"
assert_contains "$LD_HTML" 'id="splitViewer"'        "LD-0b: 분할 뷰어 마크업 생존"
assert_contains "$LD_HTML" 'id="splitDebugBtn"'      "LD-0c: 디버그 버튼 노드 생존 (숨김 단언의 짝)"
assert_file     "$LD_MAIN" "LD-0d: main_inline.js 존재"
assert_file     "$LD_VIEW" "LD-0e: viewers.js 존재"

# ── ① 정적 픽스처 ──────────────────────────────────────────
assert_file "$LD_DEMO"  "LD-1a: 데모 부트스트랩 스크립트 존재"
assert_file "$LD_JSON"  "LD-1b: 데모 픽스처 JSON 존재"
assert_file public/demo/slide-1.webp "LD-1c: 슬라이드 1 webp 존재"
assert_file public/demo/slide-8.webp "LD-1d: 슬라이드 8 webp 존재 (전 구간 렌더)"
assert_contains "$LD_JSON" '/demo/slide-1.webp' "LD-1e: 픽스처가 슬라이드 경로를 참조"
assert_contains "$LD_JSON" 'CC BY 4.0'          "LD-1f: CC BY 4.0 출처 표기 (없이 배포하면 라이선스 위반)"
assert_contains "$LD_JSON" 'OpenStax'           "LD-1g: 출처가 OpenStax 임을 명시"
# Firebase Storage URL 은 storage.rules 가 auth 를 요구하므로 데모에서 못 쓴다.
assert_absent   "$LD_JSON" 'firebasestorage'    "LD-1h: Storage URL 미사용 (로그아웃에서 403)"
# getImgSrc 는 mimeType==='url' 일 때만 문자열을 그대로 쓴다 (markdown.js:2-5).
assert_contains "$LD_DEMO" "mimeType: 'url'"    "LD-1i: extractedImages 주입이 url 모드 사용"
assert_contains "$LD_DEMO" 'ny-demo-credit' "LD-1j: 데모 뷰어 안에 CC BY 표기 (오버레이가 랜딩 크레딧을 가린다)"
assert_contains public/css/system.css '.ny-demo-credit' "LD-1k: 데모 크레딧 스타일 존재"

# ── ② 열기 경로: 이름 있는 함수 ────────────────────────────
# #splitViewBtn 은 switchView('new') 이후 disabled + hidden 이고(ui.js),
# **disabled 버튼은 클릭 이벤트를 안 쏜다.** 합성 클릭으로는 데모를 열 수 없다.
assert_contains "$LD_MAIN" 'async function openSplitViewer()'                 "LD-2a: 열기 핸들러가 호출 가능한 이름 있는 함수"
assert_contains "$LD_MAIN" "splitViewBtn.addEventListener('click', openSplitViewer)" "LD-2b: 기존 버튼이 같은 함수를 부름 (로그인 사용자 무회귀)"
assert_absent   "$LD_MAIN" "splitViewBtn.addEventListener('click', async () => {"    "LD-2c: 익명 핸들러 잔재 없음"
assert_contains "$LD_DEMO" 'openSplitViewer()'                                "LD-2d: 데모가 같은 열기 함수를 재사용 (경로 이중화 없음)"

# ── ③ 닫기 분기 ────────────────────────────────────────────
# main_inline.js 의 닫기는 switchView('home') 을 부른다. 로그아웃 방문자가 누르면
# 앱 셸 경로로 떨어진다.
assert_contains "$LD_MAIN" 'nyDemoActive'      "LD-3a: 닫기가 데모 상태로 분기"
assert_contains "$LD_DEMO" 'function closeNotyxDemo' "LD-3b: 데모 전용 닫기 존재"
assert_contains "$LD_DEMO" 'nyDemoActive = false'    "LD-3c: 닫을 때 데모 상태 해제"
assert_absent   "$LD_DEMO" "switchView('home')"      "LD-3d: 데모 닫기가 앱 셸로 안 넘어감"

# ── ④ 퀴즈·분류·질문 = CTA, 캔 금지 ────────────────────────
assert_contains "$LD_VIEW" 'nyDemoActive'   "LD-4a: switchSplitTab 이 데모에서 분기"
assert_contains "$LD_DEMO" '로그인'          "LD-4b: 로그인 CTA 문구 존재"
assert_contains public/css/system.css '.ny-demo-cta' "LD-4g: 데모 CTA 스타일 존재 (마크업만 있고 스타일 없는 절반 완료 방지)"
# 픽스처에 미리 구운 퀴즈/분류 결과가 없어야 한다 — 있으면 이 라운드가 없애려는 「가짜」다.
assert_absent   "$LD_JSON" '"quiz"'         "LD-4c: 픽스처에 구운 퀴즈 없음"
assert_absent   "$LD_JSON" '"questions"'    "LD-4d: 픽스처에 구운 문항 없음"
assert_absent   "$LD_JSON" '"classify"'     "LD-4e: 픽스처에 구운 분류 결과 없음"
assert_absent   "$LD_JSON" '"answer"'       "LD-4f: 픽스처에 구운 정답 없음"

# ── ⑤ 로그아웃 시 디버그 버튼 숨김 ─────────────────────────
# copyDebugReport(ui.js:11)가 파이프라인 내부를 덤프한다. #debugToggle 은 CSS 로
# 이미 숨겨지지만 뷰어 안의 이 버튼은 그 목록에 없다.
assert_contains "$LD_MAIN" 'splitDebugBtn' "LD-5a: 열기 경로가 디버그 버튼을 다룸"

# ── ⑥ 진입 UX: 포스터 유지 + 열기 버튼 ─────────────────────
assert_contains "$LD_HTML" 'nyDemoOpenBtn'   "LD-6a: 「실제로 열어보기」 버튼 존재"
assert_contains "$LD_HTML" '실제로 열어보기'  "LD-6b: 버튼 라벨"
assert_contains "$LD_HTML" '/js/demo.js'     "LD-6c: demo.js 가 index.html 에 로드됨"
# 모션이 `.ny-preview` 셀렉터를 물고 있다 (landing_motion.js:27) — 이름 바꾸면 33이 깨진다.
assert_contains "$LD_HTML" 'class="ny-preview"' "LD-6d: 포스터 미리보기 유지 (모션 셀렉터)"

# ── ⑥b 포스터 칩에 data-slide 금지 ─────────────────────────
# ui.js:374 의 문서 전역 위임 리스너가 `.page-cite-chip` 을 잡는다. 포스터 칩에
# data-slide 를 달면 랜딩에서 실제 오버레이가 열리려다 슬라이드를 못 찾는다.
# 범위를 #ny-preview 구간으로 한정한다 — 파일 전체 검색은 오답이다(데모 뷰어 안의
# 칩은 진짜 데이터가 있으므로 data-slide 를 정상적으로 가진다).
LD_REGION="$(mktemp)"
sed -n '/id="ny-preview">/,/<\/section>/p' "$LD_HTML" > "$LD_REGION"
assert_contains "$LD_REGION" 'page-cite-chip' "LD-6e: 포스터 구간 추출 성공 (absent 단언의 짝)"
assert_absent   "$LD_REGION" 'data-slide'     "LD-6f: 포스터 칩에 data-slide 없음 (달면 오버레이가 열리려다 실패)"
