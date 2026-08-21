# 회귀 가드 — 랜딩 기능 주장 (2026-08-06)
#
# 감사(docs/LANDING-AUDIT.md)가 랜딩에서 뺀 것들이 다시 들어오지 못하게 막는다.
# 판정 기준은 「코드가 있느냐」가 아니라 「로그인 사용자가 그 동작에 도달하느냐」.
#
# ① 미도달 기능 문구 부재 — 시간표(호출부 0건) · 스터디 룸(약속한 동작이 계약상 반대)
# ② 과장 문구 부재 + 축소된 실체 문구 존재 (지우기만 해서 통과하는 걸 막는 짝 검사)
# ③ 무료 한도 고지 존재
#
# 범위는 #landingView 안으로 한정한다. 「스터디 룸」은 로그인 후 사이드바에 그대로
# 살아 있어야 하므로(코드·진입점 유지가 결정 사항) 파일 전체 검색은 오답이다.

LC_HTML=public/index.html
LC_REGION="$(mktemp)"
sed -n '/<div id="landingView"/,/<!-- Main Content -->/p' "$LC_HTML" > "$LC_REGION"

# 추출이 깨지면 아래 absent 검사가 전부 공짜로 통과한다 — 먼저 못박는다.
assert_contains "$LC_REGION" 'id="ny-more"' "LC-0: #landingView 구간 추출 성공"

# ── ① 미도달 기능 문구 0 ─────────────────────────────────
assert_absent "$LC_REGION" '시간표'    "LC-1a: 랜딩에 시간표 문구 없음 (timetable.js 호출부 0건)"
assert_absent "$LC_REGION" '스터디 룸' "LC-1b: 랜딩에 스터디 룸 문구 없음 (6/28 동결 · 노트 내용 비공개 계약)"
assert_absent "$LC_REGION" '스터디룸'  "LC-1c: 랜딩에 스터디룸(붙여쓰기) 문구 없음"
assert_absent "$LC_REGION" '함께 보기' "LC-1d: 랜딩에 「함께 보기」 없음"

# 코드·진입점은 자산이라 유지 — 통째로 지워서 통과하는 걸 막는 짝 검사.
assert_file     public/js/timetable.js "LC-1e: timetable.js 유지 (랜딩 문구만 뺐고 코드는 자산)"
assert_contains "$LC_HTML" 'openStudyRoomEntryModal' "LC-1f: 사이드바 스터디 룸 진입점 유지"

# ── ② 과장 문구 → 실체로 축소 ────────────────────────────
assert_absent   "$LC_REGION" '순서대로 이어서' "LC-2a: 이미지 「순서대로」 주장 제거 (pptx_parser.js:60 정렬 없음)"
assert_contains "$LC_REGION" '30장'            "LC-2b: 이미지 30장 상한 고지 (MAX_IMAGE_UPLOAD_COUNT)"
assert_contains "$LC_REGION" '둘 중 하나만'    "LC-2c: 자료 슬롯 배타성 고지 (PPT+사진 동시 불가)"

assert_absent   "$LC_REGION" '반복해서 강조한'          "LC-2d: 「반복해서」 제거 (반복 횟수 세는 코드 없음)"
assert_contains "$LC_REGION" '강조한 지점을 노트에 표시' "LC-2e: 실체 = 명시적 강조 표시 (pipeline.js:328)"

assert_contains "$LC_REGION" '시험 계획을 등록한 과목은' "LC-2f: SRS 전제 고지 (home_view.js:31 유일 진입점)"

assert_absent   "$LC_REGION" '내보낸 페이지를 그대로 읽습니다' "LC-2g: 노션이 노트 파이프라인을 타는 것처럼 읽히는 문구 제거"
assert_contains "$LC_REGION" '바로 퀴즈를 만듭니다'           "LC-2h: 노션 실체 = 바로 퀴즈 (type:'notion')"

# ── ③ 무료 한도 고지 ─────────────────────────────────────
assert_contains "$LC_REGION" '무료 3회' "LC-3a: 무료 월 3회 한도 고지 (payment.js:233)"
assert_contains "$LC_REGION" '8,900'        "LC-3b: 월정액 금액 고지 (payment.js:174)"
assert_contains "$LC_REGION" '1회 500원'    "LC-3c: 1회권 금액 고지"

rm -f "$LC_REGION"
