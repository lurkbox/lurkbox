// A signed-out account leaves the renderer's memory too: the auth state that drops it from the list tells every
// module (onAccountRemoved) before the views redraw, so no cache, draft or pending save of it survives.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let authCb = null;
const indexSaves = [];
globalThis.window = {
  lurkbox: {
    async authState() { return { signedIn: true, active: '1', user: { id: '1', login: 'a' }, accounts: [{ id: '1' }, { id: '2' }] }; },
    async appInfo() { return {}; },
    async getSettings() { return {}; },
    onSettingsChanged() {},
    onAuthState(fn) { authCb = fn; },
    async emoteIndexGet() { return { v: 1, channels: [] }; },
    async emoteIndexSet(d) { indexSaves.push(d); return true; },
  },
};
const { state, initState, onAccountRemoved, onState, removedAccounts } = await import('../src/js/state.js');
const { addToDraft, peekDraft } = await import('../src/js/emote-browser.js');
const { EmoteIndexStore } = await import('../src/js/emote-index-store.js');
await initState();

test('removedAccounts lists the ids that left', () => {
  assert.deepEqual(removedAccounts([{ id: '1' }, { id: '2' }], [{ id: '2' }]), ['1']);
  assert.deepEqual(removedAccounts([{ id: '1' }], [{ id: '1' }]), []);
  assert.deepEqual(removedAccounts(undefined, []), []);
});

test('an account leaving the auth state is forgotten before the views hear of it', () => {
  const order = [];
  const offA = onAccountRemoved((id) => order.push(`forget ${id}`));
  const offS = onState((what) => order.push(what));
  addToDraft('somechannel', 'Kappa');
  assert.ok(peekDraft('somechannel').includes('Kappa'));
  authCb({ signedIn: true, active: '2', user: { id: '2', login: 'b' }, accounts: [{ id: '2' }] });
  assert.deepEqual(order, ['forget 1', 'account']);
  assert.equal(peekDraft('somechannel'), '', 'the chat draft is gone');
  assert.equal(state.auth.user.login, 'b');
  offA(); offS();
});

test('the emote index drops its copy and a pending save when its account goes', async () => {
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  let acct = '2';
  const st = new EmoteIndexStore({ host: () => window.lurkbox, account: () => acct, timers });
  await st.record({ id: '9', login: 'x', name: 'X' }, 'twitch', [{ id: '1', name: 'Kappa' }]);
  assert.ok(st.timer, 'a save is pending');
  st.forget();
  acct = '3';
  st.flush();
  assert.deepEqual(indexSaves, [], 'never saved into the next account');
  assert.equal(st.loadedFor, undefined);
});
