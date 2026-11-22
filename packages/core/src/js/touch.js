// Touch gestures bound to the page (the logic is shared/gestures.js). Only fingers count (pointerType/touch events);
// the mouse and the controller never trigger these. Everything is a no-op outside the touch layouts.
import { swipeDir, isTap, pullState } from '../shared/gestures.js';

const touchUi = () => document.body.classList.contains('touch-ui');

/**
 * Swipes and taps on `node` with pointer events (for surfaces with touch-action: none or pan-y, like the player).
 * skip(e) leaves a pointer alone (controls, sliders). onSwipe(dir, start) / onTap({ x, y, t, rect }).
 */
export function bindPointerGestures(node, { skip = () => false, onSwipe = null, onTap = null } = {}) {
  let start = null;
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !touchUi() || skip(e)) { start = null; return; }
    start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, target: e.target };
  });
  node.addEventListener('pointercancel', (e) => { if (start && e.pointerId === start.id) start = null; });
  node.addEventListener('pointerup', (e) => {
    const s = start;
    start = null;
    if (!s || e.pointerId !== s.id) return;
    const t = performance.now();
    if (onTap && isTap(s.x, s.y, e.clientX, e.clientY) && t - s.t < 500) { onTap({ x: e.clientX, y: e.clientY, t, start: s }); return; }
    const dir = swipeDir(s.x, s.y, s.t, e.clientX, e.clientY, t);
    if (dir && onSwipe) onSwipe(dir, s);
  });
}

/**
 * Swipes on a scrolling container with touch events (they keep coming while the page scrolls, unlike pointer events).
 * Horizontal swipes only reach the page where the container has touch-action: pan-y.
 */
export function bindTouchSwipe(node, { skip = () => false, onSwipe }) {
  let start = null;
  node.addEventListener('touchstart', (e) => {
    if (!touchUi() || e.touches.length !== 1 || skip(e)) { start = null; return; }
    const p = e.touches[0];
    start = { x: p.clientX, y: p.clientY, t: performance.now(), target: e.target };
  }, { passive: true });
  node.addEventListener('touchend', (e) => {
    const s = start;
    start = null;
    if (!s || !e.changedTouches.length) return;
    const p = e.changedTouches[0];
    const dir = swipeDir(s.x, s.y, s.t, p.clientX, p.clientY, performance.now());
    if (dir) onSwipe(dir, s);
  }, { passive: true });
  node.addEventListener('touchcancel', () => { start = null; }, { passive: true });
}

/**
 * Pull-to-refresh on a scrolling container: a downward drag that starts with it scrolled to the top shows `indicator`
 * (its --pull custom property, 0..1, and the class "ready"), and letting go past the threshold calls onRefresh().
 * enabled() says whether the current screen refreshes at all.
 */
export function bindPullToRefresh(scroller, indicator, { enabled, onRefresh }) {
  let s = null;
  const reset = () => { indicator.style.setProperty('--pull', '0'); indicator.classList.remove('ready', 'pulling'); };
  scroller.addEventListener('touchstart', (e) => {
    s = null;
    if (!touchUi() || e.touches.length !== 1 || !enabled()) return;
    s = { y: e.touches[0].clientY, top: scroller.scrollTop <= 0 };
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!s || !s.top) return;
    const st = pullState(e.touches[0].clientY - s.y, scroller.scrollTop <= 0);
    indicator.style.setProperty('--pull', String(st.pull));
    indicator.classList.toggle('pulling', st.pull > 0);
    indicator.classList.toggle('ready', st.ready);
  }, { passive: true });
  scroller.addEventListener('touchend', (e) => {
    const cur = s;
    s = null;
    if (!cur || !cur.top || !e.changedTouches.length) { reset(); return; }
    const st = pullState(e.changedTouches[0].clientY - cur.y, true);
    reset();
    if (st.ready) onRefresh();
  }, { passive: true });
  scroller.addEventListener('touchcancel', () => { s = null; reset(); }, { passive: true });
}
