// Small, pure state machines for window focus and the back/exit behaviour (unit-tested).

/**
 * "Video only" while Lurkbox is unfocused: after `delay` ms of blur, hide the
 * player chrome; restore on focus. Inert until a focus/blur was ever reported,
 * so a compositor that never reports focus can't hide things wrongly.
 */
export class UnfocusedMode {
  constructor({ delay = 1500, onChange = () => {} } = {}) {
    this.delay = delay;
    this.onChange = onChange;
    this.reported = false;
    this.focused = true;
    this.active = false; // video-only currently applied
    this.enabled = true;
    this.timer = null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.apply(false);
  }

  setFocus(focused) {
    this.reported = true;
    this.focused = !!focused;
    clearTimeout(this.timer);
    if (focused) { this.apply(false); return; }
    this.timer = setTimeout(() => { if (!this.focused && this.enabled) this.apply(true); }, this.delay);
  }

  apply(on) {
    if (!this.reported) on = false;
    if (on === this.active) return;
    this.active = on;
    this.onChange(on);
  }
}

/**
 * What B does: 'modal' | 'raid' | 'overlay' | 'close-player' | 'pop' | 'to-rail' | 'home' | 'exit'.
 */
export function resolveBack({ modalOpen = false, playerActive = false, raidActive = false, overlayOpen = false, stackDepth = 1, inRail = false, currentTop = 'following', home = 'following' }) {
  if (modalOpen) return 'modal';
  if (playerActive) {
    if (raidActive) return 'raid';
    if (overlayOpen) return 'overlay';
    return 'close-player';
  }
  if (stackDepth > 1) return 'pop';
  if (!inRail) return 'to-rail';
  if (currentTop !== home) return 'home';
  return 'exit';
}

/** Runs cleanup tasks but never waits longer than `timeoutMs`, then quits. */
export async function quitWithCleanup(tasks, quit, timeoutMs = 500) {
  const all = Promise.allSettled(tasks.map((t) => Promise.resolve().then(t)));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  quit();
}
