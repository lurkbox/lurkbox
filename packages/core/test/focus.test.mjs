import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNeighbor } from '../src/js/focus.js';

// 3x2 grid of 100x60 cards with 20px gaps, plus a tall rail item on the left.
const rect = (left, top, w = 100, h = 60) => ({ left, top, right: left + w, bottom: top + h });
const cells = {};
for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) cells[`${r}${c}`] = rect(200 + c * 120, 100 + r * 80);
cells.rail = rect(0, 100, 150, 40);
const cands = (except) => Object.entries(cells).filter(([k]) => k !== except).map(([k, v]) => ({ rect: v, item: k }));

test('moves to the adjacent cell in each direction', () => {
  assert.equal(pickNeighbor(cells['00'], cands('00'), 'RIGHT'), '01');
  assert.equal(pickNeighbor(cells['01'], cands('01'), 'DOWN'), '11');
  assert.equal(pickNeighbor(cells['11'], cands('11'), 'UP'), '01');
  assert.equal(pickNeighbor(cells['02'], cands('02'), 'LEFT'), '01');
});

test('left from the first column reaches the rail; nothing beyond the edges', () => {
  assert.equal(pickNeighbor(cells['00'], cands('00'), 'LEFT'), 'rail');
  assert.equal(pickNeighbor(cells['02'], cands('02'), 'RIGHT'), null);
  assert.equal(pickNeighbor(cells['10'], cands('10'), 'DOWN'), null);
});

test('prefers the same row over a closer diagonal', () => {
  const extra = { rect: rect(330, 40, 100, 40), item: 'diag' }; // up-right, partly overlapping no rows
  assert.equal(pickNeighbor(cells['00'], [...cands('00'), extra], 'RIGHT'), '01');
});
