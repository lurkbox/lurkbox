import { el } from '../ui.js';
import { hint } from '../input.js';
import { tw } from '../api.js';
import { liveListView } from '../live-list.js';

export function browseView() {
  return liveListView({
    id: 'browse',
    title: 'Browse',
    header: () => el('header', { class: 'view-header' }, el('h1', {}, 'Top live streams'), hint('{Y} refresh')),
    load: () => tw.topStreams(),
    empty: 'No streams found.',
  });
}
