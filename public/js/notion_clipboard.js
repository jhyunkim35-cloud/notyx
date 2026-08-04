// Notion clipboard helpers: copy-to-clipboard, toggle transform, reorder modal, HTML file export.
// Depends on: constants.js (storedNotesText, currentNoteId), ui.js (showToast, showSuccessToast, triggerDownload, dateStamp), markdown.js (escHtml).

/* ═══════════════════════════════════════════════
   Notion clipboard helper
═══════════════════════════════════════════════ */
function transformToNotionToggles(htmlString) {
  const root = document.createElement('div');
  root.innerHTML = htmlString;

  function wrapSection(container) {
    const children = [...container.childNodes];
    const out = document.createElement('div');
    let i = 0;

    while (i < children.length) {
      const node = children[i];
      const tag = node.nodeName;

      if (tag === 'H1' || tag === 'HR') {
        out.appendChild(node.cloneNode(true));
        i++;
        continue;
      }

      if (tag === 'H2' || tag === 'H3') {
        const details  = document.createElement('details');
        details.open   = true;
        const summary  = document.createElement('summary');
        summary.innerHTML = node.innerHTML;
        details.appendChild(summary);

        i++;
        // Collect siblings until next heading at same or higher level, or HR, or end
        const stopTags = tag === 'H2' ? ['H1', 'H2', 'HR'] : ['H1', 'H2', 'H3', 'HR'];
        while (i < children.length && !stopTags.includes(children[i].nodeName)) {
          details.appendChild(children[i].cloneNode(true));
          i++;
        }

        // Recursively handle nested H3s inside an H2 block
        if (tag === 'H2') {
          const inner = document.createElement('div');
          [...details.childNodes].slice(1).forEach(n => inner.appendChild(n.cloneNode(true)));
          const transformed = wrapSection(inner);
          // Replace detail content after summary with transformed content
          while (details.childNodes.length > 1) details.removeChild(details.lastChild);
          [...transformed.childNodes].forEach(n => details.appendChild(n));
        }

        out.appendChild(details);
        continue;
      }

      out.appendChild(node.cloneNode(true));
      i++;
    }
    return out;
  }

  // Unwrap .md-content wrapper so h2/h3 are direct children of the container
  const container = (root.children.length === 1 && root.children[0].classList?.contains('md-content'))
    ? root.children[0]
    : root;
  return wrapSection(container).innerHTML;
}

async function copyToNotionClipboard(htmlContent, plainText, useToggles = true) {
  const finalHtml = useToggles ? transformToNotionToggles(htmlContent) : htmlContent;
  const toastMsg  = useToggles ? '📋 토글 형식으로 복사됨' : '📋 일반 형식으로 복사됨';
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([finalHtml],  { type: 'text/html' }),
        'text/plain': new Blob([plainText],  { type: 'text/plain' }),
      })]);
    } else {
      // Fallback: contenteditable selection + execCommand
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none;';
      div.innerHTML = finalHtml;
      document.body.appendChild(div);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(div);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(div);
    }
    showToast(toastMsg + ' — 노션에 붙여넣기하세요');
  } catch(e) {
    showToast('❌ 복사 실패: ' + e.message);
  }
}

async function bulkNotionCopy() {
  if (!_selectedNoteIds.size) return;
  const ids = [..._selectedNoteIds];
  showToast(`📋 노트 불러오는 중...`);
  const notes = await Promise.all(ids.map(id => getNoteFS(id)));
  const valid = notes.filter(Boolean);
  if (!valid.length) return;
  showNotionReorderModal(valid);
}

function showNotionReorderModal(notes) {
  // orderedNotes is a mutable array that reflects the current row order
  const orderedNotes = [...notes];

  const overlay = document.createElement('div');
  overlay.id = 'notionReorderModal';
  overlay.className = 'db-modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  function buildRows() {
    list.innerHTML = '';
    orderedNotes.forEach((note, idx) => {
      const row = document.createElement('div');
      row.className = 'reorder-row';
      row.draggable = true;
      row.dataset.idx = idx;

      row.innerHTML = `
        <span class="reorder-drag-handle">☰</span>
        <span class="reorder-row-idx">${idx + 1}</span>
        <span class="reorder-row-title">${escHtml(note.title || '제목없음')}</span>
        <div class="reorder-updown">
          <button title="위로" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button title="아래로" ${idx === orderedNotes.length - 1 ? 'disabled' : ''}>▼</button>
        </div>`;

      const [upBtn, downBtn] = row.querySelectorAll('.reorder-updown button');
      upBtn.addEventListener('click', () => {
        if (idx === 0) return;
        [orderedNotes[idx - 1], orderedNotes[idx]] = [orderedNotes[idx], orderedNotes[idx - 1]];
        buildRows();
      });
      downBtn.addEventListener('click', () => {
        if (idx === orderedNotes.length - 1) return;
        [orderedNotes[idx], orderedNotes[idx + 1]] = [orderedNotes[idx + 1], orderedNotes[idx]];
        buildRows();
      });

      // Drag-and-drop reorder
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', String(idx));
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const src = parseInt(e.dataTransfer.getData('text/plain'));
        const dst = idx;
        if (isNaN(src) || src === dst) return;
        const [moved] = orderedNotes.splice(src, 1);
        orderedNotes.splice(dst, 0, moved);
        buildRows();
      });

      list.appendChild(row);
    });
  }

  overlay.innerHTML = `
    <div class="db-modal" style="max-width:520px;display:flex;flex-direction:column;max-height:85vh;">
      <h3>📋 노트 순서 지정</h3>
      <p style="font-size:0.82rem;color:var(--text-muted);margin:0;">드래그하거나 ▲▼ 버튼으로 순서를 바꾸세요. 각 노트는 노션에서 접기 가능한 토글 블록으로 붙여넣어집니다.</p>
      <div class="db-modal-list" id="notionReorderList" style="overflow-y:auto;max-height:50vh;flex:1;"></div>
      <div class="db-modal-footer">
        <button onclick="this.closest('.db-modal-overlay').remove()" style="background:var(--surface3);color:var(--text);">취소</button>
        <button id="notionReorderFileBtn" style="padding:0.5rem 1rem;border-radius:6px;border:none;background:var(--secondary);color:var(--bg);font-size:0.85rem;cursor:pointer;white-space:nowrap;">📄 파일 저장</button>
        <button id="notionReorderCopyBtn" style="padding:0.5rem 1rem;border-radius:6px;border:none;background:var(--primary);color:var(--bg);font-size:0.85rem;cursor:pointer;white-space:nowrap;">📋 클립보드 복사</button>
      </div>
    </div>`;

  const list = overlay.querySelector('#notionReorderList');
  buildRows();

  overlay.querySelector('#notionReorderFileBtn').addEventListener('click', () => {
    overlay.remove();
    generateNotionHtmlFile(orderedNotes);
  });

  overlay.querySelector('#notionReorderCopyBtn').addEventListener('click', async () => {
    overlay.remove();
    await executeNotionBulkCopy(orderedNotes);
  });

  document.body.appendChild(overlay);
}

async function executeNotionBulkCopy(orderedNotes) {
  const finalHtml = buildNotionToggleHtml(orderedNotes);
  const plainText = orderedNotes.map(n => `# ${n.title || '제목없음'}\n\n${n.notesText || ''}`).join('\n\n---\n\n');

  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([finalHtml],  { type: 'text/html' }),
        'text/plain': new Blob([plainText],  { type: 'text/plain' }),
      })]);
    } else {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none;';
      div.innerHTML = finalHtml;
      document.body.appendChild(div);
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(div);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(div);
    }
    showToast(`📋 ${orderedNotes.length}개 노트 복사됨 — 노션에 붙여넣기하세요`);
  } catch(e) {
    showToast('❌ 복사 실패: ' + e.message);
  }
}

function buildNotionToggleHtml(notes) {
  return notes.map(n => {
    const rawHtml = n.notesHtml || renderMarkdown(n.notesText || '');
    const innerHtml = transformToNotionToggles(rawHtml);
    return `<details open><summary>${escHtml(n.title || '제목없음')}</summary>${innerHtml}</details>`;
  }).join('\n');
}

function generateNotionHtmlFile(notes, filename) {
  const content = buildNotionToggleHtml(notes);
  const doc = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>노트 모음</title></head>\n<body>\n${content}\n</body></html>`;
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename || 'notes_export.html' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('📄 HTML 파일 저장됨 — 노션에서 가져오기로 열어주세요');
}
