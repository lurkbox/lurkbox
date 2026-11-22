// Applies the layout mode (shared/layout-mode.js) to the page as body classes:
//   layout-tv | layout-tablet | layout-phone, touch-ui (tablet or phone), orient-portrait | orient-landscape.
// Every touch rule in the CSS hangs off these classes, so the TV layout is exactly the couch UI.
// Re-checked on resize and rotation, when a controller connects or disconnects, and when Settings → Layout changes.
import { pickLayout, useSystemKeyboard } from '../shared/layout-mode.js';
import { state } from './state.js';

let current = 'tv';
const MODES = ['tv', 'tablet', 'phone'];

/** A coarse primary pointer: a touchscreen. Demo mode can pretend (LURKBOX_DEMO_TOUCH=1, for the screenshots). */
export function coarsePointer() {
  if (state.info && state.info.demo && state.info.demo.touch) return true;
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/** A game controller is connected (the Gamepad API lists pads once a button has been pressed). */
export function gamepadConnected() {
  try { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].some((g) => g && g.connected); } catch { return false; }
}

export function layoutMode() { return current; }
export function isTouchLayout() { return current !== 'tv'; }
export function isPhoneLayout() { return current === 'phone'; }

/** Text boxes use the system keyboard (no on-screen keyboard): a touch layout, a touchscreen, no controller. */
export function systemKeyboard() {
  return useSystemKeyboard({ layout: current, coarse: coarsePointer(), gamepad: gamepadConnected() });
}

/** Works out the layout and applies it; fires a 'layoutchange' event on window when it changed. */
export function applyLayout() {
  const next = pickLayout({
    override: state.settings && state.settings.layoutMode,
    touchHost: !!(state.info && state.info.touch),
    coarse: coarsePointer(),
    gamepad: gamepadConnected(),
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const b = document.body.classList;
  for (const m of MODES) b.toggle(`layout-${m}`, m === next);
  b.toggle('touch-ui', next !== 'tv');
  const portrait = window.innerHeight > window.innerWidth;
  b.toggle('orient-portrait', portrait);
  b.toggle('orient-landscape', !portrait);
  const changed = next !== current;
  current = next;
  if (changed) window.dispatchEvent(new CustomEvent('layoutchange', { detail: next }));
  return next;
}

export function installLayout() {
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(applyLayout, 60); };
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', later);
  window.addEventListener('gamepadconnected', applyLayout);
  window.addEventListener('gamepaddisconnected', applyLayout);
  try { window.matchMedia('(pointer: coarse)').addEventListener('change', applyLayout); } catch { /* old engine */ }
  return applyLayout();
}
