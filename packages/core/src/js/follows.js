// Follow-list helpers (pure; unit-tested).

/** Loads every page of a cursor-paginated endpoint. fetchPage(cursor) → {items, cursor}. */
export async function fetchAllPages(fetchPage, maxPages = 100) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const { items, cursor: next } = await fetchPage(cursor);
    all.push(...items);
    if (!next || !items.length) break;
    cursor = next;
  }
  return all;
}

export function chunk(list, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Splits follows into live streams and offline channels. A channel that is live
 * appears only in `live` (live wins); live streams of channels not in the follow
 * list (shouldn't happen) are kept too.
 */
export function mergeFollows(follows, liveStreams) {
  const liveIds = new Set(liveStreams.map((s) => s.user_id));
  const seen = new Set();
  const offline = [];
  for (const f of follows) {
    if (liveIds.has(f.broadcaster_id) || seen.has(f.broadcaster_id)) continue;
    seen.add(f.broadcaster_id);
    offline.push(f);
  }
  return { live: liveStreams, offline };
}

export const SORTS = [
  { value: 'recent', label: 'Recently live' },
  { value: 'az', label: 'A–Z' },
  { value: 'followed', label: 'Followed date' },
];

/** Sorts offline follows. lastLive: Map id → ms epoch (unknown = missing). */
export function sortOffline(list, mode, lastLive = new Map()) {
  const name = (f) => (f.broadcaster_name || f.broadcaster_login || '').toLowerCase();
  const az = (a, b) => name(a).localeCompare(name(b));
  const out = [...list];
  if (mode === 'az') return out.sort(az);
  if (mode === 'followed') return out.sort((a, b) => Date.parse(b.followed_at || 0) - Date.parse(a.followed_at || 0) || az(a, b));
  // recent: known last-live times first (newest first), then alphabetical
  return out.sort((a, b) => {
    const la = lastLive.get(a.broadcaster_id);
    const lb = lastLive.get(b.broadcaster_id);
    if (la && lb) return lb - la;
    if (la) return -1;
    if (lb) return 1;
    return az(a, b);
  });
}

/** Twitch VOD duration ("3h2m1s") in ms. */
export function parseDuration(d) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(d || ''));
  if (!m) return 0;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
}

/** Approximate end of the last broadcast from its archive VOD. */
export function lastLiveFromVod(vod) {
  if (!vod) return null;
  const start = Date.parse(vod.created_at);
  return Number.isFinite(start) ? start + parseDuration(vod.duration) : null;
}

export function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
