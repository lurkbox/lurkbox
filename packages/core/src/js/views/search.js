import { el, button, toast } from '../ui.js';
import { state } from '../state.js';
import { tw } from '../api.js';
import { KeyedGrid, channelCard, errorState, listSort } from '../grid.js';
import { SEARCH_SORTS, sortSearch } from '../../shared/sorts.js';
import { Poller, loadPages } from '../refresher.js';
import { focusEl } from '../focus.js';
import { openKeyboard } from '../osk.js';
import { hint } from '../input.js';

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
      if (action !== 'Y' || !this.resort || document.activeElement?.tagName === 'INPUT') return false;
      this.sort.cycle();
      return true;
    },
    mount(host, nav) {
      stopPoller = () => { if (poller) { poller.stop(); nav.unregisterPoller(poller); poller = null; } };
      const input = el('input', {
        class: 'text-input focusable search-input',
        type: 'text',
        placeholder: 'Channel name',
        value: lastQuery,
        spellcheck: 'false',
        autocomplete: 'off',
        'data-osk': 'Search channels',
      });
      const results = el('div', { class: 'search-results' });
      this.resort = null;
      const sort = this.sort = listSort({ key: 'searchSort', sorts: SEARCH_SORTS, fallback: 'live', onChange: () => this.resort && this.resort() });
      const watchBtn = button('Watch channel directly', () => watchDirect(), { class: 'watch-direct' });

      const run = () => {
        const q = input.value.trim();
        lastQuery = q;
        stopPoller();
        this.resort = null;
        results.replaceChildren();
        if (!q) return;
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
        const grid = new KeyedGrid(gridEl, { key: (c) => c.id, render: (c) => channelCard(c, (x) => nav.openChannel({ login: x.broadcaster_login, id: x.id, name: x.display_name })) });
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
        results.append(el('div', { class: 'search-results-head' }, sort.chip, status), gridEl, el('div', { class: 'grid' }, more), emptyEl);
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
          button('Keyboard', () => openKeyboard({ title: 'Search channels', value: input.value, onDone: (v) => { input.value = v; run(); } })),
          button('Search', run, { class: 'primary' }),
          watchBtn),
        el('p', {}, hint('{A} on the text box opens the keyboard. Steam + X opens the Steam keyboard. A physical keyboard types directly.')),
        results);
      if (lastQuery) run();
    },
  };
}
