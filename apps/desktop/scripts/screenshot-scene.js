'use strict';
// One screenshot scene in demo mode (LURKBOX_DEMO=1: made-up data, no network). Run by screenshots.mjs, which
// starts Electron once per scene so every scene begins at the demo's pinned clock:
//   electron apps/desktop/scripts/screenshot-scene.js   (env SHOT_SCENE=<name>, SHOT_OUT=<dir>, SHOT_THEME=<theme>)
// The UI is driven through a virtual gamepad (navigator.getGamepads), so input takes Lurkbox's real path, and elements are
// found by ids, roles, aria labels and data attributes (data-key on the player controls), so the scenes survive
// restyling. Before each capture it waits for fonts, every visible image, and (in the player) a playing video.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCENE = process.env.SHOT_SCENE || 'following';
const OUT = path.resolve(process.env.SHOT_OUT || path.join(__dirname, '..', '..', '..', 'docs', 'screenshots'));
const THEME = process.env.SHOT_THEME || 'lurkbox';
const TIMEOUT = Number(process.env.SHOT_TIMEOUT || 60000);

// A custom theme for the montage (Settings → Appearance → Custom).
const CUSTOM = { base: 'lurkbox', colors: { bg: '#17122a', surface: '#251d40', accent: '#7bd389', fg: '#f4f1de', muted: '#a59cb5' } };

/** Per-scene settings (written before startup) and environment. */
const SETUP = {
  following: {},
  // Following → Live sorted by game (starts on A–Z; the scene presses Y once).
  'following-by-game': { settings: { liveSort: 'az' } },
  player: {},
  'player-popover': {},
  'player-chat': { settings: { chatDefault: true } },
  'player-chat-overlay': { settings: { chatDefault: true, chatOverlay: true, chatOverlayOpacity: 45 } },
  'player-rewind': {},
  // Chat sending: the composer, the emote picker and quick chat (with phrases saved for the demo channel).
  'chat-composer': { settings: { chatDefault: true } },
  'chat-emotes': { settings: { chatDefault: true } },
  'quick-chat': { settings: { chatDefault: true, quickChat: { global: ['gg', 'LUL', 'hype!', 'o7', 'PogChamp'], channels: { 7100004: { login: 'pixelmoth', phrases: ['moth gang lurkerLove', 'world 6 lets go boxHype'] } } } } },
  categories: {},
  search: {},
  keyboard: {},
  // Recent searches for the demo account (another account's stay out of view); the scene adds one by searching.
  'search-history': { settings: { searchHistory: {
    1000001: [
      { q: 'speedrun', at: 1, pick: { kind: 'category', id: '9102', name: 'Retro Speedruns' } },
      { q: 'pixel', at: 2, pick: { kind: 'channel', id: '7100004', login: 'pixelmoth', name: 'PixelMoth' } },
      { q: 'cozy farm', at: 3 },
      { q: 'synth', at: 4, pick: { kind: 'category', id: '9106', name: 'Music & Synths' } },
    ],
    1000002: [{ q: 'not this account', at: 5 }],
  } } },
  settings: {},
  theme: { settings: { theme: THEME, customTheme: CUSTOM } },
  'whos-watching': { settings: { profilePicker: 'ask' } },
  signin: { env: { LURKBOX_DEMO_SIGNED_OUT: '1' } },
};
if (!SETUP[SCENE]) { console.error(`[shot] unknown scene ${SCENE}; one of ${Object.keys(SETUP).join(', ')}`); process.exit(2); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-shot-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, confirmExit: true, navSounds: false, inputWhenUnfocused: true, ...(SETUP[SCENE].settings || {}) }));
Object.assign(process.env, { LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: process.env.SHOT_SIZE || '1280x800' }, SETUP[SCENE].env || {});
if (!process.argv.includes('--windowed')) process.argv.push('--windowed');

const { app } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let finished = false;
function finish(code, msg) {
  if (finished) return;
  finished = true;
  let blocked = '';
  try { blocked = fs.readFileSync(path.join(userData, 'demo-blocked.log'), 'utf8').trim(); } catch { /* none */ }
  if (blocked) { console.log(`[shot] ${SCENE}: the demo tried to reach the network:\n  ${blocked.split('\n').join('\n  ')}`); code = code || 3; }
  console.log(`[shot] ${SCENE}: ${code === 0 ? 'ok' : 'FAILED'}: ${msg}`);
  if (process.env.SHOT_KEEP) console.log(`[shot] kept ${userData}`); else fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => finish(1, `timed out after ${TIMEOUT / 1000}s`), TIMEOUT).unref();

// Runs in the page. Helpers for the scenes; nothing here knows class names of the player redesign.
const PAGE_HELPERS = `(() => {
  if (window.__shot) return true;
  const st = document.createElement('style');
  // No transitions, animations or text caret: every capture shows the settled state.
  st.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }' +
    // Scrolling titles (marquee.js) would be caught at an arbitrary point: show them ending in an ellipsis instead.
    ' .marquee-on { text-indent: 0 !important; text-overflow: ellipsis !important; }';
  document.head.append(st);
  const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(n).visibility !== 'hidden'; };
  // A virtual standard-mapping gamepad: presses go through Lurkbox's real gamepad polling (and its Xbox glyphs).
  const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__shot = {
    async press(a) {
      const b = pad.buttons[BUTTON[a]];
      if (!b) throw new Error('no button ' + a);
      b.pressed = true; b.value = 1; pad.timestamp++;
      await wait(70);
      b.pressed = false; b.value = 0; pad.timestamp++;
      await wait(110);
      return true;
    },
    /** Holds a button down (hold-to-scrub); release() lets go. */
    hold(a) { const b = pad.buttons[BUTTON[a]]; b.pressed = true; b.value = 1; pad.timestamp++; return true; },
    release(a) { const b = pad.buttons[BUTTON[a]]; b.pressed = false; b.value = 0; pad.timestamp++; return true; },
    visible,
    /** Visible <img>s that haven't loaded (or failed). */
    pendingImages() {
      return [...document.images].filter((i) => visible(i) && !(i.complete && i.naturalWidth > 0)).map((i) => i.currentSrc || i.src || '(no src)');
    },
    video() { return [...document.querySelectorAll('video')].find(visible) || null; },
    spinner() { return [...document.querySelectorAll('.loading, [aria-busy="true"]')].some(visible); },
    byText(sel, text) { return [...document.querySelectorAll(sel)].find((n) => visible(n) && n.textContent.trim() === text) || null; },
  };
  return true;
})()`;

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message.slice(0, 300)); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (what, code, timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`waiting for ${what} timed out`);
      await sleep(150);
    }
  };
  const press = async (...actions) => { for (const a of actions) await js(`__shot.press(${JSON.stringify(a)})`); };
  /** Fonts, images, no spinner, two frames; then a capture. */
  const settle = async ({ noSpinner = true } = {}) => {
    await js('document.fonts.ready.then(() => true)');
    await waitFor('images', '__shot.pendingImages().length === 0', 15000).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await js('__shot.pendingImages()'))}`); });
    if (noSpinner) await waitFor('no loading spinner', '!__shot.spinner()', 15000);
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  };
  const shoot = async (name) => {
    wc.invalidate();
    await sleep(250);
    const img = await wc.capturePage();
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const s = img.getSize();
    console.log(`[shot] ${file} (${s.width}x${s.height})`);
  };
  const playing = (min = 1.5) => waitFor('the video to play', `(() => { const v = __shot.video(); return !!(v && v.readyState >= 3 && !v.paused && v.currentTime > ${min}); })()`, 30000);
  const following = () => waitFor('Following', "document.querySelectorAll('[data-view=following] .grid .card').length >= 20");
  const openFirstLive = async () => {
    await following();
    await js("document.querySelector('[data-view=following] .grid .card').focus(); true");
    await press('A');
    await waitFor('the player', "!document.getElementById('player-screen').hidden");
    await playing();
  };
  const overlay = async () => {
    if (await js("document.getElementById('player-overlay').hidden")) await press('A');
    await waitFor('the overlay', "(() => { const o = document.getElementById('player-overlay'); return !o.hidden && !!o.querySelector('[data-key]'); })()");
  };
  /** Moves focus along the overlay bar to the control with this data-key. */
  const focusControl = async (key) => {
    for (let i = 0; i < 16; i++) {
      if (await js(`document.activeElement && document.activeElement.dataset.key === ${JSON.stringify(key)}`)) return;
      await press('RIGHT');
      await sleep(60);
    }
    throw new Error(`no overlay control ${key}`);
  };
  const chatReady = (n = 12) => waitFor('chat with emotes', `(() => { const c = document.getElementById('chat'); return c && __shot.visible(c) && c.querySelectorAll('img').length >= ${n} && [...c.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0); })()`, 20000);

  /** Scrolls the chat's scrolling list to the newest message (late emote images can leave it a little short). */
  const chatToEnd = () => js("(() => { for (const n of document.querySelectorAll('#chat *')) if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight; return true; })()");

  const SCENES = {
    async following() {
      await following();
      // Scrolled so the last live row and the offline channels both show; focus on the first offline channel.
      await waitFor('offline channels', "document.querySelectorAll('[data-view=following] .grid-offline .card').length >= 20");
      await press('DOWN');
      await js(`(() => {
        const off = document.querySelector('[data-view=following] .grid-offline');
        const card = off.querySelector('.card');
        card.focus({ preventScroll: true });
        const content = document.getElementById('content');
        content.scrollTop += off.getBoundingClientRect().top - innerHeight * 0.52;
        return true;
      })()`);
      await sleep(300);
      await settle();
      await shoot('following');
    },
    async 'following-by-game'() {
      await following();
      await js("document.querySelector('[data-view=following] .grid .card').focus(); true");
      await press('Y'); // A–Z → By game, on the focused Live section
      await waitFor('the game headers', "document.querySelectorAll('[data-view=following] .grid-group').length >= 2 && /By game/.test(document.querySelector('[data-view=following] .live-title .sort-chip').textContent)");
      await sleep(1700); // the "Sorted" toast goes
      await settle();
      await shoot('following-by-game');
    },
    async player() {
      await openFirstLive();
      await overlay();
      await focusControl('quality');
      await settle();
      await shoot('player');
    },
    async 'player-popover'() {
      await openFirstLive();
      await overlay();
      await focusControl('quality');
      await press('A');
      await waitFor('the quality pop-over', "!!document.querySelector('#player-overlay [role=dialog]')");
      await settle();
      await shoot('player-popover');
    },
    async 'player-chat'() {
      await openFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500); // the last messages land
      await chatToEnd();
      await settle();
      await shoot('player-chat');
    },
    async 'player-chat-overlay'() {
      await openFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await settle();
      await shoot('player-chat-overlay');
    },
    async 'chat-composer'() {
      await openFirstLive();
      await chatReady();
      // One message sent (drawn at once, confirmed by the demo chat's echo), and the next one being typed.
      await js("(() => { const p = window.__lurkbox.player; p.composer.setDraft('that jump was so clean lurkerHi'); p.composer.send(); return true; })()");
      await waitFor('the echo', "[...document.querySelectorAll('#chat .chat-msg.own')].some((n) => /^demo-msg-/.test(n.dataset.id || ''))", 8000);
      await sleep(2500);
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await js("(() => { const p = window.__lurkbox.player; p.composer.setDraft('see you next stream o7'); p.composer.focus(); return true; })()");
      await chatToEnd();
      await settle();
      await shoot('chat-composer');
    },
    async 'chat-emotes'() {
      await openFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await js("(() => { const p = window.__lurkbox.player; p.composer.setDraft('world 6 already'); p.composer.focus(); return true; })()");
      await press('X');
      await waitFor('the emote picker', "!!document.querySelector('.pop-emotes .ep-tab')");
      for (let i = 0; i < 6 && !(await js("!!document.querySelector('.pop-emotes .ep-tab.selected[data-tab=\"7tv\"]')")); i++) await press('RB');
      await press('RIGHT');
      await settle();
      await shoot('chat-emotes');
    },
    async 'quick-chat'() {
      await openFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await overlay();
      await focusControl('quick');
      await press('A');
      await waitFor('quick chat', "!!document.querySelector('#player-overlay .pop-quick .qc-item')");
      await settle();
      await shoot('quick-chat');
    },
    async 'player-rewind'() {
      await openFirstLive(4);
      await overlay();
      // Live rewind as on the pad: up to the seek bar, then hold left to scrub back; captured mid-scrub, with the
      // storyboard frame of the archive above the bar.
      await waitFor('the seek bar', "!!document.querySelector('#player-overlay [data-key=seek]')", 15000);
      for (let i = 0; i < 3 && !(await js("document.activeElement && document.activeElement.dataset.key === 'seek'")); i++) await press('UP');
      // A first scrub back commits (the player finds the archive and plays it); the second one shows thumbnails.
      await js("__shot.hold('LEFT')");
      await sleep(1600);
      await js("__shot.release('LEFT')");
      await sleep(600);
      await playing(1);
      await overlay();
      for (let i = 0; i < 3 && !(await js("document.activeElement && document.activeElement.dataset.key === 'seek'")); i++) await press('UP');
      await js("__shot.hold('LEFT')");
      await sleep(1400);
      await settle({ noSpinner: false });
      await sleep(300); // the storyboard sprite is a CSS background
      await shoot('player-rewind');
      await js("__shot.release('LEFT')");
    },
    async categories() {
      await following();
      await press('RB', 'RB');
      await waitFor('categories', "document.querySelectorAll('[data-view=categories] .card').length >= 12");
      await settle();
      await shoot('categories');
    },
    async search() {
      await following();
      await press('RB', 'RB', 'RB');
      await waitFor('search', "!!document.querySelector('[data-view=search] input')");
      // What the on-screen keyboard does when you finish typing.
      await js("(() => { const i = document.querySelector('[data-view=search] input'); i.value = 'night'; i.dispatchEvent(new Event('osk-done')); return true; })()");
      await waitFor('search results', "document.querySelectorAll('[data-view=search] .card').length >= 3");
      await js("document.querySelector('[data-view=search] .card').focus(); true");
      await settle();
      await shoot('search');
    },
    async 'search-history'() {
      await following();
      await press('RB', 'RB', 'RB');
      await waitFor('recent searches', "document.querySelectorAll('[data-view=search] .search-recent').length === 4");
      const recents = () => js("[...document.querySelectorAll('[data-view=search] .search-recent')].map((n) => n.dataset.q).join('|')");
      if (await recents() !== 'speedrun|pixel|cozy farm|synth') throw new Error(`recent searches: ${await recents()}`);
      // Search, pick a channel from the results (recorded), come back and clear the box: it is on top, with the pick.
      await js("(() => { const i = document.querySelector('[data-view=search] input'); i.value = 'night'; i.dispatchEvent(new Event('osk-done')); return true; })()");
      await waitFor('search results', "document.querySelectorAll('[data-view=search] .card').length >= 3");
      await js("document.querySelector('[data-view=search] .grid .card').focus(); true");
      await press('A');
      await waitFor('the channel page', "!!document.querySelector('.channel-header')");
      await press('B');
      await waitFor('search again', "!!document.querySelector('[data-view=search] input')");
      await js("(() => { const i = document.querySelector('[data-view=search] input'); i.value = ''; i.dispatchEvent(new Event('osk-done')); return true; })()");
      await waitFor('the new entry', "(() => { const n = document.querySelector('[data-view=search] .search-recent'); return n && n.dataset.q === 'night' && /Channel: /.test(n.textContent); })()");
      // X deletes the highlighted one; focus stays in the list.
      await js("document.querySelectorAll('[data-view=search] .search-recent')[3].focus(); true");
      await press('X');
      await waitFor('cozy farm deleted', "![...document.querySelectorAll('[data-view=search] .search-recent')].some((n) => n.dataset.q === 'cozy farm')");
      if (await recents() !== 'night|speedrun|pixel|synth') throw new Error(`after delete: ${await recents()}`);
      if (!(await js("document.activeElement.dataset.q === 'synth'"))) throw new Error('focus left the list after X');
      // A searches again; picking from the results moves it to the top.
      await js("document.querySelectorAll('[data-view=search] .search-recent')[1].focus(); true");
      await press('A');
      await waitFor('categories for speedrun', "(() => { const g = document.querySelector('[data-view=search] .search-categories'); return g && !g.hidden && /Retro Speedruns/.test(g.textContent); })()");
      // Picking the category records the search again (on top).
      await js("document.querySelector('[data-view=search] .search-categories .card').focus(); true");
      await press('A');
      await waitFor('the category', "!!document.querySelector('[data-view^=category]')");
      await press('B');
      await waitFor('search again', "!!document.querySelector('[data-view=search] input')");
      await js("(() => { const i = document.querySelector('[data-view=search] input'); i.value = ''; i.dispatchEvent(new Event('osk-done')); return true; })()");
      await waitFor('speedrun on top', "document.querySelector('[data-view=search] .search-recent').dataset.q === 'speedrun'");
      await js("document.querySelector('[data-view=search] .search-recent').focus(); true");
      await settle();
      await shoot('search-history');
    },
    async keyboard() {
      // The built-in on-screen keyboard over Search: a grid of equal keys, typed on with the D-pad.
      await following();
      await press('RB', 'RB', 'RB');
      await waitFor('search', "!!document.querySelector('[data-view=search] input')");
      await js("document.querySelector('[data-view=search] input').focus(); true");
      await press('A');
      await waitFor('the on-screen keyboard', "!!document.querySelector('.osk .osk-key[data-ch=q]')");
      await waitFor('focus on q', "document.activeElement && document.activeElement.dataset.ch === 'q'");
      // q → down to a → right to s, d, f → A; then on to the rest of "fun" with the D-pad.
      await press('DOWN', 'RIGHT', 'RIGHT', 'RIGHT', 'A', 'UP', 'RIGHT', 'RIGHT', 'RIGHT', 'A', 'DOWN', 'DOWN', 'LEFT', 'A', 'DOWN');
      await waitFor('the typed text', "document.querySelector('.osk-field').textContent === 'fun'");
      await settle();
      await shoot('keyboard');
    },
    async settings() {
      await following();
      await press('RB', 'RB', 'RB', 'RB', 'RB'); // past Drops
      await waitFor('settings', "!!document.querySelector('[data-view=settings] .focusable')");
      await settle();
      await shoot('settings');
    },
    async theme() {
      await following();
      await js("document.querySelector('[data-view=following] .grid .card').focus(); true");
      await settle();
      await shoot(`theme-${THEME}`);
    },
    async 'whos-watching'() {
      await waitFor("Who's watching", "document.querySelectorAll('[role=dialog] button img, .modal button img').length >= 3", 20000);
      await following(); // the screen behind it has loaded too
      await settle();
      await shoot('whos-watching');
    },
    async signin() {
      await waitFor('welcome', "!!__shot.byText('button', 'Sign in with your phone instead')");
      await js("__shot.byText('button', 'Sign in with your phone instead').click(); true");
      await waitFor('the sign-in code', "document.body.textContent.includes('ABCD-EFGH') && !!document.querySelector('svg rect, svg path') && /Waiting/.test(document.body.textContent)");
      await settle({ noSpinner: false });
      await shoot('signin');
    },
  };

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', "!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)");
      await js(PAGE_HELPERS);
      await sleep(400); // the virtual pad is seen with nothing held before the first press
      await SCENES[SCENE]();
      if (errors.length) console.log(`[shot] ${SCENE}: renderer errors:\n  ${errors.join('\n  ')}`);
      finish(0, 'captured');
    } catch (e) {
      try { await shoot(`FAILED-${SCENE}`); } catch { /* ignore */ }
      if (errors.length) console.log(`[shot] renderer errors:\n  ${errors.join('\n  ')}`);
      finish(1, e.message);
    }
  });
});

require('../src/main/main.js');
