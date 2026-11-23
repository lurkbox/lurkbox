// Demo mode pictures, drawn as SVG from a seed: stream thumbnails and VOD thumbnails (small abstract scenes per
// category), avatars (little blob creatures), category box art, chat emotes and badges, and the 1600×900 scene the
// demo video pans across. All original artwork in the Lurkbox palette; nothing is downloaded. Pure strings, no DOM.
import { rng, hash, GAMES } from './data.js';

const PAL = { bg: '#081719', bgTop: '#123236', surface: '#173a3f', fg: '#ffe3cc', accent: '#ff8a66', glow: '#ffd3a8', ink: '#041012' };
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${s}% ${l}%)`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (w, h, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;
const f1 = (n) => Math.round(n * 10) / 10;

/** A smooth hill line across the width, closed to the bottom. */
function hills(w, h, r, { base, amp, waves, color, opacity = 1 }) {
  const pts = [];
  const ph = r() * Math.PI * 2;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const y = base + Math.sin(ph + (i / steps) * Math.PI * waves) * amp + Math.sin(ph * 2 + (i / steps) * Math.PI * waves * 2.3) * amp * 0.35;
    pts.push(`${f1(x)},${f1(y)}`);
  }
  return `<path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" fill="${color}" opacity="${opacity}"/>`;
}

/** Category motif drawn over the landscape (a few shapes each). */
function motif(kind, w, h, r, hue) {
  const u = Math.min(w, h) / 100;
  const out = [];
  const acc = hsl(hue + 25, 85, 68);
  switch (kind) {
    case 'space':
      for (let i = 0; i < 40; i++) out.push(`<circle cx="${f1(r() * w)}" cy="${f1(r() * h * 0.6)}" r="${f1(u * (0.2 + r() * 0.5))}" fill="#fff" opacity="${f1(0.4 + r() * 0.6)}"/>`);
      out.push(`<circle cx="${f1(w * 0.72)}" cy="${f1(h * 0.32)}" r="${f1(u * 16)}" fill="${acc}"/><ellipse cx="${f1(w * 0.72)}" cy="${f1(h * 0.32)}" rx="${f1(u * 28)}" ry="${f1(u * 5)}" fill="none" stroke="${PAL.glow}" stroke-width="${f1(u * 1.6)}" opacity="0.8"/>`);
      out.push(`<rect x="${f1(w * 0.2)}" y="${f1(h * 0.46)}" width="${f1(u * 26)}" height="${f1(u * 9)}" rx="${f1(u * 2)}" fill="${PAL.fg}"/><rect x="${f1(w * 0.2 - u * 7)}" y="${f1(h * 0.48)}" width="${f1(u * 8)}" height="${f1(u * 5)}" fill="${PAL.accent}"/>`);
      break;
    case 'ocean':
      for (let i = 0; i < 4; i++) out.push(hills(w, h, r, { base: h * (0.62 + i * 0.09), amp: u * 2.5, waves: 9, color: hsl(195 + i * 6, 60, 38 - i * 6) }));
      out.push(`<path d="M${f1(w * 0.42)},${f1(h * 0.6)} l${f1(u * 22)},0 l${f1(-u * 4)},${f1(u * 6)} l${f1(-u * 14)},0 Z" fill="#7a4b2a"/><path d="M${f1(w * 0.52)},${f1(h * 0.6)} l0,${f1(-u * 22)} l${f1(u * 12)},${f1(u * 18)} Z" fill="${PAL.fg}"/>`);
      break;
    case 'city':
      for (let i = 0; i < 14; i++) {
        const bw = u * (6 + r() * 8); const bh = h * (0.15 + r() * 0.35); const x = (i / 14) * w + r() * u * 3;
        out.push(`<rect x="${f1(x)}" y="${f1(h * 0.78 - bh)}" width="${f1(bw)}" height="${f1(bh + h * 0.22)}" fill="${hsl(hue + 190, 25, 14 + r() * 10)}"/>`);
        for (let k = 0; k < 4; k++) out.push(`<rect x="${f1(x + u * 1.5)}" y="${f1(h * 0.78 - bh + u * 3 + k * u * 5)}" width="${f1(u * 2)}" height="${f1(u * 2)}" fill="${PAL.glow}" opacity="${f1(r() > 0.4 ? 0.9 : 0.2)}"/>`);
      }
      break;
    case 'farm':
      for (let i = 0; i < 7; i++) out.push(`<path d="M0,${f1(h * (0.66 + i * 0.05))} Q${f1(w / 2)},${f1(h * (0.62 + i * 0.05))} ${w},${f1(h * (0.66 + i * 0.05))}" stroke="${hsl(95 + i * 4, 45, 30 + (i % 2) * 10)}" stroke-width="${f1(u * 3)}" fill="none"/>`);
      out.push(`<rect x="${f1(w * 0.64)}" y="${f1(h * 0.42)}" width="${f1(u * 22)}" height="${f1(u * 18)}" fill="#b5523b"/><path d="M${f1(w * 0.64 - u * 3)},${f1(h * 0.42)} l${f1(u * 14)},${f1(-u * 10)} l${f1(u * 14)},${f1(u * 10)} Z" fill="#7d2e22"/><rect x="${f1(w * 0.64 + u * 8)}" y="${f1(h * 0.42 + u * 8)}" width="${f1(u * 6)}" height="${f1(u * 10)}" fill="${PAL.fg}"/>`);
      break;
    case 'pixel': case 'speed':
      for (let i = 0; i < 6; i++) {
        const x = f1(r() * w * 0.9); const y = f1(h * (0.35 + r() * 0.35));
        out.push(`<rect x="${x}" y="${y}" width="${f1(u * (10 + r() * 14))}" height="${f1(u * 4)}" fill="${hsl(hue + 30, 55, 45)}" stroke="${PAL.ink}" stroke-width="${f1(u * 0.6)}"/>`);
        out.push(`<rect x="${f1(Number(x) + u * 3)}" y="${f1(Number(y) - u * 5)}" width="${f1(u * 3)}" height="${f1(u * 3)}" fill="${PAL.glow}"/>`);
      }
      out.push(`<rect x="${f1(w * 0.3)}" y="${f1(h * 0.5)}" width="${f1(u * 7)}" height="${f1(u * 9)}" fill="${PAL.accent}" stroke="${PAL.ink}" stroke-width="${f1(u * 0.8)}"/><rect x="${f1(w * 0.3 + u * 4)}" y="${f1(h * 0.5 + u * 2)}" width="${f1(u * 1.6)}" height="${f1(u * 1.6)}" fill="${PAL.ink}"/>`);
      if (kind === 'speed') out.push(`<rect x="${f1(w * 0.04)}" y="${f1(h * 0.06)}" width="${f1(u * 30)}" height="${f1(u * 9)}" rx="${f1(u * 1.5)}" fill="${PAL.ink}" opacity="0.7"/><text x="${f1(w * 0.04 + u * 3)}" y="${f1(h * 0.06 + u * 6.8)}" font-family="DejaVu Sans Mono, monospace" font-size="${f1(u * 6)}" font-weight="700" fill="#6dff9c">24:51.3</text>`);
      break;
    case 'music': case 'rhythm':
      for (let i = 0; i < 18; i++) { const bh = h * (0.1 + r() * 0.45); out.push(`<rect x="${f1(w * 0.1 + i * w * 0.045)}" y="${f1(h * 0.85 - bh)}" width="${f1(w * 0.03)}" height="${f1(bh)}" rx="${f1(u)}" fill="${hsl(hue + i * 8, 80, 62)}" opacity="0.9"/>`); }
      if (kind === 'rhythm') for (let i = 0; i < 4; i++) out.push(`<circle cx="${f1(w * (0.3 + i * 0.13))}" cy="${f1(h * (0.25 + r() * 0.2))}" r="${f1(u * 4)}" fill="${PAL.fg}" stroke="${PAL.ink}" stroke-width="${f1(u)}"/>`);
      break;
    case 'dungeon':
      for (let i = 0; i < 3; i++) out.push(`<path d="M${f1(w * (0.15 + i * 0.28))},${f1(h * 0.9)} v${f1(-h * 0.38)} a${f1(w * 0.09)},${f1(w * 0.09)} 0 0 1 ${f1(w * 0.18)},0 v${f1(h * 0.38)} Z" fill="${PAL.ink}" opacity="0.85"/>`);
      for (let i = 0; i < 4; i++) out.push(`<circle cx="${f1(w * (0.12 + i * 0.27))}" cy="${f1(h * 0.4)}" r="${f1(u * 3)}" fill="#ffb547"/><circle cx="${f1(w * (0.12 + i * 0.27))}" cy="${f1(h * 0.4)}" r="${f1(u * 9)}" fill="#ffb547" opacity="0.2"/>`);
      break;
    case 'chat':
      out.push(`<rect x="${f1(w * 0.18)}" y="${f1(h * 0.55)}" width="${f1(w * 0.5)}" height="${f1(h * 0.22)}" rx="${f1(u * 5)}" fill="${hsl(hue, 45, 42)}"/><rect x="${f1(w * 0.14)}" y="${f1(h * 0.5)}" width="${f1(w * 0.08)}" height="${f1(h * 0.3)}" rx="${f1(u * 4)}" fill="${hsl(hue, 45, 36)}"/><rect x="${f1(w * 0.64)}" y="${f1(h * 0.5)}" width="${f1(w * 0.08)}" height="${f1(h * 0.3)}" rx="${f1(u * 4)}" fill="${hsl(hue, 45, 36)}"/>`);
      out.push(`<rect x="${f1(w * 0.8)}" y="${f1(h * 0.3)}" width="${f1(u * 1.5)}" height="${f1(h * 0.5)}" fill="${PAL.ink}"/><path d="M${f1(w * 0.8 - u * 8)},${f1(h * 0.32)} h${f1(u * 17.5)} l${f1(-u * 4)},${f1(-u * 12)} h${f1(-u * 9.5)} Z" fill="${PAL.glow}"/><circle cx="${f1(w * 0.8)}" cy="${f1(h * 0.34)}" r="${f1(u * 16)}" fill="${PAL.glow}" opacity="0.18"/>`);
      break;
    case 'puzzle':
      for (let i = 0; i < 5; i++) for (let k = 0; k < 3; k++) if (r() > 0.25) out.push(`<rect x="${f1(w * 0.2 + i * u * 13)}" y="${f1(h * 0.3 + k * u * 13)}" width="${f1(u * 11)}" height="${f1(u * 11)}" rx="${f1(u * 2)}" fill="${hsl(hue + (i + k) * 40, 70, 60)}"/>`);
      break;
    case 'art':
      out.push(`<path d="M${f1(w * 0.42)},${f1(h * 0.9)} L${f1(w * 0.5)},${f1(h * 0.2)} L${f1(w * 0.58)},${f1(h * 0.9)}" stroke="#7a4b2a" stroke-width="${f1(u * 2)}" fill="none"/><rect x="${f1(w * 0.33)}" y="${f1(h * 0.25)}" width="${f1(w * 0.34)}" height="${f1(h * 0.38)}" fill="${PAL.fg}" stroke="#7a4b2a" stroke-width="${f1(u * 1.5)}"/>`);
      out.push(hills(w * 0.34, h * 0.63, r, { base: h * 0.5, amp: u * 3, waves: 3, color: hsl(hue + 180, 50, 45) }).replace('<path', `<path transform="translate(${f1(w * 0.33)},0)"`));
      out.push(`<circle cx="${f1(w * 0.58)}" cy="${f1(h * 0.34)}" r="${f1(u * 4)}" fill="${PAL.accent}"/>`);
      break;
    case 'race':
      out.push(`<path d="M${f1(w * 0.35)},${h} L${f1(w * 0.48)},${f1(h * 0.5)} L${f1(w * 0.52)},${f1(h * 0.5)} L${f1(w * 0.65)},${h} Z" fill="#2c3338"/>`);
      for (let i = 0; i < 5; i++) out.push(`<rect x="${f1(w * 0.497)}" y="${f1(h * (0.55 + i * 0.09))}" width="${f1(u * (0.8 + i * 0.5))}" height="${f1(u * (2 + i))}" fill="${PAL.fg}"/>`);
      out.push(`<rect x="${f1(w * 0.44)}" y="${f1(h * 0.74)}" width="${f1(u * 14)}" height="${f1(u * 7)}" rx="${f1(u * 2)}" fill="${PAL.accent}"/>`);
      break;
    case 'dice':
      for (let i = 0; i < 3; i++) {
        const x = w * (0.25 + i * 0.2); const y = h * (0.45 + (i % 2) * 0.08); const s = u * 16;
        out.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(s)}" height="${f1(s)}" rx="${f1(u * 3)}" fill="${PAL.fg}" transform="rotate(${(i - 1) * 14} ${f1(x + s / 2)} ${f1(y + s / 2)})"/>`);
        out.push(`<circle cx="${f1(x + s / 2)}" cy="${f1(y + s / 2)}" r="${f1(u * 1.8)}" fill="${PAL.ink}"/>`);
      }
      break;
    case 'monster':
      for (let i = 0; i < 3; i++) { const x = w * (0.25 + i * 0.25); const y = h * 0.68; out.push(`<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(u * 9)}" ry="${f1(u * 8)}" fill="${hsl(hue + i * 70, 60, 58)}"/><circle cx="${f1(x - u * 3)}" cy="${f1(y - u * 2)}" r="${f1(u * 1.5)}" fill="${PAL.ink}"/><circle cx="${f1(x + u * 3)}" cy="${f1(y - u * 2)}" r="${f1(u * 1.5)}" fill="${PAL.ink}"/>`); }
      break;
    case 'tech':
      for (let i = 0; i < 10; i++) { const y = h * (0.2 + r() * 0.6); const x = w * r() * 0.5; out.push(`<path d="M${f1(x)},${f1(y)} h${f1(w * 0.2)} l${f1(u * 6)},${f1(-u * 6)} h${f1(w * 0.15)}" stroke="#6dffcf" stroke-width="${f1(u * 0.8)}" fill="none" opacity="0.7"/><circle cx="${f1(x + w * 0.35 + u * 6)}" cy="${f1(y - u * 6)}" r="${f1(u * 1.5)}" fill="#6dffcf"/>`); }
      break;
    default: break;
  }
  return out.join('');
}

/** A small landscape for a category: sky, sun or moon, three hill layers, the category motif. */
export function sceneBody(w, h, { seed = 1, kind = 'farm', hue = 20, night = false } = {}) {
  const r = rng(seed);
  const sky1 = night ? hsl(hue + 200, 45, 10) : hsl(hue + 190, 45, 22);
  const sky2 = night ? hsl(hue + 230, 40, 22) : hsl(hue + 10, 70, 62);
  const id = `s${seed % 100000}`;
  const defs = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky1}"/><stop offset="1" stop-color="${sky2}"/></linearGradient>`;
  const sunX = w * (0.15 + r() * 0.7);
  const body = [
    `<rect width="${w}" height="${h}" fill="url(#${id})"/>`,
    `<circle cx="${f1(sunX)}" cy="${f1(h * 0.3)}" r="${f1(Math.min(w, h) * 0.11)}" fill="${night ? PAL.fg : PAL.glow}" opacity="0.9"/>`,
    hills(w, h, r, { base: h * 0.62, amp: h * 0.06, waves: 3, color: hsl(hue + 170, 30, 28), opacity: 0.8 }),
    hills(w, h, r, { base: h * 0.72, amp: h * 0.05, waves: 4, color: hsl(hue + 175, 35, 18) }),
    motif(kind, w, h, r, hue),
    hills(w, h, r, { base: h * 0.9, amp: h * 0.03, waves: 5, color: PAL.ink, opacity: 0.9 }),
  ].join('');
  return { defs, body };
}

const gameByName = new Map(GAMES.map((g) => [g.name, g]));

/** Stream or VOD thumbnail for a channel (the category picks the motif). */
export function thumbSvg(w, h, { key, game, night = false }) {
  const g = (game && gameByName.get(game)) || GAMES[hash(key) % GAMES.length];
  const { defs, body } = sceneBody(w, h, { seed: hash(key), kind: g.art, hue: g.hue + (hash(key) % 40), night });
  return svg(w, h, body, defs);
}

/** A round blob creature avatar. */
export function avatarSvg(login, size = 300) {
  const r = rng(hash(login));
  const hue = Math.floor(r() * 360);
  const s = size;
  const shape = Math.floor(r() * 3);
  const body = shape === 0
    ? `<circle cx="${s / 2}" cy="${s * 0.58}" r="${s * 0.3}" fill="${hsl(hue, 70, 62)}"/>`
    : shape === 1
      ? `<rect x="${s * 0.2}" y="${s * 0.3}" width="${s * 0.6}" height="${s * 0.56}" rx="${s * 0.18}" fill="${hsl(hue, 65, 60)}"/>`
      : `<path d="M${s * 0.5},${s * 0.22} C${s * 0.9},${s * 0.3} ${s * 0.92},${s * 0.86} ${s * 0.5},${s * 0.86} C${s * 0.08},${s * 0.86} ${s * 0.1},${s * 0.3} ${s * 0.5},${s * 0.22} Z" fill="${hsl(hue, 68, 64)}"/>`;
  const ears = r() > 0.5
    ? `<circle cx="${s * 0.3}" cy="${s * 0.33}" r="${s * 0.08}" fill="${hsl(hue, 60, 50)}"/><circle cx="${s * 0.7}" cy="${s * 0.33}" r="${s * 0.08}" fill="${hsl(hue, 60, 50)}"/>`
    : `<path d="M${s * 0.5},${s * 0.27} q${s * 0.04},${-s * 0.14} ${s * 0.12},${-s * 0.12}" stroke="${hsl(hue, 60, 45)}" stroke-width="${s * 0.03}" fill="none" stroke-linecap="round"/>`;
  const eyeY = s * 0.55;
  const blink = r() > 0.75;
  const eyes = blink
    ? `<path d="M${s * 0.36},${eyeY} q${s * 0.05},${s * 0.04} ${s * 0.1},0 M${s * 0.54},${eyeY} q${s * 0.05},${s * 0.04} ${s * 0.1},0" stroke="${PAL.ink}" stroke-width="${s * 0.025}" fill="none" stroke-linecap="round"/>`
    : `<circle cx="${s * 0.41}" cy="${eyeY}" r="${s * 0.045}" fill="${PAL.ink}"/><circle cx="${s * 0.59}" cy="${eyeY}" r="${s * 0.045}" fill="${PAL.ink}"/><circle cx="${s * 0.425}" cy="${eyeY - s * 0.015}" r="${s * 0.014}" fill="#fff"/><circle cx="${s * 0.605}" cy="${eyeY - s * 0.015}" r="${s * 0.014}" fill="#fff"/>`;
  const mouth = `<path d="M${s * 0.45},${s * 0.66} q${s * 0.05},${s * 0.05} ${s * 0.1},0" stroke="${PAL.ink}" stroke-width="${s * 0.022}" fill="none" stroke-linecap="round"/>`;
  const cheeks = `<circle cx="${s * 0.33}" cy="${s * 0.64}" r="${s * 0.035}" fill="${PAL.accent}" opacity="0.55"/><circle cx="${s * 0.67}" cy="${s * 0.64}" r="${s * 0.035}" fill="${PAL.accent}" opacity="0.55"/>`;
  const bg = `<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(hue + 160, 40, 26)}"/><stop offset="1" stop-color="${hsl(hue + 190, 45, 14)}"/></linearGradient>`;
  return svg(s, s, `<rect width="${s}" height="${s}" fill="url(#a)"/>${ears}${body}${eyes}${cheeks}${mouth}`, bg);
}

/** Portrait box art for a category: its scene plus the name. */
export function boxArtSvg(gameId, w = 285, h = 380) {
  const g = GAMES.find((x) => x.id === String(gameId)) || GAMES[0];
  const { defs, body } = sceneBody(w, h, { seed: hash(g.name), kind: g.art, hue: g.hue });
  const fs = Math.round(w * 0.1);
  const words = g.name.split(' ');
  const lines = words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [g.name];
  const text = lines.map((l, i) => `<text x="${w / 2}" y="${f1(h * 0.16 + i * fs * 1.1)}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${fs}" fill="${PAL.fg}" stroke="${PAL.ink}" stroke-width="${f1(fs * 0.12)}" paint-order="stroke">${esc(l)}</text>`).join('');
  return svg(w, h, body + text, defs);
}

// ---- emotes (112×112) ----

const face = (fill, extra = '') => `<circle cx="56" cy="60" r="44" fill="${fill}" stroke="${PAL.ink}" stroke-width="5"/>${extra}`;
const dotEyes = '<circle cx="40" cy="54" r="6" fill="#041012"/><circle cx="72" cy="54" r="6" fill="#041012"/>';
const happyEyes = '<path d="M32 56 q8 -10 16 0 M64 56 q8 -10 16 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>';
const smile = '<path d="M40 74 q16 14 32 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>';
const EMOTE_ART = {
  lurkWave: () => face('#ffd3a8', `${dotEyes}${smile}<path d="M92 30 l8 -16 M100 40 l12 -8 M96 22 l2 -14" stroke="#ff8a66" stroke-width="5" stroke-linecap="round"/><ellipse cx="94" cy="50" rx="10" ry="13" fill="#ffd3a8" stroke="#041012" stroke-width="5"/>`),
  lurkCozy: () => face('#ffb38f', `${happyEyes}${smile}<circle cx="30" cy="70" r="7" fill="#ff6f61" opacity="0.6"/><circle cx="82" cy="70" r="7" fill="#ff6f61" opacity="0.6"/><path d="M14 92 q42 -18 84 0 v16 h-84 Z" fill="#3a8f9c" stroke="#041012" stroke-width="5"/>`),
  boxHype: () => `<rect x="10" y="18" width="92" height="70" rx="12" fill="#ff8a66" stroke="#041012" stroke-width="5"/><circle cx="40" cy="48" r="8" fill="#041012"/><circle cx="72" cy="48" r="8" fill="#041012"/><ellipse cx="56" cy="70" rx="14" ry="10" fill="#041012"/><path d="M8 8 l10 10 M104 8 l-10 10 M56 2 v12" stroke="#ffd3a8" stroke-width="6" stroke-linecap="round"/><rect x="34" y="88" width="44" height="16" rx="5" fill="#041012"/>`,
  peekbox: () => `<rect x="12" y="20" width="88" height="64" rx="12" fill="#3fb5c4" stroke="#041012" stroke-width="5"/><path d="M18 100 h76" stroke="#041012" stroke-width="8" stroke-linecap="round"/><circle cx="42" cy="104" r="14" fill="#041012"/><circle cx="66" cy="104" r="14" fill="#041012"/><circle cx="44" cy="99" r="4" fill="#fff"/><circle cx="68" cy="99" r="4" fill="#fff"/>`,
  partyHat: () => '<path d="M56 0 L80 46 L32 46 Z" fill="#ff5fa2" stroke="#041012" stroke-width="4"/><circle cx="56" cy="2" r="6" fill="#ffd34d"/><path d="M40 30 h32 M46 18 h20" stroke="#ffd34d" stroke-width="4"/>',
  teaSip: () => `<path d="M24 46 h56 v30 a22 22 0 0 1 -22 22 h-12 a22 22 0 0 1 -22 -22 Z" fill="#ffe3cc" stroke="#041012" stroke-width="5"/><path d="M80 54 a12 12 0 0 1 0 24" stroke="#041012" stroke-width="5" fill="none"/><path d="M40 36 q-6 -10 0 -20 M56 36 q-6 -10 0 -20" stroke="#c4b2a2" stroke-width="4" fill="none" stroke-linecap="round"/>${happyEyes.replace(/56/g, '70').replace(/M32/g, 'M34').replace(/M64/g, 'M58')}`,
  wowie: () => face('#ffe066', `<circle cx="38" cy="52" r="10" fill="#fff" stroke="#041012" stroke-width="4"/><circle cx="74" cy="52" r="10" fill="#fff" stroke="#041012" stroke-width="4"/><circle cx="38" cy="52" r="4" fill="#041012"/><circle cx="74" cy="52" r="4" fill="#041012"/><ellipse cx="56" cy="80" rx="10" ry="13" fill="#041012"/>`),
  hehe: () => face('#9be37a', `${happyEyes}<path d="M34 70 q22 28 44 0 Z" fill="#041012"/><path d="M92 24 l6 -8 M100 34 l8 -4" stroke="#ff8a66" stroke-width="5" stroke-linecap="round"/>`),
  gigaGG: () => `<path d="M30 14 h52 v26 a26 26 0 0 1 -52 0 Z" fill="#ffd34d" stroke="#041012" stroke-width="5"/><path d="M30 22 h-14 a14 14 0 0 0 14 22 M82 22 h14 a14 14 0 0 1 -14 22" stroke="#041012" stroke-width="5" fill="none"/><rect x="48" y="66" width="16" height="16" fill="#ffd34d" stroke="#041012" stroke-width="5"/><rect x="30" y="82" width="52" height="18" rx="4" fill="#ff8a66" stroke="#041012" stroke-width="5"/>`,
  heartbeat: () => '<path d="M56 100 C10 70 6 42 22 28 C36 16 50 22 56 34 C62 22 76 16 90 28 C106 42 102 70 56 100 Z" fill="#ff5f6d" stroke="#041012" stroke-width="5"/><path d="M20 58 h18 l8 -12 l10 24 l8 -12 h26" stroke="#ffe3cc" stroke-width="5" fill="none" stroke-linejoin="round"/>',
  rainyday: () => '<path d="M28 60 a18 18 0 0 1 6 -34 a24 24 0 0 1 44 4 a16 16 0 0 1 6 30 Z" fill="#c9d6df" stroke="#041012" stroke-width="5"/><path d="M38 72 l-6 14 M58 72 l-6 14 M78 72 l-6 14" stroke="#3fa9f5" stroke-width="6" stroke-linecap="round"/><path d="M42 46 q4 4 8 0 M62 46 q4 4 8 0" stroke="#041012" stroke-width="4" fill="none"/>',
  // The demo account's own "Twitch" emotes (the emote picker's Twitch tab): a little TV with feet, like the runner.
  lurkerHi: () => `<rect x="14" y="18" width="84" height="62" rx="12" fill="#3fb5c4" stroke="#041012" stroke-width="5"/><rect x="25" y="29" width="62" height="40" rx="6" fill="#ffe3cc"/>${dotEyes.replace(/cy="54"/g, 'cy="46"')}<path d="M44 58 q12 9 24 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/><rect x="30" y="82" width="14" height="22" rx="5" fill="#041012"/><rect x="68" y="82" width="14" height="22" rx="5" fill="#041012"/><path d="M100 22 l8 -10 M104 34 l8 -2" stroke="#ff8a66" stroke-width="5" stroke-linecap="round"/>`,
  lurkerLove: () => `<rect x="14" y="18" width="84" height="62" rx="12" fill="#e44fa8" stroke="#041012" stroke-width="5"/><rect x="25" y="29" width="62" height="40" rx="6" fill="#ffe3cc"/><path d="M56 64 C40 54 38 44 44 39 C49 35 54 37 56 42 C58 37 63 35 68 39 C74 44 72 54 56 64 Z" fill="#ff5f6d" stroke="#041012" stroke-width="4"/><rect x="30" y="82" width="14" height="22" rx="5" fill="#041012"/><rect x="68" y="82" width="14" height="22" rx="5" fill="#041012"/>`,
  lurkerGG: () => `<rect x="14" y="18" width="84" height="62" rx="12" fill="#ffb547" stroke="#041012" stroke-width="5"/><rect x="25" y="29" width="62" height="40" rx="6" fill="#ffe3cc"/><text x="56" y="62" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="900" font-size="28" fill="#041012">GG</text><rect x="30" y="82" width="14" height="22" rx="5" fill="#041012"/><rect x="68" y="82" width="14" height="22" rx="5" fill="#041012"/>`,
  lurkerZzz: () => `<rect x="14" y="18" width="84" height="62" rx="12" fill="#6a5acd" stroke="#041012" stroke-width="5"/><rect x="25" y="29" width="62" height="40" rx="6" fill="#c9d6df"/><path d="M36 50 q8 6 16 0 M60 50 q8 6 16 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M86 6 h14 l-14 14 h14" stroke="#ffe3cc" stroke-width="4" fill="none" stroke-linejoin="round"/><rect x="30" y="82" width="14" height="22" rx="5" fill="#041012"/><rect x="68" y="82" width="14" height="22" rx="5" fill="#041012"/>`,
  clapclap: () => '<path d="M30 92 L22 44 a6 6 0 0 1 12 -2 L40 70 L38 28 a6 6 0 0 1 12 0 L52 68 L56 30 a6 6 0 0 1 12 1 L66 74 L76 52 a6 6 0 0 1 11 5 L74 96 Z" fill="#ffd3a8" stroke="#041012" stroke-width="5" stroke-linejoin="round"/><path d="M14 30 l8 6 M10 50 h10 M92 24 l-6 8" stroke="#ff8a66" stroke-width="5" stroke-linecap="round"/>',
};
// The Emotes tab's extra faces: a colour, eyes and a mouth each.
const wideEyes = '<circle cx="40" cy="52" r="9" fill="#fff" stroke="#041012" stroke-width="4"/><circle cx="72" cy="52" r="9" fill="#fff" stroke="#041012" stroke-width="4"/><circle cx="40" cy="53" r="4" fill="#041012"/><circle cx="72" cy="53" r="4" fill="#041012"/>';
const sleepyEyes = '<path d="M32 54 q8 6 16 0 M64 54 q8 6 16 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>';
const smugEyes = '<path d="M32 52 h16 M64 52 h16" stroke="#041012" stroke-width="5" stroke-linecap="round"/><circle cx="44" cy="56" r="3" fill="#041012"/><circle cx="76" cy="56" r="3" fill="#041012"/>';
const winkEyes = '<circle cx="40" cy="54" r="6" fill="#041012"/><path d="M64 56 q8 -10 16 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>';
const MOUTHS = {
  smile,
  open: '<ellipse cx="56" cy="80" rx="9" ry="11" fill="#041012"/>',
  flat: '<path d="M42 78 h28" stroke="#041012" stroke-width="5" stroke-linecap="round"/>',
  smirk: '<path d="M44 78 q14 6 26 -4" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>',
  blep: `${smile}<path d="M50 80 v8 a6 6 0 0 0 12 0 v-8 Z" fill="#ff6f8a" stroke="#041012" stroke-width="3"/>`,
  laugh: '<path d="M34 70 q22 30 44 0 Z" fill="#041012"/><path d="M40 72 q16 10 32 0" stroke="#ff6f8a" stroke-width="4" fill="none"/>',
  wobble: '<path d="M40 80 q5 -6 10 0 t10 0 t10 0" stroke="#041012" stroke-width="5" fill="none" stroke-linecap="round"/>',
};
const FACES = {
  blobNod: ['#8fd3ff', dotEyes, 'smile', '<path d="M20 22 l6 8 M92 22 l-6 8" stroke="#ffe3cc" stroke-width="5" stroke-linecap="round"/>'],
  blobSleepy: ['#b9a8ff', sleepyEyes, 'flat', '<path d="M86 10 h14 l-14 14 h14" stroke="#ffe3cc" stroke-width="4" fill="none" stroke-linejoin="round"/>'],
  blobShock: ['#8fd3ff', wideEyes, 'open', ''],
  blobSmug: ['#8fd3ff', smugEyes, 'smirk', ''],
  blobBlep: ['#8fd3ff', happyEyes, 'blep', ''],
  blobHmm: ['#8fd3ff', smugEyes, 'wobble', '<circle cx="94" cy="88" r="9" fill="#ffd3a8" stroke="#041012" stroke-width="4"/>'],
  mintJoy: ['#7fe0b8', happyEyes, 'laugh', ''],
  mintMeh: ['#7fe0b8', dotEyes, 'flat', ''],
  plumYay: ['#e48bd6', happyEyes, 'open', '<path d="M14 30 l10 6 M98 30 l-10 6" stroke="#ffd34d" stroke-width="5" stroke-linecap="round"/>'],
  plumOof: ['#e48bd6', sleepyEyes, 'wobble', ''],
  skyGrin: ['#ffd34d', dotEyes, 'laugh', ''],
  skyWink: ['#ffd34d', winkEyes, 'smirk', ''],
  sunnyLaugh: ['#ffb547', happyEyes, 'laugh', '<circle cx="28" cy="72" r="7" fill="#ff6f61" opacity="0.6"/><circle cx="84" cy="72" r="7" fill="#ff6f61" opacity="0.6"/>'],
};
for (const [name, [fill, eyes, mouth, extra]] of Object.entries(FACES)) EMOTE_ART[name] = () => face(fill, `${eyes}${MOUTHS[mouth]}${extra}`);
// A zero-width overlay: sparkles around whatever emote it sits on.
EMOTE_ART.sparkles = () => '<path d="M18 14 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 Z M92 62 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 Z M88 8 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2 Z" fill="#ffd34d" stroke="#041012" stroke-width="2.5" stroke-linejoin="round"/>';

export const EMOTE_NAMES = Object.keys(EMOTE_ART);

export function emoteSvg(name) {
  const f = EMOTE_ART[name];
  return f ? svg(112, 112, f()) : null;
}

// ---- badges (72×72) ----

const BADGE_ART = {
  broadcaster: '<rect x="4" y="4" width="64" height="64" rx="12" fill="#e0504a"/><rect x="14" y="22" width="34" height="28" rx="5" fill="#fff"/><path d="M48 32 l12 -8 v24 l-12 -8 Z" fill="#fff"/>',
  moderator: '<rect x="4" y="4" width="64" height="64" rx="12" fill="#2fa36b"/><path d="M36 12 l20 8 v14 c0 14 -10 22 -20 26 c-10 -4 -20 -12 -20 -26 v-14 Z" fill="#fff"/><path d="M28 36 l6 6 l12 -12" stroke="#2fa36b" stroke-width="5" fill="none"/>',
  vip: '<rect x="4" y="4" width="64" height="64" rx="12" fill="#e44fa8"/><path d="M36 14 l18 18 l-18 26 l-18 -26 Z" fill="#fff"/><path d="M18 32 h36" stroke="#e44fa8" stroke-width="3"/>',
  subscriber: (v) => `<rect x="4" y="4" width="64" height="64" rx="12" fill="${{ 0: '#ff8a66', 6: '#3fb5c4', 12: '#ffb547' }[v] || '#ff8a66'}"/><path d="M36 12 l7 15 l16 2 l-12 11 l3 16 l-14 -8 l-14 8 l3 -16 l-12 -11 l16 -2 Z" fill="#fff"/>`,
  bits: '<rect x="4" y="4" width="64" height="64" rx="12" fill="#173a3f"/><path d="M36 10 l18 26 l-18 26 l-18 -26 Z" fill="#9be3ff"/><path d="M36 10 l18 26 h-36 Z" fill="#d8f4ff"/>',
  artist: '<rect x="4" y="4" width="64" height="64" rx="12" fill="#6a5acd"/><path d="M36 14 c14 0 24 10 24 20 c0 8 -8 8 -12 8 c-6 0 -6 6 -2 10 c3 4 0 6 -6 6 c-16 0 -28 -10 -28 -22 c0 -12 10 -22 24 -22 Z" fill="#fff"/><circle cx="26" cy="32" r="4" fill="#ff8a66"/><circle cx="36" cy="24" r="4" fill="#3fb5c4"/><circle cx="47" cy="28" r="4" fill="#ffd34d"/>',
};

export function badgeSvg(set, version) {
  const a = BADGE_ART[set];
  if (!a) return null;
  return svg(72, 72, typeof a === 'function' ? a(version) : a);
}

/** The scene the demo video pans across: a wide dusk landscape with floating platforms and the Lurkbox colours. */
export function videoSceneSvg(w = 1600, h = 900) {
  const r = rng(77);
  const defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAL.bgTop}"/><stop offset="0.55" stop-color="#2d5a5e"/><stop offset="1" stop-color="${PAL.accent}"/></linearGradient>
<radialGradient id="sun"><stop offset="0" stop-color="${PAL.glow}"/><stop offset="0.5" stop-color="${PAL.glow}" stop-opacity="0.5"/><stop offset="1" stop-color="${PAL.glow}" stop-opacity="0"/></radialGradient>`;
  const parts = [`<rect width="${w}" height="${h}" fill="url(#sky)"/>`, `<circle cx="${w * 0.62}" cy="${h * 0.52}" r="${h * 0.32}" fill="url(#sun)"/>`, `<circle cx="${w * 0.62}" cy="${h * 0.52}" r="${h * 0.1}" fill="${PAL.fg}"/>`];
  for (let i = 0; i < 60; i++) parts.push(`<circle cx="${f1(r() * w)}" cy="${f1(r() * h * 0.35)}" r="${f1(1 + r() * 2)}" fill="#fff" opacity="${f1(0.3 + r() * 0.6)}"/>`);
  parts.push(hills(w, h, r, { base: h * 0.62, amp: h * 0.05, waves: 5, color: '#1d4146', opacity: 0.9 }));
  parts.push(hills(w, h, r, { base: h * 0.72, amp: h * 0.05, waves: 7, color: '#123236' }));
  for (let i = 0; i < 9; i++) {
    const x = w * (0.05 + i * 0.11) + r() * 40; const y = h * (0.42 + r() * 0.25); const pw = 90 + r() * 90;
    parts.push(`<rect x="${f1(x)}" y="${f1(y)}" width="${f1(pw)}" height="22" rx="6" fill="#3b7a6e" stroke="${PAL.ink}" stroke-width="4"/><rect x="${f1(x)}" y="${f1(y)}" width="${f1(pw)}" height="8" rx="4" fill="#7fd18b"/>`);
    if (r() > 0.4) parts.push(`<circle cx="${f1(x + pw / 2)}" cy="${f1(y - 30)}" r="11" fill="#ffd34d" stroke="${PAL.ink}" stroke-width="3"/>`);
  }
  parts.push(hills(w, h, r, { base: h * 0.88, amp: h * 0.025, waves: 9, color: PAL.ink }));
  return svg(w, h, parts.join(''), defs);
}

/** The demo's little runner (a TV with feet) overlaid on the video, 120×120. */
export function runnerSvg() {
  return svg(120, 120, `<rect x="14" y="16" width="92" height="66" rx="12" fill="${PAL.accent}" stroke="${PAL.ink}" stroke-width="6"/><rect x="26" y="28" width="68" height="42" rx="6" fill="${PAL.glow}"/><circle cx="48" cy="48" r="6" fill="${PAL.ink}"/><circle cx="72" cy="48" r="6" fill="${PAL.ink}"/><rect x="30" y="84" width="16" height="26" rx="6" fill="${PAL.ink}"/><rect x="74" y="84" width="16" height="26" rx="6" fill="${PAL.ink}"/>`);
}

/**
 * Renders a demo media path ("img/thumb/<login>-440x248.svg", "img/avatar/<login>.svg", "img/boxart/<id>-WxH.svg",
 * "img/vod/<login>~<n>-WxH.svg", "img/emote/<name>.svg", "img/badge/<set>-<v>.svg"). Returns the SVG text or null.
 * gameOf(login) → category name, for the thumbnail motif.
 */
export function demoImage(path, { gameOf = () => null } = {}) {
  const p = String(path).replace(/^\/+/, '').split('?')[0];
  let m;
  const size = (w, h, dw, dh) => [Math.min(1920, Number(w) || dw), Math.min(1080, Number(h) || dh)];
  if ((m = /^img\/thumb\/([a-z0-9_]+)-(\d+)x(\d+)\.svg$/.exec(p))) { const [w, h] = size(m[2], m[3], 440, 248); return thumbSvg(w, h, { key: m[1], game: gameOf(m[1]) }); }
  if ((m = /^img\/vod\/([a-z0-9_]+)~(\d+)-(\d+)x(\d+)\.svg$/.exec(p))) { const [w, h] = size(m[3], m[4], 440, 248); return thumbSvg(w, h, { key: `${m[1]}~${m[2]}`, game: gameOf(m[1]), night: Number(m[2]) % 2 === 1 }); }
  if ((m = /^img\/avatar\/([a-z0-9_]+)\.svg$/.exec(p))) return avatarSvg(m[1]);
  if ((m = /^img\/boxart\/(\d+)-(\d+)x(\d+)\.svg$/.exec(p))) { const [w, h] = size(m[2], m[3], 285, 380); return boxArtSvg(m[1], w, h); }
  if ((m = /^img\/emote\/([A-Za-z0-9]+)\.svg$/.exec(p))) return emoteSvg(m[1]);
  if ((m = /^img\/badge\/([a-z]+)-(\d+)\.svg$/.exec(p))) return badgeSvg(m[1], m[2]);
  return null;
}
