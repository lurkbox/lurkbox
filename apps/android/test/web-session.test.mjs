// The twitch.tv web session on Android (src/web-session.js) with a mocked LurkboxNative: the TV sign-in (the shared
// TvSignIn in the native twitch.tv window), the player session, account switching and the authenticated direct engine.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@lurkbox/core/src/shared/settings.js';
import { LOGIN_URL } from '@lurkbox/core/src/shared/tv-signin.js';
import { createPlatform } from '../src/platform.js';
import { makeNativeFetch } from '../src/http.js';
import { SESSION_TOKEN, mismatchWarning } from '../src/web-session.js';
import { SCOPES } from '@lurkbox/core/src/shared/config.js';

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const USERS = { viewer: '42', alice: '7' };

function mockPrefs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return { store, get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }), set: async ({ key, value }) => { store.set(key, value); } };
}

/** LurkboxNative with the web* methods: a fake CookieManager session ({login} or null) and jars by user id. */
function mockWebNative({ web = null, script = {} } = {}) {
  const n = {
    session: web, jars: new Map(), loads: [], opens: [], gql: [], listeners: {}, authorized: null, cleared: 0,
    log: async () => {}, proxyAllow: async () => {}, keepScreenOn: async () => {},
    addListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); return Promise.resolve({ remove() {} }); },
    fire(name, data) { for (const fn of this.listeners[name] || []) fn(data); },
    async webOpen(a) { this.opens.push(a); this.current = a.session; this.visit(a.url); },
    async webLoad(a) { this.visit(a.url); },
    async webClose() { const s = this.current; this.current = null; if (s) setTimeout(() => this.fire('webClosed', { session: s }), 0); },
    visit(url) {
      this.loads.push(url);
      const stage = url === LOGIN_URL ? 'login' : 'activate';
      if (script.closeAt === stage) { this.webClose(); return; }
      if (stage === 'login') setTimeout(() => { this.session = { login: script.login || 'viewer' }; }, 0);
      else setTimeout(() => { this.authorized = script.authorizeAs || 'viewer'; }, 0);
    },
    async webStatus() { return this.session ? { signedIn: true, login: this.session.login } : { signedIn: false, login: null }; },
    async webClear() { this.session = null; this.cleared++; },
    async webJarSave({ id }) { if (this.session) this.jars.set(id, { ...this.session }); return { saved: !!this.session }; },
    async webJarRestore({ id }) { this.session = this.jars.has(id) ? { ...this.jars.get(id) } : null; return { count: this.session ? 2 : 0 }; },
    async webJarPeek({ id }) { const j = this.jars.get(id); return { has: !!j, login: j ? j.login : null }; },
    async webJarRemove({ id }) { this.jars.delete(id); },
    async webGql(a) {
      this.gql.push(a);
      return { status: 200, data: JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'subtok', signature: 'sig' } } }) };
    },
  };
  return n;
}

function setup({ tokens = {}, web = null, script = {} } = {}) {
  const native = mockWebNative({ web, script });
  const calls = [];
  const http = {
    request: async (req) => {
      calls.push(req);
      const u = req.url;
      const ok = (data) => ({ status: 200, data, headers: {} });
      if (u.includes('/oauth2/device')) return ok({ device_code: 'dc', user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH', expires_in: 1800, interval: 1 });
      if (u.includes('/oauth2/token')) {
        return native.authorized ? ok({ access_token: `at-${native.authorized}`, refresh_token: 'rt', scope: SCOPES, expires_in: 3600 }) : { status: 400, data: { message: 'authorization_pending' }, headers: {} };
      }
      if (u.includes('/oauth2/validate')) {
        const login = String(req.headers.Authorization).replace('OAuth at-', '');
        return USERS[login] ? ok({ client_id: DEFAULT_SETTINGS.clientId, login, user_id: USERS[login], scopes: SCOPES }) : { status: 401, data: {}, headers: {} };
      }
      if (u.includes('/oauth2/revoke')) return ok({});
      if (u.includes('helix/users')) return ok({ data: [] });
      if (u.includes('gql.twitch.tv')) return ok({ data: { streamPlaybackAccessToken: { value: 'anontok', signature: 'sig' } } });
      if (u.includes('usher.ttvnw.net')) return ok('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://video-weaver.fra05.hls.ttvnw.net/v1/playlist/x.m3u8');
      return { status: 404, data: '', headers: {} };
    },
  };
  const prefs = mockPrefs({ tokens });
  const platform = createPlatform({ fetch: makeNativeFetch(http), prefs, app: null, native, qrSvg: () => '', setInterval: () => 0 });
  return { platform, native, calls };
}

async function drive(p) {
  let done = false;
  let out;
  p.then((v) => { done = true; out = v; }, (e) => { done = true; out = e; });
  for (let i = 0; i < 80 && !done; i++) { await flush(); mock.timers.tick(500); }
  await flush();
  assert.ok(done, 'flow did not finish');
  return out;
}

const signedIn = (login) => ({ accounts: { [USERS[login]]: { access_token: `at-${login}`, refresh_token: 'rt', login, scopes: SCOPES } }, active: USERS[login] });

test('with the native twitch.tv window the TV sign-in and the player sign-in are offered', () => {
  const { platform } = setup();
  for (const k of ['tvSignIn', 'playerSessionLogin']) assert.equal(typeof platform[k], 'function', k);
});

test('TV sign-in: twitch.tv login, then the Authorize page in the same window; web session and API are the same user', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { platform, native } = setup();
    const r = await drive(platform.tvSignIn({}));
    assert.deepEqual({ ok: r.ok, id: r.id, login: r.login, plan: r.plan }, { ok: true, id: '42', login: 'viewer', plan: 'full' });
    assert.deepEqual(native.loads, [LOGIN_URL, 'https://www.twitch.tv/activate?device-code=ABCDEFGH']);
    assert.equal(native.opens.length, 1, 'one window for both pages');
    assert.match(native.opens[0].script, /__lbNav/, 'the controller navigation goes in');
    assert.ok(native.opens[0].zoom >= 1);
    assert.equal(native.current, null, 'window closed');
    assert.deepEqual(native.jars.get('42'), { login: 'viewer' }, 'jar saved for the account');
    assert.deepEqual(await platform.playerSessionStatus(), { signedIn: true, login: 'viewer', mismatch: null });
    assert.deepEqual(await platform.accountsStatus(), [{ id: '42', api: true, player: true, playerLogin: 'viewer' }]);
  } finally { mock.timers.reset(); }
});

test('TV sign-in: closing the window at the login cancels', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { platform } = setup({ script: { closeAt: 'login' } });
    const r = await drive(platform.tvSignIn({}));
    assert.deepEqual(r, { ok: false, cancelled: true });
  } finally { mock.timers.reset(); }
});

test('TV sign-in: a different twitch.tv user than the authorized one signs both out', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { platform, native } = setup({ script: { login: 'alice', authorizeAs: 'viewer' } });
    const r = await drive(platform.tvSignIn({}));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'mismatch');
    assert.equal(native.session, null);
  } finally { mock.timers.reset(); }
});

test('player sign-in alone saves the active account\'s jar; sign-out clears the session', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { platform, native } = setup({ tokens: signedIn('viewer') });
    const r = await drive(platform.playerSessionLogin());
    assert.equal(r.ok, true);
    assert.equal(r.signedIn, true);
    assert.equal(r.login, 'viewer');
    assert.deepEqual(native.jars.get('42'), { login: 'viewer' });
    assert.deepEqual(await platform.playerSessionSignOut(), { signedIn: false, login: null, mismatch: null });
  } finally { mock.timers.reset(); }
});

test('mismatch warning, and a signed-out account\'s jar goes with it', async () => {
  assert.equal(mismatchWarning('viewer', 'Viewer'), null);
  assert.match(mismatchWarning('alice', 'viewer'), /signed in as alice/);
  const { platform, native } = setup({ tokens: signedIn('viewer'), web: { login: 'viewer' } });
  native.jars.set('42', { login: 'viewer' });
  await platform.signOut('42');
  assert.equal(native.session, null);
  assert.equal(native.jars.has('42'), false);
});

test('direct engine: signed in to twitch.tv, the token request goes through native webGql without the token in the page', async () => {
  const { platform, native, calls } = setup({ web: { login: 'viewer' } });
  const r = await platform.directMaster({ login: 'somebody' });
  assert.equal(r.ok, true);
  assert.equal(r.authed, true);
  assert.equal(native.gql.length, 1);
  const g = native.gql[0];
  assert.equal(JSON.parse(g.body).operationName, 'PlaybackAccessToken');
  assert.ok(!Object.keys(g.headers).some((k) => k.toLowerCase() === 'authorization'), 'no Authorization from the page');
  assert.ok(!JSON.stringify(g).includes(SESSION_TOKEN));
  assert.ok(!calls.some((c) => c.url.includes('gql.twitch.tv')), 'no GQL over the page-side HTTP');
  assert.match(calls.find((c) => c.url.includes('usher')).url, /token=subtok/);
});

test('direct engine: without a twitch.tv session it stays anonymous', async () => {
  const { platform, native, calls } = setup();
  const r = await platform.directMaster({ login: 'somebody' });
  assert.equal(r.ok, true);
  assert.equal(r.authed, false);
  assert.equal(native.gql.length, 0);
  assert.ok(!calls.find((c) => c.url.includes('gql.twitch.tv')).headers.Authorization);
});
