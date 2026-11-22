import { el, button, toast } from '../ui.js';
import { mascotEl } from '../mascot.js';
import { hint } from '../input.js';
import { state, saveSettings } from '../state.js';
import { tw, setFollowedCache, followedChannels, followsAge, usersByIds, lastLive, lastLiveKnown, ApiError } from '../api.js';
import { KeyedGrid, streamCard, errorState, listSort, sortChip, withGameHeaders, gameHeader } from '../grid.js';
import { LIVE_SORTS, sortStreams } from '../../shared/sorts.js';
import { mergeFollows, sortOffline, SORTS, fmtAgo } from '../follows.js';
import { Poller } from '../refresher.js';

// Last data shown, per account, so coming back to Following paints instantly instead of flashing "Loading…".
let lastShown = null;

export function welcome(nav) {
  return el('div', { class: 'welcome' },
    mascotEl('welcome-mascot'),
    el('h1', { class: 'welcome-title' }, 'Lurkbox'),
    el('p', { class: 'welcome-sub' }, state.auth.needsReauth
      ? 'Lurkbox now asks for a few more permissions. Please sign in again.'
      : 'A couch and controller client for Twitch'),
    el('div', { class: 'welcome-actions' },
      button('Sign in with Twitch', () => nav.signIn(), { class: 'primary big welcome-signin' }),
      window.lurkbox.tvSignIn ? button('Sign in with your phone instead', () => nav.phoneSignIn()) : null,
      button('Watch a channel by name', () => nav.goTop('search')),
      button('Settings', () => nav.goTop('settings'))),
    el('p', { class: 'hint' }, window.lurkbox.tvSignIn
      ? 'You sign in once, here on the TV: the twitch.tv login, then Authorize for Lurkbox. That covers your follows, raids, and your subs and Turbo in the player.'
      : 'You sign in with your phone: scan the code, then Authorize for Lurkbox. That covers your follows, raids and chat.'));
}

function offlineTile(f, user, onSelect, onFocus) {
  const last = f.lastLive ? `Last live ${fmtAgo(f.lastLive)}` : 'Offline';
  return el('button', { class: 'card card-offline focusable', type: 'button', onclick: () => onSelect(f), onfocus: () => onFocus(f) },
    el('div', { class: 'card-avatar' }, el('img', { src: (user && user.profile_image_url) || '', alt: '', loading: 'lazy' })),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, (user && user.display_name) || f.broadcaster_name || f.broadcaster_login),
      el('div', { class: 'card-meta last-live' }, last)));
}

export function followingView() {
  let poller = null;
  return {
    id: 'following',
    title: 'Following',
    destroy() { if (poller) { poller.stop(); this.nav && this.nav.unregisterPoller(poller); } },
    onAction(action) {
      if (action !== 'Y' || !this.cycleSort) return false;
      this.cycleSort();
      return true;
    },
    mount(host, nav) {
      this.nav = nav;
      if (!state.auth.hasClientId) { host.append(errorState(new ApiError('NO_CLIENT_ID'), nav)); return; }
      if (!state.auth.signedIn) { host.append(welcome(nav)); return; }

      let sort = state.settings.followSort || 'recent';
      const offChip = sortChip(() => cycleOffline());
      const liveSort = listSort({ key: 'liveSort', sorts: LIVE_SORTS, onChange: () => paintLive({ keepPosition: true }) });
      const status = el('span', { class: 'refresh-status' });
      const liveGridEl = el('div', { class: 'grid' });
      const offGridEl = el('div', { class: 'grid grid-offline' });
      const liveEmpty = el('p', { class: 'empty', hidden: true }, 'Nobody you follow is live right now.');
      host.append(
        el('header', { class: 'view-header' }, el('h1', {}, 'Following'), hint('{X} channel page'), status),
        el('h2', { class: 'section-title live-title' }, 'Live ', liveSort.chip),
        liveGridEl, liveEmpty,
        el('h2', { class: 'section-title offline-title' }, 'Offline ', offChip.el),
        offGridEl);
      const cached = lastShown && lastShown.account === state.auth.active ? lastShown : null;
      if (!cached) liveGridEl.append(el('div', { class: 'loading' }, 'Loading…'));

      let liveList = [];
      let follows = [];
      let users = new Map();
      // The player's next/previous channel follows the order on screen.
      let liveSorted = [];
      const live = new KeyedGrid(liveGridEl, {
        key: (s) => (s.header ? s.id : s.user_id),
        render: (s) => (s.header ? gameHeader(s) : streamCard(s, (x) => nav.playStream(x, liveSorted))),
      });
      const paintLive = (opts) => {
        liveSorted = sortStreams(liveList, liveSort.value);
        live.set(liveSort.value === 'game' ? withGameHeaders(liveList) : liveSorted, opts);
      };
      let focusTimer = null;
      const onTileFocus = (f) => {
        clearTimeout(focusTimer);
        if (f.lastLive !== undefined) return;
        focusTimer = setTimeout(async () => { // lazy: only the focused tile, debounced
          try {
            f.lastLive = await lastLive(f.broadcaster_id);
            const n = offGridEl.querySelector(`[data-k="${f.broadcaster_id}"] .last-live`);
            if (n) n.textContent = f.lastLive ? `Last live ${fmtAgo(f.lastLive)}` : 'Offline';
          } catch { /* ignore */ }
        }, 350);
      };
      const offline = new KeyedGrid(offGridEl, {
        key: (f) => f.broadcaster_id,
        render: (f) => offlineTile(f, users.get(f.broadcaster_id), (x) => nav.openChannel({ login: x.broadcaster_login, id: x.broadcaster_id, name: x.broadcaster_name }), onTileFocus),
      });

      const paintOffline = (offList, opts) => {
        const known = lastLiveKnown();
        for (const f of offList) if (known.has(f.broadcaster_id)) f.lastLive = known.get(f.broadcaster_id);
        offChip.set((SORTS.find((s) => s.value === sort) || SORTS[0]).label);
        offline.set(sortOffline(offList, sort, known), opts);
      };
      const cycleOffline = () => {
        const i = SORTS.findIndex((s) => s.value === sort);
        sort = SORTS[(i + 1) % SORTS.length].value;
        saveSettings({ followSort: sort });
        toast(`Sorted: ${SORTS.find((s) => s.value === sort).label}`, 1500);
        paintOffline(mergeFollows(follows, liveList).offline, { keepPosition: true }); // stay where you are
      };
      // Y sorts the section that has focus: Offline when on an offline channel, else Live.
      this.cycleSort = () => (offGridEl.contains(document.activeElement) ? cycleOffline() : liveSort.cycle());

      const applyResult = (r) => {
        lastShown = { account: state.auth.active, streams: r.streams, follows: r.follows, users: r.users };
        liveGridEl.querySelector('.loading')?.remove();
        liveList = r.streams;
        follows = r.follows;
        users = r.users;
        setFollowedCache(liveList);
        paintLive();
        liveEmpty.hidden = liveList.length > 0;
        paintOffline(mergeFollows(follows, liveList).offline);
      };
      let first = true;
      poller = new Poller({
        intervalMs: (Number(state.settings.refreshInterval) || 15) * 1000,
        canRun: () => nav.canPoll(),
        isBusy: () => nav.isNavigating(),
        onStatus: (s) => { status.textContent = s === 'offline' ? 'Offline, retrying…' : s === 'ratelimited' ? 'Rate limited, waiting…' : ''; },
        load: async () => {
          // follows: at most every 10 min, or when entering if older than 2 min
          const maxAge = first ? 2 * 60 * 1000 : 10 * 60 * 1000;
          const [streams, fl] = await Promise.all([tw.followedStreams(), followsAge() > maxAge ? followedChannels({ maxAgeMs: 0 }) : followedChannels()]);
          first = false;
          const merged = mergeFollows(fl, streams.items);
          const u = await usersByIds(merged.offline.map((f) => f.broadcaster_id)).catch(() => users);
          return { streams: streams.items, follows: fl, users: u };
        },
        apply: applyResult,
      });
      if (cached) applyResult(cached);
      nav.registerPoller(poller);
      poller.start();
    },
  };
}
