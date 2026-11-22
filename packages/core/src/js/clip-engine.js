// Clip playback. Helix GET /clips has no video URL, so the host asks Twitch's web GQL for the clip's MP4 qualities and
// a signed access token (VideoAccessToken_Clip, window.lurkbox.clipSources; see README "Unofficial Twitch interfaces").
// ClipEngine plays the chosen MP4 in a <video>, shaped like DirectEngine (the same overlay, quality pop-over and seek
// bar). Without the host member, with "Twitch player" chosen in Settings, or when GQL fails, ClipEmbed shows Twitch's
// clip embed (clips.twitch.tv/embed) instead: no quality or seeking there, and its end is timed from the clip's length.
import { EVENTS } from './direct-engine.js';

export { EVENTS };
export const CLIP_EMBED = 'https://clips.twitch.tv/embed';

/** "1080p60" / "720p" for a clip quality ({ quality: '1080', frameRate: 60 }). */
export function clipQualityName(q) {
  const h = Number.parseInt(q && q.quality, 10);
  if (!Number.isFinite(h)) return String((q && q.quality) || '?');
  const fps = Math.round(Number(q.frameRate) || 0);
  return `${h}p${fps > 30 ? fps : ''}`;
}

/**
 * The qualities, best first, with names and groups for the quality pop-over: [{ group, name, height, fps, url }].
 * Entries without an https URL are dropped; the same name twice keeps the first.
 */
export function clipQualities(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && typeof q.url === 'string' && /^(https:|lbhls:)/.test(q.url))
    .map((q) => ({ height: Number.parseInt(q.quality, 10) || 0, fps: Math.round(Number(q.frameRate) || 30), url: q.url, name: clipQualityName(q) }))
    .sort((a, b) => b.height - a.height || b.fps - a.fps)
    .filter((q) => (seen.has(q.name) ? false : (seen.add(q.name), true)))
    .map((q) => ({ ...q, group: q.name }));
}

/**
 * Which quality to play: the chosen one if the clip has it; for 'auto' (or one it lacks) the best at or below the
 * default quality setting's height (Settings → Player: 'auto', 'chunked' = source, '720p60', ...) and the background
 * cap. Falls back to the smallest. Returns a clipQualities() entry or null.
 */
export function pickClipQuality(qualities, { chosen = 'auto', preferred = 'auto', capHeight = null } = {}) {
  if (!qualities.length) return null;
  const exact = chosen && chosen !== 'auto' ? qualities.find((q) => q.group === chosen) : null;
  if (exact && !capHeight) return exact;
  const m = /^(\d{3,4})p/.exec(preferred || '');
  let limit = m ? Number(m[1]) : Infinity;
  if (exact) limit = exact.height;
  if (capHeight) limit = Math.min(limit, capHeight);
  return qualities.find((q) => q.height <= limit) || qualities[qualities.length - 1];
}

/**
 * Pure choice of how to play a clip: { kind: 'direct', qualities } or { kind: 'embed', reason }.
 * hostResult: what window.lurkbox.clipSources resolved (null when the host has no such member or threw).
 */
export function clipSourcePlan({ engine = 'direct', hasHost = true, hostResult = null }) {
  if (engine === 'embed') return { kind: 'embed', reason: 'Twitch player chosen in Settings' };
  if (!hasHost) return { kind: 'embed', reason: 'no direct clip playback on this device' };
  if (!hostResult || !hostResult.ok) return { kind: 'embed', reason: (hostResult && hostResult.reason) || 'clip sources failed' };
  const qualities = clipQualities(hostResult.qualities);
  if (!qualities.length) return { kind: 'embed', reason: 'no playable clip quality' };
  return { kind: 'direct', qualities };
}

/** The clip embed's URL (parent must be the page's host, localhost). */
export function clipEmbedUrl(slug, { parent = 'localhost', muted = false } = {}) {
  const q = new URLSearchParams({ clip: String(slug), parent, autoplay: 'true', muted: muted ? 'true' : 'false' });
  return `${CLIP_EMBED}?${q}`;
}

class Emitter {
  constructor() { this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  emit(name, data) { (this.listeners[name] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
}

/** An MP4 clip in a <video>, with the DirectEngine-like API the player uses. */
export class ClipEngine extends Emitter {
  /** @param {HTMLElement} host @param {{ log: (m: string) => void, preferred?: () => string }} opts */
  constructor(host, opts = {}) {
    super();
    this.host = host;
    this.opts = opts;
    this.isDirect = true;
    this.isClip = true;
    this.v = document.createElement('video');
    this.v.className = 'direct-video';
    this.v.playsInline = true;
    this.v.autoplay = true;
    this.v.setAttribute('tabindex', '-1');
    host.replaceChildren(this.v);
    this.qualities = [];
    this.quality = 'auto';
    this.capHeight = null;
    this.current = null;
    for (const [ev, name] of [['playing', EVENTS.PLAYING], ['pause', EVENTS.PAUSE], ['ended', EVENTS.ENDED]]) this.v.addEventListener(ev, () => this.emit(name));
    this.v.addEventListener('loadedmetadata', () => this.emit(EVENTS.READY));
    this.v.addEventListener('error', () => { if (this.v.getAttribute('src')) this.emit('error', this.v.error ? this.v.error.code : 0); });
  }

  /** qualities: clipQualities(); startAt: seconds. */
  load({ qualities, startAt = 0 }) {
    this.qualities = qualities;
    this.apply({ startAt, play: true });
  }

  apply({ startAt = null, play = null } = {}) {
    const pick = pickClipQuality(this.qualities, { chosen: this.quality, preferred: this.opts.preferred ? this.opts.preferred() : 'auto', capHeight: this.capHeight });
    if (!pick || (this.current && this.current.url === pick.url)) return;
    const t = startAt != null ? startAt : this.v.currentTime;
    const resume = play != null ? play : !this.v.paused;
    this.current = pick;
    if (this.opts.log) this.opts.log(`[clip] ${pick.name}${this.capHeight ? ` (cap ${this.capHeight}p)` : ''}`);
    this.v.src = pick.url;
    if (t > 0) this.v.addEventListener('loadedmetadata', () => { this.v.currentTime = t; }, { once: true });
    if (resume) this.play();
  }

  setBackgroundCap(maxHeight) {
    const cap = maxHeight || null;
    if (cap === this.capHeight) return;
    this.capHeight = cap;
    this.apply();
  }

  latency() { return null; }
  getDuration() { const d = this.v.duration; return Number.isFinite(d) && d > 0 ? d : 0; }
  getBuffered() { const b = this.v.buffered; const out = []; for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]); return out; }
  seek(t) { const d = this.getDuration(); this.v.currentTime = Math.max(0, d ? Math.min(t, Math.max(0, d - 0.25)) : t); }
  play() { const p = this.v.play(); if (p && p.catch) p.catch((e) => this.opts.log && this.opts.log(`[clip] play() rejected: ${e.name}`)); }
  pause() { this.v.pause(); }
  isPaused() { return this.v.paused; }
  setMuted(m) { this.v.muted = !!m; }
  getMuted() { return this.v.muted; }
  setVolume(v) { this.v.volume = Math.min(1, Math.max(0, v)); }
  getVolume() { return this.v.volume; }
  getCurrentTime() { return this.v.currentTime; }
  getEnded() { return this.v.ended; }
  getQualities() { return [{ group: 'auto', name: 'Auto' }, ...this.qualities.map((q) => ({ group: q.group, name: q.name }))]; }
  getQuality() { return this.quality; }
  setQuality(group) { this.quality = group || 'auto'; this.apply(); }
  /** The quality playing now (for the label when Auto). */
  playingName() { return this.current ? this.current.name : null; }
  destroy() { this.v.removeAttribute('src'); this.v.load(); this.host.replaceChildren(); }
}

/** Twitch's clip embed in an iframe: no API, so pause, seek and quality aren't available; ENDED fires after the clip's length. */
export class ClipEmbed extends Emitter {
  constructor(host, { slug, duration = 30, muted = false, now = () => performance.now() } = {}) {
    super();
    this.host = host;
    this.isDirect = false;
    this.isClip = true;
    this.duration = Number(duration) || 30;
    this.now = now;
    this.frame = document.createElement('iframe');
    this.frame.className = 'clip-embed';
    this.frame.setAttribute('allow', 'autoplay; fullscreen');
    this.frame.setAttribute('tabindex', '-1');
    this.frame.src = clipEmbedUrl(slug, { muted });
    host.replaceChildren(this.frame);
    this.started = now();
    this.frame.addEventListener('load', () => { this.started = now(); this.emit(EVENTS.READY); this.emit(EVENTS.PLAYING); });
    // The embed has no events: its end is the clip's length (plus a little for the embed's own start-up).
    this.endTimer = setTimeout(() => this.emit(EVENTS.ENDED), (this.duration + 3) * 1000);
  }
  latency() { return null; }
  getDuration() { return 0; } // no seek bar
  getBuffered() { return []; }
  seek() {}
  play() {}
  pause() {}
  isPaused() { return false; }
  setMuted() {}
  getMuted() { return false; }
  setVolume() {}
  getVolume() { return 1; }
  getCurrentTime() { return Math.max(0, (this.now() - this.started) / 1000); }
  getQualities() { return []; }
  getQuality() { return 'auto'; }
  setQuality() {}
  setBackgroundCap() {}
  destroy() { clearTimeout(this.endTimer); this.host.replaceChildren(); }
}
