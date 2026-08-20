# STORAGE2 Task 6 Report

## RED

Command:

```text
node scripts/test_storage2_lifecycle.js
```

Result before implementation: exit code 1.

Exact feature failure after correcting the fixture harness:

```text
AssertionError [ERR_ASSERTION]: export must hydrate each selected note exactly once
actual: []
expected: [ 'export-note' ]
```

The lifecycle fixture covers legacy import, v2 detached import, versioned export, folder move, reorder, local-to-Firestore migration, Firestore-to-local note processing, and metadata-only search results.

## GREEN

Implementation commit SHA: `a7a4802`.

Passed:

- `node scripts/test_storage2_lifecycle.js` — `STORAGE2 lifecycle: PASS`
- `node scripts/test_note_images.js` — `note images: 8 checks passed`
- `node scripts/test_storage2_task4_ui.js` — `STORAGE2 Task 4 UI: GREEN contract checks passed`
- `node scripts/test_storage2_sync.js` — `STORAGE2 sync: PASS`
- `node scripts/test_storage2_browser.mjs` — `STORAGE2 Chromium IndexedDB: PASS`
- `node --check public/js/storage.js public/js/notes_crud.js public/js/firestore_sync.js public/js/note_images.js`
- `C:\\Program Files\\Git\\bin\\bash.exe -lc "scripts/verify.sh"` — `ALL GREEN` (live skipped)
- `git diff --check`

The export artifact uses `schema: "notyx.storage2"` and `version: 2`. Each exported note is `{ note, images }`; `note` is lightweight and portable local image data exists only as `images[].dataUrl`. Import expands both legacy payload-bearing notes and detached bundles through `saveNoteFS`, preserving marker IDs, MIME metadata, and aligned sparse references. Folder moves omit image fields, reorder updates only sort metadata, and local migration hydrates only notes identified as having detached local image markers.

## Concerns

- Live verification is intentionally omitted as requested (`verify.sh` without `--live`).
- No billing files were changed.
- Existing protected unrelated paths remain untouched by this task.

## Fix Round 1/5

### RED

The fix-round lifecycle command was run before the lazy migration probe and fail-closed import changes:

```text
node scripts/test_storage2_lifecycle.js
```

Observed failures included:

```text
AssertionError [ERR_ASSERTION]: v2 rejects raw legacy entries before any write
actual: 2
expected: 0
```

After the import validation work, the remaining migration RED was:

```text
AssertionError [ERR_ASSERTION]: local-to-Firestore migration hydrates only confirmed local Blob owners
actual: [ 'marker-without-blob', 'local-image' ]
expected: [ 'local-image' ]
```

This demonstrated that marker metadata was incorrectly used as the image-upload decision instead of probing `noteImages` ownership.

### GREEN

Implemented fail-closed in-memory import planning, exact STORAGE2 v2 schema validation, portable image validation, detached `slideImageUrls` payload rejection, title-only/body-only legacy compatibility, one-note writer imports, lazy local Blob ownership probing, and migration retry-state handling.

Verification commands and results:

- `node --check public/js/storage.js; node --check public/js/notes_crud.js; node --check public/js/firestore_sync.js; node --check scripts/test_storage2_lifecycle.js; node --check scripts/test_storage2_sync.js; node --check scripts/test_storage2_browser.mjs` — exit 0.
- `node scripts/test_storage2_lifecycle.js` — `STORAGE2 lifecycle: PASS`.
- `node scripts/test_note_images.js` — `note images: 8 checks passed`.
- `node scripts/test_storage2_task4_ui.js` — `STORAGE2 Task 4 UI: GREEN contract checks passed`.
- `node scripts/test_storage2_sync.js` — `STORAGE2 sync: PASS`; unexpected sync warnings/errors are rejected by the fixture.
- `node scripts/test_storage2_browser.mjs` — `STORAGE2 Chromium IndexedDB: PASS`.
- `C:\Program Files\Git\bin\bash.exe -lc 'export PATH=/usr/bin:/bin:/mingw64/bin:$PATH; ./scripts/verify.sh'` — `ALL GREEN`; live smoke omitted.
- `git diff --check` — exit 0.

### Commit

Implementation commit SHA: `1561e14`.

### Concerns

- Live verification was intentionally omitted; `verify.sh` was run without `--live`.
- The exact commit SHA is recorded above after the single scoped commit; the report-only SHA update is intentionally not amended into history.
- No billing files were changed; protected unrelated paths and plans/spec documents remain outside the commit.

## Fix Round 2/5

### RED

The first focused re-review fixtures reproduced the two pre-fix harness/production failures:

```text
node scripts/test_storage2_lifecycle.js
```

```text
AssertionError [ERR_ASSERTION]: detached slideImageUrls object must reject before any folder/note write
actual: 1
expected: 0
```

With strict Task4 console handling enabled:

```text
node scripts/test_storage2_task4_ui.js
```

```text
Error: unexpected console.warn: [moveSavedNote] metadata list failed, falling back to one-note read: ReferenceError: db is not defined
```

The first referential-integrity implementation also correctly failed the newly added remote-marker fixture, proving that an unconditional “every HTML marker needs an image owner” rule would reject valid remote HTML exports.

### GREEN

Round 2 now enforces paired schema/version declarations, recursive legacy/v2 payload rejection with canonical legacy exceptions, strict v2 top-level-extra scanning, canonical array shapes, strict `slideImageUrls`, portable alias rejection, local-placeholder HTML owner integrity, remote HTML marker preservation, null-hydration migration failure/retry behavior, and strict Task4 Firebase/IDB harness dependencies.

Verification commands and exact results:

- `node --check public/js/storage.js; node --check public/js/notes_crud.js; node --check public/js/firestore_sync.js; node --check scripts/test_storage2_lifecycle.js; node --check scripts/test_storage2_sync.js; node --check scripts/test_storage2_browser.mjs; node --check scripts/test_storage2_task4_ui.js` — exit 0.
- `node scripts/test_storage2_lifecycle.js` — `STORAGE2 lifecycle: PASS`.
- `node scripts/test_note_images.js` — `note images: 8 checks passed`.
- `node scripts/test_storage2_task4_ui.js` — `STORAGE2 Task 4 UI: GREEN contract checks passed` with strict unexpected console.warn/error failure behavior.
- `node scripts/test_storage2_sync.js` — `STORAGE2 sync: PASS`.
- `node scripts/test_storage2_browser.mjs` — `STORAGE2 Chromium IndexedDB: PASS`; includes production import through `importNotes`/`saveNoteFS` and exact persisted PNG byte-array assertion.
- `C:\Program Files\Git\bin\bash.exe -lc 'export PATH=/usr/bin:/bin:/mingw64/bin:$PATH; ./scripts/verify.sh'` — `ALL GREEN`; 59 JS files checked, cache version `storage2task6r3`, live smoke omitted.
- `git diff --check` — exit 0.

### Commit

Implementation commit SHA: `pending until the scoped commit is created`.

### Concerns

- Live verification was intentionally omitted; `verify.sh` was run without `--live`.
- No billing files were changed.
- Protected unrelated paths, plans/spec documents, and `public/img/` remain outside the task scope.
