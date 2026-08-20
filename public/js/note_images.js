'use strict';

// Pure image detachment contracts. This file intentionally has no module or app dependency.

var NOTE_IMAGE_PAYLOAD_KEYS = ['imageBase64', 'src', 'data', 'blob', 'payload', 'base64', 'imageData'];
var NOTE_IMAGE_DATA_URL_RE = /^data:(image\/[^;,\s]+)(;[^,]*)?,([\s\S]*)$/i;
var NOTE_IMAGE_URL_RE = /^(?:https?:\/\/|\/\/)/i;

function isDataImageSource(value) {
  return typeof value === 'string' && NOTE_IMAGE_DATA_URL_RE.test(value.trim());
}

function isRemoteImageSource(value, mimeType) {
  if (typeof value !== 'string') return false;
  var trimmed = value.trim();
  if (!trimmed || isDataImageSource(trimmed)) return false;
  return NOTE_IMAGE_URL_RE.test(trimmed) || (mimeType === 'url' && NOTE_IMAGE_URL_RE.test(trimmed));
}

function noteImageIsBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function noteImageParseDataUrl(dataUrl) {
  var match = NOTE_IMAGE_DATA_URL_RE.exec(String(dataUrl).trim());
  if (!match) throw new TypeError('Expected an image data URL');
  var parameters = match[2] || '';
  var encoded = match[3] || '';
  var isBase64 = /;base64(?:;|$)/i.test(parameters);
  return {
    mimeType: match[1].toLowerCase(),
    encoded: encoded,
    isBase64: isBase64,
  };
}

function noteImageNormaliseBase64(value) {
  return String(value).replace(/[\r\n\t ]/g, '');
}

function noteImageLooksLikeRawBase64(value, mimeType) {
  if (typeof value !== 'string' || !/^image\//i.test(String(mimeType || ''))) return false;
  var compact = noteImageNormaliseBase64(value);
  return compact.length > 0 && compact.length % 4 !== 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function noteImageInferMimeFromRawBase64(value) {
  var compact = noteImageNormaliseBase64(value);
  if (!noteImageLooksLikeRawBase64(compact, 'image/unknown')) return '';
  try {
    var binary = atob(compact);
    if (binary.length >= 8
      && binary.charCodeAt(0) === 0x89
      && binary.charCodeAt(1) === 0x50
      && binary.charCodeAt(2) === 0x4e
      && binary.charCodeAt(3) === 0x47
      && binary.charCodeAt(4) === 0x0d
      && binary.charCodeAt(5) === 0x0a
      && binary.charCodeAt(6) === 0x1a
      && binary.charCodeAt(7) === 0x0a) return 'image/png';
    if (binary.length >= 3
      && binary.charCodeAt(0) === 0xff
      && binary.charCodeAt(1) === 0xd8
      && binary.charCodeAt(2) === 0xff) return 'image/jpeg';
    if (binary.length >= 6 && binary.slice(0, 6) === 'GIF87a') return 'image/gif';
    if (binary.length >= 6 && binary.slice(0, 6) === 'GIF89a') return 'image/gif';
    if (binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP') return 'image/webp';
  } catch (error) {
    return '';
  }
  return '';
}

function dataUrlToBlob(dataUrl) {
  var parsed = noteImageParseDataUrl(dataUrl);
  var bytes;
  if (parsed.isBase64) {
    var binary = atob(noteImageNormaliseBase64(parsed.encoded));
    bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    var decoded = decodeURIComponent(parsed.encoded);
    bytes = new TextEncoder().encode(decoded);
  }
  return new Blob([bytes], { type: parsed.mimeType });
}

function blobToDataUrl(blob) {
  if (!noteImageIsBlob(blob)) return Promise.reject(new TypeError('Expected a Blob'));
  if (typeof FileReader !== 'undefined') {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Unable to read image Blob')); };
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then(function (buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    var chunkSize = 0x8000;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      var chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
  });
}

function noteImageIsPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === null
    || prototype === Object.prototype
    || Boolean(prototype && prototype.constructor && prototype.constructor.name === 'Object');
}

function noteImageClone(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (noteImageIsBlob(value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  seen = seen || new Map();
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    var array = new Array(value.length);
    seen.set(value, array);
    for (var i = 0; i < value.length; i += 1) {
      if (i in value) array[i] = noteImageClone(value[i], seen);
    }
    return array;
  }
  if (!noteImageIsPlainObject(value)) return value;
  var result = {};
  seen.set(value, result);
  Object.keys(value).forEach(function (key) {
    result[key] = noteImageClone(value[key], seen);
  });
  return result;
}

function noteImageCopyMetadata(value, omitPayloadKeys) {
  if (value === null || typeof value !== 'object') {
    if (noteImageIsBlob(value)) return undefined;
    if (typeof value === 'string' && isDataImageSource(value)) return undefined;
    return value;
  }
  if (noteImageIsBlob(value)) return undefined;
  if (Array.isArray(value)) {
    var array = new Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      if (!(i in value)) continue;
      var item = noteImageCopyMetadata(value[i], omitPayloadKeys);
      if (item !== undefined) array[i] = item;
    }
    return array;
  }
  if (!noteImageIsPlainObject(value)) return value;
  var copy = {};
  Object.keys(value).forEach(function (key) {
    if (omitPayloadKeys && omitPayloadKeys[key]) return;
    var child = noteImageCopyMetadata(value[key], omitPayloadKeys);
    if (child !== undefined) copy[key] = child;
  });
  return copy;
}

function noteImageSourceFromEntry(entry) {
  if (typeof entry === 'string') return { value: entry, sourceKey: 'imageBase64', mimeType: '' };
  if (noteImageIsBlob(entry)) return { value: entry, sourceKey: 'blob', mimeType: entry.type || '' };
  if (!entry || typeof entry !== 'object') return null;
  var keys = ['imageBase64', 'src', 'data', 'blob', 'payload', 'base64', 'imageData'];
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      return { value: entry[key], sourceKey: key, mimeType: entry.mimeType || '' };
    }
  }
  return null;
}

function noteImageSourceInfo(entry) {
  var source = noteImageSourceFromEntry(entry);
  if (!source) return null;
  if (noteImageIsBlob(source.value)) {
    return {
      kind: 'local',
      blob: source.value,
      mimeType: source.value.type || source.mimeType || 'application/octet-stream',
      sourceKey: source.sourceKey,
      signature: 'blob:' + source.value.size + ':' + source.value.type,
    };
  }
  if (typeof source.value !== 'string') return null;
  var value = source.value.trim();
  if (isDataImageSource(value)) {
    var parsed = noteImageParseDataUrl(value);
    return {
      kind: 'local',
      blob: dataUrlToBlob(value),
      mimeType: parsed.mimeType,
      sourceKey: source.sourceKey,
      signature: 'data:' + parsed.mimeType + ':' + noteImageNormaliseBase64(parsed.encoded),
    };
  }
  if (noteImageLooksLikeRawBase64(value, source.mimeType)) {
    return {
      kind: 'local',
      blob: dataUrlToBlob('data:' + source.mimeType + ';base64,' + value),
      mimeType: String(source.mimeType).toLowerCase(),
      sourceKey: source.sourceKey,
      signature: 'data:' + String(source.mimeType).toLowerCase() + ':' + noteImageNormaliseBase64(value),
    };
  }
  if (isRemoteImageSource(value, source.mimeType)) {
    return {
      kind: 'remote',
      value: value,
      sourceKey: source.sourceKey,
      signature: 'url:' + value,
    };
  }
  return null;
}

function noteImageFieldIntent(note, field) {
  if (!Object.prototype.hasOwnProperty.call(note, field)) return 'preserve';
  return Array.isArray(note[field]) && note[field].length > 0 ? 'replace' : 'delete';
}

function noteImageDefaultMarker(field, index) {
  // Extracted-image markers are intentionally tied to the sparse source
  // index. Gallery HTML can therefore refer to index 2 without collapsing
  // the owner to the first selected image.
  return field === 'extractedImages' ? 'note-image-' + index : '';
}

function noteImageHtmlIntent(note) {
  if (!Object.prototype.hasOwnProperty.call(note, 'notesHtml')) return 'preserve';
  return typeof note.notesHtml === 'string' && note.notesHtml.length > 0 ? 'replace' : 'delete';
}

function noteImageRecordEntries(record) {
  if (!record || !Array.isArray(record.images)) return [];
  return record.images.filter(function (entry) {
    return entry && typeof entry === 'object' && noteImageIsBlob(entry.blob);
  }).map(function (entry) {
    return noteImageClone(entry);
  });
}

function noteImagePayloadOmitMap() {
  var omit = {};
  NOTE_IMAGE_PAYLOAD_KEYS.forEach(function (key) { omit[key] = true; });
  return omit;
}

function noteImageLightweightEntry(entry, sourceInfo) {
  if (!sourceInfo) return noteImageLocalMetadataEntry(entry);
  if (sourceInfo && sourceInfo.kind === 'remote') {
    var omit = noteImagePayloadOmitMap();
    delete omit[sourceInfo.sourceKey];
    var remote = noteImageCopyMetadata(entry, omit);
    if (typeof entry === 'string') remote = { imageBase64: sourceInfo.value, mimeType: 'url' };
    else if (!remote || typeof remote !== 'object') remote = {};
    remote[sourceInfo.sourceKey] = sourceInfo.value;
    return remote;
  }
  return noteImageLocalMetadataEntry(entry);
}

function noteImageLocalMetadataEntry(entry) {
  var metadata = noteImageCopyMetadata(entry, noteImagePayloadOmitMap());
  return metadata && typeof metadata === 'object' ? metadata : {};
}

function noteImageRecordEntry(entry, field, index, sourceInfo) {
  var metadata = noteImageCopyMetadata(
    typeof entry === 'object' && !noteImageIsBlob(entry) ? entry : {},
    noteImagePayloadOmitMap(),
  );
  if (!metadata || typeof metadata !== 'object') metadata = {};
  metadata.field = field;
  metadata.index = index;
  metadata.blob = sourceInfo.blob;
  metadata.mimeType = sourceInfo.mimeType || metadata.mimeType || sourceInfo.blob.type || 'application/octet-stream';
  metadata.sourceKey = sourceInfo.sourceKey;
  metadata._sourceSignature = sourceInfo.signature;
  return metadata;
}

function noteImageCollection(note, field, workingEntries) {
  var value = note[field];
  if (!Array.isArray(value)) return [];
  var output = new Array(value.length);
  for (var index = 0; index < value.length; index += 1) {
    if (!(index in value)) continue;
    var entry = value[index];
    if (entry === null || entry === undefined) {
      output[index] = entry;
      continue;
    }
    var sourceInfo = noteImageSourceInfo(entry);
    if (sourceInfo && sourceInfo.kind === 'local') {
      var recordEntry = noteImageRecordEntry(entry, field, index, sourceInfo);
      if (!recordEntry.markerId) recordEntry.markerId = noteImageDefaultMarker(field, index);
      workingEntries.push(recordEntry);
      output[index] = noteImageLocalMetadataEntry(entry);
      if (recordEntry.markerId) output[index].markerId = recordEntry.markerId;
    } else {
      output[index] = noteImageLightweightEntry(entry, sourceInfo);
    }
  }
  return output;
}

function noteImageReplaceHtmlSources(html, workingEntries) {
  var htmlIndex = 0;
  return String(html).replace(/<img\b([^>]*?)>/gi, function (whole, attrs) {
    var sourceMatch = /\bsrc\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))/i.exec(attrs);
    if (!sourceMatch) return whole;
    var value = sourceMatch[2] !== undefined ? sourceMatch[2] : sourceMatch[3];
    var mimeMatch = /\b(?:data-mime-type|data-mime|mime-type|type)\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/i.exec(attrs);
    var mimeType = mimeMatch ? (mimeMatch[2] !== undefined ? mimeMatch[2] : mimeMatch[3]) : '';
    var sourceInfo;
    if (isDataImageSource(value)) {
      sourceInfo = noteImageSourceInfo({ imageBase64: value, mimeType: noteImageParseDataUrl(value).mimeType });
    } else {
      var inferredMimeType = mimeType || noteImageInferMimeFromRawBase64(value);
      if (!noteImageLooksLikeRawBase64(value, inferredMimeType)) return whole;
      sourceInfo = noteImageSourceInfo({ imageBase64: value, mimeType: inferredMimeType });
    }
    var markerMatch = /\bdata-note-image-ref\s*=\s*(?:(["])([^"]+)\1|([^\s>]+))/i.exec(attrs);
    var requestedMarker = markerMatch ? (markerMatch[2] !== undefined ? markerMatch[2] : markerMatch[3]) : '';
    var arrayOwner = requestedMarker && workingEntries.find(function (entry) {
      return entry.field !== 'html' && entry.markerId === requestedMarker;
    });
    if (arrayOwner) {
      // The gallery marker points at the array owner. Remove an older HTML
      // alias with the same marker so hydrated saves cannot grow duplicates.
      for (var ownerIndex = workingEntries.length - 1; ownerIndex >= 0; ownerIndex -= 1) {
        if (workingEntries[ownerIndex].field === 'html'
            && workingEntries[ownerIndex].markerId === requestedMarker) {
          workingEntries.splice(ownerIndex, 1);
        }
      }
      var sharedAttrs = attrs.replace(/\s*src\s*=\s*(?:(['"])[^'"]*\1|[^\s>]+)/i, '');
      return '<img' + sharedAttrs + ' src="" data-note-image-ref="' + requestedMarker + '">';
    }
    var existingHtml = requestedMarker && workingEntries.find(function (entry) {
      return entry.field === 'html' && entry.markerId === requestedMarker;
    });
    if (existingHtml) {
      var replacement = noteImageRecordEntry({}, 'html', htmlIndex, sourceInfo);
      replacement.markerId = requestedMarker;
      Object.assign(existingHtml, replacement);
      htmlIndex += 1;
      var existingAttrs = attrs.replace(/\s*data-note-image-ref\s*=\s*(?:["'][^"']*["']|[^\s>]+)/i, '');
      existingAttrs = existingAttrs.replace(/\s*src\s*=\s*(?:(['"])[^'"]*\1|[^\s>]+)/i, '');
      return '<img' + existingAttrs + ' src="" data-note-image-ref="' + requestedMarker + '">';
    }
    var existing = noteImageRecordEntry({}, 'html', htmlIndex, sourceInfo);
    if (requestedMarker) existing.markerId = requestedMarker;
    workingEntries.push(existing);
    htmlIndex += 1;
    var token = '__NOTE_IMAGE_REF_' + workingEntries.indexOf(existing) + '__';
    var cleanAttrs = attrs.replace(/\sdata-note-image-ref\s*=\s*(?:["'][^"']*["']|[^\s>]+)/i, '');
    cleanAttrs = cleanAttrs.replace(/\s*src\s*=\s*(?:(["'])[^"']*\1|[^\s>]+)/i, '');
    return '<img' + cleanAttrs + ' src="" data-note-image-ref="' + token + '">';
  });
}

function noteImageKeepReferencedHtmlEntries(html, entries) {
  var referenced = {};
  String(html).replace(/\bdata-note-image-ref\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/gi, function (whole, quote, quoted, bare) {
    referenced[quoted !== undefined ? quoted : bare] = true;
    return whole;
  });
  return entries.filter(function (entry) {
    return entry.field !== 'html' || referenced[entry.markerId];
  });
}

function noteImageFinaliseRecord(entries, noteId) {
  var usedMarkers = {};
  entries.forEach(function (entry) {
    if (typeof entry.markerId === 'string' && /^note-image-\d+$/.test(entry.markerId) && !usedMarkers[entry.markerId]) {
      usedMarkers[entry.markerId] = true;
    } else {
      delete entry.markerId;
    }
  });
  var nextMarker = 0;
  entries.forEach(function (entry) {
    if (entry.markerId) return;
    var markerId;
    do {
      markerId = 'note-image-' + nextMarker;
      nextMarker += 1;
    } while (usedMarkers[markerId]);
    entry.markerId = markerId;
    usedMarkers[markerId] = true;
  });
  return {
    noteId: noteId,
    images: entries.map(function (entry) {
      var copy = noteImageClone(entry);
      delete copy._sourceSignature;
      return copy;
    }),
  };
}

function noteImageReplaceTokens(html, entries) {
  var result = String(html);
  entries.forEach(function (entry, index) {
    result = result.split('__NOTE_IMAGE_REF_' + index + '__').join(entry.markerId);
  });
  return result;
}

function detachNoteImages(note, previousImageRecord) {
  var input = note && typeof note === 'object' ? note : {};
  var lightweight = noteImageClone(input);
  var extractedIntent = noteImageFieldIntent(input, 'extractedImages');
  var slideIntent = noteImageFieldIntent(input, 'slideImages');
  var htmlIntent = noteImageHtmlIntent(input);
  var imageIntent = {
    extractedImages: extractedIntent,
    slideImages: slideIntent,
    notesHtml: htmlIntent,
    overall: extractedIntent === 'replace' || slideIntent === 'replace' || htmlIntent === 'replace'
      ? 'replace'
      : (extractedIntent === 'delete' || slideIntent === 'delete' || htmlIntent === 'delete' ? 'delete' : 'preserve'),
  };
  var workingEntries = noteImageRecordEntries(previousImageRecord);
  ['extractedImages', 'slideImages'].forEach(function (field) {
    var intent = imageIntent[field];
    if (intent === 'replace' || intent === 'delete') {
      workingEntries = workingEntries.filter(function (entry) { return entry.field !== field; });
    }
    if (intent === 'replace') lightweight[field] = noteImageCollection(input, field, workingEntries);
    if (intent === 'delete') lightweight[field] = [];
  });
  if (htmlIntent === 'replace') {
    workingEntries = noteImageKeepReferencedHtmlEntries(input.notesHtml, workingEntries);
    lightweight.notesHtml = noteImageReplaceHtmlSources(input.notesHtml, workingEntries);
  } else if (htmlIntent === 'delete') {
    lightweight.notesHtml = '';
    workingEntries = workingEntries.filter(function (entry) { return entry.field !== 'html'; });
  }
  var noteId = input.id !== undefined ? input.id : input.noteId;
  var imageRecord = noteImageFinaliseRecord(workingEntries, noteId);
  if (htmlIntent === 'replace') lightweight.notesHtml = noteImageReplaceTokens(lightweight.notesHtml, workingEntries);
  return { note: lightweight, imageRecord: imageRecord, imageIntent: imageIntent };
}

function noteImageHydratedEntry(entry, dataUrl) {
  var copy = noteImageCopyMetadata(entry, { blob: true, field: true, index: true, markerId: true, sourceKey: true });
  if (!copy || typeof copy !== 'object') copy = {};
  var payload = dataUrl;
  if (isDataImageSource(dataUrl)) {
    var parsed = noteImageParseDataUrl(dataUrl);
    if (parsed.isBase64) payload = noteImageNormaliseBase64(parsed.encoded);
  }
  copy.imageBase64 = payload;
  if (entry.sourceKey && entry.sourceKey !== 'imageBase64') copy[entry.sourceKey] = dataUrl;
  return copy;
}

function noteImageRestoreHtml(html, dataUrls) {
  return String(html).replace(/<img\b([^>]*?)>/gi, function (whole, attrs) {
    var markerMatch = /\bdata-note-image-ref\s*=\s*(?:(["'])([^"']+)\1|([^\s>]+))/i.exec(attrs);
    if (!markerMatch) return whole;
    var marker = markerMatch[2] !== undefined ? markerMatch[2] : markerMatch[3];
    if (!Object.prototype.hasOwnProperty.call(dataUrls, marker)) return whole;
    var cleanAttrs = attrs.replace(/\s*src\s*=\s*(?:(["'])[^"']*\1|[^\s>]+)/i, '');
    return '<img' + cleanAttrs + ' src="' + dataUrls[marker] + '">';
  });
}

async function hydrateNoteImages(note, imageRecord) {
  var hydrated = noteImageClone(note && typeof note === 'object' ? note : {});
  var entries = noteImageRecordEntries(imageRecord);
  var dataUrls = {};
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    var dataUrl = await blobToDataUrl(entry.blob);
    dataUrls[entry.markerId || ('note-image-' + i)] = dataUrl;
    if (entry.field === 'extractedImages' || entry.field === 'slideImages') {
      if (!Array.isArray(hydrated[entry.field])) hydrated[entry.field] = [];
      if (entry.index >= hydrated[entry.field].length) hydrated[entry.field].length = entry.index + 1;
      hydrated[entry.field][entry.index] = noteImageHydratedEntry(entry, dataUrl);
    }
  }
  if (typeof hydrated.notesHtml === 'string') hydrated.notesHtml = noteImageRestoreHtml(hydrated.notesHtml, dataUrls);
  return hydrated;
}

function stripNoteImagePayloads(note) {
  return detachNoteImages(note).note;
}

function isQuotaExceededError(error) {
  if (!error) return false;
  return error.name === 'QuotaExceededError'
    || error.code === 22
    || error.code === 1014
    || /quota|storage space/i.test(String(error.message || ''));
}
