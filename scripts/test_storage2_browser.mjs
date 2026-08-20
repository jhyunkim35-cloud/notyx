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

function arrayTopology(value) {
  if (!Array.isArray(value)) return null;
  return Array.from({ length: value.length }, (_, index) => index in value);
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

  const snapshot = await captureSnapshot(page, { production: true });
  assert.equal(snapshot.first.version, 6,
    `v5 fixture must converge to DB version 6; production DB_VERSION=${runtime.dbVersion}, observed version=${snapshot.first.version}, stores=${snapshot.first.storeNames.join(',')}`);
  assert.equal(runtime.dbVersion, 6, 'fixture must use production DB_VERSION 6');
  assert.deepEqual(snapshot.first.storeNames, ['folders', 'noteImages', 'notes', 'quizResults', 'srsCards']);
  assert.deepEqual(snapshot.first, snapshot.reopened, 'close/reopen must preserve the complete v6 snapshot');
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
    assert.deepEqual(arrayTopology(after.slideImageUrls), arrayTopology(before.slideImageUrls), `${before.id} slideImageUrls topology must survive`);
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
  assert.deepEqual(payloadImages.images.map(image => [image.field, image.index, image.slideNumber, image.mimeType, image.markerId, image.blob]), [
    ['extractedImages', 0, 2, 'image/png', 'note-image-0', { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
    ['slideImages', 0, 2, 'image/jpeg', 'note-image-1', { type: 'image/jpeg', size: 3, bytes: [255, 216, 255] }],
    ['html', 0, undefined, 'image/png', 'note-image-2', { type: 'image/png', size: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
  ]);
  assert.equal(htmlImages.images.length, 1);
  assert.equal(snapshot.first.imageRecords.some(record => record.noteId === 'url-note'), false);

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
