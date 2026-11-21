// Modal stack. The top modal owns all input until it closes.
import { el, button } from './ui.js';
import { moveFocus, focusFirst, focusEl } from './focus.js';
import { stableKey, findOpener } from './focus-keep.js';
import { DIRECTIONS } from './input-core.js';
import { A, B } from './input-core.js';

const stack = [];

export function hasModal() { return stack.length > 0; }

/**
 * @param {object} opts
 * @param {HTMLElement} opts.content
 * @param {string} [opts.title]
 * @param {(action: string) => boolean} [opts.onAction] return true to consume
 * @param {() => void} [opts.onClose]
 * @param {string} [opts.focus] selector for the initially focused element
 * @param {string} [opts.class]
 */
export function openModal(opts) {
  const root = document.getElementById('modal-root');
  const box = el('div', { class: `modal ${opts.class || ''}`.trim(), role: 'dialog' },
    opts.title ? el('h2', { class: 'modal-title' }, opts.title) : null,
    opts.content);
  const backdrop = el('div', { class: 'modal-backdrop' }, box);
  root.append(backdrop);
  const m = {
    el: box,
    opts,
    prevFocus: document.activeElement,
    // The opener may be re-rendered while the modal is open (e.g. Settings after a pick); remember its key too.
    prevKey: document.activeElement && document.activeElement !== document.body ? stableKey(document.activeElement, document.body) : null,
    closed: false,
    close() {
      if (m.closed) return;
      m.closed = true;
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
      backdrop.remove();
      const back = () => {
        const opener = findOpener(m.prevFocus, m.prevKey, document.body);
        if (opener && !opener.closest('.modal')) focusEl(opener, { instant: true });
      };
      back();
      if (opts.onClose) opts.onClose();
      // onClose / onPick may re-render the opener's view right after this: find it again then.
      setTimeout(() => { if (!stack.length && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) back(); }, 0);
    },
  };
  stack.push(m);
  requestAnimationFrame(() => focusFirst(box, opts.focus));
  return m;
}

export function handleModalAction(action, source) {
  const m = stack[stack.length - 1];
  if (!m) return false;
  if (m.opts.onAction && m.opts.onAction(action, source)) return true;
  if (DIRECTIONS.includes(action)) {
    if (!m.el.contains(document.activeElement)) focusFirst(m.el, m.opts.focus);
    else moveFocus(action, m.el);
    // Don't rely on DOM focus events: they are deferred while the window is unfocused.
    if (m.opts.onFocusChange) m.opts.onFocusChange(document.activeElement);
  } else if (action === A) {
    const a = document.activeElement;
    if (a && m.el.contains(a)) a.click();
  } else if (action === B) {
    m.close();
  }
  return true;
}

/** A vertical list picker. */
export function pickFromList({ title, items, current, onPick, onPreview, onCancel }) {
  const list = el('div', { class: 'pick-list' });
  let picked = false;
  for (const it of items) {
    const b = button(it.label, () => { picked = true; m.close(); onPick(it.value); }, {
      class: `pick-item ${it.value === current ? 'selected' : ''}`,
      dataset: { value: String(it.value) },
    });
    if (onPreview) b.addEventListener('focus', () => onPreview(it.value)); // mouse hover
    list.append(b);
  }
  const m = openModal({
    title,
    content: list,
    focus: '.pick-item.selected',
    onFocusChange: (node) => { if (onPreview && node && node.dataset.value !== undefined) onPreview(items.find((i) => String(i.value) === node.dataset.value).value); },
    onClose: () => { if (!picked && onCancel) onCancel(); },
  });
  return m;
}

export function confirmDialog({ title, message, yes = 'Yes', no = 'Cancel', onYes, onNo }) {
  const content = el('div', { class: 'confirm' },
    el('p', {}, message),
    el('div', { class: 'row' },
      button(yes, () => { m.close(); onYes(); }, { class: 'primary' }),
      button(no, () => { m.close(); if (onNo) onNo(); })));
  const m = openModal({ title, content });
  return m;
}
