import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A, B, X, Y, LB, RB, START, UP, DOWN, LEFT, RIGHT,
  padActions, padType, parsePadId, isSteamVirtualPad, Repeater, Deduper, keyAction, InputMode, glyph,
} from '../src/js/input-core.js';

const btns = (n, pressed = []) => Array.from({ length: n }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }));
const pad = ({ id = 'Generic pad', mapping = '', pressed = [], axes = [0, 0, 0, 0], buttons = 17 } = {}) =>
  ({ id, mapping, connected: true, buttons: btns(buttons, pressed), axes });

test('standard mapping: face, shoulder, menu and d-pad buttons', () => {
  const gp = pad({ mapping: 'standard', pressed: [0, 1, 2, 3, 4, 5, 9, 12, 15] });
  assert.deepEqual([...padActions(gp)].sort(), [A, B, X, Y, LB, RB, START, UP, RIGHT].sort());
});

test('Guide/Steam button (16) is ignored', () => {
  assert.equal(padActions(pad({ mapping: 'standard', pressed: [16] })).size, 0);
  // Xbox raw table maps 8 to guide
  assert.equal(padActions(pad({ id: 'Xbox (Vendor: 045e Product: 0b12)', pressed: [8] })).size, 0);
});

test('left stick respects the deadzone and picks the dominant axis', () => {
  assert.equal(padActions(pad({ mapping: 'standard', axes: [0.3, -0.4, 0, 0] })).size, 0);
  assert.deepEqual([...padActions(pad({ mapping: 'standard', axes: [0.9, 0.6, 0, 0] }))], [RIGHT]);
  assert.deepEqual([...padActions(pad({ mapping: 'standard', axes: [-0.2, -0.8, 0, 0] }))], [UP]);
});

test('DualSense with a non-standard mapping uses the Sony table and hat axes', () => {
  const id = 'Sony Interactive Entertainment DualSense Wireless Controller (Vendor: 054c Product: 0ce6)';
  // cross=0 → A, circle=1 → B, triangle=2 → Y, square=3 → X, options=9 → START
  assert.deepEqual([...padActions(pad({ id, pressed: [0] }))], [A]);
  assert.deepEqual([...padActions(pad({ id, pressed: [2] }))], [Y]);
  assert.deepEqual([...padActions(pad({ id, pressed: [3] }))], [X]);
  assert.deepEqual([...padActions(pad({ id, pressed: [9] }))], [START]);
  assert.equal(padActions(pad({ id, pressed: [10] })).size, 0, 'PS button ignored');
  const hat = pad({ id, axes: [0, 0, 0, 0, 0, 0, -1, 1] });
  assert.deepEqual([...padActions(hat)].sort(), [DOWN, LEFT].sort());
});

test('generic fallback: buttons 0/1 and a single-axis hat on axis 9', () => {
  const axes = new Array(10).fill(0);
  axes[9] = 1.2857; // centred
  assert.equal(padActions(pad({ id: 'Weird pad (Vendor: 1234 Product: 5678)', axes })).size, 0);
  axes[9] = -1; // up
  assert.deepEqual([...padActions(pad({ id: 'Weird pad', axes }))], [UP]);
  axes[9] = 0.714; // left (with axes 6/7 at rest)
  assert.ok(padActions(pad({ id: 'Weird pad', axes })).has(LEFT));
  assert.deepEqual([...padActions(pad({ id: 'Weird pad', pressed: [0, 1] }))].sort(), [A, B].sort());
  assert.equal(padActions(pad({ id: 'Weird pad', pressed: [2, 3] })).size, 0);
});

test('pad id parsing and Steam virtual pad detection', () => {
  assert.deepEqual(parsePadId('Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD Vendor: 28de Product: 11ff)'), { vendor: '28de', product: '11ff' });
  assert.deepEqual(parsePadId('54c-ce6-DualSense'), { vendor: '054c', product: '0ce6' });
  assert.ok(isSteamVirtualPad('Microsoft X-Box 360 pad 0 (STANDARD GAMEPAD Vendor: 28de Product: 11ff)'));
  assert.ok(isSteamVirtualPad('Steam Virtual Gamepad'));
  assert.ok(!isSteamVirtualPad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'));
  assert.equal(padType('Steam Virtual Gamepad'), 'steam');
  assert.equal(padType('Xbox Wireless Controller (Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(padType('DualSense Wireless Controller (Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(padType('Pro Controller (Vendor: 057e Product: 2009)'), 'nintendo');
  assert.equal(padType('Mystery stick'), 'generic');
});

test('Repeater: fires on press, repeats after the delay at the rate, not for buttons', () => {
  const r = new Repeater({ delay: 400, rate: 100 });
  const held = new Set([DOWN, A]);
  assert.deepEqual(r.update(held, 0).sort(), [A, DOWN].sort());
  assert.deepEqual(r.update(held, 300), []);
  assert.deepEqual(r.update(held, 400), [DOWN]);
  assert.deepEqual(r.update(held, 450), []);
  assert.deepEqual(r.update(held, 500), [DOWN]);
  assert.deepEqual(r.update(new Set(), 600), []);
  assert.deepEqual(r.update(new Set([DOWN]), 610), [DOWN], 'new press after release');
});

test('Deduper drops the same action from the other source within 80 ms only', () => {
  const d = new Deduper(80);
  assert.equal(d.accept(A, 'pad', 1000), true);
  assert.equal(d.accept(A, 'key', 1050), false, 'Steam sent both');
  assert.equal(d.accept(A, 'key', 1200), true, 'later key press is real');
  assert.equal(d.accept(A, 'pad', 1250), false, 'reverse direction');
  assert.equal(d.accept(B, 'pad', 1260), true, 'different action');
  assert.equal(d.accept(B, 'pad', 1270), true, 'same source never deduped');
});

test('keyboard mapping, with letters reserved for text inputs', () => {
  assert.equal(keyAction('ArrowLeft', false), LEFT);
  assert.equal(keyAction('w', false), UP);
  assert.equal(keyAction('Enter', false), A);
  assert.equal(keyAction(' ', false), A);
  assert.equal(keyAction('Escape', true), B);
  assert.equal(keyAction('Backspace', false), B);
  assert.equal(keyAction('Backspace', true), null);
  assert.equal(keyAction('w', true), null);
  assert.equal(keyAction('c', false), Y);
  assert.equal(keyAction('p', false), null, 'P is unbound (PiP removed)');
  assert.equal(keyAction('PageDown', false), RB);
  assert.equal(keyAction('q', false), LB);
  assert.equal(keyAction('F11', false), 'FULLSCREEN');
});

test('InputMode drives cursor visibility and glyph family', () => {
  const changes = [];
  const m = new InputMode((mode, type) => changes.push(`${mode}:${type}`));
  assert.equal(m.set('mouse'), true);
  assert.equal(m.cursorVisible, true);
  assert.equal(m.glyphFamily(), 'keyboard');
  m.set('pad', 'playstation');
  assert.equal(m.cursorVisible, false);
  assert.equal(m.glyphFamily(), 'playstation');
  assert.equal(glyph(A, m.glyphFamily()), '✕');
  assert.equal(m.set('pad', 'playstation'), false, 'no change event for the same mode');
  m.set('keyboard');
  assert.equal(glyph(B, m.glyphFamily()), 'Esc');
  assert.deepEqual(changes, ['mouse:steam', 'pad:playstation', 'keyboard:playstation']);
});
