// Sort orders for the lists (pure, unit-tested; settings.js validates the saved choices against these). Every sort is
// stable and falls back to A–Z, so a refresh with equal values never shuffles the cards.

/** Following → Live. */
export const LIVE_SORTS = [
  { value: 'viewers', label: 'Most viewers' },
  { value: 'started', label: 'Recently started' },
  { value: 'longest', label: 'Live longest' },
  { value: 'az', label: 'A–Z' },
  { value: 'game', label: 'By game' },
];
/** Browse and a category's streams. */
export const STREAM_SORTS = [
  { value: 'viewers', label: 'Viewers' },
  { value: 'newest', label: 'Newest' },
  { value: 'az', label: 'A–Z' },
];
/** A channel page's videos. */
export const VOD_SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'views', label: 'Most viewed' },
  { value: 'longest', label: 'Longest' },
];
/** A channel's clips (Helix returns them by views). */
export const CLIP_SORTS = [
  { value: 'views', label: 'Most viewed' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];
/** Search results (Relevance is Twitch's own order). */
export const SEARCH_SORTS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'live', label: 'Live first' },
  { value: 'az', label: 'A–Z' },
];

/** The settings key, its list and its default for each sorted list. */
export const SORT_SETTINGS = {
  liveSort: { sorts: LIVE_SORTS, fallback: 'viewers' },
  streamSort: { sorts: STREAM_SORTS, fallback: 'viewers' },
  vodSort: { sorts: VOD_SORTS, fallback: 'newest' },
  searchSort: { sorts: SEARCH_SORTS, fallback: 'live' },
  clipSort: { sorts: CLIP_SORTS, fallback: 'views' },
};

/** A saved value if it is one of `sorts`, else the fallback. */
export function validSort(sorts, value, fallback = sorts[0].value) {
  return sorts.some((s) => s.value === value) ? value : fallback;
}
export function sortLabel(sorts, value) {
  return (sorts.find((s) => s.value === value) || sorts[0]).label;
}
/** The next sort after `value` (wraps). */
export function nextSort(sorts, value) {
  const i = sorts.findIndex((s) => s.value === value);
  return sorts[(i + 1) % sorts.length].value;
}

const lower = (s) => String(s || '').toLowerCase();
const cmpText = (a, b) => lower(a).localeCompare(lower(b));
const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
const streamName = (s) => s.user_name || s.user_login || '';
const byStreamName = (a, b) => cmpText(streamName(a), streamName(b));
const byViewers = (a, b) => (Number(b.viewer_count) || 0) - (Number(a.viewer_count) || 0) || byStreamName(a, b);

/** Live streams (Helix /streams items). mode: a LIVE_SORTS or STREAM_SORTS value. */
export function sortStreams(list, mode) {
  const out = [...list];
  switch (mode) {
    case 'started': case 'newest': return out.sort((a, b) => time(b.started_at) - time(a.started_at) || byStreamName(a, b));
    case 'longest': return out.sort((a, b) => time(a.started_at) - time(b.started_at) || byStreamName(a, b));
    case 'az': return out.sort(byStreamName);
    case 'game': return groupByGame(list).flatMap((g) => g.items);
    default: return out.sort(byViewers);
  }
}

/**
 * Streams grouped by game for "By game": games A–Z (streams without a game last, as "No category"), most viewers first
 * inside each game.
 */
export function groupByGame(list) {
  const groups = new Map();
  for (const s of list) {
    const key = s.game_id || s.game_name || '';
    if (!groups.has(key)) groups.set(key, { id: key, name: s.game_name || '', items: [] });
    groups.get(key).items.push(s);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, name: g.name || 'No category', items: g.items.sort(byViewers) }))
    .sort((a, b) => (a.id === '') - (b.id === '') || cmpText(a.name, b.name));
}

/** Twitch VOD duration ("3h2m1s") in seconds. */
function durationSec(d) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(d || ''));
  return m ? (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0) : 0;
}

/** Videos (Helix /videos items). mode: a VOD_SORTS value. */
export function sortVideos(list, mode) {
  const out = [...list];
  const title = (a, b) => cmpText(a.title, b.title);
  switch (mode) {
    case 'oldest': return out.sort((a, b) => time(a.created_at) - time(b.created_at) || title(a, b));
    case 'views': return out.sort((a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0) || time(b.created_at) - time(a.created_at));
    case 'longest': return out.sort((a, b) => durationSec(b.duration) - durationSec(a.duration) || time(b.created_at) - time(a.created_at));
    default: return out.sort((a, b) => time(b.created_at) - time(a.created_at) || title(a, b));
  }
}

/** Clips (Helix /clips items). mode: a CLIP_SORTS value. Ties: more views, then newer, then title. */
export function sortClips(list, mode) {
  const out = [...list];
  const views = (a, b) => (Number(b.view_count) || 0) - (Number(a.view_count) || 0);
  const title = (a, b) => cmpText(a.title, b.title);
  switch (mode) {
    case 'newest': return out.sort((a, b) => time(b.created_at) - time(a.created_at) || views(a, b) || title(a, b));
    case 'oldest': return out.sort((a, b) => time(a.created_at) - time(b.created_at) || views(a, b) || title(a, b));
    default: return out.sort((a, b) => views(a, b) || time(b.created_at) - time(a.created_at) || title(a, b));
  }
}

/** Search results (Helix /search/channels items), in Twitch's order. mode: a SEARCH_SORTS value. */
export function sortSearch(list, mode) {
  const out = [...list];
  const name = (c) => c.display_name || c.broadcaster_login || '';
  if (mode === 'az') return out.sort((a, b) => cmpText(name(a), name(b)));
  if (mode === 'live') return out.sort((a, b) => Number(!!b.is_live) - Number(!!a.is_live)); // stable: relevance inside
  return out;
}
