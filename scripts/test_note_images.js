const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'note_images.js'),
  'utf8',
);
const markdownSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'markdown.js'),
  'utf8',
);
const imageGallerySource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'image_gallery.js'),
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
vm.runInNewContext(markdownSource, context, { filename: 'markdown.js' });
vm.runInNewContext(imageGallerySource, context, { filename: 'image_gallery.js' });

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

const PAYLOAD_ALIASES = new Set(['imageBase64', 'src', 'data', 'blob', 'payload', 'base64', 'imageData']);

function assertNoPersistedPayload(value, key, pathName) {
  if (value instanceof Blob) assert.fail(`${pathName} contains a Blob`);
  if (typeof value === 'string') {
    assert.equal(/^data:image\//i.test(value), false, `${pathName} contains a data URL`);
    if (PAYLOAD_ALIASES.has(key)) {
      assert.equal(/^[A-Za-z0-9+/]+={0,2}$/.test(value.replace(/[\r\n\t ]/g, '')) && value.length >= 8, false,
        `${pathName} contains raw base64`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (i in value) assertNoPersistedPayload(value[i], key, `${pathName}[${i}]`);
    }
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assertNoPersistedPayload(childValue, childKey, `${pathName}.${childKey}`);
  }
}

function assertNoImagePayloads(note) {
  for (const field of ['extractedImages', 'slideImages']) {
    assertNoPersistedPayload(note[field] || [], field, field);
  }
  assert.equal(/data:image\//i.test(note.notesHtml || ''), false, 'notesHtml contains a data URL');
  assert.doesNotMatch(note.notesHtml || '', /<img\b[^>]*\bsrc\s*=\s*["'][A-Za-z0-9+/]{8,}={0,2}["']/i,
    'notesHtml contains raw base64 in img src');
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || value instanceof Blob || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function snapshot(value) {
  return JSON.stringify(value, (key, child) => {
    if (child instanceof Blob) return `[Blob:${child.type}:${child.size}]`;
    return child;
  });
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
      { slideNumber: 4, imageBase64: PNG_BASE64, mimeType: 'image/png', fileName: 'four.png', alt: '첫 이미지', nested: { blob: new Blob(['nested'], { type: 'image/png' }), data: PNG_DATA_URL } },
      ,
      { slideNumber: 9, imageBase64: REMOTE_URL, mimeType: 'url', fileName: 'nine.png', alt: '원격 이미지' },
    ],
    slideImages: [
      { slideNumber: 4, imageBase64: PNG_BASE64, mimeType: 'image/png', fileName: 'four.png' },
      ,
      { slideNumber: 9, imageBase64: REMOTE_URL, mimeType: 'url', fileName: 'nine.png' },
    ],
    slideImageUrls: [null, REMOTE_URL, null],
    notesHtml: `<p>본문</p><img class="slide" src="${PNG_DATA_URL}" alt="첫 이미지"><img src="${REMOTE_URL}">`,
  };

  const sourceSnapshot = snapshot(sourceNote);
  deepFreeze(sourceNote);
  const detached = detachNoteImages(sourceNote);
  assert.notStrictEqual(detached.note, sourceNote);
  assert.equal(sourceNote.extractedImages[0].imageBase64, PNG_BASE64, 'detach does not mutate input');
  assert.equal(snapshot(sourceNote), sourceSnapshot, 'detach does not mutate frozen input');
  assert.equal(detached.note.customMetadata.keep, true);
  assert.equal(detached.note.extractedImages[0].slideNumber, 4);
  assert.equal(detached.note.extractedImages[0].mimeType, 'image/png');
  assert.equal(detached.note.extractedImages[0].fileName, 'four.png');
  assert.equal(detached.note.extractedImages[0].imageBase64, undefined);
  assert.equal(1 in detached.note.extractedImages, false, 'real sparse hole remains in extractedImages');
  assert.equal(detached.note.extractedImages[2].imageBase64, REMOTE_URL, 'URL entry remains in place');
  assert.equal(JSON.stringify(detached.note.slideImageUrls), JSON.stringify([null, REMOTE_URL, null]), 'slideImageUrls remains aligned');
  const arrayOwners = detached.imageRecord.images.filter(image => image.field !== 'html');
  assert.equal(arrayOwners.length, 2, 'array owners keep one entry per local array source');
  assert.equal(detached.imageRecord.images.filter(image => image.field === 'html').length, 1,
    'HTML keeps an independent local owner');
  assert.equal(JSON.stringify(arrayOwners.map(image => image.slideNumber)), JSON.stringify([4, 4]));
  assert.equal(JSON.stringify(arrayOwners.map(image => image.fileName)), JSON.stringify(['four.png', 'four.png']));
  assert.equal(JSON.stringify(arrayOwners.map(image => image.mimeType)), JSON.stringify(['image/png', 'image/png']));
  assert.equal(JSON.stringify(arrayOwners.map(image => image.index)), JSON.stringify([0, 0]));
  assert.equal(detached.imageRecord.images.every(image => image.blob instanceof Blob), true);
  assert.match(detached.note.notesHtml, /data-note-image-ref="note-image-2"/);
  assert.doesNotMatch(detached.note.notesHtml, /data:image\//i);
  assertNoImagePayloads(detached.note);

  const detachedAgain = detachNoteImages(sourceNote);
  assert.equal(detached.note.notesHtml, detachedAgain.note.notesHtml, 'marker IDs are deterministic');
  assert.equal(
    JSON.stringify(detached.imageRecord.images.map(image => image.markerId)),
    JSON.stringify(detachedAgain.imageRecord.images.map(image => image.markerId)),
  );

  const hydrated = await hydrateNoteImages(detached.note, detached.imageRecord);
  assert.equal(hydrated.extractedImages[0].imageBase64, 'iVBORw0KGgo=', 'hydration restores raw viewer payload');
  assert.equal(1 in hydrated.extractedImages, false, 'hydration preserves sparse slots');
  assert.equal(hydrated.extractedImages[2].imageBase64, REMOTE_URL, 'hydration preserves remote URL');
  assert.equal(hydrated.slideImages[0].imageBase64, 'iVBORw0KGgo=');
  assert.equal(context.getImgSrc(hydrated.extractedImages[0]), 'data:image/png;base64,iVBORw0KGgo=',
    'existing getImgSrc boundary produces exactly one data URL prefix');
  assert.match(hydrated.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(hydrated.notesHtml, /data-note-image-ref="note-image-2"/);
  assert.equal(detached.note.notesHtml.includes('data:image/'), false, 'hydration does not mutate lightweight note');

  const subsetSource = {
    id: 'subset-owner',
    extractedImages: [
      ,
      { slideNumber: 1, imageBase64: REMOTE_URL, mimeType: 'url' },
      { slideNumber: 3, imageBase64: PNG_DATA_URL, mimeType: 'image/png', markerId: 'note-image-2' },
    ],
    notesHtml: `<img src="${PNG_DATA_URL}" data-note-image-ref="note-image-2">` +
      `<img src="${REMOTE_URL}" data-note-image-ref="remote-slide-1">`,
  };
  const subsetDetached = detachNoteImages(subsetSource);
  const subsetOwner = subsetDetached.imageRecord.images.find(image => image.field === 'extractedImages');
  assert.equal(subsetOwner.index, 2, 'sparse extracted owner keeps its source index');
  assert.equal(subsetOwner.markerId, 'note-image-2', 'gallery marker stays attached to sparse owner');
  assert.equal(subsetDetached.imageRecord.images.filter(image => image.field === 'html').length, 0,
    'HTML referencing an array owner must not create a duplicate HTML Blob');
  const subsetHydrated = await hydrateNoteImages(subsetDetached.note, subsetDetached.imageRecord);
  assert.equal(2 in subsetHydrated.extractedImages, true, 'sparse owner hydrates at its original index');
  assert.equal(0 in subsetHydrated.extractedImages, false, 'sparse owner must not move to index zero');
  assert.match(subsetHydrated.notesHtml, /data-note-image-ref="note-image-2"/);
  assert.match(subsetHydrated.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);

  const subsetRepeated = detachNoteImages(subsetHydrated, subsetDetached.imageRecord);
  assert.equal(subsetRepeated.imageRecord.images.length, subsetDetached.imageRecord.images.length,
    'hydrated updates must not grow detached ownership records');
  assert.deepEqual(
    subsetRepeated.imageRecord.images.map(image => [image.field, image.index, image.markerId]),
    subsetDetached.imageRecord.images.map(image => [image.field, image.index, image.markerId]),
    'hydrated updates preserve ownership markers and indexes',
  );

  const sharedOwner = detachNoteImages({
    id: 'shared-owner',
    extractedImages: [{ slideNumber: 1, imageBase64: PNG_BASE64, mimeType: 'image/png', fileName: 'shared.png' }],
    notesHtml: `<img src="${PNG_DATA_URL}">`,
  });
  const deletedArrayOwner = detachNoteImages({
    id: 'shared-owner',
    notesHtml: sharedOwner.note.notesHtml,
    extractedImages: [],
  }, sharedOwner.imageRecord);
  const hydratedPreservedHtml = await hydrateNoteImages(
    deletedArrayOwner.note,
    deletedArrayOwner.imageRecord,
  );
  assert.match(hydratedPreservedHtml.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/,
    'omitted HTML must retain its own local image owner');

  const omittedArrayUpdate = detachNoteImages({
    id: 'shared-owner',
    extractedImages: [],
  }, sharedOwner.imageRecord);
  assert.equal(Object.prototype.hasOwnProperty.call(omittedArrayUpdate.note, 'notesHtml'), false,
    'partial array update truly omits notesHtml');
  const storageMergedNote = { ...sharedOwner.note, ...omittedArrayUpdate.note };
  const hydratedAfterStorageMerge = await hydrateNoteImages(
    storageMergedNote,
    omittedArrayUpdate.imageRecord,
  );
  assert.match(hydratedAfterStorageMerge.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/,
    'omitted notesHtml keeps the persisted marker valid after storage-style merge');

  const oldHtml = detachNoteImages({
    id: 'html-replacement',
    notesHtml: `<p>old</p><img src="${PNG_DATA_URL}">`,
  });
  const newHtml = detachNoteImages({
    id: 'html-replacement',
    notesHtml: '<p>new without an image</p>',
  }, oldHtml.imageRecord);
  assert.equal(newHtml.imageRecord.images.some(image => image.field === 'html'), false,
    'replacing HTML must remove stale HTML-owned Blobs');

  const metadataOnly = detachNoteImages({
    id: 'metadata-only-entry',
    extractedImages: [
      ,
      { slideNumber: 6, fileName: 'metadata-only.png', mimeType: 'image/png', custom: { keep: 'yes' } },
    ],
  });
  assert.equal(1 in metadataOnly.note.extractedImages, true, 'source-less entry keeps its sparse slot');
  assert.equal(metadataOnly.note.extractedImages[1].slideNumber, 6);
  assert.equal(metadataOnly.note.extractedImages[1].fileName, 'metadata-only.png');
  assert.equal(metadataOnly.note.extractedImages[1].custom.keep, 'yes');

  const rawHtml = detachNoteImages({
    id: 'raw-html',
    notesHtml: '<img src="iVBORw0KGgo=" type="image/png">'
      + '<img src="/assets/slide.png">'
      + `<img src="${REMOTE_URL}">`,
  });
  assert.doesNotMatch(rawHtml.note.notesHtml, /src="iVBORw0KGgo="/,
    'raw base64 must not remain in persisted HTML src');
  assert.match(rawHtml.note.notesHtml, /data-note-image-ref="note-image-0"/);
  assert.match(rawHtml.note.notesHtml, /src="\/assets\/slide\.png"/,
    'relative URL must remain unchanged');
  assert.match(rawHtml.note.notesHtml, new RegExp(`src="${REMOTE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'remote URL must remain unchanged');
  assert.equal(rawHtml.imageRecord.images.length, 1);
  assert.equal(rawHtml.imageRecord.images[0].mimeType, 'image/png');

  const rawHtmlWithoutMime = detachNoteImages({
    id: 'raw-html-without-mime',
    notesHtml: '<img src="iVBORw0KGgo=">'
      + '<img src="/assets/slide.png">'
      + `<img src="${REMOTE_URL}">`,
  });
  assert.doesNotMatch(rawHtmlWithoutMime.note.notesHtml, /src="iVBORw0KGgo="/,
    'raw PNG base64 without MIME context must not remain in persisted HTML');
  assert.match(rawHtmlWithoutMime.note.notesHtml, /data-note-image-ref="note-image-0"/);
  assert.match(rawHtmlWithoutMime.note.notesHtml, /src="\/assets\/slide\.png"/);
  assert.equal(rawHtmlWithoutMime.imageRecord.images[0].mimeType, 'image/png');

  const omitted = detachNoteImages({ id: 'note-1', title: 'metadata only' }, detached.imageRecord);
  assert.equal(omitted.imageIntent.overall, 'preserve');
  assert.equal(omitted.imageIntent.extractedImages, 'preserve');
  assert.equal(omitted.imageIntent.slideImages, 'preserve');

  const deleted = detachNoteImages({ id: 'note-1', extractedImages: [], slideImages: [] }, detached.imageRecord);
  assert.equal(deleted.imageIntent.overall, 'delete');
  assert.equal(deleted.imageIntent.extractedImages, 'delete');
  assert.equal(deleted.imageIntent.slideImages, 'delete');
  assert.equal(deleted.imageRecord.images.filter(image => image.field === 'html').length, 1,
    'omitted HTML ownership survives array deletion');

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

  const galleryImage = { slideNumber: 4, imageBase64: PNG_BASE64, mimeType: 'image/png' };
  context.extractedImages = [galleryImage];
  assert.equal(
    context.noteImageMarkerForGallery(galleryImage),
    'note-image-0',
    'gallery images receive deterministic marker metadata',
  );

  const galleryHtml = `<figure><img src="${PNG_DATA_URL}" data-note-image-ref="note-image-0"></figure>`;
  const galleryFields = stripNoteImagePayloads({ notesHtml: galleryHtml });
  assert.match(galleryFields.notesHtml, /data-note-image-ref="note-image-0"/);
  assert.doesNotMatch(galleryFields.notesHtml, /data:image\//i);

  console.log('note images: 8 checks passed');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
