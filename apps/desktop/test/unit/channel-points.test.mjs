import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../src/main/channel-points.js');
const W = require('../../src/main/watch-minutes.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../../src/main/store.js');
const { navSource, pressSource } = require('../../src/main/frame-nav.js');

test('balance parser', () => {
  assert.equal(P.parseBalance('0'), 0);
  assert.equal(P.parseBalance('1,234'), 1234);
  assert.equal(P.parseBalance('1.234.567'), 1234567);
  assert.equal(P.parseBalance('12.3K'), 12300);
  assert.equal(P.parseBalance('12,3 k'), 12300);
  assert.equal(P.parseBalance('1.2M'), 1200000);
  assert.equal(P.parseBalance(' 950 '), 950);
  assert.ok(Number.isNaN(P.parseBalance('')));
  assert.ok(Number.isNaN(P.parseBalance(null)));
});

test('claim selectors only ever target a button; scan source embeds the selector list and the auto-claim flag', () => {
  for (const s of P.SELECTORS.claim) assert.match(s, /button|claimable-bonus__icon/);
  const on = P.scanSource({ autoClaim: true });
  const off = P.scanSource({ autoClaim: false });
  assert.match(on, /if \(true\)/);
  assert.match(off, /if \(false\)/);
  assert.ok(on.includes('copo-balance-string'));
  assert.ok(on.includes("closest('button')"));
  assert.doesNotThrow(() => new Function(`return ${on}`), 'valid JS');
  assert.doesNotThrow(() => new Function(`return ${P.openRewardsSource()}`));
});

test('chat frame URLs', () => {
  assert.ok(P.isChatFrameUrl('https://www.twitch.tv/embed/lofigirl/chat?darkpopout&parent=localhost'));
  assert.ok(P.isChatFrameUrl('https://www.twitch.tv/embed/LofiGirl/chat?parent=localhost', 'lofigirl'));
  assert.ok(!P.isChatFrameUrl('https://www.twitch.tv/embed/other/chat', 'lofigirl'));
  assert.ok(!P.isChatFrameUrl('https://evil.example/embed/lofigirl/chat'));
  assert.ok(!P.isChatFrameUrl('https://www.twitch.tv/lofigirl'));
  assert.ok(!P.isChatFrameUrl('nonsense'));
});

test('tracker: claim amount from the balance change, predictions announced once', () => {
  let now = 0;
  const t = new P.PointsTracker({ now: () => now });
  let r = t.update({ signedIn: true, balanceText: '1,000', claimed: false, prediction: null, poll: null });
  assert.deepEqual(r.state, { signedIn: true, balance: 1000, prediction: null, poll: null });
  r = t.update({ signedIn: true, balanceText: '1,000', claimed: true });
  assert.ok(r.events.some((e) => e.type === 'claim-clicked'));
  now = 4000;
  r = t.update({ signedIn: true, balanceText: '1,050', claimed: false });
  assert.deepEqual(r.events.find((e) => e.type === 'claimed'), { type: 'claimed', amount: 50, balance: 1050 });
  r = t.update({ signedIn: true, balanceText: '1,050', claimed: true });
  now = 40000;
  r = t.update({ signedIn: true, balanceText: '1,050', claimed: false });
  assert.deepEqual(r.events.find((e) => e.type === 'claimed'), { type: 'claimed', amount: null, balance: 1050 }, 'claim logged even if the balance never moved');
  r = t.update({ signedIn: true, balanceText: '1,050', prediction: 'Prediction · Will he win? 1:59 left' });
  assert.deepEqual(r.events, [{ type: 'prediction', title: 'Will he win?' }]);
  r = t.update({ signedIn: true, balanceText: '1,050', prediction: 'Prediction · Will he win? 1:58 left' });
  assert.deepEqual(r.events, [], 'the countdown is not a new prediction');
  r = t.update({ signedIn: true, balanceText: '1,050', poll: 'Poll: Best map?' });
  assert.deepEqual(r.events, [{ type: 'poll', title: 'Best map?' }]);
});

const gate = (o = {}) => W.reportGate({ enabled: true, direct: true, live: true, rewound: false, playing: true, webSignedIn: true, sameUser: true, hiddenMs: null, ...o });

test('watch-minute reporting gate', () => {
  assert.deepEqual(gate(), { ok: true, reason: 'ok' });
  assert.equal(gate({ enabled: false }).reason, 'setting off');
  assert.equal(gate({ direct: false }).reason, 'Twitch player reports by itself');
  assert.equal(gate({ live: false }).reason, 'not live');
  assert.equal(gate({ rewound: true }).reason, 'rewound');
  assert.equal(gate({ playing: false }).reason, 'not playing');
  assert.equal(gate({ webSignedIn: false }).reason, 'no twitch.tv session');
  assert.equal(gate({ sameUser: false }).reason, 'twitch.tv session is another account');
  assert.equal(gate({ hiddenMs: 4 * 60000 }).ok, true, 'hidden briefly (Floater over a game) still counts');
  assert.equal(gate({ hiddenMs: 5 * 60000 + 1 }).reason, 'hidden for more than 5 min');
});

test('minute-watched payload and spade discovery', () => {
  const body = W.minuteWatchedBody({ channelId: 12, broadcastId: 34, userId: 56, login: 'SomeOne' });
  assert.match(body, /^data=/);
  const events = JSON.parse(Buffer.from(decodeURIComponent(body.slice(5)), 'base64').toString('utf8'));
  assert.deepEqual(events, [{ event: 'minute-watched', properties: { channel_id: '12', broadcast_id: '34', player: 'site', user_id: '56', live: true, channel: 'someone' } }]);
  assert.equal(W.findSettingsUrl('<script src="https://assets.twitch.tv/config/settings.abc123.js"></script>'), 'https://assets.twitch.tv/config/settings.abc123.js');
  assert.equal(W.findSettingsUrl('<script src="https://static.twitchcdn.net/config/settings.x.js">'), 'https://static.twitchcdn.net/config/settings.x.js');
  assert.equal(W.findSettingsUrl('nothing'), null);
  assert.equal(W.findSpadeUrl('{"a":1,"spade_url":"https://spade.twitch.tv/track","b":2}'), 'https://spade.twitch.tv/track');
  assert.equal(W.findSpadeUrl('{}'), null);
  assert.equal(W.lowestVariant('#EXTM3U\n#EXT-X-STREAM-INF:A\nhttps://a/1080.m3u8\n#EXT-X-STREAM-INF:B\nhttps://a/160.m3u8\n'), 'https://a/160.m3u8');
  assert.equal(W.newestSegment('#EXTM3U\n#EXTINF:2,\nhttps://seg/1.ts\n#EXTINF:2,\nhttps://seg/2.ts\n', 'https://a/160.m3u8'), 'https://seg/2.ts');
});

test('watch-minute report: skips quietly (one log line per reason), reports with HEAD + spade when allowed', async () => {
  const log = [];
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push(`${o.method || 'GET'} ${url}`);
    if (url.startsWith('https://www.twitch.tv/')) return new Response('<script src="https://assets.twitch.tv/config/settings.abc.js">');
    if (url.includes('settings.abc.js')) return new Response('{"spade_url":"https://spade.twitch.tv/track"}');
    if (url.endsWith('160.m3u8')) return new Response('#EXTM3U\n#EXTINF:2,\nhttps://seg.ttvnw.net/2.ts\n');
    if (url.endsWith('2.ts')) return new Response(null, { status: 200 });
    if (url.startsWith('https://spade')) return new Response(null, { status: 204 });
    return new Response('', { status: 404 });
  };
  const w = new W.WatchMinutes({ fetch, log: (l) => log.push(l), master: async () => ({ ok: true, authed: true, master: '#EXTM3U\n#EXT-X-STREAM-INF:B\nhttps://v.ttvnw.net/160.m3u8\n' }) });
  const info = { login: 'chan', channelId: '1', broadcastId: '2', userId: '3' };
  const g = { enabled: true, direct: true, live: true, rewound: false, playing: true, webSignedIn: false, sameUser: true, hiddenMs: null };
  assert.equal((await w.report(g, info)).skipped, true);
  await w.report(g, info);
  assert.equal(log.length, 1, 'same reason logged once');
  assert.equal(calls.length, 0, 'nothing sent without a session');
  const r = await w.report({ ...g, webSignedIn: true }, info);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => /HEAD|POST/.test(c)), ['HEAD https://seg.ttvnw.net/2.ts', 'POST https://spade.twitch.tv/track']);
  assert.match(log.at(-1), /minute-watched chan: ok \(segment 200, spade 204\)/);
  const anon = new W.WatchMinutes({ fetch, log: (l) => log.push(l), master: async () => ({ ok: true, authed: false, master: '' }) });
  assert.equal((await anon.report({ ...g, webSignedIn: true }, info)).ok, false, 'never reports with an anonymous playlist');
});

test('channel-points settings', () => {
  assert.equal(DEFAULT_SETTINGS.chatStyle, 'lurkbox');
  assert.equal(DEFAULT_SETTINGS.autoClaimPoints, true);
  assert.equal(DEFAULT_SETTINGS.earnWatchPoints, true);
  assert.deepEqual(sanitizeSettings({ chatStyle: 'twitch', autoClaimPoints: 0, earnWatchPoints: 'yes' }), { chatStyle: 'twitch', autoClaimPoints: false, earnWatchPoints: true });
  assert.equal(sanitizeSettings({ chatStyle: 'evil' }).chatStyle, 'lurkbox');
});

test('shared frame navigation script', () => {
  assert.doesNotThrow(() => new Function(`return ${navSource({ hint: 'x "y"', preferText: true })}`));
  assert.match(pressSource('down'), /__lbNav\.press\("down"\)/);
  assert.equal(pressSource('b'), null);
  assert.equal(pressSource('x); alert(1'), null);
});
