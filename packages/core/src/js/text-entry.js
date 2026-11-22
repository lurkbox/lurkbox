// Typing with a controller: Steam's on-screen keyboard where the host can open it (desktop, in Game Mode: it types
// into the focused text box, like in the TV sign-in window), otherwise Lurkbox's own on-screen keyboard. A physical
// keyboard always types straight into the box.
import { openKeyboard } from './osk.js';
import { el, button, toast } from './ui.js';
import { openModal } from './modal.js';
import { hint } from './input.js';

/**
 * Opens a keyboard for `input`. Resolves 'steam' (Steam's keyboard is up; the input keeps focus and gets the keys)
 * or 'osk' (the built-in keyboard; on Done the text goes into the input, an 'input' event fires and onDone runs).
 */
export async function keyboardFor(input, { title = 'Enter text', maxLength = 500, onDone = null, onCancel = null } = {}) {
  input.focus({ preventScroll: true });
  let steam = false;
  if (window.lurkbox && window.lurkbox.openOnScreenKeyboard) {
    try { steam = (await window.lurkbox.openOnScreenKeyboard()) === true; } catch { steam = false; }
  }
  if (steam) return 'steam';
  openKeyboard({
    title, value: input.value, maxLength, symbols: true,
    onDone: (v) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (onDone) onDone(v);
    },
    onCancel,
  });
  return 'osk';
}

/**
 * A small dialog with one text box (Save, optional Delete, Cancel), for quick-chat phrases. A on the box opens a
 * keyboard (Steam's or the built-in one), a physical Enter saves. Resolves { action: 'save', value },
 * { action: 'delete' } or null (cancelled).
 */
export function promptText({ title, value = '', maxLength = 500, placeholder = '', deletable = false, help = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = el('input', {
      class: 'text-input focusable prompt-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder, 'aria-label': title,
    });
    input.value = value;
    const save = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      if (Array.from(v).length > maxLength) { toast(`At most ${maxLength} characters`, 2500, 'warn'); return; }
      result = { action: 'save', value: v };
      m.close();
    };
    const content = el('div', { class: 'prompt' },
      help ? el('p', { class: 'prompt-help' }, help) : null,
      input,
      el('div', { class: 'row' },
        button('Save', save, { class: 'primary prompt-save' }),
        deletable ? button('Delete', () => { result = { action: 'delete' }; m.close(); }, { class: 'prompt-delete' }) : null,
        button('Cancel', () => m.close())),
      el('div', { class: 'osk-help' }, hint('{A} on the box: keyboard · {START} save · {B} cancel')));
    const m = openModal({
      title,
      class: 'prompt-modal',
      content,
      focus: '.prompt-input',
      onAction(action, source) {
        if (action === 'START') { save(); return true; }
        if (action === 'A' && document.activeElement === input) {
          if (source === 'key') save();
          else keyboardFor(input, { title, maxLength });
          return true;
        }
        return false;
      },
      onClose: () => resolve(result),
    });
  });
}
