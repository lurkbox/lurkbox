// A start-up timeline for one VOD, logged as a single line when it plays (or is left), so slow starts can be
// diagnosed from lurkbox.log:
//   [vod] 123 open → resume prompt shown 85 ms → answered 2310 ms (resume at 3:25) → master 2650 ms
//     → first level 2905 ms → first frame 3120 ms → PLAYING 3150 ms
export class StartTimeline {
  /** @param {string} id the VOD id; @param {() => number} now a millisecond clock (performance.now) */
  constructor(id, now = () => performance.now()) {
    this.id = String(id);
    this.now = now;
    this.t0 = now();
    this.steps = [];
    this.done = false;
  }

  /** Records a step once (repeats are ignored), with an optional note. Ignored after finish(). */
  mark(step, note = '') {
    if (this.done || this.steps.some((s) => s.step === step)) return;
    this.steps.push({ step, ms: Math.round(this.now() - this.t0), note });
  }

  /** Records the last step and returns the log line; null if already finished. */
  finish(step = 'PLAYING', note = '') {
    if (this.done) return null;
    this.mark(step, note);
    this.done = true;
    return this.line();
  }

  line() {
    const parts = this.steps.map((s) => `${s.step} ${s.ms} ms${s.note ? ` (${s.note})` : ''}`);
    return `[vod] ${this.id} open${parts.length ? ` → ${parts.join(' → ')}` : ''}`;
  }
}
