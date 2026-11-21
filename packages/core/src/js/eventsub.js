// EventSub WebSocket client that follows one channel's outgoing raids.
//
// Lifecycle:
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

export class RaidWatcher extends EventTarget {
  /**
   * @param {object} [deps] injectable for tests
   * @param {Function} [deps.helix] Helix request function (path, query, {method, body})
   * @param {typeof WebSocket} [deps.WebSocket]
   * @param {() => boolean} [deps.isSignedIn]
   * @param {(cb: () => void) => void} [deps.onSignin] registers a callback for sign-in changes
   */
  constructor(deps = {}) {
    super();
    this.helix = deps.helix || helix;
    this.WS = deps.WebSocket || globalThis.WebSocket;
    this.isSignedIn = deps.isSignedIn || (() => state.auth.signedIn);
    this.getAccountId = deps.getAccountId || (() => state.auth.active);
    this.target = null; // { id, login }
    this.ws = null; // active socket
    this.pendingWs = null; // socket opened for session_reconnect
    this.sessionId = null;
    this.gen = 0; // increments for every fresh (non-reconnect) session
    this.keepaliveMs = 30000;
    this.sub = null; // { id, broadcasterId, gen }
    this.watchdog = null;
    this.retryTimer = null;
    this.backoff = 0;
    this.seen = new Map(); // message_id -> time
    this.syncing = false;
    this.dirty = false;
    this.status = 'off';
    (deps.onSignin || ((cb) => onState((what) => { if (what === 'signin') cb(); })))(() => this.kick());
  }

  /** Follow raids from this channel, or stop with null. */
  watch(target) {
    const id = target && target.id ? String(target.id) : null;
    if ((this.target && this.target.id) === id) return;
    this.target = id ? { id, login: target.login } : null;
    console.log(`[eventsub] watch ${this.target ? `${this.target.login} (${id})` : 'nothing'}`);
    this.kick();
  }

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
      console.error('[eventsub] sync error', e);
    } finally {
      this.syncing = false;
    }
  }

  async syncOnce() {
    clearTimeout(this.retryTimer);
    const want = this.target;
    if (!want) {
      if (this.sub) {
        const old = this.sub;
        this.sub = null;
        await this.deleteSub(old.id, old.accountId);
      }
      this.disconnect();
      this.setStatus('off');
      return;
    }
    if (!this.isSignedIn()) {
      this.disconnect();
      this.setStatus('signed-out');
      return;
    }
    // Account switched: delete the old subscription with the OLD account's token,
    // then start a fresh session so the new account's token owns the subscription.
    if (this.sub && this.sub.accountId !== this.getAccountId()) {
      const old = this.sub;
      this.sub = null;
      await this.deleteSub(old.id, old.accountId);
      this.disconnect();
    }
    if (!this.ws || !this.sessionId) {
      this.ensureSocket(); // the welcome message kicks another sync
      return;
    }
    if (this.sub && this.sub.broadcasterId === want.id && this.sub.gen === this.gen) {
      this.setStatus('active');
      return;
    }
    if (this.sub) {
      const old = this.sub;
      this.sub = null;
      if (old.gen === this.gen) await this.deleteSub(old.id, old.accountId);
    }
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
      this.sub = { id, broadcasterId: want.id, gen, accountId };
      console.log(`[eventsub] subscribed channel.raid from ${want.login} (${id})`);
      if (!this.target || this.target.id !== want.id) this.dirty = true; // channel changed meanwhile
      else this.setStatus('active');
    } catch (e) {
      if (e.code === 'NOT_SIGNED_IN') {
        this.disconnect();
        this.setStatus('signed-out');
        return;
      }
      console.warn('[eventsub] subscribe failed', e.status, e.message);
      this.setStatus('error', e.message);
      this.retryTimer = setTimeout(() => this.kick(), 5000);
    }
  }

  async create(broadcasterId, sessionId, retried = false, accountId = this.getAccountId()) {
    const body = {
      type: 'channel.raid',
      version: '1',
      condition: { from_broadcaster_user_id: broadcasterId },
      transport: { method: 'websocket', session_id: sessionId },
    };
    try {
      const r = await this.helix('/eventsub/subscriptions', {}, { method: 'POST', body, accountId });
      return r.data[0].id;
    } catch (e) {
      if (e.status === 409) {
        // Already subscribed on this session (e.g. a retried request succeeded).
        const existing = (await this.listSubs()).find((s) => s.transport && s.transport.session_id === sessionId
          && s.condition && s.condition.from_broadcaster_user_id === broadcasterId);
        if (existing) return existing.id;
      }
      if (!retried && (e.status === 429 || /limit|cost/i.test(e.message || ''))) {
        await this.cleanupStale();
        return this.create(broadcasterId, sessionId, true, accountId);
      }
      throw e;
    }
  }

  async listSubs() {
    const out = [];
    let after;
    for (let i = 0; i < 10; i++) {
      const r = await this.helix('/eventsub/subscriptions', { type: 'channel.raid', after });
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
      console.warn('[eventsub] cleanup failed', e.message);
    }
  }

  async deleteSub(id, accountId = this.sub ? this.sub.accountId : this.getAccountId()) {
    try {
      await this.helix('/eventsub/subscriptions', { id }, { method: 'DELETE', accountId });
    } catch (e) {
      if (e.status !== 404) console.warn('[eventsub] delete failed', e.status, e.message);
    }
  }

  /** Deletes the subscription and closes the socket (used when quitting). */
  async shutdown() {
    this.target = null;
    const old = this.sub;
    this.sub = null;
    if (old) await this.deleteSub(old.id, old.accountId);
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
        console.log('[eventsub] reconnected, subscriptions carried over');
        this.armWatchdog();
        return;
      }
      this.sessionId = s.id;
      this.gen++;
      this.sub = null;
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
        if (meta.subscription_type === 'channel.raid') this.onRaid(meta, msg.payload.event);
        break;
      case 'session_reconnect':
        if (ws === this.ws && !this.pendingWs) {
          console.log('[eventsub] session_reconnect');
          this.pendingWs = this.open(msg.payload.session.reconnect_url);
        }
        break;
      case 'revocation': {
        const sid = msg.payload.subscription && msg.payload.subscription.id;
        console.warn('[eventsub] revocation', msg.payload.subscription && msg.payload.subscription.status);
        if (this.sub && this.sub.id === sid) {
          this.sub = null;
          this.retryTimer = setTimeout(() => this.kick(), 3000);
        }
        break;
      }
      default:
        break;
    }
  }

  onRaid(meta, ev) {
    if (!ev) return;
    const id = meta.message_id;
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.set(id, Date.now());
      if (this.seen.size > 50) this.seen.delete(this.seen.keys().next().value);
    }
    if (meta.message_timestamp && Date.now() - Date.parse(meta.message_timestamp) > 10 * 60 * 1000) return;
    if (!this.target || ev.from_broadcaster_user_id !== this.target.id) return;
    console.log(`[eventsub] raid ${ev.from_broadcaster_user_login} -> ${ev.to_broadcaster_user_login} (${ev.viewers})`);
    this.dispatchEvent(new CustomEvent('raid', { detail: ev }));
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      console.warn('[eventsub] keepalive timeout, reconnecting');
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
      console.warn('[eventsub] reconnect socket closed', code, reason);
      return;
    }
    if (ws !== this.ws) return;
    console.warn('[eventsub] socket closed', code, reason || '');
    clearTimeout(this.watchdog);
    this.ws = null;
    this.sessionId = null;
    this.sub = null; // websocket subscriptions die with their session
    if (this.pendingWs) { this.pendingWs.onclose = null; try { this.pendingWs.close(); } catch { /* ignore */ } this.pendingWs = null; }
    if (this.target && this.isSignedIn()) {
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
    this.sub = null;
  }
}
