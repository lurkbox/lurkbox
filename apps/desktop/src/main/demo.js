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
// LURKBOX_DEMO_TOUCH=1: the touch layouts' screenshots (AppInfo.touch, and the page treats the pointer as a touchscreen).
const DEMO_TOUCH = process.env.LURKBOX_DEMO_TOUCH === '1';
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
    whispers: require('@lurkbox/core/src/js/demo/whispers.js'),
    images: require('@lurkbox/core/src/js/demo/images.js'),
    settings: require('@lurkbox/core/src/shared/settings.js'),
    predictions: require('@lurkbox/core/src/js/demo/predictions.js'),
    vodChat: require('@lurkbox/core/src/js/demo/vod-chat.js'),
  };
}

/**
 * The first demo account's Continue watching row: a few past broadcasts part-watched over the last days (newest
 * first), plus ones the row leaves out (finished, too old, barely started) and one Twitch "deleted" (gone from Helix,
 * so the row drops it on load).
 */
function seedContinueWatching(store, db, accountId, durationOf) {
  if (!accountId) return;
  const DAY = 86400000;
  const past = db.videos.filter((v) => v.type === 'archive' && !v.stream_id);
  const pick = (i) => past[(i * 7) % past.length];
  const meta = (v) => ({ title: v.title, login: v.user_login, name: v.user_name, userId: v.user_id, thumb: v.thumbnail_url });
  const clock = store.now;
  const put = (v, frac, ago) => {
    const dur = durationOf(v);
    store.now = () => db.now - ago; // watched that long ago
    store.set(accountId, v.id, Math.round(dur * frac), dur, meta(v));
    store.now = clock;
  };
  // Shown: [fraction watched, how long ago].
  [[0.62, 2 * 3600e3], [0.18, 20 * 3600e3], [0.41, 2 * DAY], [0.83, 4 * DAY], [0.07, 6 * DAY], [0.55, 9 * DAY]].forEach(([f, ago], i) => put(pick(i), f, ago));
  put(pick(6), 0.97, 3 * 3600e3); // finished
  put(pick(7), 0.5, 40 * DAY); // older than 30 days
  store.set(accountId, '2299999999', 1800, 7200, { title: 'A deleted broadcast', login: past[0].user_login, name: past[0].user_name, thumb: past[0].thumbnail_url });
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
 * GitHub's release API and downloads for the demo's update check (updater.js), in memory: the latest release is
 * `version` with an AppImage (`appImage` bytes, behind a redirect to the asset host as on GitHub), an APK and
 * SHA256SUMS.txt. Answers like the real hop: one request, redirects returned with their Location.
 */
function demoUpdateHop({ version, appImage }) {
  const crypto = require('crypto');
  const updates = require('@lurkbox/core/src/shared/updates.js');
  const tag = `v${version}`;
  const base = `https://github.com/lurkbox/lurkbox/releases/download/${tag}/`;
  const files = { [`Lurkbox-${version}-x86_64.AppImage`]: appImage, [`Lurkbox-${version}-android.apk`]: Buffer.from('demo apk') };
  const sums = Object.entries(files).map(([n, b]) => `${crypto.createHash('sha256').update(b).digest('hex')}  ${n}`).join('\n') + '\n';
  files['SHA256SUMS.txt'] = Buffer.from(sums);
  const release = {
    tag_name: tag, name: `Lurkbox ${tag}`, html_url: `https://github.com/lurkbox/lurkbox/releases/tag/${tag}`, draft: false, prerelease: false,
    published_at: '2026-11-20T12:00:00Z',
    assets: Object.entries(files).map(([name, b]) => ({ name, size: b.length, browser_download_url: base + name })),
  };
  return async (url) => {
    const u = new URL(url);
    if (url === updates.RELEASES_API) return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json', etag: `"demo-${version}"` } });
    if (u.hostname === 'github.com' && u.pathname.startsWith(new URL(base).pathname)) {
      const name = decodeURIComponent(u.pathname.slice(new URL(base).pathname.length));
      if (files[name]) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/demo/${encodeURIComponent(name)}?sig=demo` } });
    }
    if (u.hostname === 'release-assets.githubusercontent.com') {
      const name = decodeURIComponent(u.pathname.replace(/^\/demo\//, ''));
      if (files[name]) return new Response(files[name], { status: 200, headers: { 'content-length': String(files[name].length), 'content-type': 'application/octet-stream' } });
    }
    return new Response('not found', { status: 404 });
  };
}

/**
 * The demo's updater: the real one (updater.js) over demoUpdateHop. LURKBOX_DEMO_UPDATE=1 makes the latest release a
 * minor version newer, so the toast, Settings → About and the AppImage download show (off by default, so screenshots
 * and other tests aren't interrupted); the "running AppImage" is <dir>/Lurkbox-demo.AppImage, and the restart only logs.
 */
function createDemoUpdater({ dir, version, getSettings, send, log }) {
  const { createUpdater } = require('./updater');
  const v = /^(\d+)\.(\d+)\.\d+/.exec(version);
  const newer = process.env.LURKBOX_DEMO_UPDATE === '1';
  const latest = newer ? `${v[1]}.${Number(v[2]) + 1}.0` : version;
  const target = dir ? path.join(dir, 'Lurkbox-demo.AppImage') : null;
  if (target && !fs.existsSync(target)) fs.writeFileSync(target, 'the running demo AppImage', { mode: 0o755 });
  return createUpdater({
    hop: demoUpdateHop({ version: latest, appImage: Buffer.from(`#!/bin/sh\n# Lurkbox ${latest} (demo)\n`) }),
    current: version,
    cacheFile: dir ? path.join(dir, 'update-check.json') : path.join(os.tmpdir(), `lurkbox-demo-update-${process.pid}.json`),
    getSettings, onState: (st) => send('update:state', st), log,
    env: target ? { APPIMAGE: target } : {},
    relaunch: () => log('[demo] the update would restart Lurkbox now'),
    startDelay: 1500,
  });
}

/**
 * The fake host behind the IPC channels the preload uses. Pure apart from the settings file; no network.
 * opts: { settingsFile, signedIn, media: { ok, dir }, now(), send(channel, payload), log(line), version }.
 * Returns { handlers: { channel: (...args) => value }, serveMedia(path) → { status, type, body } }.
 */
function createDemoHost(opts = {}) {
  const { data, helix, images, whispers: demoWhispers, settings: schema, predictions: demoPredictions, vodChat: demoVodChat } = coreDemo();
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
  // Resume positions: the real store, in memory, on the demo clock; seeded with a Continue watching row.
  const demoNow = () => data.DEMO_NOW + (now() - startedAt);
  const resume = new (require('./resume').ResumeStore)(null, { now: demoNow });
  const emoteIndex = new (require('./emote-index').EmoteIndexStore)(null); // in memory, like the resume positions

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
  seedContinueWatching(resume, db, accounts.length ? db.accounts[0].id : null, durationOf);
  // Whisper history: the real store, in memory, seeded for the first account.
  const whisperStore = new (require('./whispers').WhisperStore)(null);
  if (accounts.length) whisperStore.save(db.accounts[0].id, demoWhispers.demoWhisperThreads(db, db.accounts[0].id, data.DEMO_NOW));
  const updater = createDemoUpdater({ dir: opts.updateDir || null, version: opts.version || '0.0.0', getSettings: () => settings, send, log });
  if (opts.updateDir) updater.start();
  // Predictions and polls (LURKBOX_DEMO_PREDICTIONS=1; off by default so other screenshots stay as they are): the real
  // watcher over made-up GQL answers; bets and votes go straight into them.
  const ppShared = require('@lurkbox/core/src/shared/predictions.js');
  const ppDemo = demoPredictions.createDemoPredictions({ now: demoNow });
  const ppOn = process.env.LURKBOX_DEMO_PREDICTIONS === '1';
  const ppWatcher = new ppShared.PredictionsWatcher({
    query: async (login) => (ppOn && db.streams.some((x) => x.user_login === login) ? ppDemo.answer(login) : { data: { channel: { activePredictionEvents: [], lockedPredictionEvents: [], resolvedPredictionEvents: { edges: [] } }, user: { viewablePoll: null } } }),
    onState: (st) => send('predictions:state', st), log, now: demoNow, fastMs: 2000,
  });
  const noMedia = () => ({ ok: false, reason: `demo video unavailable (${(opts.media && opts.media.reason) || 'not rendered'})` });

  const handlers = {
    'app:info': () => ({ windowed: true, gamescope: false, startChannel: opts.startChannel || null, startVod: null, version: opts.version || '0.0.0', defaults: schema.DEFAULT_SETTINGS, demo: { mediaBase: MEDIA_BASE, now: data.DEMO_NOW, touch: DEMO_TOUCH, whisperInMs: Math.max(0, Number(process.env.LURKBOX_DEMO_WHISPER_IN) || 0) * 1000 }, ...(DEMO_TOUCH ? { touch: true } : {}) }),
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
      return helix.demoHelix(db, req || {}, { activeId: active, now: () => data.DEMO_NOW + (now() - startedAt) }); // the renderer's demo clock
    },
    'qr:svg': (text) => QR(text),
    'keyboard:open': () => false, // the built-in keyboard (no Steam in demo mode)
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
    // Clips: the demo MP4 of the clip's length, in the qualities a real clip has (all the same file).
    'direct:clip': (slug) => {
      const c = db.clips.find((x) => x.id === String(slug));
      if (!c) return { ok: false, reason: 'not-found' };
      if (!opts.media || !opts.media.ok) return noMedia();
      const len = demoMedia.clipLength(c.duration);
      return { ok: true, qualities: [['1080', 60], ['720', 60], ['480', 30], ['360', 30]].map(([q, fps]) => ({ quality: q, frameRate: fps, url: media(`hls/clip${len}.mp4?q=${q}&sig=demo&token=demo`) })) };
    },
    // VOD chat replay: made-up comments every 2.5 s of the video, through the real parser.
    'direct:vodComments': (req = {}) => {
      const v = db.videos.find((x) => x.id === String(req.videoId));
      if (!v) return { ok: false, reason: 'not-found' };
      const json = demoVodChat.demoComments({ videoId: v.id, offset: req.offset, cursor: req.cursor || null, durationSec: durationOf(v) || 3600, roomId: v.user_id });
      return require('@lurkbox/core/src/shared/vod-chat.js').parseComments(json);
    },
    'direct:storyboard': (vodId) => {
      const v = db.videos.find((x) => x.id === String(vodId));
      if (!v || !opts.media || !opts.media.ok) return null;
      return demoMedia.storyboardFor(durationOf(v), media('hls/storyboard.jpg'));
    },
    'resume:get': (id) => resume.get(active, String(id)),
    'resume:set': (id, position, duration, meta) => resume.set(active, String(id), position, duration, meta),
    'resume:list': () => resume.list(active),
    'resume:clear': () => resume.clear(active),
    'whispers:load': (id) => whisperStore.load(String(id)),
    'whispers:save': (id, threads) => whisperStore.save(String(id), threads),
    'emote-index:get': () => emoteIndex.get(active),
    'emote-index:set': (index) => emoteIndex.set(active, index),
    // With the demo's predictions on, the watched channel shows a points balance too (for the amount chooser).
    'points:watch': () => true,
    'points:openPanel': () => ({ ok: false, reason: 'not in demo mode' }),
    'points:pad': () => null,
    'points:closePanel': () => true,
    'points:mode': () => true,
    // With the demo's predictions on, the watched channel shows a points balance too (for the amount chooser).
    'predictions:watch': (login) => {
      ppWatcher.watch(login);
      if (ppOn && login) setTimeout(() => send('points:state', { login: String(login).toLowerCase(), signedIn: true, balance: 12480, prediction: null, poll: null }), 300);
      return true;
    },
    'predictions:bet': (req = {}) => {
      if (!ppWatcher.state.prediction || ppWatcher.state.login !== String(req.login || '').toLowerCase()) return { ok: false, reason: 'not open' };
      const r = ppDemo.bet(req.login, String(req.outcomeId), Math.floor(Number(req.points)) || 0);
      ppWatcher.kick();
      return r;
    },
    'poll:vote': (req = {}) => {
      if (!ppWatcher.state.poll || ppWatcher.state.login !== String(req.login || '').toLowerCase()) return { ok: false, reason: 'not open' };
      const r = ppDemo.vote(req.login, String(req.choiceId), !!req.points);
      ppWatcher.kick();
      return r;
    },
    'points:minute': () => ({ ok: false, reason: 'demo mode' }),
    'drops:status': () => ({ signedIn: false, lastCheckAt: null, nextCheckAt: null }),
    'drops:open': () => ({ ok: false, reason: 'not in demo mode' }),
    'drops:pad': () => null,
    'drops:close': () => true,
    'drops:progress': () => ({ checkedAt: null, campaigns: [] }),
    'follow:run': () => ({ ok: false, reason: 'no-session' }),
    'follow:openPage': () => false,
    'steam-art:apply': () => ({ ok: false, error: 'not in demo mode' }),
    'steam-art:restore': () => ({ ok: false, error: 'not in demo mode' }),
    'open:ready': () => null,
    'chatext:status': () => [],
    'chatext:update': () => [],
    'update:state': () => updater.state(),
    'update:check': () => updater.check(),
    'update:download': () => updater.download(),
    'update:install': () => updater.install(),
  };

  /** lbhls://demo/<path> → { status, type, body, headers? }. range: the request's Range header (MP4 clips seek with it). */
  function serveMedia(p, { range = null } = {}) {
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
    if (opts.media && opts.media.ok && (m = /^hls\/(clip\d+\.mp4)$/.exec(rel))) {
      let body;
      try { body = fs.readFileSync(path.join(opts.media.dir, m[1])); } catch { return { status: 404, type: 'text/plain', body: 'not found' }; }
      const r = /^bytes=(\d*)-(\d*)$/.exec(String(range || ''));
      if (!r || (r[1] === '' && r[2] === '')) return { status: 200, type: 'video/mp4', body, headers: { 'accept-ranges': 'bytes', 'content-length': String(body.length) } };
      const start = r[1] === '' ? Math.max(0, body.length - Number(r[2])) : Number(r[1]);
      const end = r[1] === '' || r[2] === '' ? body.length - 1 : Math.min(body.length - 1, Number(r[2]));
      if (start >= body.length || start > end) return { status: 416, type: 'text/plain', body: '', headers: { 'content-range': `bytes */${body.length}` } };
      return { status: 206, type: 'video/mp4', body: body.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1) } };
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
      // Electron reports "0.0" when started on a test script rather than the app folder: the package's version then.
      media, send, log, version: /^\d+\.\d+\.\d+/.test(app.getVersion()) ? app.getVersion() : require('../../package.json').version, updateDir: userData,
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
      const r = host.serveMedia(u.pathname, { range: req.headers.get('range') });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.type, ...(r.headers || {}) } });
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

module.exports = { demoUpdateHop, isDemo, runDemo, createDemoHost, allowedUrl, MEDIA_BASE };
