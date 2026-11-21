import { el } from '../ui.js';
import { hint } from '../input.js';
import { tw } from '../api.js';
import { pagedGrid, gameCard } from '../grid.js';
import { liveListView } from '../live-list.js';

export function categoriesView() {
  return {
    id: 'categories',
    title: 'Categories',
    mount(host, nav) {
      host.append(el('header', { class: 'view-header' }, el('h1', {}, 'Top categories')));
      pagedGrid(host, {
        nav,
        fetchPage: (c) => tw.topGames(c),
        card: (g) => gameCard(g, (x) => nav.push(categoryStreamsView(x))),
        empty: 'No categories found.',
      });
    },
  };
}

export function categoryStreamsView(game) {
  return liveListView({
    id: `category:${game.id}`,
    title: game.name,
    header: () => el('header', { class: 'view-header' }, el('h1', {}, game.name), hint('{B} back')),
    load: () => tw.streamsByGame(game.id),
    empty: 'Nobody is live in this category right now.',
  });
}
