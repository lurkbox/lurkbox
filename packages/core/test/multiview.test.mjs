// Multi-view: layout geometry, D-pad moves, active-tile audio, the quality cap rule, add/remove/swap and B-exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutsFor, fitLayout, nextLayout, layoutRects, moveActive, tileMutes, tileCap, addTile, removeTile, swapTiles, replaceTile, exitTarget, candidates, MAX_TILES } from '../src/shared/multiview.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const ch = (login) => ({ login, name: login.toUpperCase(), userId: `id-${login}` });
const area = (rs) => rs.reduce((s, r) => s + r.w * r.h, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('layouts: defaults per count, fitting and cycling', () => {
  assert.deepEqual(layoutsFor(2), ['side', 'big']);
  assert.deepEqual(layoutsFor(3), ['big', 'grid']);
  assert.deepEqual(layoutsFor(4), ['grid', 'big']);
  assert.equal(fitLayout('grid', 2), 'side', 'a 2x2 grid with two tiles falls back to side by side');
  assert.equal(fitLayout('big', 4), 'big');
  assert.equal(nextLayout('side', 2), 'big');
  assert.equal(nextLayout('big', 2), 'side');
  assert.equal(nextLayout('grid', 4), 'big');
});

test('geometry: side by side, one big plus two small, 2x2', () => {
  const side = layoutRects('side', 2);
  assert.deepEqual(side, [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }]);
  const big = layoutRects('big', 3);
  assert.ok(near(big[0].w, 2 / 3) && big[0].h === 1, 'tile 0 is the big one');
  assert.ok(near(big[1].x, 2 / 3) && near(big[1].h, 0.5) && near(big[2].y, 0.5));
  const grid = layoutRects('grid', 4);
  assert.deepEqual(grid.map((r) => [r.x, r.y]), [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]);
  assert.ok(grid.every((r) => r.w === 0.5 && r.h === 0.5));
  for (const [l, n] of [['side', 2], ['big', 2], ['big', 3], ['big', 4], ['grid', 4]]) assert.ok(near(area(layoutRects(l, n)), 1), `${l}/${n} fills the stage`);
  assert.ok(near(area(layoutRects('grid', 3)), 0.75), 'three in a grid leave one cell empty');
});

test('D-pad moves the active tile spatially and stops at the edges', () => {
  const g = layoutRects('grid', 4);
  assert.equal(moveActive(g, 0, 'right'), 1);
  assert.equal(moveActive(g, 0, 'down'), 2);
  assert.equal(moveActive(g, 3, 'up'), 1);
  assert.equal(moveActive(g, 3, 'left'), 2);
  assert.equal(moveActive(g, 0, 'left'), 0, 'nothing to the left');
  const b = layoutRects('big', 3);
  assert.equal(moveActive(b, 0, 'right'), 1, 'from the big tile: the top small one');
  assert.equal(moveActive(b, 2, 'left'), 0);
  assert.equal(moveActive(b, 1, 'down'), 2);
  assert.equal(moveActive(layoutRects('side', 2), 1, 'left'), 0);
});

test('audio: only the active tile is unmuted; switching moves the sound', () => {
  assert.deepEqual(tileMutes(4, 0), [false, true, true, true]);
  assert.deepEqual(tileMutes(4, 2), [true, true, false, true]);
  assert.deepEqual(tileMutes(2, 1, true), [true, true], 'the whole view muted');
});

test('quality cap: other tiles at the setting, the active one free, the background cap for all', () => {
  assert.equal(tileCap({ isActive: true }), null);
  assert.equal(tileCap({ isActive: false }), 480, '480p by default');
  assert.equal(tileCap({ isActive: false, multiQuality: '720' }), 720);
  assert.equal(tileCap({ isActive: false, multiQuality: 'same' }), null);
  assert.equal(tileCap({ isActive: true, backgroundCap: 720 }), 720, 'unfocused: the active tile is capped too');
  assert.equal(tileCap({ isActive: false, multiQuality: '720', backgroundCap: 480 }), 480, 'the lower cap wins');
  assert.equal(tileCap({ isActive: false, multiQuality: 'same', backgroundCap: 720 }), 720);
  assert.equal(DEFAULT_SETTINGS.multiQuality, '480');
  assert.equal(sanitizeSettings({ multiQuality: '720' }).multiQuality, '720');
  assert.equal(sanitizeSettings({ multiQuality: '1080' }).multiQuality, '480');
});

test('add: no duplicates, at most four, the new tile becomes active', () => {
  let r = addTile([ch('a')], 0, ch('b'));
  assert.deepEqual(r.tiles.map((t) => t.login), ['a', 'b']);
  assert.equal(r.active, 1);
  assert.equal(addTile(r.tiles, 1, ch('A')).error, 'duplicate', 'case-insensitive');
  const full = [ch('a'), ch('b'), ch('c'), ch('d')];
  assert.equal(full.length, MAX_TILES);
  r = addTile(full, 2, ch('e'));
  assert.equal(r.error, 'full');
  assert.equal(r.active, 2);
  assert.deepEqual(candidates([{ user_login: 'a' }, { user_login: 'z' }], full).map((s) => s.user_login), ['z']);
});

test('remove: the active index follows; below two tiles leaves for the single player', () => {
  const four = [ch('a'), ch('b'), ch('c'), ch('d')];
  assert.deepEqual(removeTile(four, 2, 0), { tiles: [ch('b'), ch('c'), ch('d')], active: 1 }, 'a tile before the active one');
  assert.equal(removeTile(four, 2, 2).active, 1, 'the active one: the one before it');
  assert.equal(removeTile(four, 0, 0).active, 0);
  assert.equal(removeTile(four, 1, 3).active, 1);
  const r = removeTile([ch('a'), ch('b')], 1, 0);
  assert.equal(r.exit.login, 'b', 'one left: play it on its own');
});

test('swap and raid replace', () => {
  const t = [ch('a'), ch('b'), ch('c')];
  const s = swapTiles(t, 2, 0, 2);
  assert.deepEqual(s.tiles.map((x) => x.login), ['c', 'b', 'a']);
  assert.equal(s.active, 0, 'the active tile moved into the big slot');
  assert.equal(swapTiles(t, 1, 0, 2).active, 1, 'an uninvolved active tile stays');
  assert.deepEqual(replaceTile(t, 1, ch('x')).map((x) => x.login), ['a', 'x', 'c']);
  assert.deepEqual(replaceTile(t, 1, ch('c')).map((x) => x.login), ['a', 'c'], 'a raid into a channel already shown drops the tile');
});

test('B: back to the single player on the active stream', () => {
  const t = [ch('a'), ch('b'), ch('c')];
  assert.equal(exitTarget(t, 2).login, 'c');
  assert.equal(exitTarget(t, 9).login, 'a');
  assert.equal(exitTarget([], 0), null);
});

test('raids on every tile: the watcher targets, the raiding tile, the target as a tile', async () => {
  const { raidTargets, raidTileIndex, raidChannel } = await import('../src/shared/multiview.js');
  const tiles = [ch('a'), { login: 'nouid', name: 'N' }, ch('c')];
  assert.deepEqual(raidTargets(tiles), [{ id: 'id-a', login: 'a' }, { id: 'id-c', login: 'c' }], 'tiles without an id are not watched');
  assert.equal(raidTileIndex(tiles, { from_broadcaster_user_id: 'id-c' }), 2);
  assert.equal(raidTileIndex(tiles, { from_broadcaster_user_id: 'id-x' }), -1);
  assert.equal(raidTileIndex(tiles, {}), -1);
  const t = raidChannel({ to_broadcaster_user_login: 'zed', to_broadcaster_user_name: 'Zed', to_broadcaster_user_id: 77 });
  assert.deepEqual(t, { login: 'zed', name: 'Zed', userId: '77', stream: null });
  // The swap in place keeps the other tiles and the order; a target already on screen drops the raiding tile.
  assert.deepEqual(replaceTile(tiles, 2, t).map((x) => x.login), ['a', 'nouid', 'zed']);
  assert.deepEqual(replaceTile(tiles, 2, ch('a')).map((x) => x.login), ['a', 'nouid']);
});

test('multi-select picker: A toggles up to the free slots, Start confirms (or takes the focused one)', async () => {
  const { toggleSelection, confirmSelection, freeSlots } = await import('../src/shared/multiview.js');
  assert.equal(freeSlots(1), 3);
  assert.equal(freeSlots(3), 1);
  assert.equal(freeSlots(4), 0);
  assert.equal(freeSlots(9), 0);
  let s = [];
  s = toggleSelection(s, 'a', 2).selected;
  s = toggleSelection(s, 'b', 2).selected;
  const full = toggleSelection(s, 'c', 2);
  assert.equal(full.error, 'full');
  assert.deepEqual(full.selected, ['a', 'b'], 'past the limit nothing changes');
  s = toggleSelection(s, 'a', 2).selected;
  assert.deepEqual(s, ['b'], 'A again unticks');
  s = toggleSelection(s, 'c', 2).selected;
  assert.deepEqual(s, ['b', 'c'], 'pick order');
  assert.deepEqual(confirmSelection(s, 'x', 2), ['b', 'c']);
  assert.deepEqual(confirmSelection([], 'x', 2), ['x'], 'nothing ticked: the focused one');
  assert.deepEqual(confirmSelection([], null, 2), []);
  assert.deepEqual(confirmSelection(['a', 'b', 'c'], null, 2), ['a', 'b']);
});

test('the last set per account: sanitising, remembering, resuming with 2+ live', async () => {
  const { sanitizeMultiSets, rememberSet, resumableSet } = await import('../src/shared/multiview.js');
  const clean = sanitizeMultiSets({
    123: [{ login: 'Alpha', name: 'Alpha', userId: '1' }, { login: 'beta', userId: 2 }, { login: 'alpha' }, { login: 'bad login!' }],
    456: [{ login: 'solo' }],
    abc: [{ login: 'a' }, { login: 'b' }],
    789: 'nope',
    999: Array.from({ length: 6 }, (_, i) => ({ login: `c${i}`, userId: 'not-a-number' })),
  });
  assert.deepEqual(clean, {
    123: [{ login: 'alpha', name: 'Alpha', userId: '1' }, { login: 'beta', name: 'beta', userId: '2' }],
    999: [0, 1, 2, 3].map((i) => ({ login: `c${i}`, name: `c${i}`, userId: null })),
  }, 'lower-case logins, no repeats, 2–4 per set, numeric account ids only');
  assert.deepEqual(sanitizeMultiSets(null), {});
  assert.deepEqual(sanitizeSettings({ multiSets: { 1: [ch('a'), ch('b')] } }).multiSets, { 1: [{ login: 'a', name: 'A', userId: null }, { login: 'b', name: 'B', userId: null }] });
  assert.deepEqual(DEFAULT_SETTINGS.multiSets, {});

  const tiles = [{ login: 'a', name: 'A', userId: '1' }, { login: 'b', name: 'B', userId: '2' }, { login: 'c', name: 'C', userId: '3' }];
  const sets = rememberSet({}, '42', tiles);
  assert.deepEqual(sets['42'].map((t) => t.login), ['a', 'b', 'c']);
  assert.equal(rememberSet(sets, '42', tiles), null, 'unchanged: no save');
  assert.equal(rememberSet(sets, '42', tiles.slice(0, 1)), null, 'one tile keeps the last set');
  assert.equal(rememberSet(sets, null, tiles), null, 'signed out: nothing');
  const both = rememberSet(sets, '43', tiles.slice(1));
  assert.deepEqual(Object.keys(both).sort(), ['42', '43'], 'per account');
  assert.deepEqual(both['42'], sets['42']);

  const live = [{ user_login: 'c' }, { user_login: 'x' }, { user_login: 'A' }];
  assert.deepEqual(resumableSet(both, '42', live).map((s) => s.user_login), ['A', 'c'], 'saved order, live only');
  assert.deepEqual(resumableSet(both, '43', live), [], 'only one of its channels is live');
  assert.deepEqual(resumableSet(both, '44', live), []);
  assert.deepEqual(resumableSet(both, '42', null), []);
});
