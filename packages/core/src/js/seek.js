// Seeking and scrubbing for VODs and live rewind (pure logic, unit-tested; no DOM).

/** Scrub step (seconds per repeat) for how long a direction has been held: 10 s → 30 s → 1 min → 5 min. */
export function scrubStep(heldMs) {
  if (heldMs < 1200) return 10;
  if (heldMs < 2800) return 30;
  if (heldMs < 4800) return 60;
  return 300;
}

/** Fixed jumps (seconds) for buttons and keys. onBar: the seek bar has focus (LB/RB become ±5 min there). */
export function seekJump(action, { onBar = false } = {}) {
  switch (action) {
    case 'LT': return { delta: -30 };
    case 'RT': return { delta: 30 };
    case 'SHIFT_LEFT': return { delta: -60 };
    case 'SHIFT_RIGHT': return { delta: 60 };
    case 'HOME': return { to: 'start' };
    case 'END': return { to: 'end' };
    case 'LB': return onBar ? { delta: -300 } : null;
    case 'RB': return onBar ? { delta: 300 } : null;
    default: return null;
  }
}

export const clamp = (t, lo, hi) => Math.min(Math.max(t, lo), Math.max(lo, hi));

/** 1:23:45 / 4:05 / 0:07. */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * Hold-to-scrub state. press(dir) on every LEFT/RIGHT event (the first press and each auto-repeat); the target moves
 * by scrubStep(time held). commit fires on release() or after idleMs without a press. Taps are ±10 s.
 */
export class Scrubber {
  constructor({ position, bounds, onPreview = () => {}, onCommit = () => {}, idleMs = 400, now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
    Object.assign(this, { position, bounds, onPreview, onCommit, idleMs, now, setTimer, clearTimer });
    this.active = false;
    this.target = null;
    this.dir = 0;
    this.since = 0;
    this.timer = null;
  }

  press(dir) {
    const t = this.now();
    if (!this.active) { this.active = true; this.target = this.position(); this.dir = 0; }
    if (dir !== this.dir) { this.dir = dir; this.since = t; }
    const [lo, hi] = this.bounds();
    this.target = clamp(this.target + dir * scrubStep(t - this.since), lo, hi);
    this.onPreview(this.target, scrubStep(t - this.since));
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.commit(), this.idleMs);
  }

  /** A fixed jump (LB/RB on the bar, triggers, Shift+arrows): accumulates with other presses, then commits. */
  nudge(delta) { this.setTarget((this.active ? this.target : this.position()) + delta); }

  /** Jump to an absolute target (Home/End), committed after the idle pause like a scrub. */
  setTarget(t) {
    if (!this.active) { this.active = true; this.dir = 0; }
    const [lo, hi] = this.bounds();
    this.target = clamp(t, lo, hi);
    this.onPreview(this.target, 0);
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.commit(), this.idleMs);
  }

  /** Direction released: apply now. */
  release() { if (this.active) this.commit(); }

  commit() {
    this.clearTimer(this.timer);
    this.timer = null;
    if (!this.active) return;
    const t = this.target;
    this.active = false;
    this.dir = 0;
    this.target = null;
    this.onCommit(t);
  }

  cancel() { this.clearTimer(this.timer); this.timer = null; this.active = false; this.target = null; this.dir = 0; }
}

/**
 * Resume prompt for a stored position: 'ask' (offer Resume at ... / Start over) or 'start' (play from 0).
 * Positions in the first 30 s or the last 60 s (or 98 %) are not worth asking about.
 */
export function resumeDecision({ position, duration }) {
  const p = Number(position);
  const d = Number(duration);
  if (!Number.isFinite(p) || p < 30) return 'start';
  if (Number.isFinite(d) && d > 0 && (p > d - 60 || p / d > 0.98)) return 'start';
  return 'ask';
}

/** Storyboard frame for time t: { url, x, y, w, h, sheetW, sheetH } (CSS sprite coordinates), or null. */
export function storyboardFrame(sb, t) {
  if (!sb || !sb.images || !sb.images.length || !(sb.interval > 0) || !(sb.cols > 0) || !(sb.rows > 0)) return null;
  const idx = clamp(Math.floor(Math.max(0, t) / sb.interval), 0, (sb.count || sb.images.length * sb.cols * sb.rows) - 1);
  const per = sb.cols * sb.rows;
  const sheet = Math.min(sb.images.length - 1, Math.floor(idx / per));
  const k = idx - sheet * per;
  return {
    url: sb.images[sheet],
    x: (k % sb.cols) * sb.width,
    y: Math.floor(k / sb.cols) * sb.height,
    w: sb.width,
    h: sb.height,
    sheetW: sb.cols * sb.width,
    sheetH: sb.rows * sb.height,
  };
}

// ---------- live rewind ----------

/** Helix duration "3h2m1s" → seconds. */
export function parseHelixDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(s || ''));
  if (!m || !s) return NaN;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/**
 * The archive VOD of the stream that is live now, or null. Helix /videos?type=archive returns it while the channel is
 * live with "store past broadcasts" on; its stream_id equals the live stream's id.
 */
export function matchArchive(stream, videos) {
  if (!stream || !stream.id || !Array.isArray(videos)) return null;
  return videos.find((v) => v && v.type === 'archive' && String(v.stream_id) === String(stream.id)) || null;
}

/**
 * Live rewind geometry, all in seconds. `uptime` = now − stream start; `offset` = how far behind live (0 = live);
 * the VOD started at vodStart (epoch s) and has `available` seconds in its playlist (it lags live by minutes).
 *   vodPosition(offset) = now − offset − vodStart
 *   offset(vodPosition) = now − vodStart − vodPosition
 */
export function rewindGeometry({ nowSec, streamStartSec, vodStartSec, available, endMargin = 10 }) {
  const uptime = Math.max(0, nowSec - streamStartSec);
  const vodStart = Number.isFinite(vodStartSec) ? vodStartSec : streamStartSec;
  const maxPos = Math.max(0, (Number.isFinite(available) ? available : 0) - endMargin);
  const minOffset = Math.max(0, nowSec - vodStart - maxPos); // the closest to live the archive reaches
  const maxOffset = Math.max(minOffset, nowSec - vodStart);
  return {
    uptime,
    minOffset,
    maxOffset: Math.min(maxOffset, uptime + Math.max(0, streamStartSec - vodStart)),
    vodPosition: (offset) => clamp(nowSec - offset - vodStart, 0, maxPos),
    offsetOf: (pos) => Math.max(0, nowSec - vodStart - pos),
  };
}

/**
 * Where a live scrub to `offset` (seconds behind live) goes:
 *   { mode: 'live', offset }     within the live HLS window (seek in the live stream; 0 = live edge),
 *   { mode: 'vod', position, offset, clamped }  the archive VOD at that position (clamped to what it has),
 *   { mode: 'none', offset }     no archive: stay in the live window.
 */
export function rewindTarget({ offset, liveWindow, archive, geometry }) {
  const o = Math.max(0, offset);
  if (o <= liveWindow) return { mode: 'live', offset: o };
  if (!archive || !geometry) return { mode: 'none', offset: Math.min(o, liveWindow) };
  const target = clamp(o, geometry.minOffset, geometry.maxOffset);
  return { mode: 'vod', position: geometry.vodPosition(target), offset: target, clamped: target !== o };
}
