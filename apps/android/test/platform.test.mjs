import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { documentedMembers } from '@lurkbox/core/src/platform-check.js';
import { DEFAULT_SETTINGS } from '@lurkbox/core/src/shared/settings.js';
import { createPlatform, PROXY_PREFIX, PrefValue, ResumePositions } from '../src/platform.js';
import { makeNativeFetch, toNativeRequest } from '../src/http.js';
import { installBackButton, pressBack } from '../src/input.js';
import { installKeepScreenOn } from '../src/playback.js';

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// ---- mocked Capacitor plugins ----

function mockPrefs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }),
    set: async ({ key, value }) => { store.set(key, value); },
    json: (key) => JSON.parse(store.get(key) || 'null'),
  };
}

/** CapacitorHttp.request mock: routes = [[RegExp on "METHOD url", (req) => ({ status, data, headers })]]. */
function mockHttp(routes) {
  const calls = [];
  return {
    calls,
    request: async (req) => {
      calls.push(req);
      const hit = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
      if (!hit) return { status: 404, data: '', headers: {} };
      return { headers: {}, ...hit[1](req) };
    },
  };
}

function mockApp() {
  const listeners = {};
  return {
    listeners,
    exited: 0,
    addListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return { remove() {} }; },
    fire(name, data) { for (const fn of listeners[name] || []) fn(data); },
    async exitApp() { this.exited++; },
  };
}

function mockNative() {
  const calls = { log: [], proxyAllow: [], keepScreenOn: [] };
  return {
    calls,
    log: async (a) => { calls.log.push(a.line); },
    proxyAllow: async (a) => { calls.proxyAllow.push(a.hosts); },
    keepScreenOn: async (a) => { calls.keepScreenOn.push(a.on); },
  };
}

function setup({ routes = [], prefs = {} } = {}) {
  const http = mockHttp(routes);
  const p = mockPrefs(prefs);
  const app = mockApp();
  const native = mockNative();
  const platform = createPlatform({ fetch: makeNativeFetch(http), prefs: p, app, native, qrSvg: (t) => `<svg data-text="${t}"/>`, version: '9.9.9', setInterval: () => 0 });
  return { platform, http, prefs: p, app, native };
}

const VALIDATE_OK = [/GET https:\/\/id\.twitch\.tv\/oauth2\/validate/, () => ({ status: 200, data: { client_id: DEFAULT_SETTINGS.clientId, login: 'viewer', user_id: '42', scopes: [] } })];

// ---- the interface ----

test('the Android platform exposes every required member of platform.d.ts and nothing undocumented', () => {
  const core = path.dirname(createRequire(import.meta.url).resolve('@lurkbox/core/package.json'));
  const dts = fs.readFileSync(path.join(core, 'src', 'platform.d.ts'), 'utf8');
  const documented = documentedMembers(dts);
  const body = dts.slice(dts.indexOf('interface LurkboxPlatform {'));
  const optional = new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\?\s*[(:<]/gm)].map((m) => m[1]));
  const { platform } = setup();
  const exposed = new Set(Object.keys(platform));
  assert.deepEqual([...exposed].filter((k) => !documented.has(k)).sort(), [], 'exposed but not documented');
  assert.deepEqual([...documented].filter((k) => !optional.has(k) && !exposed.has(k)).sort(), [], 'required but missing');
  for (const k of exposed) assert.equal(typeof platform[k], 'function', k);
  // Desktop-only and web-session features are left out, so the core hides them.
  for (const k of ['tvSignIn', 'playerSessionLogin', 'steamArtApply', 'steamArtRestore', 'dropsStatus', 'followChannel', 'openOnScreenKeyboard', 'onJoydevPad', 'pointsWatch', 'chatExtensionsStatus']) {
    assert.ok(!exposed.has(k), `${k} should be left out on Android`);
  }
});

test('appInfo, unavailable features and quit', async () => {
  const { platform, app } = setup();
  const info = await platform.appInfo();
  assert.equal(info.version, '9.9.9');
  assert.equal(info.gamescope, false);
  assert.deepEqual(info.defaults, DEFAULT_SETTINGS);
  assert.deepEqual(await platform.dropsOpen(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await platform.pointsOpenPanel({}), { ok: false, reason: 'unavailable' });
  assert.equal(await platform.dropsPad('b'), 'close');
  assert.equal(await platform.dismissPlayerGate(), '');
  assert.deepEqual(await platform.playerSessionStatus(), { signedIn: false, login: null, mismatch: null });
  assert.equal(await platform.openReady(), null);
  assert.match(await platform.qrSvg('https://www.twitch.tv/activate'), /data-text="https:\/\/www.twitch.tv\/activate"/);
  await platform.quit();
  assert.equal(app.exited, 1);
});

// ---- Preferences ----

test('settings: defaults, sanitised patches saved to Preferences, change events', async () => {
  const { platform, prefs } = setup({ prefs: { settings: { theme: 'oled' } } });
  const s = await platform.getSettings();
  assert.equal(s.theme, 'oled');
  assert.equal(s.clientId, DEFAULT_SETTINGS.clientId);
  const seen = [];
  const off = platform.onSettingsChanged((x) => seen.push(x.theme));
  const next = await platform.setSettings({ theme: 'daylight', notASetting: 1 });
  assert.equal(next.theme, 'daylight');
  assert.ok(!('notASetting' in next));
  await flush();
  assert.equal(prefs.json('settings').theme, 'daylight');
  off();
  await platform.setSettings({ theme: 'oled' });
  assert.deepEqual(seen, ['daylight']);
});

test('a new Client ID clears the saved tokens', async () => {
  const { platform, prefs } = setup({ routes: [VALIDATE_OK], prefs: { tokens: { accounts: { 42: { login: 'viewer', access_token: 't', refresh_token: 'r' } }, active: '42' } } });
  assert.equal((await platform.authState()).signedIn, true);
  await platform.setSettings({ clientId: 'abc123' });
  await flush();
  assert.deepEqual(prefs.json('tokens').accounts, {});
  assert.equal((await platform.authState()).signedIn, false);
});

test('PrefValue and ResumePositions keep the desktop shapes', async () => {
  const prefs = mockPrefs();
  const v = await new PrefValue(prefs, 'resume', { accounts: {} }).load();
  const r = new ResumePositions(v, { now: () => 5, max: 2 });
  assert.equal(r.set('42', '100', 61.4, 3600), true);
  assert.deepEqual(r.get('42', '100'), { position: 61, duration: 3600, at: 5 });
  assert.equal(r.get('7', '100'), null);
  assert.equal(r.set('42', 'nope', 1), false);
  r.set('42', '100', 0);
  assert.equal(r.get('42', '100'), null);
  await v.saving;
  assert.deepEqual(JSON.parse(prefs.store.get('resume')), { accounts: { 42: {} } });
});

// ---- HTTP (CapacitorHttp) ----

test('toNativeRequest: forms, JSON and text bodies', () => {
  const form = toNativeRequest(new URL('https://id.twitch.tv/oauth2/device'), { method: 'post', body: new URLSearchParams({ client_id: 'c', scopes: 'a b' }) });
  assert.equal(form.url, 'https://id.twitch.tv/oauth2/device');
  assert.equal(form.method, 'POST');
  assert.equal(form.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form.data, { client_id: 'c', scopes: 'a b' });
  const json = toNativeRequest('https://api.twitch.tv/helix/chat/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"hi"}' });
  assert.deepEqual(json.data, { message: 'hi' });
  const gql = toNativeRequest('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '{"query":"x"}' });
  assert.equal(gql.data, '{"query":"x"}');
  assert.equal(toNativeRequest('https://x.test/').data, undefined);
});

test('makeNativeFetch: status, headers, text() and json() whether the data came back parsed or not', async () => {
  const f = makeNativeFetch({ request: async (r) => (r.url.endsWith('/obj')
    ? { status: 200, data: { a: 1 }, headers: { 'Ratelimit-Reset': '99' } }
    : { status: 429, data: '{"b":2}', headers: {} }) });
  const a = await f('https://x.test/obj');
  assert.equal(a.ok, true);
  assert.equal(a.headers.get('ratelimit-reset'), '99');
  assert.deepEqual(await a.json(), { a: 1 });
  assert.equal(await a.text(), '{"a":1}');
  const b = await f('https://x.test/str');
  assert.equal(b.ok, false);
  assert.equal(b.status, 429);
  assert.deepEqual(await b.json(), { b: 2 });
  assert.equal(b.headers.get('nope'), null);
});

// ---- sign-in and Helix ----

test('the phone sign-in (device code) goes through native HTTP and reports the code', async () => {
  const { platform, http } = setup({ routes: [[/POST https:\/\/id\.twitch\.tv\/oauth2\/device/, () => ({ status: 200, data: { device_code: 'dc', user_code: 'ABCD1234', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD1234', expires_in: 1800, interval: 5 } })]] });
  const states = [];
  platform.onAuthState((s) => states.push(s));
  const r = await platform.authStart();
  assert.equal(r.ok, true);
  assert.equal(r.flow.userCode, 'ABCD1234');
  const req = http.calls.find((c) => c.url.endsWith('/device'));
  assert.equal(req.data.client_id, DEFAULT_SETTINGS.clientId);
  assert.ok(states.some((s) => s.deviceFlow && s.deviceFlow.userCode === 'ABCD1234'));
  await platform.authCancel();
  assert.equal((await platform.authState()).deviceFlow, null);
});

test('helix calls carry the token, refresh on 401 and report errors in the documented shape', async () => {
  let helixCalls = 0;
  const { platform, prefs } = setup({
    prefs: { tokens: { accounts: { 42: { login: 'viewer', access_token: 'old', refresh_token: 'rt' } }, active: '42' } },
    routes: [
      VALIDATE_OK,
      [/POST https:\/\/id\.twitch\.tv\/oauth2\/token/, () => ({ status: 200, data: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } })],
      [/GET https:\/\/api\.twitch\.tv\/helix\/streams\/followed/, (req) => { helixCalls++; return req.headers.Authorization === 'Bearer new' ? { status: 200, data: { data: [{ user_login: 'a' }] } } : { status: 401, data: '' }; }],
      [/GET https:\/\/api\.twitch\.tv\/helix\/users\?/, () => ({ status: 200, data: { data: [] } })],
      [/POST https:\/\/api\.twitch\.tv\/helix\/chat\/messages/, () => ({ status: 429, data: { message: 'Too Many Requests' }, headers: { 'Ratelimit-Reset': '1700000000' } })],
    ],
  });
  const r = await platform.helix({ path: '/streams/followed', query: { user_id: '42', first: 100 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.data, [{ user_login: 'a' }]);
  assert.equal(helixCalls, 2);
  await flush();
  assert.equal(prefs.json('tokens').accounts['42'].access_token, 'new');
  const e = await platform.helix({ path: '/chat/messages', method: 'POST', body: { message: 'hi' } });
  assert.equal(e.ok, false);
  assert.equal(e.status, 429);
  assert.equal(e.resetAt, '1700000000');
});

// ---- App events ----

test('app pause/resume drives onWindowFocus', async () => {
  const { platform, app } = setup();
  const seen = [];
  const off = platform.onWindowFocus((f) => seen.push(f));
  app.fire('appStateChange', { isActive: false });
  app.fire('appStateChange', { isActive: true });
  off();
  app.fire('appStateChange', { isActive: false });
  assert.deepEqual(seen, [false, true]);
});

test('Android BACK becomes the core\'s B (Escape), never an app exit', () => {
  const app = mockApp();
  const events = [];
  class KeyboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const win = { KeyboardEvent, dispatchEvent: (e) => events.push(`${e.type}:${e.key}`) };
  installBackButton(app, win);
  app.fire('backButton', { canGoBack: false });
  assert.deepEqual(events, ['keydown:Escape', 'keyup:Escape']);
  assert.equal(app.exited, 0);
  pressBack(win);
  assert.equal(events.length, 4);
});

test('keep the screen on only while a video plays', () => {
  const native = mockNative();
  const listeners = {};
  const videos = [{ paused: true, ended: false }];
  const doc = { querySelectorAll: () => videos, addEventListener: (e, fn) => { listeners[e] = fn; }, removeEventListener() {} };
  installKeepScreenOn(doc, native);
  videos[0].paused = false;
  listeners.playing();
  listeners.playing();
  videos[0].paused = true;
  listeners.pause();
  assert.deepEqual(native.calls.keepScreenOn, [true, false]);
});

// ---- direct engine and the HLS proxy ----

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080',
  'https://d1m7jfoe9zdc1j.cloudfront.net/abc_v/chunked/index-dvr.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360',
  'https://video-weaver.fra05.hls.ttvnw.net/v1/playlist/xyz.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1',
  'https://evil.example.com/x.m3u8',
].join('\n');

test('directMaster: token and usher through native HTTP, playlists pointed at the same-origin proxy', async () => {
  const { platform, native, http } = setup({ routes: [
    [/POST https:\/\/gql\.twitch\.tv\/gql/, () => ({ status: 200, data: { data: { videoPlaybackAccessToken: { value: 'tok', signature: 'sig' } } } })],
    [/GET https:\/\/usher\.ttvnw\.net\/vod\/123\.m3u8/, () => ({ status: 200, data: MASTER })],
  ] });
  const r = await platform.directMaster({ vodId: '123', codecs: ['h264', 'bogus'] });
  assert.equal(r.ok, true);
  assert.equal(r.authed, false);
  const lines = r.master.split('\n');
  assert.ok(lines.includes(`${PROXY_PREFIX}d1m7jfoe9zdc1j.cloudfront.net/abc_v/chunked/index-dvr.m3u8`));
  assert.ok(lines.includes(`${PROXY_PREFIX}video-weaver.fra05.hls.ttvnw.net/v1/playlist/xyz.m3u8`));
  assert.ok(lines.includes('https://evil.example.com/x.m3u8'), 'other hosts are left alone');
  assert.deepEqual(native.calls.proxyAllow, [['d1m7jfoe9zdc1j.cloudfront.net']]);
  const usher = http.calls.find((c) => c.url.includes('usher'));
  assert.match(usher.url, /supported_codecs=h264(&|$)/);
  assert.deepEqual(await platform.directMaster({ login: 'bad login!' }), { ok: false, reason: 'bad request' });
});

test('directMaster: an offline channel', async () => {
  const { platform } = setup({ routes: [
    [/POST https:\/\/gql\.twitch\.tv\/gql/, () => ({ status: 200, data: { data: { streamPlaybackAccessToken: { value: 'tok', signature: 'sig' } } } })],
    [/GET https:\/\/usher\.ttvnw\.net\/api\/channel\/hls\/somebody\.m3u8/, () => ({ status: 404, data: '' })],
  ] });
  assert.deepEqual(await platform.directMaster({ login: 'somebody' }), { ok: false, reason: 'offline', offline: true });
});

test('clipSources and liveInfo use the shared GQL helpers over native HTTP', async () => {
  const { platform } = setup({ routes: [
    [/POST https:\/\/gql\.twitch\.tv\/gql/, (req) => (String(req.data).includes('VideoAccessToken_Clip')
      ? { status: 200, data: { data: { clip: { id: '1', playbackAccessToken: { signature: 's', value: 'v' }, videoQualities: [{ quality: '720', frameRate: 30, sourceURL: 'https://production.assets.clips.twitchcdn.net/x.mp4' }] } } } }
      : { status: 200, data: { data: { user: { id: '9', stream: null } } } })],
  ] });
  const c = await platform.clipSources('SomeClip-abc');
  assert.equal(c.ok, true);
  assert.match(c.qualities[0].url, /sig=s&token=v$/);
  assert.deepEqual(await platform.liveInfo('somebody'), { stream: null, archive: null });
  assert.equal(await platform.liveInfo('bad login!'), null);
});

test('log never throws and goes to the native log', async () => {
  const { platform, native } = setup();
  platform.log('[test] hello');
  await flush();
  assert.deepEqual(native.calls.log, ['[test] hello']);
  const broken = createPlatform({ fetch: async () => { throw new Error('x'); }, prefs: mockPrefs(), app: mockApp(), native: { log: () => { throw new Error('boom'); } }, qrSvg: () => '', setInterval: () => 0 });
  assert.doesNotThrow(() => broken.log('x'));
});
