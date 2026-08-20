const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadContext() {
  const context = {
    Blob,
    atob,
    btoa,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    window: {},
  };
  for (const file of ['note_images.js', 'firestore_sync.js', 'notes_crud.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  return context;
}

function makeFirestore(context, writes, remoteDocs = [], { deleteError = null, updateError = null } = {}) {
  const notes = new Map(remoteDocs.map(note => [note.id, note]));
  let reads = 0;
  const noteRef = {
    doc(id) {
      return {
        async get() {
          reads += 1;
          const data = notes.get(id);
          return data ? { exists: true, data: () => data } : { exists: false, data: () => ({}) };
        },
        async set(payload) {
          writes.push({ method: 'set', id, payload });
          notes.set(id, Object.assign({}, notes.get(id), payload));
        },
        async update(payload) {
          if (updateError) throw updateError;
          writes.push({ method: 'update', id, payload });
          notes.set(id, Object.assign({}, notes.get(id), payload));
        },
        async delete() {
          if (deleteError) throw deleteError;
          notes.delete(id);
        },
      };
    },
    async get() {
      reads += 1;
      return { docs: [...notes.values()].map(data => ({ data: () => data })) };
    },
  };
  const folderDocs = new Map();
  const folders = {
    doc(id) {
      return {
        async get() {
          const data = folderDocs.get(id);
          return data ? { exists: true, data: () => data } : { exists: false, data: () => ({}) };
        },
        async set(payload) {
          writes.push({ method: 'folder-set', id, payload });
          folderDocs.set(id, Object.assign({}, folderDocs.get(id), payload));
        },
        async delete() { folderDocs.delete(id); },
      };
    },
    orderBy: () => ({ get: async () => ({ docs: [...folderDocs.values()].map(data => ({ data: () => data })) }) }),
    async get() { return { docs: [...folderDocs.values()].map(data => ({ data: () => data })) }; },
  };
  context.db = {
    collection(name) {
      if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
      return {
        doc() {
          return {
            collection(child) {
              return child === 'notes' ? noteRef : folders;
            },
          };
        },
      };
    },
  };
  return { noteRef, getReads: () => reads };
}

function assertNoFirestorePayload(value, label = 'payload', seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object') {
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /^data:image\//i, `${label} contains a data URL`);
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  assert.equal(value instanceof Blob, false, `${label} contains a Blob`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFirestorePayload(item, `${label}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'notesHtml', `${label} contains notesHtml`);
    assert.notEqual(key, 'extractedImages', `${label} contains extractedImages`);
    assert.notEqual(key, 'slideImages', `${label} contains slideImages`);
    assert.notEqual(key, 'imageBase64', `${label} contains imageBase64`);
    assert.notEqual(key, 'base64', `${label} contains base64`);
    assert.notEqual(key, 'blob', `${label} contains blob`);
    assertNoFirestorePayload(child, `${label}.${key}`, seen);
  }
}

function makeStorage(uploaded, shouldFail = false) {
  let nextUrl = 0;
  return {
    ref(storagePath) {
      return {
        async putString(data, encoding, options) {
          uploaded.push({ storagePath, data, encoding, contentType: options.contentType });
          if (shouldFail) throw new Error('fixture storage upload failure');
        },
        async getDownloadURL() {
          nextUrl += 1;
          return `https://storage.example.test/upload-${nextUrl}.png`;
        },
      };
    },
  };
}

async function run() {
  const context = loadContext();
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const jpeg = 'data:image/jpeg;base64,/9j/';
  const remoteA = 'https://cdn.example.test/a.png';
  const remoteB = 'https://cdn.example.test/b.jpg';

  const stripped = context.stripFirestoreNotePayloads({
    id: 'strip-me',
    title: 'Payload-safe',
    notesText: 'Keep text',
    notesHtml: `<p>Must not persist HTML</p><img src="${png}">`,
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }, { imageBase64: remoteA, mimeType: 'url' }],
    slideImages: [{ imageBase64: new Blob(['raw']), mimeType: 'image/png' }],
    slideImageUrls: [remoteA, , remoteB],
    customMetadata: { keep: true, blob: new Blob(['nested']), dataUrl: png },
  });
  assert.equal(stripped.notesHtml, undefined, 'Firestore must not receive notesHtml');
  assert.equal(stripped.extractedImages, undefined, 'Firestore must not receive runtime extractedImages');
  assert.equal(stripped.slideImages, undefined, 'Firestore must not receive slideImages');
  assert.equal(stripped.slideImageUrls.length, 3, 'aligned URL references keep their length');
  assert.equal(stripped.slideImageUrls[0], remoteA);
  assert.equal(stripped.slideImageUrls[1], null, 'Firestore-facing sparse URL holes normalize to null');
  assert.equal(stripped.slideImageUrls[2], remoteB);
  assert.equal(stripped.customMetadata.keep, true);
  assert.equal('blob' in stripped.customMetadata, false, 'nested Blobs are stripped');
  assert.equal('dataUrl' in stripped.customMetadata, false, 'nested data URLs are stripped');

  const writes = [];
  makeFirestore(context, writes);
  context.currentUser = { uid: 'sync-user' };
  const localSaves = [];
  context.saveNote = async note => {
    localSaves.push(note);
    return note;
  };
  const uploaded = [];
  context.storage = makeStorage(uploaded);

  await context.saveNoteFS({
    id: 'url-only',
    title: 'URL-only note',
    notesText: 'No upload is needed.',
    extractedImages: [
      { slideNumber: 1, imageBase64: remoteA, mimeType: 'url', fileName: 'a.png' },
      ,
      { slideNumber: 3, imageBase64: remoteB, mimeType: 'url', fileName: 'b.jpg' },
    ],
    slideImageUrls: [remoteA, , remoteB],
  });
  assert.equal(uploaded.length, 0, 'URL-only notes must not re-upload');
  assert.equal(localSaves.at(-1).slideImageUrls[1], undefined, 'URL-only sparse holes remain aligned');
  assert.equal(writes.at(-1).payload.extractedImages, undefined);
  assert.equal(writes.at(-1).payload.notesHtml, undefined);

  uploaded.length = 0;
  localSaves.length = 0;
  writes.length = 0;
  await context.saveNoteFS({
    id: 'mixed-images',
    title: 'Mixed images',
    notesText: 'Upload local entries only.',
    extractedImages: [
      { slideNumber: 1, imageBase64: png, mimeType: 'image/png', fileName: 'one.png' },
      { slideNumber: 2, imageBase64: remoteA, mimeType: 'url', fileName: 'two.png' },
      ,
      { slideNumber: 4, imageBase64: jpeg, mimeType: 'image/jpeg', fileName: 'four.jpg' },
    ],
    slideImageUrls: [null, remoteA, , null],
  });
  assert.deepEqual(uploaded.map(item => [item.storagePath, item.contentType]), [
    ['users/sync-user/notes/mixed-images/slide_0.png', 'image/png'],
    ['users/sync-user/notes/mixed-images/slide_3.png', 'image/jpeg'],
  ], 'only local entries upload with their MIME metadata');
  const mergedLocal = localSaves.at(-1);
  assert.equal(mergedLocal.extractedImages[0].imageBase64, 'https://storage.example.test/upload-1.png');
  assert.equal(mergedLocal.extractedImages[0].mimeType, 'image/png', 'uploaded aliases retain original MIME metadata');
  assert.equal(mergedLocal.extractedImages[1].imageBase64, remoteA, 'existing URL remains untouched');
  assert.equal(2 in mergedLocal.extractedImages, false, 'extracted image sparsity survives');
  assert.equal(mergedLocal.extractedImages[3].imageBase64, 'https://storage.example.test/upload-2.png');
  assert.equal(mergedLocal.slideImageUrls[0], 'https://storage.example.test/upload-1.png');
  assert.equal(mergedLocal.slideImageUrls[1], remoteA);
  assert.equal(2 in mergedLocal.slideImageUrls, false, 'returned URLs keep sparse slideImageUrls holes');
  assert.equal(mergedLocal.slideImageUrls[3], 'https://storage.example.test/upload-2.png');
  assert.equal(writes.at(-1).payload.extractedImages, undefined);
  assert.equal(writes.at(-1).payload.slideImages, undefined);
  assert.equal(writes.at(-1).payload.notesHtml, undefined);
  assert.equal(writes.at(-1).payload.slideImageUrls[0], mergedLocal.slideImageUrls[0]);
  assert.equal(writes.at(-1).payload.slideImageUrls[1], remoteA);
  assert.equal(writes.at(-1).payload.slideImageUrls[2], null, 'Firestore sparse arrays normalize holes to null');
  assert.equal(writes.at(-1).payload.slideImageUrls[3], mergedLocal.slideImageUrls[3]);
  assertNoFirestorePayload(writes.at(-1).payload, 'mixed Firestore write');

  const sharedPng = 'data:image/png;base64,iVBORw0KGgo=';
  const distinctJpeg = 'data:image/jpeg;base64,/9j/';
  const distinctGif = 'data:image/gif;base64,R0lGODlh';
  const dualSlides = new Array(5);
  dualSlides[0] = { slideNumber: 1, imageBase64: sharedPng, mimeType: 'image/png', fileName: 'shared-slide.png' };
  dualSlides[2] = { slideNumber: 3, imageBase64: distinctJpeg, mimeType: 'image/jpeg', fileName: 'slide.jpg' };
  dualSlides[3] = { slideNumber: 4, imageBase64: remoteA, mimeType: 'image/webp', fileName: 'remote.webp' };
  const dualExtracted = new Array(5);
  dualExtracted[0] = { slideNumber: 1, imageBase64: sharedPng, mimeType: 'image/png', fileName: 'shared-extracted.png' };
  dualExtracted[3] = { slideNumber: 4, imageBase64: remoteA, mimeType: 'image/webp', fileName: 'remote-copy.webp' };
  dualExtracted[4] = { slideNumber: 5, imageBase64: distinctGif, mimeType: 'image/gif', fileName: 'extra.gif' };
  const dualUrls = new Array(5);
  dualUrls[0] = null;
  dualUrls[2] = remoteB;
  dualUrls[3] = remoteA;
  uploaded.length = 0;
  localSaves.length = 0;
  writes.length = 0;
  context.storage = makeStorage(uploaded);
  await context.saveNoteFS({
    id: 'dual-aliases',
    title: 'Dual aliases',
    notesText: 'Both image aliases must sync.',
    slideImages: dualSlides,
    extractedImages: dualExtracted,
    slideImageUrls: dualUrls,
  });
  assert.equal(uploaded.length, 3, 'shared local sources across aliases upload once');
  assert.deepEqual(uploaded.map(item => [item.storagePath, item.contentType]), [
    ['users/sync-user/notes/dual-aliases/slide_0.png', 'image/png'],
    ['users/sync-user/notes/dual-aliases/slide_2.png', 'image/jpeg'],
    ['users/sync-user/notes/dual-aliases/slide_4.png', 'image/gif'],
  ]);
  const dualLocal = localSaves.at(-1);
  assert.equal(dualLocal.slideImages[0].imageBase64.startsWith('https://'), true);
  assert.equal(dualLocal.slideImages[0].mimeType, 'image/png');
  assert.equal(dualLocal.extractedImages[0].imageBase64, dualLocal.slideImages[0].imageBase64,
    'shared source URL is applied to both aliases');
  assert.equal(dualLocal.extractedImages[0].mimeType, 'image/png');
  assert.equal(dualLocal.slideImages[2].imageBase64.startsWith('https://'), true);
  assert.equal(dualLocal.slideImages[2].mimeType, 'image/jpeg');
  assert.equal(dualLocal.extractedImages[4].imageBase64.startsWith('https://'), true);
  assert.equal(dualLocal.extractedImages[4].mimeType, 'image/gif');
  assert.equal(1 in dualLocal.slideImages, false);
  assert.equal(1 in dualLocal.extractedImages, false);
  assert.equal(dualLocal.slideImages[3].imageBase64, remoteA);
  assert.equal(dualLocal.extractedImages[3].imageBase64, remoteA);
  assert.equal(2 in dualLocal.slideImageUrls, true);
  assert.equal(writes.at(-1).payload.slideImageUrls[1], null);
  assert.equal(writes.at(-1).payload.slideImageUrls[4], dualLocal.slideImageUrls[4]);
  assertNoFirestorePayload(writes.at(-1).payload, 'dual-alias Firestore write');

  const collisionWrites = [];
  const collisionUploaded = [];
  makeFirestore(context, collisionWrites);
  context.currentUser = { uid: 'sync-user' };
  context.storage = makeStorage(collisionUploaded);
  const collisionSave = { count: 0, current: null };
  context.saveNote = async note => {
    collisionSave.count += 1;
    collisionSave.current = Object.assign({}, note, { updatedAt: `production-save-${collisionSave.count}` });
    return collisionSave.current;
  };
  context.getNote = async () => collisionSave.current && Object.assign({}, collisionSave.current);
  await context.saveNoteFS({
    id: 'alias-collision',
    title: 'Alias collision',
    notesText: 'Distinct owners share one index.',
    slideImages: [{ imageBase64: png, mimeType: 'image/png', fileName: 'slide-owner.png' }],
    extractedImages: [{ imageBase64: jpeg, mimeType: 'image/jpeg', fileName: 'extracted-owner.jpg' }],
    slideImageUrls: [null],
  });
  assert.equal(collisionUploaded.length, 2, 'same-index distinct owners upload separately');
  assert.deepEqual(collisionUploaded.map(item => item.storagePath), [
    'users/sync-user/notes/alias-collision/slide_0.png',
    'users/sync-user/notes/alias-collision/extracted_0.png',
  ]);
  assert.notEqual(collisionSave.current.slideImages[0].imageBase64,
    collisionSave.current.extractedImages[0].imageBase64);
  assert.equal(collisionSave.current.slideImages[0].mimeType, 'image/png');
  assert.equal(collisionSave.current.extractedImages[0].mimeType, 'image/jpeg');
  assert.equal(collisionSave.current.slideImageUrls[0], collisionSave.current.slideImages[0].imageBase64,
    'slideImages is canonical for conflicting slideImageUrls');
  assert.equal(collisionWrites.at(-1).payload.slideImageUrls[0], collisionSave.current.slideImages[0].imageBase64);

  const normalWrites = [];
  const normalUploaded = [];
  makeFirestore(context, normalWrites);
  context.storage = makeStorage(normalUploaded);
  const normalSave = { count: 0, current: null };
  context.saveNote = async note => {
    normalSave.count += 1;
    normalSave.current = Object.assign({}, note, { updatedAt: `normal-save-${normalSave.count}` });
    return normalSave.current;
  };
  context.getNote = async () => normalSave.current && Object.assign({}, normalSave.current);
  await context.saveNoteFS({
    id: 'normal-upload',
    title: 'Normal upload',
    notesText: 'A normal upload must reach Firestore.',
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
  });
  assert.equal(normalUploaded.length, 1);
  assert.equal(normalWrites.filter(write => write.method === 'set').length, 1,
    'normal upload performs exactly one safe Firestore write');

  let releaseUpload;
  let uploadStarted;
  const raceWrites = [];
  const raceFirestore = makeFirestore(context, raceWrites);
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  uploadStarted = new Promise(resolve => { context.__uploadStarted = resolve; });
  let uploadNumber = 0;
  context.storage = {
    ref(storagePath) {
      return {
        async putString(data, encoding, options) {
          context.__uploadStarted({ storagePath, data, encoding, contentType: options.contentType });
          await uploadGate;
        },
        async getDownloadURL() {
          uploadNumber += 1;
          return `https://storage.example.test/race-${uploadNumber}.png`;
        },
      };
    },
  };
  let currentLocal = null;
  localSaves.length = 0;
  context.saveNote = async note => {
    currentLocal = Object.assign({}, note);
    localSaves.push(currentLocal);
    return currentLocal;
  };
  context.getNote = async () => (currentLocal ? Object.assign({}, currentLocal) : null);
  const staleSave = context.saveNoteFS({
    id: 'race-note',
    title: 'Old title',
    notesText: 'Old text',
    revision: 1,
    customMetadata: { owner: 'old' },
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
  });
  await uploadStarted;
  await context.saveNoteFS({
    id: 'race-note',
    title: 'New title',
    notesText: 'New text',
    revision: 2,
    customMetadata: { owner: 'new', retained: true },
  });
  assert.equal(currentLocal.notesText, 'New text', 'newer save must win while upload is pending');
  releaseUpload();
  await staleSave;
  assert.equal(currentLocal.title, 'New title', 'stale upload completion must not restore old title');
  assert.equal(currentLocal.notesText, 'New text', 'stale upload completion must not restore old text');
  assert.equal(currentLocal.revision, 2, 'stale upload completion must not restore old revision');
  assert.deepEqual(currentLocal.customMetadata, { owner: 'new', retained: true });
  const raceRemote = await raceFirestore.noteRef.doc('race-note').get();
  assert.equal(raceRemote.data().notesText, 'New text', 'stale upload completion must not restore old Firestore text');
  assert.equal(raceRemote.data().customMetadata.owner, 'new');
  assert.equal(raceRemote.data().customMetadata.retained, true);

  const failedUploads = [];
  context.storage = makeStorage(failedUploads, true);
  localSaves.length = 0;
  await assert.rejects(
    () => context.saveNoteFS({
      id: 'upload-failure',
      title: 'Detached on failure',
      notesText: 'Text and image must survive locally.',
      extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
    }),
    /fixture storage upload failure/,
    'upload failures must be visible to the caller',
  );
  assert.equal(localSaves.at(-1).extractedImages[0].imageBase64, png,
    'failed uploads keep local ownership for detached noteImages');

  let listReads = 0;
  const legacyListDoc = {
    id: 'list-1',
    title: 'List metadata',
    notesText: 'Text',
    notesHtml: `<p>legacy</p><img src="${png}">`,
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
    slideImages: [{ blob: new Blob(['legacy']), mimeType: 'image/png' }],
    slideImageUrls: [remoteA, , remoteB],
    customMetadata: { base64: 'iVBORw0KGgo=', blob: new Blob(['nested']) },
  };
  const listDocs = [legacyListDoc];
  context.db = {
    collection() {
      return { doc() { return { collection() {
        return { async get() { listReads += 1; return { docs: listDocs.map(data => ({ data: () => data })) }; } };
      } }; } };
    },
  };
  let openDbCalls = 0;
  context.openDB = async () => {
    openDbCalls += 1;
    throw new Error('raw notes-store mirror must not be used');
  };
  const priorMarkerNote = {
    id: 'list-1',
    notesHtml: '<p>local marker</p><img src="" data-note-image-ref="note-image-0">',
    customMetadata: { local: true },
  };
  const listMirrors = [];
  let mirroredListResult;
  context.saveNote = async note => {
    listMirrors.push(note);
    assert.equal(note.extractedImages, undefined, 'list mirror omits extractedImages');
    assert.equal(note.slideImages, undefined, 'list mirror omits slideImages');
    assert.doesNotMatch(note.notesHtml || '', /data:image\//i, 'list marker HTML has no payload');
    mirroredListResult = Object.assign({}, priorMarkerNote, note);
    return mirroredListResult;
  };
  context._invalidateNotesCache();
  const listFirst = await context.getAllNotesFS();
  const listSecond = await context.getAllNotesFS();
  assert.equal(listReads, 1, 'metadata-only list results are cached');
  assert.equal(listFirst[0].extractedImages, undefined, 'list reads do not hydrate extractedImages');
  assert.equal(listSecond[0].extractedImages, undefined, 'cached list reads remain lightweight');
  assert.equal(listFirst[0].notesHtml, undefined, 'legacy list notesHtml is removed');
  assertNoFirestorePayload(listFirst[0], 'sanitized list result');
  assert.equal(listMirrors.length, 1, 'remote list metadata is mirrored once');
  assert.match(mirroredListResult.notesHtml, /data-note-image-ref="note-image-0"/,
    'detached-aware mirror preserves prior marker HTML');
  assert.equal(openDbCalls, 0, 'list sync must not raw-put Firestore docs into notes');

  makeFirestore(context, [], [{ id: 'one-note', title: 'One note', notesText: 'Body', slideImageUrls: [remoteA, , remoteB] }]);
  context.getNote = async () => ({ id: 'one-note', title: 'One note', notesText: 'Body' });
  context.saveNote = async note => { localSaves.push(note); return note; };
  context.renderMarkdown = text => `<p>${text}</p>`;
  const hydratedOneNote = await context.getNoteFS('one-note');
  assert.equal(hydratedOneNote.extractedImages[0].imageBase64, remoteA,
    'one-note reads hydrate URL references');
  assert.equal(1 in hydratedOneNote.extractedImages, false,
    'one-note hydration preserves sparse positions');

  const authorityWrites = [];
  makeFirestore(context, authorityWrites, [{
    id: 'authority-note',
    title: 'Authority note',
    notesText: 'New remote prose',
    slideImageUrls: [remoteA],
  }]);
  context.currentUser = { uid: 'authority-user' };
  context.getAllNotes = async () => [{
    id: 'authority-note',
    title: 'Authority note',
    notesText: 'Old local prose',
    notesHtml: '<p>Old local prose</p><img src="" data-note-image-ref="note-image-0">',
  }];
  context.renderMarkdown = text => `<p>${text}</p>`;
  const authorityLocal = {
    id: 'authority-note',
    title: 'Authority note',
    notesText: 'Old local prose',
    notesHtml: '<p>Old local prose</p><img src="data:image/png;base64,iVBORw0KGgo=" data-note-image-ref="note-image-0">',
    extractedImages: [{ imageBase64: 'iVBORw0KGgo=', mimeType: 'image/png', markerId: 'note-image-0' }],
  };
  context.getNote = async () => Object.assign({}, authorityLocal);
  const authorityMirrors = [];
  context.saveNote = async note => { authorityMirrors.push(note); return note; };
  context._invalidateNotesCache();
  const authorityList = await context.getAllNotesFS();
  assert.equal(authorityList[0].notesHtml, undefined, 'authority list remains metadata-only');
  assert.equal(authorityMirrors[0].notesText, 'New remote prose');
  assert.match(authorityMirrors[0].notesHtml, /New remote prose/,
    'list mirror renders newer remote prose');
  assert.doesNotMatch(authorityMirrors[0].notesHtml, /Old local prose/,
    'list mirror drops stale local prose');
  assert.match(authorityMirrors[0].notesHtml, /data-note-image-ref="note-image-0"/,
    'list mirror carries only local marker-bearing image nodes');
  assert.doesNotMatch(authorityMirrors[0].notesHtml, /data:image\//i,
    'list mirror HTML contains markers, not image payloads');
  const authorityMirrorPayload = Object.assign({}, authorityMirrors[0]);
  delete authorityMirrorPayload.notesHtml;
  assertNoFirestorePayload(authorityMirrorPayload, 'authority local mirror');
  const authorityOpened = await context.getNoteFS('authority-note');
  assert.match(authorityOpened.notesHtml, /New remote prose/);
  assert.doesNotMatch(authorityOpened.notesHtml, /Old local prose/);
  assert.match(authorityOpened.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/,
    'opening the note still hydrates the detached marker image');

  const writerWrites = [];
  context.currentUser = { uid: 'writer-user' };
  makeFirestore(context, writerWrites, [{ id: 'partial-note', title: 'Partial', notesText: 'Body' }]);
  await context.safeNotePartialUpdate('partial-note', {
    title: 'Safe partial',
    notesHtml: `<img src="${png}">`,
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
    customMetadata: { blob: new Blob(['partial']), base64: 'iVBORw0KGgo=' },
  });
  const partialWrite = writerWrites.find(write => write.method === 'update');
  assert.ok(partialWrite, 'safe partial update must execute the Firestore update path');
  assertNoFirestorePayload(partialWrite.payload, 'safe partial update');

  const fallbackWrites = [];
  const missingDocError = Object.assign(new Error('No document to update'), { code: 'not-found' });
  makeFirestore(context, fallbackWrites, [], { updateError: missingDocError });
  context.getNote = async () => ({ id: 'fallback-note', title: 'Local full note', notesText: 'Local body' });
  context.saveNote = async note => note;
  await context.safeNotePartialUpdate('fallback-note', {
    title: 'Fallback title',
    notesHtml: `<img src="${png}">`,
  });
  const fallbackWrite = fallbackWrites.find(write => write.method === 'set');
  assert.ok(fallbackWrite, 'missing partial docs must fall back through saveNoteFS');
  assertNoFirestorePayload(fallbackWrite.payload, 'safe partial fallback');

  context.FOLDER_COLORS = [{ value: 'blue' }];
  const folderWrites = [];
  makeFirestore(context, folderWrites);
  context.saveFolder = async folder => folder;
  await context.saveFolderFS({ id: 'folder-1', name: 'Folder', color: 'blue' });
  await context.renameFolderFS('folder-1', 'Renamed', 'blue', 'LECTURE-1');
  assert.equal(folderWrites.filter(write => write.method === 'folder-set').length, 2,
    'folder save and rename writers remain executable');

  const loginWrites = [];
  makeFirestore(context, loginWrites, [{
    id: 'login-legacy',
    title: 'Login legacy',
    notesText: 'Login body',
    notesHtml: `<img src="${png}">`,
    extractedImages: [{ imageBase64: png, mimeType: 'image/png' }],
    slideImages: [{ imageBase64: png, mimeType: 'image/png' }],
    slideImageUrls: [remoteA],
  }]);
  context.currentUser = { uid: 'login-user' };
  context.sessionStorage = { getItem: () => null, setItem(key, value) { this.value = [key, value]; } };
  context.localStorage = { getItem: () => '[]', setItem() {}, removeItem() {} };
  context.getAllNotes = async () => [];
  context.getAllFolders = async () => [];
  const loginMirrors = [];
  context.saveNote = async note => {
    const lightweight = context.stripFirestoreNotePayloads(note);
    loginMirrors.push(lightweight);
    return lightweight;
  };
  context.saveFolder = async () => {};
  await context.syncNotesOnLogin();
  assert.equal(loginMirrors.length, 1, 'login sync must mirror the remote note');
  assertNoFirestorePayload(loginMirrors[0], 'login-sync local mirror');
  assert.equal(loginMirrors[0].extractedImages, undefined);

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'firestore_sync.js'), 'utf8');
  const crudSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'notes_crud.js'), 'utf8');
  assert.match(source, /stripFirestoreNotePayloads/,
    'Firestore note writes must use the shared payload stripper');
  assert.doesNotMatch(crudSource, /ref\.doc\(id\)\.set\(/,
    'notes CRUD must not bypass the shared Firestore note writer');
  assert.match(crudSource, /safeNotePartialUpdate\(id,/,
    'import must use the shared safe note writer');
  assert.doesNotMatch(source, /fsNote\.slideImageUrls\.map\(/,
    'sync must not synthesize extractedImages for every remote note');

  const localDeletes = [];
  const localNotes = new Map([['delete-me', { id: 'delete-me' }]]);
  const localImageRecords = new Map([['delete-me', { noteId: 'delete-me', images: [{ blob: new Blob(['image']) }] }]]);
  context.currentUser = { uid: 'delete-user' };
  context.localStorage = { getItem: () => '[]', setItem() {} };
  context.getNote = async () => ({ id: 'delete-me', audioStoragePath: 'users/delete-user/recordings/audio.webm' });
  context.deleteNote = async id => {
    localDeletes.push(id);
    localNotes.delete(id);
    localImageRecords.delete(id);
  };
  context.deleteSlideImages = async () => {};
  context.storage = { ref: () => ({ async delete() { throw new Error('audio delete failed'); } }) };
  makeFirestore(context, [], [{ id: 'delete-me', audioStoragePath: 'users/delete-user/recordings/audio.webm' }], {
    deleteError: new Error('remote delete failed'),
  });
  await assert.rejects(() => context.deleteNoteFS('delete-me'), /remote delete failed/);
  assert.deepEqual(localDeletes, ['delete-me'],
    'remote delete failure must not prevent local note and noteImages deletion');
  assert.equal(localNotes.has('delete-me'), false, 'actual local note deletion completed');
  assert.equal(localImageRecords.has('delete-me'), false, 'actual local noteImages deletion completed');

  console.log('STORAGE2 sync: PASS (Task 5 payload-safe Firestore and sync contracts)');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
