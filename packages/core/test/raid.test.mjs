import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RaidCountdown } from '../src/js/raid.js';

const EV = { from_broadcaster_user_id: '1', from_broadcaster_user_name: 'From', to_broadcaster_user_id: '2', to_broadcaster_user_login: 'target_login', to_broadcaster_user_name: 'Target', viewers: 42 };

let calls;
const make = () => new RaidCountdown({
  onShow: (s) => calls.push(['show', s.mode, s.left]),
  onTick: (left) => calls.push(['tick', left]),
  onFollow: (ev) => calls.push(['follow', ev.to_broadcaster_user_login]),
  onEnd: (reason) => calls.push(['end', reason]),
});

beforeEach(() => {
  calls = [];
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
});
afterEach(() => mock.timers.reset());

test('countdown expiry switches to to_broadcaster_user_login', () => {
  const r = make();
  assert.equal(r.start(EV, { follow: true, delaySec: 10 }), 'countdown');
  assert.deepEqual(calls[0], ['show', 'countdown', 10]);
  mock.timers.tick(5000);
  assert.ok(calls.some((c) => c[0] === 'tick' && c[1] === 5));
  assert.ok(!calls.some((c) => c[0] === 'follow'));
  mock.timers.tick(5000);
  assert.deepEqual(calls.at(-1), ['follow', 'target_login']);
  assert.equal(r.active, false);
});

test('B cancels: no follow afterwards', () => {
  const r = make();
  r.start(EV, { follow: true, delaySec: 10 });
  mock.timers.tick(3000);
  assert.equal(r.cancel(), true);
  mock.timers.tick(20000);
  assert.deepEqual(calls.at(-1), ['end', 'cancelled']);
  assert.ok(!calls.some((c) => c[0] === 'follow'));
});

test('A follows immediately', () => {
  const r = make();
  r.start(EV, { follow: true, delaySec: 30 });
  assert.equal(r.followNow(), true);
  assert.deepEqual(calls.at(-1), ['follow', 'target_login']);
  mock.timers.tick(60000);
  assert.equal(calls.filter((c) => c[0] === 'follow').length, 1);
});

test('delay 0 follows without a countdown', () => {
  const r = make();
  assert.equal(r.start(EV, { follow: true, delaySec: 0 }), 'followed');
  assert.deepEqual(calls, [['follow', 'target_login']]);
});

test('raid follow off: offer expires without switching', () => {
  const r = make();
  assert.equal(r.start(EV, { follow: false, delaySec: 10, offerSec: 20 }), 'offer');
  mock.timers.tick(21000);
  assert.deepEqual(calls.at(-1), ['end', 'expired']);
  assert.ok(!calls.some((c) => c[0] === 'follow'));
});
