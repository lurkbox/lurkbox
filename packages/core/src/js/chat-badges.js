// Twitch chat badges (Helix GET /chat/badges/global and /chat/badges?broadcaster_id=), keyed "set_id/version".
// The channel's own badges (subscriber tiers, bits) override the global ones. Cached per channel for the session.

/** Helix badge sets → Map("set/version" → { url, url2, title }). */
export function badgeMap(sets) {
  const m = new Map();
  for (const s of sets || []) {
    for (const v of s.versions || []) {
      m.set(`${s.set_id}/${v.id}`, { url: v.image_url_2x || v.image_url_1x, title: v.title || s.set_id });
    }
  }
  return m;
}

/** The IRC `badges` tag ("broadcaster/1,subscriber/12") → ["broadcaster/1", "subscriber/12"]. */
export function parseBadgesTag(tag) {
  return String(tag || '').split(',').filter((b) => /^[^/]+\/[^/]+$/.test(b));
}

export class BadgeCache {
  /** @param helixFn (path, query) → Helix JSON; throws when not signed in */
  constructor(helixFn) {
    this.helix = helixFn;
    this.global = null; // Promise<Map>
    this.channels = new Map(); // broadcaster id → Promise<Map>
  }

  loadGlobal() {
    if (!this.global) this.global = this.helix('/chat/badges/global', {}).then((r) => badgeMap(r.data)).catch((e) => { this.global = null; throw e; });
    return this.global;
  }

  loadChannel(id) {
    if (!id) return Promise.resolve(new Map());
    if (!this.channels.has(id)) {
      this.channels.set(id, this.helix('/chat/badges', { broadcaster_id: id }).then((r) => badgeMap(r.data)).catch((e) => { this.channels.delete(id); throw e; }));
    }
    return this.channels.get(id);
  }

  /** Resolved lookup tables for a channel: { global, channel } (empty Maps on failure). */
  async forChannel(id) {
    const [global, channel] = await Promise.all([
      this.loadGlobal().catch(() => new Map()),
      this.loadChannel(id).catch(() => new Map()),
    ]);
    return { global, channel };
  }
}

/** Looks up a badge in the resolved tables; the channel's version wins. */
export function lookupBadge(tables, key) {
  if (!tables) return null;
  return (tables.channel && tables.channel.get(key)) || (tables.global && tables.global.get(key)) || null;
}
