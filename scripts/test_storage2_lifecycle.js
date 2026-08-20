const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadContext() {
  class FixtureURL extends URL {}
  FixtureURL.createObjectURL = () => 'blob:fixture';
  FixtureURL.revokeObjectURL = () => {};
  const testConsole = {
    log() {},
    trace() {},
    warn(...args) { throw new Error(`unexpected console.warn: ${args.join(' ')}`); },
    error(...args) { throw new Error(`unexpected console.error: ${args.join(' ')}`); },
  };
  const context = {
    Blob,
    atob,
    btoa,
    console: testConsole,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    window: {},
    URL: FixtureURL,
    firebase: {
      firestore() {
        return {
          collection() {
            return { doc() { return { collection() { return { get: async () => ({ docs: [] }) }; } }; } };
          },
        };
      },
    },
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
  context.showToast = () => {};
  context.saveNoteFS = async note => { roundTripCalls.push(note); return note; };
  await context.importNotes({
    value: 'round-trip',
    files: [{ text: async () => JSON.stringify(exported) }],
  });
  assert.equal(roundTripCalls.length, 1, 'export artifact imports through the note writer');
  assert.equal(roundTripCalls[0].extractedImages[0].imageBase64, png, 'export/import round-trip restores local image data');
  assert.equal(roundTripCalls[0].extractedImages[0].mimeType, 'image/png');
  assert.match(roundTripCalls[0].notesHtml, /data-note-image-ref="note-image-0"/);
  context.showToast = () => {};

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
        id: 'invalid-v2-legacy-entry', title: 'Invalid mixed entry', notesText: 'Must be rejected',
      },
    ],
  };
  await context.importNotes({
    value: 'selected',
    files: [{ text: async () => JSON.stringify(importData) }],
  });
  assert.equal(importCalls.length, 0, 'v2 rejects raw legacy entries before any write');

  await context.importNotes({
    value: 'detached',
    files: [{ text: async () => JSON.stringify({
      schema: 'notyx.storage2', version: 2, folders: [], notes: [importData.notes[0]],
    }) }],
  });
  assert.equal(importCalls.length, 1, 'valid detached bundle imports through the writer');
  assert.equal(importCalls[0].extractedImages[2].imageBase64, png);
  assert.equal(importCalls[0].extractedImages[2].mimeType, 'image/webp');
  assert.equal(importCalls[0].extractedImages[1], null, 'detached import preserves sparse image positions');
  assert.equal(importCalls[0].slideImageUrls[1], null, 'detached import preserves sparse URL positions');
  assert.match(importCalls[0].notesHtml, /data-note-image-ref="note-image-2"/);
  assert.match(importCalls[0].notesHtml, new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await context.importNotes({
    value: 'legacy',
    files: [{ text: async () => JSON.stringify({
      notes: [{
        id: 'legacy-import', title: 'Legacy import', notesText: 'Legacy payload',
        notesHtml: `<img src="${png}">`,
        extractedImages: [{ imageBase64: png, mimeType: 'image/png', fileName: 'legacy.png' }],
      }],
    }) }],
  });
  assert.equal(importCalls.length, 2, 'legacy input imports through the writer');
  assert.equal(importCalls[1].extractedImages[0].mimeType, 'image/png', 'legacy MIME metadata survives');

  await context.importNotes({
    value: 'legacy sparse text',
    files: [{ text: async () => JSON.stringify({ notes: [
      { id: 'legacy-title-only', title: 'Title only' },
      { id: 'legacy-body-only', notesText: 'Body only' },
    ] }) }],
  });
  assert.equal(importCalls.length, 4, 'legacy title-only and body-only notes remain compatible');

  const directLegacyPlan = context._buildImportPlan({ notes: [{
    id: 'legacy-direct-sources', title: 'Direct sources', notesText: 'Supported direct inputs',
    extractedImages: [remote],
    slideImages: [png],
  }] });
  assert.equal(directLegacyPlan.notes[0].note.extractedImages[0], remote,
    'legacy direct remote string remains supported');
  assert.equal(directLegacyPlan.notes[0].note.slideImages[0], png,
    'legacy direct data URL remains supported');
  const directLegacyBlob = new context.Blob(['legacy direct blob'], { type: 'image/png' });
  const directBlobPlan = context._buildImportPlan({ notes: [{
    id: 'legacy-direct-blob', title: 'Direct Blob', notesText: 'Supported direct Blob',
    extractedImages: [directLegacyBlob],
  }] });
  assert.equal(directBlobPlan.notes[0].note.extractedImages[0], directLegacyBlob,
    'legacy direct Blob remains supported');

  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-conflicting-aliases', title: 'Conflicting aliases', notesText: 'Must reject',
    extractedImages: [{ imageBase64: png, src: 'data:image/png;base64,iVBORw0KGgoAAQ==' }],
  }] }), /conflicting image sources/,
  'conflicting string aliases must reject before any write');

  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-conflicting-data-aliases', title: 'Conflicting data aliases', notesText: 'Must reject',
    extractedImages: [{ data: png, imageData: 'data:image/png;base64,iVBORw0KGgoAAQ==' }],
  }] }), /conflicting image sources/,
  'conflicting data/imageData aliases must reject before any write');

  const conflictingBlob = new context.Blob(['different bytes'], { type: 'image/png' });
  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-conflicting-blob-alias', title: 'Conflicting Blob alias', notesText: 'Must reject',
    extractedImages: [{ data: png, blob: conflictingBlob }],
  }] }), /conflicting image sources/,
  'data/Blob alias combinations must reject without asynchronous Blob comparison');

  const equivalentAliasPlan = context._buildImportPlan({ notes: [{
    id: 'legacy-equivalent-aliases', title: 'Equivalent aliases', notesText: 'Keep exact bytes',
    extractedImages: [{ imageBase64: 'iVBORw0KGgo=', src: png, mimeType: 'image/png' }],
  }] });
  const equivalentDetached = context.detachNoteImages(equivalentAliasPlan.notes[0].note);
  const equivalentHydrated = await context.hydrateNoteImages(
    equivalentDetached.note,
    equivalentDetached.imageRecord,
  );
  assert.equal(equivalentHydrated.extractedImages[0].imageBase64, 'iVBORw0KGgo=',
    'equivalent raw/data aliases preserve exact bytes through detach/hydrate');

  const equivalentRemotePlan = context._buildImportPlan({ notes: [{
    id: 'legacy-equivalent-remote-aliases', title: 'Equivalent remote aliases', notesText: 'Keep URL',
    extractedImages: [{ imageBase64: 'HTTP://CDN.EXAMPLE.test/remote.png', src: 'http://cdn.example.test/remote.png' }],
  }] });
  assert.equal(equivalentRemotePlan.notes[0].note.extractedImages[0].imageBase64,
    'HTTP://CDN.EXAMPLE.test/remote.png', 'protocol/host case-only remote aliases remain compatible');
  const protocolRelativePlan = context._buildImportPlan({ notes: [{
    id: 'legacy-equivalent-protocol-relative-aliases', title: 'Equivalent protocol-relative aliases', notesText: 'Keep URL',
    extractedImages: [{ imageBase64: '//CDN.EXAMPLE.test/remote.png', src: '//cdn.example.test/remote.png' }],
  }] });
  assert.equal(protocolRelativePlan.notes[0].note.extractedImages[0].imageBase64,
    '//CDN.EXAMPLE.test/remote.png', 'protocol-relative aliases compare within their own URL kind');
  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-mixed-remote-url-kinds', title: 'Mixed remote URL kinds', notesText: 'Must reject',
    extractedImages: [{ imageBase64: '//cdn.example.test/remote.png', src: 'https://cdn.example.test/remote.png' }],
  }] }), /conflicting image sources/,
  'protocol-relative and absolute URLs must not be merged implicitly');
  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-conflicting-remote-path', title: 'Conflicting remote path', notesText: 'Must reject',
    extractedImages: [{ imageBase64: 'https://cdn.example.test/a.png', src: 'https://cdn.example.test/b.png' }],
  }] }), /conflicting image sources/,
  'remote aliases with different paths must reject');
  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-conflicting-remote-credentials', title: 'Conflicting remote credentials', notesText: 'Must reject',
    extractedImages: [{ imageBase64: 'https://User:Pass@cdn.example.test/a.png', src: 'https://user:Pass@cdn.example.test/a.png' }],
  }] }), /conflicting image sources/,
  'remote aliases with credential case differences must reject');

  const sameBlob = new context.Blob(['same bytes'], { type: 'image/png' });
  const sameBlobPlan = context._buildImportPlan({ notes: [{
    id: 'legacy-same-blob-aliases', title: 'Same Blob aliases', notesText: 'Keep Blob',
    extractedImages: [{ data: sameBlob, blob: sameBlob }],
  }] });
  assert.equal(sameBlobPlan.notes[0].note.extractedImages[0].data, sameBlob,
    'the same Blob object in multiple aliases remains compatible');
  const firstBlob = new context.Blob(['same bytes'], { type: 'image/png' });
  const secondBlob = new context.Blob(['same bytes'], { type: 'image/png' });
  assert.throws(() => context._buildImportPlan({ notes: [{
    id: 'legacy-different-blob-aliases', title: 'Different Blob aliases', notesText: 'Must reject',
    extractedImages: [{ data: firstBlob, blob: secondBlob }],
  }] }), /conflicting image sources/,
  'different Blob objects reject even when their bytes match');

  const detachedRoundTrip = context.detachNoteImages({
    id: 'byte-round-trip',
    title: 'Byte round trip',
    notesText: 'HTML and aliases',
    notesHtml: `<p>body</p><img src="${png}" data-note-image-ref="note-image-0">`,
    extractedImages: [{ markerId: 'note-image-0', imageBase64: png, mimeType: 'image/png', fileName: 'one.png' }],
    slideImages: [, { imageBase64: 'data:image/jpeg;base64,/9j/', mimeType: 'image/jpeg', fileName: 'two.jpg' }],
  });
  assert.equal(detachedRoundTrip.note.notesHtml.includes('data:image/'), false);
  assert.equal(detachedRoundTrip.imageRecord.images.length, 2, 'HTML/array aliases have detached owners');
  const hydratedRoundTrip = await context.hydrateNoteImages(detachedRoundTrip.note, detachedRoundTrip.imageRecord);
  assert.equal(hydratedRoundTrip.extractedImages[0].imageBase64, 'iVBORw0KGgo=');
  assert.equal(hydratedRoundTrip.slideImages[1].imageBase64, '/9j/');
  assert.match(hydratedRoundTrip.notesHtml, /data:image\/png;base64,iVBORw0KGgo=/);

  const invalidWrites = [];
  context.getAllNotesFS = async () => [];
  context.getAllFoldersFS = async () => [];
  context.saveFolderFS = async folder => { invalidWrites.push({ type: 'folder', value: folder }); };
  context.saveNoteFS = async note => { invalidWrites.push({ type: 'note', value: note }); };
  async function assertRejectedImport(data, label) {
    invalidWrites.length = 0;
    await context.importNotes({ value: label, files: [{ text: async () => JSON.stringify(data) }] });
    assert.equal(invalidWrites.length, 0, `${label} must reject before any folder/note write`);
  }
  const validDetachedNote = {
    id: 'invalid-fixture-note', title: 'Valid title', notesText: 'Valid body',
    notesHtml: '<img src="" data-note-image-ref="note-image-0">',
  };
  const validPortable = {
    field: 'extractedImages', index: 0, markerId: 'note-image-0',
    mimeType: 'image/png', dataUrl: png,
  };
  await assertRejectedImport({ schema: 'foreign.storage', version: 2, folders: [], notes: [] }, 'foreign schema');
  await assertRejectedImport({ version: 2, folders: [], notes: [] }, 'version-only declaration');
  await assertRejectedImport({ schema: 'notyx.storage2', folders: [], notes: [] }, 'schema-only declaration');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 3, folders: [], notes: [] }, 'unsupported version');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: {} }, 'malformed notes shape');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [
    { note: { ...validDetachedNote, id: 'duplicate-note' }, images: [] },
    { note: { ...validDetachedNote, id: 'duplicate-note' }, images: [] },
  ] }, 'duplicate note id');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [{ id: 'duplicate-folder', name: 'one' }, { id: 'duplicate-folder', name: 'two' }], notes: [] }, 'duplicate folder id');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{ note: validDetachedNote, images: [validPortable, validPortable] }] }, 'duplicate owner');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{ note: validDetachedNote, images: [validPortable, { ...validPortable, field: 'slideImages' }] }] }, 'duplicate marker');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{ note: validDetachedNote, images: [{ ...validPortable, field: 'slideImageUrls' }] }] }, 'arbitrary image field');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{ note: validDetachedNote, images: [{ ...validPortable, dataUrl: 'data:image/png;base64,not valid???' }] }] }, 'invalid data URL');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, slideImageUrls: [png] }, images: [],
  }] }, 'detached slideImageUrls data URL');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, slideImageUrls: [{ url: remote }] }, images: [],
  }] }, 'detached slideImageUrls object');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, notesHtml: { html: 'not a string' } }, images: [],
  }] }, 'non-string notesHtml');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, cover: { imageBase64: png } }, images: [],
  }] }, 'nested image alias');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, cover: { mimeType: 'image/png', raw: 'iVBORw0KGgo=' } }, images: [],
  }] }, 'nested raw image payload');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, extractedImages: ['not canonical'] }, images: [],
  }] }, 'malformed canonical image entry');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: validDetachedNote,
    images: [{ ...validPortable, imageBase64: png }],
  }] }, 'extra portable image alias');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: { ...validDetachedNote, notesHtml: '<img src="" data-note-image-ref="note-image-1">' },
    images: [{ field: 'html', index: 0, markerId: 'note-image-0', mimeType: 'image/png', dataUrl: png }],
  }] }, 'orphan HTML owner');
  await assertRejectedImport({ notes: [{
    id: 'legacy-nested-alias', title: 'Legacy nested alias', notesText: 'Must reject',
    cover: { imageBase64: png },
  }] }, 'legacy nested image alias');
  await assertRejectedImport({
    schema: 'notyx.storage2', version: 2, folders: [],
    exportedMetadata: { cover: { imageBase64: png } },
    notes: [{ note: { id: 'top-level-extra', title: 'Top extra', notesText: 'Must reject' }, images: [] }],
  }, 'v2 top-level nested image alias');
  await assertRejectedImport({ notes: [{
    id: 'legacy-malformed-primitive', title: 'Legacy malformed', notesText: 'Must reject',
    extractedImages: [42],
  }] }, 'legacy malformed canonical primitive');
  await assertRejectedImport({ notes: [{
    id: 'legacy-nested-canonical-alias', title: 'Legacy nested alias', notesText: 'Must reject',
    extractedImages: [{ metadata: { imageBase64: png } }],
  }] }, 'legacy nested canonical image alias');
  await assertRejectedImport({ notes: [{
    id: 'legacy-non-img-html-payload', title: 'Legacy HTML payload', notesText: 'Must reject',
    notesHtml: '<p data-image="data:image/png;base64,iVBORw0KGgo=">text</p>',
  }] }, 'legacy non-img HTML payload');
  await assertRejectedImport({
    folders: [{ id: 'should-not-write', name: 'Should not write' }],
    notes: [{
      id: 'legacy-import-conflicting-remote-credentials', title: 'Conflicting remote credentials', notesText: 'Must reject',
      extractedImages: [{ imageBase64: 'https://User:Pass@cdn.example.test/a.png', src: 'https://user:Pass@cdn.example.test/a.png' }],
    }],
  }, 'legacy import conflicting remote credentials');

  const remoteMarkerNote = {
    id: 'remote-marker-collision', title: 'Remote marker', notesText: 'Remote source',
    notesHtml: '<img src="https://cdn.example.test/remote.png" data-note-image-ref="note-image-7">',
  };
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: remoteMarkerNote,
    images: [{ field: 'extractedImages', index: 0, markerId: 'note-image-7', mimeType: 'image/png', dataUrl: png }],
  }] }, 'remote HTML marker extracted owner collision');
  await assertRejectedImport({ schema: 'notyx.storage2', version: 2, folders: [], notes: [{
    note: remoteMarkerNote,
    images: [{ field: 'slideImages', index: 0, markerId: 'note-image-7', mimeType: 'image/png', dataUrl: png }],
  }] }, 'remote HTML marker slide owner collision');
  const normalisedRemoteMarker = context._normaliseImportedNote({
    note: remoteMarkerNote,
    images: [{ field: 'extractedImages', index: 0, markerId: 'note-image-7', mimeType: 'image/png', dataUrl: png }],
  });
  assert.match(normalisedRemoteMarker.notesHtml, /src="https:\/\/cdn\.example\.test\/remote\.png"/,
    'normalization must never replace a remote HTML source');

  const remoteHtmlPlan = context._buildImportPlan({
    schema: 'notyx.storage2', version: 2, folders: [], notes: [{
      note: {
        id: 'remote-html-note', title: 'Remote HTML', notesText: 'Remote body',
        notesHtml: '<img src="https://cdn.example.test/remote.png" data-note-image-ref="note-image-9">',
      },
      images: [],
    }],
  });
  assert.equal(remoteHtmlPlan.notes.length, 1, 'remote HTML marker without local owner remains valid v2 metadata');
  context.saveNoteFS = async note => { importCalls.push(note); return note; };
  await context.importNotes({
    value: 'remote-html-import',
    files: [{ text: async () => JSON.stringify({
      schema: 'notyx.storage2', version: 2, folders: [], notes: [{
        note: {
          id: 'remote-html-import', title: 'Remote HTML', notesText: 'Remote body',
          notesHtml: '<img src="https://cdn.example.test/remote.png" data-note-image-ref="note-image-9">',
        },
        images: [],
      }],
    }) }],
  });
  assert.equal(importCalls.length, 5, 'remote HTML v2 import uses the real note writer');
  assert.match(importCalls.at(-1).notesHtml, /https:\/\/cdn\.example\.test\/remote\.png/);

  assert.throws(() => context._buildImportPlan({
    schema: 'notyx.storage2', version: 2, folders: [], notes: [{
      note: { ...validDetachedNote, cover: { blob: new Blob(['local']) } }, images: [],
    }],
  }), /Blob|local image payload/, 'v2 import rejects Blob values before any write');

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
    removeItem: key => localStore.delete(key),
  };
  context.getAllNotes = async () => [
    { id: 'url-only', title: 'URL only', notesText: 'No local image', extractedImages: [{ imageBase64: remote, mimeType: 'url' }] },
    { id: 'marker-without-blob', title: 'Marker only', notesText: 'No local record', extractedImages: [{ markerId: 'note-image-1', mimeType: 'image/png' }] },
    { id: 'local-image', title: 'Local image', notesText: 'Needs upload', extractedImages: [{ markerId: 'note-image-0', mimeType: 'image/png' }] },
  ];
  context.getAllFolders = async () => [];
  context.hasLocalNoteImageBlobs = async id => id === 'local-image';
  context.getNote = async id => { migrationGets.push(id); return { id, title: 'Local image', notesText: 'Needs upload', extractedImages: [{ imageBase64: png, mimeType: 'image/png' }] }; };
  context.saveNoteFS = async note => { migrationSaves.push(note); return note; };
  context.saveFolderFS = async () => {};
  await context.migrateLocalToFirestore();
  assert.deepEqual(migrationGets, ['local-image'], 'local-to-Firestore migration hydrates only confirmed local Blob owners');
  assert.deepEqual(migrationSaves.map(note => note.id), ['url-only', 'marker-without-blob', 'local-image']);
  assert.equal(localStore.get('fs_migrated_migration-user'), 'true', 'successful migration sets the retry flag');

  const nullHydrationSaves = [];
  context.currentUser = { uid: 'null-hydration-user' };
  context.getAllNotes = async () => [{ id: 'null-hydration-note', title: 'Needs hydration', notesText: 'Body' }];
  context.hasLocalNoteImageBlobs = async () => true;
  context.getNote = async () => null;
  context.saveNoteFS = async note => { nullHydrationSaves.push(note); };
  await context.migrateLocalToFirestore();
  assert.equal(nullHydrationSaves.length, 0, 'positive local-image probe must not save stale metadata after null hydration');
  assert.equal(localStore.has('fs_migrated_null-hydration-user'), false, 'null hydration keeps retry flag unset');

  localStore.delete('fs_migrated_migration-retry-user');
  context.currentUser = { uid: 'migration-retry-user' };
  context.getAllNotes = async () => [{ id: 'retry-note', title: 'Retry note', notesText: 'Retry body', extractedImages: [{ markerId: 'note-image-2' }] }];
  context.hasLocalNoteImageBlobs = async () => true;
  context.getNote = async () => { throw new Error('hydration failed'); };
  context.saveNoteFS = async () => { throw new Error('must not save after hydration failure'); };
  await context.migrateLocalToFirestore();
  assert.equal(localStore.has('fs_migrated_migration-retry-user'), false, 'failed required migration keeps retry state unset');
  context.getNote = async id => ({ id, title: 'Retry note', notesText: 'Retry body', extractedImages: [{ imageBase64: png, mimeType: 'image/png' }] });
  context.saveNoteFS = async note => { migrationSaves.push(note); };
  await context.migrateLocalToFirestore();
  assert.equal(localStore.get('fs_migrated_migration-retry-user'), 'true', 'retry success sets the migration flag');

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
  context.openDB = async () => ({});
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
