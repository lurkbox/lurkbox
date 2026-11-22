// Custom theme editor: five colours, live preview, contrast warnings.
import { scheduleSteamArt } from '../steam-art.js';
import { el, button, toast } from '../ui.js';
import { state, saveSettings, applyTheme, THEMES } from '../state.js';
import { pickFromList, openModal } from '../modal.js';
import { openKeyboard } from '../osk.js';
import { hint, A, B, LB, RB, LEFT, RIGHT, START } from '../input.js';
import { readableOn } from '../color.js';
import { hexToHsl, hslToHex, isHex } from '../color.js';
import {
  CUSTOM_KEYS, BASE_COLORS, PRESETS, sanitizeCustom, contrastWarnings, fixContrast,
} from '../theme-custom.js';

const BASES = THEMES.filter((t) => t.value !== 'custom');

export function customThemeView() {
  let draft;
  let saved = false;
  let host;
  let refs;

  const startDraft = () => {
    const existing = state.settings.customTheme;
    if (existing) return sanitizeCustom(existing);
    const base = BASE_COLORS[state.settings.theme] ? state.settings.theme : 'lurkbox';
    return { base, colors: { ...BASE_COLORS[base] } };
  };

  const live = () => {
    applyTheme('custom', draft.colors);
    if (!refs) return;
    for (const { key } of CUSTOM_KEYS) {
      refs.sw[key].style.background = draft.colors[key];
      refs.hex[key].textContent = draft.colors[key];
    }
    refs.base.textContent = `Base: ${(BASES.find((b) => b.value === draft.base) || BASES[0]).label}`;
    const warns = contrastWarnings(draft.colors);
    refs.warn.replaceChildren(...(warns.length
      ? warns.map((w) => el('div', { class: 'custom-warning' }, `⚠ ${w.text}`))
      : [el('div', { class: 'custom-ok' }, 'Contrast looks good.')]));
    refs.chatNick.style.color = readableOn('#1e90ff', draft.colors.surface);
  };

  const revert = () => applyTheme(state.settings.theme);

  const cancel = (nav) => {
    revert();
    nav.pop();
  };

  return {
    id: 'custom-theme',
    title: 'Custom theme',
    destroy() { if (!saved) revert(); },
    onAction(action) {
      if (action === B) { cancel(this.nav); return true; }
      return false;
    },
    mount(h, nav) {
      host = h;
      this.nav = nav;
      draft = startDraft();
      const sw = {}, hex = {};
      const rows = CUSTOM_KEYS.map(({ key, label }) => {
        sw[key] = el('span', { class: 'swatch' });
        hex[key] = el('span', { class: 'swatch-hex' });
        return el('button', {
          class: 'btn focusable swatch-row', type: 'button', dataset: { key: `custom-${key}` },
          onclick: () => openColorEditor(label, draft.colors[key], (v) => { draft.colors[key] = v; live(); }),
        }, sw[key], el('span', { class: 'swatch-label' }, label), hex[key]);
      });
      const baseBtn = button('Base', () => pickFromList({
        title: 'Start from',
        items: BASES,
        current: draft.base,
        onPick: (v) => { draft = { base: v, colors: { ...BASE_COLORS[v] } }; live(); },
      }), { dataset: { key: 'custom-base' } });
      const warn = el('div', { class: 'custom-warnings', 'aria-live': 'polite' });

      const chatNick = el('span', { class: 'chat-nick' }, 'viewer42');
      const preview = el('div', { class: 'custom-preview', 'aria-hidden': 'true' },
        el('div', { class: 'preview-title' }, 'Preview'),
        el('div', { class: 'card preview-focus' },
          el('div', { class: 'card-thumb' }, el('span', { class: 'badge live' }, 'LIVE')),
          el('div', { class: 'card-body' },
            el('div', { class: 'card-title' }, 'Focused card'),
            el('div', { class: 'card-meta' }, 'Muted text · 1.2K watching'))),
        el('div', { class: 'preview-chat' }, chatNick, ': ', el('span', {}, 'hello from chat')),
        el('div', { class: 'row' },
          el('span', { class: 'btn primary preview-btn' }, 'Primary'),
          el('span', { class: 'btn preview-btn' }, 'Button')));

      refs = { sw, hex, base: baseBtn, warn, chatNick };

      host.append(
        el('header', { class: 'view-header' }, el('h1', {}, 'Custom theme'), hint('{B} cancel')),
        el('div', { class: 'custom-layout' },
          el('div', { class: 'custom-controls' },
            baseBtn,
            ...rows,
            warn,
            el('div', { class: 'row' },
              button('Fix contrast', () => { draft.colors = fixContrast(draft.colors); live(); toast('Contrast adjusted', 2000); }),
              button('Reset to base', () => { draft.colors = { ...BASE_COLORS[draft.base] }; live(); }),
              button('Save', async () => {
                saved = true;
                await saveSettings({ theme: 'custom', customTheme: { base: draft.base, colors: { ...draft.colors } } });
                applyTheme('custom');
                toast('Custom theme saved', 2500, 'ok');
                scheduleSteamArt();
                nav.pop();
              }, { class: 'primary', dataset: { key: 'custom-save' } }),
              button('Cancel', () => cancel(nav)))),
          preview));
      live();
    },
  };
}

// ---------- colour editor (modal) ----------

const CHANNELS = [
  { ch: 0, label: 'Hue', max: 360, step: 2, big: 30, wrap: true },
  { ch: 1, label: 'Saturation', max: 100, step: 1, big: 10 },
  { ch: 2, label: 'Lightness', max: 100, step: 1, big: 10 },
];

export function openColorEditor(title, value, onChange) {
  const original = value;
  let hsl = hexToHsl(value);
  let done = false;
  let accel = { ch: -1, dir: 0, t: 0, n: 0 };

  const big = el('div', { class: 'ce-swatch' });
  const hexIn = el('input', { class: 'text-input focusable ce-hex', type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '7', 'data-osk': 'Hex colour' });
  const sliders = CHANNELS.map((c) => {
    const range = el('input', { type: 'range', min: '0', max: String(c.max), step: '1', tabindex: '-1', class: 'ce-range' });
    const val = el('span', { class: 'ce-val' });
    range.addEventListener('input', () => { hsl[c.ch] = Number(range.value); update(); });
    const rowEl = el('div', { class: 'focusable ce-slider', tabindex: '0', dataset: { ch: String(c.ch) } },
      el('span', { class: 'ce-label' }, c.label), range, val);
    return { c, rowEl, range, val };
  });

  const update = (fromHex) => {
    const hex = hslToHex(hsl);
    big.style.background = hex;
    if (!fromHex) hexIn.value = hex;
    for (const s of sliders) {
      s.range.value = String(Math.round(hsl[s.c.ch]));
      s.val.textContent = String(Math.round(hsl[s.c.ch]));
    }
    onChange(hex);
  };
  const setHex = (v) => {
    v = v.trim().toLowerCase();
    if (!v.startsWith('#')) v = `#${v}`;
    if (!isHex(v)) { toast('Use a 6-digit hex colour like #1a9fff', 2500, 'warn'); return; }
    hsl = hexToHsl(v);
    update();
  };
  hexIn.addEventListener('change', () => setHex(hexIn.value));

  const adjust = (row, dir, isBig) => {
    const c = CHANNELS[Number(row.dataset.ch)];
    const now = performance.now();
    accel = accel.ch === c.ch && accel.dir === dir && now - accel.t < 220 ? { ...accel, t: now, n: accel.n + 1 } : { ch: c.ch, dir, t: now, n: 0 };
    const step = isBig ? c.big : c.step * (1 + Math.min(accel.n, 24) / 4); // hold to accelerate
    let v = hsl[c.ch] + dir * step;
    v = c.wrap ? ((v % c.max) + c.max) % c.max : Math.min(c.max, Math.max(0, v));
    hsl[c.ch] = v;
    update();
  };

  const presets = el('div', { class: 'ce-presets' }, PRESETS.map((p) => el('button', {
    class: 'focusable ce-preset', type: 'button', style: `background:${p}`, title: p, 'aria-label': p,
    onclick: () => { hsl = hexToHsl(p); update(); },
  })));

  const content = el('div', { class: 'ce' },
    el('div', { class: 'ce-top' }, big, el('div', { class: 'ce-hexrow' }, hexIn,
      button('Keyboard', () => openKeyboard({ title: 'Hex colour', value: hexIn.value, maxLength: 7, onDone: setHex }), { class: 'osk-btn' }))),
    ...sliders.map((s) => s.rowEl),
    presets,
    el('div', { class: 'row' },
      button('Done', () => { done = true; m.close(); }, { class: 'primary ce-done' }),
      button('Cancel', () => m.close())),
    el('div', { class: 'osk-help' }, hint('{LEFT}/{RIGHT} adjust (hold to speed up) · {LB}/{RB} big steps · {START} done · {B} cancel')));

  const m = openModal({
    title,
    class: 'ce-modal',
    content,
    focus: '.ce-slider',
    onAction(action, source) {
      const a = document.activeElement;
      if (a && a.classList.contains('ce-slider')) {
        if (action === LEFT || action === RIGHT) { adjust(a, action === RIGHT ? 1 : -1, false); return true; }
        if (action === LB || action === RB) { adjust(a, action === RB ? 1 : -1, true); return true; }
      }
      if (a === hexIn && action === A) {
        if (source === 'key') setHex(hexIn.value);
        else openKeyboard({ title: 'Hex colour', value: hexIn.value, maxLength: 7, onDone: setHex });
        return true;
      }
      if (action === START) { done = true; m.close(); return true; }
      return false;
    },
    onClose() { if (!done) onChange(original); },
  });
  update();
  return m;
}
