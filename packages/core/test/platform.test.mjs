import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlatform, documentedMembers, usedMembers, stripComments } from '../src/platform-check.js';

// The core's only contact with its host is window.lurkbox, documented in src/platform.d.ts.
test('platform: every window.lurkbox member the core uses is documented in platform.d.ts', () => {
  const r = checkPlatform();
  assert.deepEqual(r.undocumented, [], `add these to LurkboxPlatform in packages/core/src/platform.d.ts: ${r.undocumented.map((k) => `${k} (${r.used.get(k).join(', ')})`).join('; ')}`);
  assert.deepEqual(r.problems, []);
});

test('platform: every documented member is still used (remove stale ones from platform.d.ts)', () => {
  assert.deepEqual(checkPlatform().unused, []);
});

test('platform check: finds direct, optional, aliased and destructured access; ignores comments and strings', () => {
  const src = [
    "// window.lurkbox.commented()",
    "/* window.lurkbox.blockComment() */",
    "const url = 'https://x//y'; window.lurkbox.direct();",
    "if (window.lurkbox?.maybe) window.lurkbox.maybe();",
    "const api = window.lurkbox;",
    "api.aliased();",
    "const { picked, other: renamed } = window.lurkbox;",
    "const s = 'window.lurkbox.inString';",
  ].join('\n');
  const { used, problems } = usedMembers(src);
  assert.deepEqual([...used].sort(), ['aliased', 'direct', 'inString', 'maybe', 'other', 'picked'].sort());
  assert.deepEqual(problems, []);
  assert.deepEqual(usedMembers('window.lurkbox[name]()').problems.length, 1);
  assert.equal(stripComments("a // b\nc"), 'a \nc');
});

test('platform check: reads interface members, optional ones included', () => {
  const dts = 'export interface LurkboxPlatform {\n  /** doc */\n  a(): Promise<void>;\n  b?(x: string): void;\n  c: number;\n  nested(opts?: {\n    inner: string;\n  }): void;\n}\n';
  assert.deepEqual([...documentedMembers(dts)].sort(), ['a', 'b', 'c', 'nested']);
});
