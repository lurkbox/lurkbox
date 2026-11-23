// Spatial focus navigation over elements with the .focusable class.
import { UP, DOWN, LEFT, RIGHT } from './input-core.js';

function isVisible(node) {
  if (node.disabled || node.closest('[hidden], [inert]')) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function focusables(scope) {
  return [...scope.querySelectorAll('.focusable')].filter(isVisible);
}

// The focus ring is driven by an .is-focused class as well as :focus, because
// :focus doesn't match while the window lacks OS focus (and DOM focus events
// are deferred then), which can happen under Gamescope. For the same reason a newly marked node gets a bubbling
// 'lurkbox-focus' event: listen to it, not to focusin, to follow the D-pad.
let marked = null;
export function markFocused(node) {
  if (marked === node) return;
  if (marked) marked.classList.remove('is-focused');
  marked = node && node.classList && node.classList.contains('focusable') ? node : null;
  if (marked) {
    marked.classList.add('is-focused');
    if (typeof marked.dispatchEvent === 'function' && typeof Event === 'function') marked.dispatchEvent(new Event('lurkbox-focus', { bubbles: true }));
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => markFocused(e.target));
}

/**
 * Pure scroll maths (unit-tested). Positions are relative to the scroller's
 * visible top edge. Returns the new scrollTop, or null to leave it alone.
 *  - firstRow: the item is in the first row of the view → scroll to 0 so the
 *    heading and toolbar are fully visible.
 *  - headTop: top of a section heading that belongs to the item's row, kept in view too.
 */
export function computeScrollTop({ scrollTop, viewHeight, itemTop, itemBottom, margin, firstRow = false, headTop = null }) {
  if (firstRow) return scrollTop === 0 ? null : 0;
  const top = headTop !== null ? Math.min(headTop, itemTop) : itemTop;
  if (top - margin < 0) return Math.max(0, scrollTop + top - margin);
  if (itemBottom + margin > viewHeight) return scrollTop + itemBottom + margin - viewHeight;
  return null;
}

const SCROLLERS = '#content, .pick-list, .modal, .chat-list, .ce, .ep-grid, .po-pop';

function remPx() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }

/**
 * Pure: the scrollLeft that brings an item of a sideways row (.hscroll, e.g. Continue watching) into view with a
 * margin, or null to leave it alone. Positions are relative to the row's visible left edge.
 */
export function computeScrollLeft({ scrollLeft, viewWidth, itemLeft, itemRight, margin }) {
  if (itemLeft - margin < 0) return Math.max(0, scrollLeft + itemLeft - margin);
  if (itemRight + margin > viewWidth) return scrollLeft + itemRight + margin - viewWidth;
  return null;
}

function scrollRowToFocus(node, instant) {
  const row = node.closest('.hscroll');
  if (!row || row.scrollWidth <= row.clientWidth) return;
  const cr = row.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const left = computeScrollLeft({ scrollLeft: row.scrollLeft, viewWidth: row.clientWidth, itemLeft: r.left - cr.left, itemRight: r.right - cr.left, margin: remPx() * 1.5 });
  if (left === null) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.scrollTo({ left, behavior: instant || reduce ? 'instant' : 'smooth' });
}

/** Scrolls only the item's own scroll container (never ancestors or the body), and its sideways row if it is in one. */
export function scrollToFocus(node, instant = false) {
  scrollRowToFocus(node, instant);
  // The nearest of these containers that actually scrolls (e.g. a long list inside a modal, else the modal itself).
  let sc = node.parentElement && node.parentElement.closest(SCROLLERS);
  while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement && sc.parentElement.closest(SCROLLERS);
  if (!sc) return;
  const cr = sc.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const view = node.closest('.view') || sc;
  const others = focusables(view).filter((n) => n !== node);
  const firstRow = view !== sc || sc.id === 'content'
    ? !others.some((n) => n.getBoundingClientRect().bottom <= r.top + 1)
    : false;
  let headTop = null;
  const grid = node.closest('.grid');
  if (grid) {
    const inFirstGridRow = ![...grid.children].some((n) => n !== node && n.getBoundingClientRect().bottom <= r.top + 1);
    const head = grid.previousElementSibling;
    if (inFirstGridRow && head && /^H[1-3]$|view-header|section-title/.test(head.tagName + ' ' + head.className)) {
      headTop = head.getBoundingClientRect().top - cr.top;
    }
  }
  const target = computeScrollTop({
    scrollTop: sc.scrollTop,
    viewHeight: sc.clientHeight,
    itemTop: r.top - cr.top,
    itemBottom: r.bottom - cr.top,
    margin: remPx() * 2.6, // ~1.5 row gaps plus room for the ring and focus scale
    firstRow,
    headTop,
  });
  if (target === null) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  sc.scrollTo({ top: target, behavior: instant || reduce ? 'instant' : 'smooth' });
}

/** A finger in a touch layout has no cursor: only text boxes take focus (for the keyboard), nothing scrolls to it. */
function touchWithoutCursor(node) {
  if (typeof document === 'undefined' || !document.body) return false;
  const b = document.body.classList;
  if (!b.contains('touch-ui') || !b.contains('input-touch')) return false;
  return !(node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
}

export function focusEl(node, opts = {}) {
  if (!node) return false;
  if (touchWithoutCursor(node)) return false;
  node.focus({ preventScroll: true });
  markFocused(node);
  scrollToFocus(node, !!opts.instant);
  return document.activeElement === node;
}

export function focusFirst(scope, selector) {
  const list = focusables(scope);
  const pick = (selector && list.find((n) => n.matches(selector))) || list[0];
  return focusEl(pick, { instant: true });
}

/**
 * Pure neighbour search (unit-tested). `cur` and each candidate `rect` are
 * {left, top, right, bottom}. Returns the best candidate's `item`, or null.
 */
export function pickNeighbor(cur, candidates, dir) {
  const cx = (cur.left + cur.right) / 2;
  const cy = (cur.top + cur.bottom) / 2;
  let best = null;
  let bestScore = Infinity;
  for (const { rect: c, item } of candidates) {
    const ncx = (c.left + c.right) / 2;
    const ncy = (c.top + c.bottom) / 2;
    let primary, overlapGap, offset;
    if (dir === RIGHT || dir === LEFT) {
      if (dir === RIGHT ? ncx <= cx : ncx >= cx) continue;
      primary = dir === RIGHT ? c.left - cur.right : cur.left - c.right;
      overlapGap = Math.max(0, Math.max(c.top, cur.top) - Math.min(c.bottom, cur.bottom));
      offset = Math.abs(ncy - cy);
    } else {
      if (dir === DOWN ? ncy <= cy : ncy >= cy) continue;
      primary = dir === DOWN ? c.top - cur.bottom : cur.top - c.bottom;
      overlapGap = Math.max(0, Math.max(c.left, cur.left) - Math.min(c.right, cur.right));
      offset = Math.abs(ncx - cx);
    }
    // Prefer candidates that overlap on the cross axis (same row/column).
    const score = Math.max(0, primary) + overlapGap * 3 + offset * 0.05 + (overlapGap > 0 ? 1000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

/**
 * Moves focus from the active element to the best candidate in `dir` within `scope`.
 * Returns the newly focused element, or null when nothing lies in that direction.
 */
export function moveFocus(dir, scope) {
  const items = focusables(scope);
  if (!items.length) return null;
  const cur = document.activeElement;
  if (!cur || !items.includes(cur)) {
    focusEl(items[0]);
    return items[0];
  }
  const best = pickNeighbor(cur.getBoundingClientRect(),
    items.filter((n) => n !== cur).map((n) => ({ rect: n.getBoundingClientRect(), item: n })), dir);
  if (best) focusEl(best);
  return best;
}

export { UP, DOWN, LEFT, RIGHT };
