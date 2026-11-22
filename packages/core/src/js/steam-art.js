// "Match Steam library artwork to theme": rasterises the themed art and hands it to the main process.
// Runs only after a theme is committed (never during live preview), debounced.
import { state } from './state.js';
import { toast } from './ui.js';
import { resolvedColors } from './mascot.js';
import { isHex } from './color.js';
import { steamArtSvgs } from './steam-art-svg.js';

const DEBOUNCE_MS = 1500;
// Bump when steam-art-svg.js changes the artwork, so an unchanged theme still re-applies once.
const ART_VERSION = 2;
// Opaque, large assets go as JPEG (Steam accepts 'jpg'); the logo and icon need alpha.
const JPEG = new Set(['capsule', 'wide', 'hero']);
let lastKey = null;
let timer = null;
let running = false;
let again = false;
let wordmark = null;

async function loadWordmark() {
  if (!wordmark) {
    const r = await fetch('/vendor/wordmark.json');
    if (!r.ok) throw new Error(`wordmark ${r.status}`);
    wordmark = await r.json();
  }
  return wordmark;
}

async function rasterise({ svg, width, height }, jpeg = false) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  const blob = await canvas.convertToBlob(jpeg ? { type: 'image/jpeg', quality: 0.8 } : { type: 'image/png' });
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n);
  const fg = String(get('--fg')).trim();
  return { ...resolvedColors(get), fg: isHex(fg) ? fg : '#ffe3cc' };
}

/** Identifies the artwork: the theme colours plus ART_VERSION (SHA-256 hex). */
export async function steamArtKey(colors = themeColors()) {
  const text = JSON.stringify({ v: ART_VERSION, c: Object.keys(colors).sort().map((k) => [k, colors[k]]) });
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Themed data URLs for the current (applied) theme: JPEG capsule/wide/hero, PNG logo/icon, plus `key`. */
export async function renderSteamArt(colors = themeColors()) {
  const svgs = steamArtSvgs(colors, await loadWordmark());
  const out = {};
  for (const [name, s] of Object.entries(svgs)) out[name] = await rasterise(s, JPEG.has(name));
  out.key = await steamArtKey(colors);
  return out;
}

async function run() {
  if (running) { again = true; return; }
  if (!state.settings.steamArtSync || !window.lurkbox.steamArtApply) return;
  // A live preview is on screen (the picker was reopened): wait for it to settle.
  if (document.documentElement.dataset.theme !== (state.settings.theme || 'lurkbox')) { scheduleSteamArt(); return; }
  running = true;
  try {
    const colors = themeColors();
    const key = await steamArtKey(colors);
    if (key === lastKey) return; // same theme as the last apply in this session
    const r = await window.lurkbox.steamArtApply(await renderSteamArt(colors));
    if (r && r.ok) lastKey = key;
    if (r && r.ok && r.skipped) return; // unchanged since the last apply (main keeps the key across restarts)
    if (r && r.ok && r.deferred) toast('Steam library art updates in a minute', 3000, 'ok');
    else if (r && r.ok) toast(r.live ? 'Steam library art updated' : 'Library art will update the next time Steam restarts', 4000, 'ok');
    else toast(`Couldn't update the Steam library art: ${(r && r.error) || 'unknown error'}`, 5000, 'warn');
  } catch (e) {
    window.lurkbox.log(`[steam-art] render failed: ${e.message}`);
    toast("Couldn't update the Steam library art", 5000, 'warn');
  } finally {
    running = false;
    if (again) { again = false; scheduleSteamArt(); }
  }
}

/** Call after a theme is committed. No-op unless the setting is on. */
export function scheduleSteamArt() {
  clearTimeout(timer);
  timer = setTimeout(run, DEBOUNCE_MS);
}

export async function restoreSteamArt() {
  lastKey = null;
  if (!window.lurkbox.steamArtRestore) return;
  try {
    const r = await window.lurkbox.steamArtRestore();
    if (r && r.ok) toast(r.live ? 'Original Lurkbox art restored' : 'Original art restored; Steam shows it after it restarts', 4000, 'ok');
    else toast(`Couldn't restore the art: ${(r && r.error) || 'unknown error'}`, 5000, 'warn');
  } catch (e) {
    window.lurkbox.log(`[steam-art] restore failed: ${e.message}`);
    toast("Couldn't restore the art", 5000, 'warn');
  }
}
