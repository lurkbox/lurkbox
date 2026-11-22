// Search history, per account: the stored shape, its validation and the list edits (pure; ES module, shared by every
// platform: sanitizeSettings runs it in the desktop main process too).
//
// searchHistory: { [twitchUserId]: Entry[] }, newest first, at most MAX_SEARCHES per account. Entry:
//   { q: string, at: number (ms), pick?: { kind: 'channel' | 'category', id: string, login?: string, name: string } }
// One entry per query (compared without case or extra spaces); the latest pick for it wins.

export const MAX_SEARCHES = 20;
export const MAX_SEARCH_ACCOUNTS = 20;
export const MAX_QUERY_LENGTH = 100;
const ID = /^\d{1,20}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;

/** A query as stored: trimmed, inner whitespace collapsed, at most MAX_QUERY_LENGTH characters ('' when unusable). */
export function cleanQuery(q) {
  if (typeof q !== 'string') return '';
  return Array.from(q.replace(/\s+/g, ' ').trim()).slice(0, MAX_QUERY_LENGTH).join('');
}
const sameQuery = (a, b) => a.toLowerCase() === b.toLowerCase();

function cleanPick(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.kind !== 'channel' && p.kind !== 'category') return null;
  const id = String(p.id ?? '');
  if (!ID.test(id)) return null;
  const name = cleanQuery(p.name);
  if (!name) return null;
  const out = { kind: p.kind, id, name };
  if (p.kind === 'channel') {
    const login = String(p.login || '').toLowerCase();
    if (!LOGIN.test(login)) return null;
    out.login = login;
  }
  return out;
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const q = cleanQuery(e.q);
  if (!q) return null;
  const at = Number(e.at);
  const out = { q, at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0 };
  const pick = cleanPick(e.pick);
  if (pick) out.pick = pick;
  return out;
}

/** One account's list: valid entries only, deduped by query (the first, i.e. newest, wins), at most MAX_SEARCHES. */
export function sanitizeSearchList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const e = cleanEntry(raw);
    if (!e || out.some((x) => sameQuery(x.q, e.q))) continue;
    out.push(e);
    if (out.length >= MAX_SEARCHES) break;
  }
  return out;
}

/** The whole map, keyed by Twitch user id. Accounts without entries are dropped. */
export function sanitizeSearchHistory(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, list] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_SEARCH_ACCOUNTS) break;
    if (!ID.test(id)) continue;
    const l = sanitizeSearchList(list);
    if (l.length) out[id] = l;
  }
  return out;
}

/** This account's searches, newest first. */
export function searchesFor(history, userId) {
  return (history && ID.test(String(userId || '')) && Array.isArray(history[userId])) ? history[userId] : [];
}

/** The history after searching `q` (and picking `pick` from its results): moved to the top, deduped, capped. */
export function recordSearch(history, userId, q, pick = null, now = Date.now()) {
  const all = { ...(history || {}) };
  const id = String(userId || '');
  const query = cleanQuery(q);
  if (!ID.test(id) || !query) return all;
  const entry = cleanEntry({ q: query, at: now, pick });
  all[id] = [entry, ...searchesFor(all, id).filter((e) => !sameQuery(e.q, query))].slice(0, MAX_SEARCHES);
  return all;
}

/** The history without the entry for `q` on this account. */
export function deleteSearch(history, userId, q) {
  const all = { ...(history || {}) };
  const id = String(userId || '');
  if (!all[id]) return all;
  const query = cleanQuery(q);
  const left = all[id].filter((e) => !sameQuery(e.q, query));
  if (left.length) all[id] = left; else delete all[id];
  return all;
}

/** The history without this account's entries (the other accounts keep theirs). */
export function clearSearches(history, userId) {
  const all = { ...(history || {}) };
  delete all[String(userId || '')];
  return all;
}
