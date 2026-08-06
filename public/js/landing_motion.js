// public/js/landing_motion.js
//
// Landing-only entrance motion (decision record 2026-08-06). Everywhere else
// in this app has zero motion — system.css has no transition/animation rule
// outside this file's target list. #landingView is the single exception,
// and this file is the only place that owns it: no CSS keyframes, no other
// JS file touches opacity/transform on these elements.
//
// Not an ES module — this repo has no build step. <script defer src> load
// order is the contract; this file is a plain IIFE exposing
// window.nyLandingMotion = { start, stop }.

(function () {
  'use strict';

  var started = false;
  var triggers = [];
  var tweens = [];
  var runId = 0; // stop() can land before the start() rAF callback fires; the rAF checks this to bail out.

  var SELECTOR = [
    '#landingView .ny-hero-title',
    '#landingView .ny-hero-sub',
    '#landingView .ny-hero-cta',
    '#landingView .ny-hero-note',
    '#landingView .ny-section-head > *',
    '#landingView .ny-preview',
    '#landingView .ny-list-check > li',
    '#landingView .ny-grid-cards > .ny-card',
    '#landingView .ny-stack > .ny-feature',
    '#landingView .ny-closing-title',
    '#landingView .ny-closing-note'
  ].join(',\n    ');

  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    var rise = parseFloat(cs.getPropertyValue('--ny-motion-rise'));
    var dur = parseFloat(cs.getPropertyValue('--ny-motion-dur')) / 1000;
    var stagger = parseFloat(cs.getPropertyValue('--ny-motion-stagger')) / 1000;
    var ease = cs.getPropertyValue('--ny-motion-ease').trim();
    var hlDur = parseFloat(cs.getPropertyValue('--ny-motion-hl-dur')) / 1000;
    var hlDelay = parseFloat(cs.getPropertyValue('--ny-motion-hl-delay')) / 1000;

    if (
      isNaN(rise) || isNaN(dur) || isNaN(stagger) ||
      isNaN(hlDur) || isNaN(hlDelay) || !ease
    ) {
      console.warn('[landing_motion] motion tokens missing/unparsable — skipping motion entirely');
      return null;
    }
    return { rise: rise, dur: dur, stagger: stagger, ease: ease, hlDur: hlDur, hlDelay: hlDelay };
  }

  function isPast(el) {
    var r = el.getBoundingClientRect();
    return r.bottom <= 0 || r.top >= (window.innerHeight || 0);
  }

  // Already scrolled past = above the viewport. start() must not use isPast():
  // that also matches "entirely below the viewport", which is every element
  // waiting to be scrolled to, and finalizing those kills the entrance motion.
  function isAbove(el) {
    return el.getBoundingClientRect().bottom <= 0;
  }

  function finalize(el) {
    if (el.getAttribute('data-state') === 'pending' && window.gsap) {
      gsap.set(el, { opacity: 1, y: 0, clearProps: 'opacity,transform' });
    }
    el.setAttribute('data-state', 'revealed');
  }

  function drawHighlight(tokens) {
    var mark = document.querySelector('#landingView .ny-hero-title .ny-hl');
    if (!mark) return;
    if (mark.getClientRects().length !== 1) return;

    var wash = document.createElement('span');
    wash.className = 'ny-hl-wash';
    wash.setAttribute('aria-hidden', 'true');
    mark.appendChild(wash);
    mark.classList.add('ny-hl-draw');

    tweens.push(gsap.to(wash, {
      scaleX: 1,
      duration: tokens.hlDur,
      delay: tokens.hlDelay,
      ease: tokens.ease
    }));
  }

  function revealBatch(tokens, els) {
    var live = [];
    for (var i = 0; i < els.length; i++) {
      if (isPast(els[i])) {
        finalize(els[i]);
      } else {
        live.push(els[i]);
      }
    }
    if (live.length === 0) return;

    tweens.push(gsap.to(live, {
      opacity: 1,
      y: 0,
      duration: tokens.dur,
      ease: tokens.ease,
      stagger: tokens.stagger,
      overwrite: true,
      onStart: function () {
        for (var i = 0; i < live.length; i++) {
          live[i].setAttribute('data-state', 'revealed');
        }
      },
      onComplete: function () {
        for (var i = 0; i < live.length; i++) {
          gsap.set(live[i], { clearProps: 'opacity,transform' });
        }
      }
    }));
  }

  function start() {
    if (started) return;

    if (!window.gsap || !window.ScrollTrigger) {
      console.warn('[landing_motion] GSAP/ScrollTrigger not loaded — landing stays fully static');
      return;
    }

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    var tokens = readTokens();
    if (!tokens) return;

    gsap.registerPlugin(ScrollTrigger);

    var myRun = ++runId;

    requestAnimationFrame(function () {
      if (myRun !== runId) return;

      var els = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
      var hidden = [];

      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (isAbove(el)) {
          finalize(el);
        } else {
          el.setAttribute('data-state', 'pending');
          hidden.push(el);
        }
      }

      if (hidden.length) {
        gsap.set(hidden, { opacity: 0, y: tokens.rise });
        triggers = ScrollTrigger.batch(hidden, {
          start: 'top 85%',
          once: true,
          interval: 0.06,
          onEnter: function (batchEls) { revealBatch(tokens, batchEls); }
        });
      }

      drawHighlight(tokens);

      ScrollTrigger.refresh();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
      }
    });

    started = true;
  }

  function stop() {
    runId++;

    if (!window.gsap) {
      started = false;
      return;
    }

    for (var i = 0; i < triggers.length; i++) {
      triggers[i].kill();
    }
    triggers = [];

    for (var j = 0; j < tweens.length; j++) {
      tweens[j].kill();
    }
    tweens = [];

    var pending = document.querySelectorAll('#landingView [data-state]');
    for (var k = 0; k < pending.length; k++) {
      gsap.set(pending[k], { clearProps: 'opacity,transform' });
      pending[k].removeAttribute('data-state');
    }

    var wash = document.querySelector('#landingView .ny-hl-wash');
    if (wash) wash.remove();
    var mark = document.querySelector('#landingView .ny-hero-title .ny-hl');
    if (mark) mark.classList.remove('ny-hl-draw');

    started = false;
  }

  window.nyLandingMotion = { start: start, stop: stop };
})();
