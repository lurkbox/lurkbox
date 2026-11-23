import { el, button, toast } from '../ui.js';
import { state, saveSettings } from '../state.js';
import { tw } from '../api.js';
import { KeyedGrid, channelCard, gameCard, errorState, listSort, onLongPress } from '../grid.js';
import { categoryStreamsView } from './categories.js';
import { searchesFor, recordSearch, deleteSearch, clearSearches } from '../../shared/search-history.js';
import { SEARCH_SORTS, sortSearch } from '../../shared/sorts.js';
import { Poller, loadPages } from '../refresher.js';
import { focusEl } from '../focus.js';
import { openKeyboard } from '../osk.js';
import { hint, X } from '../input.js';

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
let lastQuery = '';

export function searchView() {
  let poller = null;
  let stopPoller = () => {};
  return {
    id: 'search',
    title: 'Search',
    destroy() { stopPoller(); },
    onAction(action) {
      const a = document.activeElement;
      if (action === X && a && a.classList.contains('search-recent') && this.forget) { this.forget(a); return true; }
      if (action !== 'Y' || !this.resort || a?.tagName === 'INPUT') return false;
      this.sort.cycle();
      return true;
    },
    mount(host, nav) {
      stopPoller = () => { if (poller) { poller.stop(); nav.unregisterPoller(poller); poller = null; } };
      const input = el('input', {
        class: 'text-input focusable search-input',
        type: 'text',
        placeholder: 'Channel or category',
        value: lastQuery,
        spellcheck: 'false',
        autocomplete: 'off',
        'data-osk': 'Search',
      });
      const results = el('div', { class: 'search-results' });
      this.resort = null;
      const sort = this.sort = listSort({ key: 'searchSort', sorts: SEARCH_SORTS, fallback: 'live', onChange: () => this.resort && this.resort() });
      const watchBtn = button('Watch channel directly', () => watchDirect(), { class: 'watch-direct' });

      // ---- search history (per account; Settings → General turns it off) ----
      const me = () => (state.auth.signedIn && state.auth.user ? String(state.auth.user.id) : null);
      const historyOn = () => state.settings.searchHistoryOn !== false && !!me();
      /** Remembers the query and what was picked from its results. */
      const remember = (q, pick) => {
        if (!historyOn()) return;
        saveSettings({ searchHistory: recordSearch(state.settings.searchHistory, me(), q, pick) }).catch(() => {});
      };
      const showHistory = (focusIndex = null) => {
        results.replaceChildren();
        if (!historyOn()) return;
        const list = searchesFor(state.settings.searchHistory, me());
        if (!list.length) { results.append(el('p', { class: 'hint search-recent-empty' }, 'Your recent searches show here.')); return; }
        const items = list.map((e) => button([
          el('span', { class: 'search-recent-q' }, e.q),
          e.pick ? el('span', { class: 'search-recent-pick' }, `${e.pick.kind === 'category' ? 'Category' : 'Channel'}: ${e.pick.name}`) : null,
        ], () => { input.value = e.q; run(); }, { class: 'search-recent', dataset: { q: e.q }, 'aria-label': `Search again: ${e.q}` }))
          .map((b) => onLongPress(b, () => this.forget(b))); // touch: a long-press deletes it (X on a controller)
        const clearBtn = button('Clear history', async () => {
          await saveSettings({ searchHistory: clearSearches(state.settings.searchHistory, me()) });
          showHistory();
          focusEl(input);
        }, { class: 'search-recent-clear' });
        results.append(
          el('h2', { class: 'section-title search-recent-title' }, 'Recent searches ', el('span', { class: 'hint' }, hint('{A} search again · {X} delete'))),
          el('div', { class: 'search-recent-list' }, items, clearBtn));
        if (focusIndex != null) focusEl(items[Math.min(focusIndex, items.length - 1)] || clearBtn);
      };
      // X on a recent search deletes it; the focus stays in the same place in the list.
      this.forget = async (node) => {
        const i = [...results.querySelectorAll('.search-recent')].indexOf(node);
        await saveSettings({ searchHistory: deleteSearch(state.settings.searchHistory, me(), node.dataset.q) });
        if (!results.contains(node)) return; // a search started meanwhile
        showHistory(i);
        if (!results.querySelector('.search-recent')) focusEl(input);
      };

      const run = () => {
        const q = input.value.trim();
        lastQuery = q;
        stopPoller();
        this.resort = null;
        results.replaceChildren();
        if (!q) { showHistory(); return; }
        if (!state.auth.signedIn) {
          results.append(el('div', { class: 'empty' },
            el('p', {}, 'Sign in to search. You can still watch a channel by its exact name.'),
            button('Sign in', () => nav.signIn(), { class: 'primary' })));
          return;
        }
        // Results refresh in place (live badges, titles) like Following and Browse; "Load more" adds a page.
        const status = el('span', { class: 'refresh-status' });
        const gridEl = el('div', { class: 'grid' }, el('div', { class: 'loading' }, 'Loading…'));
        const emptyEl = el('div', { class: 'empty', hidden: true }, el('p', {}, `No channels match "${q}".`));
        const grid = new KeyedGrid(gridEl, {
          key: (c) => c.id,
          render: (c) => channelCard(c, (x) => {
            remember(q, { kind: 'channel', id: x.id, login: x.broadcaster_login, name: x.display_name || x.broadcaster_login });
            nav.openChannel({ login: x.broadcaster_login, id: x.id, name: x.display_name });
          }),
        });
        // Matching categories, above the channels (one request, not refreshed).
        const catTitle = el('h2', { class: 'section-title search-cat-title', hidden: true }, 'Categories');
        const catGrid = el('div', { class: 'grid search-categories', hidden: true });
        tw.searchCategories(q).then(({ items }) => {
          if (lastQuery !== q || !items.length || !catGrid.isConnected) return;
          catGrid.append(...items.slice(0, 6).map((g) => gameCard(g, (x) => {
            remember(q, { kind: 'category', id: x.id, name: x.name });
            nav.push(categoryStreamsView(x));
          })));
          catTitle.hidden = catGrid.hidden = false;
        }).catch(() => { /* channels still show */ });
        let pages = 1;
        let focusIndex = null;
        let pendingMore = false;
        const more = button('Load more', () => {
          pages++;
          focusIndex = grid.items.length;
          more.disabled = true;
          more.textContent = 'Loading…';
          if (poller.inFlight) pendingMore = true; // a refresh is running; fetch again right after it
          else poller.tick();
        }, { class: 'card card-more', hidden: true });
        results.append(catTitle, catGrid, el('div', { class: 'search-results-head' }, el('h2', { class: 'section-title' }, 'Channels'), sort.chip, status), gridEl, el('div', { class: 'grid' }, more), emptyEl);
        let raw = [];
        this.resort = () => grid.set(sortSearch(raw, sort.value), { keepPosition: true });
        stopPoller();
        poller = new Poller({
          intervalMs: (Number(state.settings.refreshInterval) || 15) * 1000,
          canRun: () => nav.canPoll(),
          isBusy: () => nav.isNavigating(),
          onStatus: (st) => { status.textContent = st === 'offline' ? 'Offline, retrying…' : st === 'ratelimited' ? 'Rate limited, waiting…' : ''; },
          load: () => loadPages((c) => tw.searchChannels(q, c), pages),
          apply: (r) => {
            if (pendingMore) { pendingMore = false; setTimeout(() => poller && poller.tick(), 0); return; }
            gridEl.querySelector('.loading')?.remove();
            raw = r.items;
            grid.set(sortSearch(raw, sort.value));
            emptyEl.hidden = r.items.length > 0;
            more.hidden = !r.cursor;
            more.disabled = false;
            more.textContent = 'Load more';
            if (focusIndex != null) {
              const target = gridEl.children[focusIndex] || (more.hidden ? gridEl.lastElementChild : null);
              focusIndex = null;
              if (target) focusEl(target);
            }
          },
        });
        const origLoad = poller.load;
        poller.load = async () => {
          try { return await origLoad(); } catch (e) {
            if (e.code === 'NOT_SIGNED_IN' || e.code === 'NO_CLIENT_ID') { stopPoller(); gridEl.replaceWith(errorState(e, nav)); }
            throw e;
          }
        };
        nav.registerPoller(poller);
        poller.start();
      };
      const watchDirect = () => {
        const login = input.value.trim().toLowerCase().replace(/^.*twitch\.tv\//, '').replace(/[/?#].*$/, '');
        if (!LOGIN_RE.test(login)) {
          toast('Type the exact channel name first', 3000, 'warn');
          return;
        }
        lastQuery = input.value.trim();
        nav.playChannel({ login, name: login });
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(); }
      });
      // The router opens the on-screen keyboard when A is pressed on [data-osk];
      // Steam + X also works while the input is focused.
      input.addEventListener('osk-done', run);

      host.append(
        el('header', { class: 'view-header' }, el('h1', {}, 'Search')),
        el('div', { class: 'search-bar' },
          input,
          button('Keyboard', () => openKeyboard({ title: 'Search', value: input.value, onDone: (v) => { input.value = v; run(); } }), { class: 'osk-btn' }),
          button('Search', run, { class: 'primary' }),
          button('Emotes', () => nav.openEmoteSearch({ query: input.value.trim() }), { class: 'search-emotes', dataset: { focusKey: 'search-emotes' } }),
          watchBtn),
        el('p', { class: 'osk-note' }, hint('{A} on the text box opens the keyboard. Steam + X opens the Steam keyboard. A physical keyboard types directly.')),
        results);
      run(); // the last query's results, or the recent searches
    },
  };
}
