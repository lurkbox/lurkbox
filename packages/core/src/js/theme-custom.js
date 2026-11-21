// The "Custom" theme: five user colours, everything else derived (pure; unit-tested).
import { parseHex, contrast, mix, rgba, hexToHsl, hslToHex, isHex, luminance } from './color.js';

export const CUSTOM_KEYS = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'accent', label: 'Accent / focus' },
  { key: 'fg', label: 'Text' },
  { key: 'muted', label: 'Muted text' },
];

// Starting values per base theme (must match the CSS theme blocks; a test checks).
export const BASE_COLORS = {
  lurkbox: { bg: '#081719', surface: '#0f2a2e', accent: '#ff8a66', fg: '#ffe3cc', muted: '#c4b2a2' },
  'game-mode': { bg: '#0e141b', surface: '#23262e', accent: '#1a9fff', fg: '#dcdedf', muted: '#8b929a' },
  'classic-purple': { bg: '#0e0e10', surface: '#18181b', accent: '#9147ff', fg: '#efeff1', muted: '#adadb8' },
  oled: { bg: '#000000', surface: '#000000', accent: '#ff8a66', fg: '#e6e6e6', muted: '#9a9a9a' },
  daylight: { bg: '#f4f5f7', surface: '#ffffff', accent: '#d94f3d', fg: '#14181f', muted: '#505867' },
  'high-contrast': { bg: '#000000', surface: '#000000', accent: '#ffd400', fg: '#ffffff', muted: '#ffffff' },
};

export const PRESETS = [
  '#000000', '#0e141b', '#081719', '#1f1f23', '#f4f5f7', '#ffffff',
  '#ff8a66', '#e0504a', '#ffd400', '#3ccf8e', '#1a9fff', '#9147ff',
];

/** Validates a saved {base, colors}; bad or missing values fall back to the base theme's. */
export function sanitizeCustom(saved) {
  const base = saved && BASE_COLORS[saved.base] ? saved.base : 'lurkbox';
  const colors = { ...BASE_COLORS[base] };
  const src = (saved && saved.colors) || {};
  for (const { key } of CUSTOM_KEYS) if (isHex(src[key])) colors[key] = src[key].toLowerCase();
  return { base, colors };
}

const isDark = (hex) => luminance(parseHex(hex)) < 0.18;
const bestOn = (hex) => (contrast(parseHex('#000000'), parseHex(hex)) >= contrast(parseHex('#ffffff'), parseHex(hex)) ? '#000000' : '#ffffff');

/** Full token map (same names as the CSS theme blocks) from the five user colours. */
export function deriveTokens(c) {
  const dark = isDark(c.bg);
  const lift = dark ? '#ffffff' : '#000000';
  return {
    '--bg': c.bg,
    '--bg-top': mix(c.bg, lift, dark ? 0.07 : 0.02),
    '--surface': c.surface,
    '--raised': mix(c.surface, c.fg, 0.08),
    '--fg': c.fg,
    '--fg-dim': c.muted,
    '--accent': c.accent,
    '--accent-glow': mix(c.accent, '#ffffff', 0.45),
    '--on-accent': bestOn(c.accent),
    '--primary-bg': c.accent,
    '--primary-fg': bestOn(c.accent),
    '--live': '#e0504a',
    '--on-live': '#ffffff',
    '--ok': '#3ccf8e',
    '--on-ok': '#032b1c',
    '--warn': '#ffb547',
    '--ring': c.accent,
    '--ring-glow': rgba(c.accent, 0.5),
    '--focus-bg': c.fg,
    '--focus-fg': c.bg,
    '--border': mix(c.surface, c.fg, 0.15),
    '--input-bg': mix(c.bg, c.surface, 0.5),
    '--input-border': mix(c.surface, c.fg, 0.28),
    '--scrim': rgba(c.bg, 0.82),
    '--overlay-from': rgba(c.bg, 0.7),
    '--overlay-mid': rgba(c.bg, 0.4),
    '--panel-bg': c.surface,
    '--chat-bg': c.surface,
    '--toast-bg': mix(c.surface, c.fg, 0.08),
    '--badge-bg': 'rgba(0, 0, 0, 0.72)',
    '--badge-fg': '#ffffff',
    '--qr-bg': '#ffffff',
    '--video-bg': '#000000',
    '--inner-ring': 'rgba(0, 0, 0, 0)',
    '--icon-silhouette': mix(c.bg, '#000000', dark ? 0.55 : 0.3),
    '--icon-stroke': 'rgba(0, 0, 0, 0)',
    '--title-a': c.fg,
    '--title-b': c.accent,
    '--shadow': dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.18)',
    '--color-scheme': dark ? 'dark' : 'light',
  };
}

/** Contrast problems to warn about (never blocks). */
export function contrastWarnings(c) {
  const w = [];
  const ratio = (a, b) => contrast(parseHex(a), parseHex(b));
  const tb = ratio(c.fg, c.bg);
  const ts = ratio(c.fg, c.surface);
  const ab = ratio(c.accent, c.bg);
  if (tb < 4.5) w.push({ id: 'fg-bg', text: `Text on background is ${tb.toFixed(1)}:1 (needs 4.5:1)` });
  if (ts < 4.5) w.push({ id: 'fg-surface', text: `Text on surface is ${ts.toFixed(1)}:1 (needs 4.5:1)` });
  if (ab < 3) w.push({ id: 'accent-bg', text: `Focus colour on background is ${ab.toFixed(1)}:1 (needs 3:1 to show focus)` });
  return w;
}

/** Moves a colour's lightness away from the backgrounds until it reaches `min` against all of them. */
export function nudgeLightness(color, backgrounds, min) {
  const ok = (hex) => backgrounds.every((b) => contrast(parseHex(hex), parseHex(b)) >= min);
  if (ok(color)) return color;
  const [h, s, l] = hexToHsl(color);
  const dark = backgrounds.every((b) => isDark(b));
  const dir = dark ? 1 : -1;
  for (let step = 1; step <= 100; step++) {
    const cand = hslToHex([h, s, l + dir * step]);
    if (ok(cand)) return cand;
  }
  return dark ? '#ffffff' : '#000000';
}

/** "Fix contrast": text to 4.5:1 on bg and surface, muted to 4.5:1, accent to 3:1 on bg. */
export function fixContrast(c) {
  return {
    ...c,
    fg: nudgeLightness(c.fg, [c.bg, c.surface], 4.5),
    muted: nudgeLightness(c.muted, [c.bg, c.surface], 4.5),
    accent: nudgeLightness(c.accent, [c.bg], 3),
  };
}

const KEEP = new Set(['--ui-scale', '--screen-margin']); // display settings, not theme tokens

/** Applies a token map as inline custom properties (custom theme), or clears them. */
export function applyTokens(tokens) {
  const root = document.documentElement;
  for (const p of [...root.style]) if (p.startsWith('--') && !KEEP.has(p)) root.style.removeProperty(p);
  root.style.removeProperty('color-scheme');
  if (!tokens) return;
  for (const [k, v] of Object.entries(tokens)) {
    if (k === '--color-scheme') root.style.setProperty('color-scheme', v);
    else root.style.setProperty(k, v);
  }
}
