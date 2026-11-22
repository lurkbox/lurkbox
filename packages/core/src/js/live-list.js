// A live stream grid that refreshes itself while on screen (Browse, Category). Y cycles its sort (Viewers, Newest, A–Z).
import { el } from './ui.js';
import { hint } from './input.js';
import { state } from './state.js';
import { KeyedGrid, streamCard, errorState, listSort } from './grid.js';
import { STREAM_SORTS, sortStreams } from '../shared/sorts.js';
import { Poller } from './refresher.js';

export function liveListView({ id, title, header, load, empty }) {
  let poller = null;
  return {
    id,
    title,
    destroy() { if (poller) { poller.stop(); this.nav.unregisterPoller(poller); } },
    onAction(action) { if (action === 'Y' && this.sort) { this.sort.cycle(); return true; } return false; },
    mount(host, nav) {
      this.nav = nav;
      const status = el('span', { class: 'refresh-status' });
      const gridEl = el('div', { class: 'grid' }, el('div', { class: 'loading' }, 'Loading…'));
      const emptyEl = el('div', { class: 'empty', hidden: true }, el('p', {}, empty));
      const h = header();
      let list = [];
      let raw = [];
      const sort = this.sort = listSort({ key: 'streamSort', sorts: STREAM_SORTS, onChange: () => paint({ keepPosition: true }) });
      h.append(hint('{X} channel page'), sort.chip, status);
      host.append(h, gridEl, emptyEl);
      const grid = new KeyedGrid(gridEl, { key: (s) => s.user_id || s.id, render: (s) => streamCard(s, (x) => nav.playStream(x, list)) });
      poller = new Poller({
        intervalMs: (Number(state.settings.refreshInterval) || 15) * 1000,
        canRun: () => nav.canPoll(),
        isBusy: () => nav.isNavigating(),
        onStatus: (s) => { status.textContent = s === 'offline' ? 'Offline, retrying…' : s === 'ratelimited' ? 'Rate limited, waiting…' : ''; },
        load: async () => (await load()).items,
        apply: (items) => {
          gridEl.querySelector('.loading')?.remove();
          raw = items;
          paint();
          emptyEl.hidden = items.length > 0;
        },
      });
      // The player's next/previous channel follows the order on screen.
      function paint(opts) { list = sortStreams(raw, sort.value); grid.set(list, opts); }
      const origLoad = poller.load;
      poller.load = async () => {
        try { return await origLoad(); } catch (e) {
          if (e.code === 'NOT_SIGNED_IN' || e.code === 'NO_CLIENT_ID') { poller.stop(); gridEl.replaceWith(errorState(e, nav)); }
          throw e;
        }
      };
      nav.registerPoller(poller);
      poller.start();
    },
  };
}
