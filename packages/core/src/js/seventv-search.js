// Global 7TV emote search for the Emote search screen: 7TV's public v4 GraphQL API (`emotes.search`, the one 7tv.app
// uses), with no sign-in. Request building and response mapping are pure; SevenTvSearch adds the debounce, paging and
// stale-answer guard (timers and fetch injected, unit-tested). Browse only: nothing here changes a 7TV account.

export const SEVENTV_GQL = 'https://7tv.io/v4/gql';
export const PER_PAGE = 48;
/** The sort choices: [value, label, 7TV's SortBy]. */
export const SEARCH_SORTS = [
  { value: 'popular', label: 'Popular', sortBy: 'TOP_ALL_TIME' },
  { value: 'trending', label: 'Trending', sortBy: 'TRENDING_WEEKLY' },
  { value: 'newest', label: 'Newest', sortBy: 'UPLOAD_DATE' },
];

const SEARCH_QUERY = `query LurkboxEmoteSearch($query: String, $page: Int, $perPage: Int, $sort: Sort!, $filters: Filters) {
  emotes { search(query: $query, page: $page, perPage: $perPage, sort: $sort, filters: $filters) {
    totalCount pageCount
    items { id defaultName flags { animated defaultZeroWidth } owner { mainConnection { platformDisplayName } } images { url mime scale frameCount } }
  } }
}`;
const USAGE_QUERY = 'query LurkboxEmoteUsage($id: Id!) { emotes { emote(id: $id) { channels(page: 1, perPage: 1) { totalCount } } } }';

/**
 * The fetch arguments for one page. o: { query, page (1-based), perPage, sort ('popular'|'trending'|'newest'),
 * animated, zeroWidth (true: only those) }.
 */
export function buildSearchRequest({ query = '', page = 1, perPage = PER_PAGE, sort = 'popular', animated = false, zeroWidth = false } = {}) {
  const s = SEARCH_SORTS.find((x) => x.value === sort) || SEARCH_SORTS[0];
  const filters = {};
  if (animated) filters.animated = true;
  if (zeroWidth) filters.defaultZeroWidth = true;
  const variables = {
    query: String(query || '').trim().slice(0, 100) || null,
    page: Math.max(1, Math.floor(page) || 1),
    perPage: Math.min(100, Math.max(1, Math.floor(perPage) || PER_PAGE)),
    sort: { sortBy: s.sortBy, order: 'DESCENDING' },
    filters: Object.keys(filters).length ? filters : null,
  };
  return {
    url: SEVENTV_GQL,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: SEARCH_QUERY, variables }) },
  };
}

/** The best grid picture: the 2x WebP (animated unless `animated` is false), else any 2x, else the first https image. */
function pickImage(images, animated) {
  // 7TV's CDN only (the demo's pictures in demo mode).
  const list = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.url === 'string' && /^(https:\/\/cdn\.7tv\.app\/|lbhls:\/\/demo\/)/.test(i.url));
  const isStatic = (i) => /_static\./.test(i.url);
  const want = list.filter((i) => (animated ? !isStatic(i) : isStatic(i) || !/\.(gif|webp|avif)$/.test(i.url) || i.frameCount === 1));
  const pool = want.length ? want : list;
  return pool.find((i) => i.scale === 2 && i.mime === 'image/webp')
    || pool.find((i) => i.scale === 2) || pool.find((i) => i.mime === 'image/webp') || pool[0] || null;
}

/** One search item → the app's emote shape ({ provider, id, name, url, zeroWidth, animated, author }), or null. */
export function mapSearchItem(it, { animated = true } = {}) {
  if (!it || typeof it.id !== 'string' || typeof it.defaultName !== 'string' || !it.defaultName) return null;
  const anim = !!(it.flags && it.flags.animated);
  const img = pickImage(it.images, animated && anim);
  if (!img) return null;
  const owner = it.owner && it.owner.mainConnection && it.owner.mainConnection.platformDisplayName;
  return {
    provider: '7tv', id: it.id, name: it.defaultName, url: img.url, w: 0, h: 0,
    zeroWidth: !!(it.flags && it.flags.defaultZeroWidth), animated: anim,
    author: typeof owner === 'string' ? owner.slice(0, 40) : '',
  };
}

/** The GraphQL answer → { items, total, pageCount }. Throws on GraphQL errors or a missing result. */
export function mapSearchResponse(body, opts) {
  if (body && Array.isArray(body.errors) && body.errors.length) throw new Error(`7TV: ${String(body.errors[0].message || 'search failed').slice(0, 120)}`);
  const r = body && body.data && body.data.emotes && body.data.emotes.search;
  if (!r || !Array.isArray(r.items)) throw new Error('7TV: no search result');
  return {
    items: r.items.map((x) => mapSearchItem(x, opts)).filter(Boolean),
    total: Number.isFinite(r.totalCount) ? r.totalCount : 0,
    pageCount: Number.isFinite(r.pageCount) ? r.pageCount : 0,
  };
}

/** One page of results. */
export async function searchEmotes(fetchFn, o = {}) {
  const { url, init } = buildSearchRequest(o);
  const r = await fetchFn(url, init);
  if (!r.ok) throw new Error(`7TV search: HTTP ${r.status}`);
  return mapSearchResponse(await r.json(), { animated: o.animatedPictures !== false });
}

/** How many channels have the emote in their set (null when 7TV doesn't say). */
export async function emoteUsage(fetchFn, id) {
  const r = await fetchFn(SEVENTV_GQL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { id: String(id) } }),
  });
  if (!r.ok) return null;
  const b = await r.json();
  const n = b && b.data && b.data.emotes && b.data.emotes.emote && b.data.emotes.emote.channels && b.data.emotes.emote.channels.totalCount;
  return Number.isFinite(n) ? n : null;
}

/**
 * The search as you type: set() restarts it after `debounceMs` (typing), more() loads the next page (infinite scroll).
 * Answers to an older search are dropped. onChange(state) after every change; state: { query, sort, animated,
 * zeroWidth, items, total, page, pageCount, loading, error, done }.
 */
export class SevenTvSearch {
  constructor({ fetchFn = (...a) => fetch(...a), debounceMs = 350, perPage = PER_PAGE, animatedPictures = true, timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) }, onChange = () => {} } = {}) {
    this.fetch = fetchFn;
    this.debounceMs = debounceMs;
    this.perPage = perPage;
    this.animatedPictures = animatedPictures;
    this.timers = timers;
    this.onChange = onChange;
    this.gen = 0;
    this.timer = null;
    this.state = { query: '', sort: 'popular', animated: false, zeroWidth: false, items: [], total: 0, page: 0, pageCount: 0, loading: false, error: null, done: false };
  }

  /** Changes the query or options; `now` skips the debounce (Enter, a sort or filter change). */
  set(patch = {}, { now = false } = {}) {
    const next = { ...this.state, ...patch };
    const same = ['query', 'sort', 'animated', 'zeroWidth'].every((k) => (k === 'query' ? String(next.query).trim() === String(this.state.query).trim() : next[k] === this.state[k]));
    if (same && this.state.page > 0 && !now) return;
    this.state = { ...next, items: [], total: 0, page: 0, pageCount: 0, error: null, done: false, loading: true };
    this.gen++;
    this.timers.clearTimeout(this.timer);
    const gen = this.gen;
    this.onChange(this.state);
    if (now) this.load(gen, 1);
    else this.timer = this.timers.setTimeout(() => this.load(gen, 1), this.debounceMs);
  }

  /** The next page, unless one is loading, the last one is in or there was an error. */
  more() {
    const s = this.state;
    if (s.loading || s.done || s.error || s.page === 0) return false;
    this.state = { ...s, loading: true };
    this.onChange(this.state);
    this.load(this.gen, s.page + 1);
    return true;
  }

  async load(gen, page) {
    const s = this.state;
    try {
      const r = await searchEmotes(this.fetch, { query: s.query, page, perPage: this.perPage, sort: s.sort, animated: s.animated, zeroWidth: s.zeroWidth, animatedPictures: this.animatedPictures });
      if (gen !== this.gen) return;
      const seen = new Set(this.state.items.map((e) => e.id));
      const items = [...this.state.items, ...r.items.filter((e) => !seen.has(e.id))];
      this.state = { ...this.state, items, total: r.total, page, pageCount: r.pageCount, loading: false, done: page >= r.pageCount || r.items.length === 0 };
    } catch (e) {
      if (gen !== this.gen) return;
      this.state = { ...this.state, loading: false, error: e.message || String(e) };
    }
    this.onChange(this.state);
  }

  stop() { this.gen++; this.timers.clearTimeout(this.timer); }
}
