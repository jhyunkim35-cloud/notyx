import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const playwrightPath = 'C:/Users/김준현/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const fixturePath = path.resolve('scripts/browser/storage2-indexeddb.html');
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

async function inspectDatabase(page) {
  return page.evaluate(async () => {
    function requestResult(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function readAll(database, storeName) {
      return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).getAll());
    }

    function summarizeNote(note) {
      return {
        id: note.id,
        title: note.title,
        extractedImages: note.extractedImages,
        slideImages: note.slideImages,
        slideImageUrls: note.slideImageUrls,
        notesHtml: note.notesHtml,
      };
    }

    function summarizeImageRecord(record) {
      return {
        noteId: record.noteId,
        images: record.images.map(image => ({
          field: image.field,
          index: image.index,
          slideNumber: image.slideNumber,
          fileName: image.fileName,
          mimeType: image.mimeType,
          markerId: image.markerId,
          blobType: image.blob.type,
          blobSize: image.blob.size,
        })),
      };
    }

    async function summarize(database) {
      const storeNames = Array.from(database.objectStoreNames).sort();
      const schema = {};
      for (const storeName of storeNames) {
        const transaction = database.transaction(storeName, 'readonly');
        schema[storeName] = {
          keyPath: transaction.objectStore(storeName).keyPath,
          indexes: Array.from(transaction.objectStore(storeName).indexNames).sort(),
        };
      }
      const notes = (await readAll(database, 'notes')).map(summarizeNote).sort((a, b) => a.id.localeCompare(b.id));
      const imageRecords = database.objectStoreNames.contains('noteImages')
        ? (await readAll(database, 'noteImages')).map(summarizeImageRecord).sort((a, b) => a.noteId.localeCompare(b.noteId))
        : [];
      const folders = await readAll(database, 'folders');
      const quizResults = await readAll(database, 'quizResults');
      const srsCards = await readAll(database, 'srsCards');
      return {
        version: database.version,
        storeNames,
        schema,
        notes,
        imageRecords,
        folders,
        quizResults,
        srsCards,
      };
    }

    const database = await openDB();
    const first = await summarize(database);
    database.close();

    const timetableRequest = indexedDB.open('timetableDB', 1);
    const timetableDatabase = await requestResult(timetableRequest);
    const timetable = await readAll(timetableDatabase, 'timetable');
    const timetableSchema = Array.from(timetableDatabase.transaction('timetable', 'readonly').objectStore('timetable').indexNames).sort();
    timetableDatabase.close();

    const reopenedDatabase = await openDB();
    const reopened = await summarize(reopenedDatabase);
    reopenedDatabase.close();
    return { first, reopened, timetable, timetableSchema };
  });
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(fixturePath).href);
  await page.waitForFunction(() => window.__storage2FixtureReady === true);

  await page.evaluate(() => window.__createV5Fixture());
  const snapshot = await inspectDatabase(page);
  assert.equal(snapshot.first.version, 6,
    `v5 fixture must converge to DB version 6; observed version=${snapshot.first.version}, stores=${snapshot.first.storeNames.join(',')}`);
  assert.deepEqual(snapshot.first.storeNames, ['folders', 'noteImages', 'notes', 'quizResults', 'srsCards']);
  assert.deepEqual(snapshot.first, snapshot.reopened, 'close/reopen must preserve the v6 snapshot');

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
  assert.deepEqual(snapshot.timetableSchema, ['dayOfWeek']);
  assert.equal(snapshot.timetable[0].courseName, 'IndexedDB migration');

  const payloadNote = snapshot.first.notes.find(note => note.id === 'payload-note');
  const urlNote = snapshot.first.notes.find(note => note.id === 'url-note');
  const htmlNote = snapshot.first.notes.find(note => note.id === 'html-note');
  assert.equal(payloadNote.extractedImages[0].imageBase64, undefined);
  assert.equal(payloadNote.extractedImages[1], undefined, 'extractedImages sparse slot must stay payload-free');
  assert.equal(payloadNote.extractedImages[2].imageBase64, 'https://cdn.example.test/slide-5.png');
  assert.equal(payloadNote.slideImages[0].imageBase64, undefined);
  assert.equal(payloadNote.slideImages[1], undefined, 'slideImages sparse slot must stay payload-free');
  assert.equal(payloadNote.slideImages[2].imageBase64, 'https://cdn.example.test/slide-5.png');
  assert.equal(payloadNote.slideImageUrls[2], null, 'sparse slideImageUrls slot must survive');
  assert.equal(payloadNote.slideImageUrls[1], 'https://cdn.example.test/slide-5.png');
  assert.match(payloadNote.notesHtml, /data-note-image-ref="note-image-/);
  assert.doesNotMatch(payloadNote.notesHtml, /data:image\//i);
  assert.doesNotMatch(payloadNote.notesHtml, /src\s*=\s*["'][A-Za-z0-9+/]{8,}={0,2}["']/i);
  assert.equal(urlNote.extractedImages[0].imageBase64, 'https://cdn.example.test/slide-7.png');
  assert.equal(urlNote.slideImages[0].imageBase64, 'https://cdn.example.test/slide-7.png');
  assert.doesNotMatch(htmlNote.notesHtml, /data:image\//i);
  assert.match(htmlNote.notesHtml, /data-note-image-ref="note-image-/);
  assert.doesNotMatch(htmlNote.notesHtml, /src\s*=\s*["'][A-Za-z0-9+/]{8,}={0,2}["']/i);
  assertNoPayload(payloadNote.extractedImages, 'payloadNote.extractedImages');
  assertNoPayload(payloadNote.slideImages, 'payloadNote.slideImages');
  assertNoPayload(urlNote.extractedImages, 'urlNote.extractedImages');
  assertNoPayload(urlNote.slideImages, 'urlNote.slideImages');

  const payloadImages = snapshot.first.imageRecords.find(record => record.noteId === 'payload-note');
  const htmlImages = snapshot.first.imageRecords.find(record => record.noteId === 'html-note');
  assert.deepEqual(payloadImages.images.map(image => [image.field, image.index, image.slideNumber, image.mimeType, image.blobType]), [
    ['extractedImages', 0, 2, 'image/png', 'image/png'],
    ['slideImages', 0, 2, 'image/jpeg', 'image/jpeg'],
    ['html', 0, undefined, 'image/png', 'image/png'],
  ]);
  assert.equal(payloadImages.images[0].blobSize, 8);
  assert.equal(payloadImages.images[1].blobSize, 3);
  assert.equal(htmlImages.images.length, 1);
  assert.equal(snapshot.first.imageRecords.some(record => record.noteId === 'url-note'), false);

  await page.evaluate(() => window.__createV5Fixture({ invalid: true }));
  await assert.rejects(() => page.evaluate(() => openDB()), /Abort|Invalid|conversion|image|base64/i);
  const aborted = await page.evaluate(async () => {
    const request = indexedDB.open('meetingAppDB', 5);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const note = await new Promise((resolve, reject) => {
      const read = database.transaction('notes', 'readonly').objectStore('notes').get('invalid-note');
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    const stores = Array.from(database.objectStoreNames).sort();
    database.close();
    return { version: database.version, stores, note };
  });
  assert.equal(aborted.version, 5, 'conversion failure must leave the database at v5');
  assert.deepEqual(aborted.stores, ['folders', 'notes', 'quizResults', 'srsCards']);
  assert.equal(aborted.note.id, 'invalid-note');
  console.log('STORAGE2 Chromium IndexedDB: PASS (v5 fixture, v6 cursor migration, reopen convergence, abort safety)');
} finally {
  await browser.close();
}
