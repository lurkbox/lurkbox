// Input from three sources, normalised into actions:
//  - gamepads (Steam Input's virtual pad with the standard mapping, or raw pads
//    via vendor fallback tables; any connected pad drives the UI),
//  - keyboard (also what Steam's keyboard/mouse templates send),
//  - mouse (hover focuses, click activates, right-click = back, wheel scrolls),
//  - touch (taps are clicks; mode 'touch' hides the focus ring in the touch layouts; gestures are in touch.js).
import { onAction as soundForAction, installSounds } from './sounds.js';
import {
  A, B, X, Y, LB, RB, LT, RT, BACK, START, UP, DOWN, LEFT, RIGHT, DIRECTIONS, SHIFT_LEFT, SHIFT_RIGHT, HOME, END,
  padActions, padType, Repeater, Deduper, keyAction, InputMode, glyph,
} from './input-core.js';

export { A, B, X, Y, LB, RB, LT, RT, BACK, START, UP, DOWN, LEFT, RIGHT, DIRECTIONS, SHIFT_LEFT, SHIFT_RIGHT, HOME, END };

const CURSOR_IDLE_MS = 3000;
const STUCK_MS = 15000;

/** Input events go to the console and to lurkbox.log, so controller problems on the TV can be read over SSH. */
function padLog(line) {
  console.log(`[input] ${line}`);
  try { if (window.lurkbox && window.lurkbox.log) window.lurkbox.log(`[input] ${line}`); } catch { /* ignore */ }
}

export class Input {
  /** @param {(action: string, source: 'pad'|'key'|'mouse') => void} dispatch */
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.repeater = new Repeater();
    this.deduper = new Deduper();
    this.windowFocused = document.hasFocus();
    this.seenFocus = this.windowFocused;
    this.allowUnfocused = false;
    this.swallowAll = false;
    this.pads = new Map(); // index -> id
    this.padState = new Map(); // index -> { repeater, ignore:Set, swallow, since:Map, seen }
    this.cursorTimer = null;
    this.mode = new InputMode((mode, type) => this.onModeChange(mode, type));

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    // Releases matter only for hold-to-scrub (LEFT/RIGHT); onRelease is set by the app.
    this.onRelease = null;
    window.addEventListener('keyup', (e) => {
      const a = { ArrowLeft: LEFT, ArrowRight: RIGHT, a: LEFT, d: RIGHT }[e.key];
      if (a && this.onRelease) this.onRelease(a, 'key');
    }, true);
    window.addEventListener('gamepadconnected', (e) => {
      this.pads.set(e.gamepad.index, e.gamepad.id);
      padLog(`gamepad connected #${e.gamepad.index}: ${e.gamepad.id} (mapping=${e.gamepad.mapping || 'none'}, type=${padType(e.gamepad.id)})`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads.delete(e.gamepad.index);
      this.padState.delete(e.gamepad.index);
      padLog(`gamepad disconnected #${e.gamepad.index}`);
    });
    // Window focus comes from the main process (BrowserWindow focus/blur). DOM
    // blur also fires when the embed iframe takes focus, which is not "unfocused".
    if (window.lurkbox) window.lurkbox.onWindowFocus((f) => this.setWindowFocus(f));
    installSounds({ onWindowFocus: window.lurkbox && window.lurkbox.onWindowFocus });
    // Steam virtual pads read by the main process from /dev/input/js* (Chromium drops all but one of them).
    this.joyPads = new Map();
    if (window.lurkbox && window.lurkbox.onJoydevPad) {
      window.lurkbox.onJoydevPad((p) => {
        const key = 1000 + p.index;
        if (p.gone) { this.joyPads.delete(key); padLog(`joydev pad ${p.index} removed`); return; }
        if (!this.joyPads.has(key)) padLog(`joydev pad ${p.index}: ${p.id}`);
        this.joyPads.set(key, { index: key, id: p.id, mapping: 'standard', connected: true, joydev: true, buttons: p.buttons, axes: p.axes });
      });
    }

    this.installMouse();
    this.onModeChange(this.mode.mode, this.mode.padType);
    this.timer = setInterval(() => this.poll(), 16);
    let lastList = '';
    const listPads = () => {
      const list = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean).map((g) => `#${g.index} ${g.id} (${g.mapping || 'none'}, ${g.connected ? 'connected' : 'gone'})`).join(' | ') || 'none';
      if (list !== lastList) { lastList = list; padLog(`gamepads: ${list}`); }
    };
    setTimeout(listPads, 2000);
    setInterval(listPads, 5000);
  }

  setWindowFocus(focused) {
    if (focused && !this.windowFocused) this.swallowAll = true; // ignore the press that switched apps (per pad)
    this.windowFocused = focused;
    if (focused) this.seenFocus = true;
  }

  /** Controller input is ignored while another app (a game under Floater) has focus. */
  acceptPad() {
    if (this.allowUnfocused) return true;
    if (!this.seenFocus) return true; // focus never reported: don't lock the user out
    return this.windowFocused;
  }

  emit(action, source) {
    if (!this.deduper.accept(action, source === 'pad' ? 'pad' : 'key', performance.now())) return;
    if (DIRECTIONS.includes(action)) this.lastDirAt = performance.now();
    if (source === 'pad' || source === 'key') soundForAction(action);
    this.dispatch(action, source);
  }

  // ---------- keyboard ----------

  onKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const action = keyAction(e.key, typing, e.shiftKey);
    if (!action) return;
    if (typing) {
      if (e.key === 'ArrowLeft' && t.selectionStart > 0) return;
      if (e.key === 'ArrowRight' && t.selectionEnd < t.value.length) return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.mode.set('keyboard');
    if (action === 'FULLSCREEN') {
      if (window.lurkbox && window.lurkbox.toggleFullscreen) window.lurkbox.toggleFullscreen();
      return;
    }
    this.emit(action, 'key');
  }

  // ---------- gamepads ----------

  /**
   * Each pad is tracked on its own, so one pad can never block another:
   * - its own repeater, so a direction held on pad 2 doesn't stop pad 1 from firing the same direction;
   * - actions already held when a pad first shows up (a resting trigger or stick on a newly connected pad) are ignored on
   *   that pad until released;
   * - an action held for more than 15 s is treated as stuck on that pad and ignored until released;
   * - "swallow until release" after regaining focus is per pad.
   */
  poll() {
    const apiPads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    // When joydev supplies Steam's virtual pads, skip them in the Gamepad API so presses aren't counted twice.
    const pads = this.joyPads.size ? [...apiPads.filter((g) => g && !/Vendor: 28de/i.test(g.id)), ...this.joyPads.values()] : apiPads;
    const now = performance.now();
    const fire = [];
    let lastType = null;
    let anyDir = false;
    const live = new Set();
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      live.add(gp.index);
      let st = this.padState.get(gp.index);
      const acts = padActions(gp);
      if (!st || st.id !== gp.id) {
        st = { id: gp.id, repeater: new Repeater(), ignore: new Set(gp.joydev ? [] : acts), swallow: false, since: new Map(), stuckLogged: new Set() };
        this.padState.set(gp.index, st);
        if (acts.size && !gp.joydev) padLog(`pad #${gp.index} appeared holding ${[...acts].join(',')}; ignoring those until released`);
      }
      // No per-press logging: it filled lurkbox.log. Connects, joydev pads, stuck and ignored input are still logged.
      if (this.swallowAll) st.swallow = true;
      for (const a of [...st.ignore]) if (!acts.has(a)) st.ignore.delete(a);
      for (const a of [...st.since.keys()]) if (!acts.has(a)) { st.since.delete(a); st.stuckLogged.delete(a); }
      const held = new Set();
      for (const a of acts) {
        if (st.ignore.has(a)) continue;
        if (!st.since.has(a)) st.since.set(a, now);
        if (now - st.since.get(a) > STUCK_MS) {
          if (!st.stuckLogged.has(a)) { st.stuckLogged.add(a); padLog(`pad #${gp.index} has held ${a} for ${STUCK_MS / 1000} s; ignoring it until released`); }
          continue;
        }
        held.add(a);
      }
      if (st.swallow) {
        if (held.size === 0) st.swallow = false;
        st.repeater.reset(held);
        continue;
      }
      if ([...held].some((a) => DIRECTIONS.includes(a))) anyDir = true;
      const f = st.repeater.update(held, now);
      if (this.onRelease && st.repeater.released.length && this.acceptPad()) for (const a of st.repeater.released) this.onRelease(a, 'pad');
      if (f.length) { lastType = padType(gp.id); fire.push(...f); }
    }
    this.swallowAll = false;
    for (const i of [...this.padState.keys()]) if (!live.has(i)) this.padState.delete(i);
    if (anyDir) this.lastDirAt = now; // holding = mid-navigation
    if (fire.length && !this.acceptPad() && (this.blockLogged = (this.blockLogged || 0) + 1) <= 20) padLog(`dropped ${fire.join(',')}: window not focused`);
    if (!fire.length || !this.acceptPad()) return;
    this.mode.set('pad', lastType);
    for (const a of new Set(fire)) this.emit(a, 'pad');
  }

  // ---------- mouse ----------

  installMouse() {
    let lastX = -1;
    let lastY = -1;
    // Touch: input mode 'touch' (no focus ring, no cursor). The mouse events a browser makes up after a tap don't
    // count as the mouse.
    this.lastTouchAt = -Infinity;
    const touchedRecently = () => performance.now() - this.lastTouchAt < 1000;
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      this.lastTouchAt = performance.now();
      this.mode.set('touch');
    }, true);
    // A tapped button doesn't keep the focus highlight (the focus ring is the controller's cursor). Text boxes keep
    // focus for the keyboard, and so do controls that moved the focus somewhere on purpose.
    window.addEventListener('click', (e) => {
      if (!touchedRecently() || !document.body.classList.contains('touch-ui')) return;
      const b = e.target.closest && e.target.closest('button');
      if (b) setTimeout(() => { if (document.activeElement === b) b.blur(); }, 0);
    });
    window.addEventListener('mousemove', (e) => {
      if (touchedRecently()) return;
      if (e.screenX === lastX && e.screenY === lastY) return; // synthetic move after scroll/layout
      lastX = e.screenX;
      lastY = e.screenY;
      this.mode.set('mouse');
      this.bumpCursor();
    }, true);
    document.addEventListener('mouseover', (e) => {
      if (this.mode.mode !== 'mouse') return;
      const f = e.target.closest && e.target.closest('.focusable');
      if (f && document.activeElement !== f && !(document.activeElement && document.activeElement.tagName === 'INPUT' && f.tagName !== 'INPUT')) {
        f.focus({ preventScroll: true });
      }
    });
    window.addEventListener('mousedown', () => { if (touchedRecently()) return; this.mode.set('mouse'); this.bumpCursor(); }, true);
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A touch long-press opens the context menu too; it is not Back (Android's back gesture is).
      if (touchedRecently()) return;
      this.mode.set('mouse');
      this.dispatch(B, 'mouse');
    });
  }

  bumpCursor() {
    document.body.classList.remove('cursor-idle');
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => document.body.classList.add('cursor-idle'), CURSOR_IDLE_MS);
  }

  onModeChange(mode, type) {
    const body = document.body;
    body.classList.toggle('input-mouse', mode === 'mouse');
    body.classList.toggle('input-pad', mode === 'pad');
    body.classList.toggle('input-keyboard', mode === 'keyboard');
    body.classList.toggle('input-touch', mode === 'touch');
    if (mode !== 'mouse') { clearTimeout(this.cursorTimer); body.classList.add('cursor-idle'); }
    refreshGlyphs(this.mode.glyphFamily());
  }
}

// ---------- button hints ----------

let glyphFamily = 'steam';

/** Builds a hint like "{B} back · {Y} refresh"; {X} tokens become glyphs that follow the input type. */
export function hint(text, cls = 'hint') {
  const node = document.createElement('span');
  node.className = cls;
  for (const part of text.split(/(\{[A-Z]+\})/)) {
    const m = /^\{([A-Z]+)\}$/.exec(part);
    if (m) {
      const g = document.createElement('kbd');
      g.className = 'glyph';
      g.dataset.act = m[1];
      g.textContent = glyph(m[1], glyphFamily);
      node.append(g);
    } else if (part) {
      node.append(part);
    }
  }
  return node;
}

export function refreshGlyphs(family) {
  if (family) glyphFamily = family;
  document.body.dataset.glyphs = glyphFamily;
  for (const g of document.querySelectorAll('kbd.glyph[data-act]')) g.textContent = glyph(g.dataset.act, glyphFamily);
}
