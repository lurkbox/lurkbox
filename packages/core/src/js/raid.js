// Raid countdown state machine (no DOM). The player renders it.
export class RaidCountdown {
  /**
   * @param {{onShow?: (state) => void, onTick?: (secondsLeft) => void, onFollow: (ev) => void, onEnd?: (reason) => void}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.ev = null;
    this.mode = null; // 'countdown' (auto-follow) | 'offer' (raid follow off: A to follow)
    this.deadline = 0;
    this.timer = null;
  }

  get active() { return !!this.ev; }

  secondsLeft() { return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)); }

  /** @param {{follow: boolean, delaySec: number, offerSec?: number}} opts */
  start(ev, { follow, delaySec, offerSec = 20 }) {
    this.clear();
    const delay = Math.max(0, Number(delaySec) || 0);
    if (follow && delay === 0) {
      this.cb.onFollow(ev);
      return 'followed';
    }
    this.ev = ev;
    this.mode = follow ? 'countdown' : 'offer';
    this.deadline = Date.now() + (follow ? delay : offerSec) * 1000;
    if (this.cb.onShow) this.cb.onShow({ ev, mode: this.mode, left: this.secondsLeft() });
    this.timer = setInterval(() => this.tick(), 250);
    return this.mode;
  }

  tick() {
    if (!this.ev) return;
    const left = this.secondsLeft();
    if (left > 0) {
      if (this.cb.onTick) this.cb.onTick(left);
      return;
    }
    const { ev, mode } = this;
    this.clear();
    if (mode === 'countdown') this.cb.onFollow(ev);
    else if (this.cb.onEnd) this.cb.onEnd('expired');
  }

  /** B: stay on the current channel. */
  cancel() {
    if (!this.ev) return false;
    this.clear();
    if (this.cb.onEnd) this.cb.onEnd('cancelled');
    return true;
  }

  /** A: follow right away. */
  followNow() {
    if (!this.ev) return false;
    const ev = this.ev;
    this.clear();
    this.cb.onFollow(ev);
    return true;
  }

  clear() {
    clearInterval(this.timer);
    this.timer = null;
    this.ev = null;
    this.mode = null;
  }
}

/**
 * One RaidCountdown per key (multi-view: per tile), so raids on several tiles count down, follow and cancel on
 * their own. The callbacks get the key first.
 */
export class TileRaids {
  /** @param {{onShow?: (key, state) => void, onTick?: (key, left) => void, onFollow: (key, ev) => void, onEnd?: (key, reason) => void}} cb */
  constructor(cb) {
    this.cb = cb;
    this.map = new Map(); // key -> RaidCountdown
  }

  start(key, ev, opts) {
    this.clear(key);
    const rc = new RaidCountdown({
      onShow: (s) => { if (this.cb.onShow) this.cb.onShow(key, s); },
      onTick: (left) => { if (this.cb.onTick) this.cb.onTick(key, left); },
      onFollow: (e) => { this.map.delete(key); this.cb.onFollow(key, e); },
      onEnd: (reason) => { this.map.delete(key); if (this.cb.onEnd) this.cb.onEnd(key, reason); },
    });
    this.map.set(key, rc);
    const mode = rc.start(ev, opts);
    if (!rc.active) this.map.delete(key);
    return mode;
  }

  active(key) { const rc = this.map.get(key); return !!(rc && rc.active); }

  get(key) { const rc = this.map.get(key); return rc && rc.active ? { ev: rc.ev, mode: rc.mode, left: rc.secondsLeft() } : null; }

  cancel(key) { const rc = this.map.get(key); return rc ? rc.cancel() : false; }

  followNow(key) { const rc = this.map.get(key); return rc ? rc.followNow() : false; }

  /** Drops a key's countdown without callbacks (its tile closed). */
  clear(key) { const rc = this.map.get(key); if (rc) rc.clear(); this.map.delete(key); }

  clearAll() { for (const k of [...this.map.keys()]) this.clear(k); }
}
