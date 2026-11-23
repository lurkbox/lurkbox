// Demo mode, renderer side. Runs only when the host says so (appInfo.demo, desktop: LURKBOX_DEMO=1). It pins the
// clock to DEMO_NOW and replaces the page's fetch and WebSocket with local fakes that answer the third-party emote
// APIs (7TV, FrankerFaceZ; BetterTTV answers "no emotes"), Twitch chat (IRC), EventSub and the 7TV EventAPI from
// the demo data. Anything else is refused: demo mode never touches the network. Same-origin requests (the page's
// own files) still go to the host.
import { DEMO_NOW, EMOTES, EMOTE_AUTHORS, buildDemoData } from './data.js';
import { joinLines, chatLine, ownLine, PAINTED } from './chat-feed.js';
import { onChatSent } from '../chat-send.js';
import { onWhisperSent } from '../whispers.js';
import { state } from '../state.js';
import { demoIncomingEvent, demoReplyEvent } from './whispers.js';

const BLOCKED = 'Lurkbox demo mode: network access is blocked';

/** Pins Date to DEMO_NOW at install time; it keeps ticking from there. */
export function installClock(win, now = DEMO_NOW) {
  const Real = win.Date;
  const offset = now - Real.now();
  class DemoDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + offset); }
    static now() { return Real.now() + offset; }
  }
  win.Date = DemoDate;
  return () => { win.Date = Real; };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** The emote sets, in each provider's own response format. */
export function emoteResponses(media) {
  const of = (provider, zw = null) => EMOTES.filter(([, p, z]) => p === provider && (zw === null || z === zw));
  const stv = (list) => list.map(([name, , zw], i) => ({
    id: `demo-${name}`, name, flags: zw ? 1 : 0,
    data: {
      id: `demo-${name}`, name, animated: false, flags: zw ? 256 : 0, owner: { username: EMOTE_AUTHORS[i % EMOTE_AUTHORS.length].toLowerCase(), display_name: EMOTE_AUTHORS[i % EMOTE_AUTHORS.length] },
      host: { url: media('img/emote'), files: [{ name: `${name}.svg`, format: 'WEBP', width: 32, height: 32 }] },
    },
  }));
  const ffz = (list) => list.map(([name], i) => ({ id: 900 + i, name, width: 32, height: 32, owner: { name: 'teaclub', display_name: 'TeaClub' }, urls: { 1: media(`img/emote/${name}.svg`), 2: media(`img/emote/${name}.svg`) } }));
  const seven = of('7tv');
  return {
    '7tv:global': { id: 'demo-global', name: 'Demo global', emotes: stv(seven.slice(0, 3)) },
    '7tv:channel': (id) => ({ id: `demo-user-${id}`, emote_set_id: `demo-set-${id}`, emote_set: { id: `demo-set-${id}`, name: 'Demo channel', emotes: stv(seven.slice(3)) } }),
    'ffz:global': { default_sets: [3], sets: { 3: { id: 3, emoticons: ffz(of('ffz').slice(0, 2)) } } },
    'ffz:channel': { room: {}, sets: { 77: { id: 77, emoticons: ffz(of('ffz').slice(2)) } } },
  };
}

/**
 * The demo's "all of 7TV" catalogue for Emote search: every demo emote in a few made-up variants (three per name, so
 * there is more than one page), newest last. [name, picture, zeroWidth, animated, owner].
 */
export function demoCatalog() {
  const out = [];
  EMOTES.forEach(([name, , zw], i) => {
    for (const [k, suffix] of ['', 'XL', 'Mini'].entries()) out.push([`${name}${suffix}`, name, zw, (i + k) % 3 === 0, EMOTE_AUTHORS[(i + k) % EMOTE_AUTHORS.length]]);
  });
  return out;
}

/** Answers Emote search's 7TV GraphQL requests (search, usage) from demoCatalog(). */
export function demoSevenTvGql(body, media) {
  let req = null;
  try { req = JSON.parse(String(body || '')); } catch { req = null; }
  const v = (req && req.variables) || {};
  const q = String((req && req.query) || '');
  const all = demoCatalog();
  if (q.includes('LurkboxEmoteUsage')) {
    const i = all.findIndex(([name]) => `demo-x-${name}` === v.id);
    return { data: { emotes: { emote: i < 0 ? null : { channels: { totalCount: 1200 - i * 13 } } } } };
  }
  const query = String(v.query || '').toLowerCase();
  const f = v.filters || {};
  let hits = all.filter(([name, , zw, anim]) => (!query || name.toLowerCase().includes(query)) && (!f.animated || anim) && (!f.defaultZeroWidth || zw));
  if (v.sort && v.sort.sortBy === 'UPLOAD_DATE') hits = hits.reverse();
  const per = Math.max(1, Number(v.perPage) || 48);
  const page = Math.max(1, Number(v.page) || 1);
  const items = hits.slice((page - 1) * per, page * per).map(([name, pic, zw, anim, owner]) => ({
    id: `demo-x-${name}`, defaultName: name, flags: { animated: anim, defaultZeroWidth: zw },
    owner: { mainConnection: { platformDisplayName: owner } },
    images: [{ url: media(`img/emote/${pic}.svg`), mime: 'image/webp', scale: 2, frameCount: 1 }],
  }));
  return { data: { emotes: { search: { totalCount: hits.length, pageCount: Math.ceil(hits.length / per), items } } } };
}

/** A fetch that answers the emote APIs from the demo data and refuses every other remote URL. */
export function demoFetch({ realFetch, origin, media, log = () => {} }) {
  const r = emoteResponses(media);
  return async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    let u;
    try { u = new URL(url, origin); } catch { throw new TypeError(BLOCKED); }
    if (u.origin === origin && realFetch) return realFetch(input, init);
    let m;
    if (u.host === '7tv.io') {
      if (u.pathname === '/v4/gql' && init && init.method === 'POST') return json(demoSevenTvGql(init.body, media));
      if (u.pathname === '/v3/emote-sets/global') return json(r['7tv:global']);
      if ((m = /^\/v3\/users\/twitch\/(\d+)$/.exec(u.pathname))) return json(r['7tv:channel'](m[1]));
    }
    if (u.host === 'api.betterttv.net') return u.pathname.endsWith('/emotes/global') ? json([]) : new Response('', { status: 404 });
    if (u.host === 'api.frankerfacez.com') {
      if (u.pathname === '/v1/set/global') return json(r['ffz:global']);
      if (/^\/v1\/room\/id\/\d+$/.test(u.pathname)) return json(r['ffz:channel']);
    }
    log(`[demo] blocked fetch ${u.origin}${u.pathname}`);
    throw new TypeError(BLOCKED);
  };
}

/** 7TV paint and entitlement dispatches for the painted demo chatters. */
function paintDispatches() {
  const c = (hex) => parseInt(`${hex}ff`, 16) | 0; // 7TV colours: signed 32-bit RGBA
  const paints = [
    { id: 'demo-paint-sunset', name: 'Sunset', function: 'LINEAR_GRADIENT', angle: 90, repeat: false, stops: [{ at: 0, color: c('ffd34d') }, { at: 0.5, color: c('ff8a66') }, { at: 1, color: c('e44fa8') }], shadows: [] },
    { id: 'demo-paint-lagoon', name: 'Lagoon', function: 'LINEAR_GRADIENT', angle: 90, repeat: false, stops: [{ at: 0, color: c('6dffcf') }, { at: 1, color: c('5fa8ff') }], shadows: [] },
  ];
  const out = [];
  PAINTED.forEach((uid, i) => {
    const p = paints[i % paints.length];
    out.push({ type: 'cosmetic.create', body: { object: { id: p.id, kind: 'PAINT', data: p } } });
    out.push({ type: 'entitlement.create', body: { object: { id: `demo-ent-${uid}`, kind: 'PAINT', ref_id: p.id, user: { connections: [{ platform: 'TWITCH', id: uid }] } } } });
  });
  return out;
}

/**
 * A WebSocket stand-in for the three sockets the core opens (Twitch IRC, EventSub, 7TV EventAPI). Other URLs fail
 * like an unreachable server. ctx: { roomIdOf(login), chat: { paused, intervalMs }, setTimer, clearTimer, log,
 * sockets (a Set the open IRC sockets join, for echo()) }.
 */
export function demoWebSocket(ctx) {
  const { setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) } = ctx;
  return class DemoWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.timers = new Set();
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      let host = '';
      try { host = new URL(this.url).host; } catch { /* bad URL */ }
      this.kind = { 'irc-ws.chat.twitch.tv:443': 'irc', 'irc-ws.chat.twitch.tv': 'irc', 'eventsub.wss.twitch.tv': 'eventsub', 'events.7tv.io': '7tv' }[host] || null;
      if (!this.kind) {
        if (ctx.log) ctx.log(`[demo] blocked WebSocket ${this.url.split('?')[0]}`);
        this.later(() => { this.readyState = 3; this.fire('onerror', {}); this.fire('onclose', { code: 1006, reason: 'demo mode' }); }, 0);
        return;
      }
      this.later(() => {
        this.readyState = 1;
        this.fire('onopen', {});
        if (this.kind === 'eventsub') { if (ctx.eventsubs) ctx.eventsubs.add(this); this.startEventSub(); }
        if (this.kind === '7tv') this.start7tv();
      }, 10);
    }

    later(fn, ms) { const t = setTimer(() => { this.timers.delete(t); if (this.readyState !== 3 || this.kind === null) fn(); }, ms); this.timers.add(t); return t; }
    fire(name, ev) { const f = this[name]; if (typeof f === 'function') { try { f.call(this, ev); } catch (e) { console.error(e); } } }
    emit(data) { if (this.readyState === 1) this.fire('onmessage', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }

    send(data) {
      if (this.readyState !== 1) return;
      const s = String(data);
      if (this.kind === 'irc') {
        const m = /^JOIN #([a-z0-9_]+)/i.exec(s);
        if (m) this.startIrc(m[1].toLowerCase());
        else if (/^PING/.test(s)) this.emit(`PONG :tmi.twitch.tv`);
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (ctx.sockets) ctx.sockets.delete(this);
      if (ctx.eventsubs) ctx.eventsubs.delete(this);
      for (const t of this.timers) clearTimer(t);
      this.timers.clear();
      this.fire('onclose', { code, reason });
    }

    /** The echo of a message sent through Helix (demo mode's stand-in for Twitch relaying it to the channel). */
    echo(detail) {
      this.later(() => this.emit(ownLine({ channel: this.channel, roomId: this.roomId, user: detail.user, text: detail.text, id: detail.id })), 250);
    }

    startIrc(channel) {
      const roomId = ctx.roomIdOf(channel) || '0';
      this.channel = channel;
      this.roomId = roomId;
      if (ctx.sockets) ctx.sockets.add(this);
      const [join, room, ...backlog] = joinLines(channel, roomId);
      this.emit(join);
      this.emit(room);
      // The backlog waits a moment, so the emote sets (loaded on ROOMSTATE) are in place when it is drawn.
      this.later(() => this.emit(backlog.join('\r\n')), 700);
      let n = backlog.length;
      const tick = () => {
        if (!ctx.chat.paused) this.emit(chatLine(channel, roomId, n++));
        this.later(tick, ctx.chat.intervalMs);
      };
      this.later(tick, 700 + ctx.chat.intervalMs);
    }

    startEventSub() {
      const meta = (type) => ({ message_id: `demo-${type}-${Date.now()}`, message_type: type, message_timestamp: new Date().toISOString() });
      this.emit({ metadata: meta('session_welcome'), payload: { session: { id: 'demo-session', status: 'connected', keepalive_timeout_seconds: 30, reconnect_url: null } } });
      const keep = () => { this.emit({ metadata: meta('session_keepalive'), payload: {} }); this.later(keep, 20000); };
      this.later(keep, 20000);
    }

    /** An EventSub notification (the whisper watcher takes user.whisper.message; the raid one ignores it). */
    notify(type, event) {
      this.emit({
        metadata: { message_id: `demo-${type}-${event.whisper_id || Date.now()}`, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type, subscription_version: '1' },
        payload: { subscription: { id: `demo-sub-${type}`, type, version: '1', status: 'enabled' }, event },
      });
    }

    start7tv() {
      this.emit({ op: 1, d: { heartbeat_interval: 25000, session_id: 'demo', subscription_limit: 500 } });
      this.later(() => { for (const d of paintDispatches()) this.emit({ op: 0, d }); }, 300);
    }
  };
}

/**
 * Installs demo mode in the page: the clock, fetch and WebSocket. info = appInfo.demo ({ mediaBase }).
 * Exposes window.__lurkboxDemo (chat pause/resume, for the screenshot script). Returns that control object.
 */
export function installDemo(win, info = {}) {
  const base = String(info.mediaBase || 'demo-media/');
  const media = (p) => `${base}${p}`;
  const db = buildDemoData({ media });
  const log = (line) => { try { console.log(line); } catch { /* ignore */ } };
  installClock(win, info.now || DEMO_NOW);
  const realFetch = win.fetch ? win.fetch.bind(win) : null;
  win.fetch = demoFetch({ realFetch, origin: win.location.origin, media, log });
  const chat = { paused: false, intervalMs: 1200 };
  const ids = new Map(db.users.map((u) => [u.login, u.id]));
  const sockets = new Set();
  const eventsubs = new Set();
  win.WebSocket = demoWebSocket({ roomIdOf: (l) => ids.get(l), chat, log, sockets, eventsubs });
  // Whispers: the fake incoming one (whisper()), and a reply from whoever you whispered, over the fake EventSub.
  let whisperN = 0;
  const whisper = (event) => { if (event) for (const s of eventsubs) s.notify('user.whisper.message', event); return !!event; };
  onWhisperSent((d) => { setTimeout(() => whisper(demoReplyEvent(db, { ...d, n: ++whisperN })), 1800); });
  if (Number(info.whisperInMs) > 0) setTimeout(() => whisper(demoIncomingEvent(db, state.auth.active, ++whisperN)), Number(info.whisperInMs));
  // Sent messages come back over the fake chat connection of their room, as they would from Twitch.
  onChatSent((d) => { for (const s of sockets) if (s.roomId === String(d.roomId)) s.echo(d); });
  const control = {
    db,
    pauseChat() { chat.paused = true; },
    resumeChat() { chat.paused = false; },
    /** An incoming whisper to the active account now (screenshots, smoke tests). */
    whisper() { return whisper(demoIncomingEvent(db, state.auth.active, ++whisperN)); },
  };
  win.__lurkboxDemo = control;
  log('[demo] demo mode: fake data, network blocked');
  return control;
}
