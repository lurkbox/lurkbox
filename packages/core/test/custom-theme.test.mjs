import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hexToHsl, hslToHex, contrast, parseHex } from '../src/js/color.js';
import {
  BASE_COLORS, CUSTOM_KEYS, deriveTokens, sanitizeCustom, contrastWarnings, fixContrast,
} from '../src/js/theme-custom.js';
import { sanitizeSettings } from '../src/shared/settings.js';

const css = fs.readFileSync(new URL('../src/css/app.css', import.meta.url), 'utf8');
const lurkbox = /:root, :root\[data-theme="lurkbox"\]\s*\{([^}]*)\}/.exec(css)[1];
const COLOR_TOKENS = [...lurkbox.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].filter((m) => /#|rgba?\(/.test(m[2])).map((m) => m[1]);

test('derivation from the five colours produces the full token set', () => {
  for (const [base, colors] of Object.entries(BASE_COLORS)) {
    const tokens = deriveTokens(colors);
    const missing = COLOR_TOKENS.filter((t) => !(t in tokens));
    assert.deepEqual(missing, [], `${base}: missing ${missing.join(', ')}`);
    for (const [k, v] of Object.entries(tokens)) {
      if (k === '--color-scheme') continue;
      assert.match(v, /^#[0-9a-f]{6}$|^rgba\(\d+, \d+, \d+, [\d.]+\)$/, `${base} ${k}=${v}`);
    }
  }
});

test('base colours match the CSS theme blocks', () => {
  const map = { bg: '--bg', surface: '--surface', accent: '--accent', fg: '--fg', muted: '--fg-dim' };
  for (const [base, colors] of Object.entries(BASE_COLORS)) {
    const re = new RegExp(`\\[data-theme="${base}"\\]\\s*\\{([^}]*)\\}`);
    const block = re.exec(css)[1];
    for (const [k, token] of Object.entries(map)) {
      const v = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`).exec(block)[1];
      assert.equal(colors[k], v, `${base}.${k}`);
    }
  }
});

test('hex -> HSL -> hex round-trips', () => {
  for (const hex of ['#000000', '#ffffff', '#ff8a66', '#1a9fff', '#9147ff', '#123236', '#d94f3d', '#7f7f7f', '#00ff00']) {
    assert.equal(hslToHex(hexToHsl(hex)), hex);
  }
  assert.deepEqual(hexToHsl('#ff0000').map(Math.round), [0, 100, 50]);
  assert.equal(hslToHex([480, 100, 50]), '#00ff00', 'hue wraps');
});

test('Fix contrast reaches 4.5:1 for text and 3:1 for the focus colour', () => {
  const bad = [
    { bg: '#202020', surface: '#2a2a2a', accent: '#252525', fg: '#444444', muted: '#333333' },
    { bg: '#f0f0f0', surface: '#ffffff', accent: '#eeeeee', fg: '#cccccc', muted: '#dddddd' },
    { bg: '#123236', surface: '#1d4146', accent: '#1d4a50', fg: '#3a6a70', muted: '#2a5a60' },
  ];
  for (const c of bad) {
    assert.ok(contrastWarnings(c).length >= 2, 'warns before fixing');
    const f = fixContrast(c);
    assert.ok(contrast(parseHex(f.fg), parseHex(f.bg)) >= 4.5);
    assert.ok(contrast(parseHex(f.fg), parseHex(f.surface)) >= 4.5);
    assert.ok(contrast(parseHex(f.muted), parseHex(f.surface)) >= 4.5);
    assert.ok(contrast(parseHex(f.accent), parseHex(f.bg)) >= 3);
    assert.deepEqual(contrastWarnings(f), []);
    assert.equal(f.bg, c.bg, 'backgrounds untouched');
  }
});

test('invalid saved values fall back to the base theme', () => {
  const s = sanitizeCustom({ base: 'daylight', colors: { bg: 'red', surface: '#12345', accent: '#ABCDEF', fg: null } });
  assert.equal(s.base, 'daylight');
  assert.equal(s.colors.bg, BASE_COLORS.daylight.bg);
  assert.equal(s.colors.surface, BASE_COLORS.daylight.surface);
  assert.equal(s.colors.accent, '#abcdef');
  assert.equal(s.colors.fg, BASE_COLORS.daylight.fg);
  assert.deepEqual(sanitizeCustom({ base: 'nope' }), { base: 'lurkbox', colors: BASE_COLORS.lurkbox });
  assert.deepEqual(sanitizeCustom(null).colors, BASE_COLORS.lurkbox);
  assert.equal(CUSTOM_KEYS.length, 5);
});

test('main-process settings validation keeps only valid custom values', () => {
  const out = sanitizeSettings({ theme: 'custom', customTheme: { base: 'custom', colors: { bg: '#000000', fg: 'white', x: '#ffffff' } } });
  assert.equal(out.theme, 'custom');
  assert.deepEqual(out.customTheme, { base: 'lurkbox', colors: { bg: '#000000' } });
  assert.equal(sanitizeSettings({ customTheme: 'junk' }).customTheme, null);
});
