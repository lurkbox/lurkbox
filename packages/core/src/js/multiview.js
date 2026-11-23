// Multi-view: 2–4 live streams at once (TV and tablet layouts). Each tile is its own DirectEngine (one hls.js
// instance per tile); one tile is active: it alone has the sound, the normal quality and the chat side panel (with
// the composer). Every tile's raids come over the one EventSub socket and count down on their own tile. The rules
// (geometry, D-pad, audio, caps, add/remove/swap, raids, the saved set) are pure, in ../shared/multiview.js.
// A on the active tile opens its control bar: the player's seek bar (live rewind through the archive VOD), its icon
// row (live, channel points, follow, More = the tile menu) and pop-overs. Twitch's chat frame follows the active
// tile: the chat panel in "Twitch chat" style, otherwise hidden under the tiles for channel points.
import { el, button, toast, fmtViewers } from './ui.js';
import { A, B, X, Y, START, BACK, UP, DOWN, LEFT, RIGHT, hint } from './input.js';
import { DirectEngine, EVENTS } from './direct-engine.js';
import { Chat, promptChatSignIn } from './chat.js';
import { ChatSending } from './chat-sending.js';
import { sendAuthState } from './chat-send.js';
import { TileRaids } from './raid.js';
import { state, saveSettings, onState } from './state.js';
import { backgroundCap, pickDefaultQuality } from './hls-util.js';
import { pickFromList, openModal } from './modal.js';
import { followedLive, isFollowing } from './api.js';
import * as MV from '../shared/multiview.js';
import { TwitchChatFrame } from './twitch-chat.js';
import { SeekBar } from './seekbar.js';
import { Scrubber, seekJump } from './seek.js';
import { LiveRewind } from './live-rewind.js';
import { Popover } from './popover.js';
import { icon } from './icons.js';
import { multiControls, controlIcon, controlLabel, shortCount, anchorPopover, OVERLAY_HIDE_MS, POPOVER_HIDE_MS } from './player-ui.js';
import { moveFocus, focusEl } from './focus.js';
import { pressFollow } from './follow.js';
import { chatLayout, chatPanelWidth } from '../shared/chat-layout.js';
import { twitchChatZoom } from '../shared/tv-zoom.js';

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

const streamLabel = (s) => `${s.user_name || s.user_login}${s.game_name ? ` · ${s.game_name}` : ''}`;

/**
 * Picks followed live channels not in `tiles`, up to the free slots: with one slot, a plain list (A picks); with
 * more, A ticks channels and Start or Y (or the Watch button) confirms. onPick gets the streams in pick order.
 */
export async function pickLiveChannels({ tiles, title = 'Watch with…', onPick }) {
  const limit = MV.freeSlots(tiles.length);
  if (!limit) { toast(`Multi-view shows at most ${MV.MAX_TILES} streams`, 2500); return; }
  let live = [];
  try { live = state.auth.signedIn ? await followedLive() : []; } catch { live = []; }
  const list = MV.candidates(live, tiles);
  if (!list.length) { toast(state.auth.signedIn ? 'No other followed channel is live' : 'Sign in to pick from your followed channels', 3000); return; }
  const byLogin = (login) => list.find((s) => s.user_login === login);
  if (limit === 1 || list.length === 1) {
    pickFromList({ title, items: list.map((s) => ({ label: streamLabel(s), value: s.user_login })), onPick: (login) => onPick([byLogin(login)]) });
    return;
  }
  let selected = [];
  const items = list.map((s) => button(streamLabel(s), () => {
    const r = MV.toggleSelection(selected, s.user_login, limit);
    if (r.error) toast(`At most ${limit} more stream${limit === 1 ? '' : 's'} fit`, 2000);
    selected = r.selected;
    update();
  }, { class: 'pick-item', dataset: { value: s.user_login } }));
  const count = el('div', { class: 'pick-count' });
  const go = button('', () => done(), { class: 'primary pick-go' });
  const update = () => {
    for (const b of items) {
      const on = selected.includes(b.dataset.value);
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    count.textContent = `${selected.length} of ${limit} picked`;
    go.textContent = selected.length ? `Watch ${tiles.length + selected.length} streams` : 'Watch the focused one';
  };
  const done = () => {
    const a = document.activeElement;
    const focused = a && a.classList.contains('pick-item') ? a.dataset.value : null;
    const logins = MV.confirmSelection(selected, focused, limit);
    if (!logins.length) return;
    m.close();
    onPick(logins.map(byLogin).filter(Boolean));
  };
  update();
  const m = openModal({
    title,
    class: 'pick-many',
    content: el('div', { class: 'pick-many-body' }, hint('{A} pick · {START} or {Y} watch', 'hint pick-hint'), count, el('div', { class: 'pick-list' }, ...items), el('div', { class: 'row' }, go)),
    focus: '.pick-item',
    onAction: (action) => {
      if (action === START || action === Y) { done(); return true; }
      return false;
    },
  });
}

export class MultiView {
  /** onExit(channel): leave for the single player on that channel (B, "Watch only this", one tile left). */
  constructor({ watcher, onExit, signIn = () => {} }) {
    this.watcher = watcher;
    this.onExit = onExit;
    this.signIn = signIn;
    this.screen = el('div', { id: 'multi-screen', hidden: true });
    this.stage = el('div', { id: 'multi-stage' });
    this.chatPanel = el('aside', { id: 'multi-chat', 'aria-label': 'Chat' });
    this.screen.append(this.stage, this.chatPanel);
    document.body.append(this.screen);
    this.chat = new Chat(this.chatPanel);
    // Sending: the active tile's chat gets the player's composer (View/Select, quick chat, emotes).
    this.sending = new ChatSending({ chat: this.chat, panel: this.chatPanel, screen: this.screen, current: () => this.current(), onLeave: () => this.leaveComposer() });
    this.composer = this.sending.composer;
    this.chatLogin = null;
    // A raid on any tile counts down on that tile; it then plays the raid target in place.
    this.raids = new TileRaids({
      onShow: (t) => this.renderRaid(t),
      onTick: (t, left) => { const c = t.node.querySelector('.mv-raid-count'); if (c) c.textContent = String(left); },
      onFollow: (t, ev) => this.followRaid(t, ev),
      onEnd: (t) => this.renderRaid(t),
    });
    // Channel points (and the chat panel in "Twitch chat" style): Twitch's chat page for the active tile.
    this.tchat = new TwitchChatFrame(this.screen, { id: 'multi-tchat', panelId: 'multi-tchat-panel' });
    this.points = { signedIn: false, balance: null };
    this.pointsPanel = false;
    if (window.lurkbox.onPointsState) {
      window.lurkbox.onPointsState((st) => {
        if (!this.isOpen || !st || st.login !== this.tchat.login) return;
        this.points = st;
        this.renderBar();
      });
      window.lurkbox.onPointsEvent((ev) => { if (ev && ev.type === 'panel-closed' && this.pointsPanel) this.closePointsPanel({ focusIcon: true }); });
    }
    onState((what) => {
      if (!this.isOpen) return;
      if (what === 'settings' || what === 'signin' || what === 'auth') { this.openTwitchChat(); this.render(); this.followActive(); }
    });
    this.buildBar();
    this.tiles = []; // { ch, node, host, engine, error, quality, rewind }
    this.active = 0;
    this.layout = 'side';
    this.background = false;
    this.chatOn = false;
    this.isOpen = false;
    this.stage.addEventListener('click', (e) => {
      if (e.target.closest('.po-ui')) return; // the control bar and its pop-overs
      const n = e.target.closest('.mv-tile');
      if (!n) return;
      const i = this.tiles.findIndex((t) => t.node === n);
      if (i < 0) return;
      if (i === this.active) this.openBar(); else this.setActive(i);
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
    this.closePointsPanel();
    this.closeBar();
    this.tchat.close();
    this.tchatWant = null;
    for (const t of this.tiles) this.destroyTile(t);
    this.tiles = [];
    this.stage.replaceChildren();
    this.raids.clearAll();
    this.sending.cpop.close({ returnFocus: false });
    this.leaveComposer();
    this.composer.clear();
    this.composer.setVisible(false);
    this.chat.leave();
    this.chatLogin = null;
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
    t.rewind = new LiveRewind({ engine: () => t.engine, channel: () => t.ch, log: mlog, onChange: () => this.renderBar() });
    this.tiles.push(t);
    this.stage.append(node);
    this.startTile(t);
    return t;
  }

  startTile(t) {
    if (t.engine) t.engine.destroy();
    t.rewind.reset();
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
    this.raids.clear(t);
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
      this.renderRaid(t);
    });
    const twitchStyle = state.settings.chatStyle === 'twitch';
    this.screen.classList.toggle('twitch-chat', this.chatOn && twitchStyle);
    // Twitch's chat in the side panel: the panel keeps the width of Twitch's frame at the TV zoom (as in the player).
    if (twitchStyle) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const zoom = twitchChatZoom(state.settings, window.screen && window.screen.height);
      const px = chatPanelWidth({ style: 'twitch', chatWidth: chatLayout(state.settings).chatWidth, windowWidth: window.innerWidth, zoom, remPx });
      this.screen.style.setProperty('--chat-w', `${px}px`);
    } else this.screen.style.removeProperty('--chat-w');
    const mode = this.pointsPanel ? 'modal' : this.chatOn && twitchStyle && this.tchat.login ? 'panel' : 'hidden';
    if (this.tchat.mode !== mode) this.tchat.setMode(mode);
    // Twitch's frame has its own input, so the composer is only in Lurkbox chat.
    this.composer.setVisible(this.chatOn && !twitchStyle && state.auth.signedIn);
    this.placeBar();
  }

  setActive(i) {
    if (i === this.active || !this.tiles[i]) return;
    this.closeBar();
    this.active = i;
    this.render();
    this.applyAll();
    this.followActive();
  }

  /** The chat panel follows the active tile; raids are watched on every tile; the set is remembered. */
  followActive() {
    const ch = this.current();
    if (!ch) return;
    // Lurkbox chat (IRC) only in Lurkbox chat style; Twitch's frame replaces it in the other.
    const login = this.chatOn && state.settings.chatStyle !== 'twitch' ? ch.login : null;
    if (login !== this.chatLogin) {
      // A draft (and the composer's pop-overs) belong to their channel.
      this.sending.cpop.close({ returnFocus: false });
      this.composer.clear();
      this.chat.setOwnEmotes([]);
      if (login) { this.chat.join(login); this.sending.loadOwnEmotes().catch(() => {}); } else this.chat.leave();
      this.chatLogin = login;
    }
    this.openTwitchChat();
    if (ch.following == null && ch.userId && state.auth.signedIn) {
      isFollowing(ch.userId).then((f) => { if (f != null && ch.following == null) { ch.following = f; this.renderBar(); } }).catch(() => {});
    }
    this.watcher.watchMany(MV.raidTargets(this.tiles.map((t) => t.ch)));
    this.remember();
  }

  /** Twitch's chat frame for the active tile: always in "Twitch chat" style, else only with a twitch.tv web session. */
  openTwitchChat() {
    const ch = this.current();
    const login = ch ? ch.login : null;
    const want = login && `${login}|${state.settings.chatStyle}`;
    if (want === this.tchatWant) return;
    this.tchatWant = want;
    this.points = { signedIn: false, balance: null };
    if (!login) { this.tchat.close(); return; }
    if (state.settings.chatStyle === 'twitch') { this.tchat.open(login); this.render(); return; }
    this.tchat.close();
    if (!window.lurkbox.playerSessionStatus) return;
    window.lurkbox.playerSessionStatus().then((st) => {
      if (!this.isOpen || this.tchatWant !== want) return;
      if (st && st.signedIn) { this.tchat.open(login); this.render(); this.renderBar(); }
    }).catch(() => {});
  }

  /** Saves this set for "Resume multi-view" (per account, 2+ tiles). */
  remember() {
    const me = state.auth.user;
    const next = me && MV.rememberSet(state.settings.multiSets, me.id, this.tiles.map((t) => t.ch));
    if (next) saveSettings({ multiSets: next }).catch(() => {});
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

  /** Adds these streams (the last one added becomes active). */
  add(streams) {
    let tiles = this.tiles.map((t) => t.ch);
    let active = this.active;
    const added = [];
    for (const s of [].concat(streams)) {
      const ch = tileChannel(s);
      const r = MV.addTile(tiles, active, ch);
      if (r.error) { toast(r.error === 'full' ? `Multi-view shows at most ${MV.MAX_TILES} streams` : `${ch.name} is already here`, 2500); continue; }
      ({ tiles, active } = r);
      added.push(ch);
    }
    if (!added.length) return;
    const fresh = added.map((ch) => this.addTileNode(ch));
    this.rebuild([...this.tiles.filter((x) => !fresh.includes(x)), ...fresh], active);
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
    pickLiveChannels({ tiles: this.tiles.map((t) => t.ch), title: 'Add to multi-view', onPick: (list) => this.add(list) });
  }

  // ---- the active tile's overlay ----

  openMenu() {
    const t = this.tiles[this.active];
    if (!t) return;
    const i = this.active;
    const items = [];
    const raid = this.raids.get(t);
    if (raid) {
      items.push({ label: `Follow the raid to ${raid.ev.to_broadcaster_user_name} now`, value: 'raid-go' });
      items.push({ label: raid.mode === 'countdown' ? 'Cancel the raid (stay)' : 'Dismiss the raid', value: 'raid-cancel' });
    }
    if (t.error) items.push({ label: 'Try again', value: 'retry' });
    if (t.engine) items.push({ label: `Quality: ${t.quality ? (t.engine.getQualities().find((q) => q.group === t.quality) || {}).name || t.quality : 'Auto'}`, value: 'quality' });
    items.push({ label: this.chatOn ? 'Hide chat' : 'Show chat', value: 'chat' });
    items.push({ label: 'Send a message', value: 'compose' });
    items.push({ label: `Layout: ${MV.LAYOUT_NAMES[MV.nextLayout(this.layout, this.tiles.length)]}`, value: 'layout' });
    if (this.tiles.length < MV.MAX_TILES) items.push({ label: 'Add stream…', value: 'add' });
    if (this.layout === 'big' && i !== 0) items.push({ label: 'Move to the big tile', value: 'big' });
    items.push({ label: 'Remove from multi-view', value: 'remove' });
    items.push({ label: 'Watch only this', value: 'only' });
    pickFromList({
      title: t.ch.name,
      items,
      onPick: (v) => {
        if (v === 'raid-go') this.raids.followNow(t);
        else if (v === 'raid-cancel') this.raids.cancel(t);
        else if (v === 'compose') this.openComposer();
        else if (v === 'retry') this.startTile(t);
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

  // ---- raids: each tile counts down and follows in place ----

  onRaid(ev) {
    if (!this.isOpen) return;
    const i = MV.raidTileIndex(this.tiles.map((t) => t.ch), ev);
    if (i < 0) return;
    mlog(`[multi] raid ${ev.from_broadcaster_user_login} -> ${ev.to_broadcaster_user_login} (tile ${i})`);
    this.raids.start(this.tiles[i], ev, { follow: !!state.settings.raidFollow, delaySec: state.settings.raidDelay });
  }

  /** The tile's compact raid banner (or none). B cancels / A follows only on the active tile; its menu has both. */
  renderRaid(t) {
    const r = this.raids.get(t);
    let n = t.node.querySelector('.mv-raid');
    t.node.classList.toggle('mv-raiding', !!r);
    if (!r) { if (n) n.remove(); return; }
    const isActive = this.tiles[this.active] === t;
    const sig = `${r.ev.to_broadcaster_user_login}|${r.mode}|${isActive}`;
    if (n && n.dataset.sig === sig) return;
    if (n) n.remove();
    const countdown = r.mode === 'countdown';
    n = el('div', { class: 'mv-raid', dataset: { sig }, role: 'status' },
      el('div', { class: 'mv-raid-line' },
        el('span', { class: 'mv-raid-text' }, countdown ? `Raiding ${r.ev.to_broadcaster_user_name}` : `${r.ev.from_broadcaster_user_name} is raiding ${r.ev.to_broadcaster_user_name}`),
        countdown ? el('span', { class: 'mv-raid-count' }, String(r.left)) : null),
      el('div', { class: 'mv-raid-sub' }, `${fmtViewers(r.ev.viewers)} viewers`),
      isActive ? hint(countdown ? '{B} stay · {A} go now' : '{A} follow · {B} dismiss', 'hint mv-raid-hint') : el('div', { class: 'mv-raid-sub' }, 'Select this tile to stay'));
    t.node.append(n);
  }

  /** The raid target replaces its tile in place (or the tile goes, if the target is already on screen). */
  followRaid(t, ev) {
    const i = this.tiles.indexOf(t);
    if (i < 0 || !this.isOpen) return;
    if (i === this.active) this.closeBar();
    const ch = MV.raidChannel(ev);
    const next = MV.replaceTile(this.tiles.map((x) => x.ch), i, ch);
    if (next.length < this.tiles.length) { toast(`${ev.to_broadcaster_user_name} is already here`, 3000); this.remove(i); return; }
    toast(`${ev.from_broadcaster_user_name} raided ${ev.to_broadcaster_user_name}: following in its tile`, 4000, 'ok');
    t.ch = ch;
    t.quality = null;
    t.node.dataset.login = ch.login;
    t.node.querySelector('.mv-name').textContent = ch.name;
    this.renderRaid(t);
    this.startTile(t);
    this.followActive();
  }

  // ---- the active tile's control bar (the player's seek bar, icon row and pop-overs) ----

  buildBar() {
    this.seekBar = new SeekBar({ onSeek: (t) => this.tileSeek(t), onPreview: () => this.bumpBar() });
    this.scrubber = new Scrubber({
      position: () => { const m = this.seekModel(); return m ? m.pos : 0; },
      bounds: () => { const m = this.seekModel(); return m ? [m.min, m.max] : [0, 0]; },
      onPreview: (t) => { this.seekBar.preview = t; this.renderSeek(); this.bumpBar(); },
      onCommit: (t) => { this.seekBar.preview = null; this.tileSeek(t); },
    });
    this.barButtons = {};
    for (const key of multiControls({ points: true, follow: true })) {
      const b = el('button', { type: 'button', class: 'po-icon focusable', dataset: { key, focusKey: `mv-${key}` }, 'aria-haspopup': key === 'points' ? 'dialog' : null },
        icon(controlIcon(key, {})), key === 'points' ? el('span', { class: 'po-count', hidden: true }) : null);
      b.dataset.icon = controlIcon(key, {});
      b.addEventListener('click', () => { this.bumpBar(); this.onBarControl(key, b); });
      this.barButtons[key] = b;
    }
    this.barRow = el('div', { class: 'po-row' }, Object.values(this.barButtons));
    this.bar = el('div', { class: 'mv-bar po-panel po-ui', hidden: true }, this.barRow);
    this.pop = new Popover({
      scope: this.bar,
      focus: (n) => focusEl(n, { instant: true }),
      move: (dir, scope) => moveFocus(dir, scope),
      active: () => document.activeElement,
      mount: (node, opener) => { const t = this.tiles[this.active]; if (t) t.node.append(node); this.placePop(node, opener); },
    });
    this.barOn = false;
    setInterval(() => { if (this.barOn) this.renderSeek(); }, 1000);
  }

  tileSeekState() { const t = this.tiles[this.active]; return t && t.engine ? t : null; }
  seekModel() { const t = this.tileSeekState(); return t ? t.rewind.model() : null; }
  tileSeek(t) { const tile = this.tileSeekState(); if (tile) tile.rewind.seekTo(t).catch((e) => mlog(`[multi] seek failed: ${e.message}`)); }
  renderSeek() {
    const m = this.barOn ? this.seekModel() : null;
    const bar = this.seekBar.node;
    if (m && bar.parentNode !== this.bar) this.bar.insertBefore(bar, this.barRow);
    if (!m && bar.parentNode) bar.remove();
    if (m && !bar.matches('.scrubbing:active')) this.seekBar.update(m);
  }

  barCtx() {
    const t = this.tiles[this.active];
    const ch = t ? t.ch : {};
    let behind = false;
    try { behind = !!(t && t.engine && t.engine.latency() > 8); } catch { /* not ready */ }
    return {
      rewound: !!(t && t.rewind.rewound), behind,
      points: this.points.signedIn && Number.isFinite(this.points.balance) ? this.points.balance : null,
      following: ch.following == null ? null : ch.following,
      name: ch.name || ch.login || '',
    };
  }

  /** Shows the bar on the active tile, focused on its first control (or on `focus`, a control key). */
  openBar(focus = null) {
    const t = this.tiles[this.active];
    if (!t) return;
    this.barOn = true;
    t.node.append(this.bar);
    this.bar.hidden = false;
    t.node.classList.add('mv-bar-on');
    this.renderBar();
    const b = (focus && this.barButtons[focus] && !this.barButtons[focus].hidden ? this.barButtons[focus] : null) || this.barRow.querySelector('.po-icon:not([hidden])');
    if (b) focusEl(b, { instant: true });
    this.bumpBar();
  }

  closeBar() {
    if (!this.barOn) return;
    this.barOn = false;
    clearTimeout(this.barTimer);
    this.pop.close({ returnFocus: false });
    this.scrubber.cancel();
    this.seekBar.preview = null;
    this.bar.hidden = true;
    for (const t of this.tiles) t.node.classList.remove('mv-bar-on');
    if (this.bar.contains(document.activeElement)) document.activeElement.blur();
  }

  /** The bar hides after a few idle seconds (longer with a pop-over open). */
  bumpBar() {
    clearTimeout(this.barTimer);
    if (!this.barOn) return;
    this.barTimer = setTimeout(() => this.closeBar(), this.pop.isOpen ? POPOVER_HIDE_MS : OVERLAY_HIDE_MS);
  }

  /** Keeps the bar on the active tile after a re-render (a swap or a new layout moves the tiles, not the bar). */
  placeBar() {
    const t = this.tiles[this.active];
    if (this.barOn && t && this.bar.parentNode !== t.node) this.closeBar();
  }

  renderBar() {
    if (!this.barOn) return;
    const t = this.tiles[this.active];
    if (!t) return;
    const ctx = this.barCtx();
    const shown = new Set(multiControls({
      points: !!this.tchat.login,
      follow: !!(t.ch.login && window.lurkbox.followChannel && state.auth.signedIn),
    }));
    for (const [key, b] of Object.entries(this.barButtons)) {
      b.hidden = !shown.has(key);
      const name = controlIcon(key, ctx);
      if (b.dataset.icon !== name) { b.dataset.icon = name; b.firstElementChild.replaceWith(icon(name)); }
      b.setAttribute('aria-label', controlLabel(key, ctx));
      b.title = controlLabel(key, ctx);
      b.classList.toggle('on', key === 'follow' && ctx.following === true);
      b.classList.toggle('expanded', this.pop.key === key);
    }
    const count = this.barButtons.points.querySelector('.po-count');
    count.hidden = ctx.points == null;
    count.textContent = ctx.points == null ? '' : shortCount(ctx.points);
    if (this.bar.contains(document.activeElement) && document.activeElement.hidden) focusEl(this.barRow.querySelector('.po-icon:not([hidden])'), { instant: true });
    this.renderSeek();
    this.pop.update();
  }

  onBarControl(key, b) {
    const t = this.tiles[this.active];
    if (!t) return;
    if (key === 'live') t.rewind.goLive();
    else if (key === 'follow') this.toggleFollow(t);
    else if (key === 'points') this.openPointsPop(b);
    else if (key === 'more') { this.closeBar(); this.openMenu(); }
  }

  /** Controller input while the bar is up: the seek bar scrubs, the row moves, B (or Down from the row) closes it. */
  handleBar(action) {
    this.bumpBar();
    if (this.pop.isOpen) { this.pop.handle(action); return; }
    const a = document.activeElement;
    const onSeek = a === this.seekBar.node;
    const j = seekJump(action, { onBar: onSeek });
    if (j && this.seekModel()) {
      if (j.delta) this.scrubber.nudge(j.delta);
      else { const m = this.seekModel(); this.scrubber.setTarget(j.to === 'start' ? m.min : m.max); }
      return;
    }
    if (onSeek && (action === LEFT || action === RIGHT)) { this.scrubber.press(action === LEFT ? -1 : 1); return; }
    if (action === B || (action === DOWN && !onSeek)) { this.closeBar(); return; }
    if (action === A) { if (!onSeek && a && this.bar.contains(a) && a.click) a.click(); return; }
    if (DIR[action]) {
      if (!this.bar.contains(a)) { const b = this.barRow.querySelector('.po-icon:not([hidden])'); if (b) focusEl(b, { instant: true }); return; }
      moveFocus(action, this.bar);
    }
  }

  async toggleFollow(t) {
    const ch = t.ch;
    if (!ch.login) return;
    const f = await pressFollow({ login: ch.login, id: ch.userId, name: ch.name || ch.login }, ch.following == null ? null : ch.following, { signIn: () => { this.signIn(); } });
    ch.following = f;
    this.renderBar();
  }

  placePop(node, opener) {
    const t = this.tiles[this.active];
    if (!node.isConnected || !opener || !t) return;
    const box = t.node.getBoundingClientRect();
    const { left, bottom } = anchorPopover(opener.getBoundingClientRect(), { width: node.offsetWidth, height: node.offsetHeight }, box, { margin: 8, gap: 10 });
    node.style.left = `${left}px`;
    node.style.bottom = `${bottom}px`;
    node.style.maxHeight = `${Math.max(120, box.height - bottom - 8)}px`;
  }

  /** The player's channel-points pop-over: the balance, Rewards, Predictions & polls. */
  openPointsPop(opener) {
    if (this.pop.key === 'points') { this.pop.close(); return; }
    const bal = el('div', { class: 'po-pop-big' });
    const update = () => {
      const p = this.barCtx().points;
      bal.replaceChildren(icon('points', 'po-item-icon'), el('span', {}, p == null ? 'Balance not available yet' : p.toLocaleString('en-US')));
      bal.classList.toggle('dim', p == null);
    };
    update();
    const rewards = button([icon('gift', 'po-item-icon'), el('span', {}, 'Rewards')], () => this.openPointsPanel({ rewards: true }), { class: 'po-item', dataset: { focusKey: 'mv-pop-rewards' } });
    const preds = button([icon('poll', 'po-item-icon'), el('span', {}, 'Predictions & polls')], () => this.openPointsPanel({ rewards: false }), { class: 'po-item', dataset: { focusKey: 'mv-pop-predictions' } });
    const node = el('div', { class: 'po-pop po-ui pop-points', role: 'dialog', 'aria-label': 'Channel points' },
      el('div', { class: 'po-pop-title' }, 'Channel points'), el('div', { class: 'po-pop-body po-list' }, bal, rewards, preds));
    this.pop.open({ key: 'points', node, opener, initial: rewards, update: () => { update(); this.placePop(node, opener); }, onClose: () => this.renderBar() });
    this.renderBar();
    this.bumpBar();
  }

  /** The rewards view: Twitch's chat frame as a large modal over the tiles (as in the player). */
  async openPointsPanel({ rewards }) {
    if (!this.tchat.login || !window.lurkbox.pointsOpenPanel) return;
    this.closeBar();
    this.pointsPanel = true;
    if (!this.pointsBackdrop) {
      this.pointsBackdrop = el('div', { class: 'points-backdrop', hidden: true, onclick: () => this.closePointsPanel({ focusIcon: true }) }, hint('D-pad move · {A} select · {B} back / close', 'points-hint'));
      this.screen.append(this.pointsBackdrop);
    }
    this.pointsBackdrop.hidden = false;
    this.render();
    const r = await window.lurkbox.pointsOpenPanel({ rewards });
    if (r && !r.ok) toast(`Channel points: ${r.reason}`, 3000, 'warn');
    else if (rewards && r && !r.opened) toast('No channel points here (signed out, or the channel has none)', 3500);
  }

  async pointsBack() {
    const r = await window.lurkbox.pointsPad('b');
    if (r !== 'back' && this.pointsPanel) this.closePointsPanel({ focusIcon: true });
  }

  closePointsPanel({ focusIcon = false } = {}) {
    if (!this.pointsPanel) return;
    this.pointsPanel = false;
    if (this.pointsBackdrop) this.pointsBackdrop.hidden = true;
    if (window.lurkbox.pointsClosePanel) window.lurkbox.pointsClosePanel();
    this.render();
    if (focusIcon && this.isOpen) this.openBar('points');
  }

  // ---- sending ----

  /** True when the composer is on screen and usable (chat showing, signed in). */
  composerReachable() {
    return this.chatOn && sendAuthState(state.auth) === 'ok' && !this.composer.node.hidden;
  }

  /** View/Select (or the tile menu): chat on, focus the composer and open a keyboard. */
  openComposer() {
    const auth = sendAuthState(state.auth);
    if (auth !== 'ok') { promptChatSignIn(auth); return; }
    if (!this.chatOn) this.toggleChat();
    this.composer.focus({ keyboard: true });
  }

  leaveComposer() {
    const a = document.activeElement;
    if (a && this.composer.contains(a)) a.blur();
    document.body.classList.remove('composing');
  }

  // ---- input ----

  handle(action, source = 'pad') {
    if (this.pointsPanel) {
      if (action === B) { this.pointsBack(); return; }
      if (action === START) { this.closePointsPanel({ focusIcon: true }); return; }
      const key = { UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', A: 'a' }[action];
      if (key) window.lurkbox.pointsPad(key);
      return;
    }
    if (this.barOn) { this.handleBar(action); return; }
    const cpop = this.sending.cpop;
    if (cpop.isOpen) { cpop.handle(action, source); return; } // the emote picker or quick chat
    if (this.composer.contains(document.activeElement)) {
      if (this.composer.handle(action, source)) return;
      if (action === Y) this.leaveComposer();
      return; // the rest would act on the tiles behind it
    }
    const t = this.tiles[this.active];
    if (t && this.raids.active(t)) {
      if (action === B) { this.raids.cancel(t); return; }
      if (action === A) { this.raids.followNow(t); return; }
    }
    if (DIR[action]) {
      const next = MV.moveActive(MV.layoutRects(this.layout, this.tiles.length), this.active, DIR[action]);
      // RIGHT past the last tile: into the chat's message box (A then opens the keyboard).
      if (next === this.active && action === RIGHT && this.composerReachable()) { this.composer.focus({ keyboard: false }); return; }
      this.setActive(next);
      return;
    }
    if (action === BACK) this.openComposer();
    else if (action === A) this.openBar();
    else if (action === B) this.exit();
    else if (action === X) this.openAdd();
    else if (action === Y) this.cycleLayout();
  }
}
