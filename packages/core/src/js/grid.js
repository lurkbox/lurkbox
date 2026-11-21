// Card grids with cursor paging ("Load more" card at the end).
import { el, button, fmtViewers, fmtUptime, fmtDate, thumb } from './ui.js';
import { ApiError } from './api.js';
import { state } from './state.js';

const refreshMs = () => (Number(state.settings.refreshInterval) || 15) * 1000;
import { focusEl } from './focus.js';
import { focusAfterUpdate } from './refresher.js';
import { refreshMarquee } from './marquee.js';

export function streamCard(s, onSelect) {
  return el('button', { class: 'card focusable', type: 'button', onclick: () => onSelect(s) },
    el('div', { class: 'card-thumb' },
      s.thumbnail_url ? el('img', { src: thumb(s.thumbnail_url, 440, 248, refreshMs()), alt: '', loading: 'lazy' }) : null,
      el('span', { class: 'badge live' }, 'LIVE'),
      el('span', { class: 'badge viewers' }, `${fmtViewers(s.viewer_count)} watching`)),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, s.user_name || s.user_login),
      el('div', { class: 'card-sub' }, s.title || ''),
      el('div', { class: 'card-meta' }, [s.game_name, fmtUptime(s.started_at)].filter(Boolean).join(' · '))));
}

export function gameCard(g, onSelect) {
  return el('button', { class: 'card card-game focusable', type: 'button', onclick: () => onSelect(g) },
    el('div', { class: 'card-thumb tall' }, el('img', { src: thumb(g.box_art_url, 285, 380), alt: '', loading: 'lazy' })),
    el('div', { class: 'card-body' }, el('div', { class: 'card-title' }, g.name)));
}

export function channelCard(c, onSelect) {
  return el('button', { class: 'card card-channel focusable', type: 'button', onclick: () => onSelect(c) },
    el('div', { class: 'card-avatar' },
      el('img', { src: c.thumbnail_url || '', alt: '', loading: 'lazy' }),
      c.is_live ? el('span', { class: 'badge live' }, 'LIVE') : null),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, c.display_name || c.broadcaster_login),
      el('div', { class: 'card-sub' }, c.is_live ? (c.title || '') : 'Offline'),
      el('div', { class: 'card-meta' }, c.game_name || '')));
}

export function videoCard(v, onSelect) {
  const img = v.thumbnail_url ? thumb(v.thumbnail_url, 440, 248) : '';
  return el('button', { class: 'card focusable', type: 'button', onclick: () => onSelect(v) },
    el('div', { class: 'card-thumb' },
      img ? el('img', { src: img, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-missing' }, 'Processing'),
      el('span', { class: 'badge viewers' }, v.duration || ''),
      v.type && v.type !== 'archive' ? el('span', { class: 'badge kind' }, v.type) : null),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, v.title || 'Untitled'),
      el('div', { class: 'card-meta' }, `${fmtDate(v.created_at)} · ${fmtViewers(v.view_count)} views`)));
}

/** Renders a friendly message for API errors, with an action button where it helps. */
export function errorState(err, nav) {
  if (err instanceof ApiError && err.code === 'NO_CLIENT_ID') {
    return el('div', { class: 'empty' },
      el('h2', {}, 'No Client ID'),
      el('p', {}, 'Lurkbox needs a Twitch Client ID. Add one in Settings.'),
      button('Open Settings', () => nav.goTop('settings'), { class: 'primary' }));
  }
  if (err instanceof ApiError && err.code === 'NOT_SIGNED_IN') {
    return el('div', { class: 'empty' },
      el('h2', {}, 'Sign in to browse'),
      el('p', {}, 'The Twitch API needs a signed-in account for this list.'),
      button('Sign in', () => nav.signIn(), { class: 'primary' }));
  }
  return el('div', { class: 'empty' },
    el('h2', {}, 'Something went wrong'),
    el('p', {}, err && err.message ? err.message : String(err)),
    button('Try again', () => nav.refresh(), { class: 'primary' }));
}

/**
 * @param {HTMLElement} host
 * @param {{fetchPage: (cursor) => Promise<{items, cursor}>, card: (item) => HTMLElement, empty: string|HTMLElement, nav: object, filter?: (items) => items}} opts
 */
export async function pagedGrid(host, opts) {
  const grid = el('div', { class: 'grid' });
  host.append(grid);
  grid.append(el('div', { class: 'loading' }, 'Loading…'));
  let more = null;
  const seen = new Set();
  const load = async (cursor) => {
    const { items, cursor: next } = await opts.fetchPage(cursor);
    const fresh = items.filter((it) => {
      const key = it.id || it.user_id || JSON.stringify(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const it of (opts.filter ? opts.filter(fresh) : fresh)) grid.insertBefore(opts.card(it), more);
    return next;
  };
  try {
    const next = await load(null);
    grid.querySelector('.loading')?.remove();
    if (!grid.children.length) {
      grid.replaceWith(typeof opts.empty === 'string' ? el('div', { class: 'empty' }, el('p', {}, opts.empty)) : opts.empty);
      return;
    }
    let cursor = next;
    if (cursor) {
      more = button('Load more', async () => {
        more.disabled = true;
        more.textContent = 'Loading…';
        try {
          const firstNew = grid.children.length - 1;
          cursor = await load(cursor);
          const target = grid.children[firstNew];
          if (target && target !== more) focusEl(target);
        } catch (e) {
          console.warn('load more failed', e);
        }
        more.disabled = false;
        more.textContent = 'Load more';
        if (!cursor) more.remove();
      }, { class: 'card card-more' });
      grid.append(more);
    }
  } catch (e) {
    console.warn('grid load failed', e);
    grid.replaceWith(errorState(e, opts.nav));
  }
}

/**
 * A grid that updates in place: cards are keyed, existing buttons are reused
 * (so focus never jumps), new items are added and gone ones removed. Large
 * lists render in chunks; the next chunk appears when focus nears the end.
 */
export class KeyedGrid {
  constructor(container, { key, render, chunkSize = 60 }) {
    this.el = container;
    this.key = key;
    this.render = render;
    this.chunkSize = chunkSize;
    this.limit = chunkSize;
    this.items = [];
    this.nodes = new Map();
    container.addEventListener('focusin', (e) => {
      const card = e.target.closest('[data-k]');
      if (!card) return;
      const idx = [...container.children].indexOf(card);
      if (idx >= this.limit - 12 && this.limit < this.items.length) { this.limit += this.chunkSize; this.paint(); }
    });
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.keepPosition] focus stays at the same slot (index) and the page doesn't scroll, instead of
   *   following the focused item to its new place (used when re-sorting).
   */
  set(items, opts = {}) {
    this.items = items;
    if (!opts.keepPosition) { this.paint(); return; }
    const active = document.activeElement;
    const card = active && this.el.contains(active) ? active.closest('[data-k]') : null;
    const idx = card ? [...this.el.children].indexOf(card) : -1;
    const scroller = this.el.closest('#content') || document.scrollingElement;
    const top = scroller ? scroller.scrollTop : 0;
    this.paint({ noRefocus: true });
    if (idx >= 0) {
      const slot = this.el.children[Math.min(idx, this.el.children.length - 1)];
      if (slot) slot.focus({ preventScroll: true });
      if (scroller) scroller.scrollTop = top;
      setTimeout(refreshMarquee, 60);
    }
  }

  paint({ noRefocus = false } = {}) {
    const active = document.activeElement;
    const focusedKey = active && this.el.contains(active) ? (active.closest('[data-k]') || {}).dataset?.k : null;
    const oldKeys = [...this.el.children].map((n) => n.dataset.k);
    const shown = this.items.slice(0, this.limit);
    const newKeys = shown.map((it) => String(this.key(it)));
    const keep = new Set(newKeys);
    for (const [k, n] of this.nodes) if (!keep.has(k)) { n.remove(); this.nodes.delete(k); }
    shown.forEach((it, i) => {
      const k = newKeys[i];
      const fresh = this.render(it);
      fresh.dataset.k = k;
      let node = this.nodes.get(k);
      if (node) {
        morphChildren(node, fresh); // update in place: unchanged images and text stay, so nothing flickers
        node.className = fresh.className + (node.classList.contains('is-focused') ? ' is-focused' : '');
        node.onclick = fresh.onclick;
      } else {
        node = fresh;
        this.nodes.set(k, node);
      }
      if (this.el.children[i] !== node) this.el.insertBefore(node, this.el.children[i] || null);
    });
    const target = focusAfterUpdate(oldKeys, newKeys, focusedKey);
    if (focusedKey) setTimeout(refreshMarquee, 60); // a refresh rewrote the focused card's text
    if (!noRefocus && focusedKey && target !== focusedKey && target) focusEl(this.nodes.get(target), { instant: true });
  }
}

/**
 * Make `target`'s children match `source`'s without recreating nodes that didn't change. Images keep showing the old picture
 * until the new one has loaded, so a refresh never blanks a thumbnail. Falls back to replacing a subtree whose shape changed.
 */
export function morphChildren(target, source) {
  const a = [...target.childNodes];
  const b = [...source.childNodes];
  if (a.length !== b.length) { target.replaceChildren(...b); return; }
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) { target.replaceChild(y, x); continue; }
    if (x.nodeType === 3) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    if (x.nodeType !== 1) continue;
    syncAttributes(x, y);
    if (x.nodeName !== 'IMG') morphChildren(x, y);
  }
}

function syncAttributes(x, y) {
  for (const { name } of [...x.attributes]) if (!y.hasAttribute(name)) x.removeAttribute(name);
  for (const { name, value } of [...y.attributes]) {
    if (x.getAttribute(name) === value) continue;
    if (x.nodeName === 'IMG' && name === 'src') { swapImage(x, value); continue; }
    x.setAttribute(name, value);
  }
}

/** Load the new picture off-screen, then swap it in; the old one stays visible meanwhile. */
function swapImage(img, src) {
  img.dataset.pendingSrc = src;
  const pre = new Image();
  pre.onload = () => { if (img.dataset.pendingSrc === src) { img.src = src; delete img.dataset.pendingSrc; } };
  pre.onerror = pre.onload;
  pre.src = src;
}
