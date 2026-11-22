// Built-in on-screen keyboard (fallback for Steam + X). A CSS grid of COLS equal columns (osk-layout.js); the D-pad
// moves over the grid itself, not by spatial search, so up/down keep the column and left/right wrap at the row ends.
import { el, button } from './ui.js';
import { openModal } from './modal.js';
import { focusEl } from './focus.js';
import { X, Y, START, LB, RB, DIRECTIONS, hint } from './input.js';
import { COLS, oskLayout, oskMove, keyIndexAt, startColumn, span } from './osk-layout.js';

/**
 * @param {{title: string, value?: string, maxLength?: number, symbols?: boolean, onDone: (v: string) => void, onCancel?: () => void}} opts
 *   symbols: the chat keyboard (a fifth row of punctuation).
 */
export function openKeyboard({ title, value = '', maxLength = 100, symbols = false, onDone, onCancel }) {
  let text = value;
  let upper = false;
  let layout = 'letters';
  let rows = [];
  let pos = { row: 1, col: 0 }; // q
  let finished = false;

  const field = el('div', { class: 'osk-field' });
  const keysWrap = el('div', { class: 'osk-keys', role: 'group', 'aria-label': 'Keyboard', style: `grid-template-columns: repeat(${COLS}, minmax(0, 1fr))` });

  const renderText = () => {
    field.textContent = text;
    field.append(el('span', { class: 'osk-caret' }));
    keysWrap.querySelectorAll('.osk-key[data-ch]').forEach((k) => {
      k.textContent = upper ? k.dataset.ch.toUpperCase() : k.dataset.ch;
    });
    const shift = keysWrap.querySelector('.osk-key[data-key=shift]');
    if (shift) { shift.classList.toggle('on', upper); shift.setAttribute('aria-pressed', String(upper)); }
  };
  const type = (ch) => { if (text.length < maxLength) text += upper ? ch.toUpperCase() : ch; renderText(); };
  const backspace = () => { text = text.slice(0, -1); renderText(); };
  const toggleShift = () => { upper = !upper; renderText(); };
  const done = () => { finished = true; m.close(); onDone(text); };

  const keyNode = (p) => {
    const i = keyIndexAt(rows, p);
    return keysWrap.querySelector(`.osk-key[data-row="${p.row}"][data-index="${i}"]`);
  };
  const focusPos = (p) => { pos = p; focusEl(keyNode(p)); };

  const ACTIONS = {
    shift: toggleShift,
    layout: () => { layout = layout === 'letters' ? 'symbols' : 'letters'; build(); focusPos(pos); },
    space: () => type(' '),
    backspace,
    clear: () => { text = ''; renderText(); },
    done,
  };

  function build() {
    rows = oskLayout(layout, { chat: symbols });
    keysWrap.replaceChildren();
    rows.forEach((row, r) => row.forEach((key, i) => {
      const dataset = { row: String(r), index: String(i), col: String(startColumn(row, i)) };
      const cls = `osk-key${key.ch ? '' : ' osk-special'}${key.primary ? ' primary' : ''}${key.id === 'done' ? ' osk-done' : ''}`;
      const b = key.ch
        ? button(key.ch, () => type(key.ch), { class: cls, dataset: { ...dataset, ch: key.ch } })
        : button(key.label, () => ACTIONS[key.id](), { class: cls, dataset: { ...dataset, key: key.id }, 'aria-label': key.aria });
      b.style.gridColumn = `span ${span(key)}`;
      keysWrap.append(b);
    }));
    renderText();
  }

  // Mouse hover and touch move the D-pad position too.
  keysWrap.addEventListener('focusin', (e) => {
    const k = e.target.closest('.osk-key');
    if (!k) return;
    const r = Number(k.dataset.row);
    if (r === pos.row && keyIndexAt(rows, pos) === Number(k.dataset.index)) return;
    pos = { row: r, col: Number(k.dataset.col) };
  });

  build();
  const help = el('div', { class: 'osk-help' }, hint('{A} type · {X} delete · {Y} space · {LB}/{RB} shift · {START} done · {B} cancel'));
  const m = openModal({
    title,
    class: 'osk',
    content: el('div', {}, field, keysWrap, help),
    focus: '.osk-key[data-ch="q"]',
    onClose() { if (!finished && onCancel) onCancel(); },
    onAction(action) {
      if (DIRECTIONS.includes(action)) {
        if (!keysWrap.contains(document.activeElement)) { focusPos(pos); return true; }
        const next = oskMove(rows, pos, action);
        if (next) focusPos(next);
        return true;
      }
      if (action === X) { backspace(); return true; }
      if (action === Y) { type(' '); return true; }
      if (action === LB || action === RB) { toggleShift(); return true; }
      if (action === START) { done(); return true; }
      return false;
    },
  });
  return m;
}
