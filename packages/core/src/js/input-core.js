// Pure input logic (no DOM): gamepad mapping tables, pad detection, repeat,
// key/pad de-duplication and input-mode tracking. Unit-tested under node --test.

export const A = 'A', B = 'B', X = 'X', Y = 'Y', LB = 'LB', RB = 'RB', BACK = 'BACK', START = 'START';
export const LT = 'LT', RT = 'RT'; // triggers (standard buttons 6/7): ±30 s in the video player
// Keyboard-only seek keys (player): Shift+←/→ ±1 min, Home/End.
export const SHIFT_LEFT = 'SHIFT_LEFT', SHIFT_RIGHT = 'SHIFT_RIGHT', HOME = 'HOME', END = 'END';
export const UP = 'UP', DOWN = 'DOWN', LEFT = 'LEFT', RIGHT = 'RIGHT';
export const DIRECTIONS = [UP, DOWN, LEFT, RIGHT];
export const GUIDE = 'GUIDE'; // Steam/Xbox/PS button: owned by Steam, always ignored

export const DEADZONE = 0.5;
export const REPEAT_DELAY = 380;
export const REPEAT_RATE = 110;
export const DEDUPE_MS = 80;

// W3C "standard" mapping (what Steam Input's virtual pad reports).
export const STANDARD = { 0: A, 1: B, 2: X, 3: Y, 4: LB, 5: RB, 6: LT, 7: RT, 8: BACK, 9: START, 12: UP, 13: DOWN, 14: LEFT, 15: RIGHT, 16: GUIDE };

// Fallback tables for mapping !== 'standard' (Linux evdev button order as
// Chromium reports it). D-pads on these usually arrive as hat axes 6/7.
// Face buttons are mapped by position: bottom = A (select), right = B (back).
export const VENDOR_TABLES = {
  // Xbox (xpad / xone)
  '045e': { buttons: { 0: A, 1: B, 2: X, 3: Y, 4: LB, 5: RB, 6: BACK, 7: START, 8: GUIDE }, type: 'xbox' },
  // DualShock 4 / DualSense (hid-sony / hid-playstation): cross, circle, triangle, square
  '054c': { buttons: { 0: A, 1: B, 2: Y, 3: X, 4: LB, 5: RB, 8: BACK, 9: START, 10: GUIDE }, type: 'playstation' },
  // Switch Pro (hid-nintendo): B(south), A(east), X(north), Y(west), ..., minus, plus, home
  '057e': { buttons: { 0: A, 1: B, 2: Y, 3: X, 5: LB, 6: RB, 9: BACK, 10: START, 11: GUIDE }, type: 'nintendo' },
  // 8BitDo in D-input mode
  '2dc8': { buttons: { 0: A, 1: B, 3: X, 4: Y, 6: LB, 7: RB, 10: BACK, 11: START, 12: GUIDE }, type: 'xbox' },
  // Valve hardware seen raw (Steam not running)
  '28de': { buttons: { 0: A, 1: B, 2: X, 3: Y, 4: LB, 5: RB, 6: BACK, 7: START, 8: GUIDE }, type: 'steam' },
};
export const GENERIC = { buttons: { 0: A, 1: B }, type: 'generic' };

/** Parses vendor/product from Chromium ("Vendor: 045e Product: 028e") or Firefox ("045e-028e-…") ids. */
export function parsePadId(id = '') {
  let m = /Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i.exec(id);
  if (!m) m = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  if (!m) return { vendor: null, product: null };
  return { vendor: m[1].toLowerCase().padStart(4, '0'), product: m[2].toLowerCase().padStart(4, '0') };
}

export function isSteamVirtualPad(id = '') {
  return parsePadId(id).vendor === '28de' || /steam virtual gamepad|valve/i.test(id);
}

/** Glyph family for hints: 'steam' | 'xbox' | 'playstation' | 'nintendo' | 'generic'. */
export function padType(id = '') {
  if (isSteamVirtualPad(id)) return 'steam';
  const { vendor } = parsePadId(id);
  if (vendor && VENDOR_TABLES[vendor]) return VENDOR_TABLES[vendor].type;
  if (/xbox|x-box|xinput|microsoft/i.test(id)) return 'xbox';
  if (/dualsense|dualshock|playstation|sony|wireless controller/i.test(id)) return 'playstation';
  if (/nintendo|pro controller|joy-con/i.test(id)) return 'nintendo';
  return 'generic';
}

function hatFromAxis(v) {
  // DirectInput-style POV hat on one axis: -1 = up, then clockwise in steps of 2/7; >1 = centred.
  if (typeof v !== 'number' || Math.abs(v) > 1.05) return [];
  const idx = Math.round((v + 1) / (2 / 7));
  return [[UP], [UP, RIGHT], [RIGHT], [DOWN, RIGHT], [DOWN], [DOWN, LEFT], [LEFT], [UP, LEFT]][idx] || [];
}

/** Returns the set of logical actions currently held on one gamepad. */
export function padActions(gp, deadzone = DEADZONE) {
  const out = new Set();
  if (!gp) return out;
  const pressed = (b) => !!b && (b.pressed || b.value > 0.5);
  const standard = gp.mapping === 'standard';
  const table = standard ? STANDARD
    : (VENDOR_TABLES[parsePadId(gp.id).vendor] || GENERIC).buttons;
  (gp.buttons || []).forEach((b, i) => {
    const act = table[i];
    if (act && act !== GUIDE && pressed(b)) out.add(act);
  });
  const axes = gp.axes || [];
  const ax = axes[0] || 0;
  const ay = axes[1] || 0;
  if (Math.abs(ax) > deadzone || Math.abs(ay) > deadzone) {
    if (Math.abs(ax) > Math.abs(ay)) out.add(ax > 0 ? RIGHT : LEFT);
    else out.add(ay > 0 ? DOWN : UP);
  }
  if (!standard) {
    if (axes.length > 9) hatFromAxis(axes[9]).forEach((d) => out.add(d));
    if (axes.length >= 8) {
      if (axes[6] < -0.5) out.add(LEFT);
      if (axes[6] > 0.5) out.add(RIGHT);
      if (axes[7] < -0.5) out.add(UP);
      if (axes[7] > 0.5) out.add(DOWN);
    }
  }
  return out;
}

const REPEATABLE = new Set(DIRECTIONS);

/** Turns "held" sets into press events with auto-repeat for directions. */
export class Repeater {
  constructor({ delay = REPEAT_DELAY, rate = REPEAT_RATE } = {}) {
    this.delay = delay;
    this.rate = rate;
    this.prev = new Set();
    this.next = new Map();
  }

  /** @returns {string[]} actions to fire for this frame; this.released lists the actions let go this frame */
  update(held, now) {
    const fire = [];
    this.released = [...this.prev].filter((a) => !held.has(a));
    for (const a of held) {
      if (!this.prev.has(a)) {
        fire.push(a);
        if (REPEATABLE.has(a)) this.next.set(a, now + this.delay);
      } else if (REPEATABLE.has(a) && now >= (this.next.get(a) ?? Infinity)) {
        fire.push(a);
        this.next.set(a, now + this.rate);
      }
    }
    for (const a of this.prev) if (!held.has(a)) this.next.delete(a);
    this.prev = new Set(held);
    return fire;
  }

  reset(held = new Set()) {
    this.prev = new Set(held);
    this.next.clear();
  }
}

/**
 * Steam can deliver one press as both a pad event and a key event.
 * Drops an action if the same action came from the *other* source within DEDUPE_MS.
 */
export class Deduper {
  constructor(windowMs = DEDUPE_MS) {
    this.windowMs = windowMs;
    this.last = new Map(); // action -> { source, t }
  }

  accept(action, source, now) {
    const prev = this.last.get(action);
    if (prev && prev.source !== source && now - prev.t < this.windowMs) return false;
    this.last.set(action, { source, t: now });
    return true;
  }
}

/** Keyboard → action. `typing` = a text input has focus; `shift` = Shift held. */
export function keyAction(key, typing, shift = false) {
  if (!typing && shift && key === 'ArrowLeft') return SHIFT_LEFT;
  if (!typing && shift && key === 'ArrowRight') return SHIFT_RIGHT;
  if (!typing && key === 'Home') return HOME;
  if (!typing && key === 'End') return END;
  switch (key) {
    case 'ArrowUp': return UP;
    case 'ArrowDown': return DOWN;
    case 'ArrowLeft': return LEFT;
    case 'ArrowRight': return RIGHT;
    case 'Enter': return A;
    case 'Escape': return B;
    case 'PageUp': return LB;
    case 'PageDown': return RB;
    case 'F11': return 'FULLSCREEN';
    default: break;
  }
  if (typing) return null; // letters, space and Backspace belong to the input
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'w': return UP;
    case 's': return DOWN;
    case 'a': return LEFT;
    case 'd': return RIGHT;
    case ' ': return A;
    case 'Backspace': return B;
    case 'c': return Y; // chat (refresh in lists)
    case 'l': return X; // jump to live
    case 'q': return LB;
    case 'e': return RB;
    case 'm': return START;
    case '[': return LT;
    case ']': return RT;
    default: return null;
  }
}

/** Which kind of input was used last; drives cursor hiding and button glyphs. */
export class InputMode {
  constructor(onChange = () => {}) {
    this.mode = 'pad'; // 'pad' | 'keyboard' | 'mouse'
    this.padType = 'steam';
    this.onChange = onChange;
  }

  set(mode, padTypeName) {
    const changed = mode !== this.mode || (mode === 'pad' && padTypeName && padTypeName !== this.padType);
    this.mode = mode;
    if (mode === 'pad' && padTypeName) this.padType = padTypeName;
    if (changed) this.onChange(this.mode, this.padType);
    return changed;
  }

  get cursorVisible() { return this.mode === 'mouse'; }

  glyphFamily() { return this.mode === 'pad' ? this.padType : 'keyboard'; }
}

const GLYPHS = {
  steam: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', START: 'Menu', BACK: 'View' },
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', START: 'Menu', BACK: 'View' },
  generic: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', START: 'Start', BACK: 'Select', LT: 'LT', RT: 'RT' },
  playstation: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', START: 'Options', BACK: 'Share' },
  // Labels printed on Nintendo pads at the same positions.
  nintendo: { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR', START: '+', BACK: '−' },
  keyboard: { A: 'Enter', B: 'Esc', X: 'L', Y: 'C', LB: 'Q', RB: 'E', LT: '[', RT: ']', START: 'M', BACK: 'Tab' },
};

const ARROWS = { UP: ['\u25B2', '\u2191'], DOWN: ['\u25BC', '\u2193'], LEFT: ['\u25C0', '\u2190'], RIGHT: ['\u25B6', '\u2192'] };

export function glyph(action, family) {
  if (ARROWS[action]) return ARROWS[action][family === 'keyboard' ? 1 : 0];
  return (GLYPHS[family] || GLYPHS.generic)[action] || action;
}
