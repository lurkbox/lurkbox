// Clip creation: the scope check, the Helix request, every error Twitch can answer (clips off, not live, rate limit,
// sign-in), the edit link, "My clips" storage per account, and the demo's echo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIP_SCOPE, MAX_MY_CLIPS, clipAuthState, buildClipCreate, clipCreateResult, clipEditUrl, clipShortLink, sanitizeMyClips, sanitizeClipList, addMyClip, myClipsFor,
} from '../src/shared/my-clips.js';
import { SCOPES } from '../src/shared/config.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix, CLIPS_OFF } from '../src/js/demo/helix.js';

const NOW = Date.UTC(2026, 2, 14, 20, 0, 5);
const ME = { id: '1000001', login: 'lurker' };

test('the clips:edit scope is requested at sign-in; a token without it asks for a new sign-in', () => {
  assert.ok(SCOPES.includes(CLIP_SCOPE));
  assert.equal(clipAuthState({ signedIn: true, user: ME, missingScopes: [] }), 'ok');
  assert.equal(clipAuthState({ signedIn: true, user: ME, needsReauth: true, missingScopes: ['clips:edit', 'user:write:chat'] }), 'reauth');
  assert.equal(clipAuthState({ signedIn: true, user: ME, needsReauth: true, missingScopes: ['user:write:chat'] }), 'ok', 'another missing scope doesn\'t block clipping');
  assert.equal(clipAuthState({ signedIn: false }), 'signed-out');
  assert.equal(clipAuthState(null), 'signed-out');
});

test('the request: POST /clips for the broadcaster', () => {
  assert.deepEqual(buildClipCreate('7100004'), { path: '/clips', query: { broadcaster_id: '7100004' }, method: 'POST' });
  assert.deepEqual(buildClipCreate(null), { error: 'no-channel' });
  assert.deepEqual(buildClipCreate('abc'), { error: 'no-channel' });
});

test('202: the clip and its edit link', () => {
  const r = clipCreateResult({ ok: true, status: 202, data: { data: [{ id: 'FunnySlug-abc', edit_url: 'https://clips.twitch.tv/FunnySlug-abc/edit' }] } });
  assert.deepEqual(r, { ok: true, id: 'FunnySlug-abc', editUrl: 'https://clips.twitch.tv/FunnySlug-abc/edit' });
  assert.equal(clipShortLink('FunnySlug-abc'), 'clips.twitch.tv/FunnySlug-abc');
  assert.equal(clipCreateResult({ ok: true, status: 202, data: { data: [] } }).ok, false, 'no clip in the answer');
  assert.equal(clipCreateResult({ ok: true, status: 202, data: { data: [{ id: '<script>' }] } }).ok, false, 'not a slug');
});

test('the edit link is only ever Twitch\'s', () => {
  assert.equal(clipEditUrl('S', 'https://www.twitch.tv/x/clip/S?edit'), 'https://www.twitch.tv/x/clip/S?edit');
  assert.equal(clipEditUrl('S', 'https://evil.example/S/edit'), 'https://clips.twitch.tv/S/edit');
  assert.equal(clipEditUrl('S', 'http://clips.twitch.tv/S/edit'), 'https://clips.twitch.tv/S/edit', 'not https');
  assert.equal(clipEditUrl('S', 'javascript:alert(1)'), 'https://clips.twitch.tv/S/edit');
  assert.equal(clipEditUrl('S', undefined), 'https://clips.twitch.tv/S/edit');
});

test('errors: sign-in, clips off, followers/subs only, not live, rate limit, Twitch down, other', () => {
  const err = (status, message, extra = {}) => clipCreateResult({ ok: false, status, error: 'x', data: message ? { message } : null, resetAt: null, ...extra }, { name: 'PixelMoth', now: NOW });
  assert.equal(err(401).code, 'reauth');
  assert.equal(err(400, 'Missing scope: clips:edit').code, 'reauth');
  assert.deepEqual(err(403, 'The broadcaster has disabled clips on their channel.'), { ok: false, code: 'disabled', message: 'Clips are turned off for PixelMoth.' });
  assert.deepEqual(err(403, 'The broadcaster has restricted the ability to capture clips to followers and/or subscribers only.'), { ok: false, code: 'disabled', message: 'PixelMoth lets only some viewers make clips.' });
  assert.deepEqual(err(404, 'The broadcaster must be broadcasting live.'), { ok: false, code: 'offline', message: 'PixelMoth isn’t live, so there’s nothing to clip.' });
  const rl = err(429, 'Too many', { resetAt: Math.floor(NOW / 1000) + 42 });
  assert.equal(rl.code, 'ratelimited');
  assert.equal(rl.resetAt, (Math.floor(NOW / 1000) + 42) * 1000, 'Ratelimit-Reset is in seconds');
  assert.match(rl.message, /Try again in 4[12] s\./);
  const rlNoReset = err(429, null);
  assert.equal(rlNoReset.resetAt, NOW + 60000, 'no reset header: a minute');
  assert.equal(err(503).code, 'unavailable');
  assert.deepEqual(err(400, 'Something odd'), { ok: false, code: 'error', message: 'Couldn’t clip: Something odd' });
  assert.equal(clipCreateResult(null).code, 'error', 'no answer at all (the host threw)');
});

test('My clips: per account, newest first, valid entries only, at most 50', () => {
  const e = (id, extra = {}) => ({ id, broadcasterId: '7100004', login: 'pixelmoth', name: 'PixelMoth', at: 5, editUrl: `https://clips.twitch.tv/${id}/edit`, ...extra });
  let all = addMyClip({}, '1000001', e('A'));
  all = addMyClip(all, '1000001', e('B'));
  all = addMyClip(all, '1000002', e('C', { broadcasterId: '7100001', login: 'mossykeyboard' }));
  assert.deepEqual(all['1000001'].map((c) => c.id), ['B', 'A']);
  assert.deepEqual(myClipsFor(all, '1000001', '7100004').map((c) => c.id), ['B', 'A']);
  assert.deepEqual(myClipsFor(all, '1000001', '7100001'), [], 'another channel');
  assert.deepEqual(myClipsFor(all, '1000002', '7100001').map((c) => c.id), ['C'], 'another account');
  assert.deepEqual(addMyClip(all, '1000001', e('A'))['1000001'].map((c) => c.id), ['A', 'B'], 'no duplicates; the new one first');
  assert.deepEqual(sanitizeClipList([e('ok'), e('../x'), e('y', { broadcasterId: 'x' }), e('z', { login: 'Bad Login!' }), null, 'str']).map((c) => c.id), ['ok']);
  assert.equal(sanitizeClipList([e('evil', { editUrl: 'https://evil.example' })])[0].editUrl, 'https://clips.twitch.tv/evil/edit');
  assert.equal(sanitizeClipList(Array.from({ length: 70 }, (_, i) => e(`c${i}`))).length, MAX_MY_CLIPS);
  assert.deepEqual(sanitizeMyClips({ notanid: [e('A')], 123: [], 456: [e('B')] }), { 456: [{ ...e('B') }] });
  assert.deepEqual(sanitizeMyClips(null), {});
  assert.deepEqual(DEFAULT_SETTINGS.myClips, {});
  assert.deepEqual(sanitizeSettings({ myClips: { 1000001: [e('A'), e('bad slug')] } }).myClips, { 1000001: [e('A')] });
});

test('demo echo: a clip of a live channel; not live, clips off and the rate limit answer like Twitch', () => {
  const db = buildDemoData();
  let now = db.now;
  const ctx = { activeId: '1000001', now: () => now };
  const post = (id) => demoHelix(db, { path: '/clips', method: 'POST', query: { broadcaster_id: id } }, ctx);
  const live = db.streams.find((s) => s.user_login === 'pixelmoth');
  const r = post(live.user_id);
  assert.equal(r.status, 202);
  const made = clipCreateResult(r);
  assert.ok(made.ok, JSON.stringify(r));
  const listed = demoHelix(db, { path: '/clips', query: { id: [made.id] } }, ctx).data.data[0];
  assert.equal(listed.creator_name, 'lurker');
  assert.equal(listed.broadcaster_id, live.user_id);
  assert.ok(listed.video_id && listed.vod_offset > 0, 'from the live archive, so "Watch from here" works');
  assert.equal(listed.created_at, new Date(db.now).toISOString().replace(/\.\d{3}Z$/, 'Z'), 'on the demo clock');
  const offline = db.users.find((u) => u.login === 'velvetvoxel');
  assert.equal(clipCreateResult(post(offline.id)).code, 'offline');
  const off = db.users.find((u) => u.login === CLIPS_OFF[0]);
  assert.equal(clipCreateResult(post(off.id), { name: off.display_name }).message, `Clips are turned off for ${off.display_name}.`);
  for (let i = 0; i < 4; i++) { now += 1000; assert.equal(post(live.user_id).status, 202); }
  now += 1000;
  const limited = clipCreateResult(post(live.user_id), { now });
  assert.equal(limited.code, 'ratelimited');
  assert.ok(limited.resetAt > now && limited.resetAt <= now + 60000);
  now += 61000;
  assert.equal(post(live.user_id).status, 202, 'a minute later it works again');
});
