// Direct HLS engine (hls.js in a <video>), shaped like the subset of the
// Twitch.Player API the player uses, so both engines share the same overlay.
import { loadScript } from './ui.js';
import { parseQualities, adState, shouldFallback, fatalAction, unrecoverableLoad, resumeDecision, codecsFor, catchUpRate, CODEC_TYPES, levelPlan, levelLabel } from './hls-util.js';

export const EVENTS = { READY: 'ready', PLAYING: 'playing', PAUSE: 'pause', ONLINE: 'online', OFFLINE: 'offline', ENDED: 'ended' };

export class DirectEngine {
  /**
   * One engine per <video>: the single player has one, multi-view one per tile (each its own hls.js instance; they
   * share nothing but the loaded hls.js script). tag: the log prefix ('direct', 'multi:<login>').
   * @param {HTMLElement} host @param {{onFallback: (reason) => void, onAd: (ad) => void, log: (msg) => void, quality: string, tag?: string}} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.tag = opts.tag || 'direct';
    this.listeners = {};
    this.video = document.createElement('video');
    this.video.className = 'direct-video';
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.setAttribute('tabindex', '-1');
    host.replaceChildren(this.video);
    this.hls = null;
    this.qualities = [];
    this.quality = 'auto';
    this.capHeight = null; // background quality cap (px), null = none
    this.fatalCount = 0;
    this.ad = { inAd: false };
    this.ranges = [];
    this.v = this.video;
    for (const [ev, name] of [['playing', EVENTS.PLAYING], ['pause', EVENTS.PAUSE], ['ended', EVENTS.ENDED]]) {
      this.v.addEventListener(ev, () => this.emit(name));
    }
    this.v.addEventListener('loadeddata', () => { if (!this.frameSeen) { this.frameSeen = true; this.milestone('first frame'); } });
    this.statsTimer = setInterval(() => this.logStats(), 30000);
    this.adTimer = setInterval(() => this.checkAd(), 1000);
  }

  /** Start-up steps for the player's timeline: 'master', 'first level', 'first frame'. */
  milestone(step, note) { if (this.opts.onMilestone) { try { this.opts.onMilestone(step, note); } catch { /* ignore */ } } }

  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  emit(name, data) { (this.listeners[name] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

  /** startAt: seconds into a video (resume, live rewind); videos start at 0 by default. */
  async load({ channel, video, startAt }, { retry = false } = {}) {
    this.teardownHls();
    if (!retry) this.forceH264 = false; // a new channel gets the codec setting again
    this.target = { channel, video, startAt };
    this.frameSeen = false;
    this.fatalCount = 0;
    this.ranges = [];
    this.lastStats = null;
    const pref = this.forceH264 ? 'h264' : (this.opts.codecPref ? this.opts.codecPref() : 'h264');
    const efficient = {};
    if (pref === 'best') {
      for (const [c, type] of Object.entries(CODEC_TYPES)) {
        try {
          const info = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: type, width: 1920, height: 1080, bitrate: 6e6, framerate: 60 } });
          efficient[c] = !!(info.supported && info.powerEfficient);
        } catch { efficient[c] = false; }
      }
    }
    const codecs = codecsFor(pref, (t) => window.MediaSource && MediaSource.isTypeSupported(t), efficient);
    this.codecs = codecs;
    const t0 = performance.now();
    const r = await window.lurkbox.directMaster({ login: channel || null, vodId: video ? String(video).replace(/^v/, '') : null, codecs });
    if (!this.target || this.target.channel !== channel || this.target.video !== video) return; // switched meanwhile
    if (!r.ok) {
      const d = r.offline ? shouldFallback({ type: 'usher', status: 404 }) : shouldFallback(r.reason && r.reason.startsWith('usher') ? { type: 'usher', reason: r.reason } : r.reason === 'invalid playlist' ? { type: 'invalid-playlist' } : { type: 'token-error', reason: r.reason });
      if (d.offline) { this.emit(EVENTS.READY); this.emit(EVENTS.OFFLINE); return; }
      this.opts.onFallback(d.reason);
      return;
    }
    this.milestone('master', r.authed ? 'signed in' : 'anonymous');
    this.opts.log(`[${this.tag}] master ok in ${Math.round(performance.now() - t0)} ms (${r.authed ? 'signed-in token' : `anon token: ${r.anonReason || '?'}`}), codecs ${codecs.join(',')} (${this.forceH264 ? 'H.264 forced after a fatal error' : `setting: ${pref}`})`);
    this.qualities = parseQualities(r.master).filter((q) => !q.audioOnly);
    await loadScript('/vendor/hls.min.js');
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) { this.opts.onFallback('hls.js unsupported'); return; }
    const low = this.opts.lowLatency !== false;
    // A VOD of a broadcast that is still live is an EVENT playlist, which hls.js treats as live: it would pull the
    // playhead to the edge (liveMaxLatencyDuration) and speed up. Videos never chase the edge.
    const hls = new Hls(video ? {
      startPosition: Number.isFinite(startAt) ? Math.max(0, startAt) : 0,
      liveSyncDuration: 6,
      liveMaxLatencyDuration: 1e9,
      maxLiveSyncPlaybackRate: 1,
      backBufferLength: 90,
      enableWorker: true,
    } : {
      lowLatencyMode: low,
      liveSyncDuration: low ? 2 : 6,
      liveMaxLatencyDuration: low ? 12 : 30,
      maxLiveSyncPlaybackRate: catchUpRate(this.opts.autoCatchUp !== false), // speeds up slightly, never jumps
      backBufferLength: 30,
      enableWorker: true,
    });
    this.v.preservesPitch = true;
    this.hls = hls;
    const url = URL.createObjectURL(new Blob([r.master], { type: 'application/vnd.apple.mpegurl' }));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      URL.revokeObjectURL(url);
      this.emit(EVENTS.READY);
      this.emit(EVENTS.ONLINE);
      this.applyQuality();
    });
    this.levelLoaded = false;
    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
      if (!this.levelLoaded) { this.levelLoaded = true; this.milestone('first level'); this.opts.log(`[${this.tag}] first level playlist loaded after ${Math.round(performance.now() - t0)} ms${data.details && !data.details.live ? ' (VOD)' : ''}`); }
      const dr = data.details && data.details.dateRanges;
      if (dr) this.ranges = Object.values(dr).map((d) => ({ ...d.attr, CLASS: d.class || (d.attr && d.attr.CLASS) }));
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      const code = data.response ? data.response.code : undefined;
      if (this.hls === hls && unrecoverableLoad({ network: data.type === Hls.ErrorTypes.NETWORK_ERROR, details: data.details, code, levelLoaded: this.levelLoaded })) {
        this.opts.log(`[${this.tag}] ${data.details} HTTP ${code} on the first try (${code === 0 ? 'CORS or network refusal' : 'client error'}): not retrying`);
        this.teardownHls();
        this.opts.onFallback(`${data.details} HTTP ${code}`);
        return;
      }
      if (!data.fatal) return;
      this.fatalCount++;
      const mediaError = data.type === Hls.ErrorTypes.MEDIA_ERROR;
      const h264Only = (this.codecs || []).every((c) => c === 'h264');
      const action = fatalAction({ mediaError, count: this.fatalCount, h264Only, reloaded: !!this.forceH264 });
      this.opts.log(`[${this.tag}] fatal hls error ${data.type}/${data.details} (#${this.fatalCount}, codecs ${(this.codecs || []).join(',')}${this.forceH264 ? ', after H.264 retry' : ''}) -> ${action}`);
      if (action === 'recover') { hls.recoverMediaError(); return; }
      if (action === 'restart-load') { hls.startLoad(); return; }
      if (action === 'reload-h264') {
        // Most likely an AV1/HEVC rendition this machine can't decode: one fresh H.264-only start before giving up.
        this.forceH264 = true;
        const t = this.target;
        setTimeout(() => { if (this.target === t) this.load(t, { retry: true }); }, 0);
        return;
      }
      this.opts.onFallback(shouldFallback({ type: 'fatal', count: Math.max(2, this.fatalCount), detail: data.details }).reason);
    });
    hls.loadSource(url);
    hls.attachMedia(this.v);
    clearTimeout(this.framesTimer);
    this.framesTimer = setTimeout(() => {
      const q = this.v.getVideoPlaybackQuality ? this.v.getVideoPlaybackQuality() : null;
      if (!q || q.totalVideoFrames === 0) {
        const d = shouldFallback({ type: 'no-frames' });
        this.opts.onFallback(d.reason);
      }
    }, 10000);
  }

  /**
   * Applies the chosen quality and the background cap. smooth = switch at the next fragment (hls.js nextLevel)
   * instead of flushing the buffer, so the picture never blanks.
   */
  applyQuality({ smooth = false } = {}) {
    const hls = this.hls;
    if (!hls || !hls.levels || !hls.levels.length) return;
    const levels = hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate, group: l.attrs && l.attrs.VIDEO }));
    const plan = levelPlan({ levels, quality: this.quality, capHeight: this.capHeight });
    hls.autoLevelCapping = plan.autoCap;
    if (smooth) hls.nextLevel = plan.level;
    else hls.currentLevel = plan.level;
    return plan;
  }

  /** Quality cap: the background cap (Floater over a game) or a multi-view tile's cap. maxHeight null = no cap. */
  setBackgroundCap(maxHeight) {
    const cap = maxHeight || null;
    if (cap === this.capHeight) return;
    this.capHeight = cap;
    const plan = this.applyQuality({ smooth: true });
    if (plan) {
      const target = plan.level >= 0 ? plan.level : plan.autoCap;
      const lvl = this.hls.levels[target];
      this.opts.log(`[${this.tag}] quality ${cap ? `cap ${cap}p -> ${lvl ? levelLabel(lvl) : 'auto'}` : `off -> ${this.quality}`}`);
    }
  }

  /** Quality and cap together (a multi-view tile gaining or losing the sound), switched at the next fragment. */
  setQualityCap(quality, maxHeight) {
    this.quality = quality || 'auto';
    this.capHeight = maxHeight || null;
    return this.applyQuality({ smooth: true });
  }

  checkAd() {
    if (!this.hls) return;
    const now = this.hls.playingDate ? this.hls.playingDate.getTime() : Date.now();
    const s = adState(this.ranges, now);
    if (s.inAd !== this.ad.inAd) this.opts.log(`[${this.tag}] ad ${s.inAd ? 'start' : 'end'}`);
    this.ad = s;
    this.opts.onAd({ inAd: s.inAd, secondsLeft: s.endsAt ? Math.max(0, Math.round((s.endsAt - now) / 1000)) : null });
  }

  logStats() {
    if (!this.v.getVideoPlaybackQuality) return;
    const q = this.v.getVideoPlaybackQuality();
    const last = this.lastStats || { d: 0, x: 0 };
    this.lastStats = { d: q.totalVideoFrames, x: q.droppedVideoFrames };
    const lvl = this.hls && this.hls.levels ? this.hls.levels[this.hls.currentLevel] : null;
    const dd = q.totalVideoFrames - last.d;
    const dx = q.droppedVideoFrames - last.x;
    const pct = dd > 0 ? ` (last 30 s: ${dx}/${dd}, ${((100 * dx) / dd).toFixed(1)}%)` : '';
    this.opts.log(`[${this.tag}] frames decoded=${q.totalVideoFrames} dropped=${q.droppedVideoFrames}${pct} level=${this.hls ? this.hls.currentLevel : '-'} ${levelLabel(lvl)}${this.capHeight ? ` bg-cap=${this.capHeight}p` : ''}`);
  }

  /** Seconds behind the live edge (null for VODs / unknown). */
  latency() {
    if (!this.hls || !this.target || !this.target.channel) return null;
    const pos = this.hls.liveSyncPosition;
    return Number.isFinite(pos) ? Math.max(0, pos - this.v.currentTime) : (Number.isFinite(this.hls.latency) ? this.hls.latency : null);
  }

  jumpToLive() {
    if (!this.hls) return;
    const pos = this.hls.liveSyncPosition;
    if (Number.isFinite(pos)) this.v.currentTime = pos;
    this.play();
  }

  /** Where the live window starts and what is buffered around the playhead. */
  liveWindow() {
    const hls = this.hls;
    const d = hls && (hls.latestLevelDetails || (hls.levels[hls.currentLevel] && hls.levels[hls.currentLevel].details));
    const frags = d && d.fragments;
    const windowStart = frags && frags.length ? frags[0].start : NaN;
    const t = this.v.currentTime;
    let bufferedEnd = null;
    const b = this.v.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t) bufferedEnd = b.end(i);
    return { windowStart, bufferedEnd, liveSync: hls ? hls.liveSyncPosition : NaN, live: !!(d ? d.live : (this.target && this.target.channel)) };
  }

  /**
   * Resume after a user pause. Twitch keeps a short live window: if the paused position has dropped out of it,
   * go to the live edge (restarting the loader); otherwise play on from where we were (the badge shows "behind").
   */
  resume() {
    if (!this.hls) { this.play(); return 'play'; }
    const w = this.liveWindow();
    const action = resumeDecision({ live: w.live && !!(this.target && this.target.channel), position: this.v.currentTime, windowStart: w.windowStart, liveSync: w.liveSync, bufferedEnd: w.bufferedEnd });
    this.opts.log(`[${this.tag}] resume at ${this.v.currentTime.toFixed(1)} (window from ${Number.isFinite(w.windowStart) ? w.windowStart.toFixed(1) : '?'}, live ${Number.isFinite(w.liveSync) ? w.liveSync.toFixed(1) : '?'}, buffered to ${w.bufferedEnd != null ? w.bufferedEnd.toFixed(1) : '-'}) -> ${action}`);
    if (action === 'jump') {
      this.hls.startLoad(w.liveSync);
      this.v.currentTime = w.liveSync;
    } else if (action === 'reload') {
      const hls = this.hls;
      hls.startLoad(-1);
      const once = () => {
        hls.off(window.Hls.Events.LEVEL_UPDATED, once);
        if (this.hls === hls && Number.isFinite(hls.liveSyncPosition)) this.v.currentTime = hls.liveSyncPosition;
      };
      hls.on(window.Hls.Events.LEVEL_UPDATED, once);
    }
    this.play();
    return action;
  }

  // ---- seeking (videos) ----

  /** Seconds the video has (grows while an archive of a live broadcast is still being written). */
  getDuration() {
    const d = this.v.duration;
    if (Number.isFinite(d) && d > 0) return d;
    const det = this.hls && (this.hls.latestLevelDetails || null);
    return det && Number.isFinite(det.totalduration) ? det.totalduration : 0;
  }

  /** Buffered ranges [[start, end], ...]. */
  getBuffered() {
    const b = this.v.buffered;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    return out;
  }

  seek(t) {
    if (!this.hls) return;
    const d = this.getDuration();
    const to = Math.max(0, d ? Math.min(t, Math.max(0, d - 1)) : t);
    this.v.currentTime = to;
  }

  // ---- Twitch.Player-like API ----
  setChannel(login) { this.load({ channel: login }); }
  setVideo(id) { this.load({ video: id }); }
  play() { const p = this.v.play(); if (p && p.catch) p.catch((e) => this.opts.log(`[${this.tag}] play() rejected: ${e.name}`)); }
  pause() { this.v.pause(); }
  isPaused() { return this.v.paused; }
  setMuted(m) { this.v.muted = !!m; }
  getMuted() { return this.v.muted; }
  setVolume(v) { this.v.volume = Math.min(1, Math.max(0, v)); }
  getVolume() { return this.v.volume; }
  getCurrentTime() { return this.v.currentTime; }
  getEnded() { return this.v.ended; }
  getQualities() {
    return [{ group: 'auto', name: 'Auto' }, ...this.qualities.map((q) => ({ group: q.group, name: q.name }))];
  }
  getQuality() { return this.quality; }
  setQuality(group) { this.quality = group; this.applyQuality(); }

  teardownHls() {
    clearTimeout(this.framesTimer);
    if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; }
  }

  destroy() {
    this.teardownHls();
    clearInterval(this.statsTimer);
    clearInterval(this.adTimer);
    this.v.removeAttribute('src');
    this.v.load();
    this.host.replaceChildren();
  }
}
