// PPTX/PDF parsing: text extraction, image extraction, speaker separation.
// Depends on: constants.js (pdfjsLib, pptFile, imageFiles, MAX_IMAGE_UPLOAD_COUNT, txtFiles, recIdCounter, abortController, REC_ORDINALS, dragSrcRecId, debugLog).

/* ═══════════════════════════════════════════════
   PDF.js — load worker via importScripts-compatible shim.
   pdf.min.mjs is an ES module; we load it dynamically so we
   can set the workerSrc before first use.
═══════════════════════════════════════════════ */
async function getPdfjsLib() {
  if (pdfjsLib) return pdfjsLib;
  const mod = await import(
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
  );
  mod.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  pdfjsLib = mod;
  return pdfjsLib;
}

/* ═══════════════════════════════════════════════
   File handling
═══════════════════════════════════════════════ */
const IMAGE_UPLOAD_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
function isImageUploadFile(file) {
  const name = file.name.toLowerCase();
  return IMAGE_UPLOAD_EXTS.some(ext => name.endsWith(ext));
}

function setDocSlotTag(iconHtml, tagText) {
  document.getElementById('pptIcon').innerHTML = iconHtml;
  document.getElementById('pptTagName').textContent = tagText;
  document.getElementById('pptTag').style.display = 'inline-flex';
  document.getElementById('pptZone').classList.add('has-file');
}

/* U8: document slot accepts .pptx/.pdf/.docx (single file) OR standalone
   image(s) (photos of slides/handwritten notes — multiple = pages of one
   lecture, transcribed via vision in note_creation.js). The two kinds are
   mutually exclusive: picking one clears the other. `files` is a FileList
   or single File (drag-drop passes a FileList too, see main_inline.js). */
async function onPptChange(files) {
  const list = files instanceof FileList || Array.isArray(files) ? Array.from(files) : [files];
  if (!list.length) return;

  if (list.length > 1) {
    // Multiple files selected → document slot only supports this for images.
    if (!list.every(isImageUploadFile)) {
      showToast('⚠️ 여러 파일을 한 번에 올리려면 모두 이미지(.jpg, .png, .webp, .heic)여야 합니다.');
      return;
    }
    if (list.length > MAX_IMAGE_UPLOAD_COUNT) {
      showToast(`⚠️ 이미지는 최대 ${MAX_IMAGE_UPLOAD_COUNT}장까지 업로드할 수 있습니다.`);
      return;
    }
    const oversized = list.find(f => f.size > MAX_FILE_SIZE_BYTES);
    if (oversized) {
      showToast(`⚠️ "${oversized.name}" 파일이 너무 큽니다 (${(oversized.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
      return;
    }
    imageFiles = list;
    pptFile = null;
    setDocSlotTag('<i data-lucide="image"></i>', `이미지 ${list.length}장`);
    checkReady();
    return;
  }

  const file = list[0];
  if (isImageUploadFile(file)) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      showToast(`⚠️ 파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
      return;
    }
    imageFiles = [file];
    pptFile = null;
    setDocSlotTag('<i data-lucide="image"></i>', '이미지 1장');
    checkReady();
    return;
  }

  const name = file.name.toLowerCase();
  if (!name.endsWith('.pptx') && !name.endsWith('.pdf') && !name.endsWith('.docx')) {
    showToast('⚠️ .pptx, .pdf, .docx 또는 이미지(.jpg, .png, .webp, .heic) 파일만 업로드할 수 있습니다.');
    return;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    showToast(`⚠️ 파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
    return;
  }
  if (file.size > WARN_FILE_SIZE_BYTES) {
    if (!await appConfirm(`파일 크기가 ${(file.size / 1024 / 1024).toFixed(0)}MB입니다. 처리 시간이 길어질 수 있습니다. 계속하시겠습니까?`)) return;
  }
  imageFiles = [];  // mutual exclusion: a deck/doc replaces any staged images
  pptFile = file;
  setDocSlotTag(
    name.endsWith('.pptx') ? '<i data-lucide="presentation"></i>' : '<i data-lucide="file-text"></i>',
    file.name
  );
  checkReady();
}

/* ── Multi-recording slot management ─────────── */

function addRecSlot(file = null) {
  const id = ++recIdCounter;
  txtFiles.push({ id, file });
  renderRecSlots();
  checkReady();
}

function removeRecSlot(id) {
  txtFiles = txtFiles.filter(s => s.id !== id);
  renderRecSlots();
  checkReady();
}

function setRecSlotFile(id, file) {
  const slot = txtFiles.find(s => s.id === id);
  if (slot) slot.file = file;
  renderRecSlots();
  checkReady();
}

function reorderRecSlots(srcId, dstId) {
  const srcIdx = txtFiles.findIndex(s => s.id === srcId);
  const dstIdx = txtFiles.findIndex(s => s.id === dstId);
  if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return;
  const [item] = txtFiles.splice(srcIdx, 1);
  // After removing src, every slot after it shifts left by one. So when the
  // drop target sat below the source, its index is now one less than before
  // the splice — drop the item at the corrected index. Without this, the item
  // lands one slot too early, an off-by-one that compounds and looks broken
  // once there are many slots.
  const insertIdx = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
  txtFiles.splice(insertIdx, 0, item);
  renderRecSlots();
}

// Auto-sort slots by filename in natural numeric order (so "2교시" precedes
// "10교시", "lecture1" precedes "lecture12", etc.). Slots with no file yet
// are pushed to the end so they don't disrupt the ordering of named ones.
function sortRecSlotsByName() {
  txtFiles.sort((a, b) => {
    const an = a.file ? a.file.name : '';
    const bn = b.file ? b.file.name : '';
    if (!an && !bn) return 0;
    if (!an) return 1;
    if (!bn) return -1;
    return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' });
  });
  renderRecSlots();
  checkReady();
}

function renderRecSlots() {
  const list = document.getElementById('multiRecList');
  const zone = document.getElementById('multiRecZone');
  if (!list) return;

  // BYO transcript hint card — shown only on new-note view, dismissed via localStorage
  if (zone && _currentView === 'new') {
    if (!document.getElementById('byoTranscriptHint')) {
      if (!localStorage.getItem('byoTranscriptHintDismissed')) {
        const card = document.createElement('div');
        card.id = 'byoTranscriptHint';
        card.style.cssText = [
          'background:rgba(var(--surface2-rgb,30,30,40),0.7)',
          'border:1px solid var(--border,rgba(255,255,255,0.12))',
          'border-radius:10px',
          'padding:0.75rem 1rem',
          'margin-bottom:0.75rem',
          'font-size:0.82rem',
          'line-height:1.5',
          'color:var(--text-muted,#aaa)',
          'position:relative',
        ].join(';');
        card.innerHTML = `
          <button id="byoTranscriptHintClose" aria-label="닫기" style="position:absolute;top:0.4rem;right:0.6rem;background:none;border:none;cursor:pointer;color:var(--text-muted,#aaa);font-size:1rem;line-height:1">×</button>
          <div style="margin-bottom:0.3rem;font-weight:600;color:var(--text,#e8e8e8)">💡 더 정확한 녹취록을 원하시나요?</div>
          다른 한국어 STT 서비스에서 녹취록을 만든 뒤 <strong>.txt 파일로 업로드</strong>하셔도 됩니다:<br>
          &nbsp;•&nbsp;<a href="https://clovanote.naver.com" target="_blank" rel="noopener" style="color:var(--accent,#7c9ef8)">클로바노트</a> — 무료 월 5시간<br>
          &nbsp;•&nbsp;<a href="https://daglo.ai" target="_blank" rel="noopener" style="color:var(--accent,#7c9ef8)">다글로</a> — 한국어 정확도 최상<br>
          <span style="display:block;margin-top:0.35rem;font-size:0.78rem">본 앱의 내장 녹음/STT는 빠른 시작용이며, 정확도가 낮을 수 있습니다.</span>
        `;
        card.querySelector('#byoTranscriptHintClose').addEventListener('click', () => {
          localStorage.setItem('byoTranscriptHintDismissed', '1');
          card.remove();
        });
        list.parentNode.insertBefore(card, list);
      }
    }
  }

  list.innerHTML = '';

  const hasFiles = txtFiles.some(s => s.file !== null);
  if (zone) zone.classList.toggle('has-files', hasFiles);

  // Show the filename-sort button only when there are ≥2 filled slots —
  // sorting zero or one file is meaningless.
  const sortBtn = document.getElementById('sortRecBtn');
  if (sortBtn) {
    const filled = txtFiles.filter(s => s.file).length;
    sortBtn.style.display = filled >= 2 ? '' : 'none';
  }

  if (txtFiles.length === 0) {
    list.innerHTML = '<div class="rec-empty-hint">녹취록이 없으면 PPT만으로 노트를 작성합니다</div>';
    return;
  }

  txtFiles.forEach((item, idx) => {
    const orderLabel = REC_ORDINALS[idx] ?? `${idx + 1}교시`;
    const fileName   = item.file ? item.file.name : null;

    const div = document.createElement('div');
    div.className    = 'rec-slot';
    div.dataset.id   = item.id;

    const handle = document.createElement('span');
    handle.className = 'rec-drag-handle';
    handle.title     = '드래그하여 순서 변경';
    handle.textContent = '⠿';

    const orderSpan = document.createElement('span');
    orderSpan.className   = 'rec-order-label';
    orderSpan.textContent = orderLabel;

    const fileArea = document.createElement('div');
    fileArea.className = 'rec-file-area';

    const fileInput = document.createElement('input');
    fileInput.type   = 'file';
    fileInput.accept = '.txt';
    fileInput.className = 'rec-file-input';

    const fileNameSpan = document.createElement('span');
    fileNameSpan.className   = 'rec-file-name' + (fileName ? ' has-file' : '');
    fileNameSpan.textContent = fileName ? ('✓ ' + fileName) : '파일 선택 또는 여기에 드롭';

    fileArea.append(fileInput, fileNameSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'rec-remove-btn';
    removeBtn.title       = '제거';
    removeBtn.textContent = '×';

    // U18: empty slots also offer picking a SAVED transcript (내 녹취록) in
    // place — previously the only path was leaving for the 내 녹취록 page.
    if (!fileName && typeof window.pickSavedTranscriptForSlot === 'function' && _currentView === 'new') {
      const pickBtn = document.createElement('button');
      pickBtn.type        = 'button';
      pickBtn.className   = 'rec-pick-saved-btn';
      pickBtn.title       = '저장된 녹취록에서 선택';
      pickBtn.textContent = '🎙 내 녹취록';
      pickBtn.addEventListener('click', e => {
        e.stopPropagation();
        window.pickSavedTranscriptForSlot(item.id);
      });
      div.append(handle, orderSpan, fileArea, pickBtn, removeBtn);
    } else {
      div.append(handle, orderSpan, fileArea, removeBtn);
    }

    // ── File input change ──
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!f.name.toLowerCase().endsWith('.txt')) {
        showToast('⚠️ .txt 파일만 업로드할 수 있습니다.');
        return;
      }
      // C1: OOM guard — reject absurdly large transcripts before they hit memory.
      // Real lecture transcripts are <1MB; 200MB is just catching pathological input.
      if (f.size > MAX_FILE_SIZE_BYTES) {
        showToast(`⚠️ 녹취록 파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
        return;
      }
      setRecSlotFile(item.id, f);
    });

    // ── Remove ──
    removeBtn.addEventListener('click', () => removeRecSlot(item.id));

    // ── Drag to reorder: enable dragging only via handle ──
    handle.addEventListener('mousedown', () => div.setAttribute('draggable', 'true'));
    div.addEventListener('dragend',  () => {
      div.setAttribute('draggable', 'false');
      div.classList.remove('dragging');
      document.querySelectorAll('.rec-slot').forEach(s => s.classList.remove('drag-over-slot'));
    });
    div.addEventListener('mouseup', () => div.setAttribute('draggable', 'false'));

    div.addEventListener('dragstart', e => {
      dragSrcRecId = item.id;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(item.id)); // Firefox requires this
    });

    div.addEventListener('dragover', e => {
      e.preventDefault();
      // File drag from OS: highlight the file area, not the slot border
      if (e.dataTransfer.types.includes('Files')) {
        div.classList.remove('drag-over-slot');
      } else {
        e.dataTransfer.dropEffect = 'move';
        div.classList.add('drag-over-slot');
      }
    });

    div.addEventListener('dragleave', e => {
      // Only remove if leaving the slot entirely
      if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over-slot');
    });

    div.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation(); // prevent multiRecZone's drop from firing
      div.classList.remove('drag-over-slot');

      if (e.dataTransfer.files.length > 0) {
        // OS file drop onto this slot
        const f = e.dataTransfer.files[0];
        if (!f.name.toLowerCase().endsWith('.txt')) {
          showToast('⚠️ .txt 파일만 업로드할 수 있습니다.');
          return;
        }
        // C1: OOM guard — see fileInput change handler above.
        if (f.size > MAX_FILE_SIZE_BYTES) {
          showToast(`⚠️ 녹취록 파일이 너무 큽니다 (${(f.size / 1024 / 1024).toFixed(0)}MB). 최대 200MB까지 업로드할 수 있습니다.`);
          return;
        }
        setRecSlotFile(item.id, f);
      } else if (dragSrcRecId !== null && dragSrcRecId !== item.id) {
        // Slot reorder
        reorderRecSlots(dragSrcRecId, item.id);
      }
      dragSrcRecId = null;
    });

    list.appendChild(div);
  });
}

function setupDrop(zoneId, handler) {
  const zone = document.getElementById(zoneId);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    // U15: pass the whole FileList (not just files[0]) so multi-image drops
    // work the same as the file picker's multi-select. Only call site today
    // is pptZone/onPptChange, which already accepts a FileList (U8).
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files);
  });
}

function checkReady() {
  if (isBatchMode) {
    checkBatchReady();
  } else {
    const hasRecordings = txtFiles.some(s => s.file !== null);
    const hasDoc = !!pptFile || imageFiles.length > 0;  // U8: image upload also fills the document slot
    // U1: transcript-only analysis is now allowed — enable when either input exists.
    analyzeBtn.disabled = isRunning || (!hasDoc && !hasRecordings);
    const notice = document.getElementById('pptOnlyNotice');
    if (hasDoc && !hasRecordings) notice.classList.add('visible');
    else notice.classList.remove('visible');

    // Inject a hint (once) when a transcript is loaded but no PPT yet
    let recOnlyHint = document.getElementById('recOnlyHint');
    if (!recOnlyHint && notice && notice.parentNode) {
      recOnlyHint = document.createElement('div');
      recOnlyHint.id = 'recOnlyHint';
      recOnlyHint.style.cssText = [
        'display:none',
        'font-size:0.82rem',
        'color:var(--secondary)',
        'background:var(--secondary-dim)',
        'border:1px solid var(--secondary-dim)',
        'border-radius:6px',
        'padding:0.45rem 0.9rem',
        'margin-top:0.5rem',
        'text-align:center',
        'line-height:1.5',
      ].join(';');
      recOnlyHint.textContent = '💡 녹취록만으로도 분석할 수 있어요 — PPT/PDF를 함께 올리면 더 정확해집니다.';
      notice.parentNode.insertBefore(recOnlyHint, notice.nextSibling);
    }
    if (recOnlyHint) {
      recOnlyHint.style.display = (!hasDoc && hasRecordings) ? '' : 'none';
    }
  }
}

/* ═══════════════════════════════════════════════
   Presentation text extraction — dispatches by type
═══════════════════════════════════════════════ */
async function extractPresentationText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf'))  return extractPdfText(file);
  if (name.endsWith('.docx')) return extractDocxText(file);
  return extractPptxText(file);
}

/* ── DOCX via JSZip + XML (no page markers — Word docs have no pages) ── */
function decodeXmlEntities(s) {
  // &amp; must decode LAST — decoding it first double-decodes e.g. &amp;lt; into <
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function extractDocxText(file) {
  const zip = await JSZip.loadAsync(file);
  const docFile = zip.files['word/document.xml'];
  // Throw (not a sentinel string) — a returned string would flow into the
  // pipeline as the document text and generate a note from garbage.
  if (!docFile) throw new Error('Word 문서에서 텍스트를 추출할 수 없습니다.');

  const xml = await docFile.async('text');
  const paraXmls = xml.split(/<w:p[ >]/).slice(1); // first chunk is pre-first-paragraph content

  const paragraphs = [];
  for (const paraXml of paraXmls) {
    const texts = [...paraXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => decodeXmlEntities(m[1]));
    const para  = texts.join('').trim();
    if (para) paragraphs.push(para);
  }

  const result = paragraphs.join('\n\n').trim();
  if (!result) throw new Error('Word 문서에서 텍스트를 추출할 수 없습니다.');
  debugLog('DOCX', `Extracted ${paragraphs.length} paragraphs, ${result.length} chars`);
  return result;
}

/* ── PPTX via JSZip + XML ─────────────────────── */

/* Resolve the notesSlide path for a given slide via its .rels file.
   Notes slides are numbered independently from slide numbers, so we
   must look up the relationship rather than assuming matching numbers. */
async function findNotesPath(zip, slidePath) {
  const slideFile = slidePath.split('/').pop();                      // e.g. "slide3.xml"
  const relsPath  = `ppt/slides/_rels/${slideFile}.rels`;
  if (!zip.files[relsPath]) return null;
  const relsXml = await zip.files[relsPath].async('text');
  const m = relsXml.match(/Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"/);
  if (!m) return null;
  const target   = m[1];                                             // e.g. "../notesSlides/notesSlide2.xml"
  const resolved = target.startsWith('../')
    ? 'ppt/' + target.slice(3)
    : 'ppt/slides/' + target;
  return zip.files[resolved] ? resolved : null;
}

/* Parse slide's .rels file to find chart and SmartArt diagram relationships.
   Returns { charts: [resolvedPath,...], diagrams: [resolvedPath,...] }. */
async function findSlideRelationships(zip, slidePath) {
  const slideFile = slidePath.split('/').pop();
  const relsPath  = `ppt/slides/_rels/${slideFile}.rels`;
  const result    = { charts: [], diagrams: [] };
  if (!zip.files[relsPath]) return result;

  const relsXml = await zip.files[relsPath].async('text');
  const relRe   = /<Relationship[^>]+Type="([^"]+)"[^>]+Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relsXml)) !== null) {
    const type     = m[1];
    const target   = m[2];
    const resolved = target.startsWith('../')
      ? 'ppt/' + target.slice(3)
      : 'ppt/slides/' + target;
    if (!zip.files[resolved]) continue;
    if (type.includes('/chart'))       result.charts.push(resolved);
    if (type.includes('/diagramData')) result.diagrams.push(resolved);
  }
  return result;
}

/* Parse c:chart XML and build a markdown table from series data.
   Returns a formatted string like "차트(title):\n| header |...\n| row |...". */
function extractChartData(chartXml) {
  const parser   = new DOMParser();
  const doc      = parser.parseFromString(chartXml, 'application/xml');
  const titleEls = doc.getElementsByTagName('c:t');
  const title    = titleEls.length ? titleEls[0].textContent.trim() : '';

  const series = [];
  for (const ser of doc.getElementsByTagName('c:ser')) {
    const txEl  = ser.getElementsByTagName('c:tx')[0];
    const nameV = txEl ? txEl.getElementsByTagName('c:v')[0] : null;
    const name  = nameV ? nameV.textContent.trim() : `시리즈${series.length + 1}`;

    const catEl = ser.getElementsByTagName('c:cat')[0];
    const cats  = catEl
      ? Array.from(catEl.getElementsByTagName('c:v')).map(v => v.textContent.trim())
      : [];

    const valEl = ser.getElementsByTagName('c:val')[0] || ser.getElementsByTagName('c:yVal')[0];
    const vals  = valEl
      ? Array.from(valEl.getElementsByTagName('c:v')).map(v => v.textContent.trim())
      : [];

    series.push({ name, cats, vals });
  }

  if (!series.length) return title ? `차트(${title}): 데이터 없음` : '';

  const allCats = series[0].cats.length
    ? series[0].cats
    : series[0].vals.map((_, i) => String(i + 1));
  const header  = '| 카테고리 | ' + series.map(s => s.name).join(' | ') + ' |';
  const sep     = '| --- | '     + series.map(() => '---').join(' | ') + ' |';
  const rows    = allCats.map((cat, i) =>
    '| ' + cat + ' | ' + series.map(s => s.vals[i] ?? '').join(' | ') + ' |'
  );

  const label = title ? `차트(${title})` : '차트';
  return `${label}:\n${header}\n${sep}\n${rows.join('\n')}`;
}

/* Parse SmartArt diagram data XML and return " / "-separated text. */
function extractDiagramText(diagramXml) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(diagramXml, 'application/xml');

  // Try namespace-prefixed elements first, then unprefixed fallback
  const pts    = doc.getElementsByTagName('dgm:pt').length
    ? doc.getElementsByTagName('dgm:pt')
    : doc.getElementsByTagName('pt');

  const texts = [];
  for (const pt of pts) {
    const type = pt.getAttribute('type') || '';
    if (type === 'parTrans' || type === 'sibTrans') continue;
    const atEls = pt.getElementsByTagName('a:t').length
      ? pt.getElementsByTagName('a:t')
      : pt.getElementsByTagName('t');
    for (const el of atEls) {
      const t = el.textContent.trim();
      if (t) texts.push(t);
    }
  }
  return texts.join(' / ');
}

async function extractPptxText(file) {
  const zip = await JSZip.loadAsync(file);

  const slidePaths = [];
  zip.forEach(path => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) slidePaths.push(path);
  });
  slidePaths.sort((a, b) =>
    parseInt(a.match(/(\d+)/)[1]) - parseInt(b.match(/(\d+)/)[1])
  );

  if (slidePaths.length === 0) return '슬라이드 내용을 찾을 수 없습니다.';

  const lines = [];
  for (const path of slidePaths) {
    const num      = path.match(/(\d+)/)[1];
    const slideXml = await zip.files[path].async('text');

    // Resolve notes path via rels (correct) rather than assuming number match
    const notesPath = await findNotesPath(zip, path);
    const notesXml  = notesPath ? await zip.files[notesPath].async('text') : '';

    const { title, body, tables, notes } = extractSlideContent(slideXml, notesXml);

    // Extract chart and SmartArt diagram data via slide relationships
    const rels        = await findSlideRelationships(zip, path);
    const chartTexts  = [];
    for (const chartPath of rels.charts) {
      const ct = extractChartData(await zip.files[chartPath].async('text'));
      if (ct) chartTexts.push(ct);
    }
    const diagramTexts = [];
    for (const dgmPath of rels.diagrams) {
      const dt = extractDiagramText(await zip.files[dgmPath].async('text'));
      if (dt) diagramTexts.push(dt);
    }

    const hasContent = title || body || tables.length > 0 || notes
                    || chartTexts.length > 0 || diagramTexts.length > 0;
    lines.push(`[슬라이드 ${num}]`);
    if (!hasContent) {
      lines.push('(텍스트 없음 — 이미지 전용 슬라이드)');
    } else {
      if (title)              lines.push(`제목: ${title}`);
      if (body)               lines.push(`내용: ${body}`);
      tables.forEach(t     => lines.push(`표:\n${t}`));
      chartTexts.forEach(c  => lines.push(c));
      diagramTexts.forEach(d => lines.push(`다이어그램: ${d}`));
      if (notes)              lines.push(`노트: ${notes}`);
    }
    if (tables.length || chartTexts.length || diagramTexts.length) {
      console.log(`[슬라이드 ${num}] 구조 데이터:`,
        { tables: tables.length, charts: chartTexts.length, diagrams: diagramTexts.length });
    }
    lines.push('');
  }

  const result = lines.join('\n').trim() || 'PPT에서 텍스트를 추출할 수 없습니다.';
  debugLog('PPT', `Extracted ${slidePaths.length} slides, ${result.length} chars, tables=${/표:/.test(result)}, charts=${/차트/.test(result)}, diagrams=${/다이어그램:/.test(result)}`);
  console.log('[PPT 추출 완료] storedPptText 길이:', result.length);
  console.log('[PPT 추출 완료] 표/차트 포함 여부:', /표:|차트|다이어그램:/.test(result) ? '✅' : '❌');
  console.log('[PPT 추출 결과 전문]', result);
  return result;
}

/* Extract structured content from a single slide's XML.
   Uses getElementsByTagName('ns:local') which is reliable for namespace-
   prefixed elements in DOMParser/application/xml documents across all
   modern browsers, avoiding the broad unqualified fallback selectors
   (", t" / ", p" / ", sp") that could match spurious XML elements. */
function extractSlideContent(slideXml, notesXml) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(slideXml, 'application/xml');

  // All <a:t> text inside el, joined by space
  function getAtTexts(el) {
    return Array.from(el.getElementsByTagName('a:t'))
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
  }

  // Text per <a:p> paragraph — runs within a paragraph are concatenated directly
  function getParaTexts(el) {
    return Array.from(el.getElementsByTagName('a:p'))
      .map(p => Array.from(p.getElementsByTagName('a:t'))
        .map(n => n.textContent.trim()).filter(Boolean).join(''))
      .filter(Boolean);
  }

  // Title: <p:sp> whose <p:ph> has type="title" or type="ctrTitle"
  let title   = '';
  let titleSp = null;
  for (const sp of doc.getElementsByTagName('p:sp')) {
    const phs = sp.getElementsByTagName('p:ph');
    if (phs.length && /^(title|ctrTitle)$/i.test(phs[0].getAttribute('type') || '')) {
      titleSp = sp;
      break;
    }
  }
  if (titleSp) {
    const txBodies = titleSp.getElementsByTagName('p:txBody');
    if (txBodies.length) title = getAtTexts(txBodies[0]);
  }

  // Body: all <p:sp> shapes except title; skip date/footer/slideNum placeholders
  const bodyParts = [];
  for (const sp of doc.getElementsByTagName('p:sp')) {
    if (sp === titleSp) continue;
    const phs    = sp.getElementsByTagName('p:ph');
    const phType = phs.length ? (phs[0].getAttribute('type') || '') : '';
    if (/^(dt|ftr|sldNum)$/i.test(phType)) continue;
    const txBodies = sp.getElementsByTagName('p:txBody');
    if (!txBodies.length) continue;
    const paras = getParaTexts(txBodies[0]);
    if (paras.length) bodyParts.push(paras.join('\n'));
  }
  const body = bodyParts.join('\n').trim();

  // Tables: <p:graphicFrame> → <a:tbl> → rows → cells (namespace fallbacks for edge cases)
  const tables = [];
  const frames = doc.getElementsByTagName('p:graphicFrame').length
    ? doc.getElementsByTagName('p:graphicFrame')
    : doc.getElementsByTagName('graphicFrame');
  for (const frame of frames) {
    const tbls = frame.getElementsByTagName('a:tbl').length
      ? frame.getElementsByTagName('a:tbl')
      : frame.getElementsByTagName('tbl');
    if (!tbls.length) continue;
    const trEls = tbls[0].getElementsByTagName('a:tr').length
      ? tbls[0].getElementsByTagName('a:tr')
      : tbls[0].getElementsByTagName('tr');
    const rows = [];
    Array.from(trEls).forEach((tr, rowIdx) => {
      const tcEls = tr.getElementsByTagName('a:tc').length
        ? tr.getElementsByTagName('a:tc')
        : tr.getElementsByTagName('tc');
      const cells = Array.from(tcEls).map(tc => {
        const apEls = tc.getElementsByTagName('a:p').length
          ? tc.getElementsByTagName('a:p')
          : tc.getElementsByTagName('p');
        const cellText = Array.from(apEls).map(ap => {
          const atEls = ap.getElementsByTagName('a:t').length
            ? ap.getElementsByTagName('a:t')
            : ap.getElementsByTagName('t');
          return Array.from(atEls).map(n => n.textContent.trim()).filter(Boolean).join('');
        }).filter(Boolean).join(' / ').replace(/<[^>]*>/g, '') || ' ';
        return cellText;
      });
      rows.push('| ' + cells.join(' | ') + ' |');
      if (rowIdx === 0) {
        rows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      }
    });
    if (rows.length) tables.push(rows.join('\n'));
  }

  // Notes: skip date/footer/slideNum placeholders
  let notes = '';
  if (notesXml) {
    const ndoc       = parser.parseFromString(notesXml, 'application/xml');
    const notesParts = [];
    for (const sp of ndoc.getElementsByTagName('p:sp')) {
      const phs    = sp.getElementsByTagName('p:ph');
      const phType = phs.length
        ? (phs[0].getAttribute('type') || phs[0].getAttribute('idx') || '')
        : '';
      if (/^(dt|ftr|sldNum)$/i.test(phType)) continue;
      const txBodies = sp.getElementsByTagName('p:txBody');
      if (!txBodies.length) continue;
      const paras = getParaTexts(txBodies[0]);
      if (paras.length) notesParts.push(paras.join(' '));
    }
    notes = notesParts.join(' ').trim();
  }

  return { title, body, tables, notes };
}

/* ── PPTX image extraction ────────────────────── */
async function extractPptxImages(file) {
  const images = [];
  // EMF/WMF are Windows-only vector formats browsers cannot display — intentionally excluded
  const MIME_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
  };
  // Skip base64 strings larger than ~3 MB to avoid freezing the browser
  const MAX_BASE64_LEN = 3 * 1024 * 1024;

  try {
    const zip = await JSZip.loadAsync(file);

    const slidePaths = [];
    zip.forEach(path => {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) slidePaths.push(path);
    });
    // Bug fix: use slide(\d+) so the SLIDE number is captured, not an incidental digit
    slidePaths.sort((a, b) =>
      parseInt(a.match(/slide(\d+)\.xml/)[1]) - parseInt(b.match(/slide(\d+)\.xml/)[1])
    );

    const seen = new Set();
    for (const slidePath of slidePaths) {
      // Bug fix: use slide(\d+) pattern, not the first digit in the full path string
      const slideNum = parseInt(slidePath.match(/slide(\d+)\.xml/)[1]);
      const relsPath = slidePath.replace('ppt/slides/slide', 'ppt/slides/_rels/slide') + '.rels';
      if (!zip.files[relsPath]) continue;

      const relsXml = await zip.files[relsPath].async('text');

      // Bug fix: the old regex used [^/]*? which halts on the '/' chars inside
      // the Type URL (e.g. http://…/relationships/image).  Parse each full
      // <Relationship …/> element as a unit instead.
      const relEls = relsXml.match(/<Relationship\s[^>]+\/?>/gi) || [];
      for (const rel of relEls) {
        const targetM = rel.match(/Target="([^"]+)"/i);
        if (!targetM) continue;

        // Bug fix: URL-decode paths like ../media/image%201.png
        let rawPath = targetM[1];
        try { rawPath = decodeURIComponent(rawPath); } catch (_) { /* keep raw */ }

        const ext = rawPath.split('.').pop().toLowerCase();
        const mimeType = MIME_MAP[ext];
        if (!mimeType) continue;   // skip EMF, WMF, TIFF, etc.

        let imgPath = rawPath;
        if (imgPath.startsWith('../')) imgPath = 'ppt/' + imgPath.slice(3);
        else if (!imgPath.startsWith('ppt/')) imgPath = 'ppt/slides/' + imgPath;

        if (!zip.files[imgPath]) continue;

        const dedupeKey = `${slideNum}|${imgPath}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const base64 = await zip.files[imgPath].async('base64');
        // Bug fix: skip oversized images that would freeze the browser
        if (base64.length > MAX_BASE64_LEN) {
          console.warn(`슬라이드 ${slideNum} 이미지 크기 초과 (${(base64.length / 1024 / 1024).toFixed(1)} MB) — 건너뜀`);
          continue;
        }

        images.push({
          slideNumber: slideNum,
          imageBase64: base64,
          mimeType,
          fileName: imgPath.split('/').pop(),
        });
      }
    }
  } catch (e) {
    console.warn('이미지 추출 오류:', e);
  }
  return images;
}

/* ── PDF via PDF.js ───────────────────────────── */
// R1: text-pass loop, factored out of extractPdfText so note_creation.js can
// run it against a doc it already opened itself (parallel with image render).
// Takes an already-loaded pdf.js doc; does not load/destroy/page-limit-check.
async function extractPdfTextFromDoc(pdf) {
  const numPages = pdf.numPages;
  const lines = [];
  for (let i = 1; i <= numPages; i++) {
    // Yield to the browser every 5 pages to keep the UI responsive
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    if (abortController?.signal.aborted) { pdf.destroy(); throw new DOMException('Aborted', 'AbortError'); }

    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();

    const itemsByY = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!itemsByY.has(y)) itemsByY.set(y, []);
      itemsByY.get(y).push(item);
    }

    const sortedYs = [...itemsByY.keys()].sort((a, b) => b - a);
    const pageLines = sortedYs.map(y => {
      const row = itemsByY.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
      return row.map(it => it.str).join(' ').trim();
    }).filter(l => l.length > 0);

    if (pageLines.length > 0) {
      lines.push(`[페이지 ${i}]`);
      lines.push(pageLines.join('\n'));
      lines.push('');
    }
  }

  return lines.join('\n').trim() || 'PDF에서 텍스트를 추출할 수 없습니다.';
}

async function extractPdfText(file) {
  const pdfjs = await getPdfjsLib();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  if (numPages > MAX_PDF_PAGES) {
    pdf.destroy();
    throw Object.assign(new Error(`PDF가 ${numPages}페이지입니다. 최대 ${MAX_PDF_PAGES}페이지까지 처리할 수 있습니다.`), { name: 'PageLimitError' });
  }
  if (numPages > WARN_PDF_PAGES) {
    showToast(`📄 PDF가 ${numPages}페이지입니다. 처리 시간이 길어질 수 있습니다.`);
  }

  const result = await extractPdfTextFromDoc(pdf);
  pdf.destroy();
  return result;
}

/* ── PDF page image extraction ────────────────── */
// ponytail: FileReader is the only way to turn a Blob into a base64 string in
// the browser without pulling in a dependency — no Buffer here.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// R1: image-render loop, factored out of extractPdfPageImages so note_creation.js
// can run it in the background, in parallel with the AI text pipeline, against
// a doc it already opened itself. 3-way concurrency pool + adaptive render scale
// (drops to 1.25 past 40 pages) + async OffscreenCanvas encode where available —
// all just to cut wall-clock on the previously-serial synchronous-canvas render.
async function extractPdfPageImagesFromDoc(pdf, opts = {}) {
  const { onProgress, ownsDoc = true } = opts;
  const total = pdf.numPages;
  const scale = total > 40 ? 1.25 : 1.5;
  const images = new Array(total);
  let nextPage  = 1;
  let doneCount = 0;

  async function worker() {
    while (nextPage <= total) {
      if (abortController?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = nextPage++;
      if (i > total) return;

      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      let imageBase64;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(viewport.width, viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        imageBase64 = await blobToBase64(blob);
      } else {
        const canvas   = document.createElement('canvas');
        canvas.width   = viewport.width;
        canvas.height  = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        imageBase64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      }

      images[i - 1] = { slideNumber: i, imageBase64, mimeType: 'image/jpeg' };
      doneCount++;
      onProgress?.(doneCount, total);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  } catch (e) {
    if (ownsDoc) pdf.destroy();
    throw e;
  }

  if (ownsDoc) pdf.destroy();
  return images;
}

async function extractPdfPageImages(file) {
  let images = [];
  try {
    const pdfjs = await getPdfjsLib();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

    if (pdf.numPages > MAX_PDF_PAGES) {
      pdf.destroy();
      throw Object.assign(new Error(`PDF가 ${pdf.numPages}페이지입니다. 최대 ${MAX_PDF_PAGES}페이지까지 처리할 수 있습니다.`), { name: 'PageLimitError' });
    }
    if (pdf.numPages > WARN_PDF_PAGES) {
      showToast(`📄 PDF가 ${pdf.numPages}페이지입니다. 처리 시간이 길어질 수 있습니다.`);
    }

    images = await extractPdfPageImagesFromDoc(pdf);
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'PageLimitError') throw e;
    console.warn('PDF 페이지 이미지 추출 오류:', e);
  }
  return images;
}

/* ── U8: standalone image upload → text transcription via Claude vision ──
   Competitor feature parity: users can upload photos of slides/handwritten
   notes directly (no deck required). Each image is transcribed and wrapped
   in a [페이지 N] header so the existing pipeline/chunking/cite-chip
   machinery — which already matches /\[(?:슬라이드|페이지) (\d+)\]/ — works
   unchanged. Single-note only; see note_creation.js. */
const IMAGE_VISION_BATCH_SIZE = 4;   // images per vision call, matches image_gallery.js content-array style

// ponytail: HEIC decodes natively in Safari but throws in Chrome/Firefox —
// lazy-load the tiny converter only on first HEIC failure, cached after that
// (no CSP restrictions here, same pattern as the jsDelivr lucide-icons load).
let _heic2anyLoad = null;
function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (_heic2anyLoad) return _heic2anyLoad;
  _heic2anyLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => reject(new Error('HEIC 변환 도구 로드 실패'));
    document.head.appendChild(script);
  });
  return _heic2anyLoad;
}

/* Downscale to Anthropic's ~1568px long-edge sweet spot before base64 —
   uploaded phone photos can be several MB / 4000px+ otherwise. */
async function downscaleImageForVision(file, maxEdge = 1568) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    // HEIC (iPhone photos): createImageBitmap fails outside Safari — convert
    // to JPEG via heic2any and retry once. Any other failure (or a failed
    // conversion) rethrows and the caller's per-image salvage handles it.
    if (!file.name.toLowerCase().endsWith('.heic')) throw e;
    const heic2any = await loadHeic2Any();
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
    bitmap = await createImageBitmap(Array.isArray(converted) ? converted[0] : converted);
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const dataURL = canvas.toDataURL('image/jpeg', 0.85);
    return { mimeType: 'image/jpeg', base64: dataURL.split(',')[1] };
  } finally {
    bitmap.close?.();
  }
}

/* items: [{mimeType, base64, pageNum}, ...] (≤ IMAGE_VISION_BATCH_SIZE).
   Same /api/claude fetch shape as image_gallery.js's analyzeImagesWithVision
   (model/idToken/feature:'vision'), reused here for transcription instead
   of slide description. */
async function transcribeImageBatch(items) {
  const content = [];
  items.forEach((it, i) => {
    content.push({ type: 'text', text: `[이미지 ${i + 1} — 페이지 ${it.pageNum}]` });
    content.push({ type: 'image', source: { type: 'base64', media_type: it.mimeType, data: it.base64 } });
  });
  const headerLines = items.map((it, i) => `이미지 ${i + 1}은 [페이지 ${it.pageNum}] 헤더로 시작하세요.`).join('\n');
  content.push({
    type: 'text',
    text: `각 이미지의 모든 텍스트·수식·필기 내용을 순서대로 전사하세요.\n${headerLines}\n표는 마크다운 표로, 수식은 텍스트로 표현하세요. 설명·해석은 넣지 말고 내용만 전사하세요.`,
  });

  let idToken = null;
  try { idToken = await firebase.auth().currentUser?.getIdToken(); } catch (_) {}
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: abortController?.signal,
    // ponytail: haiku — this is transcription, not reasoning; sonnet would only add cost.
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content }], idToken, isFirstCall: false, feature: 'vision' }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `이미지 인식 API 오류 (${res.status})`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

/* Transcribes `files` (in selection order = page order) into a single
   [페이지 N]-marked pptText string, plus the `imgs` array shape
   renderImageGallery expects (same shape extractPptxImages/extractPdfPageImages
   produce) so cite chips + the slide overlay work unchanged.
   Per-image failure salvages a placeholder and continues; only throws if
   every single image failed. AbortError always propagates immediately. */
async function extractImagesText(files) {
  const downscaled = [];
  for (const file of files) {
    try {
      downscaled.push({ file, ...(await downscaleImageForVision(file)) });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      debugLog('IMG', `downscale failed for ${file.name}: ${e.message}`);
      downscaled.push({ file, mimeType: null, base64: null });
    }
  }

  const imgs = downscaled.map((d, i) => ({
    slideNumber: i + 1,
    imageBase64: d.base64 || '',
    mimeType: d.mimeType || 'image/jpeg',
    fileName: d.file.name,
  }));

  const blocks = [];

  for (let start = 0; start < downscaled.length; start += IMAGE_VISION_BATCH_SIZE) {
    const slice = downscaled.slice(start, start + IMAGE_VISION_BATCH_SIZE)
      .map((d, i) => ({ ...d, pageNum: start + i + 1 }));
    const usable = slice.filter(d => d.base64);
    const sliceBlocks = slice.filter(d => !d.base64)
      .map(d => ({ pageNum: d.pageNum, text: `[페이지 ${d.pageNum}]\n(이미지 인식 실패)` }));

    if (usable.length) {
      try {
        const text = await transcribeImageBatch(usable);
        sliceBlocks.push({ pageNum: usable[0].pageNum, text: text.trim() });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        debugLog('IMG', `vision batch failed at page ${usable[0].pageNum}: ${e.message}`);
        usable.forEach(d => sliceBlocks.push({ pageNum: d.pageNum, text: `[페이지 ${d.pageNum}]\n(이미지 인식 실패)` }));
      }
    }

    sliceBlocks.sort((a, b) => a.pageNum - b.pageNum);
    blocks.push(...sliceBlocks.map(b => b.text));
  }

  const failCount = blocks.filter(b => b.includes('(이미지 인식 실패)')).length;
  if (failCount === downscaled.length) {
    throw new Error('모든 이미지 인식에 실패했습니다.');
  }

  return { pptText: blocks.join('\n\n'), imgs };
}

/* ═══════════════════════════════════════════════
   Speaker separation (client-side)
   Supports two transcript formats:
   - Clova STT:  "[hh:mm:ss] 참석자 N: text"
   - AssemblyAI: "발화자 N: text"   (server already remaps so dominant speaker = 1)
═══════════════════════════════════════════════ */
function separateSpeakers(rawText, professorNum) {
  // Match either "참석자 N:" or "발화자 N:" with optional [timestamp] prefix.
  const speakerRe = /^(?:\[[\d:]+\]\s*)?(?:참석자|발화자)\s*(\d+)\s*:/;
  const lines = rawText.split('\n');

  const speakers = new Set();
  for (const line of lines) {
    const m = line.match(speakerRe);
    if (m) speakers.add(parseInt(m[1]));
  }

  if (speakers.size <= 1) {
    const nonEmpty = lines.filter(l => l.trim()).length;
    return {
      text: rawText,
      totalLines: nonEmpty,
      professorLines: nonEmpty,
      speakerCount: speakers.size,
      allSpeakers: [...speakers].sort((a,b) => a - b),
      skipped: true,
      professorNum,
    };
  }

  const profLines = lines.filter(line => {
    const stripped = line.replace(/^\[[\d:]+\]\s*/, '');
    return stripped.startsWith(`참석자 ${professorNum}:`)
        || stripped.startsWith(`발화자 ${professorNum}:`);
  });

  const extractedText = profLines
    .map(line => line.replace(/^\[[\d:]+\]\s*/, '').replace(/^(?:참석자|발화자)\s*\d+\s*:\s*/, '').trim())
    .filter(t => t.length > 0)
    .join('\n');

  const totalLabeled = lines.filter(l => speakerRe.test(l)).length;

  return {
    text: extractedText,
    totalLines: totalLabeled,
    professorLines: profLines.length,
    speakerCount: speakers.size,
    allSpeakers: [...speakers].sort((a,b) => a - b),
    skipped: false,
    professorNum,
  };
}
