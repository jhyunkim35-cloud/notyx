// First-visit guided tour (R4) — lightweight coachmarks for new users.
//
// Spotlights the core actions on the home view the first time a logged-in
// user lands on an EMPTY home (new-account heuristic — never nags returning
// users who already have notes). Shown once per user via a localStorage flag.
//
// Robustness: every step resolves its target at runtime and is silently
// skipped if the element is missing or not actually inside the viewport
// (e.g. a collapsed mobile sidebar drawer). So a missing element can never
// strand the user on a spotlight pointing at nothing.
//
// Re-runnable any time via window.startNotyxTour() (e.g. a future "사용법
// 다시 보기" entry).

(function () {
  'use strict';

  const FLAG = 'notyx_tour_v1_seen';

  const STEPS = [
    { sel: '#emptyHomeNewBtn',     title: '✨ 노트 만들기',  body: '강의 PPT·PDF랑 녹음을 올리면 AI가 학습노트랑 퀴즈를 만들어줘요. 여기서 시작해요.' },
    { sel: '#homeRecordSection',   title: '🎙️ 강의 녹음',   body: '강의를 실시간으로 녹음하거나, 가지고 있는 오디오 파일을 올릴 수도 있어요.' },
    { sel: '#sidebarFolders',      title: '📁 과목 정리',    body: '폴더를 만들어 과목별로 노트를 정리할 수 있어요.' },
    { sel: '#bugReportSidebarBtn', title: '🐛 문제 신고',    body: '막히거나 이상한 게 있으면 여기로 알려주세요. 바로 확인해서 고칠게요.' },
  ];

  const Z = 2147483600; // just under the absolute max so app modals stay below

  let _running = false;

  function seen() { try { return localStorage.getItem(FLAG) === '1'; } catch (_) { return false; } }
  function markSeen() { try { localStorage.setItem(FLAG, '1'); } catch (_) {} }

  // Visible AND at least partially inside the viewport (off-canvas drawers fail this).
  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) return false;
    return true;
  }

  function el(tag, css, html) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function start() {
    if (_running) return;
    const steps = STEPS.filter(s => isVisible(document.querySelector(s.sel)));
    if (!steps.length) { markSeen(); return; }
    _running = true;

    let i = 0;

    // Transparent backdrop blocks app interaction; the spotlight's huge
    // box-shadow does the actual dimming so the target stays bright.
    const backdrop = el('div', `position:fixed;inset:0;z-index:${Z};background:transparent;`);
    const spot = el('div', `position:fixed;z-index:${Z + 1};border-radius:10px;pointer-events:none;` +
      `box-shadow:0 0 0 9999px rgba(15,23,42,0.62);transition:left .25s,top .25s,width .25s,height .25s;`);
    const tip = el('div',
      `position:fixed;z-index:${Z + 2};max-width:min(320px,90vw);box-sizing:border-box;` +
      `background:var(--surface,#fff);color:var(--text,#0f172a);border-radius:12px;padding:16px 18px;` +
      `box-shadow:0 16px 48px rgba(0,0,0,0.28);font-family:inherit;line-height:1.5;`);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { /* ignore stray backdrop clicks */ } });
    document.body.appendChild(backdrop);
    document.body.appendChild(spot);
    document.body.appendChild(tip);

    function cleanup() {
      _running = false;
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      [backdrop, spot, tip].forEach(n => { try { n.remove(); } catch (_) {} });
    }
    function finish() { cleanup(); markSeen(); }
    function next() { i++; if (i >= steps.length) finish(); else render(); }

    // Position spotlight + tooltip around the current target.
    function position() {
      const target = document.querySelector(steps[i].sel);
      if (!target || !isVisible(target)) { next(); return; }
      const r = target.getBoundingClientRect();
      const pad = 6;
      spot.style.left = (r.left - pad) + 'px';
      spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';

      // Tooltip below the target if there's room, otherwise above.
      const th = tip.offsetHeight || 140;
      const tw = tip.offsetWidth || 300;
      let top = r.bottom + 12;
      if (top + th > innerHeight - 8) top = Math.max(8, r.top - th - 12);
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(8, Math.min(left, innerWidth - tw - 8));
      tip.style.top = top + 'px';
      tip.style.left = left + 'px';
    }

    function render() {
      const step = steps[i];
      const target = document.querySelector(step.sel);
      if (!target || !isVisible(target)) { next(); return; }
      try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}

      const isLast = i === steps.length - 1;
      tip.innerHTML =
        `<div style="font-weight:700;font-size:15px;margin-bottom:6px;">${step.title}</div>` +
        `<div style="font-size:13px;color:var(--text-muted,#475569);">${step.body}</div>` +
        `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;gap:10px;">` +
          `<span style="font-size:12px;color:var(--text-muted,#94a3b8);">${i + 1} / ${steps.length}</span>` +
          `<span style="display:flex;gap:8px;">` +
            (isLast ? '' : `<button data-act="skip" style="background:transparent;border:none;color:var(--text-muted,#94a3b8);font:inherit;font-size:13px;cursor:pointer;padding:6px 8px;">건너뛰기</button>`) +
            `<button data-act="next" style="background:var(--primary);border:none;color:var(--bg);font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:7px 16px;border-radius:8px;">${isLast ? '시작하기' : '다음'}</button>` +
          `</span>` +
        `</div>`;
      tip.querySelector('[data-act="next"]').addEventListener('click', next);
      const skipBtn = tip.querySelector('[data-act="skip"]');
      if (skipBtn) skipBtn.addEventListener('click', finish);

      requestAnimationFrame(position); // measure tip after content set
    }

    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    render();
  }

  // Auto-start only for a fresh account: gate on the empty-home message being
  // visible so returning users with notes are never interrupted.
  function maybeAutoStart() {
    if (seen() || _running) return;
    const empty = document.getElementById('emptyHomeMsg');
    if (!empty || getComputedStyle(empty).display === 'none') return;
    if (!isVisible(document.querySelector(STEPS[0].sel))) return;
    start();
  }

  function arm() {
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user || seen()) return;
      // Wait for the home UI to settle (auth → render → empty-state paint).
      let tries = 0;
      const t = setInterval(function () {
        if (seen() || _running) { clearInterval(t); return; }
        const empty = document.getElementById('emptyHomeMsg');
        const ready = empty && getComputedStyle(empty).display !== 'none'
          && isVisible(document.querySelector(STEPS[0].sel));
        if (ready) { clearInterval(t); maybeAutoStart(); }
        else if (++tries > 30) clearInterval(t); // ~6s, then give up silently
      }, 200);
    });
  }

  // Manual replay ignores the seen flag.
  window.startNotyxTour = start;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm, { once: true });
  } else {
    arm();
  }
})();
