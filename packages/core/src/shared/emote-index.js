// The "seen channels" emote index: the channel emote sets Lurkbox has loaded (the chat and the channel page's Emotes
// tab), kept per account by the host (desktop emote-index.json, Android preferences, demo in memory) so Emote search
// can look across all of them. Pure and shared, so the host validates what it stores with the same code.
//
// One account's index: { v: 1, channels: [{ id, login, name, at, emotes: [[provider, id, name, url?]] }] }, the most
// recently seen channel first. `url` is left out when it is the provider's usual picture for that id (emoteUrl()).
// At most MAX_ENTRIES emotes in all: the least recently seen channels go first.

export const MAX_ENTRIES = 20000;
export const MAX_CHANNELS = 500;
export const INDEX_PROVIDERS = ['7tv', 'bttv', 'ffz', 'twitch'];

const LOGIN = /^[a-z0-9_]{1,25}$/;
const CH_ID = /^\d{1,20}$/;
const EMOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 100;

/** The provider's usual grid picture for an emote id. */
export function emoteUrl(provider, id) {
  const i = encodeURIComponent(String(id));
  if (provider === '7tv') return `https://cdn.7tv.app/emote/${i}/2x.webp`;
  if (provider === 'bttv') return `https://cdn.betterttv.net/emote/${i}/2x.webp`;
  if (provider === 'ffz') return `https://cdn.frankerfacez.com/emote/${i}/2`;
  if (provider === 'twitch') return `https://static-cdn.jtvnw.net/emoticons/v2/${i}/default/dark/2.0`;
  return '';
}

/** Only https pictures, or the demo's picture scheme (demo mode indexes its fake emotes too). */
function okUrl(u) {
  return typeof u === 'string' && /^(https:\/\/|lbhls:\/\/demo\/)[^\s"'<>]{1,300}$/.test(u);
}

function okEntry(x) {
  return Array.isArray(x) && INDEX_PROVIDERS.includes(x[0]) && typeof x[1] === 'string' && EMOTE_ID.test(x[1])
    && typeof x[2] === 'string' && x[2].length > 0 && x[2].length <= NAME_MAX && (x[3] === undefined || okUrl(x[3]));
}

function trim(channels, max) {
  const out = [];
  let left = max;
  for (const c of channels) {
    if (left <= 0 || out.length >= MAX_CHANNELS) break;
    const emotes = c.emotes.length > left ? c.emotes.slice(0, left) : c.emotes;
    left -= emotes.length;
    out.push(emotes === c.emotes ? c : { ...c, emotes });
  }
  return out;
}

/** An empty index. */
export const emptyIndex = () => ({ v: 1, channels: [] });

/** Validates a stored index (anything else becomes an empty one); keeps the order and the cap. */
export function sanitizeEmoteIndex(x, { max = MAX_ENTRIES } = {}) {
  if (!x || typeof x !== 'object' || !Array.isArray(x.channels)) return emptyIndex();
  const seen = new Set();
  const channels = [];
  for (const c of x.channels) {
    if (!c || typeof c !== 'object' || !CH_ID.test(String(c.id)) || !LOGIN.test(String(c.login)) || seen.has(String(c.id))) continue;
    seen.add(String(c.id));
    const name = typeof c.name === 'string' && c.name ? c.name.slice(0, 40) : String(c.login);
    const at = Number.isFinite(c.at) ? c.at : 0;
    const emotes = Array.isArray(c.emotes) ? c.emotes.filter(okEntry).map((e) => (e[3] === undefined ? e.slice(0, 3) : e.slice(0, 4))) : [];
    channels.push({ id: String(c.id), login: String(c.login), name, at, emotes });
  }
  return { v: 1, channels: trim(channels, max) };
}

/**
 * Records one provider's set for a channel: replaces that provider's entries for the channel, moves the channel to the
 * front (most recently seen) and drops the least recently seen channels over `max` entries. channel: { id, login,
 * name }; emotes: normalised emotes ({ id, name, url }). Returns a new index (the input is not changed).
 */
export function indexChannel(index, channel, provider, emotes, { now = Date.now(), max = MAX_ENTRIES } = {}) {
  const idx = index && Array.isArray(index.channels) ? index : emptyIndex();
  const id = String((channel && channel.id) || '');
  const login = String((channel && channel.login) || '').toLowerCase();
  if (!CH_ID.test(id) || !LOGIN.test(login) || !INDEX_PROVIDERS.includes(provider)) return idx;
  const old = idx.channels.find((c) => c.id === id);
  const fresh = [];
  const names = new Set();
  for (const e of Array.isArray(emotes) ? emotes : []) {
    if (!e || names.has(e.name)) continue;
    const entry = e.url && e.url !== emoteUrl(provider, e.id) ? [provider, String(e.id), e.name, e.url] : [provider, String(e.id), e.name];
    if (!okEntry(entry)) continue;
    names.add(e.name);
    fresh.push(entry);
  }
  const kept = old ? old.emotes.filter((e) => e[0] !== provider) : [];
  const next = {
    id, login,
    name: String((channel && channel.name) || (old && old.name) || login).slice(0, 40),
    at: now,
    emotes: [...kept, ...fresh],
  };
  return { v: 1, channels: trim([next, ...idx.channels.filter((c) => c.id !== id)], max) };
}

/** How many emotes the index holds. */
export function indexSize(index) {
  return (index && Array.isArray(index.channels) ? index.channels : []).reduce((n, c) => n + c.emotes.length, 0);
}

/**
 * Searches the index: exact names (ignoring case) first, then names starting with the query, then names containing
 * it; within a group the exact-case match, then the most recently seen channel, then A–Z. One result per emote
 * (provider + id), from the most recently seen channel that has it; `channels` counts how many have it. An empty query
 * returns nothing. Results: { provider, id, name, url, channel: { id, login, name }, channels }.
 */
export function searchSeen(index, query, { limit = 300 } = {}) {
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  if (!ql) return [];
  const byEmote = new Map();
  const channels = index && Array.isArray(index.channels) ? index.channels : [];
  channels.forEach((c, rank) => {
    for (const [provider, id, name, url] of c.emotes) {
      const n = name.toLowerCase();
      const tier = n === ql ? 0 : n.startsWith(ql) ? 1 : n.includes(ql) ? 2 : -1;
      if (tier < 0) continue;
      const key = `${provider}:${id}`;
      const hit = byEmote.get(key);
      if (hit) { hit.channels++; continue; }
      byEmote.set(key, {
        provider, id, name, url: url || emoteUrl(provider, id),
        channel: { id: c.id, login: c.login, name: c.name }, channels: 1,
        tier, exact: name === q ? 0 : 1, rank,
      });
    }
  });
  return [...byEmote.values()]
    .sort((a, b) => a.tier - b.tier || a.exact - b.exact || a.rank - b.rank || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .slice(0, limit)
    .map(({ tier, exact, rank, ...r }) => r);
}

/** The hosts keep one index per account ({ accounts: { "<userId>|anon": index } }); this is the key. */
export function accountIndexKey(id) {
  return CH_ID.test(String(id || '')) ? String(id) : 'anon';
}

/** A host's accounts map with one account's index replaced (validated), or removed when `data` is null. */
export function accountsWithIndex(accounts, accountId, data) {
  const next = { ...(accounts && typeof accounts === 'object' ? accounts : {}) };
  const key = accountIndexKey(accountId);
  if (data == null) delete next[key];
  else next[key] = sanitizeEmoteIndex(data);
  return next;
}
