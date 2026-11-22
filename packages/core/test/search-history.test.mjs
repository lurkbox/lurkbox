// Search history: per-account storage, dedupe, the cap of 20, delete and clear, validation through the settings
// schema, and the demo's category search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SEARCHES, MAX_QUERY_LENGTH, cleanQuery, sanitizeSearchHistory, sanitizeSearchList, searchesFor, recordSearch,
  deleteSearch, clearSearches,
} from '../src/shared/search-history.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';

const A = '1001';
const B = '2002';
const qs = (h, id) => searchesFor(h, id).map((e) => e.q);

test('newest first, deduped by query (case and spaces ignored), the latest pick wins', () => {
  let h = {};
  h = recordSearch(h, A, 'lofi', null, 1);
  h = recordSearch(h, A, 'speedrun', { kind: 'category', id: '9102', name: 'Retro Speedruns' }, 2);
  h = recordSearch(h, A, '  LOFI  ', { kind: 'channel', id: '7', login: 'LofiGuy', name: 'LofiGuy' }, 3);
  assert.deepEqual(qs(h, A), ['LOFI', 'speedrun']);
  assert.deepEqual(h[A][0], { q: 'LOFI', at: 3, pick: { kind: 'channel', id: '7', login: 'lofiguy', name: 'LofiGuy' } });
  assert.deepEqual(h[A][1].pick, { kind: 'category', id: '9102', name: 'Retro Speedruns' });
  assert.equal(cleanQuery('a \n  b\t'), 'a b');
  assert.equal(Array.from(cleanQuery('😀'.repeat(300))).length, MAX_QUERY_LENGTH);
  assert.deepEqual(recordSearch(h, A, '   '), h, 'an empty query is not stored');
  assert.deepEqual(recordSearch(h, 'nobody', 'x'), h, 'needs an account id');
});

test('at most 20 per account, the oldest drop off', () => {
  let h = {};
  for (let i = 0; i < 25; i++) h = recordSearch(h, A, `q${i}`, null, i);
  assert.equal(h[A].length, MAX_SEARCHES);
  assert.equal(h[A][0].q, 'q24');
  assert.equal(h[A].at(-1).q, 'q5');
  h = recordSearch(h, A, 'q10', null, 99);
  assert.equal(h[A].length, MAX_SEARCHES, 'searching an old one again moves it up without growing the list');
  assert.equal(h[A][0].q, 'q10');
});

test('each account has its own history; delete and clear touch one account only', () => {
  let h = {};
  h = recordSearch(h, A, 'mine', null, 1);
  h = recordSearch(h, B, 'theirs', null, 2);
  h = recordSearch(h, A, 'also mine', null, 3);
  assert.deepEqual(qs(h, A), ['also mine', 'mine']);
  assert.deepEqual(qs(h, B), ['theirs']);
  const d = deleteSearch(h, A, 'MINE');
  assert.deepEqual(qs(d, A), ['also mine']);
  assert.deepEqual(qs(d, B), ['theirs']);
  assert.equal(A in deleteSearch(d, A, 'also mine'), false, 'an empty list is dropped');
  const c = clearSearches(h, A);
  assert.deepEqual(qs(c, A), []);
  assert.deepEqual(qs(c, B), ['theirs']);
  assert.deepEqual(qs(h, A), ['also mine', 'mine'], 'the input is not modified');
});

test('stored history is validated: bad ids, entries and picks are dropped, duplicates and overflow trimmed', () => {
  const raw = {
    [A]: [
      { q: 'ok', at: 5, pick: { kind: 'channel', id: '12', login: 'Some_One', name: 'Some_One' } },
      { q: 'OK', at: 4 },
      { q: '', at: 3 },
      'text',
      { q: 'bad pick', at: 2, pick: { kind: 'user', id: 'x', name: 'n' } },
      { q: 'no login', pick: { kind: 'channel', id: '1', name: 'n' } },
      ...Array.from({ length: 30 }, (_, i) => ({ q: `x${i}`, at: i })),
    ],
    notanid: [{ q: 'lost' }],
    [B]: [],
  };
  const h = sanitizeSearchHistory(raw);
  assert.deepEqual(Object.keys(h), [A]);
  assert.equal(h[A].length, MAX_SEARCHES);
  assert.deepEqual(h[A][0], { q: 'ok', at: 5, pick: { kind: 'channel', id: '12', login: 'some_one', name: 'Some_One' } });
  assert.deepEqual(h[A][1], { q: 'bad pick', at: 2 }, 'a bad pick is dropped, the query kept');
  assert.deepEqual(h[A][2], { q: 'no login', at: 0 });
  assert.deepEqual(sanitizeSearchHistory([1, 2]), {});
  assert.deepEqual(sanitizeSearchList(null), []);
});

test('settings: on by default, empty by default, validated when saved', () => {
  assert.equal(DEFAULT_SETTINGS.searchHistoryOn, true);
  assert.deepEqual(DEFAULT_SETTINGS.searchHistory, {});
  assert.equal(sanitizeSettings({ searchHistoryOn: 0 }).searchHistoryOn, false);
  const saved = sanitizeSettings({ searchHistory: recordSearch({}, A, 'lofi', null, 1) }).searchHistory;
  assert.deepEqual(saved, { [A]: [{ q: 'lofi', at: 1 }] });
  assert.deepEqual(sanitizeSettings({ searchHistory: 'junk' }).searchHistory, {});
  assert.equal('searchHistory' in sanitizeSettings({ theme: 'oled' }), false);
});

test('demo mode answers category searches', () => {
  const db = buildDemoData();
  const r = demoHelix(db, { path: '/search/categories', query: { query: 'art', first: 20 } }, { activeId: db.accounts[0].id });
  assert.ok(JSON.stringify(r).includes('Art Studio'), JSON.stringify(r).slice(0, 200));
  assert.ok(!JSON.stringify(demoHelix(db, { path: '/search/categories', query: { query: '' } }, {})).includes('Art Studio'));
});
