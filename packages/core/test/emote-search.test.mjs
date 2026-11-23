// Emote search: 7TV's search (request, mapping, debounce, paging), the seen-channels index (add, cap, LRU, per
// account) and its ranking, and demo mode's made-up answers (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, fakeFetch } from './helpers.mjs';
import {
  buildSearchRequest, mapSearchItem, mapSearchResponse, searchEmotes, emoteUsage, SevenTvSearch, SEVENTV_GQL,
} from '../src/js/seventv-search.js';
import {
  emptyIndex, indexChannel, sanitizeEmoteIndex, searchSeen, indexSize, emoteUrl, accountsWithIndex, MAX_ENTRIES,
} from '../src/shared/emote-index.js';
import { EmoteIndexStore } from '../src/js/emote-index-store.js';
import { demoFetch, demoCatalog } from '../src/js/demo/install.js';

const img = (id, name, scale = 2) => ({ url: `https://cdn.7tv.app/emote/${id}/${name}`, mime: name.endsWith('.webp') ? 'image/webp' : 'image/png', scale, frameCount: name.includes('static') ? 1 : 10 });
const item = (id, name, { animated = false, zw = false, owner = 'Artist' } = {}) => ({
  id, defaultName: name, flags: { animated, defaultZeroWidth: zw }, owner: { mainConnection: { platformDisplayName: owner } },
  images: animated
    ? [img(id, '1x.webp', 1), img(id, '2x_static.webp'), img(id, '2x.webp'), img(id, '4x.webp', 4)]
    : [img(id, '1x.png', 1), img(id, '2x.png'), img(id, '2x.webp')].map((i) => ({ ...i, frameCount: 1 })),
});
const page = (items, { total = items.length, pageCount = 1 } = {}) => ({ data: { emotes: { search: { totalCount: total, pageCount, items } } } });

test('7TV search request: v4 GraphQL, query trimmed (empty = popular), sort, filters only when on, page bounds', () => {
  const r = buildSearchRequest({ query: '  catJAM ', page: 2, perPage: 30, sort: 'newest', animated: true });
  assert.equal(r.url, SEVENTV_GQL);
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['Content-Type'], 'application/json');
  const b = JSON.parse(r.init.body);
  assert.match(b.query, /emotes \{ search\(query: \$query/);
  assert.deepEqual(b.variables, { query: 'catJAM', page: 2, perPage: 30, sort: { sortBy: 'UPLOAD_DATE', order: 'DESCENDING' }, filters: { animated: true } });
  const d = JSON.parse(buildSearchRequest({ query: ' ', page: 0, perPage: 999, sort: 'bogus', zeroWidth: true }).init.body).variables;
  assert.equal(d.query, null, 'empty: no query (7TV lists its top emotes)');
  assert.equal(d.page, 1);
  assert.equal(d.perPage, 100);
  assert.equal(d.sort.sortBy, 'TOP_ALL_TIME', 'unknown sort: popular');
  assert.deepEqual(d.filters, { defaultZeroWidth: true });
  assert.equal(JSON.parse(buildSearchRequest({ sort: 'trending' }).init.body).variables.sort.sortBy, 'TRENDING_WEEKLY');
});

test('7TV search response: the app\'s emote shape, 2x WebP (static when animation is off), owners, errors', () => {
  const a = mapSearchItem(item('A1', 'catJAM', { animated: true, zw: true, owner: 'Frocasso' }));
  assert.deepEqual(a, { provider: '7tv', id: 'A1', name: 'catJAM', url: 'https://cdn.7tv.app/emote/A1/2x.webp', w: 0, h: 0, zeroWidth: true, animated: true, author: 'Frocasso' });
  assert.equal(mapSearchItem(item('A1', 'catJAM', { animated: true }), { animated: false }).url, 'https://cdn.7tv.app/emote/A1/2x_static.webp');
  assert.equal(mapSearchItem(item('S1', 'Okay')).url, 'https://cdn.7tv.app/emote/S1/2x.webp');
  assert.equal(mapSearchItem({ ...item('X', 'x'), images: [{ url: 'https://evil.example/x.webp', scale: 2 }] }), null, 'only 7TV\'s CDN');
  assert.equal(mapSearchItem({ id: 'x' }), null);
  const r = mapSearchResponse(page([item('A', 'a'), { id: 'bad' }, item('B', 'b')], { total: 120, pageCount: 3 }));
  assert.deepEqual(r.items.map((e) => e.id), ['A', 'B']);
  assert.equal(r.total, 120);
  assert.equal(r.pageCount, 3);
  assert.throws(() => mapSearchResponse({ errors: [{ message: 'rate limited' }] }), /rate limited/);
  assert.throws(() => mapSearchResponse({ data: {} }), /no search result/);
});

test('7TV fetch: one POST per page, HTTP errors thrown; the usage count', async () => {
  const f = fakeFetch([[(u, init) => JSON.parse(init.body).query.includes('Usage'), () => json(200, { data: { emotes: { emote: { channels: { totalCount: 9917 } } } } })],
    ['7tv.io/v4/gql', () => json(200, page([item('A', 'a')]))]]);
  const r = await searchEmotes(f, { query: 'a' });
  assert.equal(r.items[0].name, 'a');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(await emoteUsage(f, 'A'), 9917);
  await assert.rejects(searchEmotes(async () => json(503, {}), { query: 'a' }), /HTTP 503/);
  assert.equal(await emoteUsage(async () => json(500, {}), 'A'), null);
});

/** Manual timers: run() fires everything due. */
function manualTimers() {
  let id = 0;
  const due = new Map();
  return {
    setTimeout: (fn) => { due.set(++id, fn); return id; },
    clearTimeout: (t) => { due.delete(t); },
    pending: () => due.size,
    run: () => { const fns = [...due.values()]; due.clear(); for (const fn of fns) fn(); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('7TV search as you type: debounced (one request for a burst of keys), paged, stale answers dropped', async () => {
  const timers = manualTimers();
  const calls = [];
  const fetchFn = async (url, init) => {
    const v = JSON.parse(init.body).variables;
    calls.push(v);
    const items = [1, 2].map((n) => item(`${v.query}-${v.page}-${n}`, `${v.query}${v.page}${n}`));
    return json(200, page(items, { total: 5, pageCount: 3 }));
  };
  const states = [];
  const s = new SevenTvSearch({ fetchFn, timers, perPage: 2, onChange: (st) => states.push(st) });
  s.set({ query: 'c' });
  s.set({ query: 'ca' });
  s.set({ query: 'cat' });
  assert.equal(calls.length, 0, 'nothing before the pause');
  assert.equal(timers.pending(), 1, 'one timer for the burst');
  assert.equal(s.state.loading, true);
  timers.run();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'cat');
  assert.deepEqual(s.state.items.map((e) => e.name), ['cat11', 'cat12']);
  assert.equal(s.state.page, 1);
  assert.equal(s.state.done, false);
  s.set({ query: ' cat ' });
  assert.equal(timers.pending(), 0, 'the same query (ignoring spaces) does not search again');
  assert.equal(s.more(), true);
  assert.equal(s.more(), false, 'one page at a time');
  await tick();
  assert.equal(calls[1].page, 2);
  assert.deepEqual(s.state.items.map((e) => e.name), ['cat11', 'cat12', 'cat21', 'cat22']);
  s.more();
  await tick();
  assert.equal(s.state.page, 3);
  assert.equal(s.state.done, true, 'the last page');
  assert.equal(s.more(), false);
  // A new search while a page is loading: the old answer is dropped.
  let release;
  const slow = new SevenTvSearch({ fetchFn: (u, init) => new Promise((r) => { release = () => r(fetchFn(u, init)); }), timers, perPage: 2 });
  slow.set({ query: 'old' }, { now: true });
  const first = release;
  slow.set({ query: 'new' }, { now: true });
  release();
  await tick(); await tick();
  first();
  await tick(); await tick();
  assert.deepEqual(slow.state.items.map((e) => e.name), ['new11', 'new12']);
  // A sort or filter change searches at once.
  const n = calls.length;
  s.set({ sort: 'newest' }, { now: true });
  await tick();
  assert.equal(calls.length, n + 1);
  assert.equal(calls[n].sort.sortBy, 'UPLOAD_DATE');
  assert.equal(calls[n].page, 1, 'back to the first page');
  assert.ok(states.length > 5);
});

test('7TV search errors keep the grid and stop paging', async () => {
  const s = new SevenTvSearch({ fetchFn: async () => json(500, {}), timers: manualTimers() });
  s.set({ query: 'x' }, { now: true });
  await tick(); await tick();
  assert.match(s.state.error, /HTTP 500/);
  assert.equal(s.more(), false);
});

// ---- the seen-channels index ----

const em = (provider, id, name, url) => ({ provider, id, name, url: url || emoteUrl(provider, id) });
const chA = { id: '1001', login: 'alpha', name: 'Alpha' };
const chB = { id: '1002', login: 'bravo', name: 'Bravo' };
const chC = { id: '1003', login: 'charlie', name: 'Charlie' };

test('index: records a channel\'s set per provider, most recent channel first, compact entries', () => {
  let idx = indexChannel(emptyIndex(), chA, '7tv', [em('7tv', 'S1', 'catJAM'), em('7tv', 'S2', 'peepoHey', 'https://cdn.7tv.app/emote/S2/2x_static.webp')], { now: 10 });
  idx = indexChannel(idx, chA, 'bttv', [em('bttv', 'B1', 'monkaS')], { now: 11 });
  assert.equal(idx.channels.length, 1);
  assert.deepEqual(idx.channels[0].emotes, [['7tv', 'S1', 'catJAM'], ['7tv', 'S2', 'peepoHey', 'https://cdn.7tv.app/emote/S2/2x_static.webp'], ['bttv', 'B1', 'monkaS']], 'the usual URL is left out');
  idx = indexChannel(idx, chB, 'ffz', [em('ffz', '77', 'tea')], { now: 12 });
  assert.deepEqual(idx.channels.map((c) => c.login), ['bravo', 'alpha']);
  // A channel's provider set is replaced, and seeing it again moves it to the front.
  idx = indexChannel(idx, chA, '7tv', [em('7tv', 'S3', 'catKISS')], { now: 13 });
  assert.deepEqual(idx.channels.map((c) => c.login), ['alpha', 'bravo']);
  assert.deepEqual(idx.channels[0].emotes.map((e) => e[2]), ['monkaS', 'catKISS']);
  assert.equal(idx.channels[0].at, 13);
  assert.equal(indexSize(idx), 3);
  // Bad input leaves it alone.
  assert.equal(indexChannel(idx, { id: 'x', login: 'alpha' }, '7tv', []), idx);
  assert.equal(indexChannel(idx, chA, 'other', []), idx);
});

test('index: capped (least recently seen channels go first), validated on load', () => {
  const many = (p, n, prefix) => Array.from({ length: n }, (_, i) => em(p, `${prefix}${i}`, `${prefix}${i}`));
  let idx = indexChannel(emptyIndex(), chA, '7tv', many('7tv', 4, 'a'), { max: 10 });
  idx = indexChannel(idx, chB, '7tv', many('7tv', 4, 'b'), { max: 10 });
  idx = indexChannel(idx, chC, '7tv', many('7tv', 4, 'c'), { max: 10 });
  assert.deepEqual(idx.channels.map((c) => [c.login, c.emotes.length]), [['charlie', 4], ['bravo', 4], ['alpha', 2]], 'the oldest channel is cut');
  idx = indexChannel(idx, chA, 'bttv', many('bttv', 1, 'x'), { max: 10 });
  assert.deepEqual(idx.channels.map((c) => c.login), ['alpha', 'charlie', 'bravo'], 'LRU: seen again, kept');
  assert.ok(indexSize(idx) <= 10);
  assert.equal(MAX_ENTRIES, 20000);
  const big = indexChannel(emptyIndex(), chA, '7tv', many('7tv', MAX_ENTRIES + 50, 'z'));
  assert.equal(indexSize(big), MAX_ENTRIES);

  const dirty = { channels: [
    { id: '1001', login: 'alpha', name: 'Alpha', at: 5, emotes: [['7tv', 'S1', 'ok'], ['evil', 'x', 'y'], ['7tv', 'S2', 'js', 'javascript:alert(1)'], ['bttv', 'B1', 'demo', 'lbhls://demo/img/emote/x.svg']] },
    { id: '1001', login: 'alpha', emotes: [] },
    { id: 'nope', login: 'bad', emotes: [] },
    { id: '1002', login: 'Not A Login', emotes: [] },
  ] };
  const clean = sanitizeEmoteIndex(dirty);
  assert.equal(clean.channels.length, 1, 'one per channel, valid ids and logins only');
  assert.deepEqual(clean.channels[0].emotes, [['7tv', 'S1', 'ok'], ['bttv', 'B1', 'demo', 'lbhls://demo/img/emote/x.svg']]);
  assert.deepEqual(sanitizeEmoteIndex(null), emptyIndex());
  assert.deepEqual(sanitizeEmoteIndex({ channels: 'x' }), emptyIndex());
});

test('index per account in the host: replaced, validated, forgotten with null', () => {
  let acc = accountsWithIndex({}, '42', indexChannel(emptyIndex(), chA, '7tv', [em('7tv', 'S1', 'a')]));
  acc = accountsWithIndex(acc, '43', indexChannel(emptyIndex(), chB, '7tv', [em('7tv', 'S2', 'b')]));
  acc = accountsWithIndex(acc, null, { channels: [] });
  assert.deepEqual(Object.keys(acc).sort(), ['42', '43', 'anon']);
  assert.equal(acc['42'].channels[0].login, 'alpha');
  acc = accountsWithIndex(acc, '42', null);
  assert.deepEqual(Object.keys(acc).sort(), ['43', 'anon']);
});

test('seen search: exact > prefix > contains, then exact case, then the most recent channel; one per emote', () => {
  let idx = indexChannel(emptyIndex(), chA, '7tv', [em('7tv', 'S1', 'catJAM'), em('7tv', 'S2', 'PepeCat'), em('7tv', 'S3', 'cat')], { now: 1 });
  idx = indexChannel(idx, chB, 'bttv', [em('bttv', 'B1', 'Cat'), em('bttv', 'B2', 'catKISS')], { now: 2 });
  idx = indexChannel(idx, chC, '7tv', [em('7tv', 'S1', 'catJAM')], { now: 3 });
  const r = searchSeen(idx, ' cat ');
  assert.deepEqual(r.map((x) => `${x.name}@${x.channel.login}`), ['cat@alpha', 'Cat@bravo', 'catJAM@charlie', 'catKISS@bravo', 'PepeCat@alpha']);
  const jam = r.find((x) => x.name === 'catJAM');
  assert.equal(jam.channels, 2, 'catJAM is in two channels, shown once (the most recent)');
  assert.equal(jam.url, 'https://cdn.7tv.app/emote/S1/2x.webp');
  assert.deepEqual(jam.channel, { id: '1003', login: 'charlie', name: 'Charlie' });
  assert.deepEqual(searchSeen(idx, ''), []);
  assert.equal(searchSeen(idx, 'cat', { limit: 2 }).length, 2);
  assert.deepEqual(searchSeen(idx, 'zzz'), []);
});

test('the index store: loads per account from the host, saves after a pause, clears', async () => {
  const timers = manualTimers();
  const saved = {};
  let acct = '42';
  const host = {
    emoteIndexGet: async () => saved[acct] || null,
    emoteIndexSet: async (d) => { if (d == null) delete saved[acct]; else saved[acct] = JSON.parse(JSON.stringify(d)); return true; },
  };
  const store = new EmoteIndexStore({ host: () => host, account: () => acct, timers, now: () => 100 });
  await store.record(chA, '7tv', [em('7tv', 'S1', 'catJAM')]);
  await store.record(chA, 'ffz', [em('ffz', '9', 'tea')]);
  assert.equal(saved['42'], undefined, 'not saved yet');
  timers.run();
  assert.equal(saved['42'].channels[0].emotes.length, 2);
  // Another account has its own index.
  acct = '43';
  assert.equal(await store.size(), 0);
  await store.record(chB, '7tv', [em('7tv', 'S9', 'other')]);
  timers.run();
  assert.equal((await store.search('cat')).length, 0);
  acct = '42';
  assert.equal((await store.search('cat'))[0].name, 'catJAM');
  await store.clear();
  assert.equal(saved['42'], undefined);
  assert.equal(saved['43'].channels[0].login, 'bravo', 'the other account keeps its index');
  assert.equal(await store.size(), 0);
});

// ---- demo mode ----

test('demo mode answers Emote search from made-up emotes, with pages and filters, and nothing else', async () => {
  const media = (p) => `lbhls://demo/${p}`;
  const f = demoFetch({ realFetch: null, origin: 'http://localhost:1', media });
  const cat = demoCatalog();
  assert.ok(cat.length > 48, 'more than one page');
  const s = new SevenTvSearch({ fetchFn: f, timers: manualTimers(), perPage: 10 });
  s.set({ query: 'blob' }, { now: true });
  await tick(); await tick();
  assert.equal(s.state.total, 18);
  assert.equal(s.state.items.length, 10);
  assert.ok(s.state.items.every((e) => e.name.toLowerCase().includes('blob') && e.url.startsWith('lbhls://demo/img/emote/')));
  s.more();
  await tick(); await tick();
  assert.equal(s.state.items.length, 18);
  assert.equal(s.state.done, true);
  s.set({ query: '', zeroWidth: true }, { now: true });
  await tick(); await tick();
  assert.ok(s.state.items.length > 0 && s.state.items.every((e) => e.zeroWidth));
  assert.equal(typeof await emoteUsage(f, s.state.items[0].id), 'number');
  await assert.rejects(f('https://api.7tv.app/v4/gql', { method: 'POST', body: '{}' }), /network access is blocked/);
});
