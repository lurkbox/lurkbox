// Demo mode (README screenshots): the fake data behind the Helix seam and the renderer's fake network. Every test
// here runs with fetch and WebSocket replaced by functions that throw, so any real network use fails the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
const netCalls = [];
before(() => {
  globalThis.fetch = (...a) => { netCalls.push(['fetch', String(a[0])]); throw new Error(`network fetch in a demo test: ${a[0]}`); };
  globalThis.WebSocket = class { constructor(url) { netCalls.push(['ws', String(url)]); throw new Error(`network WebSocket in a demo test: ${url}`); } };
});
after(() => {
  globalThis.fetch = real.fetch;
  globalThis.WebSocket = real.WebSocket;
  assert.deepEqual(netCalls, [], 'demo mode made no network calls');
});

const { buildDemoData, DEMO_NOW, DEMO_DEVICE_CODE, EMOTES, helixDuration } = await import('../src/js/demo/data.js');
const { demoHelix } = await import('../src/js/demo/helix.js');
const { demoImage, emoteSvg, videoSceneSvg } = await import('../src/js/demo/images.js');
const { joinLines, chatLine } = await import('../src/js/demo/chat-feed.js');
const { demoFetch, demoWebSocket, installClock, installDemo } = await import('../src/js/demo/install.js');
const { parseIrc, ircEvent } = await import('../src/js/chat.js');
const { LOADERS } = await import('../src/js/emote-providers.js');
const { matchArchive } = await import('../src/js/seek.js');

const BASE = 'lbhls://demo/';
const media = (p) => `${BASE}${p}`;
const db = buildDemoData({ media });
const helix = (path, query = {}, extra = {}) => demoHelix(db, { path, query, ...extra }, { activeId: db.accounts[0].id });

test('the demo data is deterministic and the expected size', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildDemoData({ media }))), JSON.parse(JSON.stringify(db)));
  assert.equal(db.liveFollowed.length, 12);
  assert.equal(db.follows.length, 32, '12 live + 20 offline follows');
  assert.equal(db.accounts[0].login, 'lurker');
  assert.equal(DEMO_DEVICE_CODE, 'ABCD-EFGH');
  for (const s of db.streams) assert.ok(Date.parse(s.started_at) < DEMO_NOW);
  assert.equal(helixDuration(3725), '1h2m5s');
});

test('every picture and link in the data is a demo URL (no remote images)', () => {
  const urls = JSON.stringify(db).match(/[a-z]+:\/\/[^"]+/g) || [];
  assert.ok(urls.length > 50);
  for (const u of urls) assert.ok(u.startsWith(BASE), `unexpected URL ${u}`);
});

test('Helix: the requests the core makes are answered from the demo data', () => {
  const followed = helix('/streams/followed', { user_id: '1000001', first: 100 });
  assert.equal(followed.ok, true);
  assert.equal(followed.data.data.length, 12);
  assert.ok(followed.data.data.every((s, i, a) => i === 0 || a[i - 1].viewer_count >= s.viewer_count), 'sorted by viewers');
  assert.equal(helix('/channels/followed', { user_id: '1000001', first: 100 }).data.data.length, 32);
  assert.ok(helix('/streams', { first: 40 }).data.data.length >= 20, 'Browse');
  const games = helix('/games/top', { first: 40 }).data.data;
  assert.ok(games.length >= 12);
  const g = games[0];
  assert.ok(helix('/streams', { game_id: g.id }).data.data.every((s) => s.game_id === g.id));
  const search = helix('/search/channels', { query: 'night' }).data.data;
  assert.ok(search.length >= 3 && search.some((c) => c.is_live) && search.some((c) => !c.is_live));
  const s = followed.data.data[0];
  assert.equal(helix('/streams', { user_login: s.user_login }).data.data[0].id, s.id);
  assert.equal(helix('/users', { login: s.user_login }).data.data[0].id, s.user_id);
  assert.equal(helix('/users', { id: [s.user_id, db.follows[20].broadcaster_id] }).data.data.length, 2);
  const vids = helix('/videos', { user_id: s.user_id, type: 'all' }).data.data;
  assert.ok(vids.length >= 8);
  assert.equal(helix('/videos', { id: vids[1].id }).data.data[0].id, vids[1].id);
  // Live rewind finds the archive of the running broadcast.
  const arch = helix('/videos', { user_id: s.user_id, type: 'archive', first: 5 }).data.data;
  assert.equal(matchArchive(s, arch).stream_id, s.id);
  assert.ok(helix('/chat/badges/global').data.data.some((b) => b.set_id === 'moderator'));
  assert.equal(helix('/eventsub/subscriptions', {}, { method: 'POST', body: { type: 'channel.raid', condition: { from_broadcaster_user_id: '1' } } }).data.data[0].status, 'enabled');
  assert.equal(helix('/nothing').ok, false);
});

test('every picture the data and chat refer to renders as SVG', () => {
  const paths = new Set();
  for (const u of JSON.stringify(db).match(/lbhls:\/\/demo\/[^"]+/g)) paths.add(u.slice(BASE.length).replace(/%?\{width\}/, '440').replace(/%?\{height\}/, '248'));
  for (const [name] of EMOTES) paths.add(`img/emote/${name}.svg`);
  for (const p of paths) {
    const svg = demoImage(`${p}?t=123`, { gameOf: () => 'Cozy Farming' });
    assert.ok(svg && svg.startsWith('<svg'), `no picture for ${p}`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), `${p} refers to a remote resource`);
  }
  assert.equal(demoImage('img/emote/nope.svg'), null);
  assert.equal(emoteSvg('lurkWave'), emoteSvg('lurkWave'));
  assert.ok(videoSceneSvg().length > 1000);
});

test('the fake emote APIs feed the real emote loaders; other URLs are refused', async () => {
  const f = demoFetch({ realFetch: null, origin: 'http://localhost:1234', media });
  const seven = await LOADERS['7tv'](f, '');
  assert.ok(seven.emotes.length >= 2 && seven.emotes.every((e) => e.url.startsWith(`${BASE}img/emote/`)));
  const sevenCh = await LOADERS['7tv'](f, '7100001');
  assert.ok(sevenCh.setId && sevenCh.emotes.some((e) => e.zeroWidth), 'a zero-width channel emote');
  assert.ok((await LOADERS.ffz(f, '')).emotes.length >= 1);
  assert.ok((await LOADERS.ffz(f, '7100001')).emotes.length >= 1);
  assert.deepEqual((await LOADERS.bttv(f, '')).emotes, []);
  await assert.rejects(() => f('https://example.com/x'), /network access is blocked/);
  await assert.rejects(() => f('https://gql.twitch.tv/gql'), /network access is blocked/);
});

/** Collects what a demo socket sends to the page, with manual timers. */
function socketHarness(url) {
  const timers = [];
  const WS = demoWebSocket({ roomIdOf: (l) => (l === 'pixelmoth' ? '7100004' : null), chat: { paused: false, intervalMs: 1000 }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const ws = new WS(url);
  const got = [];
  ws.onmessage = (e) => got.push(e.data);
  const run = (n = 1) => { for (let i = 0; i < n; i++) { const t = timers.splice(0); t.forEach((fn) => fn()); } };
  return { ws, got, run };
}

test('the fake Twitch chat speaks IRC that chat.js understands', () => {
  const h = socketHarness('wss://irc-ws.chat.twitch.tv:443');
  h.run();
  assert.equal(h.ws.readyState, 1);
  h.ws.send('JOIN #pixelmoth');
  h.run(2);
  const events = h.got.flatMap((d) => d.split('\r\n')).map((l) => ircEvent(parseIrc(l))).filter(Boolean);
  assert.equal(events[0].kind, 'joined');
  assert.deepEqual(events[1], { kind: 'room', roomId: '7100004', modes: { slow: '0', 'followers-only': '10', 'subs-only': '0', 'emote-only': '0', r9k: '0' } });
  const msgs = events.filter((e) => e.kind === 'msg');
  assert.ok(msgs.length >= 20);
  assert.ok(msgs.some((m) => /moderator\/1/.test(m.badges)));
  assert.ok(msgs.every((m) => m.roomId === '7100004' && m.nick && m.text));
  assert.equal(chatLine('pixelmoth', '7100004', 5), chatLine('pixelmoth', '7100004', 5), 'deterministic');
  assert.equal(joinLines('a', '1', 3).length, 5);
  h.ws.close();
  assert.equal(h.ws.readyState, 3);
});

test('the fake EventSub and 7TV sockets greet; unknown sockets fail like a dead server', () => {
  const es = socketHarness('wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30');
  es.run();
  assert.equal(JSON.parse(es.got[0]).metadata.message_type, 'session_welcome');
  const stv = socketHarness('wss://events.7tv.io/v3');
  stv.run(2);
  const ops = stv.got.map((d) => JSON.parse(d));
  assert.equal(ops[0].op, 1);
  assert.ok(ops.some((o) => o.op === 0 && o.d.type === 'cosmetic.create'));
  const bad = socketHarness('wss://example.com/socket');
  let closed = null;
  bad.ws.onclose = (e) => { closed = e.code; };
  bad.run();
  assert.equal(closed, 1006);
});

test('installDemo pins the clock and replaces fetch and WebSocket in the page', async () => {
  const win = { Date, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: { origin: 'http://localhost:1' } };
  const control = installDemo(win, { mediaBase: BASE, now: DEMO_NOW });
  assert.ok(Math.abs(win.Date.now() - DEMO_NOW) < 5000);
  assert.ok(Math.abs(new win.Date().getTime() - DEMO_NOW) < 5000);
  assert.equal(new win.Date(0).getTime(), 0);
  assert.notEqual(win.WebSocket, globalThis.WebSocket);
  await assert.rejects(() => win.fetch('https://api.twitch.tv/helix/streams'), /blocked/);
  assert.equal(typeof control.pauseChat, 'function');
  const undo = installClock(win, 0);
  assert.ok(Math.abs(win.Date.now()) < 5000);
  undo();
});

test('demo sending: Helix accepts a message (but not the same one twice in 30 s) and the fake chat echoes it', () => {
  const db = buildDemoData({ media: (p) => `${BASE}${p}` });
  const me = db.accounts[0];
  let t = 1000;
  const send = (message, to = '7100004') => demoHelix(db, { path: '/chat/messages', method: 'POST', body: { broadcaster_id: to, sender_id: me.id, message } }, { activeId: me.id, now: () => t });
  const a = send('gg');
  assert.equal(a.ok, true);
  assert.equal(a.data.data[0].is_sent, true);
  assert.match(a.data.data[0].message_id, /^demo-msg-\d+$/);
  const dup = send('gg');
  assert.equal(dup.data.data[0].is_sent, false);
  assert.equal(dup.data.data[0].drop_reason.code, 'msg_duplicate');
  assert.equal(send('gg', '7100005').data.data[0].is_sent, true, 'another channel is not a duplicate');
  t += 31000;
  assert.equal(send('gg', '7100005').data.data[0].is_sent, true, 'after 30 s it may go again');
  assert.equal(demoHelix(db, { path: '/chat/messages', method: 'POST', body: { broadcaster_id: '1', sender_id: '999', message: 'x' } }, { activeId: me.id }).ok, false, 'only as the signed-in user');

  // The echo: a socket joined to the room gets your message back as an IRC PRIVMSG with the Helix id.
  const timers = [];
  const sockets = new Set();
  const WS = demoWebSocket({ roomIdOf: () => '7100004', chat: { paused: true, intervalMs: 1000 }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, sockets });
  const ws = new WS('wss://irc-ws.chat.twitch.tv:443');
  const got = [];
  ws.onmessage = (e) => got.push(e.data);
  const run = () => { const ts = timers.splice(0); ts.forEach((fn) => fn()); };
  run();
  ws.send('JOIN #pixelmoth');
  run();
  assert.equal(sockets.size, 1);
  [...sockets][0].echo({ user: me, text: 'hello lurkWave', id: 'demo-msg-9' });
  run();
  const ev = got.flatMap((d) => d.split('\r\n')).map((l) => ircEvent(parseIrc(l))).filter((e) => e && e.kind === 'msg' && e.id === 'demo-msg-9')[0];
  assert.ok(ev, 'echoed');
  assert.equal(ev.userId, me.id);
  assert.equal(ev.text, 'hello lurkWave');
  assert.equal(ev.roomId, '7100004');
  ws.close();
  assert.equal(sockets.size, 0, 'a closed socket leaves the set');
});
