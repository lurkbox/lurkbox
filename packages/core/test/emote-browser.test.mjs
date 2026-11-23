// The channel page's Emotes tab: shaping a provider's list, overlay marking, the search filter, labels and facts, the
// bigger preview, the Twitch channel emotes (Helix /chat/emotes), and the A (chat draft) and Y (quick chat) actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTE_TABS, shapeEmotes, isOverlay, filterEmotes, tabLabel, bigUrl, emoteFacts, emptyText,
  draftAvailability, addToDraft, peekDraft, takeDraft, addEmotePhrase,
} from '../src/js/emote-browser.js';
import { fetchChannelEmotes, ChannelEmoteCache } from '../src/js/user-emotes.js';
import { CHANNEL_TABS } from '../src/shared/channel-page.js';
import { DEFAULT_QUICK_CHAT, MAX_PHRASES } from '../src/shared/quick-chat.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';
import { demoFetch } from '../src/js/demo/install.js';
import { LOADERS } from '../src/js/emote-providers.js';

const E = (name, extra = {}) => ({ provider: '7tv', id: name, name, url: `https://cdn.7tv.app/emote/${name}/2x.webp`, zeroWidth: false, ...extra });

test('the Emotes tab sits between Schedule and About, with 7TV, BTTV, FFZ and Twitch sub-tabs', () => {
  assert.deepEqual(CHANNEL_TABS.map((t) => t.value).slice(3, 6), ['schedule', 'emotes', 'about']);
  assert.deepEqual(EMOTE_TABS.map((t) => t.label), ['7TV', 'BTTV', 'FFZ', 'Twitch']);
});

test('shaping: A–Z ignoring case, one per name, no emotes without a name or picture', () => {
  const out = shapeEmotes([E('zed'), E('Alpha'), E('beta'), E('alpha'), E('Alpha', { id: 'dupe' }), { name: '', url: 'x' }, { name: 'nopic' }, null]);
  assert.deepEqual(out.map((e) => e.name), ['Alpha', 'alpha', 'beta', 'zed']);
  assert.equal(out[0].id, 'Alpha', 'the first of a name wins (the channel set comes first)');
  assert.deepEqual(shapeEmotes(undefined), []);
});

test('zero-width marking: 7TV/BTTV flags and FFZ modifiers are overlays', () => {
  const out = shapeEmotes([E('Hat', { zeroWidth: true }), E('Face'), { ...E('Flip'), provider: 'ffz', ffzModifier: true }]);
  assert.deepEqual(out.map((e) => [e.name, e.overlay]), [['Face', false], ['Flip', true], ['Hat', true]]);
  assert.equal(isOverlay(null), false);
});

test('search: case-insensitive substring, prefix matches first, empty query → everything', () => {
  const list = shapeEmotes(['catJAM', 'PepeHands', 'Jammies', 'jamCat', 'KEKW'].map((n) => E(n)));
  assert.deepEqual(filterEmotes(list, ' jam ').map((e) => e.name), ['jamCat', 'Jammies', 'catJAM']);
  assert.deepEqual(filterEmotes(list, 'xyz'), []);
  assert.equal(filterEmotes(list, '  '), list);
});

test('labels, empty states, the bigger picture and the detail facts', () => {
  assert.equal(tabLabel('7tv', 312), '7TV 312');
  assert.equal(tabLabel('bttv', 0), 'BTTV 0');
  assert.equal(tabLabel('ffz', 1200), 'FFZ 999+');
  assert.equal(tabLabel('twitch', null), 'Twitch', 'loading or failed: no count');
  assert.equal(emptyText('7tv', 'PixelMoth'), 'PixelMoth has no 7TV emote set.');
  assert.equal(emptyText('twitch', 'PixelMoth'), 'PixelMoth has no Twitch channel emotes.');

  assert.equal(bigUrl(E('a')), 'https://cdn.7tv.app/emote/a/4x.webp');
  assert.equal(bigUrl({ url: 'https://cdn.7tv.app/emote/a/2x_static.webp' }), 'https://cdn.7tv.app/emote/a/4x_static.webp');
  assert.equal(bigUrl({ url: 'https://cdn.betterttv.net/emote/b/2x.png' }), 'https://cdn.betterttv.net/emote/b/3x.png');
  assert.equal(bigUrl({ url: 'https://cdn.frankerfacez.com/emote/9/animated/2.webp' }), 'https://cdn.frankerfacez.com/emote/9/animated/4.webp');
  assert.equal(bigUrl({ url: 'https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/2.0' }), 'https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0');
  assert.equal(bigUrl({ url: 'lbhls://demo/img/emote/x.svg' }), 'lbhls://demo/img/emote/x.svg', 'other hosts unchanged');

  const [hat] = shapeEmotes([E('Hat', { zeroWidth: true, author: 'Maker', animated: true })]);
  assert.deepEqual(emoteFacts(hat), [['Provider', '7TV'], ['By', 'Maker'], ['Zero-width', 'Yes'], ['Animated', 'Yes']]);
  const [sub] = shapeEmotes([{ provider: 'twitch', name: 'chanHi', url: 'u', emoteType: 'subscriptions', tier: '2000' }]);
  assert.deepEqual(emoteFacts(sub), [['Provider', 'Twitch'], ['Type', 'Subscriber · Tier 2'], ['Zero-width', 'No']]);
  const [ffz] = shapeEmotes([{ provider: 'ffz', name: 'z', url: 'u', author: 'Own' }]);
  assert.deepEqual(emoteFacts(ffz)[1], ['Owner', 'Own']);
});

test('Twitch channel emotes: Helix /chat/emotes with the broadcaster, template URLs, tier and animation; cached', async () => {
  const calls = [];
  const helix = async (path, query) => {
    calls.push([path, query]);
    return {
      template: 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}',
      data: [
        { id: '1', name: 'chanHi', tier: '1000', emote_type: 'subscriptions', format: ['static', 'animated'] },
        { id: '2', name: 'chanGG', tier: '', emote_type: 'follower', format: ['static'] },
        { id: '3', name: 'chanHi', tier: '2000', emote_type: 'subscriptions', format: ['static'] },
      ],
    };
  };
  const list = await fetchChannelEmotes(helix, '42');
  assert.deepEqual(calls, [['/chat/emotes', { broadcaster_id: '42' }]]);
  assert.deepEqual(list.map((e) => [e.name, e.tier, e.animated, e.emoteType]), [['chanHi', '1000', true, 'subscriptions'], ['chanGG', '', false, 'follower']]);
  assert.equal(list[0].url, 'https://static-cdn.jtvnw.net/emoticons/v2/1/animated/dark/2.0');
  assert.equal((await fetchChannelEmotes(helix, '42', { animated: false }))[0].url, 'https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/2.0', 'the Animated emotes setting');

  let n = 0;
  const cache = new ChannelEmoteCache(async () => { n++; return { data: [] }; });
  await cache.get('42');
  await cache.get('42');
  await cache.get('42', { animated: false });
  assert.equal(n, 2, 'one request per channel and animation setting');
});

test('A: the chat draft needs a sign-in and Lurkbox chat; emotes build up per channel; the player takes it', () => {
  assert.equal(draftAvailability({ signedIn: false }, {}), 'signed-out');
  assert.equal(draftAvailability({ signedIn: true }, { chatStyle: 'twitch' }), 'twitch-style');
  assert.equal(draftAvailability({ signedIn: true }, { chatStyle: 'lurkbox' }), 'ok');

  const drafts = new Map();
  assert.equal(addToDraft('PixelMoth', 'lurkWave', drafts), 'lurkWave ');
  assert.equal(addToDraft('pixelmoth', 'boxHype', drafts), 'lurkWave boxHype ', 'logins ignore case');
  assert.equal(addToDraft('other', 'hehe', drafts), 'hehe ', 'each channel has its own');
  assert.equal(peekDraft('pixelmoth', drafts), 'lurkWave boxHype ');
  drafts.set('long', 'x'.repeat(495));
  assert.equal(addToDraft('long', 'boxHype', drafts), null, 'over 500 characters: refused');
  assert.equal(drafts.get('long').length, 495, 'and the draft is unchanged');
  assert.equal(takeDraft('PIXELMOTH', drafts), 'lurkWave boxHype ');
  assert.equal(takeDraft('pixelmoth', drafts), '', 'taken once');
});

test('Y: the emote becomes one of the channel\'s quick-chat phrases (once; at most MAX_PHRASES)', () => {
  const ch = { id: '7100004', login: 'pixelmoth' };
  const a = addEmotePhrase(DEFAULT_QUICK_CHAT, ch, 'boxHype');
  assert.equal(a.result, 'added');
  assert.deepEqual(a.qc.channels['7100004'], { login: 'pixelmoth', phrases: ['boxHype'] });
  assert.deepEqual(a.qc.global, [...DEFAULT_QUICK_CHAT.global], 'the global list is untouched');
  const b = addEmotePhrase(a.qc, ch, 'boxHype');
  assert.equal(b.result, 'exists');
  assert.deepEqual(b.qc, a.qc);
  const full = { global: [], channels: { 7100004: { login: 'pixelmoth', phrases: Array.from({ length: MAX_PHRASES }, (_, i) => `p${i}`) } } };
  assert.equal(addEmotePhrase(full, ch, 'boxHype').result, 'full');
  assert.equal(addEmotePhrase(null, ch, 'x').result, 'added', 'no saved quick chat yet');
});

test('demo data: a big 7TV set with owners and an overlay, no BTTV set, FFZ, and Twitch channel emotes', async () => {
  const media = (p) => `lbhls://demo/${p}`;
  const f = demoFetch({ realFetch: null, origin: 'http://localhost:1', media });
  const seven = shapeEmotes((await LOADERS['7tv'](f, '7100004')).emotes);
  assert.ok(seven.length >= 15, `7TV: ${seven.length}`);
  assert.ok(seven.some((e) => e.overlay) && seven.every((e) => e.author));
  assert.deepEqual((await LOADERS.bttv(f, '7100004')).emotes, [], 'the BTTV empty state');
  assert.ok((await LOADERS.ffz(f, '7100004')).emotes.length >= 3);
  const db = buildDemoData({ media });
  const helix = async (path, query) => { const r = demoHelix(db, { path, query }); if (!r.ok) throw new Error(r.error); return r.data; };
  const tw = await fetchChannelEmotes(helix, '7100004');
  assert.deepEqual(tw.map((e) => [e.name, e.emoteType, e.tier]), [['lurkerHi', 'subscriptions', '1000'], ['lurkerLove', 'subscriptions', '2000'], ['lurkerGG', 'follower', '']]);
});
