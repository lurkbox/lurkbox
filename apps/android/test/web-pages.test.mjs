// Channel points, follow/unfollow and Drops on Android with a mocked LurkboxNative: the hidden twitch.tv pages
// (page*: hidden-pages.js) and the in-app twitch.tv window (web*), driven through the platform's window.lurkbox members.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createPlatform } from '../src/platform.js';
import { makeNativeFetch } from '../src/http.js';
import { createHiddenPages, asyncStartSource } from '../src/hidden-pages.js';
import { createDrops } from '../src/drops.js';
import { chatPageUrl } from '@lurkbox/core/src/shared/channel-points.js';
import { INVENTORY_URL, scanInventory } from '@lurkbox/core/src/shared/drops.js';
import { documentedMembers } from '@lurkbox/core/src/platform-check.js';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const fast = async () => {};

/**
 * LurkboxNative with web* (a fake CookieManager session) and page* (hidden pages). A page's answers come from
 * respond(kind, source): sync sources directly, async ones (asyncStartSource) through the __lbAsync box, as in the
 * WebView. evaluateJavascript's JSON text is what pageEval resolves.
 */
function mockNative({ signedIn = true, respond = () => null, loadFails = false } = {}) {
  const n = {
    session: signedIn ? { login: 'viewer' } : null, listeners: {}, opens: [], loads: [], current: null,
    pageOpens: [], pageCloses: [], evals: [], boxes: {}, open: new Set(),
    log: async () => {}, proxyAllow: async () => {}, keepScreenOn: async () => {},
    addListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); return Promise.resolve({ remove() {} }); },
    fire(name, data) { for (const fn of this.listeners[name] || []) fn(data); },
    async webOpen(a) { this.opens.push(a); this.current = a.session; },
    async webLoad(a) { this.loads.push(a.url); },
    async webClose() { const s = this.current; this.current = null; if (s) setTimeout(() => this.fire('webClosed', { session: s }), 0); },
    async webStatus() { return this.session ? { signedIn: true, login: this.session.login } : { signedIn: false, login: null }; },
    async webClear() { this.session = null; },
    async webJarSave() { return { saved: true }; },
    async webJarRestore() { return { count: 0 }; },
    async webJarPeek() { return { has: false, login: null }; },
    async webJarRemove() {},
    async webGql() { return { status: 500, data: '' }; },
    async pageOpen(a) {
      this.pageOpens.push(a);
      if (loadFails) throw new Error('load failed (-2)');
      this.open.add(a.kind);
      this.boxes[a.kind] = {};
    },
    async pageClose({ kind }) { this.pageCloses.push(kind); this.open.delete(kind); delete this.boxes[kind]; },
    async pageEval({ kind, source }) {
      this.evals.push({ kind, source });
      if (!this.open.has(kind)) return { json: null };
      const box = this.boxes[kind];
      const start = /const k = "(k\d+)";[\s\S]*?Promise\.resolve\(\)\.then\(\(\) => \(([\s\S]*)\)\)\.then\(\(v\)/.exec(source);
      if (start && source.includes('pending: true };')) {
        const [, key, inner] = start;
        box[key] = { pending: true };
        Promise.resolve().then(() => respond(kind, inner)).then((v) => { if (this.boxes[kind] === box) box[key] = { v: v === undefined ? null : v }; }, (e) => { box[key] = { e: e.message }; });
        return { json: 'true' };
      }
      const poll = /const k = "(k\d+)";\s*const box = window\.__lbAsync;/.exec(source);
      if (poll) {
        const r = box[poll[1]];
        if (!r) return { json: JSON.stringify({ lost: true }) };
        if (r.pending) return { json: JSON.stringify({ pending: true }) };
        delete box[poll[1]];
        return { json: JSON.stringify(r) };
      }
      const v = await respond(kind, source);
      return { json: v === undefined ? 'null' : JSON.stringify(v) };
    },
  };
  return n;
}

function mockPrefs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return { get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }), set: async ({ key, value }) => { store.set(key, value); } };
}

function setup(opts = {}) {
  const native = mockNative(opts);
  const http = { request: async () => ({ status: 404, data: '', headers: {} }) };
  const timers = [];
  const platform = createPlatform({
    fetch: makeNativeFetch(http), prefs: mockPrefs({ settings: opts.settings || {} }), app: null, native, qrSvg: () => '', setInterval: () => 0,
    features: {
      pages: { sleep: fast },
      points: { every: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, stopEvery: () => {}, screenWidth: () => 960 },
      drops: { claimer: { setTimer: () => 0, clearTimer: () => {} } },
      follow: { run: opts.runFollow },
    },
  });
  return { platform, native, timers };
}

// ---- the hidden pages ----

test('hidden pages: async sources are awaited through the page (as evaluateJavascript would see them)', async () => {
  // A real JS context stands in for the page: evaluateJavascript returns the expression's JSON (a Promise is "{}").
  const fresh = () => { const c = vm.createContext({ setTimeout }); vm.runInContext('var window = globalThis;', c); return c; };
  let ctx = fresh();
  const native = {
    pageOpen: async () => {}, pageClose: async () => {},
    pageEval: async ({ source }) => { const v = vm.runInContext(source, ctx); return { json: JSON.stringify(v instanceof Promise || (v && typeof v.then === 'function') ? {} : v === undefined ? null : v) }; },
  };
  const pages = createHiddenPages({ native, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const p = await pages.open('follow', 'https://www.twitch.tv/somechannel');
  assert.deepEqual(await p.eval('(async () => { await new Promise((r) => setTimeout(r, 20)); return { state: "following", n: 41 + 1 }; })()'), { state: 'following', n: 42 });
  await assert.rejects(p.eval('(async () => { throw new Error("nope"); })()'), /nope/);
  assert.equal(await p.evalSync('1 + 2'), 3);
  // The page reloaded (the box is gone) while a source ran: the caller hears about it instead of waiting forever.
  const slow = p.eval('(async () => { await new Promise((r) => setTimeout(r, 50)); return 1; })()');
  ctx = fresh(); // a new document
  await assert.rejects(slow, /page gone/);
  await assert.rejects(p.eval('new Promise(() => {})', { timeoutMs: 20, pollMs: 5 }), /timed out/);
});

test('hidden pages: the async wrapper embeds the key as JSON and the source unchanged', () => {
  const src = asyncStartSource('k1"});alert(1);//', '(async () => 1)()');
  assert.ok(src.includes(JSON.stringify('k1"});alert(1);//')));
  assert.ok(src.includes('(async () => 1)()'));
});

test('hidden pages: a page that does not load is closed and the open fails', async () => {
  const native = mockNative({ loadFails: true });
  const pages = createHiddenPages({ native, sleep: fast });
  await assert.rejects(pages.open('drops', INVENTORY_URL), /load failed/);
  assert.deepEqual(native.pageCloses, ['drops']);
  assert.deepEqual(native.pageOpens[0], { kind: 'drops', url: INVENTORY_URL, width: 1280, height: 900 });
  // Timeout: pageOpen never resolves.
  const stuck = { pageOpen: () => new Promise(() => {}), pageClose: async () => { stuck.closed = true; }, pageEval: async () => ({ json: null }) };
  await assert.rejects(createHiddenPages({ native: stuck }).open('points', chatPageUrl('a'), { timeoutMs: 10 }), /timed out/);
  assert.equal(stuck.closed, true);
});

// ---- the platform members ----

test('platform: with the hidden pages, the points, follow and Drops members are there and documented', async () => {
  const { platform } = setup();
  const dts = fs.readFileSync(require.resolve('@lurkbox/core/src/platform.d.ts'), 'utf8');
  const documented = documentedMembers(dts);
  for (const k of ['watchMinute', 'pointsWatch', 'onPointsState', 'onPointsEvent', 'pointsOpenPanel', 'pointsPad', 'pointsClosePanel', 'followChannel', 'openChannelPage', 'dropsStatus', 'dropsProgress', 'onDropsEvent', 'dropsOpen', 'dropsPad', 'dropsClose']) {
    assert.equal(typeof platform[k], 'function', k);
    assert.ok(documented.has(k), `${k} documented`);
  }
  for (const k of Object.keys(platform)) assert.ok(documented.has(k), `${k} is undocumented`);
  assert.equal(typeof platform.watchMinute, 'function', 'watch-time points with the web session');
  assert.ok(!('pointsMode' in platform), 'the hidden page keeps zoom 1: no pointsMode');
  assert.equal((await platform.appInfo()).hostPages, true);
});

// ---- channel points ----

test('points: the chat page loads hidden, the scan gives the balance, claims and a prediction toast', async () => {
  const scans = [
    { signedIn: true, balanceText: '1,200', claimed: true, prediction: null, poll: null, vw: 340, vh: 720 },
    { signedIn: true, balanceText: '1,250', claimed: false, prediction: 'Prediction · Will they win? 1:30 left', poll: null, vw: 340, vh: 720 },
  ];
  const sources = [];
  const { platform, native, timers } = setup({ respond: (kind, src) => { sources.push(src); return scans.shift() || null; } });
  const states = [];
  const events = [];
  platform.onPointsState((s) => states.push(s));
  platform.onPointsEvent((e) => events.push(e));
  await platform.pointsWatch('SomeChannel');
  await flush();
  assert.deepEqual(native.pageOpens[0], { kind: 'points', url: 'https://www.twitch.tv/embed/somechannel/chat?parent=localhost&darkpopout', width: 340, height: 720 });
  assert.equal(timers[0].ms, 4000);
  assert.ok(sources[0].includes('copo-balance-string') && sources[0].includes('if (true)'), 'the shared scan source with auto-claim on');
  assert.deepEqual(states.at(-1), { login: 'somechannel', signedIn: true, balance: 1200, prediction: null, poll: null });
  timers[0].fn();
  await flush();
  assert.equal(states.at(-1).balance, 1250);
  assert.deepEqual(events, [{ login: 'somechannel', type: 'prediction', title: 'Will they win?' }]);
  assert.equal(native.pageOpens.length, 1, 'the page is loaded once per channel');
  // The same channel again: nothing reloads. Another channel, then none: the page goes.
  await platform.pointsWatch('somechannel');
  assert.equal(native.pageOpens.length, 1);
  await platform.pointsWatch(null);
  assert.deepEqual(native.pageCloses, ['points']);
  await platform.pointsWatch('bad login!');
  assert.equal(native.pageOpens.length, 1);
});

test('points: auto-claim off goes into the scan source; no twitch.tv session loads nothing', async () => {
  const sources = [];
  const off = setup({ settings: { autoClaimPoints: false }, respond: (kind, src) => { sources.push(src); return { signedIn: true, balanceText: '5' }; } });
  await off.platform.pointsWatch('a');
  await flush();
  assert.ok(sources[0].includes('if (false)'));

  const { platform, native } = setup({ signedIn: false });
  const states = [];
  platform.onPointsState((s) => states.push(s));
  await platform.pointsWatch('a');
  await flush();
  assert.equal(native.pageOpens.length, 0);
  assert.deepEqual(states.at(-1), { login: 'a', signedIn: false, balance: null });
  assert.deepEqual(await platform.pointsOpenPanel({ rewards: true }), { ok: false, reason: 'not signed in to twitch.tv' });
});

test('points: the rewards view opens the chat page in the twitch.tv window; closing it tells the core', async () => {
  const { platform, native } = setup({ settings: { twitchChatSize: 250 }, respond: () => ({ signedIn: true, balanceText: '1' }) });
  const events = [];
  platform.onPointsEvent((e) => events.push(e));
  assert.deepEqual(await platform.pointsOpenPanel({ rewards: true }), { ok: false, reason: 'chat not loaded' });
  await platform.pointsWatch('a');
  await flush();
  assert.deepEqual(await platform.pointsOpenPanel({ rewards: true }), { ok: true, opened: true });
  await flush();
  const o = native.opens[0];
  assert.equal(o.url, chatPageUrl('a'));
  assert.equal(o.zoom, 2.4, '2.5 lowered so 960 CSS px keep a 400 px layout');
  assert.ok(o.script.includes('__lbRewardsView') && o.script.includes('reward-center') && o.script.includes('__lbNav'), 'opens, fits and navigates the popover');
  assert.ok(o.textScript.includes('BALANCE_BUTTON'), 'B out of a message box goes back to the rewards');
  assert.equal(await platform.pointsPad('b'), 'close');
  // The user pressed BACK in the window (native): the core hears 'panel-closed'.
  await native.webClose();
  await flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events.at(-1), { login: 'a', type: 'panel-closed' });
  // Predictions: no popover, and no text script.
  await platform.pointsOpenPanel({ rewards: false });
  assert.ok(native.opens[1].script.includes('if (false)'));
  assert.equal(native.opens[1].textScript, '');
  await platform.pointsClosePanel();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(native.current, null);
});

// ---- follow / unfollow ----

test('follow: Twitch\'s button on the hidden channel page, confirmed by the flip', async () => {
  const seen = [];
  const { platform, native } = setup({
    respond: (kind, src) => {
      seen.push(src);
      if (!/const ACT = "(follow|unfollow)"/.test(src)) return { state: native.following ? 'following' : 'not-following', clicked: false, flipped: false };
      native.following = /const ACT = "follow"/.test(src);
      return { state: native.following ? 'following' : 'not-following', clicked: true, flipped: true };
    },
  });
  assert.deepEqual(await platform.followChannel({ login: 'SomeChannel', name: 'SomeChannel', action: 'follow' }), { ok: true, following: true });
  assert.deepEqual(native.pageOpens[0], { kind: 'follow', url: 'https://www.twitch.tv/somechannel', width: 1280, height: 900 });
  assert.ok(seen.some((s) => s.includes('const LOGIN = "somechannel"')), 'the shared page source, the login as JSON');
  assert.deepEqual(native.pageCloses, ['follow'], 'the page is closed after the action');
  assert.deepEqual(await platform.followChannel({ login: 'somechannel', action: 'unfollow' }), { ok: false, reason: 'invalid' }, 'unfollow needs the confirmation');
  assert.deepEqual(await platform.followChannel({ login: 'somechannel', action: 'unfollow', confirmed: true }), { ok: true, following: false });
  assert.deepEqual(await platform.followChannel({ login: 'x y', action: 'follow' }), { ok: false, reason: 'invalid' });
});

test('follow: no session, busy, and the "open on twitch.tv" window', async () => {
  const out = setup({ signedIn: false });
  assert.deepEqual(await out.platform.followChannel({ login: 'a', action: 'follow' }), { ok: false, reason: 'no-session' });
  assert.equal(out.native.pageOpens.length, 0);

  let release;
  const { platform, native } = setup({ runFollow: () => new Promise((r) => { release = r; }) });
  const first = platform.followChannel({ login: 'a', action: 'follow' });
  await flush();
  assert.deepEqual(await platform.followChannel({ login: 'a', action: 'follow' }), { ok: false, reason: 'busy' });
  release({ ok: true, following: true });
  assert.deepEqual(await first, { ok: true, following: true });

  assert.equal(await platform.openChannelPage('not a login'), false);
  const opened = platform.openChannelPage('SomeChannel');
  await flush();
  assert.equal(native.opens[0].url, 'https://www.twitch.tv/somechannel');
  assert.ok(native.opens[0].script.includes('__lbNav'));
  let done = false;
  opened.then(() => { done = true; });
  await flush();
  assert.equal(done, false, 'resolves only when the window closes');
  await native.webClose();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await opened, true);
});

// ---- Drops ----

test('Drops: the inventory opens in the twitch.tv window with the controller navigation', async () => {
  const { platform, native } = setup();
  const events = [];
  platform.onDropsEvent((e) => events.push(e));
  const st = await platform.dropsStatus();
  assert.equal(st.signedIn, true);
  assert.deepEqual(await platform.dropsOpen(), { ok: true });
  await flush();
  assert.equal(native.opens[0].url, INVENTORY_URL);
  assert.ok(native.opens[0].script.includes('"domFocus":false') && native.opens[0].script.includes('BACK: close'));
  assert.deepEqual(await platform.dropsOpen(), { ok: true }, 'already open: nothing new');
  assert.equal(native.opens.length, 1);
  assert.equal(await platform.dropsPad('b'), 'close');
  await native.webClose();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events, [{ type: 'closed' }]);
  const out = setup({ signedIn: false });
  assert.deepEqual(await out.platform.dropsOpen(), { ok: false, reason: 'not signed in to twitch.tv' });
});

test('Drops: auto-claim runs the shared scan in the hidden inventory page on the desktop schedule', async () => {
  const native = mockNative({
    respond: (kind, src) => (src.includes('if (true)')
      ? { state: 'ready', campaigns: [{ game: 'G', name: 'C', drops: [{ name: 'Hat', percent: 100, claimable: true }, { name: 'Cape', percent: 40, claimable: false }] }], claimed: [{ name: 'Hat', confirmed: true }] }
      : { state: 'ready', campaigns: [], claimed: [] }),
  });
  const pages = createHiddenPages({ native, sleep: fast });
  const timers = [];
  let t = 1_000_000;
  const emitted = [];
  const lines = [];
  let settings = {};
  let web = { signedIn: true };
  const d = createDrops({
    pages, web: { status: async () => web }, getSettings: () => settings, emit: (n, e) => emitted.push([n, e]), log: (l) => lines.push(l),
    scan: (a) => scanInventory({ ...a, sleep: fast }),
    claimer: { setTimer: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {}, now: () => t },
  });
  d.start();
  assert.deepEqual(timers, [60000], 'first check one minute after start');
  assert.deepEqual(await d.claimer.tick(), { ok: true, claimed: ['Hat'] });
  assert.deepEqual(native.pageOpens[0], { kind: 'drops', url: INVENTORY_URL, width: 1280, height: 900 });
  assert.deepEqual(native.pageCloses, ['drops']);
  assert.deepEqual(emitted, [['drops:event', { type: 'claimed', name: 'Hat' }]]);
  assert.equal(timers.at(-1), 15 * 60000, 'then every 15 min');
  assert.equal((await d.progress()).campaigns[0].drops[1].name, 'Cape');
  assert.equal((await d.status()).lastCheckAt, t);
  // Never twice within 5 minutes.
  t += 60000;
  assert.deepEqual(await d.claimer.tick(), { skipped: 'rate' });
  // Off, or no session: nothing loads.
  t += 10 * 60000;
  settings = { autoClaimDrops: false };
  assert.deepEqual(await d.claimer.tick(), { skipped: 'off' });
  settings = {};
  web = { signedIn: false };
  assert.deepEqual(await d.claimer.tick(), { skipped: 'no-session' });
  assert.equal(native.pageOpens.length, 1);
  // A page that does not load: backoff (30 min after one failure).
  web = { signedIn: true };
  native.pageOpen = async () => { throw new Error('load failed (-2)'); };
  const r = await d.claimer.tick();
  assert.match(r.error, /load failed/);
  assert.equal(timers.at(-1), 30 * 60000);
  assert.ok(lines.every((l) => !/auth-token|OAuth/i.test(l)));
});

// ---- watch-time points (shared/watch-minutes.js over native HTTP) ----

test('watch minutes: the desktop gate, the minute-watched requests, and no auth-token in page requests', async () => {
  const native = mockNative();
  const reqs = [];
  const http = {
    request: async (r) => {
      reqs.push(r);
      if (r.url === 'https://x.ttvnw.net/low.m3u8') return { status: 200, data: '#EXTM3U\n#EXTINF:2,\nseg9.ts\n', headers: {} };
      if (r.url === 'https://x.ttvnw.net/seg9.ts') return { status: 200, data: '', headers: {} };
      if (r.url === 'https://www.twitch.tv/somechannel') return { status: 200, data: '<script src="https://static.twitchcdn.net/config/settings.abc.js"></script>', headers: {} };
      if (r.url === 'https://static.twitchcdn.net/config/settings.abc.js') return { status: 200, data: '{"spade_url":"https://spade.twitch.tv/track"}', headers: {} };
      if (r.url === 'https://spade.twitch.tv/track') return { status: 204, data: '', headers: {} };
      return { status: 404, data: '', headers: {} };
    },
  };
  const masters = [];
  let settings = {};
  const make = () => createPlatform({
    fetch: makeNativeFetch(http), app: null, native, qrSvg: () => '', setInterval: () => 0,
    prefs: mockPrefs({ settings, tokens: { accounts: { 42: { login: 'viewer', access_token: 't', refresh_token: 'r' } }, active: '42' } }),
    features: { pages: { sleep: fast }, points: { every: () => 0, stopEvery: () => {} }, drops: { claimer: { setTimer: () => 0, clearTimer: () => {} } },
      watchMinutes: { master: async (login) => { masters.push(login); return { ok: true, authed: true, master: '#EXTM3U\nhttps://x.ttvnw.net/high.m3u8\nhttps://x.ttvnw.net/low.m3u8\n' }; } } },
  });
  let platform = make();
  const minute = { login: 'SomeChannel', channelId: '12', broadcastId: '34', direct: true, live: true, rewound: false, playing: true };
  const r = await platform.watchMinute(minute);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(masters, ['somechannel']);
  const spade = reqs.find((x) => x.url === 'https://spade.twitch.tv/track');
  assert.equal(spade.method, 'POST');
  const events = JSON.parse(Buffer.from(decodeURIComponent(String(spade.data).slice(5)), 'base64').toString('utf8'));
  assert.deepEqual(events[0].properties, { channel_id: '12', broadcast_id: '34', player: 'site', user_id: '42', live: true, channel: 'somechannel' });
  assert.equal(reqs.find((x) => x.url.endsWith('seg9.ts')).method, 'HEAD');
  for (const x of reqs.filter((q) => !/^https:\/\/(id\.twitch\.tv|api\.twitch\.tv)\//.test(q.url))) assert.ok(!Object.keys(x.headers).some((k) => /authorization|cookie/i.test(k)), `no session sent to ${x.url}`);
  // The gate: rewound, paused, another account's session, the setting off, a bad request.
  assert.equal((await platform.watchMinute({ ...minute, rewound: true })).reason, 'rewound');
  assert.equal((await platform.watchMinute({ ...minute, playing: false })).reason, 'not playing');
  assert.equal((await platform.watchMinute({ ...minute, channelId: 'x' })).reason, 'bad request');
  native.session = { login: 'someoneelse' };
  assert.equal((await platform.watchMinute(minute)).reason, 'twitch.tv session is another account');
  native.session = null;
  assert.equal((await platform.watchMinute(minute)).reason, 'no twitch.tv session');
  native.session = { login: 'viewer' };
  settings = { earnWatchPoints: false };
  platform = make();
  assert.equal((await platform.watchMinute(minute)).reason, 'setting off');
});

test('watch minutes: in the background for more than 5 minutes, no reports', async () => {
  const native = mockNative();
  let stateCb = null;
  const app = { addListener: (name, fn) => { if (name === 'appStateChange') stateCb = fn; return Promise.resolve({ remove() {} }); } };
  const platform = createPlatform({
    fetch: makeNativeFetch({ request: async () => ({ status: 404, data: '', headers: {} }) }), app, native, qrSvg: () => '', setInterval: () => 0,
    prefs: mockPrefs({ tokens: { accounts: { 42: { login: 'viewer', access_token: 't', refresh_token: 'r' } }, active: '42' } }),
    features: { pages: { sleep: fast }, points: { every: () => 0, stopEvery: () => {} }, drops: { claimer: { setTimer: () => 0, clearTimer: () => {} } } },
  });
  const realNow = Date.now;
  try {
    let now = 1_000_000;
    Date.now = () => now;
    stateCb({ isActive: false });
    now += 6 * 60 * 1000;
    const r = await platform.watchMinute({ login: 'somechannel', channelId: '12', broadcastId: '34', direct: true, live: true, rewound: false, playing: true });
    assert.equal(r.reason, 'hidden for more than 5 min');
  } finally { Date.now = realNow; }
});

// ---- predictions and polls ----

const PP = await import('@lurkbox/core/src/shared/predictions.js');

test('predictions: native webGql allows exactly the shared read query (and PlaybackAccessToken), nothing else', () => {
  const java = fs.readFileSync(new URL('../android/app/src/main/java/io/github/lurkbox/Lurkbox/LurkboxNativePlugin.java', import.meta.url), 'utf8');
  const m = /static final String PREDICTIONS_QUERY = (".*");/.exec(java);
  assert.ok(m, 'PREDICTIONS_QUERY in LurkboxNativePlugin.java');
  assert.equal(JSON.parse(m[1]), PP.PP_QUERY, 'the Java copy of the query matches shared/predictions.js');
  assert.match(java, /"LurkboxPredictionsPolls"\.equals\(op\) && PREDICTIONS_QUERY\.equals\(o\.optString\("query"\)\)/);
});

test('predictions: read through native webGql with the session; a bet and a vote press the buttons in the hidden chat page', async () => {
  const answer = {
    data: {
      channel: { activePredictionEvents: [{ id: 'ev', title: 'Win?', status: 'ACTIVE', createdAt: new Date().toISOString(), predictionWindowSeconds: 120, outcomes: [{ id: 'a', title: 'Yes', color: 'BLUE', totalPoints: 10, totalUsers: 1 }, { id: 'b', title: 'No', color: 'PINK', totalPoints: 5, totalUsers: 1 }], self: null }], lockedPredictionEvents: [], resolvedPredictionEvents: { edges: [] } },
      user: { viewablePoll: { id: 'p', title: 'Map?', status: 'ACTIVE', remainingDurationMilliseconds: 30000, choices: [{ id: 'c1', title: 'Dust', votes: { total: 1 } }, { id: 'c2', title: 'Ice', votes: { total: 0 } }], votes: { total: 1 } } },
    },
  };
  const ran = [];
  const { platform, native } = setup({
    respond: (_kind, source) => {
      if (source.includes('outcome not found')) { ran.push('predict'); return { ok: true, step: 'done' }; }
      if (source.includes('no poll choices')) { ran.push('vote'); return { ok: true, step: 'done' }; }
      return { signedIn: true, balanceText: '1,000' };
    },
  });
  const gql = [];
  native.webGql = async ({ headers, body }) => { gql.push({ headers, body: JSON.parse(body) }); return { status: 200, data: JSON.stringify(answer) }; };
  const states = [];
  platform.onPredictionsState((s) => states.push(s));
  await platform.pointsWatch('somechannel');
  await platform.predictionsWatch('somechannel');
  await flush();
  const st = states.at(-1);
  assert.equal(st.login, 'somechannel');
  assert.equal(st.prediction.id, 'ev');
  assert.equal(st.poll.id, 'p');
  assert.equal(gql[0].body.operationName, 'LurkboxPredictionsPolls');
  assert.ok(!Object.keys(gql[0].headers).some((k) => k.toLowerCase() === 'authorization'), 'the page never sends the token');
  assert.deepEqual(await platform.predictionBet({ login: 'somechannel', eventId: 'ev', outcomeId: 'b', points: 100 }), { ok: true });
  assert.deepEqual(await platform.pollVote({ login: 'somechannel', pollId: 'p', choiceId: 'c2' }), { ok: true });
  assert.deepEqual(ran, ['predict', 'vote']);
  // Something else than what is open: refused without touching the page.
  assert.equal((await platform.predictionBet({ login: 'somechannel', eventId: 'other', outcomeId: 'b', points: 100 })).ok, false);
  assert.equal((await platform.predictionBet({ login: 'somechannel', eventId: 'ev', outcomeId: 'b', points: 0 })).ok, false);
  assert.equal(ran.length, 2);
  await platform.predictionsWatch(null);
  assert.deepEqual(states.at(-1), { login: null, prediction: null, poll: null });
});

test('predictions: signed out, the read is anonymous and acting says no-session', async () => {
  const { platform, native } = setup({ signedIn: false });
  let gqlCalls = 0;
  native.webGql = async () => { gqlCalls++; return { status: 500, data: '' }; };
  const states = [];
  platform.onPredictionsState((s) => states.push(s));
  await platform.predictionsWatch('somechannel');
  await flush();
  assert.equal(gqlCalls, 0);
  assert.equal(states.at(-1).login, 'somechannel');
  assert.equal((await platform.predictionBet({ login: 'somechannel', eventId: 'x', outcomeId: 'y', points: 5 })).ok, false);
});
