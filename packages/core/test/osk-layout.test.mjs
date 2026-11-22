// The on-screen keyboard's grid: every row fills the same columns, every key can be reached with the D-pad, up/down
// keep the column (through wide keys and back), and left/right wrap at the row ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLS, oskLayout, oskMove, keyIndexAt, columnMap, startColumn, span } from '../src/js/osk-layout.js';

const LAYOUTS = [
  ['letters', {}], ['letters', { chat: true }], ['symbols', {}], ['symbols', { chat: true }],
];
const name = (l, o) => `${l}${o.chat ? ' (chat)' : ''}`;
const keyAt = (rows, p) => rows[p.row][keyIndexAt(rows, p)];
const label = (k) => k.ch || k.id;

test('every row of every layout spans exactly COLS whole cells', () => {
  for (const [l, o] of LAYOUTS) {
    const rows = oskLayout(l, o);
    rows.forEach((row, r) => {
      assert.equal(row.reduce((s, k) => s + span(k), 0), COLS, `${name(l, o)} row ${r}`);
      for (const k of row) assert.ok(Number.isInteger(span(k)) && span(k) >= 1, `${name(l, o)} ${label(k)} spans whole cells`);
      assert.equal(columnMap(row).length, COLS);
    });
  }
});

test('both layouts have the same rows, so switching keeps the keyboard\'s size; no character twice in a layout', () => {
  for (const chat of [false, true]) {
    assert.equal(oskLayout('letters', { chat }).length, oskLayout('symbols', { chat }).length);
    assert.equal(oskLayout('letters', { chat }).length, chat ? 6 : 5);
  }
  for (const [l, o] of LAYOUTS) {
    const chs = oskLayout(l, o).flat().filter((k) => k.ch).map((k) => k.ch);
    assert.equal(new Set(chs).size, chs.length, name(l, o));
  }
  const bottom = oskLayout('letters').at(-1).map((k) => k.id);
  assert.deepEqual(bottom, ['shift', 'layout', 'space', 'backspace', 'clear', 'done']);
  assert.equal(oskLayout('letters').at(-1)[1].label, '#+=');
  assert.equal(oskLayout('symbols').at(-1)[1].label, 'ABC');
  assert.deepEqual(oskLayout('letters', { chat: true })[4].map((k) => k.ch).join(''), "!?,':;()#/", 'the chat punctuation row');
});

test('every key is reachable from q with the D-pad', () => {
  for (const [l, o] of LAYOUTS) {
    const rows = oskLayout(l, o);
    const seen = new Set();
    const queue = [{ row: 1, col: 0 }];
    const posKey = (p) => `${p.row}:${p.col}`;
    const visited = new Set();
    while (queue.length) {
      const p = queue.shift();
      if (visited.has(posKey(p))) continue;
      visited.add(posKey(p));
      seen.add(`${p.row}/${keyIndexAt(rows, p)}`);
      for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT']) { const n = oskMove(rows, p, d); if (n) queue.push(n); }
    }
    const all = rows.flatMap((row, r) => row.map((_, i) => `${r}/${i}`));
    assert.deepEqual([...seen].sort(), all.sort(), name(l, o));
  }
});

test('up and down keep the column, even through a wide key', () => {
  for (const [l, o] of LAYOUTS) {
    const rows = oskLayout(l, o);
    for (let col = 0; col < COLS; col++) {
      // Top to bottom and back: the column never changes and every key covers it.
      let p = { row: 0, col };
      while (true) {
        assert.ok(columnMap(rows[p.row])[col] === keyIndexAt(rows, p));
        const n = oskMove(rows, p, 'DOWN');
        if (!n) break;
        assert.equal(n.col, col, `${name(l, o)} down from row ${p.row}`);
        p = n;
      }
      assert.equal(p.row, rows.length - 1);
      while ((p = oskMove(rows, p, 'UP') || p).row > 0) assert.equal(p.col, col);
      assert.equal(p.col, col);
    }
  }
  const rows = oskLayout('letters');
  // v → Space → back up lands on v, not on the Space key's first column.
  const v = { row: 3, col: 3 };
  assert.equal(keyAt(rows, v).ch, 'v');
  const down = oskMove(rows, v, 'DOWN');
  assert.equal(keyAt(rows, down).id, 'space');
  assert.equal(keyAt(rows, oskMove(rows, down, 'UP')).ch, 'v');
  const n = { row: 3, col: 5 };
  assert.equal(keyAt(rows, oskMove(rows, n, 'DOWN')).id, 'space', 'n is above Space too');
  assert.equal(keyAt(rows, oskMove(rows, { row: 3, col: 9 }, 'DOWN')).id, 'done', '@ → Done');
  assert.equal(oskMove(rows, { row: 0, col: 4 }, 'UP'), null, 'nothing above the top row');
  assert.equal(oskMove(rows, { row: rows.length - 1, col: 4 }, 'DOWN'), null, 'nothing below the bottom row');
});

test('left and right step one key and wrap at the row ends', () => {
  const rows = oskLayout('letters');
  assert.equal(keyAt(rows, oskMove(rows, { row: 1, col: 0 }, 'LEFT')).ch, 'p', 'q ← wraps to p');
  assert.equal(keyAt(rows, oskMove(rows, { row: 1, col: 9 }, 'RIGHT')).ch, 'q', 'p → wraps to q');
  assert.equal(keyAt(rows, oskMove(rows, { row: 1, col: 0 }, 'RIGHT')).ch, 'w');
  // On the bottom row, one press moves one key, whatever its width.
  const b = rows.length - 1;
  const order = [];
  let p = { row: b, col: 0 };
  for (let i = 0; i < 7; i++) { order.push(keyAt(rows, p).id); p = oskMove(rows, p, 'RIGHT'); }
  assert.deepEqual(order, ['shift', 'layout', 'space', 'backspace', 'clear', 'done', 'shift']);
  assert.equal(keyAt(rows, oskMove(rows, { row: b, col: 0 }, 'LEFT')).id, 'done', 'Shift ← wraps to Done');
  // Moving sideways onto a wide key puts you in its first column.
  assert.deepEqual(oskMove(rows, { row: b, col: 2 }, 'RIGHT'), { row: b, col: 3 }, 'layout → Space starts at column 3');
  assert.equal(startColumn(rows[b], 5), 8, 'Done covers the last two columns');
  assert.equal(keyAt(rows, oskMove(rows, { row: b, col: 8 }, 'UP')).ch, '.', 'Done → up keeps its column');
});
