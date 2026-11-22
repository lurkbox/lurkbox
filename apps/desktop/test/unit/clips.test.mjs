// Clip playback sources: the GQL request (persisted, then plain), signing each quality's URL, host checks, errors; and
// the core's choice between the MP4 qualities and Twitch's clip embed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { json } from './helpers.mjs';
import { clipQualities, clipQualityName, pickClipQuality, clipSourcePlan, clipEmbedUrl } from '@lurkbox/core/src/js/clip-engine.js';

const require = createRequire(import.meta.url);
const { buildClipRequest, parseClipAccess, fetchClipSources, validSlug, CLIP_HASH } = require('../../src/main/clips.js');
const { WEB_CLIENT_ID } = require('../../src/main/direct.js');

const ANSWER = {
  data: {
    clip: {
      id: '1',
      playbackAccessToken: { signature: 'sig123', value: '{"clip_uri":"x","expires":1}' },
      videoQualities: [
        { frameRate: 30, quality: '360', sourceURL: 'https://production.assets.clips.twitchcdn.net/v2/media/a/360.mp4' },
        { frameRate: 60, quality: '1080', sourceURL: 'https://production.assets.clips.twitchcdn.net/v2/media/a/1080.mp4' },
        { frameRate: 60, quality: '720', sourceURL: 'https://production.assets.clips.twitchcdn.net/v2/media/a/720.mp4?x=1' },
        { frameRate: 30, quality: '480', sourceURL: 'http://production.assets.clips.twitchcdn.net/480.mp4' }, // not https
        { frameRate: 30, quality: '160', sourceURL: 'https://evil.example/160.mp4' }, // not Twitch's
      ],
    },
  },
  extensions: {},
};

test('slugs: only clip-slug characters', () => {
  assert.ok(validSlug('AwkwardHelplessSalamanderSwiftRage-a1B2'));
  assert.ok(!validSlug('../../x'));
  assert.ok(!validSlug('a b'));
  assert.ok(!validSlug(''));
});

test('the request: web client id, persisted hash first, plain query as fallback, no auth', () => {
  const p = buildClipRequest('Slug-1');
  assert.equal(p.headers['Client-ID'], WEB_CLIENT_ID);
  assert.ok(!('Authorization' in p.headers));
  const pb = JSON.parse(p.body);
  assert.deepEqual(pb, { operationName: 'VideoAccessToken_Clip', variables: { slug: 'Slug-1' }, extensions: { persistedQuery: { version: 1, sha256Hash: CLIP_HASH } } });
  const q = JSON.parse(buildClipRequest('Slug-1', { persisted: false }).body);
  assert.match(q.query, /clip\(slug: \$slug\)/);
  assert.match(q.query, /playbackAccessToken/);
  assert.match(q.query, /videoQualities \{ frameRate quality sourceURL \}/);
});

test('parsing: each https Twitch URL gets sig and token; others are dropped', () => {
  const r = parseClipAccess(ANSWER);
  assert.equal(r.ok, true);
  assert.deepEqual(r.qualities.map((q) => q.quality), ['360', '1080', '720']);
  const u = new URL(r.qualities[2].url);
  assert.equal(u.searchParams.get('sig'), 'sig123');
  assert.equal(u.searchParams.get('token'), '{"clip_uri":"x","expires":1}');
  assert.equal(u.searchParams.get('x'), '1', 'existing parameters stay');
  assert.deepEqual(parseClipAccess([ANSWER]).qualities.length, 3, 'a batched (array) answer');
  assert.deepEqual(parseClipAccess({ data: { clip: null } }), { ok: false, reason: 'not-found' });
  assert.deepEqual(parseClipAccess({ errors: [{ message: 'PersistedQueryNotFound' }] }), { ok: false, reason: 'persisted' });
  assert.deepEqual(parseClipAccess({ data: { clip: { videoQualities: [], playbackAccessToken: null } } }), { ok: false, reason: 'no token' });
  assert.deepEqual(parseClipAccess({ data: { clip: { videoQualities: [], playbackAccessToken: { signature: 's', value: 'v' } } } }), { ok: false, reason: 'no qualities' });
  assert.equal(parseClipAccess(null).ok, false);
});

test('fetching: the persisted query; an unknown hash falls back to the plain query; a missing clip stops', async () => {
  const bodies = [];
  const ok = async (url, init) => { bodies.push(JSON.parse(init.body)); return json(200, ANSWER); };
  assert.equal((await fetchClipSources({ fetch: ok, slug: 'S' })).ok, true);
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].extensions);

  bodies.length = 0;
  const logs = [];
  const fallback = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    return json(200, b.extensions ? { errors: [{ message: 'PersistedQueryNotFound' }] } : ANSWER);
  };
  const r = await fetchClipSources({ fetch: fallback, slug: 'S', log: (l) => logs.push(l) });
  assert.equal(r.ok, true);
  assert.equal(bodies.length, 2);
  assert.ok(!bodies[1].extensions && bodies[1].query, 'second try: the plain query');
  assert.match(logs[0], /persisted query failed: persisted/);

  let n = 0;
  const gone = async () => { n++; return json(200, { data: { clip: null } }); };
  assert.deepEqual(await fetchClipSources({ fetch: gone, slug: 'S' }), { ok: false, reason: 'not-found' });
  assert.equal(n, 1, 'a deleted clip is not asked for twice');

  const down = async () => json(503, {});
  assert.deepEqual(await fetchClipSources({ fetch: down, slug: 'S' }), { ok: false, reason: 'GQL HTTP 503' });
  const offline = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
  assert.deepEqual(await fetchClipSources({ fetch: offline, slug: 'S' }), { ok: false, reason: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.deepEqual(await fetchClipSources({ fetch: ok, slug: '../x' }), { ok: false, reason: 'bad slug' });
});

test('core: qualities named and sorted, best first', () => {
  const qs = clipQualities(parseClipAccess(ANSWER).qualities);
  assert.deepEqual(qs.map((q) => q.name), ['1080p60', '720p60', '360p']);
  assert.deepEqual(qs.map((q) => q.group), ['1080p60', '720p60', '360p']);
  assert.equal(clipQualityName({ quality: '720', frameRate: 30 }), '720p');
  assert.equal(clipQualityName({ quality: 'source' }), 'source');
  assert.deepEqual(clipQualities([{ quality: '720', url: 'javascript:alert(1)' }]), [], 'only https (or the demo scheme)');
  assert.deepEqual(clipQualities(null), []);
});

test('core: which quality plays', () => {
  const qs = clipQualities(parseClipAccess(ANSWER).qualities);
  const name = (o) => pickClipQuality(qs, o).name;
  assert.equal(name({}), '1080p60', 'auto: the best');
  assert.equal(name({ preferred: '720p60' }), '720p60', 'the default quality setting caps auto');
  assert.equal(name({ preferred: '480p30' }), '360p');
  assert.equal(name({ preferred: '160p30' }), '360p', 'nothing that small: the smallest');
  assert.equal(name({ chosen: '360p' }), '360p', 'a chosen quality');
  assert.equal(name({ chosen: '1440p60' }), '1080p60', 'a quality the clip lacks: auto');
  assert.equal(name({ capHeight: 720 }), '720p60', 'the background cap');
  assert.equal(name({ chosen: '1080p60', capHeight: 480 }), '360p', 'the cap wins over a chosen quality');
  assert.equal(pickClipQuality([], {}), null);
});

test('core: the direct MP4 or the embed', () => {
  const good = { ok: true, qualities: parseClipAccess(ANSWER).qualities };
  assert.equal(clipSourcePlan({ hostResult: good }).kind, 'direct');
  assert.equal(clipSourcePlan({ hostResult: good }).qualities.length, 3);
  assert.deepEqual(clipSourcePlan({ engine: 'embed', hostResult: good }), { kind: 'embed', reason: 'Twitch player chosen in Settings' });
  assert.deepEqual(clipSourcePlan({ hasHost: false }), { kind: 'embed', reason: 'no direct clip playback on this device' });
  assert.deepEqual(clipSourcePlan({ hostResult: { ok: false, reason: 'not-found' } }), { kind: 'embed', reason: 'not-found' });
  assert.deepEqual(clipSourcePlan({ hostResult: null }), { kind: 'embed', reason: 'clip sources failed' });
  assert.deepEqual(clipSourcePlan({ hostResult: { ok: true, qualities: [{ quality: '720', url: 'http://x/a.mp4' }] } }), { kind: 'embed', reason: 'no playable clip quality' });
  assert.equal(clipEmbedUrl('Slug-1'), 'https://clips.twitch.tv/embed?clip=Slug-1&parent=localhost&autoplay=true&muted=false');
});
