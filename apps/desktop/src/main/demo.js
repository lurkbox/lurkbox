'use strict';
// Demo mode: LURKBOX_DEMO=1 runs Lurkbox fully offline on made-up data, for the README screenshots
// (`npm run screenshots`) and for trying the UI without an account. main.js hands over to runDemo() before it sets
// anything else up, so none of the real Twitch, Steam or Decky code runs.
//
// - The same preload and window.lurkbox as always; only the IPC handlers behind it are fakes (createDemoHost below):
//   a signed-in made-up account, Helix answered from @lurkbox/core/src/js/demo/helix.js, a fake device code, and
//   direct playback of a generated video (demo-media.js).
// - The renderer installs its own fakes for chat, EventSub and the emote APIs (appInfo.demo, core js/demo/).
// - Pictures, playlists and video segments come from the lbhls://demo/ scheme (registered by main.js for the HLS
//   proxy, which demo mode doesn't use).
// - Network: every request that isn't the local page server or lbhls://demo/ is cancelled, and host names other
//   than localhost don't resolve. Cancelled requests are written to <userData>/demo-blocked.log.
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Demo mode is on only for exactly LURKBOX_DEMO=1. */
function isDemo(env = process.env) {
  return env.LURKBOX_DEMO === '1';
}

const MEDIA_BASE = 'lbhls://demo/';
const QR = (text) => {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
};

/** Loads the core's demo modules (ES modules; require(esm)). */
function coreDemo() {
  return {
    data: require('@lurkbox/core/src/js/demo/data.js'),
    helix: require('@lurkbox/core/src/js/demo/helix.js'),
    images: require('@lurkbox/core/src/js/demo/images.js'),
    settings: require('@lurkbox/core/src/shared/settings.js'),
  };
}

/** Is this URL allowed in demo mode? Only the local page server, the demo media scheme and in-page data. */
function allowedUrl(url, serverUrl) {
  const u = String(url);
  if (/^(data|blob|devtools|chrome|chrome-extension):/.test(u)) return true;
  if (u.startsWith(MEDIA_BASE)) return true;
  if (!serverUrl) return false;
  try {
    const a = new URL(u);
    const s = new URL(serverUrl);
    return a.protocol === 'http:' && a.port === s.port && ['localhost', '127.0.0.1', '[::1]'].includes(a.hostname);
  } catch { return false; }
}

/**
 * The fake host behind the IPC channels the preload uses. Pure apart from the settings file; no network.
 * opts: { settingsFile, signedIn, media: { ok, dir }, now(), send(channel, payload), log(line), version }.
 * Returns { handlers: { channel: (...args) => value }, serveMedia(path) → { status, type, body } }.
 */
function createDemoHost(opts = {}) {
  const { data, helix, images, settings: schema } = coreDemo();
  const demoMedia = require('./demo-media');
  const media = (p) => `${MEDIA_BASE}${p}`;
  const db = data.buildDemoData({ media });
  const send = opts.send || (() => {});
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const startedAt = now();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(opts.settingsFile, 'utf8')); } catch { /* defaults */ }
  let settings = { ...schema.DEFAULT_SETTINGS, ...saved };
  const saveSettings = () => { if (opts.settingsFile) { try { fs.mkdirSync(path.dirname(opts.settingsFile), { recursive: true }); fs.writeFileSync(opts.settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { log(`[demo] settings not saved: ${e.message}`); } } };
  let accounts = opts.signedIn === false ? [] : db.accounts.map((a) => ({ ...a }));
  let active = accounts.length ? accounts[0].id : null;
  let deviceFlow = null;
  const resume = new Map();

  const authState = () => {
    const me = accounts.find((a) => a.id === active) || null;
    return {
      hasClientId: true, signedIn: !!me, needsReauth: false, missingScopes: [],
      user: me ? { id: me.id, login: me.login, display_name: me.display_name, profile_image_url: me.profile_image_url } : null,
      active, accounts: accounts.map((a) => ({ ...a })), deviceFlow,
    };
  };
  const emitAuth = () => send('auth:state', authState());
  const signIn = (id = db.accounts[0].id) => {
    const a = db.accounts.find((x) => x.id === id);
    if (!accounts.some((x) => x.id === id)) accounts.push({ ...a });
    active = id;
    deviceFlow = null;
    emitAuth();
    return a;
  };
  const durationOf = (v) => { const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v.duration || ''); return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0; };
  const gameOf = (login) => {
    const s = db.streams.find((x) => x.user_login === login);
    if (s) return s.game_name;
    const u = db.users.find((x) => x.login === login);
    const g = u && db.gameOf.get(u.id);
    return g ? g.name : null;
  };
  const noMedia = () => ({ ok: false, reason: `demo video unavailable (${(opts.media && opts.media.reason) || 'not rendered'})` });

  const handlers = {
    'app:info': () => ({ windowed: true, gamescope: false, startChannel: opts.startChannel || null, startVod: null, version: opts.version || '0.0.0', defaults: schema.DEFAULT_SETTINGS, demo: { mediaBase: MEDIA_BASE, now: data.DEMO_NOW } }),
    'app:quit': () => { if (opts.quit) opts.quit(); },
    'window:setIcon': () => false,
    'window:toggleFullscreen': () => {},
    'settings:get': () => ({ ...settings }),
    'settings:set': (patch) => {
      settings = { ...settings, ...schema.sanitizeSettings(patch || {}) };
      saveSettings();
      send('settings:changed', { ...settings });
      return { ...settings };
    },
    'auth:state': () => authState(),
    'auth:start': () => {
      deviceFlow = { userCode: data.DEMO_DEVICE_CODE, verificationUri: `https://www.twitch.tv/activate?device-code=${data.DEMO_DEVICE_CODE.replace('-', '')}`, expiresIn: 1800, status: 'pending' };
      emitAuth();
      return { ok: true, flow: deviceFlow };
    },
    'auth:cancel': () => { deviceFlow = null; emitAuth(); },
    'auth:signOut': (id) => { const t = id || active; accounts = accounts.filter((a) => a.id !== t); if (active === t) active = accounts.length ? accounts[0].id : null; emitAuth(); return true; },
    'auth:tvSignIn': () => { const a = signIn(); return { ok: true, id: a.id, login: a.login, plan: 'demo' }; },
    'accounts:status': () => accounts.map((a) => ({ id: a.id, api: true, player: true, playerLogin: a.login })), // shown as fully signed in
    'auth:switch': (id) => { if (accounts.some((a) => a.id === String(id))) { active = String(id); emitAuth(); } return authState(); },
    'auth:remove': (id) => handlers['auth:signOut'](String(id)),
    helix: (req) => {
      if (!active) return { ok: false, status: 401, error: 'NOT_SIGNED_IN', data: null, resetAt: null };
      return helix.demoHelix(db, req || {}, { activeId: active });
    },
    'qr:svg': (text) => QR(text),
    'player:dismissGate': () => '',
    'log:write': (line) => log(String(line).slice(0, 2000)),
    'player-session:status': () => ({ signedIn: false, login: null, mismatch: null }),
    'player-session:login': () => ({ ok: false, signedIn: false, login: null, mismatch: null, error: 'demo mode' }),
    'player-session:signOut': () => ({ signedIn: false, login: null, mismatch: null }),
    'player:probe': () => ({ viewerLoggedIn: null, adShowing: null }),
    'direct:master': (req = {}) => {
      if (!opts.media || !opts.media.ok) return noMedia();
      if (req.login) {
        const s = db.streams.find((x) => x.user_login === String(req.login).toLowerCase());
        if (!s) return { ok: false, reason: 'offline', offline: true };
        return { ok: true, master: demoMedia.masterPlaylist(media(`hls/live/${s.user_login}.m3u8`)), authed: true };
      }
      const v = db.videos.find((x) => x.id === String(req.vodId));
      if (!v) return { ok: false, reason: 'usher HTTP 404' };
      return { ok: true, master: demoMedia.masterPlaylist(media(`hls/vod/${v.id}.m3u8`)), authed: true };
    },
    'direct:liveInfo': () => null,
    'direct:storyboard': (vodId) => {
      const v = db.videos.find((x) => x.id === String(vodId));
      if (!v || !opts.media || !opts.media.ok) return null;
      return demoMedia.storyboardFor(durationOf(v), media('hls/storyboard.jpg'));
    },
    'resume:get': (id) => resume.get(String(id)) || null,
    'resume:set': (id, position, duration) => { if (position > 0) resume.set(String(id), { position, duration, at: now() }); else resume.delete(String(id)); return true; },
    'points:watch': () => true,
    'points:openPanel': () => ({ ok: false, reason: 'not in demo mode' }),
    'points:pad': () => null,
    'points:closePanel': () => true,
    'points:minute': () => ({ ok: false, reason: 'demo mode' }),
    'drops:status': () => ({ signedIn: false, lastCheckAt: null, nextCheckAt: null }),
    'drops:open': () => ({ ok: false, reason: 'not in demo mode' }),
    'drops:pad': () => null,
    'drops:close': () => true,
    'drops:progress': () => ({ checkedAt: null, campaigns: [] }),
    'steam-art:apply': () => ({ ok: false, error: 'not in demo mode' }),
    'steam-art:restore': () => ({ ok: false, error: 'not in demo mode' }),
    'open:ready': () => null,
    'chatext:status': () => [],
    'chatext:update': () => [],
  };

  /** lbhls://demo/<path> → { status, type, body }. */
  function serveMedia(p) {
    const rel = String(p).replace(/^\/+/, '').split('?')[0];
    if (rel.startsWith('img/')) {
      const svg = images.demoImage(rel, { gameOf });
      return svg ? { status: 200, type: 'image/svg+xml', body: svg } : { status: 404, type: 'text/plain', body: 'not found' };
    }
    let m;
    const segBase = media('hls/');
    if ((m = /^hls\/live\/([a-z0-9_]+)\.m3u8$/.exec(rel))) {
      const elapsed = 60 + (now() - startedAt) / 1000;
      return { status: 200, type: 'application/vnd.apple.mpegurl', body: demoMedia.livePlaylist({ elapsedSec: elapsed, segBase }) };
    }
    if ((m = /^hls\/vod\/(\d+)\.m3u8$/.exec(rel))) {
      const v = db.videos.find((x) => x.id === m[1]);
      if (!v) return { status: 404, type: 'text/plain', body: 'not found' };
      // An archive still being recorded grows with the stream; the others have their Helix duration.
      const live = v.stream_id && db.streams.some((s) => s.id === v.stream_id);
      const dur = durationOf(v) + (live ? (now() - startedAt) / 1000 : 0);
      return { status: 200, type: 'application/vnd.apple.mpegurl', body: demoMedia.vodPlaylist({ durationSec: dur, segBase }) };
    }
    if (opts.media && opts.media.ok && (m = /^hls\/(seg\d{3}\.ts|storyboard\.jpg)$/.exec(rel))) {
      try {
        return { status: 200, type: m[1].endsWith('.ts') ? 'video/mp2t' : 'image/jpeg', body: fs.readFileSync(path.join(opts.media.dir, m[1])) };
      } catch { /* below */ }
    }
    return { status: 404, type: 'text/plain', body: 'not found' };
  }

  return { handlers, serveMedia, db, authState };
}

/** Where the demo video is cached (rendered once per version). */
function mediaDir() {
  return process.env.LURKBOX_DEMO_MEDIA || path.join(os.tmpdir(), `lurkbox-demo-media-${require('./demo-media').VERSION}`);
}

/**
 * Runs the app in demo mode. Called by main.js at startup instead of the normal setup.
 * LURKBOX_DEMO_SIZE=<w>x<h> sets the window's content size (default 1280x800, the Steam Deck / Game Mode size);
 * LURKBOX_DEMO_SIGNED_OUT=1 starts signed out (welcome screen).
 */
function runDemo({ argv = process.argv.slice(1) } = {}) {
  const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
  const { startServer } = require('./server');
  const { WEB_ROOT, ASSETS_DIR, HLS_JS } = require('./paths');
  const userData = process.env.LURKBOX_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-demo-'));
  app.setPath('userData', userData);
  // No name resolution except the page server: a missed request can't reach the internet.
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
  app.commandLine.appendSwitch('lang', 'en-US');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,Translate');
  const [w, h] = (/^(\d+)x(\d+)$/.exec(process.env.LURKBOX_DEMO_SIZE || '') || [0, 1280, 800]).slice(1).map(Number);
  const logFile = path.join(userData, 'lurkbox.log');
  const blockedFile = path.join(userData, 'demo-blocked.log');
  const log = (line) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ } if (process.env.LURKBOX_DEBUG) console.log(line); };
  let win = null;
  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  const argValue = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

  app.whenReady().then(async () => {
    const { ensureDemoMedia } = require('./demo-media');
    const { images } = coreDemo();
    const media = ensureDemoMedia(mediaDir(), { sceneSvg: images.videoSceneSvg(), runnerSvg: images.runnerSvg(), log: (l) => { log(l); console.log(l); } });
    const host = createDemoHost({
      settingsFile: path.join(userData, 'settings.json'),
      signedIn: process.env.LURKBOX_DEMO_SIGNED_OUT !== '1',
      media, send, log, version: app.getVersion(),
      startChannel: (argValue('channel') || '').toLowerCase() || null,
      quit: () => app.quit(),
    });
    const server = await startServer(WEB_ROOT, {
      '/vendor/hls.min.js': HLS_JS,
      '/vendor/wordmark.json': path.join(ASSETS_DIR, 'src', 'wordmark.json'),
    });
    const ses = session.defaultSession;
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (allowedUrl(details.url, server.url)) { cb({}); return; }
      const line = `${details.resourceType} ${details.url.slice(0, 200)}`;
      log(`[demo] blocked ${line}`);
      try { fs.appendFileSync(blockedFile, `${line}\n`); } catch { /* ignore */ }
      cb({ cancel: true });
    });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.protocol.handle('lbhls', (req) => {
      const u = new URL(req.url);
      const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
      if (u.host !== 'demo') return new Response('not allowed', { status: 403, headers: cors });
      const r = host.serveMedia(u.pathname);
      return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.type } });
    });
    for (const [ch, fn] of Object.entries(host.handlers)) ipcMain.handle(ch, (_e, ...args) => fn(...args));
    ipcMain.on('player-login:pad', () => {});

    win = new BrowserWindow({
      width: w, height: h, useContentSize: true, resizable: true, backgroundColor: '#081719', autoHideMenuBar: true,
      title: 'Lurkbox (demo)', icon: path.join(ASSETS_DIR, 'icons', '256x256.png'), show: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    Menu.setApplicationMenu(null);
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => { if (!url.startsWith(server.url)) e.preventDefault(); });
    wc.on('console-message', (e) => {
      if (e.level === 'error' || process.env.LURKBOX_DEBUG) console.log(`[renderer] ${e.message.slice(0, 400)}`);
    });
    win.on('focus', () => send('window:focus', true));
    win.on('blur', () => send('window:focus', false));
    win.once('ready-to-show', () => win.show());
    app.on('window-all-closed', () => app.quit());
    app.on('will-quit', () => server.close());
    console.log(`[demo] Lurkbox demo mode (fake data, no network): ${server.url}, user data ${userData}${media.ok ? '' : `; ${media.reason}`}`);
    await win.loadURL(server.url);
  });
}

module.exports = { isDemo, runDemo, createDemoHost, allowedUrl, MEDIA_BASE };
