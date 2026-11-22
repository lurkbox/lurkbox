// Layout modes: TV (the couch layout: rail, focus ring, controller hints), tablet (the rail, touch-sized targets) and
// phone (a bottom tab bar and a top app bar). Pure; js/layout.js applies the result as body classes.
//
// Auto picks a touch layout only when all of these hold:
//  - the host can show one (AppInfo.touch: Android; the desktop never sets it, so Auto is always TV there),
//  - the primary pointer is coarse (a touchscreen; TVs and desktops report fine or none),
//  - no game controller is connected (a phone with a pad gets the controller layout).
// Then the window decides: narrower than 700 px, or shorter than 500 px on its short side (a phone held sideways),
// is a phone; anything else is a tablet.

export const LAYOUT_MODES = ['auto', 'tv', 'tablet', 'phone'];
export const LAYOUT_LABELS = { auto: 'Auto', tv: 'TV', tablet: 'Tablet', phone: 'Phone' };
export const TABLET_MIN_WIDTH = 700;
export const PHONE_MAX_SHORT_SIDE = 500;

export function validLayoutMode(v) { return LAYOUT_MODES.includes(v) ? v : 'auto'; }

/** 'phone' or 'tablet' for a touch window of this size. */
export function touchLayoutFor(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w < TABLET_MIN_WIDTH || Math.min(w, h) < PHONE_MAX_SHORT_SIDE) return 'phone';
  return 'tablet';
}

/**
 * The layout to show: 'tv' | 'tablet' | 'phone'.
 * @param {object} o
 * @param {string} [o.override] the Settings choice: 'auto' (default), 'tv', 'tablet' or 'phone'
 * @param {boolean} [o.touchHost] the host offers touch layouts (AppInfo.touch)
 * @param {boolean} [o.coarse] the primary pointer is coarse
 * @param {boolean} [o.gamepad] a game controller is connected
 * @param {number} o.width window width (CSS px)
 * @param {number} o.height window height (CSS px)
 */
export function pickLayout({ override = 'auto', touchHost = false, coarse = false, gamepad = false, width = 0, height = 0 } = {}) {
  const o = validLayoutMode(override);
  if (o !== 'auto') return o;
  if (!touchHost || !coarse || gamepad) return 'tv';
  return touchLayoutFor(width, height);
}

/**
 * Whether text boxes use the system keyboard (a plain focused input) instead of Lurkbox's on-screen keyboard: in a
 * touch layout with a coarse pointer and no controller. A controller always gets the on-screen keyboard.
 */
export function useSystemKeyboard({ layout, coarse = false, gamepad = false }) {
  return layout !== 'tv' && !!coarse && !gamepad;
}
