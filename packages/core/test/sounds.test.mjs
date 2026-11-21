import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = globalThis.window || {};
const { gainFor, soundsEnabled, TONES } = await import('../src/js/sounds.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = await import('../src/shared/settings.js');

test('navigation sounds default on at normal volume and can be turned off', () => {
  assert.equal(DEFAULT_SETTINGS.navSounds, true);
  assert.equal(DEFAULT_SETTINGS.navSoundVolume, 30);
  assert.equal(soundsEnabled({ navSounds: false, navSoundVolume: 50 }), false);
  assert.equal(soundsEnabled({ navSounds: true, navSoundVolume: 0 }), false);
  assert.equal(soundsEnabled({}), true);
});

test('volume is sanitised to 0..100 in steps of 10 and maps to a soft gain', () => {
  assert.equal(sanitizeSettings({ navSoundVolume: 57 }).navSoundVolume, 60);
  assert.equal(sanitizeSettings({ navSoundVolume: 500 }).navSoundVolume, 100);
  assert.equal(sanitizeSettings({ navSoundVolume: 'x' }).navSoundVolume, 30);
  assert.equal(gainFor(0), 0);
  assert.ok(gainFor(100) <= 0.2 && gainFor(30) >= 0.05 && gainFor(30) < gainFor(60));
});

test('every sound is short', () => {
  for (const [name, parts] of Object.entries(TONES)) for (const p of parts) assert.ok(p[2] <= 120, name);
});
