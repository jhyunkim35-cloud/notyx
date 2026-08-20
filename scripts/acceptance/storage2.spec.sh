# STORAGE2 acceptance gate.
#
# This spec owns the final structural contract and runs every STORAGE2 test
# driver. The Chromium driver is intentionally fail-closed: a missing browser,
# missing Playwright, or a successful process without its PASS marker is a
# failure rather than a skip.

if ! declare -f _pass >/dev/null 2>&1; then
  _storage2_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$_storage2_dir/../.." || exit 2
  . scripts/acceptance/_assert.sh
fi

_storage2_run_node() {
  local label="$1"
  shift
  local output status
  output=$("$@" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    _pass "$label"
  else
    _fail "$label (exit $status: $(printf '%s' "$output" | tail -3 | tr '\n' ' '))"
  fi
}

_storage2_run_chromium() {
  local output status
  output=$(node scripts/test_storage2_browser.mjs 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    _fail "STORAGE2-1e: real Chromium IndexedDB test failed (exit $status: $(printf '%s' "$output" | tail -3 | tr '\n' ' '))"
  elif ! printf '%s' "$output" | grep -Fq 'STORAGE2 Chromium IndexedDB: PASS'; then
    _fail "STORAGE2-1e: real Chromium test did not report its PASS marker (silent skip is not accepted)"
  elif printf '%s' "$output" | grep -Eiq '(^|[^A-Za-z])(skip|skipped|skipping)([^A-Za-z]|$)'; then
    _fail "STORAGE2-1e: real Chromium test reported a skip"
  else
    _pass "STORAGE2-1e: real Chromium IndexedDB test passed (Playwright + Chrome + PASS marker)"
  fi
}

_storage2_region_contains() {
  local region="$1"
  local pattern="$2"
  local label="$3"
  if printf '%s\n' "$region" | grep -Fq -- "$pattern"; then
    _pass "$label"
  else
    _fail "$label  (없음: '$pattern' in selected source region)"
  fi
}

_storage2_region_absent() {
  local region="$1"
  local pattern="$2"
  local label="$3"
  if printf '%s\n' "$region" | grep -Fq -- "$pattern"; then
    _fail "$label  (발견됨: '$pattern' in selected source region)"
  else
    _pass "$label"
  fi
}

# ── 1) Deterministic suites and the real browser gate ──────────────────────
assert_file scripts/test_note_images.js "STORAGE2-1a: image contract test exists"
_storage2_run_node "STORAGE2-1a: image contract test passed" node scripts/test_note_images.js

assert_file scripts/test_storage2_task4_ui.js "STORAGE2-1b: UI contract test exists"
_storage2_run_node "STORAGE2-1b: UI contract test passed" node scripts/test_storage2_task4_ui.js

assert_file scripts/test_storage2_sync.js "STORAGE2-1c: sync contract test exists"
_storage2_run_node "STORAGE2-1c: sync contract test passed" node scripts/test_storage2_sync.js

assert_file scripts/test_storage2_lifecycle.js "STORAGE2-1d: lifecycle contract test exists"
_storage2_run_node "STORAGE2-1d: lifecycle contract test passed" node scripts/test_storage2_lifecycle.js

assert_file scripts/test_storage2_browser.mjs "STORAGE2-1e: Chromium test exists"
assert_file 'C:/Users/김준현/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs' "STORAGE2-1e: Playwright runtime exists"
assert_file 'C:/Program Files/Google/Chrome/Application/chrome.exe' "STORAGE2-1e: Chrome executable exists"
_storage2_run_chromium

# ── 2) IndexedDB schema and migration invariants ───────────────────────────
assert_contains public/js/constants.js "const DB_VERSION = 6" "STORAGE2-2a: DB_VERSION is 6"
assert_contains public/js/storage.js "ensureStore(e, 'noteImages', 'noteId')" "STORAGE2-2b: noteImages store is added with noteId keyPath"
assert_contains public/js/storage.js "notes.openCursor()" "STORAGE2-2c: v6 migration uses a notes cursor"
assert_absent public/js/storage.js "deleteObjectStore" "STORAGE2-2d: migration never deletes an object store"
assert_absent public/js/storage.js "deleteIndex" "STORAGE2-2e: migration never deletes an index"

_storage2_migration="$(sed -n '/    version: 6,/,/^  },/p' public/js/storage.js)"
_storage2_region_contains "$_storage2_migration" "notes.openCursor()" "STORAGE2-2f: v6 migration region opens a cursor"
_storage2_region_absent "$_storage2_migration" "getAll(" "STORAGE2-2g: v6 migration region does not call getAll()"

# ── 3) Transaction and read-shape invariants ───────────────────────────────
assert_contains public/js/storage.js "db.transaction(['notes', 'noteImages'], 'readwrite')" "STORAGE2-3a: note save/delete use a notes+noteImages transaction"
assert_contains public/js/storage.js "db.transaction(['notes', 'folders', 'noteImages'], 'readwrite')" "STORAGE2-3b: storage reset includes noteImages transactionally"
assert_contains public/js/storage.js "tx.objectStore('noteImages').delete(id)" "STORAGE2-3c: note deletion removes its detached image record"
assert_contains public/js/storage.js "tx.objectStore('noteImages').clear()" "STORAGE2-3d: storage reset clears detached image records"

_storage2_list="$(sed -n '/^async function getAllNotes()/,/^async function updateNoteOrder/p' public/js/storage.js)"
_storage2_region_contains "$_storage2_list" "objectStore('notes').getAll()" "STORAGE2-3e: list reads use the notes store"
_storage2_region_contains "$_storage2_list" "stripNoteImagePayloads(note)" "STORAGE2-3f: list reads strip image payloads"
_storage2_region_absent "$_storage2_list" "noteImages" "STORAGE2-3g: list reads never open noteImages"

_storage2_one_note="$(sed -n '/^async function getNote(id)/,/^async function getAllNotes/p' public/js/storage.js)"
_storage2_region_contains "$_storage2_one_note" "objectStore('noteImages').get(id)" "STORAGE2-3h: one-note reads fetch only the requested image record"
_storage2_region_contains "$_storage2_one_note" "hydrateNoteImages(note, imageRecord)" "STORAGE2-3i: one-note reads hydrate in memory"
_storage2_region_absent "$_storage2_one_note" "getAll(" "STORAGE2-3j: one-note reads do not bulk-hydrate images"

# ── 4) Local/Firestore payload stripping ───────────────────────────────────
assert_contains public/js/note_images.js "function stripNoteImagePayloads(note)" "STORAGE2-4a: shared local payload stripper exists"
assert_contains public/js/firestore_sync.js "function stripFirestoreNotePayloads(note)" "STORAGE2-4b: Firestore payload stripper exists"
assert_contains public/js/firestore_sync.js "delete lightweight.notesHtml" "STORAGE2-4c: Firestore writes remove notesHtml payloads"
assert_contains public/js/firestore_sync.js "delete lightweight.extractedImages" "STORAGE2-4d: Firestore writes remove extractedImages payloads"
assert_contains public/js/firestore_sync.js "delete lightweight.slideImages" "STORAGE2-4e: Firestore writes remove slideImages payloads"
assert_contains public/js/firestore_sync.js "stripFirestoreNotePayloads(note)" "STORAGE2-4f: Firestore note writes pass through the stripper"

# This is intentionally a Task 7 gate: the prior storage-growth pin must move
# with the production schema, while all other STORAGE1 checks remain intact.
assert_contains scripts/acceptance/storage-growth.spec.sh "DB_VERSION=6" "STORAGE2-5a: storage-growth gate expects DB_VERSION=6"
assert_contains public/index.html "storage2task7" "STORAGE2-5b: final STORAGE2 cache token is normalized"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo
  if [ "$AFAIL" -eq 0 ]; then
    echo "✅ storage2 ALL GREEN"
    exit 0
  else
    echo "❌ storage2 failed $AFAIL checks"
    exit 1
  fi
fi
