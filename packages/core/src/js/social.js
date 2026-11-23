// Your subscriptions and blocked users (official Helix only). Pure logic with the Helix call injected, so it is
// unit-tested without a host; social-ui.js wires it to the app.
//
// Subscriptions: Helix has no "list my subscriptions". GET /subscriptions/user?broadcaster_id&user_id checks one
// channel (user:read:subscriptions) and answers 404 when you aren't subscribed. SubChecker checks your followed
// channels a few at a time, spaced out, and remembers each answer (yes or no) for an hour.
// Blocks: GET /users/blocks?broadcaster_id=<me> lists them (user:read:blocked_users); PUT/DELETE /users/blocks
// ?target_user_id blocks/unblocks (user:manage:blocked_users). Blocking always asks first.

import { fetchAllPages } from './follows.js';

const TIERS = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };

/** Helix tier ("1000" | "2000" | "3000") → "Tier 1" | "Tier 2" | "Tier 3" (anything else: "Subscribed"). */
export function tierLabel(tier) { return TIERS[String(tier)] || 'Subscribed'; }

/** Short form for card badges: "Sub", "Sub T2", "Sub T3". */
export function tierBadge(tier) { const t = String(tier); return t === '2000' ? 'Sub T2' : t === '3000' ? 'Sub T3' : 'Sub'; }

/** One GET /subscriptions/user answer → { broadcasterId, login, name, tier, tierLabel, isGift, gifter } or null. */
export function parseSubscription(res) {
  const s = res && Array.isArray(res.data) ? res.data[0] : null;
  if (!s || !s.broadcaster_id) return null;
  const isGift = !!s.is_gift;
  return {
    broadcasterId: String(s.broadcaster_id),
    login: String(s.broadcaster_login || ''),
    name: String(s.broadcaster_name || s.broadcaster_login || ''),
    tier: String(s.tier || ''),
    tierLabel: tierLabel(s.tier),
    isGift,
    gifter: isGift && (s.gifter_login || s.gifter_name) ? { login: String(s.gifter_login || ''), name: String(s.gifter_name || s.gifter_login || '') } : null,
  };
}

/** "Tier 1 · gifted by SomeName" */
export function subDetail(sub) {
  if (!sub) return '';
  return [sub.tierLabel, sub.isGift ? (sub.gifter ? `gifted by ${sub.gifter.name}` : 'gifted') : null].filter(Boolean).join(' · ');
}

export const SUB_TTL_MS = 60 * 60 * 1000;

/**
 * Checks subscriptions one channel at a time (Helix has no list), at most `concurrency` requests at once and each
 * worker waiting `gapMs` between requests, so a long follow list stays well under the rate limit. Answers (subscribed
 * or not) are cached per account and channel for `ttlMs`; errors are not cached. A 429 pauses every worker until the
 * reset time (at most 60 s) and retries that channel once.
 * helix(path, query) resolves the JSON or throws an error with .status (and .resetAt, epoch seconds).
 */
export class SubChecker {
  constructor({ helix, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ttlMs = SUB_TTL_MS, concurrency = 2, gapMs = 250 } = {}) {
    this.helix = helix;
    this.now = now;
    this.sleep = sleep;
    this.ttlMs = ttlMs;
    this.concurrency = Math.max(1, concurrency);
    this.gapMs = gapMs;
    this.cache = new Map(); // `${userId}:${broadcasterId}` → { at, sub }
    this.inflight = new Map(); // same key → Promise
    this.pauseUntil = 0;
  }

  key(userId, broadcasterId) { return `${userId}:${broadcasterId}`; }

  /** The cached answer: a sub, null (not subscribed), or undefined (unknown or expired). */
  cached(userId, broadcasterId) {
    const c = this.cache.get(this.key(userId, broadcasterId));
    if (!c || this.now() - c.at >= this.ttlMs) return undefined;
    return c.sub;
  }

  /** Every cached subscription of this account (fresh ones only): Map broadcasterId → sub. */
  known(userId) {
    const out = new Map();
    const pre = `${userId}:`;
    for (const [k, c] of this.cache) if (k.startsWith(pre) && c.sub && this.now() - c.at < this.ttlMs) out.set(k.slice(pre.length), c.sub);
    return out;
  }

  clear() { this.cache.clear(); }

  /** One channel: resolves a sub, null (not subscribed, a quiet 404), or undefined (couldn't tell). */
  check(userId, broadcasterId) {
    const k = this.key(userId, broadcasterId);
    const hit = this.cached(userId, broadcasterId);
    if (hit !== undefined) return Promise.resolve(hit);
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = this.fetchOne(userId, broadcasterId).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  async fetchOne(userId, broadcasterId, retried = false) {
    const wait = this.pauseUntil - this.now();
    if (wait > 0) await this.sleep(wait);
    try {
      const sub = parseSubscription(await this.helix('/subscriptions/user', { broadcaster_id: String(broadcasterId), user_id: String(userId) }));
      this.cache.set(this.key(userId, broadcasterId), { at: this.now(), sub });
      return sub;
    } catch (e) {
      const status = e && e.status;
      if (status === 404) { this.cache.set(this.key(userId, broadcasterId), { at: this.now(), sub: null }); return null; }
      if (status === 429 && !retried) {
        const reset = Number(e.resetAt) * 1000;
        this.pauseUntil = this.now() + Math.min(60000, Math.max(1000, Number.isFinite(reset) ? reset - this.now() : 5000));
        return this.fetchOne(userId, broadcasterId, true);
      }
      return undefined;
    }
  }

  /**
   * Many channels (deduplicated), cached ones first without a request. onResult(broadcasterId, sub|null) for each
   * answer as it comes. Resolves Map broadcasterId → sub of the subscribed ones. cancelled() stops it early.
   */
  async checkAll(userId, broadcasterIds, { onResult = () => {}, cancelled = () => false } = {}) {
    const out = new Map();
    const todo = [];
    for (const id of [...new Set(broadcasterIds.map(String))]) {
      const hit = this.cached(userId, id);
      if (hit === undefined) { todo.push(id); continue; }
      if (hit) out.set(id, hit);
      onResult(id, hit);
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !cancelled()) {
        const id = todo[next++];
        const sub = await this.check(userId, id);
        if (sub) out.set(id, sub);
        if (sub !== undefined) onResult(id, sub);
        if (next < todo.length && this.gapMs) await this.sleep(this.gapMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length) }, worker));
    return out;
  }
}

/** One page of GET /users/blocks → [{ id, login, name }]. */
export function parseBlocks(res) {
  const list = res && Array.isArray(res.data) ? res.data : [];
  return list.filter((b) => b && b.user_id).map((b) => ({
    id: String(b.user_id), login: String(b.user_login || ''), name: String(b.display_name || b.user_login || ''),
  }));
}

/**
 * Your block list (per account), loaded from Helix and kept in step with blocks and unblocks made in Lurkbox.
 * subscribe(fn) is told after every change (the chat filter re-reads it).
 */
export class BlockList {
  constructor({ helix }) {
    this.helix = helix;
    this.userId = null;
    this.items = [];
    this.ids = new Set();
    this.loadedAt = 0;
    this.loading = null;
    this.listeners = new Set();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit() { for (const fn of this.listeners) { try { fn(this.items); } catch (e) { console.error(e); } } }

  set(items) {
    this.items = items;
    this.ids = new Set(items.map((b) => b.id));
    this.emit();
  }

  has(id) { return !!id && this.ids.has(String(id)); }

  /** Loads (all pages) for this account; reuses a load younger than maxAgeMs. */
  load(userId, { maxAgeMs = 10 * 60 * 1000 } = {}) {
    if (!userId) { this.userId = null; this.set([]); return Promise.resolve([]); }
    if (String(userId) !== this.userId) { this.userId = String(userId); this.loadedAt = 0; this.loading = null; this.set([]); }
    if (this.loadedAt && Date.now() - this.loadedAt < maxAgeMs) return Promise.resolve(this.items);
    if (this.loading) return this.loading;
    const me = this.userId;
    this.loading = fetchAllPages(async (after) => {
      const r = await this.helix('/users/blocks', { broadcaster_id: me, first: 100, after });
      return { items: parseBlocks(r), cursor: (r && r.pagination && r.pagination.cursor) || null };
    }).then((items) => {
      if (this.userId === me) { this.loadedAt = Date.now(); this.set(items); }
      return items;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** PUT /users/blocks. user: { id, login, name }. reason: optional 'harassment' | 'spam' | 'other'. */
  async block(user, { reason } = {}) {
    await this.helix('/users/blocks', { target_user_id: String(user.id), source_context: 'chat', reason }, { method: 'PUT' });
    if (!this.has(user.id)) this.set([{ id: String(user.id), login: user.login || '', name: user.name || user.login || '' }, ...this.items]);
  }

  /** DELETE /users/blocks. */
  async unblock(user) {
    await this.helix('/users/blocks', { target_user_id: String(user.id) }, { method: 'DELETE' });
    if (this.has(user.id)) this.set(this.items.filter((b) => b.id !== String(user.id)));
  }
}

/** Should Lurkbox chat leave this message out? ev: a chat event (userId); blocked: { has(id) }; on: the setting. */
export function hideFromChat(ev, blocked, on = true) {
  return !!(on && ev && ev.userId && blocked && blocked.has(String(ev.userId)));
}

/**
 * Block (or unblock) only after a "Yes" in the dialog. deps: confirm(dialog) (confirmDialog's shape), list (BlockList),
 * toast. Resolves true when it changed.
 */
export function confirmBlock(user, { confirm, list, toast = () => {} }) {
  const name = user.name || user.login;
  return new Promise((resolve) => confirm({
    title: `Block ${name}?`,
    message: `${name} can't whisper you, and Lurkbox hides their chat messages. You can unblock them in Settings → Account → Blocked users.`,
    yes: 'Block', no: 'Cancel',
    onYes: async () => {
      try { await list.block(user); toast(`Blocked ${name}`); resolve(true); } catch (e) { toast(`Couldn't block ${name}`, 3000, 'warn'); resolve(false); }
    },
    onNo: () => resolve(false),
  }));
}

export function confirmUnblock(user, { confirm, list, toast = () => {} }) {
  const name = user.name || user.login;
  return new Promise((resolve) => confirm({
    title: `Unblock ${name}?`,
    message: `${name} can whisper you again and their chat messages show again.`,
    yes: 'Unblock', no: 'Cancel',
    onYes: async () => {
      try { await list.unblock(user); toast(`Unblocked ${name}`); resolve(true); } catch (e) { toast(`Couldn't unblock ${name}`, 3000, 'warn'); resolve(false); }
    },
    onNo: () => resolve(false),
  }));
}
