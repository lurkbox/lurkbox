// Keep the controller where it was across a re-render: record the focused control's stable key (and the scroll
// position) before rebuilding, then put focus back on the same key, or its nearest surviving neighbour, instantly.

/** A control's stable key: data-focus-key, then data-setting / data-key / data-view. */
export function focusKey(node) {
  if (!node || !node.dataset) return null;
  const d = node.dataset;
  return d.focusKey || d.setting || d.key || d.view || null;
}

/**
 * Pure choice of where focus goes after a re-render (unit-tested).
 * snap: { key, index, order } (order = keys of the focusables before, in DOM order; null for unkeyed ones).
 * keys: keys of the focusables after, in DOM order. Returns an index into `keys`, or -1 when there is nothing.
 */
export function chooseRestoreTarget(snap, keys) {
  if (!keys.length) return -1;
  if (!snap) return -1;
  if (snap.key) {
    const i = keys.indexOf(snap.key);
    if (i >= 0) return i;
  }
  // Gone: the nearest neighbour from before that still exists, preferring the one after it (what moved up).
  const order = snap.order || [];
  for (let d = 1; d < order.length; d++) {
    for (const j of [snap.index + d, snap.index - d]) {
      const k = order[j];
      if (k) { const i = keys.indexOf(k); if (i >= 0) return i; }
    }
  }
  if (Number.isInteger(snap.index) && snap.index >= 0) return Math.min(snap.index, keys.length - 1);
  return -1;
}

/**
 * Records focus inside `root` (null when focus is elsewhere). `list` = the root's focusables in DOM order;
 * unkeyed controls get a derived key from their row and position, so they come back too.
 */
export function snapshotFocus(root, list, scroller = null) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const scrollTop = scroller ? scroller.scrollTop : null;
  if (!active || !root.contains(active)) return { key: null, index: -1, order: [], scrollTop, had: false };
  const order = list.map((n) => stableKey(n, root));
  return { key: stableKey(active, root), index: list.indexOf(active), order, scrollTop, had: true };
}

/** Puts focus back after a re-render. `focus(node)` must focus instantly (no smooth scroll). Returns the node. */
export function restoreFocus(root, snap, list, focus, scroller = null) {
  if (scroller && snap && Number.isFinite(snap.scrollTop)) scroller.scrollTop = snap.scrollTop;
  if (!snap || !snap.had) return null;
  const active = document.activeElement;
  if (active && root.contains(active) && stableKey(active, root) === snap.key) return active; // never lost (morphed)
  const i = chooseRestoreTarget(snap, list.map((n) => stableKey(n, root)));
  if (i < 0) return null;
  focus(list[i]);
  if (scroller && Number.isFinite(snap.scrollTop)) {
    // focus() may nudge the scroller to show the control; keep the old position when it is still visible.
    const r = list[i].getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    if (r.top >= c.top && r.bottom <= c.bottom) scroller.scrollTop = snap.scrollTop;
  }
  return list[i];
}

/** focusKey, or "<row label>#<n>" for an unkeyed control inside a settings row / keyed group. */
export function stableKey(node, root) {
  const k = focusKey(node);
  if (k) return k;
  const group = node.closest && node.closest('[data-focus-group], .setting-row, .account-row');
  if (!group || (root && !root.contains(group))) return null;
  const label = group.dataset.focusGroup || (group.querySelector('.setting-label, .setting-value') || group).textContent.trim().slice(0, 60);
  const mates = [...group.querySelectorAll('.focusable')];
  return `${label}#${mates.indexOf(node)}`;
}

/**
 * Finds the control that should get focus back when a sub-menu closes: the opener itself if it is still in the
 * page, otherwise the control that replaced it (same key) in `scope`.
 */
export function findOpener(opener, openerKey, scope) {
  if (opener && opener.isConnected) return opener;
  if (!openerKey || !scope) return null;
  return [...scope.querySelectorAll('.focusable')].find((n) => stableKey(n, scope) === openerKey) || null;
}
