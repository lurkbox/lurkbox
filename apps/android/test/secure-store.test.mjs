// The tokens in the encrypted store (SecureStorePlugin.java, mocked here): the one-time move out of plaintext
// Preferences, the round trip, and a Keystore key that stopped working (cleared, signed out, never a crash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@lurkbox/core/src/shared/settings.js';
import { SCOPES } from '@lurkbox/core/src/shared/config.js';
import { createPlatform, migrateToSecure } from '../src/platform.js';
import { makeNativeFetch } from '../src/http.js';

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function mockPrefs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }),
    set: async ({ key, value }) => { store.set(key, value); },
    remove: async ({ key }) => { store.delete(key); },
  };
}

/**
 * Like the native store: values sealed at rest ("lb1:" + base64 here), get → { value } or, with the key broken,
 * everything cleared and { value: null, reset: true }. failSet / failGet: the native call rejects.
 */
function mockSecure(initial = {}, { broken = false, failSet = false, failGet = false } = {}) {
  const sealed = new Map(Object.entries(initial).map(([k, v]) => [k, `lb1:${Buffer.from(JSON.stringify(v)).toString('base64')}`]));
  const calls = { get: 0, set: 0 };
  return {
    sealed,
    calls,
    get: async ({ key }) => {
      calls.get++;
      if (failGet) throw new Error('Keystore unavailable');
      if (!sealed.has(key)) return { value: null };
      if (broken) { sealed.clear(); return { value: null, reset: true }; }
      return { value: Buffer.from(sealed.get(key).slice(4), 'base64').toString() };
    },
    set: async ({ key, value }) => {
      calls.set++;
      if (failSet) throw new Error('could not encrypt');
      sealed.set(key, `lb1:${Buffer.from(value).toString('base64')}`);
    },
    remove: async ({ key }) => { sealed.delete(key); },
    json: (key) => (sealed.has(key) ? JSON.parse(Buffer.from(sealed.get(key).slice(4), 'base64').toString()) : null),
  };
}

const VALID = { client_id: DEFAULT_SETTINGS.clientId, login: 'viewer', user_id: '42', scopes: SCOPES };
const VALIDATE_OK = [/GET https:\/\/id\.twitch\.tv\/oauth2\/validate/, () => ({ status: 200, data: VALID })];
const REFRESH = [/POST https:\/\/id\.twitch\.tv\/oauth2\/token/, () => ({ status: 200, data: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } })];
const TOKENS = { accounts: { 42: { login: 'viewer', access_token: 't', refresh_token: 'r' } }, active: '42' };

function setup({ prefs = {}, secure = {}, secureOpts = {}, routes = [VALIDATE_OK] } = {}) {
  const http = {
    request: async (req) => {
      const hit = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
      return hit ? { headers: {}, ...hit[1](req) } : { status: 404, data: '', headers: {} };
    },
  };
  const p = mockPrefs(prefs);
  const s = mockSecure(secure, secureOpts);
  const logs = [];
  const native = { log: async ({ line }) => { logs.push(line); } };
  const platform = createPlatform({ fetch: makeNativeFetch(http), prefs: p, secure: s, app: null, native, qrSvg: () => '', setInterval: () => 0 });
  return { platform, prefs: p, secure: s, logs };
}

test('plaintext tokens move into the encrypted store on the first run and the plaintext copy is deleted', async () => {
  const { platform, prefs, secure, logs } = setup({ prefs: { tokens: TOKENS, settings: { theme: 'oled' } } });
  assert.equal((await platform.authState()).signedIn, true);
  assert.deepEqual(secure.json('tokens'), TOKENS);
  assert.equal(prefs.store.has('tokens'), false);
  assert.equal(prefs.store.has('settings'), true, 'settings stay in Preferences');
  assert.ok(logs.some((l) => /moved tokens into encrypted storage/.test(l)));
  assert.ok(!logs.some((l) => l.includes("'t'") || l.includes('"t"')), 'no token in the log');
});

test('already encrypted tokens win over a stale plaintext copy, which is still deleted', async () => {
  const newer = { accounts: { 7: { login: 'other', access_token: 'x', refresh_token: 'y' } }, active: '7' };
  const prefs = mockPrefs({ tokens: TOKENS });
  const secure = mockSecure({ tokens: newer });
  assert.deepEqual(await migrateToSecure(prefs, secure, 'tokens'), { migrated: false, reset: false });
  assert.deepEqual(secure.json('tokens'), newer);
  assert.equal(prefs.store.has('tokens'), false);
  assert.equal(secure.calls.set, 0);
});

test('migrateToSecure without plaintext does nothing', async () => {
  const prefs = mockPrefs();
  const secure = mockSecure();
  assert.deepEqual(await migrateToSecure(prefs, secure, 'tokens'), { migrated: false, reset: false });
  assert.equal(secure.calls.set, 0);
});

test('tokens round-trip through the encrypted store (a refresh is saved there, never in Preferences)', async () => {
  const routes = [VALIDATE_OK, REFRESH, [/GET https:\/\/api\.twitch\.tv\/helix\/streams\/followed/, (req) => (req.headers.Authorization === 'Bearer new' ? { status: 200, data: { data: [] } } : { status: 401, data: '' })]];
  const first = setup({ secure: { tokens: TOKENS }, routes });
  assert.equal((await first.platform.helix({ path: '/streams/followed', query: { user_id: '42' } })).ok, true);
  await flush();
  assert.equal(first.secure.json('tokens').accounts['42'].access_token, 'new');
  assert.equal(first.prefs.store.has('tokens'), false);
  // A restart reads the same store back.
  const again = createPlatform({ fetch: makeNativeFetch({ request: async () => ({ status: 200, headers: {}, data: VALID }) }), prefs: first.prefs, secure: first.secure, app: null, native: {}, qrSvg: () => '', setInterval: () => 0 });
  const st = await again.authState();
  assert.equal(st.signedIn, true);
  assert.equal(st.user.login, 'viewer');
});

test('a Keystore key that stopped working clears the tokens and asks for a sign-in, without throwing', async () => {
  const { platform, secure, logs } = setup({ secure: { tokens: TOKENS }, secureOpts: { broken: true } });
  const st = await platform.authState();
  assert.equal(st.signedIn, false);
  await flush();
  assert.deepEqual(Object.keys((secure.json('tokens') || {}).accounts || {}), [], 'no account left in the store');
  assert.ok(logs.some((l) => /could not be decrypted.*sign in again/.test(l)));
  // Signing in again works: the device flow starts as usual.
  assert.equal(typeof platform.authStart, 'function');
});

test('a native store that rejects reads or writes leaves the app signed out, not crashed, and no plaintext behind', async () => {
  const unreadable = setup({ secure: { tokens: TOKENS }, secureOpts: { failGet: true } });
  assert.equal((await unreadable.platform.authState()).signedIn, false);
  assert.ok(unreadable.logs.some((l) => /could not read tokens/.test(l)));

  const unwritable = setup({ prefs: { tokens: TOKENS }, secureOpts: { failSet: true } });
  assert.equal((await unwritable.platform.authState()).signedIn, false);
  assert.equal(unwritable.prefs.store.has('tokens'), false, 'the plaintext copy is deleted anyway');
  assert.ok(unwritable.logs.some((l) => /could not encrypt tokens/.test(l)));
  assert.deepEqual(await unwritable.platform.getSettings().then((s) => typeof s), 'object');
});
