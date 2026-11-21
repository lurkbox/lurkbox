import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readableOn, parseHex, contrast } from '../src/js/color.js';
import { THEMES } from '../src/shared/settings.js';

const css = fs.readFileSync(new URL('../src/css/app.css', import.meta.url), 'utf8');

/** Returns { name: { token: value } } for every :root[data-theme="..."] block. */
function themeBlocks() {
  const out = {};
  const re = /:root(?:,\s*:root)?\[data-theme="([a-z-]+)"\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const tokens = {};
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
    out[m[1]] = tokens;
  }
  return out;
}
const blocks = themeBlocks();
const COLOR_TOKENS = Object.keys(blocks.lurkbox).filter((k) => /#|rgba?\(/.test(blocks.lurkbox[k]));

test('six built-in themes in CSS plus Custom in settings validation', () => {
  assert.deepEqual(Object.keys(blocks).sort(), THEMES.filter((t) => t !== 'custom').sort());
  assert.equal(THEMES.length, 7);
  assert.equal(THEMES.at(-1), 'custom');
});

test('every theme defines the full colour token set', () => {
  assert.ok(COLOR_TOKENS.length >= 30, `found ${COLOR_TOKENS.length} tokens`);
  for (const [name, tokens] of Object.entries(blocks)) {
    const missing = COLOR_TOKENS.filter((t) => !(t in tokens));
    assert.deepEqual(missing, [], `${name} is missing ${missing.join(', ')}`);
  }
});

test('component CSS uses tokens only: no literal colours outside theme blocks', () => {
  const components = css.slice(css.indexOf('html { font-size'));
  const literals = components.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
  assert.deepEqual(literals, []);
});

test('every var(--token) used is defined', () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const undef = [...used].filter((u) => !defined.has(u));
  assert.deepEqual(undef, []);
});

test('OLED is pure black; High Contrast uses a 6px yellow ring with opaque scrims', () => {
  for (const t of ['--bg', '--surface', '--raised', '--panel-bg', '--chat-bg']) assert.equal(blocks.oled[t], '#000000', t);
  assert.equal(blocks.oled['--border'], '#1a1a1a');
  assert.equal(blocks['high-contrast']['--ring'], '#ffd400');
  assert.equal(blocks['high-contrast']['--ring-w'], '6px');
  assert.match(blocks['high-contrast']['--scrim'], /^#/, 'modal scrim is opaque');
  for (const [name, t] of Object.entries(blocks)) for (const k of ['--overlay-from', '--overlay-mid']) assert.match(t[k], /^rgba\(/, `${name} ${k}: the player overlay is never opaque`);
});

test('body text meets 4.5:1 on each theme background and surface', () => {
  for (const [name, t] of Object.entries(blocks)) {
    for (const bg of ['--bg', '--surface', '--chat-bg', '--panel-bg']) {
      const c = contrast(parseHex(t['--fg']), parseHex(t[bg]));
      assert.ok(c >= 4.5, `${name} --fg on ${bg}: ${c.toFixed(2)}`);
    }
  }
});

test('chat name colours are clamped to at least 4.5:1 on every theme', () => {
  const samples = ['#000000', '#0000FF', '#1E90FF', '#8A2BE2', '#FF0000', '#008000', '#FFFF00', '#FFFFFF', '#00FF7F', '#D2691E', '#5F9EA0', '', 'garbage'];
  for (const [name, t] of Object.entries(blocks)) {
    const bg = t['--chat-bg'];
    for (const s of samples) {
      const out = readableOn(s, bg);
      const c = contrast(parseHex(out), parseHex(bg));
      assert.ok(c >= 4.5, `${name}: ${s || '(none)'} -> ${out} on ${bg} = ${c.toFixed(2)}`);
    }
  }
});

test('readableOn leaves already-readable colours alone', () => {
  assert.equal(readableOn('#ffffff', '#000000'), '#ffffff');
  assert.equal(readableOn('#14181f', '#ffffff'), '#14181f');
});

test('Game Mode theme: flatter corners, blue ring with a white inner edge, 1.04 focus scale', () => {
  const g = blocks['game-mode'];
  assert.equal(g['--radius'], '4px');
  assert.equal(g['--accent'], '#1a9fff');
  assert.equal(g['--inner-ring'], '#ffffff');
  assert.equal(g['--inner-w'], '2px');
  assert.equal(g['--focus-scale'], '1.04');
  assert.equal(g['--bg-top'], '#1b2838');
  assert.equal(g['--bg'], '#0e141b');
});

test('mascot renders with every theme and references only defined variables', async () => {
  const { mascotSvg, LIVE, resolvedColors } = await import('../src/js/mascot.js');
  const { deriveTokens, BASE_COLORS } = await import('../src/js/theme-custom.js');
  const live = mascotSvg(LIVE);
  const used = [...new Set([...live.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
  const base = /:root \{([^}]*)\}/.exec(css)[1];
  const all = { ...blocks, custom: deriveTokens(BASE_COLORS.daylight) };
  for (const [name, tokens] of Object.entries(all)) {
    for (const v of used) assert.ok(v in tokens || base.includes(`${v}:`), `${name} lacks ${v}`);
    const get = (n) => tokens[n] ?? (/--icon-halo:\s*([\d.]+)/.exec(base) || [])[1];
    const svg = mascotSvg(resolvedColors(get), { background: true, rounded: true });
    assert.ok(!/undefined|NaN|var\(/.test(svg), `${name} raster SVG is fully resolved`);
    assert.equal((svg.match(/<rect /g) || []).length, 6, 'background + screen + 4 couch rects');
  }
  assert.equal(blocks.oled['--icon-halo'], '0', 'OLED has no halo');
  assert.equal(blocks['high-contrast']['--icon-stroke'], '#ffffff', 'High Contrast screen outline');
});
