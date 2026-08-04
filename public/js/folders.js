// Folder manager: create, rename, delete folders; modal UI.
// Depends on: constants.js (FOLDER_COLORS, _activeFolderId), firestore_sync.js (getAllFoldersFS, saveFolderFS, renameFolderFS, deleteFolderFS), ui.js (showToast), markdown.js (escHtml), notes_crud.js (fmtDate), home_view.js (renderHomeView).

/* ═══════════════════════════════════════════════
   U14: shared folder-select builder
   ────────────────────────────────────────────────
   Note-creation flows (single-mode promptNoteName modal, multi-mode batch
   staging select + per-queue-item selects) all need the same "📂 미분류 +
   one option per folder" list so a note can be filed into a folder right
   when it's created instead of always landing in 미분류 and requiring a
   later move. This returns <option> markup only — callers wrap their own
   <select id/class/data-*> since each site needs different attributes.
═══════════════════════════════════════════════ */
function buildFolderSelectOptions(folders, selectedId) {
  const sel = selectedId || '';
  const opts = [{ id: '', name: '📂 미분류' }, ...(folders || [])];
  return opts.map(f =>
    `<option value="${escHtml(f.id || '')}"${(f.id || '') === sel ? ' selected' : ''}>${escHtml(f.name)}</option>`
  ).join('');
}

async function showFolderManager() {
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  overlay.id = 'folderManagerOverlay';
  overlay.innerHTML = `
    <div class="db-modal">
      <h3 style="display:flex;align-items:center;gap:0.4rem;"><i data-lucide="folder-cog" class="icon-sm" style="color:var(--primary);"></i><span>폴더 관리</span></h3>
      <div class="db-modal-list" id="folderManagerList"></div>
      <div class="db-modal-footer">
        <input id="newFolderInput" type="text" placeholder="새 폴더 이름..." />
        <button onclick="createFolderFromInput()">만들기</button>
        <button onclick="document.getElementById('folderManagerOverlay').remove()">닫기</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await refreshFolderManagerList();
}

async function refreshFolderManagerList() {
  const listEl = document.getElementById('folderManagerList');
  if (!listEl) return;
  const folders = await getAllFoldersFS();
  listEl.innerHTML = '';
  if (!folders.length) {
    listEl.innerHTML = '<div style="font-size:0.82rem; color:var(--text-muted); padding:0.5rem;">폴더가 없습니다.</div>';
    return;
  }
  for (const folder of folders) {
    const row = document.createElement('div');
    row.className = 'db-modal-row';
    row.dataset.folderId = folder.id;

    // Use a color dot + name (matching the sidebar/home-view style) instead
    // of a generic 📁 emoji. Falls back to neutral if folder has no color.
    const label = document.createElement('span');
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.4rem';
    const dotColor = folder.color || 'var(--text-muted)';
    label.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escHtml(dotColor)};flex-shrink:0;"></span><span>${escHtml(folder.name)}</span>`;

    const actions = document.createElement('div');
    actions.className = 'db-modal-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.title = '이름 변경';
    renameBtn.setAttribute('aria-label', '이름 변경');
    renameBtn.innerHTML = '<i data-lucide="pencil" class="icon-sm"></i>';
    renameBtn.addEventListener('click', () => enterFolderEditMode(row, folder));

    const deleteBtn = document.createElement('button');
    deleteBtn.title = '삭제';
    deleteBtn.setAttribute('aria-label', '삭제');
    deleteBtn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i>';
    // Inline two-step confirm (replaces the appConfirm modal, which a browser
    // extension with max z-index was painting over so it never showed and its
    // OK click never landed). First click arms the button (red, "삭제?");
    // a second click within 3s deletes; otherwise it auto-resets. Arming any
    // row's button resets every other armed button so only one is live.
    let _delTimer = null;
    deleteBtn.addEventListener('click', () => {
      if (deleteBtn.classList.contains('confirm-delete')) {
        clearTimeout(_delTimer);
        deleteFolderNow(folder.id);
      } else {
        listEl.querySelectorAll('button.confirm-delete').forEach(resetFolderDeleteBtn);
        deleteBtn.classList.add('confirm-delete');
        deleteBtn.textContent = '삭제?';
        _delTimer = setTimeout(() => resetFolderDeleteBtn(deleteBtn), 3000);
      }
    });

    actions.append(renameBtn, deleteBtn);
    row.append(label, actions);
    listEl.appendChild(row);
  }
}

async function createFolderFromInput() {
  const input = document.getElementById('newFolderInput');
  const name  = input?.value.trim();
  if (!name) return;
  // R4: visible-error parity with delete/rename so all folder mutations
  // toast on failure instead of swallowing the throw.
  try {
    await saveFolderFS({ name });
    input.value = '';
  } catch (e) {
    console.error('[createFolderFromInput] failed:', e);
    showToast('❌ 폴더 생성 실패: ' + (e.message || '알 수 없는 오류'));
    return;
  }
  await refreshFolderManagerList().catch(err => console.warn('[createFolderFromInput] refresh failed:', err));
  renderHomeView();
}

function renameFolderPrompt(id, currentName, currentColor) {
  showFolderEditModal(id, currentName, currentColor);
}

function showFolderEditModal(id, currentName = '', currentColor = null) {
  const chosenColorRef = { value: currentColor || FOLDER_COLORS[0].value };
  // R3/R5: when editing an existing folder, look up name, color, and the
  // existing lectureCode so every field pre-fills with what the user
  // already chose. Earlier the lookup only handled lectureCode, which
  // meant any future entry point that calls showFolderEditModal(id)
  // without passing currentName/currentColor opened with an empty input
  // (e.g. window.renameFolderPrompt(id) from console).
  let initialLectureCode = '';
  if (id) {
    getAllFoldersFS().then(folders => {
      const f = folders.find(x => x.id === id);
      if (!f) return;
      const nameInput = overlay.querySelector('.folderEditNameInput');
      if (!currentName && nameInput && !nameInput.value) nameInput.value = f.name || '';
      if (!currentColor && f.color) {
        chosenColorRef.value = f.color;
        overlay.querySelectorAll('.folder-color-option').forEach(d => {
          d.classList.toggle('selected', d.dataset.color === f.color);
        });
      }
      const lectureInput = overlay.querySelector('.folderEditLectureInput');
      if (f.lectureCode && lectureInput && !lectureInput.value) lectureInput.value = f.lectureCode;
    }).catch(() => {});
  }
  const overlay = document.createElement('div');
  overlay.className = 'db-modal-overlay';
  const colorDots = FOLDER_COLORS.map(c =>
    `<span class="folder-color-option${c.value === chosenColorRef.value ? ' selected' : ''}" data-color="${escHtml(c.value)}" style="background:${c.value}" title="${escHtml(c.name)}"></span>`
  ).join('');
  overlay.innerHTML = `
    <div class="db-modal">
      <h3 style="margin-bottom:1rem; font-size:1rem; display:flex; align-items:center; gap:0.4rem;"><i data-lucide="${id ? 'folder-pen' : 'folder-plus'}" class="icon-sm" style="color:var(--primary);"></i><span>${id ? '폴더 편집' : '새 폴더'}</span></h3>
      <div style="margin-bottom:0.8rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">폴더 이름</label>
        <input class="folderEditNameInput" value="${escHtml(currentName)}" placeholder="폴더 이름..."
          style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
      </div>
      <div style="margin-bottom:0.8rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.3rem;">스터디 룸 초대 코드 (선택)</label>
        <input class="folderEditLectureInput" value="${escHtml(initialLectureCode)}" placeholder="예: PSYC301, 산심2026" maxlength="20"
          style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface2); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.25rem;">같은 코드의 스터디 룸에 이 폴더 노트 학습 활동이 공유됩니다 (시간/노트수만, 내용 X)</div>
      </div>
      <div style="margin-bottom:1rem;">
        <label style="font-size:0.78rem; font-weight:600; color:var(--text-muted); display:block; margin-bottom:0.4rem;">색상</label>
        <div class="folder-color-picker">${colorDots}</div>
      </div>
      <div class="db-modal-footer">
        <button onclick="this.closest('.db-modal-overlay').remove()">취소</button>
        <button class="folderEditConfirmBtn" style="background:var(--primary); color:var(--bg); border:none; border-radius:6px; padding:0.4rem 1rem; cursor:pointer; font-size:0.85rem;">저장</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.folder-color-option').forEach(dot => {
    dot.addEventListener('click', () => {
      overlay.querySelectorAll('.folder-color-option').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      chosenColorRef.value = dot.dataset.color;
    });
  });

  const nameInput = overlay.querySelector('.folderEditNameInput');
  const lectureInput = overlay.querySelector('.folderEditLectureInput');
  setTimeout(() => nameInput.focus(), 50);

  const doSave = async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('폴더 이름을 입력하세요.'); return; }
    // R3: lectureCode is optional. Empty string = clear / no linking.
    // renameFolderFS + saveFolderFS persist `null` to make later reads
    // unambiguous (vs "field missing entirely").
    const lectureCode = (lectureInput?.value || '').trim() || null;
    try {
      if (id) {
        await renameFolderFS(id, name, chosenColorRef.value, lectureCode);
      } else {
        await saveFolderFS({ name, color: chosenColorRef.value, lectureCode });
      }
      overlay.remove();
      await refreshFolderManagerList().catch(err => console.warn('[doSave] refresh failed:', err));
      renderHomeView();
    } catch(e) {
      // R4: also log to console so the user can hand the stack to a developer
      // if the toast message is too terse to diagnose.
      console.error('[showFolderEditModal/doSave] failed:', e);
      showToast(`❌ ${e.message || '알 수 없는 오류'}`);
    }
  };
  overlay.querySelector('.folderEditConfirmBtn').addEventListener('click', doSave);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  lectureInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
}

// Inline folder edit (replaces the showFolderEditModal popup for renaming an
// existing folder — that modal was painted over by an extension at max
// z-index). Expands the row in place into name + invite-code + color picker
// + save/cancel. The "new folder" path still uses createFolderFromInput,
// which lives inside the folder-manager modal and isn't covered by the bug.
function enterFolderEditMode(row, folder) {
  const chosen = { value: folder.color || FOLDER_COLORS[0].value };
  const colorDots = FOLDER_COLORS.map(c =>
    `<span class="folder-color-option${c.value === chosen.value ? ' selected' : ''}" data-color="${escHtml(c.value)}" style="background:${c.value}" title="${escHtml(c.name)}"></span>`
  ).join('');
  row.style.alignItems = 'stretch';
  row.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:0.5rem; width:100%;">
      <input class="folderRowNameInput" value="${escHtml(folder.name || '')}" placeholder="폴더 이름..."
        style="width:100%; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); font-size:0.85rem; box-sizing:border-box;" />
      <input class="folderRowLectureInput" value="${escHtml(folder.lectureCode || '')}" placeholder="스터디룸 초대 코드 (선택)" maxlength="20"
        style="width:100%; padding:0.35rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); font-size:0.78rem; box-sizing:border-box;" />
      <div class="folder-color-picker" style="display:flex; gap:0.3rem; flex-wrap:wrap;">${colorDots}</div>
      <div style="display:flex; gap:0.4rem; justify-content:flex-end;">
        <button class="folderRowCancel" style="background:var(--surface3); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:0.3rem 0.8rem; cursor:pointer; font-size:0.8rem;">취소</button>
        <button class="folderRowSave" style="background:var(--primary); color:var(--bg); border:none; border-radius:6px; padding:0.3rem 0.8rem; cursor:pointer; font-size:0.8rem;">저장</button>
      </div>
    </div>`;
  row.querySelectorAll('.folder-color-option').forEach(dot => {
    dot.addEventListener('click', () => {
      row.querySelectorAll('.folder-color-option').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      chosen.value = dot.dataset.color;
    });
  });
  const nameInput = row.querySelector('.folderRowNameInput');
  const lectureInput = row.querySelector('.folderRowLectureInput');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
  const cancel = () => { refreshFolderManagerList().catch(() => {}); };
  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('폴더 이름을 입력하세요.'); nameInput.focus(); return; }
    const lectureCode = (lectureInput.value || '').trim() || null;
    try {
      await renameFolderFS(folder.id, name, chosen.value, lectureCode);
    } catch (e) {
      console.error('[enterFolderEditMode/save] failed:', e);
      showToast('❌ 이름 변경 실패: ' + (e.message || '알 수 없는 오류'));
      return;
    }
    await refreshFolderManagerList().catch(() => {});
    renderHomeView();
  };
  row.querySelector('.folderRowSave').addEventListener('click', save);
  row.querySelector('.folderRowCancel').addEventListener('click', cancel);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') cancel(); });
  lectureInput.addEventListener('keydown', e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') cancel(); });
}

// Resets an armed inline-delete button back to its trash-icon state.
function resetFolderDeleteBtn(btn) {
  btn.classList.remove('confirm-delete');
  btn.innerHTML = '<i data-lucide="trash-2" class="icon-sm"></i>';
  if (window.lucide && typeof lucide.createIcons === 'function') {
    try { lucide.createIcons(); } catch (e) {}
  }
}

// Performs the actual folder delete. Confirmation is handled inline by the
// two-step delete button in refreshFolderManagerList (the old appConfirm
// modal was unusable because an extension painted over it). Folder delete is
// low-risk: notes are reparented to "uncategorized", never destroyed.
async function deleteFolderNow(id) {
  let ok = true;
  try {
    await deleteFolderFS(id);
  } catch (e) {
    ok = false;
    console.error('[deleteFolderNow] failed:', e);
    showToast('❌ 폴더 삭제 실패: ' + (e.message || '알 수 없는 오류') + ' (콘솔 확인)');
  }
  await refreshFolderManagerList().catch(err => console.warn('[deleteFolderNow] refresh failed:', err));
  // If viewing the deleted folder, return to home
  if (_activeFolderId === id) _activeFolderId = null;
  renderHomeView();
  if (ok) showToast('🗑️ 폴더 삭제됨 (노트는 미분류로 이동)');
}
