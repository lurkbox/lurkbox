// The channel page: a header (banner, avatar, name, followers, Follow, a LIVE card with Watch) and tabs: Home, Videos,
// Clips, Schedule and About. LB/RB (or the tabs themselves) switch tabs; Y sorts the Videos and Clips grids. Everything
// comes from the official Helix API (users, streams, videos, clips, schedule, channels, followers).
import { el, button, toast, fmtViewers, fmtUptime, fmtDate, thumb } from '../ui.js';
import { hint } from '../input.js';
import { tw, usersByIds } from '../api.js';
import { pagedGrid, videoCard, clipCard, errorState, listSort, filterPills } from '../grid.js';
import { VOD_SORTS, CLIP_SORTS, sortVideos, sortClips } from '../../shared/sorts.js';
import { CHANNEL_TABS, VIDEO_FILTERS, CLIP_PERIODS, validChoice, fmtSchedule, nextSegment, fmtFollowers } from '../../shared/channel-page.js';
import { followButton } from '../follow.js';
import { myClipsFor, clipShortLink } from '../../shared/my-clips.js';
import { state, saveSettings } from '../state.js';
import { focusEl } from '../focus.js';
import { shortCount } from '../player-ui.js';

/** @param {{ login: string, id?: string, name?: string, tab?: string }} c */
export function channelView({ login, id, name, tab }) {
  login = String(login || '').toLowerCase();
  return {
    id: `channel:${login}`,
    title: name || login,
    tab: validChoice(CHANNEL_TABS, tab, 'home'),
    initialFocus: '[data-focus-key=channel-watch]', // when live; else the first control
    onAction(action) {
      if ((action === 'LB' || action === 'RB') && this.showTab) { this.stepTab(action === 'RB' ? 1 : -1); return true; }
      if (action === 'Y' && this.sort) { this.sort.cycle(); return true; }
      return false;
    },
    stepTab(dir) {
      const i = CHANNEL_TABS.findIndex((t) => t.value === this.tab);
      this.showTab(CHANNEL_TABS[(i + dir + CHANNEL_TABS.length) % CHANNEL_TABS.length].value, { focusTab: true });
    },
    async mount(host, nav) {
      const view = this;
      const avatar = el('div', { class: 'channel-avatar' }, el('span', { class: 'channel-avatar-initial' }, (name || login || '?').slice(0, 1).toUpperCase()));
      const nameEl = el('h1', { class: 'channel-name' }, name || login);
      const sub = el('div', { class: 'channel-sub' });
      const actions = el('div', { class: 'channel-actions' });
      const banner = el('div', { class: 'channel-banner', 'aria-hidden': 'true' });
      const hero = el('header', { class: 'view-header channel-header channel-hero' },
        banner,
        el('div', { class: 'channel-id' }, avatar, el('div', { class: 'channel-names' }, el('div', { class: 'channel-name-row' }, nameEl), sub), actions),
        hint('{LB}/{RB} tabs · {B} back', 'hint channel-hint'));
      const tabs = el('div', { class: 'channel-tabs', role: 'tablist', 'aria-label': 'Channel' });
      const body = el('div', { class: 'channel-body', role: 'tabpanel' });
      host.append(hero, tabs, body);

      let user;
      let stream = null;
      try {
        user = id ? (await usersByIds([id])).get(String(id)) : await tw.userByLogin(login);
        if (!user && id) user = { id, login, display_name: name || login };
      } catch (e) {
        body.replaceChildren(errorState(e, nav));
        return;
      }
      if (!user) {
        body.replaceChildren(el('div', { class: 'empty' }, el('p', {}, `No channel called "${login}".`)));
        return;
      }
      const ch = { login: user.login || login, id: String(user.id), name: user.display_name || name || login };
      nameEl.textContent = ch.name;
      if (user.profile_image_url) avatar.replaceChildren(el('img', { src: user.profile_image_url, alt: '' }));
      if (user.offline_image_url) banner.style.backgroundImage = `url(${JSON.stringify(String(user.offline_image_url))})`;
      banner.classList.toggle('has-image', !!user.offline_image_url);
      const subParts = { followers: '', kind: user.broadcaster_type === 'partner' ? 'Partner' : user.broadcaster_type === 'affiliate' ? 'Affiliate' : '' };
      const paintSub = () => { sub.textContent = [subParts.followers, subParts.kind].filter(Boolean).join(' · '); };
      paintSub();
      tw.followerCount(ch.id).then((n) => { subParts.followers = fmtFollowers(n, shortCount); paintSub(); }).catch(() => {});

      // Live: the header's LIVE card (Watch).
      try { stream = await tw.streamByUserId(ch.id); } catch { stream = null; }
      const watch = () => (stream ? nav.playStream(stream, [stream]) : nav.playChannel({ login: ch.login, name: ch.name, userId: ch.id }));
      if (stream) {
        actions.append(el('div', { class: 'channel-live-card' },
          el('div', { class: 'channel-live-text' },
            el('span', { class: 'badge live inline' }, 'LIVE'),
            el('span', { class: 'channel-live-title marquee-line' }, stream.title || ''),
            el('span', { class: 'channel-live-meta' }, [stream.game_name, `${fmtViewers(stream.viewer_count)} watching`, `up ${fmtUptime(stream.started_at)}`].filter(Boolean).join(' · '))),
          button('Watch', watch, { class: 'primary watch-live', dataset: { focusKey: 'channel-watch' } })));
      }
      if (window.lurkbox.followChannel && state.auth.signedIn) nameEl.after(followButton(ch, nav));

      // Tabs.
      const tabButtons = new Map();
      for (const t of CHANNEL_TABS) {
        const b = button(t.label, () => view.showTab(t.value), { class: 'channel-tab', role: 'tab', dataset: { focusKey: `tab-${t.value}`, tab: t.value } });
        tabButtons.set(t.value, b);
        tabs.append(b);
      }
      let schedule = null; // loaded once: Home and Schedule both use it
      const loadSchedule = () => (schedule = schedule || tw.schedule(ch.id).catch((e) => ({ error: e })));

      view.showTab = (value, { focusTab = false } = {}) => {
        view.tab = validChoice(CHANNEL_TABS, value, 'home');
        view.sort = null;
        for (const [k, b] of tabButtons) {
          b.classList.toggle('selected', k === view.tab);
          b.setAttribute('aria-selected', k === view.tab ? 'true' : 'false');
        }
        body.dataset.tab = view.tab;
        body.replaceChildren();
        ({ home: renderHome, videos: renderVideos, clips: renderClips, schedule: renderSchedule, about: renderAbout })[view.tab]();
        if (focusTab) focusEl(tabButtons.get(view.tab), { instant: true });
      };

      function section(title, ...rest) {
        return el('h2', { class: 'section-title' }, title, ...rest);
      }

      function renderHome() {
        // The live stream (or the last broadcast), the next scheduled stream, recent highlights and popular clips.
        const top = el('div', { class: 'channel-home-top' });
        body.append(top);
        if (stream) {
          top.append(el('div', { class: 'channel-home-block' }, section('Live now'), el('div', { class: 'grid grid-feature' }, liveFeature(stream, watch))));
        } else {
          const last = el('div', { class: 'channel-home-block' }, section('Last broadcast'), el('div', { class: 'loading' }, 'Loading…'));
          top.append(last);
          tw.videos(ch.id, null, 'archive', 1).then(({ items }) => {
            last.querySelector('.loading')?.remove();
            last.append(items[0]
              ? el('div', { class: 'grid grid-feature' }, videoCard(items[0], (v) => nav.playVideo(v)))
              : el('p', { class: 'empty' }, 'No past broadcasts.'));
          }).catch(() => { last.querySelector('.loading')?.remove(); last.append(el('p', { class: 'empty' }, 'No past broadcasts.')); });
        }
        const next = el('div', { class: 'channel-home-block channel-next' }, section('Next stream'), el('div', { class: 'loading' }, 'Loading…'));
        top.append(next);
        loadSchedule().then((r) => {
          next.querySelector('.loading')?.remove();
          const seg = r && !r.error ? nextSegment(r.items) : null;
          next.append(seg
            ? scheduleRow(seg, { onSelect: () => view.showTab('schedule', { focusTab: true }) })
            : el('p', { class: 'empty' }, 'No schedule'));
        });
        const hl = el('div', {});
        body.append(section('Recent highlights'), hl);
        pagedGrid(hl, { nav, fetchPage: () => tw.videos(ch.id, null, 'highlight', 8).then((p) => ({ items: p.items, cursor: null })), card: (v) => videoCard(v, (x) => nav.playVideo(x)), empty: 'No highlights.' });
        const clips = el('div', {});
        const clipList = [];
        body.append(section('Popular clips', el('span', { class: 'section-note' }, 'last 30 days')), clips);
        pagedGrid(clips, {
          nav,
          fetchPage: () => tw.clips(ch.id, { period: '30d', first: 8 }).then((p) => ({ items: p.items, cursor: null })),
          card: (c) => { clipList.push(c); return clipCard(c, (x) => playClip(x, clipList)); },
          empty: 'No clips in the last 30 days.',
        });
      }

      function renderVideos() {
        let grid = null;
        const sort = view.sort = listSort({ key: 'vodSort', sorts: VOD_SORTS, onChange: () => grid && grid.resort() });
        const gridHost = el('div', {});
        const load = (type) => {
          gridHost.replaceChildren();
          grid = pagedGrid(gridHost, {
            nav,
            fetchPage: (c) => tw.videos(ch.id, c, type),
            card: (v) => videoCard(v, (x) => nav.playVideo(x)),
            sort: (items) => sortVideos(items, sort.value),
            empty: { archive: 'No past broadcasts.', highlight: 'No highlights.', upload: 'No uploads.' }[type] || 'No videos.',
          });
        };
        const filter = filterPills({
          items: VIDEO_FILTERS, key: 'vf', label: 'Video type',
          value: validChoice(VIDEO_FILTERS, state.settings.videoFilter),
          onPick: (v) => { saveSettings({ videoFilter: v }); load(v); },
        });
        body.append(el('div', { class: 'channel-toolbar' }, filter.el, sort.chip), gridHost);
        load(filter.value);
      }

      function renderClips() {
        let grid = null;
        let list = [];
        const sort = view.sort = listSort({ key: 'clipSort', sorts: CLIP_SORTS, onChange: () => grid && grid.resort() });
        const gridHost = el('div', {});
        const load = (period) => {
          gridHost.replaceChildren();
          list = [];
          grid = pagedGrid(gridHost, {
            nav,
            fetchPage: (c) => tw.clips(ch.id, { after: c, period }),
            card: (c) => { list.push(c); return clipCard(c, (x) => playClip(x, sortClips(list, sort.value))); },
            sort: (items) => sortClips(items, sort.value),
            empty: period === 'all' ? 'No clips yet.' : `No clips in the last ${CLIP_PERIODS.find((p) => p.value === period).label}.`,
          });
        };
        const period = filterPills({
          items: CLIP_PERIODS, key: 'cp', label: 'Clips from',
          value: validChoice(CLIP_PERIODS, state.settings.clipPeriod, '7d'),
          onPick: (v) => { saveSettings({ clipPeriod: v }); load(v); },
        });
        body.append(el('div', { class: 'channel-toolbar' }, period.el, sort.chip), gridHost);
        load(period.value);
        renderMyClips();
      }

      /** Clips you made of this channel (per account, newest first), above the channel's clips. */
      function renderMyClips() {
        const me = state.auth.user && state.auth.user.id;
        const mine = me ? myClipsFor(state.settings.myClips, me, ch.id) : [];
        if (!mine.length) return;
        const grid = el('div', { class: 'grid my-clips' }, el('div', { class: 'loading' }, 'Loading…'));
        const head = el('h2', { class: 'section-title my-clips-title' }, 'My clips', el('span', { class: 'section-note' }, `${mine.length}`));
        body.insertBefore(head, body.firstChild);
        head.after(grid);
        tw.clipsByIds(mine.map((c) => c.id)).catch(() => []).then((found) => {
          const byId = new Map(found.map((c) => [c.id, c]));
          const ready = mine.map((m) => byId.get(m.id)).filter(Boolean);
          grid.replaceChildren(...mine.map((m) => {
            const c = byId.get(m.id);
            if (c) return clipCard(c, (x) => playClip(x, ready));
            // Not in Helix yet (Twitch is still processing it) or deleted: its link, and a reminder.
            return clipCard({ id: m.id, title: 'Processing…', creator_name: '', created_at: new Date(m.at).toISOString(), duration: 0, view_count: 0 },
              () => toast(`Twitch is still processing this clip. Edit it at ${clipShortLink(m.id)}/edit`, 4000));
          }));
        });
      }

      function renderSchedule() {
        const list = el('div', { class: 'schedule-list' }, el('div', { class: 'loading' }, 'Loading…'));
        const tz = el('p', { class: 'hint schedule-tz' }, `Times in your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'}).`);
        body.append(tz, list);
        loadSchedule().then((r) => {
          if (r.error) { list.replaceChildren(errorState(r.error, nav)); return; }
          const rows = [];
          if (r.vacation && r.vacation.end > Date.now()) {
            rows.push(el('div', { class: 'banner schedule-vacation' }, `On a break until ${fmtDate(new Date(r.vacation.end).toISOString())}`));
          }
          if (!r.items.length) rows.push(el('div', { class: 'empty' }, el('p', {}, 'No schedule')));
          for (const seg of r.items) rows.push(scheduleRow(seg));
          list.replaceChildren(...rows);
        });
      }

      function renderAbout() {
        const facts = el('dl', { class: 'about-facts' });
        const fact = (k, v) => { if (v) facts.append(el('dt', {}, k), el('dd', {}, v)); };
        const desc = (user.description || '').trim();
        body.append(
          el('div', { class: 'about' },
            el('h2', { class: 'section-title' }, `About ${ch.name}`),
            el('p', { class: 'about-desc' }, desc || 'This channel has no description.'),
            facts));
        fact('Followers', subParts.followers.replace(/ followers?$/, ''));
        fact('Type', subParts.kind);
        if (user.created_at) fact('On Twitch since', fmtDate(user.created_at));
        tw.channelInfo(ch.id).then((info) => {
          if (!info) return;
          fact('Category', info.game_name);
          fact('Language', languageName(info.broadcaster_language));
          if (Array.isArray(info.tags) && info.tags.length) {
            facts.append(el('dt', {}, 'Tags'), el('dd', { class: 'about-tags' }, info.tags.slice(0, 10).map((t) => el('span', { class: 'tag' }, t))));
          }
        }).catch(() => {});
        // Panels and social links aren't in Twitch's public API: Twitch's own page shows them.
        if (window.lurkbox.openChannelPage) {
          body.append(el('div', { class: 'about-more' },
            el('p', { class: 'hint' }, 'Panels and social links are on the channel’s twitch.tv page.'),
            button('Open on twitch.tv', () => window.lurkbox.openChannelPage(ch.login), { dataset: { focusKey: 'about-open' } })));
        }
      }

      function playClip(c, list) {
        nav.playClip(c, list, { login: ch.login, name: ch.name });
      }

      view.showTab(view.tab);
    },
  };
}

/** The Home tab's live stream: a wide card that plays it. */
function liveFeature(s, onSelect) {
  return el('button', { class: 'card card-feature focusable', type: 'button', onclick: onSelect, dataset: { focusKey: 'home-live' } },
    el('div', { class: 'card-thumb' },
      s.thumbnail_url ? el('img', { src: thumb(s.thumbnail_url, 640, 360, 60000), alt: '' }) : null,
      el('span', { class: 'badge live' }, 'LIVE'),
      el('span', { class: 'badge viewers' }, `${fmtViewers(s.viewer_count)} watching`)),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-title' }, s.title || 'Live'),
      el('div', { class: 'card-meta' }, [s.game_name, `up ${fmtUptime(s.started_at)}`].filter(Boolean).join(' · '))));
}

/** One schedule segment: when (local time), what, the category. Focusable so the D-pad scrolls the list. */
function scheduleRow(seg, { onSelect } = {}) {
  const when = fmtSchedule(seg.start, seg.end);
  return el('button', {
    class: `schedule-row focusable${seg.canceled ? ' canceled' : ''}`, type: 'button', onclick: onSelect || null,
    dataset: { focusKey: `seg-${seg.id || seg.start}` },
  },
  el('div', { class: 'schedule-when' }, el('span', { class: 'schedule-day' }, when.day), el('span', { class: 'schedule-time' }, `${when.time} ${when.zone}`.trim())),
  el('div', { class: 'schedule-what' },
    el('span', { class: 'card-title' }, seg.title || 'Stream'),
    el('span', { class: 'card-meta' }, [seg.category ? seg.category.name : null, seg.canceled ? 'Cancelled' : null, seg.recurring ? 'Weekly' : null].filter(Boolean).join(' · '))));
}

function languageName(code) {
  if (!code || code === 'other') return '';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}
