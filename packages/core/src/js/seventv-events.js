// 7TV EventAPI (wss://events.7tv.io/v3), scoped to the channel being watched:
//   - emote_set.* on the channel's emote set (object_id) → emotes added/removed/renamed live;
//   - entitlement.*, cosmetic.* and emote_set.* with { ctx: 'channel', platform: 'TWITCH', id } → the 7TV badges,
//     name paints and personal emote sets of chatters who use 7TV (their extension announces them in the channel).
// This is the same method the 7TV browser extension uses. Read-only: nothing is sent about the viewer.
import { from7tv } from './emote-providers.js';

const EVENTS_URL = 'wss://events.7tv.io/v3';
const OP = { DISPATCH: 0, HELLO: 1, HEARTBEAT: 2, RECONNECT: 4, ACK: 5, ERROR: 6, END: 7, SUBSCRIBE: 35, UNSUBSCRIBE: 36 };

/** 7TV colours are signed 32-bit RGBA integers. */
export function rgba(n) {
  const v = Number(n) >>> 0;
  return `rgba(${(v >>> 24) & 255}, ${(v >>> 16) & 255}, ${(v >>> 8) & 255}, ${((v & 255) / 255).toFixed(3)})`;
}

/** Hosts a 7TV paint image may come from. */
const PAINT_IMAGE_HOST = /^cdn\.7tv\.(app|io)$/;

/** A paint's image as a CSS url() value: only https images on 7TV's CDN, the URL escaped as a CSS string; else ''. */
export function paintImageUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !PAINT_IMAGE_HOST.test(u.hostname)) return '';
  return `url("${u.href.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
}

function gradientCss(g) {
  const fn = g.function;
  if (fn === 'URL') return paintImageUrl(g.image_url);
  const stops = (g.stops || []).map((s) => `${rgba(s.color)} ${Math.round(Number(s.at) * 1000) / 10}%`);
  if (stops.length < 2) return '';
  const head = fn === 'RADIAL_GRADIENT' ? (g.shape === 'ellipse' ? 'ellipse' : 'circle') : `${Number(g.angle) || 0}deg`;
  const name = fn === 'RADIAL_GRADIENT' ? 'radial-gradient' : 'linear-gradient';
  return `${g.repeat ? 'repeating-' : ''}${name}(${head}, ${stops.join(', ')})`;
}

/**
 * A 7TV paint → CSS declarations for the username (background-clip: text), as [property, value] pairs that are set
 * one by one through the CSSOM (chat-render.js). Returns null when it can't be drawn.
 * Handles both the flat (v2-style: function/stops/image_url) and the layered (gradients[]) formats.
 */
export function paintCss(paint) {
  const d = paint && (paint.data || paint);
  if (!d) return null;
  const layers = d.gradients && d.gradients.length ? d.gradients : [d];
  const images = layers.map(gradientCss).filter(Boolean);
  if (!images.length) return null;
  const shadows = (d.shadows || []).slice(0, 3).map((s) => `drop-shadow(${Number(s.x_offset) || 0}px ${Number(s.y_offset) || 0}px ${Number(s.radius) || 0}px ${rgba(s.color)})`);
  return [
    ['background-image', images.join(', ')],
    ['background-size', '100% 100%'],
    ['-webkit-background-clip', 'text'],
    ['background-clip', 'text'],
    ['-webkit-text-fill-color', 'transparent'],
    // var(--nick-shadow) is the over-the-video legibility shadow (see app.css); empty elsewhere.
    shadows.length ? ['filter', `${shadows.join(' ')} var(--nick-shadow,)`] : null,
  ].filter(Boolean);
}

/** A 7TV badge cosmetic → { url, title }. */
export function badgeFrom7tv(cos) {
  const d = cos && (cos.data || cos);
  const host = d && d.host;
  if (!host || !host.url) return null;
  const files = host.files || [];
  const f = files.find((x) => x.name === '2x.webp') || files.find((x) => x.format === 'WEBP') || files[0];
  if (!f) return null;
  return { url: `${host.url.startsWith('//') ? 'https:' : ''}${host.url}/${f.name}`, title: d.tooltip || d.name || '7TV' };
}

/**
 * The emote changes in an emote_set.update ChangeMap → { add: [emote], remove: [name] }.
 * pushed = added, pulled = removed (old_value), updated = renamed (old_value → value).
 */
export function emoteSetChanges(body, opts) {
  const add = [];
  const remove = [];
  for (const f of body.pushed || []) if (f.key === 'emotes' && f.value) { const e = from7tv(f.value, opts); if (e) add.push(e); }
  for (const f of body.pulled || []) if (f.key === 'emotes' && f.old_value) remove.push(f.old_value.name);
  for (const f of body.updated || []) {
    if (f.key !== 'emotes') continue;
    if (f.old_value) remove.push(f.old_value.name);
    if (f.value) { const e = from7tv(f.value, opts); if (e) add.push(e); }
  }
  return { add, remove };
}

/** The Twitch user ids an entitlement applies to. */
export function entitlementTwitchIds(obj) {
  const conns = (obj && obj.user && obj.user.connections) || [];
  return conns.filter((c) => c.platform === 'TWITCH' && c.id).map((c) => String(c.id));
}

/**
 * Holds the cosmetics seen in the channel and keeps the EventAPI connection.
 * Callbacks: onEmotes({ setId, add, remove, personal }), onUserSet(twitchId, setId, on), onCosmetics(twitchIds).
 */
export class SevenTVEvents {
  constructor({ WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null, log = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.WS = WebSocketImpl;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.ws = null;
    this.channelId = null;
    this.setId = null;
    this.wantCosmetics = true;
    this.retry = 0;
    this.timer = null;
    this.paints = new Map(); // paint id → CSS declarations ([property, value] pairs)
    this.badges = new Map(); // badge id → { url, title }
    this.userPaint = new Map(); // twitch id → paint id
    this.userBadge = new Map(); // twitch id → badge id
    this.personalSets = new Set(); // 7TV set ids that are personal (flags & 4)
    this.animated = true;
    this.onEmotes = () => {};
    this.onUserSet = () => {};
    this.onCosmetics = () => {};
  }

  /** Watches a channel (null stops). setId is the channel's 7TV emote set, if it has one. */
  watch(channelId, { setId = null, cosmetics = true, animated = true } = {}) {
    this.stop();
    this.channelId = channelId ? String(channelId) : null;
    this.setId = setId;
    this.wantCosmetics = cosmetics;
    this.animated = animated;
    if (this.channelId && this.WS && (setId || cosmetics)) this.connect();
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    if (this.ws) { const ws = this.ws; this.ws = null; ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    this.channelId = null;
    this.userPaint.clear();
    this.userBadge.clear();
    this.personalSets.clear();
  }

  subscriptions() {
    const subs = [];
    if (this.setId) subs.push({ type: 'emote_set.*', condition: { object_id: this.setId } });
    if (this.wantCosmetics) {
      const cond = { ctx: 'channel', platform: 'TWITCH', id: this.channelId };
      for (const type of ['entitlement.*', 'cosmetic.*', 'emote_set.*']) subs.push({ type, condition: cond });
    }
    return subs;
  }

  connect() {
    const ws = new this.WS(EVENTS_URL);
    this.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      this.onMessage(m, ws);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || !this.channelId) return;
      this.ws = null;
      // 4001-4004/4009/4010 mean a client bug: log it and don't loop.
      if ([4001, 4002, 4003, 4004, 4009, 4010].includes(e && e.code)) { this.log(`[7tv] events closed ${e.code} ${e.reason || ''}; not reconnecting`); return; }
      const delay = (e && e.code === 4007 ? 5 * 60000 : Math.min(60000, 2000 * 2 ** this.retry++)) + Math.floor(Math.random() * 1000);
      this.timer = this.setTimer(() => { if (this.channelId) this.connect(); }, delay);
    };
  }

  onMessage(m, ws) {
    switch (m.op) {
      case OP.HELLO:
        this.retry = 0;
        for (const d of this.subscriptions()) ws.send(JSON.stringify({ op: OP.SUBSCRIBE, d }));
        break;
      case OP.DISPATCH: this.dispatch(m.d); break;
      case OP.RECONNECT: try { ws.close(); } catch { /* ignore */ } break;
      case OP.ERROR: this.log(`[7tv] events error: ${JSON.stringify(m.d).slice(0, 200)}`); break;
      default: break;
    }
  }

  /** Applies one dispatch ({ type, body }). Exposed for tests. */
  dispatch(d) {
    if (!d || !d.body) return;
    const body = d.body;
    const obj = body.object;
    switch (d.type) {
      case 'cosmetic.create': {
        if (!obj) return;
        if (obj.kind === 'PAINT') { const css = paintCss(obj); if (css) this.paints.set(obj.id, css); }
        if (obj.kind === 'BADGE') { const b = badgeFrom7tv(obj); if (b) this.badges.set(obj.id, b); }
        this.onCosmetics(this.usersWith(obj.id));
        break;
      }
      case 'entitlement.create':
      case 'entitlement.delete': {
        if (!obj) return;
        const on = d.type === 'entitlement.create';
        const ids = entitlementTwitchIds(obj);
        for (const id of ids) {
          if (obj.kind === 'PAINT') { if (on) this.userPaint.set(id, obj.ref_id); else if (this.userPaint.get(id) === obj.ref_id) this.userPaint.delete(id); }
          if (obj.kind === 'BADGE') { if (on) this.userBadge.set(id, obj.ref_id); else if (this.userBadge.get(id) === obj.ref_id) this.userBadge.delete(id); }
          if (obj.kind === 'EMOTE_SET') this.onUserSet(id, obj.ref_id, on);
        }
        if (obj.kind !== 'EMOTE_SET') this.onCosmetics(ids);
        break;
      }
      case 'emote_set.create':
        if (obj && (obj.flags & 4)) {
          this.personalSets.add(obj.id);
          const add = (obj.emotes || []).map((e) => from7tv(e, { animated: this.animated })).filter(Boolean);
          if (add.length) this.onEmotes({ setId: obj.id, add, remove: [], personal: true });
        }
        break;
      case 'emote_set.update': {
        const ch = emoteSetChanges(body, { animated: this.animated });
        if (!ch.add.length && !ch.remove.length) return;
        const personal = body.id !== this.setId;
        if (personal && !this.personalSets.has(body.id)) return; // a set we don't show
        this.onEmotes({ setId: body.id, ...ch, personal });
        break;
      }
      default: break;
    }
  }

  usersWith(cosmeticId) {
    const ids = [];
    for (const [u, p] of this.userPaint) if (p === cosmeticId) ids.push(u);
    for (const [u, b] of this.userBadge) if (b === cosmeticId) ids.push(u);
    return ids;
  }

  /** The cosmetics to draw for a Twitch user: { paintId, css, badge } (only those already defined). */
  cosmeticsFor(twitchId) {
    const paintId = this.userPaint.get(twitchId);
    const badgeId = this.userBadge.get(twitchId);
    return {
      paintId: paintId && this.paints.has(paintId) ? paintId : null,
      badge: (badgeId && this.badges.get(badgeId)) || null,
    };
  }
}
