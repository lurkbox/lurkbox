import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayControls, controlLabel, controlIcon, shortCount, liveLabel, anchorPopover, POPOVER_CONTROLS, OVERLAY_HIDE_MS } from '../src/js/player-ui.js';
import { PLAYER_ICONS } from '../src/js/icons.js';
import { Popover } from '../src/js/popover.js';
import { stepValue, valueAt, holdMultiplier, HoldTracker } from '../src/js/slider.js';

test('overlay controls: one row, live-only buttons, points only with Twitch\'s chat frame', () => {
  assert.deepEqual(overlayControls({ kind: 'live', points: true }), ['play', 'volume', 'quality', 'chat', 'live', 'points', 'channel', 'more', 'back']);
  assert.deepEqual(overlayControls({ kind: 'live', points: false }), ['play', 'volume', 'quality', 'chat', 'live', 'channel', 'more', 'back']);
  assert.deepEqual(overlayControls({ kind: 'video', points: true }), ['play', 'volume', 'quality', 'channel', 'more', 'back']);
  for (const k of ['volume', 'quality', 'chat', 'points', 'more']) assert.ok(POPOVER_CONTROLS.has(k), k);
  assert.ok(!POPOVER_CONTROLS.has('play'));
  assert.ok(OVERLAY_HIDE_MS >= 3500 && OVERLAY_HIDE_MS <= 5000, 'auto-hide after about 4 s');
});

test('label bubble text: action, then its state after a dot', () => {
  assert.equal(controlLabel('quality', { quality: '1080p60' }), 'Quality · 1080p60');
  assert.equal(controlLabel('quality', {}), 'Quality · Auto');
  assert.equal(controlLabel('chat', { chatOn: true }), 'Chat · On');
  assert.equal(controlLabel('chat', { chatOn: false }), 'Chat · Off');
  assert.equal(controlLabel('volume', { volume: 0.7 }), 'Volume · 70%');
  assert.equal(controlLabel('volume', { volume: 0.7, muted: true }), 'Volume · Muted');
  assert.equal(controlLabel('play', { paused: true }), 'Play');
  assert.equal(controlLabel('play', { paused: false }), 'Pause');
  assert.equal(controlLabel('points', { points: 12345 }), 'Channel points · 12,345');
  assert.equal(controlLabel('points', { points: null }), 'Channel points');
  assert.equal(controlLabel('live', { rewound: true }), 'Back to live');
  assert.equal(controlLabel('live', { behind: true }), 'Jump to live');
  assert.equal(controlLabel('channel', { name: 'Somebody' }), 'Somebody · Channel');
  assert.equal(controlLabel('back'), 'Back');
});

test('icons: every control has an outline icon; state picks the variant', () => {
  for (const k of overlayControls({ kind: 'live', points: true })) assert.ok(PLAYER_ICONS[controlIcon(k, {})], k);
  assert.equal(controlIcon('play', { paused: true }), 'play');
  assert.equal(controlIcon('play', { paused: false }), 'pause');
  assert.equal(controlIcon('volume', { muted: true, volume: 1 }), 'volume-muted');
  assert.equal(controlIcon('volume', { volume: 0.3 }), 'volume-low');
  assert.equal(controlIcon('chat', { chatOn: false }), 'chat-off');
  for (const [name, svg] of Object.entries(PLAYER_ICONS)) assert.doesNotMatch(svg, /fill="#|stroke="#|<image|href=/, `${name}: stroke icon, currentColor, no artwork`);
});

test('points badge: short counts', () => {
  assert.equal(shortCount(950), '950');
  assert.equal(shortCount(1234), '1.2K');
  assert.equal(shortCount(12345), '12K');
  assert.equal(shortCount(2500000), '2.5M');
  assert.equal(shortCount(null), '');
});

test('top-line badge: LIVE, behind, rewound; nothing for videos', () => {
  assert.deepEqual(liveLabel({ kind: 'live', badge: { live: true, text: '● LIVE' } }), { text: '● LIVE', state: 'live' });
  assert.deepEqual(liveLabel({ kind: 'live', badge: { live: false, text: '−0:23 behind' } }), { text: '−0:23 behind', state: 'behind' });
  assert.deepEqual(liveLabel({ kind: 'live', badge: { live: false, text: 'x' }, direct: false }).state, 'live', 'the embed has no latency figure');
  assert.deepEqual(liveLabel({ kind: 'live', rewoundBy: 3723 }), { text: 'Rewound −1:02:03', state: 'rewound' });
  assert.deepEqual(liveLabel({ kind: 'live', rewoundBy: 75 }).text, 'Rewound −1:15');
  assert.equal(liveLabel({ kind: 'video' }), null);
});

test('pop-over anchor: above the button, centred, kept inside the overlay', () => {
  const box = { left: 0, top: 0, right: 1000, bottom: 600 };
  assert.deepEqual(anchorPopover({ left: 480, right: 540, top: 520, bottom: 580 }, { width: 300, height: 200 }, box, { margin: 12, gap: 10 }), { left: 360, bottom: 90 });
  assert.equal(anchorPopover({ left: 10, right: 70, top: 520, bottom: 580 }, { width: 300, height: 200 }, box).left, 12, 'clamped at the left edge');
  assert.equal(anchorPopover({ left: 950, right: 1000, top: 520, bottom: 580 }, { width: 300, height: 200 }, box).left, 688, 'clamped at the right edge');
});

// ---- pop-over focus: into it on open, back to its button on B ----

function fakeNode(key, { connected = true } = {}) {
  return {
    dataset: { focusKey: key }, isConnected: connected, classList: { contains: (c) => c === 'focusable' },
    closest: () => null, clicked: 0, click() { this.clicked += 1; },
  };
}
function fakePop(items) {
  return { removed: false, items, remove() { this.removed = true; }, querySelector: () => items[0], contains: (n) => items.includes(n) };
}
function setup(scopeItems = []) {
  const log = [];
  let active = null;
  const scope = { contains: () => true, querySelectorAll: () => scopeItems };
  const pop = new Popover({
    scope,
    focus: (n) => { active = n; log.push(n.dataset.focusKey); },
    move: (dir) => log.push(`move ${dir}`),
    active: () => active,
  });
  return { pop, log, get active() { return active; } };
}

test('pop-over: focus moves into it, B closes it and focus returns to its button', () => {
  const t = setup();
  const opener = fakeNode('po-quality');
  const first = fakeNode('pop-q-auto');
  const node = fakePop([first, fakeNode('pop-q-720p60')]);
  t.pop.open({ key: 'quality', node, opener });
  assert.equal(t.active, first, 'focus moved into the pop-over');
  assert.ok(t.pop.isOpen);
  assert.equal(t.pop.handle('DOWN'), true);
  assert.deepEqual(t.log.slice(-1), ['move DOWN'], 'the D-pad stays inside it');
  assert.equal(t.pop.handle('A'), true);
  assert.equal(first.clicked, 1);
  assert.equal(t.pop.handle('Y'), false, 'other buttons pass through');
  assert.equal(t.pop.handle('B'), true);
  assert.ok(!t.pop.isOpen);
  assert.ok(node.removed);
  assert.equal(t.active, opener, 'focus is back on the quality button');
});

test('pop-over: a re-rendered button gets the focus back by its key; initial focus can be chosen', () => {
  const replacement = fakeNode('po-chat');
  const t = setup([fakeNode('po-play'), replacement]);
  const opener = fakeNode('po-chat');
  const pick = fakeNode('cc-chatWidth');
  t.pop.open({ key: 'chat', node: fakePop([fakeNode('pop-chat-on'), pick]), opener, initial: pick });
  assert.equal(t.active, pick);
  opener.isConnected = false; // the bar was rebuilt meanwhile
  t.pop.close();
  assert.equal(t.active, replacement);
});

test('pop-over: closing without returning focus (auto-hide) and opening another replaces it', () => {
  const t = setup();
  const a = fakePop([fakeNode('x')]);
  t.pop.open({ key: 'volume', node: a, opener: fakeNode('po-volume') });
  let closed = 0;
  const b = fakePop([fakeNode('y')]);
  t.pop.open({ key: 'more', node: b, opener: fakeNode('po-more'), onClose: () => { closed += 1; } });
  assert.ok(a.removed, 'the first one is gone');
  assert.equal(t.pop.key, 'more');
  const before = t.active;
  assert.equal(t.pop.close({ returnFocus: false }), null);
  assert.equal(t.active, before, 'focus untouched');
  assert.equal(closed, 1);
});

// ---- sliders ----

test('slider steps: snapped, clamped, hold accelerates', () => {
  const r = { min: 75, max: 250, step: 5 };
  assert.equal(stepValue(100, 1, r), 105);
  assert.equal(stepValue(100, -1, r, 4), 80);
  assert.equal(stepValue(248, 1, r), 250);
  assert.equal(stepValue(76, -1, r, 2), 75);
  assert.equal(stepValue('x', 1, r), 80);
  assert.equal(holdMultiplier(0), 1);
  assert.equal(holdMultiplier(800), 2);
  assert.equal(holdMultiplier(2000), 4);
  const h = new HoldTracker();
  assert.equal(h.press(1, 0), 1);
  assert.equal(h.press(1, 700), 1, 'a gap longer than a repeat starts a new hold');
  let m = 1;
  for (let t = 800; t <= 2600; t += 110) m = h.press(1, t);
  assert.equal(m, 4, 'held for 1.8 s');
  assert.equal(h.press(-1, 2700), 1, 'turning around starts over');
  assert.equal(valueAt(0.5, { min: 0, max: 100, step: 5 }), 50);
  assert.equal(valueAt(1.4, { min: 0, max: 100, step: 5 }), 100);
  assert.equal(valueAt(0.33, { min: 20, max: 50, step: 1 }), 30);
});
