// Multi-view: 2–4 live streams at once (TV and tablet layouts). Each tile is its own DirectEngine (one hls.js
// instance per tile); one tile is active: it alone has the sound, the normal quality, the chat side panel and the
// raid subscription. The rules (geometry, D-pad, audio, caps, add/remove/swap) are pure, in ../shared/multiview.js.
import { el, toast } from './ui.js';
import { A, B, X, Y, UP, DOWN, LEFT, RIGHT } from './input.js';
import { DirectEngine, EVENTS } from './direct-engine.js';
import { Chat } from './chat.js';
import { state } from './state.js';
import { backgroundCap, pickDefaultQuality } from './hls-util.js';
import { pickFromList } from './modal.js';
import { followedLive } from './api.js';
import * as MV from '../shared/multiview.js';

const DIR = { [UP]: 'up', [DOWN]: 'down', [LEFT]: 'left', [RIGHT]: 'right' };

function mlog(msg) {
  console.log(msg);
  if (window.lurkbox.log) window.lurkbox.log(msg);
}

/** A channel from a stream (Helix /streams) or a player/card channel. */
export function tileChannel(c) {
  if (c.user_login) return { login: c.user_login, name: c.user_name || c.user_login, userId: c.user_id, stream: c };
  return { login: c.login, name: c.name || c.login, userId: c.userId || c.id || null, stream: c.stream || null };
}

/** Picks one followed live channel not in `tiles` (a list modal); onPick gets the stream. */
export async function pickLiveChannel({ tiles, title = 'Watch with…', onPick }) {
  let live = [];
  try { live = state.auth.signedIn ? await followedLive() : []; } catch { live = []; }
  const list = MV.candidates(live, tiles);
  if (!list.length) { toast(state.auth.signedIn ? 'No other followed channel is live' : 'Sign in to pick from your followed channels', 3000); return; }
  pickFromList({
    title,
    items: list.map((s) => ({ label: `${s.user_name || s.user_login}${s.game_name ? ` · ${s.game_name}` : ''}`, value: s.user_login })),
    onPick: (login) => onPick(list.find((s) => s.user_login === login)),
  });
}

export class MultiView {
  /** onExit(channel): leave for the single player on that channel (B, "Watch only this", one tile left). */
  constructor({ watcher, onExit }) {
    this.watcher = watcher;
    this.onExit = onExit;
    this.screen = el('div', { id: 'multi-screen', hidden: true });
    this.stage = el('div', { id: 'multi-stage' });
    this.chatPanel = el('aside', { id: 'multi-chat', 'aria-label': 'Chat' });
    this.screen.append(this.stage, this.chatPanel);
    document.body.append(this.screen);
    this.chat = new Chat(this.chatPanel);
    this.tiles = []; // { ch, node, host, engine, error, quality }
    this.active = 0;
    this.layout = 'side';
    this.background = false;
    this.chatOn = false;
    this.isOpen = false;
    this.stage.addEventListener('click', (e) => {
      const n = e.target.closest('.mv-tile');
      if (!n) return;
      const i = this.tiles.findIndex((t) => t.node === n);
      if (i < 0) return;
      if (i === this.active) this.openMenu(); else this.setActive(i);
    });
    watcher.addEventListener('raid', (e) => this.onRaid(e.detail));
    window.addEventListener('resize', () => { if (this.isOpen) this.render(); });
  }

  /** Opens with these channels (2–4); the first is active. */
  open(channels, { active = 0 } = {}) {
    this.isOpen = true;
    this.tiles = [];
    this.stage.replaceChildren();
    for (const c of channels.slice(0, MV.MAX_TILES)) this.addTileNode(tileChannel(c));
    this.active = Math.min(active, this.tiles.length - 1);
    this.layout = MV.layoutsFor(this.tiles.length)[0];
    this.lastCount = this.tiles.length;
    this.chatOn = !!state.settings.chatDefault;
    this.screen.hidden = false;
    document.body.classList.add('multi-active');
    document.getElementById('app').inert = true;
    mlog(`[multi] open ${this.tiles.map((t) => t.ch.login).join(', ')}`);
    this.render();
    this.followActive();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const t of this.tiles) this.destroyTile(t);
    this.tiles = [];
    this.stage.replaceChildren();
    this.chat.leave();
    this.watcher.watch(null);
    this.screen.hidden = true;
    document.body.classList.remove('multi-active');
    document.getElementById('app').inert = false;
  }

  current() { return this.tiles[this.active] ? this.tiles[this.active].ch : null; }

  addTileNode(ch) {
    const host = el('div', { class: 'mv-video' });
    const err = el('div', { class: 'mv-error', hidden: true });
    const node = el('div', { class: 'mv-tile', dataset: { login: ch.login } }, host,
      el('div', { class: 'mv-label' }, el('span', { class: 'mv-live' }, 'LIVE'), el('span', { class: 'mv-name' }, ch.name)), err);
    const t = { ch, node, host, err, engine: null, error: null, quality: null };
    this.tiles.push(t);
    this.stage.append(node);
    this.startTile(t);
    return t;
  }

  startTile(t) {
    if (t.engine) t.engine.destroy();
    this.setTileError(t, null);
    const engine = new DirectEngine(t.host, {
      tag: `multi:${t.ch.login}`,
      log: mlog,
      lowLatency: state.settings.lowLatency !== false,
      autoCatchUp: state.settings.autoCatchUp !== false,
      codecPref: () => state.settings.videoCodec || 'h264',
      // No embed fallback here: the tile shows why (often the decoder's limit on streams at once); the others go on.
      onFallback: (reason) => this.failTile(t, reason),
      onAd: (ad) => t.node.classList.toggle('mv-ad', !!ad.inAd),
    });
    t.engine = engine;
    engine.addEventListener(EVENTS.READY, () => this.applyTile(t));
    engine.addEventListener(EVENTS.OFFLINE, () => this.failTile(t, 'offline'));
    engine.addEventListener(EVENTS.PLAYING, () => this.setTileError(t, null));
    this.applyTile(t);
    engine.load({ channel: t.ch.login });
  }

  destroyTile(t) {
    if (t.engine) { try { t.engine.destroy(); } catch { /* ignore */ } }
    t.engine = null;
  }

  failTile(t, reason) {
    mlog(`[multi] ${t.ch.login} failed: ${reason}`);
    this.destroyTile(t);
    this.setTileError(t, reason === 'offline' ? `${t.ch.name} is offline` : `Can't play this stream here (${reason}). The device may not decode this many at once.`);
  }

  setTileError(t, text) {
    t.error = text;
    t.err.hidden = !text;
    t.err.textContent = text || '';
    t.node.classList.toggle('mv-failed', !!text);
  }

  /** Sound and quality for one tile, from whether it is active. */
  applyTile(t) {
    const e = t.engine;
    if (!e) return;
    const i = this.tiles.indexOf(t);
    const isActive = i === this.active;
    e.setMuted(MV.tileMutes(this.tiles.length, this.active)[i]);
    if (isActive) {
      const v = Number(state.settings.volume);
      e.setVolume(Number.isFinite(v) ? v : 1);
    }
    const cap = MV.tileCap({ isActive, multiQuality: state.settings.multiQuality || '480', backgroundCap: this.background ? backgroundCap(state.settings.backgroundQuality || '720') : null });
    let q = 'auto';
    if (isActive) {
      if (t.quality) q = t.quality;
      else { const pick = pickDefaultQuality(e.getQualities(), state.settings.defaultQuality || 'auto'); if (pick) q = pick.group; }
    }
    e.setQualityCap(q, cap);
    e.play();
  }

  applyAll() { for (const t of this.tiles) this.applyTile(t); }

  render() {
    const rects = MV.layoutRects(this.layout, this.tiles.length);
    this.screen.classList.toggle('chat-on', this.chatOn);
    this.screen.dataset.layout = this.layout;
    this.tiles.forEach((t, i) => {
      const r = rects[i];
      Object.assign(t.node.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      t.node.classList.toggle('active', i === this.active);
    });
  }

  setActive(i) {
    if (i === this.active || !this.tiles[i]) return;
    this.active = i;
    this.render();
    this.applyAll();
    this.followActive();
  }

  /** The chat panel and the raid subscription follow the active tile. */
  followActive() {
    const ch = this.current();
    if (!ch) return;
    if (this.chatOn) this.chat.join(ch.login); else this.chat.leave();
    this.watcher.watch(ch.userId ? { id: ch.userId, login: ch.login } : null);
  }

  setBackground(on) {
    this.background = !!on;
    if (this.isOpen) this.applyAll();
  }

  // ---- changing the set ----

  rebuild(tiles, active) {
    // Keep the tiles (and their engines) that stay; drop the rest.
    const keep = new Set(tiles);
    for (const t of this.tiles) if (!keep.has(t)) { this.destroyTile(t); t.node.remove(); }
    this.tiles = tiles;
    this.active = active;
    for (const t of tiles) this.stage.append(t.node); // DOM order = tile order (moving a <video> keeps playing)
    // A different count starts from its default layout (two: side by side, three: one big, four: 2x2).
    this.layout = tiles.length !== this.lastCount ? MV.layoutsFor(tiles.length)[0] : MV.fitLayout(this.layout, tiles.length);
    this.lastCount = tiles.length;
    this.render();
    this.applyAll();
    this.followActive();
  }

  add(stream) {
    const ch = tileChannel(stream);
    const r = MV.addTile(this.tiles.map((t) => t.ch), this.active, ch);
    if (r.error) { toast(r.error === 'full' ? `Multi-view shows at most ${MV.MAX_TILES} streams` : `${ch.name} is already here`, 2500); return; }
    const t = this.addTileNode(ch);
    this.rebuild([...this.tiles.filter((x) => x !== t), t], r.active);
  }

  remove(i) {
    const r = MV.removeTile(this.tiles.map((t) => t.ch), this.active, i);
    if (r.exit) { this.onExit(r.exit); return; }
    this.rebuild(this.tiles.filter((_, j) => j !== i), r.active);
  }

  swap(i, j) {
    const r = MV.swapTiles(this.tiles, this.active, i, j);
    this.rebuild(r.tiles, r.active);
  }

  cycleLayout() {
    this.layout = MV.nextLayout(this.layout, this.tiles.length);
    toast(`Layout: ${MV.LAYOUT_NAMES[this.layout]}`, 1500);
    this.render();
  }

  toggleChat() {
    this.chatOn = !this.chatOn;
    this.render();
    this.followActive();
  }

  exit() {
    const ch = MV.exitTarget(this.tiles.map((t) => t.ch), this.active);
    if (ch) this.onExit(ch);
  }

  openAdd() {
    if (this.tiles.length >= MV.MAX_TILES) { toast(`Multi-view shows at most ${MV.MAX_TILES} streams`, 2500); return; }
    pickLiveChannel({ tiles: this.tiles.map((t) => t.ch), title: 'Add to multi-view', onPick: (s) => this.add(s) });
  }

  // ---- the active tile's overlay ----

  openMenu() {
    const t = this.tiles[this.active];
    if (!t) return;
    const i = this.active;
    const items = [];
    if (t.error) items.push({ label: 'Try again', value: 'retry' });
    if (t.engine) items.push({ label: `Quality: ${t.quality ? (t.engine.getQualities().find((q) => q.group === t.quality) || {}).name || t.quality : 'Auto'}`, value: 'quality' });
    items.push({ label: this.chatOn ? 'Hide chat' : 'Show chat', value: 'chat' });
    items.push({ label: `Layout: ${MV.LAYOUT_NAMES[MV.nextLayout(this.layout, this.tiles.length)]}`, value: 'layout' });
    if (this.tiles.length < MV.MAX_TILES) items.push({ label: 'Add stream…', value: 'add' });
    if (this.layout === 'big' && i !== 0) items.push({ label: 'Move to the big tile', value: 'big' });
    items.push({ label: 'Remove from multi-view', value: 'remove' });
    items.push({ label: 'Watch only this', value: 'only' });
    pickFromList({
      title: t.ch.name,
      items,
      onPick: (v) => {
        if (v === 'retry') this.startTile(t);
        else if (v === 'quality') this.openQuality(t);
        else if (v === 'chat') this.toggleChat();
        else if (v === 'layout') this.cycleLayout();
        else if (v === 'add') this.openAdd();
        else if (v === 'big') this.swap(i, 0);
        else if (v === 'remove') this.remove(i);
        else if (v === 'only') this.onExit(t.ch);
      },
    });
  }

  openQuality(t) {
    if (!t.engine) return;
    pickFromList({
      title: 'Quality',
      items: t.engine.getQualities().map((q) => ({ label: q.name, value: q.group })),
      current: t.quality || 'auto',
      onPick: (g) => { t.quality = g === 'auto' ? null : g; this.applyTile(t); },
    });
  }

  // ---- raids: the active tile follows in place ----

  onRaid(ev) {
    if (!this.isOpen) return;
    const i = this.tiles.findIndex((t) => t.ch.userId && String(t.ch.userId) === String(ev.from_broadcaster_user_id));
    if (i < 0) return;
    if (!state.settings.raidFollow) { toast(`${ev.from_broadcaster_user_name} is raiding ${ev.to_broadcaster_user_name}`, 4000); return; }
    toast(`${ev.from_broadcaster_user_name} raided ${ev.to_broadcaster_user_name}: following in its tile`, 4000, 'ok');
    const ch = { login: ev.to_broadcaster_user_login, name: ev.to_broadcaster_user_name, userId: ev.to_broadcaster_user_id, stream: null };
    const next = MV.replaceTile(this.tiles.map((t) => t.ch), i, ch);
    if (next.length < this.tiles.length) { this.remove(i); return; } // already on screen
    const t = this.tiles[i];
    t.ch = ch;
    t.quality = null;
    t.node.dataset.login = ch.login;
    t.node.querySelector('.mv-name').textContent = ch.name;
    this.startTile(t);
    if (i === this.active) this.followActive();
  }

  // ---- input ----

  handle(action) {
    if (DIR[action]) { this.setActive(MV.moveActive(MV.layoutRects(this.layout, this.tiles.length), this.active, DIR[action])); return; }
    if (action === A) this.openMenu();
    else if (action === B) this.exit();
    else if (action === X) this.openAdd();
    else if (action === Y) this.cycleLayout();
  }
}
