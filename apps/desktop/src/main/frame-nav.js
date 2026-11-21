'use strict';
// Controller navigation for twitch.tv pages we don't control (the sign-in window, the channel-points/rewards panel in
// Twitch's embedded chat). Injected into the page with executeJavaScript; the app sends it presses:
//   window.__lbNav.press('up'|'down'|'left'|'right'|'a') → 'keyboard' when A landed on a text box (open the OSK).
// Spatial navigation, a visible focus ring, hidden checkboxes reachable through their label. It never reads field
// values or cookies; it only looks at element positions and types.

/* eslint-disable no-var */
function installNav(opts) {
  if (window.__lbNav) { window.__lbNav.reset(); return 'already'; }
  var FOCUSABLE = [
    'input:not([type=hidden]):not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])',
    'button:not([disabled])', 'a[href]', '[role=button]', '[role=checkbox]', '[role=switch]', '[role=link]', '[role=menuitem]', '[role=radio]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  var TEXT_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', '']);
  var isTextField = function (el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    return el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  };
  var targetBox = function (el) {
    var r = el.getBoundingClientRect();
    if ((r.width < 4 || r.height < 4) && el.labels && el.labels[0]) r = el.labels[0].getBoundingClientRect();
    var p = el.parentElement;
    while ((r.width < 4 || r.height < 4) && p && p !== document.body) { r = p.getBoundingClientRect(); p = p.parentElement; }
    return r;
  };
  var usesLabel = function (el) {
    var r = el.getBoundingClientRect();
    return (r.width < 4 || r.height < 4) && !!(el.labels && el.labels[0]);
  };
  var visible = function (el) {
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    var r = targetBox(el);
    return r.width >= 4 && r.height >= 4 && r.bottom > -2000 && r.top < innerHeight + 2000;
  };
  // Inside a popover/dialog, stay inside it.
  var scope = function () {
    var d = document.querySelectorAll(opts.scopeSelector || '[role=dialog], [data-a-target="tw-dialog-layer"] [role=dialog], .reward-center__content');
    for (var i = d.length - 1; i >= 0; i--) if (visible(d[i])) return d[i];
    return document;
  };
  var candidates = function () {
    var seen = new Set();
    var out = [];
    scope().querySelectorAll(FOCUSABLE).forEach(function (el) {
      if (!visible(el)) return;
      if (el.tagName === 'LABEL' && el.control && seen.has(el.control)) return;
      seen.add(el);
      out.push(el);
    });
    return out;
  };
  var current = null;
  var ring = null;
  var drawRing = function () {
    if (!ring) {
      ring = document.createElement('div');
      ring.setAttribute('style', 'position:fixed;z-index:2147483646;pointer-events:none;border:4px solid #FF8A66;border-radius:10px;box-shadow:0 0 0 3px rgba(0,0,0,.6),0 0 18px rgba(255,138,102,.7);transition:all 90ms ease-out;display:none');
      document.documentElement.appendChild(ring);
    }
    if (!current || !current.isConnected) { ring.style.display = 'none'; return; }
    var r = targetBox(current);
    Object.assign(ring.style, { display: 'block', left: (r.left - 6) + 'px', top: (r.top - 6) + 'px', width: (r.width + 12) + 'px', height: (r.height + 12) + 'px' });
  };
  var setCurrent = function (el) {
    current = el;
    if (!el) { drawRing(); return; }
    (usesLabel(el) ? el.labels[0] : el).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!isTextField(el)) el.focus({ preventScroll: true });
    drawRing();
  };
  var move = function (dir) {
    var list = candidates();
    if (!list.length) return;
    if (!current || !current.isConnected || list.indexOf(current) < 0) {
      var active = document.activeElement && list.indexOf(document.activeElement) >= 0 ? document.activeElement : null;
      setCurrent(active || (opts.preferText ? list.find(isTextField) : null) || list[0]);
      return;
    }
    var a = targetBox(current);
    var ax = a.left + a.width / 2;
    var ay = a.top + a.height / 2;
    var best = null;
    var bestScore = Infinity;
    list.forEach(function (el) {
      if (el === current || el.contains(current) || current.contains(el)) return; // wrappers aren't neighbours
      var b = targetBox(el);
      var dx = b.left + b.width / 2 - ax;
      var dy = b.top + b.height / 2 - ay;
      var main;
      var cross;
      if (dir === 'down') { if (b.top < a.bottom - 4 && dy <= 4) return; main = dy; cross = Math.abs(dx); }
      else if (dir === 'up') { if (b.bottom > a.top + 4 && dy >= -4) return; main = -dy; cross = Math.abs(dx); }
      else if (dir === 'right') { if (dx <= 4) return; main = dx; cross = Math.abs(dy); }
      else { if (dx >= -4) return; main = -dx; cross = Math.abs(dy); }
      if (main <= 0) return;
      var score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setCurrent(best);
  };
  var activate = function () {
    if (!current || !current.isConnected) { move('down'); return null; }
    if (isTextField(current)) { current.focus(); return 'keyboard'; }
    var t = (current.getAttribute('type') || '').toLowerCase();
    if ((t === 'checkbox' || t === 'radio') && usesLabel(current)) current.labels[0].click();
    else current.click();
    setTimeout(drawRing, 50);
    return null;
  };
  if (opts.hint) {
    var bar = document.createElement('div');
    bar.textContent = opts.hint;
    bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 20px;font:600 20px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.85);text-align:center;pointer-events:none');
    document.documentElement.appendChild(bar);
  }
  addEventListener('scroll', drawRing, true);
  addEventListener('resize', drawRing);
  addEventListener('focusin', function (e) { if (e.target && e.target.matches && e.target.matches(FOCUSABLE)) { current = e.target; drawRing(); } }, true);
  window.__lbNav = {
    press: function (k) { if (k === 'a') return activate(); move(k); return null; },
    start: function () { if (!current && candidates().length) move('down'); return !!current; },
    reset: function () { current = null; drawRing(); },
    count: function () { return candidates().length; },
  };
  return 'installed';
}

/** Source to inject: installs window.__lbNav. opts: { hint?: string, preferText?: boolean, scopeSelector?: string } */
function navSource(opts = {}) {
  return `(${installNav.toString()})(${JSON.stringify(opts)})`;
}

const PRESS_KEYS = new Set(['up', 'down', 'left', 'right', 'a']);
/** Source for one press; null for keys the nav doesn't handle. */
function pressSource(key) {
  if (!PRESS_KEYS.has(key)) return null;
  return `(window.__lbNav ? window.__lbNav.press(${JSON.stringify(key)}) : 'no-nav')`;
}

module.exports = { navSource, pressSource, installNav };
