'use strict';
// Steam's Game Mode session sets GTK_IM_MODULE=Steam. Chromium then receives every character typed on the Steam
// on-screen keyboard twice: once from Steam's GTK input-method module and once as a synthesized key event. Flatpak apps
// never load that module, which is why they don't double. Drop it before Chromium initialises GTK, so only the key events
// arrive. This has to stay at the very top of the main script.
const STEAM_IM_MODULES = ['GTK_IM_MODULE', 'QT_IM_MODULE'];
const droppedImModules = STEAM_IM_MODULES.filter((k) => /^steam$/i.test(process.env[k] || ''));
for (const k of droppedImModules) delete process.env[k];
const path = require('path');
const { openSteamKeyboard, inGameMode } = require('./steam-keyboard');
const { JoydevReader } = require('./joydev');
const { app, BrowserWindow, ipcMain, Menu, session, nativeImage, safeStorage, net, protocol } = require('electron');
const { CookieJar, playerStatus, mismatchWarning, openPlayerLogin, createLoginWindow, loginZoom, CHROME_UA } = require('./player-session');
const { TvSignIn } = require('./tv-signin');
const qrcode = require('qrcode-generator');
const { JsonFile, DEFAULT_SETTINGS, sanitizeSettings } = require('./store');
const { Twitch } = require('./twitch');
const { startServer } = require('./server');
const { fetchMaster } = require('./direct');
const hlsProxy = require('./hls-proxy');
const { navSource, pressSource, backSource } = require('./frame-nav');
const points = require('./channel-points');
const drops = require('./drops');
const { createDropsFrameHost } = require('./drops-frame');
const follow = require('./follow');
const { WatchMinutes } = require('./watch-minutes');
const { ResumeStore } = require('./resume');
const { WEB_CLIENT_ID, GQL_URL } = require('./direct');
const { SteamArt } = require('./steam-art');
const { ScopeKeeper } = require('./keep-scope');
const { logGpu, watchDecoders } = require('./gpu-diag');
const { setupChatExtensions } = require('./chat-extensions');
const { WEB_ROOT, ASSETS_DIR, HLS_JS } = require('./paths');
const { createAppLog } = require('./app-log');
const { twitchChatZoom, zoomFrameSource } = require('@lurkbox/core/src/shared/tv-zoom.js');
let chatExt = null; // experimental 7TV/BTTV/FFZ extensions in Twitch's chat frame (Settings → Chat)

const argv = process.argv.slice(1);
const WINDOWED = argv.includes('--windowed');
const argValue = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const START_CHANNEL = (argValue('channel') || '').toLowerCase() || null;
// Dev aid: --vod=<id> opens that past broadcast at startup.
const START_VOD = /^\d+$/.test(argValue('vod') || '') ? argValue('vod') : null;
// Dev aid: --screenshot=<file.png> [--screenshot-delay=<ms>] captures the window, then quits.
const SCREENSHOT = argValue('screenshot');
const SCREENSHOT_DELAY = Number(argValue('screenshot-delay')) || 5000;

// ---- Chromium switches: keep playing when hidden, unfocused or occluded (Floater) ----
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Under Gamescope, Steam/Floater track the window through XWayland. The browser process picks its Ozone platform before
// this script runs, so --ozone-platform must be on the real command line (README: Steam launch options). Appending it
// here only reaches the GPU process; when that differs from the browser's platform (WAYLAND_DISPLAY set), the GPU
// process crashes on start (exit 139), and Chromium falls back to software compositing and decoding. So only append
// it when it matches what the browser auto-selects anyway (no WAYLAND_DISPLAY), which keeps the children consistent.
const underGamescope = !!process.env.GAMESCOPE_WAYLAND_DISPLAY || /gamescope/i.test(process.env.XDG_CURRENT_DESKTOP || '');
const ozoneArg = argv.find((a) => a.startsWith('--ozone-platform'));
if (underGamescope && !ozoneArg && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
const ozoneNote = ozoneArg ? ozoneArg.slice(2) : (process.env.WAYLAND_DISPLAY ? `auto (WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY})` : 'auto (x11)');

app.setName('Lurkbox');
// Cookies (the twitch.tv player sign-in) and safeStorage are encrypted with a key from the OS password store. Chromium
// picks KWallet/libsecret in Desktop Mode but the fixed "basic" key under Gamescope (no wallet), so cookies saved in one
// mode can't be decrypted in the other and the sign-in silently disappears. Always use the same store.
if (!argv.some((a) => a.startsWith('--password-store'))) app.commandLine.appendSwitch('password-store', process.env.LURKBOX_PASSWORD_STORE || 'basic');
// Twitch HLS through the main process (VOD CDN has no CORS for localhost): see hls-proxy.js.
protocol.registerSchemesAsPrivileged([{ scheme: hlsProxy.SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const proxyHosts = new hlsProxy.ProxyHosts();
// Tests point userData at a temp dir so they never touch real tokens.
if (process.env.LURKBOX_USER_DATA) app.setPath('userData', process.env.LURKBOX_USER_DATA);
// Demo mode (README screenshots): made-up data, no network, none of the setup below. Only for exactly LURKBOX_DEMO=1.
if (require('./demo').isDemo()) { require('./demo').runDemo(); return; }

// Hardware video decoding (VA-API) for the direct engine; Settings → Player, needs a restart.
const earlySettings = (() => {
  try { return JSON.parse(require('fs').readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; }
})();
// VA-API decoding is on by default in Electron 45 (Chromium 156) on Linux; chrome://gpu lists the profiles with no
// flags. The old flag set (AcceleratedVideoDecodeLinuxGL, ...ZeroCopyGL, VaapiVideoDecoder, VaapiIgnoreDriverChecks)
// is kept as an opt-in for experiments: LURKBOX_GPU_CONFIG=legacy | gl | default.
const GPU_CONFIGS = {
  default: [],
  gl: ['AcceleratedVideoDecodeLinuxGL', 'VaapiIgnoreDriverChecks'],
  legacy: ['AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'VaapiVideoDecoder', 'VaapiIgnoreDriverChecks'],
};
const hwRequested = earlySettings.hwDecode !== false;
const gpuConfig = !hwRequested ? 'disabled' : (GPU_CONFIGS[process.env.LURKBOX_GPU_CONFIG] ? process.env.LURKBOX_GPU_CONFIG : 'default');
if (process.platform === 'linux') {
  if (!hwRequested) app.commandLine.appendSwitch('disable-accelerated-video-decode');
  else if (GPU_CONFIGS[gpuConfig].length) app.commandLine.appendSwitch('enable-features', GPU_CONFIGS[gpuConfig].join(','));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let server = null;
let settings = null;
let tokens = null;
let twitch = null;
let playerJar = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });
// Record the scope Steam launched us in now, before Chromium's portal setup moves us (see keep-scope.js).
const scopeKeeper = process.env.LURKBOX_KEEP_SCOPE === '0' ? null : new ScopeKeeper({ log: (l) => appLog(l) });

// lurkbox.log in userData, up to 5 MB, then rotated to lurkbox.log.1 (app-log.js). Never log tokens.
let appLogImpl = null;
function appLog(line) {
  if (!appLogImpl) appLogImpl = createAppLog(path.join(app.getPath('userData'), 'lurkbox.log'));
  appLogImpl(line);
}

let joydev = null;
let hiddenSince = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Runs inside the Twitch player iframe. Keeps the page "visible" so the embed
// never pauses or drops quality when the window is hidden or loses focus.
const FRAME_VISIBILITY_PATCH = `(() => {
  if (window.__ttvPatched) return; window.__ttvPatched = true;
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Document.prototype.hasFocus = function () { return true; };
  } catch (e) {}
  const stop = (e) => e.stopImmediatePropagation();
  for (const t of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
    window.addEventListener(t, stop, true);
    document.addEventListener(t, stop, true);
  }
})();`;

const GATE_SELECTORS = [
  '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
  '[data-a-target="player-overlay-mature-accept"]',
  '[data-a-target="mature-content-gate-accept-button"]',
];
// The big "play" overlay only appears when autoplay failed; clicking it is a
// last resort (used by the play watchdog and the "Press A to play" button).
const PLAY_SELECTORS = ['[data-a-target="player-overlay-play-button"]'];
const frameClick = (selectors) => `(() => {
  for (const s of ${JSON.stringify(selectors)}) {
    const el = document.querySelector(s);
    if (el && el.offsetParent !== null) { el.click(); return s; }
  }
  return '';
})();`;

function playerFrames() {
  if (!win || win.isDestroyed()) return [];
  return win.webContents.mainFrame.framesInSubtree.filter((f) => {
    try { return new URL(f.url).hostname === 'player.twitch.tv'; } catch { return false; }
  });
}

function patchPlayerFrames() {
  for (const f of playerFrames()) f.executeJavaScript(FRAME_VISIBILITY_PATCH).catch(() => {});
}

// Twitch's embedded chat (chat style "Twitch chat", rewards, predictions, polls) is drawn at desktop size, so it is
// zoomed for the TV inside the frame: Settings → Chat → Twitch chat size, Auto = the login window's rule.
// Re-applied on every load of the frame, on every points scan and when the setting or the UI scale changes.
let lastChatZoomLog = '';
function chatZoom() {
  return twitchChatZoom(settings.get(), require('electron').screen.getPrimaryDisplay().size.height);
}
function zoomChatFrames() {
  if (!win || win.isDestroyed()) return;
  const z = chatZoom();
  for (const f of win.webContents.mainFrame.framesInSubtree) {
    let chat = false;
    try { chat = points.isChatFrameUrl(f.url); } catch { /* frame gone */ }
    if (!chat) continue;
    f.executeJavaScript(zoomFrameSource(z)).then((computed) => {
      const line = `[chat] Twitch chat frame zoom ${z} (computed ${computed}) ${f.url.split('?')[0]}`;
      if (line !== lastChatZoomLog) { lastChatZoomLog = line; appLog(line); }
    }).catch(() => {});
  }
}

// ---- Twitch Drops (drops.js): the Drops section's frame of Twitch's inventory page, and the background auto-claim ----
let dropsProgress = { checkedAt: null, campaigns: [] };
let dropsClaimer = null;
function dropsFrames() {
  if (!win || win.isDestroyed()) return [];
  return win.webContents.mainFrame.framesInSubtree.filter((f) => { try { return drops.isDropsPageUrl(f.url); } catch { return false; } });
}
const dropsFrame = createDropsFrameHost({
  frames: dropsFrames,
  zoom: () => loginZoom(require('electron').screen.getPrimaryDisplay().size.height, settings.get().uiScale),
  openKeyboard: () => openSteamKeyboard(appLog),
});

/** Loads the inventory page in a hidden window of the same session, waits for it, scans it and (claim) presses Claim. */
async function scanInventoryHidden({ claim }) {
  const w = new BrowserWindow({
    show: false, width: 1280, height: 900, paintWhenInitiallyHidden: true,
    webPreferences: { session: session.defaultSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = w.webContents;
  try {
    wc.setAudioMuted(true);
    wc.setUserAgent(CHROME_UA);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => { if (!/^https:\/\/(www\.)?twitch\.tv\//.test(url)) e.preventDefault(); });
    await Promise.race([wc.loadURL(drops.INVENTORY_URL), new Promise((_r, rej) => setTimeout(() => rej(new Error('load timed out')), 45000))]);
    let r = null;
    for (let i = 0; i < 30; i++) {
      r = await wc.executeJavaScript(drops.scanSource({ claim: false }));
      if (r && r.state !== 'loading') break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!r || r.state !== 'ready') return r || { state: 'loading', campaigns: [], claimed: [] };
    await new Promise((res) => setTimeout(res, 2500)); // the campaign list fills in after the first paint
    return await wc.executeJavaScript(drops.scanSource({ claim }));
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

function startDropsClaimer() {
  dropsClaimer = new drops.DropsClaimer({
    enabled: () => settings.get().autoClaimDrops !== false,
    hasSession: async () => (await playerStatus(session.defaultSession.cookies)).signedIn,
    run: () => scanInventoryHidden({ claim: true }),
    onClaim: (name) => send('drops:event', { type: 'claimed', name }),
    onProgress: (campaigns) => { dropsProgress = { checkedAt: Date.now(), campaigns }; },
    log: appLog,
  }).start();
}

async function createWindow() {
  server = await startServer(WEB_ROOT, {
    '/vendor/hls.min.js': HLS_JS,
    '/vendor/wordmark.json': path.join(ASSETS_DIR, 'src', 'wordmark.json'),
  });
  console.log(`[main] renderer served at ${server.url}`);

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: !WINDOWED, // BrowserWindow fullscreen, never exclusive; Gamescope handles the rest
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    title: 'Lurkbox',
    icon: path.join(ASSETS_DIR, 'icons', '256x256.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    console.log(`[main] blocked popup: ${url}`);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(server.url)) e.preventDefault();
  });
  wc.on('did-frame-finish-load', patchPlayerFrames);
  wc.on('did-frame-finish-load', zoomChatFrames);
  wc.on('did-frame-finish-load', () => dropsFrame.prepare());
  wc.on('frame-created', patchPlayerFrames);
  watchDecoders(wc, appLog);
  if (chatExt) chatExt.watchFrames(wc);
  // GPU/utility crashes (a crashing GPU process means software decoding). Quiet at shutdown and after 10 lines.
  let goneLogged = 0;
  let lastGone = '';
  app.on('child-process-gone', (_e, d) => {
    if ((d.type !== 'GPU' && d.type !== 'Utility') || ['killed', 'clean-exit'].includes(d.reason) || quitting) return;
    const line = `[gpu] ${d.type} process gone: ${d.reason} (exit ${d.exitCode})${d.name ? ` ${d.name}` : ''}`;
    if (line === lastGone || goneLogged >= 10) return;
    lastGone = line;
    goneLogged += 1;
    appLog(line);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone', details.reason);
    if (details.reason !== 'clean-exit') setTimeout(() => win && !win.isDestroyed() && wc.reload(), 1000);
  });
  wc.on('console-message', (e) => {
    if (/Autoplay|visibility/i.test(e.message)) appLog(`[embed] ${e.message.replace(/%c/g, '').replace(/\s+/g, ' ').slice(0, 300)}`);
    const lvl = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'log';
    if (lvl !== 'log' || process.env.LURKBOX_DEBUG) console[lvl](`[renderer] ${e.message}`);
  });

  win.on('focus', () => { appLog('[window] focus'); send('window:focus', true); });
  win.on('blur', () => { appLog('[window] blur'); send('window:focus', false); });
  // Watch-time points stop after 5 min minimised/hidden.
  for (const ev of ['minimize', 'hide']) win.on(ev, () => { if (!hiddenSince) hiddenSince = Date.now(); });
  for (const ev of ['restore', 'show']) win.on(ev, () => { hiddenSince = null; });
  win.once('ready-to-show', () => win.show());
  // Steam's virtual pads are read from /dev/input/js* because Chromium only sees one of them (see joydev.js).
  if (process.platform === 'linux' && process.env.LURKBOX_JOYDEV !== '0' && !joydev) {
    joydev = new JoydevReader({ onChange: (pad) => send('joydev:pad', pad), log: appLog }).start();
    app.on('will-quit', () => joydev.stop());
    win.webContents.on('did-finish-load', () => setTimeout(() => joydev && joydev.replay(), 300));
  }

  await win.loadURL(server.url);

  if (SCREENSHOT) {
    setTimeout(async () => {
      try {
        const img = await wc.capturePage();
        require('fs').writeFileSync(SCREENSHOT, img.toPNG());
        console.log(`[main] screenshot written to ${SCREENSHOT}`);
      } catch (e) {
        console.error('[main] screenshot failed', e);
      }
      app.quit();
    }, SCREENSHOT_DELAY);
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    windowed: WINDOWED,
    gamescope: underGamescope,
    startChannel: START_CHANNEL,
    startVod: START_VOD,
    version: app.getVersion(),
    defaults: DEFAULT_SETTINGS,
  }));
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('window:setIcon', (_e, dataUrl) => {
    if (!win || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 2_000_000) return false;
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return false;
    win.setIcon(img);
    return true;
  });
  ipcMain.handle('window:toggleFullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const clean = sanitizeSettings(patch || {});
    const prevClientId = settings.get().clientId;
    const next = settings.set(clean);
    if ('clientId' in clean && clean.clientId !== prevClientId) {
      // Tokens are bound to the Client ID that issued them.
      twitch.cancelDeviceFlow();
      twitch.clearTokens();
    }
    if ('twitchChatSize' in clean || 'uiScale' in clean) zoomChatFrames();
    if ('chatExtensions' in clean && chatExt) await chatExt.setEnabled(clean.chatExtensions).catch((e) => appLog(`[extensions] ${e.message}`));
    send('settings:changed', next);
    return next;
  });

  ipcMain.handle('auth:state', () => twitch.state());
  ipcMain.handle('auth:start', async () => {
    try {
      return { ok: true, flow: await twitch.startDeviceFlow() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('auth:cancel', () => twitch.cancelDeviceFlow());
  // One sign-in covers the API and the player, so signing out does both.
  ipcMain.handle('auth:signOut', async (_e, id) => {
    const target = id || twitch.store().active;
    if (target === twitch.store().active) await playerJar.clear();
    if (/^\d+$/.test(String(target))) playerJar.remove(String(target));
    return twitch.signOut(target || undefined);
  });
  ipcMain.handle('auth:switch', (_e, id) => twitch.switchAccount(String(id)));
  ipcMain.handle('auth:remove', async (_e, id) => {
    const next = await twitch.removeAccount(String(id));
    if (/^\d+$/.test(String(id))) playerJar.remove(String(id));
    return next;
  });

  ipcMain.handle('helix', async (_e, req) => {
    try {
      const r = await twitch.helix(req);
      return { ok: true, status: r.status, data: r.data };
    } catch (e) {
      return { ok: false, status: e.status || 0, error: e.message, data: e.body || null, resetAt: e.resetAt || null };
    }
  });

  // The chat composer's keyboard: Steam's (types into the focused box) in Game Mode; elsewhere the core shows its own.
  ipcMain.handle('keyboard:open', () => (inGameMode() ? openSteamKeyboard(appLog) : false));
  ipcMain.handle('qr:svg', (_e, text) => {
    const qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  });

  ipcMain.handle('player:dismissGate', async (_e, opts = {}) => {
    const selectors = opts && opts.play ? [...GATE_SELECTORS, ...PLAY_SELECTORS] : GATE_SELECTORS;
    let clicked = '';
    for (const f of playerFrames()) {
      try { clicked = (await f.executeJavaScript(frameClick(selectors))) || clicked; } catch { /* frame gone */ }
    }
    if (clicked) appLog(`[player] clicked ${clicked} in the embed`);
    return clicked;
  });
  ipcMain.handle('direct:master', async (_e, req) => {
    try {
      const login = req && req.login && /^[a-z0-9_]{1,25}$/i.test(req.login) ? req.login : null;
      const vodId = req && req.vodId && /^\d+$/.test(req.vodId) ? req.vodId : null;
      if (!login && !vodId) return { ok: false, reason: 'bad request' };
      const codecs = (req.codecs || ['h264']).filter((c) => ['av1', 'h265', 'h264'].includes(c));
      const auth = (await session.defaultSession.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }))[0];
      const r = await fetchMaster({ fetch: net.fetch, login, vodId, codecs, authToken: auth ? auth.value : null, log: appLog });
      if (r.ok) {
        if (process.env.LURKBOX_HLS_PROXY !== '0') r.master = hlsProxy.rewriteMaster(r.master, proxyHosts);
        if (!r.authed) {
          const active = twitch.store().active;
          const jarLogin = active && /^\d+$/.test(active) ? playerJar.peekLogin(active) : null;
          r.anonReason = `${r.anonReason}${auth ? '' : `; account jar ${jarLogin !== null ? 'has a web session' : 'has none'}`}`;
          appLog(`[direct] anon token: ${r.anonReason}`);
        }
      }
      return r;
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  // Storyboard thumbnails for scrubbing a VOD (Twitch's seekPreviewsURL JSON; the sprite sheets load as images).
  ipcMain.handle('direct:storyboard', async (_e, vodId) => {
    try {
      if (!/^\d{1,20}$/.test(String(vodId))) return null;
      const q = { query: `{ video(id: ${JSON.stringify(String(vodId))}) { seekPreviewsURL } }` };
      const r = await net.fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID }, body: JSON.stringify(q) }).then((x) => x.json());
      const url = r && r.data && r.data.video && r.data.video.seekPreviewsURL;
      if (!url) return null;
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/\.cloudfront\.net$|\.twitch\.tv$|\.ttvnw\.net$/.test(u.hostname)) return null;
      const list = await net.fetch(url).then((x) => (x.ok ? x.json() : null));
      if (!Array.isArray(list)) return null;
      const pick = list.find((s) => s.quality === 'high') || list[0];
      if (!pick || !Array.isArray(pick.images)) return null;
      const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
      return {
        count: num(pick.count), width: num(pick.width), height: num(pick.height), rows: num(pick.rows), cols: num(pick.cols), interval: num(pick.interval),
        images: pick.images.filter((i) => /^[\w.-]+\.jpg$/.test(i)).map((i) => new URL(i, url).href),
      };
    } catch (e) { appLog(`[direct] storyboard failed: ${e.message}`); return null; }
  });
  ipcMain.handle('direct:liveInfo', async (_e, login) => {
    try {
      if (!/^[a-z0-9_]{1,25}$/i.test(String(login))) return null;
      return await require('./direct').fetchLiveInfo({ fetch: net.fetch, login });
    } catch (e) { appLog(`[direct] live info failed: ${e.message}`); return null; }
  });
  const resume = new ResumeStore(path.join(app.getPath('userData'), 'resume.json'));
  ipcMain.handle('resume:get', (_e, videoId) => resume.get(twitch.store().active, String(videoId)));
  ipcMain.handle('resume:set', (_e, videoId, position, duration) => resume.set(twitch.store().active, String(videoId), position, duration));
  ipcMain.handle('log:write', (_e, line) => appLog(String(line).slice(0, 2000)));

  // ---- Steam library art (opt-in; Settings → Appearance). Never throws to the renderer. ----
  const steamArt = new SteamArt({
    backupDir: path.join(app.getPath('userData'), 'steam-art-backup'),
    staticDir: path.join(ASSETS_DIR, 'steam'),
    log: appLog,
  });
  let steamArtBusy = Promise.resolve();
  const steamArtCall = (fn) => {
    const run = steamArtBusy.then(fn).catch((e) => { appLog(`[steam-art] failed: ${e.message}`); return { ok: false, error: e.message }; });
    steamArtBusy = run;
    return run;
  };
  ipcMain.handle('steam-art:apply', (_e, pngs) => steamArtCall(() => {
    if (!settings.get().steamArtSync) return { ok: false, error: 'Steam art sync is off' };
    return steamArt.apply(pngs);
  }));
  ipcMain.handle('steam-art:restore', () => steamArtCall(() => steamArt.restore()));

  // ---- optional player sign-in (twitch.tv web session for subs/Turbo in the embed) ----
  const jar = playerJar;
  const playerState = async () => {
    const st = await playerStatus(session.defaultSession.cookies);
    return { ...st, mismatch: mismatchWarning(st.login, twitch.user && twitch.user.login) };
  };
  ipcMain.handle('player-session:status', () => playerState());
  const loginWindowOpts = () => ({
    BrowserWindow, parent: win, session: session.defaultSession, fullscreen: !WINDOWED,
    preload: path.join(__dirname, '..', 'login-preload.js'),
    zoom: loginZoom(require('electron').screen.getPrimaryDisplay().size.height, settings.get().uiScale),
  });
  ipcMain.handle('player-session:login', async () => {
    const r = await openPlayerLogin({ ...loginWindowOpts(), log: appLog });
    const active = twitch.store().active;
    if (r.ok && active && /^\d+$/.test(active)) await jar.save(active).catch(() => {});
    return { ...r, ...(await playerState()) };
  });

  // ---- single TV sign-in: twitch.tv login, then Authorize for Lurkbox, in one window ----
  const tvSignIn = new TvSignIn({
    twitch, jar, cookies: session.defaultSession.cookies, log: appLog,
    openWindow: () => {
      const w = createLoginWindow({ ...loginWindowOpts(), title: 'Sign in to Twitch' });
      return {
        load: (url) => { if (!w.isDestroyed()) w.loadURL(url); },
        close: () => { if (!w.isDestroyed()) w.close(); },
        closed: new Promise((resolve) => w.on('closed', resolve)),
      };
    },
  });
  ipcMain.handle('auth:tvSignIn', async (_e, opts = {}) => {
    const r = await tvSignIn.run({ add: !!(opts && opts.add), accountId: opts && /^\d+$/.test(String(opts.accountId)) ? String(opts.accountId) : null });
    // Write the new web session to disk now; Chromium otherwise batches cookie writes (lost if Steam kills us).
    await session.defaultSession.cookies.flushStore().catch(() => {});
    twitch.emitState();
    return r;
  });
  // One line per account: is the API token usable, and is the player (twitch.tv web session) signed in as them?
  ipcMain.handle('accounts:status', async () => {
    const st = twitch.state();
    const live = await playerStatus(session.defaultSession.cookies);
    return st.accounts.map((a) => {
      const playerLogin = a.id === st.active ? (live.signedIn ? live.login || '' : null) : jar.peekLogin(a.id);
      return { id: a.id, api: !a.needsSignin, player: playerLogin !== null && (!playerLogin || playerLogin.toLowerCase() === String(a.login).toLowerCase()), playerLogin };
    });
  });
  ipcMain.handle('player-session:signOut', async () => { await jar.clear(); appLog('[player-login] signed out of the player'); return playerState(); });
  // Controller in the twitch.tv window: the shared navigation (frame-nav.js) runs in the page.
  ipcMain.on('player-login:pad', async (e, key) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w === win) return;
    if (key === 'b') { w.close(); return; }
    if (key === 'keyboard') { openSteamKeyboard(appLog); return; }
    const src = pressSource(key);
    if (!src) return;
    try {
      if (await e.sender.executeJavaScript(src) === 'keyboard') openSteamKeyboard(appLog);
    } catch { /* page navigating */ }
  });
  // ---- channel points: Twitch's embedded chat page (hosted by the renderer as an iframe), scanned from here ----
  const tracker = new points.PointsTracker();
  let pointsLogin = null;
  let pointsTimer = null;
  let pointsNote = '';
  const note = (line) => { if (line !== pointsNote) { pointsNote = line; appLog(line); } };
  const chatFrames = (login) => {
    if (!win || win.isDestroyed()) return [];
    return win.webContents.mainFrame.framesInSubtree.filter((f) => { try { return points.isChatFrameUrl(f.url, login); } catch { return false; } });
  };
  const scanPoints = async () => {
    const login = pointsLogin;
    if (!login) return;
    const web = await playerStatus(session.defaultSession.cookies);
    if (!web.signedIn) { note(`[points] ${login}: no twitch.tv session; channel points inactive (sign in on the TV to use them)`); send('points:state', { login, signedIn: false, balance: null }); return; }
    const frame = chatFrames(login)[0];
    if (!frame) { note(`[points] ${login}: chat frame not loaded yet`); return; }
    frame.executeJavaScript(zoomFrameSource(chatZoom())).catch(() => {});
    let scan;
    try { scan = await frame.executeJavaScript(points.scanSource({ autoClaim: settings.get().autoClaimPoints !== false })); } catch (e) { note(`[points] ${login}: scan failed (${e.message})`); return; }
    if (login !== pointsLogin) return;
    const { events, state } = tracker.update(scan);
    for (const ev of events) {
      if (ev.type === 'signed-in') note(`[points] ${login}: chat ${ev.signedIn ? 'shows the points balance' : 'shows no points (signed out in the frame, or the channel has no points)'}`);
      else if (ev.type === 'claim-clicked') appLog(`[points] ${login}: clicked Claim Bonus`);
      else if (ev.type === 'claimed') appLog(`[points] ${login}: claimed bonus ${ev.amount != null ? `+${ev.amount}` : '(amount not seen)'}, balance ${ev.balance}`);
      else if (ev.type === 'prediction' || ev.type === 'poll') { appLog(`[points] ${login}: ${ev.type} shown`); send('points:event', { login, ...ev }); }
    }
    send('points:state', { login, ...state });
  };
  ipcMain.handle('points:watch', (_e, login) => {
    const l = login && /^[a-z0-9_]{1,25}$/i.test(String(login)) ? String(login).toLowerCase() : null;
    if (l === pointsLogin) return true;
    pointsLogin = l;
    tracker.reset(l);
    pointsNote = '';
    clearInterval(pointsTimer);
    pointsTimer = l ? setInterval(() => scanPoints().catch(() => {}), 4000) : null;
    return true;
  });
  // The rewards view: the renderer shows the chat frame as a large modal; here the rewards popover (or just the chat
  // with the prediction/poll pinned) is opened, fitted to the whole frame and driven by the controller (frame-nav).
  ipcMain.handle('points:openPanel', async (_e, opts = {}) => {
    const frame = pointsLogin && chatFrames(pointsLogin)[0];
    if (!frame) return { ok: false, reason: 'chat not loaded' };
    try {
      await frame.executeJavaScript(navSource(points.NAV_OPTIONS));
      const opened = opts.rewards ? await frame.executeJavaScript(points.openRewardsSource()) : false;
      await frame.executeJavaScript(points.fitRewardsSource());
      // The popover renders after the click; start the focus on its first target once there is one.
      let tries = 0;
      const startNav = () => frame.executeJavaScript('window.__lbFit && window.__lbFit.run(), window.__lbNav ? window.__lbNav.start() : true')
        .then((ok) => { if (!ok && ++tries < 10) setTimeout(startNav, 300); }).catch(() => {});
      setTimeout(startNav, 300);
      appLog(`[points] ${pointsLogin}: panel opened${opts.rewards ? (opened ? ' (rewards)' : ' (rewards button not found)') : ''}`);
      return { ok: true, opened };
    } catch (e) { return { ok: false, reason: e.message }; }
  });
  // D-pad/A go to the page; B returns 'back' when it closed a reward's sub-view, 'close' when the view should close.
  ipcMain.handle('points:pad', async (_e, key) => {
    const frame = pointsLogin && chatFrames(pointsLogin)[0];
    const k = String(key);
    const src = k === 'b' ? backSource() : pressSource(k);
    if (!src) return null;
    if (!frame) return k === 'b' ? 'close' : null;
    try {
      const r = await frame.executeJavaScript(src);
      if (r === 'keyboard') openSteamKeyboard(appLog);
      return r;
    } catch { return k === 'b' ? 'close' : null; }
  });
  ipcMain.handle('points:closePanel', async () => {
    const frame = pointsLogin && chatFrames(pointsLogin)[0];
    if (frame) await frame.executeJavaScript(points.closeRewardsSource()).catch(() => {});
    return true;
  });

  // ---- Drops section: Twitch's inventory page in the renderer's frame, driven with the controller (frame-nav) ----
  ipcMain.handle('drops:status', async () => ({
    signedIn: (await playerStatus(session.defaultSession.cookies)).signedIn,
    lastCheckAt: dropsClaimer && dropsClaimer.lastRunAt, nextCheckAt: dropsClaimer && dropsClaimer.nextAt,
  }));
  ipcMain.handle('drops:open', () => dropsFrame.open());
  ipcMain.handle('drops:pad', (_e, key) => dropsFrame.pad(key));
  ipcMain.handle('drops:close', () => dropsFrame.close());
  ipcMain.handle('drops:progress', () => dropsProgress);

  // ---- follow / unfollow: Twitch's own channel page in a hidden window of the twitch.tv session (follow.js) ----
  // Only on the user's press (unfollow only after Lurkbox's confirmation), one at a time, for the channel they chose.
  let followBusy = false;
  const openFollowPage = async (url, timeoutMs) => {
    const w = new BrowserWindow({
      show: false, width: 1280, height: 900, paintWhenInitiallyHidden: true,
      webPreferences: { session: session.defaultSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const wc = w.webContents;
    wc.setAudioMuted(true);
    wc.setUserAgent(CHROME_UA);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, u) => { if (!/^https:\/\/(www\.)?twitch\.tv\//.test(u)) e.preventDefault(); });
    const page = { eval: (src) => wc.executeJavaScript(src), close: () => { if (!w.isDestroyed()) w.destroy(); } };
    try {
      await Promise.race([wc.loadURL(url), new Promise((_r, rej) => setTimeout(() => rej(new Error('load timed out')), timeoutMs))]);
    } catch (e) { page.close(); throw e; }
    return page;
  };
  ipcMain.handle('follow:run', async (_e, req = {}) => {
    if (followBusy) return { ok: false, reason: 'busy' };
    followBusy = true;
    try {
      return await follow.runFollow({
        login: String(req.login || ''), name: String(req.name || '').slice(0, 60), action: req.action, confirmed: req.confirmed === true,
        hasSession: async () => (await playerStatus(session.defaultSession.cookies)).signedIn,
        openPage: openFollowPage, log: appLog,
      });
    } finally { followBusy = false; }
  });
  // The fallback: the channel's page in the in-app twitch.tv window (TV zoom, controller navigation, B closes), so the
  // user can press Twitch's button themselves.
  ipcMain.handle('follow:openPage', async (_e, login) => {
    const url = follow.channelUrl(String(login || ''));
    if (!url) return false;
    const w = createLoginWindow({ ...loginWindowOpts(), title: 'twitch.tv' });
    w.loadURL(url);
    await new Promise((resolve) => w.on('closed', resolve));
    return true;
  });

  // Watch-time points for the stream on screen (direct engine). The renderer reports once a minute what it plays.
  const minuteMasters = new Map();
  const watchMinutes = new WatchMinutes({
    fetch: (u, o) => net.fetch(u, o),
    log: appLog,
    // A signed-in master per channel, reused for 5 minutes (the variant playlist URLs stay valid).
    master: async (login) => {
      const c = minuteMasters.get(login);
      if (c && Date.now() - c.at < 300000) return c.r;
      const auth = (await session.defaultSession.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }))[0];
      const r = await fetchMaster({ fetch: net.fetch, login, codecs: ['h264'], authToken: auth ? auth.value : null });
      if (r.ok && r.authed) { minuteMasters.clear(); minuteMasters.set(login, { r, at: Date.now() }); }
      return r;
    },
  });
  ipcMain.handle('points:minute', async (_e, m = {}) => {
    const login = m && /^[a-z0-9_]{1,25}$/i.test(String(m.login)) ? String(m.login).toLowerCase() : null;
    if (!login || !/^\d+$/.test(String(m.channelId)) || !/^\d+$/.test(String(m.broadcastId))) return { ok: false, reason: 'bad request' };
    const web = await playerStatus(session.defaultSession.cookies);
    const store = twitch.store();
    const acct = store.accounts[store.active];
    const hiddenMs = hiddenSince ? Date.now() - hiddenSince : (win && !win.isDestroyed() && (win.isMinimized() || !win.isVisible()) ? Infinity : null);
    return watchMinutes.report({
      enabled: settings.get().earnWatchPoints !== false,
      direct: !!m.direct, live: !!m.live, rewound: !!m.rewound, playing: !!m.playing,
      webSignedIn: web.signedIn, sameUser: !!(web.login && acct && acct.login && web.login.toLowerCase() === acct.login.toLowerCase()),
      hiddenMs,
    }, { login, channelId: String(m.channelId), broadcastId: String(m.broadcastId), userId: store.active });
  });

  // Read-only booleans from the embed for debugging subs/Turbo (never values).
  ipcMain.handle('player:probe', async () => {
    const out = { viewerLoggedIn: null, adShowing: null };
    for (const f of playerFrames()) {
      try {
        Object.assign(out, await f.executeJavaScript(`({
          viewerLoggedIn: document.cookie.split('; ').some((c) => c.startsWith('auth-token=') || c.startsWith('login=')),
          adShowing: !!document.querySelector('[data-a-target="video-ad-label"],[data-a-target="video-ad-countdown"],[class*="video-ad"]'),
        })`));
      } catch { /* frame gone */ }
    }
    appLog(`[player] probe viewerLoggedIn=${out.viewerLoggedIn} adShowing=${out.adShowing}`);
    return out;
  });

  twitch.on('state', (s) => send('auth:state', s));
  twitch.on('auth', (ev) => send('auth:event', ev));
}

app.whenReady().then(async () => {
  if (scopeKeeper) scopeKeeper.start();
  if (droppedImModules.length) appLog(`[input] dropped Steam IM module env (${droppedImModules.join(', ')}) to avoid doubled on-screen keyboard input`);
  const dir = app.getPath('userData');
  settings = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
  tokens = new JsonFile(path.join(dir, 'tokens.json'), {});
  playerJar = new CookieJar({ cookies: session.defaultSession.cookies, safeStorage, dir: path.join(dir, 'player-cookies') });
  twitch = new Twitch({
    getSettings: () => settings.get(),
    tokens,
    // Switching accounts swaps the twitch.tv player cookies (each account has its own encrypted jar).
    onSwitch: async (fromId, toId) => {
      try {
        if (fromId && /^\d+$/.test(fromId)) await playerJar.save(fromId);
        if (toId) await playerJar.restore(toId);
        appLog('[accounts] switched; player cookies swapped');
      } catch (e) { appLog(`[accounts] cookie swap failed: ${e.message}`); }
    },
  });

  session.defaultSession.protocol.handle(hlsProxy.SCHEME, hlsProxy.makeHandler({ fetch: (u, o) => net.fetch(u, o), hosts: proxyHosts, log: appLog }));
  await restorePlayerSession().catch((e) => appLog(`[player-cookies] startup check failed: ${e.message}`));

  // Only allow what the embed needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });

  // The Drops section frames Twitch's inventory page, which refuses framing: allow it for that page in Lurkbox's own
  // window only (drops.allowFraming drops X-Frame-Options and CSP frame-ancestors, nothing else).
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['https://www.twitch.tv/drops/inventory*'] }, (d, cb) => {
    const ours = d.resourceType === 'subFrame' && win && !win.isDestroyed() && d.webContentsId === win.webContents.id;
    cb(ours && drops.isInventoryUrl(d.url) ? { responseHeaders: drops.allowFraming(d.responseHeaders) } : {});
  });

  registerIpc();
  // Twitch's chat iframe lives in the default session, so the extensions are loaded there before the window opens.
  chatExt = setupChatExtensions({ ipcMain, ses: session.defaultSession, getSettings: () => settings.get(), dir: path.join(dir, 'extensions'), fetch: (u, o) => net.fetch(u, o), log: appLog });
  await chatExt.loadChatExtensions(session.defaultSession).catch((e) => appLog(`[extensions] startup load failed: ${e.message}`));
  startCompanion(dir);
  // Validate (and refresh if needed) the stored token. A network error is not a
  // sign-out: retry in the background and update the UI when it succeeds.
  const validateWithRetry = async (delay = 5000) => {
    try {
      await twitch.validate();
      twitch.emitState();
    } catch (e) {
      console.warn(`[auth] validation failed (${e.message}); retrying in ${delay / 1000}s`);
      setTimeout(() => validateWithRetry(Math.min(delay * 2, 120000)), delay);
    }
  };
  await validateWithRetry();
  // Twitch asks apps to validate tokens hourly.
  setInterval(() => twitch.validate().then(() => twitch.emitState()).catch(() => {}), 60 * 60 * 1000);

  await createWindow();
  startDropsClaimer();
  logGpu({ log: appLog, hwRequested, config: `config ${gpuConfig}, ozone ${ozoneNote}` }).catch(() => {});
});

/**
 * At startup the active account's twitch.tv web session must be in the default session (the direct engine's signed-in
 * token and the embed both read it). If Chromium lost it (cookie store key changed, or the write never reached disk),
 * restore it from the account's encrypted jar. Logs why, never values.
 */
async function restorePlayerSession() {
  const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : '?';
  // With the basic store (always under Gamescope, and now everywhere) Electron refuses safeStorage unless plain-text
  // mode is allowed, so the per-account jars were never written there. Chromium's cookie DB uses the same fixed key.
  if (backend === 'basic_text' && !safeStorage.isEncryptionAvailable() && typeof safeStorage.setUsePlainTextEncryption === 'function') safeStorage.setUsePlainTextEncryption(true);
  const active = twitch.store().active;
  const live = await playerStatus(session.defaultSession.cookies);
  const jarLogin = active && /^\d+$/.test(active) ? playerJar.peekLogin(active) : null;
  let action = 'nothing to do';
  if (!live.signedIn && jarLogin !== null) {
    const n = await playerJar.restore(active);
    const now = await playerStatus(session.defaultSession.cookies);
    action = now.signedIn ? `restored ${n} cookies from the account's jar` : `jar restore gave no auth-token (${n} cookies set; expired?)`;
    await session.defaultSession.cookies.flushStore().catch(() => {});
  } else if (live.signedIn && active && /^\d+$/.test(active) && jarLogin === null) {
    await playerJar.save(active).catch(() => {});
    action = 'saved the session to the account jar';
  }
  appLog(`[player-cookies] startup: store=${backend}, session auth-token ${live.signedIn ? 'present' : 'missing'}, account jar ${jarLogin !== null ? 'has a web session' : 'none'}, encryption ${safeStorage.isEncryptionAvailable() ? 'available' : 'UNAVAILABLE (jars cannot be saved)'} -> ${action}`);
}

// Steam stops a shortcut with SIGTERM. Quit through Electron so Chromium writes pending cookies (the sign-in) to disk.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    appLog(`[app] ${sig}: quitting`);
    if (!app.isReady()) { app.exit(0); return; }
    session.defaultSession.cookies.flushStore().catch(() => {}).finally(() => app.quit());
    setTimeout(() => app.exit(0), 3000).unref();
  });
}

// Decky companion plugin (decky/): export each follow's notification bell for it, and open the channels it asks for
// (a clicked go-live toast). See notify-export.js and open-request.js.
const { NotifyExporter } = require('./notify-export');
const { OpenRequestWatcher } = require('./open-request');
let openPending = null;
let openRendererReady = false;
function startCompanion(dir) {
  const webAuthToken = async () => {
    const c = (await session.defaultSession.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }))[0];
    return c ? c.value : null;
  };
  new NotifyExporter({ fetch: (u, o) => net.fetch(u, o), getAuthToken: webAuthToken, file: path.join(dir, 'notify-channels.json'), log: appLog }).start();
  const opener = new OpenRequestWatcher({
    dir,
    log: appLog,
    onRequest: (r) => {
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
      if (openRendererReady) send('open:channel', r); else openPending = r;
    },
  });
  openPending = opener.takeNow();
  opener.start();
  ipcMain.handle('open:ready', () => { openRendererReady = true; const r = openPending; openPending = null; return r; });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => server && server.close());
