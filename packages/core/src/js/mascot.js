// Themed mascot (TV + couch lurker). Same geometry as assets/src/build-art.py
// mascot() in a 256 box. Coloured from theme tokens in the app; the window icon
// is rasterised from the resolved token values.
import { mix, isHex } from './color.js';

let uid = 0;

/** Token references used in the live, in-app SVG (CSS variables). */
export const MASCOT_TOKENS = ['--bg', '--bg-top', '--accent-glow', '--accent', '--icon-silhouette', '--icon-stroke', '--icon-halo'];

/**
 * @param {object} c colours: bg, bgTop, glow, accent, accentDark, silhouette, stroke, halo (opacity)
 * @param {{background?: boolean, rounded?: boolean, box?: {x: number, y: number, size: number}}} [opts]
 *   box: place it at (x, y) with this size inside a larger SVG (Steam art) instead of a standalone element.
 */
export function mascotSvg(c, { background = false, rounded = false, box = null } = {}) {
  const id = `m${++uid}`;
  const bgRect = background
    ? `<rect width="256" height="256" rx="${rounded ? 56 : 0}" fill="url(#${id}b)"/>`
    : '';
  const head = box
    ? `<svg x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" viewBox="0 0 256 256" overflow="visible">`
    : '<svg class="mascot" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
  return `${head}
<defs>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c.bgTop}"/><stop offset="1" style="stop-color:${c.bg}"/></linearGradient>
<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c.glow}"/><stop offset="0.55" style="stop-color:${c.accent}"/><stop offset="1" style="stop-color:${c.accentDark}"/></linearGradient>
<radialGradient id="${id}h"><stop offset="0" style="stop-color:${c.accent};stop-opacity:${c.halo}"/><stop offset="1" style="stop-color:${c.accent};stop-opacity:0"/></radialGradient>
</defs>${bgRect}
<circle cx="128" cy="108" r="120" fill="url(#${id}h)"/>
<rect x="40" y="46" width="176" height="122" rx="18" fill="url(#${id}s)" style="stroke:${c.stroke};stroke-width:6"/>
<circle cx="128" cy="170" r="15" style="fill:${c.silhouette}"/>
<rect x="60" y="180" width="136" height="32" rx="12" style="fill:${c.silhouette}"/>
<rect x="44" y="194" width="28" height="36" rx="10" style="fill:${c.silhouette}"/>
<rect x="184" y="194" width="28" height="36" rx="10" style="fill:${c.silhouette}"/>
<rect x="62" y="206" width="132" height="22" rx="6" style="fill:${c.silhouette}"/>
</svg>`;
}

/** Live colours: CSS variables, so the mascot follows theme changes without re-rendering. */
export const LIVE = {
  bg: 'var(--bg)',
  bgTop: 'var(--bg-top)',
  glow: 'var(--accent-glow)',
  accent: 'var(--accent)',
  accentDark: 'color-mix(in srgb, var(--accent) 62%, black)',
  silhouette: 'var(--icon-silhouette)',
  stroke: 'var(--icon-stroke)',
  halo: 'var(--icon-halo)',
};

export function mascotEl(cls = '') {
  const span = document.createElement('span');
  span.className = `mascot-wrap ${cls}`.trim();
  span.innerHTML = mascotSvg(LIVE); // static markup built above, no user data
  return span;
}

/** Resolved colours from a token map (e.g. getComputedStyle values) for rasterising. */
export function resolvedColors(get) {
  const hex = (name, fallback) => { const v = String(get(name) || '').trim(); return isHex(v) ? v : fallback; };
  const accent = hex('--accent', '#ff8a66');
  const stroke = String(get('--icon-stroke') || '').trim();
  return {
    bg: hex('--bg', '#081719'),
    bgTop: hex('--bg-top', '#123236'),
    glow: hex('--accent-glow', '#ffd3a8'),
    accent,
    accentDark: mix(accent, '#000000', 0.38),
    silhouette: hex('--icon-silhouette', '#041012'),
    stroke: isHex(stroke) ? stroke : 'none',
    halo: Number.isFinite(parseFloat(get('--icon-halo'))) ? parseFloat(get('--icon-halo')) : 0.35,
  };
}

/** Renders the themed icon (rounded square, 256 px) to a PNG data URL. */
export async function iconDataUrl(size = 256) {
  const cs = getComputedStyle(document.documentElement);
  const svg = mascotSvg(resolvedColors((n) => cs.getPropertyValue(n)), { background: true, rounded: true });
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(img, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}
