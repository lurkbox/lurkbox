// A focusable slider for the controller, mouse and touch: D-pad left/right steps (holding accelerates), the
// pointer drags. Used by the chat pop-over, the volume pop-over and Settings → Chat. The stepping is pure and
// unit-tested; the DOM part is the Slider class.
import { el } from './ui.js';

/** Steps per press for how long a direction has been held: ×1, then ×2 after 0.6 s, ×4 after 1.6 s. */
export function holdMultiplier(heldMs) {
  if (heldMs < 600) return 1;
  if (heldMs < 1600) return 2;
  return 4;
}

/** A press counts as part of the same hold when it comes within this long of the previous one (repeat is 110 ms). */
export const HOLD_GAP_MS = 300;

/** value moved by dir (−1 / +1) steps of `step` × mult, snapped to the step and clamped to [min, max]. */
export function stepValue(value, dir, { min, max, step }, mult = 1) {
  const v = Number(value);
  const base = Number.isFinite(v) ? v : min;
  const next = Math.round((base + dir * step * mult) / step) * step;
  return Math.min(max, Math.max(min, Number(next.toFixed(6))));
}

/** The value at a fraction (0..1) of the track, snapped and clamped. */
export function valueAt(frac, { min, max, step }) {
  const f = Math.min(1, Math.max(0, Number(frac) || 0));
  return Math.min(max, Math.max(min, Math.round((min + f * (max - min)) / step) * step));
}

/** Tracks a hold of LEFT/RIGHT: press(dir, now) → the multiplier for this press. */
export class HoldTracker {
  constructor() { this.dir = 0; this.since = 0; this.last = -Infinity; }
  press(dir, now) {
    if (dir !== this.dir || now - this.last > HOLD_GAP_MS) { this.dir = dir; this.since = now; }
    this.last = now;
    return holdMultiplier(now - this.since);
  }
}

const registry = new WeakMap(); // node → Slider

/** The slider that owns this node (the focused element), if any. */
export function sliderFor(node) { return (node && registry.get(node)) || null; }

/** Routes LEFT/RIGHT to the focused slider. Returns true when consumed. */
export function handleSliderAction(action, active = typeof document !== 'undefined' ? document.activeElement : null) {
  const s = sliderFor(active);
  return s ? s.handle(action) : false;
}

export class Slider {
  /**
   * @param {object} o
   * @param {string} o.key focus key (data-focus-key)
   * @param {string} o.label
   * @param {number} o.min @param {number} o.max @param {number} o.step
   * @param {number} o.value
   * @param {(v: number) => string} [o.format] value text
   * @param {(v: number) => void} o.onInput every change (live preview)
   * @param {boolean} [o.disabled]
   * @param {string} [o.cls]
   */
  constructor(o) {
    this.o = { format: (v) => String(v), ...o };
    this.value = o.value;
    this.hold = new HoldTracker();
    this.fill = el('div', { class: 'slider-fill' });
    this.knob = el('div', { class: 'slider-knob' });
    this.track = el('div', { class: 'slider-track' }, this.fill, this.knob);
    this.valueEl = el('span', { class: 'slider-value' });
    this.labelEl = el('span', { class: 'slider-label' }, o.label);
    this.node = el('div', {
      class: `slider focusable ${o.cls || ''}`.trim(), tabindex: '0', role: 'slider',
      'aria-label': o.label, 'aria-valuemin': String(o.min), 'aria-valuemax': String(o.max),
      dataset: { focusKey: o.key },
    }, el('div', { class: 'slider-head' }, this.labelEl, this.valueEl), this.track);
    registry.set(this.node, this);
    this.installPointer();
    this.setDisabled(!!o.disabled);
    this.render();
  }

  setDisabled(on) {
    this.disabled = on;
    this.node.classList.toggle('disabled', on);
    this.node.setAttribute('aria-disabled', on ? 'true' : 'false');
  }

  /** External change (the same setting changed elsewhere): no onInput. Ignored while dragging. */
  setValue(v) {
    if (this.dragging || v === this.value) return;
    this.value = v;
    this.render();
  }

  setLabel(text) { if (this.labelEl.textContent !== text) this.labelEl.textContent = text; }

  change(v) {
    if (this.disabled || v === this.value) return;
    this.value = v;
    this.o.onInput(v); // first: format() may read the setting this changes
    this.render();
  }

  handle(action) {
    const dir = action === 'LEFT' ? -1 : action === 'RIGHT' ? 1 : 0;
    if (!dir) return false;
    if (this.disabled) return true;
    const mult = this.hold.press(dir, performance.now());
    this.change(stepValue(this.value, dir, this.o, mult));
    return true;
  }

  installPointer() {
    const at = (e) => {
      const r = this.track.getBoundingClientRect();
      return valueAt((e.clientX - r.left) / Math.max(1, r.width), this.o);
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (this.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      try { this.track.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.node.focus({ preventScroll: true });
      this.change(at(e));
    });
    this.track.addEventListener('pointermove', (e) => { if (this.dragging) this.change(at(e)); });
    const end = () => { this.dragging = false; };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.track.addEventListener('click', (e) => e.stopPropagation());
  }

  render() {
    const { min, max } = this.o;
    const f = max > min ? (this.value - min) / (max - min) : 0;
    const pct = `${(Math.min(1, Math.max(0, f)) * 100).toFixed(2)}%`;
    this.fill.style.width = pct;
    this.knob.style.left = pct;
    const text = this.o.format(this.value);
    if (this.valueEl.textContent !== text) this.valueEl.textContent = text;
    this.node.setAttribute('aria-valuenow', String(this.value));
    this.node.setAttribute('aria-valuetext', text);
  }
}
