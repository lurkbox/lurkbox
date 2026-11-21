import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createAppLog, LOG_MAX_BYTES } = require('../../src/main/app-log.js');

test('app log: 5 MB, then rotated to lurkbox.log.1 (replacing the old one)', () => {
  assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024);
  const dir = tmpDir('lurkbox-log-');
  const file = path.join(dir, 'lurkbox.log');
  const log = createAppLog(file, { maxBytes: 100, now: () => new Date(0) }); // each line is 25 + 1 + 9 = 35 bytes
  log('line 0001');
  log('line 0002');
  assert.equal(fs.readFileSync(file, 'utf8'), '1970-01-01T00:00:00.000Z line 0001\n1970-01-01T00:00:00.000Z line 0002\n');
  log('line 0003'); // 105 > 100: rotate first
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /line 0001\n.*line 0002\n$/);
  assert.equal(fs.readFileSync(file, 'utf8'), '1970-01-01T00:00:00.000Z line 0003\n');
  log('line 0004'); log('line 0005');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n').length, 2);
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /line 0003\n.*line 0004\n$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('app log: picks up an existing file size and never throws', () => {
  const dir = tmpDir('lurkbox-log-');
  const file = path.join(dir, 'lurkbox.log');
  fs.writeFileSync(file, 'x'.repeat(90));
  createAppLog(file, { maxBytes: 100 })('next');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 90);
  assert.doesNotThrow(() => createAppLog(path.join(dir, 'missing', 'dir', 'x.log'))('nope'));
  fs.rmSync(dir, { recursive: true, force: true });
});
