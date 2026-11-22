// Quick chat and the emote picker: stored phrases (sanitising, per-channel ordering, list edits), recent emotes per
// account, inserting an emote into the message, the picker's tabs, your own Twitch emotes (Helix, paginated), and the
// pop-over hook that gives quick chat its X/Y and the picker its LB/RB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUICK_CHAT, sanitizeQuickChat, sanitizePhrases, cleanPhrase, sanitizeEmoteRecents, pushRecent, quickPhrases, phraseList,
  editPhrases, listOps, MAX_PHRASES, MAX_RECENTS,
} from '../src/shared/quick-chat.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { insertEmote, pickerTabs, initialTab } from '../src/js/emote-picker.js';
import { fetchUserEmotes, emoteUrlFromTemplate, UserEmoteCache } from '../src/js/user-emotes.js';
import { Popover } from '../src/js/popover.js';
import { overlayControls, controlLabel, controlIcon, POPOVER_CONTROLS } from '../src/js/player-ui.js';
import { PLAYER_ICONS } from '../src/js/icons.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';

test('starter phrases, and the settings keys', () => {
  assert.deepEqual([...DEFAULT_QUICK_CHAT.global], ['gg', 'LUL', 'hype!', 'o7', 'PogChamp']);
  assert.deepEqual(DEFAULT_SETTINGS.quickChat.global, DEFAULT_QUICK_CHAT.global);
  assert.deepEqual(sanitizeSettings({ quickChat: null }).quickChat, { global: [...DEFAULT_QUICK_CHAT.global], channels: {} }, 'garbage → the starter list');
  assert.equal('quickChat' in sanitizeSettings({ theme: 'oled' }), false, 'untouched when not in the patch');
});

test('quick chat is sanitised: strings ≤ 500 characters, ≤ 30 per list, channels keyed by broadcaster id', () => {
  assert.equal(cleanPhrase('  hi \n there\t'), 'hi there');
  assert.equal(cleanPhrase(42), '');
  assert.equal(Array.from(cleanPhrase('😀'.repeat(600))).length, 500, 'cut to 500 characters, not UTF-16 units');
  assert.deepEqual(sanitizePhrases(['a', '', '  ', 'a', 7, null, { x: 1 }, 'b']), ['a', 'b'], 'no empties, repeats or non-strings');
  assert.equal(sanitizePhrases(Array.from({ length: 50 }, (_, i) => `p${i}`)).length, MAX_PHRASES);
  const q = sanitizeSettings({
    quickChat: {
      global: ['gg', 'gg', ''],
      channels: {
        7100004: { login: 'PixelMoth', phrases: ['moth gang', ''] },
        abc: { login: 'x', phrases: ['bad key'] },
        12: { login: 'not a login!', phrases: ['kept, login dropped'] },
        13: { login: 'empty', phrases: [] },
        14: 'nope',
      },
      extra: 'ignored',
    },
  }).quickChat;
  assert.deepEqual(q, {
    global: ['gg'],
    channels: { 7100004: { login: 'pixelmoth', phrases: ['moth gang'] }, 12: { login: '', phrases: ['kept, login dropped'] } },
  });
});

test('per-channel ordering: the channel\'s phrases first, then the global ones (without repeats)', () => {
  const qc = { global: ['gg', 'o7', 'hype!'], channels: { 5: { login: 'chan', phrases: ['moth gang', 'o7'] } } };
  assert.deepEqual(quickPhrases(qc, '5'), [
    { text: 'moth gang', scope: 'channel', index: 0 }, { text: 'o7', scope: 'channel', index: 1 },
    { text: 'gg', scope: 'global', index: 0 }, { text: 'hype!', scope: 'global', index: 2 },
  ]);
  assert.deepEqual(quickPhrases(qc, '6').map((p) => p.text), ['gg', 'o7', 'hype!'], 'another channel: global only');
  assert.deepEqual(quickPhrases(qc, null).map((p) => p.scope), ['global', 'global', 'global']);
  assert.deepEqual(phraseList(qc, 'channel', '5'), ['moth gang', 'o7']);
  assert.deepEqual(phraseList(qc, 'global'), ['gg', 'o7', 'hype!']);
});

test('list edits: add, edit, delete, reorder; a channel list is created with its login and removed when empty', () => {
  let qc = sanitizeQuickChat(DEFAULT_QUICK_CHAT);
  qc = editPhrases(qc, 'channel', { id: '9', login: 'somechan' }, (l) => listOps.add(l, 'hello chat'));
  assert.deepEqual(qc.channels[9], { login: 'somechan', phrases: ['hello chat'] });
  qc = editPhrases(qc, 'channel', { id: '9' }, (l) => listOps.add(l, 'bye'));
  assert.deepEqual(qc.channels[9], { login: 'somechan', phrases: ['hello chat', 'bye'] }, 'the login is kept');
  qc = editPhrases(qc, 'channel', { id: '9' }, (l) => listOps.move(l, 1, -1));
  assert.deepEqual(qc.channels[9].phrases, ['bye', 'hello chat']);
  qc = editPhrases(qc, 'global', null, (l) => listOps.set(l, 0, 'GG!'));
  assert.equal(qc.global[0], 'GG!');
  qc = editPhrases(qc, 'global', null, (l) => listOps.remove(l, 1));
  assert.deepEqual(qc.global, ['GG!', 'hype!', 'o7', 'PogChamp']);
  qc = editPhrases(qc, 'channel', { id: '9' }, () => []);
  assert.equal('9' in qc.channels, false, 'emptied → removed');
  assert.deepEqual(editPhrases(qc, 'channel', { id: 'x' }, () => ['a']), qc, 'a bad id changes nothing');
  assert.deepEqual(listOps.move(['a', 'b'], 0, -1), ['a', 'b'], 'not past the top');
  assert.deepEqual(listOps.move(['a', 'b'], 1, 1), ['a', 'b'], 'not past the bottom');
  const full = Array.from({ length: MAX_PHRASES }, (_, i) => `p${i}`);
  assert.equal(listOps.add(full, 'more').length, MAX_PHRASES);
});

test('recent emotes per account: newest first, no repeats, at most 24', () => {
  let r = pushRecent({}, '1000001', 'lurkerHi');
  r = pushRecent(r, '1000001', 'boxHype');
  r = pushRecent(r, '1000001', 'lurkerHi');
  r = pushRecent(r, '1000002', 'gigaGG');
  assert.deepEqual(r, { 1000001: ['lurkerHi', 'boxHype'], 1000002: ['gigaGG'] });
  for (let i = 0; i < 40; i++) r = pushRecent(r, '1000001', `e${i}`);
  assert.equal(r[1000001].length, MAX_RECENTS);
  assert.equal(r[1000001][0], 'e39');
  assert.deepEqual(pushRecent({}, 'nope', 'x'), {}, 'no account');
  assert.deepEqual(sanitizeEmoteRecents({ 1: ['a', 'a', 'with space', 5, 'b'], x: ['c'], 2: 'no' }), { 1: ['a', 'b'] });
  assert.deepEqual(sanitizeSettings({ emoteRecents: { 1: ['ok'] } }).emoteRecents, { 1: ['ok'] });
});

test('inserting an emote: at the caret, spaced, never over 500 characters', () => {
  assert.deepEqual(insertEmote('', 0, 'lurkerHi'), { text: 'lurkerHi ', caret: 9 });
  assert.deepEqual(insertEmote('hello', null, 'lurkerHi'), { text: 'hello lurkerHi ', caret: 15 });
  assert.deepEqual(insertEmote('hello ', 6, 'gg'), { text: 'hello gg ', caret: 9 });
  assert.deepEqual(insertEmote('hello world', 5, 'o7'), { text: 'hello o7 world', caret: 9 }, 'in the middle: no double space');
  assert.deepEqual(insertEmote('ab', 99, 'x'), { text: 'ab x ', caret: 5 }, 'a bad caret means the end');
  assert.equal(insertEmote('a'.repeat(495), null, 'lurkerHi'), null);
  assert.ok(insertEmote('a'.repeat(490), null, 'lurkerHi'));
});

test('the picker\'s tabs: Recent, Twitch, then 7TV / BTTV / FFZ (channel before global, enabled only)', () => {
  const e = (provider, name) => ({ provider, name, id: name, url: `u/${name}` });
  const sets = new Map([
    ['7tv:global', new Map([['peek', e('7tv', 'peek')], ['wave', e('7tv', 'wave')]])],
    ['7tv:channel', new Map([['wave', e('7tv', 'wave')], ['hype', e('7tv', 'hype')]])],
    ['ffz:channel', new Map([['tea', e('ffz', 'tea')]])],
  ]);
  const own = [e('twitch', 'lurkerHi')];
  const all = new Map([...own, ...[...sets.values()].flatMap((m) => [...m.values()])].map((x) => [x.name, x]));
  const tabs = pickerTabs({ recents: ['hype', 'gone', 'lurkerHi'], own, sets, enabled: ['7tv', 'ffz'], lookup: (n) => all.get(n) || null });
  assert.deepEqual(tabs.map((t) => t.key), ['recent', 'twitch', '7tv', 'ffz'], 'BTTV off: no tab');
  assert.deepEqual(tabs[0].emotes.map((x) => x.name), ['hype', 'lurkerHi'], 'recents that no longer exist are skipped');
  assert.deepEqual(tabs[2].emotes.map((x) => x.name), ['wave', 'hype', 'peek'], 'channel first, no repeats');
  assert.equal(initialTab(tabs), 'recent');
  assert.equal(initialTab(pickerTabs({ own, sets })), 'twitch', 'no recents: the first tab with emotes');
  assert.equal(initialTab(pickerTabs({})), 'twitch', 'nothing at all: Twitch');
});

test('your Twitch emotes: every page of /chat/emotes/user, the template, the channel\'s own first', async () => {
  const calls = [];
  const pages = {
    '': { data: [{ id: '1', name: 'zebraGG', owner_id: '0', format: ['static'] }, { id: '2', name: 'chanHi', owner_id: '55', format: ['static', 'animated'] }], template: 'T/{{id}}/{{format}}/{{theme_mode}}/{{scale}}', pagination: { cursor: 'c2' } },
    c2: { data: [{ id: '3', name: 'appleLUL', owner_id: '0', format: ['static'] }, { id: '1', name: 'zebraGG' }], template: 'T/{{id}}/{{format}}/{{theme_mode}}/{{scale}}', pagination: {} },
  };
  const helixFn = async (path, q) => { calls.push([path, q]); return pages[q.after || '']; };
  const list = await fetchUserEmotes(helixFn, '1000001', '55');
  assert.deepEqual(calls.map(([p, q]) => [p, q.user_id, q.broadcaster_id, q.after]), [['/chat/emotes/user', '1000001', '55', undefined], ['/chat/emotes/user', '1000001', '55', 'c2']]);
  assert.deepEqual(list.map((x) => x.name), ['chanHi', 'appleLUL', 'zebraGG'], 'the channel\'s own, then by name; no repeats');
  assert.equal(list[0].url, 'T/2/animated/dark/2.0');
  assert.equal(list[1].url, 'T/3/static/dark/2.0');
  assert.equal(emoteUrlFromTemplate(null, { id: 'x', format: ['animated'] }, { animated: false }), 'https://static-cdn.jtvnw.net/emoticons/v2/x/static/dark/2.0');
  const cache = new UserEmoteCache(helixFn);
  await cache.get('1000001', '55');
  await cache.get('1000001', '55');
  assert.equal(calls.length, 4, 'cached');
});

test('demo mode: your own emotes, two to a page, pictured by the demo', async () => {
  const db = buildDemoData({ media: (p) => `lbhls://demo/${p}` });
  const me = db.accounts[0].id;
  const list = await fetchUserEmotes(async (path, query) => demoHelix(db, { path, query }, { activeId: me }).data, me, '7100004');
  assert.deepEqual(list.map((x) => x.name).sort(), ['lurkerGG', 'lurkerHi', 'lurkerLove', 'lurkerZzz']);
  assert.ok(list.every((x) => /^lbhls:\/\/demo\/img\/emote\/lurker\w+\.svg$/.test(x.url)), 'demo pictures, no network');
  assert.equal(demoHelix(db, { path: '/chat/emotes/user', query: { user_id: '999' } }, { activeId: me }).ok, false);
});

test('overlay: quick chat (lightning bubble) after "Send a message", a pop-over; its X/Y go to the pop-over', () => {
  assert.deepEqual(overlayControls({ kind: 'live', compose: true, quick: true }), ['play', 'volume', 'quality', 'chat', 'compose', 'quick', 'live', 'channel', 'more', 'back']);
  assert.deepEqual(overlayControls({ kind: 'live', quick: true }).slice(3, 5), ['chat', 'quick'], 'Twitch chat style: quick chat without the composer');
  assert.ok(POPOVER_CONTROLS.has('quick'));
  assert.equal(controlLabel('quick'), 'Quick chat');
  assert.ok(PLAYER_ICONS[controlIcon('quick')]);
  for (const n of ['emote', 'send', 'keyboard', 'plus', 'up', 'down']) assert.ok(PLAYER_ICONS[n], n);
  const seen = [];
  const node = { remove() {}, querySelector: () => null, contains: () => true };
  const pop = new Popover({ focus() {}, move() {}, active: () => null, scope: null });
  pop.open({ key: 'quick', node, opener: null, onAction: (a) => { seen.push(a); return a === 'X' || a === 'Y'; } });
  assert.equal(pop.handle('Y'), true);
  assert.equal(pop.handle('X'), true);
  assert.equal(pop.handle('LB'), false, 'not taken: passes through');
  assert.equal(pop.handle('B'), true, 'B still closes');
  assert.equal(pop.isOpen, false);
  assert.deepEqual(seen, ['Y', 'X', 'LB']);
});
