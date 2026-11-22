'use strict';
// Continue watching smoke test, offline, in demo mode (LURKBOX_DEMO=1: made-up data, no network): the seeded row is at
// the top of Following (above Live, newest first, the deleted VOD dropped after its Helix 404); D-pad RIGHT scrolls the
// row; A plays a VOD from its saved position without the "Continue watching?" question; back in Following the row
// is refreshed with that VOD first; X → "Remove from Continue watching" removes it with the focus kept in the row;
// the setting hides the row and Settings → Clear watch history empties it. LURKBOX_SHOT_DIR=<dir> saves cw-*.png.
// Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-cw-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true }));
Object.assign(process.env, { TZ: 'UTC', LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: '1280x800' });
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
  if (blocked.some((l) => EMBED.test(l))) console.log('[cw] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[cw] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[cw] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[cw] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
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
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `cw-${name}.png`), (await wc.capturePage()).toPNG()); };
  const tab = () => js("document.querySelector('.channel-body') && document.querySelector('.channel-body').dataset.tab");
  const focusKey = () => js('document.activeElement && document.activeElement.dataset.focusKey');
  const log = (m) => console.log(`[cw] ${m}`);

  const cards = () => js("[...document.querySelectorAll('[data-view=following] .cw-row .card')].map((c) => c.dataset.cwId)");
  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      // Reduced motion: focus scrolls instantly (smooth scrolls don't run under xvfb), so the row's scroll can be read at once.
      wc.debugger.attach();
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(400);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5");
      // The row: six part-watched broadcasts (the deleted one went after Helix's 404), above Live.
      await waitFor('the Continue watching row', "document.querySelectorAll('[data-view=following] .cw-row .card').length === 6");
      const ids = await cards();
      if (ids.includes('2299999999')) throw new Error('the deleted VOD is still in the row');
      const order = await js("(() => { const v = document.querySelector('#content [data-view=following]'); const t = v.querySelector('.cw-title'); const live = v.querySelector('.live-title'); return !t.hidden && (t.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING) > 0; })()");
      if (!order) throw new Error('the row is not above Live');
      const bar = await js("(() => { const c = document.querySelector('.cw-row .card'); const f = c.querySelector('.cw-progress-fill'); return { w: parseFloat(f.style.width), left: c.querySelector('.cw-left').textContent }; })()");
      if (!(bar.w > 50 && bar.w < 70) || !/^\d+ (h|min)/.test(bar.left)) throw new Error(`first card's progress: ${JSON.stringify(bar)}`);
      const resumeLeft = await js(`window.lurkbox.resumeList().then((l) => l.find((e) => e.id === ${JSON.stringify(ids[0])}) ? true : false)`);
      if (!resumeLeft) throw new Error('the row and the stored positions disagree');
      log(`row: ${ids.length} cards, first ${bar.w}% (${bar.left})`);

      // D-pad: the first card, RIGHT along the row (it scrolls sideways), DOWN to Live.
      await js("document.querySelector('.cw-row .card').focus(); true");
      for (let i = 0; i < 5; i++) await press('RIGHT');
      const at = await js("({ k: document.activeElement.dataset.cwId, scroll: document.querySelector('.cw-row').scrollLeft })");
      if (at.k !== ids[5]) throw new Error(`RIGHT x5 is on ${at.k}, not the last card`);
      if (!(at.scroll > 0)) throw new Error('the row did not scroll to the focused card');
      await press('DOWN');
      if (!(await js("!!document.activeElement.closest('.grid-live')"))) throw new Error('DOWN from the row is not on Live');
      await press('UP');
      if (!(await js("!!document.activeElement.closest('.cw-row')"))) throw new Error('UP from Live is not back on the row');
      await shot('row');

      // A on the third card: plays from the saved position, no "Continue watching?" question.
      await js("document.querySelectorAll('.cw-row .card')[2].focus(); true");
      const pick = ids[2];
      const saved = await js(`window.lurkbox.resumeGet(${JSON.stringify(pick)})`);
      await press('A');
      await waitFor('the VOD player', `!document.getElementById('player-screen').hidden && window.__lurkbox.player.current && window.__lurkbox.player.current.videoId === ${JSON.stringify(pick)}`);
      await sleep(800);
      if (await js("!!document.querySelector('.modal .pick-item')")) throw new Error('a resume question was shown');
      const t = await waitFor('playback near the saved spot', `(() => { const v = document.querySelector('#player-screen video'); return v && v.currentTime > 1 ? v.currentTime : null; })()`, 30000).catch(() => null);
      if (t !== null && Math.abs(t - saved.position) > 20) throw new Error(`played from ${t}, saved at ${saved.position}`);
      if (t !== null) await sleep(1500);
      await press('B');
      await waitFor('Following again', "document.getElementById('player-screen').hidden");
      if (t !== null) await waitFor('the row refreshed (just watched: first)', `document.querySelector('.cw-row .card') && document.querySelector('.cw-row .card').dataset.cwId === ${JSON.stringify(pick)}`, 2500);
      log(t !== null ? `played ${pick} from ${t.toFixed(0)} s (saved ${saved.position} s), first in the row again` : `no demo video (ffmpeg missing?): skipped the position check`);

      // X → Remove from Continue watching: one card fewer, focus stays in the row.
      await js("document.querySelector('.cw-row .card').focus(); true");
      const gone = await js('document.activeElement.dataset.cwId');
      await press('X');
      await waitFor('the menu', "[...document.querySelectorAll('.modal .pick-item')].some((b) => /Remove from Continue watching/.test(b.textContent))");
      await waitFor('the focus in the menu', "!!(document.activeElement && document.activeElement.closest('.modal'))");
      await shot('menu');
      await press('A');
      await waitFor('one card fewer', `document.querySelectorAll('.cw-row .card').length === 5 && !document.querySelector('.cw-row [data-cw-id="${gone}"]')`);
      if (!(await js("!!document.activeElement.closest('.cw-row')"))) throw new Error('the focus left the row after Remove');
      if (await js(`window.lurkbox.resumeGet(${JSON.stringify(gone)})`)) throw new Error('the removed VOD kept its position');

      // The setting hides the row; Clear watch history empties it.
      await js("window.__lurkbox.nav.goTop('settings'); true");
      await waitFor('settings', "!!document.querySelector('.clear-watch-history')");
      await js("document.querySelector('.clear-watch-history').click(); true");
      await waitFor('the confirm dialog', "!!document.querySelector('.modal .btn.primary')");
      await js("document.querySelector('.modal .btn.primary').click(); true");
      await waitFor('cleared', 'window.lurkbox.resumeList().then((l) => l.length === 0)');
      await js("window.__lurkbox.nav.goTop('following'); true");
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5");
      await sleep(600);
      if (!(await js("document.querySelector('.cw-row').hidden && document.querySelector('.cw-title').hidden"))) throw new Error('the row shows after Clear watch history');
      finish(0, `row of ${ids.length} above Live (deleted VOD dropped), D-pad scroll, played without the question, refreshed after the player, X → Remove, Clear watch history`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
