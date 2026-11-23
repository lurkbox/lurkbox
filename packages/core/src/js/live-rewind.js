// Live rewind for one live stream on a DirectEngine (a multi-view tile; always the direct engine): the seek model (seconds since the stream
// started; the right end is the live edge), seeking inside the live window or into the stream's archive VOD, and
// back to live. The rules are the pure helpers in seek.js, shared with the single player.
import { fmtTime, matchArchive, rewindGeometry, rewindTarget, parseHelixDuration } from './seek.js';
import { helix, tw } from './api.js';
import { state } from './state.js';
import { toast } from './ui.js';

const num = (f) => { try { const v = f(); return typeof v === 'number' && Number.isFinite(v) ? v : 0; } catch { return 0; } };

export class LiveRewind {
  /**
   * @param {object} o
   * @param {() => any} o.engine the tile's DirectEngine (or null)
   * @param {() => any} o.channel the tile's channel { login, userId, stream }
   * @param {(msg: string) => void} [o.log]
   * @param {() => void} [o.onChange] the rewind state changed (re-render)
   */
  constructor({ engine, channel, log = () => {}, onChange = () => {} }) {
    Object.assign(this, { engine, channel, log, onChange });
    this.reset();
  }

  reset() {
    this.rewind = null; // { id } while the tile plays the archive VOD
    this.archive = undefined; // undefined = not looked up, false = none
    this.archiveFor = null;
    this.noRewindToast = false;
  }

  get rewound() { return !!this.rewind; }

  geo(nowSec = Date.now() / 1000) {
    const ch = this.channel();
    const a = this.archive;
    if (!a || !ch || !ch.stream) return null;
    const e = this.engine();
    const engineDur = this.rewind && e ? num(() => e.getDuration()) : 0;
    const helixDur = parseHelixDuration(a.duration);
    const available = Math.max(engineDur, Number.isFinite(helixDur) ? helixDur : 0);
    return rewindGeometry({ nowSec, streamStartSec: Date.parse(ch.stream.started_at) / 1000, vodStartSec: Date.parse(a.created_at) / 1000, available });
  }

  /** The seek bar's model (see seekbar.js), or null (no engine, no start time). */
  model() {
    const e = this.engine();
    const ch = this.channel();
    if (!e || !ch || !ch.stream || !ch.stream.started_at) return null;
    const nowSec = Date.now() / 1000;
    const startSec = Date.parse(ch.stream.started_at) / 1000;
    if (!Number.isFinite(startSec)) return null;
    const uptime = Math.max(1, nowSec - startSec);
    let pos;
    let min;
    let buffered;
    let note = '';
    const g = this.archive ? this.geo(nowSec) : null;
    if (this.rewind && g) {
      pos = uptime - g.offsetOf(num(() => e.getCurrentTime()));
      min = Math.max(0, uptime - g.maxOffset);
      buffered = e.getBuffered().map(([a, b]) => [uptime - g.offsetOf(a), uptime - g.offsetOf(b)]);
    } else {
      const w = e.liveWindow();
      const sync = Number.isFinite(w.liveSync) ? w.liveSync : num(() => e.getCurrentTime());
      const win = Number.isFinite(w.windowStart) ? Math.max(0, sync - w.windowStart) : 20;
      pos = uptime - (num(() => e.latency()) || 0);
      min = this.archive === false ? Math.max(0, uptime - win) : 0;
      buffered = e.getBuffered().map(([a, b]) => [uptime - (sync - a), uptime - (sync - b)]);
      if (this.archive === false) note = 'not saved: no rewind';
    }
    return {
      min, max: uptime, pos: Math.min(uptime, Math.max(min, pos)), buffered,
      label: (t) => { const off = uptime - t; return off < 3 ? 'LIVE' : `−${fmtTime(off)}`; },
      total: `uptime ${fmtTime(uptime)}`, note, thumb: null,
    };
  }

  /** The stream's archive VOD, looked up once per stream (Helix signed in, Twitch's web GQL signed out). */
  async ensureArchive() {
    const ch = this.channel();
    if (!ch) return null;
    if (!ch.stream && state.auth.signedIn) { try { ch.stream = await tw.streamByLogin(ch.login); } catch { /* below */ } }
    const s = ch.stream;
    if (!s || !s.id) return null;
    if (this.archiveFor === s.id && this.archive !== undefined) return this.archive || null;
    let found = null;
    try {
      if (state.auth.signedIn) {
        const r = await helix('/videos', { user_id: ch.userId || s.user_id, type: 'archive', first: 5 });
        found = matchArchive(s, r.data || []);
      } else if (window.lurkbox.liveInfo) {
        const info = await window.lurkbox.liveInfo(ch.login);
        found = info && info.stream && String(info.stream.id) === String(s.id) ? info.archive : null;
      }
    } catch (e) {
      this.log(`archive lookup failed: ${e.message}`);
      return null;
    }
    if (ch !== this.channel()) return null;
    this.archiveFor = s.id;
    this.archive = found || false;
    return found;
  }

  /** Seek to t (seconds since the stream started): inside the live window, or into the archive VOD. */
  async seekTo(t) {
    const ch = this.channel();
    const e = this.engine();
    if (!ch || !e || !ch.stream) return;
    const uptime = Date.now() / 1000 - Date.parse(ch.stream.started_at) / 1000;
    const offset = Math.max(0, uptime - t);
    let win = 20;
    let w = null;
    if (!this.rewind) {
      w = e.liveWindow();
      if (Number.isFinite(w.windowStart) && Number.isFinite(w.liveSync)) win = Math.max(4, w.liveSync - w.windowStart - 2);
    }
    if (offset <= win) {
      if (this.rewind) { this.goLive(); return; }
      if (offset < 3) { e.jumpToLive(); return; }
      e.v.currentTime = Math.max(w.windowStart, w.liveSync - offset);
      return;
    }
    const archive = await this.ensureArchive();
    if (ch !== this.channel() || this.engine() !== e) return;
    const target = rewindTarget({ offset, liveWindow: win, archive, geometry: archive ? this.geo() : null });
    if (target.mode === 'none') {
      if (!this.noRewindToast) { this.noRewindToast = true; toast("This channel doesn't save broadcasts, so you can't rewind.", 4000); }
      if (!this.rewind && w && Number.isFinite(w.windowStart)) e.v.currentTime = Math.max(w.windowStart, w.liveSync - target.offset);
      this.onChange();
      return;
    }
    if (target.mode === 'live') { if (this.rewind) this.goLive(); return; }
    if (target.clamped) toast(`The saved broadcast reaches −${fmtTime(target.offset)} for now`, 2500);
    if (this.rewind && this.rewind.id === archive.id) e.seek(target.position);
    else {
      this.log(`live rewind: ${ch.login} -> archive ${archive.id} at ${fmtTime(target.position)}`);
      this.rewind = { id: archive.id };
      e.load({ video: archive.id, startAt: target.position });
    }
    this.onChange();
  }

  /** Back from the archive VOD to the live stream (or to the live edge). */
  goLive() {
    const e = this.engine();
    const ch = this.channel();
    if (!e || !ch) return;
    if (!this.rewind) { e.jumpToLive(); toast('Jumped to live', 1500); return; }
    this.rewind = null;
    e.load({ channel: ch.login });
    toast('Back to live', 1800);
    this.onChange();
  }
}
