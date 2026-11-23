import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../src/main/channel-points.js');
const W = require('../../src/main/watch-minutes.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../../src/main/store.js');
const { navSource, pressSource, backSource, navTooBig, navInnermost, navIntersect, navNearestDelta } = require('../../src/main/frame-nav.js');

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
  // Only the points frame (lurkbox=points) is scanned and claims; the Twitch chat style panel frame never does.
  const pts = 'https://www.twitch.tv/embed/lofigirl/chat?parent=localhost&darkpopout&lurkbox=points';
  const panel = 'https://www.twitch.tv/embed/lofigirl/chat?parent=localhost&darkpopout';
  assert.ok(P.isPointsFrameUrl(pts, 'lofigirl'));
  assert.ok(!P.isPointsFrameUrl(pts, 'other'));
  assert.ok(!P.isPointsFrameUrl(panel));
  assert.ok(!P.isPointsFrameUrl('https://evil.example/embed/lofigirl/chat?lurkbox=points'));
  assert.equal(P.chatFrameModeFor(pts, 'panel'), 'hidden');
  assert.equal(P.chatFrameModeFor(pts, 'hidden'), 'hidden');
  assert.equal(P.chatFrameModeFor(pts, 'modal'), 'modal');
  assert.equal(P.chatFrameModeFor(panel, 'modal'), 'panel');
  assert.equal(P.chatFrameModeFor(panel, 'hidden'), 'panel');
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

test('tracker: "no points" only after several scans in a row without the summary', () => {
  const t = new P.PointsTracker();
  const miss = { signedIn: false, signInPrompt: false, balanceText: null };
  let r = t.update({ signedIn: true, balanceText: '1,000' });
  assert.deepEqual(r.events, [{ type: 'signed-in', signedIn: true }, { type: 'balance', balance: 1000, previous: null }]);
  // Twitch re-renders the summary (the claim animation): one or two misses keep the balance shown.
  for (let i = 1; i < P.NO_POINTS_AFTER; i++) {
    r = t.update(miss);
    assert.deepEqual(r.events, [], `miss ${i}`);
    assert.equal(r.state.signedIn, true);
  }
  r = t.update({ signedIn: true, balanceText: '1,000' });
  assert.deepEqual(r.events, [], 'back before the limit: no event');
  for (let i = 1; i < P.NO_POINTS_AFTER; i++) t.update(miss);
  r = t.update(miss);
  assert.deepEqual(r.events, [{ type: 'signed-in', signedIn: false }]);
  assert.equal(t.misses, P.NO_POINTS_AFTER);
  // Twitch's sign-in prompt: at once.
  const t2 = new P.PointsTracker();
  t2.update({ signedIn: true, balanceText: '5' });
  assert.deepEqual(t2.update({ ...miss, signInPrompt: true }).events, [{ type: 'signed-in', signedIn: false }]);
});

test('no-points log detail: selector names and sizes only', () => {
  assert.equal(P.noPointsDetail({}), '');
  assert.equal(P.noPointsDetail({ diag: { chatInput: '340x96', editor: null, tagged: 2, names: ['a', 'b'], visibility: 'visible' } }),
    'chat input 340x96, editor missing, 2 data-test-selector elements in the input area: a, b; page visible');
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
  assert.equal(pressSource('b'), null, 'B is not a press: it goes through backSource');
  assert.equal(pressSource('x); alert(1'), null);
  assert.match(backSource(), /__lbNav\.back\(\)/);
  assert.match(backSource(), /'close'/, 'no navigation in the page: close the view');
  const src = navSource({ scopeSelector: P.NAV_OPTIONS.scopeSelector, fallbackSelector: P.NAV_OPTIONS.fallbackSelector });
  for (const f of ['navTooBig', 'navInnermost', 'navIntersect', 'navNearestDelta', 'installNav']) assert.ok(src.includes(`function ${f}(`), `${f} is injected`);
  assert.doesNotThrow(() => new Function(`return ${src}`));
});

test('nav targets: elements over ~60 % of the viewport are not targets', () => {
  const vw = 515, vh = 391; // the rewards view at zoom 1.74
  assert.equal(navTooBig({ width: 100, height: 80 }, vw, vh), false, 'a reward tile');
  assert.equal(navTooBig({ width: vw, height: 40 }, vw, vh), false, 'a full-width button or tab bar');
  assert.equal(navTooBig({ width: 60, height: vh }, vw, vh), false, 'a tall narrow strip');
  assert.equal(navTooBig({ width: vw, height: vh }, vw, vh), true, 'the whole popover');
  assert.equal(navTooBig({ width: vw * 0.7, height: vh * 0.7 }, vw, vh), true, 'a panel over 60 % both ways');
  assert.equal(navTooBig({ width: vw, height: vh * 0.65 }, vw, vh), true, 'over 60 % of the area');
  assert.equal(navTooBig({ width: 10, height: 10 }, 0, 0), false, 'no viewport yet: nothing is too big');
});

test('nav targets: wrappers give way to the smallest elements inside them', () => {
  // A focusable box around the reward row and the chat input (the "big region" from the TV photo), its tiles, and a
  // tile with a focusable badge inside.
  const wrap = { id: 'wrap', kids: ['t1', 't2', 'input', 'badge'] };
  const t1 = { id: 't1', kids: [] };
  const t2 = { id: 't2', kids: ['badge'] };
  const badge = { id: 'badge', kids: [] };
  const input = { id: 'input', kids: [] };
  const contains = (a, b) => a.kids.includes(b.id);
  assert.deepEqual(navInnermost([wrap, t1, t2, badge, input], contains).map((x) => x.id), ['t1', 'badge', 'input']);
  assert.deepEqual(navInnermost([t1, input], contains).map((x) => x.id), ['t1', 'input'], 'siblings stay');
  assert.deepEqual(navInnermost([], contains), []);
});

test('focus ring: clipped to what is visible; scroll-into-view moves by the nearest amount', () => {
  const frame = { left: 0, top: 0, right: 515, bottom: 391 };
  assert.deepEqual(navIntersect({ left: 10, top: 380, right: 110, bottom: 460 }, frame), { left: 10, top: 380, right: 110, bottom: 391 }, 'cut at the frame bottom');
  assert.equal(navIntersect({ left: 10, top: 400, right: 110, bottom: 460 }, frame), null, 'scrolled out of view');
  // block: 'nearest' inside a scroll container spanning 100..380
  assert.equal(navNearestDelta(150, 230, 100, 380), 0, 'already visible: no scroll');
  assert.equal(navNearestDelta(350, 430, 100, 380), 50, 'below: scroll down until its bottom shows');
  assert.equal(navNearestDelta(60, 140, 100, 380), -40, 'above: scroll up until its top shows');
  assert.equal(navNearestDelta(50, 500, 100, 380), -50, 'taller than the container: its top is aligned');
});
