# 회귀 가드 — U7 STT Whisper 이관 + 완전 화자분리 (2026-07-08)
# U7b(2026-07-09) 갱신: pyannote.ai 유료 호스팅 API → Firestore 잡큐 + 로컬
# 파이썬 워커(worker/diarize_worker.py, community-1 오픈소스 모델) 셀프호스팅
# 전환. Groq whisper-large-v3-turbo 전사는 그대로, assemblyai.js와 동형 계약
# (transcribe→jobId, status 폴링→문자열)도 그대로 잠금.
# 머지 로직 행동 검증은 node scripts/test_stt_merge.js (8단언).
# 잡큐/그레이스 만료/labels 액션 행동 검증은 node scripts/test_whisper_stt_smoke.js.

assert_file api/whisper-stt.js "U7-1: whisper-stt 서버리스 함수 존재"
assert_file api/_stt_merge.js "U7-1: 순수 머지 모듈 존재"
assert_file scripts/test_stt_merge.js "U7-1: 머지 단위테스트 존재"

assert_contains api/whisper-stt.js "whisper-large-v3-turbo" "U7-2: Groq turbo 모델 지정"
assert_contains api/whisper-stt.js "timestamp_granularities[]" "U7-2: 단어 타임스탬프 요청"
assert_contains api/whisper-stt.js "language', 'ko'" "U7-2: 한국어 지정"

assert_contains api/whisper-stt.js "transcript_id: jobId" "U7-3: assemblyai.js 동형 계약 (transcript_id 반환)"
assert_contains api/whisper-stt.js "diarization_failed: true" "U7-3: 화자분리 실패 시 전사문 폴백 (잡 전체 실패 금지)"
assert_contains api/whisper-stt.js "stt_tmp/" "U7-3: whisper 결과 uid 스코프 Storage 스태시"
assert_absent api/whisper-stt.js "file.delete()" "U7-3: 완료 응답 유실 대비 tmp 미삭제 (재폴링 멱등성)"
assert_contains api/whisper-stt.js "isAllowedAudioUrl" "U7-3: Storage URL 허용목록 가드"

assert_contains api/whisper-stt.js "diarizationJobs" "U7b-1: Firestore 잡큐로 화자분리 이관 (pyannote.ai 유료 API 제거)"
assert_contains api/whisper-stt.js "diarization_pending" "U7b-2: 그레이스 만료 시 라벨 없이 전사문 우선 전달"
assert_contains api/whisper-stt.js "action === 'labels'" "U7b-3: 워커 완료 후 라벨 업그레이드 액션 존재"
assert_file worker/diarize_worker.py "U7b-4: 로컬 화자분리 워커 존재"
assert_contains worker/diarize_worker.py "speaker-diarization-community-1" "U7b-4: 오픈소스 community-1 모델 지정"
assert_contains worker/diarize_worker.py "exclusive_speaker_diarization" "U7b-4: pyannote 4.x 출력 형식 대응"

assert_contains api/_stt_merge.js "발화자" "U7-4: 기존 발화자 N: 문자열 포맷 출력 (separateSpeakers 무변경 호환)"
assert_contains api/_stt_merge.js "dropHallucinatedSegments" "U7-4: 무음 환각 세그먼트 드롭 가드"
assert_contains api/_stt_merge.js "smoothBoundaryBleed" "U7-4: 화자 경계 블리드 스무딩"
assert_contains api/_stt_merge.js "rankSpeakers" "U7-4: 최다 발화자 → 발화자 1 리맵"

assert_matches public/js/recorder.js "const USE_WHISPER = (true|false)" "U7-5: 롤백 플래그 존재 (값은 운영 토글 — 키 등록 전 false)"
assert_contains public/js/recorder.js "/api/whisper-stt" "U7-5: 기본 엔진이 whisper-stt로 라우팅"
assert_contains public/js/recorder.js "audioBitsPerSecond: 32000" "U7-5: 32kbps opus (90분≈22MB, Groq 한도 내)"

assert_contains vercel.json "api/whisper-stt.js" "U7-6: maxDuration 등록"
assert_contains public/js/transcripts_view.js "발화자|참석자" "U7-7: 프리뷰 발화자 라벨 강조 렌더"
assert_matches public/index.html "transcripts_view\.js\?v=storage2task7" "U7-7: transcripts_view 캐시버스트 갱신 (현재값 정확 핀 — 얼터네이션 금지, 구값 허용은 회귀 감지력 상실)"

assert_live /api/whisper-stt "unauthorized" "U7-8: 라이브 함수 응답 (미인증 401 바디)"

assert_contains api/whisper-stt.js "form.append('prompt'" "U7e-1: 용어 프롬프트 서버 전달 (Groq FormData)"
assert_contains public/js/recorder.js "buildSttTermsPrompt" "U7e-2: 클라 강의자료 용어 추출 함수 존재"
assert_matches public/index.html "recorder\.js\?v=storage2task7" "U7e-3: recorder.js 캐시버스트 갱신 (현재값 정확 핀)"

assert_contains public/js/recorder.js 'id="recSpeakersHint"' "U7e-4: 발화자 수 힌트 셀렉트 존재 (기본 자동 감지)"
assert_contains public/js/recorder.js "reqBody.speakers_hint = hintVal" "U7e-5: 힌트가 whisper 경로 body에만 포함"
assert_contains api/whisper-stt.js "Number.isInteger(body?.speakers_hint)" "U7e-6: 서버 힌트 정수·범위 검증"
assert_contains api/whisper-stt.js "{ numSpeakers: speakersHint }" "U7e-7: 유효 힌트만 잡 문서 numSpeakers로 저장"
assert_contains worker/diarize_worker.py "num_speakers" "U7e-8: 로컬 워커 exact-N 클러스터링 지원"
assert_contains worker/modal_worker.py "num_speakers" "U7e-9: Modal 워커 exact-N 클러스터링 지원"
