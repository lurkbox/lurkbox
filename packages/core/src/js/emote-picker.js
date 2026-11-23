// The emote picker (opened from the chat composer): tabs Recent, Twitch (your own emotes), 7TV, BTTV and FFZ (the
// channel's and global sets the chat already loaded), and a grid of emotes. A inserts the emote's name into the
// message at the caret; LB/RB switch tabs; B closes. A search box above the tabs filters every tab by name as you type
// (any keyboard: the built-in one, Steam's or the system's); DOWN from it goes to the results. The tab lists, the
// filter and the insertion are pure and unit-tested.
import { el, button } from './ui.js';
import { emoteImg } from './chat-render.js';
import { hint } from './input.js';
import { focusEl, focusables } from './focus.js';
import { snapshotFocus, restoreFocus } from './focus-keep.js';
import { MAX_CHAT_LENGTH, chatLength } from './chat-send.js';
import { keyboardFor } from './text-entry.js';

export const TAB_LABELS = { recent: 'Recent', twitch: 'Twitch', '7tv': '7TV', bttv: 'BTTV', ffz: 'FFZ' };
/** A tab shows at most this many emotes (the grid stays quick on the TV). */
export const MAX_GRID = 400;

/**
 * Inserts an emote name at `caret` (default: the end), with a space before it unless it starts the message or
 * follows a space, and a space after it. Returns { text, caret } (caret after the space), or null when the
 * message would go over Twitch's 500 characters.
 */
export function insertEmote(text, caret, name) {
  const t = String(text || '');
  const at = Number.isInteger(caret) && caret >= 0 && caret <= t.length ? caret : t.length;
  const before = t.slice(0, at);
  const after = t.slice(at);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after.startsWith(' ') ? '' : ' ';
  const next = `${before}${pre}${name}${post}${after}`;
  if (chatLength(next.trim()) > MAX_CHAT_LENGTH) return null;
  return { text: next, caret: before.length + pre.length + name.length + 1 };
}

/**
 * The picker's tabs. src: { recents: [names], own: [Twitch emotes], sets: Map('<provider>:<scope>' → Map(name →
 * emote)) (an EmoteIndex's sets), enabled: [providers], lookup(name) → emote|null }. Third-party tabs list the
 * channel's emotes before the global ones. Disabled providers have no tab.
 */
export function pickerTabs({ recents = [], own = [], sets = new Map(), enabled = ['7tv', 'bttv', 'ffz'], lookup = () => null }) {
  const tabs = [];
  tabs.push({ key: 'recent', label: TAB_LABELS.recent, emotes: recents.map((n) => lookup(n)).filter(Boolean) });
  tabs.push({ key: 'twitch', label: TAB_LABELS.twitch, emotes: own });
  for (const p of ['7tv', 'bttv', 'ffz']) {
    if (!enabled.includes(p)) continue;
    const seen = new Set();
    const list = [];
    for (const scope of ['channel', 'global']) {
      const m = sets.get(`${p}:${scope}`);
      if (!m) continue;
      for (const e of m.values()) if (!seen.has(e.name)) { seen.add(e.name); list.push(e); }
    }
    tabs.push({ key: p, label: TAB_LABELS[p], emotes: list });
  }
  return tabs;
}

/**
 * Every tab filtered by `query`: names containing it (ignoring case and surrounding spaces), the ones starting with it
 * first, each group in the tab's order. An empty query returns the tabs as they are.
 */
export function filterTabs(tabs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return tabs;
  return tabs.map((t) => {
    const starts = [];
    const contains = [];
    for (const e of t.emotes) {
      const n = String(e.name).toLowerCase();
      if (n.startsWith(q)) starts.push(e);
      else if (n.includes(q)) contains.push(e);
    }
    return { ...t, emotes: [...starts, ...contains] };
  });
}

/** The grid's empty state: no matches for the search, still loading, or nothing in the tab. */
export function emptyNote(tab, query, loading = null) {
  const q = String(query || '').trim();
  if (q) return `No ${tab.key === 'recent' ? 'recent' : tab.label} emotes match "${q}".`;
  return loading || (tab.key === 'recent' ? 'Emotes you insert show here.' : `No ${tab.label} emotes here.`);
}

/** The first tab to show: Recent when it has emotes, else the first non-empty one, else Twitch. */
export function initialTab(tabs) {
  const recent = tabs.find((t) => t.key === 'recent');
  if (recent && recent.emotes.length) return 'recent';
  return (tabs.find((t) => t.emotes.length) || tabs.find((t) => t.key === 'twitch') || tabs[0]).key;
}

/**
 * DOM. o: { tabs: () => tabs (re-read on update), onPick(emote), draft: () => string, loading: () => string|null }.
 * build() returns { title, body, initial, update, onAction(action, source) } for a Popover.
 */
export class EmotePicker {
  constructor(o) {
    this.o = o;
    this.tab = null;
    this.query = '';
  }

  build() {
    this.search = el('input', {
      class: 'text-input focusable ep-search', type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search',
      placeholder: 'Search emotes', 'aria-label': 'Search emotes', maxlength: '50', dataset: { focusKey: 'ep-search' },
    });
    // Every keyboard ends in an input event (typing, Steam's keyboard, the built-in one's Done, the system one).
    this.search.addEventListener('input', () => { if (this.search.value !== this.query) { this.query = this.search.value; this.update(); } });
    this.tabsRow = el('div', { class: 'ep-tabs', role: 'tablist' });
    this.draft = el('div', { class: 'ep-draft' });
    this.grid = el('div', { class: 'ep-grid' });
    this.body = el('div', { class: 'po-pop-body ep' }, this.search, this.tabsRow, this.draft, this.grid,
      el('div', { class: 'po-pop-note ep-hint' }, hint('{A} insert · {LB}/{RB} tab · {B} close')));
    this.update();
    return {
      title: 'Emotes',
      body: this.body,
      initial: () => this.grid.querySelector('.ep-emote') || this.tabsRow.querySelector('.ep-tab.selected'),
      update: () => this.update(),
      onAction: (a, source) => this.onAction(a, source),
    };
  }

  current() { return this.lastTabs.find((t) => t.key === this.tab) || this.lastTabs[0]; }

  update() {
    const all = this.o.tabs();
    if (!this.tab || !all.some((t) => t.key === this.tab)) this.tab = initialTab(all);
    const tabs = filterTabs(all, this.query);
    this.lastTabs = tabs;
    const snap = snapshotFocus(this.body, focusables(this.body));
    // Tabs.
    const sig = tabs.map((t) => `${t.key}:${t.emotes.length}`).join(',') + `|${this.tab}`;
    if (this.tabsRow.dataset.sig !== sig) {
      this.tabsRow.dataset.sig = sig;
      this.tabsRow.replaceChildren(...tabs.map((t) => button(`${t.label}${t.emotes.length ? ` ${t.emotes.length > 999 ? '999+' : t.emotes.length}` : ''}`, () => this.select(t.key), {
        class: `ep-tab${t.key === this.tab ? ' selected' : ''}`, role: 'tab', 'aria-selected': t.key === this.tab ? 'true' : 'false',
        dataset: { focusKey: `ep-tab-${t.key}`, tab: t.key },
      })));
    }
    // The message so far (its end), so you see what you are building.
    const d = this.o.draft ? this.o.draft() : '';
    this.draft.textContent = d ? (d.length > 60 ? `…${d.slice(-60)}` : d) : 'Your message is empty';
    this.draft.classList.toggle('empty', !d);
    // Grid.
    const tab = this.current();
    const gsig = `${tab.key}:${this.query.trim().toLowerCase()}:${tab.emotes.length}:${tab.emotes.slice(0, 3).map((e) => e.name).join(',')}:${this.o.loading ? this.o.loading(tab.key) || '' : ''}`;
    if (this.grid.dataset.sig !== gsig) {
      this.grid.dataset.sig = gsig;
      const loading = this.o.loading ? this.o.loading(tab.key) : null;
      if (!tab.emotes.length) {
        this.grid.replaceChildren(el('div', { class: 'po-pop-note ep-empty' }, emptyNote(tab, this.query, loading)));
      } else {
        const list = tab.emotes.slice(0, MAX_GRID);
        this.grid.replaceChildren(...list.map((e) => el('button', {
          type: 'button', class: 'ep-emote focusable', title: e.name, 'aria-label': e.name,
          dataset: { focusKey: `ep-${tab.key}-${e.name}` }, onclick: () => this.o.onPick(e),
        }, emoteImg(e))), ...(tab.emotes.length > MAX_GRID ? [el('div', { class: 'po-pop-note ep-more' }, `+${tab.emotes.length - MAX_GRID} more`)] : []));
      }
    }
    restoreFocus(this.body, snap, focusables(this.body), (n) => focusEl(n, { instant: true }));
  }

  select(key, { focusGrid = false, keepFocus = false } = {}) {
    if (key === this.tab) return;
    this.tab = key;
    this.update();
    if (keepFocus) return;
    const target = focusGrid ? this.grid.querySelector('.ep-emote') : null;
    focusEl(target || this.tabsRow.querySelector(`[data-tab="${key}"]`), { instant: true });
  }

  /** The search box takes A (a keyboard; a physical Enter goes to the results) and DOWN (to the results). */
  onSearchAction(a, source) {
    if (a === 'A' && source !== 'key') {
      keyboardFor(this.search, { title: 'Search emotes', maxLength: 50 });
      return true;
    }
    if (a === 'A' || a === 'DOWN') {
      focusEl(this.grid.querySelector('.ep-emote') || this.tabsRow.querySelector('.ep-tab.selected'), { instant: true });
      return true;
    }
    return a === 'UP'; // nothing above it
  }

  onAction(a, source) {
    if (document.activeElement === this.search && this.onSearchAction(a, source)) return true;
    if (a !== 'LB' && a !== 'RB') return false;
    const keys = this.lastTabs.map((t) => t.key);
    const i = keys.indexOf(this.tab);
    const inGrid = this.grid.contains(document.activeElement);
    const inSearch = document.activeElement === this.search;
    this.select(keys[(i + (a === 'RB' ? 1 : -1) + keys.length) % keys.length], { focusGrid: inGrid, keepFocus: inSearch });
    return true;
  }
}
