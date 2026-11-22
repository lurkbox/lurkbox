// Builds the web assets the APK bundles (apps/android/www, Capacitor's webDir) from @lurkbox/core:
//   - packages/core/src, without the Node-only dev files (platform-check.js, platform.d.ts);
//   - the host-served files the core expects: vendor/hls.min.js and vendor/wordmark.json (platform.d.ts);
//   - platform-android.js: the Android window.lurkbox (src/platform-android.js bundled by esbuild into one classic
//     script), loaded by index.html before js/main.js so it exists before the core boots.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'www');
const CORE = path.dirname(require.resolve('@lurkbox/core/package.json'));
const CORE_SRC = path.join(CORE, 'src');
const REPO = path.resolve(APP, '..', '..');
const SKIP = new Set(['platform-check.js', 'platform.d.ts']);
const PLATFORM_TAG = '<script src="platform-android.js"></script>';

/** index.html with the Android platform script in front of the core's module script. */
export function injectPlatform(html) {
  if (html.includes(PLATFORM_TAG)) return html;
  const main = '<script type="module" src="js/main.js"></script>';
  if (!html.includes(main)) throw new Error('index.html: js/main.js script tag not found');
  return html.replace(main, `${PLATFORM_TAG}\n  ${main}`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export async function buildWeb({ out = OUT, minify = true } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(CORE_SRC, out);
  fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
  fs.copyFileSync(require.resolve('hls.js/dist/hls.min.js', { paths: [CORE] }), path.join(out, 'vendor', 'hls.min.js'));
  fs.copyFileSync(path.join(REPO, 'assets', 'src', 'wordmark.json'), path.join(out, 'vendor', 'wordmark.json'));
  const index = path.join(out, 'index.html');
  fs.writeFileSync(index, injectPlatform(fs.readFileSync(index, 'utf8')));
  const version = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
  await build({
    entryPoints: [path.join(APP, 'src', 'platform-android.js')],
    outfile: path.join(out, 'platform-android.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome90'],
    minify,
    legalComments: 'eof',
    define: { __LURKBOX_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWeb({ minify: !process.argv.includes('--no-minify') });
  console.log(`web assets → ${path.relative(REPO, OUT)}`);
}
