import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { consumeOpenRequest, parseRequest, atMs, OpenRequestWatcher } = require('../../src/main/open-request.js');

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const write = (dir, obj) => {
  const f = path.join(dir, 'open-request.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
};

test('atMs accepts ms, seconds and ISO strings', () => {
  assert.equal(atMs(NOW), NOW);
  assert.equal(atMs(NOW / 1000), NOW);
  assert.equal(atMs(new Date(NOW).toISOString()), NOW);
  assert.ok(Number.isNaN(atMs(null)));
  assert.ok(Number.isNaN(atMs('soon')));
});

test('a fresh request is returned and the file is deleted', () => {
  const dir = tmpDir();
  const f = write(dir, { channel: 'SomeOne_1', name: 'SomeOne_1', at: (NOW - 30_000) / 1000 });
  assert.deepEqual(consumeOpenRequest(f, { now: NOW }), { channel: 'someone_1', name: 'SomeOne_1' });
  assert.equal(fs.existsSync(f), false);
  assert.equal(consumeOpenRequest(f, { now: NOW }), null);
});

test('stale, future, malformed and bad-channel requests are ignored and deleted', () => {
  const dir = tmpDir();
  const cases = [
    { channel: 'a', at: NOW - 121_000 },
    { channel: 'a', at: NOW + 5 * 60_000 },
    { channel: '../etc', at: NOW },
    { channel: 'a' },
    ['a'],
    '{"channel": "a", "at":',
    '',
  ];
  for (const c of cases) {
    const logs = [];
    const f = write(dir, c);
    assert.equal(consumeOpenRequest(f, { now: NOW, log: (l) => logs.push(l) }), null, JSON.stringify(c));
    assert.equal(fs.existsSync(f), false);
    assert.equal(logs.length, 1);
  }
});

test('parseRequest keeps a short display name and falls back to the login', () => {
  assert.deepEqual(parseRequest({ channel: 'abc', at: NOW, name: 'ABC' }, NOW), { channel: 'abc', name: 'ABC' });
  assert.deepEqual(parseRequest({ channel: 'abc', at: NOW, name: 'x'.repeat(80) }, NOW), { channel: 'abc', name: 'abc' });
  assert.deepEqual(parseRequest({ channel: 'abc', at: NOW + 30_000 }, NOW), { channel: 'abc', name: 'abc' });
});

test('the watcher consumes a request written after it started', async () => {
  const dir = tmpDir();
  const got = [];
  const w = new OpenRequestWatcher({ dir, onRequest: (r) => got.push(r.channel) });
  w.start();
  try {
    // Written the way the plugin does it: temp file, then rename.
    const tmp = path.join(dir, 'open-request.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ channel: 'later', at: Date.now() }));
    fs.renameSync(tmp, path.join(dir, 'open-request.json'));
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(got, ['later']);
    assert.equal(fs.existsSync(path.join(dir, 'open-request.json')), false);
  } finally {
    w.stop();
  }
});

test('takeNow picks up a request left before startup', () => {
  const dir = tmpDir();
  write(dir, { channel: 'boot', at: NOW - 1000 });
  const w = new OpenRequestWatcher({ dir, onRequest: () => {}, now: () => NOW });
  assert.equal(w.takeNow().channel, 'boot');
  assert.equal(w.takeNow(), null);
});
