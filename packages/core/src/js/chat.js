// Read-only anonymous Twitch chat over IRC WebSocket (justinfan login), with Twitch emotes and badges, 7TV/BTTV/FFZ
// emotes and 7TV cosmetics. Emote and badge sets are keyed by the channel's room-id (from ROOMSTATE).
import { el } from './ui.js';
import { readableOn } from './color.js';
import { state, onState } from './state.js';
import { helix } from './api.js';
import { EmoteIndex, tokenize, PROVIDERS } from './chat-emotes.js';
import { emoteCache } from './emote-providers.js';
import { BadgeCache, parseBadgesTag, lookupBadge } from './chat-badges.js';
import { SevenTVEvents } from './seventv-events.js';
import { renderParts, renderBadges, applyPaint, attachChatTips } from './chat-render.js';
import { toast } from './ui.js';
import {
  NO_MODES, parseRoomState, PendingEchoes, SendGate, buildSendRequest, interpretSendResult, sendAuthState, slowModeExempt,
  waitText, emitChatSent, ECHO_TIMEOUT_MS,
} from './chat-send.js';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_MESSAGES = 150;
const ROOM_MODE_TAGS = ['slow', 'followers-only', 'subs-only', 'emote-only', 'r9k'];

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    tags[k] = v.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\').replace(/\\r/g, '').replace(/\\n/g, '');
  }
  return tags;
}

export function parseIrc(line) {
  let rest = line;
  let tags = {};
  let prefix = '';
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = null;
  const ti = rest.indexOf(' :');
  if (ti >= 0) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }
  const [command, ...params] = rest.split(' ').filter(Boolean);
  return { tags, prefix, command, params, trailing };
}

/** Converts a parsed IRC line into a chat event (pure; unit-tested). */
export function ircEvent(m) {
  switch (m.command) {
    case 'PING': return { kind: 'ping', reply: `PONG :${m.trailing || 'tmi.twitch.tv'}` };
    case 'RECONNECT': return { kind: 'reconnect' };
    case 'JOIN': return { kind: 'joined' };
    case 'PRIVMSG': {
      let text = m.trailing || '';
      let action = false;
      const am = /^\u0001ACTION (.*)\u0001$/.exec(text);
      if (am) { text = am[1]; action = true; }
      return {
        kind: 'msg',
        id: m.tags.id || '',
        nick: m.tags['display-name'] || m.prefix.split('!')[0],
        color: m.tags.color || '',
        text,
        action,
        userId: m.tags['user-id'] || '',
        roomId: m.tags['room-id'] || '',
        badges: m.tags.badges || '',
        emotes: m.tags.emotes || '',
      };
    }
    case 'ROOMSTATE': {
      if (!m.tags['room-id']) return null;
      // Room modes: every tag on join, then only the ones that changed (merged by parseRoomState).
      const modes = {};
      for (const k of ROOM_MODE_TAGS) if (k in m.tags) modes[k] = m.tags[k];
      return { kind: 'room', roomId: m.tags['room-id'], modes };
    }
    case 'USERNOTICE':
      return m.tags['system-msg'] ? { kind: 'system', text: m.tags['system-msg'] + (m.trailing ? ` — ${m.trailing}` : ''), notice: true } : null;
    case 'CLEARMSG':
      return m.tags['target-msg-id'] ? { kind: 'delete', id: m.tags['target-msg-id'] } : null;
    case 'NOTICE':
      return m.trailing ? { kind: 'system', text: m.trailing } : null;
    default:
      return null;
  }
}

/** Bounded message list: keeps the newest `cap` entries. */
export class MessageLog {
  constructor(cap = MAX_MESSAGES) {
    this.cap = cap;
    this.items = [];
  }

  /** Adds an item; returns the items evicted to stay within the cap. */
  push(item) {
    this.items.push(item);
    return this.items.length > this.cap ? this.items.splice(0, this.items.length - this.cap) : [];
  }

  remove(pred) {
    const i = this.items.findIndex(pred);
    return i >= 0 ? this.items.splice(i, 1)[0] : null;
  }

  clear() { this.items = []; }
}

/** The chat panel's background from the active theme. */
function chatBg() {
  if (typeof document === 'undefined') return '#000000';
  return getComputedStyle(document.documentElement).getPropertyValue('--chat-bg').trim() || '#000000';
}

const badgeCache = new BadgeCache((path, query) => helix(path, query));
const log = (line) => { try { window.lurkbox.log(`[chat] ${line}`); } catch { /* no platform log */ } };

/** The chat-related settings, with defaults for settings saved before they existed. */
export function chatPrefs(s = state.settings || {}) {
  const on = (k) => s[k] !== false;
  return {
    providers: PROVIDERS.filter((p) => on({ '7tv': 'chatEmotes7tv', bttv: 'chatEmotesBttv', ffz: 'chatEmotesFfz' }[p])),
    animated: on('chatAnimatedEmotes'),
    cosmetics: on('chat7tvCosmetics'),
  };
}

/** Not signed in, or the token lacks user:write:chat: offer the TV sign-in (again). */
let signInPrompt = null;
export async function promptChatSignIn(kind) {
  if (signInPrompt && !signInPrompt.closed) return;
  const [{ confirmDialog }, { tvSignIn }] = await Promise.all([import('./modal.js'), import('./auth.js')]);
  const again = kind === 'reauth';
  signInPrompt = confirmDialog({
    title: again ? 'Sign in again to chat' : 'Sign in to chat',
    message: again
      ? 'Lurkbox needs a fresh sign-in to send chat messages for this account (Twitch\'s "send chat messages" permission is missing).'
      : 'Sign in to Twitch to send chat messages.',
    yes: 'Sign in',
    no: 'Not now',
    onYes: () => tvSignIn({ accountId: again ? state.auth.active : null }),
  });
}

export class Chat {
  constructor(panel) {
    this.panel = panel;
    this.list = el('div', { class: 'chat-list' });
    this.title = el('div', { class: 'chat-title' }, 'Chat');
    panel.replaceChildren(this.title, this.list);
    attachChatTips(this.list);
    this.log = new MessageLog(MAX_MESSAGES);
    this.ws = null;
    this.channel = null;
    this.retry = 0;
    this.retryTimer = null;
    this.roomId = null;
    this.index = new EmoteIndex();
    this.badges = null; // { global, channel } for this room
    this.prefs = chatPrefs();
    this.queue = []; // nodes waiting for the next frame (one layout per frame, not per message)
    this.flushing = false;
    // Sending (chat-send.js): the room's modes, messages waiting for their IRC echo, the local send gate, and what
    // your own messages looked like last time (colour and badges, from the echo).
    this.modes = { ...NO_MODES };
    this.modeListeners = new Set();
    this.pending = new PendingEchoes();
    this.gate = new SendGate();
    this.own = { color: '', badges: '', userId: '' };
    this.localSeq = 0;
    this.ownEmotes = new Map(); // your own Twitch emotes (user-emotes.js), for your messages and the pickers
    this.stv = new SevenTVEvents({ log });
    this.stv.onEmotes = ({ setId, add, remove, personal }) => {
      if (personal) this.index.patchPersonal(setId, { add, remove });
      else this.index.patch('7tv', 'channel', { add, remove });
      if (!personal && (add.length || remove.length)) {
        const names = [...add.map((e) => `+${e.name}`), ...remove.map((n) => `-${n}`)].slice(0, 6).join(' ');
        this.system(`7TV emotes updated: ${names}`);
      }
    };
    this.stv.onUserSet = (uid, setId, on) => this.index.setUserSet(uid, setId, on);
    this.stv.onCosmetics = (uids) => this.refreshCosmetics(uids);
    // Re-clamp name colours when the theme changes.
    window.addEventListener('themechange', () => {
      const bg = chatBg();
      for (const n of this.list.querySelectorAll('.chat-nick')) n.style.color = readableOn(n.dataset.color, bg);
    });
    onState((what) => {
      if (what !== 'settings') return;
      const next = chatPrefs();
      const prev = this.prefs;
      this.prefs = next;
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      this.index.setEnabled(next.providers);
      if (this.roomId) this.loadRoom(this.roomId, { force: true });
    });
  }

  join(login) {
    login = (login || '').toLowerCase();
    if (login === this.channel && this.ws) return;
    this.leave();
    this.channel = login;
    this.title.textContent = `Chat · ${login}`;
    this.list.replaceChildren();
    this.log.clear();
    this.queue = [];
    this.pending.clear();
    this.setModes({ ...NO_MODES });
    this.system('Connecting to chat…');
    this.connect();
  }

  leave() {
    this.channel = null;
    this.roomId = null;
    this.badges = null;
    this.index.clearChannel();
    this.stv.stop();
    clearTimeout(this.retryTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  connect() {
    const channel = this.channel;
    if (!channel) return;
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) if (line) this.onLine(line, ws);
    };
    ws.onclose = () => {
      if (this.ws !== ws || !this.channel) return;
      this.ws = null;
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      this.system(`Chat disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Loads badges and third-party emotes for a room (cached), then watches 7TV for live changes. */
  async loadRoom(roomId, { force = false } = {}) {
    if (this.roomId === roomId && !force) return;
    this.roomId = roomId;
    const channel = this.channel;
    const stale = () => this.roomId !== roomId || this.channel !== channel;
    const { providers, animated, cosmetics } = this.prefs;
    this.index.setEnabled(providers);
    badgeCache.forChannel(roomId).then((t) => { if (!stale()) this.badges = t; });
    let sevenSetId = null;
    const loads = [];
    for (const p of providers) {
      for (const scope of ['global', 'channel']) {
        loads.push(emoteCache.get(p, scope === 'global' ? '' : roomId, { animated }).then((r) => {
          if (stale()) return;
          this.index.set(p, scope, r.emotes);
          if (p === '7tv' && scope === 'channel') sevenSetId = r.setId || null;
        }).catch((e) => {
          if (!stale()) this.index.set(p, scope, []);
          log(`${p} ${scope} emotes for ${roomId} failed: ${e.message}`);
        }));
      }
    }
    for (const p of PROVIDERS) if (!providers.includes(p)) { this.index.set(p, 'global', []); this.index.set(p, 'channel', []); }
    await Promise.all(loads);
    if (stale()) return;
    const counts = providers.map((p) => `${p} ${(this.index.sets.get(`${p}:global`) || new Map()).size}+${(this.index.sets.get(`${p}:channel`) || new Map()).size}`).join(', ');
    log(`#${channel} (${roomId}) emotes: ${counts || 'third-party emotes off'}`);
    const want7tvLive = providers.includes('7tv') ? sevenSetId : null;
    this.stv.watch(roomId, { setId: want7tvLive, cosmetics, animated });
  }

  onLine(line, ws) {
    const ev = ircEvent(parseIrc(line));
    if (!ev) return;
    switch (ev.kind) {
      case 'ping': ws.send(ev.reply); break;
      case 'reconnect': ws.close(); break;
      case 'joined': this.retry = 0; this.system(`Joined #${this.channel}`); break;
      case 'room':
        this.loadRoom(ev.roomId);
        if (ev.modes) this.setModes(parseRoomState(ev.modes, this.modes));
        break;
      case 'msg': this.onMessage(ev); break;
      case 'system': this.system(ev.text, ev.notice ? 'notice' : ''); break;
      case 'delete': {
        const gone = this.log.remove((x) => x.id === ev.id);
        if (gone) gone.node.remove();
        else this.queue = this.queue.filter((q) => q.id !== ev.id);
        break;
      }
      default: break;
    }
  }

  /** An incoming message; your own is matched to the copy drawn when you sent it, which it replaces. */
  onMessage(ev) {
    const me = state.auth.user;
    const mine = !!(me && ev.userId && String(ev.userId) === String(me.id));
    if (mine) this.own = { color: ev.color, badges: ev.badges, userId: ev.userId };
    const p = mine ? this.pending.match(ev) : null;
    const node = this.messageNode(ev);
    if (mine) node.classList.add('own');
    if (p && this.replaceItem(p.localId, node, ev.id)) return;
    this.add(node, ev.id);
  }

  /** Swaps the node of a message already in the list (or still queued). Returns false when it is gone. */
  replaceItem(id, node, newId = id) {
    const item = this.log.items.find((x) => x.id === id) || this.queue.find((x) => x.id === id);
    if (!item) return false;
    if (item.node.isConnected) item.node.replaceWith(node);
    item.node = node;
    item.id = newId;
    return true;
  }

  // ---------- sending ----------

  /** fn(modes) whenever the room's modes change (the composer's note). Returns an unsubscribe function. */
  onModes(fn) { this.modeListeners.add(fn); return () => this.modeListeners.delete(fn); }

  setModes(m) {
    const same = JSON.stringify(m) === JSON.stringify(this.modes);
    this.modes = m;
    if (!same) for (const fn of this.modeListeners) { try { fn(m); } catch (e) { console.error(e); } }
  }

  slowExempt() {
    const me = state.auth.user;
    return slowModeExempt({ userId: me && me.id, roomId: this.roomId, badges: this.own.badges });
  }

  /** The local gate for a send now (slow mode, cooldowns): { ok } or { ok: false, waitMs, why }. */
  checkGate(phrase = null) {
    return this.gate.check({ now: Date.now(), slowSec: this.modes.slow, exempt: this.slowExempt(), phrase });
  }

  /**
   * Sends `text` to the channel as the signed-in account (Helix POST /chat/messages). With the IRC panel connected to
   * that room, the message shows at once (dimmed) and is confirmed by its echo; a refusal marks it and shows a toast.
   * opts: { broadcasterId (default: this room), phrase (quick-chat cooldown key) }. Resolves interpretSendResult()'s
   * shape, or { ok: false, kind: 'auth'|'cooldown'|<buildSendRequest error> }.
   */
  async send(text, { broadcasterId = null, phrase = null } = {}) {
    const auth = sendAuthState(state.auth);
    if (auth !== 'ok') { promptChatSignIn(auth); return { ok: false, kind: 'auth' }; }
    const me = state.auth.user;
    const roomId = String(broadcasterId || this.roomId || '');
    const req = buildSendRequest({ broadcasterId: roomId, senderId: me.id, message: text });
    if (req.error) {
      if (req.error === 'too-long') toast('That message is over Twitch\'s 500-character limit', 3000, 'warn');
      else if (req.error === 'no-channel') toast('Chat isn\'t connected yet', 2500, 'warn');
      return { ok: false, kind: req.error };
    }
    const now = Date.now();
    const gate = this.gate.check({ now, slowSec: roomId === this.roomId ? this.modes.slow : 0, exempt: this.slowExempt(), phrase });
    if (!gate.ok) { toast(waitText(gate), 2000); return { ok: false, kind: 'cooldown', ...gate }; }
    const undo = this.gate.mark({ now, phrase });
    const localId = this.roomId === roomId && this.ws ? this.addOwn(req.body.message) : null;
    let r;
    try { r = await window.lurkbox.helix(req); } catch (e) { r = { ok: false, status: 0, error: e.message, data: null }; }
    const res = interpretSendResult(r);
    if (res.ok) {
      if (localId) this.pending.setId(localId, res.id);
      emitChatSent({ channel: this.roomId === roomId ? this.channel : null, roomId, text: req.body.message, id: res.id, user: me });
      log(`sent a message to ${roomId}${res.id ? '' : ' (no id)'}`);
      return res;
    }
    this.gate.undo(undo);
    if (res.kind === 'rate') this.gate.block(res.retryAt);
    if (localId) this.markOwn(localId, 'failed', 'not sent');
    log(`send to ${roomId} failed: ${res.kind}${res.code ? ` ${res.code}` : ''}`);
    if (res.kind === 'auth') promptChatSignIn('reauth');
    else toast(res.reason, 4500, 'warn');
    return res;
  }

  /** Draws your own message right away (pending until its echo). Returns its local id. */
  addOwn(text) {
    const me = state.auth.user;
    const localId = `local-${++this.localSeq}`;
    const node = this.messageNode({
      id: localId, nick: me.display_name || me.login, color: this.own.color, text, action: false,
      userId: String(me.id), roomId: this.roomId, badges: this.own.userId === String(me.id) ? this.own.badges : '', emotes: '',
    });
    node.classList.add('own', 'pending');
    this.pending.add({ localId, text, userId: String(me.id), at: Date.now() });
    this.add(node, localId);
    this.scrollToEnd();
    setTimeout(() => {
      for (const gone of this.pending.expire(Date.now())) this.markOwn(gone.localId, 'unconfirmed', 'not seen in chat yet');
    }, ECHO_TIMEOUT_MS + 100);
    return localId;
  }

  /** Marks your own message: 'failed' (Twitch refused it) or 'unconfirmed' (no echo). */
  markOwn(localId, kind, label) {
    if (kind === 'failed') this.pending.remove(localId);
    const item = this.log.items.find((x) => x.id === localId) || this.queue.find((x) => x.id === localId);
    if (!item) return;
    item.node.classList.remove('pending');
    item.node.classList.add(kind);
    if (!item.node.querySelector('.chat-own-state')) item.node.append(el('span', { class: 'chat-own-state' }, ` · ${label}`));
  }

  /** Jumps the list to the newest message (after you send). */
  scrollToEnd() {
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  /** Your own Twitch emotes (Helix /chat/emotes/user) by name. */
  setOwnEmotes(list) { this.ownEmotes = new Map((list || []).map((e) => [e.name, e])); }

  /** The channel's emotes plus your own Twitch emotes: for your messages, quick-chat phrases and the emote picker. */
  lookup() {
    const base = this.index;
    const own = this.ownEmotes;
    return { enabled: base.enabled, get: (name, userId) => base.get(name, userId) || own.get(name) || null };
  }

  /** Builds one message: badges, name (colour or 7TV paint), then text with emotes. */
  messageNode(ev) {
    if (ev.roomId && ev.roomId !== this.roomId) this.loadRoom(ev.roomId);
    const badges = [];
    for (const key of parseBadgesTag(ev.badges)) { const b = lookupBadge(this.badges, key); if (b) badges.push(b); }
    const cos = this.prefs.cosmetics && ev.userId ? this.stv.cosmeticsFor(ev.userId) : null;
    if (cos && cos.badge) badges.push(cos.badge);
    const nick = el('span', { class: 'chat-nick', style: `color:${readableOn(ev.color, chatBg())}`, dataset: { color: ev.color } }, ev.nick);
    if (cos && cos.paintId) applyPaint(nick, cos.paintId, this.stv.paints.get(cos.paintId));
    const text = el('span', { class: 'chat-text' });
    const me = state.auth.user;
    const index = me && ev.userId && String(ev.userId) === String(me.id) ? this.lookup() : this.index;
    text.append(renderParts(tokenize(ev.text, ev.emotes, index, { userId: ev.userId, animated: this.prefs.animated })));
    return el('div', { class: `chat-msg${ev.action ? ' action' : ''}`, dataset: { id: ev.id, uid: ev.userId } },
      renderBadges(badges), nick, ev.action ? ' ' : ': ', text);
  }

  /** 7TV cosmetics arrived for some users: repaint their names already on screen. */
  refreshCosmetics(uids) {
    if (!this.prefs.cosmetics || !uids || !uids.length) return;
    const want = new Set(uids);
    for (const item of this.log.items) {
      const node = item.node;
      const uid = node.dataset && node.dataset.uid;
      if (!uid || !want.has(uid)) continue;
      const cos = this.stv.cosmeticsFor(uid);
      const nick = node.querySelector('.chat-nick');
      if (nick) applyPaint(nick, cos.paintId, cos.paintId && this.stv.paints.get(cos.paintId));
      if (cos.badge && !node.querySelector('.chat-badge.stv')) {
        let holder = node.querySelector('.chat-badges');
        if (!holder) { holder = renderBadges([]) || el('span', { class: 'chat-badges' }); node.prepend(holder); }
        const b = renderBadges([cos.badge]).firstChild;
        b.classList.add('stv');
        holder.append(b);
      }
    }
  }

  system(text, kind = '') {
    this.add(el('div', { class: `chat-msg system ${kind}`.trim() }, text));
  }

  /** Queues a node; the list is updated once per animation frame (read scroll position, append, trim, scroll). */
  add(node, id = '') {
    this.queue.push({ id, node });
    if (this.queue.length > 2 * MAX_MESSAGES) this.queue.splice(0, this.queue.length - MAX_MESSAGES);
    if (this.flushing) return;
    this.flushing = true;
    // rAF normally; the timer covers a hidden window, where frames stop.
    const run = () => { if (this.flushing) this.flush(); };
    requestAnimationFrame(run);
    setTimeout(run, 250);
  }

  flush() {
    this.flushing = false;
    if (!this.queue.length) return;
    const batch = this.queue.length > MAX_MESSAGES ? this.queue.slice(-MAX_MESSAGES) : this.queue;
    this.queue = [];
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    const frag = document.createDocumentFragment();
    for (const item of batch) {
      frag.append(item.node);
      for (const old of this.log.push(item)) old.node.remove();
    }
    this.list.append(frag);
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }
}
