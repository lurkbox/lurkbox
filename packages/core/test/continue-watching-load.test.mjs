// Continue watching's loader: the active account's positions through the row's rules, one Helix check for new ids,
// deleted VODs forgotten lazily, the setting, and Remove.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NOW = Date.UTC(2026, 10, 22);
const calls = { helix: [], set: [] };
let entries = [];
let helixAnswer = null;
globalThis.window = {
  lurkbox: {
    async getSettings() { return {}; },
    async setSettings(p) { return p; },
    async authState() { return { signedIn: true, active: '42', user: { id: '42' } }; },
    async appInfo() { return {}; },
    onSettingsChanged() {},
    onAuthState() {},
    async resumeList() { return entries; },
    async resumeSet(id, pos) { calls.set.push([id, pos]); return true; },
    async helix(req) { calls.helix.push(req); return helixAnswer(req); },
  },
};
const { state, initState } = await import('../src/js/state.js');
await initState();
const { loadContinueWatching, removeFromContinueWatching, resetContinueWatchingChecks } = await import('../src/js/continue-watching.js');

const e = (id, ago, extra = {}) => ({ id, position: 600, duration: 3600, at: NOW - ago, title: `t${id}`, login: 'abc', name: 'Abc', ...extra });

test('loads the row, checks new ids once with Helix and drops deleted VODs', async () => {
  resetContinueWatchingChecks();
  entries = [e('1', 1000), e('2', 2000), e('3', 3000, { position: 3550 })];
  helixAnswer = () => ({ ok: true, status: 200, data: { data: [{ id: '1', title: 'fresh title', user_login: 'abc', user_name: 'Abc' }] } });
  const rows = await loadContinueWatching({ account: '42', now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ['1'], '2 is gone from Helix, 3 is finished');
  assert.equal(rows[0].video.title, 'fresh title');
  assert.deepEqual(calls.helix[0].query.id, ['1', '2'], 'one request for the unchecked ids');
  assert.deepEqual(calls.set, [['2', 0]], 'the deleted VOD is forgotten');

  entries = [e('1', 500)];
  calls.helix.length = 0;
  const again = await loadContinueWatching({ account: '42', now: NOW });
  assert.equal(again[0].video.title, 'fresh title');
  assert.equal(calls.helix.length, 0, 'checked ids are not asked again');
});

test('a Helix failure keeps the row as stored; another account is checked afresh', async () => {
  resetContinueWatchingChecks();
  calls.set.length = 0;
  calls.helix.length = 0;
  entries = [e('7', 1000)];
  helixAnswer = () => { throw new Error('offline'); };
  const rows = await loadContinueWatching({ account: '42', now: NOW });
  assert.equal(rows[0].video.title, 't7', 'the stored details');
  assert.equal(calls.set.length, 0);
  helixAnswer = () => ({ ok: true, status: 200, data: { data: [{ id: '7', title: 'x' }] } });
  await loadContinueWatching({ account: '43', now: NOW });
  assert.equal(calls.helix.length, 2);
});

test('the setting turns the row off; Remove forgets the position', async () => {
  state.settings.continueWatchingOn = false;
  assert.deepEqual(await loadContinueWatching({ account: '42', now: NOW }), []);
  state.settings.continueWatchingOn = true;
  calls.set.length = 0;
  await removeFromContinueWatching('7');
  assert.deepEqual(calls.set, [['7', 0]]);
});
