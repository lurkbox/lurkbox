import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScrollTop } from '../src/js/focus.js';

// Fake layout: 600 px tall scroller, 200 px card rows, 40 px margin.
const base = { viewHeight: 600, margin: 40 };

test('first-row items scroll the view back to the very top (heading visible)', () => {
  assert.equal(computeScrollTop({ ...base, scrollTop: 37, itemTop: 120, itemBottom: 300, firstRow: true }), 0);
  assert.equal(computeScrollTop({ ...base, scrollTop: 0, itemTop: 120, itemBottom: 300, firstRow: true }), null, 'already at top');
});

test('items below the fold scroll down just enough to keep a margin', () => {
  // item spans 560..760 in view coords; needs bottom + margin = 800 visible
  assert.equal(computeScrollTop({ ...base, scrollTop: 100, itemTop: 560, itemBottom: 760 }), 100 + 760 + 40 - 600);
});

test('items above the top edge scroll up with a margin; visible items stay put', () => {
  assert.equal(computeScrollTop({ ...base, scrollTop: 500, itemTop: -100, itemBottom: 100 }), 500 - 100 - 40);
  assert.equal(computeScrollTop({ ...base, scrollTop: 500, itemTop: 100, itemBottom: 300 }), null);
});

test('a section heading above the first row of a section is brought into view too', () => {
  assert.equal(computeScrollTop({ ...base, scrollTop: 800, itemTop: 20, itemBottom: 220, headTop: -60 }), 800 - 60 - 40);
});

test('never scrolls above 0', () => {
  assert.equal(computeScrollTop({ ...base, scrollTop: 10, itemTop: -5, itemBottom: 150 }), 0);
});
