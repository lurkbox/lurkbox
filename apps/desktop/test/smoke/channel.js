'use strict';
// Channel page smoke test, offline, in demo mode (LURKBOX_DEMO=1: made-up data, no network): X on a live card in
// Following opens the channel page; its header (followers, LIVE card, Follow), then every tab with the virtual gamepad:
// Home (live, next stream, highlights, clips), Videos (the Highlights filter, Y sort), Clips (a period filter, Y sort),
// Schedule (times in the local zone) and About; RB wraps around, B goes back to Following with the focus where it was.
// LURKBOX_SHOT_DIR=<dir> saves channel-*.png. Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-channel-'));
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
  if (blocked.some((l) => EMBED.test(l))) console.log('[channel] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[channel] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[channel] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[channel] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
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
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `channel-${name}.png`), (await wc.capturePage()).toPNG()); };
  const tab = () => js("document.querySelector('.channel-body') && document.querySelector('.channel-body').dataset.tab");
  const focusKey = () => js('document.activeElement && document.activeElement.dataset.focusKey');
  const log = (m) => console.log(`[channel] ${m}`);

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await sleep(400);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid .card').length >= 5");
      // X on the second live card opens its channel page.
      await js("document.querySelectorAll('[data-view=following] .grid .card')[1].focus(); true");
      const login = await js("document.activeElement.dataset.channelLogin");
      await press('X');
      await waitFor('the channel page', `!!document.querySelector('[data-view="channel:${login}"] .channel-tab.selected')`);
      if (await tab() !== 'home') throw new Error(`opened on ${await tab()}`);
      await waitFor('the header', "/followers/.test(document.querySelector('.channel-sub').textContent) && !!document.querySelector('.channel-live-card .watch-live') && !!document.querySelector('.channel-avatar img')");
      await waitFor('the home tab', "!!document.querySelector('.channel-body [data-focus-key=home-live]') && document.querySelectorAll('.channel-body .card-clip').length >= 1 && !!document.querySelector('.channel-next')");
      if (await focusKey() !== 'channel-watch') throw new Error(`first focus on ${await focusKey()}, not Watch`);
      log(`home: ${await js("document.querySelectorAll('.channel-body .card').length")} cards, next stream: ${await js("document.querySelector('.channel-next').textContent.replace(/\\s+/g, ' ').slice(0, 80)")}`);
      await shot('home');

      // RB → Videos: Past broadcasts by default; the Highlights pill filters; Y sorts.
      await press('RB');
      await waitFor('the videos tab', "document.querySelector('.channel-body').dataset.tab === 'videos' && document.querySelectorAll('.channel-body .grid .card').length >= 3");
      if (await focusKey() !== 'tab-videos') throw new Error(`RB left focus on ${await focusKey()}`);
      if (!(await js("document.querySelector('[data-focus-key=vf-archive]').classList.contains('on')"))) throw new Error('Past broadcasts is not the default filter');
      await js("document.querySelector('[data-focus-key=vf-highlight]').focus(); true");
      await press('A');
      await waitFor('highlights only', "(() => { const t = [...document.querySelectorAll('.channel-body .grid .card .card-title')].map((n) => n.textContent); return t.length >= 1 && t.every((x) => /best bits/.test(x)); })()");
      await press('Y');
      await waitFor('the video sort', "/Oldest/.test(document.querySelector('.channel-toolbar .sort-chip').textContent)", 3000);
      if (await js("window.__lurkbox.state.settings.videoFilter") !== 'highlight') throw new Error('the video filter was not saved');
      await shot('videos');

      // RB → Clips: the period pills and the sort.
      await press('RB');
      await waitFor('the clips tab', "document.querySelector('.channel-body').dataset.tab === 'clips' && !!document.querySelector('[data-focus-key=cp-7d].on')");
      await js("document.querySelector('[data-focus-key=cp-all]').focus(); true");
      await press('A');
      await waitFor('all-time clips', "document.querySelectorAll('.channel-body .card-clip').length >= 6");
      const views = await js("[...document.querySelectorAll('.channel-body .card-clip .badge.clip-views')].map((n) => n.textContent)");
      log(`clips (most viewed): ${views.join(', ')}`);
      await press('Y');
      await waitFor('the clip sort', "/Newest/.test(document.querySelector('.channel-toolbar .sort-chip').textContent)", 3000);
      await shot('clips');

      // RB → Schedule.
      await press('RB');
      await waitFor('the schedule', "document.querySelector('.channel-body').dataset.tab === 'schedule' && document.querySelectorAll('.channel-body .schedule-row').length >= 1 || !!document.querySelector('.channel-body .schedule-list .empty')");
      log(`schedule: ${await js("(document.querySelector('.channel-body .schedule-row') || document.querySelector('.channel-body .schedule-list')).textContent.replace(/\\s+/g, ' ').slice(0, 80)")}`);
      await shot('schedule');

      // RB → About; RB again wraps to Home.
      await press('RB');
      await waitFor('about', "document.querySelector('.channel-body').dataset.tab === 'about' && /made-up channel/.test(document.querySelector('.about-desc').textContent)");
      await waitFor('the category fact', "/Category/.test(document.querySelector('.about-facts').textContent)", 5000);
      await press('RB');
      if (await tab() !== 'home') throw new Error('RB did not wrap to Home');
      await press('LB');
      if (await tab() !== 'about') throw new Error('LB did not wrap to About');

      // B → Following, focus back on the card.
      await press('B');
      await waitFor('Following again', "!document.querySelector('[data-view^=\"channel:\"]') && document.activeElement && document.activeElement.dataset.channelLogin === " + JSON.stringify(login));
      finish(0, `channel page of ${login}: header, all five tabs, filters, sorts, LB/RB wrap, back to the same card`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
