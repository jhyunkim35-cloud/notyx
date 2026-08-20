// IndexedDB layer. Pure local storage for notes, folders, quiz results.
// Depends on: constants.js (DB_NAME, DB_VERSION, uuidv4, getNextSortOrder).

// Migration ladder. Steps are keyed by the DB_VERSION they land on and run in
// order for every version the installed DB is behind (e.oldVersion).
//
// Why this shape: the previous handler wrapped createIndex() inside
// `if (!db.objectStoreNames.contains(store))`, so bumping DB_VERSION was a
// silent no-op for anyone who already had the stores — new installs got the
// index, existing users never did, and the schema forked permanently. Index
// creation now goes through the live upgrade transaction instead, guarded by
// indexNames so each step is idempotent on both paths.
//
// Never drop a store or an index here — that is data loss, not migration.
function ensureStore(e, name, keyPath = 'id') {
  const db = e.target.result;
  if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
}
function ensureIndex(e, name, indexName, keyPath) {
  const store = e.target.transaction.objectStore(name);
  if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, { unique: false });
}

const IDB_MIGRATIONS = [
  {
    version: 5,
    // Baseline + v5 in one idempotent step: create any missing store, then
    // reconcile EVERY declared index. v1~v4 installs may be missing some (that
    // is the defect above), and notes.updatedAt is new in v5 — getAllNotes()
    // has always sorted by it. Running this on a fresh install and on a v4
    // install must produce the identical schema.
    run(e) {
      ensureStore(e, 'notes');
      ensureStore(e, 'folders');
      ensureStore(e, 'quizResults');
      ensureStore(e, 'srsCards');
      ensureIndex(e, 'notes',       'folderId',       'folderId');
      ensureIndex(e, 'notes',       'createdAt',      'createdAt');
      ensureIndex(e, 'notes',       'title',          'title');
      ensureIndex(e, 'notes',       'updatedAt',      'updatedAt');
      ensureIndex(e, 'folders',     'name',           'name');
      ensureIndex(e, 'quizResults', 'noteId',         'noteId');
      ensureIndex(e, 'quizResults', 'timestamp',      'timestamp');
      ensureIndex(e, 'srsCards',    'folderId',       'folderId');
      ensureIndex(e, 'srsCards',    'nextReviewDate', 'nextReviewDate');
    },
  },
  {
    version: 6,
    run(e) {
      ensureStore(e, 'noteImages', 'noteId');
      const transaction = e.target.transaction;
      const notes = transaction.objectStore('notes');
      const noteImages = transaction.objectStore('noteImages');
      const cursorRequest = notes.openCursor();

      cursorRequest.onerror = () => transaction.abort();
      cursorRequest.onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;

        try {
          const detached = detachNoteImages(cursor.value);
          if (detached.imageRecord.images.length > 0) noteImages.put(detached.imageRecord);
          cursor.update(detached.note);
        } catch (error) {
          transaction.abort();
          return;
        }
        cursor.continue();
      };
    },
  },
];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      for (const step of IDB_MIGRATIONS) {
        if (e.oldVersion < step.version) step.run(e);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveQuizResult(result) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('quizResults', 'readwrite');
    tx.objectStore('quizResults').put(result);
    tx.oncomplete = () => {
      resolve(result);
      // Fire-and-forget Firestore write — don't block quiz flow
      const user = firebase.auth().currentUser;
      if (user) {
        firebase.firestore()
          .collection('users').doc(user.uid)
          .collection('quizResults').doc(result.id)
          .set(result, { merge: true })
          .catch(e => console.warn('Firestore quizResult save failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function getQuizResultsByNote(noteId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction('quizResults', 'readonly');
    const store   = tx.objectStore('quizResults');
    const index   = store.index('noteId');
    const req     = index.getAll(noteId);
    req.onsuccess = e => {
      const results = e.target.result || [];
      results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      resolve(results);
    };
    req.onerror = e => reject(e.target.error);
  });
}

function saveNoteTransaction(db, note, requestedRecord) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'noteImages'], 'readwrite');
    const notes = tx.objectStore('notes');
    const noteImages = tx.objectStore('noteImages');
    let previousNote;
    let previousImageRecord;
    let lightweightRecord;
    let failure;
    let settled = false;
    let noteReady = false;
    let imageReady = false;

    function abortWith(error) {
      failure = error || new Error('Note transaction aborted');
      try {
        tx.abort();
      } catch (_) {
        if (!settled) {
          settled = true;
          reject({ error: failure, previousNote, previousImageRecord });
        }
      }
    }

    function prepare() {
      if (!noteReady || !imageReady || settled) return;
      try {
        const mergedRecord = Object.assign(
          { folderId: null, createdAt: new Date().toISOString() },
          previousNote || {},
          requestedRecord,
        );
        const detached = detachNoteImages(
          Object.assign({}, note, { id: mergedRecord.id }),
          previousImageRecord,
        );
        lightweightRecord = Object.assign({}, mergedRecord, detached.note);
        if (detached.imageRecord.images.length > 0) noteImages.put(detached.imageRecord);
        else noteImages.delete(mergedRecord.id);
        notes.put(lightweightRecord);
      } catch (error) {
        abortWith(error);
      }
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve({ record: lightweightRecord, previousNote, previousImageRecord });
    };
    tx.onerror = event => {
      if (!failure) failure = event.target.error || tx.error;
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject({
        error: failure || tx.error || new Error('Note transaction aborted'),
        previousNote,
        previousImageRecord,
      });
    };

    const noteRequest = notes.get(requestedRecord.id);
    noteRequest.onsuccess = event => {
      previousNote = event.target.result;
      noteReady = true;
      prepare();
    };
    noteRequest.onerror = event => abortWith(event.target.error);

    const imageRequest = noteImages.get(requestedRecord.id);
    imageRequest.onsuccess = event => {
      previousImageRecord = event.target.result;
      imageReady = true;
      prepare();
    };
    imageRequest.onerror = event => abortWith(event.target.error);
  });
}

function saveNoteLightweightAfterQuota(db, requestedRecord, previousNote) {
  const incomingLightweight = detachNoteImages(requestedRecord).note;
  const fallbackRecord = Object.assign(
    { folderId: null, createdAt: new Date().toISOString() },
    previousNote || {},
    requestedRecord,
  );
  const imageFields = ['extractedImages', 'slideImages', 'notesHtml'];
  for (const field of imageFields) {
    if (previousNote && Object.prototype.hasOwnProperty.call(previousNote, field)) {
      fallbackRecord[field] = noteImageClone(previousNote[field]);
    } else if (Object.prototype.hasOwnProperty.call(incomingLightweight, field)) {
      fallbackRecord[field] = incomingLightweight[field];
    } else {
      delete fallbackRecord[field];
    }
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(fallbackRecord);
    tx.oncomplete = () => resolve(Object.assign({}, fallbackRecord, {
      saveStatus: 'image-degraded',
      degradation: { resource: 'noteImages', reason: 'quota' },
    }));
    tx.onerror = event => reject(event.target.error || tx.error);
    tx.onabort = event => reject(event.target.error || tx.error || new Error('Lightweight note save aborted'));
  });
}

async function saveNote(note) {
  // ───── GHOST GUARD ─────
  // saveNote is the only IndexedDB writer for notes. Reject anything that
  // would render as "제목없음 0자" in the UI — empty title AND empty body.
  // Without this, multiple legitimate-looking call sites could (and did)
  // produce empty rows by passing partial data with no id. Silent log so
  // we can trace the offender; never throw — callers are not error-handled.
  const _isNotion = note && note.type === 'notion';
  const _hasTitle = note && note.title && note.title.trim();
  const _hasBody  = note && (
    (_isNotion ? (note.markdownContent || '').trim() : (note.notesText || '').trim())
  );
  if (!_hasTitle && !_hasBody) {
    console.warn('🔴 [saveNote] refused empty note', {
      id: note?.id || '(no id — would have generated new uuid)',
      title: note?.title,
      type: note?.type,
      keys: note ? Object.keys(note).sort() : null,
    });
    console.trace('[saveNote] empty-note call stack');
    return note; // honour the API shape but don't write
  }
  // ───── END GHOST GUARD ─────

  const db  = await openDB();
  const now = new Date().toISOString();
  // Assign sortOrder for brand-new notes that don't already have one
  let sortOrder = note.sortOrder;
  if (sortOrder === undefined && !note.id) {
    sortOrder = await getNextSortOrder(note.folderId ?? null);
  }
  const requestedRecord = Object.assign({}, note, {
    id:        note.id || uuidv4(),
    updatedAt: now,
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  });
  try {
    const result = await saveNoteTransaction(db, note, requestedRecord);
    db.close();
    return result.record;
  } catch (failure) {
    const error = failure && failure.error ? failure.error : failure;
    if (!isQuotaExceededError(error)) {
      db.close();
      throw error;
    }
    try {
      return await saveNoteLightweightAfterQuota(db, requestedRecord, failure.previousNote);
    } finally {
      db.close();
    }
  }
}

async function getNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'noteImages'], 'readonly');
    const noteRequest = tx.objectStore('notes').get(id);
    const imageRequest = tx.objectStore('noteImages').get(id);
    let note;
    let imageRecord;
    noteRequest.onsuccess = event => { note = event.target.result; };
    imageRequest.onsuccess = event => { imageRecord = event.target.result; };
    tx.oncomplete = () => {
      db.close();
      if (!note) {
        resolve(note);
        return;
      }
      hydrateNoteImages(note, imageRecord).then(resolve, reject);
    };
    noteRequest.onerror = event => reject(event.target.error);
    imageRequest.onerror = event => reject(event.target.error);
    tx.onerror = event => reject(event.target.error || tx.error);
    tx.onabort = event => reject(event.target.error || tx.error || new Error('Note read aborted'));
  });
}

async function getAllNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('notes', 'readonly').objectStore('notes').getAll();
    req.onsuccess = e => {
      const notes = e.target.result.map(note => stripNoteImagePayloads(note));
      db.close();
      resolve(notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    };
    req.onerror   = e => reject(e.target.error);
  });
}

async function updateNoteOrder(orderedIds) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    let i = 0;
    function next() {
      if (i >= orderedIds.length) return;
      const sortIndex = i++;
      const req = store.get(orderedIds[sortIndex]);
      req.onsuccess = () => {
        if (req.result) store.put(Object.assign({}, req.result, { sortOrder: sortIndex }));
        next();
      };
      req.onerror = e => reject(e.target.error);
    }
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
    next();
  });
}

async function deleteNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'noteImages'], 'readwrite');
    tx.objectStore('notes').delete(id);
    tx.objectStore('noteImages').delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
      // Fire-and-forget Firestore cleanup — note + all its quiz results
      const user = firebase.auth().currentUser;
      if (user) {
        const userFs = firebase.firestore().collection('users').doc(user.uid);
        userFs.collection('notes').doc(id)
          .delete()
          .catch(e => console.warn('Firestore note delete failed:', e));
        // Delete quiz results whose noteId matches the deleted note
        userFs.collection('quizResults').where('noteId', '==', id).get()
          .then(snap => snap.forEach(doc => doc.ref.delete()))
          .catch(e => console.warn('Firestore quizResults cleanup failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function searchNotes(query) {
  const all = await getAllNotes();
  const q   = query.toLowerCase();
  return all.filter(n => (n.title || '').toLowerCase().includes(q) || (n.notesText || '').toLowerCase().includes(q));
}

async function saveFolder(folder) {
  const db  = await openDB();
  const now = new Date().toISOString();
  const record = Object.assign({ createdAt: now }, folder, { id: folder.id || uuidv4() });
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror    = e => reject(e.target.error);
    tx.onabort    = e => reject(e.target.error);
  });
}

async function getAllFolders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('folders', 'readonly').objectStore('folders').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteFolder(id) {
  const db = await openDB();
  // Move notes in this folder to uncategorized
  const all = await getAllNotes();
  const inFolder = all.filter(n => n.folderId === id);
  const tx = db.transaction(['notes', 'folders'], 'readwrite');
  for (const note of inFolder) {
    tx.objectStore('notes').put(Object.assign({}, note, { folderId: null }));
  }
  tx.objectStore('folders').delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
      // Also delete from Firestore — fire-and-forget safety net
      const user = firebase.auth().currentUser;
      if (user) {
        firebase.firestore()
          .collection('users').doc(user.uid)
          .collection('folders').doc(id)
          .delete()
          .catch(e => console.warn('Firestore folder delete failed:', e));
      }
    };
    tx.onerror    = e => reject(e.target.error);
  });
}

async function renameFolder(id, newName, color) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction('folders', 'readwrite').objectStore('folders');
    const get = store.get(id);
    get.onsuccess = () => {
      const rec = Object.assign({}, get.result, { name: newName }, color !== undefined ? { color } : {});
      const put = store.put(rec);
      put.onsuccess = () => resolve(rec);
      put.onerror   = e => reject(e.target.error);
    };
    get.onerror = e => reject(e.target.error);
  });
}

async function getStorageSize() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage } = await navigator.storage.estimate();
    return usage || 0;
  }
  // Fallback: rough estimate from note content lengths
  const notes = await getAllNotesFS();
  return notes.reduce((sum, n) => sum + JSON.stringify(n).length, 0);
}

/* ═══════════════════════════════════════════════
   Clear all storage
═══════════════════════════════════════════════ */
async function clearAllStorage() {
  if (!await appConfirm('모든 저장된 노트와 폴더를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.', { danger: true })) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['notes', 'folders', 'noteImages'], 'readwrite');
      tx.objectStore('notes').clear();
      tx.objectStore('folders').clear();
      tx.objectStore('noteImages').clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror    = e => reject(e.target.error);
    });
    currentNoteId = null;
    showSuccessToast('🗑 저장소 초기화 완료');
    renderHomeView();
  } catch (e) {
    showToast(`❌ 초기화 실패: ${e.message}`);
  }
}
