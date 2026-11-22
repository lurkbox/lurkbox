// Touch gestures: swipe thresholds, taps, channel tab steps, pull-to-refresh, double-tap seek and long-press timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  swipeDir, isTap, tabStepForSwipe, pullState, DoubleTap, LongPress,
  SWIPE_MIN_PX, SWIPE_MAX_MS, DOUBLE_TAP_MS, LONG_PRESS_MS, PULL_REFRESH_PX, SEEK_STEP_S,
} from '../src/shared/gestures.js';

test('swipes: direction, distance and time thresholds', () => {
  assert.equal(swipeDir(300, 100, 0, 200, 110, 200), 'left');
  assert.equal(swipeDir(100, 100, 0, 220, 90, 200), 'right');
  assert.equal(swipeDir(100, 100, 0, 105, 300, 200), 'down');
  assert.equal(swipeDir(100, 300, 0, 110, 100, 200), 'up');
  assert.equal(swipeDir(100, 100, 0, 100 + SWIPE_MIN_PX - 1, 100, 100), null, 'too short');
  assert.equal(swipeDir(100, 100, 0, 100 + SWIPE_MIN_PX, 100, 100), 'right', 'exactly the minimum');
  assert.equal(swipeDir(100, 100, 0, 300, 100, SWIPE_MAX_MS + 1), null, 'too slow: a drag');
  assert.equal(swipeDir(100, 100, 0, 200, 180, 200), null, 'diagonal: neither axis dominates');
  assert.equal(swipeDir(100, 100, 0, 250, 199, 200), 'right', 'just over 1.5× the other axis');
  assert.equal(swipeDir(0, 0, 0, 30, 0, 100, { minPx: 20 }), 'right', 'options');
});

test('taps and channel tab steps', () => {
  assert.equal(isTap(10, 10, 18, 4), true);
  assert.equal(isTap(10, 10, 30, 10), false);
  assert.equal(tabStepForSwipe('left'), 1, 'left swipe: next tab (RB)');
  assert.equal(tabStepForSwipe('right'), -1, 'right swipe: previous tab (LB)');
  assert.equal(tabStepForSwipe('down'), 0);
  assert.equal(tabStepForSwipe(null), 0);
});

test('pull-to-refresh only from the top, ready past the threshold', () => {
  assert.deepEqual(pullState(40, true), { pull: 40 / PULL_REFRESH_PX, ready: false });
  assert.deepEqual(pullState(PULL_REFRESH_PX, true), { pull: 1, ready: true });
  assert.deepEqual(pullState(300, true), { pull: 1, ready: true });
  assert.deepEqual(pullState(300, false), { pull: 0, ready: false }, 'started scrolled down');
  assert.deepEqual(pullState(-50, true), { pull: 0, ready: false }, 'pushing up');
});

test('double tap: same half within the window seeks ±10 s, and keeps seeking', () => {
  const d = new DoubleTap();
  const W = 1000;
  assert.deepEqual(d.tap(800, W, 0), { kind: 'single', side: 'right' });
  assert.deepEqual(d.tap(820, W, 200), { kind: 'double', side: 'right', seek: SEEK_STEP_S });
  assert.deepEqual(d.tap(790, W, 400), { kind: 'double', side: 'right', seek: 10 }, 'a third tap seeks again');
  assert.equal(d.tap(200, W, 500).kind, 'single', 'the other half starts over');
  assert.deepEqual(d.tap(150, W, 650), { kind: 'double', side: 'left', seek: -10 });
  assert.equal(d.tap(150, W, 650 + DOUBLE_TAP_MS + 1).kind, 'single', 'too late');
  d.reset();
  assert.equal(d.tap(150, W, 700).kind, 'single', 'after reset');
  assert.equal(DoubleTap.side(499, 1000), 'left');
  assert.equal(DoubleTap.side(500, 1000), 'right');
});

test('long-press timing: held still for 500 ms fires once; moving cancels', () => {
  const p = new LongPress();
  p.start(0);
  assert.equal(p.fire(LONG_PRESS_MS - 1), false);
  assert.equal(p.fire(LONG_PRESS_MS), true);
  assert.equal(p.fire(LONG_PRESS_MS + 100), false, 'only once');
  assert.equal(p.end(), true, 'the click after it is swallowed');
  p.start(1000);
  p.move(4, 3);
  assert.equal(p.fire(1600), true, 'a small wobble is still a press');
  p.end();
  p.start(2000);
  p.move(30, 0);
  assert.equal(p.fire(2600), false, 'moved: a scroll, not a press');
  assert.equal(p.end(), false);
  assert.equal(p.fire(5000), false, 'not pressed');
});
