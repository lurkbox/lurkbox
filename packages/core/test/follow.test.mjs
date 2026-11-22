import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pressFollow, resetFollowBusy, followButtonLabel } from '../src/js/follow.js';
import { overlayControls, controlLabel, controlIcon } from '../src/js/player-ui.js';
import { PLAYER_ICONS } from '../src/js/icons.js';

const CH = { login: 'somechannel', id: '123', name: 'SomeChannel' };

/** Fakes for the follow flow: the host's answers, the dialogs (answered by `answer`), toasts and the cache. */
function rig({ answers = [], answer = 'yes', recheck = null } = {}) {
  const calls = [];
  const dialogs = [];
  const toasts = [];
  let invalidated = 0;
  let signIns = 0;
  let opened = [];
  const deps = {
    api: { followChannel: async (req) => { calls.push(req); return answers.shift() || { ok: false, reason: 'timeout' }; } },
    confirm: (d) => { dialogs.push(d.title); queueMicrotask(() => (answer === 'yes' ? d.onYes() : d.onNo())); },
    toast: (m) => toasts.push(m),
    invalidate: () => { invalidated++; },
    signIn: () => { signIns++; },
    openPage: async (l) => { opened.push(l); return true; },
    recheck: async () => recheck,
  };
  return { deps, calls, dialogs, toasts, get invalidated() { return invalidated; }, get signIns() { return signIns; }, get opened() { return opened; } };
}

test('Follow: one press follows at once, toasts and invalidates the follows cache', async () => {
  resetFollowBusy();
  const r = rig({ answers: [{ ok: true, following: true }] });
  assert.equal(await pressFollow(CH, false, r.deps), true);
  assert.deepEqual(r.calls, [{ login: 'somechannel', name: 'SomeChannel', action: 'follow', confirmed: false }]);
  assert.deepEqual(r.dialogs, []);
  assert.deepEqual(r.toasts, ['Followed SomeChannel']);
  assert.equal(r.invalidated, 1);
});

test('Unfollow asks first; Cancel sends nothing, even for a stale "following"', async () => {
  resetFollowBusy();
  const r = rig({ answer: 'no' });
  assert.equal(await pressFollow(CH, true, r.deps), true);
  assert.deepEqual(r.dialogs, ['Unfollow SomeChannel?']);
  assert.deepEqual(r.calls, [], 'no unfollow without a Yes');
  assert.equal(r.invalidated, 0);
});

test('Unfollow after Yes: sent once, confirmed, toast "Unfollowed"', async () => {
  resetFollowBusy();
  const r = rig({ answers: [{ ok: true, following: false }] });
  assert.equal(await pressFollow(CH, true, r.deps), false);
  assert.deepEqual(r.calls, [{ login: 'somechannel', name: 'SomeChannel', action: 'unfollow', confirmed: true }]);
  assert.deepEqual(r.toasts, ['Unfollowed SomeChannel']);
});

test('unknown state presses Follow only (never unfollows); "already following" is reported as followed', async () => {
  resetFollowBusy();
  const r = rig({ answers: [{ ok: true, following: true, already: true }] });
  assert.equal(await pressFollow(CH, null, r.deps), true);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].action, 'follow');
});

test('no twitch.tv session: the sign-in prompt, nothing else', async () => {
  resetFollowBusy();
  const r = rig({ answers: [{ ok: false, reason: 'no-session' }] });
  assert.equal(await pressFollow(CH, false, r.deps), false);
  assert.deepEqual(r.dialogs, ['Sign in to follow']);
  assert.equal(r.signIns, 1);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.opened, []);
});

test('a challenge or a button that never flips: "Couldn\'t follow, open on twitch.tv" opens the page, then re-checks', async () => {
  for (const reason of ['challenge', 'timeout', 'load', 'wrong-channel']) {
    resetFollowBusy();
    const r = rig({ answers: [{ ok: false, reason }], recheck: true });
    assert.equal(await pressFollow(CH, false, r.deps), true, reason);
    assert.deepEqual(r.dialogs, ['Couldn’t follow, open on twitch.tv']);
    assert.deepEqual(r.opened, ['somechannel']);
    assert.equal(r.invalidated, 1);
  }
  resetFollowBusy();
  const r = rig({ answers: [{ ok: false, reason: 'timeout' }], answer: 'yes', recheck: null });
  // Unfollow: Yes in the confirm, then the fallback (also answered Yes); unknown afterwards keeps the old state.
  assert.equal(await pressFollow(CH, true, r.deps), true);
  assert.deepEqual(r.dialogs, ['Unfollow SomeChannel?', 'Couldn’t unfollow, open on twitch.tv']);
});

test('without the host feature nothing is sent', async () => {
  resetFollowBusy();
  const toasts = [];
  assert.equal(await pressFollow(CH, false, { api: {}, toast: (m) => toasts.push(m) }), false);
  assert.equal(toasts.length, 1);
});

test('player bar: the heart, its label bubble and icon', () => {
  assert.deepEqual(overlayControls({ kind: 'live', points: true, follow: true }), ['play', 'volume', 'quality', 'chat', 'live', 'points', 'follow', 'channel', 'more', 'back']);
  assert.ok(overlayControls({ kind: 'video', follow: true }).includes('follow'));
  assert.ok(!overlayControls({ kind: 'live', points: true }).includes('follow'));
  assert.equal(controlLabel('follow', { following: false }), 'Follow');
  assert.equal(controlLabel('follow', { following: null }), 'Follow');
  assert.equal(controlLabel('follow', { following: true }), 'Following · Unfollow?');
  assert.equal(controlIcon('follow', { following: true }), 'heart-filled');
  assert.equal(controlIcon('follow', {}), 'heart');
  assert.ok(PLAYER_ICONS.heart && PLAYER_ICONS['heart-filled']);
  assert.equal(followButtonLabel(true), 'Following');
  assert.equal(followButtonLabel(false), 'Follow');
});
