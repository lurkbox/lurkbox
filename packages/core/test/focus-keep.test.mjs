import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRestoreTarget, focusKey } from '../src/js/focus-keep.js';

const BEFORE = ['po-play', 'po-voldown', 'po-volup', 'po-mute', 'po-quality', 'po-chat', 'po-exit'];

test('focus stays on the same control after a re-render', () => {
  const snap = { key: 'po-volup', index: 2, order: BEFORE };
  assert.equal(chooseRestoreTarget(snap, BEFORE), 2);
  assert.equal(chooseRestoreTarget(snap, ['po-play', 'po-volup']), 1, 'found by key even if it moved');
});

test('a control that disappeared hands focus to its nearest surviving neighbour', () => {
  const snap = { key: 'po-chat', index: 5, order: BEFORE };
  const after = ['po-play', 'po-voldown', 'po-volup', 'po-mute', 'po-quality', 'po-exit']; // VOD: no chat
  assert.equal(after[chooseRestoreTarget(snap, after)], 'po-exit', 'prefers the one after (it moved up)');
  const noNext = ['po-play', 'po-quality'];
  assert.equal(noNext[chooseRestoreTarget({ key: 'po-chat', index: 5, order: BEFORE }, noNext)], 'po-quality');
});

test('unkeyed controls fall back to the same position; nothing to focus gives -1', () => {
  assert.equal(chooseRestoreTarget({ key: null, index: 3, order: [null, null, null, null] }, [null, null]), 1);
  assert.equal(chooseRestoreTarget({ key: 'x', index: 0, order: ['x'] }, []), -1);
  assert.equal(chooseRestoreTarget(null, ['a']), -1);
});

test('stable keys come from data-focus-key, then data-setting / data-key / data-view', () => {
  assert.equal(focusKey({ dataset: { focusKey: 'po-mute', key: 'mute' } }), 'po-mute');
  assert.equal(focusKey({ dataset: { setting: 'theme' } }), 'theme');
  assert.equal(focusKey({ dataset: { view: 'settings' } }), 'settings');
  assert.equal(focusKey({ dataset: {} }), null);
  assert.equal(focusKey(null), null);
});
