// Navigation sounds: short, soft UI blips synthesized with the Web Audio API (no sound files, nothing copied from other
// apps). They play for controller and keyboard navigation only:
//   move    focus moved to another item          select  A / Enter on an item
//   back    B / Escape                           bump    a direction with nowhere to go
// Settings: navSounds (on/off) and navSoundVolume (0-100). No sounds while Lurkbox is unfocused (e.g. floated over a
// game), and none while the player is showing only the video, where directions seek or switch instead of navigating.
import { state } from './state.js';

const MOVE_WINDOW_MS = 160;   // a focus change this soon after a direction press counts as navigation
const BUMP_CHECK_MS = 110;

let ctx = null;
let windowFocused = true;
let logged = false;
let lastDir = { at: 0, from: null };

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function soundsEnabled(s = state.settings || {}) {
  return s.navSounds !== false && (Number(s.navSoundVolume ?? 30) > 0);
}

/**
 * Peak gain for the setting. Linear, so "Subtle" (30) is still clearly audible on a TV: about -24 dBFS, well under the
 * stream's audio. (An earlier squared curve put Subtle at about -44 dBFS, which was inaudible.)
 */
export function gainFor(volume) {
  const v = Math.min(100, Math.max(0, Number(volume ?? 30))) / 100;
  return 0.2 * v;
}

/** Tone recipes: [startHz, endHz, durationMs, wave, gainScale]. Exported for tests. */
export const TONES = {
  // Quiet and subtle, in the spirit of Steam's Game Mode UI: soft sine ticks, low-passed, very short.
  move: [[880, 820, 18, 'sine', 0.55]],
  select: [[700, 700, 26, 'sine', 0.7], [1040, 1040, 40, 'sine', 0.55, 28]],
  back: [[620, 470, 45, 'sine', 0.6]],
  bump: [[170, 150, 40, 'sine', 0.8]],
};

export function play(name) {
  if (!windowFocused || !soundsEnabled()) return;
  const a = audio();
  if (!a) return;
  const base = gainFor((state.settings || {}).navSoundVolume);
  if (!logged) {
    logged = true;
    try { window.lurkbox && window.lurkbox.log && window.lurkbox.log(`[sounds] first sound "${name}": audio ${a.state}, gain ${base.toFixed(3)}`); } catch { /* ignore */ }
  }
  const t0 = a.currentTime + 0.005;
  for (const [f0, f1, ms, wave, scale, delayMs = 0] of TONES[name] || []) {
    const osc = a.createOscillator();
    const g = a.createGain();
    const start = t0 + delayMs / 1000;
    const end = start + ms / 1000;
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), end);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(base * scale, start + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    osc.connect(lp).connect(g).connect(a.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/** True while the player shows only the video (directions seek or switch channels there, they don't navigate). */
function videoOnly() {
  if (!document.body.classList.contains('player-active')) return false;
  const f = document.activeElement;
  return !(f && f !== document.body && f.closest && f.closest('#player-overlay, .popover, .modal, #modal-root'));
}

const DIRS = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT']);

/**
 * Called by the input layer for every controller/keyboard action, before it is dispatched.
 * Mouse and touch never call this.
 */
export function onAction(action) {
  if (DIRS.has(action)) {
    if (videoOnly()) return;
    const from = document.activeElement;
    lastDir = { at: performance.now(), from };
    setTimeout(() => {
      // Nothing took focus: there was nowhere to go in that direction.
      if (document.activeElement === from && performance.now() - lastDir.at >= BUMP_CHECK_MS - 5) play('bump');
    }, BUMP_CHECK_MS);
    return;
  }
  if (action === 'A') { if (!videoOnly() || document.querySelector('.modal')) play('select'); return; }
  if (action === 'B') play('back');
}

export function installSounds({ onWindowFocus } = {}) {
  document.addEventListener('focusin', (e) => {
    if (performance.now() - lastDir.at > MOVE_WINDOW_MS) return; // programmatic focus (refresh, restore), not navigation
    if (e.target === lastDir.from) return;
    lastDir.from = e.target; // one tick per press
    play('move');
  }, true);
  if (onWindowFocus) onWindowFocus((f) => { windowFocused = !!f; });
}
