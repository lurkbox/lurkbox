// Touch gestures, as pure logic with the time passed in (js/touch.js binds them to pointer events): swipes,
// pull-to-refresh, double-tap to seek and long-press. Unit-tested under node --test.

export const SWIPE_MIN_PX = 60; // how far a finger must travel to count as a swipe
export const SWIPE_MAX_MS = 700; // slower than this is a drag, not a swipe
export const SWIPE_AXIS_RATIO = 1.5; // the main axis must be this much longer than the other
export const TAP_MAX_PX = 12; // a tap may wobble this much
export const DOUBLE_TAP_MS = 300; // the second tap of a double tap comes within this
export const LONG_PRESS_MS = 500;
export const PULL_REFRESH_PX = 80; // pull down this far at the top of a list to refresh
export const SEEK_STEP_S = 10; // a double tap on a half of the video seeks this far

/**
 * The swipe a finger made from (x0, y0) at t0 to (x1, y1) at t1: 'left' | 'right' | 'up' | 'down' | null.
 * 'left' means the finger moved left (the next page comes in from the right).
 */
export function swipeDir(x0, y0, t0, x1, y1, t1, { minPx = SWIPE_MIN_PX, maxMs = SWIPE_MAX_MS, ratio = SWIPE_AXIS_RATIO } = {}) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (t1 - t0 > maxMs) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= minPx && ax >= ay * ratio) return dx < 0 ? 'left' : 'right';
  if (ay >= minPx && ay >= ax * ratio) return dy < 0 ? 'up' : 'down';
  return null;
}

/** A tap: the finger barely moved. */
export function isTap(x0, y0, x1, y1, maxPx = TAP_MAX_PX) {
  return Math.abs(x1 - x0) <= maxPx && Math.abs(y1 - y0) <= maxPx;
}

/** Channel page tabs: a left swipe goes to the next tab (RB), a right swipe to the previous one (LB). */
export function tabStepForSwipe(dir) {
  return dir === 'left' ? 1 : dir === 'right' ? -1 : 0;
}

/**
 * Pull-to-refresh progress for a downward drag of `dy` px that started with the list scrolled to the top:
 * { pull (0..1, for the indicator), ready (let go now to refresh) }.
 */
export function pullState(dy, startedAtTop, threshold = PULL_REFRESH_PX) {
  if (!startedAtTop || !(dy > 0)) return { pull: 0, ready: false };
  return { pull: Math.min(1, dy / threshold), ready: dy >= threshold };
}

/**
 * Double tap on the left or right half of the video. tap(x, width, now) returns
 * { kind: 'single' } for the first tap, or { kind: 'double', side: 'left'|'right', seek: -10|10 } when a second tap on
 * the same half follows within DOUBLE_TAP_MS. Further taps on that half keep seeking (each one within the window of
 * the last), like the big video apps.
 */
export class DoubleTap {
  constructor({ windowMs = DOUBLE_TAP_MS, step = SEEK_STEP_S } = {}) {
    this.windowMs = windowMs;
    this.step = step;
    this.last = null; // { side, t }
  }

  static side(x, width) { return x < width / 2 ? 'left' : 'right'; }

  tap(x, width, now) {
    const side = DoubleTap.side(x, width);
    const prev = this.last;
    this.last = { side, t: now };
    if (prev && prev.side === side && now - prev.t <= this.windowMs) {
      return { kind: 'double', side, seek: side === 'left' ? -this.step : this.step };
    }
    return { kind: 'single', side };
  }

  reset() { this.last = null; }
}

/**
 * Long-press timing: start(now) when the finger goes down, move(dx, dy) cancels once it travels, and fire(now) says
 * whether the press has been held long enough (checked by a timer). end() returns true when it fired, so the click
 * that follows can be swallowed.
 */
export class LongPress {
  constructor({ ms = LONG_PRESS_MS, slop = TAP_MAX_PX } = {}) {
    this.ms = ms;
    this.slop = slop;
    this.t0 = null;
    this.fired = false;
    this.cancelled = false;
  }

  start(now) { this.t0 = now; this.fired = false; this.cancelled = false; }

  move(dx, dy) { if (Math.abs(dx) > this.slop || Math.abs(dy) > this.slop) this.cancelled = true; }

  /** True once, when the press has lasted `ms` without moving. */
  fire(now) {
    if (this.t0 == null || this.cancelled || this.fired) return false;
    if (now - this.t0 < this.ms) return false;
    this.fired = true;
    return true;
  }

  end() { const f = this.fired; this.t0 = null; return f; }
}
