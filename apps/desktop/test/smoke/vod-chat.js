'use strict';
// VOD chat replay smoke test, offline, in demo mode (LURKBOX_DEMO=1: the demo answers VideoCommentsByOffsetOrCursor with
// made-up comments every 2.5 s of video, through the real parser): a past broadcast opened at 2:00 with chat on shows
// "Chat replay" with the last 20 s of chat and then the comments as the video reaches them (never ahead of it), in the
// live chat's style (badges, coloured names); no message box; pausing stops it; a seek to 10:00 starts the list over
// from there; Y turns it off and on. LURKBOX_SHOT_DIR=<dir> saves vod-chat-*.png. Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-vodchat-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true, chatDefault: true, continueWatchingOn: false }));
Object.assign(process.env, { TZ: 'UTC', LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: '1280x800', });
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
  if (blocked.some((l) => EMBED.test(l))) console.log('[vod-chat] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[vod-chat] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[vod-chat] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[vod-chat] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
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
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `vod-chat-${name}.png`), (await wc.capturePage()).toPNG()); };
  const tab = () => js("document.querySelector('.channel-body') && document.querySelector('.channel-body').dataset.tab");
  const focusKey = () => js('document.activeElement && document.activeElement.dataset.focusKey');
  const log = (m) => console.log(`[vod-chat] ${m}`);

  // The comment number in a message's id (demo-vc-<video>-<n>, every 2.5 s of video).
  const shown = () => js("[...document.querySelectorAll('#chat .chat-msg:not(.system)')].map((n) => Number((/-(\\d+)$/.exec(n.dataset.id || '') || [])[1])).filter(Number.isFinite)");
  const pos = () => js("(() => { const v = document.querySelector('#player-screen video'); return v ? v.currentTime : null; })()");
  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5", 30000);
      // A past broadcast of a live channel's user, opened at 2:00 (no resume question).
      const video = await js(`(async () => {
        const s = (await window.lurkbox.helix({ path: '/streams/followed', query: { user_id: window.__lurkbox.state.auth.user.id } })).data.data[0];
        const v = (await window.lurkbox.helix({ path: '/videos', query: { user_id: s.user_id, type: 'archive' } })).data.data.find((x) => !x.stream_id);
        return v;
      })()`);
      if (!video) throw new Error('no demo VOD');
      await js(`window.__lurkbox.nav.playVideo(${JSON.stringify(video)}, { startAt: 120 }); true`);
      await waitFor('the VOD player', `!document.getElementById('player-screen').hidden && window.__lurkbox.player.current && window.__lurkbox.player.current.videoId === ${JSON.stringify(video.id)}`, 20000);
      await waitFor('chat replay', "/Chat replay/.test(document.querySelector('#chat .chat-title').textContent) && document.getElementById('player-screen').classList.contains('chat-on')", 15000);
      await waitFor('the context messages', "document.querySelectorAll('#chat .chat-msg:not(.system)').length >= 5", 15000);
      let ids = await shown();
      if (Math.min(...ids) < Math.floor((120 - 20) / 2.5) - 1) throw new Error(`context from too early: ${ids.slice(0, 3)}`);
      if (Math.max(...ids) > Math.ceil(125 / 2.5) + 1) throw new Error(`messages ahead of the video: ${ids.slice(-3)}`);
      if (!(await js("!!document.querySelector('#chat .chat-msg .chat-badge') && !!document.querySelector('#chat .chat-nick[style*=color]')"))) throw new Error('no badges or coloured names');
      if (await js("(() => { const c = document.querySelector('#chat .chat-composer'); return !!c && !c.hidden && getComputedStyle(c).display !== 'none'; })()")) throw new Error('the message box shows for a VOD');
      await shot('replay');
      const p0 = await pos();
      const playing = await waitFor('playback', `(() => { const v = document.querySelector('#player-screen video'); return v && v.currentTime > ${(p0 || 120) + 3} ? v.currentTime : null; })()`, 20000).catch(() => null);
      if (playing === null) {
        log('note: the demo video does not play here (ffmpeg missing?); checked the start only');
      } else {
        // Comments arrive as the video plays, never ahead of it.
        await waitFor('newer comments', `(() => { const ids = [...document.querySelectorAll('#chat .chat-msg:not(.system)')].map((n) => Number((/-(\\d+)$/.exec(n.dataset.id || '') || [])[1])); return Math.max(...ids) > ${Math.max(...ids)}; })()`, 15000);
        ids = await shown();
        const t = await pos();
        if (Math.max(...ids) * 2.5 > t + 1) throw new Error(`a comment at ${Math.max(...ids) * 2.5} s shows at ${t} s`);
        // Pause: nothing new.
        await js('window.__lurkbox.player.togglePause(); true');
        await sleep(800);
        const before = (await shown()).length;
        await sleep(3000);
        if ((await shown()).length !== before) throw new Error('comments kept coming while paused');
        await js('window.__lurkbox.player.togglePause(); true');
        // Seek to 10:00: the list starts over there.
        await js('window.__lurkbox.player.seekTo(600); true');
        await waitFor('the list from 10:00', "(() => { const ids = [...document.querySelectorAll('#chat .chat-msg:not(.system)')].map((n) => Number((/-(\\d+)$/.exec(n.dataset.id || '') || [])[1])); return ids.length >= 5 && Math.min(...ids) >= 230; })()", 20000);
        ids = await shown();
        if (Math.max(...ids) * 2.5 > (await pos()) + 1) throw new Error('after the seek, comments ahead of the video');
        await shot('seek');
        log(`replay followed the video (${Math.round(playing)} s), stopped while paused, started over after a seek to 10:00 (${ids.length} messages from ${ids[0] * 2.5} s)`);
      }
      // Y turns the chat off and on again (the chat control is there for VODs).
      if (await js("document.querySelector('#player-overlay [data-key=chat]').hidden")) throw new Error('no chat control for a VOD');
      await press('Y');
      await waitFor('chat off', "!document.getElementById('player-screen').classList.contains('chat-on')");
      await press('Y');
      await waitFor('chat on again', "document.getElementById('player-screen').classList.contains('chat-on') && document.querySelectorAll('#chat .chat-msg:not(.system)').length >= 3", 15000);
      finish(0, `${video.user_login} VOD ${video.id}: chat replay with context at 2:00, badges and colours, no message box${playing === null ? '' : ', in step with playback, paused, a seek'}, Y off/on`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
