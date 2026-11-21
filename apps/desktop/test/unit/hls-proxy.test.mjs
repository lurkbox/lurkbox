import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { unrecoverableLoad } from '@lurkbox/core/src/js/hls-util.js';

const require = createRequire(import.meta.url);
const { ProxyHosts, toProxyUrl, fromProxyUrl, rewriteMaster, makeHandler } = require('../../src/main/hls-proxy.js');
const { anonReasonFor } = require('../../src/main/direct.js');

const VOD_MASTER = `#EXTM3U
#EXT-X-TWITCH-INFO:ORIGIN="s3",CLUSTER="cloudfront_vod"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=8422490,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,VIDEO="chunked"
https://d1m7jfoe9zdc1j.cloudfront.net/abc_xqc_1/chunked/index-muted-X.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="https://d1m7jfoe9zdc1j.cloudfront.net/abc_xqc_1/audio_only/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=746525,RESOLUTION=640x360,VIDEO="360p30"
https://evil.example.com/360p30/index.m3u8
`;

test('allow-list: Twitch hosts always, cloudfront only after a usher master named it', () => {
  const h = new ProxyHosts();
  for (const ok of ['usher.ttvnw.net', 'video-weaver.sea02.hls.ttvnw.net', 'www.twitch.tv', 'twitch.tv']) assert.ok(h.allows(ok), ok);
  for (const no of ['example.com', 'ttvnw.net.evil.com', 'twitch.tv.evil.com', 'eviltwitch.tv', 'd1m7jfoe9zdc1j.cloudfront.net', '']) assert.ok(!h.allows(no), no);
  h.learn(VOD_MASTER);
  assert.ok(h.allows('d1m7jfoe9zdc1j.cloudfront.net'));
  assert.ok(!h.allows('dother.cloudfront.net'));
});

test('URL mapping round-trips and refuses foreign hosts, ports and credentials', () => {
  const h = new ProxyHosts();
  h.learn(VOD_MASTER);
  const u = 'https://d1m7jfoe9zdc1j.cloudfront.net/abc_xqc_1/chunked/index.m3u8?a=1';
  const p = toProxyUrl(u, h);
  assert.equal(p, 'lbhls://d1m7jfoe9zdc1j.cloudfront.net/abc_xqc_1/chunked/index.m3u8?a=1');
  assert.equal(fromProxyUrl(p, h), u);
  // Relative segment URLs resolve against the proxied playlist and stay proxied.
  assert.equal(fromProxyUrl(new URL('0-muted.ts', p).href, h), 'https://d1m7jfoe9zdc1j.cloudfront.net/abc_xqc_1/chunked/0-muted.ts');
  assert.equal(toProxyUrl('https://example.com/x.m3u8', h), 'https://example.com/x.m3u8');
  assert.equal(toProxyUrl('http://usher.ttvnw.net/x.m3u8', h), 'http://usher.ttvnw.net/x.m3u8');
  for (const bad of ['lbhls://example.com/x', 'lbhls://user:pw@usher.ttvnw.net/x', 'lbhls://usher.ttvnw.net:8080/x', 'https://usher.ttvnw.net/x', 'nonsense']) assert.equal(fromProxyUrl(bad, h), null, bad);
});

test('master rewrite proxies Twitch playlists only (URI lines and URI= attributes)', () => {
  const h = new ProxyHosts();
  const out = rewriteMaster(VOD_MASTER, h);
  assert.match(out, /^lbhls:\/\/d1m7jfoe9zdc1j\.cloudfront\.net\/abc_xqc_1\/chunked\/index-muted-X\.m3u8$/m);
  assert.match(out, /URI="lbhls:\/\/d1m7jfoe9zdc1j\.cloudfront\.net\/abc_xqc_1\/audio_only\/index\.m3u8"/);
  assert.match(out, /^https:\/\/evil\.example\.com\/360p30\/index\.m3u8$/m);
});

test('handler: 403 for foreign hosts, streams allowed ones with CORS and the upstream status', async () => {
  const h = new ProxyHosts();
  h.learn(VOD_MASTER);
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return new Response('#EXTM3U\n', { status: url.includes('missing') ? 404 : 200, headers: { 'content-type': 'binary/octet-stream' } }); };
  const handle = makeHandler({ fetch, hosts: h });
  const refused = await handle(new Request('lbhls://example.com/x.m3u8'));
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 0);
  const ok = await handle(new Request('lbhls://d1m7jfoe9zdc1j.cloudfront.net/a/chunked/index.m3u8', { headers: { Range: 'bytes=0-1', Cookie: 'x=1' } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal(ok.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(await ok.text(), '#EXTM3U\n');
  assert.equal(calls[0].url, 'https://d1m7jfoe9zdc1j.cloudfront.net/a/chunked/index.m3u8');
  assert.deepEqual(calls[0].opts.headers, { range: 'bytes=0-1' }); // no cookies forwarded
  assert.equal((await handle(new Request('lbhls://d1m7jfoe9zdc1j.cloudfront.net/missing.ts'))).status, 404);
  assert.equal((await handle(new Request('lbhls://usher.ttvnw.net/x', { method: 'POST', body: 'x' }))).status, 405);
});

test('a CORS refusal or 4xx on the first level load is unrecoverable; later or 5xx errors are retried', () => {
  assert.equal(unrecoverableLoad({ network: true, details: 'levelLoadError', code: 0, levelLoaded: false }), true);
  assert.equal(unrecoverableLoad({ network: true, details: 'levelLoadError', code: 403, levelLoaded: false }), true);
  assert.equal(unrecoverableLoad({ network: true, details: 'manifestLoadError', code: 404, levelLoaded: false }), true);
  assert.equal(unrecoverableLoad({ network: true, details: 'levelLoadError', code: 503, levelLoaded: false }), false);
  assert.equal(unrecoverableLoad({ network: true, details: 'levelLoadError', code: 0, levelLoaded: true }), false);
  assert.equal(unrecoverableLoad({ network: true, details: 'fragLoadError', code: 0, levelLoaded: false }), false);
  assert.equal(unrecoverableLoad({ network: false, details: 'levelLoadError', code: 0, levelLoaded: false }), false);
  assert.equal(unrecoverableLoad({ network: true, details: 'levelLoadTimeOut', code: undefined, levelLoaded: false }), false);
});

test('anon token reasons', () => {
  assert.match(anonReasonFor('token HTTP 401'), /^cookie rejected/);
  assert.match(anonReasonFor('failed integrity check'), /^integrity required/);
});
