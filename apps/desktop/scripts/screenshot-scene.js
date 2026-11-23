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
  'player-chat-overlay': { settings: { chatDefault: true, chatOverlay: true, chatOverlayOpacity: 45, chatHeight: 65, chatVPos: 'bottom' } },
  'player-rewind': {},
  // A prediction and a poll on the channel (the demo's, LURKBOX_DEMO_PREDICTIONS): the card in the overlay, then the
  // prediction's dialog with its live totals.
  'player-prediction': { env: { LURKBOX_DEMO_PREDICTIONS: '1' } },
  // Chat sending: the composer, the emote picker and quick chat (with phrases saved for the demo channel).
  'chat-composer': { settings: { chatDefault: true } },
  'chat-emotes': { settings: { chatDefault: true } },
  'quick-chat': { settings: { chatDefault: true, quickChat: { global: ['gg', 'LUL', 'hype!', 'o7', 'PogChamp'], channels: { 7100004: { login: 'pixelmoth', phrases: ['moth gang lurkerLove', 'world 6 lets go boxHype'] } } } } },
  // The channel page (X on a live card): Home, the Clips tab (period 30 days), the Schedule tab.
  channel: {},
  'channel-clips': { settings: { clipPeriod: '30d' } },
  'channel-schedule': {},
  // The channel page's Emotes tab: the 7TV set with the zero-width partyHat focused in the detail panel.
  'channel-emotes': {},
  // Emote search from the channel's Emotes tab: Seen channels (the channel just browsed) checked, then All of 7TV
  // (the demo's made-up catalogue) for "blob" with the detail panel's usage count.
  'emote-search': {},
  'player-clip': { settings: { clipPeriod: 'all' } },
  'clip-created': {},
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
  // Whispers: the demo account's seeded conversations; the scene replies to one and a whisper comes in.
  whispers: {},
  settings: {},
  // Settings → About with a newer release (the demo's GitHub, LURKBOX_DEMO_UPDATE): the toast and the Download button.
  'settings-about': { env: { LURKBOX_DEMO_UPDATE: '1' } },
  subscriptions: {},
  'blocked-users': { settings: { chatDefault: true } },
  theme: { settings: { theme: THEME, customTheme: CUSTOM } },
  'whos-watching': { settings: { profilePicker: 'ask' } },
  signin: { env: { LURKBOX_DEMO_SIGNED_OUT: '1' } },
  // The touch layouts (Android phones and tablets): a touchscreen (Chromium's touch emulation, LURKBOX_DEMO_TOUCH),
  // no controller, driven by taps and swipes.
  // The demo's Continue watching row shows only in its own scenes, so the other Following shots stay as they were.
  'continue-watching': { settings: { continueWatchingOn: true } },
  'phone-continue-watching': { touch: true, settings: { continueWatchingOn: true }, env: { LURKBOX_DEMO_SIZE: '412x915' } },
  'phone-following': { touch: true, env: { LURKBOX_DEMO_SIZE: '412x915' } },
  'phone-channel': { touch: true, env: { LURKBOX_DEMO_SIZE: '412x915' } },
  'phone-player': { touch: true, env: { LURKBOX_DEMO_SIZE: '412x915' } },
  'phone-clip': { touch: true, settings: { clipPeriod: 'all', clipAutoplay: false }, env: { LURKBOX_DEMO_SIZE: '412x915' } },
  'phone-landscape': { touch: true, settings: { chatDefault: true }, env: { LURKBOX_DEMO_SIZE: '915x412' } },
  'tablet-following': { touch: true, env: { LURKBOX_DEMO_SIZE: '1280x800' } },
  'tablet-player': { touch: true, settings: { chatDefault: true }, env: { LURKBOX_DEMO_SIZE: '1280x800' } },
  // Multi-view: X on a live card → Watch with… → three more ticked in the multi-select picker → a 2x2 grid, chat on.
  multiview: { settings: { chatDefault: true } },
};
const TOUCH = !!SETUP[SCENE].touch;
if (TOUCH) SETUP[SCENE].env.LURKBOX_DEMO_TOUCH = '1';
if (!SETUP[SCENE]) { console.error(`[shot] unknown scene ${SCENE}; one of ${Object.keys(SETUP).join(', ')}`); process.exit(2); }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-shot-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, confirmExit: true, navSounds: false, inputWhenUnfocused: true, continueWatchingOn: false, ...(SETUP[SCENE].settings || {}) }));
// Times (the schedule, dates) in UTC, not the machine's zone: the screenshots are public.
Object.assign(process.env, { TZ: process.env.SHOT_TZ || 'UTC', LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: process.env.SHOT_SIZE || '1280x800' }, SETUP[SCENE].env || {});
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
  const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null };
  // Touch scenes have no controller (a connected pad would pick the TV layout).
  if (!window.__shotTouch) Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
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
  // Touch: real touch events through the DevTools protocol (taps become clicks, pointerType 'touch').
  const cdp = (method, params = {}) => wc.debugger.sendCommand(method, params);
  const touchAt = async (points) => { for (const [type, x, y] of points) { await cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }); await sleep(16); } };
  const centre = async (sel) => {
    const r = await js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => __shot.visible(x)); if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const b = n.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) throw new Error(`nothing to tap: ${sel}`);
    return r;
  };
  const tap = async (sel, { hold = 60 } = {}) => {
    const [x, y] = await centre(sel);
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(hold);
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
  };
  const tapXY = async (x, y) => { await touchAt([['touchStart', x, y], ['touchEnd', x, y]]); };
  /** A finger moving from (x0, y0) to (x1, y1) in `steps` moves over about `ms`. */
  const swipe = async (x0, y0, x1, y1, { steps = 8, ms = 160 } = {}) => {
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps);
      await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
    }
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(300);
  };
  const layoutIs = (mode) => waitFor(`the ${mode} layout`, `document.body.classList.contains('layout-${mode}')`, 10000);
  /** Following → the first live card, by tap. */
  const tapFirstLive = async () => {
    await following();
    await tap('[data-view=following] .grid-live .card');
    await waitFor('the player', "!document.getElementById('player-screen').hidden");
    await playing();
  };
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
    await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
    await press('A');
    await waitFor('the player', "!document.getElementById('player-screen').hidden");
    await playing();
  };
  /** X on the first live card opens its channel page (pixelmoth: live, with a schedule). */
  const openChannelPage = async () => {
    await following();
    await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
    await press('X');
    await waitFor('the channel page', "!!document.querySelector('.channel-tabs .channel-tab.selected')");
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
      // The sub badges (one Helix check per followed channel): the demo account has five subs.
      await waitFor('the sub badges', "document.querySelectorAll('[data-view=following] .badge.sub').length === 5", 20000);
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
      await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
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
    async 'player-prediction'() {
      await openFirstLive();
      await overlay();
      await waitFor('the prediction card', "(() => { const c = document.querySelector('#player-overlay .pp-card'); return c && !c.hidden && /Which level next/.test(c.textContent); })()", 20000);
      await js("document.querySelector('#player-overlay .pp-card').focus(); true");
      await press('A');
      await waitFor('the prediction dialog', "document.querySelectorAll('.modal.pp-modal .pp-outcome').length === 2 && /Your balance/.test(document.querySelector('.pp-modal .pp-balance').textContent)");
      await press('DOWN'); // the second outcome
      await settle();
      await shoot('player-prediction');
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
    async channel() {
      await openChannelPage();
      await waitFor('the home tab', "document.querySelectorAll('.channel-body .card').length >= 6 && !!document.querySelector('.channel-next .schedule-row')");
      await waitFor('the follower count', "/followers/.test(document.querySelector('.channel-sub').textContent)");
      await js("document.querySelector('[data-focus-key=channel-watch]').focus(); true");
      await settle();
      await shoot('channel');
    },
    async 'channel-clips'() {
      await openChannelPage();
      await press('RB', 'RB');
      await waitFor('the clips tab', "document.querySelector('.channel-body').dataset.tab === 'clips' && document.querySelectorAll('.channel-body .card-clip').length >= 4");
      await js("document.querySelector('.channel-body .card-clip').focus(); true");
      await settle();
      await shoot('channel-clips');
    },
    async 'channel-schedule'() {
      await openChannelPage();
      await press('RB', 'RB', 'RB');
      await waitFor('the schedule tab', "document.querySelectorAll('.channel-body .schedule-row').length >= 4");
      await js("document.querySelector('.channel-body .schedule-row').focus(); true");
      await settle();
      await shoot('channel-schedule');
    },
    async 'channel-emotes'() {
      await openChannelPage();
      await press('RB', 'RB', 'RB', 'RB');
      await waitFor('the emotes tab', "document.querySelector('.channel-body').dataset.tab === 'emotes' && document.querySelectorAll('.channel-body .eb-emote').length >= 15 && /^FFZ \\d+$/.test(document.querySelector('[data-focus-key=eb-ffz]').textContent) && /^Twitch \\d+$/.test(document.querySelector('[data-focus-key=eb-twitch]').textContent)");
      await js("document.querySelector('[data-focus-key=eb-7tv-blobSleepy]').focus(); true");
      await press('DOWN');
      await waitFor('the detail panel', "document.querySelector('.eb-detail-name') && document.querySelector('.eb-detail-name').textContent === 'partyHat'");
      await settle();
      await shoot('channel-emotes');
    },
    async 'emote-search'() {
      await openChannelPage();
      await press('RB', 'RB', 'RB', 'RB');
      await waitFor('the emotes tab', "document.querySelectorAll('.channel-body .eb-emote').length >= 15");
      await js("document.querySelector('[data-focus-key=eb-search-all]').focus(); true");
      await press('A');
      await waitFor('emote search', "!!document.querySelector('[data-view=emote-search] .es-input')");
      const type = (q) => js(`(() => { const i = document.querySelector('.es-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      // Seen channels: the channel's sets were indexed as the tab loaded them.
      await press('RB');
      await type('blob');
      await waitFor('seen results', "document.querySelectorAll('[data-view=emote-search] .eb-emote .eb-sub').length >= 6 && /PixelMoth/i.test(document.querySelector('[data-view=emote-search] .eb-sub').textContent)");
      // All of 7TV: three made-up variants per demo emote; the usage count loads for the focused one.
      await press('LB');
      await waitFor('7TV results', "document.querySelectorAll('[data-view=emote-search] .eb-emote').length >= 18 && /18 emotes/.test(document.querySelector('.es-status').textContent)");
      await js("document.querySelectorAll('[data-view=emote-search] .eb-emote')[1].focus(); true");
      await press('RIGHT', 'LEFT');
      await waitFor('the usage count', "/channels/.test((document.querySelector('[data-fact=\"Used in\"]') || {}).textContent || '')");
      await settle();
      await shoot('emote-search');
    },
    async 'player-clip'() {
      // A clip from the Clips tab in the player: the CLIP line, the seek bar, "Watch from here" focused.
      await openChannelPage();
      await press('RB', 'RB');
      await waitFor('the clips', "document.querySelectorAll('.channel-body .card-clip').length >= 4");
      await js("document.querySelector('.channel-body .card-clip').focus(); true");
      await press('A');
      await waitFor('the clip', "!document.getElementById('player-screen').hidden && window.__lurkbox.player.current && window.__lurkbox.player.current.kind === 'clip'");
      await playing(2);
      await overlay();
      await focusControl('vod');
      await settle();
      await shoot('player-clip');
    },
    async 'clip-created'() {
      // The scissors on the live overlay: the demo makes the clip; the toast has the QR code and link to edit it.
      await openFirstLive();
      await overlay();
      await focusControl('clip');
      await press('A');
      await waitFor('the clip toast', "!!document.querySelector('#toasts .toast.clip-made .clip-toast-qr svg')", 8000);
      await settle();
      await shoot('clip-created');
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
    async whispers() {
      await following();
      await press('RB', 'RB', 'RB', 'RB');
      await waitFor('the conversations', "document.querySelectorAll('[data-view=whispers] .whisper-row').length === 3");
      if (!(await js("document.querySelector('.rail-item[data-view=whispers]').classList.contains('has-unread') && document.querySelector('.whisper-row').classList.contains('unread')"))) throw new Error('no unread dot');
      await js("document.querySelector('[data-view=whispers] .whisper-row').focus(); true");
      await press('A');
      await waitFor('the thread', "document.querySelectorAll('.whisper-thread .wmsg').length === 5 && document.activeElement && document.activeElement.classList.contains('cm-input')");
      if (await js("document.querySelector('.rail-item[data-view=whispers]').classList.contains('has-unread')")) throw new Error('opening the thread left it unread');
      // Type (what the keyboard does) and press Send; the demo's PixelMoth answers over the fake EventSub.
      await js("(() => { const i = document.querySelector('.whisper-thread .cm-input'); i.value = 'saving you a seat! 🪑'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
      await press('RIGHT');
      await waitFor('Send', "document.activeElement && document.activeElement.classList.contains('cm-send')");
      await press('A');
      await waitFor('the reply', "document.querySelectorAll('.whisper-thread .wmsg.them').length === 4 && document.querySelectorAll('.whisper-thread .wmsg.me').length === 3", 8000);
      // Someone else whispers: a toast offers Y to reply.
      await js('window.__lurkboxDemo.whisper()');
      await waitFor('the whisper toast', "!!document.querySelector('#toasts .whisper-toast .undo-toast-btn')");
      await js("document.querySelector('.whisper-thread .cm-input').focus(); true");
      await settle();
      await shoot('whispers');
    },
    async settings() {
      await following();
      await press('RB', 'RB', 'RB', 'RB', 'RB', 'RB'); // past Whispers and Drops
      await waitFor('settings', "!!document.querySelector('[data-view=settings] .focusable')");
      await settle();
      await shoot('settings');
    },
    async 'settings-about'() {
      await following();
      await waitFor('the update toast', "!!document.querySelector('#toasts .update-toast')", 20000);
      await press('RB', 'RB', 'RB', 'RB', 'RB', 'RB'); // Settings, past Whispers and Drops
      await waitFor('the update row', "!!document.querySelector('[data-setting=\"update-download\"]')");
      await js("document.querySelector('[data-setting=\"update-download\"]').focus(); true");
      await settle();
      await shoot('settings-about');
    },
    async subscriptions() {
      // Settings → Account → Subscriptions: the demo account's subs among its follows (one Helix check per channel).
      await following();
      await press('RB', 'RB', 'RB', 'RB', 'RB', 'RB'); // Settings, past Whispers and Drops
      await waitFor('settings', "!!document.querySelector('[data-setting=subscriptions]')");
      await js("document.querySelector('[data-setting=subscriptions]').focus(); true");
      await press('A');
      await waitFor('every channel checked', "/subscriptions among/.test((document.querySelector('[data-view=subscriptions] .social-status') || {}).textContent || '') && document.querySelectorAll('[data-view=subscriptions] .social-row').length === 5", 30000);
      await js("document.querySelector('[data-view=subscriptions] .social-row .focusable').focus(); true");
      await settle();
      await shoot('subscriptions');
    },
    async 'blocked-users'() {
      // Block a chatter from the chat line's user card (Up from the message box, A, Block, Yes), then Settings → Blocked users.
      await openFirstLive();
      await js("window.__lurkbox.player.composer.focus(); true");
      await waitFor('the message box', "document.activeElement && document.activeElement.classList.contains('cm-input')");
      await waitFor('chat lines', "document.querySelectorAll('#chat .chat-msg[data-uid]').length >= 5");
      if (await js("[...document.querySelectorAll('#chat .chat-msg[data-uid]')].some((n) => n.dataset.uid === '8000007')")) throw new Error('a blocked chatter is in chat');
      await press('UP');
      await waitFor('a picked line', "!!document.querySelector('#chat .chat-msg.picked')");
      const who = await js("document.querySelector('#chat .chat-msg.picked .chat-nick').textContent");
      await press('A');
      await waitFor('the user card', "!!document.querySelector('.user-card-block')");
      await js("document.querySelector('.user-card-block').focus(); true");
      await press('A');
      await waitFor('the confirm', "!!__shot.byText('.modal .btn', 'Block')");
      await js("__shot.byText('.modal .btn', 'Block').focus(); true");
      await press('A');
      await waitFor('their lines gone', `![...document.querySelectorAll('#chat .chat-msg .chat-nick')].some((n) => n.textContent === ${JSON.stringify(who)})`);
      await js("window.__lurkbox.nav.closePlayer(); true");
      await press('RB', 'RB', 'RB', 'RB', 'RB', 'RB'); // Settings, past Whispers and Drops
      await waitFor('settings', "!!document.querySelector('[data-setting=blockedUsers]')");
      await js("document.querySelector('[data-setting=blockedUsers]').focus(); true");
      await press('A');
      await waitFor('the blocked users', `document.querySelectorAll('[data-view=blocked-users] .social-row').length === 4 && document.querySelector('[data-view=blocked-users] .social-name').textContent === ${JSON.stringify(who)}`);
      await js("document.querySelector('[data-view=blocked-users] .social-row .focusable').focus(); true");
      await settle();
      await shoot('blocked-users');
    },
    async theme() {
      await following();
      await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
      await settle();
      await shoot(`theme-${THEME}`);
    },
    async 'whos-watching'() {
      await waitFor("Who's watching", "document.querySelectorAll('[role=dialog] button img, .modal button img').length >= 3", 20000);
      await following(); // the screen behind it has loaded too
      await settle();
      await shoot('whos-watching');
    },
    async 'continue-watching'() {
      await following();
      await waitFor('the Continue watching row', "document.querySelectorAll('[data-view=following] .cw-row .card').length === 6");
      await js("document.querySelector('[data-view=following] .cw-row .card').focus(); true");
      await press('RIGHT');
      await sleep(300);
      await settle();
      await shoot('continue-watching');
    },
    async 'phone-continue-watching'() {
      await layoutIs('phone');
      await following();
      await waitFor('the Continue watching row', "document.querySelectorAll('[data-view=following] .cw-row .card').length === 6");
      const row = await js("(() => { const r = document.querySelector('.cw-row'); return { sw: r.scrollWidth, cw: r.clientWidth, h: r.getBoundingClientRect().height, card: r.querySelector('.card').getBoundingClientRect().height }; })()");
      if (!(row.sw > row.cw * 2)) throw new Error(`the row does not scroll sideways on the phone: ${JSON.stringify(row)}`);
      if (row.h > row.card * 1.5) throw new Error(`the row wraps on the phone: ${JSON.stringify(row)}`);
      await settle();
      await shoot('phone-continue-watching');
      // The ✕ removes a card (a 44 px target); the toast's Undo brings it back; a long-press offers the menu.
      const x = await js("(() => { const r = document.querySelector('.cw-row .card .cw-x').getBoundingClientRect(); return [r.width, r.height]; })()");
      if (x[0] < 44 || x[1] < 44) throw new Error(`the ✕ is ${x.join('x')} px`);
      await tap('[data-view=following] .cw-row .card .cw-x');
      await waitFor('one card fewer', "document.querySelectorAll('[data-view=following] .cw-row .card').length === 5");
      await waitFor('the Undo toast', "!!document.querySelector('#toasts .undo-toast .undo-toast-btn')");
      await settle({ noSpinner: false });
      await shoot('phone-continue-watching-undo');
      await tap('#toasts .undo-toast-btn');
      await waitFor('the card back', "document.querySelectorAll('[data-view=following] .cw-row .card').length === 6");
      await tap('[data-view=following] .cw-row .card', { hold: 750 });
      await waitFor('the menu', "[...document.querySelectorAll('.modal .pick-item')].some((b) => /Remove from Continue watching/.test(b.textContent))");
    },
    async 'phone-following'() {
      await layoutIs('phone');
      await following();
      await waitFor('offline channels', "document.querySelectorAll('[data-view=following] .grid-offline .card').length >= 4");
      if (await js("!!document.querySelector('#rail .brand') && __shot.visible(document.querySelector('#rail .brand'))")) throw new Error('the rail brand shows on the phone');
      // Every bottom tab is a 44 px target at least.
      const small = await js("[...document.querySelectorAll('#rail .rail-item')].filter((b) => __shot.visible(b)).map((b) => b.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length");
      if (small) throw new Error(`${small} bottom tabs are smaller than 44 px`);
      await settle();
      await shoot('phone-following');
      // Pull to refresh: a drag down from the top of the list re-mounts the section.
      await js("(() => { const n = window.__lurkbox.nav; window.__shotRefreshes = 0; const r = n.refresh; n.refresh = function () { window.__shotRefreshes++; return r.apply(this, arguments); }; document.getElementById('content').scrollTop = 0; return true; })()");
      await swipe(206, 300, 206, 520, { steps: 10, ms: 300 });
      await waitFor('a pull-to-refresh', 'window.__shotRefreshes === 1', 5000);
      // Tabs: Categories, by tap.
      await tap('#rail .rail-item[data-view=categories]');
      await waitFor('categories', "document.querySelectorAll('[data-view=categories] .card').length >= 6 && /Categories/.test(document.querySelector('.appbar-title').textContent)");
    },
    async 'phone-channel'() {
      // A long-press on a live card opens its channel page; a left swipe goes to the next tab.
      await layoutIs('phone');
      await following();
      await tap('[data-view=following] .grid-live .card', { hold: 750 });
      await waitFor('the channel page', "!!document.querySelector('.channel-tabs .channel-tab.selected')");
      if (!(await js("document.getElementById('player-screen').hidden"))) throw new Error('the long-press also played the stream');
      await waitFor('the home tab', "document.querySelectorAll('.channel-body .card').length >= 3");
      const tab = () => js("document.querySelector('.channel-body').dataset.tab");
      const before = await tab();
      await swipe(330, 600, 90, 610);
      await waitFor('the next tab', `document.querySelector('.channel-body').dataset.tab !== ${JSON.stringify(before)}`, 5000);
      await swipe(90, 600, 330, 610);
      await waitFor('back to the first tab', `document.querySelector('.channel-body').dataset.tab === ${JSON.stringify(before)}`, 5000);
      await js("document.getElementById('content').scrollTop = 0; true");
      await settle();
      await shoot('phone-channel');
    },
    async 'phone-player'() {
      await layoutIs('phone');
      await tapFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await tapXY(206, 110); // a tap on the video shows the controls
      await waitFor('the overlay', "!document.getElementById('player-overlay').hidden");
      await settle();
      await shoot('phone-player');
    },
    async 'phone-clip'() {
      // A clip from the channel's Clips tab: double tap the right half seeks +10 s, the seek bar drags, swipe down closes.
      await layoutIs('phone');
      await following();
      await tap('[data-view=following] .grid-live .card', { hold: 750 });
      await waitFor('the channel page', "!!document.querySelector('.channel-tabs .channel-tab.selected')");
      await tap('.channel-tabs .channel-tab[data-tab=clips], .channel-tabs .channel-tab:nth-child(3)');
      await waitFor('the clips', "document.querySelectorAll('.channel-body .card-clip').length >= 4");
      await tap('.channel-body .card-clip');
      await waitFor('the clip', "!document.getElementById('player-screen').hidden && window.__lurkbox.player.current && window.__lurkbox.player.current.kind === 'clip'");
      await playing(1);
      const t = () => js('__shot.video().currentTime');
      await js('__shot.video().pause(); true');
      const t0 = await t();
      await tapXY(330, 40);
      await sleep(120);
      await tapXY(330, 40);
      await waitFor('a seek of +10 s', `(() => { const v = __shot.video(); return v.currentTime > ${t0} + 8 && v.currentTime < ${t0} + 12; })()`, 5000);
      if (await js("document.querySelector('.seek-flash').hidden")) throw new Error('no +10 s flash');
      if (!(await js("/\\+10 s/.test(document.querySelector('.seek-flash').textContent)"))) throw new Error('the flash does not say +10 s');
      await waitFor('the overlay', "!document.getElementById('player-overlay').hidden");
      await settle({ noSpinner: false });
      await shoot('phone-clip');
      // Drag the seek bar's track with a finger to a quarter of the clip.
      const r = await js("(() => { const b = document.querySelector('.po-seek-track').getBoundingClientRect(); return [b.left, b.right, b.top + b.height / 2]; })()");
      const dur = await js('__shot.video().duration');
      await swipe(r[0] + (r[1] - r[0]) * 0.7, r[2], r[0] + (r[1] - r[0]) * 0.25, r[2], { steps: 10, ms: 900 });
      await waitFor('the drag to seek', `Math.abs(__shot.video().currentTime - ${dur} * 0.25) < ${dur} * 0.08`, 5000);
      // Swipe down on the video closes the player and comes back to the channel page.
      await js("window.__lurkbox.player.hideOverlay(); true");
      await swipe(206, 40, 206, 220, { steps: 8, ms: 200 });
      await waitFor('the player closed', "document.getElementById('player-screen').hidden && !!document.querySelector('.channel-tabs')", 5000);
    },
    async 'phone-landscape'() {
      await layoutIs('phone');
      await tapFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await settle();
      await shoot('phone-landscape');
    },
    async 'tablet-following'() {
      await layoutIs('tablet');
      await following();
      await settle();
      await shoot('tablet-following');
    },
    async multiview() {
      await following();
      await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
      await press('X');
      const pickItem = async (re) => {
        await waitFor(`a list item ${re}`, `[...document.querySelectorAll('.modal .pick-item')].some((b) => ${re}.test(b.textContent) && !b.classList.contains('selected'))`, 8000);
        await js(`[...document.querySelectorAll('.modal .pick-item')].find((b) => ${re}.test(b.textContent) && !b.classList.contains('selected')).focus(); true`);
        await press('A');
      };
      await pickItem('/Watch with/');
      await waitFor('the multi-select picker', "!!document.querySelector('.modal.pick-many .pick-item')", 8000);
      for (let i = 0; i < 3; i++) await pickItem('/./');
      await press('START');
      await waitFor('four tiles', "document.querySelectorAll('#multi-stage .mv-tile').length === 4");
      await waitFor('every tile playing', "[...document.querySelectorAll('#multi-stage video')].filter((v) => v.readyState >= 3 && v.currentTime > 1.5).length === 4", 40000);
      await press('RIGHT'); // the sound (and the chat) on the top right tile
      await waitFor('chat with emotes', "(() => { const c = document.getElementById('multi-chat'); return c && __shot.visible(c) && c.querySelectorAll('.chat-msg').length >= 8 && [...c.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0); })()", 20000);
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await js("(() => { for (const n of document.querySelectorAll('#multi-chat *')) if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight; return true; })()");
      await settle();
      await shoot('multiview');
    },
    async 'tablet-player'() {
      await layoutIs('tablet');
      await tapFirstLive();
      await chatReady();
      await js('window.__lurkboxDemo.pauseChat(); true');
      await sleep(1500);
      await chatToEnd();
      await tapXY(400, 300);
      await waitFor('the overlay', "!document.getElementById('player-overlay').hidden");
      await settle();
      await shoot('tablet-player');
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
      if (TOUCH) {
        wc.debugger.attach('1.3');
        await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await js('window.__shotTouch = true');
      }
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
