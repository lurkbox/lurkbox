// Card grids with cursor paging ("Load more" card at the end).
import { el, button, toast, fmtViewers, fmtUptime, fmtDate, thumb } from './ui.js';
import { hint } from './input.js';
import { sortLabel, nextSort, groupByGame } from '../shared/sorts.js';
import { fmtLength } from '../shared/channel-page.js';
import { cwProgress } from '../shared/continue-watching.js';
import { fmtAgo } from './follows.js';
import { ApiError } from './api.js';
import { state, saveSettings } from './state.js';

const refreshMs = () => (Number(state.settings.refreshInterval) || 15) * 1000;
import { focusEl } from './focus.js';
import { focusAfterUpdate } from './refresher.js';
import { refreshMarquee } from './marquee.js';
import { LongPress, LONG_PRESS_MS } from '../shared/gestures.js';

/** The channel a card belongs to, for X (or a long-press) → its channel page (main.js). */
const channelData = (login, id, name) => (login ? { channelLogin: login, channelId: id || '', channelName: name || login } : undefined);

/**
 * A touch long-press (shared/gestures.js LongPress: 500 ms held still; moving, as in a scroll, cancels it). No click
 * follows it, and no context menu (which would be Back). Also where X or Y does something on a controller.
 */
export function onLongPress(node, fn, ms = LONG_PRESS_MS) {
  const lp = new LongPress({ ms });
  let timer = null;
  let at = null;
  let touching = false;
  let fired = false;
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touching = true;
    fired = false;
    at = { x: e.clientX, y: e.clientY };
    lp.start(performance.now());
    clearTimeout(timer);
    timer = setTimeout(() => { if (lp.fire(performance.now())) { fired = true; fn(); } }, ms);
  });
  node.addEventListener('pointermove', (e) => {
    if (!at || e.pointerType !== 'touch') return;
    lp.move(e.clientX - at.x, e.clientY - at.y);
    if (lp.cancelled) clearTimeout(timer);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(ev, () => { clearTimeout(timer); lp.end(); at = null; setTimeout(() => { touching = false; }, 0); });
  node.addEventListener('click', (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  node.addEventListener('contextmenu', (e) => { if (fired || touching) { e.preventDefault(); e.stopPropagation(); } });
  return node;
}

/** X on a focused card (or a long-press on it) opens its channel page: the card's data-channel-* (main.js). */
export function channelOfCard(node) {
  const c = node && node.closest ? node.closest('[data-channel-login]') : null;
  return c ? { login: c.dataset.channelLogin, id: c.dataset.channelId || null, name: c.dataset.channelName || c.dataset.channelLogin } : null;
}

let openChannelFn = null;
/** main.js: how a long-press opens a channel page. */
export function setChannelOpener(fn) { openChannelFn = fn; }
function withChannel(card) {
  if (card.dataset.channelLogin) onLongPress(card, () => { const c = channelOfCard(card); if (c && openChannelFn) openChannelFn(c); });
  return card;
}

export function streamCard(s, onSelect) {
  return withChannel(el('button', { class: 'card focusable', type: 'button', onclick: () => onSelect(s), dataset: channelData(s.user_login, s.user_id, s.user_name) },
    el('div', { class: 'card-thumb' },
      s.thumbnail_url ? el('img', { src: thumb(s.thumbnail_url, 440, 248, refreshMs()), alt: '', loading: 'lazy' }) : null,
      el('span', { class: 'badge live' }, 'LIVE'),
      el('span', { class: 'badge viewers' }, `${fmtViewers(s.viewer_count)} watching`),
      // Uptime sits on the thumbnail so it never gets cut off by a long game name.
      s.started_at ? el('span', { class: 'badge uptime', title: 'Live for' }, fmtUptime(s.started_at)) : null),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, s.user_name || s.user_login),
      el('div', { class: 'card-sub' }, s.title || ''),
      // The game gets the whole line; it scrolls on focus (marquee) if it's still too long.
      el('div', { class: 'card-meta' }, s.game_name || ''))));
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
  return el('button', { class: 'card focusable', type: 'button', onclick: () => onSelect(v), dataset: { focusKey: `video-${v.id}` } },
    el('div', { class: 'card-thumb' },
      img ? el('img', { src: img, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-missing' }, 'Processing'),
      el('span', { class: 'badge viewers' }, v.duration || ''),
      v.type && v.type !== 'archive' ? el('span', { class: 'badge kind' }, v.type) : null),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, v.title || 'Untitled'),
      el('div', { class: 'card-meta' }, `${fmtDate(v.created_at)} · ${fmtViewers(v.view_count)} views`)));
}

/**
 * A Continue watching card (shared/continue-watching.js): the VOD's picture with a progress bar along its bottom and
 * "x min left"; the channel, the title and when it was last watched. A plays from the saved position; X (or a
 * long-press) calls onMenu (Remove from Continue watching).
 */
export function continueCard(item, onSelect, onMenu) {
  const v = item.video;
  const p = cwProgress(item.position, item.duration);
  const img = v.thumbnail_url ? thumb(v.thumbnail_url, 440, 248) : '';
  const card = el('button', { class: 'card card-cw focusable', type: 'button', onclick: () => onSelect(item), dataset: { focusKey: `cw-${item.id}`, cwId: item.id }, 'aria-label': `${v.user_name || v.user_login}: ${v.title || 'Video'}, ${p.label}` },
    el('div', { class: 'card-thumb' },
      img ? el('img', { src: img, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-missing' }, 'Video'),
      el('span', { class: 'badge cw-left' }, p.label),
      el('div', { class: 'cw-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p.fraction * 100)) },
        el('div', { class: 'cw-progress-fill', style: `width: ${(p.fraction * 100).toFixed(1)}%` }))),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, v.user_name || v.user_login || ''),
      el('div', { class: 'card-sub' }, v.title || 'Untitled'),
      el('div', { class: 'card-meta' }, `Watched ${fmtAgo(item.at)}`)));
  return onLongPress(card, () => onMenu(item));
}

/** A clip (Helix /clips item): its picture, length and views; who clipped it and when. */
export function clipCard(c, onSelect) {
  return el('button', { class: 'card card-clip focusable', type: 'button', onclick: () => onSelect(c), dataset: { focusKey: `clip-${c.id}` } },
    el('div', { class: 'card-thumb' },
      c.thumbnail_url ? el('img', { src: c.thumbnail_url, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-missing' }, 'Clip'),
      el('span', { class: 'badge viewers' }, fmtLength(c.duration)),
      el('span', { class: 'badge clip-views' }, `${fmtViewers(c.view_count)} views`)),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, c.title || 'Untitled clip'),
      el('div', { class: 'card-meta' }, [c.creator_name ? `Clipped by ${c.creator_name}` : null, fmtDate(c.created_at)].filter(Boolean).join(' · '))));
}

/**
 * A row of filter pills (one is on), e.g. the Videos tab's Past broadcasts / Highlights / Uploads. Focusable and
 * tappable; A or a tap picks one. @returns {{ el, set(value) }}
 */
export function filterPills({ items, value, onPick, key, label }) {
  const row = el('div', { class: 'pills', role: 'radiogroup', 'aria-label': label || null, dataset: { focusGroup: key } });
  const paint = () => {
    for (const b of row.children) {
      const on = b.dataset.value === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  for (const it of items) {
    row.append(el('button', {
      class: 'pill focusable', type: 'button', role: 'radio', dataset: { value: it.value, focusKey: `${key}-${it.value}` },
      onclick: () => { if (value === it.value) return; value = it.value; paint(); onPick(it.value); },
    }, it.label));
  }
  paint();
  return { el: row, set(v) { value = v; paint(); }, get value() { return value; } };
}

/**
 * The current sort of a list, as a small chip ("Y sort: Most viewers") that a tap or click also cycles. Not .focusable:
 * the D-pad skips it, Y cycles from anywhere in the list.
 */
export function sortChip(onClick) {
  const label = el('span', { class: 'sort-chip-label' });
  const chip = el('button', { class: 'sort-chip', type: 'button', tabindex: '-1', onclick: () => onClick() }, hint('{Y} sort: '), label);
  return { el: chip, set(text) { label.textContent = text; chip.setAttribute('aria-label', `Sort: ${text}`); } };
}

/**
 * A list's sort: the saved choice (settings key), its chip and Y to cycle. onChange(value) re-sorts the list (keeping the
 * focus position). @param {{key: string, sorts: {value, label}[], fallback?: string, onChange: (value: string) => void}} o
 */
export function listSort({ key, sorts, fallback = sorts[0].value, onChange }) {
  let value = sorts.some((x) => x.value === state.settings[key]) ? state.settings[key] : fallback;
  const chip = sortChip(() => s.cycle());
  chip.set(sortLabel(sorts, value));
  const s = {
    chip: chip.el,
    get value() { return value; },
    cycle() {
      value = nextSort(sorts, value);
      chip.set(sortLabel(sorts, value));
      saveSettings({ [key]: value });
      toast(`Sorted: ${sortLabel(sorts, value)}`, 1500);
      onChange(value);
    },
  };
  return s;
}

/** Streams with a small game header before each game's group ("By game"); headers have `header: true`. */
export function withGameHeaders(list) {
  return groupByGame(list).flatMap((g) => [{ header: true, id: `game:${g.id}`, name: g.name, count: g.items.length }, ...g.items]);
}
export function gameHeader(h) {
  return el('div', { class: 'grid-group', role: 'heading', 'aria-level': '3' }, h.name, el('span', { class: 'grid-group-count' }, String(h.count)));
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
 * @param {{fetchPage: (cursor) => Promise<{items, cursor}>, card: (item) => HTMLElement, empty: string|HTMLElement, nav: object, filter?: (items) => items, sort?: (items) => items}} opts
 *   sort: the order of everything loaded so far (re-applied after each page and by resort()).
 * @returns {{resort: () => void}} resort(): re-orders the cards after the sort changed; focus stays in the same slot.
 */
export function pagedGrid(host, opts) {
  const grid = el('div', { class: 'grid' });
  host.append(grid);
  grid.append(el('div', { class: 'loading' }, 'Loading…'));
  let more = null;
  const seen = new Set();
  const items = [];
  const nodes = new Map(); // item → card
  const order = () => {
    if (!opts.sort) return;
    for (const it of opts.sort(items)) grid.insertBefore(nodes.get(it), more);
  };
  const load = async (cursor) => {
    const { items: page, cursor: next } = await opts.fetchPage(cursor);
    const fresh = page.filter((it) => {
      const key = it.id || it.user_id || JSON.stringify(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const it of (opts.filter ? opts.filter(fresh) : fresh)) {
      const card = opts.card(it);
      items.push(it);
      nodes.set(it, card);
      grid.insertBefore(card, more);
    }
    order();
    return next;
  };
  const ctl = {
    resort() {
      if (!opts.sort || !items.length) return;
      const cards = () => [...grid.children].filter((n) => n !== more && n.classList.contains('focusable'));
      const active = document.activeElement;
      const idx = active && grid.contains(active) ? cards().indexOf(active) : -1;
      const scroller = grid.closest('#content');
      const top = scroller ? scroller.scrollTop : 0;
      order();
      if (idx >= 0) {
        const slot = cards()[idx];
        if (slot) slot.focus({ preventScroll: true });
        if (scroller) scroller.scrollTop = top;
        setTimeout(refreshMarquee, 60);
      }
    },
  };
  (async () => {
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
            // Focus goes to the slot "Load more" was in (the first new card, unless a sort moved things around).
            const firstNew = grid.children.length - 1;
            cursor = await load(cursor);
            const target = grid.children[firstNew];
            if (target && target !== more) focusEl(target);
          } catch (e) {
            console.warn('load more failed', e);
          }
          more.disabled = false;
          more.textContent = 'Load more';
          if (!cursor) { more.remove(); more = null; }
        }, { class: 'card card-more' });
        grid.append(more);
      }
    } catch (e) {
      console.warn('grid load failed', e);
      grid.replaceWith(errorState(e, opts.nav));
    }
  })();
  return ctl;
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
    // The slot counts cards only (group headers aren't focusable).
    const cards = () => [...this.el.children].filter((n) => n.classList.contains('focusable'));
    const idx = card ? cards().indexOf(card) : -1;
    const scroller = this.el.closest('#content') || document.scrollingElement;
    const top = scroller ? scroller.scrollTop : 0;
    this.paint({ noRefocus: true });
    if (idx >= 0) {
      const now = cards();
      const slot = now[Math.min(idx, now.length - 1)];
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
