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
  assert.deepEqual(runtime.scriptOrder, ['fixture-helpers', 'constants', 'note_images', 'storage'],
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
          markerId: 'note-image-1',
          blob: { type: 'image/jpeg', size: 3, bytes: [255, 216, 255] },
        },
        {
          field: 'html',
          index: 0,
          mimeType: 'image/png',
          sourceKey: 'imageBase64',
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

  const priorPayloadImages = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  await page.evaluate(() => window.__storage2ResetIdbTrace());
  await page.evaluate(() => saveNote({
    id: 'payload-note',
    title: 'Omitted image update',
    notesText: 'Text survives an omitted image update.',
  }));
  const omittedUpdate = await page.evaluate(() => window.__storage2ReadImageRecord('payload-note'));
  assert.deepEqual(omittedUpdate, priorPayloadImages, 'omitted image fields must preserve the detached record');
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
    extractedImages: [{ slideNumber: 3, imageBase64: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', fileName: 'prior.png' }],
  }));
  const priorQuotaImages = await page.evaluate(() => window.__storage2ReadImageRecord('quota-note'));
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
  assert.equal(quotaNote.notesText, 'Text must survive the image quota failure.');
  assert.match(quotaNote.extractedImages[0].imageBase64, /^iVBORw0KGgo=/,
    'quota fallback must preserve the prior image reference when possible');
  assert.deepEqual(await page.evaluate(() => window.__storage2ReadImageRecord('quota-note')), priorQuotaImages,
    'quota fallback must preserve the prior detached image record');

  await page.evaluate(() => window.__storage2ResetIdbTrace());
  await page.evaluate(() => clearAllStorage());
  const clearTrace = await page.evaluate(() => window.__storage2IdbTrace.slice());
  assert.deepEqual(clearTrace.filter(entry => entry.type === 'transaction' && entry.mode === 'readwrite')
    .map(entry => entry.storeNames.slice().sort()), [['folders', 'noteImages', 'notes']],
  'clearAllStorage must clear notes, folders, and noteImages in one transaction');
  const cleared = await captureSnapshot(page, { production: true });
  assert.deepEqual(cleared.first.stores.notes.records, [], 'clearAllStorage must clear notes');
  assert.deepEqual(cleared.first.stores.noteImages.records, [], 'clearAllStorage must clear noteImages');
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
