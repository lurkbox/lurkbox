'use strict';
// Electron smoke test: launches Lurkbox windowed with an empty userData dir,
// waits for the welcome screen, opens the Drops section (a sign-in prompt without a session) and exits 0 (1 on failure or timeout).
// Run with: npm run test:smoke
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const TIMEOUT_MS = 30000;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-smoke-'));
process.env.LURKBOX_USER_DATA = userData;
if (!process.argv.includes('--windowed')) process.argv.push('--windowed');

const errors = [];
const finish = (code, msg) => {
  console.log(`[smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  if (errors.length) console.log(`[smoke] renderer errors:\n  ${errors.join('\n  ')}`);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
};
setTimeout(() => finish(1, `timed out after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS).unref();

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.on('did-finish-load', async () => {
    for (let i = 0; i < 100; i++) {
      const r = await win.webContents.executeJavaScript(`(() => {
        const w = document.querySelector('.welcome .welcome-signin');
        return { welcome: !!w, focused: document.activeElement === w, rail: document.querySelectorAll('#rail .rail-items .rail-item').length };
      })()`).catch(() => null);
      if (r && r.welcome && r.rail === 7) { // Following, Browse, Categories, Search, Whispers, Drops, Settings
        if (errors.length) return finish(1, 'welcome screen rendered, but the renderer logged errors');
        // The Drops section without a twitch.tv session: a sign-in prompt with its button focused.
        await win.webContents.executeJavaScript("window.__lurkbox.nav.goTop('drops'), true");
        let d = null;
        for (let j = 0; j < 50; j++) {
          d = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('.view[data-view="drops"] .drops-signin-btn');
            return { prompt: !!b, focused: document.activeElement === b, frame: !!document.querySelector('.view[data-view="drops"] iframe'),
              rail: !!document.querySelector('#rail [data-view="drops"].current') };
          })()`).catch(() => null);
          if (d && d.prompt && d.focused) break;
          await new Promise((res) => setTimeout(res, 100));
        }
        if (!d || !d.prompt || !d.focused || d.frame || !d.rail) return finish(1, `Drops section without a session: ${JSON.stringify(d)}`);
        if (errors.length) return finish(1, 'Drops section rendered, but the renderer logged errors');
        return finish(0, `welcome screen rendered (sign-in button focused: ${r.focused}); Drops shows the sign-in prompt`);
      }
      await new Promise((res) => setTimeout(res, 200));
    }
    finish(1, 'welcome screen never appeared');
  });
});

require('../../src/main/main.js');
