// Player screen: Twitch embed, info overlay, chat panel and raid following.
import { el, button, toast, loadScript, fmtViewers, fmtUptime, fmtDate } from './ui.js';
import { A, B, X, Y, LB, RB, START, BACK, UP, DOWN, LEFT, RIGHT, DIRECTIONS, hint } from './input.js';
import { Scrubber, seekJump, fmtTime, resumeDecision, storyboardFrame, parseHelixDuration, matchArchive, rewindGeometry, rewindTarget } from './seek.js';
import { SeekBar } from './seekbar.js';
import { TwitchChatFrame } from './twitch-chat.js';
import { pickDropsChip } from './drops.js';
import { StartTimeline } from './start-timeline.js';
import { helix } from './api.js';
import { moveFocus, focusFirst, focusEl, focusables } from './focus.js';
import { snapshotFocus, restoreFocus, focusKey } from './focus-keep.js';
import { pickFromList, hasModal } from './modal.js';
import { state, onState, saveSettings, previewSettings } from './state.js';
import { tw, followedLive, usersByIds, isFollowing } from './api.js';
import { pressFollow } from './follow.js';
import { icon } from './icons.js';
import { overlayControls, fitControls, PINNED_CONTROLS, POPOVER_CONTROLS, controlIcon, controlLabel, shortCount, liveLabel, anchorPopover, OVERLAY_HIDE_MS, POPOVER_HIDE_MS } from './player-ui.js';
import { Popover } from './popover.js';
import { Slider, handleSliderAction } from './slider.js';
import { ChatControls } from './chat-controls.js';
import { chatEnv } from './views/settings-chat.js';
import { marqueeLine } from './marquee.js';
import { chatLayout, chatOverActive, chatPanelWidth, chatBox } from '../shared/chat-layout.js';
import { twitchChatZoom } from '../shared/tv-zoom.js';
import { DoubleTap } from '../shared/gestures.js';
import { bindPointerGestures } from './touch.js';
import { isTouchLayout, isPhoneLayout } from './layout.js';

/** Player log line: console plus userData/lurkbox.log (readable over SSH). */
function plog(msg) {
  console.log(`[player] ${msg}`);
  try { if (window.lurkbox.log) window.lurkbox.log(`[player] ${msg}`); } catch { /* ignore */ }
}

/** A finished VOD start timeline line ("[vod] ..."), to the console and lurkbox.log. */
function vlog(line) {
  if (!line) return;
  console.log(line);
  try { if (window.lurkbox.log) window.lurkbox.log(line); } catch { /* ignore */ }
}
import { Chat, promptChatSignIn } from './chat.js';
import { ChatSending } from './chat-sending.js';
import { openUserCard } from './social-ui.js';
import { sendAuthState } from './chat-send.js';
import { setQuickChatChannel } from './quick-chat.js';
import { takeDraft } from './emote-browser.js';
import { RaidCountdown } from './raid.js';
import { DirectEngine, EVENTS as DIRECT_EVENTS } from './direct-engine.js';
import { ClipEngine, ClipEmbed, clipSourcePlan } from './clip-engine.js';
import { clipAuthState, buildClipCreate, clipCreateResult, clipShortLink, addMyClip } from '../shared/my-clips.js';
import { liveBadge, catchUpDecision, backgroundCap, pickDefaultQuality } from './hls-util.js';

const EMBED_URL = 'https://player.twitch.tv/js/embed/v1.js';
const EMBED_PARENT = ['localhost']; // must match the host the UI is served from
/** Every control the bar can show, in order (overlayControls() picks the ones for what is playing). */
const ALL_CONTROLS = ['play', 'volume', 'quality', 'chat', 'compose', 'quick', 'live', 'points', 'clip', 'prev', 'next', 'vod', 'follow', 'channel', 'more', 'back'];
const LONG_PRESS_MS = 450;

const RAID_STATUS_TEXT = {
  off: 'Raid follow: idle',
  connecting: 'Raid follow: connecting…',
  active: 'Raid follow: watching for raids',
  reconnecting: 'Raid follow: reconnecting…',
  error: 'Raid follow: error, retrying',
  'signed-out': 'Raid follow needs sign-in',
};

/** "Clip created", with a QR code and short link to the clip's edit page on twitch.tv. */
function showClipToast({ id, editUrl }) {
  const qr = el('div', { class: 'clip-toast-qr', 'aria-hidden': 'true' });
  toast(el('div', { class: 'clip-toast' }, qr,
    el('div', { class: 'clip-toast-text' },
      el('strong', {}, 'Clip created'),
      el('span', { class: 'clip-toast-link' }, clipShortLink(id)),
      el('span', { class: 'clip-toast-hint' }, 'Scan to edit it on twitch.tv · in My clips on the channel page'))), 12000, 'clip-made');
  Promise.resolve(window.lurkbox.qrSvg(editUrl)).then((svg) => { if (typeof svg === 'string' && svg.startsWith('<svg')) qr.innerHTML = svg; }).catch(() => {});
}

let clipSignIn = null;
/** Signed out, or the token lacks clips:edit: offer the TV sign-in (for this account). */
async function promptClipSignIn(kind) {
  if (clipSignIn && !clipSignIn.closed) return;
  const [{ confirmDialog }, { tvSignIn }] = await Promise.all([import('./modal.js'), import('./auth.js')]);
  const again = kind === 'reauth';
  clipSignIn = confirmDialog({
    title: again ? 'Sign in again to clip' : 'Sign in to clip',
    message: again
      ? 'Lurkbox needs a fresh sign-in to make clips for this account (Twitch\'s "create clips" permission is missing).'
      : 'Sign in to Twitch to make clips.',
    yes: 'Sign in',
    no: 'Not now',
    onYes: () => tvSignIn({ accountId: again ? state.auth.active : null }),
  });
}

/** "Clipped by x · 1.2K views · Mar 3, 2026" */
function clipMeta(c) {
  return [c.creator_name ? `Clipped by ${c.creator_name}` : null, `${fmtViewers(c.view_count)} views`, c.created_at ? fmtDate(c.created_at) : null].filter(Boolean).join(' · ');
}

export class Player {
  constructor({ nav, watcher }) {
    this.nav = nav;
    this.watcher = watcher;
    this.screen = document.getElementById('player-screen');
    this.host = document.getElementById('player-host');
    this.overlay = document.getElementById('player-overlay');
    this.raidEl = document.getElementById('raid-overlay');
    this.statusEl = document.getElementById('player-status');
    this.chatPanel = document.getElementById('chat');
    this.chat = new Chat(this.chatPanel);
    // Sending (Lurkbox chat style): the composer at the bottom of the chat panel, with its emote picker and quick chat.
    this.sending = new ChatSending({
      chat: this.chat, panel: this.chatPanel, screen: this.screen,
      current: () => (this.current && this.current.kind === 'live' ? this.current : null),
      onLeave: () => this.leaveComposer(),
    });
    this.composer = this.sending.composer;
    this.cpop = this.sending.cpop;
    this.userEmotes = this.sending.userEmotes;
    // A name in chat (clicked, or a line picked with Up from the message box and A): the user card.
    this.chat.onUser = (u) => openUserCard(u, { openChannel: (x) => { this.nav.closePlayer(); this.nav.openChannel({ login: x.login, id: x.id, name: x.name }); } });
    this.linePick = null; // the chat line picked with the D-pad (from the message box), or null
    this.embed = null;
    this.current = null; // { kind: 'live'|'video', login, name, userId, stream, videoId, title }
    this.playlist = [];
    this.active = false;
    document.body.classList.remove('player-active');
    this.chatOn = null;
    this.raid = new RaidCountdown({
      onShow: (r) => this.renderRaid(r),
      onTick: (left) => { const c = this.raidEl.querySelector('.raid-count'); if (c) c.textContent = String(left); },
      onFollow: (ev) => this.followRaid(ev),
      onEnd: (reason) => { this.hideRaid(); if (reason === 'cancelled') toast('Raid cancelled. Staying here.', 2500); },
    });
    this.gateTimer = null;
    this.overlayTimer = null;
    this.resumeTimer = null;
    this.qualityApplied = false;
    this.raidStatus = 'off';

    // The iframe ignores the pointer (CSS), so the stage receives all mouse input.
    const stage = document.getElementById('player-stage');
    stage.addEventListener('click', (e) => {
      if (performance.now() - this.touchTapAt < 700) return; // a finger: the touch gestures below handle it
      if (e.target.closest('button, .po-ui, .play-prompt')) return;
      if (this.pop.isOpen) { this.pop.close(); this.bumpOverlay(); return; } // a click outside closes the pop-over
      if (this.overlayVisible()) this.hideOverlay(); else this.showOverlay();
    });
    stage.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, .po-ui')) return;
      if (window.lurkbox.toggleFullscreen) window.lurkbox.toggleFullscreen();
    });
    stage.addEventListener('wheel', (e) => {
      if (e.target.closest('#chat, .po-pop')) return;
      e.preventDefault();
      this.changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: false });
    // Touch and pen on the controls (dragging a slider, say) keep them up too.
    stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && this.overlayVisible()) this.bumpOverlay(); });
    stage.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' && e.buttons && this.overlayVisible()) this.bumpOverlay(); });
    // Moving the mouse brings the controls back (and keeps them up); they hide again after a few idle seconds.
    stage.addEventListener('mousemove', (e) => {
      // Only a real move: the first event just records where the pointer is (a window appearing under a resting
      // pointer sends one), and a few px of jitter don't count.
      const last = this.lastMouse;
      this.lastMouse = { x: e.screenX, y: e.screenY };
      if (last.x < 0 || Math.abs(e.screenX - last.x) + Math.abs(e.screenY - last.y) <= 4) { if (last.x >= 0) this.lastMouse = last; return; }
      if (!this.active || !document.body.classList.contains('input-mouse')) return;
      if (this.overlayVisible()) this.bumpOverlay(); else this.showOverlay();
    });
    this.lastMouse = { x: -1, y: -1 };
    this.installTouch(stage);

    // Seek bar + hold-to-scrub (VODs, and live rewind through the archive VOD on the direct engine).
    this.seekBar = new SeekBar({ onSeek: (t) => this.seekTo(t), onPreview: () => this.bumpOverlay() });
    this.scrubber = new Scrubber({
      position: () => { const m = this.seekModel(); return m ? m.pos : 0; },
      bounds: () => { const m = this.seekModel(); return m ? [m.min, m.max] : [0, 0]; },
      onPreview: (t) => { this.seekBar.preview = t; this.renderSeek(); },
      onCommit: (t) => { this.seekBar.preview = null; this.seekTo(t); },
    });
    this.rewind = null; // { id, since } while a live channel plays from its archive VOD
    this.archive = undefined; // the live stream's archive VOD: undefined = not looked up, false = none
    this.storyboard = null;

    // Channel points: Twitch's own chat page (hidden, or the chat panel in "Twitch chat" style).
    this.tchat = new TwitchChatFrame(this.screen);
    this.points = { signedIn: false, balance: null };
    this.pointsPanel = false;
    this.pointsOfferUntil = 0;
    if (window.lurkbox.onPointsState) {
      window.lurkbox.onPointsState((st) => {
        if (!this.current || st.login !== this.current.login) return;
        const changed = st.balance !== this.points.balance || st.signedIn !== this.points.signedIn;
        this.points = st;
        if (changed && this.overlayVisible()) this.renderOverlay(true);
      });
      window.lurkbox.onPointsEvent((ev) => {
        if (!this.active || !this.current || ev.login !== this.current.login || this.raid.active) return;
        const what = ev.type === 'prediction' ? 'Prediction' : 'Poll';
        this.pointsOfferUntil = performance.now() + 12000;
        toast(`${what}: ${ev.title || 'open now'}, press ${this.glyph('Y')} to open`, 12000);
      });
    }
    this.lastMinute = { at: 0, t: null };

    setInterval(() => this.tickLive(), 1000);

    watcher.addEventListener('raid', (e) => this.onRaid(e.detail));
    watcher.addEventListener('status', (e) => {
      this.raidStatus = e.detail.status;
      if (this.pop.key === 'more') this.pop.update();
    });

    // Overlay: built once and updated in place, so the focused control keeps its node.
    this.pop = new Popover({
      scope: this.overlay,
      focus: (n) => focusEl(n, { instant: true }),
      move: (dir, scope) => moveFocus(dir, scope),
      active: () => document.activeElement,
      mount: (node, opener) => { this.overlay.append(node); this.placePopover(node, opener); },
    });
    this.lastFocusKey = null;
    this.buildOverlay();

    // Chat layout: the chat pop-over and Settings → Chat change the same settings; apply them live.
    this.appliedStyle = state.settings.chatStyle;
    onState((what) => {
      if (what === 'signin' || what === 'auth' || what === 'account') { if (this.active) { this.applyLayout(); if (this.overlayVisible()) this.renderOverlay(true); } return; }
      if (what !== 'settings') return;
      if (this.active && this.current && this.current.kind === 'live' && state.settings.chatStyle !== this.appliedStyle) {
        this.appliedStyle = state.settings.chatStyle;
        this.openTwitchChat(this.current.login); // the style switches live, not only for the next channel
      }
      this.appliedStyle = state.settings.chatStyle;
      this.applyChatLayout();
      if (this.pop.isOpen) this.pop.update();
    });
    window.addEventListener('resize', () => { this.applyChatLayout(); if (this.pop.isOpen) this.pop.update(); });
  }

  raidStatusText() {
    if (!state.settings.raidFollow) return 'Raid follow: off (offer only)';
    if (this.current && this.current.kind !== 'live') return 'Raid follow: not for videos';
    return RAID_STATUS_TEXT[this.raidStatus] || `Raid follow: ${this.raidStatus}`;
  }

  // ---------- opening / switching ----------

  async openLive({ login, name, userId, stream }, playlist) {
    login = String(login).toLowerCase();
    if (this.vodTimeline) { vlog(this.vodTimeline.finish('left before PLAYING')); this.vodTimeline = null; }
    if (this.embedOnly && this.embedOnly !== login) this.embedOnly = null;
    if (Array.isArray(playlist) && playlist.length) this.playlist = playlist;
    if (!this.current || this.current.login !== login) { this.composer.clear(); this.chat.setOwnEmotes([]); } // a draft belongs to its channel
    // Emotes added on the channel page's Emotes tab wait for the player: they start (or extend) this channel's draft.
    const waiting = takeDraft(login);
    if (waiting) { const cur = this.composer.input.value.trim(); this.composer.setDraft(cur ? `${cur} ${waiting}` : waiting); }
    this.current = { kind: 'live', login, name: name || login, userId: userId || (stream && stream.user_id) || null, stream: stream || null };
    this.resetSeek();
    this.show();
    this.cancelRaid();
    this.setStatus('');
    this.qualityApplied = false;
    try {
      await this.ensureEmbed({ channel: login });
    } catch (e) {
      this.setStatus(`Could not load the Twitch player. Check the network.\n${e.message}`);
      return;
    }
    this.startGateLoop();
    this.openTwitchChat(login);
    this.applyLayout();
    this.resolveChannel(this.current);
    if (!state.auth.signedIn && window.lurkbox.liveInfo) this.loadLiveInfo(this.current);
  }

  /** opts.startAt: start there (seconds) without asking to resume, e.g. a clip's "Watch from here". */
  async openVideo(video, opts = {}) {
    if (this.current && this.current.kind === 'video') this.saveResume();
    const cur = { kind: 'video', login: video.user_login, name: video.user_name, userId: video.user_id, videoId: video.id, title: video.title, video };
    if (this.vodTimeline) vlog(this.vodTimeline.finish('left before PLAYING'));
    this.vodTimeline = new StartTimeline(video.id);
    this.current = cur;
    this.resetSeek();
    this.show();
    this.cancelRaid();
    this.setStatus('');
    this.qualityApplied = false;
    this.watcher.watch(null); // raids only matter for live channels
    this.closePointsPanel();
    this.tchat.close();
    this.loadFollow(cur);
    if (window.lurkbox.storyboard) window.lurkbox.storyboard(video.id).then((sb) => { if (cur === this.current) this.storyboard = sb; }).catch(() => {});
    let startAt = Math.max(0, Number(opts.startAt) || 0);
    const saved = !startAt && window.lurkbox.resumeGet ? await window.lurkbox.resumeGet(video.id).catch(() => null) : null;
    if (cur !== this.current) return;
    if (saved && resumeDecision({ position: saved.position, duration: saved.duration || parseHelixDuration(video.duration) }) === 'ask') {
      this.vodMark('resume prompt shown');
      startAt = await this.askResume(saved.position);
      this.vodMark('answered', startAt ? `resume at ${fmtTime(startAt)}` : 'start over');
      if (cur !== this.current) return;
    }
    if (startAt) plog(`video ${video.id}: resuming at ${fmtTime(startAt)}`);
    try {
      await this.ensureEmbed({ video: `v${video.id}`, startAt });
    } catch (e) {
      this.setStatus(`Could not load the Twitch player. Check the network.\n${e.message}`);
      return;
    }
    this.startGateLoop();
    if (this.chatOn) this.chat.leave(); // live chat doesn't match a VOD
  }

  /**
   * Plays a clip (Helix /clips item). list: the clips it came from (next/previous and "next clip" autoplay go through
   * it); channel: { login, name } of the broadcaster (Helix clips carry no login).
   */
  async openClip(clip, list = [], channel = {}) {
    if (this.current && this.current.kind === 'video') this.saveResume();
    if (this.vodTimeline) { vlog(this.vodTimeline.finish('left before PLAYING')); this.vodTimeline = null; }
    if (Array.isArray(list)) this.clipList = list.some((c) => c.id === clip.id) ? list : [clip]; // null: keep (next/previous)
    const cur = { kind: 'clip', login: channel.login || null, name: channel.name || clip.broadcaster_name, userId: clip.broadcaster_id, title: clip.title, clip };
    this.current = cur;
    this.resetSeek();
    this.show();
    this.cancelRaid();
    this.setStatus('');
    this.qualityApplied = true; // the clip engine picks its own quality
    this.watcher.watch(null);
    this.closePointsPanel();
    this.tchat.close();
    if (this.chatOn) this.chat.leave();
    this.destroyEngine();
    if (!cur.login && cur.userId && state.auth.signedIn) {
      usersByIds([cur.userId]).then((m) => { const u = m.get(cur.userId); if (u && cur === this.current) { cur.login = u.login; if (this.overlayVisible()) this.renderOverlay(true); } }).catch(() => {});
    }
    this.loadFollow(cur);
    const engine = state.settings.playerEngine === 'embed' ? 'embed' : 'direct';
    const hasHost = !!window.lurkbox.clipSources;
    let hostResult = null;
    if (engine === 'direct' && hasHost) hostResult = await window.lurkbox.clipSources(clip.id).catch((e) => ({ ok: false, reason: e.message }));
    if (cur !== this.current) return;
    const plan = clipSourcePlan({ engine, hasHost, hostResult });
    plog(`clip ${clip.id}: ${plan.kind}${plan.reason ? ` (${plan.reason})` : ` (${plan.qualities.map((q) => q.name).join(', ')})`}`);
    if (plan.kind === 'direct') {
      this.embed = new ClipEngine(this.host, { log: plog, preferred: () => state.settings.defaultQuality || 'auto' });
      this.embed.addEventListener('error', (code) => { if (cur === this.current && this.embed && this.embed.isDirect) { plog(`clip media error ${code}; Twitch's clip player`); this.playClipEmbed(cur); } });
      this.bindEngineEvents(DIRECT_EVENTS);
      this.applyBackground();
      this.embed.load({ qualities: plan.qualities });
    } else {
      if (hostResult && hostResult.reason === 'not-found') { this.setStatus('This clip was deleted.'); return; }
      this.playClipEmbed(cur);
    }
    this.armPlayWatchdog();
    if (this.overlayVisible()) this.renderOverlay();
  }

  /** Twitch's clip embed (the fallback; no quality or seeking). */
  playClipEmbed(cur) {
    this.destroyEngine();
    this.embed = new ClipEmbed(this.host, { slug: cur.clip.id, duration: cur.clip.duration });
    document.body.classList.add('embed-active');
    this.bindEngineEvents(DIRECT_EVENTS);
    if (this.overlayVisible()) this.renderOverlay(true);
  }

  /** The clip after (dir 1) or before (-1) this one in its list, or null. */
  clipNeighbour(dir) {
    const cur = this.current;
    const list = this.clipList || [];
    if (!cur || cur.kind !== 'clip' || list.length < 2) return null;
    const i = list.findIndex((c) => c.id === cur.clip.id);
    const j = i + dir;
    return i >= 0 && j >= 0 && j < list.length ? list[j] : null;
  }

  stepClip(dir, { auto = false } = {}) {
    const cur = this.current;
    const next = this.clipNeighbour(dir);
    if (!next) { if (!auto) toast(dir > 0 ? 'That was the last clip' : 'This is the first clip', 2000); return false; }
    toast(`${auto ? 'Next clip' : dir > 0 ? 'Next' : 'Previous'}: ${next.title || 'clip'}`, 2500);
    this.openClip(next, null, { login: cur.login, name: cur.name });
    return true;
  }

  /** "Watch from here": the clip's moment in its broadcast (Helix vod_offset), when Twitch still has the video. */
  async watchClipVod() {
    const cur = this.current;
    if (!cur || cur.kind !== 'clip' || !cur.clip.video_id) return;
    let v = null;
    try { v = state.auth.signedIn ? await tw.videoById(cur.clip.video_id) : null; } catch { v = null; }
    if (cur !== this.current) return;
    if (state.auth.signedIn && !v) { toast('The broadcast of this clip is no longer on Twitch', 3500, 'warn'); return; }
    const video = v || { id: cur.clip.video_id, user_login: cur.login || '', user_name: cur.name, user_id: cur.userId, title: cur.clip.title };
    const at = Math.max(0, Number(cur.clip.vod_offset) || 0);
    this.destroyEngine(); // a fresh engine for the video
    this.openVideo(video, { startAt: at });
  }

  /**
   * The scissors: a clip of the live stream (Helix POST /clips, clips:edit), made as the signed-in user. A toast shows
   * a QR code and short link to its edit page (clips are edited on twitch.tv); it is added to "My clips".
   */
  async createClip() {
    const cur = this.current;
    if (!cur || cur.kind !== 'live') return;
    const auth = clipAuthState(state.auth);
    if (auth !== 'ok') { promptClipSignIn(auth); return; }
    if (this.clipBusy) return;
    const wait = Math.ceil(((this.clipBlockedUntil || 0) - Date.now()) / 1000);
    if (wait > 0) { toast(`Too many clips. Try again in ${wait} s.`, 3000, 'warn'); return; }
    const req = buildClipCreate(cur.userId);
    if (req.error) { toast('Still looking up this channel, try again in a moment', 2500); return; }
    this.clipBusy = true;
    if (this.overlayVisible()) this.renderOverlay(true);
    const busy = toast('Clipping…', 8000);
    let r;
    try { r = await window.lurkbox.helix(req); } catch (e) { r = { ok: false, status: 0, error: e.message }; }
    this.clipBusy = false;
    if (busy) busy.remove();
    if (cur === this.current && this.overlayVisible()) this.renderOverlay(true);
    const res = clipCreateResult(r, { name: cur.name || cur.login });
    plog(`clip of ${cur.login}: ${res.ok ? res.id : `${res.code} (${r && r.status})`}`);
    if (!res.ok) {
      if (res.code === 'ratelimited') this.clipBlockedUntil = res.resetAt;
      if (res.code === 'reauth') { promptClipSignIn('reauth'); return; }
      toast(res.message, 5000, 'warn');
      return;
    }
    const me = state.auth.user && state.auth.user.id;
    if (me) saveSettings({ myClips: addMyClip(state.settings.myClips, me, { id: res.id, broadcasterId: cur.userId, login: cur.login, name: cur.name || cur.login, at: Date.now(), editUrl: res.editUrl }) });
    showClipToast(res);
  }

  /** Looks up the broadcaster id (needed for EventSub) and fresh stream info. */
  async resolveChannel(cur) {
    if (!state.auth.signedIn) {
      this.watcher.watch(null);
      this.raidStatus = 'signed-out';
      return;
    }
    try {
      if (!cur.stream) cur.stream = await tw.streamByLogin(cur.login);
      if (!cur.userId) cur.userId = cur.stream ? cur.stream.user_id : (await tw.userByLogin(cur.login) || {}).id;
      if (cur.stream) cur.name = cur.stream.user_name || cur.name;
    } catch (e) {
      console.warn('[player] channel lookup failed', e.message);
    }
    if (cur !== this.current) return; // switched meanwhile
    this.watcher.watch(cur.userId ? { id: cur.userId, login: cur.login } : null);
    if (cur.userId) setQuickChatChannel({ id: cur.userId, login: cur.login, name: cur.name });
    this.loadOwnEmotes().catch(() => {}); // your emotes show in your own messages and the picker
    if (this.overlayVisible()) this.renderOverlay();
    this.loadDropsChip(cur);
    this.loadFollow(cur);
  }

  /** Whether the user follows this channel (Helix), for the heart icon. */
  async loadFollow(cur) {
    if (!cur.userId || cur.following != null) return;
    const f = await isFollowing(cur.userId);
    if (cur !== this.current || f == null) return;
    cur.following = f;
    if (this.overlayVisible()) this.renderOverlay();
  }

  /** The heart: follow at once, or (following) ask in a Lurkbox dialog, then unfollow. */
  async toggleFollow() {
    const cur = this.current;
    if (!cur || !cur.login) return;
    const f = await pressFollow({ login: cur.login, id: cur.userId, name: cur.name || cur.login }, cur.following == null ? null : cur.following, { signIn: () => this.nav.signIn() });
    if (cur !== this.current) return;
    cur.following = f;
    this.renderOverlay();
  }

  /** The drops chip: progress on a drop for this stream's game, from the host's last look at the inventory page. */
  async loadDropsChip(cur) {
    if (!window.lurkbox.dropsProgress || !cur.stream || !cur.stream.game_name) return;
    const p = await window.lurkbox.dropsProgress().catch(() => null);
    if (cur !== this.current || !p) return;
    cur.dropsChip = pickDropsChip(p.campaigns, cur.stream.game_name);
    if (this.overlayVisible()) this.renderOverlay(true);
  }

  async ensureEmbed(opts) {
    if (this.embed && this.embed.isClip) this.destroyEngine();
    const wantDirect = state.settings.playerEngine !== 'embed' && !this.embedOnly;
    if (this.embed && this.embed.isDirect !== wantDirect) this.destroyEngine();
    let switching = false;
    if (!this.embed && wantDirect) {
      this.embed = new DirectEngine(this.host, {
        log: plog,
        lowLatency: state.settings.lowLatency !== false,
        autoCatchUp: state.settings.autoCatchUp !== false,
        codecPref: () => state.settings.videoCodec || 'h264',
        onFallback: (reason) => this.fallbackToEmbed(reason),
        onAd: (ad) => this.showAd(ad),
        onMilestone: (step, note) => this.vodMark(step, note),
      });
      this.embed.isDirect = true;
      this.applyBackground();
      this.bindEngineEvents(DIRECT_EVENTS);
      this.embed.load(opts.channel ? { channel: opts.channel } : { video: opts.video, startAt: opts.startAt || 0 });
      this.armPlayWatchdog();
      return;
    }
    if (!wantDirect) await loadScript(EMBED_URL);
    const T = window.Twitch;
    if (!this.embed) {
      this.host.replaceChildren();
      const { startAt, ...embedOpts } = opts;
      if (startAt) embedOpts.time = `${Math.floor(startAt / 3600)}h${Math.floor((startAt % 3600) / 60)}m${Math.floor(startAt % 60)}s`;
      this.embed = new T.Player('player-host', {
        width: '100%',
        height: '100%',
        parent: EMBED_PARENT,
        autoplay: true,
        muted: false,
        controls: false, // no native controls/info overlay; Lurkbox's overlay is the only UI
        ...embedOpts,
      });
      this.embed.isDirect = false;
      document.body.classList.add('embed-active');
      this.bindEngineEvents(T.Player);
    } else if (opts.channel) {
      switching = true;
      this.embed.setChannel(opts.channel);
      this.kickPlayback('switch');
    } else if (opts.video) {
      switching = true;
      this.embed.setVideo(opts.video, opts.startAt || 0);
      this.kickPlayback('switch');
    }
    this.playingSeen = false;
    if (switching) this.armPlayWatchdog();
  }

  /** Same handlers for both engines. P = event-name constants. */
  bindEngineEvents(P) {
    {
      this.embed.addEventListener(P.READY, () => {
        const f = this.host.querySelector('iframe');
        if (f) f.setAttribute('tabindex', '-1');
        plog('READY');
        this.kickPlayback('ready');
        if (!this.playingSeen) this.armPlayWatchdog(); // time the checks from READY, not from open
      });
      this.embed.addEventListener(P.PLAYING, () => this.onPlaying());
      this.embed.addEventListener(P.PAUSE, () => this.onPaused());
      this.embed.addEventListener(P.OFFLINE, () => {
        if (this.current && this.current.kind === 'live' && !this.raid.active) this.setStatus(`${this.current.name} is offline`);
      });
      this.embed.addEventListener(P.ONLINE, () => this.setStatus(''));
      this.embed.addEventListener(P.ENDED, () => {
        if (this.current && this.current.kind === 'live' && this.rewind) { this.goLive('caught up'); return; }
        if (this.current && this.current.kind === 'clip') {
          if (state.settings.clipAutoplay !== false && this.clipNeighbour(1)) { this.stepClip(1, { auto: true }); return; }
          this.setStatus('Clip ended. B to go back.');
          return;
        }
        if (this.current && this.current.kind === 'video') {
          if (window.lurkbox.resumeSet) window.lurkbox.resumeSet(this.current.videoId, 0).catch(() => {}); // watched to the end
          this.setStatus('Video ended. B to go back.');
        }
      });
      if (P.PLAYBACK_BLOCKED) {
        this.embed.addEventListener(P.PLAYBACK_BLOCKED, () => {
          this.blockedCount = (this.blockedCount || 0) + 1;
          this.lastStall = 'blocked';
          plog(`PLAYBACK_BLOCKED #${this.blockedCount}`);
          if (this.blockedCount === 1) { this.kickPlayback('blocked'); return; }
          this.embed.setMuted(true); // last resort: muted playback is allowed everywhere
          this.embed.play();
          toast('Autoplay was blocked, playing muted. Unmute from the overlay.', 5000, 'warn');
        });
      }
    }
  }

  destroyEngine() {
    document.body.classList.remove('embed-active');
    if (this.embed && this.embed.destroy) this.embed.destroy();
    this.embed = null;
    this.host.replaceChildren();
  }

  fallbackToEmbed(reason) {
    this.vodMark('fallback to the Twitch player', reason);
    plog(`direct engine -> Twitch player: ${reason}`);
    toast('Using the Twitch player', 3000);
    this.embedOnly = this.current ? this.current.login || true : true;
    this.rewind = null;
    this.destroyEngine();
    const c = this.current;
    if (!c) return;
    if (c.kind === 'live') this.ensureEmbed({ channel: c.login });
    else if (c.kind === 'clip') this.playClipEmbed(c);
    else this.ensureEmbed({ video: `v${c.videoId}` });
  }

  showAd(ad) {
    const b = document.getElementById('ad-badge');
    if (!b) return;
    b.hidden = !ad.inAd;
    if (ad.inAd) b.textContent = ad.secondsLeft != null ? `Ad \u00B7 ${Math.floor(ad.secondsLeft / 60)}:${String(ad.secondsLeft % 60).padStart(2, '0')}` : 'Ad';
  }

  /** Window unfocused for a while (Floater over a game): cap the direct engine's quality; restore on focus. */
  setBackground(on) {
    this.background = !!on;
    this.applyBackground();
  }

  applyBackground() {
    if (!this.embed || !this.embed.isDirect) return;
    this.embed.setBackgroundCap(this.background ? backgroundCap(state.settings.backgroundQuality || '720') : null);
  }

  latency() { return this.embed && this.embed.isDirect ? this.embed.latency() : null; }

  jumpToLive() {
    if (!this.current || this.current.kind !== 'live') return;
    this.behindOffered = false;
    if (this.rewind) { this.goLive('jump'); return; }
    if (this.embed && this.embed.isDirect) { this.embed.jumpToLive(); toast('Jumped to live', 1500); }
    else this.openLive({ login: this.current.login, name: this.current.name, userId: this.current.userId, stream: this.current.stream }); // embed: reload
  }

  /** Corner badge, the overlay's live badge and the catch-up offer, once a second. */
  tickLive() {
    this.tickSeek();
    const badge = document.getElementById('live-badge');
    if (!badge) return;
    const lat = this.active && this.current && this.current.kind === 'live' ? this.latency() : null;
    const b = liveBadge(lat);
    let rewoundBy = null;
    if (this.rewind && this.active) {
      const m = this.seekModel();
      rewoundBy = m ? m.max - m.pos : 0;
      badge.hidden = this.overlayVisible();
      badge.textContent = `Rewound \u2212${fmtTime(rewoundBy)} \u00B7 ${this.glyphX()} to go live`;
      badge.classList.add('rewound');
    } else {
      badge.classList.remove('rewound');
      badge.hidden = !(this.active && this.current && this.current.kind === 'live' && !b.live && !this.overlayVisible());
      badge.textContent = b.text;
      const decision = catchUpDecision(lat, { autoCatchUp: state.settings.autoCatchUp !== false });
      if (decision === 'offer' && !this.behindOffered && !this.raid.active) {
        this.behindOffered = true;
        toast(`You're ${b.text.replace('\u2212', '').replace(' behind', '')} behind. Press ${this.glyphX()} to jump to live.`, 6000);
      }
      if (decision === 'none') this.behindOffered = false;
    }
    this.liveState = { rewound: rewoundBy != null, behind: !b.live && !!(this.embed && this.embed.isDirect) };
    const live = this.ui && this.ui.badge;
    if (!live || !this.current) return;
    const l = liveLabel({ kind: this.current.kind, rewoundBy, badge: b, direct: !!(this.embed && this.embed.isDirect) });
    live.hidden = !l;
    if (l) {
      if (live.textContent !== l.text) live.textContent = l.text;
      live.dataset.state = l.state;
      live.classList.toggle('behind', l.state !== 'live');
    }
    if (this.tipFor && this.tipFor.dataset.key === 'live') this.showTip(this.tipFor, { refresh: true });
  }

  /** Unmute, restore volume and play. Safe to call repeatedly. */
  kickPlayback(why) {
    if (!this.embed) return;
    try {
      this.embed.setMuted(false);
      this.embed.setVolume(this.volume());
      this.embed.play();
      plog(`play() (${why})`);
    } catch (e) {
      plog(`play() failed (${why}): ${e.message}`);
    }
  }

  volume() {
    const v = Number(state.settings.volume);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }

  /** If PLAYING doesn't arrive within 8 s: try gates and play again, then offer "Press A to play". */
  armPlayWatchdog() {
    clearTimeout(this.playTimer);
    this.loadedAt = performance.now();
    this.userPaused = false;
    this.lastStall = '';
    this.hidePlayPrompt();
    // play() through the JS API is ignored when Twitch decides autoplay isn't
    // allowed ("style visibility"), but its own play overlay works. Click it early.
    clearTimeout(this.earlyTimer1);
    clearTimeout(this.earlyTimer2);
    const early = async (label) => {
      if (!this.active || this.playingSeen) return;
      const clicked = await window.lurkbox.dismissPlayerGate({ play: true });
      if (clicked) { this.lastStall = `autoplay refused, clicked ${clicked}`; plog(`${label}: clicked ${clicked}`); }
    };
    this.earlyTimer1 = setTimeout(() => early('1.5 s check'), 1500);
    this.earlyTimer2 = setTimeout(() => early('4 s check'), 4000);
    this.playTimer = setTimeout(async () => {
      if (!this.active || this.playingSeen) return;
      const clicked = await window.lurkbox.dismissPlayerGate({ play: true });
      const reason = clicked ? `gate (${clicked})` : (this.lastStall || 'no PLAYING event');
      plog(`no playback after 8 s: ${reason}; paused=${this.safe(() => this.embed.isPaused())} muted=${this.safe(() => this.embed.getMuted())}`);
      this.kickPlayback('watchdog');
      setTimeout(() => { if (this.active && !this.playingSeen) this.showPlayPrompt(); }, 1500);
    }, 8000);
  }

  safe(fn) { try { return fn(); } catch { return '?'; } }

  showPlayPrompt() {
    this.playPrompt.hidden = false;
    // Not while you type a message or use a pop-over: the prompt waits for A outside them.
    const a = document.activeElement;
    if (this.composer.contains(a) || this.cpop.isOpen || (this.overlayVisible() && this.overlay.contains(a))) return;
    focusEl(this.playPrompt.querySelector('button'), { instant: true });
  }

  hidePlayPrompt() { if (this.playPrompt) this.playPrompt.hidden = true; }

  togglePause() {
    if (!this.embed) return;
    if (this.embed.isPaused()) {
      this.userPaused = false;
      if (this.embed.isDirect && this.current && this.current.kind === 'live') {
        // The paused spot may have left Twitch's short live window: the engine jumps to live if so.
        this.embed.setMuted(false);
        this.embed.setVolume(this.volume());
        this.embed.resume();
        this.behindOffered = false;
        this.tickLive();
      } else this.kickPlayback('user');
    }
    else { this.userPaused = true; this.embed.pause(); }
    if (this.overlayVisible()) this.renderOverlay(true);
  }

  changeVolume(delta) {
    this.setVolume(this.volume() + delta);
  }

  /** Sets the volume (0..1), unmutes, saves it shortly after; quiet = no toast (the volume pop-over shows it). */
  setVolume(value, { quiet = false } = {}) {
    if (!this.embed) return;
    const v = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    state.settings.volume = v; // immediate; persisted below
    this.embed.setMuted(false);
    this.embed.setVolume(v);
    if (!quiet && !(this.pop.key === 'volume')) toast(`Volume ${Math.round(v * 100)}%`, 1200);
    clearTimeout(this.volTimer);
    this.volTimer = setTimeout(() => saveSettings({ volume: v }), 800);
    if (this.overlayVisible()) this.renderOverlay(true);
  }

  toggleMute({ quiet = false } = {}) {
    if (!this.embed) return;
    const m = !this.embed.getMuted();
    this.embed.setMuted(m);
    if (!quiet) toast(m ? 'Muted' : 'Unmuted', 1200);
    if (this.overlayVisible()) this.renderOverlay(true);
  }

  /** A step of the current VOD's start timeline (ignored for live channels and once it played). */
  vodMark(step, note) {
    if (this.vodTimeline && this.current && this.current.kind === 'video' && String(this.current.videoId) === this.vodTimeline.id) this.vodTimeline.mark(step, note);
  }

  onPlaying() {
    if (this.vodTimeline && this.current && this.current.kind === 'video') { vlog(this.vodTimeline.finish('PLAYING', this.embed && !this.embed.isDirect ? 'Twitch player' : '')); this.vodTimeline = null; }
    if (!this.playingSeen) {
      plog(`PLAYING after ${Math.round(performance.now() - (this.loadedAt || 0))} ms`);
      setTimeout(() => { if (this.active && window.lurkbox.probePlayer) window.lurkbox.probePlayer().catch(() => {}); }, 5000);
    }
    this.playingSeen = true;
    clearTimeout(this.playTimer);
    this.hidePlayPrompt();
    this.stopGateLoop();
    clearTimeout(this.resumeTimer);
    this.setStatus('');
    if (!this.qualityApplied) {
      this.qualityApplied = true;
      // Qualities are only known once playback starts.
      setTimeout(() => this.applyDefaultQuality(), 500);
    }
  }

  // The app never pauses on its own; if the embed paused itself, resume.
  onPaused() {
    clearTimeout(this.resumeTimer);
    if (!this.active || this.userPaused) return;
    if (this.embed && this.embed.getEnded && this.safe(() => this.embed.getEnded()) === true) return; // the end, not a stall
    if (performance.now() - (this.loadedAt || 0) < 5000) {
      this.lastStall = 'paused right after load';
      plog('PAUSE within 5 s of load; retrying play()');
      this.kickPlayback('early-pause');
      return;
    }
    this.resumeTimer = setTimeout(() => {
      if (this.active && this.embed && this.embed.isPaused && this.embed.isPaused()) {
        console.log('[player] resuming after unexpected pause');
        this.embed.play();
      }
    }, 1500);
  }

  applyDefaultQuality() {
    const want = state.settings.defaultQuality || 'auto';
    if (!this.embed || want === 'auto' || this.embed.isClip) return; // a clip picks its own from the same setting
    const pick = pickDefaultQuality(this.embed.getQualities(), want);
    if (!pick) return;
    console.log(`[player] quality -> ${pick.name} (${pick.group})`);
    this.embed.setQuality(pick.group);
  }

  startGateLoop() {
    this.stopGateLoop();
    if (!state.settings.skipContentGate) return;
    let n = 0;
    this.gateTimer = setInterval(async () => {
      if (++n > 15 || !this.active) return this.stopGateLoop();
      if (await window.lurkbox.dismissPlayerGate()) console.log('[player] dismissed a content gate');
    }, 1500);
  }

  stopGateLoop() {
    clearInterval(this.gateTimer);
    this.gateTimer = null;
  }

  show() {
    if (!this.playPrompt) {
      this.playPrompt = el('div', { class: 'play-prompt', hidden: true },
        button('Press A to play', () => { this.hidePlayPrompt(); window.lurkbox.dismissPlayerGate({ play: true }); this.kickPlayback('prompt'); this.armPlayWatchdog(); }, { class: 'primary big' }));
      document.getElementById('player-stage').append(this.playPrompt);
    }
    // Portrait in a touch layout: the chat fills the space under the video, so it starts on.
    if (this.chatOn === null) this.chatOn = !!state.settings.chatDefault || (isTouchLayout() && window.innerHeight > window.innerWidth);
    this.active = true;
    document.body.classList.add('player-active');
    this.screen.hidden = false;
    document.getElementById('app').inert = true;
    this.applyLayout();
  }

  close() {
    if (this.linePick) this.endLinePick({ toComposer: false });
    if (this.vodTimeline) { vlog(this.vodTimeline.finish('left before PLAYING')); this.vodTimeline = null; }
    this.saveResume();
    this.scrubber.cancel();
    this.active = false;
    this.cancelRaid();
    this.hideOverlay();
    this.stopGateLoop();
    clearTimeout(this.resumeTimer);
    clearTimeout(this.playTimer);
    clearTimeout(this.earlyTimer1);
    clearTimeout(this.earlyTimer2);
    this.hidePlayPrompt();
    this.watcher.watch(null);
    this.cpop.close({ returnFocus: false });
    this.composer.clear();
    this.composer.setVisible(false);
    this.chat.leave();
    this.closePointsPanel();
    this.tchat.close();
    this.destroyEngine(); // removes the iframe/video and stops playback
    this.showAd({ inAd: false });
    this.current = null;
    this.screen.hidden = true;
    document.getElementById('app').inert = false;
  }

  setStatus(text) {
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
  }

  /**
   * The chat layout settings on the player screen: width (the video shrinks beside the panel; over the video the chat
   * floats on top), side, text size and background opacity. Safe to call at any time.
   */
  applyChatLayout() {
    const s = state.settings;
    const L = chatLayout(s);
    const style = s.chatStyle === 'twitch' ? 'twitch' : 'lurkbox';
    const direct = this.embed ? !!this.embed.isDirect : (s.playerEngine !== 'embed' && !this.embedOnly);
    const over = chatOverActive({ layout: L, style, direct });
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const zoom = twitchChatZoom(s, window.screen && window.screen.height);
    const px = chatPanelWidth({ style, chatWidth: L.chatWidth, windowWidth: window.innerWidth, zoom, remPx });
    const st = this.screen.style;
    if (style === 'twitch') { st.removeProperty('--chat-w'); st.setProperty('--tchat-w', `${px}px`); } else { st.setProperty('--chat-w', `${px}px`); st.removeProperty('--tchat-w'); }
    st.setProperty('--chat-text', String(L.chatTextSize / 100));
    st.setProperty('--chat-bg-a', `${L.chatBgOpacity}%`);
    st.setProperty('--chat-over-a', `${L.chatOverlayOpacity}%`);
    this.screen.classList.toggle('chat-left', L.chatSide === 'left');
    this.screen.classList.toggle('chat-over', over);
    // Height and position: a shorter panel beside the video (which keeps its size), or a shorter box over it that
    // lifts above the control bar while that is open. Phone and touch portrait ignore it (chatEnv().heightApplies).
    const box = chatBox({
      chatHeight: L.chatHeight, chatVPos: L.chatVPos, screenHeight: this.screen.clientHeight || window.innerHeight,
      over, overlayOpen: !!this.overlay && this.overlayVisible(), barPx: this.ui && this.ui.panel ? this.ui.panel.offsetHeight : 0,
      applies: chatEnv().heightApplies,
    });
    this.screen.classList.toggle('chat-short', !box.full);
    this.screen.classList.toggle('chat-top', !box.full && box.top != null);
    this.screen.classList.toggle('chat-bottom', !box.full && box.top == null);
    if (box.full) { for (const p of ['--chat-h', '--chat-top', '--chat-bottom']) st.removeProperty(p); return; }
    st.setProperty('--chat-h', `${box.height}px`);
    st.setProperty('--chat-top', box.top == null ? 'auto' : `${box.top}px`);
    st.setProperty('--chat-bottom', box.bottom == null ? 'auto' : `${box.bottom}px`);
  }

  applyLayout() {
    this.applyChatLayout();
    const chatVisible = this.chatOn && this.current && this.current.kind === 'live';
    this.screen.classList.toggle('chat-on', !!chatVisible);
    const twitchStyle = state.settings.chatStyle === 'twitch';
    this.screen.classList.toggle('twitch-chat', !!(chatVisible && twitchStyle));
    if (!this.pointsPanel) this.tchat.setMode(chatVisible && twitchStyle && this.tchat.login ? 'panel' : 'hidden');
    // Twitch chat style has its own input in Twitch's frame, so the composer is only in Lurkbox chat.
    this.composer.setVisible(!!(chatVisible && !twitchStyle && state.auth.signedIn));
    if (chatVisible && twitchStyle) {
      this.chat.leave(); // Twitch's chat replaces the IRC panel
    } else if (chatVisible && this.current) {
      this.chat.join(this.current.login);
      requestAnimationFrame(() => { const l = this.chatPanel.querySelector('.chat-list'); if (l) l.scrollTop = l.scrollHeight; });
    } else {
      this.chat.leave();
    }
  }

  toggleChat() {
    if (this.current && this.current.kind !== 'live') {
      toast('Chat is only available for live channels', 2500);
      return;
    }
    this.chatOn = !this.chatOn;
    this.applyLayout();
    if (this.overlayVisible()) this.renderOverlay();
  }

  /** True when the message box is on screen and usable: live, Lurkbox chat showing, signed in. */
  composerReachable() {
    return !!(this.current && this.current.kind === 'live' && this.chatOn && state.settings.chatStyle !== 'twitch'
      && sendAuthState(state.auth) === 'ok' && this.composer.node.isConnected && !this.composer.node.hidden);
  }

  /** "Send a message": chat on, focus the composer and open a keyboard (Lurkbox chat style, live, signed in). */
  openComposer() {
    if (!this.current || this.current.kind !== 'live') return;
    const auth = sendAuthState(state.auth);
    if (auth !== 'ok') { promptChatSignIn(auth); return; }
    if (state.settings.chatStyle === 'twitch') { toast('Type in Twitch\'s chat on the right', 2500); return; }
    if (!this.chatOn) { this.chatOn = true; this.applyLayout(); }
    this.hideOverlay();
    this.composer.focus({ keyboard: true });
  }

  /** Your own Twitch emotes for this channel (Helix, cached), handed to the chat. */
  loadOwnEmotes() { return this.sending.loadOwnEmotes(); }

  /** The composer's emote picker or quick chat, above its button (pressing the button again closes it). */
  openChatPicker(kind, opener) { this.sending.openPicker(kind, opener); }

  /** Quick chat for the channel on screen (the overlay's icon, or the composer's button). */
  quickPicker() { return this.sending.quickPicker(); }

  /** B in the composer: back to the overlay, on "Send a message". The draft stays. */
  leaveComposer() {
    const a = document.activeElement;
    if (a && this.composer.contains(a)) a.blur();
    document.body.classList.remove('composing');
    this.lastFocusKey = 'po-compose';
    this.showOverlay();
  }

  async step(dir) {
    if (!this.current) return;
    if (this.pop.isOpen) this.pop.close(); // its contents belong to the channel being left
    let list = [];
    try { list = state.auth.signedIn ? await followedLive() : this.playlist; } catch { list = this.playlist; }
    if (!list.length) list = this.playlist;
    if (!list.length) { toast('No other live channels to switch to', 2500); return; }
    const idx = list.findIndex((s) => s.user_login === this.current.login);
    const next = list[(idx + dir + list.length) % list.length];
    if (!next || next.user_login === this.current.login) { toast('No other live channels', 2000); return; }
    toast(`${dir > 0 ? 'Next' : 'Previous'}: ${next.user_name}`, 2000);
    this.openLive({ login: next.user_login, name: next.user_name, userId: next.user_id, stream: next }, list);
    if (this.overlayVisible()) this.renderOverlay();
  }

  // ---------- overlay ----------
  // A translucent scrim over the full-size video: a top line (avatar, name, live badge, scrolling title), the seek
  // bar, and one row of icon buttons. The focused (or hovered, or long-pressed) button shows its label in a bubble;
  // quality, volume, chat, channel points and "more" open small pop-overs above their button.

  overlayVisible() { return !this.overlay.hidden; }

  buildOverlay() {
    const ui = {};
    ui.avatar = el('span', { class: 'po-avatar' });
    ui.name = el('span', { class: 'po-name' });
    ui.badge = el('span', { class: 'po-live', hidden: true });
    ui.title = el('span', { class: 'po-title marquee-line' });
    ui.drops = el('span', { class: 'po-drops', hidden: true });
    ui.clipMeta = el('span', { class: 'po-clip-meta' });
    ui.clip = el('span', { class: 'po-clip', hidden: true }, el('span', { class: 'po-clip-badge' }, 'CLIP'), ui.clipMeta);
    ui.top = el('div', { class: 'po-top' }, ui.avatar, ui.name, ui.badge, ui.clip, ui.drops, ui.title);
    ui.buttons = {};
    for (const key of ALL_CONTROLS) {
      const b = el('button', {
        type: 'button', class: `po-icon focusable${key === 'play' ? ' po-default' : ''}`,
        dataset: { key, focusKey: `po-${key}` }, 'aria-haspopup': POPOVER_CONTROLS.has(key) ? 'dialog' : null,
      }, icon(controlIcon(key, {})), key === 'points' ? el('span', { class: 'po-count', hidden: true }) : null);
      b.dataset.icon = controlIcon(key, {});
      b.addEventListener('click', () => {
        if (this.longPressed === b) { this.longPressed = null; return; } // a long-press only shows the label
        this.bumpOverlay();
        this.onControl(key, b);
      });
      this.installTip(b);
      ui.buttons[key] = b;
    }
    ui.row = el('div', { class: 'po-row' }, ALL_CONTROLS.map((k) => ui.buttons[k]));
    ui.panel = el('div', { class: 'po-panel po-ui' }, ui.top, ui.row);
    ui.tip = el('div', { class: 'po-tip', role: 'tooltip', hidden: true });
    this.overlay.replaceChildren(ui.panel, ui.tip);
    // The row never overflows: re-fit it when its width changes (resize, rotation) or the layout mode does.
    ui.overflow = [];
    let rowWidth = 0;
    const refit = () => { if (this.overlayVisible()) this.renderOverlay(true); };
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (ui.row.clientWidth !== rowWidth) { rowWidth = ui.row.clientWidth; refit(); } }).observe(ui.row);
    }
    window.addEventListener('layoutchange', refit);
    window.addEventListener('layoutchange', () => this.applyChatLayout()); // the phone and touch portrait ignore the chat height
    // The bar's height (a seek bar, a wrapped row) decides how far a bottom chat over the video lifts.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (this.overlayVisible()) this.applyChatLayout(); }).observe(ui.panel);
    this.overlay.addEventListener('focusin', (e) => {
      const b = e.target.closest && e.target.closest('.po-icon');
      if (b && !document.body.classList.contains('input-mouse') && !document.body.classList.contains('input-touch')) this.showTip(b);
      else if (!b) this.hideTip();
    });
    this.ui = ui;
  }

  /** Hover (mouse) and long-press (touch) show the same label bubble as focus. */
  installTip(b) {
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !this.pop.isOpen) this.showTip(b); });
    b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && this.tipFor === b) this.hideTip(); });
    let timer = null;
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.longPressed = b;
        focusEl(b, { instant: true });
        this.showTip(b, { touch: true });
        this.bumpOverlay();
        clearTimeout(this.tipTimer);
        this.tipTimer = setTimeout(() => { if (this.tipFor === b) this.hideTip(); }, 2500);
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('contextmenu', (e) => { if (this.longPressed === b) e.preventDefault(); });
  }

  /** What the labels and icons say right now. */
  labelCtx() {
    const cur = this.current || {};
    let quality = 'Auto';
    try {
      const q = this.embed && this.embed.getQuality();
      const found = q && (this.embed.getQualities() || []).find((x) => x.group === q);
      quality = found ? found.name : (q && q !== 'auto' ? q : 'Auto');
      if ((!q || q === 'auto') && this.embed.playingName && this.embed.playingName()) quality = `Auto (${this.embed.playingName()})`;
    } catch { /* not ready */ }
    const ls = this.liveState || {};
    return {
      paused: this.safe(() => this.embed.isPaused()) === true,
      muted: this.safe(() => this.embed.getMuted()) === true,
      volume: this.volume(),
      quality,
      chatOn: !!this.chatOn,
      rewound: !!ls.rewound,
      behind: !!ls.behind,
      points: this.points.signedIn && Number.isFinite(this.points.balance) ? this.points.balance : null,
      name: cur.name || cur.login || '',
      following: cur.following == null ? null : cur.following,
      clipping: !!this.clipBusy,
      vodOffset: cur.kind === 'clip' && cur.clip.vod_offset != null ? fmtTime(cur.clip.vod_offset) : null,
      next: cur.kind === 'clip' ? (this.clipNeighbour(1) || {}).title || null : null,
      prev: cur.kind === 'clip' ? (this.clipNeighbour(-1) || {}).title || null : null,
    };
  }

  showTip(b, { touch = false, refresh = false } = {}) {
    if (!b || b.hidden || this.pop.isOpen || !this.overlayVisible()) return;
    if (refresh && this.tipFor !== b) return;
    const tip = this.ui.tip;
    const text = controlLabel(b.dataset.key, this.labelCtx());
    // The activate glyph only inside the focused label (controller/keyboard), never for mouse or touch.
    const glyph = !touch && !document.body.classList.contains('input-mouse') && document.activeElement === b;
    const sig = `${text}|${glyph}`;
    if (tip.dataset.sig !== sig) {
      tip.dataset.sig = sig;
      tip.replaceChildren(...(glyph ? [hint('{A}', 'po-tip-glyph')] : []), el('span', { class: 'po-tip-text' }, text));
    }
    this.tipFor = b;
    tip.hidden = false;
    const box = this.overlay.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const w = tip.offsetWidth;
    const margin = 8;
    const left = Math.min(Math.max(margin, (r.left + r.right) / 2 - box.left - w / 2), Math.max(margin, box.width - w - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.bottom = `${Math.round(box.bottom - r.top + 10)}px`;
  }

  hideTip() {
    this.tipFor = null;
    if (this.ui) this.ui.tip.hidden = true;
  }

  /** The current focus target to come back to (the pop-over's button while one is open). */
  overlayFocusKey() {
    const a = document.activeElement;
    if (this.pop.isOpen && this.pop.cur.opener) return focusKey(this.pop.cur.opener);
    return a && this.overlay.contains(a) ? focusKey(a) : null;
  }

  /**
   * Shows the controls. Focus comes back to the control used last (same channel), else Play/Pause. In mouse mode
   * nothing gets the focus ring until the pointer moves onto a control.
   */
  showOverlay() {
    const was = this.overlayVisible();
    this.overlay.hidden = false;
    document.body.classList.add('overlay-open');
    this.renderOverlay();
    this.applyChatLayout(); // a short chat at the bottom, over the video, moves above the bar
    if (!was) {
      const mouse = document.body.classList.contains('input-mouse');
      const back = this.lastFocusKey && focusables(this.overlay).find((n) => focusKey(n) === this.lastFocusKey);
      if (back) focusEl(back, { instant: true });
      else focusFirst(this.overlay, '.po-default');
      if (mouse) this.hideTip(); else this.syncTip();
    }
    this.bumpOverlay();
    // Refresh title/viewers in the background.
    const cur = this.current;
    if (!was && cur && cur.kind === 'live' && state.auth.signedIn) {
      tw.streamByLogin(cur.login).then((s) => {
        if (cur === this.current && s) { cur.stream = s; if (this.overlayVisible()) this.renderOverlay(true); }
      }).catch(() => {});
    }
  }

  hideOverlay() {
    clearTimeout(this.overlayTimer);
    if (this.scrubber && this.scrubber.active) this.scrubber.commit();
    const wasOpen = !this.overlay.hidden;
    if (wasOpen) this.lastFocusKey = this.overlayFocusKey() || this.lastFocusKey;
    this.pop.close({ returnFocus: false });
    this.hideTip();
    const a = document.activeElement;
    if (a && this.overlay.contains(a)) a.blur();
    this.overlay.hidden = true;
    document.body.classList.remove('overlay-open');
    this.applyChatLayout();
    // The embed may pause itself while covered (Twitch's visibility check); resume it.
    if (wasOpen && this.active && this.embed && !this.embed.isDirect && !this.userPaused) {
      setTimeout(() => { if (this.safe(() => this.embed.isPaused()) === true && !this.userPaused) { plog('resuming after the overlay closed'); this.kickPlayback('overlay-closed'); } }, 300);
    }
  }

  /** Auto-hide after a few seconds without input (longer with a pop-over open). */
  bumpOverlay() {
    clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => {
      // Never while the pointer rests on the controls or a slider is being dragged.
      if (this.overlay.querySelector('.po-ui:hover') && document.body.classList.contains('input-mouse')) { this.bumpOverlay(); return; }
      if (hasModal()) { this.bumpOverlay(); return; } // e.g. editing a quick-chat phrase from the pop-over
      this.hideOverlay();
    }, this.pop.isOpen ? POPOVER_HIDE_MS : OVERLAY_HIDE_MS);
  }

  /** Updates the overlay in place: which controls exist, their icons and labels, the top line, the seek bar. */
  renderOverlay(_keepFocus = false) {
    const cur = this.current;
    if (!cur || !this.ui) return;
    const ui = this.ui;
    const snap = snapshotFocus(this.overlay, focusables(this.overlay));
    const ctx = this.labelCtx();
    const shown = new Set(overlayControls({
      kind: cur.kind, points: !!this.tchat.login, follow: !!(cur.login && window.lurkbox.followChannel && state.auth.signedIn),
      vod: cur.kind === 'clip' && !!cur.clip.video_id, clip: state.auth.signedIn, prev: !!this.clipNeighbour(-1), next: !!this.clipNeighbour(1),
      compose: state.auth.signedIn && state.settings.chatStyle !== 'twitch',
      quick: state.auth.signedIn,
      volume: !isPhoneLayout(), // phones have volume buttons
    }));
    for (const key of ALL_CONTROLS) ui.buttons[key].hidden = !shown.has(key);
    // What does not fit moves into More, lowest priority first.
    ui.overflow = this.fitRow(ALL_CONTROLS.filter((k) => shown.has(k)));
    for (const key of ui.overflow) ui.buttons[key].hidden = true;
    for (const key of ALL_CONTROLS) {
      const b = ui.buttons[key];
      const name = controlIcon(key, ctx);
      if (b.dataset.icon !== name) { b.dataset.icon = name; b.firstElementChild.replaceWith(icon(name)); }
      b.setAttribute('aria-label', controlLabel(key, ctx));
      b.classList.toggle('on', (key === 'chat' && ctx.chatOn) || (key === 'follow' && ctx.following === true));
      b.setAttribute('aria-expanded', this.pop.key === key ? 'true' : 'false');
    }
    const count = ui.buttons.points.querySelector('.po-count');
    count.hidden = ctx.points == null;
    count.textContent = ctx.points == null ? '' : shortCount(ctx.points);
    // Top line.
    const s = cur.stream;
    const name = cur.name || cur.login || '';
    if (ui.name.textContent !== name) ui.name.textContent = name;
    const title = cur.kind !== 'live' ? (cur.title || '') : ((s && s.title) || '');
    if (ui.title.textContent !== title) { ui.title.textContent = title; requestAnimationFrame(() => marqueeLine(ui.title)); }
    const chip = cur.kind === 'live' ? cur.dropsChip : null;
    ui.drops.hidden = !chip;
    if (chip && ui.drops.textContent !== chip.label) { ui.drops.textContent = chip.label; ui.drops.title = chip.label; }
    // Clips: a CLIP badge and who clipped it, its views and date.
    ui.clip.hidden = cur.kind !== 'clip';
    if (cur.kind === 'clip') {
      const meta = clipMeta(cur.clip);
      if (ui.clipMeta.textContent !== meta) ui.clipMeta.textContent = meta;
    }
    this.renderAvatar(cur);
    // The seek bar is one persistent node (it keeps focus and drag state), between the top line and the buttons.
    const seekable = !!this.seekModel();
    const bar = this.seekBar.node;
    if (seekable && bar.parentNode !== ui.panel) ui.panel.insertBefore(bar, ui.row);
    if (!seekable && bar.parentNode) bar.remove();
    this.renderSeek();
    restoreFocus(this.overlay, snap, focusables(this.overlay), (n) => focusEl(n, { instant: true }));
    this.tickLive(); // the live/behind badge is owned by tickLive
    if (this.tipFor) { if (this.tipFor.hidden) this.hideTip(); else this.showTip(this.tipFor, { refresh: true }); }
    this.pop.update();
  }

  /** The controls (of `keys`, all shown) that do not fit in the row's width; [] when the row is not laid out. */
  fitRow(keys) {
    const row = this.ui.row;
    const cs = getComputedStyle(row);
    const width = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    // With a controller (TV layout), "Send a message" is the way into the composer, so it stays too.
    const pinned = isTouchLayout() ? PINNED_CONTROLS : new Set([...PINNED_CONTROLS, 'compose']);
    return fitControls(keys, { width, button: this.ui.buttons.play.offsetWidth, gap: parseFloat(cs.columnGap) || 0, pinned }).overflow;
  }

  /** The channel's avatar (Helix, cached), else its initial. */
  renderAvatar(cur) {
    const a = this.ui.avatar;
    const key = cur.userId || cur.login;
    if (a.dataset.for === key) return;
    a.dataset.for = key;
    a.replaceChildren(el('span', { class: 'po-avatar-initial' }, (cur.name || cur.login || '?').slice(0, 1).toUpperCase()));
    if (!cur.userId || !state.auth.signedIn) return;
    usersByIds([cur.userId]).then((m) => {
      const u = m.get(cur.userId);
      if (u && u.profile_image_url && a.dataset.for === key) a.replaceChildren(el('img', { src: u.profile_image_url, alt: '' }));
    }).catch(() => {});
  }

  /** A press on a bar button. */
  onControl(key, b) {
    const cur = this.current;
    if (!cur) return;
    switch (key) {
      case 'play': this.togglePause(); break;
      case 'live': this.jumpToLive(); break;
      case 'follow': this.toggleFollow(); break;
      case 'compose': this.openComposer(); break;
      case 'vod': this.watchClipVod(); break;
      case 'clip': this.createClip(); break;
      case 'prev': this.stepClip(-1); break;
      case 'next': this.stepClip(1); break;
      case 'channel': {
        if (!cur.login && !cur.userId) break;
        const c = { login: cur.login || '', id: cur.userId, name: cur.name };
        this.nav.closePlayer();
        this.nav.openChannel(c);
        break;
      }
      case 'back': this.nav.closePlayer(); break;
      default:
        if (POPOVER_CONTROLS.has(key)) this.openPopover(key, b);
    }
  }

  // ---------- pop-overs ----------

  /** Opens the pop-over for a bar button (pressing its button again closes it). */
  openPopover(key, opener = this.ui.buttons[key]) {
    if (this.pop.key === key) { this.pop.close(); this.bumpOverlay(); return; }
    const built = { volume: () => this.volumePop(), quality: () => this.qualityPop(), chat: () => this.chatPop(), quick: () => this.quickPicker(), points: () => this.pointsPop(), more: () => this.morePop() }[key];
    if (!built) return;
    const { body, initial, update, title, onAction } = built();
    const node = el('div', { class: `po-pop po-ui pop-${key}`, role: 'dialog', 'aria-label': title },
      el('div', { class: 'po-pop-title' }, title), body);
    this.hideTip();
    this.pop.open({
      key, node, opener, initial: initial && initial(), onAction,
      update: () => { if (update) update(); this.placePopover(node, opener); },
      onClose: () => { if (this.ui) this.renderButtonsExpanded(); },
    });
    this.renderButtonsExpanded();
    this.bumpOverlay();
  }

  renderButtonsExpanded() {
    for (const [k, b] of Object.entries(this.ui.buttons)) {
      b.setAttribute('aria-expanded', this.pop.key === k ? 'true' : 'false');
      b.classList.toggle('expanded', this.pop.key === k);
    }
  }

  placePopover(node, opener) {
    if (!node.isConnected || !opener) return;
    const box = this.overlay.getBoundingClientRect();
    const r = opener.getBoundingClientRect();
    const { left, bottom } = anchorPopover(r, { width: node.offsetWidth, height: node.offsetHeight }, box, { margin: 12, gap: 14 });
    node.style.left = `${left}px`;
    node.style.bottom = `${bottom}px`;
    node.style.maxHeight = `${Math.max(160, box.height - bottom - 12)}px`;
  }

  volumePop() {
    const fmt = (v) => (this.safe(() => this.embed.getMuted()) === true ? 'Muted' : `${v}%`);
    const slider = new Slider({
      key: 'pop-volume', label: 'Level', min: 0, max: 100, step: 5, value: Math.round(this.volume() * 100),
      format: fmt, onInput: (v) => this.setVolume(v / 100, { quiet: true }),
    });
    const mute = button('', () => this.toggleMute({ quiet: true }), { class: 'po-item', dataset: { focusKey: 'pop-mute' } });
    const update = () => {
      slider.setValue(Math.round(this.volume() * 100));
      slider.render();
      const m = this.safe(() => this.embed.getMuted()) === true;
      mute.replaceChildren(icon(m ? 'volume' : 'volume-muted', 'po-item-icon'), el('span', {}, m ? 'Unmute' : 'Mute'));
    };
    update();
    return { title: 'Volume', body: el('div', { class: 'po-pop-body' }, slider.node, mute), initial: () => slider.node, update };
  }

  qualityPop() {
    const list = el('div', { class: 'po-pop-body po-list' });
    const update = () => {
      const qs = (this.safe(() => this.embed.getQualities()) || []).filter((q) => q && q.group);
      const curQ = this.safe(() => this.embed.getQuality());
      if (!qs.length) { list.replaceChildren(el('div', { class: 'po-pop-note' }, 'Qualities appear once the stream is playing.')); return; }
      const items = [{ value: 'auto', label: 'Auto' }, ...qs.filter((q) => q.group !== 'auto').map((q) => ({ value: q.group, label: q.name }))];
      const sig = items.map((i) => i.value).join(',') + `|${curQ}`;
      if (list.dataset.sig === sig) return;
      list.dataset.sig = sig;
      const snap = snapshotFocus(list, focusables(list));
      list.replaceChildren(...items.map((it) => button([icon(it.value === curQ || (it.value === 'auto' && (!curQ || curQ === 'auto')) ? 'check' : '', 'po-item-icon'), el('span', {}, it.label)], () => {
        this.embed.setQuality(it.value);
        this.pop.close();
        setTimeout(() => this.overlayVisible() && this.renderOverlay(true), 300);
      }, { class: `po-item${it.value === curQ ? ' selected' : ''}`, dataset: { focusKey: `pop-q-${it.value}` } })));
      restoreFocus(list, snap, focusables(list), (n) => focusEl(n, { instant: true }));
    };
    update();
    return { title: 'Quality', body: list, initial: () => list.querySelector('.po-item.selected') || list.querySelector('.po-item'), update };
  }

  chatPop() {
    const onoff = button('', () => this.toggleChat(), { class: 'cc-toggle', dataset: { focusKey: 'pop-chat-on' } });
    const head = el('div', { class: 'cc-row' }, el('span', { class: 'cc-label' }, 'Chat'), onoff);
    const controls = new ChatControls({
      settings: state.settings,
      env: () => chatEnv(this.embed ? !!this.embed.isDirect : state.settings.playerEngine !== 'embed'),
      onChange: (patch, { live }) => {
        if (!this.chatOn) { this.chatOn = true; this.applyLayout(); } // show what is being changed
        if (live) previewSettings(patch); else saveSettings(patch);
        this.bumpOverlay();
      },
    });
    const update = () => {
      onoff.textContent = this.chatOn ? 'On' : 'Off';
      onoff.classList.toggle('on', !!this.chatOn);
      controls.update(state.settings);
    };
    update();
    return { title: 'Chat', body: el('div', { class: 'po-pop-body po-chat' }, head, ...controls.nodes), initial: () => onoff, update };
  }

  pointsPop() {
    const bal = el('div', { class: 'po-pop-big' });
    const update = () => {
      const p = this.labelCtx().points;
      bal.replaceChildren(icon('points', 'po-item-icon'), el('span', {}, p == null ? 'Balance not available yet' : p.toLocaleString('en-US')));
      bal.classList.toggle('dim', p == null);
    };
    update();
    const rewards = button([icon('gift', 'po-item-icon'), el('span', {}, 'Rewards')], () => this.openPointsPanel({ rewards: true }), { class: 'po-item', dataset: { focusKey: 'pop-rewards' } });
    const preds = button([icon('poll', 'po-item-icon'), el('span', {}, 'Predictions & polls')], () => this.openPointsPanel({ rewards: false }), { class: 'po-item', dataset: { focusKey: 'pop-predictions' } });
    return { title: 'Channel points', body: el('div', { class: 'po-pop-body po-list' }, bal, rewards, preds), initial: () => rewards, update };
  }

  morePop() {
    const info = el('div', { class: 'po-pop-info' });
    const raid = el('div', { class: 'po-pop-note' });
    const engine = button('', () => this.switchEngine(), { class: 'po-item', dataset: { focusKey: 'pop-engine' } });
    // "Resume multi-view": shown once the last set (per account) turns out to have two or more channels live.
    const resume = !isPhoneLayout() ? button([icon('grid', 'po-item-icon'), el('span', {}, 'Resume multi-view')], () => { this.pop.close({ returnFocus: false }); this.nav.resumeMulti(); }, { class: 'po-item', hidden: true, dataset: { focusKey: 'pop-multi-resume' } }) : null;
    if (resume && this.nav.resumableMulti) {
      this.nav.resumableMulti().then((list) => {
        if (list.length < 2 || !resume.isConnected) return;
        resume.hidden = false;
        resume.querySelector('span').textContent = `Resume multi-view (${list.map((x) => x.user_name || x.user_login).join(', ')})`;
        if (this.pop.isOpen) this.pop.update();
      });
    }
    // The row's controls that did not fit, as items (a pop-over control opens its own pop-over in place of this one).
    const extra = el('div', { class: 'po-more-extra' });
    const renderExtra = () => {
      const keys = (this.ui && this.ui.overflow) || [];
      const ctx = this.labelCtx();
      const sig = keys.map((k) => `${k}:${controlIcon(k, ctx)}:${controlLabel(k, ctx)}`).join('|');
      if (extra.dataset.sig === sig) return;
      extra.dataset.sig = sig;
      const snap = snapshotFocus(extra, focusables(extra));
      extra.replaceChildren(...keys.map((k) => button([icon(controlIcon(k, ctx), 'po-item-icon'), el('span', {}, controlLabel(k, ctx))], () => {
        if (POPOVER_CONTROLS.has(k)) { this.onControl(k, this.ui.buttons.more); return; }
        this.pop.close(); // focus goes back to More
        this.onControl(k, this.ui.buttons.more);
      }, { class: 'po-item', dataset: { focusKey: `pop-x-${k}` } })));
      restoreFocus(extra, snap, focusables(extra), (n) => focusEl(n, { instant: true }));
    };
    const items = [
      button([icon('reload', 'po-item-icon'), el('span', {}, 'Reload')], () => { this.pop.close({ returnFocus: false }); this.reload(); }, { class: 'po-item', dataset: { focusKey: 'pop-reload' } }),
      engine,
      this.current && this.current.kind === 'live' && !isPhoneLayout() ? button([icon('grid', 'po-item-icon'), el('span', {}, 'Add stream to multi-view')], () => { this.pop.close({ returnFocus: false }); this.nav.watchWith(this.current); }, { class: 'po-item', dataset: { focusKey: 'pop-multi' } }) : null,
      resume,
      window.lurkbox.toggleFullscreen ? button([icon('fullscreen', 'po-item-icon'), el('span', {}, 'Fullscreen')], () => window.lurkbox.toggleFullscreen(), { class: 'po-item', dataset: { focusKey: 'pop-fullscreen' } }) : null,
    ];
    const update = () => {
      const cur = this.current;
      if (!cur) return;
      renderExtra();
      const s = cur.stream;
      const meta = cur.kind === 'clip'
        ? ['Clip', clipMeta(cur.clip), cur.clip.video_id ? (cur.clip.vod_offset != null ? `from a broadcast at ${fmtTime(cur.clip.vod_offset)}` : 'from a broadcast') : 'broadcast not saved']
        : cur.kind === 'video'
        ? ['Video', cur.video && cur.video.created_at ? fmtDate(cur.video.created_at) : null]
        : s ? [s.game_name, s.viewer_count != null ? `${fmtViewers(s.viewer_count)} watching` : null, s.started_at ? `up ${fmtUptime(s.started_at)}` : null] : ['Live'];
      info.textContent = meta.filter(Boolean).join(' · ');
      raid.textContent = cur.kind === 'live' ? this.raidStatusText() : '';
      raid.hidden = cur.kind !== 'live';
      const direct = !!(this.embed && this.embed.isDirect);
      engine.replaceChildren(icon('engine', 'po-item-icon'), el('span', {}, direct ? 'Use the Twitch player' : this.embedOnly ? 'Try the Lurkbox player again' : 'Use the Lurkbox player'));
    };
    update();
    return { title: 'More', body: el('div', { class: 'po-pop-body po-list' }, info, raid, extra, ...items.filter(Boolean)), initial: () => extra.querySelector('.focusable') || items[0], update };
  }

  /** Reloads what is playing (More → Reload). */
  reload() {
    const cur = this.current;
    if (!cur) return;
    if (cur.kind === 'live') this.openLive({ login: cur.login, name: cur.name, userId: cur.userId, stream: cur.stream });
    else if (cur.kind === 'clip') this.openClip(cur.clip, null, { login: cur.login, name: cur.name });
    else if (cur.video) { this.saveResume(true); this.openVideo(cur.video); }
  }

  /** More → switch between the Lurkbox (direct) player and the Twitch player, saved as the Player setting. */
  async switchEngine() {
    const direct = !!(this.embed && this.embed.isDirect);
    this.pop.close({ returnFocus: false });
    this.embedOnly = null;
    await saveSettings({ playerEngine: direct ? 'embed' : 'direct' });
    toast(direct ? 'Twitch player' : 'Lurkbox player', 2000);
    this.reload();
  }

  // ---------- raids ----------

  onRaid(ev) {
    if (!this.active || !this.current || this.current.kind !== 'live') return;
    if (ev.from_broadcaster_user_id !== this.current.userId) return;
    this.raid.start(ev, { follow: !!state.settings.raidFollow, delaySec: state.settings.raidDelay });
  }

  renderRaid({ ev, mode, left }) {
    this.raidEl.replaceChildren(el('div', { class: 'raid-card' },
      el('div', { class: 'raid-kicker' }, `${ev.from_broadcaster_user_name} is raiding`),
      el('div', { class: 'raid-target' }, mode === 'countdown' ? `Raiding ${ev.to_broadcaster_user_name}` : ev.to_broadcaster_user_name),
      el('div', { class: 'raid-viewers' }, `with ${fmtViewers(ev.viewers)} viewers`),
      mode === 'countdown' ? el('div', { class: 'raid-count' }, String(left)) : null,
      hint(mode === 'countdown' ? '{B} cancel · {A} go now' : '{A} follow raid · {B} dismiss', 'raid-hint')));
    this.raidEl.hidden = false;
    document.body.classList.add('raid-open');
  }

  hideRaid() {
    document.body.classList.remove('raid-open');
    this.raidEl.hidden = true;
    this.raidEl.replaceChildren();
  }

  cancelRaid() {
    this.raid.clear();
    this.hideRaid();
  }

  followRaid(ev) {
    this.hideRaid();
    toast(`Following raid to ${ev.to_broadcaster_user_name}`, 3500, 'ok');
    this.openLive({ login: ev.to_broadcaster_user_login, name: ev.to_broadcaster_user_name, userId: ev.to_broadcaster_user_id });
    if (this.overlayVisible()) this.renderOverlay();
  }

  // ---------- channel points ----------

  glyph(act) { const g = document.querySelector(`kbd.glyph[data-act="${act}"]`); return g ? g.textContent : act; }

  /** Twitch's chat frame for this channel: always in "Twitch chat" style, otherwise only with a twitch.tv session. */
  openTwitchChat(login) {
    this.points = { signedIn: false, balance: null };
    if (state.settings.chatStyle === 'twitch') { this.tchat.open(login); return; }
    const cur = this.current;
    this.tchat.close();
    if (!window.lurkbox.playerSessionStatus) return;
    window.lurkbox.playerSessionStatus().then((st) => {
      if (cur !== this.current || !this.active) return;
      if (st && st.signedIn) { this.tchat.open(login); this.applyLayout(); } else plog('channel points: no twitch.tv session; the chat frame is not loaded');
    }).catch(() => {});
  }

  /**
   * The rewards view: Twitch's chat frame as a large modal over the player, with its rewards popover (rewards: true) or
   * the pinned prediction/poll, fitted to the frame and driven by the controller. The hint sits below the modal.
   */
  async openPointsPanel({ rewards }) {
    if (!this.tchat.login) return;
    this.hideOverlay();
    this.pointsPanel = true;
    if (!this.pointsBackdrop) {
      this.pointsBackdrop = el('div', { class: 'points-backdrop', hidden: true, onclick: () => this.closePointsPanel({ focusIcon: true }) }, hint('D-pad move \u00B7 {A} select \u00B7 {B} back / close', 'points-hint'));
      this.screen.append(this.pointsBackdrop);
    }
    this.pointsBackdrop.hidden = false;
    this.tchat.setMode('modal');
    const r = await window.lurkbox.pointsOpenPanel({ rewards });
    if (r && !r.ok) toast(`Channel points: ${r.reason}`, 3000, 'warn');
    else if (rewards && r && !r.opened) toast('No channel points here (signed out, or the channel has none)', 3500);
  }

  /** B in the rewards view: a reward's detail/confirm step goes back first; otherwise the view closes. */
  async pointsBack() {
    const r = await window.lurkbox.pointsPad('b');
    if (r !== 'back' && this.pointsPanel) this.closePointsPanel({ focusIcon: true });
  }

  /** Closes the rewards view; with focusIcon the overlay comes back with the channel-points icon focused. */
  closePointsPanel({ focusIcon = false } = {}) {
    if (!this.pointsPanel) return;
    this.pointsPanel = false;
    if (this.pointsBackdrop) this.pointsBackdrop.hidden = true;
    window.lurkbox.pointsClosePanel();
    this.applyLayout();
    if (focusIcon && this.active && this.current) {
      this.lastFocusKey = 'po-points';
      this.showOverlay();
    }
  }

  /** Once a minute on the direct engine: tell the platform layer what is on screen (it decides whether to report). */
  tickWatchMinute() {
    const cur = this.current;
    const now = performance.now();
    if (now - this.lastMinute.at < 60000) return;
    const t = this.safe(() => this.embed.getCurrentTime());
    const advanced = typeof t === 'number' && this.lastMinute.t != null && t !== this.lastMinute.t;
    const first = this.lastMinute.at === 0;
    this.lastMinute = { at: now, t: typeof t === 'number' ? t : null };
    if (first || !window.lurkbox.watchMinute || !cur || cur.kind !== 'live' || !this.embed || !this.embed.isDirect) return;
    if (!cur.userId || !cur.stream || !cur.stream.id) return;
    window.lurkbox.watchMinute({
      login: cur.login, channelId: cur.userId, broadcastId: cur.stream.id,
      direct: true, live: true, rewound: !!this.rewind,
      playing: advanced && this.safe(() => this.embed.isPaused()) === false,
    }).catch(() => {});
  }

  // ---------- seeking ----------

  resetSeek() {
    if (this.scrubber) this.scrubber.cancel();
    this.rewind = null;
    this.archive = undefined;
    this.archiveFor = null;
    this.storyboard = null;
    this.noRewindToast = false;
    this.lastResumeSave = 0;
    this.lastMinute = { at: 0, t: null };
    if (this.seekBar) this.seekBar.preview = null;
  }

  glyphX() { const g = document.querySelector('kbd.glyph[data-act="X"]'); return g ? g.textContent : 'X'; }

  /**
   * What the seek bar shows, in one coordinate system:
   *   video: seconds into the video;
   *   live: seconds since the stream started (the right end is the live edge, uptime).
   * null when there is nothing to seek (embed live, unknown duration, no start time).
   */
  seekModel() {
    const e = this.embed;
    const cur = this.current;
    if (!e || !cur || !this.active) return null;
    const num = (f) => { const v = this.safe(f); return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
    if (cur.kind === 'video' || cur.kind === 'clip') {
      const dur = num(() => e.getDuration());
      if (!(dur > 0)) return null;
      const sb = this.storyboard;
      return {
        min: 0, max: dur, pos: Math.min(dur, num(() => e.getCurrentTime())),
        buffered: e.getBuffered ? e.getBuffered() : [],
        label: fmtTime, total: fmtTime(dur), note: '',
        thumb: sb ? (t) => storyboardFrame(sb, t) : null,
      };
    }
    if (!e.isDirect || !cur.stream || !cur.stream.started_at) return null;
    const nowSec = Date.now() / 1000;
    const startSec = Date.parse(cur.stream.started_at) / 1000;
    if (!Number.isFinite(startSec)) return null;
    const uptime = Math.max(1, nowSec - startSec);
    let pos;
    let min;
    let buffered = [];
    let note = '';
    let thumb = null;
    const g = this.archive ? this.rewindGeo(nowSec) : null;
    if (this.rewind && g) {
      pos = uptime - g.offsetOf(num(() => e.getCurrentTime()));
      min = Math.max(0, uptime - g.maxOffset);
      buffered = e.getBuffered().map(([a, b]) => [uptime - g.offsetOf(a), uptime - g.offsetOf(b)]);
      note = g.minOffset > 15 ? `available up to \u2212${fmtTime(g.minOffset)}` : '';
    } else {
      const w = e.liveWindow();
      const sync = Number.isFinite(w.liveSync) ? w.liveSync : num(() => e.getCurrentTime());
      const win = Number.isFinite(w.windowStart) ? Math.max(0, sync - w.windowStart) : 20;
      pos = uptime - (this.latency() || 0);
      min = this.archive === false ? Math.max(0, uptime - win) : 0;
      buffered = e.getBuffered().map(([a, b]) => [uptime - (sync - a), uptime - (sync - b)]);
      if (this.archive === false) note = 'not saved: no rewind';
      else if (g && g.minOffset > 15) note = `rewind up to \u2212${fmtTime(g.minOffset)}`;
    }
    if (g && this.storyboard) {
      const sb = this.storyboard;
      thumb = (t) => storyboardFrame(sb, g.vodPosition(uptime - t));
    }
    return {
      min, max: uptime, pos: Math.min(uptime, Math.max(min, pos)), buffered,
      label: (t) => { const off = uptime - t; return off < 3 ? 'LIVE' : `\u2212${fmtTime(off)}`; },
      total: `uptime ${fmtTime(uptime)}`, note, thumb,
    };
  }

  /** Rewind geometry for the current live stream's archive VOD. */
  rewindGeo(nowSec = Date.now() / 1000) {
    const cur = this.current;
    const a = this.archive;
    if (!a || !cur || !cur.stream) return null;
    const engineDur = this.rewind && this.embed && this.embed.getDuration ? this.safe(() => this.embed.getDuration()) : 0;
    const helixDur = parseHelixDuration(a.duration);
    const available = Math.max(Number.isFinite(engineDur) ? engineDur : 0, Number.isFinite(helixDur) ? helixDur : 0);
    return rewindGeometry({ nowSec, streamStartSec: Date.parse(cur.stream.started_at) / 1000, vodStartSec: Date.parse(a.created_at) / 1000, available });
  }

  /** Looks up the live stream's archive VOD once per stream (Helix /videos, matched by stream_id). */
  async ensureArchive() {
    const cur = this.current;
    if (!cur || cur.kind !== 'live') return null;
    if (!cur.stream && state.auth.signedIn) { try { cur.stream = await tw.streamByLogin(cur.login); } catch { /* below */ } }
    if (!cur.stream && window.lurkbox.liveInfo) await this.loadLiveInfo(cur);
    const s = cur.stream;
    if (!s || !s.id) return null;
    if (this.archiveFor === s.id && this.archive !== undefined) return this.archive || null;
    let found = null;
    try {
      if (state.auth.signedIn) {
        const uid = cur.userId || s.user_id;
        const r = await helix('/videos', { user_id: uid, type: 'archive', first: 5 });
        found = matchArchive(s, r.data || []);
      } else {
        const info = await window.lurkbox.liveInfo(cur.login); // signed out: Twitch's web GQL
        found = info && info.stream && String(info.stream.id) === String(s.id) ? info.archive : null;
      }
    } catch (e) {
      plog(`archive lookup failed: ${e.message}`);
      return null; // unknown: try again next time
    }
    if (cur !== this.current) return null;
    this.archiveFor = s.id;
    this.archive = found || false;
    plog(found ? `live rewind: archive ${found.id} (Helix duration ${found.duration})` : `live rewind: no archive for stream ${s.id}`);
    if (found && window.lurkbox.storyboard) window.lurkbox.storyboard(found.id).then((sb) => { if (cur === this.current) this.storyboard = sb; }).catch(() => {});
    return found;
  }

  /** Signed out there is no Helix: the stream's id and start time come from Twitch's web GQL. */
  async loadLiveInfo(cur) {
    try {
      const info = await window.lurkbox.liveInfo(cur.login);
      if (cur === this.current && info && info.stream && !cur.stream) {
        cur.stream = info.stream;
        if (!cur.userId && info.stream.user_id) cur.userId = info.stream.user_id;
        if (info.archive) { this.archiveFor = info.stream.id; this.archive = info.archive; }
      }
    } catch { /* no rewind */ }
  }

  canSeek() { return !!this.seekModel(); }

  /** Seek input. Returns true when consumed. */
  handleSeek(action) {
    if (!this.current || !this.embed) return false;
    const onBar = this.overlayVisible() && document.activeElement === this.seekBar.node;
    const dir = action === LEFT ? -1 : action === RIGHT ? 1 : 0;
    if (onBar && dir) { this.bumpOverlay(); this.scrubber.press(dir); return true; }
    const j = seekJump(action, { onBar });
    // A plain direction with the overlay closed starts a scrub on a VOD (the bar opens focused).
    const startScrub = !this.overlayVisible() && dir && (this.current.kind === 'video' || this.current.kind === 'clip');
    if (!j && !startScrub) return false;
    const m = this.seekModel();
    if (!m) {
      if (j && this.current.kind === 'live' && !this.embed.isDirect && ['LT', 'RT'].includes(action)) toast('Rewind needs the Lurkbox player (Settings \u2192 Player)', 2500);
      return !!j && action !== 'LB' && action !== 'RB';
    }
    if (!this.overlayVisible()) { this.showOverlay(); focusEl(this.seekBar.node, { instant: true }); }
    this.bumpOverlay();
    if (startScrub) { this.scrubber.press(dir); return true; }
    if (j.delta) this.scrubber.nudge(j.delta);
    else this.scrubber.setTarget(j.to === 'start' ? m.min : m.max);
    return true;
  }

  /** A direction was let go: a running scrub applies now. */
  release(action) {
    if ((action === LEFT || action === RIGHT) && this.scrubber.active && this.scrubber.dir) this.scrubber.release();
  }

  /** Seeks by `delta` seconds on a VOD or clip (a double tap on a half of the video); shows the controls. */
  seekBy(delta) {
    const cur = this.current;
    const m = this.seekModel();
    if (!cur || (cur.kind !== 'video' && cur.kind !== 'clip') || !m) return false;
    const t = Math.max(m.min, Math.min(m.max, m.pos + delta));
    this.seekTo(t);
    if (!this.overlayVisible()) this.showOverlay(); else this.bumpOverlay();
    this.flashSeek(delta);
    return true;
  }

  /** "−10 s" / "+10 s" over the half of the video that was tapped. */
  flashSeek(delta) {
    if (!this.seekFlash) {
      this.seekFlash = el('div', { class: 'seek-flash', 'aria-hidden': 'true' });
      document.getElementById('player-stage').append(this.seekFlash);
    }
    const f = this.seekFlash;
    f.textContent = `${delta < 0 ? '\u2212' : '+'}${Math.abs(delta)} s`;
    f.dataset.side = delta < 0 ? 'left' : 'right';
    f.hidden = false;
    clearTimeout(this.seekFlashTimer);
    this.seekFlashTimer = setTimeout(() => { f.hidden = true; }, 700);
  }

  /**
   * Touch on the player (touch layouts only; shared/gestures.js): a tap shows or hides the controls, a double tap on
   * the left or right half seeks ∓10 s on VODs and clips, a swipe down closes the player on a phone, and on a phone
   * held sideways a swipe from the right brings the chat in (a swipe right puts it away).
   */
  installTouch(stage) {
    this.touchTapAt = -Infinity;
    const dbl = new DoubleTap();
    const sideways = () => isPhoneLayout() && window.innerWidth > window.innerHeight;
    bindPointerGestures(stage, {
      skip: (e) => !!e.target.closest('button, .po-ui, .po-pop, .play-prompt, #chat'),
      onTap: ({ x, t }) => {
        this.touchTapAt = t;
        if (!this.active) return;
        if (this.pop.isOpen) { this.pop.close({ returnFocus: false }); this.bumpOverlay(); dbl.reset(); return; }
        const rect = stage.getBoundingClientRect();
        const r = dbl.tap(x - rect.left, rect.width, t);
        if (r.kind === 'double' && this.seekBy(r.seek)) return;
        if (this.overlayVisible()) this.hideOverlay(); else this.showOverlay();
      },
      onSwipe: (dir, s) => {
        if (!this.active || this.pop.isOpen || this.cpop.isOpen || this.raid.active || this.pointsPanel) return;
        if (dir === 'down' && isPhoneLayout() && !sideways()) { this.nav.closePlayer(); return; }
        if (dir === 'left' && sideways() && !this.chatOn && s.x > window.innerWidth * 0.5) this.toggleChat();
        else if (dir === 'right' && sideways() && this.chatOn) this.toggleChat();
      },
    });
    // The chat panel itself: a swipe right puts it away (phone held sideways).
    bindPointerGestures(this.chatPanel, {
      skip: (e) => !!e.target.closest('input, button'),
      onSwipe: (dir) => { if (this.active && dir === 'right' && sideways() && this.chatOn) this.toggleChat(); },
    });
  }

  seekTo(t) {
    const cur = this.current;
    if (!cur || !this.embed) return;
    if (cur.kind === 'video' || cur.kind === 'clip') {
      plog(`seek to ${fmtTime(t)}`);
      this.safe(() => this.embed.seek(t));
      if (this.embed.isPaused && this.safe(() => this.embed.isPaused()) === true && !this.userPaused) this.kickPlayback('seek');
      if (cur.kind === 'video') setTimeout(() => this.saveResume(true), 1500);
    } else {
      this.liveSeekTo(t).catch((e) => plog(`live seek failed: ${e.message}`));
    }
    this.renderSeek();
  }

  /** Live seek to t (seconds since the stream started): inside the live window, or into the archive VOD. */
  async liveSeekTo(t) {
    const cur = this.current;
    const e = this.embed;
    if (!cur || cur.kind !== 'live' || !e || !e.isDirect || !cur.stream) return;
    const nowSec = Date.now() / 1000;
    const uptime = nowSec - Date.parse(cur.stream.started_at) / 1000;
    const offset = Math.max(0, uptime - t);
    let win = 20;
    let w = null;
    if (!this.rewind) {
      w = e.liveWindow();
      if (Number.isFinite(w.windowStart) && Number.isFinite(w.liveSync)) win = Math.max(4, w.liveSync - w.windowStart - 2);
    }
    if (offset <= win) {
      if (this.rewind) { this.goLive('scrubbed to live'); return; }
      if (offset < 3) { e.jumpToLive(); return; }
      e.v.currentTime = Math.max(w.windowStart, w.liveSync - offset);
      return;
    }
    const archive = await this.ensureArchive();
    if (cur !== this.current || this.embed !== e) return;
    const target = rewindTarget({ offset, liveWindow: win, archive, geometry: archive ? this.rewindGeo() : null });
    if (target.mode === 'none') {
      if (!this.noRewindToast) { this.noRewindToast = true; toast("This channel doesn't save broadcasts, so you can't rewind.", 4000); }
      if (!this.rewind && w && Number.isFinite(w.windowStart)) e.v.currentTime = Math.max(w.windowStart, w.liveSync - target.offset);
      this.renderSeek();
      return;
    }
    if (target.mode === 'live') { if (this.rewind) this.goLive('scrubbed to live'); return; }
    if (target.clamped) toast(`The saved broadcast reaches \u2212${fmtTime(target.offset)} for now`, 2500);
    if (this.rewind && this.rewind.id === archive.id) {
      e.seek(target.position);
    } else {
      plog(`live rewind: ${cur.login} -> archive ${archive.id} at ${fmtTime(target.position)} (\u2212${fmtTime(target.offset)})`);
      this.rewind = { id: archive.id, since: performance.now() };
      e.load({ video: archive.id, startAt: target.position });
      this.armPlayWatchdog();
    }
    this.renderSeek();
  }

  /** Back from the archive VOD to the live stream. */
  goLive(why) {
    const cur = this.current;
    if (!cur || !this.rewind || !this.embed) return;
    plog(`live rewind: back to live (${why})`);
    this.rewind = null;
    this.embed.load({ channel: cur.login });
    this.armPlayWatchdog();
    toast(why === 'caught up' ? 'Caught up: back to live' : 'Back to live', 1800);
    this.renderSeek();
  }

  renderSeek() {
    if (!this.overlayVisible()) return;
    this.seekBar.update(this.seekModel());
  }

  /** Once a second: refresh the bar, save the VOD position every 10 s, leave a caught-up rewind. */
  tickSeek() {
    if (!this.active || !this.current || !this.embed) return;
    this.tickWatchMinute();
    if (this.overlayVisible() && !this.seekBar.node.matches('.scrubbing:active')) this.renderSeek();
    const now = performance.now();
    if (this.current.kind === 'video' && this.playingSeen && now - (this.lastResumeSave || 0) > 10000) this.saveResume();
    if (this.rewind && now - this.rewind.since > 8000 && this.safe(() => this.embed.isPaused()) === false) {
      const d = this.safe(() => this.embed.getDuration());
      const p = this.safe(() => this.embed.getCurrentTime());
      if (typeof d === 'number' && d > 0 && d - p < 4) this.goLive('caught up');
    }
  }

  /** Stores where this VOD is (per account). */
  saveResume(force = false) {
    const cur = this.current;
    if (!cur || cur.kind !== 'video' || !this.embed || !window.lurkbox.resumeSet) return;
    if (!this.playingSeen && !force) return;
    const pos = this.safe(() => this.embed.getCurrentTime());
    const dur = this.safe(() => this.embed.getDuration());
    if (typeof pos !== 'number' || !Number.isFinite(pos) || pos <= 0) return;
    this.lastResumeSave = performance.now();
    const done = typeof dur === 'number' && dur > 0 && resumeDecision({ position: pos, duration: dur }) === 'start' && pos > 30;
    // The video's details go with the position, for Following's Continue watching row.
    const v = cur.video || {};
    const meta = { title: v.title, login: v.user_login, name: v.user_name, userId: v.user_id, thumb: v.thumbnail_url };
    window.lurkbox.resumeSet(cur.videoId, done ? 0 : pos, dur, meta).catch(() => {});
  }

  /** "Resume at 1:23:45 / Start over". Resolves with the start position (B = resume). */
  askResume(position) {
    return new Promise((resolve) => {
      pickFromList({
        title: 'Continue watching?',
        items: [{ value: 'resume', label: `Resume at ${fmtTime(position)}` }, { value: 'start', label: 'Start over' }],
        current: 'resume',
        onPick: (v) => resolve(v === 'resume' ? position : 0),
        onCancel: () => resolve(position),
      });
    });
  }

  // ---------- input ----------

  /** Up from the message box: pick chat lines with the D-pad (A opens the user card, B or Down past the end goes back). */
  startLinePick() {
    const lines = this.pickableLines();
    if (!lines.length) return false;
    const a = document.activeElement;
    if (a && this.composer.contains(a)) a.blur();
    this.chat.holdScroll = true;
    this.setLinePick(lines[lines.length - 1]);
    return true;
  }

  pickableLines() { return [...this.chatPanel.querySelectorAll('.chat-list .chat-msg[data-uid]')].filter((n) => n.dataset.uid); }

  setLinePick(node) {
    if (this.linePick) this.linePick.classList.remove('picked');
    this.linePick = node;
    if (node) { node.classList.add('picked'); node.scrollIntoView({ block: 'nearest' }); }
  }

  endLinePick({ toComposer = true } = {}) {
    this.setLinePick(null);
    this.chat.holdScroll = false;
    if (toComposer && this.composerReachable()) this.composer.focus({ keyboard: false });
  }

  handleLinePick(action) {
    if (!this.linePick.isConnected || !this.screen.classList.contains('chat-on')) {
      // The line scrolled out of the log, or chat closed: back to the newest line (or out).
      const lines = this.screen.classList.contains('chat-on') ? this.pickableLines() : [];
      if (!lines.length) { this.endLinePick(); return false; }
      this.setLinePick(lines[lines.length - 1]);
    }
    if (action === UP || action === DOWN) {
      const lines = this.pickableLines();
      const i = lines.indexOf(this.linePick) + (action === UP ? -1 : 1);
      if (i >= lines.length) this.endLinePick();
      else this.setLinePick(lines[Math.max(0, i)]);
      return true;
    }
    if (action === A) { this.chat.openUser(this.linePick); return true; }
    if (action === B || action === Y || action === LEFT || action === RIGHT) { this.endLinePick(); return true; }
    if (action === START) { this.endLinePick({ toComposer: false }); return false; }
    return true;
  }

  scrollChat(action) {
    const l = this.chatPanel.querySelector('.chat-list');
    if (l) l.scrollBy({ top: action === UP ? -200 : 200, behavior: 'smooth' });
  }

  handle(action, source = 'pad') {
    const r = this.handleAction(action, source);
    if (this.overlayVisible()) this.syncTip();
    return r;
  }

  /**
   * The label bubble follows the focused icon. Called after every input as well as on focusin, because DOM focus
   * events are deferred while the window lacks OS focus (Gamescope).
   */
  syncTip() {
    if (document.body.classList.contains('input-mouse') || document.body.classList.contains('input-touch')) return; // hover / long-press show it
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains('po-icon') && this.overlay.contains(a) && !this.pop.isOpen) this.showTip(a);
    else this.hideTip();
  }

  handleAction(action, source = 'pad') {
    if (this.cpop.isOpen) {
      this.cpop.handle(action, source); // B closes it (focus back to the composer's button), A, D-pad, LB/RB tabs, X/Y
      return true;
    }
    if (this.linePick && this.handleLinePick(action)) return true;
    if (this.composer.contains(document.activeElement)) {
      if (this.composer.handle(action, source)) return true;
      if (action === UP && state.auth.signedIn && this.startLinePick()) return true;
      if (action === UP || action === DOWN) { this.scrollChat(action); return true; }
      if (action === Y) { this.leaveComposer(); return true; }
      return true; // the rest would act on the video behind it
    }
    if (this.pointsPanel) {
      if (action === B) { this.pointsBack(); return true; }
      if (action === START) { this.closePointsPanel({ focusIcon: true }); return true; }
      const key = { UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', A: 'a' }[action];
      if (key) window.lurkbox.pointsPad(key);
      return true;
    }
    if (action === Y && this.pointsOfferUntil > performance.now() && this.tchat.login) {
      this.pointsOfferUntil = 0;
      this.openPointsPanel({ rewards: false });
      return true;
    }
    if (this.raid.active) {
      if (action === B) { this.raid.cancel(); return true; }
      if (action === A) { this.raid.followNow(); return true; }
    }
    // "Press A to play" takes A, unless A is meant for a control focused in the overlay.
    if (this.playPrompt && !this.playPrompt.hidden && action === A && !(this.overlayVisible() && this.overlay.contains(document.activeElement))) {
      this.playPrompt.querySelector('button').click();
      return true;
    }
    if (this.overlayVisible() && this.pop.isOpen) {
      this.bumpOverlay();
      if (handleSliderAction(action)) return true; // LEFT/RIGHT on a slider (hold accelerates)
      if (action === START) { this.hideOverlay(); return true; }
      if (this.pop.handle(action)) return true; // B closes it (focus back to its button), A, D-pad inside it
      // Anything else (Y, X, LB/RB, triggers) keeps its usual meaning below.
      if (['LT', 'RT', 'SHIFT_LEFT', 'SHIFT_RIGHT', 'HOME', 'END'].includes(action)) this.pop.close();
    }
    if (this.handleSeek(action)) return true;
    if (this.overlayVisible()) {
      this.bumpOverlay();
      if (DIRECTIONS.includes(action)) {
        if (!this.overlay.contains(document.activeElement)) focusFirst(this.overlay, '.po-default');
        else moveFocus(action, this.overlay);
        return true;
      }
      if (action === A) {
        const a = document.activeElement;
        if (a && this.overlay.contains(a)) a.click();
        else focusFirst(this.overlay, '.po-default');
        return true;
      }
      if (action === B || action === START) { this.hideOverlay(); return true; }
    }
    switch (action) {
      case A:
      case START:
        this.showOverlay();
        return true;
      case B:
        this.nav.closePlayer();
        return true;
      case Y: this.toggleChat(); return true;
      case X: this.jumpToLive(); return true;
      case LB: if (this.current && this.current.kind === 'clip') this.stepClip(-1); else this.step(-1); return true;
      case RB: if (this.current && this.current.kind === 'clip') this.stepClip(1); else this.step(1); return true;
      case UP:
      case DOWN: {
        // With Lurkbox chat showing, up/down scroll it; otherwise they bring the controls back.
        if (this.screen.classList.contains('chat-on') && !this.screen.classList.contains('twitch-chat')) this.scrollChat(action);
        else this.showOverlay();
        return true;
      }
      case BACK: // View/Select: straight into the message box with the keyboard, without opening the controls
        this.openComposer();
        return true;
      case LEFT:
      case RIGHT: {
        // Toward a visible Lurkbox chat: step into its message box (A then opens the keyboard). Otherwise show the controls.
        // (On videos, left/right scrub instead: handleSeek.)
        const towardChat = action === (this.screen.classList.contains('chat-left') ? LEFT : RIGHT);
        if (towardChat && this.composerReachable()) { this.composer.focus({ keyboard: false }); return true; }
        this.showOverlay();
        return true;
      }
      default:
        return true;
    }
  }
}
