import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { importHostConfig, MARKER } = require('../../src/main/flatpak-import.js');

const FLATPAK = { FLATPAK_ID: 'io.github.lurkbox.Lurkbox' };

function hostProfile() {
  const host = tmpDir();
  fs.writeFileSync(path.join(host, 'tokens.json'), '{"accounts":[]}', { mode: 0o600 });
  fs.writeFileSync(path.join(host, 'settings.json'), '{}');
  fs.writeFileSync(path.join(host, 'lurkbox.log'), 'log');
  fs.writeFileSync(path.join(host, 'SingletonLock'), '');
  fs.mkdirSync(path.join(host, 'Cache'));
  fs.writeFileSync(path.join(host, 'Cache', 'data_0'), 'x');
  fs.mkdirSync(path.join(host, 'Local Storage'));
  fs.writeFileSync(path.join(host, 'Local Storage', 'leveldb'), 'y');
  return host;
}

test('does nothing outside a Flatpak', () => {
  const userData = path.join(tmpDir(), 'Lurkbox');
  const r = importHostConfig({ userData, env: {}, hostDir: hostProfile() });
  assert.equal(r.imported, false);
  assert.equal(fs.existsSync(userData), false);
});

test('copies the profile once, without caches, logs or locks, keeping modes', () => {
  const host = hostProfile();
  const userData = path.join(tmpDir(), 'Lurkbox');
  const r = importHostConfig({ userData, env: FLATPAK, hostDir: host });
  assert.equal(r.imported, true);
  assert.equal(fs.readFileSync(path.join(userData, 'tokens.json'), 'utf8'), '{"accounts":[]}');
  assert.equal(fs.statSync(path.join(userData, 'tokens.json')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(userData, 'Local Storage', 'leveldb')));
  for (const n of ['lurkbox.log', 'SingletonLock', 'Cache']) assert.equal(fs.existsSync(path.join(userData, n)), false, n);
  assert.ok(fs.existsSync(path.join(userData, MARKER)));
  // Second start: the marker stops it, even if the Flatpak profile was emptied.
  fs.rmSync(path.join(userData, 'tokens.json'));
  assert.equal(importHostConfig({ userData, env: FLATPAK, hostDir: host }).reason, 'already done');
  assert.equal(fs.existsSync(path.join(userData, 'tokens.json')), false);
  // The host folder is untouched.
  assert.ok(fs.existsSync(path.join(host, 'lurkbox.log')));
});

test('never overwrites a Flatpak profile that is already in use', () => {
  const userData = path.join(tmpDir(), 'Lurkbox');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), '{"mine":true}');
  const r = importHostConfig({ userData, env: FLATPAK, hostDir: hostProfile() });
  assert.equal(r.imported, false);
  assert.equal(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'), '{"mine":true}');
  assert.equal(fs.existsSync(path.join(userData, 'tokens.json')), false);
});

test('a missing host folder is not an error', () => {
  const userData = path.join(tmpDir(), 'Lurkbox');
  const r = importHostConfig({ userData, env: FLATPAK, hostDir: path.join(tmpDir(), 'nope') });
  assert.equal(r.imported, false);
  assert.match(r.reason, /no readable/);
});

test('the Steam keyboard goes through xdg-open (the OpenURI portal) inside the Flatpak', () => {
  const { keyboardCommand } = require('../../src/main/steam-keyboard.js');
  assert.deepEqual(keyboardCommand({}), ['steam', ['steam://open/keyboard']]);
  assert.deepEqual(keyboardCommand(FLATPAK), ['xdg-open', ['steam://open/keyboard']]);
});
