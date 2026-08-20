// Firestore cloud sync + usage tracking + image upload.
// Depends on: constants.js (auth, db, storage, currentUser, DEVELOPER_EMAILS),
//             storage.js (saveNote, getNote, getAllNotes, getAllFolders, saveFolder,
//                         deleteNote, deleteFolder, renameFolder, updateNoteOrder, openDB).

function userNotesRef() {
  if (!currentUser) return null;
  return db.collection('users').doc(currentUser.uid).collection('notes');
}
function userFoldersRef() {
  if (!currentUser) return null;
  return db.collection('users').doc(currentUser.uid).collection('folders');
}

// M1: Validate folder color against FOLDER_COLORS whitelist to prevent CSS injection.
// Accepts only values from the predefined palette (or null/undefined to clear).
function sanitizeFolderColor(color) {
  if (color == null || color === '') return null;
  if (typeof color !== 'string') return null;
  if (typeof FOLDER_COLORS === 'undefined') return null;
  const allowed = FOLDER_COLORS.some(c => c.value === color);
  return allowed ? color : null;
}

function _carryLocalImageDegradation(error, localSaveResult) {
  if (!localSaveResult || localSaveResult.saveStatus !== 'image-degraded') return error;
  const decorated = error instanceof Error ? error : new Error(String(error || 'Remote note save failed'));
  decorated.saveStatus = localSaveResult.saveStatus;
  decorated.degradation = localSaveResult.degradation;
  decorated.localSaveResult = localSaveResult;
  return decorated;
}

function stripFirestoreNotePayloads(note) {
  const detached = typeof stripNoteImagePayloads === 'function'
    ? stripNoteImagePayloads(note || {})
    : Object.assign({}, note || {});
  const lightweight = typeof noteImageCopyMetadata === 'function'
    ? noteImageCopyMetadata(detached, typeof noteImagePayloadOmitMap === 'function'
      ? noteImagePayloadOmitMap()
      : null)
    : detached;
  delete lightweight.notesHtml;
  delete lightweight.extractedImages;
  delete lightweight.slideImages;
  delete lightweight.filteredText;
  return lightweight;
}

async function writeFirestoreNote(ref, id, note, options) {
  return ref.doc(id).set(stripFirestoreNotePayloads(note), options || { merge: true });
}

async function updateFirestoreNote(ref, id, partial) {
  return ref.doc(id).update(stripFirestoreNotePayloads(partial));
}

function _syncImageSelection(note) {
  if (Array.isArray(note && note.slideImages) && note.slideImages.length > 0) {
    return { field: 'slideImages', entries: note.slideImages };
  }
  if (Array.isArray(note && note.extractedImages) && note.extractedImages.length > 0) {
    return { field: 'extractedImages', entries: note.extractedImages };
  }
  return null;
}

function _syncImageSource(entry) {
  if (typeof noteImageSourceInfo === 'function') return noteImageSourceInfo(entry);
  if (typeof entry === 'string' && isRemoteImageSource(entry)) return { kind: 'remote', value: entry };
  return entry ? { kind: 'local', value: entry } : null;
}

function _syncHasLocalImages(entries) {
  for (let index = 0; index < entries.length; index += 1) {
    if (!(index in entries) || entries[index] == null) continue;
    const source = _syncImageSource(entries[index]);
    if (!source || source.kind === 'local') return true;
  }
  return false;
}

function _syncEntryWithUrl(entry, url) {
  const output = entry && typeof entry === 'object' && !(entry instanceof Blob)
    ? Object.assign({}, entry)
    : {};
  output.imageBase64 = url;
  output.mimeType = 'url';
  delete output.blob;
  delete output.src;
  delete output.data;
  delete output.payload;
  delete output.base64;
  delete output.imageData;
  return output;
}

function _syncRecordWithUploadedUrls(record, selection, urls) {
  const merged = Object.assign({}, record);
  const entries = new Array(selection.entries.length);
  for (let index = 0; index < selection.entries.length; index += 1) {
    if (!(index in selection.entries)) continue;
    const entry = selection.entries[index];
    if (entry == null) {
      entries[index] = entry;
      continue;
    }
    const url = urls[index];
    entries[index] = url ? _syncEntryWithUrl(entry, url) : entry;
  }
  merged[selection.field] = entries;

  const slideImageUrls = new Array(
    Array.isArray(record.slideImageUrls) ? record.slideImageUrls.length : selection.entries.length,
  );
  if (Array.isArray(record.slideImageUrls)) {
    for (let index = 0; index < record.slideImageUrls.length; index += 1) {
      if (index in record.slideImageUrls) slideImageUrls[index] = record.slideImageUrls[index];
    }
  }
  if (slideImageUrls.length < selection.entries.length) slideImageUrls.length = selection.entries.length;
  for (let index = 0; index < urls.length; index += 1) {
    if (index in urls && urls[index]) slideImageUrls[index] = urls[index];
  }
  merged.slideImageUrls = slideImageUrls;
  return merged;
}

async function saveNoteFS(note) {
  // ───── GHOST NOTE DIAGNOSTIC (temp, remove after debugging) ─────
  const _hasTitle = note && note.title && note.title.trim();
  const _hasContent = note && (note.notesText || note.markdownContent) &&
                      (note.notesText || note.markdownContent).trim();
  if (!_hasTitle || !_hasContent) {
    console.warn('🔴 GHOST CANDIDATE saveNoteFS called with empty data!', {
      id: note?.id,
      title: note?.title || '(empty)',
      hasNotesText: !!note?.notesText,
      hasMarkdown: !!note?.markdownContent,
      notesTextLen: note?.notesText?.length || 0,
      type: note?.type,
    });
    console.trace('Call stack:');
    return note;
  }
  console.log('[saveNoteFS]', note?.id, '|', note?.title || '(no title)', '|', _hasContent ? 'has content' : 'EMPTY');
  // ───── END DIAGNOSTIC ─────
  _invalidateNotesCache();
  const now = new Date().toISOString();
  const id = note.id || uuidv4();
  const record = Object.assign({ folderId: null, createdAt: now }, note, { id, updatedAt: now });
  const imageSelection = _syncImageSelection(record);

  // Always save the original local payload first. If Storage upload fails,
  // the note text and detached local images remain available offline.
  let localSaveResult = await saveNote(record);
  let recordForRemote = record;

  // If logged in, upload images to Storage and save to Firestore
  const ref = userNotesRef();
  try {
    if (ref) {
      if (imageSelection && _syncHasLocalImages(imageSelection.entries)) {
        const uploadedUrls = await uploadSlideImages(id, imageSelection.entries);
        recordForRemote = _syncRecordWithUploadedUrls(record, imageSelection, uploadedUrls);
        // Replace detached local payloads only after every upload succeeds.
        localSaveResult = await saveNote(recordForRemote);
      }

      const toSave = Object.assign({}, recordForRemote);

      // Progressive size reduction until under 900KB
      const stripOrder = ['pipelineLog', 'highlightedTranscript', 'pptText', 'recText'];
      for (const key of stripOrder) {
        if (JSON.stringify(toSave).length <= 900000) break;
        console.warn('saveNoteFS: stripping', key, '(' + JSON.stringify(toSave[key] || '').length + ' chars)');
        delete toSave[key];
      }

      const finalSize = JSON.stringify(stripFirestoreNotePayloads(toSave)).length;
      if (finalSize > 950000) {
        console.error('saveNoteFS: STILL too large after all strips:', finalSize,
          Object.keys(toSave).map(k => k + ':' + JSON.stringify(toSave[k] || '').length).join(', '));
        return Object.assign({}, recordForRemote, localSaveResult); // skip Firestore write, IndexedDB already saved
      }

      await writeFirestoreNote(ref, id, toSave, { merge: true });
    }
  } catch (error) {
    throw _carryLocalImageDegradation(error, localSaveResult);
  }
  return Object.assign({}, recordForRemote, localSaveResult);
}
// ─────────────────────────────────────────────────────────────────
// Firestore is the truth source. IDB is an offline-only cache.
//
// Reads go to Firestore first; on success the result is mirrored into
// IDB so an offline reload still has data. On any failure (network
// down, SDK error, not-logged-in) we fall back to IDB so the UI never
// breaks. This single rule kills the "Edge has stale data" class of
// bugs because there's no longer any per-browser source of truth that
// can drift.
//
// Hydration policy (very important — this is what corrupted the PPT
// slide URLs before): when we read a note from Firestore we may build
// `extractedImages` from `slideImageUrls` for the viewer. That field
// is FOR DISPLAY ONLY. saveNoteFS guards against it being sent back
// up — see uploadSlideImages, which keeps URL-typed entries as-is.
// ─────────────────────────────────────────────────────────────────

function _hydrateNoteForViewer(note) {
  if (!note) return note;
  if (!note.notesHtml && note.notesText && typeof renderMarkdown === 'function') {
    note.notesHtml = renderMarkdown(note.notesText);
  }
  if (note.slideImageUrls && !note.extractedImages) {
    note.extractedImages = new Array(note.slideImageUrls.length);
    for (let index = 0; index < note.slideImageUrls.length; index += 1) {
      if (index in note.slideImageUrls && note.slideImageUrls[index]) {
        note.extractedImages[index] = {
          slideNumber: index + 1,
          imageBase64: note.slideImageUrls[index],
          mimeType: 'url',
        };
      }
    }
  }
  return note;
}

function _markerImageNodes(html) {
  const nodes = {};
  String(html || '').replace(/<img\b[^>]*data-note-image-ref\s*=\s*(?:(['"])([^'"]+)\1|([^\s>]+))[^>]*>/gi,
    (whole, quote, quoted, bare) => {
      const marker = quoted !== undefined ? quoted : bare;
      if (!nodes[marker]) nodes[marker] = whole;
      return whole;
    });
  return nodes;
}

function _mergeMarkerImageNodes(remoteHtml, localHtml) {
  let merged = String(remoteHtml || '');
  const localNodes = _markerImageNodes(localHtml);
  for (const [marker, node] of Object.entries(localNodes)) {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const markerPattern = new RegExp(
      '<img\\b(?=[^>]*data-note-image-ref\\s*=\\s*(?:["\\\'])' + escapedMarker + '(?:["\\\']))[^>]*>',
      'i',
    );
    if (markerPattern.test(merged)) merged = merged.replace(markerPattern, node);
    else merged += (merged ? '\n' : '') + node;
  }
  return merged;
}

async function getNoteFS(id) {
  // Logged-out path: just hit IDB
  const ref = userNotesRef();
  if (!ref) return getNote(id);
  try {
    const doc = await ref.doc(id).get();
    if (doc.exists) {
      const rawData = doc.data() || {};
      const data = _hydrateNoteForViewer(Object.assign({}, rawData));
      const local = await getNote(id).catch(() => null);
      const remoteHasDetachedArrays = Object.prototype.hasOwnProperty.call(rawData, 'extractedImages')
        || Object.prototype.hasOwnProperty.call(rawData, 'slideImages');
      const metadata = Object.assign({}, data, { id });
      if (local) {
        if (!remoteHasDetachedArrays
          && ((Array.isArray(local.extractedImages) && local.extractedImages.length > 0)
            || (Array.isArray(local.slideImages) && local.slideImages.length > 0))) {
          delete metadata.extractedImages;
          delete metadata.slideImages;
        }
        const contentMatches = Object.prototype.hasOwnProperty.call(rawData, 'notesText')
          && local.notesText === rawData.notesText;
        if (contentMatches && typeof local.notesHtml === 'string') {
          // The local one-note read has marker-resolved HTML and is safe to
          // reuse only when it represents the same remote text version.
          metadata.notesHtml = local.notesHtml;
        } else {
          // Firestore notesText is authoritative for changed content. Carry
          // only detached marker-bearing image nodes from local HTML; never
          // carry stale local prose into the remote version.
          metadata.notesHtml = _mergeMarkerImageNodes(metadata.notesHtml, local.notesHtml);
        }
      }
      try {
        await saveNote(metadata);
      } catch (e) { /* metadata mirror is best-effort; local data remains usable */ }
      const hydrated = await getNote(id).catch(() => null);
      return hydrated ? Object.assign({}, hydrated, metadata) : data;
    }
    // Doc doesn't exist on Firestore — fall back to IDB so notes the user
    // is actively editing locally (not yet pushed) still open.
    return getNote(id);
  } catch (e) {
    console.warn('[getNoteFS] Firestore read failed, falling back to IDB:', id, e.message);
    return getNote(id);
  }
}

// U18: short-lived memo cache — the global-search input calls getAllNotesFS on
// every debounced keystroke, which was a full PAID Firestore collection read
// (+ IDB mirror) per pause. 5s TTL bounds staleness; every write path below
// calls _invalidateNotesCache() so same-tab mutations are never stale.
// ponytail: same-tab cache only — cross-device staleness within 5s is acceptable.
let _notesCache = null, _notesCacheAt = 0, _notesCacheUid = null;
const NOTES_CACHE_TTL_MS = 5000;
function _invalidateNotesCache() { _notesCache = null; }

async function getAllNotesFS() {
  const ref = userNotesRef();
  if (!ref) return getAllNotes();
  const uid = currentUser?.uid || null;
  if (_notesCache && _notesCacheUid === uid && (Date.now() - _notesCacheAt) < NOTES_CACHE_TTL_MS) {
    return _notesCache;
  }
  try {
    const snap = await ref.get();
    const notes = snap.docs.map(d => Object.assign({}, d.data()));
    // Mirror set into IDB as a side effect so future offline loads work.
    // We don't delete IDB-only notes here — that's the realtime listener's
    // job in v2; for now an IDB-only note still appears so the user never
    // sees their unsynced work vanish.
    try {
      const conn = await openDB();
      await new Promise((res, rej) => {
        const tx = conn.transaction('notes', 'readwrite');
        const store = tx.objectStore('notes');
        for (const n of notes) store.put(n);
        tx.oncomplete = res;
        tx.onerror = e => rej(e.target.error);
      });
    } catch (e) { /* best-effort */ }
    const sorted = notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    _notesCache = sorted; _notesCacheAt = Date.now(); _notesCacheUid = uid;
    return sorted;
  } catch (e) {
    console.warn('[getAllNotesFS] Firestore read failed, falling back to IDB:', e.message);
    return getAllNotes();
  }
}
async function deleteNoteFS(id) {
  _invalidateNotesCache();
  // Read the audio pointer while the record still exists — deleteNote() below
  // drops the local row and ref.doc(id).delete() drops the remote one.
  let audioPath = null;
  try {
    const note = await getNote(id);
    if (note) audioPath = note.audioStoragePath || null;
  } catch (e) { /* best-effort */ }
  let firstError = null;
  const ref = userNotesRef();
  if (ref) {
    if (!audioPath) {
      // Local row can be absent (bulk delete of a note synced on another device).
      try {
        const snap = await ref.doc(id).get();
        if (snap.exists) audioPath = (snap.data() || {}).audioStoragePath || null;
      } catch (e) { /* best-effort */ }
    }
    try {
      await ref.doc(id).delete();
    } catch (e) {
      firstError = e;
    }
    try {
      await deleteSlideImages(id);
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }
  try {
    await deleteNote(id);
  } catch (e) {
    if (!firstError) firstError = e;
  }
  await deleteNoteAudio(audioPath);
  // Track deletion for sync
  if (currentUser) {
    const deletedKey = 'deleted_notes_' + currentUser.uid;
    const deleted = JSON.parse(localStorage.getItem(deletedKey) || '[]');
    // M2: dedupe + cap at 200 (drop oldest) to prevent unbounded localStorage growth
    if (!deleted.includes(id)) deleted.push(id);
    const capped = deleted.length > 200 ? deleted.slice(deleted.length - 200) : deleted;
    localStorage.setItem(deletedKey, JSON.stringify(capped));
  }
  if (firstError) throw firstError;
}
async function searchNotesFS(query) {
  const all = await getAllNotesFS();
  const q = query.toLowerCase();
  return all.filter(n => (n.title || '').toLowerCase().includes(q) || (n.notesText || '').toLowerCase().includes(q));
}

// Ghost-note prevention helper.
//
// Firestore's `set(..., {merge:true})` will create a new doc if one doesn't
// already exist — that's how partial updates from folder moves and renames
// were silently spawning empty notes (no title, no body) on Firestore in the
// first place. Use this helper for every partial-field write to a note doc:
//
//   - If the doc exists  -> apply patch via update() (truly partial, no creation)
//   - If the doc is missing AND IndexedDB has the full note with real content,
//     fall through to saveNoteFS() which already gates on title+content.
//   - If the doc is missing AND local data is also empty, refuse the write —
//     better to skip a save than to materialise a ghost row.
//
// Returns true on success (any path), false if the write was refused.
async function safeNotePartialUpdate(noteId, partial) {
  _invalidateNotesCache();
  const ref = userNotesRef();
  if (!ref || !noteId) return false;
  try {
    await updateFirestoreNote(ref, noteId, partial);
    return true;
  } catch (e) {
    const code = e && (e.code || '');
    const isMissing = code === 'not-found' || code === 'firestore/not-found' ||
                      /no document to update|not found/i.test(e.message || '');
    if (!isMissing) {
      console.warn('[safeNotePartialUpdate] update error', noteId, e);
      return false;
    }
    // Doc missing on Firestore — recover from local IndexedDB if it has real data.
    let local = null;
    try { local = await getNote(noteId); } catch {}
    const hasTitle   = local && local.title && local.title.trim();
    const hasContent = local && (local.notesText || local.markdownContent) &&
                       (local.notesText || local.markdownContent).trim();
    if (!local || !hasTitle || !hasContent) {
      console.warn('[safeNotePartialUpdate] doc missing AND local empty/missing — refusing to create ghost note',
        noteId, { localExists: !!local, hasTitle, hasContent });
      return false;
    }
    // Local has real data — push it through saveNoteFS so it goes through the
    // existing ghost guard there, and merge in the requested partial fields.
    const merged = Object.assign({}, local, partial);
    try {
      await saveNoteFS(merged);
      return true;
    } catch (e2) {
      console.warn('[safeNotePartialUpdate] fallback saveNoteFS failed', noteId, e2);
      return false;
    }
  }
}

async function saveFolderFS(folder) {
  const ref = userFoldersRef();
  if (!ref) return saveFolder(folder);
  const id = folder.id || uuidv4();
  // M1: sanitize color against whitelist before persisting
  const safeFolder = Object.assign({}, folder, { color: sanitizeFolderColor(folder.color) });
  const record = Object.assign({ createdAt: new Date().toISOString() }, safeFolder, { id });
  await ref.doc(id).set(record, { merge: true });
  return record;
}
async function getAllFoldersFS() {
  const ref = userFoldersRef();
  if (!ref) return getAllFolders();
  try {
    const snap = await ref.orderBy('name').get();
    const folders = snap.docs.map(d => d.data());
    // Mirror to IDB so offline page loads still show folders
    try {
      const conn = await openDB();
      await new Promise((res, rej) => {
        const tx = conn.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        for (const f of folders) store.put(f);
        tx.oncomplete = res;
        tx.onerror = e => rej(e.target.error);
      });
    } catch (e) { /* best-effort */ }
    return folders;
  } catch (e) {
    console.warn('[getAllFoldersFS] Firestore read failed, falling back to IDB:', e.message);
    return getAllFolders();
  }
}
async function deleteFolderFS(id) {
  const ref = userFoldersRef();
  if (!ref) return deleteFolder(id);

  // R4 (folder-bug-fix): the previous version was an unguarded sequence
  //     getAllNotesFS() → for each note, saveNoteFS(folderId:null)
  //     → ref.doc(id).delete() → deleteFolder(id)
  // Any single step could throw — getAllNotesFS hitting a transient
  // Firestore error, saveNoteFS rejecting on a 1MB-doc edge case,
  // ref.doc().delete() on a network hiccup — and the function would
  // throw out before reaching deleteFolder(id), leaving the folder
  // visible in IDB. Since deleteFolderConfirm had no try/catch, the
  // error was also invisible to the user.
  //
  // New shape: each phase isolated. If notes-detach fails we still
  // attempt to delete the folder; if the Firestore delete fails we
  // still purge IDB so the user at least sees the folder disappear
  // locally and can refresh to retry server-side. Errors are logged
  // and re-thrown so the caller can show a toast.
  let firstErr = null;

  // Phase 1: detach notes from the doomed folder. Per-note failures
  // are collected but don't block the rest — orphan notes-still-tagged
  // are a smaller problem than a folder that can't be deleted.
  try {
    const notes = await getAllNotesFS();
    for (const note of notes.filter(n => n.folderId === id)) {
      try {
        await saveNoteFS(Object.assign({}, note, { folderId: null }));
      } catch (e) {
        console.warn('[deleteFolderFS] note detach failed for', note.id, e.message);
        if (!firstErr) firstErr = e;
      }
    }
  } catch (e) {
    console.warn('[deleteFolderFS] getAllNotesFS failed, proceeding to delete anyway:', e.message);
    if (!firstErr) firstErr = e;
  }

  // Phase 2: delete the Firestore doc. .delete() is idempotent (no-op
  // on missing doc) so this is safe even if the folder was IDB-only.
  try {
    await ref.doc(id).delete();
  } catch (e) {
    console.error('[deleteFolderFS] Firestore delete failed:', e.message);
    if (!firstErr) firstErr = e;
  }

  // Phase 3: purge from IDB *unconditionally*. Without this, a Firestore
  // failure above would leave the folder visible after refresh — confusing.
  // Worst case: server-side still has the doc but UI shows it gone; next
  // login sync will resurface it, which is recoverable. Better than leaving
  // the user staring at a folder that won't disappear.
  try {
    await deleteFolder(id);
  } catch (e) {
    console.error('[deleteFolderFS] IDB purge failed:', e.message);
    if (!firstErr) firstErr = e;
  }

  if (firstErr) throw firstErr;
}
async function renameFolderFS(id, newName, color, lectureCode) {
  const ref = userFoldersRef();
  if (!ref) return renameFolder(id, newName, color);

  // M1: sanitize color against whitelist before persisting
  const safeColor = color !== undefined ? sanitizeFolderColor(color) : undefined;
  // R3: lectureCode is the per-folder match key for study-room activity
  // sync. Stored as-is (no charset enforcement here — sync side normalizes
  // before comparing). Pass `null` to clear it, or `undefined` to leave it
  // alone for callers that don't touch the code field.
  const codePatch = lectureCode !== undefined
    ? { lectureCode: (lectureCode && String(lectureCode).trim()) || null }
    : {};

  // R4 (folder-bug-fix): previously this function did
  //     `const doc = await ref.doc(id).get(); if (!doc.exists) return;`
  // which silently no-op'd whenever the user clicked rename on a folder
  // that existed in IndexedDB but had no matching Firestore doc — a state
  // that can arise from offline creation, partial sync, or stale local
  // mirror. The modal would close, the home view would refresh, and the
  // user would see the old name unchanged with no error toast.
  //
  // Now we upsert: read the existing doc if any, merge the patch, and
  // write back with `set({merge:true})` which creates the doc if missing.
  // We also mirror the change to IndexedDB *immediately* (instead of
  // relying on the next getAllFoldersFS to re-mirror) so renderHomeView()
  // sees the new name on first call after the Firestore round-trip.
  let existing = {};
  try {
    const doc = await ref.doc(id).get();
    if (doc.exists) existing = doc.data() || {};
  } catch (e) {
    console.warn('[renameFolderFS] read failed, will upsert anyway:', e.message);
  }

  const updated = Object.assign({}, existing, { id, name: newName },
    safeColor !== undefined ? { color: safeColor } : {},
    codePatch);

  // createdAt fallback for upsert-of-missing-doc case so listing/sorting works.
  if (!updated.createdAt) updated.createdAt = new Date().toISOString();

  await ref.doc(id).set(updated, { merge: true });

  // Mirror to IDB so renderHomeView() (which reads IDB) sees new name
  // without waiting for the next getAllFoldersFS Firestore round-trip.
  try {
    await saveFolder(updated);
  } catch (e) {
    console.warn('[renameFolderFS] IDB mirror failed (non-fatal):', e.message);
  }

  return updated;
}
async function updateNoteOrderFS(orderedIds) {
  _invalidateNotesCache();
  // Always update IndexedDB so renderHomeView() (which reads IDB) sees the new order
  await updateNoteOrder(orderedIds);
  const ref = userNotesRef();
  if (!ref) return;
  const batch = db.batch();
  orderedIds.forEach((id, sortIndex) => {
    batch.update(ref.doc(id), stripFirestoreNotePayloads({ sortOrder: sortIndex }));
  });
  await batch.commit();
}

async function migrateLocalToFirestore() {
  if (!currentUser) return;
  const migrated = localStorage.getItem('fs_migrated_' + currentUser.uid);
  if (migrated) return;
  try {
    const localNotes = await getAllNotes();
    const localFolders = await getAllFolders();
    if (localFolders.length > 0 || localNotes.length > 0) {
      showToast('📦 로컬 노트를 클라우드로 이전 중...');
      for (const folder of localFolders) {
        try { await saveFolderFS(folder); } catch (e) { console.warn('Folder migration skip:', e); }
      }
      let ok = 0;
      for (const note of localNotes) {
        if (!note.title?.trim() || !(note.notesText || note.markdownContent)?.trim()) {
          console.warn('[migrate] skipped empty legacy note', note.id);
          continue;
        }
        try { await saveNoteFS(note); ok++; } catch (e) { console.warn('Note migration skip:', note.id, e.message); }
      }
      showSuccessToast('☁️ ' + ok + '/' + localNotes.length + '개 노트 이전 완료');
    }
  } catch (e) {
    console.error('Migration error:', e);
  }
  // Always set flag so we don't retry
  localStorage.setItem('fs_migrated_' + currentUser.uid, 'true');
}

async function syncNotesOnLogin() {
  if (!currentUser) return;
  const synced = sessionStorage.getItem('synced_' + currentUser.uid);
  if (synced) return;
  try {
    const ref = userNotesRef();
    const fRef = userFoldersRef();
    if (!ref || !fRef) return;

    const [localNotes, localFolders, fsNotesSnap, fsFoldersSnap] = await Promise.all([
      getAllNotes(), getAllFolders(),
      ref.get(), fRef.get()
    ]);

    const fsNotes = fsNotesSnap.docs.map(d => d.data());
    const fsFolders = fsFoldersSnap.docs.map(d => d.data());
    const fsNoteMap = Object.fromEntries(fsNotes.map(n => [n.id, n]));
    const localNoteMap = Object.fromEntries(localNotes.map(n => [n.id, n]));
    const fsFolderMap = Object.fromEntries(fsFolders.map(f => [f.id, f]));
    const localFolderMap = Object.fromEntries(localFolders.map(f => [f.id, f]));

    // 1. Process deleted notes tracked in localStorage
    const deletedKey = 'deleted_notes_' + currentUser.uid;
    const deletedIds = JSON.parse(localStorage.getItem(deletedKey) || '[]');
    const successfulDeletes = [];
    for (const did of deletedIds) {
      try {
        await ref.doc(did).delete();
        successfulDeletes.push(did);
      } catch(e) {
        console.warn('Firestore delete failed, will retry next sync:', did, e);
      }
    }
    // Only remove successfully deleted IDs; keep failed ones for next sync
    if (successfulDeletes.length === deletedIds.length) {
      localStorage.removeItem(deletedKey);
    } else {
      const remaining = deletedIds.filter(id => !successfulDeletes.includes(id));
      localStorage.setItem(deletedKey, JSON.stringify(remaining));
    }
    // Purge any zombie notes that exist in IndexedDB despite being on the delete list
    for (const did of deletedIds) {
      try { await deleteNote(did); } catch(e) {}
    }
    const deletedSet = new Set(deletedIds);

    // 2. Firestore에 있는데 로컬에 없으면 → 로컬에 저장 (단, 삭제 목록에 없는 경우만)
    for (const fsNote of fsNotes) {
      if (deletedSet.has(fsNote.id)) continue;
      if (!localNoteMap[fsNote.id]) {
        // Skip ghost notes from Firestore (empty title AND empty content)
        const _hasTitle = fsNote.title && fsNote.title.trim();
        const _hasContent = (fsNote.notesText || fsNote.markdownContent) &&
                            (fsNote.notesText || fsNote.markdownContent).trim();
        if (!_hasTitle && !_hasContent) {
          console.warn('[sync] skipping ghost note from Firestore:', fsNote.id);
          continue;
        }
        await saveNote(fsNote);
      }
    }
    for (const fsFolder of fsFolders) {
      if (!localFolderMap[fsFolder.id]) await saveFolder(fsFolder);
    }

    // 3. 로컬에 있는데 Firestore에 없으면 → Firestore에 업로드
    // HOTFIX: disabled to prevent ghost note resurrection
    // for (const ln of localNotes) {
    //   if (deletedSet.has(ln.id)) continue;
    //   if (!fsNoteMap[ln.id]) {
    //     try { await saveNoteFS(ln); } catch (e) { console.warn('Sync upload skip:', ln.id, e.message); }
    //   }
    // }
    // for (const lf of localFolders) {
    //   if (!fsFolderMap[lf.id]) {
    //     try { await saveFolderFS(lf); } catch (e) { console.warn('Folder sync skip:', e.message); }
    //   }
    // }

    // 4. 둘 다 있으면 → updatedAt 비교
    for (const fsNote of fsNotes) {
      if (deletedSet.has(fsNote.id)) continue;
      const local = localNoteMap[fsNote.id];
      if (!local) continue;
      const fsTime = fsNote.updatedAt || '';
      const localTime = local.updatedAt || '';
      if (fsTime > localTime) {
        const merged = Object.assign({}, fsNote);
        if (typeof local.notesHtml === 'string') {
          merged.notesHtml = _mergeMarkerImageNodes(fsNote.notesHtml, local.notesHtml);
        }
        await saveNote(merged);
      } else if (localTime > fsTime) {
        // HOTFIX: disabled to prevent ghost note resurrection
        // try { await saveNoteFS(local); } catch (e) { console.warn('Sync push skip:', e.message); }
      }
    }

    // 5. Sync quiz results from Firestore → IndexedDB (merge only, never delete)
    try {
      const qrSnap = await firebase.firestore()
        .collection('users').doc(currentUser.uid)
        .collection('quizResults').get();
      const idbQr = await openDB();
      for (const doc of qrSnap.docs) {
        const fsQr = doc.data();
        await new Promise((res, rej) => {
          const tx  = idbQr.transaction('quizResults', 'readwrite');
          const req = tx.objectStore('quizResults').get(fsQr.id);
          req.onsuccess = e => {
            const local = e.target.result;
            // Add if absent; keep the newer record if both exist
            if (!local || (fsQr.timestamp && local.timestamp && fsQr.timestamp > local.timestamp)) {
              tx.objectStore('quizResults').put(fsQr);
            }
            tx.oncomplete = () => res();
            tx.onerror    = ev => rej(ev.target.error);
          };
          req.onerror = ev => rej(ev.target.error);
        }).catch(e => console.warn('quizResult IDB merge failed:', fsQr.id, e));
      }
    } catch (e) {
      console.warn('Quiz results sync failed (non-critical):', e);
    }

    sessionStorage.setItem('synced_' + currentUser.uid, 'true');
  } catch (e) {
    console.error('Sync error:', e);
  }
}

// getUserUsage, incrementUsage, canAnalyze, setPaidPlan moved to /js/payment.js

async function uploadSlideImages(noteId, slideImages) {
  if (!currentUser || !slideImages || !slideImages.length) return [];
  const urls = new Array(slideImages.length);
  for (let i = 0; i < slideImages.length; i++) {
    if (!(i in slideImages)) continue;
    const img = slideImages[i];
    if (!img) {
      urls[i] = img;
      continue;
    }
    const source = _syncImageSource(img);
    if (source && source.kind === 'remote') {
      urls[i] = source.value;
      continue;
    }
    const path = 'users/' + currentUser.uid + '/notes/' + noteId + '/slide_' + i + '.png';
    const ref = storage.ref(path);
    let data;
    const contentType = source?.mimeType || img.mimeType || 'image/png';
    if (source?.representation === 'blob') {
      if (typeof ref.put !== 'function') throw new Error('Storage fixture cannot upload Blob images');
      await ref.put(source.blob, { contentType });
    } else {
      data = source?.value || (typeof img === 'object' ? img.imageBase64 : img);
      if (typeof data !== 'string') throw new Error('Unsupported local image payload');
      if (data.includes('base64,')) data = data.split('base64,')[1];
      data = data.replace(/-/g, '+').replace(/_/g, '/');
      if (data.length % 4) data += '='.repeat(4 - (data.length % 4));
      await ref.putString(data, 'base64', { contentType });
    }
    urls[i] = await ref.getDownloadURL();
  }
  return urls;
}

async function deleteSlideImages(noteId) {
  if (!currentUser) return;
  const prefix = 'users/' + currentUser.uid + '/notes/' + noteId + '/';
  try {
    const listRef = storage.ref(prefix);
    const list = await listRef.listAll();
    await Promise.all(list.items.map(item => item.delete()));
  } catch (e) {
    console.error('deleteSlideImages error:', e);
  }
}

// 🔴2: recordings live at a flat users/{uid}/recordings/... path, which the
// notes/{noteId}/ prefix sweep in deleteSlideImages() can never reach. The note
// record carries the pointer, so cleanup has to route through audioStoragePath.
//
// Scope is deliberate: only the owner's own upload is removed. The group copy
// made by api/group-create.js belongs to the lecture group, not to this note —
// deleting a note must never destroy material other members depend on. The
// prefix guard below is what enforces that.
async function deleteNoteAudio(path) {
  if (!currentUser || typeof path !== 'string' || !path) return;
  if (!path.startsWith('users/' + currentUser.uid + '/recordings/')) return;
  try {
    await storage.ref(path).delete();
  } catch (e) {
    // deleteNoteAudio best-effort: an audio delete failure (already gone,
    // offline, permission) must never block the note delete itself.
    console.warn('deleteNoteAudio failed (best-effort):', e && e.message);
  }
}

async function getNextSortOrder(folderId, excludeId = null) {
  // B3 fix: Use a timestamp-based sortOrder to avoid race conditions on
  // concurrent folder moves. The previous Math.max(...) + 1 logic required
  // a read-then-write that two simultaneous moves could collide on,
  // returning the same value and producing duplicate sortOrder entries.
  //
  // Date.now() gives millisecond uniqueness, and since notes sort ASC by
  // sortOrder, a freshly-added note (large timestamp) lands at the end of
  // its folder — matching the previous "max + 1" intent. Existing
  // small-integer sortOrders from manual drag-reorder still sort first.
  // The folderId/excludeId args are kept for API compatibility but unused.
  return Date.now();
}
