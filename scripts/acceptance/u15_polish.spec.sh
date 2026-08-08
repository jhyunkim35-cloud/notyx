# 회귀 가드 — U15 폴리시 3종 (2026-07-11)
# 1) 발화자 이름변경 (표시전용 매핑, 저장 텍스트는 불변)
# 2) 이미지 드래그앤드롭 다중파일 (setupDrop FileList 전달)
# 3) HEIC 업로드 (아이폰 사진) — 실패시 heic2any 지연로드 변환

# ── Item 1: 발화자 이름변경 ──────────────────────────────
assert_contains public/js/transcripts_view.js "transcriptSpeakerRenameBtn" "U15-1: 미리보기 헤더에 발화자 이름변경 버튼 존재"
assert_contains public/js/transcripts_view.js "function hasSpeakerLabels" "U15-1: 발화자 라벨 감지 함수 존재 (버튼 조건부 노출)"
assert_contains public/js/transcripts_view.js "function extractSpeakerNumbers" "U15-1: 텍스트에서 발화자 번호 추출 함수 존재"
assert_contains public/js/transcripts_view.js "function openSpeakerRenameModal" "U15-1: 발화자 이름변경 모달 함수 존재"
assert_contains public/js/transcripts_view.js "db-modal" "U15-1: 발화자 이름변경 모달이 기존 .db-modal 패턴 재사용"
assert_contains public/js/transcripts_store.js "async function saveSpeakerNamesFS" "U15-1: speakerNames 저장 API 존재"
assert_contains public/js/transcripts_store.js "window.saveSpeakerNamesFS" "U15-1: saveSpeakerNamesFS 전역 노출"
assert_contains public/js/transcripts_view.js "renderTranscriptPreviewBody(t.text || '', t.speakerNames, t.deixisAnnotations)" "U15-1: 미리보기 렌더가 speakerNames 매핑을 표시시점에 전달"
assert_contains public/js/transcripts_view.js "function applySpeakerNames" "U15-1: 노트 생성 소비 시점 치환 함수 존재"
assert_contains public/js/transcripts_view.js "applySpeakerNames(raw, t.speakerNames)" "U15-1: 노트 만들기 경로에서 발화자 이름 치환 적용"
assert_contains public/js/transcripts_store.js "const patch = { speakerNames: speakerNames || {}, updatedAt: new Date().toISOString() };" "U15-1: speakerNames 저장 patch가 text 필드를 건드리지 않음 (저장 텍스트 불변)"

# ── Item 2: 이미지 다중 드래그앤드롭 ─────────────────────
assert_contains public/js/pptx_parser.js "if (e.dataTransfer.files.length) handler(e.dataTransfer.files);" "U15-2: setupDrop이 FileList 전체를 handler에 전달 (files[0] 아님)"
assert_absent   public/js/pptx_parser.js "handler(e.dataTransfer.files[0])" "U15-2: setupDrop의 단일파일 전달 코드 제거됨"

# ── Item 3: HEIC 업로드 ───────────────────────────────────
assert_contains public/index.html ".webp,.heic" "U15-3: pptInput accept 속성에 .heic 추가"
assert_contains public/js/pptx_parser.js "'.webp', '.heic'" "U15-3: IMAGE_UPLOAD_EXTS에 .heic 추가"
assert_contains public/js/pptx_parser.js "function loadHeic2Any" "U15-3: heic2any 지연로드 헬퍼 존재"
assert_contains public/js/pptx_parser.js "cdn.jsdelivr.net/npm/heic2any" "U15-3: heic2any CDN 스크립트 주소 참조"
assert_contains public/js/pptx_parser.js "ponytail:" "U15-3: HEIC 우회 로직에 ponytail 주석으로 한계 명시"
assert_contains public/js/pptx_parser.js "file.name.toLowerCase().endsWith('.heic')" "U15-3: createImageBitmap 실패시 .heic 파일만 변환 재시도"

# ── 캐시버스트 ────────────────────────────────────────────
assert_absent   public/index.html "?v=storage1" "U15: 캐시버스트 이전 버전 마커 잔존 없음"
assert_contains public/index.html "?v=preview1" "U15: 캐시버스트 신규 버전 마커 적용 (랜딩 미리보기 라운드에서 전체 통일)"
