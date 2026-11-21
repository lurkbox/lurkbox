import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseQualities, adState, shouldFallback, supportedCodecs, liveBadge, catchUpDecision, catchUpRate, fatalAction, resumeDecision } from '@lurkbox/core/src/js/hls-util.js';

const require = createRequire(import.meta.url);
const { buildGqlRequest, usherUrl, fetchMaster, WEB_CLIENT_ID } = require('../../src/main/direct.js');

const MASTER = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="x"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://example/1080.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://example/720.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://example/audio.m3u8
`;

test('GQL request: web client id, auth header only when signed in to the player', () => {
  const anon = buildGqlRequest({ login: 'SomeOne' });
  assert.equal(anon.headers['Client-ID'], WEB_CLIENT_ID);
  assert.ok(!('Authorization' in anon.headers));
  const body = JSON.parse(anon.body);
  assert.equal(body.operationName, 'PlaybackAccessToken');
  assert.deepEqual(body.variables, { isLive: true, login: 'someone', isVod: false, vodID: '', playerType: 'site', platform: 'web' });
  const authed = buildGqlRequest({ vodId: 123, authToken: 'tok' });
  assert.equal(authed.headers.Authorization, 'OAuth tok');
  assert.equal(JSON.parse(authed.body).variables.isVod, true);
  assert.equal(JSON.parse(authed.body).variables.vodID, '123');
});

test('usher URLs for live and VOD', () => {
  const u = new URL(usherUrl({ login: 'Chan', token: '{"a":1}', sig: 'abc', codecs: ['av1', 'h264'], rand: 42 }));
  assert.equal(u.origin + u.pathname, 'https://usher.ttvnw.net/api/channel/hls/chan.m3u8');
  for (const [k, v] of Object.entries({ sig: 'abc', token: '{"a":1}', allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true', p: '42', player_backend: 'mediaplayer', playlist_include_framerate: 'true', supported_codecs: 'av1,h264', platform: 'web' })) {
    assert.equal(u.searchParams.get(k), v, k);
  }
  assert.equal(new URL(usherUrl({ vodId: '999', token: 't', sig: 's' })).pathname, '/vod/999.m3u8');
});

test('fetchMaster: signed-in first, anonymous retry, offline on 404', async () => {
  const calls = [];
  const fakeFetch = (statusFor) => async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization });
    if (url.includes('gql')) {
      if (init.headers.Authorization) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: { value: 'v', signature: 's', authorization: { isForbidden: false } } } }));
    }
    return new Response(statusFor === 404 ? '' : MASTER, { status: statusFor });
  };
  const logs = [];
  const ok = await fetchMaster({ fetch: fakeFetch(200), login: 'chan', codecs: ['h264'], authToken: 'cookie', log: (l) => logs.push(l) });
  assert.equal(ok.ok, true);
  assert.equal(ok.authed, false);
  assert.match(logs[0], /anon token \(ads possible\)/);
  assert.equal(calls.filter((c) => c.url.includes('gql')).length, 2);
  const off = await fetchMaster({ fetch: fakeFetch(404), login: 'chan', codecs: ['h264'], authToken: null });
  assert.deepEqual(off, { ok: false, reason: 'offline', offline: true });
});

test('quality list from a master playlist', () => {
  const q = parseQualities(MASTER);
  assert.deepEqual(q.map((x) => [x.group, x.name, x.height, x.fps]), [
    ['chunked', '1080p60 (Source)', 1080, 60], ['720p60', '720p60', 720, 60], ['audio_only', 'audio_only', 0, 0],
  ]);
  assert.equal(q[2].audioOnly, true);
});

test('ad markers are detected and labelled (never removed)', () => {
  const pl = `#EXTM3U
#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="2026-11-21T10:00:00.000Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-21T10:01:00.000Z",DURATION=30.0,X-TV-TWITCH-AD-POD-LENGTH="1"
#EXT-X-DATERANGE:ID="source-2",CLASS="twitch-stream-source",START-DATE="2026-11-21T10:01:00.000Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="Amazon"
`;
  const t = (s) => Date.parse(`2026-11-21T10:0${s}Z`);
  assert.deepEqual(adState(pl, t('0:30.000')), { inAd: false, endsAt: null });
  const mid = adState(pl, t('1:10.000'));
  assert.equal(mid.inAd, true);
  assert.equal(mid.endsAt, Date.parse('2026-11-21T10:01:30.000Z'));
  assert.equal(adState(pl.replace('"Amazon"', '"live"'), t('1:40.000')).inAd, false, 'after the pod, back to live');
});

test('fallback decision table', () => {
  assert.equal(shouldFallback({ type: 'token-error', reason: 'x' }).fallback, true);
  assert.deepEqual(shouldFallback({ type: 'usher', status: 404 }), { fallback: false, offline: true });
  assert.equal(shouldFallback({ type: 'usher', status: 403 }).fallback, true);
  assert.equal(shouldFallback({ type: 'invalid-playlist' }).fallback, true);
  assert.deepEqual(shouldFallback({ type: 'fatal', count: 1, detail: 'x' }), { fallback: false, recover: true });
  assert.equal(shouldFallback({ type: 'fatal', count: 2, detail: 'x' }).fallback, true);
  assert.equal(shouldFallback({ type: 'no-frames' }).fallback, true);
});

test('codec advertisement prefers hardware-efficient codecs only', () => {
  assert.deepEqual(supportedCodecs(() => true, { av1: false, h265: false }), ['h264']);
  assert.deepEqual(supportedCodecs(() => true, { av1: true, h265: true }), ['av1', 'h265', 'h264']);
  assert.deepEqual(supportedCodecs(() => false, { av1: true }), ['h264']);
});

test('live badge, catch-up rate and the >30 s offer', () => {
  assert.deepEqual(liveBadge(2), { live: true, text: '● LIVE' });
  assert.deepEqual(liveBadge(23), { live: false, text: '−0:23 behind' });
  assert.equal(liveBadge(65).text, '−1:05 behind');
  assert.equal(liveBadge(null).live, true);
  assert.equal(catchUpDecision(3), 'none');
  assert.equal(catchUpDecision(10), 'auto');
  assert.equal(catchUpDecision(10, { autoCatchUp: false }), 'none');
  assert.equal(catchUpDecision(31), 'offer');
  assert.equal(catchUpRate(true), 1.1);
  assert.equal(catchUpRate(false), 1);
});

test('fatal errors: one H.264-only retry before the embed fallback', () => {
  // bufferAppendError on AV1/HEVC: straight to the H.264 reload.
  assert.equal(fatalAction({ mediaError: true, count: 1, h264Only: false, reloaded: false }), 'reload-h264');
  // Already H.264: recover first, then the one fresh reload, then fall back.
  assert.equal(fatalAction({ mediaError: true, count: 1, h264Only: true, reloaded: false }), 'recover');
  assert.equal(fatalAction({ mediaError: true, count: 2, h264Only: true, reloaded: false }), 'reload-h264');
  assert.equal(fatalAction({ mediaError: true, count: 1, h264Only: true, reloaded: true }), 'recover');
  assert.equal(fatalAction({ mediaError: true, count: 2, h264Only: true, reloaded: true }), 'fallback');
  // Network errors restart loading first.
  assert.equal(fatalAction({ mediaError: false, count: 1, h264Only: true, reloaded: false }), 'restart-load');
  assert.equal(fatalAction({ mediaError: false, count: 2, h264Only: true, reloaded: false }), 'reload-h264');
  assert.equal(fatalAction({ mediaError: false, count: 2, h264Only: true, reloaded: true }), 'fallback');
});

test('resume after a pause: jump to live only when the paused spot has left the live window', () => {
  const base = { live: true, liveSync: 90, windowStart: 60 };
  assert.equal(resumeDecision({ ...base, position: 80, bufferedEnd: 95 }), 'play', 'still inside the window: play on (badge shows behind)');
  assert.equal(resumeDecision({ ...base, position: 50, bufferedEnd: 95 }), 'jump', 'fell out of the window');
  assert.equal(resumeDecision({ ...base, position: 62, bufferedEnd: null }), 'jump', 'about to fall out, nothing buffered');
  assert.equal(resumeDecision({ ...base, position: 62, bufferedEnd: 94 }), 'play', 'about to fall out but buffered to the edge');
  assert.equal(resumeDecision({ live: true, liveSync: NaN, windowStart: NaN, position: 10 }), 'reload', 'no live position: restart loading');
  assert.equal(resumeDecision({ live: false, position: 5, windowStart: 60, liveSync: 90 }), 'play', 'VODs just play');
  // And the badge after a jump reads LIVE again; behind otherwise.
  assert.equal(liveBadge(90 - 88).live, true);
  assert.equal(liveBadge(90 - 62).text, '\u22120:28 behind');
});
