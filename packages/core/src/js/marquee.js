// Scrolls text that doesn't fit (stream titles, names, game names) on the focused card, like TV apps do.
// It uses an animated text-indent, so no extra DOM is needed. The lines inside the focused element are measured on
// focus, and again after a grid refresh rewrites them.
const LINES = '.card-title, .card-sub, .card-meta, .marquee-line';
const SPEED_PX_PER_S = 60;

const running = new Map(); // line -> Animation (inside the focused element)
const pinned = new Map(); // line -> Animation (scrolls without focus: the player overlay's title)

function start(line, into = running) {
  const overflow = line.scrollWidth - line.clientWidth;
  if (overflow <= 2) return;
  const dist = overflow + 16;
  const duration = Math.max(3, dist / SPEED_PX_PER_S + 2.4) * 1000;
  line.classList.add('marquee-on');
  // Web Animations API, not CSS keyframes: keyframes that read a per-element custom property didn't move in Chromium.
  const anim = line.animate([
    { textIndent: '0px', offset: 0 },
    { textIndent: '0px', offset: 0.15 },
    { textIndent: `-${dist}px`, offset: 0.85 },
    { textIndent: `-${dist}px`, offset: 1 },
  ], { duration, iterations: Infinity, direction: 'alternate', easing: 'linear' });
  into.set(line, anim);
}

/**
 * Scrolls `line` (a .marquee-line) whether or not anything around it has focus, e.g. the stream title on the player
 * overlay; call again after its text changes. Lines that fit don't move. stopMarqueeLine() ends it.
 */
export function marqueeLine(line) {
  stopMarqueeLine(line);
  if (line && line.isConnected) start(line, pinned);
}

export function stopMarqueeLine(line) {
  const a = pinned.get(line);
  if (!a) return;
  a.cancel();
  line.classList.remove('marquee-on');
  pinned.delete(line);
}

function stop(root) {
  for (const [line, anim] of running) {
    if (root === document || root.contains(line) || !line.isConnected) {
      anim.cancel();
      line.classList.remove('marquee-on');
      running.delete(line);
    }
  }
}

/** (Re)start scrolling inside the element that has focus. */
export function refreshMarquee() {
  const f = document.activeElement;
  if (!f || f === document.body) return;
  stop(document);
  for (const line of f.querySelectorAll(LINES)) if (!pinned.has(line)) start(line);
}

export function installMarquee() {
  // The OS "reduce motion" hint isn't reliable under Game Mode, and scrolling text is how you read long titles, so it
  // isn't tied to it. Log the hint once so we can see what the device reports.
  try { window.lurkbox && window.lurkbox.log && window.lurkbox.log(`[ui] prefers-reduced-motion=${matchMedia('(prefers-reduced-motion: reduce)').matches}`); } catch { /* ignore */ }
  document.addEventListener('focusin', () => { setTimeout(refreshMarquee, 60); }, true);
  document.addEventListener('focusout', (e) => { if (e.target && e.target.querySelectorAll) stop(e.target); }, true);
}
