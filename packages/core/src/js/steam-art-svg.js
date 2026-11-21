// Themed Steam library art as SVG strings (pure; rasterised by steam-art.js).
// Same geometry as assets/src/build-art.py; colours come from the theme tokens (resolvedColors in mascot.js)
// plus `fg` for the wordmark, the way the in-app mascot is coloured.
import { mascotSvg } from './mascot.js';
import { parseHex, luminance } from './color.js';

export const SIZES = Object.freeze({ capsule: [600, 900], wide: [920, 430], hero: [3840, 1240], icon: [256, 256] });

function wordH(wm, width) {
  const [xmin, ymin, xmax, ymax] = wm.bbox;
  return (ymax - ymin) * width / (xmax - xmin);
}

/** The wordmark outline with its bbox's left/top at (x, y), scaled to `width` (build-art.py word()). */
function word(wm, x, y, width, fill, extra = '') {
  const [xmin, ymin, xmax] = wm.bbox;
  const s = width / (xmax - xmin);
  return `<path d="${wm.d}" fill="${fill}" ${extra} transform="translate(${(x - xmin * s).toFixed(2)} ${(y - ymin * s).toFixed(2)}) scale(${s.toFixed(5)})"/>`;
}

function svg(w, h, c, body, { bg = true } = {}) {
  const defs = `<defs><linearGradient id="abg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.bgTop}"/><stop offset="1" stop-color="${c.bg}"/></linearGradient>
<radialGradient id="aspill" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${c.accent}" stop-opacity=".22"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>
<filter id="ashadow" x="-10%" y="-20%" width="120%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="${shadowFor(c.fg)}" flood-opacity=".55"/></filter></defs>`;
  const back = bg ? `<rect width="${w}" height="${h}" fill="url(#abg)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${back}${body}</svg>`;
}

/** Dark wordmark (light themes) gets a light glow; light wordmark a dark shadow. */
function shadowFor(fg) {
  const rgb = parseHex(fg);
  return rgb && luminance(rgb) < 0.2 ? '#ffffff' : '#000000';
}

const mascot = (c, x, y, size) => mascotSvg(c, { box: { x, y, size } });

export function capsuleSvg(c, wm) {
  const ww = 470;
  return svg(600, 900, c, mascot(c, 22, 70, 556) + word(wm, 65, 690, ww, c.fg));
}

export function wideSvg(c, wm) {
  const ww = 470;
  return svg(920, 430, c, mascot(c, 24, 40, 350) + word(wm, 398, 215 - wordH(wm, ww) / 2, ww, c.fg));
}

/** Scene only, no text (Steam overlays the logo). */
export function heroSvg(c) {
  const [w, h] = SIZES.hero;
  const floor = 1010;
  const S = c.silhouette;
  return svg(w, h, c, [
    `<rect y="${floor}" width="${w}" height="${h - floor}" fill="${S}" opacity=".55"/>`,
    `<ellipse cx="2510" cy="${floor + 40}" rx="1100" ry="180" fill="url(#aspill)"/>`,
    mascot(c, 1940, 30, 1140),
    `<rect x="1730" y="420" width="14" height="${floor - 420}" fill="${S}"/>`,
    `<path d="M1680 420 L1794 420 L1772 330 L1702 330 Z" fill="${S}"/>`,
    `<rect x="1690" y="${floor - 14}" width="94" height="14" rx="7" fill="${S}"/>`,
    `<path d="M3250 ${floor} L3230 ${floor - 120} L3330 ${floor - 120} L3310 ${floor} Z" fill="${S}"/>`,
    `<path d="M3280 ${floor - 120} C3200 ${floor - 300} 3150 ${floor - 360} 3170 ${floor - 420} C3240 ${floor - 360} 3270 ${floor - 260} 3280 ${floor - 120} Z" fill="${S}"/>`,
    `<path d="M3280 ${floor - 120} C3330 ${floor - 320} 3390 ${floor - 380} 3420 ${floor - 400} C3410 ${floor - 320} 3340 ${floor - 220} 3280 ${floor - 120} Z" fill="${S}"/>`,
    `<path d="M3280 ${floor - 120} C3270 ${floor - 330} 3285 ${floor - 450} 3300 ${floor - 500} C3320 ${floor - 420} 3300 ${floor - 260} 3280 ${floor - 120} Z" fill="${S}"/>`,
  ].join(''));
}

/** Wordmark only, transparent background. Returns { svg, width, height }. */
export function logoSvg(c, wm) {
  const ww = 1280;
  const pad = 40;
  const width = Math.trunc(ww + 2 * pad);
  const height = Math.trunc(wordH(wm, ww) + 2 * pad);
  return { svg: svg(width, height, c, `<g filter="url(#ashadow)">${word(wm, pad, pad, ww, c.fg)}</g>`, { bg: false }), width, height };
}

/** Rounded square with a transparent margin, like a desktop app icon (build-art.py icon_svg()). */
export function iconSvg(c) {
  return svg(256, 256, c, `<clipPath id="ar"><rect x="8" y="8" width="240" height="240" rx="54"/></clipPath>
<g clip-path="url(#ar)"><rect width="256" height="256" fill="url(#abg)"/>${mascot(c, 14, 18, 228)}</g>`, { bg: false });
}

/** All five assets: { name: { svg, width, height } }. */
export function steamArtSvgs(c, wm) {
  const logo = logoSvg(c, wm);
  return {
    capsule: { svg: capsuleSvg(c, wm), width: 600, height: 900 },
    wide: { svg: wideSvg(c, wm), width: 920, height: 430 },
    hero: { svg: heroSvg(c), width: 3840, height: 1240 },
    logo,
    icon: { svg: iconSvg(c), width: 256, height: 256 },
  };
}
