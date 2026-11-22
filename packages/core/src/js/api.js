// Helix helpers. Requests go through the main process, which holds the tokens.
import { state } from './state.js';
import { fetchAllPages, chunk, lastLiveFromVod } from './follows.js';
import { clipRange, scheduleSegments, vacation } from '../shared/channel-page.js';

export class ApiError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code; // 'NO_CLIENT_ID' | 'NOT_SIGNED_IN' | 'HTTP'
    this.status = status;
  }
}

export async function helix(path, query = {}, { method = 'GET', body, accountId } = {}) {
  const r = await window.lurkbox.helix({ path, query, method, body, accountId });
  if (r.ok) return r.data;
  if (r.error === 'NO_CLIENT_ID') throw new ApiError('NO_CLIENT_ID', 0, 'No Client ID set');
  if (r.error === 'NOT_SIGNED_IN' || r.status === 401) throw new ApiError('NOT_SIGNED_IN', 401, 'Not signed in');
  const e = new ApiError('HTTP', r.status, r.error);
  e.data = r.data;
  e.resetAt = r.resetAt;
  throw e;
}

const page = (res) => ({ items: res.data || [], cursor: (res.pagination && res.pagination.cursor) || null });

export const tw = {
  followedStreams: async (after) => page(await helix('/streams/followed', { user_id: state.auth.user && state.auth.user.id, first: 100, after })),
  topStreams: async (after) => page(await helix('/streams', { first: 40, after })),
  topGames: async (after) => page(await helix('/games/top', { first: 40, after })),
  streamsByGame: async (gameId, after) => page(await helix('/streams', { game_id: gameId, first: 40, after })),
  searchChannels: async (query, after) => page(await helix('/search/channels', { query, first: 40, after })),
  searchCategories: async (query, after) => page(await helix('/search/categories', { query, first: 20, after })),
  /** type: 'all' | 'archive' | 'highlight' | 'upload' (the Videos tab's filter). */
  videos: async (userId, after, type = 'all', first = 40) => page(await helix('/videos', { user_id: userId, first, type, after })),
  /** A channel's clips in a period (shared/channel-page.js CLIP_PERIODS); Helix orders them by views. */
  clips: async (broadcasterId, { after, period = 'all', now = Date.now(), first = 40 } = {}) => page(await helix('/clips', { broadcaster_id: broadcasterId, first, after, ...clipRange(period, now) })),
  clipById: async (id) => ((await helix('/clips', { id })).data || [])[0] || null,
  /**
   * The channel's stream schedule: { items: upcoming segments (scheduleSegments), cursor, vacation }. Helix answers 404
   * for a channel without a schedule, which is "no schedule", not an error.
   */
  schedule: async (broadcasterId, { after, now = Date.now(), first = 25 } = {}) => {
    try {
      const r = await helix('/schedule', { broadcaster_id: broadcasterId, first, after });
      return { items: scheduleSegments(r.data, now), cursor: (r.pagination && r.pagination.cursor) || null, vacation: vacation(r.data) };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'HTTP' && e.status === 404) return { items: [], cursor: null, vacation: null };
      throw e;
    }
  },
  /** Follower count (Helix GET /channels/followers: `total`; any user token may read it), or null. */
  followerCount: async (broadcasterId) => { const r = await helix('/channels/followers', { broadcaster_id: broadcasterId, first: 1 }); return Number.isFinite(Number(r.total)) ? Number(r.total) : null; },
  /** Channel information (title, category, tags, language). */
  channelInfo: async (broadcasterId) => ((await helix('/channels', { broadcaster_id: broadcasterId })).data || [])[0] || null,
  videoById: async (id) => ((await helix('/videos', { id })).data || [])[0] || null,
  userByLogin: async (login) => (await helix('/users', { login })).data[0] || null,
  streamByUserId: async (id) => (await helix('/streams', { user_id: id })).data[0] || null,
  streamByLogin: async (login) => (await helix('/streams', { user_login: login })).data[0] || null,
};

// ---- follows (offline + live) ----

const followCache = new Map(); // userId → { at, items }
/** Every followed channel (all pages), cached per account for 10 min. */
export async function followedChannels({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  const me = state.auth.user && state.auth.user.id;
  if (!me) return [];
  const c = followCache.get(me);
  if (c && Date.now() - c.at < maxAgeMs) return c.items;
  const items = await fetchAllPages(async (after) => page(await helix('/channels/followed', { user_id: me, first: 100, after })));
  followCache.set(me, { at: Date.now(), items });
  return items;
}
/**
 * Does the signed-in user follow this channel? Helix GET /channels/followed?user_id=<me>&broadcaster_id=<id>.
 * Resolves true/false, or null when it can't tell (signed out, error).
 */
export async function isFollowing(broadcasterId) {
  const me = state.auth.user && state.auth.user.id;
  if (!me || !broadcasterId) return null;
  try {
    const r = await helix('/channels/followed', { user_id: me, broadcaster_id: String(broadcasterId) });
    return (r.data || []).some((f) => String(f.broadcaster_id) === String(broadcasterId));
  } catch { return null; }
}
/** After a follow or unfollow: the next Following refresh (and LB/RB stepping) reloads the lists. */
export function invalidateFollows() {
  followCache.clear();
  followedCache = { at: 0, items: [], account: state.auth.active };
}
export function followsAge() {
  const c = followCache.get(state.auth.user && state.auth.user.id);
  return c ? Date.now() - c.at : Infinity;
}

const userCache = new Map(); // id → user
/** /users for many ids, in batches of 100, cached. */
export async function usersByIds(ids) {
  const missing = [...new Set(ids)].filter((id) => !userCache.has(id));
  for (const batch of chunk(missing, 100)) {
    const r = await helix('/users', { id: batch });
    for (const u of r.data || []) userCache.set(u.id, u);
  }
  return new Map(ids.filter((id) => userCache.has(id)).map((id) => [id, userCache.get(id)]));
}

const lastLiveCache = new Map(); // id → ms | null
/** Approximate end of the last broadcast (one /videos call per channel, cached). */
export async function lastLive(id) {
  if (lastLiveCache.has(id)) return lastLiveCache.get(id);
  const r = await helix('/videos', { user_id: id, type: 'archive', first: 1 });
  const v = lastLiveFromVod((r.data || [])[0]);
  lastLiveCache.set(id, v);
  return v;
}
export function lastLiveKnown() { return new Map([...lastLiveCache].filter(([, v]) => v)); }

/** Cached followed-live list, used for LB/RB channel stepping in the player. */
let followedCache = { at: 0, items: [] };
export async function followedLive(maxAgeMs = 60000) {
  if (!state.auth.signedIn) return [];
  if (followedCache.account !== state.auth.active) followedCache = { at: 0, items: [], account: state.auth.active }; // per account
  if (Date.now() - followedCache.at < maxAgeMs) return followedCache.items;
  const { items } = await tw.followedStreams();
  followedCache = { at: Date.now(), items, account: state.auth.active };
  return items;
}
export function setFollowedCache(items) { followedCache = { at: Date.now(), items, account: state.auth.active }; }
