// Typing with a controller: Steam's on-screen keyboard where the host can open it (desktop, in Game Mode: it types
// into the focused text box, like in the TV sign-in window), otherwise Lurkbox's own on-screen keyboard. A physical
// keyboard always types straight into the box.
import { openKeyboard } from './osk.js';

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
