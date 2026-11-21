// Third-party emote sets: 7TV (v3), BetterTTV and FrankerFaceZ. Public APIs, fetched straight from the renderer
// (all three send CORS headers), so this works the same in Electron and in the Android build. Results are normalised
// to { provider, id, name, url, w, h, zeroWidth, animated } and cached per channel for the session.

const SEVENTV = 'https://7tv.io/v3';
const BTTV = 'https://api.betterttv.net/3/cached';
const FFZ = 'https://api.frankerfacez.com/v1';
// BetterTTV's old overlay emotes (the 7TV extension treats the same list as zero-width).
const BTTV_ZERO_WIDTH = new Set(['SoSnowy', 'IceCold', 'SantaHat', 'TopHat', 'ReinDeer', 'CandyCane', 'cvMask', 'cvHazmat']);

// ---- normalisers (pure) ----

/** A 7TV "active emote" (from an emote set) → emote, or null if it has no usable image. */
export function from7tv(ae, { animated = true } = {}) {
  const d = ae && (ae.data || ae);
  const host = d && d.host;
  if (!host || !host.url || !Array.isArray(host.files)) return null;
  const webp = host.files.filter((f) => f.format === 'WEBP');
  const f2 = webp.find((f) => f.name === '2x.webp') || webp[0] || host.files[0];
  const f1 = webp.find((f) => f.name === '1x.webp') || f2;
  if (!f2) return null;
  const isAnim = !!d.animated;
  const file = !animated && isAnim && f2.static_name ? f2.static_name : f2.name;
  const base = host.url.startsWith('//') ? `https:${host.url}` : host.url;
  return {
    provider: '7tv',
    id: ae.id || d.id,
    name: ae.name || d.name,
    url: `${base}/${file}`,
    w: f1.width || 0,
    h: f1.height || 0,
    // Zero-width: the active emote's flag 1, or the emote's own flag 256 (ZERO_WIDTH).
    zeroWidth: !!((ae.flags & 1) || (d.flags & 256)),
    animated: isAnim,
  };
}

export function fromBttv(e, { animated = true } = {}) {
  if (!e || !e.id || !e.code || e.modifier) return null; // text modifiers ("h!") are handled by the tokenizer
  const anim = !!e.animated;
  return {
    provider: 'bttv',
    id: e.id,
    name: e.code,
    url: `https://cdn.betterttv.net/emote/${encodeURIComponent(e.id)}/2x.${anim && !animated ? 'png' : 'webp'}`,
    w: e.width || 0,
    h: e.height || 0,
    zeroWidth: BTTV_ZERO_WIDTH.has(e.code),
    animated: anim,
  };
}

export function fromFfz(e, { animated = true } = {}) {
  if (!e || !e.id || !e.name || !e.urls) return null;
  const anim = e.animated && typeof e.animated === 'object' && Object.keys(e.animated).length > 0;
  const urls = anim && animated ? e.animated : e.urls;
  const url = urls['2'] || urls['1'] || urls['4'];
  if (!url) return null;
  return {
    provider: 'ffz',
    id: String(e.id),
    name: e.name,
    url: anim && animated && !/\.(webp|gif)$/.test(url) ? `${url}.webp` : url,
    w: e.width || 0,
    h: e.height || 0,
    zeroWidth: false,
    ffzModifier: !!e.modifier,
    ffzFlags: Number(e.modifier_flags) || 0,
    animated: !!anim,
  };
}

const compact = (xs) => xs.filter(Boolean);

// ---- fetchers ----

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return null; // the channel has no set with this provider
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** 7TV: returns { emotes, setId } (setId is used for live emote_set.update events). */
export async function load7tv(fetchFn, channelId, opts) {
  if (!channelId) {
    const set = await getJson(fetchFn, `${SEVENTV}/emote-sets/global`);
    return { emotes: compact(((set && set.emotes) || []).map((e) => from7tv(e, opts))), setId: set && set.id };
  }
  const u = await getJson(fetchFn, `${SEVENTV}/users/twitch/${encodeURIComponent(channelId)}`);
  const set = u && u.emote_set;
  return { emotes: compact(((set && set.emotes) || []).map((e) => from7tv(e, opts))), setId: (set && set.id) || (u && u.emote_set_id) || null };
}

export async function loadBttv(fetchFn, channelId, opts) {
  if (!channelId) return { emotes: compact(((await getJson(fetchFn, `${BTTV}/emotes/global`)) || []).map((e) => fromBttv(e, opts))) };
  const u = await getJson(fetchFn, `${BTTV}/users/twitch/${encodeURIComponent(channelId)}`);
  return { emotes: compact([...((u && u.channelEmotes) || []), ...((u && u.sharedEmotes) || [])].map((e) => fromBttv(e, opts))) };
}

export async function loadFfz(fetchFn, channelId, opts) {
  const r = await getJson(fetchFn, channelId ? `${FFZ}/room/id/${encodeURIComponent(channelId)}` : `${FFZ}/set/global`);
  if (!r || !r.sets) return { emotes: [] };
  // Global: only the default sets (the others are per-user/limited). Room: every set it lists.
  const ids = channelId ? Object.keys(r.sets) : (r.default_sets || []).map(String);
  const emotes = [];
  for (const id of ids) for (const e of (r.sets[id] && r.sets[id].emoticons) || []) emotes.push(fromFfz(e, opts));
  return { emotes: compact(emotes) };
}

export const LOADERS = { '7tv': load7tv, bttv: loadBttv, ffz: loadFfz };

/**
 * Session cache in front of the loaders: one request per (provider, channel, animated) at a time, kept for 30 min.
 * Failures are cached for 2 min so a broken provider isn't hammered on every channel switch.
 */
export class EmoteCache {
  constructor(fetchFn = (...a) => fetch(...a), { now = () => Date.now(), ttlMs = 30 * 60 * 1000, errorTtlMs = 2 * 60 * 1000, loaders = LOADERS } = {}) {
    this.fetch = fetchFn;
    this.now = now;
    this.ttl = ttlMs;
    this.errorTtl = errorTtlMs;
    this.loaders = loaders;
    this.entries = new Map(); // key → { at, promise, failed }
  }

  /** Resolves { emotes, setId? } or rejects; channelId '' means the global set. */
  get(provider, channelId = '', { animated = true } = {}) {
    const key = `${provider}:${channelId}:${animated ? 'a' : 's'}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < (hit.failed ? this.errorTtl : this.ttl)) return hit.promise;
    const entry = { at: this.now(), failed: false, promise: null };
    entry.promise = this.loaders[provider](this.fetch, channelId, { animated }).catch((e) => { entry.failed = true; throw e; });
    this.entries.set(key, entry);
    return entry.promise;
  }

  clear() { this.entries.clear(); }
}
