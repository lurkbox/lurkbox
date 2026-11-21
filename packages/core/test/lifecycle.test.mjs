import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { UnfocusedMode, resolveBack, quitWithCleanup } from '../src/js/lifecycle.js';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('video-only: a blur shorter than 1.5 s does not hide anything', () => {
  const changes = [];
  const u = new UnfocusedMode({ onChange: (on) => changes.push(on) });
  u.setFocus(false);
  mock.timers.tick(1000);
  u.setFocus(true);
  mock.timers.tick(5000);
  assert.deepEqual(changes, []);
});

test('video-only: hides after 1.5 s of blur and restores on focus', () => {
  const changes = [];
  const u = new UnfocusedMode({ onChange: (on) => changes.push(on) });
  u.setFocus(false);
  mock.timers.tick(1500);
  assert.deepEqual(changes, [true]);
  u.setFocus(true);
  assert.deepEqual(changes, [true, false], 'restored immediately; chat state lives elsewhere and is untouched');
});

test('video-only: stays inert when focus was never reported, and when disabled', () => {
  const changes = [];
  const u = new UnfocusedMode({ onChange: (on) => changes.push(on) });
  u.apply(true);
  assert.deepEqual(changes, [], 'no focus report yet → nothing hidden');
  u.setEnabled(false);
  u.setFocus(false);
  mock.timers.tick(5000);
  assert.deepEqual(changes, []);
});

test('back stack: player → view → rail → home → exit prompt', () => {
  assert.equal(resolveBack({ modalOpen: true, playerActive: true }), 'modal');
  assert.equal(resolveBack({ playerActive: true, raidActive: true }), 'raid', 'B cancels a raid countdown first');
  assert.equal(resolveBack({ playerActive: true, overlayOpen: true }), 'overlay');
  assert.equal(resolveBack({ playerActive: true }), 'close-player');
  assert.equal(resolveBack({ stackDepth: 2 }), 'pop');
  assert.equal(resolveBack({ stackDepth: 1, inRail: false }), 'to-rail');
  assert.equal(resolveBack({ stackDepth: 1, inRail: true, currentTop: 'browse' }), 'home');
  assert.equal(resolveBack({ stackDepth: 1, inRail: true, currentTop: 'following' }), 'exit');
});

test('quit runs cleanup but never waits longer than the timeout', async () => {
  mock.timers.reset();
  let quit = 0;
  const slow = () => new Promise(() => {}); // a network delete that never answers
  const t0 = Date.now();
  await quitWithCleanup([slow, () => 1], () => { quit++; }, 50);
  assert.equal(quit, 1);
  assert.ok(Date.now() - t0 < 1000);
  let ran = false;
  await quitWithCleanup([() => { ran = true; }], () => { quit++; }, 500);
  assert.ok(ran);
  assert.equal(quit, 2);
});
