import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { JsonFile, DEFAULT_SETTINGS, sanitizeSettings } = require('../../src/main/store.js');
const { DEFAULT_CLIENT_ID } = require('@lurkbox/core/src/shared/config.js');

test('defaults include the built-in Client ID', () => {
  const s = new JsonFile(path.join(tmpDir(), 'settings.json'), DEFAULT_SETTINGS);
  assert.equal(s.get().clientId, DEFAULT_CLIENT_ID);
  assert.equal(s.get().raidFollow, true);
  assert.equal(s.get().raidDelay, 10);
});

test('a Client ID saved in Settings overrides the default; empty means none', () => {
  const file = path.join(tmpDir(), 'settings.json');
  new JsonFile(file, DEFAULT_SETTINGS).set({ clientId: 'abc123' });
  assert.equal(new JsonFile(file, DEFAULT_SETTINGS).get().clientId, 'abc123');
  new JsonFile(file, DEFAULT_SETTINGS).set({ clientId: '' });
  assert.equal(new JsonFile(file, DEFAULT_SETTINGS).get().clientId, '');
});

test('files are written with mode 0600 and survive a corrupt file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'tokens.json');
  new JsonFile(file, {}).set({ access_token: 'x' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(new JsonFile(file, { a: 1 }).get(), { a: 1 });
});

test('sanitizeSettings validates and clamps values', () => {
  assert.deepEqual(sanitizeSettings({ clientId: '  ab-c 12!  ' }), { clientId: 'abc12' });
  assert.equal(sanitizeSettings({ raidDelay: 500 }).raidDelay, 120);
  assert.equal(sanitizeSettings({ raidDelay: -3 }).raidDelay, 0);
  assert.equal(sanitizeSettings({ raidDelay: 'x' }).raidDelay, DEFAULT_SETTINGS.raidDelay);
  assert.deepEqual(sanitizeSettings({ chatDefault: 1, raidFollow: 0 }), { chatDefault: true, raidFollow: false });
  assert.deepEqual(sanitizeSettings({ unknownKey: 'x' }), {});
});

test('theme setting is validated against the theme list', () => {
  assert.equal(sanitizeSettings({ theme: 'oled' }).theme, 'oled');
  assert.equal(sanitizeSettings({ theme: 'twitch' }).theme, 'lurkbox');
  assert.equal(DEFAULT_SETTINGS.theme, 'lurkbox');
});

test('screen margin defaults to 0 and the old auto value migrates to 0', () => {
  assert.equal(DEFAULT_SETTINGS.screenMargin, 0);
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ screenMargin: 'auto', uiScale: 110 }));
  const s = new JsonFile(file, DEFAULT_SETTINGS).get();
  assert.equal(s.screenMargin, 0);
  assert.equal(s.uiScale, 110);
  assert.equal(sanitizeSettings({ screenMargin: 'auto' }).screenMargin, 0);
  assert.equal(sanitizeSettings({ screenMargin: 2.5 }).screenMargin, 2.5);
});
