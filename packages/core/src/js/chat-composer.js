// The chat composer: a compact text box at the bottom of the Lurkbox chat panel, with the room's modes above it
// ("Slow mode 30 s · Followers-only") and a character counter near Twitch's 500-character limit. The player's
// "Send a message" control focuses it and opens a keyboard (keyboardFor: Steam's, else the built-in one); a
// physical keyboard types straight in. Enter (or A on Send) sends, B leaves.
import { el, toast } from './ui.js';
import { icon } from './icons.js';
import { focusEl, moveFocus } from './focus.js';
import { keyboardFor } from './text-entry.js';
import { MAX_CHAT_LENGTH, COUNTER_FROM, chatLength, roomModeNote } from './chat-send.js';

/** The counter's text and state for a draft: { text, show, over }. Pure. */
export function counterState(text) {
  const n = chatLength(text);
  return { text: `${n}/${MAX_CHAT_LENGTH}`, show: n >= COUNTER_FROM, over: n > MAX_CHAT_LENGTH };
}

export class Composer {
  /**
   * @param {object} o
   * @param {import('./chat.js').Chat} o.chat for the room modes
   * @param {(text: string) => Promise<{ok: boolean}>} o.onSend
   * @param {() => void} o.onLeave B (or Escape): leave the composer
   * @param {HTMLElement[]} [o.buttons] extra buttons between the text box and Send (emotes, quick chat)
   */
  constructor({ chat, onSend, onLeave, buttons = [] }) {
    this.onSend = onSend;
    this.onLeave = onLeave;
    this.sending = false;
    this.input = el('input', {
      class: 'cm-input focusable', type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'send',
      placeholder: 'Send a message', 'aria-label': 'Chat message', dataset: { focusKey: 'cm-input' },
    });
    this.sendBtn = el('button', { type: 'button', class: 'cm-btn cm-send focusable', 'aria-label': 'Send', title: 'Send', dataset: { focusKey: 'cm-send' }, onclick: () => this.send() }, icon('send'));
    this.note = el('div', { class: 'cm-note', hidden: true });
    this.counter = el('span', { class: 'cm-count', hidden: true });
    this.row = el('div', { class: 'cm-row' }, this.input, ...buttons, this.sendBtn);
    this.node = el('div', { class: 'chat-composer', hidden: true }, el('div', { class: 'cm-meta' }, this.note, this.counter), this.row);
    this.input.addEventListener('input', () => this.updateCounter());
    // While typing, the player's "video only when unfocused" mode leaves the chat alone (Steam's keyboard can take focus).
    this.node.addEventListener('focusin', () => document.body.classList.add('composing'));
    this.node.addEventListener('focusout', () => setTimeout(() => { if (!this.contains(document.activeElement)) document.body.classList.remove('composing'); }, 0));
    chat.onModes((m) => this.setModes(m));
    this.setModes(chat.modes);
  }

  get visible() { return !this.node.hidden; }

  setVisible(on) {
    this.node.hidden = !on;
    if (!on && this.contains(document.activeElement)) document.activeElement.blur();
  }

  setModes(modes) {
    const t = roomModeNote(modes);
    this.note.textContent = t;
    this.note.hidden = !t;
  }

  updateCounter() {
    const c = counterState(this.input.value);
    this.counter.textContent = c.text;
    this.counter.hidden = !c.show;
    this.counter.classList.toggle('over', c.over);
    this.input.classList.toggle('over', c.over);
  }

  contains(n) { return !!(n && this.node.contains(n)); }

  /** Focuses the text box; with keyboard, opens the on-screen keyboard too. */
  focus({ keyboard = false } = {}) {
    focusEl(this.input, { instant: true });
    if (keyboard) this.openKeyboard();
  }

  openKeyboard() {
    return keyboardFor(this.input, {
      title: 'Chat message',
      maxLength: MAX_CHAT_LENGTH,
      onDone: () => { this.updateCounter(); focusEl(this.sendBtn, { instant: true }); }, // A then sends
    });
  }

  /** Puts text into the draft (an emote name, at the caret). */
  setDraft(text, caret = null) {
    this.input.value = text;
    this.updateCounter();
    if (caret != null) { try { this.input.setSelectionRange(caret, caret); } catch { /* not focused */ } }
  }

  clear() { this.setDraft(''); }

  async send() {
    if (this.sending) return;
    const text = this.input.value;
    if (!text.trim()) { this.focus({ keyboard: true }); return; }
    if (chatLength(text.trim()) > MAX_CHAT_LENGTH) { toast(`Messages can be at most ${MAX_CHAT_LENGTH} characters`, 3000, 'warn'); return; }
    this.sending = true;
    this.node.classList.add('sending');
    try {
      const r = await this.onSend(text);
      if (r && r.ok) this.clear();
    } finally {
      this.sending = false;
      this.node.classList.remove('sending');
    }
  }

  /**
   * Controller/keyboard input while focus is in the composer. source: 'pad' | 'key' | 'mouse'.
   * A: on the text box, Enter sends and the pad's A opens the keyboard; on a button, presses it. START sends.
   * B leaves. LEFT/RIGHT move between the box and the buttons. Returns true when consumed.
   */
  handle(action, source) {
    const a = document.activeElement;
    switch (action) {
      case 'A':
        if (a === this.input) { if (source === 'key') this.send(); else this.openKeyboard(); }
        else if (a && this.contains(a)) a.click();
        return true;
      case 'START': this.send(); return true;
      case 'B': this.onLeave(); return true;
      case 'LEFT':
      case 'RIGHT':
        moveFocus(action, this.row);
        return true;
      default:
        return false;
    }
  }
}
