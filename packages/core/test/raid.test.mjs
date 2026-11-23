import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RaidCountdown, TileRaids } from '../src/js/raid.js';

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

test('TileRaids: each tile counts down on its own; cancelling one leaves the other to follow', async () => {
  {
    const followed = [];
    const ended = [];
    const shown = [];
    const r = new TileRaids({ onShow: (k, s) => shown.push([k, s.mode]), onFollow: (k, ev) => followed.push([k, ev.to]), onEnd: (k, why) => ended.push([k, why]) });
    const a = { n: 'a' };
    const b = { n: 'b' };
    assert.equal(r.start(a, { to: 'x' }, { follow: true, delaySec: 10 }), 'countdown');
    mock.timers.tick(3000);
    assert.equal(r.start(b, { to: 'y' }, { follow: true, delaySec: 10 }), 'countdown');
    assert.ok(r.active(a) && r.active(b));
    assert.equal(r.get(a).left, 7);
    assert.equal(r.cancel(a), true);
    assert.deepEqual(ended, [[a, 'cancelled']]);
    assert.equal(r.active(a), false);
    mock.timers.tick(10000);
    assert.deepEqual(followed, [[b, 'y']], 'only b follows');
    assert.equal(r.active(b), false);
    // Raid follow off: an offer that A takes; delay 0 follows at once; a closed tile is cleared without callbacks.
    assert.equal(r.start(a, { to: 'z' }, { follow: false, delaySec: 10 }), 'offer');
    assert.equal(r.followNow(a), true);
    assert.deepEqual(followed.at(-1), [a, 'z']);
    assert.equal(r.start(b, { to: 'w' }, { follow: true, delaySec: 0 }), 'followed');
    assert.deepEqual(followed.at(-1), [b, 'w']);
    assert.equal(r.active(b), false);
    r.start(a, { to: 'q' }, { follow: true, delaySec: 5 });
    r.clear(a);
    mock.timers.tick(10000);
    assert.equal(followed.length, 3, 'a cleared countdown never follows');
    assert.deepEqual(shown.map(([k, m]) => [k.n, m]), [['a', 'countdown'], ['b', 'countdown'], ['a', 'offer'], ['a', 'countdown']]);
  }
});
