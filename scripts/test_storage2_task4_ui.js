const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
const context = {
  Blob,
  atob,
  btoa,
  FileReader: undefined,
  console,
  setTimeout,
  clearTimeout,
  window: { recorderLastAudioPath: null },
};

for (const file of ['note_images.js', 'markdown.js', 'image_gallery.js', 'notes_crud.js', 'firestore_sync.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
  vm.runInNewContext(source, context, { filename: file });
}

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const warnings = [];
context.document = {
  getElementById(id) {
    if (id === 'finalNotesBody') {
      return { innerHTML: `<p>본문</p><img src="${PNG_DATA_URL}" data-note-image-ref="note-image-0">` };
    }
    return null;
  },
};
context.showToast = message => warnings.push(message);
context.storedNotesText = '본문';
context.storedPptText = '';
context.storedFilteredText = '';
context.storedHighlightedTranscript = '';
context.extractedImages = [{ slideNumber: 1, imageBase64: PNG_DATA_URL, mimeType: 'image/png' }];
context.currentSummaryLayers = null;
context.currentStudyTools = null;
context.pptFile = null;

const fields = context.buildNoteSaveFields({ title: '테스트 노트', folderId: null });
assert.match(fields.notesHtml, /data-note-image-ref="note-image-0"/);
assert.match(fields.notesHtml, /data:image\//i, 'runtime HTML must reach the persistence boundary');
assert.doesNotMatch(context.detachNoteImages(fields).note.notesHtml, /data:image\//i,
  'the detached persistence boundary must remove data URLs');

const degraded = {
  id: 'note-1',
  saveStatus: 'image-degraded',
  degradation: { resource: 'noteImages', reason: 'quota' },
};
assert.equal(context.showImageDegradationWarning(degraded), true);
assert.equal(warnings.length, 1, 'one failed save produces one warning');
assert.match(warnings[0], /이미지/);
assert.match(warnings[0], /저장 공간|다시 저장/);
assert.equal(context.showImageDegradationWarning({ id: 'note-1' }), false);
assert.equal(warnings.length, 1, 'normal saves do not change warning count');

context.uuidv4 = () => 'ui-note-id';
context.currentUser = null;
context.saveNote = async () => ({
  id: 'ui-note-id',
  saveStatus: 'image-degraded',
  degradation: { resource: 'noteImages', reason: 'quota' },
});
const oversizedResult = await context.saveNoteFS({
  id: 'oversized-ui-note',
  title: 'Oversized UI note',
  notesText: '본문',
  pptText: 'x'.repeat(960000),
});
assert.equal(oversizedResult.saveStatus, 'image-degraded',
  'oversized Firestore documents must preserve local image degradation');

context.currentUser = { uid: 'ui-user' };
context.db = {
  collection() {
    return {
      doc() {
        return {
          collection() {
            return {
              doc() {
                return { set: async () => { throw new Error('remote write failed'); } };
              },
            };
          },
        };
      },
    };
  },
};
await assert.rejects(
  () => context.saveNoteFS({ id: 'remote-error-note', title: 'Remote error', notesText: '본문' }),
  error => error.saveStatus === 'image-degraded'
    && error.degradation?.resource === 'noteImages'
    && error.degradation?.reason === 'quota',
  'remote errors must carry the degraded local-save result',
);

context.currentUser = null;
assert.equal(
  (fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'notes_crud.js'), 'utf8')
    .match(/showImageDegradationWarning\(/g) || []).length >= 7,
  true,
  'every direct UI save path must consume degradation through the shared warning helper',
);

context.currentUser = { uid: 'reconcile-user' };
let getNoteCalls = 0;
let mirroredMetadata = null;
const localHydrated = {
  id: 'reconcile-note',
  title: 'local title',
  notesText: 'local text',
  notesHtml: '<p>local</p><img src="data:image/png;base64,iVBORw0KGgo=" data-note-image-ref="note-image-2">',
  extractedImages: [,, { slideNumber: 3, imageBase64: 'iVBORw0KGgo=', mimeType: 'image/png', markerId: 'note-image-2' }],
};
context.getNote = async () => { getNoteCalls += 1; return localHydrated; };
context.saveNote = async note => { mirroredMetadata = note; return note; };
context.db = {
  collection() {
    return {
      doc() {
        return {
          collection() {
            return {
              doc() {
                return {
                  get: async () => ({
                    exists: true,
                    data: () => ({ id: 'reconcile-note', title: 'remote title', notesText: 'remote text', slideImageUrls: ['https://cdn.example.test/remote.png'] }),
                  }),
                };
              },
            };
          },
        };
      },
    };
  },
};
const reconciled = await context.getNoteFS('reconcile-note');
assert.equal(getNoteCalls, 1, 'authenticated note open must read one local hydrated note');
assert.equal(reconciled.title, 'remote title', 'Firestore metadata remains authoritative');
assert.equal(reconciled.extractedImages[2].markerId, 'note-image-2',
  'local detached image ownership survives authenticated reconciliation');
assert.match(reconciled.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
assert.ok(mirroredMetadata, 'authenticated reconciliation must mirror metadata through the detached writer');
assert.equal(mirroredMetadata.extractedImages, undefined,
  'metadata mirroring must not bypass detached image ownership with array payloads');
assert.equal(mirroredMetadata.slideImages, undefined,
  'metadata mirroring must not bypass detached image ownership with slide payloads');

console.log('STORAGE2 Task 4 UI: GREEN contract checks passed');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
