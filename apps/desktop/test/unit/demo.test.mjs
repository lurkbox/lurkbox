// Demo mode on the desktop host (src/main/demo.js, demo-media.js): it only turns on for LURKBOX_DEMO=1, implements
// every IPC channel the preload uses without touching the network, and builds sane HLS playlists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const demo = require('../../src/main/demo.js');
const media = require('../../src/main/demo-media.js');

const real = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
before(() => {
  globalThis.fetch = () => { throw new Error('network fetch in demo mode'); };
  globalThis.WebSocket = class { constructor() { throw new Error('network WebSocket in demo mode'); } };
});
after(() => { globalThis.fetch = real.fetch; globalThis.WebSocket = real.WebSocket; });

test('demo mode turns on only for exactly LURKBOX_DEMO=1', () => {
  assert.equal(demo.isDemo({}), false);
  for (const v of ['', '0', 'true', 'yes', ' 1', '1 ']) assert.equal(demo.isDemo({ LURKBOX_DEMO: v }), false, JSON.stringify(v));
  assert.equal(demo.isDemo({ LURKBOX_DEMO: '1' }), true);
});

test('main.js hands over to demo mode before any other setup, behind the env check', () => {
  const main = fs.readFileSync(new URL('../../src/main/main.js', import.meta.url), 'utf8');
  const guard = main.indexOf("if (require('./demo').isDemo()) { require('./demo').runDemo(); return; }");
  assert.ok(guard > 0, 'the guard is there');
  for (const later of ['requestSingleInstanceLock', 'app.whenReady', 'registerIpc()', 'startCompanion(']) assert.ok(main.indexOf(later) > guard, `${later} comes after the guard`);
});

test('only the page server and the demo media scheme are allowed', () => {
  const srv = 'http://localhost:4321/';
  for (const u of ['http://localhost:4321/js/main.js', 'http://127.0.0.1:4321/x', 'lbhls://demo/img/avatar/a.svg', 'data:image/png;base64,AA', 'blob:http://localhost:4321/x']) assert.ok(demo.allowedUrl(u, srv), u);
  for (const u of ['https://api.twitch.tv/helix/streams', 'http://localhost:9999/', 'wss://irc-ws.chat.twitch.tv/', 'lbhls://usher.ttvnw.net/x.m3u8', 'https://player.twitch.tv/js/embed/v1.js']) assert.equal(demo.allowedUrl(u, srv), false, u);
});

function host(extra = {}) {
  const dir = tmpDir('lurkbox-demo-');
  const sent = [];
  const h = demo.createDemoHost({ settingsFile: path.join(dir, 'settings.json'), media: { ok: true, dir }, send: (c, p) => sent.push([c, p]), ...extra });
  return { ...h, dir, sent };
}

test('every IPC channel the preload uses has a demo handler', () => {
  const preload = fs.readFileSync(new URL('../../src/preload.js', import.meta.url), 'utf8');
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length > 30);
  const { handlers } = host();
  for (const c of channels) assert.equal(typeof handlers[c], 'function', c);
});

test('the demo host answers sign-in, Helix, settings and playback without the network', async () => {
  const h = host();
  const H = h.handlers;
  const info = H['app:info']();
  assert.equal(info.demo.mediaBase, demo.MEDIA_BASE);
  assert.equal(H['auth:state']().user.login, 'lurker');
  assert.equal(H['auth:state']().accounts.length, 3);
  assert.equal(H['auth:start']().flow.userCode, 'ABCD-EFGH');
  const r = H.helix({ path: '/streams/followed', query: { first: 100 } });
  assert.equal(r.ok, true);
  assert.equal(r.data.data.length, 12);
  assert.equal(H['settings:set']({ theme: 'oled', bogus: 1 }).theme, 'oled');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')).theme, 'oled');
  assert.ok(h.sent.some(([c]) => c === 'settings:changed'));
  const login = r.data.data[0].user_login;
  const m = H['direct:master']({ login });
  assert.equal(m.ok, true);
  assert.match(m.master, new RegExp(`lbhls://demo/hls/live/${login}\\.m3u8`));
  assert.equal(H['direct:master']({ login: 'velvetvoxel' }).offline, true, 'offline channels are offline');
  const vod = H.helix({ path: '/videos', query: { user_id: r.data.data[0].user_id, type: 'all' } }).data.data[2];
  assert.equal(H['direct:master']({ vodId: vod.id }).ok, true);
  assert.equal(H['direct:storyboard'](vod.id).images[0], 'lbhls://demo/hls/storyboard.jpg');
  assert.match(String(await H['qr:svg']('https://www.twitch.tv/activate')), /<svg/);
  H['auth:signOut']();
  assert.equal(H['auth:state']().user.login, 'couchcritter');
  assert.equal(host({ signedIn: false }).handlers.helix({ path: '/streams' }).error, 'NOT_SIGNED_IN');
  assert.match(host({ media: { ok: false, reason: 'ffmpeg not found' } }).handlers['direct:master']({ login }).reason, /ffmpeg not found/);
});

test('the demo media scheme serves pictures and playlists', () => {
  let now = 1000000;
  const h = host({ now: () => now });
  const img = h.serveMedia('/img/avatar/lurker.svg');
  assert.equal(img.type, 'image/svg+xml');
  assert.match(img.body, /^<svg/);
  assert.equal(h.serveMedia('/img/thumb/pixelmoth-440x248.svg?t=5').status, 200);
  assert.equal(h.serveMedia('/img/../../etc/passwd').status, 404);
  assert.equal(h.serveMedia('/hls/seg999.ts').status, 404);
  const live = h.serveMedia('/hls/live/pixelmoth.m3u8').body;
  now += 10000;
  const later = h.serveMedia('/hls/live/pixelmoth.m3u8').body;
  const seq = (p) => Number(/MEDIA-SEQUENCE:(\d+)/.exec(p)[1]);
  assert.equal(seq(later) - seq(live), 5, 'the live window slides with the clock');
});

test('live playlists loop the segments with discontinuities; VODs end', () => {
  const p = media.livePlaylist({ elapsedSec: media.LOOP_SEC + 4, segBase: 'x/' });
  const lines = p.trim().split('\n');
  assert.ok(lines.includes('#EXT-X-DISCONTINUITY'), 'the wrap is marked');
  assert.ok(!p.includes('#EXT-X-ENDLIST'));
  assert.equal(lines.filter((l) => l.endsWith('.ts')).length, 6);
  assert.match(p, /#EXT-X-DISCONTINUITY-SEQUENCE:0/);
  const p2 = media.livePlaylist({ elapsedSec: media.LOOP_SEC * 3 + 20, segBase: 'x/' });
  assert.match(p2, /#EXT-X-DISCONTINUITY-SEQUENCE:3/);
  assert.ok(!p2.includes('#EXT-X-DISCONTINUITY\n'), 'no wrap inside this window');
  const v = media.vodPlaylist({ durationSec: 3600, segBase: 'x/' });
  assert.equal(v.trim().split('\n').filter((l) => l.endsWith('.ts')).length, 1800);
  assert.match(v, /#EXT-X-ENDLIST\n$/);
  assert.equal(media.storyboardFor(2500, 'u').interval, 100);
  assert.match(media.masterPlaylist('lbhls://demo/hls/live/a.m3u8'), /NAME="720p60 \(source\)"/);
});

test('ensureDemoMedia reports a missing ffmpeg instead of throwing', () => {
  const dir = tmpDir('lurkbox-demo-media-');
  const r = media.ensureDemoMedia(dir, { sceneSvg: '<svg/>', runnerSvg: '<svg/>', ffmpeg: path.join(dir, 'no-such-ffmpeg') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ffmpeg not found/);
});

test('demo clips: signed-looking qualities of the clip MP4, served with byte ranges', () => {
  const h = host();
  const clip = h.db.clips.find((c) => c.video_id);
  const r = h.handlers['direct:clip'](clip.id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.qualities.map((q) => q.quality), ['1080', '720', '480', '360']);
  assert.match(r.qualities[0].url, new RegExp(`^lbhls://demo/hls/clip${clip.duration}\\.mp4\\?q=1080`));
  assert.deepEqual(h.handlers['direct:clip']('NoSuchClip'), { ok: false, reason: 'not-found' });
  assert.match(host({ media: { ok: false, reason: 'ffmpeg not found' } }).handlers['direct:clip'](clip.id).reason, /ffmpeg not found/);
  fs.writeFileSync(path.join(h.dir, 'clip15.mp4'), Buffer.from('0123456789'));
  const all = h.serveMedia('/hls/clip15.mp4?q=720');
  assert.equal(all.status, 200);
  assert.equal(all.type, 'video/mp4');
  assert.equal(all.headers['accept-ranges'], 'bytes');
  const part = h.serveMedia('/hls/clip15.mp4', { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(part.body).toString(), '2345');
  assert.equal(part.headers['content-range'], 'bytes 2-5/10');
  assert.equal(Buffer.from(h.serveMedia('/hls/clip15.mp4', { range: 'bytes=7-' }).body).toString(), '789');
  assert.equal(Buffer.from(h.serveMedia('/hls/clip15.mp4', { range: 'bytes=-3' }).body).toString(), '789');
  assert.equal(h.serveMedia('/hls/clip15.mp4', { range: 'bytes=20-' }).status, 416);
  assert.equal(h.serveMedia('/hls/clip30.mp4').status, 404, 'not rendered');
});

test('demo Continue watching: a seeded row for the first account, a deleted VOD Helix answers 404 for, per account', async () => {
  const { continueWatching, checkVideos } = await import('@lurkbox/core/src/shared/continue-watching.js');
  const { DEMO_NOW } = await import('@lurkbox/core/src/js/demo/data.js');
  const H = host().handlers;
  const all = H['resume:list']();
  const rows = continueWatching(all, DEMO_NOW);
  assert.equal(rows.length, 7, 'six part-watched broadcasts and the deleted one; finished and old ones left out');
  assert.ok(all.length > rows.length);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].at >= r.at), 'newest first');
  assert.ok(rows.every((r) => r.title && r.login && r.thumb), 'with their details');
  const ids = rows.map((r) => r.id);
  const check = checkVideos(ids, H.helix({ path: '/videos', query: { id: ids } }));
  assert.deepEqual(check.gone, ['2299999999'], 'the deleted VOD is gone from Helix');
  assert.equal(H.helix({ path: '/videos', query: { id: ['2299999999'] } }).status, 404);
  // Per account: the second account starts empty; positions follow the active account.
  H['auth:switch'](H['auth:state']().accounts[1].id);
  assert.deepEqual(H['resume:list'](), []);
  H['resume:set'](rows[0].id, 300, 3600, { title: 'x' });
  assert.equal(H['resume:get'](rows[0].id).position, 300);
  assert.equal(H['resume:clear'](), true);
  assert.deepEqual(H['resume:list'](), []);
});
