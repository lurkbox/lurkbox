'use strict';
// The Drops section's frame of Twitch's inventory page, seen from the main process: zoom it for the TV and, while the
// frame has the app's focus ("engaged"), run the shared controller navigation (frame-nav.js) inside it and pass it
// the renderer's presses. Used by main.js (drops:open / drops:pad / drops:close) and by the drops smoke test.
const { ensureNavSource, pressSource, backSource } = require('./frame-nav');
const drops = require('./drops');

/**
 * @param {object} d
 * @param {() => Electron.WebFrameMain[]} d.frames  the inventory frames of Lurkbox's window
 * @param {() => number} d.zoom                     the TV zoom for the page
 * @param {() => void} [d.openKeyboard]             A landed on a text box
 */
function createDropsFrameHost({ frames, zoom, openKeyboard = () => {} }) {
  const host = {
    engaged: false,
    /** Zooms the inventory frame for the TV and, while it has focus, (re)starts the navigation. */
    async prepare() {
      const z = zoom();
      for (const f of frames()) {
        try {
          await f.executeJavaScript(require('@lurkbox/core/src/shared/tv-zoom.js').zoomFrameSource(z));
          if (!host.engaged) continue;
          // Every frame load in the window (Twitch's page keeps loading sub-frames) comes here: a running navigation
          // keeps its focus, only a new page gets one.
          await f.executeJavaScript(ensureNavSource(drops.NAV_OPTIONS));
          // Twitch renders the inventory after load: start on the first target once there is one.
          for (let i = 0; i < 20 && host.engaged; i++) {
            if (await f.executeJavaScript('window.__lbNav ? window.__lbNav.start() : false')) break;
            await new Promise((r) => setTimeout(r, 400));
          }
        } catch { /* frame navigating or gone */ }
      }
    },
    async open() {
      host.engaged = true;
      if (!frames().length) return { ok: false, reason: 'inventory not loaded' };
      host.prepare().catch(() => {});
      return { ok: true };
    },
    /** D-pad/A go to the page; B returns 'back' when it closed a dialog in the page, 'close' when the view should. */
    async pad(key) {
      const k = String(key);
      const src = k === 'b' ? backSource() : pressSource(k);
      const frame = frames()[0];
      if (!src) return null;
      if (!frame) return k === 'b' ? 'close' : null;
      try {
        const r = await frame.executeJavaScript(src, key === 'a');
        if (r === 'keyboard') openKeyboard();
        if (r === 'no-nav') host.prepare().catch(() => {});
        return r === 'text' ? 'back' : r; // B left a text box: stay in the page
      } catch { return k === 'b' ? 'close' : null; }
    },
    async close() {
      host.engaged = false;
      for (const f of frames()) await f.executeJavaScript('window.__lbNav ? (window.__lbNav.stop(), true) : false').catch(() => {});
      return true;
    },
  };
  return host;
}

module.exports = { createDropsFrameHost };
