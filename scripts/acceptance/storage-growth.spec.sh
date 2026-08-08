# STORAGE1 — 저장 구조 1단계: 녹음 고아파일 차단 + IndexedDB 마이그레이션 사다리
#
# 감사 노트 2026-08-06 「데이터 성장 구조 감사」의 🔴2 · 🟡4 만 핀한다.
# 🔴1 blob 분리 · 🟡3 인덱스 실사용 · 🟡5~7 은 범위 밖 — 여기서 묻지 않는다.

# ── ① 🔴2 노트 삭제가 녹음 객체까지 지운다 ────────────────────────────────
assert_contains public/js/firestore_sync.js "async function deleteNoteAudio" "deleteNoteAudio() 정의됨"
assert_contains public/js/firestore_sync.js "await deleteNoteAudio(" "deleteNoteFS가 deleteNoteAudio 호출"
assert_contains public/js/firestore_sync.js "note.audioStoragePath" "오디오 삭제가 노트 레코드의 audioStoragePath를 쓴다"
assert_contains public/js/firestore_sync.js "'users/' + currentUser.uid + '/recordings/'" "삭제 대상이 본인 recordings 프리픽스로 한정됨"
assert_contains public/js/firestore_sync.js "deleteNoteAudio best-effort" "오디오 삭제 실패가 노트 삭제를 막지 않음(best-effort 주석)"

# 범위 밖이 그대로인지 — 업로드 경로는 노트 생성 전이라 noteId를 못 쓴다
assert_contains public/js/recorder.js "'users/' + currentUser.uid + '/recordings/'" "녹음 업로드 경로 불변"
# 로컬 전용 deleteNote()는 오프라인에서도 불리므로 Storage를 안 건드린다
assert_absent public/js/storage.js "storage.ref(" "storage.js는 Firebase Storage를 건드리지 않음"

# ── ②③④ 🟡4 마이그레이션 사다리 ──────────────────────────────────────────
assert_contains public/js/constants.js "const DB_VERSION = 5" "DB_VERSION=5"
assert_contains public/js/storage.js "e.oldVersion" "onupgradeneeded에 oldVersion 분기 존재"
assert_contains public/js/storage.js "e.target.transaction" "기존 스토어에 인덱스를 추가하는 versionchange 트랜잭션을 잡는다"
assert_contains public/js/storage.js ".objectStore(name)" "기존 스토어는 tx.objectStore(name)으로 열어 인덱스를 추가"
assert_contains public/js/storage.js "indexNames.contains(" "인덱스 생성이 indexNames 가드로 멱등화됨"
assert_contains public/js/storage.js "MIGRATIONS" "버전별 마이그레이션 스텝 배열 존재"
assert_contains public/js/storage.js "'updatedAt'" "v5 스텝이 notes.updatedAt 인덱스를 추가"
# 기존 데이터 삭제·재생성 금지
assert_absent public/js/storage.js "deleteObjectStore" "마이그레이션이 스토어를 지우지 않음"
assert_absent public/js/storage.js "deleteIndex" "마이그레이션이 인덱스를 지우지 않음"

# ── ⑤ S2 고아 목록 스크립트는 읽기 전용 ───────────────────────────────────
assert_file scripts/audit-orphan-audio.mjs "고아 오디오 목록 스크립트 존재"
assert_absent scripts/audit-orphan-audio.mjs ".delete()" "목록 스크립트에 삭제 호출 없음"
assert_absent scripts/audit-orphan-audio.mjs "deleteFiles" "목록 스크립트에 일괄 삭제 없음"
assert_contains scripts/audit-orphan-audio.mjs "READ-ONLY" "읽기 전용임을 파일이 명시"
