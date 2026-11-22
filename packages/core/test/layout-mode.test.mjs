// Layout modes: Auto from the window size, the pointer and controllers, the Settings override, the system keyboard,
// and the setting through the schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLayout, touchLayoutFor, useSystemKeyboard, validLayoutMode, LAYOUT_MODES } from '../src/shared/layout-mode.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const touch = { touchHost: true, coarse: true, gamepad: false };

test('Auto on a touchscreen: phone, tablet by size', () => {
  assert.equal(pickLayout({ ...touch, width: 412, height: 915 }), 'phone', 'phone portrait');
  assert.equal(pickLayout({ ...touch, width: 915, height: 412 }), 'phone', 'phone landscape (short side < 500)');
  assert.equal(pickLayout({ ...touch, width: 1280, height: 800 }), 'tablet', 'tablet landscape');
  assert.equal(pickLayout({ ...touch, width: 800, height: 1280 }), 'tablet', 'tablet portrait');
  assert.equal(pickLayout({ ...touch, width: 600, height: 960 }), 'phone', 'a small tablet held upright is narrower than 700');
  assert.equal(pickLayout({ ...touch, width: 960, height: 600 }), 'tablet', '... and a tablet sideways');
  assert.equal(touchLayoutFor(699, 1000), 'phone');
  assert.equal(touchLayoutFor(700, 1000), 'tablet');
  assert.equal(touchLayoutFor(1000, 499), 'phone');
  assert.equal(touchLayoutFor(1000, 500), 'tablet');
});

test('Auto is TV without a touchscreen, with a controller, or on a host without touch layouts', () => {
  assert.equal(pickLayout({ ...touch, coarse: false, width: 412, height: 915 }), 'tv', 'fine or no pointer (Android TV)');
  assert.equal(pickLayout({ ...touch, gamepad: true, width: 412, height: 915 }), 'tv', 'a phone with a controller');
  assert.equal(pickLayout({ ...touch, gamepad: true, width: 1280, height: 800 }), 'tv', 'a tablet with a controller');
  assert.equal(pickLayout({ ...touch, touchHost: false, width: 1280, height: 800 }), 'tv', 'the desktop (Steam Deck touchscreen)');
  assert.equal(pickLayout({ touchHost: false, coarse: false, gamepad: false, width: 1920, height: 1080 }), 'tv', 'the desktop');
  assert.equal(pickLayout({ width: 412, height: 915 }), 'tv', 'nothing known: TV');
  assert.equal(pickLayout(), 'tv');
});

test('the Settings override wins over everything', () => {
  for (const mode of ['tv', 'tablet', 'phone']) {
    assert.equal(pickLayout({ override: mode, touchHost: false, coarse: false, gamepad: true, width: 1920, height: 1080 }), mode);
    assert.equal(pickLayout({ override: mode, ...touch, width: 412, height: 915 }), mode);
  }
  assert.equal(pickLayout({ override: 'auto', ...touch, width: 412, height: 915 }), 'phone');
  assert.equal(pickLayout({ override: 'nonsense', ...touch, width: 412, height: 915 }), 'phone', 'unknown → Auto');
});

test('the system keyboard: touch layout, touchscreen, no controller', () => {
  assert.equal(useSystemKeyboard({ layout: 'phone', coarse: true, gamepad: false }), true);
  assert.equal(useSystemKeyboard({ layout: 'tablet', coarse: true, gamepad: false }), true);
  assert.equal(useSystemKeyboard({ layout: 'phone', coarse: true, gamepad: true }), false, 'a controller gets the on-screen keyboard');
  assert.equal(useSystemKeyboard({ layout: 'phone', coarse: false, gamepad: false }), false, 'phone layout forced on a desktop');
  assert.equal(useSystemKeyboard({ layout: 'tv', coarse: true, gamepad: false }), false, 'TV layout forced on a phone');
});

test('layoutMode in the settings schema', () => {
  assert.equal(DEFAULT_SETTINGS.layoutMode, 'auto');
  assert.deepEqual(LAYOUT_MODES, ['auto', 'tv', 'tablet', 'phone']);
  for (const m of LAYOUT_MODES) assert.deepEqual(sanitizeSettings({ layoutMode: m }), { layoutMode: m });
  assert.deepEqual(sanitizeSettings({ layoutMode: 'watch' }), { layoutMode: 'auto' });
  assert.deepEqual(sanitizeSettings({ layoutMode: null }), { layoutMode: 'auto' });
  assert.equal(validLayoutMode(undefined), 'auto');
  assert.deepEqual(sanitizeSettings({}), {}, 'left alone when not in the patch');
});
