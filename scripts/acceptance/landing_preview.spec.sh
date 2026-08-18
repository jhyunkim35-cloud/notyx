# 회귀 가드 — 랜딩 노트 미리보기 (2026-08-08)
#
# 랜딩의 `#ny-preview`는 손으로 쓴 가짜 마크업이었고, 안에 제품이 절대 출력하지
# 않는 수치(「강의 중 2회 강조」)가 박혀 있었다. 반복 횟수를 세는 코드는 레포에
# 없다 — `pipeline.js`는 「⭐는 명시적으로 강조한 경우만」이 전부다.
#
# 이 스펙이 지키는 것:
#   ① 유령 수치 0 — 코드로 존재를 증명 못 하는 주장은 미리보기에 없다
#   ② 실물 구조 — 요약 리드 → 제목 → 구분선 → 페이지 인용 칩 → 용어 정의
#   ③ CC BY 4.0 출처 표시 (없이 배포하면 라이선스 위반)
#   ④ `.ny-preview*` 클래스명 불변 — landing_motion.js가 셀렉터로 물고 있다
#   ⑤ 로그인 후 화면 무변경 — 진짜 칩 기능은 그대로
#
# 범위는 `#ny-preview` 섹션 안으로 한정한다. 파일 전체 검색은 오답이다 —
# 「회 강조」류 문구가 로그인 후 화면에 생기는 건 이 스펙의 관심사가 아니고,
# 반대로 `page-cite-chip`은 파일 전체에는 원래 있으니 존재 단언이 공짜로 통과한다.

LP_HTML=public/index.html
LP_CSS=public/css/system.css
LP_REGION="$(mktemp)"
sed -n '/id="ny-preview">/,/<\/section>/p' "$LP_HTML" > "$LP_REGION"

# ── ⓪ 추출 성공 못박기 ───────────────────────────────────
# assert_absent는 추출이 깨져 빈 파일이 되면 전부 공짜로 통과한다. 8/6·8/8에
# 두 번 걸린 함정이라 absent 검사보다 먼저 「범위가 살아 있음」을 단언한다.
assert_contains "$LP_REGION" 'class="ny-preview"'  "LP-0a: #ny-preview 구간 추출 성공"
assert_contains "$LP_REGION" 'ny-preview-body'     "LP-0b: 추출 구간이 미리보기 본문까지 포함"

# ── ① 유령 수치 0 ────────────────────────────────────────
assert_absent "$LP_REGION" '회 강조'   "LP-1a: 「N회 강조」 없음 (반복 횟수를 세는 코드가 레포에 0건)"
assert_absent "$LP_REGION" '강의 중 2' "LP-1b: 「강의 중 2회」 잔재 없음"
assert_absent "$LP_REGION" '유기화학'  "LP-1c: 가공된 과목명 제거 (실제 노트로 교체)"

# ── ② 실물 `.md-content` 구조 ────────────────────────────
# 실제 노트의 6가지 패턴을 순서대로 핀한다. 각각 라이브 DOM에서 채취한 것.
assert_contains "$LP_REGION" '<strong>요약</strong>'                "LP-2a: 요약 리드 문단이 맨 위"
assert_contains "$LP_REGION" '8.1 Overview of Photosynthesis'       "LP-2b: 섹션 제목(실물 <h1> 자리)"
assert_matches  "$LP_REGION" '<hr'                                  "LP-2c: 제목 아래 구분선"
assert_contains "$LP_REGION" 'page-cite-chip'                       "LP-2d: 페이지 인용 칩 존재 (실재 기능인데 랜딩이 광고를 안 했다)"
assert_contains "$LP_REGION" 'p.1-3'                                "LP-2e: 범위형 페이지 인용 표기"
assert_contains "$LP_REGION" '<strong>광합성 Photosynthesis</strong>' "LP-2f: 용어 = 「한글 English」 굵게"
assert_contains "$LP_REGION" 'ex) 식물'                             "LP-2g: 용어 아래 중첩 목록"

# 포스터는 정적이다. 클릭 핸들러 없는 <button>은 접근성 거짓말이므로 칩은
# 비대화형 요소로 모양만 재현한다. 게다가 ui.js의 문서 전역 위임 리스너가
# `.page-cite-chip`을 물고 있어서, data-slide를 달면 랜딩에서 슬라이드
# 오버레이가 열리려다 실패한다 — 속성을 안 다는 것이 그 경로를 차단한다.
#
# 2026-08-08(P2): 이 불변식의 대상은 **섹션이 아니라 포스터**다. 같은 섹션에
# 「실제로 열어보기」 CTA(#nyDemoOpenBtn)가 생겼는데, 그건 진짜 핸들러가 달린
# 진짜 버튼이라 LP-2h가 막으려던 거짓말이 아니다. 그래서 그 한 줄만 빼고 검사한다
# — 제외 대상이 실재함을 먼저 못박아야 제외가 공짜 통과가 되지 않는다.
assert_contains "$LP_REGION" 'id="nyDemoOpenBtn"' "LP-2h0: 제외 대상(데모 CTA)이 실재 (아래 제외의 짝)"
LP_POSTER="$(mktemp)"
grep -v 'id="nyDemoOpenBtn"' "$LP_REGION" > "$LP_POSTER"
assert_contains "$LP_POSTER" 'ny-preview-body' "LP-2h1: 제외 후에도 포스터 본문 생존 (absent 단언의 짝)"
assert_absent "$LP_POSTER" '<button'    "LP-2h: 포스터에 <button> 없음 (정적 화면 = 비대화형 칩)"
assert_absent "$LP_REGION" 'data-slide' "LP-2i: 랜딩 칩에 data-slide 없음 (ui.js 전역 클릭 위임 미발화)"
rm -f "$LP_POSTER"

# ── ③ CC BY 4.0 출처 표시 (의무) ─────────────────────────
assert_contains "$LP_REGION" 'OpenStax, Biology (CC BY 4.0)' "LP-3a: CC BY 출처 표시 존재"
assert_contains "$LP_REGION" 'https://openstax.org'          "LP-3b: 원본 링크 존재"

# ── ④ 클래스명 불변 (모션 계약) ──────────────────────────
# landing_motion.js가 `#landingView .ny-preview`를 진입 모션 대상으로 물고
# 있다. 이름이 바뀌면 스펙은 전부 그린인 채 모션만 죽는다 — 8/6에 겪은 실패.
assert_contains "$LP_REGION" 'class="ny-preview-bar"'   "LP-4a: .ny-preview-bar 유지"
assert_contains "$LP_REGION" 'class="ny-preview-body"'  "LP-4b: .ny-preview-body 유지"
assert_contains "$LP_REGION" 'class="ny-preview-slide"' "LP-4c: .ny-preview-slide 유지"
assert_contains "$LP_REGION" 'class="ny-preview-note"'  "LP-4d: .ny-preview-note 유지"
assert_contains public/js/landing_motion.js '#landingView .ny-preview' "LP-4e: 모션 셀렉터가 여전히 .ny-preview를 물고 있음"

# 새 마크업은 CSS가 있어야 실물처럼 보인다. 마크업만 바꾸고 스타일을 빼먹는
# 절반 완료를 막는 짝 검사.
assert_contains "$LP_CSS" '.ny-preview-lead'          "LP-4f: 요약 리드 스타일 존재"
assert_contains "$LP_CSS" '.ny-preview-credit'        "LP-4g: 크레딧 스타일 존재"
assert_contains "$LP_CSS" '#ny-preview .page-cite-chip' "LP-4h: 랜딩 칩 스코프 오버라이드 존재 (cursor 거짓말 방지)"

# ── ⑤ 로그인 후 화면 무변경 ──────────────────────────────
# 이번 작업은 랜딩 한정이다. 진짜 칩 기능(markdown.js가 <button>으로 렌더 →
# ui.js가 슬라이드 오버레이를 연다)은 손대지 않았음을 못박는다.
assert_contains public/js/markdown.js 'class="page-cite-chip" data-slide=' "LP-5a: 노트 렌더러의 진짜 칩 <button> 유지"
assert_contains public/js/ui.js       "closest('.page-cite-chip')"         "LP-5b: 칩 클릭 위임 핸들러 유지"
assert_contains "$LP_HTML"            'id="finalNotesBody"'                "LP-5c: 로그인 후 노트 뷰 골격 유지"

# ── ⑥ 캐시버스트 ────────────────────────────────────────
# 「신규값 존재 + 구값 잔존 0」의 짝은 u15_polish가 소유한다 — 여기서 다시 물으면
# 같은 단언이 두 벌이 된다. 이 스펙이 더할 게 있는 건 **CSS 링크**뿐이다:
# 지금까지 캐시버스트를 핀하던 스펙은 전부 JS 파일이었고, 이번 라운드는 처음으로
# system.css가 바뀐다. 현재값 정확 핀 — 얼터네이션은 회귀 감지력이 0이다.
assert_contains "$LP_HTML" 'system.css?v=demoauth1' "LP-6: system.css 캐시버스트 갱신 (CSS가 바뀐 라운드)"

rm -f "$LP_REGION"
