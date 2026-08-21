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
  local success_marker="$2"
  shift 2
  local output status
  output=$("$@" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    _fail "$label (exit $status: $(printf '%s' "$output" | tail -3 | tr '\n' ' '))"
  elif ! printf '%s\n' "$output" | grep -Fxq -- "$success_marker"; then
    _fail "$label (missing success marker: '$success_marker')"
  elif printf '%s' "$output" | grep -Eiq '(^|[^A-Za-z])(skip|skipped|skipping)([^A-Za-z]|$)'; then
    _fail "$label (skip/skipped/skipping output is not accepted)"
  else
    _pass "$label"
  fi
}

_storage2_run_chromium() {
  local label="STORAGE2-1l: real Chromium IndexedDB test"
  local output status
  output=$(node scripts/test_storage2_browser.mjs 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    _fail "$label failed (exit $status: $(printf '%s' "$output" | tail -3 | tr '\n' ' '))"
  elif ! printf '%s' "$output" | grep -Fq 'STORAGE2 Chromium IndexedDB: PASS'; then
    _fail "$label did not report its PASS marker (silent skip is not accepted)"
  elif printf '%s' "$output" | grep -Eiq '(^|[^A-Za-z])(skip|skipped|skipping)([^A-Za-z]|$)'; then
    _fail "$label reported a skip"
  else
    _pass "$label passed (Playwright + Chrome + PASS marker)"
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

_storage2_region_count() {
  local region="$1"
  local pattern="$2"
  local expected="$3"
  local label="$4"
  local count
  count=$(printf '%s\n' "$region" | grep -Fo -- "$pattern" | wc -l | tr -d '[:space:]')
  if [ "$count" -eq "$expected" ]; then
    _pass "$label"
  else
    _fail "$label  (expected $expected, found $count: '$pattern' in selected source region)"
  fi
}

_storage2_assert_unique_ids() {
  local duplicate
  local label="STORAGE2-6a: every STORAGE2 assertion/result ID is unique"
  duplicate=$(grep -oE 'STORAGE2-[0-9]+[a-z]+' "${BASH_SOURCE[0]}" | sort | uniq -d)
  if [ -n "$duplicate" ]; then
    _fail "$label (duplicates: $(printf '%s' "$duplicate" | tr '\n' ' '))"
  else
    _pass "$label"
  fi
}

# ── 1) Deterministic suites and the real browser gate ──────────────────────
_storage2_assert_unique_ids
assert_file scripts/test_note_images.js "STORAGE2-1a: image contract test exists"
_storage2_run_node "STORAGE2-1b: image contract test passed" "note images: 8 checks passed" node scripts/test_note_images.js

assert_file scripts/test_storage2_task4_ui.js "STORAGE2-1c: UI contract test exists"
_storage2_run_node "STORAGE2-1d: UI contract test passed" "STORAGE2 Task 4 UI: GREEN contract checks passed" node scripts/test_storage2_task4_ui.js

assert_file scripts/test_storage2_sync.js "STORAGE2-1e: sync contract test exists"
_storage2_run_node "STORAGE2-1f: sync contract test passed" "STORAGE2 sync: PASS (Task 5 payload-safe Firestore and sync contracts)" node scripts/test_storage2_sync.js

assert_file scripts/test_storage2_lifecycle.js "STORAGE2-1g: lifecycle contract test exists"
_storage2_run_node "STORAGE2-1h: lifecycle contract test passed" "STORAGE2 lifecycle: PASS" node scripts/test_storage2_lifecycle.js

assert_file scripts/test_storage2_browser.mjs "STORAGE2-1i: Chromium test exists"
assert_file 'C:/Users/김준현/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs' "STORAGE2-1j: Playwright runtime exists"
assert_file 'C:/Program Files/Google/Chrome/Application/chrome.exe' "STORAGE2-1k: Chrome executable exists"
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
_storage2_save_transaction="$(sed -n '/^function saveNoteTransaction/,/^function saveNoteLightweightAfterQuota/p' public/js/storage.js)"
_storage2_region_count "$_storage2_save_transaction" "db.transaction(['notes', 'noteImages'], 'readwrite')" 1 "STORAGE2-3a: saveNoteTransaction has one notes+noteImages readwrite transaction"
_storage2_region_contains "$_storage2_save_transaction" "detachNoteImages(" "STORAGE2-3b: saveNoteTransaction detaches image payloads"
_storage2_region_contains "$_storage2_save_transaction" "noteImages.put(detached.imageRecord)" "STORAGE2-3c: saveNoteTransaction writes noteImages"
_storage2_region_contains "$_storage2_save_transaction" "noteImages.delete(mergedRecord.id)" "STORAGE2-3d: saveNoteTransaction deletes noteImages on empty intent"
_storage2_region_contains "$_storage2_save_transaction" "notes.put(lightweightRecord)" "STORAGE2-3e: saveNoteTransaction writes the lightweight note"

_storage2_delete_note="$(sed -n '/^async function deleteNote(id)/,/^async function searchNotes/p' public/js/storage.js)"
_storage2_region_count "$_storage2_delete_note" "db.transaction(['notes', 'noteImages'], 'readwrite')" 1 "STORAGE2-3f: deleteNote has one notes+noteImages readwrite transaction"
_storage2_region_contains "$_storage2_delete_note" "tx.objectStore('notes').delete(id)" "STORAGE2-3g: deleteNote removes the note inside its transaction"
_storage2_region_contains "$_storage2_delete_note" "tx.objectStore('noteImages').delete(id)" "STORAGE2-3h: deleteNote removes detached images inside its transaction"

_storage2_clear_all="$(sed -n '/^async function clearAllStorage()/,$p' public/js/storage.js)"
_storage2_region_count "$_storage2_clear_all" "db.transaction(['notes', 'folders', 'noteImages'], 'readwrite')" 1 "STORAGE2-3i: clearAllStorage has one notes+folders+noteImages readwrite transaction"
_storage2_region_contains "$_storage2_clear_all" "tx.objectStore('notes').clear()" "STORAGE2-3j: clearAllStorage clears notes inside its transaction"
_storage2_region_contains "$_storage2_clear_all" "tx.objectStore('folders').clear()" "STORAGE2-3k: clearAllStorage clears folders inside its transaction"
_storage2_region_contains "$_storage2_clear_all" "tx.objectStore('noteImages').clear()" "STORAGE2-3l: clearAllStorage clears detached images inside its transaction"

_storage2_list="$(sed -n '/^async function getAllNotes()/,/^async function updateNoteOrder/p' public/js/storage.js)"
_storage2_region_contains "$_storage2_list" "objectStore('notes').getAll()" "STORAGE2-3m: list reads use the notes store"
_storage2_region_contains "$_storage2_list" "stripNoteImagePayloads(note)" "STORAGE2-3n: list reads strip image payloads"
_storage2_region_absent "$_storage2_list" "noteImages" "STORAGE2-3o: list reads never open noteImages"

_storage2_one_note="$(sed -n '/^async function getNote(id)/,/^async function getAllNotes/p' public/js/storage.js)"
_storage2_region_contains "$_storage2_one_note" "objectStore('noteImages').get(id)" "STORAGE2-3p: one-note reads fetch only the requested image record"
_storage2_region_contains "$_storage2_one_note" "hydrateNoteImages(note, imageRecord)" "STORAGE2-3q: one-note reads hydrate in memory"
_storage2_region_absent "$_storage2_one_note" "getAll(" "STORAGE2-3r: one-note reads do not bulk-hydrate images"

# ── 4) Local/Firestore payload stripping ───────────────────────────────────
assert_contains public/js/note_images.js "function stripNoteImagePayloads(note)" "STORAGE2-4a: shared local payload stripper exists"
_storage2_firestore_strip="$(sed -n '/^function stripFirestoreNotePayloads/,/^async function writeFirestoreNote/p' public/js/firestore_sync.js)"
_storage2_region_contains "$_storage2_firestore_strip" "function stripFirestoreNotePayloads(note)" "STORAGE2-4b: Firestore payload stripper region exists"
_storage2_region_contains "$_storage2_firestore_strip" "delete lightweight.notesHtml" "STORAGE2-4c: Firestore stripper removes notesHtml payloads"
_storage2_region_contains "$_storage2_firestore_strip" "delete lightweight.extractedImages" "STORAGE2-4d: Firestore stripper removes extractedImages payloads"
_storage2_region_contains "$_storage2_firestore_strip" "delete lightweight.slideImages" "STORAGE2-4e: Firestore stripper removes slideImages payloads"

_storage2_firestore_write="$(sed -n '/^async function writeFirestoreNote/,/^async function updateFirestoreNote/p' public/js/firestore_sync.js)"
_storage2_region_contains "$_storage2_firestore_write" "stripFirestoreNotePayloads(note)" "STORAGE2-4f: writeFirestoreNote calls the payload stripper"

_storage2_firestore_update="$(sed -n '/^async function updateFirestoreNote/,/^function _syncImageSource/p' public/js/firestore_sync.js)"
_storage2_region_contains "$_storage2_firestore_update" "stripFirestoreNotePayloads(partial)" "STORAGE2-4g: updateFirestoreNote calls the payload stripper"

# This is intentionally a Task 7 gate: the prior storage-growth pin must move
# with the production schema, while all other STORAGE1 checks remain intact.
assert_contains scripts/acceptance/storage-growth.spec.sh "DB_VERSION=6" "STORAGE2-5a: storage-growth gate expects DB_VERSION=6"
assert_contains public/index.html "billingui3" "STORAGE2-5b: final STORAGE2 cache token is normalized"

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
