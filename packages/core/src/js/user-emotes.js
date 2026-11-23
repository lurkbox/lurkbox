// Your own Twitch emotes (official Helix GET /chat/emotes/user, scope user:read:emotes, paginated): the emote
// picker's Twitch tab, and how your own messages show those emotes before (and besides) the IRC emotes tag.
// Cached per account and channel (the channel adds its follower emotes) for 30 minutes. Also a channel's own emotes
// (GET /chat/emotes?broadcaster_id), for the channel page's Emotes tab.

const TTL_MS = 30 * 60 * 1000;
const MAX_PAGES = 30;

/** Helix's emote template → image URL ({{id}}, {{format}}, {{theme_mode}}, {{scale}}). */
export function emoteUrlFromTemplate(template, e, { animated = true } = {}) {
  const tpl = template || 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}';
  const formats = Array.isArray(e.format) ? e.format : [];
  const format = animated && formats.includes('animated') ? 'animated' : 'static';
  return tpl.replace('{{id}}', encodeURIComponent(e.id)).replace('{{format}}', format).replace('{{theme_mode}}', 'dark').replace('{{scale}}', '2.0');
}

/** One Helix user emote → the chat emote shape ({ provider: 'twitch', id, name, url }). */
export function fromHelixEmote(e, template, opts) {
  if (!e || !e.id || !e.name) return null;
  return { provider: 'twitch', id: String(e.id), name: String(e.name), url: emoteUrlFromTemplate(template, e, opts), w: 0, h: 0, zeroWidth: false, emoteType: e.emote_type || '', owner: e.owner_id || '' };
}

/**
 * Every page of /chat/emotes/user. helixFn(path, query) resolves the Helix body ({ data, template, pagination }).
 * Returns the emotes sorted with the channel's own first, then by name.
 */
export async function fetchUserEmotes(helixFn, userId, broadcasterId, opts = {}) {
  const out = [];
  const seen = new Set();
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await helixFn('/chat/emotes/user', { user_id: userId, broadcaster_id: broadcasterId || undefined, after });
    for (const e of (r && r.data) || []) {
      const x = fromHelixEmote(e, r.template, opts);
      if (x && !seen.has(x.name)) { seen.add(x.name); out.push(x); }
    }
    after = r && r.pagination && r.pagination.cursor;
    if (!after) break;
  }
  const own = (x) => (broadcasterId && String(x.owner) === String(broadcasterId) ? 0 : 1);
  return out.sort((a, b) => own(a) - own(b) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The per-session cache in front of fetchUserEmotes. */
export class UserEmoteCache {
  constructor(helixFn, { now = () => Date.now() } = {}) {
    this.helix = helixFn;
    this.now = now;
    this.entries = new Map();
  }

  get(userId, broadcasterId = '', opts = {}) {
    const key = `${userId}:${broadcasterId || ''}:${opts.animated === false ? 's' : 'a'}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < (hit.failed ? 60000 : TTL_MS)) return hit.promise;
    const entry = { at: this.now(), failed: false, promise: null };
    entry.promise = fetchUserEmotes(this.helix, userId, broadcasterId, opts).catch((e) => { entry.failed = true; throw e; });
    this.entries.set(key, entry);
    return entry.promise;
  }
}

/**
 * A channel's own Twitch emotes (official Helix GET /chat/emotes?broadcaster_id: subscriber tiers, follower and Bits
 * emotes; one page, any token), for the channel page's Emotes tab. Each emote also gets `tier` ('1000'…) and
 * `animated`.
 */
export async function fetchChannelEmotes(helixFn, broadcasterId, opts = {}) {
  const r = await helixFn('/chat/emotes', { broadcaster_id: broadcasterId });
  const out = [];
  const seen = new Set();
  for (const e of (r && r.data) || []) {
    const x = fromHelixEmote(e, r.template, opts);
    if (!x || seen.has(x.name)) continue;
    seen.add(x.name);
    x.owner = String(broadcasterId);
    x.tier = e.tier ? String(e.tier) : '';
    x.animated = Array.isArray(e.format) && e.format.includes('animated');
    out.push(x);
  }
  return out;
}

/** The session cache in front of fetchChannelEmotes (per channel and animation setting, 30 minutes). */
export class ChannelEmoteCache {
  constructor(helixFn, { now = () => Date.now() } = {}) {
    this.helix = helixFn;
    this.now = now;
    this.entries = new Map();
  }

  get(broadcasterId, opts = {}) {
    const key = `${broadcasterId}:${opts.animated === false ? 's' : 'a'}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < (hit.failed ? 60000 : TTL_MS)) return hit.promise;
    const entry = { at: this.now(), failed: false, promise: null };
    entry.promise = fetchChannelEmotes(this.helix, broadcasterId, opts).catch((e) => { entry.failed = true; throw e; });
    this.entries.set(key, entry);
    return entry.promise;
  }
}
