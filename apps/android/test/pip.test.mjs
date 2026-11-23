// Picture-in-picture (pip.js, platform.js): when the activity is told to use it, the video-only mode in the window,
// and its play/pause button reaching the core (onMediaAction). MainActivity is mocked as LurkboxNative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPip, installPip } from '../src/pip.js';
import { createPlatform } from '../src/platform.js';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeDoc() {
  const classes = new Set();
  const listeners = {};
  const videos = [];
  return {
    videos,
    body: { classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }, add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
    defaultView: {},
    addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); },
    removeEventListener: (n, fn) => { listeners[n] = (listeners[n] || []).filter((f) => f !== fn); },
    querySelectorAll: (sel) => (sel === 'video' ? videos : []),
    fire: (n) => { for (const fn of listeners[n] || []) fn({ type: n }); },
    classes,
  };
}

function mockNative({ supported = true } = {}) {
  const listeners = {};
  const calls = { pip: [] };
  return {
    calls,
    listeners,
    pip: async (a) => { calls.pip.push(a); },
    pipSupported: async () => ({ supported }),
    addListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return Promise.resolve({ remove() { listeners[name] = listeners[name].filter((f) => f !== fn); } }); },
    fire: (name, data) => { for (const fn of listeners[name] || []) fn(data); },
  };
}

test('the activity is told to use picture-in-picture only while a video plays in the player and the setting is on', () => {
  const doc = fakeDoc();
  const native = mockNative();
  let on = true;
  const pip = createPip({ doc, native, enabled: () => on });
  const video = { paused: true, ended: false };
  doc.videos.push(video);
  pip.update();
  assert.deepEqual(native.calls.pip.at(-1), { wanted: false, playing: false }, 'no player yet');
  doc.body.classList.add('player-active');
  video.paused = false;
  doc.fire('playing');
  assert.deepEqual(native.calls.pip.at(-1), { wanted: true, playing: true });
  const n = native.calls.pip.length;
  doc.fire('play');
  assert.equal(native.calls.pip.length, n, 'unchanged state is not sent again');
  video.paused = true;
  doc.fire('pause');
  assert.deepEqual(native.calls.pip.at(-1), { wanted: false, playing: false }, 'paused: Home leaves the app as usual');
  video.paused = false;
  on = false;
  doc.fire('playing');
  assert.deepEqual(native.calls.pip.at(-1), { wanted: false, playing: true }, 'setting off');
  on = true;
  doc.body.classList.remove('player-active');
  pip.update();
  assert.deepEqual(native.calls.pip.at(-1), { wanted: false, playing: false }, 'player closed');
  pip.stop();
});

test('entering the window switches the page to video only, and leaving it restores the layout', () => {
  const doc = fakeDoc();
  const native = mockNative();
  const pip = createPip({ doc, native, enabled: () => true });
  doc.body.classList.add('player-active');
  doc.videos.push({ paused: false, ended: false });
  native.fire('pipMode', { inPip: true });
  assert.equal(doc.classes.has('pip'), true);
  assert.equal(pip.state().inPip, true);
  assert.equal(doc.classes.has('player-active'), true, 'the player stays open');
  native.fire('pipMode', { inPip: false });
  assert.equal(doc.classes.has('pip'), false);
  assert.equal(pip.state().inPip, false);
  pip.stop();
  native.fire('pipMode', { inPip: true });
});

test('installPip follows the pipOnLeave setting and does nothing without the native side', async () => {
  const doc = fakeDoc();
  const native = mockNative();
  let cb = null;
  const platform = { getSettings: async () => ({ pipOnLeave: false }), onSettingsChanged: (fn) => { cb = fn; return () => {}; } };
  doc.body.classList.add('player-active');
  doc.videos.push({ paused: false, ended: false });
  installPip(doc, native, platform);
  await flush();
  assert.deepEqual(native.calls.pip.at(-1), { wanted: false, playing: true });
  cb({ pipOnLeave: true });
  assert.deepEqual(native.calls.pip.at(-1), { wanted: true, playing: true });
  assert.equal(installPip(doc, {}, platform), null);
});

const prefs = () => { const m = new Map(); return { get: async ({ key }) => ({ value: m.get(key) || null }), set: async ({ key, value }) => { m.set(key, value); }, remove: async ({ key }) => { m.delete(key); } }; };
const make = (native) => createPlatform({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }), prefs: prefs(), app: null, native, qrSvg: () => '', setInterval: () => 0 });

test('the window\'s play/pause button and its closing reach the core as media actions; appInfo says whether it exists', async () => {
  const native = mockNative();
  const platform = make(native);
  assert.equal(typeof platform.onMediaAction, 'function');
  assert.equal((await platform.appInfo()).pip, true);
  const seen = [];
  const off = platform.onMediaAction((a) => seen.push(a));
  native.fire('pipAction', { action: 'toggle-pause' });
  native.fire('pipAction', { action: 'pause' });
  native.fire('pipAction', { nothing: 1 });
  off();
  native.fire('pipAction', { action: 'play' });
  assert.deepEqual(seen, ['toggle-pause', 'pause']);
  assert.equal((await make(mockNative({ supported: false })).appInfo()).pip, false, 'a TV');
  const without = make({});
  assert.equal(without.onMediaAction, undefined);
  assert.equal((await without.appInfo()).pip, false);
});
