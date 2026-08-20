const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

for (const file of ['note_images.js', 'markdown.js', 'image_gallery.js', 'notes_crud.js']) {
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
assert.doesNotMatch(fields.notesHtml, /data:image\//i, 'note save fields must not persist data URLs');

const degraded = {
  id: 'note-1',
  saveStatus: 'image-degraded',
  degradation: { resource: 'noteImages', reason: 'quota' },
};
assert.equal(context.showImageDegradationWarning(degraded), true);
assert.equal(warnings.length, 1, 'one failed save produces one warning');
assert.match(warnings[0], /이미지/);
assert.match(warnings[0], /로그인|Firebase Storage/);
assert.equal(context.showImageDegradationWarning({ id: 'note-1' }), false);
assert.equal(warnings.length, 1, 'normal saves do not change warning count');

console.log('STORAGE2 Task 4 UI: GREEN contract checks passed');
