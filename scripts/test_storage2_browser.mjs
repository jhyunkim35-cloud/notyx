import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const playwrightPath = 'C:/Users/김준현/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'browser', 'storage2-indexeddb.html');
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function assertNoPayload(value, label) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    assert.equal(/^data:image\//i.test(value), false, `${label} contains a data URL`);
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (index in value) assertNoPayload(value[index], `${label}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['imageBase64', 'src', 'data', 'blob', 'payload', 'base64', 'imageData'].includes(key)) {
      assert.equal(typeof child === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(child.replace(/[\r\n\t ]/g, '')) && child.length >= 8, false,
        `${label}.${key} contains raw base64`);
    }
    assertNoPayload(child, `${label}.${key}`);
  }
}

function noteWithoutImageFields(note) {
  const copy = { ...note };
  delete copy.extractedImages;
  delete copy.slideImages;
  delete copy.notesHtml;
  return copy;
}

function htmlRemoteSources(html) {
  return [...String(html || '').matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi)]
    .map(match => match[2]);
}

async function captureSnapshot(page, { production = false, version = 5 } = {}) {
  return page.evaluate(async ({ production, version }) => {
    function requestResult(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function readAll(database, storeName) {
      return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).getAll());
    }

    function arrayTopology(value) {
      if (!Array.isArray(value)) return null;
      return {
        length: value.length,
        present: Array.from({ length: value.length }, (_, index) => index in value),
      };
    }

    async function serializeImageRecord(record) {
      return {
        ...record,
        images: await Promise.all(record.images.map(async image => {
          const bytes = Array.from(new Uint8Array(await image.blob.arrayBuffer()));
          return {
            ...image,
            blob: { type: image.blob.type, size: image.blob.size, bytes },
          };
        })),
      };
    }

    async function captureDatabase(database) {
      const storeNames = Array.from(database.objectStoreNames).sort();
      const schema = {};
      const stores = {};
      for (const storeName of storeNames) {
        const transaction = database.transaction(storeName, 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const records = await readAll(database, storeName);
        schema[storeName] = {
          keyPath: objectStore.keyPath,
          indexes: Array.from(objectStore.indexNames).sort(),
        };
        stores[storeName] = {
          keyPath: objectStore.keyPath,
          indexes: Array.from(objectStore.indexNames).sort(),
          records: storeName === 'noteImages'
            ? await Promise.all(records.map(serializeImageRecord))
            : records,
        };
      }
      const notes = stores.notes?.records || [];
      const folders = stores.folders?.records || [];
      const quizResults = stores.quizResults?.records || [];
      const srsCards = stores.srsCards?.records || [];
      const imageRecords = stores.noteImages?.records || [];
      const noteTopologies = notes.map(note => ({
        id: note.id,
        extractedImages: arrayTopology(note.extractedImages),
        slideImages: arrayTopology(note.slideImages),
        slideImageUrls: arrayTopology(note.slideImageUrls),
      }));
      return {
        version: database.version,
        storeNames,
        schema,
        stores,
        notes,
        imageRecords,
        folders,
        quizResults,
        srsCards,
        noteTopologies,
      };
    }

    async function openLegacyDatabase() {
      return requestResult(indexedDB.open(DB_NAME, version));
    }

    async function captureTimetable() {
      const request = indexedDB.open('timetableDB', 1);
      const database = await requestResult(request);
      const snapshot = await captureDatabase(database);
      database.close();
      return snapshot;
    }

    const database = production ? await openDB() : await openLegacyDatabase();
    const first = await captureDatabase(database);
    database.close();
    const timetable = await captureTimetable();
    if (!production) return { first, timetable };

    const reopenedDatabase = await openDB();
    const reopened = await captureDatabase(reopenedDatabase);
    reopenedDatabase.close();
    return { first, reopened, timetable };
  }, { production, version });
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(fixturePath).href);
  await page.waitForFunction(() => window.__storage2FixtureReady === true);
  const runtime = await page.evaluate(() => ({
    productionConstantsLoaded: window.__storage2ProductionConstantsLoaded === true,
    scriptOrder: window.__storage2ScriptOrder || [],
    dbName: typeof DB_NAME === 'string' ? DB_NAME : null,
    dbVersion: typeof DB_VERSION === 'number' ? DB_VERSION : null,
  }));
  assert.equal(runtime.productionConstantsLoaded, true, 'fixture must execute public/js/constants.js');
    assert.deepEqual(runtime.scriptOrder, ['fixture-helpers', 'constants', 'note_images', 'markdown', 'storage', 'firestore_sync'],
    'fixture scripts must load production constants before Task 1 and storage');
  assert.equal(runtime.dbName, 'meetingAppDB', 'fixture must use the production DB name');

  await page.evaluate(() => window.__createV5Fixture());
  const legacy = await captureSnapshot(page);
  assert.equal(legacy.first.version, 5);
  assert.deepEqual(legacy.first.storeNames, ['folders', 'notes', 'quizResults', 'srsCards']);
  assert.equal(legacy.first.stores.noteImages, undefined);
  const expectedNoteTopologies = [
    {
      id: 'html-note',
      extractedImages: null,
      slideImages: null,
      slideImageUrls: null,
    },
    {
      id: 'payload-note',
      extractedImages: { length: 3, present: [true, false, true] },
      slideImages: { length: 3, present: [true, false, true] },
      slideImageUrls: { length: 4, present: [true, true, false, true] },
    },
    {
      id: 'url-note',
      extractedImages: { length: 1, present: [true] },
      slideImages: { length: 1, present: [true] },
      slideImageUrls: { length: 1, present: [true] },
    },
  ];
  assert.deepEqual(legacy.first.noteTopologies, expectedNoteTopologies,
    'v5 array topology must be captured inside Chrome before Playwright serialization');

  const snapshot = await captureSnapshot(page, { production: true });
  assert.equal(snapshot.first.version, 6,
    `v5 fixture must converge to DB version 6; production DB_VERSION=${runtime.dbVersion}, observed version=${snapshot.first.version}, stores=${snapshot.first.storeNames.join(',')}`);
  assert.equal(runtime.dbVersion, 6, 'fixture must use production DB_VERSION 6');
  assert.deepEqual(snapshot.first.storeNames, ['folders', 'noteImages', 'notes', 'quizResults', 'srsCards']);
  assert.deepEqual(snapshot.first, snapshot.reopened, 'close/reopen must preserve the complete v6 snapshot');
  assert.deepEqual(snapshot.first.noteTopologies, expectedNoteTopologies,
    'v6 array topology must be captured inside Chrome before Playwright serialization');
  assert.deepEqual(snapshot.first.noteTopologies, snapshot.reopened.noteTopologies,
    'close/reopen must preserve page-side array topology');
  assert.deepEqual(snapshot.timetable, legacy.timetable, 'independent timetable data must survive migration');

  const expectedIndexes = {
    folders: ['name'],
    noteImages: [],
    notes: ['createdAt', 'folderId', 'title', 'updatedAt'],
    quizResults: ['noteId', 'timestamp'],
    srsCards: ['folderId', 'nextReviewDate'],
  };
  assert.deepEqual(snapshot.first.schema, Object.fromEntries(
    Object.entries(expectedIndexes).map(([storeName, indexes]) => [storeName, {
      keyPath: storeName === 'noteImages' ? 'noteId' : 'id',
      indexes,
    }]),
  ));
  assert.equal(snapshot.first.folders[0].name, 'Storage 2');
  assert.equal(snapshot.first.quizResults[0].noteId, 'payload-note');
  assert.equal(snapshot.first.srsCards[0].folderId, 'folder-1');
  assert.deepEqual(snapshot.timetable.schema, {
    timetable: { keyPath: 'entryId', indexes: ['dayOfWeek'] },
  });
  assert.equal(snapshot.timetable.stores.timetable.records[0].courseName, 'IndexedDB migration');

  for (const storeName of ['folders', 'quizResults', 'srsCards']) {
    assert.deepEqual(snapshot.first.stores[storeName].records, legacy.first.stores[storeName].records,
      `${storeName} records must survive unchanged`);
  }

  const beforeNotes = legacy.first.stores.notes.records;
  const afterNotes = snapshot.first.stores.notes.records;
  assert.equal(afterNotes.length, beforeNotes.length, 'all legacy notes must remain');
  assert.deepEqual(afterNotes.map(note => note.id), beforeNotes.map(note => note.id), 'note record order must remain stable');
  for (let index = 0; index < beforeNotes.length; index += 1) {
    const before = beforeNotes[index];
    const after = afterNotes[index];
    assert.deepEqual(noteWithoutImageFields(after), noteWithoutImageFields(before), `${before.id} metadata must survive`);
    assert.deepEqual(after.slideImageUrls, before.slideImageUrls, `${before.id} slideImageUrls values must survive`);
  }

  const payloadNote = snapshot.first.notes.find(note => note.id === 'payload-note');
  const urlNote = snapshot.first.notes.find(note => note.id === 'url-note');
  const htmlNote = snapshot.first.notes.find(note => note.id === 'html-note');
  const beforePayloadNote = legacy.first.notes.find(note => note.id === 'payload-note');
  const beforeUrlNote = legacy.first.notes.find(note => note.id === 'url-note');
  const beforeHtmlNote = legacy.first.notes.find(note => note.id === 'html-note');
  assert.equal(payloadNote.notesText, 'Local payloads and URL references.');
  assert.equal(payloadNote.folderId, 'folder-1');
  assert.equal(payloadNote.createdAt, '2026-08-20T10:00:00.000Z');
  assert.deepEqual(payloadNote.unknownMetadata, { source: 'v5-fixture', keep: true });
  assert.equal(payloadNote.extractedImages[0].imageBase64, undefined);
  assert.equal(payloadNote.extractedImages[1], undefined, 'extractedImages sparse slot must stay payload-free');
  assert.equal(payloadNote.extractedImages[2].imageBase64, 'https://cdn.example.test/slide-5.png');
  assert.equal(payloadNote.slideImages[0].imageBase64, undefined);
  assert.equal(payloadNote.slideImages[1], undefined, 'slideImages sparse slot must stay payload-free');
  assert.equal(payloadNote.slideImages[2].imageBase64, 'https://cdn.example.test/slide-5.png');
  assert.equal(payloadNote.slideImageUrls.length, beforePayloadNote.slideImageUrls.length);
  assert.equal(2 in payloadNote.slideImageUrls, 2 in beforePayloadNote.slideImageUrls, 'sparse slideImageUrls hole must survive');
  assert.equal(payloadNote.slideImageUrls[1], 'https://cdn.example.test/slide-5.png');
  assert.match(payloadNote.notesHtml, /data-note-image-ref="note-image-/);
  assert.doesNotMatch(payloadNote.notesHtml, /data:image\//i);
  assert.doesNotMatch(payloadNote.notesHtml, /src\s*=\s*["'][A-Za-z0-9+/]{8,}={0,2}["']/i);
  assert.equal(urlNote.extractedImages[0].imageBase64, 'https://cdn.example.test/slide-7.png');
  assert.equal(urlNote.slideImages[0].imageBase64, 'https://cdn.example.test/slide-7.png');
  assert.deepEqual(urlNote.extractedImages, beforeUrlNote.extractedImages, 'URL-only extractedImages must remain unchanged');
  assert.deepEqual(urlNote.slideImages, beforeUrlNote.slideImages, 'URL-only slideImages must remain unchanged');
  assert.equal(urlNote.notesHtml, beforeUrlNote.notesHtml, 'remote HTML src must remain unchanged');
  assert.deepEqual(htmlRemoteSources(payloadNote.notesHtml), htmlRemoteSources(beforePayloadNote.notesHtml));
  assert.deepEqual(htmlRemoteSources(urlNote.notesHtml), htmlRemoteSources(beforeUrlNote.notesHtml));
  assert.deepEqual(htmlRemoteSources(htmlNote.notesHtml), htmlRemoteSources(beforeHtmlNote.notesHtml));
  assert.doesNotMatch(htmlNote.notesHtml, /data:image\//i);
  assert.match(htmlNote.notesHtml, /data-note-image-ref="note-image-/);
  assert.doesNotMatch(htmlNote.notesHtml, /src\s*=\s*["'][A-Za-z0-9+/]{8,}={0,2}["']/i);
  assertNoPayload(payloadNote.extractedImages, 'payloadNote.extractedImages');
  assertNoPayload(payloadNote.slideImages, 'payloadNote.slideImages');
  assertNoPayload(urlNote.extractedImages, 'urlNote.extractedImages');
  assertNoPayload(urlNote.slideImages, 'urlNote.slideImages');

  const payloadImages = snapshot.first.imageRecords.find(record => record.noteId === 'payload-note');
  const htmlImages = snapshot.first.imageRecords.find(record => record.noteId === 'html-note');
  const expectedImageRecords = [
    {
      noteId: 'html-note',
      images: [{
        field: 'html',
        index: 0,
        mimeType: 'image/png',
        sourceKey: 'imageBase64',
        _sourceSignature: 'v1:12:8e378466bc31fe16',
        markerId: 'note-image-0',
        blob: { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
      }],
    },
    {
      noteId: 'payload-note',
      images: [
        {
          slideNumber: 2,
          fileName: 'slide-2.png',
          field: 'extractedImages',
          index: 0,
          mimeType: 'image/png',
          sourceKey: 'imageBase64',
          _sourceSignature: 'v1:12:8e378466bc31fe16',
          markerId: 'note-image-0',
          blob: { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
        },
        {
          slideNumber: 2,
          fileName: 'slide-2-detail.jpg',
          field: 'slideImages',
          index: 0,
          mimeType: 'image/jpeg',
          sourceKey: 'imageBase64',
          _sourceSignature: 'v1:4:56c4835cc4f27fb7',
          markerId: 'note-image-1',
          blob: { type: 'image/jpeg', size: 3, bytes: [255, 216, 255] },
        },
        {
          field: 'html',
          index: 0,
          mimeType: 'image/png',
          sourceKey: 'imageBase64',
          _sourceSignature: 'v1:12:8e378466bc31fe16',
          markerId: 'note-image-2',
          blob: { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
        },
      ],
    },
  ];
  assert.equal(snapshot.first.imageRecords.length, 2, 'exactly two notes must have detached image records');
  assert.deepEqual(snapshot.first.imageRecords, expectedImageRecords, 'every detached image record must match exactly');
  assert.deepEqual(snapshot.first.imageRecords, snapshot.reopened.imageRecords,
    'complete imageRecords snapshot must survive close/reopen');
  const persistedSignatures = snapshot.first.imageRecords.flatMap(record => record.images.map(image => image._sourceSignature));
  assert.equal(persistedSignatures.every(signature => typeof signature === 'string' && signature.length <= 64), true,
    'Chrome-persisted ownership fingerprints must stay within the compact size cap');
  assert.equal(persistedSignatures.some(signature => /data:image/i.test(signature)), false,
    'Chrome-persisted ownership fingerprints must not contain a data URL prefix');
  assert.equal(persistedSignatures.some(signature => /iVBORw0KGgo=|\/9j\//.test(signature)), false,
    'Chrome-persisted ownership fingerprints must not contain source base64');
  assert.notEqual(
    payloadImages.images.find(image => image.mimeType === 'image/png')._sourceSignature,
    payloadImages.images.find(image => image.mimeType === 'image/jpeg')._sourceSignature,
    'Chrome fingerprints must distinguish the PNG/JPEG collision fixtures',
  );
  assert.deepEqual(payloadImages.images.map(image => [image.field, image.index, image.slideNumber, image.mimeType, image.markerId, image.blob]), [
    ['extractedImages', 0, 2, 'image/png', 'note-image-0', { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
    ['slideImages', 0, 2, 'image/jpeg', 'note-image-1', { type: 'image/jpeg', size: 3, bytes: [255, 216, 255] }],
    ['html', 0, undefined, 'image/png', 'note-image-2', { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
  ]);
  assert.equal(htmlImages.images.length, 1);
  assert.equal(snapshot.first.imageRecords.some(record => record.noteId === 'url-note'), false);

  await page.evaluate(() => window.__storage2ResetIdbTrace());
  const allNotes = await page.evaluate(() => getAllNotes());
  assert.equal(allNotes.length, 3, 'getAllNotes must return every lightweight note');
  assertNoPayload(allNotes, 'getAllNotes result');
  const listTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  assert.equal(listTrace.some(entry => entry.storeName === 'noteImages' || entry.storeNames?.includes('noteImages')), false,
    'getAllNotes must never touch noteImages');

  await page.evaluate(() => window.__storage2ResetIdbTrace());
  const localBlobProbe = await page.evaluate(async () => ({
    payload: await hasLocalNoteImageBlobs('payload-note'),
    urlOnly: await hasLocalNoteImageBlobs('url-note'),
    trace: window.__storage2IdbTrace.slice(),
  }));
  assert.equal(localBlobProbe.payload, true, 'local Blob probe identifies noteImages ownership');
  assert.equal(localBlobProbe.urlOnly, false, 'local Blob probe rejects URL-only notes');
  assert.deepEqual(localBlobProbe.trace.filter(entry => entry.storeName === 'noteImages' && entry.operation === 'get').map(entry => entry.key),
    ['payload-note', 'url-note'], 'local Blob probe reads exactly one noteImages key per note');
  assert.equal(localBlobProbe.trace.some(entry => entry.storeName === 'noteImages' && entry.operation === 'getAll'), false,
    'local Blob probe must not scan noteImages');

  await page.evaluate(() => window.__storage2ResetIdbTrace());
  const hydratedPayloadNote = await page.evaluate(() => getNote('payload-note'));
  assert.match(hydratedPayloadNote.extractedImages[0].imageBase64, /^iVBORw0KGgo=/,
    'getNote must hydrate local image payloads');
  assert.match(hydratedPayloadNote.notesHtml, /src="data:image\/png;base64,/,
    'getNote must hydrate HTML image sources');
  const oneNoteTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  const imageReads = oneNoteTrace.filter(entry => entry.storeName === 'noteImages' && entry.operation === 'get');
  assert.deepEqual(imageReads.map(entry => entry.key), ['payload-note'],
    'getNote must read exactly the requested noteImages key');
  assert.equal(oneNoteTrace.some(entry => entry.storeName === 'noteImages' && entry.operation === 'getAll'), false,
    'getNote must not scan noteImages');

  const htmlOnlyInput = {
    id: 'task4-html-only',
    title: 'Task 4 HTML only',
    notesText: 'HTML-only image ownership.',
    notesHtml: '<p>HTML only</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="html-only">',
  };
  await page.evaluate(note => saveNote(note), htmlOnlyInput);
  const htmlOnlyLightweight = await page.evaluate(async () => (await getAllNotes()).find(note => note.id === 'task4-html-only'));
  assert.doesNotMatch(htmlOnlyLightweight.notesHtml, /data:image\//i,
    'HTML-only persisted notesHtml must not contain a data URL');
  assert.match(htmlOnlyLightweight.notesHtml, /data-note-image-ref="note-image-0"/);
  const htmlOnlyRecord = await page.evaluate(() => window.__storage2ReadImageRecord('task4-html-only'));
  assert.deepEqual(htmlOnlyRecord.images.map(image => [image.field, image.index, image.markerId]), [['html', 0, 'note-image-0']],
    'HTML-only local images must have one detached HTML owner');
  const htmlOnlyOpen = await page.evaluate(() => getNote('task4-html-only'));
  assert.match(htmlOnlyOpen.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/,
    'HTML-only local images must hydrate on open');
  await page.evaluate(async () => {
    const hydrated = await getNote('task4-html-only');
    hydrated.title = 'Task 4 HTML update';
    await saveNote(hydrated);
  });
  const htmlOnlyUpdatedRecord = await page.evaluate(() => window.__storage2ReadImageRecord('task4-html-only'));
  assert.equal(htmlOnlyUpdatedRecord.images.length, 1,
    're-saving hydrated HTML must not grow duplicate HTML owners');

  await page.evaluate(() => saveNote({
    id: 'task4-marker-collision',
    title: 'Task 4 marker collision',
    notesText: 'Original HTML owner.',
    notesHtml: '<img src="data:image/png;base64,iVBORw0KGgo=" data-note-image-ref="note-image-0">',
  }));
  await page.evaluate(async () => {
    const hydrated = await getNote('task4-marker-collision');
    hydrated.notesText = 'Original HTML plus extracted owner.';
    hydrated.extractedImages = [{
      slideNumber: 1,
      imageBase64: 'data:image/jpeg;base64,/9j/',
      mimeType: 'image/jpeg',
    }];
    hydrated.notesHtml += '<img src="data:image/jpeg;base64,/9j/" data-note-image-ref="note-image-0">';
    await saveNote(hydrated);
  });
  const collisionRecord = await page.evaluate(() => window.__storage2ReadImageRecord('task4-marker-collision'));
  assert.deepEqual(collisionRecord.images.map(image => [image.field, image.markerId, image._sourceSignature]), [
    ['html', 'note-image-0', 'v1:12:8e378466bc31fe16'],
    ['extractedImages', 'note-image-1', 'v1:4:56c4835cc4f27fb7'],
  ], 'marker collision keeps the old HTML owner and allocates a new extracted marker');
  const collisionOpen = await page.evaluate(() => getNote('task4-marker-collision'));
  assert.match(collisionOpen.notesHtml, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.match(collisionOpen.notesHtml, /data:image\/jpeg;base64,\/9j\//);
  await page.evaluate(async () => saveNote(await getNote('task4-marker-collision')));
  const collisionRepeatedRecord = await page.evaluate(() => window.__storage2ReadImageRecord('task4-marker-collision'));
  assert.equal(collisionRepeatedRecord.images.length, 2,
    'marker collision ownership must not grow on a repeated hydrated save');

  await page.evaluate(() => saveNote({
    id: 'task4-direct-blob',
    title: 'Task 4 direct Blob migration',
    notesText: 'Direct Blob owners.',
    extractedImages: [
      { slideNumber: 1, imageBase64: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), mimeType: 'image/png' },
      { slideNumber: 2, imageBase64: new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'image/png' }), mimeType: 'image/png' },
    ],
  }));
  const directBlobBefore = await page.evaluate(async () => {
    const record = await window.__storage2ReadImageRecord('task4-direct-blob');
    return record.images.map(image => [image.markerId, image._sourceSignature]);
  });
  assert.notEqual(directBlobBefore[0][1], directBlobBefore[1][1],
    'Chrome equal-size direct Blobs must have distinct owner fingerprints');
  const directBlobOpen = await page.evaluate(() => getNote('task4-direct-blob'));
  assert.notEqual(directBlobOpen.extractedImages[0].imageBase64, directBlobOpen.extractedImages[1].imageBase64,
    'Chrome equal-size direct Blobs must hydrate to distinct bytes');
  await page.evaluate(note => saveNote(note), directBlobOpen);
  const directBlobAfter = await page.evaluate(async () => {
    const record = await window.__storage2ReadImageRecord('task4-direct-blob');
    return record.images.map(image => [image.markerId, image._sourceSignature]);
  });
  assert.deepEqual(directBlobAfter, directBlobBefore,
    'Chrome Blob migration through hydrate/save must preserve owner identity');
  assert.equal(directBlobAfter.length, 2,
    'Chrome Blob migration must not duplicate owners');

  await page.evaluate(() => saveNote({
    id: 'task4-subset',
    title: 'Task 4 sparse subset',
    notesText: 'Sparse subset image ownership.',
    extractedImages: [, , { slideNumber: 3, imageBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }],
    notesHtml: '<p>stale local prose</p><img src="data:image/png;base64,iVBORw0KGgo=" data-note-image-ref="note-image-2">',
  }));
  const subsetLightweight = await page.evaluate(async () => {
    const note = (await getAllNotes()).find(candidate => candidate.id === 'task4-subset');
    return { note, hasIndex0: 0 in note.extractedImages, hasIndex2: 2 in note.extractedImages };
  });
  assert.equal(subsetLightweight.hasIndex2, true);
  assert.equal(subsetLightweight.hasIndex0, false);
  assert.equal(subsetLightweight.note.extractedImages[2].markerId, 'note-image-2');
  assert.equal((await page.evaluate(() => window.__storage2ReadImageRecord('task4-subset'))).images.length, 1,
    'subset HTML marker must share the extracted owner');
  const subsetOpen = await page.evaluate(async () => {
    const note = await getNote('task4-subset');
    return { note, hasIndex0: 0 in note.extractedImages, hasIndex2: 2 in note.extractedImages };
  });
  assert.equal(subsetOpen.hasIndex2, true, 'subset image must restore at index 2');
  assert.equal(subsetOpen.hasIndex0, false, 'subset image must not restore at index 0');
  assert.match(subsetOpen.note.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  await page.evaluate(async () => {
    const hydrated = await getNote('task4-subset');
    hydrated.extractedImages = [hydrated.extractedImages[1], , hydrated.extractedImages[2]];
    await saveNote(hydrated);
  });
  const subsetReorderedRecord = await page.evaluate(() => window.__storage2ReadImageRecord('task4-subset'));
  assert.deepEqual(subsetReorderedRecord.images.map(image => [image.field, image.index, image.markerId]),
    [['extractedImages', 2, 'note-image-2']],
    'reordered hydrated saves preserve sparse owner identity without HTML duplicates');

  await page.evaluate(async () => {
    currentUser = { uid: 'task4-auth-user' };
    Object.assign(db, {
      collection() {
        return { doc() {
          return { collection() {
            return { doc() {
              return { get: async () => ({
                exists: true,
                data: () => ({ id: 'task4-subset', title: 'Firestore title', notesText: 'Firestore metadata text', slideImageUrls: [null, 'https://cdn.example.test/remote.png', null] }),
              }) };
            } };
          } };
        } };
      },
    });
  });
  const authenticatedReconciled = await page.evaluate(() => getNoteFS('task4-subset'));
  assert.equal(authenticatedReconciled.title, 'Firestore title',
    'authenticated open must use Firestore metadata truth');
  assert.match(authenticatedReconciled.notesHtml, /Firestore metadata text/,
    'authenticated open must render newer Firestore notesText');
  assert.doesNotMatch(authenticatedReconciled.notesHtml, /stale local prose/,
    'authenticated open must not retain stale local prose');
  assert.equal(2 in authenticatedReconciled.extractedImages, true,
    'authenticated open must retain the local detached sparse owner');
  assert.match(authenticatedReconciled.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/,
    'authenticated open must restore local image sources');
  const authenticatedRepeated = await page.evaluate(() => getNoteFS('task4-subset'));
  assert.match(authenticatedRepeated.notesHtml, /Firestore metadata text/,
    'repeated authenticated open remains on the remote content version');
  assert.doesNotMatch(authenticatedRepeated.notesHtml, /stale local prose/);
  assert.equal((await page.evaluate(() => window.__storage2ReadImageRecord('task4-subset'))).images.length, 1,
    'remote reconciliation must not delete or duplicate detached ownership');
  await page.evaluate(() => { currentUser = null; delete db.collection; });

  const degradedRemoteCases = await page.evaluate(async () => {
    const originalPut = IDBObjectStore.prototype.put;
    const fakeDb = (setImpl) => ({
      collection() {
        return { doc() {
          return { collection() {
            return { doc() { return { set: setImpl }; } };
          } };
        } };
      },
    });
    currentUser = { uid: 'task4-degraded-user' };
    let injected = false;
    IDBObjectStore.prototype.put = function () {
      if (this.name === 'noteImages' && !injected) {
        injected = true;
        throw new DOMException('fixture quota failure', 'QuotaExceededError');
      }
      return originalPut.apply(this, arguments);
    };
    Object.assign(db, fakeDb(async () => {}));
    let oversized;
    try {
      oversized = await saveNoteFS({
        id: 'task4-oversized-local',
        title: 'Oversized degraded local',
        notesText: 'Text survives.',
        pptText: 'x'.repeat(960000),
        notesHtml: '<img src="data:image/png;base64,iVBORw0KGgo=">',
      });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    let remoteError;
    injected = false;
    IDBObjectStore.prototype.put = function () {
      if (this.name === 'noteImages' && !injected) {
        injected = true;
        throw new DOMException('fixture quota failure', 'QuotaExceededError');
      }
      return originalPut.apply(this, arguments);
    };
    Object.assign(db, fakeDb(async () => { throw new Error('remote write failed'); }));
    try {
      await saveNoteFS({
        id: 'task4-remote-error',
        title: 'Remote degraded error',
        notesText: 'Text survives remote failure.',
        notesHtml: '<img src="data:image/png;base64,iVBORw0KGgo=">',
      });
    } catch (error) {
      remoteError = { saveStatus: error.saveStatus, degradation: error.degradation, message: error.message };
    } finally {
      IDBObjectStore.prototype.put = originalPut;
      currentUser = null;
      delete db.collection;
    }
    return { oversized, remoteError };
  });
  assert.equal(degradedRemoteCases.oversized.saveStatus, 'image-degraded',
    'oversized Firestore documents must preserve degraded local-save status');
  assert.deepEqual(degradedRemoteCases.oversized.degradation, { resource: 'noteImages', reason: 'quota' });
  assert.equal(degradedRemoteCases.remoteError.saveStatus, 'image-degraded',
    'remote errors after degraded local saves must carry the local status');
  assert.deepEqual(degradedRemoteCases.remoteError.degradation, { resource: 'noteImages', reason: 'quota' });

  const priorPayloadImages = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  const omittedLightweightBefore = await page.evaluate(async () => {
    const note = (await getAllNotes()).find(candidate => candidate.id === 'payload-note');
    return {
      extractedImages: note.extractedImages,
      slideImages: note.slideImages,
      notesHtml: note.notesHtml,
      slideImageUrls: note.slideImageUrls,
    };
  });
  await page.evaluate(() => window.__storage2ResetIdbTrace());
  await page.evaluate(() => saveNote({
    id: 'payload-note',
    title: 'Omitted image update',
    notesText: 'Text survives an omitted image update.',
  }));
  const omittedUpdate = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  assert.deepEqual(omittedUpdate, priorPayloadImages, 'omitted image fields must preserve the detached record');
  const omittedLightweightAfter = await page.evaluate(async () => {
    const note = (await getAllNotes()).find(candidate => candidate.id === 'payload-note');
    return {
      extractedImages: note.extractedImages,
      slideImages: note.slideImages,
      notesHtml: note.notesHtml,
      slideImageUrls: note.slideImageUrls,
    };
  });
  assert.deepEqual(omittedLightweightAfter, omittedLightweightBefore,
    'omitted image fields must preserve every lightweight image field and URL/marker reference');
  assert.equal(omittedLightweightAfter.extractedImages[2].imageBase64, 'https://cdn.example.test/slide-5.png');
  assert.equal(omittedLightweightAfter.slideImageUrls[1], 'https://cdn.example.test/slide-5.png');
  assert.match(omittedLightweightAfter.notesHtml, /data-note-image-ref="note-image-2"/);
  const omittedTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  const omittedWriteTransactions = omittedTrace.filter(entry => entry.type === 'transaction' && entry.mode === 'readwrite');
  assert.deepEqual(omittedWriteTransactions.map(entry => entry.storeNames.slice().sort()), [['noteImages', 'notes']],
    'saveNote must update notes and noteImages in one readwrite transaction');

  await page.evaluate(() => saveNote({
    id: 'payload-note',
    title: 'Replace one image owner',
    notesText: 'One image owner is replaced.',
    extractedImages: [{
      slideNumber: 42,
      imageBase64: 'data:image/jpeg;base64,/9j/',
      mimeType: 'image/jpeg',
      fileName: 'replacement.jpg',
    }],
  }));
  const replacedImages = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  assert.deepEqual(replacedImages.images.map(image => image.field), ['slideImages', 'html', 'extractedImages'],
    'explicit non-empty image fields must replace only their owners');
  assert.equal(replacedImages.images.find(image => image.field === 'extractedImages').slideNumber, 42);
  assert.equal(replacedImages.images.find(image => image.field === 'extractedImages').fileName, 'replacement.jpg');
  assert.equal(replacedImages.images.find(image => image.field === 'slideImages').fileName, 'slide-2-detail.jpg',
    'omitted owners must remain during a replacement');

  await page.evaluate(() => saveNote({
    id: 'payload-note',
    title: 'Delete two image owners',
    notesText: 'Two image owners are deleted.',
    extractedImages: [],
    slideImages: [],
  }));
  const partiallyDeletedImages = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  assert.deepEqual(partiallyDeletedImages.images.map(image => image.field), ['html'],
    'explicit empty fields must remove only their image owners');

  await page.evaluate(() => saveNote({
    id: 'payload-note',
    title: 'Delete final image owner',
    notesText: 'The final image owner is deleted.',
    notesHtml: '',
  }));
  assert.equal(await page.evaluate(() => window.__storage2ReadImageRecord('payload-note')), null,
    'noteImages must be deleted when no image owners remain');

  await page.evaluate(() => saveNote({
    id: 'crud-note',
    title: 'CRUD delete note',
    notesText: 'This note and its image record will be deleted.',
    extractedImages: [{ slideNumber: 1, imageBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }],
  }));
  assert.ok(await page.evaluate(() => window.__storage2ReadImageRecord('crud-note')));
  await page.evaluate(() => window.__storage2ResetIdbTrace());
  await page.evaluate(() => deleteNote('crud-note'));
  const deleteTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  assert.deepEqual(deleteTrace.filter(entry => entry.type === 'transaction' && entry.mode === 'readwrite')
    .map(entry => entry.storeNames.slice().sort()), [['noteImages', 'notes']],
  'deleteNote must remove notes and noteImages in one transaction');
  const afterDelete = await captureSnapshot(page, { production: true });
  assert.equal(afterDelete.first.notes.some(note => note.id === 'crud-note'), false, 'deleteNote must remove the note');
  assert.equal(afterDelete.first.imageRecords.some(record => record.noteId === 'crud-note'), false,
    'deleteNote must remove the matching noteImages record');

  await page.evaluate(() => saveNote({
    id: 'quota-note',
    title: 'Quota baseline note',
    notesText: 'Prior image survives a quota failure.',
    folderId: 'folder-1',
    customMetadata: { revision: 1, source: 'quota-fixture' },
    extractedImages: [{ slideNumber: 3, imageBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', fileName: 'prior.png' }],
    slideImages: [{ slideNumber: 3, imageBase64: 'data:image/jpeg;base64,/9j/', mimeType: 'image/jpeg', fileName: 'prior-detail.jpg' }],
    slideImageUrls: [null, 'https://cdn.example.test/prior.png'],
    notesHtml: '<p>Prior HTML reference</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="prior">',
  }));
  const priorQuotaImages = await page.evaluate(() => window.__storage2ReadImageRecord('quota-note'));
  const priorQuotaLightweight = await page.evaluate(async () => {
    return (await getAllNotes()).find(note => note.id === 'quota-note');
  });
  await page.evaluate(() => window.__storage2ResetIdbTrace());
  const quotaResult = await page.evaluate(async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let injected = false;
    IDBObjectStore.prototype.put = function () {
      if (this.name === 'noteImages' && !injected) {
        injected = true;
        throw new DOMException('fixture quota failure', 'QuotaExceededError');
      }
      return originalPut.apply(this, arguments);
    };
    try {
      const result = await saveNote({
        id: 'quota-note',
        title: 'Quota text update',
        notesText: 'Text must survive the image quota failure.',
        folderId: 'folder-2',
        customMetadata: { revision: 2, source: 'quota-fallback', retained: true },
        extractedImages: [{ slideNumber: 99, imageBase64: 'data:image/jpeg;base64,/9j/', mimeType: 'image/jpeg', fileName: 'new.jpg' }],
      });
      return { result, injected };
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  });
  assert.equal(quotaResult.injected, true, 'quota fixture must throw at the real noteImages put boundary');
  assert.equal(quotaResult.result.saveStatus, 'image-degraded',
    'quota fallback must expose an explicit degraded-save status');
  assert.deepEqual(quotaResult.result.degradation, { resource: 'noteImages', reason: 'quota' },
    'quota fallback must expose a typed image degradation reason');
  const quotaTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  assert.deepEqual(quotaTrace.filter(entry => entry.type === 'transaction' && entry.mode === 'readwrite')
    .map(entry => entry.storeNames.slice().sort()), [['noteImages', 'notes'], ['notes']],
  'quota fallback must abort the image transaction before the lightweight retry');
  const quotaNote = await page.evaluate(() => getNote('quota-note'));
  const quotaLightweight = await page.evaluate(async () => {
    return (await getAllNotes()).find(note => note.id === 'quota-note');
  });
  assert.equal(quotaResult.result.title, 'Quota text update');
  assert.equal(quotaResult.result.notesText, 'Text must survive the image quota failure.');
  assert.equal(quotaResult.result.folderId, 'folder-2');
  assert.deepEqual(quotaResult.result.customMetadata, { revision: 2, source: 'quota-fallback', retained: true });
  assert.equal(quotaLightweight.title, quotaResult.result.title);
  assert.equal(quotaLightweight.notesText, quotaResult.result.notesText);
  assert.equal(quotaLightweight.folderId, quotaResult.result.folderId);
  assert.deepEqual(quotaLightweight.customMetadata, quotaResult.result.customMetadata);
  assert.equal(quotaLightweight.updatedAt, quotaResult.result.updatedAt);
  assert.notDeepEqual(quotaLightweight.customMetadata, priorQuotaLightweight.customMetadata);
  assert.notEqual(quotaLightweight.folderId, priorQuotaLightweight.folderId);
  assert.equal(quotaNote.notesText, 'Text must survive the image quota failure.');
  assert.equal(quotaNote.extractedImages[0].fileName, 'prior.png');
  assert.equal(quotaNote.slideImages[0].fileName, 'prior-detail.jpg');
  assert.match(quotaNote.extractedImages[0].imageBase64, /^iVBORw0KGgo=/,
    'quota fallback must preserve the prior image reference when possible');
  assert.match(quotaNote.notesHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.deepEqual(await page.evaluate(() => window.__storage2ReadImageRecord('quota-note')), priorQuotaImages,
    'quota fallback must preserve the prior detached image record');

  await page.evaluate(() => saveNote({
    id: 'quota-failure-note',
    title: 'Quota fallback failure baseline',
    notesText: 'This complete note must survive fallback failure.',
    folderId: 'folder-3',
    customMetadata: { revision: 7, source: 'fallback-failure' },
    extractedImages: [{ slideNumber: 8, imageBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', fileName: 'failure-prior.png' }],
    slideImages: [{ slideNumber: 8, imageBase64: 'data:image/jpeg;base64,/9j/', mimeType: 'image/jpeg', fileName: 'failure-prior-detail.jpg' }],
    slideImageUrls: ['https://cdn.example.test/failure-prior.png'],
    notesHtml: '<p>Failure prior HTML</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="failure prior">',
  }));
  const fallbackFailureBeforeNote = await page.evaluate(async () => {
    return (await getAllNotes()).find(note => note.id === 'quota-failure-note');
  });
  const fallbackFailureBeforeImages = await page.evaluate(() => window.__storage2ReadImageRecord('quota-failure-note'));
  const fallbackFailure = await page.evaluate(async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let imagePutAttempted = false;
    let notesPutAttempted = false;
    IDBObjectStore.prototype.put = function () {
      if (this.name === 'noteImages' && !imagePutAttempted) {
        imagePutAttempted = true;
        throw new DOMException('fixture quota failure before fallback', 'QuotaExceededError');
      }
      if (this.name === 'notes') notesPutAttempted = true;
      return originalPut.apply(this, arguments);
    };
    try {
      try {
        const value = await saveNote({
          id: 'quota-failure-note',
          title: 'Must not commit after fallback failure',
          notesText: 'This update must be rejected.',
          customMetadata: { revision: 8, uncloneable: function () {} },
          extractedImages: [{ slideNumber: 9, imageBase64: 'data:image/jpeg;base64,/9j/', mimeType: 'image/jpeg', fileName: 'failure-new.jpg' }],
        });
        return { fulfilled: true, value, imagePutAttempted, notesPutAttempted };
      } catch (error) {
        return {
          fulfilled: false,
          value: undefined,
          errorName: error && error.name,
          imagePutAttempted,
          notesPutAttempted,
        };
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  });
  assert.equal(fallbackFailure.fulfilled, false, 'failed lightweight fallback must reject normally');
  assert.equal(fallbackFailure.value, undefined, 'fallback failure must not return a degraded success');
  assert.equal(fallbackFailure.errorName, 'DataCloneError');
  assert.equal(fallbackFailure.imagePutAttempted, true, 'the primary image put must fail first');
  assert.equal(fallbackFailure.notesPutAttempted, true, 'the lightweight fallback notes put must be attempted');
  const fallbackFailureAfterNote = await page.evaluate(async () => {
    return (await getAllNotes()).find(note => note.id === 'quota-failure-note');
  });
  const fallbackFailureAfterImages = await page.evaluate(() => window.__storage2ReadImageRecord('quota-failure-note'));
  assert.deepEqual(fallbackFailureAfterNote, fallbackFailureBeforeNote,
    'failed fallback must preserve the complete prior lightweight note');
  assert.deepEqual(fallbackFailureAfterImages, fallbackFailureBeforeImages,
    'failed fallback must preserve the prior detached image record');

  await page.evaluate(() => window.__storage2ResetIdbTrace());
  await page.evaluate(() => clearAllStorage());
  const clearTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  assert.deepEqual(clearTrace.filter(entry => entry.type === 'transaction' && entry.mode === 'readwrite')
    .map(entry => entry.storeNames.slice().sort()), [['folders', 'noteImages', 'notes']],
  'clearAllStorage must clear notes, folders, and noteImages in one transaction');
  const clearRequests = clearTrace.filter(entry => entry.type === 'request' && entry.operation === 'clear');
  assert.equal(clearRequests.length, 3, 'clearAllStorage must issue exactly three clear requests');
  assert.deepEqual(clearRequests.map(entry => entry.storeName).sort(), ['folders', 'noteImages', 'notes']);
  const cleared = await captureSnapshot(page, { production: true });
  assert.deepEqual(cleared.first.stores.notes.records, [], 'clearAllStorage must clear notes');
  assert.deepEqual(cleared.first.stores.noteImages.records, [], 'clearAllStorage must clear noteImages');
  assert.deepEqual(cleared.first.stores.folders.records, [], 'clearAllStorage must clear folders');
  assert.deepEqual(cleared.timetable, snapshot.timetable, 'clearAllStorage must leave timetable behavior untouched');

  await page.evaluate(() => window.__createV5Fixture({ invalid: true }));
  const malformedBefore = await captureSnapshot(page);
  await assert.rejects(() => page.evaluate(() => openDB()), /Abort|Invalid|conversion|image|base64/i);
  const malformedAfter = await captureSnapshot(page);
  assert.deepEqual(malformedAfter, malformedBefore,
    'conversion failure must preserve the complete v5 note, stores, schema, and data');
  assert.equal(malformedAfter.first.version, 5, 'conversion failure must leave the database at v5');
  console.log('STORAGE2 Chromium IndexedDB: PASS (v5 fixture, v6 cursor migration, reopen convergence, abort safety)');
} finally {
  await browser.close();
}
