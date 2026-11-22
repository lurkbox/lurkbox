// Built-in on-screen keyboard (fallback for Steam + X).
import { el, button } from './ui.js';
import { openModal } from './modal.js';
import { X, Y, START, LB, RB, hint } from './input.js';

const ROWS = [
  '1234567890'.split(''),
  'qwertyuiop'.split(''),
  'asdfghjkl'.split('').concat(['_']),
  'zxcvbnm'.split('').concat(['-', '.', '@']),
];
// An extra row for chat (symbols: true).
const SYMBOLS = "!?,':;()#/".split('');

/**
 * @param {{title: string, value?: string, maxLength?: number, symbols?: boolean, onDone: (v: string) => void, onCancel?: () => void}} opts
 */
export function openKeyboard({ title, value = '', maxLength = 100, symbols = false, onDone, onCancel }) {
  let text = value;
  let upper = false;
  const field = el('div', { class: 'osk-field' });
  const render = () => {
    field.textContent = text;
    field.append(el('span', { class: 'osk-caret' }));
    keysWrap.querySelectorAll('.osk-key[data-ch]').forEach((k) => {
      k.textContent = upper ? k.dataset.ch.toUpperCase() : k.dataset.ch;
    });
  };
  const type = (ch) => { if (text.length < maxLength) text += upper ? ch.toUpperCase() : ch; render(); };
  const backspace = () => { text = text.slice(0, -1); render(); };
  let finished = false;
  const done = () => { finished = true; m.close(); onDone(text); };

  const keysWrap = el('div', { class: 'osk-keys' });
  for (const row of symbols ? [...ROWS, SYMBOLS] : ROWS) {
    keysWrap.append(el('div', { class: 'osk-row' },
      row.map((ch) => button(ch, () => type(ch), { class: 'osk-key', dataset: { ch } }))));
  }
  keysWrap.append(el('div', { class: 'osk-row' },
    button('Shift', () => { upper = !upper; render(); }, { class: 'osk-key wide' }),
    button('Space', () => type(' '), { class: 'osk-key wider' }),
    button('Delete', backspace, { class: 'osk-key wide' }),
    button('Clear', () => { text = ''; render(); }, { class: 'osk-key wide' }),
    button('Done', done, { class: 'osk-key wide primary osk-done' })));

  const help = el('div', { class: 'osk-help' }, hint('{A} type · {X} delete · {Y} space · {LB}/{RB} shift · {START} done · {B} cancel'));
  const m = openModal({
    title,
    class: 'osk',
    content: el('div', {}, field, keysWrap, help),
    focus: '.osk-key[data-ch="q"]',
    onClose() { if (!finished && onCancel) onCancel(); },
    onAction(action) {
      if (action === X) { backspace(); return true; }
      if (action === Y) { type(' '); return true; }
      if (action === LB || action === RB) { upper = !upper; render(); return true; }
      if (action === START) { done(); return true; }
      return false;
    },
  });
  render();
  return m;
}
