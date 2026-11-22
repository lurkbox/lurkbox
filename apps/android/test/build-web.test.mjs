import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWeb, injectPlatform } from '../scripts/build-web.mjs';

test('injectPlatform puts the Android platform script in front of the core, once', () => {
  const html = '<body>\n  <script type="module" src="js/main.js"></script>\n</body>';
  const out = injectPlatform(html);
  assert.ok(out.indexOf('platform-android.js') < out.indexOf('js/main.js'));
  assert.equal(injectPlatform(out), out);
  assert.throws(() => injectPlatform('<body></body>'));
});

test('buildWeb bundles the core, the host-served files and the platform, without the dev-only files', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-www-'));
  try {
    await buildWeb({ out, minify: false });
    for (const f of ['index.html', 'js/main.js', 'vendor/hls.min.js', 'vendor/wordmark.json', 'platform-android.js']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(out, 'platform-check.js')));
    assert.ok(!fs.existsSync(path.join(out, 'platform.d.ts')));
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /platform-android\.js/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
