// List sorting: each comparator (Following → Live, Browse/category streams, channel videos, search), the "By game"
// groups, cycling, and that the choices persist through the settings schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_SORTS, STREAM_SORTS, VOD_SORTS, SEARCH_SORTS, SORT_SETTINGS, sortStreams, groupByGame, sortVideos, sortSearch,
  nextSort, sortLabel, validSort,
} from '../src/shared/sorts.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const iso = (h) => new Date(Date.UTC(2026, 10, 21, h)).toISOString();
const STREAMS = [
  { user_id: '1', user_name: 'bravo', viewer_count: 50, started_at: iso(10), game_id: 'g2', game_name: 'Zelda' },
  { user_id: '2', user_name: 'Alpha', viewer_count: 900, started_at: iso(6), game_id: 'g1', game_name: 'Art' },
  { user_id: '3', user_name: 'charlie', viewer_count: 50, started_at: iso(12), game_id: 'g2', game_name: 'Zelda' },
  { user_id: '4', user_name: 'delta', viewer_count: 7, started_at: iso(8), game_id: '', game_name: '' },
  { user_id: '5', user_name: 'echo', viewer_count: 300, started_at: iso(9), game_id: 'g1', game_name: 'Art' },
];
const names = (l) => l.map((s) => s.user_name || s.title || s.display_name);

test('Following → Live and Browse comparators', () => {
  assert.deepEqual(names(sortStreams(STREAMS, 'viewers')), ['Alpha', 'echo', 'bravo', 'charlie', 'delta'], 'most viewers; ties A–Z');
  assert.deepEqual(names(sortStreams(STREAMS, 'started')), ['charlie', 'bravo', 'echo', 'delta', 'Alpha'], 'recently started first');
  assert.deepEqual(names(sortStreams(STREAMS, 'newest')), names(sortStreams(STREAMS, 'started')), 'Browse "Newest" is the same order');
  assert.deepEqual(names(sortStreams(STREAMS, 'longest')), ['Alpha', 'delta', 'echo', 'bravo', 'charlie'], 'live longest first');
  assert.deepEqual(names(sortStreams(STREAMS, 'az')), ['Alpha', 'bravo', 'charlie', 'delta', 'echo'], 'A–Z ignores case');
  assert.deepEqual(names(sortStreams(STREAMS, 'nonsense')), names(sortStreams(STREAMS, 'viewers')), 'unknown → viewers');
  assert.deepEqual(names(STREAMS), ['bravo', 'Alpha', 'charlie', 'delta', 'echo'], 'the input is not modified');
});

test('By game: games A–Z, no-category last, most viewers inside each game', () => {
  const g = groupByGame(STREAMS);
  assert.deepEqual(g.map((x) => x.name), ['Art', 'Zelda', 'No category']);
  assert.deepEqual(g.map((x) => names(x.items)), [['Alpha', 'echo'], ['bravo', 'charlie'], ['delta']]);
  assert.deepEqual(names(sortStreams(STREAMS, 'game')), ['Alpha', 'echo', 'bravo', 'charlie', 'delta'], 'flattened in the same order');
});

test('channel video comparators', () => {
  const V = [
    { id: 'a', title: 'A', created_at: iso(1), view_count: 10, duration: '1h0m0s' },
    { id: 'b', title: 'B', created_at: iso(3), view_count: 500, duration: '45m' },
    { id: 'c', title: 'C', created_at: iso(2), view_count: 70, duration: '3h2m1s' },
  ];
  assert.deepEqual(names(sortVideos(V, 'newest')), ['B', 'C', 'A']);
  assert.deepEqual(names(sortVideos(V, 'oldest')), ['A', 'C', 'B']);
  assert.deepEqual(names(sortVideos(V, 'views')), ['B', 'C', 'A']);
  assert.deepEqual(names(sortVideos(V, 'longest')), ['C', 'A', 'B']);
});

test('search comparators: relevance is Twitch\'s order, live first keeps it among equals', () => {
  const S = [
    { id: '1', display_name: 'zed', is_live: false },
    { id: '2', display_name: 'Moe', is_live: true },
    { id: '3', display_name: 'amy', is_live: false },
    { id: '4', display_name: 'bob', is_live: true },
  ];
  assert.deepEqual(names(sortSearch(S, 'relevance')), ['zed', 'Moe', 'amy', 'bob']);
  assert.deepEqual(names(sortSearch(S, 'live')), ['Moe', 'bob', 'zed', 'amy']);
  assert.deepEqual(names(sortSearch(S, 'az')), ['amy', 'bob', 'Moe', 'zed']);
});

test('cycling and labels', () => {
  assert.deepEqual(LIVE_SORTS.map((s) => s.label), ['Most viewers', 'Recently started', 'Live longest', 'A–Z', 'By game']);
  assert.deepEqual(STREAM_SORTS.map((s) => s.label), ['Viewers', 'Newest', 'A–Z']);
  assert.deepEqual(VOD_SORTS.map((s) => s.label), ['Newest', 'Oldest', 'Most viewed', 'Longest']);
  assert.deepEqual(SEARCH_SORTS.map((s) => s.label), ['Relevance', 'Live first', 'A–Z']);
  let v = 'viewers';
  const seen = [];
  for (let i = 0; i < LIVE_SORTS.length; i++) { v = nextSort(LIVE_SORTS, v); seen.push(v); }
  assert.deepEqual(seen, ['started', 'longest', 'az', 'game', 'viewers'], 'Y walks every sort and wraps');
  assert.equal(sortLabel(VOD_SORTS, 'views'), 'Most viewed');
  assert.equal(validSort(STREAM_SORTS, 'bogus'), 'viewers');
});

test('the sort choices persist: defaults, valid values kept, junk falls back', () => {
  assert.equal(DEFAULT_SETTINGS.liveSort, 'viewers', 'Most viewers is the Live default');
  assert.equal(DEFAULT_SETTINGS.streamSort, 'viewers');
  assert.equal(DEFAULT_SETTINGS.vodSort, 'newest');
  assert.equal(DEFAULT_SETTINGS.searchSort, 'live', 'search keeps its old live-first order by default');
  for (const [key, { sorts, fallback }] of Object.entries(SORT_SETTINGS)) {
    assert.equal(DEFAULT_SETTINGS[key], fallback, key);
    for (const s of sorts) assert.equal(sanitizeSettings({ [key]: s.value })[key], s.value, `${key}=${s.value}`);
    assert.equal(sanitizeSettings({ [key]: 'nope' })[key], fallback, `${key} junk`);
    assert.equal(sanitizeSettings({ [key]: null })[key], fallback, `${key} null`);
  }
  assert.equal('liveSort' in sanitizeSettings({ theme: 'oled' }), false, 'untouched when not in the patch');
});
