'use strict';
// Controller navigation for twitch.tv pages we don't control (the sign-in window, the channel-points rewards view of
// Twitch's embedded chat). Injected into the page with executeJavaScript; the app sends it presses:
//   window.__lbNav.press('up'|'down'|'left'|'right'|'a') → 'keyboard' when A landed on a text box (open the OSK).
//   window.__lbNav.back() → 'back' when B closed a sub-view (a reward's detail/confirm), else 'close'.
// Spatial navigation over individual actionable elements (wrappers and anything over ~60 % of the viewport are
// skipped), a focus ring on the element's exact rect (clipped to what is visible, kept up to date on scroll and
// resize), and hidden checkboxes reachable through their label. It never reads field values or cookies; it only looks
// at element positions and types.
//
// The pure helpers below are unit-tested and injected into the page together with installNav (see navSource).

/* eslint-disable no-var */

/** True for elements too big to be one target: over 60 % of the viewport's area, or 60 % of both sides. */
function navTooBig(r, vw, vh) {
  if (!(vw > 0 && vh > 0)) return false;
  return r.width * r.height > 0.6 * vw * vh || (r.width > 0.6 * vw && r.height > 0.6 * vh);
}

/** Drops every candidate that contains another candidate (wrappers), keeping the innermost, smallest ones. */
function navInnermost(list, contains) {
  return list.filter(function (el) {
    for (var i = 0; i < list.length; i++) if (list[i] !== el && contains(el, list[i])) return false;
    return true;
  });
}

/** Intersection of two rects ({left, top, right, bottom}); null when empty. */
function navIntersect(a, b) {
  var r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right - r.left >= 1 && r.bottom - r.top >= 1 ? r : null;
}

/** Scroll delta that brings [start, end] inside [boxStart, boxEnd] the way block: 'nearest' does (0 when it fits). */
function navNearestDelta(start, end, boxStart, boxEnd) {
  if (start >= boxStart && end <= boxEnd) return 0;
  if (end - start > boxEnd - boxStart) return start - boxStart; // taller than the box: align the start
  return start < boxStart ? start - boxStart : end - boxEnd;
}

function installNav(opts) {
  if (window.__lbNav) { window.__lbNav.reset(); return 'already'; }
  var FOCUSABLE = [
    'input:not([type=hidden]):not([disabled])', 'textarea:not([disabled])', 'select:not([disabled])',
    'button:not([disabled])', 'a[href]', '[role=button]', '[role=checkbox]', '[role=switch]', '[role=link]', '[role=menuitem]', '[role=radio]',
    '[role=tab]', '[role=option]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  // Buttons that leave a sub-view of a popover (a reward's detail or confirm step) rather than closing it.
  var BACK = opts.backSelector || 'button[aria-label="Back" i], button[aria-label^="Back " i], button[data-a-target*="back" i], [data-test-selector*="back-button" i] button, button[data-test-selector*="back" i]';
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
  var view = function () { return { left: 0, top: 0, right: innerWidth, bottom: innerHeight }; };
  // The scroll containers around an element (inner first).
  var scrollers = function (el) {
    var out = [];
    for (var p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (/(auto|scroll|overlay|hidden)/.test(cs.overflowY + ' ' + cs.overflowX)) out.push(p);
    }
    return out;
  };
  // What is actually visible of an element: its rect clipped by its scroll containers and the viewport.
  var visibleRect = function (el) {
    var r = navIntersect(targetBox(el), view());
    var s = scrollers(el);
    for (var i = 0; r && i < s.length; i++) r = navIntersect(r, s[i].getBoundingClientRect());
    return r;
  };
  // Inside a popover/dialog, stay inside it; otherwise in the fallback areas (e.g. the pinned prediction), else the page.
  var scopes = function () {
    var d = document.querySelectorAll(opts.scopeSelector || '[role=dialog], [data-a-target="tw-dialog-layer"] [role=dialog], .reward-center__content');
    for (var i = d.length - 1; i >= 0; i--) if (visible(d[i])) return [d[i]];
    if (opts.fallbackSelector) {
      var f = Array.prototype.filter.call(document.querySelectorAll(opts.fallbackSelector), visible);
      if (f.length) return f;
    }
    return [document];
  };
  var candidates = function () {
    var seen = new Set();
    var out = [];
    scopes().forEach(function (root) {
      root.querySelectorAll(FOCUSABLE).forEach(function (el) {
        if (seen.has(el) || !visible(el)) return;
        if (el.tagName === 'LABEL' && el.control && seen.has(el.control)) return;
        if (navTooBig(targetBox(el), innerWidth, innerHeight)) return; // a whole panel, not a target
        seen.add(el);
        out.push(el);
      });
    });
    return navInnermost(out, function (a, b) { return a.contains(b); });
  };
  var zoom = function () {
    var z = document.documentElement.currentCSSZoom || parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    return z > 0 ? z : 1;
  };
  var current = null;
  var ring = null;
  var drawRing = function () {
    if (!ring) {
      ring = document.createElement('div');
      ring.id = 'lurkbox-focus-ring';
      ring.setAttribute('style', 'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:4px solid #FF8A66;border-radius:10px;box-shadow:0 0 0 3px rgba(0,0,0,.6),0 0 18px rgba(255,138,102,.7);display:none');
      document.documentElement.appendChild(ring);
    }
    var r = current && current.isConnected ? visibleRect(current) : null;
    if (!r) { ring.style.display = 'none'; return; }
    // The ring lives in <html>, which may be zoomed (Twitch's chat frame is zoomed for the TV): rects are in viewport
    // pixels, the ring's own lengths are multiplied by the zoom.
    var z = zoom();
    var pad = 4;
    var v = view();
    var box = { left: Math.max(v.left, r.left - pad), top: Math.max(v.top, r.top - pad), right: Math.min(v.right, r.right + pad), bottom: Math.min(v.bottom, r.bottom + pad) };
    Object.assign(ring.style, {
      display: 'block', left: (box.left / z) + 'px', top: (box.top / z) + 'px',
      width: ((box.right - box.left) / z) + 'px', height: ((box.bottom - box.top) / z) + 'px',
      borderWidth: (4 / z) + 'px', borderRadius: (10 / z) + 'px',
    });
  };
  // block/inline 'nearest' inside the element's own scroll containers only (never the page that hosts the frame).
  var reveal = function (el) {
    var target = usesLabel(el) ? el.labels[0] : el;
    var s = scrollers(target).filter(function (p) {
      var cs = getComputedStyle(p);
      return /(auto|scroll|overlay)/.test(cs.overflowY + ' ' + cs.overflowX) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1);
    });
    for (var i = 0; i < s.length; i++) {
      var p = s[i];
      var z = p.currentCSSZoom || zoom();
      var r = target.getBoundingClientRect();
      var b = p.getBoundingClientRect();
      var m = 8;
      var dy = navNearestDelta(r.top, r.bottom, b.top + m, b.bottom - m);
      var dx = navNearestDelta(r.left, r.right, b.left + m, b.right - m);
      if (dy && p.scrollHeight > p.clientHeight + 1) p.scrollTop += dy / z;
      if (dx && p.scrollWidth > p.clientWidth + 1) p.scrollLeft += dx / z;
    }
    var rr = target.getBoundingClientRect();
    var dyDoc = navNearestDelta(rr.top, rr.bottom, 0, innerHeight);
    if (dyDoc) document.scrollingElement.scrollTop += dyDoc / zoom();
  };
  var setCurrent = function (el) {
    current = el;
    if (!el) { drawRing(); return; }
    reveal(el);
    if (!isTextField(el)) el.focus({ preventScroll: true });
    drawRing();
  };
  var hideHint = function () {};
  var move = function (dir) {
    hideHint();
    var list = candidates();
    if (!list.length) return;
    if (!current || !current.isConnected || list.indexOf(current) < 0) {
      var active = document.activeElement && list.indexOf(document.activeElement) >= 0 ? document.activeElement : null;
      // First the page's own focus, then (sign-in) the first text box, then the first item of the scrolling content
      // (a popover's list rather than its header's close button), then the first target.
      var inContent = list.find(function (el) {
        return scrollers(el).some(function (p) { var cs = getComputedStyle(p); return /(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1; });
      });
      setCurrent(active || (opts.preferText ? list.find(isTextField) : null) || inContent || list[0]);
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
    hideHint();
    if (!current || !current.isConnected) { move('down'); return null; }
    reveal(current);
    drawRing();
    if (isTextField(current)) { current.focus(); return 'keyboard'; }
    var t = (current.getAttribute('type') || '').toLowerCase();
    if ((t === 'checkbox' || t === 'radio') && usesLabel(current)) current.labels[0].click();
    else current.click();
    setTimeout(drawRing, 50);
    return null;
  };
  // B: leave a sub-view of the open popover (its Back button) when there is one.
  var back = function () {
    var roots = scopes();
    for (var i = 0; i < roots.length; i++) {
      var list = roots[i].querySelectorAll(BACK);
      for (var j = 0; j < list.length; j++) {
        if (visible(list[j]) && !list[j].disabled) { list[j].click(); current = null; drawRing(); return 'back'; }
      }
    }
    return 'close';
  };
  if (opts.hint) {
    // Shown until the first press, so it never stays on top of the page's own buttons.
    var bar = document.createElement('div');
    bar.textContent = opts.hint;
    bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 20px;font:600 20px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.85);text-align:center;pointer-events:none;transition:opacity .3s');
    document.documentElement.appendChild(bar);
    hideHint = function () { bar.style.opacity = '0'; setTimeout(function () { bar.remove(); }, 400); hideHint = function () {}; };
  }
  var onFocusIn = function (e) {
    var t = e.target;
    if (t && t.matches && t.matches(FOCUSABLE) && candidates().indexOf(t) >= 0) { current = t; drawRing(); }
  };
  addEventListener('scroll', drawRing, true);
  addEventListener('resize', drawRing);
  addEventListener('focusin', onFocusIn, true);
  // Layout changes without a scroll event (popover animations, content loading).
  var tick = setInterval(function () { if (current) drawRing(); }, 250);
  window.__lbNav = {
    press: function (k) { if (k === 'a') return activate(); move(k); return null; },
    back: back,
    start: function () { if (!current && candidates().length) move('down'); return !!current; },
    reset: function () { current = null; drawRing(); },
    count: function () { return candidates().length; },
    targets: function () { return candidates(); },
    current: function () { return current; },
    stop: function () {
      clearInterval(tick);
      removeEventListener('scroll', drawRing, true);
      removeEventListener('resize', drawRing);
      removeEventListener('focusin', onFocusIn, true);
      current = null;
      if (ring) ring.remove();
      ring = null;
      delete window.__lbNav;
    },
  };
  return 'installed';
}

const HELPERS = [navTooBig, navInnermost, navIntersect, navNearestDelta];

/** Source to inject: installs window.__lbNav. opts: { hint?, preferText?, scopeSelector?, fallbackSelector?, backSelector? } */
function navSource(opts = {}) {
  return `(() => { ${HELPERS.map((f) => f.toString()).join('\n')}\nreturn (${installNav.toString()})(${JSON.stringify(opts)}); })()`;
}

const PRESS_KEYS = new Set(['up', 'down', 'left', 'right', 'a']);
/** Source for one press; null for keys the nav doesn't handle. */
function pressSource(key) {
  if (!PRESS_KEYS.has(key)) return null;
  return `(window.__lbNav ? window.__lbNav.press(${JSON.stringify(key)}) : 'no-nav')`;
}

/** Source for B: 'back' when a sub-view was closed in the page, 'close' when the caller should close the whole view. */
function backSource() {
  return "(window.__lbNav ? window.__lbNav.back() : 'close')";
}

module.exports = { navSource, pressSource, backSource, installNav, navTooBig, navInnermost, navIntersect, navNearestDelta };
