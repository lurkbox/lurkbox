// Drops on Android: the inventory (twitch.tv/drops/inventory) in the in-app twitch.tv window with the controller
// navigation (the core's Drops section opens it: AppInfo.hostPages), and auto-claim on the desktop's schedule with the
// shared DropsClaimer (1 min after start, then every 15 min, never twice within 5 min, backoff after failures) running
// the shared inventory scan in a hidden WebView of the web session (hidden-pages.js, 'drops').
import { INVENTORY_URL, NAV_OPTIONS, DropsClaimer, scanInventory } from '@lurkbox/core/src/shared/drops.js';
import { navSource } from '@lurkbox/core/src/shared/frame-nav.js';

const HINT = 'D-pad: move · OK: select · BACK: close';

/**
 * @param {object} d
 * @param {ReturnType<import('./hidden-pages.js').createHiddenPages>} d.pages
 * @param {ReturnType<import('./web-session.js').createWebSession>} d.web
 * @param {() => object} d.getSettings
 * @param {(name: string, data: object) => void} d.emit   'drops:event'
 * @param {(line: string) => void} d.log
 * @param {object} [d.claimer]   DropsClaimer options for tests (timers, delays)
 */
export function createDrops({ pages, web, getSettings, emit, log, claimer: claimerOpts = {}, scan = scanInventory }) {
  let progress = { checkedAt: null, campaigns: [] };
  let view = null;

  const run = async () => {
    const page = await pages.open('drops', INVENTORY_URL);
    try {
      return await scan({ page: { eval: (src) => page.eval(src, { timeoutMs: 60000 }) }, claim: true });
    } finally { page.close(); }
  };

  const claimer = new DropsClaimer({
    enabled: () => (getSettings() || {}).autoClaimDrops !== false,
    hasSession: async () => (await web.status()).signedIn,
    run,
    onClaim: (name) => emit('drops:event', { type: 'claimed', name }),
    onProgress: (campaigns) => { progress = { checkedAt: Date.now(), campaigns }; },
    log,
    // Node (tests) must not stay alive for the claimer; the WebView's timers have no unref.
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    ...claimerOpts,
  });

  return {
    claimer,
    start: () => claimer.start(),
    /** platform.dropsStatus */
    status: async () => ({ signedIn: (await web.status()).signedIn, lastCheckAt: claimer.lastRunAt, nextCheckAt: claimer.nextAt }),
    /** platform.dropsOpen: the inventory in the twitch.tv window ({ type: 'closed' } when the user leaves it). */
    open: async () => {
      if (!(await web.status()).signedIn) return { ok: false, reason: 'not signed in to twitch.tv' };
      if (view) return { ok: true };
      const win = web.openWindow({ script: navSource({ ...NAV_OPTIONS, hint: HINT }) });
      view = win;
      win.closed.then(() => { if (view === win) view = null; emit('drops:event', { type: 'closed' }); });
      win.load(INVENTORY_URL);
      return { ok: true };
    },
    /** The remote drives the window natively. */
    pad: async () => 'close',
    close: async () => { const win = view; view = null; if (win) win.close(); return true; },
    progress: async () => progress,
    /** The active account signed out: forget its campaigns and close its inventory window. */
    reset: () => { progress = { checkedAt: null, campaigns: [] }; const win = view; view = null; if (win) win.close(); },
  };
}
