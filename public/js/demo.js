// Logged-out live demo. The landing page opens the real #splitViewer with a
// static OpenStax fixture, so every feature that needs zero server calls —
// notes, source text, accordion, page-cite chips, p.N jumps, the slide panel,
// thumbnails, drag-select, PDF export, Notion copy — runs for real.
//
// Quiz / classify / ask are deliberately NOT wired: they ARE the LLM round
// trip. A pre-baked result would re-create exactly the fake this round exists
// to remove, so the tabs stay visible and answer with a login CTA.
window.nyDemoActive = false;

async function openNotyxDemo() {
  let d;
  try {
    d = await (await fetch('/demo/demo.json')).json();
  } catch (e) {
    showToast('데모를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
    return;
  }

  // Assign the product's own globals — the viewer reads these, so nothing
  // is special-cased downstream.
  storedNotesText = d.notesText;
  storedFilteredText = d.sourceText;
  storedHighlightedTranscript = '';
  storedPptText = d.pptText;
  currentNoteId = null;
  recommendedSlides = [];
  extractedImages = d.slides.map(s => ({ slideNumber: s.slideNumber, imageBase64: s.src, mimeType: 'url' }));

  document.getElementById('finalNotesBody').innerHTML = renderMarkdown(d.notesText);

  const titleEl = document.getElementById('notesCardTitle');
  if (titleEl) titleEl.textContent = d.title;

  // Quiz/classify tabs ship `disabled` in the markup and a disabled button
  // fires no click, so the CTA would be unreachable. Enable just these two.
  ['quizBtn', 'classifyBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = false;
  });

  window.nyDemoActive = true;
  await openSplitViewer();

  // CC BY 4.0 requires attribution wherever the work is shown, and this
  // overlay covers the landing credit. Built from the fixture's own source
  // block so the two can never drift.
  const slidesEl = document.getElementById('splitSlides');
  if (slidesEl && d.source) {
    const credit = document.createElement('p');
    credit.className = 'ny-demo-credit';
    credit.textContent = `${d.source.work} — ${d.source.license}`;
    const link = document.createElement('a');
    link.href = d.source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '원본';
    credit.append(' ', link);
    slidesEl.prepend(credit);
  }

  switchSplitTab('notes');
}

function closeNotyxDemo() {
  const splitViewer = document.getElementById('splitViewer');
  if (splitViewer) splitViewer.style.display = 'none';
  document.body.style.overflow = '';
  window.nyDemoActive = false;

  // Clear what was injected
  storedNotesText = '';
  storedFilteredText = '';
  storedPptText = '';
  extractedImages = [];

  ['quizBtn', 'classifyBtn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = true;
  });
  // MUST NOT call switchView(...) — the logged-out visitor has no app shell.
}

function renderDemoLoginCta(tab) {
  const paneId = tab === 'quiz' ? 'quizInlineArea' : tab === 'classify' ? 'classifyArea' : 'splitAsk';
  const pane = document.getElementById(paneId);
  if (!pane) return;

  const label = tab === 'quiz' ? '퀴즈는' : tab === 'classify' ? '분류는' : '질문은';

  const wrap = document.createElement('div');
  wrap.className = 'ny-demo-cta';

  const p1 = document.createElement('p');
  p1.textContent = `${label} 로그인 후에 사용할 수 있어요.`;
  const p2 = document.createElement('p');
  p2.textContent = '이 세 가지는 AI가 그 자리에서 생성하는 기능이라 미리 만들어 둘 수 없습니다.';

  const btn = document.createElement('button');
  btn.className = 'ny-btn ny-btn-primary';
  btn.type = 'button';
  btn.textContent = 'Google로 로그인하고 사용하기';
  btn.onclick = async () => {
    const user = await loginWithGoogle();
    if (user) closeNotyxDemo();
  };

  wrap.append(p1, p2, btn);

  pane.innerHTML = '';
  pane.appendChild(wrap);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('nyDemoOpenBtn')?.addEventListener('click', openNotyxDemo);
});
