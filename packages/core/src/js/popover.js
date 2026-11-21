// Small pop-overs anchored above a button (the player overlay's quality, volume, chat, points and "more").
// Focus moves into the pop-over; B (or a click outside) closes it and focus goes back to its button, or to the
// button that replaced it after a re-render (same focus key). DOM access goes through `deps`, so the focus
// return is unit-tested without a browser.
import { stableKey, findOpener } from './focus-keep.js';

export class Popover {
  /**
   * @param {object} deps
   * @param {(node: any) => void} deps.focus focuses a node instantly
   * @param {(dir: string, scope: any) => any} deps.move spatial focus move inside the pop-over
   * @param {() => any} deps.active the focused element
   * @param {any} deps.scope where a re-rendered opener is looked up (the overlay)
   * @param {(node: any) => void} [deps.mount] puts the pop-over on screen (and positions it)
   */
  constructor(deps) {
    this.deps = deps;
    this.cur = null; // { key, node, opener, openerKey, onClose, update }
  }

  get isOpen() { return !!this.cur; }
  get key() { return this.cur ? this.cur.key : null; }

  /**
   * Opens `node` for the control `key`, above `opener`. `initial` is the node to focus first (else the first
   * focusable in it). `update` refreshes its contents in place when the player state changes.
   */
  open({ key, node, opener, initial = null, onClose = null, update = null }) {
    if (this.cur) this.close({ returnFocus: false });
    const openerKey = opener ? stableKey(opener, this.deps.scope) : null;
    this.cur = { key, node, opener, openerKey, onClose, update };
    if (this.deps.mount) this.deps.mount(node, opener);
    const first = initial || (node.querySelector && node.querySelector('.focusable'));
    if (first) this.deps.focus(first);
    return this.cur;
  }

  /** Closes it; focus goes back to the button unless returnFocus is false. Returns the node that got focus. */
  close({ returnFocus = true } = {}) {
    const c = this.cur;
    if (!c) return null;
    this.cur = null;
    if (c.node && c.node.remove) c.node.remove();
    if (c.onClose) c.onClose();
    if (!returnFocus) return null;
    const back = findOpener(c.opener, c.openerKey, this.deps.scope);
    if (back) this.deps.focus(back);
    return back;
  }

  contains(n) { return !!(this.cur && n && this.cur.node.contains && this.cur.node.contains(n)); }

  update() { if (this.cur && this.cur.update) this.cur.update(); }

  /** Controller input while open. Returns true when consumed (B, A, directions); other actions pass through. */
  handle(action) {
    if (!this.cur) return false;
    if (action === 'B') { this.close(); return true; }
    const a = this.deps.active();
    if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(action)) {
      if (!this.contains(a)) {
        const first = this.cur.node.querySelector && this.cur.node.querySelector('.focusable');
        if (first) this.deps.focus(first);
      } else this.deps.move(action, this.cur.node);
      return true;
    }
    if (action === 'A') {
      if (this.contains(a) && a.click) a.click();
      return true;
    }
    return false;
  }
}
