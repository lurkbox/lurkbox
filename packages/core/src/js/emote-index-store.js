// The renderer's side of the "seen channels" emote index (../shared/emote-index.js): loads the active account's index
// from the host once, records the channel sets the chat and the channel page load, and saves a few seconds after the
// last change. Hosts without the members (none today) just keep it for the session.
import { emptyIndex, indexChannel, sanitizeEmoteIndex, searchSeen, indexSize } from '../shared/emote-index.js';
import { state } from './state.js';

export class EmoteIndexStore {
  /** host: window.lurkbox-like ({ emoteIndexGet?, emoteIndexSet? }); account: () => the active account id or null. */
  constructor({ host = () => window.lurkbox, account = () => null, saveMs = 4000, now = () => Date.now(), timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) } } = {}) {
    this.host = host;
    this.account = account;
    this.saveMs = saveMs;
    this.now = now;
    this.timers = timers;
    this.index = emptyIndex();
    this.loadedFor = undefined; // the account the index belongs to
    this.loading = null;
    this.timer = null;
  }

  /** The active account's index (loaded from the host the first time, and again after an account switch). */
  async load() {
    const acct = this.account();
    if (this.loadedFor === acct) return this.index;
    if (this.loading && this.loading.acct === acct) return this.loading.p;
    this.flush();
    const h = this.host();
    const p = (async () => {
      let data = null;
      try { data = h && h.emoteIndexGet ? await h.emoteIndexGet() : null; } catch { data = null; }
      if (this.account() !== acct) return this.load();
      this.index = sanitizeEmoteIndex(data);
      this.loadedFor = acct;
      this.loading = null;
      return this.index;
    })();
    this.loading = { acct, p };
    return p;
  }

  /** Records one provider's set for a channel ({ id, login, name }). */
  async record(channel, provider, emotes) {
    await this.load();
    const next = indexChannel(this.index, channel, provider, emotes, { now: this.now() });
    if (next === this.index) return;
    this.index = next;
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.flush(), this.saveMs);
  }

  /** Saves a pending change now. */
  flush() {
    if (!this.timer) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    const h = this.host();
    if (h && h.emoteIndexSet && this.loadedFor !== undefined) Promise.resolve(h.emoteIndexSet(this.index)).catch(() => {});
  }

  async search(query, opts) { return searchSeen(await this.load(), query, opts); }

  async size() { return indexSize(await this.load()); }

  /** Settings → Chat → Clear emote index (the active account's). */
  async clear() {
    await this.load();
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.index = emptyIndex();
    const h = this.host();
    if (h && h.emoteIndexSet) await h.emoteIndexSet(null);
  }
}

let shared = null;
/** The app's store, for the signed-in account. */
export function emoteIndex() {
  if (!shared) shared = new EmoteIndexStore({
    host: () => ({
      emoteIndexGet: window.lurkbox.emoteIndexGet ? () => window.lurkbox.emoteIndexGet() : null,
      emoteIndexSet: window.lurkbox.emoteIndexSet ? (d) => window.lurkbox.emoteIndexSet(d) : null,
    }),
    account: () => (state.auth && state.auth.signedIn && state.auth.user ? String(state.auth.user.id) : null) });
  return shared;
}
