const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'note_images.js'),
  'utf8',
);

const context = {
  Blob,
  atob,
  btoa,
  FileReader: undefined,
  console,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(source, context, { filename: 'note_images.js' });

const {
  isDataImageSource,
  isRemoteImageSource,
  dataUrlToBlob,
  blobToDataUrl,
  detachNoteImages,
  hydrateNoteImages,
  stripNoteImagePayloads,
  isQuotaExceededError,
} = context;

const PNG_DATA_URL = 'data:image/png;base64, iVBORw0KGgo=';
const PNG_BASE64 = 'iVBORw0KGgo=';
const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/';
const REMOTE_URL = 'https://cdn.example.test/slide-2.png';

function assertNoImagePayloads(note) {
  for (const field of ['extractedImages', 'slideImages']) {
    for (const image of note[field] || []) {
      if (!image) continue;
      assert.notEqual(typeof image.imageBase64 === 'string' && image.imageBase64.startsWith('data:'), true,
        `${field} contains a data URL`);
      assert.notEqual(typeof image.src === 'string' && image.src.startsWith('data:'), true,
        `${field} contains a data URL in src`);
      assert.notEqual(typeof image.data === 'string' && image.data.startsWith('data:'), true,
        `${field} contains a data URL in data`);
      assert.equal(image.blob instanceof Blob, false, `${field} contains a Blob`);
    }
  }
  assert.equal(/data:image\//i.test(note.notesHtml || ''), false, 'notesHtml contains a data URL');
}

async function run() {
  assert.equal(isDataImageSource(PNG_DATA_URL), true);
  assert.equal(isDataImageSource('data:text/plain;base64,SGk='), false);
  assert.equal(isDataImageSource(REMOTE_URL), false);
  assert.equal(isRemoteImageSource(REMOTE_URL, 'url'), true);
  assert.equal(isRemoteImageSource(REMOTE_URL, 'image/png'), true);
  assert.equal(isRemoteImageSource(PNG_DATA_URL, 'url'), false);
  assert.equal(isRemoteImageSource('not-a-url', 'url'), false);

  const pngBlob = dataUrlToBlob(PNG_DATA_URL);
  assert.equal(pngBlob instanceof Blob, true);
  assert.equal(pngBlob.type, 'image/png');
  assert.equal(pngBlob.size, 8);
  assert.equal(await blobToDataUrl(pngBlob), 'data:image/png;base64,iVBORw0KGgo=');

  const sourceNote = {
    id: 'note-1',
    title: '혼합 이미지',
    folderId: 'folder-7',
    customMetadata: { keep: true },
    extractedImages: [
      { slideNumber: 4, imageBase64: PNG_BASE64, mimeType: 'image/png', fileName: 'four.png', alt: '첫 이미지' },
      null,
      { slideNumber: 9, imageBase64: REMOTE_URL, mimeType: 'url', fileName: 'nine.png', alt: '원격 이미지' },
    ],
    slideImages: [
      { slideNumber: 4, imageBase64: PNG_BASE64, mimeType: 'image/png', fileName: 'four.png' },
      null,
      { slideNumber: 9, imageBase64: REMOTE_URL, mimeType: 'url', fileName: 'nine.png' },
    ],
    slideImageUrls: [null, REMOTE_URL, null],
    notesHtml: `<p>본문</p><img class="slide" src="${PNG_DATA_URL}" alt="첫 이미지"><img src="${REMOTE_URL}">`,
  };

  const detached = detachNoteImages(sourceNote);
  assert.notStrictEqual(detached.note, sourceNote);
  assert.deepEqual(sourceNote.extractedImages[0].imageBase64, PNG_BASE64, 'detach does not mutate input');
  assert.equal(detached.note.customMetadata.keep, true);
  assert.equal(detached.note.extractedImages[0].slideNumber, 4);
  assert.equal(detached.note.extractedImages[0].mimeType, 'image/png');
  assert.equal(detached.note.extractedImages[0].fileName, 'four.png');
  assert.equal(detached.note.extractedImages[0].imageBase64, undefined);
  assert.deepEqual(detached.note.extractedImages[1], null, 'sparse slot remains in extractedImages');
  assert.equal(detached.note.extractedImages[2].imageBase64, REMOTE_URL, 'URL entry remains in place');
  assert.equal(JSON.stringify(detached.note.slideImageUrls), JSON.stringify([null, REMOTE_URL, null]), 'slideImageUrls remains aligned');
  assert.equal(detached.imageRecord.images.length, 2, 'local image record keeps one entry per source image');
  assert.equal(JSON.stringify(detached.imageRecord.images.map(image => image.slideNumber)), JSON.stringify([4, 4]));
  assert.equal(JSON.stringify(detached.imageRecord.images.map(image => image.fileName)), JSON.stringify(['four.png', 'four.png']));
  assert.equal(JSON.stringify(detached.imageRecord.images.map(image => image.mimeType)), JSON.stringify(['image/png', 'image/png']));
  assert.equal(JSON.stringify(detached.imageRecord.images.map(image => image.index)), JSON.stringify([0, 0]));
  assert.equal(detached.imageRecord.images.every(image => image.blob instanceof Blob), true);
  assert.match(detached.note.notesHtml, /data-note-image-ref="note-image-0"/);
  assert.doesNotMatch(detached.note.notesHtml, /data:image\//i);
  assertNoImagePayloads(detached.note);

  const detachedAgain = detachNoteImages(sourceNote);
  assert.equal(detached.note.notesHtml, detachedAgain.note.notesHtml, 'marker IDs are deterministic');
  assert.equal(
    JSON.stringify(detached.imageRecord.images.map(image => image.markerId)),
    JSON.stringify(detachedAgain.imageRecord.images.map(image => image.markerId)),
  );

  const hydrated = await hydrateNoteImages(detached.note, detached.imageRecord);
  assert.equal(hydrated.extractedImages[0].imageBase64, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(hydrated.extractedImages[1], null, 'hydration preserves sparse slots');
  assert.equal(hydrated.extractedImages[2].imageBase64, REMOTE_URL, 'hydration preserves remote URL');
  assert.equal(hydrated.slideImages[0].imageBase64, 'data:image/png;base64,iVBORw0KGgo=');
  assert.match(hydrated.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(hydrated.notesHtml, /data-note-image-ref="note-image-0"/);
  assert.equal(detached.note.notesHtml.includes('data:image/'), false, 'hydration does not mutate lightweight note');

  const omitted = detachNoteImages({ id: 'note-1', title: 'metadata only' }, detached.imageRecord);
  assert.equal(omitted.imageIntent.overall, 'preserve');
  assert.equal(omitted.imageIntent.extractedImages, 'preserve');
  assert.equal(omitted.imageIntent.slideImages, 'preserve');

  const deleted = detachNoteImages({ id: 'note-1', extractedImages: [], slideImages: [] }, detached.imageRecord);
  assert.equal(deleted.imageIntent.overall, 'delete');
  assert.equal(deleted.imageIntent.extractedImages, 'delete');
  assert.equal(deleted.imageIntent.slideImages, 'delete');
  assert.equal(deleted.imageRecord.images.length, 0);

  const replacement = detachNoteImages({
    id: 'note-1',
    extractedImages: [{ slideNumber: 12, imageBase64: JPEG_DATA_URL, mimeType: 'image/jpeg', fileName: 'twelve.jpg' }],
  }, detached.imageRecord);
  assert.equal(replacement.imageIntent.overall, 'replace');
  assert.equal(replacement.imageIntent.extractedImages, 'replace');
  assert.equal(replacement.imageIntent.slideImages, 'preserve');
  assert.equal(replacement.imageRecord.images.find(image => image.field === 'extractedImages').slideNumber, 12);
  assertNoImagePayloads(replacement.note);

  const stripped = stripNoteImagePayloads(sourceNote);
  assertNoImagePayloads(stripped);
  assert.equal(stripped.extractedImages[2].imageBase64, REMOTE_URL);
  assert.equal(stripped.customMetadata.keep, true);
  assert.equal(sourceNote.notesHtml.includes(PNG_DATA_URL), true, 'strip does not mutate input HTML');

  assert.equal(isQuotaExceededError({ name: 'QuotaExceededError' }), true);
  assert.equal(isQuotaExceededError({ code: 22 }), true);
  assert.equal(isQuotaExceededError(new Error('unrelated failure')), false);

  console.log('note images: 8 checks passed');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
