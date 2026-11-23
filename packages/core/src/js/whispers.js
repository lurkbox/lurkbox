// Whispers: the signed-in account's private messages. One service for the app's lifetime: it keeps an EventSub
// connection of its own (WhisperWatcher, user.whisper.message) open while signed in, keeps the history of the active
// account (the host stores it: whispersLoad/whispersSave), and sends through Helix POST /whispers. No DOM here: the
// Whispers section (views/whispers.js) and main.js (toasts, the rail's unread dot) listen to its events:
//   'change'   the threads changed (detail: { threads })
//   'incoming' a whisper arrived (detail: { peer, message, open }: open = its thread is on screen)
import { state, onState } from './state.js';
import { WhisperWatcher } from './eventsub.js';
import {
  whisperFromEvent, addWhisper, updateWhisper, markThreadRead, sanitizeWhisperThreads, unreadCount, whisperAuthState,
  buildWhisperRequest, interpretWhisperResult, whisperLimit, WhisperGate, whisperWaitText,
} from '../shared/whispers.js';

// "sent" listeners (demo mode's fake reply)
const sentListeners = new Set();
/** fn({ from, to, text }) after Twitch accepted a whisper. Returns an unsubscribe function. */
export function onWhisperSent(fn) { sentListeners.add(fn); return () => sentListeners.delete(fn); }
function emitSent(detail) { for (const fn of sentListeners) { try { fn(detail); } catch (e) { console.error(e); } } }

export class WhisperService extends EventTarget {
  /**
   * @param {object} [deps] injectable for tests: watcher, getAuth, now, onAuth (the host is window.lurkbox)
   */
  constructor(deps = {}) {
    super();
    this.getAuth = deps.getAuth || (() => state.auth);
    this.now = deps.now || (() => Date.now());
    this.watcher = deps.watcher || new WhisperWatcher();
    this.account = null;
    this.threads = [];
    this.openPeer = null; // the thread on screen
    this.gate = new WhisperGate();
    this.seq = 0;
    this.loading = null;
    this.watcher.addEventListener('whisper', (e) => this.onEvent(e.detail));
    (deps.onAuth || ((cb) => onState((what) => { if (what !== 'settings') cb(); })))(() => this.sync());
  }

  get available() { return !!(window.lurkbox && window.lurkbox.whispersLoad); }

  /** 'ok', 'signed-out' or 'reauth' (the token lacks user:manage:whispers). */
  authState() { return whisperAuthState(this.getAuth()); }

  /** Follows the active account: loads its history and (with the scope) keeps the EventSub subscription. */
  sync() {
    const a = this.getAuth() || {};
    const id = a.signedIn && a.user ? String(a.user.id) : null;
    this.watcher.watch(id && this.authState() === 'ok' ? { id, login: a.user.login } : null);
    if (id === this.account) return this.loading || Promise.resolve();
    this.account = id;
    this.threads = [];
    this.openPeer = null;
    this.gate = new WhisperGate();
    this.emitChange();
    if (!id || !this.available) { this.loading = null; return Promise.resolve(); }
    const p = this.loading = Promise.resolve(window.lurkbox.whispersLoad(id)).then((list) => {
      if (this.account !== id) return;
      // Whispers that arrived while loading are kept on top of the stored ones.
      let merged = sanitizeWhisperThreads(list);
      for (const t of this.threads) for (const m of t.messages) merged = addWhisper(merged, t, m, { unread: !m.me && t.id !== this.openPeer });
      this.threads = merged;
      this.emitChange();
    }).catch((e) => console.warn('[whispers] load failed', e && e.message));
    return p;
  }

  save(account = this.account) {
    if (!account || !this.available || account !== this.account) return Promise.resolve(false);
    return Promise.resolve(window.lurkbox.whispersSave(account, this.threads)).catch(() => false);
  }

  emitChange() { this.dispatchEvent(new CustomEvent('change', { detail: { threads: this.threads } })); }

  thread(peerId) { return this.threads.find((t) => t.id === String(peerId)) || null; }

  unread() { return unreadCount(this.threads); }

  /** The length limit for a whisper to this person (10,000 once they have whispered you, else 500). */
  limitFor(peerId) { return whisperLimit(this.thread(peerId)); }

  onEvent(ev) {
    const got = whisperFromEvent(ev, this.account, this.now());
    if (!got) return;
    const open = this.openPeer === got.peer.id;
    const before = this.threads;
    this.threads = addWhisper(this.threads, got.peer, got.message, { unread: !open });
    if (this.threads === before) return; // a repeated delivery
    console.log(`[whispers] from ${got.peer.login || got.peer.id}`);
    this.save();
    this.emitChange();
    this.dispatchEvent(new CustomEvent('incoming', { detail: { ...got, open } }));
  }

  /** The thread with this person is on screen (null: none); opening it marks it read. */
  setOpen(peerId) {
    this.openPeer = peerId ? String(peerId) : null;
    if (this.openPeer) this.markRead(this.openPeer);
  }

  markRead(peerId) {
    const t = this.thread(peerId);
    if (!t || !t.unread) return;
    this.threads = markThreadRead(this.threads, peerId);
    this.save();
    this.emitChange();
  }

  /** Settings → Clear whispers: the active account's history. */
  async clear() {
    this.threads = [];
    this.emitChange();
    if (this.account && this.available) await Promise.resolve(window.lurkbox.whispersSave(this.account, [])).catch(() => false);
  }

  /**
   * Sends `text` to `peer` ({ id, login, name }) as the active account. The message is added at once and marked
   * failed (with the reason) when Twitch refuses it. Resolves interpretWhisperResult()'s shape, or { ok: false,
   * kind: 'auth'|'cooldown'|<buildWhisperRequest error>, reason }.
   */
  async send(peer, text) {
    const auth = this.authState();
    if (auth !== 'ok') return { ok: false, kind: 'auth', auth, reason: auth === 'reauth' ? 'Sign in again to send whispers.' : 'Sign in to send whispers.' };
    const me = this.getAuth().user;
    const account = this.account;
    const limit = this.limitFor(peer.id);
    const req = buildWhisperRequest({ fromId: me.id, toId: peer.id, message: text, limit });
    if (req.error) {
      const reasons = { 'too-long': `Whispers can be at most ${limit.toLocaleString('en-US')} characters here.`, self: 'You can\'t whisper yourself.', empty: 'Type a message first.' };
      return { ok: false, kind: req.error, reason: reasons[req.error] || 'Can\'t send that whisper.' };
    }
    const now = this.now();
    const g = this.gate.check({ now, to: peer.id });
    if (!g.ok) return { ok: false, kind: 'cooldown', reason: whisperWaitText(g), ...g };
    this.gate.mark({ now, to: peer.id });
    const id = `local-${now}-${++this.seq}`;
    this.threads = addWhisper(this.threads, peer, { id, me: true, text: req.body.message, at: now });
    this.emitChange();
    let r;
    try { r = await window.lurkbox.helix(req); } catch (e) { r = { ok: false, status: 0, error: e.message, data: null }; }
    const res = interpretWhisperResult(r, this.now());
    if (account !== this.account) return res; // the account changed meanwhile; its history was saved without this
    if (res.ok) {
      emitSent({ from: me, to: String(peer.id), text: req.body.message });
    } else {
      if (res.kind === 'rate') this.gate.block(res.retryAt);
      this.threads = updateWhisper(this.threads, peer.id, id, { failed: res.reason });
      this.emitChange();
    }
    this.save();
    return res;
  }
}

let service = null;
/** The app's whisper service (made on first use). */
export function whispers() { return service || (service = new WhisperService()); }
