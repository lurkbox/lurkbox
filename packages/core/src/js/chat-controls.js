// The live chat controls, shared by the player's chat pop-over and Settings → Chat: one list of specs (pure,
// unit-tested) read from and written to the same settings keys, so a change in either place shows in the other.
import { el, button } from './ui.js';
import { Slider } from './slider.js';
import { twitchChatZoom } from '../shared/tv-zoom.js';
import {
  chatLayout, chatPanelWidth, widthPercent, chatOverActive, CHAT_LAYOUT_DEFAULTS, TEXT_SIZE, WIDTH, OPACITY,
} from '../shared/chat-layout.js';

const pct = (v) => `${v}%`;

/**
 * What the chat controls show for these settings. env: { windowWidth, screenHeight, remPx, direct }.
 * Each spec: { key, type: 'slider'|'choice'|'toggle', label, value, text, range?, options?, disabled?, hidden?, note?, patch(v) }.
 * hidden: the control can't apply right now (e.g. the background slider in Twitch chat style), so it isn't shown.
 * patch(v) is the settings patch for a new value (the only way the controls change settings).
 */
export function chatControlSpecs(settings, env = {}) {
  const s = settings || {};
  const L = chatLayout(s);
  const style = s.chatStyle === 'twitch' ? 'twitch' : 'lurkbox';
  const twitch = style === 'twitch';
  const zoom = twitchChatZoom(s, env.screenHeight);
  const W = Number(env.windowWidth) || 1280;
  const widthPx = chatPanelWidth({ style, chatWidth: L.chatWidth, windowWidth: W, zoom, remPx: env.remPx });
  const widthNow = L.chatWidth === 'auto' ? widthPercent(widthPx, W) : L.chatWidth;
  const over = chatOverActive({ layout: L, style, direct: env.direct !== false });
  const specs = [
    { key: 'chatStyle', type: 'choice', label: 'Style', value: style,
      options: [{ value: 'lurkbox', label: 'Lurkbox chat' }, { value: 'twitch', label: 'Twitch chat' }],
      patch: (v) => ({ chatStyle: v === 'twitch' ? 'twitch' : 'lurkbox' }) },
    twitch
      ? { key: 'twitchChatSize', type: 'slider', label: 'Text size', range: TEXT_SIZE,
          value: Math.round(zoom * 100),
          text: L.twitchChatSize === 'auto' ? `Auto · ${Math.round(zoom * 100)}%` : pct(L.twitchChatSize),
          note: 'Zooms Twitch\'s own chat (and its rewards, predictions and polls).',
          patch: (v) => ({ twitchChatSize: v }) }
      : { key: 'chatTextSize', type: 'slider', label: 'Text size', range: TEXT_SIZE, value: L.chatTextSize,
          text: pct(L.chatTextSize), patch: (v) => ({ chatTextSize: v }) },
    { key: 'chatWidth', type: 'slider', label: 'Width', range: WIDTH, value: widthNow,
      text: L.chatWidth === 'auto' ? `Auto · ${widthNow}%` : pct(widthNow),
      note: over ? 'Over the video, the chat floats on top at this width.' : 'The video shrinks beside the chat.',
      patch: (v) => ({ chatWidth: v }) },
    { key: 'chatSide', type: 'choice', label: 'Side', value: L.chatSide,
      options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }],
      patch: (v) => ({ chatSide: v === 'left' ? 'left' : 'right' }) },
    { key: 'chatBgOpacity', type: 'slider', label: 'Background', range: OPACITY, value: L.chatBgOpacity,
      text: pct(L.chatBgOpacity), disabled: twitch || over, hidden: twitch || over,
      note: twitch ? 'Twitch chat draws its own background.' : over ? 'Over the video, the setting below applies.' : '',
      patch: (v) => ({ chatBgOpacity: v }) },
    { key: 'chatOverlay', type: 'toggle', label: 'Over the video', value: !!L.chatOverlay, disabled: twitch,
      note: twitch ? 'Lurkbox chat only: Twitch\'s chat and player pause when something covers them.'
        : env.direct === false && L.chatOverlay ? 'On the Twitch player engine chat stays beside the video (the player pauses when covered).' : '',
      patch: (v) => ({ chatOverlay: !!v }) },
    { key: 'chatOverlayOpacity', type: 'slider', label: 'Background over the video', range: OPACITY,
      value: L.chatOverlayOpacity, text: pct(L.chatOverlayOpacity), disabled: twitch || !L.chatOverlay, hidden: twitch || !L.chatOverlay,
      patch: (v) => ({ chatOverlayOpacity: v }) },
  ];
  return specs;
}

/** The patch "Reset chat layout" saves (style and on/off are not layout). */
export function resetChatLayoutPatch() { return { ...CHAT_LAYOUT_DEFAULTS }; }

/**
 * DOM for the specs: one control per spec, updated in place by update(settings, env).
 * onChange(patch, { live }) is called with the spec's patch; live is true for slider moves (preview + delayed save).
 * wrap(spec, control) may wrap each control (Settings puts it in a row); default: the control itself.
 */
export class ChatControls {
  constructor({ settings, env, onChange, wrap = null, only = null }) {
    this.onChange = onChange;
    this.env = env;
    this.items = new Map(); // key → { spec, control, slider?, buttons?, noteEl, wrapper }
    this.nodes = [];
    this.specs = chatControlSpecs(settings, env());
    for (const spec of this.specs) {
      if (only && !only.includes(spec.key)) continue;
      const item = this.build(spec);
      this.items.set(spec.key, item);
      item.wrapper = wrap ? wrap(spec, item.control, item.noteEl) : el('div', { class: 'cc-item', dataset: { focusGroup: spec.key } }, item.control, item.noteEl);
      this.nodes.push(item.wrapper);
    }
    this.update(settings);
  }

  build(spec) {
    const noteEl = el('div', { class: 'cc-note' });
    if (spec.type === 'slider') {
      const slider = new Slider({
        key: `cc-${spec.key}`, label: spec.label, ...spec.range, value: spec.value, cls: 'cc-slider',
        format: () => this.text(spec.key),
        onInput: (v) => this.onChange(this.current(spec.key).patch(v), { live: true }),
      });
      return { spec, slider, control: slider.node, noteEl };
    }
    if (spec.type === 'toggle') {
      const b = button('', () => { const c = this.current(spec.key); if (!c.disabled) this.onChange(c.patch(!c.value), { live: false }); },
        { class: 'cc-toggle', dataset: { focusKey: `cc-${spec.key}` } });
      const control = el('div', { class: 'cc-row' }, el('span', { class: 'cc-label' }, spec.label), b);
      return { spec, button: b, control, noteEl };
    }
    const buttons = spec.options.map((o) => button(o.label, () => {
      const c = this.current(spec.key);
      if (c.value !== o.value) this.onChange(c.patch(o.value), { live: false });
    }, { class: 'cc-choice', dataset: { focusKey: `cc-${spec.key}-${o.value}`, value: o.value } }));
    const control = el('div', { class: 'cc-row' }, el('span', { class: 'cc-label' }, spec.label), el('div', { class: 'cc-choices' }, buttons));
    return { spec, buttons, control, noteEl };
  }

  current(key) { return this.specs.find((s) => s.key === key) || this.items.get(key).spec; }

  text(key) { const c = this.current(key); return c.text || String(c.value); }

  /** Re-reads the settings: values, texts, disabled states and notes. */
  update(settings) {
    this.specs = chatControlSpecs(settings, this.env());
    // The text size control is a different setting per style: rebuild it in place when the style flips.
    for (const [key, item] of this.items) {
      const spec = this.specs.find((s) => s.key === key) || (key === 'chatTextSize' || key === 'twitchChatSize'
        ? this.specs.find((s) => s.key === 'chatTextSize' || s.key === 'twitchChatSize') : null);
      if (!spec) continue;
      if (spec.key !== key) { this.items.delete(key); this.items.set(spec.key, item); item.spec = spec; }
      if (item.wrapper) item.wrapper.hidden = !!spec.hidden;
      item.noteEl.textContent = spec.note || '';
      item.noteEl.hidden = !spec.note;
      if (item.slider) {
        item.slider.o.format = () => this.text(spec.key);
        item.slider.o.onInput = (v) => this.onChange(this.current(spec.key).patch(v), { live: true });
        item.slider.setDisabled(!!spec.disabled);
        item.slider.setValue(spec.value);
        item.slider.render();
      } else if (item.button) {
        item.button.textContent = spec.value ? 'On' : 'Off';
        item.button.classList.toggle('on', !!spec.value);
        item.button.disabled = !!spec.disabled;
      } else if (item.buttons) {
        for (const b of item.buttons) b.classList.toggle('selected', b.dataset.value === String(spec.value));
      }
    }
  }
}
