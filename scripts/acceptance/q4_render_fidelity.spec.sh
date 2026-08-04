# 회귀 가드 — Q4 렌더링 충실도 (2026-07-08)
# 노트 렌더링 4종 수정: 라이트 테마 하드코딩 색상 → CSS 변수, 중첩 서브불릿
# 계층 렌더, STEM 표기 깨뜨리던 단일 * 이탤릭 제거, cloze 정답 접근성/유출 방지.
# UI Phase B(2026-08-04)에서 강조는 색상이 아니라 명도로 바뀌었다. 두 테마가 각자
# --md-strong을 정의한다는 것이 이 검사의 본질이고, 값은 무채색 결정에 따라간다.
# (보라 계열이 다시 들어오는지는 ui-phaseb.spec.sh PB-1a가 잡는다.)
assert_contains public/index.html "--md-strong: #ffffff" "Q4-1: :root 다크 테마 --md-strong 변수 정의"
assert_contains public/index.html "--md-strong: #000000" "Q4-1: :root.light 라이트 테마 --md-strong 오버라이드"
assert_contains public/index.html "color: var(--md-strong)" "Q4-1: .md-content strong이 --md-strong 변수 사용"
assert_contains public/index.html "color: var(--md-heading)" "Q4-1: .md-content h1/h2가 --md-heading 변수 사용"
assert_contains public/index.html "color: var(--md-highlight)" "Q4-1: .highlight-important이 --md-highlight 변수 사용 (부가 발견)"

assert_contains public/js/markdown.js "listStack" "Q4-2: renderMarkdown이 중첩 리스트 스택으로 서브불릿 계층 렌더"
assert_contains public/js/markdown.js "pushListItem" "Q4-2: depth 기반 리스트 아이템 push 함수 존재"

assert_absent public/js/markdown.js "replace(/\\*(.+?)\\*/g,     '<em>\$1</em>')" "Q4-3: STEM 표기(x*y*z) 깨뜨리던 단일 * 이탤릭 규칙 제거됨"

assert_contains public/js/pipeline.js "data-answer=" "Q4-4: cloze 정답이 data-answer 속성에만 존재 (select/copy/Ctrl+F 유출 방지)"
assert_contains public/js/pipeline.js "role=\"button\"" "Q4-4: cloze span이 키보드 접근 가능(role+tabindex)"
assert_contains public/js/pipeline.js "e.key !== 'Enter'" "Q4-4: cloze Enter/Space 키보드 토글 리스너 존재"
