import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { documentedMembers } from '@lurkbox/core/src/platform-check.js';

// The desktop host implements the core's platform interface (packages/core/src/platform.d.ts) in preload.js.
test('preload.js exposes exactly the documented window.lurkbox interface', () => {
  const core = path.dirname(createRequire(import.meta.url).resolve('@lurkbox/core/package.json'));
  const dts = fs.readFileSync(path.join(core, 'src', 'platform.d.ts'), 'utf8');
  const preload = fs.readFileSync(new URL('../../src/preload.js', import.meta.url), 'utf8');
  const block = preload.slice(preload.indexOf("exposeInMainWorld('lurkbox', {"));
  const exposed = new Set([...block.slice(0, block.indexOf('\n});')).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
  const documented = documentedMembers(dts);
  assert.deepEqual([...exposed].filter((k) => !documented.has(k)).sort(), [], 'exposed by preload.js but not documented in platform.d.ts');
  assert.deepEqual([...documented].filter((k) => !exposed.has(k)).sort(), [], 'documented in platform.d.ts but not exposed by preload.js');
});
