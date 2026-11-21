import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ScopeKeeper, parseCgroup, shouldMoveBack } = require('../../src/main/keep-scope.js');

const SLICE = '/user.slice/user-1000.slice/user@1000.service/app.slice';
const STEAM = `${SLICE}/app-steam-app3002582954-100.scope`;
const CHROMIUM = `${SLICE}/app-io.github.lurkbox.Lurkbox-200.scope`;

test('parseCgroup reads the cgroup v2 line', () => {
  assert.equal(parseCgroup(`0::${STEAM}\n`), STEAM);
  assert.equal(parseCgroup('12:pids:/x\n0::/a/b.scope'), '/a/b.scope');
  assert.equal(parseCgroup('1:name=systemd:/x'), null);
  assert.equal(parseCgroup(''), null);
});

test('only sibling scopes are moved back', () => {
  assert.equal(shouldMoveBack(STEAM, CHROMIUM), true);
  assert.equal(shouldMoveBack(STEAM, STEAM), false);
  assert.equal(shouldMoveBack(null, CHROMIUM), false);
  assert.equal(shouldMoveBack(STEAM, '/other.slice/app-x-1.scope'), false, 'different parent');
  assert.equal(shouldMoveBack(`${SLICE}/something.service`, CHROMIUM), false, 'original is not a scope');
});

test('ScopeKeeper moves the browser process and its followers back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-scope-'));
  const proc = path.join(tmp, 'proc');
  const cg = path.join(tmp, 'cg');
  fs.mkdirSync(path.join(proc, '200'), { recursive: true });
  fs.mkdirSync(path.join(cg, STEAM), { recursive: true });
  fs.mkdirSync(path.join(cg, CHROMIUM), { recursive: true });
  fs.writeFileSync(path.join(proc, '200', 'cgroup'), `0::${STEAM}\n`);
  const logs = [];
  const k = new ScopeKeeper({ pid: 200, procRoot: proc, cgroupRoot: cg, log: (l) => logs.push(l) });
  assert.equal(k.original, STEAM);
  assert.equal(k.check(), 0, 'nothing to do while still in the launch scope');
  // Chromium moves us; an audio process (201) is born in the new scope.
  fs.writeFileSync(path.join(proc, '200', 'cgroup'), `0::${CHROMIUM}\n`);
  fs.writeFileSync(path.join(cg, CHROMIUM, 'cgroup.procs'), '201\n200\n');
  const written = [];
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    if (String(file).endsWith('cgroup.procs')) { written.push([path.relative(cg, path.dirname(file)), String(data).trim()]); return; }
    return real(file, data, ...rest);
  };
  try { assert.equal(k.check(), 2); } finally { fs.writeFileSync = real; }
  assert.deepEqual(written, [[STEAM.slice(1), '200'], [STEAM.slice(1), '201']], 'own pid first, then the rest');
  assert.match(logs.at(-1), /moved 2 process\(es\) back to app-steam-app3002582954-100\.scope/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
