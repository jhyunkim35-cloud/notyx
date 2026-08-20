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

Implementation commit SHA: pending single scoped local commit; the final handoff records the resulting SHA.

Passed:

- `node scripts/test_storage2_lifecycle.js` — `STORAGE2 lifecycle: PASS`
- `node scripts/test_note_images.js` — `note images: 8 checks passed`
- `node scripts/test_storage2_task4_ui.js` — `STORAGE2 Task 4 UI: GREEN contract checks passed`
- `node scripts/test_storage2_sync.js` — `STORAGE2 sync: PASS`
- `node scripts/test_storage2_browser.mjs` — `STORAGE2 Chromium IndexedDB: PASS`
- `node --check public/js/storage.js public/js/notes_crud.js public/js/firestore_sync.js public/js/note_images.js`
- `git diff --check`

The export artifact uses `schema: "notyx.storage2"` and `version: 2`. Each exported note is `{ note, images }`; `note` is lightweight and portable local image data exists only as `images[].dataUrl`. Import expands both legacy payload-bearing notes and detached bundles through `saveNoteFS`, preserving marker IDs, MIME metadata, and aligned sparse references. Folder moves omit image fields, reorder updates only sort metadata, and local migration hydrates only notes identified as having detached local image markers.

## Concerns

- `bash scripts/verify.sh` and the requested final diff/status/commit gates remain to be run.
- Live verification is intentionally omitted as requested (`verify.sh` without `--live`).
- No billing files were changed.
- Existing protected unrelated paths remain untouched by this task.
