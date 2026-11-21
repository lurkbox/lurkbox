import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages, chunk, mergeFollows, sortOffline, parseDuration, lastLiveFromVod } from '../src/js/follows.js';
import { Poller, focusAfterUpdate } from '../src/js/refresher.js';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('pagination follows cursors until the last page', async () => {
  const pages = { null: { items: [1, 2], cursor: 'a' }, a: { items: [3], cursor: 'b' }, b: { items: [4], cursor: null } };
  const seen = [];
  const all = await fetchAllPages(async (c) => { seen.push(c); return pages[c]; });
  assert.deepEqual(all, [1, 2, 3, 4]);
  assert.deepEqual(seen, [null, 'a', 'b']);
});

test('user lookups are batched at 100', () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(i));
  assert.deepEqual(chunk(ids).map((c) => c.length), [100, 100, 50]);
});

const F = (id, name, followed_at = '2024-01-01T00:00:00Z') => ({ broadcaster_id: id, broadcaster_login: name.toLowerCase(), broadcaster_name: name, followed_at });

test('merging live and offline: no duplicates, live wins', () => {
  const follows = [F('1', 'Alpha'), F('2', 'Beta'), F('2', 'Beta'), F('3', 'Gamma')];
  const live = [{ user_id: '2', user_login: 'beta' }];
  const r = mergeFollows(follows, live);
  assert.deepEqual(r.live.map((s) => s.user_id), ['2']);
  assert.deepEqual(r.offline.map((f) => f.broadcaster_id), ['1', '3']);
});

test('offline sort orders', () => {
  const list = [F('1', 'charlie', '2024-03-01T00:00:00Z'), F('2', 'Alpha', '2024-01-01T00:00:00Z'), F('3', 'bravo', '2024-05-01T00:00:00Z')];
  assert.deepEqual(sortOffline(list, 'az').map((f) => f.broadcaster_id), ['2', '3', '1']);
  assert.deepEqual(sortOffline(list, 'followed').map((f) => f.broadcaster_id), ['3', '1', '2']);
  const known = new Map([['1', 2000], ['3', 1000]]);
  assert.deepEqual(sortOffline(list, 'recent', known).map((f) => f.broadcaster_id), ['1', '3', '2'], 'known last-live first, then A–Z');
});

test('last live from the latest archive VOD', () => {
  assert.equal(parseDuration('3h2m1s'), (3 * 3600 + 2 * 60 + 1) * 1000);
  assert.equal(parseDuration('45s'), 45000);
  assert.equal(lastLiveFromVod({ created_at: '2026-11-20T10:00:00Z', duration: '1h0m0s' }), Date.parse('2026-11-20T11:00:00Z'));
  assert.equal(lastLiveFromVod(undefined), null);
});

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

function makePoller(over = {}) {
  const calls = { load: 0, apply: [] };
  let can = true;
  const p = new Poller({
    intervalMs: 15000,
    canRun: () => can,
    load: async () => { calls.load++; if (over.fail) throw over.fail(); return calls.load; },
    apply: (r) => calls.apply.push(r),
    ...over.opts,
  });
  return { p, calls, setCan: (v) => { can = v; } };
}

test('refreshes immediately on view enter, then every interval', async () => {
  const { p, calls } = makePoller();
  p.start();
  await flush();
  assert.equal(calls.load, 1, 'immediate refresh on enter');
  mock.timers.tick(15000); await flush();
  mock.timers.tick(15000); await flush();
  assert.equal(calls.load, 3);
  p.stop();
});

test('pauses while hidden or in the player and resumes with an immediate refresh', async () => {
  const { p, calls, setCan } = makePoller();
  p.start(); await flush();
  setCan(false); p.poke();
  mock.timers.tick(60000); await flush();
  assert.equal(calls.load, 1, 'no polling while paused');
  setCan(true); p.poke(); await flush();
  assert.equal(calls.load, 2, 'resume refreshes right away');
  p.stop();
});

test('429 backs off until Ratelimit-Reset; network errors back off 15 → 30 → 60 s', async () => {
  const statuses = [];
  const reset = (1_000_000 + 40000) / 1000;
  const { p, calls } = makePoller({ fail: () => Object.assign(new Error('rl'), { status: 429, resetAt: String(reset) }), opts: { onStatus: (s) => statuses.push(s) } });
  p.start(); await flush();
  mock.timers.tick(39000); await flush();
  assert.equal(calls.load, 1, 'waits for the reset time');
  mock.timers.tick(2000); await flush();
  assert.equal(calls.load, 2);
  assert.equal(statuses[0], 'ratelimited');
  p.stop();
  const n = makePoller({ fail: () => new TypeError('fetch failed') });
  n.p.start(); await flush();
  for (const wait of [15000, 30000, 60000, 60000]) { mock.timers.tick(wait - 1); await flush(); const before = n.calls.load; mock.timers.tick(1); await flush(); assert.equal(n.calls.load, before + 1, `retry after ${wait}`); }
  n.p.stop();
});

test('updates are deferred while the user is mid-navigation', async () => {
  let busy = true;
  const { p, calls } = makePoller({ opts: { isBusy: () => busy } });
  p.start(); await flush();
  assert.deepEqual(calls.apply, []);
  busy = false;
  mock.timers.tick(300); await flush();
  assert.deepEqual(calls.apply, [1]);
  p.stop();
});

test('focus stays on the same id across a reorder, else moves to the nearest neighbour', () => {
  assert.equal(focusAfterUpdate(['a', 'b', 'c'], ['c', 'a', 'b'], 'b'), 'b');
  assert.equal(focusAfterUpdate(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 'b'), 'c', 'next neighbour first');
  assert.equal(focusAfterUpdate(['a', 'b', 'c'], ['a'], 'c'), 'a', 'previous when nothing after survives');
  assert.equal(focusAfterUpdate(['a'], [], 'a'), null);
  assert.equal(focusAfterUpdate(['a'], ['x'], null), null);
});

test('loadPages re-fetches the loaded pages in order, de-duplicated, and returns the last cursor', async () => {
  const { loadPages } = await import('../src/js/refresher.js');
  const pagesData = { null: { items: [{ id: 'a' }, { id: 'b', is_live: true }], cursor: 'c1' }, c1: { items: [{ id: 'b' }, { id: 'c' }], cursor: 'c2' }, c2: { items: [{ id: 'd' }], cursor: null } };
  const calls = [];
  const fetchPage = async (c) => { calls.push(c); return pagesData[c]; };
  const live = (items) => [...items].sort((x, y) => Number(!!y.is_live) - Number(!!x.is_live));
  const r1 = await loadPages(fetchPage, 1, { perPage: live });
  assert.deepEqual(r1, { items: [{ id: 'b', is_live: true }, { id: 'a' }], cursor: 'c1' });
  const r2 = await loadPages(fetchPage, 2);
  assert.deepEqual(r2.items.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(r2.cursor, 'c2');
  const r9 = await loadPages(fetchPage, 9);
  assert.deepEqual(r9.items.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.equal(r9.cursor, null);
  assert.deepEqual(calls, [null, null, 'c1', null, 'c1', 'c2']);
});

test('offline sort: Recently live is the default and only known modes are kept', async () => {
  const { DEFAULT_SETTINGS, sanitizeSettings } = await import('../src/shared/settings.js');
  const { SORTS } = await import('../src/js/follows.js');
  assert.equal(DEFAULT_SETTINGS.followSort, 'recent');
  assert.equal(SORTS[0].value, 'recent', 'Y cycles from the default');
  assert.deepEqual(SORTS.map((s) => s.value), ['recent', 'az', 'followed']);
  assert.equal(sanitizeSettings({ followSort: 'az' }).followSort, 'az');
  assert.equal(sanitizeSettings({ followSort: 'zzz' }).followSort, 'recent');
});
