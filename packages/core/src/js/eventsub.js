// EventSub WebSocket clients: one subscription type per connection. RaidWatcher follows the watched channel's
// outgoing raids (channel.raid; in multi-view every tile's, all on this one socket); WhisperWatcher receives the signed-in account's whispers (user.whisper.message). Each has
// its own socket, so the raid one can come and go with the player while whispers stay connected.
//
// Lifecycle (shown for raids; whispers watch the signed-in user instead of a channel):
//  - The socket opens only while a live channel is being watched (Twitch closes
//    a session with code 4003 if nothing subscribes within 10 seconds).
//  - session_welcome on a fresh connection -> subscribe channel.raid with
//    condition.from_broadcaster_user_id = watched channel. Needs a user access
//    token (any user, no scope) because the transport is websocket.
//  - Channel change -> delete the old subscription, create the new one.
//  - session_keepalive / any message resets a watchdog of keepalive_timeout + slack;
//    if it fires the socket is dropped and a fresh session is opened and resubscribed.
//  - session_reconnect -> open reconnect_url; on its welcome close the old socket.
//    Subscriptions carry over, so no resubscribe.
//  - Unexpected close -> backoff, fresh session, resubscribe.
//  - revocation of our subscription -> resubscribe after a short delay.
import { helix } from './api.js';
import { state, onState } from './state.js';

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const WATCHDOG_SLACK_MS = 8000;

export class EventSubWatcher extends EventTarget {
  /**
   * @param {object} spec { type, version, tag (log prefix), condition(targetId) → condition object,
   *   event: name of the CustomEvent fired with each notification's event, accept(ev, target) → boolean }
   * @param {object} [deps] injectable for tests
   * @param {Function} [deps.helix] Helix request function (path, query, {method, body})
   * @param {typeof WebSocket} [deps.WebSocket]
   * @param {() => boolean} [deps.isSignedIn]
   * @param {(cb: () => void) => void} [deps.onSignin] registers a callback for sign-in changes
   */
  constructor(deps = {}, spec) {
    super();
    this.spec = spec;
    this.helix = deps.helix || helix;
    this.WS = deps.WebSocket || globalThis.WebSocket;
    this.isSignedIn = deps.isSignedIn || (() => state.auth.signedIn);
    this.getAccountId = deps.getAccountId || (() => state.auth.active);
    this.targets = new Map(); // id -> { id, login }
    this.maxTargets = spec.maxTargets || 1;
    this.ws = null; // active socket
    this.pendingWs = null; // socket opened for session_reconnect
    this.sessionId = null;
    this.gen = 0; // increments for every fresh (non-reconnect) session
    this.keepaliveMs = 30000;
    this.subs = new Map(); // targetId -> { id, targetId, gen, accountId }
    this.watchdog = null;
    this.retryTimer = null;
    this.backoff = 0;
    this.seen = new Map(); // message_id -> time
    this.syncing = false;
    this.dirty = false;
    this.status = 'off';
    (deps.onSignin || ((cb) => onState((what) => { if (what === 'signin') cb(); })))(() => this.kick());
  }

  /** Watch this target ({ id, login }: the channel for raids, yourself for whispers), or stop with null. */
  watch(target) {
    this.watchMany(target ? [target] : []);
  }

  /**
   * Watch several targets on this one connection (multi-view: every tile's raids). Subscriptions are added and
   * deleted to match; past spec.maxTargets (Twitch's per-connection cost limit) the rest are left out, with a log.
   */
  watchMany(list) {
    const next = new Map();
    for (const t of list || []) {
      const id = t && t.id ? String(t.id) : null;
      if (!id || next.has(id)) continue;
      if (next.size >= this.maxTargets) { console.warn(`[${this.spec.tag}] over ${this.maxTargets} targets, not watching ${t.login}`); continue; }
      next.set(id, { id, login: t.login });
    }
    if (next.size === this.targets.size && [...next.keys()].every((id) => this.targets.has(id))) return;
    this.targets = next;
    console.log(`[${this.spec.tag}] watch ${next.size ? [...next.values()].map((t) => `${t.login} (${t.id})`).join(', ') : 'nothing'}`);
    this.kick();
  }

  /** The first watched target (the only one outside multi-view), or null. */
  get target() { return this.targets.values().next().value || null; }

  /** The subscription for the first target (compat with the single-target callers and tests). */
  get sub() { return this.subs.values().next().value || null; }

  setStatus(status, detail = '') {
    if (status === this.status && !detail) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  kick() {
    this.dirty = true;
    if (!this.syncing) this.syncLoop();
  }

  async syncLoop() {
    this.syncing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.syncOnce();
      }
    } catch (e) {
      console.error(`[${this.spec.tag}]`, 'sync error', e);
    } finally {
      this.syncing = false;
    }
  }

  async deleteAll() {
    const old = [...this.subs.values()];
    this.subs.clear();
    for (const s of old) await this.deleteSub(s.id, s.accountId);
  }

  async syncOnce() {
    clearTimeout(this.retryTimer);
    if (!this.targets.size) {
      await this.deleteAll();
      this.disconnect();
      this.setStatus('off');
      return;
    }
    if (!this.isSignedIn()) {
      this.disconnect();
      this.setStatus('signed-out');
      return;
    }
    // Account switched: delete the old subscriptions with the OLD account's token,
    // then start a fresh session so the new account's token owns the subscriptions.
    if ([...this.subs.values()].some((s) => s.accountId !== this.getAccountId())) {
      await this.deleteAll();
      this.disconnect();
    }
    if (!this.ws || !this.sessionId) {
      this.ensureSocket(); // the welcome message kicks another sync
      return;
    }
    // Delete first (frees cost for the new ones): targets no longer wanted, and leftovers of an older session.
    for (const [tid, s] of [...this.subs]) {
      if (this.targets.has(tid) && s.gen === this.gen) continue;
      this.subs.delete(tid);
      if (s.gen === this.gen) await this.deleteSub(s.id, s.accountId);
    }
    for (const want of [...this.targets.values()]) {
      if (this.subs.has(want.id)) continue;
      if (!this.targets.has(want.id)) continue; // dropped while an earlier one was subscribing
      const gen = this.gen;
      const sessionId = this.sessionId;
      const accountId = this.getAccountId();
      try {
        const id = await this.create(want.id, sessionId, false, accountId);
        if (gen !== this.gen) {
          // A fresh session started while we were subscribing; that sub is dead.
          this.dirty = true;
          return;
        }
        this.subs.set(want.id, { id, targetId: want.id, gen, accountId });
        console.log(`[${this.spec.tag}] subscribed ${this.spec.type} for ${want.login} (${id})`);
        if (!this.targets.has(want.id)) this.dirty = true; // target dropped meanwhile: the next pass deletes it
      } catch (e) {
        if (e.code === 'NOT_SIGNED_IN') {
          this.disconnect();
          this.setStatus('signed-out');
          return;
        }
        console.warn(`[${this.spec.tag}]`, 'subscribe failed', want.login, e.status, e.message);
        this.setStatus('error', e.message);
        this.retryTimer = setTimeout(() => this.kick(), 5000);
        return;
      }
    }
    this.setStatus('active');
  }

  async create(targetId, sessionId, retried = false, accountId = this.getAccountId()) {
    const condition = this.spec.condition(targetId);
    const body = {
      type: this.spec.type,
      version: this.spec.version || '1',
      condition,
      transport: { method: 'websocket', session_id: sessionId },
    };
    try {
      const r = await this.helix('/eventsub/subscriptions', {}, { method: 'POST', body, accountId });
      return r.data[0].id;
    } catch (e) {
      if (e.status === 409) {
        // Already subscribed on this session (e.g. a retried request succeeded).
        const existing = (await this.listSubs()).find((s) => s.transport && s.transport.session_id === sessionId
          && s.condition && Object.entries(condition).every(([k, v]) => s.condition[k] === v));
        if (existing) return existing.id;
      }
      if (!retried && (e.status === 429 || /limit|cost/i.test(e.message || ''))) {
        await this.cleanupStale();
        return this.create(targetId, sessionId, true, accountId);
      }
      throw e;
    }
  }

  async listSubs() {
    const out = [];
    let after;
    for (let i = 0; i < 10; i++) {
      const r = await this.helix('/eventsub/subscriptions', { type: this.spec.type, after });
      out.push(...(r.data || []));
      after = r.pagination && r.pagination.cursor;
      if (!after) break;
    }
    return out;
  }

  /** Deletes disabled leftovers. Enabled subscriptions may belong to another device, so they stay. */
  async cleanupStale() {
    try {
      const subs = await this.listSubs();
      for (const s of subs) if (s.status !== 'enabled') await this.deleteSub(s.id);
    } catch (e) {
      console.warn(`[${this.spec.tag}]`, 'cleanup failed', e.message);
    }
  }

  async deleteSub(id, accountId = this.getAccountId()) {
    try {
      await this.helix('/eventsub/subscriptions', { id }, { method: 'DELETE', accountId });
    } catch (e) {
      if (e.status !== 404) console.warn(`[${this.spec.tag}]`, 'delete failed', e.status, e.message);
    }
  }

  /** Deletes the subscription and closes the socket (used when quitting). */
  async shutdown() {
    this.targets = new Map();
    await this.deleteAll();
    this.disconnect();
  }

  // ---- socket ----

  ensureSocket() {
    if (this.ws) return;
    this.setStatus('connecting');
    this.ws = this.open(WS_URL);
  }

  open(url) {
    const ws = new this.WS(url);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(ws, msg);
    };
    ws.onclose = (e) => this.onClose(ws, e.code, e.reason);
    ws.onerror = () => {};
    return ws;
  }

  onMessage(ws, msg) {
    const meta = msg.metadata || {};
    const type = meta.message_type;
    if (ws !== this.ws && ws !== this.pendingWs) return;

    if (type === 'session_welcome') {
      const s = msg.payload.session;
      this.keepaliveMs = (s.keepalive_timeout_seconds || 10) * 1000;
      if (ws === this.pendingWs) {
        // Reconnect finished: subscriptions moved to this socket.
        const old = this.ws;
        this.ws = ws;
        this.pendingWs = null;
        this.sessionId = s.id;
        if (old) { old.onclose = null; try { old.close(); } catch { /* ignore */ } }
        console.log(`[${this.spec.tag}]`, 'reconnected, subscriptions carried over');
        this.armWatchdog();
        return;
      }
      this.sessionId = s.id;
      this.gen++;
      this.subs.clear();
      this.backoff = 0;
      this.armWatchdog();
      this.kick();
      return;
    }

    if (ws === this.ws) this.armWatchdog();

    switch (type) {
      case 'session_keepalive':
        break;
      case 'notification':
        if (meta.subscription_type === this.spec.type) this.onEvent(meta, msg.payload.event);
        break;
      case 'session_reconnect':
        if (ws === this.ws && !this.pendingWs) {
          console.log(`[${this.spec.tag}]`, 'session_reconnect');
          this.pendingWs = this.open(msg.payload.session.reconnect_url);
        }
        break;
      case 'revocation': {
        const sid = msg.payload.subscription && msg.payload.subscription.id;
        console.warn(`[${this.spec.tag}]`, 'revocation', msg.payload.subscription && msg.payload.subscription.status);
        const hit = [...this.subs].find(([, x]) => x.id === sid);
        if (hit) {
          this.subs.delete(hit[0]);
          this.retryTimer = setTimeout(() => this.kick(), 3000);
        }
        break;
      }
      default:
        break;
    }
  }

  onEvent(meta, ev) {
    if (!ev) return;
    const id = meta.message_id;
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.set(id, Date.now());
      if (this.seen.size > 50) this.seen.delete(this.seen.keys().next().value);
    }
    if (meta.message_timestamp && Date.now() - Date.parse(meta.message_timestamp) > 10 * 60 * 1000) return;
    if (![...this.targets.values()].some((t) => this.spec.accept(ev, t))) return;
    this.dispatchEvent(new CustomEvent(this.spec.event, { detail: ev }));
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      console.warn(`[${this.spec.tag}]`, 'keepalive timeout, reconnecting');
      this.dropSocket();
    }, this.keepaliveMs + WATCHDOG_SLACK_MS);
  }

  /** Forcefully abandons the current socket and runs the close handling. */
  dropSocket() {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
    this.onClose(ws, 0, 'watchdog');
  }

  onClose(ws, code, reason) {
    if (ws === this.pendingWs) {
      this.pendingWs = null;
      console.warn(`[${this.spec.tag}]`, 'reconnect socket closed', code, reason);
      return;
    }
    if (ws !== this.ws) return;
    console.warn(`[${this.spec.tag}]`, 'socket closed', code, reason || '');
    clearTimeout(this.watchdog);
    this.ws = null;
    this.sessionId = null;
    this.subs.clear(); // websocket subscriptions die with their session
    if (this.pendingWs) { this.pendingWs.onclose = null; try { this.pendingWs.close(); } catch { /* ignore */ } this.pendingWs = null; }
    if (this.targets.size && this.isSignedIn()) {
      const delay = Math.min(30000, 1000 * 2 ** this.backoff++);
      this.setStatus('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.kick(), delay);
    } else {
      this.setStatus('off');
    }
  }

  disconnect() {
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    for (const ws of [this.ws, this.pendingWs]) {
      if (!ws) continue;
      ws.onclose = null;
      try { ws.close(1000); } catch { /* ignore */ }
    }
    this.ws = null;
    this.pendingWs = null;
    this.sessionId = null;
    this.subs.clear();
  }
}

/** Outgoing raids of the watched channel (any user token, no scope). */
export class RaidWatcher extends EventSubWatcher {
  constructor(deps = {}) {
    super(deps, {
      type: 'channel.raid', version: '1', tag: 'eventsub', event: 'raid',
      // A WebSocket session allows a total cost of 10; each channel.raid on someone else's channel costs 1.
      maxTargets: 10,
      condition: (id) => ({ from_broadcaster_user_id: id }),
      accept: (ev, target) => {
        if (ev.from_broadcaster_user_id !== target.id) return false;
        console.log(`[eventsub] raid ${ev.from_broadcaster_user_login} -> ${ev.to_broadcaster_user_login} (${ev.viewers})`);
        return true;
      },
    });
  }
}

/**
 * The signed-in account's whispers (user.whisper.message, condition user_id = you; user:manage:whispers). The
 * whispers service watches the active account while signed in, for as long as the app runs.
 */
export class WhisperWatcher extends EventSubWatcher {
  constructor(deps = {}) {
    super(deps, {
      type: 'user.whisper.message', version: '1', tag: 'whispers', event: 'whisper',
      condition: (id) => ({ user_id: id }),
      accept: (ev, target) => String(ev.to_user_id) === target.id,
    });
  }
}
