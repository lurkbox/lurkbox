import { el, button, fmtViewers, fmtUptime } from '../ui.js';
import { hint } from '../input.js';
import { tw } from '../api.js';
import { pagedGrid, videoCard, errorState } from '../grid.js';
import { followButton } from '../follow.js';

/** Channel page: live status plus VODs. */
export function channelView({ login, id, name }) {
  return {
    id: `channel:${login}`,
    title: name || login,
    async mount(host, nav) {
      const header = el('header', { class: 'view-header channel-header' }, el('h1', {}, name || login), hint('{B} back'));
      const live = el('div', { class: 'channel-live' }, el('div', { class: 'loading' }, 'Loading…'));
      const vods = el('div', { class: 'channel-vods' });
      host.append(header, live, el('h2', { class: 'section-title' }, 'Videos'), vods);
      try {
        const user = id ? { id, login, display_name: name } : await tw.userByLogin(login);
        if (!user) {
          live.replaceChildren(el('div', { class: 'empty' }, el('p', {}, `No channel called "${login}".`)));
          return;
        }
        if (user.profile_image_url) header.prepend(el('img', { class: 'avatar', src: user.profile_image_url, alt: '' }));
        if (window.lurkbox.followChannel) header.querySelector('h1').after(followButton({ login: user.login || login, id: user.id, name: user.display_name || name || login }, nav));
        const stream = await tw.streamByUserId(user.id);
        live.replaceChildren(stream
          ? el('div', { class: 'live-row' },
            button(`Watch live: ${stream.title || ''}`.trim(), () => nav.playStream(stream, [stream]), { class: 'primary big watch-live' }),
            el('div', { class: 'card-meta' }, `${stream.game_name || ''} · ${fmtViewers(stream.viewer_count)} watching · up ${fmtUptime(stream.started_at)}`))
          : el('div', { class: 'live-row' },
            el('p', {}, 'Offline'),
            button('Open player anyway', () => nav.playChannel({ login: user.login || login, name: user.display_name || name, userId: user.id }))));
        pagedGrid(vods, {
          nav,
          fetchPage: (c) => tw.videos(user.id, c),
          card: (v) => videoCard(v, (x) => nav.playVideo(x)),
          empty: 'No videos.',
        });
      } catch (e) {
        live.replaceChildren(errorState(e, nav));
      }
    },
  };
}
