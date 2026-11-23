'use strict';
// Multi-view smoke test, offline, in demo mode (LURKBOX_DEMO=1: made-up data, no network): X on a live card →
// "Watch with…" → a followed channel opens two tiles side by side, only the active tile has sound and the normal
// quality (the other is capped at 480p), the D-pad moves the sound, A's tile menu adds a third (one big plus two)
// and X a fourth (2x2), the layout button cycles, B leaves for the single player on the active stream.
// LURKBOX_SHOT_DIR=<dir> saves multiview-2.png and multiview.png (the README's). Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-mv-'));
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
  if (blocked.some((l) => EMBED.test(l))) console.log('[mv] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[mv] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[mv] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[mv] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
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
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage()).toPNG()); };
  const log = (m) => console.log(`[mv] ${m}`);
  const pick = async (re) => {
    await waitFor(`a list item ${re}`, `[...document.querySelectorAll('.modal .pick-item')].some((b) => ${re}.test(b.textContent))`, 8000);
    await js(`[...document.querySelectorAll('.modal .pick-item')].find((b) => ${re}.test(b.textContent)).focus(); true`);
    await press('A');
  };
  const tiles = () => js("[...document.querySelectorAll('#multi-stage .mv-tile')].map((n) => ({ login: n.dataset.login, active: n.classList.contains('active'), muted: n.querySelector('video') ? n.querySelector('video').muted : null, r: [n.style.left, n.style.top, n.style.width, n.style.height].join(' ') }))");
  const caps = () => js('__lurkbox.multi.tiles.map((t) => t.engine ? t.engine.capHeight : "none")');
  const playing = (n) => waitFor(`${n} tiles playing`, `[...document.querySelectorAll('#multi-stage video')].filter((v) => v.currentTime > 0.3).length >= ${n}`, 40000).then(() => true, () => false);

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await sleep(400);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5");
      await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
      const first = await js('document.activeElement.dataset.channelLogin');
      // X on a live card: Channel page or Watch with…
      await press('X');
      await pick('/Watch with/');
      await pick('/./');
      await waitFor('multi-view', "!document.getElementById('multi-screen').hidden && document.querySelectorAll('#multi-stage .mv-tile').length === 2");
      let t = await tiles();
      if (t[0].login !== first || !t[0].active) throw new Error(`the card's channel is not the active first tile: ${JSON.stringify(t)}`);
      if (!/^0% 0% 50% 100%$/.test(t[0].r) || !/^50% 0% 50% 100%$/.test(t[1].r)) throw new Error(`not side by side: ${t.map((x) => x.r)}`);
      const two = await playing(2);
      t = await tiles();
      if (t[0].muted !== false || t[1].muted !== true) throw new Error(`audio: ${JSON.stringify(t.map((x) => x.muted))}`);
      let c = await caps();
      if (c[0] !== null || c[1] !== 480) throw new Error(`quality caps ${JSON.stringify(c)} (want null, 480)`);
      log(`2 tiles ${two ? 'playing' : '(no demo video)'}: ${t.map((x) => x.login).join(', ')}`);
      await shot('multiview-2');

      // RIGHT: the sound and the normal quality move to the other tile.
      await press('RIGHT');
      t = await tiles();
      if (!t[1].active || t[1].muted !== false || t[0].muted !== true) throw new Error(`RIGHT did not move the sound: ${JSON.stringify(t)}`);
      c = await caps();
      if (c[0] !== 480 || c[1] !== null) throw new Error(`caps after RIGHT ${JSON.stringify(c)}`);

      // A: the tile menu → Add stream… → three tiles (one big plus two small, the new one active).
      await press('A');
      await pick('/Add stream/');
      await pick('/./');
      await waitFor('three tiles', "document.querySelectorAll('#multi-stage .mv-tile').length === 3");
      t = await tiles();
      if (!t[2].active || !/^0% 0% 66\.6+\d*% 100%$/.test(t[0].r)) throw new Error(`3 tiles: ${JSON.stringify(t)}`);
      // X: a fourth → 2x2.
      await press('X');
      await pick('/./');
      await waitFor('four tiles', "document.querySelectorAll('#multi-stage .mv-tile').length === 4");
      t = await tiles();
      if (t.some((x) => !/50% 50%$/.test(x.r)) || !t[3].active) throw new Error(`not a 2x2 grid: ${JSON.stringify(t)}`);
      if (t.filter((x) => x.muted === false).length > 1) throw new Error('more than one tile has sound');
      await press('UP');
      t = await tiles();
      if (!t[1].active) throw new Error('UP from the bottom right is not the top right');
      const four = await playing(4);
      log(`4 tiles ${four ? 'playing' : '(no demo video)'}`);
      await sleep(600);
      await shot('multiview');
      // Y cycles the layout (grid → one big), and back.
      await press('Y');
      if (await js("document.getElementById('multi-screen').dataset.layout") !== 'big') throw new Error('Y did not switch the layout');
      await press('Y');
      // B: the single player on the active stream.
      const want = t[1].login;
      await press('B');
      await waitFor('the single player', `document.getElementById('multi-screen').hidden && !document.getElementById('player-screen').hidden && __lurkbox.player.current && __lurkbox.player.current.login === ${JSON.stringify(want)}`);
      if (await js("document.querySelectorAll('#multi-stage video').length")) throw new Error('multi-view videos left behind');
      await press('B');
      await waitFor('Following again', "document.getElementById('player-screen').hidden && !!document.activeElement.closest('[data-view=following]')", 5000);
      finish(0, 'X → Watch with…, 2 and 4 tiles, audio and caps follow the active tile, layouts, B to the single player');
    } catch (e) {
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
