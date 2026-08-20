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

function makeFirestore(context, writes, remoteDocs = [], { deleteError = null } = {}) {
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
  const folders = { orderBy: () => ({ get: async () => ({ docs: [] }) }) };
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
  assert.equal(1 in stripped.slideImageUrls, false, 'aligned URL references keep sparse holes');
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
  assert.equal(mergedLocal.extractedImages[0].mimeType, 'url');
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
  assert.deepEqual(writes.at(-1).payload.slideImageUrls, mergedLocal.slideImageUrls);

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
  const listDocs = [{ id: 'list-1', title: 'List metadata', notesText: 'Text', slideImageUrls: [remoteA, , remoteB] }];
  context.db = {
    collection() {
      return { doc() { return { collection() {
        return { async get() { listReads += 1; return { docs: listDocs.map(data => ({ data: () => data })) }; } };
      } }; } };
    },
  };
  context.openDB = async () => ({
    transaction() {
      const tx = { objectStore: () => ({ put() {} }) };
      queueMicrotask(() => tx.oncomplete && tx.oncomplete());
      return tx;
    },
  });
  context._invalidateNotesCache();
  const listFirst = await context.getAllNotesFS();
  const listSecond = await context.getAllNotesFS();
  assert.equal(listReads, 1, 'metadata-only list results are cached');
  assert.equal(listFirst[0].extractedImages, undefined, 'list reads do not hydrate extractedImages');
  assert.equal(listSecond[0].extractedImages, undefined, 'cached list reads remain lightweight');

  makeFirestore(context, [], [{ id: 'one-note', title: 'One note', notesText: 'Body', slideImageUrls: [remoteA, , remoteB] }]);
  context.getNote = async () => ({ id: 'one-note', title: 'One note', notesText: 'Body' });
  context.saveNote = async note => { localSaves.push(note); return note; };
  context.renderMarkdown = text => `<p>${text}</p>`;
  const hydratedOneNote = await context.getNoteFS('one-note');
  assert.equal(hydratedOneNote.extractedImages[0].imageBase64, remoteA,
    'one-note reads hydrate URL references');
  assert.equal(1 in hydratedOneNote.extractedImages, false,
    'one-note hydration preserves sparse positions');

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'firestore_sync.js'), 'utf8');
  const crudSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'notes_crud.js'), 'utf8');
  assert.match(source, /stripFirestoreNotePayloads/,
    'Firestore note writes must use the shared payload stripper');
  assert.doesNotMatch(crudSource, /ref\.doc\(id\)\.set\(/,
    'notes CRUD must not bypass the shared Firestore note writer');
  assert.doesNotMatch(source, /fsNote\.slideImageUrls\.map\(/,
    'sync must not synthesize extractedImages for every remote note');

  const localDeletes = [];
  context.currentUser = { uid: 'delete-user' };
  context.localStorage = { getItem: () => '[]', setItem() {} };
  context.getNote = async () => ({ id: 'delete-me', audioStoragePath: 'users/delete-user/recordings/audio.webm' });
  context.deleteNote = async id => { localDeletes.push(id); };
  context.deleteSlideImages = async () => {};
  context.deleteNoteAudio = async () => {};
  makeFirestore(context, [], [{ id: 'delete-me', audioStoragePath: 'users/delete-user/recordings/audio.webm' }], {
    deleteError: new Error('remote delete failed'),
  });
  await assert.rejects(() => context.deleteNoteFS('delete-me'), /remote delete failed/);
  assert.deepEqual(localDeletes, ['delete-me'],
    'remote delete failure must not prevent local note and noteImages deletion');

  console.log('STORAGE2 sync: PASS (Task 5 payload-safe Firestore and sync contracts)');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
