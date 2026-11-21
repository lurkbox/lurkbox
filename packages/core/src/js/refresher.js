// Auto-refresh for live lists (pure timing logic; unit-tested with fake timers).

/**
 * Polls `load()` every `intervalMs` while `canRun()` is true. Runs immediately
 * on start and on resume. Backs off on 429 (Ratelimit-Reset) and network errors
 * (15 → 30 → 60 s). `apply(result)` is deferred while `isBusy()` (mid-navigation).
 */
export class Poller {
  constructor({ load, apply, intervalMs = 15000, canRun = () => true, isBusy = () => false, onStatus = () => {}, now = () => Date.now() }) {
    Object.assign(this, { load, apply, intervalMs, canRun, isBusy, onStatus, now });
    this.timer = null;
    this.running = false;
    this.paused = false;
    this.errors = 0;
    this.inFlight = false;
  }

  start() { this.running = true; this.tick(); }

  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }

  /** Re-check pause conditions; resuming refreshes immediately. */
  poke() {
    if (!this.running) return;
    const can = this.canRun();
    if (!can) { this.paused = true; clearTimeout(this.timer); this.timer = null; return; }
    if (this.paused) { this.paused = false; this.tick(); }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (!this.running) return;
    if (!this.canRun()) { this.paused = true; return; }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const result = await this.load();
      this.errors = 0;
      this.onStatus('ok');
      this.applyWhenIdle(result);
      this.schedule(this.intervalMs);
    } catch (e) {
      this.schedule(this.backoff(e));
    } finally {
      this.inFlight = false;
    }
  }

  backoff(e) {
    if (e && e.status === 429) {
      const reset = Number(e.resetAt) * 1000; // Ratelimit-Reset is epoch seconds
      this.onStatus('ratelimited');
      return Number.isFinite(reset) && reset > this.now() ? reset - this.now() + 250 : 30000;
    }
    this.errors++;
    this.onStatus('offline');
    return [15000, 30000, 60000][Math.min(this.errors - 1, 2)];
  }

  applyWhenIdle(result) {
    if (this.isBusy()) { setTimeout(() => this.applyWhenIdle(result), 300); return; }
    this.apply(result);
  }
}

/**
 * Where focus should go after a list update: the same key if it still exists,
 * otherwise its nearest surviving neighbour (by old position), else null.
 */
export function focusAfterUpdate(oldKeys, newKeys, focusedKey) {
  if (focusedKey == null) return null;
  if (newKeys.includes(focusedKey)) return focusedKey;
  const idx = oldKeys.indexOf(focusedKey);
  if (idx < 0) return newKeys[0] ?? null;
  const survivors = new Set(newKeys);
  for (let d = 1; d < oldKeys.length; d++) {
    for (const j of [idx + d, idx - d]) {
      if (j >= 0 && j < oldKeys.length && survivors.has(oldKeys[j])) return oldKeys[j];
    }
  }
  return newKeys[0] ?? null;
}

/**
 * Re-fetches the first `pages` cursor pages (for lists with "Load more" that also auto-refresh, e.g. Search).
 * Items are de-duplicated by `key`; `perPage` reorders each page (e.g. live first). Returns { items, cursor }.
 */
export async function loadPages(fetchPage, pages, { key = (it) => it.id, perPage = (items) => items } = {}) {
  const seen = new Set();
  const items = [];
  let cursor = null;
  for (let i = 0; i < Math.max(1, pages); i++) {
    const r = await fetchPage(cursor);
    for (const it of perPage(r.items || [])) {
      const k = String(key(it));
      if (!seen.has(k)) { seen.add(k); items.push(it); }
    }
    cursor = r.cursor || null;
    if (!cursor) break;
  }
  return { items, cursor };
}
