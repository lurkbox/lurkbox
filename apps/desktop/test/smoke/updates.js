'use strict';
// Update notifications smoke test, offline, in demo mode with a newer release (LURKBOX_DEMO=1 LURKBOX_DEMO_UPDATE=1:
// the demo's GitHub answers from memory, no network): the one-time "is available" toast after start; Settings → About
// shows it with Download; A on Download fetches the AppImage behind a redirect, checks it against SHA256SUMS.txt and
// replaces the demo's "running AppImage" file; "Restart to update" asks for the restart (the demo only logs it); the
// toast shows once per version; "Check for updates" off is saved. LURKBOX_SHOT_DIR=<dir> saves update-*.png.
// Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-update-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true }));
Object.assign(process.env, { TZ: 'UTC', LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: '1280x800', LURKBOX_DEMO_UPDATE: '1' });
if (!process.argv.includes('--windowed')) process.argv.push('--windowed');

const { app } = require('electron');
const SHOTS = process.env.LURKBOX_SHOT_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let finished = false;
function finish(code, msg) {
  if (finished) return;
  finished = true;
  let blocked = [];
  try { blocked = fs.readFileSync(path.join(userData, 'demo-blocked.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
  const EMBED = /player\.twitch\.tv\/js\/embed|clips\.twitch\.tv\/embed/; // no demo video (ffmpeg missing): the player tried the embed
  if (blocked.some((l) => EMBED.test(l))) console.log('[update] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[update] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[update] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[update] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => finish(1, 'timed out'), 120000).unref();

// A virtual standard gamepad (the same as the screenshot scenes), so presses take Lurkbox's real input path.
const PAD = `(() => {
  if (window.__pad) return true;
  const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__pad = { async press(a) { const b = pad.buttons[BUTTON[a]]; b.pressed = true; b.value = 1; pad.timestamp++; await wait(70); b.pressed = false; b.value = 0; pad.timestamp++; await wait(110); return true; } };
  return true;
})()`;

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message.slice(0, 300)); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (what, code, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`waiting for ${what} timed out`);
      await sleep(150);
    }
  };
  const press = async (...keys) => { for (const k of keys) await js(`__pad.press(${JSON.stringify(k)})`); };
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `update-${name}.png`), (await wc.capturePage()).toPNG()); };
  const tab = () => js("document.querySelector('.channel-body') && document.querySelector('.channel-body').dataset.tab");
  const focusKey = () => js('document.activeElement && document.activeElement.dataset.focusKey');
  const log = (m) => console.log(`[update] ${m}`);

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5");
      const version = await js('window.lurkbox.updateState().then((s) => s.current)');
      const m = /^(\d+)\.(\d+)\./.exec(version);
      const next = `${m[1]}.${Number(m[2]) + 1}.0`;
      // The toast, once, a moment after start.
      await waitFor('the update toast', `[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('Lurkbox v${next} is available'))`, 20000);
      await waitFor('updateNotified saved', `window.lurkbox.getSettings().then((s) => s.updateNotified === '${next}')`);
      await shot('toast');
      log(`toast for v${next} (running ${version})`);

      await js("window.__lurkbox.nav.goTop('settings'); true");
      await waitFor('Settings → About', "!!document.querySelector('#settings-about') && !!document.querySelector('[data-setting=\"update-download\"]')");
      const text = await js("document.querySelector('.update-status').textContent");
      if (!text.includes(`v${next} is available`)) throw new Error(`About says: ${text}`);
      // Download with the controller: focus it, A.
      await js("document.querySelector('[data-setting=\"update-download\"]').focus(); true");
      await press('A');
      await waitFor('Restart to update', "!!document.querySelector('[data-setting=\"update-install\"]')", 20000);
      if (!(await js("document.activeElement && document.activeElement.dataset.setting === 'update-install'"))) throw new Error('the focus did not move to Restart to update');
      const file = fs.readFileSync(path.join(userData, 'Lurkbox-demo.AppImage'), 'utf8');
      if (!file.includes(`Lurkbox ${next} (demo)`)) throw new Error(`the AppImage was not replaced: ${file.slice(0, 60)}`);
      if ((fs.statSync(path.join(userData, 'Lurkbox-demo.AppImage')).mode & 0o111) === 0) throw new Error('the new AppImage is not executable');
      if (fs.readdirSync(userData).some((n) => n.includes('.update-'))) throw new Error('a temporary download stayed behind');
      await shot('ready');
      await press('A');
      await sleep(400);
      const logText = fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8');
      if (!/\[demo\] the update would restart Lurkbox now/.test(logText)) throw new Error('Restart to update did not ask for the restart');
      if (!/sha256 ok/.test(logText)) throw new Error('no checksum line in the log');
      log('downloaded behind a redirect, checksum ok, replaced, restart asked');

      // The toast is once per version: a fresh state for the same version doesn't show it again.
      const toasts = await js("[...document.querySelectorAll('#toasts .update-toast')].length");
      await js('window.lurkbox.updateCheck()');
      await sleep(500);
      if ((await js("[...document.querySelectorAll('#toasts .update-toast')].length")) > toasts) throw new Error('the toast showed twice');

      // "Check for updates" off is saved.
      await js("document.querySelector('[data-setting=\"checkUpdates\"]').focus(); true");
      await press('A');
      await waitFor('checkUpdates off', 'window.lurkbox.getSettings().then((s) => s.checkUpdates === false)');
      finish(0, `toast for v${next}, Settings → About, Download (redirect, SHA-256) replaced the AppImage, Restart to update, once per version, the setting`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
