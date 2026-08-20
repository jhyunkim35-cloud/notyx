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
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
  };
  for (const file of ['note_images.js', 'storage.js', 'notes_crud.js', 'firestore_sync.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  return context;
}

function makeDocument(context, state) {
  context.document = {
    createElement(tag) {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click() {},
        };
      }
      const element = {
        className: '',
        style: {},
        innerHTML: '',
        appendChild(child) { state.children.push(child); },
        remove() {},
        querySelector() {
          return { appendChild(child) { state.rows.push(child); } };
        },
      };
      return element;
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
  };
}

function noPayload(value, label = 'value', seen = new Set()) {
  if (value == null || typeof value !== 'object') {
    if (typeof value === 'string') assert.doesNotMatch(value, /^data:image\//i, `${label} contains a data URL`);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  assert.equal(value instanceof Blob, false, `${label} contains a Blob`);
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'blob', `${label} contains blob`);
    assert.notEqual(key, 'dataUrl', `${label} contains export payload outside artifact images`);
    if (key === 'imageBase64' && typeof child === 'string') {
      assert.doesNotMatch(child, /^data:image\//i, `${label}.${key} contains a data URL`);
    }
    noPayload(child, `${label}.${key}`, seen);
  }
}

async function run() {
  const context = loadContext();
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const remote = 'https://cdn.example.test/remote.png';
  const domState = { children: [], rows: [] };
  makeDocument(context, domState);
  context.dateStamp = () => '2026-08-21';
  context.showSuccessToast = () => {};
  context.showToast = () => {};
  context.escHtml = value => String(value);
  context.renderHomeView = async () => {};
  context.getAllFoldersFS = async () => [];

  let exportBlob;
  let hydrateCalls = [];
  const lightweightExportNote = {
    id: 'export-note',
    title: 'Export note',
    notesText: 'Portable image',
    notesHtml: '<p>text</p><img src="" data-note-image-ref="note-image-0">',
    extractedImages: [{ markerId: 'note-image-0', mimeType: 'image/png', fileName: 'slide.png' }],
    slideImageUrls: [remote, , null],
  };
  const hydratedExportNote = {
    ...lightweightExportNote,
    notesHtml: `<p>text</p><img src="${png}" data-note-image-ref="note-image-0">`,
    extractedImages: [{ markerId: 'note-image-0', imageBase64: png, mimeType: 'image/png', fileName: 'slide.png' }],
  };
  context.getAllNotesFS = async () => [lightweightExportNote];
  context.getNoteFS = async id => {
    hydrateCalls.push(id);
    return hydratedExportNote;
  };
  const originalBlob = context.Blob;
  context.Blob = class CaptureBlob extends originalBlob {
    constructor(parts, options) {
      super(parts, options);
      exportBlob = this;
    }
  };

  await context.exportAllNotes();
  assert.deepEqual(hydrateCalls, ['export-note'], 'export must hydrate each selected note exactly once');
  const exported = JSON.parse(await exportBlob.text());
  assert.equal(exported.schema, 'notyx.storage2', 'export has a versioned STORAGE2 schema');
  assert.equal(exported.version, 2, 'export schema version is explicit');
  assert.equal(exported.notes.length, 1);
  noPayload(exported.notes[0].note, 'exported metadata note');
  assert.equal(exported.notes[0].images.length, 1, 'portable local images live in the artifact image list');
  assert.equal(exported.notes[0].images[0].dataUrl, png, 'portable image representation preserves the data URL');

  const roundTripCalls = [];
  context.getAllNotesFS = async () => [];
  context.getAllFoldersFS = async () => [];
  context.saveNoteFS = async note => { roundTripCalls.push(note); return note; };
  await context.importNotes({
    value: 'round-trip',
    files: [{ text: async () => JSON.stringify(exported) }],
  });
  assert.equal(roundTripCalls.length, 1, 'export artifact imports through the note writer');
  assert.equal(roundTripCalls[0].extractedImages[0].imageBase64, png, 'export/import round-trip restores local image data');
  assert.equal(roundTripCalls[0].extractedImages[0].mimeType, 'image/png');
  assert.match(roundTripCalls[0].notesHtml, /data-note-image-ref="note-image-0"/);

  const importCalls = [];
  context.currentUser = null;
  context.getAllNotesFS = async () => [];
  context.getAllFoldersFS = async () => [];
  context.saveNoteFS = async note => { importCalls.push(note); return note; };
  const importData = {
    schema: 'notyx.storage2',
    version: 2,
    folders: [],
    notes: [
      {
        note: {
          id: 'detached-import', title: 'Detached import', notesText: 'Keep sparse data',
          notesHtml: '<p>x</p><img src="" data-note-image-ref="note-image-2">',
          slideImageUrls: [remote, , null],
          extractedImages: [, , { markerId: 'note-image-2', mimeType: 'image/webp', slideNumber: 3 }],
        },
        images: [{ field: 'extractedImages', index: 2, markerId: 'note-image-2', mimeType: 'image/webp', fileName: 'third.webp', dataUrl: png }],
      },
      {
        id: 'legacy-import', title: 'Legacy import', notesText: 'Legacy payload',
        notesHtml: `<img src="${png}">`,
        extractedImages: [{ imageBase64: png, mimeType: 'image/png', fileName: 'legacy.png' }],
      },
    ],
  };
  await context.importNotes({
    value: 'selected',
    files: [{ text: async () => JSON.stringify(importData) }],
  });
  assert.equal(importCalls.length, 2, 'legacy and detached bundles import one note at a time');
  assert.equal(importCalls[0].extractedImages[2].imageBase64, png);
  assert.equal(importCalls[0].extractedImages[2].mimeType, 'image/webp');
  assert.equal(importCalls[0].extractedImages[1], null, 'detached import preserves sparse image positions');
  assert.equal(importCalls[0].slideImageUrls[1], null, 'detached import preserves sparse URL positions');
  assert.match(importCalls[0].notesHtml, /data-note-image-ref="note-image-2"/);
  assert.match(importCalls[0].notesHtml, new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(importCalls[1].extractedImages[0].mimeType, 'image/png', 'legacy MIME metadata survives');

  const moveWrites = [];
  const moveHydrates = [];
  domState.rows.length = 0;
  context.getAllNotesFS = async () => [{
    id: 'move-note', title: 'Move me', notesText: 'Text', folderId: 'old',
    notesHtml: '<img src="" data-note-image-ref="note-image-0">',
    extractedImages: [{ markerId: 'note-image-0', mimeType: 'image/png' }],
  }];
  context.getNoteFS = async id => { moveHydrates.push(id); throw new Error('move must not hydrate'); };
  context.getAllFoldersFS = async () => [{ id: 'new-folder', name: 'New folder' }];
  context.getNextSortOrder = async () => 7;
  context.saveNoteFS = async note => { moveWrites.push(note); return note; };
  await context.moveSavedNote('move-note');
  assert.equal(moveHydrates.length, 0, 'folder move uses the metadata list path');
  assert.equal(domState.rows.length, 2, 'move exposes uncategorized and folder choices');
  await domState.rows[1].onclick();
  assert.equal(moveWrites.length, 1);
  assert.equal('extractedImages' in moveWrites[0], false, 'move omits image fields');
  assert.equal('notesHtml' in moveWrites[0], false, 'move omits HTML payload fields');
  assert.equal(moveWrites[0].folderId, 'new-folder');

  const reorderCalls = [];
  const batchUpdates = [];
  context.currentUser = { uid: 'reorder-user' };
  context.updateNoteOrder = async ids => reorderCalls.push(ids);
  context.db = {
    collection() {
      return { doc() { return { collection() { return { doc() {} }; } }; } };
    },
    batch() {
      return { update(ref, payload) { batchUpdates.push({ ref, payload }); }, commit: async () => {} };
    },
  };
  await context.updateNoteOrderFS(['a', 'b']);
  assert.deepEqual(reorderCalls, [['a', 'b']]);
  assert.deepEqual(JSON.parse(JSON.stringify(batchUpdates.map(item => item.payload))), [{ sortOrder: 0 }, { sortOrder: 1 }]);
  assert.equal(moveHydrates.length, 0, 'reorder never hydrates notes');

  const migrationGets = [];
  const migrationSaves = [];
  const localStore = new Map();
  context.currentUser = { uid: 'migration-user' };
  context.localStorage = {
    getItem: key => localStore.get(key) || null,
    setItem: (key, value) => localStore.set(key, String(value)),
  };
  context.getAllNotes = async () => [
    { id: 'url-only', title: 'URL only', notesText: 'No local image', extractedImages: [{ imageBase64: remote, mimeType: 'url' }] },
    { id: 'local-image', title: 'Local image', notesText: 'Needs upload', extractedImages: [{ markerId: 'note-image-0', mimeType: 'image/png' }] },
  ];
  context.getAllFolders = async () => [];
  context.getNote = async id => { migrationGets.push(id); return { id, title: 'Local image', notesText: 'Needs upload', extractedImages: [{ imageBase64: png, mimeType: 'image/png' }] }; };
  context.saveNoteFS = async note => { migrationSaves.push(note); return note; };
  context.saveFolderFS = async () => {};
  await context.migrateLocalToFirestore();
  assert.deepEqual(migrationGets, ['local-image'], 'local-to-Firestore migration hydrates only notes needing upload');
  assert.deepEqual(migrationSaves.map(note => note.id), ['url-only', 'local-image']);

  const syncSaves = [];
  const remoteNote = { id: 'remote-only', title: 'Remote note', notesText: 'Restore one note', slideImageUrls: [remote] };
  const remoteNotesRef = {
    async get() { return { docs: [{ data: () => remoteNote }] }; },
    doc() { return { async delete() {} }; },
  };
  const remoteFoldersRef = { async get() { return { docs: [] }; } };
  context.currentUser = { uid: 'firestore-local-user' };
  context.sessionStorage = { getItem: () => null, setItem() {} };
  context.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  context.db = {
    collection() {
      return { doc() {
        return { collection(child) { return child === 'notes' ? remoteNotesRef : remoteFoldersRef; } };
      } };
    },
  };
  context.getAllNotes = async () => [];
  context.getAllFolders = async () => [];
  context.saveNote = async note => { syncSaves.push(note); return note; };
  context.getNote = async () => { throw new Error('Firestore-to-local sync must not hydrate list notes'); };
  await context.syncNotesOnLogin();
  assert.deepEqual(syncSaves.map(note => note.id), ['remote-only'], 'Firestore-to-local sync saves each remote note individually');
  noPayload(syncSaves[0], 'Firestore-to-local metadata save');

  const searchRows = [{ id: 'search-note', title: 'Find me', notesText: 'needle', notesHtml: '<img src="" data-note-image-ref="note-image-0">', extractedImages: [{ markerId: 'note-image-0', mimeType: 'image/png' }] }];
  context.getAllNotes = async () => searchRows;
  const searchResult = await context.searchNotes('needle');
  assert.equal(searchResult.length, 1);
  noPayload(searchResult[0], 'local search result');
  context.getAllNotesFS = async () => searchRows;
  const remoteSearchResult = await context.searchNotesFS('needle');
  assert.equal(remoteSearchResult.length, 1);
  noPayload(remoteSearchResult[0], 'Firestore search result');

  console.log('STORAGE2 lifecycle: PASS');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
