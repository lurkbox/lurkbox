// Colour helpers (pure). Used to keep chat name colours readable on every theme.

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function lin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb) {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Returns `color` (hex) adjusted so it has at least `min` contrast against `bg`:
 * mixed toward white on dark backgrounds and toward black on light ones.
 * Missing or invalid colours fall back to `fallback`.
 */
export function readableOn(color, bg, { min = 4.5, fallback = '#9b7bff' } = {}) {
  const bgRgb = parseHex(bg) || [0, 0, 0];
  const start = parseHex(color) || parseHex(fallback);
  const target = luminance(bgRgb) < 0.18 ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const mixed = start.map((v, i) => v + (target[i] - v) * t);
    if (contrast(mixed, bgRgb) >= min) return toHex(mixed);
  }
  return toHex(target);
}

export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

export function rgba(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** hex -> [h 0..360, s 0..100, l 0..100] */
export function hexToHsl(hex) {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

/** [h, s, l] -> hex */
export function hslToHex([h, s, l]) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

export function isHex(v) { return /^#[0-9a-f]{6}$/i.test(String(v || '')); }
