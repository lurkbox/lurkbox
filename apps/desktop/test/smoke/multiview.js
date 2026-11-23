'use strict';
// Multi-view smoke test, offline, in demo mode (LURKBOX_DEMO=1: made-up data, no network): X on a live card →
// "Watch with…" → the multi-select picker (A ticks, Start confirms) opens two tiles side by side, only the active
// tile has sound and the normal quality (the other is capped at 480p), the D-pad moves the sound, A's tile menu
// adds a third (one big plus two) and X a fourth (2x2), the layout button cycles. Every tile's raids are watched on
// the one EventSub socket: a raid on a non-active tile counts down on that tile and swaps it in place, a raid on
// the active tile is cancelled with B. View/Select opens the active tile's composer and a message goes out in its
// chat. B leaves for the single player on the active stream; the set was saved and "Resume multi-view" in the
// player's More opens it again. LURKBOX_SHOT_DIR=<dir> saves multiview-2.png and multiview.png (the README's comes from `npm run screenshots -- multiview`). Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-mv-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true, raidFollow: true, raidDelay: 2, chatStyle: 'lurkbox' }));
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
  const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
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
      const first = await js("document.querySelector('[data-view=following] .grid-live .card').dataset.channelLogin");
      // X on a live card: Channel page or Watch with… (a Following refresh can take the focus on a slow runner: retry).
      for (let i = 0; i < 5 && !(await js("!!document.querySelector('.modal .pick-item')")); i++) {
        await js(`document.querySelector('[data-view=following] .grid-live .card[data-channel-login=${JSON.stringify(first)}]').focus(); true`);
        await press('X');
        await sleep(500);
      }
      await pick('/Watch with/');
      // The multi-select picker: A ticks (twice unticks), Start confirms.
      await waitFor('the multi-select picker', "!!document.querySelector('.modal.pick-many .pick-item')", 8000);
      await pick('/./');
      await pick('/./');
      if (await js("document.querySelectorAll('.modal.pick-many .pick-item.selected').length") !== 0) throw new Error('A twice did not untick');
      await pick('/./');
      if (await js("document.querySelectorAll('.modal.pick-many .pick-item.selected').length") !== 1) throw new Error('A did not tick');
      await press('START');
      await waitFor('multi-view', "!document.getElementById('multi-screen').hidden && document.querySelectorAll('#multi-stage .mv-tile').length === 2");
      let t = await tiles();
      if (t[0].login !== first || !t[0].active) throw new Error(`the card's channel is not the active first tile: ${JSON.stringify(t)}`);
      if (!/^0% 0% 50% 100%$/.test(t[0].r) || !/^50% 0% 50% 100%$/.test(t[1].r)) throw new Error(`not side by side: ${t.map((x) => x.r)}`);
      const two = await playing(2);
      t = await tiles();
      // Without the demo video (no ffmpeg, as in CI) every tile fails: each shows its error in place.
      const failedOk = async (n) => { if (await js("document.querySelectorAll('#multi-stage .mv-tile.mv-failed .mv-error:not([hidden])').length") !== n) throw new Error('no demo video, and the tiles show no error'); };
      if (two) {
        if (t[0].muted !== false || t[1].muted !== true) throw new Error(`audio: ${JSON.stringify(t.map((x) => x.muted))}`);
        const c = await caps();
        if (c[0] !== null || c[1] !== 480) throw new Error(`quality caps ${JSON.stringify(c)} (want null, 480)`);
      } else await failedOk(2);
      log(`2 tiles ${two ? 'playing' : '(no demo video)'}: ${t.map((x) => x.login).join(', ')}`);
      await shot('multiview-2');

      // RIGHT: the sound and the normal quality move to the other tile.
      await press('RIGHT');
      t = await tiles();
      if (!t[1].active) throw new Error(`RIGHT did not move the active tile: ${JSON.stringify(t)}`);
      if (two) {
        if (t[1].muted !== false || t[0].muted !== true) throw new Error(`RIGHT did not move the sound: ${JSON.stringify(t)}`);
        const c = await caps();
        if (c[0] !== 480 || c[1] !== null) throw new Error(`caps after RIGHT ${JSON.stringify(c)}`);
      }

      // A: the tile menu → Add stream… → three tiles (one big plus two small, the new one active).
      await press('A');
      await pick('/Add stream/');
      await waitFor('the multi-select picker', "!!document.querySelector('.modal.pick-many .pick-item')", 8000);
      await pick('/./');
      await press('START');
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
      const four = two ? await playing(4) : false;
      if (!two) await failedOk(4);
      log(`4 tiles ${four ? 'playing' : '(no demo video)'}`);
      await sleep(600);
      await shot('multiview');
      // Raids: the one socket watches every tile.
      await waitFor('raid subscriptions for every tile', '__lurkbox.watcher.targets.size === 4 && __lurkbox.watcher.subs.size === 4', 8000);
      const raid = (i, to) => js(`(() => { const t = __lurkbox.multi.tiles[${i}].ch; __lurkbox.watcher.dispatchEvent(new CustomEvent('raid', { detail: { from_broadcaster_user_id: String(t.userId), from_broadcaster_user_login: t.login, from_broadcaster_user_name: t.name, to_broadcaster_user_id: '9999001', to_broadcaster_user_login: ${JSON.stringify(to)}, to_broadcaster_user_name: ${JSON.stringify(to)}, viewers: 42 } })); return true; })()`);
      // A non-active tile (0; the active one is 1): its own banner, then it plays the target in place.
      await raid(0, 'raidtarget');
      await waitFor('the raid banner on tile 0', "!!document.querySelectorAll('#multi-stage .mv-tile')[0].querySelector('.mv-raid') && !document.querySelectorAll('#multi-stage .mv-tile')[1].querySelector('.mv-raid')", 3000);
      await waitFor('tile 0 swapped to the raid target', "document.querySelectorAll('#multi-stage .mv-tile')[0].dataset.login === 'raidtarget' && !document.querySelector('.mv-raid')", 6000);
      t = await tiles();
      if (!t[1].active || t.length !== 4) throw new Error(`the raid moved the active tile: ${JSON.stringify(t)}`);
      await waitFor('the raid target watched', "[...__lurkbox.watcher.targets.keys()].includes('9999001')", 5000);
      // The active tile: B cancels its countdown (and only that; multi-view stays open).
      const before = t[1].login;
      await raid(1, 'othertarget');
      await waitFor('the raid banner on the active tile', "!!document.querySelectorAll('#multi-stage .mv-tile')[1].querySelector('.mv-raid .mv-raid-hint')", 3000);
      await press('B');
      await sleep(2600);
      t = await tiles();
      if (t[1].login !== before || await js("!!document.querySelector('.mv-raid')") || await js("document.getElementById('multi-screen').hidden")) throw new Error(`B did not cancel the active tile's raid: ${JSON.stringify(t)}`);
      log('raids: tile 0 followed in place, the active tile\'s cancelled with B');
      // View/Select: the active tile's composer, with the keyboard; the message goes out in its chat.
      await press('BACK');
      await waitFor('the composer in multi-view', "document.getElementById('multi-screen').classList.contains('chat-on') && !document.querySelector('#multi-chat .chat-composer').hidden && (!!document.querySelector('.osk .osk-key') || document.activeElement.matches('#multi-chat .cm-input'))", 4000);
      if (await js("!!document.querySelector('.osk')")) await press('B'); // the built-in keyboard (no Steam keyboard here)
      await js("(() => { const i = document.querySelector('#multi-chat .cm-input'); i.focus(); i.value = 'hi from multi'; i.dispatchEvent(new Event('input')); return true; })()");
      await press('START');
      await waitFor('the message in the multi-view chat', "[...document.querySelectorAll('#multi-chat .chat-msg.own')].some((n) => n.textContent.includes('hi from multi'))", 6000);
      if (await js("document.querySelector('#multi-chat .cm-input').value") !== '') throw new Error('the draft was not cleared after sending');
      if (await js(`__lurkbox.multi.chat.channel`) !== t[1].login) throw new Error('the chat is not the active tile\'s');
      // Y in the composer: quick chat, above the composer (B closes it, back on the composer).
      await js("document.querySelector('#multi-chat .cm-input').focus(); true");
      await press('Y');
      await waitFor('quick chat in multi-view', "!!document.querySelector('#multi-screen > .po-pop.pop-quick')", 3000);
      await press('B');
      await waitFor('quick chat closed', "!document.querySelector('.po-pop.pop-quick') && !!document.activeElement.closest('#multi-chat .chat-composer')", 3000);
      await press('B'); // out of the composer (Y there is quick chat)
      if (await js("!!(document.activeElement && document.activeElement.closest('#multi-chat'))")) throw new Error('B did not leave the composer');
      log('composer: sent from the active tile\'s chat');
      t = await tiles();
      const saved = await js('(() => { const s = __lurkbox.state.settings.multiSets[__lurkbox.state.auth.user.id]; return s && s.map((x) => x.login); })()');
      if (!saved || saved.join() !== t.map((x) => x.login).join()) throw new Error(`the set was not saved: ${JSON.stringify(saved)} vs ${t.map((x) => x.login)}`);
      // Y cycles the layout (grid → one big), and back.
      await press('Y');
      if (await js("document.getElementById('multi-screen').dataset.layout") !== 'big') throw new Error('Y did not switch the layout');
      await press('Y');
      // B: the single player on the active stream.
      const want = t[1].login;
      await press('B');
      await waitFor('the single player', `document.getElementById('multi-screen').hidden && !document.getElementById('player-screen').hidden && __lurkbox.player.current && __lurkbox.player.current.login === ${JSON.stringify(want)}`);
      if (await js("document.querySelectorAll('#multi-stage video').length")) throw new Error('multi-view videos left behind');
      // The player's More: "Resume multi-view" (the saved set, the channels of it that are live: not the raid target).
      await js('__lurkbox.player.showOverlay(); true');
      await waitFor('the overlay', "!!document.querySelector('#player-overlay .po-icon')", 4000);
      await js("(() => { const b = document.querySelector('#player-overlay .po-icon[data-key=more]'); b.focus(); b.click(); return true; })()");
      await waitFor('Resume multi-view in More', "[...document.querySelectorAll('.po-pop .po-item')].some((n) => !n.hidden && /Resume multi-view/.test(n.textContent))", 6000);
      await js("[...document.querySelectorAll('.po-pop .po-item')].find((n) => /Resume multi-view/.test(n.textContent)).click(); true");
      await waitFor('multi-view resumed', "!document.getElementById('multi-screen').hidden && document.querySelectorAll('#multi-stage .mv-tile').length === 3", 8000);
      const resumed = (await tiles()).map((x) => x.login);
      if (resumed.join() !== saved.filter((l) => l !== 'raidtarget').join()) throw new Error(`resumed ${resumed} from ${saved}`);
      log(`resumed: ${resumed.join(', ')}`);
      await press('B');
      await waitFor('the single player again', "document.getElementById('multi-screen').hidden && !document.getElementById('player-screen').hidden", 5000);
      await press('B');
      await waitFor('Following again', "document.getElementById('player-screen').hidden && !!document.activeElement.closest('[data-view=following]')", 5000);
      finish(0, 'X → Watch with… (multi-select), 2 and 4 tiles, audio and caps follow the active tile, layouts, per-tile raids on one socket, the composer, B to the single player, Resume multi-view');
    } catch (e) {
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
