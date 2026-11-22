// README screenshots: runs Lurkbox in demo mode (LURKBOX_DEMO=1: made-up data, no network) once per scene, drives it
// with a virtual gamepad and writes PNGs to docs/screenshots/ (screenshot-scene.js has the scenes).
//
//   npm run screenshots                      # every scene
//   npm run screenshots -- player player-chat   # some scenes (themes = the theme montage)
//
// Needs ffmpeg (with librsvg) for the demo video and ImageMagick (magick) for the theme montage and PNG
// optimisation. Runs under xvfb-run when it is installed (SHOT_XVFB=0 uses your display), at 1280×800 (SHOT_SIZE).
// Deterministic: fixed data, seeded pictures, the clock pinned to the demo's "now", animations off; only the frame of
// the demo video differs slightly between runs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(process.env.SHOT_OUT || path.join(REPO, 'docs', 'screenshots'));
const SCENE_JS = path.join(HERE, 'screenshot-scene.js');
const ELECTRON = require('electron'); // the binary path when required from Node

export const SCENES = ['following', 'following-by-game', 'player', 'player-popover', 'player-chat', 'player-chat-overlay', 'chat-composer', 'chat-emotes', 'quick-chat', 'player-rewind', 'categories', 'search', 'search-history', 'keyboard', 'settings', 'themes', 'whos-watching', 'signin'];
export const THEMES = [
  ['lurkbox', 'Lurkbox'], ['game-mode', 'Game Mode'], ['classic-purple', 'Classic Purple'], ['oled', 'OLED'],
  ['daylight', 'Daylight'], ['high-contrast', 'High Contrast'], ['custom', 'Custom'],
];

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const fail = (msg) => { console.error(`[screenshots] ${msg}`); process.exit(1); };

function runScene(scene, { theme, out }) {
  const env = { ...process.env, SHOT_SCENE: scene, SHOT_OUT: out, XDG_SESSION_TYPE: 'x11' };
  if (theme) env.SHOT_THEME = theme;
  delete env.ELECTRON_RUN_AS_NODE;
  const xvfb = process.env.SHOT_XVFB !== '0' && has('xvfb-run');
  if (xvfb) delete env.WAYLAND_DISPLAY;
  const args = [...(xvfb ? ['-a', '-s', '-screen 0 1920x1080x24', ELECTRON] : []), ...(xvfb ? ['--ozone-platform=x11'] : []), SCENE_JS];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(xvfb ? 'xvfb-run' : ELECTRON, args, { env, encoding: 'utf8', timeout: 150000 });
    const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /^\[shot\]|^ {2}\S/.test(l));
    if (r.status === 0) { console.log(lines.filter((l) => !/: ok: /.test(l)).join('\n')); return; }
    console.log(lines.join('\n') || (r.error ? r.error.message : `exit ${r.status}`));
    if (r.status === 3) fail(`${scene}: demo mode tried to reach the network (see above)`);
    if (attempt === 1) console.log(`[screenshots] ${scene}: retrying once`);
  }
  fail(`${scene} failed twice`);
}

/** All seven themes on the same screen: 4 + 3 tiles, labelled. */
function montage(dir, file) {
  const tile = (list) => ['montage', ...list.flatMap(([key, label]) => ['-label', label, path.join(dir, `theme-${key}.png`)]),
    '-tile', `${list.length}x1`, '-geometry', '480x300+14+10', '-background', '#081719', '-fill', '#ffe3cc', '-font', 'DejaVu-Sans-Bold', '-pointsize', '20'];
  const rowA = path.join(dir, 'row-a.png');
  const rowB = path.join(dir, 'row-b.png');
  for (const [args, f] of [[tile(THEMES.slice(0, 4)), rowA], [tile(THEMES.slice(4)), rowB]]) {
    const r = spawnSync('magick', [...args, f], { encoding: 'utf8' });
    if (r.status !== 0) fail(`montage failed: ${r.stderr}`);
  }
  const r = spawnSync('magick', [rowA, rowB, '-background', '#081719', '-gravity', 'center', '-append', '-bordercolor', '#081719', '-border', '8', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`montage failed: ${r.stderr}`);
}

const MAX_BYTES = 400 * 1024;
/** Recompresses a PNG losslessly; if it is still over 400 KB, quantises it to 256 colours. */
function optimise(file) {
  const tmp = `${file}.tmp.png`;
  for (const fmt of [['PNG24'], ['PNG8', '-colors', '256']]) {
    if (fmt[0] === 'PNG8' && fs.statSync(file).size <= MAX_BYTES) break;
    const r = spawnSync('magick', [file, '-strip', ...fmt.slice(1), '-define', 'png:compression-level=9', '-define', 'png:compression-filter=5', '-define', 'png:compression-strategy=1', `${fmt[0]}:${tmp}`], { encoding: 'utf8' });
    if (r.status === 0 && fs.statSync(tmp).size < fs.statSync(file).size) fs.renameSync(tmp, file);
    else fs.rmSync(tmp, { force: true });
  }
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const scenes = wanted.length ? wanted : SCENES;
  for (const s of scenes) if (!SCENES.includes(s)) fail(`unknown scene "${s}"; one of ${SCENES.join(', ')}`);
  if (!has('ffmpeg')) fail('ffmpeg is needed for the demo video');
  if (!has('magick')) fail('ImageMagick (magick) is needed for the theme montage and PNG optimisation');
  fs.mkdirSync(OUT, { recursive: true });

  // Render the demo video once (cached in the temp dir), so the first scene doesn't time out on it.
  const media = require(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'demo-media.js'));
  const images = await import(path.join(REPO, 'packages', 'core', 'src', 'js', 'demo', 'images.js'));
  const mediaDir = process.env.LURKBOX_DEMO_MEDIA || path.join(os.tmpdir(), `lurkbox-demo-media-${media.VERSION}`);
  const m = media.ensureDemoMedia(mediaDir, { sceneSvg: images.videoSceneSvg(), runnerSvg: images.runnerSvg(), log: (l) => console.log(l) });
  if (!m.ok) fail(`demo video: ${m.reason}`);
  process.env.LURKBOX_DEMO_MEDIA = mediaDir;

  const written = [];
  for (const scene of scenes) {
    if (scene === 'themes') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-themes-'));
      for (const [key] of THEMES) runScene('theme', { theme: key, out: tmp });
      montage(tmp, path.join(OUT, 'themes.png'));
      fs.rmSync(tmp, { recursive: true, force: true });
    } else {
      runScene(scene, { out: OUT });
    }
    written.push(path.join(OUT, `${scene}.png`));
  }
  for (const f of written) optimise(f);
  console.log('[screenshots] done:');
  for (const f of written) console.log(`  ${path.relative(REPO, f)}  ${Math.round(fs.statSync(f).size / 1024)} KB`);
}

main().catch((e) => fail(e.stack || e.message));
