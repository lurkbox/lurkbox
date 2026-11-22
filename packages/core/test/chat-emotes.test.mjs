import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmotesTag, splitTwitchEmotes, tokenize, EmoteIndex, twitchEmoteUrl, ffzEffects } from '../src/js/chat-emotes.js';
import { from7tv, fromBttv, fromFfz, EmoteCache, load7tv, loadBttv, loadFfz } from '../src/js/emote-providers.js';
import { badgeMap, parseBadgesTag, BadgeCache, lookupBadge } from '../src/js/chat-badges.js';
import { fakeFetch, json } from './helpers.mjs';

const E = (provider, name, extra = {}) => ({ provider, id: `${provider}-${name}`, name, url: `https://x/${provider}/${name}`, w: 32, h: 32, zeroWidth: false, ...extra });
const kinds = (parts) => parts.map((p) => (p.t === 'text' ? p.s : `[${p.emote.provider}:${p.emote.name}${p.overlays.length ? `+${p.overlays.map((o) => o.name).join('+')}` : ''}${p.effects.length ? `{${p.effects.join(',')}}` : ''}]`)).join('');

// ---- Twitch emote tag ----

test('parseEmotesTag: groups, ranges, sorting and junk', () => {
  assert.deepEqual(parseEmotesTag('25:0-4,12-16/1902:6-10'), [
    { id: '25', start: 0, end: 4 }, { id: '1902', start: 6, end: 10 }, { id: '25', start: 12, end: 16 },
  ]);
  assert.deepEqual(parseEmotesTag(''), []);
  assert.deepEqual(parseEmotesTag('emotesv2_abc:3-5'), [{ id: 'emotesv2_abc', start: 3, end: 5 }]);
  assert.deepEqual(parseEmotesTag('x:5-2/y:a-b/:1-2'), [], 'reversed, non-numeric and id-less ranges are dropped');
  assert.deepEqual(parseEmotesTag('a:0-4/b:2-6'), [{ id: 'a', start: 0, end: 4 }], 'overlaps are dropped');
});

test('splitTwitchEmotes counts code points: emoji and surrogate pairs before an emote', () => {
  // "😀 Kappa": 😀 is one code point (two UTF-16 units). Twitch sends Kappa at 2-6.
  assert.deepEqual(splitTwitchEmotes('😀 Kappa', '25:2-6'), [
    { t: 'text', s: '😀 ' }, { t: 'emote', provider: 'twitch', id: '25', name: 'Kappa' },
  ]);
  // A ZWJ family emoji is several code points; positions still line up.
  const fam = '👨‍👩‍👧'; // 5 code points
  assert.equal(Array.from(fam).length, 5);
  assert.deepEqual(splitTwitchEmotes(`${fam} hi Kappa 𝕏 Kappa`, '25:9-13,17-21').filter((p) => p.t === 'emote').map((p) => p.name), ['Kappa', 'Kappa']);
  assert.deepEqual(splitTwitchEmotes(`${fam} hi Kappa 𝕏 Kappa`, '25:9-13,17-21').map((p) => p.s || p.name), [`${fam} hi `, 'Kappa', ' 𝕏 ', 'Kappa']);
});

test('splitTwitchEmotes ignores ranges past the end and handles no tag', () => {
  assert.deepEqual(splitTwitchEmotes('hi', '25:5-9'), [{ t: 'text', s: 'hi' }]);
  assert.deepEqual(splitTwitchEmotes('hi', ''), [{ t: 'text', s: 'hi' }]);
  assert.deepEqual(splitTwitchEmotes('', ''), []);
});

test('Twitch emote URLs: animated by default, static on request', () => {
  assert.equal(twitchEmoteUrl('25'), 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0');
  assert.equal(twitchEmoteUrl('25', { animated: false }), 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0');
});

// ---- word matching and precedence ----

function index() {
  const ix = new EmoteIndex();
  ix.set('ffz', 'global', [E('ffz', 'Clash'), E('ffz', 'OnlyFfz'), E('ffz', 'Kappa')]);
  ix.set('bttv', 'global', [E('bttv', 'Clash'), E('bttv', 'OnlyBttv'), E('bttv', 'cvHazmat', { zeroWidth: true })]);
  ix.set('7tv', 'global', [E('7tv', 'Clash'), E('7tv', 'Only7tv'), E('7tv', 'RainTime', { zeroWidth: true })]);
  return ix;
}

test('precedence 7TV > BTTV > FFZ, and a third-party emote beats a Twitch emote of the same name', () => {
  const ix = index();
  assert.equal(kinds(tokenize('Clash OnlyFfz OnlyBttv Only7tv plain', '', ix)), '[7tv:Clash] [ffz:OnlyFfz] [bttv:OnlyBttv] [7tv:Only7tv] plain');
  ix.setEnabled(['bttv', 'ffz']);
  assert.equal(kinds(tokenize('Clash', '', ix)), '[bttv:Clash]', '7TV off: BTTV wins');
  ix.setEnabled(['ffz']);
  assert.equal(kinds(tokenize('Clash', '', ix)), '[ffz:Clash]');
  ix.setEnabled([]);
  assert.equal(kinds(tokenize('Clash', '', ix)), 'Clash');
  // Twitch's Kappa (from the tag) loses to FFZ's Kappa by name, but stays a Twitch emote when FFZ is off.
  const ix2 = index();
  assert.equal(kinds(tokenize('Kappa', '25:0-4', ix2)), '[ffz:Kappa]');
  ix2.setEnabled(['7tv', 'bttv']);
  assert.equal(kinds(tokenize('Kappa', '25:0-4', ix2)), '[twitch:Kappa]');
});

test('channel emotes beat global ones within a provider; words are whole tokens', () => {
  const ix = index();
  ix.set('bttv', 'channel', [E('bttv', 'Only7tv')]);
  ix.set('7tv', 'channel', [E('7tv', 'OnlyBttv', { id: 'chan' })]);
  const parts = tokenize('OnlyBttv Only7tv xOnly7tv', '', ix);
  assert.equal(kinds(parts), '[7tv:OnlyBttv] [7tv:Only7tv] xOnly7tv');
  assert.equal(parts[0].emote.id, 'chan');
});

test('zero-width emotes layer over the previous emote (7TV flag, BTTV list, z! modifier)', () => {
  const ix = index();
  assert.equal(kinds(tokenize('Only7tv RainTime', '', ix)), '[7tv:Only7tv+RainTime]');
  assert.equal(kinds(tokenize('Only7tv cvHazmat RainTime after', '', ix)), '[7tv:Only7tv+cvHazmat+RainTime] after');
  assert.equal(kinds(tokenize('Kappa cvHazmat', '25:0-4', new EmoteIndex())), '[twitch:Kappa] cvHazmat', 'no third-party emotes: cvHazmat is text');
  const ix2 = index();
  ix2.setEnabled(['bttv', '7tv']);
  assert.equal(kinds(tokenize('Kappa cvHazmat', '25:0-4', ix2)), '[twitch:Kappa+cvHazmat]', 'over a Twitch emote too');
  assert.equal(kinds(tokenize('hello RainTime', '', ix)), 'hello [7tv:RainTime]', 'nothing to layer on: shown alone');
  assert.equal(kinds(tokenize('Only7tv text RainTime', '', ix)), '[7tv:Only7tv] text [7tv:RainTime]', 'text in between breaks the stack');
  assert.equal(kinds(tokenize('Only7tv z! OnlyBttv', '', ix)), '[7tv:Only7tv+OnlyBttv]', 'BTTV z! makes the next emote zero-width');
});

test('BTTV text modifiers and FFZ modifier emotes become effects', () => {
  const ix = index();
  assert.equal(kinds(tokenize('h! Only7tv', '', ix)), '[7tv:Only7tv{flip-x}]');
  assert.equal(kinds(tokenize('a h!  v! Only7tv b', '', ix)), 'a [7tv:Only7tv{flip-x,flip-y}] b');
  assert.equal(kinds(tokenize('h! hello', '', ix)), 'h! hello', 'a modifier before plain text stays text');
  assert.equal(kinds(tokenize('w!', '', ix)), 'w!');
  ix.set('ffz', 'channel', [E('ffz', 'ffzX', { ffzModifier: true, ffzFlags: 3 }), E('ffz', 'ffzOver', { ffzModifier: true, ffzFlags: 0 })]);
  assert.equal(kinds(tokenize('Only7tv ffzX', '', ix)), '[7tv:Only7tv{flip-x}]', 'hidden FFZ modifier: effect only');
  assert.equal(kinds(tokenize('Only7tv ffzOver', '', ix)), '[7tv:Only7tv+ffzOver]', 'visible FFZ modifier: overlay');
  assert.equal(kinds(tokenize('ffzX hi', '', ix)), ' hi', 'hidden modifier with nothing before it vanishes');
  assert.deepEqual(ffzEffects(2 | 4 | 8), ['flip-x', 'flip-y', 'wide']);
});

test('7TV personal emotes win for their owner only', () => {
  const ix = index();
  ix.setUserSet('42', 'set1');
  ix.patchPersonal('set1', { add: [E('7tv', 'Mine', { id: 'p' }), E('7tv', 'Clash', { id: 'pc' })] });
  assert.equal(tokenize('Mine Clash', '', ix, { userId: '42' })[0].emote.id, 'p');
  assert.equal(tokenize('Mine Clash', '', ix, { userId: '42' })[2].emote.id, 'pc');
  assert.equal(kinds(tokenize('Mine', '', ix, { userId: '7' })), 'Mine');
  ix.setUserSet('42', 'set1', false);
  assert.equal(kinds(tokenize('Mine', '', ix, { userId: '42' })), 'Mine');
});

test('EmoteIndex.patch adds and removes live (7TV emote_set.update)', () => {
  const ix = index();
  ix.patch('7tv', 'channel', { add: [E('7tv', 'NewOne')] });
  assert.equal(kinds(tokenize('NewOne', '', ix)), '[7tv:NewOne]');
  ix.patch('7tv', 'channel', { remove: ['NewOne'] });
  assert.equal(kinds(tokenize('NewOne', '', ix)), 'NewOne');
  ix.clearChannel();
  assert.equal(kinds(tokenize('Only7tv', '', ix)), '[7tv:Only7tv]', 'globals survive a channel switch');
});

// ---- provider normalisers ----

const stvActive = {
  id: 'E1', name: 'RainTime', flags: 1,
  data: { id: 'E1', name: 'RainTime', flags: 256, animated: true, host: { url: '//cdn.7tv.app/emote/E1', files: [
    { name: '1x.webp', static_name: '1x_static.webp', width: 32, height: 16, format: 'WEBP' },
    { name: '2x.webp', static_name: '2x_static.webp', width: 64, height: 32, format: 'WEBP' },
    { name: '2x.avif', static_name: '2x_static.avif', width: 64, height: 32, format: 'AVIF' },
  ] } },
};

test('7TV normaliser: webp, 1x size for the aspect ratio, zero-width, static frame when animation is off', () => {
  const e = from7tv(stvActive);
  assert.deepEqual(e, { provider: '7tv', id: 'E1', name: 'RainTime', url: 'https://cdn.7tv.app/emote/E1/2x.webp', w: 32, h: 16, zeroWidth: true, animated: true, author: '' });
  assert.equal(from7tv({ ...stvActive, data: { ...stvActive.data, owner: { username: 'rainy', display_name: 'Rainy' } } }).author, 'Rainy', 'the owner, for the Emotes tab');
  assert.equal(from7tv(stvActive, { animated: false }).url, 'https://cdn.7tv.app/emote/E1/2x_static.webp');
  assert.equal(from7tv({ ...stvActive, flags: 0, data: { ...stvActive.data, flags: 0 } }).zeroWidth, false);
  assert.equal(from7tv({ id: 'x', name: 'x' }), null);
});

test('BTTV and FFZ normalisers', () => {
  assert.deepEqual(fromBttv({ id: 'b1', code: 'cvHazmat', animated: false }), { provider: 'bttv', id: 'b1', name: 'cvHazmat', url: 'https://cdn.betterttv.net/emote/b1/2x.webp', w: 0, h: 0, zeroWidth: true, animated: false, author: '' });
  assert.equal(fromBttv({ id: 'b3', code: 'Shared', user: { name: 'maker', displayName: 'Maker' } }).author, 'Maker', 'a shared emote\'s owner');
  assert.equal(fromBttv({ id: 'b2', code: 'Jam', animated: true }, { animated: false }).url, 'https://cdn.betterttv.net/emote/b2/2x.png');
  assert.equal(fromBttv({ id: 'm', code: 'h!', modifier: true }), null, 'text modifiers are not emotes');
  const f = fromFfz({ id: 9, name: 'Z', width: 33, height: 30, urls: { 1: 'https://cdn.frankerfacez.com/emote/9/1', 2: 'https://cdn.frankerfacez.com/emote/9/2' }, modifier: true, modifier_flags: 3 });
  assert.equal(f.url, 'https://cdn.frankerfacez.com/emote/9/2');
  assert.equal(f.ffzModifier, true);
  assert.equal(f.ffzFlags, 3);
  assert.equal(fromFfz({ id: 8, name: 'O', urls: { 1: 'o' }, owner: { name: 'own', display_name: 'Own' } }).author, 'Own');
  const a = { id: 5, name: 'A', urls: { 2: 'u/2' }, animated: { 2: 'https://cdn.frankerfacez.com/emote/5/animated/2' } };
  assert.equal(fromFfz(a).url, 'https://cdn.frankerfacez.com/emote/5/animated/2.webp');
  assert.equal(fromFfz(a, { animated: false }).url, 'u/2');
});

test('loaders: endpoints, 404 means no emotes, FFZ default sets only', async () => {
  const f = fakeFetch([
    ['7tv.io/v3/users/twitch/1', () => json(200, { emote_set_id: 'S', emote_set: { id: 'S', emotes: [stvActive] } })],
    ['7tv.io/v3/users/twitch/2', () => json(404, { error: 'not found' })],
    ['betterttv.net/3/cached/users/twitch/1', () => json(200, { channelEmotes: [{ id: 'c', code: 'C' }], sharedEmotes: [{ id: 's', code: 'S' }] })],
    ['frankerfacez.com/v1/set/global', () => json(200, { default_sets: [3], sets: { 3: { emoticons: [{ id: 1, name: 'G', urls: { 1: 'g' } }] }, 99: { emoticons: [{ id: 2, name: 'NotDefault', urls: { 1: 'n' } }] } } })],
  ]);
  const s = await load7tv(f, '1');
  assert.equal(s.setId, 'S');
  assert.deepEqual(s.emotes.map((e) => e.name), ['RainTime']);
  assert.deepEqual((await load7tv(f, '2')).emotes, []);
  assert.deepEqual((await loadBttv(f, '1')).emotes.map((e) => e.name), ['C', 'S']);
  assert.deepEqual((await loadFfz(f, '')).emotes.map((e) => e.name), ['G']);
});

test('EmoteCache: one request per key, failures retried after the error TTL', async () => {
  let t = 0;
  let calls = 0;
  let fail = true;
  const loaders = { bttv: async () => { calls++; if (fail) throw new Error('down'); return { emotes: [E('bttv', 'X')] }; } };
  const c = new EmoteCache(null, { now: () => t, loaders, errorTtlMs: 1000, ttlMs: 10000 });
  await assert.rejects(c.get('bttv', '1'));
  await assert.rejects(c.get('bttv', '1'));
  assert.equal(calls, 1, 'failure cached');
  t = 1500; fail = false;
  assert.equal((await c.get('bttv', '1')).emotes.length, 1);
  await c.get('bttv', '1');
  assert.equal(calls, 2, 'success cached');
  await c.get('bttv', '1', { animated: false });
  assert.equal(calls, 3, 'static variant is its own entry');
});

// ---- badges ----

const helixBadges = (sets) => ({ data: sets });
const sub = (title) => ({ set_id: 'subscriber', versions: [{ id: '12', image_url_1x: 'a1', image_url_2x: `${title}-2x`, title }] });

test('badges: tag parsing and channel badges override global', async () => {
  assert.deepEqual(parseBadgesTag('broadcaster/1,subscriber/12,bad,'), ['broadcaster/1', 'subscriber/12']);
  assert.deepEqual(parseBadgesTag(''), []);
  const calls = [];
  const cache = new BadgeCache(async (path, q) => {
    calls.push([path, q]);
    if (path === '/chat/badges/global') return helixBadges([{ set_id: 'moderator', versions: [{ id: '1', image_url_2x: 'mod2x', title: 'Moderator' }] }, sub('Global sub')]);
    return helixBadges([sub(`Channel ${q.broadcaster_id} sub`)]);
  });
  const t = await cache.forChannel('77');
  assert.equal(lookupBadge(t, 'moderator/1').url, 'mod2x');
  assert.equal(lookupBadge(t, 'subscriber/12').title, 'Channel 77 sub');
  assert.equal(lookupBadge(t, 'vip/1'), null);
  await cache.forChannel('77');
  await cache.forChannel('88');
  assert.deepEqual(calls.map((c) => c[0]), ['/chat/badges/global', '/chat/badges', '/chat/badges'], 'global once, each channel once');
  assert.equal(badgeMap([{ set_id: 'x', versions: [{ id: '1', image_url_1x: 'only1x' }] }]).get('x/1').url, 'only1x');
});

test('badges: a failed lookup gives empty tables and is retried next time', async () => {
  let n = 0;
  const cache = new BadgeCache(async () => { n++; throw new Error('NOT_SIGNED_IN'); });
  const t = await cache.forChannel('1');
  assert.equal(t.global.size + t.channel.size, 0);
  await cache.forChannel('1');
  assert.equal(n, 4);
});
