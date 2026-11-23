'use strict';
// Preload for the twitch.tv login window: reads the controller and sends each press to the main process, which runs
// the shared controller navigation (packages/core/src/shared/frame-nav.js, injected into the page) and opens Steam's keyboard when A
// lands on a text box. Sandboxed: no page access from here, no field values or cookies.
const { ipcRenderer } = require('electron');

const held = new Map();
function poll() {
  const now = new Set();
  for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (!gp) continue;
    const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    if (b(12) || ay < -0.6) now.add('up');
    if (b(13) || ay > 0.6) now.add('down');
    if (b(14) || ax < -0.6) now.add('left');
    if (b(15) || ax > 0.6) now.add('right');
    if (b(0)) now.add('a');
    if (b(1)) now.add('b');
  }
  const t = performance.now();
  for (const k of now) {
    const h = held.get(k);
    const dirKey = k === 'up' || k === 'down' || k === 'left' || k === 'right';
    if (!h) { held.set(k, { since: t, last: t }); ipcRenderer.send('player-login:pad', k); }
    else if (dirKey && t - h.since > 400 && t - h.last > 120) { h.last = t; ipcRenderer.send('player-login:pad', k); }
  }
  for (const k of [...held.keys()]) if (!now.has(k)) held.delete(k);
}
setInterval(poll, 30);
