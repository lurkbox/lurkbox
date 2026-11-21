'use strict';
// "Match Steam library artwork to theme" (Settings → Appearance, opt-in).
//
// The renderer rasterises themed PNGs; this module writes them to Steam's grid folder and, when Steam's CEF
// remote debugging is on (Decky Loader enables it), updates the library live through SteamClient.Apps.* in the
// SharedJSContext target. That is Steam's internal, undocumented client interface and may break with Steam updates.
//
// Safety: only the fixed function declarations in buildCall() are ever sent over CDP, called with validated arguments
// (numeric appid, asset type, base64 image, image path). Nothing else is evaluated.
//
// Memory (2026-11-21: steamwebhelper grew to 4.5 GB and froze Game Mode after 8 live applies): image data used to be
// inlined into Runtime.evaluate source, and DevTools keeps every evaluated script's source alive. Now image data is a
// call ARGUMENT (Runtime.callFunctionOn, released after each apply), the images are small (JPEG capsule/wide/hero),
// the hero is never sent live (file only; Steam shows it after a restart), unchanged themes are skipped, live applies
// are at least 60 s apart, and the CDP connection is closed after each apply.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'Lurkbox';

// SteamClient.Apps.SetCustomArtworkForApp asset types. Believed numbering (the one decky-steamgriddb uses); not
// verified against the Steam client from here. If Steam renumbers them, this table is the only place to change.
const ASSET_TYPES = Object.freeze({ capsule: 0, hero: 1, logo: 2, wide: 3 });
const ASSETS = Object.freeze(['capsule', 'wide', 'hero', 'logo']);

// Assets updated live through CDP. The hero (3840x1240) is written to the grid folder only.
const LIVE_ASSETS = Object.freeze(['capsule', 'wide', 'logo']);
const MIN_LIVE_INTERVAL_MS = 60000;
const EXTS = ['png', 'jpg'];

/** Grid file name for each asset (the icon is ours, pointed at with SetShortcutIcon). ext: 'png' | 'jpg'. */
function gridName(appid, asset, ext = 'png') {
  const a = checkAppId(appid);
  if (!EXTS.includes(ext)) throw new Error('bad extension');
  switch (asset) {
    case 'capsule': return `${a}p.${ext}`;
    case 'wide': return `${a}.${ext}`;
    case 'hero': return `${a}_hero.${ext}`;
    case 'logo': return `${a}_logo.${ext}`;
    case 'icon': return `${a}_icon.${ext}`;
    default: throw new Error(`unknown asset ${asset}`);
  }
}

// ---- appid ----

let CRC_TABLE = null;
function crc32(str) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of Buffer.from(String(str), 'utf8')) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Steam's non-Steam shortcut appid: crc32('"<exe>"' + name) | 0x80000000 (unsigned). */
function shortcutAppId(exe, name = NAME) {
  return (crc32(`"${exe}"${name}`) | 0x80000000) >>> 0;
}

/**
 * Lurkbox's own appid. Prefers SteamGameId (a 64-bit game id whose high 32 bits are the shortcut appid), then
 * the AppImage path. Returns { appid, source } or null.
 */
function appIdFromEnv(env = process.env) {
  const g = String(env.SteamGameId || '').trim();
  if (/^\d{1,20}$/.test(g)) {
    const id = Number(BigInt(g) >> 32n);
    if (id > 0 && id <= 0xffffffff) return { appid: id, source: 'SteamGameId' };
  }
  if (env.APPIMAGE && path.isAbsolute(env.APPIMAGE)) return { appid: shortcutAppId(env.APPIMAGE), source: 'APPIMAGE' };
  return null;
}

// ---- shortcuts.vdf (binary KeyValues) ----

function parseVdf(b, i = 0) {
  const d = {};
  while (i < b.length) {
    const t = b[i++];
    if (t === 8) return [d, i];
    const j = b.indexOf(0, i);
    if (j < 0) throw new Error('bad vdf');
    const k = b.toString('utf8', i, j);
    i = j + 1;
    if (t === 0) { [d[k], i] = parseVdf(b, i); }
    else if (t === 1) { const e = b.indexOf(0, i); if (e < 0) throw new Error('bad vdf'); d[k] = b.toString('utf8', i, e); i = e + 1; }
    else if (t === 2) { d[k] = b.readInt32LE(i); i += 4; }
    else if (t === 7) { d[k] = b.readBigUInt64LE(i); i += 8; }
    else throw new Error(`unknown vdf type ${t}`);
  }
  return [d, i];
}

/** The "Lurkbox" entry of a shortcuts.vdf buffer, or null. */
function lurkboxShortcut(buf) {
  try {
    const sc = (parseVdf(buf)[0].shortcuts) || {};
    const e = Object.values(sc).find((x) => x && (x.AppName || x.appname) === NAME);
    if (!e) return null;
    return { appid: typeof e.appid === 'number' ? e.appid >>> 0 : null, icon: typeof e.icon === 'string' ? e.icon : '', exe: e.Exe || e.exe || '' };
  } catch { return null; }
}

function steamRoot(env = process.env) {
  if (env.LURKBOX_STEAM_ROOT) return env.LURKBOX_STEAM_ROOT;
  const a = path.join(os.homedir(), '.local', 'share', 'Steam');
  return fs.existsSync(a) ? a : path.join(os.homedir(), '.steam', 'steam');
}

/** The userdata/<id> whose config/shortcuts.vdf mentions Lurkbox (prefers one whose entry has `appid`). */
function findUserdata(root, appid) {
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(root, 'userdata')).filter((d) => /^\d+$/.test(d)); } catch { return null; }
  const found = [];
  for (const id of dirs) {
    const vdf = path.join(root, 'userdata', id, 'config', 'shortcuts.vdf');
    let buf;
    try { buf = fs.readFileSync(vdf); } catch { continue; }
    if (!buf.includes(NAME)) continue;
    const entry = lurkboxShortcut(buf);
    found.push({ id, config: path.join(root, 'userdata', id, 'config'), entry, mtime: fs.statSync(vdf).mtimeMs });
  }
  if (!found.length) return null;
  return found.find((f) => appid && f.entry && f.entry.appid === appid) || found.sort((a, b) => b.mtime - a.mtime)[0];
}

// ---- CDP expressions (allow-list) ----

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_B64 = 24 * 1024 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._\-/ ]+\.png$/;

function checkAppId(appid) {
  if (!Number.isInteger(appid) || appid <= 0 || appid > 0xffffffff) throw new Error('bad appid');
  return appid;
}
function checkType(t) {
  if (!Object.values(ASSET_TYPES).includes(t)) throw new Error('bad asset type');
  return t;
}
function checkB64(s) {
  if (typeof s !== 'string' || !s.length || s.length > MAX_B64 || s.length % 4 !== 0 || !B64.test(s)) throw new Error('bad base64');
  return s;
}
function checkPath(p) {
  if (typeof p !== 'string' || p.length > 1024 || !SAFE_PATH.test(p) || p.split('/').includes('..')) throw new Error('bad path');
  return p;
}

const FUNCTIONS = Object.freeze({
  setArtwork: 'function (appid, data, ext, type) { return SteamClient.Apps.SetCustomArtworkForApp(appid, data, ext, type); }',
  clearArtwork: 'function (appid, type) { return SteamClient.Apps.ClearCustomArtworkForApp(appid, type); }',
  setIcon: 'function (appid, path) { return SteamClient.Apps.SetShortcutIcon(appid, path); }',
});

/**
 * The only calls ever sent to Steam: a fixed function declaration plus validated arguments. `call` is one of:
 *   { fn: 'setArtwork', appid, base64, ext, assetType } → SteamClient.Apps.SetCustomArtworkForApp(appid, b64, ext, t)
 *   { fn: 'clearArtwork', appid, assetType }            → SteamClient.Apps.ClearCustomArtworkForApp(appid, t)
 *   { fn: 'setIcon', appid, path }                      → SteamClient.Apps.SetShortcutIcon(appid, path)
 * Returns { functionDeclaration, args }. Throws on anything else.
 */
function buildCall(call) {
  if (!call || typeof call !== 'object') throw new Error('bad call');
  const a = checkAppId(call.appid);
  switch (call.fn) {
    case 'setArtwork': {
      const ext = call.ext === undefined ? 'png' : call.ext;
      if (!EXTS.includes(ext)) throw new Error('bad extension');
      return { functionDeclaration: FUNCTIONS.setArtwork, args: [a, checkB64(call.base64), ext, checkType(call.assetType)] };
    }
    case 'clearArtwork': return { functionDeclaration: FUNCTIONS.clearArtwork, args: [a, checkType(call.assetType)] };
    case 'setIcon': return { functionDeclaration: FUNCTIONS.setIcon, args: [a, checkPath(call.path)] };
    default: throw new Error('call not allowed');
  }
}

// ---- CDP client ----

/**
 * Connects to Steam's SharedJSContext over CDP if it is listening on 127.0.0.1:8080. Returns null if not.
 * The returned `run(call)` only accepts call objects (see buildExpression), never raw expressions.
 */
async function openSteamContext({ fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, port = 8080, timeoutMs = 3000 } = {}) {
  if (!fetch || !WebSocket) return null;
  let list;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    list = await r.json();
  } catch { return null; }
  const t = Array.isArray(list) && list.find((x) => x && x.title === 'SharedJSContext' && typeof x.webSocketDebuggerUrl === 'string');
  if (!t) return null;
  let u;
  try { u = new URL(t.webSocketDebuggerUrl); } catch { return null; }
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;

  const ws = new WebSocket(u.href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); });
  });
  let nextId = 1;
  const pending = new Map();
  const GROUP = 'lurkbox-art';
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    const p = m && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    const ex = m.error || (m.result && m.result.exceptionDetails);
    if (ex) p.reject(new Error(`Steam: ${(ex.exception && ex.exception.description) || ex.text || ex.message || 'error'}`.slice(0, 300)));
    else p.resolve(m.result && m.result.result ? (p.raw ? m.result.result : m.result.result.value) : undefined);
  });
  const send = (method, params, raw = false) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 15000);
      pending.set(id, { resolve, reject, timer, raw });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  let global = null;
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP closed')); } pending.clear(); });
  return {
    async run(call) {
      const { functionDeclaration, args } = buildCall(call);
      if (!global) {
        const g = await send('Runtime.evaluate', { expression: 'globalThis', objectGroup: GROUP }, true);
        if (!g || !g.objectId) throw new Error('Steam: no global object');
        global = g.objectId;
      }
      return send('Runtime.callFunctionOn', {
        objectId: global, functionDeclaration, arguments: args.map((value) => ({ value })),
        objectGroup: GROUP, awaitPromise: true, returnByValue: true, silent: true,
      });
    },
    async close() {
      // Let Steam's GC free the arguments, then detach.
      try { if (global) await send('Runtime.releaseObjectGroup', { objectGroup: GROUP }); } catch { /* closing anyway */ }
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

// ---- files ----

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const MAX_PNG = 16 * 1024 * 1024;

/** Validates a PNG data URL or bare base64 string from the renderer; returns { b64, buf, ext: 'png' }. */
function pngFrom(input) {
  const s = typeof input === 'string' ? input.replace(/^data:image\/png;base64,/, '') : '';
  checkB64(s);
  const buf = Buffer.from(s, 'base64');
  if (buf.length > MAX_PNG || buf.length < PNG_SIG.length || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  return { b64: s, buf, ext: 'png' };
}

/** A PNG or JPEG data URL; returns { b64, buf, ext }. */
function imageFrom(input) {
  if (typeof input === 'string' && input.startsWith('data:image/jpeg;base64,')) {
    const s = input.slice(23);
    checkB64(s);
    const buf = Buffer.from(s, 'base64');
    if (buf.length > MAX_PNG || !buf.subarray(0, 3).equals(JPG_SIG)) throw new Error('not a JPEG');
    return { b64: s, buf, ext: 'jpg' };
  }
  return pngFrom(input);
}

/** Writes one asset's grid file and removes the same asset in the other format, so Steam can't pick a stale one. */
function writeGrid(gridDir, appid, asset, buf, ext) {
  writeAtomic(path.join(gridDir, gridName(appid, asset, ext)), buf);
  for (const other of EXTS) if (other !== ext) fs.rmSync(path.join(gridDir, gridName(appid, asset, other)), { force: true });
}

const kb = (n) => `${Math.round(n / 1024)} KB`;

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.lurkbox-tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/**
 * Backs up the current grid files once per appid, before Lurkbox first overwrites them.
 * backupDir/<appid>/manifest.json records which files existed and the shortcut's original icon path.
 */
function backupOnce({ gridDir, appid, backupDir, iconPath = '' }) {
  const dir = path.join(backupDir, String(checkAppId(appid)));
  const manifestFile = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestFile)) return { created: false, dir };
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const a of ASSETS) {
    const src = path.join(gridDir, gridName(appid, a));
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, `${a}.png`)); files[a] = true; } else files[a] = false;
  }
  // Originals in JPEG are backed up too (restore writes them back as they were).
  for (const a of ASSETS) {
    const src = path.join(gridDir, gridName(appid, a, 'jpg'));
    if (!files[a] && fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, `${a}.jpg`)); files[a] = 'jpg'; }
  }
  writeAtomic(manifestFile, Buffer.from(JSON.stringify({ appid, files, iconPath, at: new Date().toISOString() }, null, 2)));
  return { created: true, dir };
}

class SteamArt {
  /**
   * @param {object} o
   * @param {string} o.backupDir userData/steam-art-backup
   * @param {string} o.staticDir assets/steam (the shipped art, used when there is no backup)
   * @param {(line: string) => void} [o.log]
   */
  constructor({ backupDir, staticDir, log = () => {}, env = process.env, root, openContext = openSteamContext, now = () => Date.now(), setTimer = setTimeout, minLiveIntervalMs = MIN_LIVE_INTERVAL_MS }) {
    Object.assign(this, { backupDir, staticDir, log, env, root: root || steamRoot(env), openContext, now, setTimer, minLiveIntervalMs });
    this.lastLiveAt = 0;
    this.deferred = null;
  }

  stateFile() { return path.join(this.backupDir, 'applied.json'); }
  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) || {}; } catch { return {}; } }
  writeState(st) { try { writeAtomic(this.stateFile(), Buffer.from(JSON.stringify(st))); } catch (e) { this.log(`[steam-art] state not saved: ${e.message}`); } }

  /** Locates the appid and grid folder; throws a user-readable error. */
  target() {
    const fromEnv = appIdFromEnv(this.env);
    const ud = findUserdata(this.root, fromEnv && fromEnv.appid);
    if (!ud) throw new Error('No Steam shortcut for Lurkbox found');
    let appid = fromEnv && fromEnv.appid;
    let source = fromEnv && fromEnv.source;
    if (!appid && ud.entry && ud.entry.appid) { appid = ud.entry.appid; source = 'shortcuts.vdf'; }
    if (!appid) throw new Error('Lurkbox is not running as a Steam shortcut');
    return { appid, source, gridDir: path.join(ud.config, 'grid'), userId: ud.id, iconPath: (ud.entry && ud.entry.icon || '').replace(/^"|"$/g, '') };
  }

  async withSteam(fn) {
    let ctx = null;
    try { ctx = await this.openContext(); } catch (e) { this.log(`[steam-art] CDP unavailable: ${e.message}`); ctx = null; }
    if (!ctx) return false;
    try { await fn(ctx); return true; } finally { await ctx.close(); }
  }

  /**
   * images: { capsule, wide, hero, logo, icon } as PNG or JPEG data URLs (logo and icon PNG), plus an optional `key`
   * (a hash of the theme colours and the art version). The same key as the last apply is skipped entirely.
   */
  async apply(images) {
    const t = this.target();
    const key = images && typeof images.key === 'string' ? images.key.slice(0, 128) : null;
    const st = this.readState();
    if (key && st.key === key && st.appid === t.appid) {
      this.log(`[steam-art] unchanged (${key.slice(0, 12)}); not applied`);
      return { ok: true, live: false, skipped: true, appid: t.appid };
    }
    const imgs = {};
    for (const a of ASSETS) imgs[a] = imageFrom(images && images[a]);
    imgs.icon = pngFrom(images && images.icon);
    this.log(`[steam-art] payload ${[...ASSETS, 'icon'].map((a) => `${a} ${imgs[a].ext} ${kb(imgs[a].buf.length)}`).join(', ')}`);
    const b = backupOnce({ gridDir: t.gridDir, appid: t.appid, backupDir: this.backupDir, iconPath: t.iconPath });
    if (b.created) this.log(`[steam-art] backed up original grid art to ${b.dir}`);
    for (const a of ASSETS) writeGrid(t.gridDir, t.appid, a, imgs[a].buf, imgs[a].ext);
    const iconFile = path.join(t.gridDir, gridName(t.appid, 'icon'));
    writeAtomic(iconFile, imgs.icon.buf);
    this.writeState({ key, appid: t.appid, at: new Date(this.now()).toISOString() });

    const wait = this.lastLiveAt ? this.lastLiveAt + this.minLiveIntervalMs - this.now() : 0;
    if (wait > 0) {
      // Too soon after the last live update: only the newest images go live, once, when the interval is over.
      const firstDefer = !this.deferred;
      this.deferred = { t, imgs, iconFile };
      if (firstDefer) this.setTimer(() => { const d = this.deferred; this.deferred = null; if (d) this.applyLive(d).catch((e) => this.log(`[steam-art] deferred live update failed: ${e.message}`)); }, wait);
      this.log(`[steam-art] files written for appid ${t.appid}; live update deferred ${Math.ceil(wait / 1000)} s (last one under ${this.minLiveIntervalMs / 1000} s ago)`);
      return { ok: true, live: false, deferred: true, appid: t.appid };
    }
    const live = await this.applyLive({ t, imgs, iconFile });
    return { ok: true, live, appid: t.appid };
  }

  async applyLive({ t, imgs, iconFile }) {
    this.lastLiveAt = this.now();
    const live = await this.withSteam(async (ctx) => {
      for (const a of LIVE_ASSETS) await ctx.run({ fn: 'setArtwork', appid: t.appid, base64: imgs[a].b64, ext: imgs[a].ext, assetType: ASSET_TYPES[a] });
      await ctx.run({ fn: 'setIcon', appid: t.appid, path: iconFile });
    });
    const sent = LIVE_ASSETS.reduce((n, a) => n + imgs[a].b64.length, 0);
    this.log(`[steam-art] applied for appid ${t.appid} (${t.source}, user ${t.userId}); live=${live}${live ? ` (sent ${LIVE_ASSETS.join(', ')}: ${kb(sent)} base64; hero file only)` : ''}`);
    return live;
  }

  /** Puts the backed-up (or shipped) art back and clears Steam's custom artwork. */
  async restore() {
    const t = this.target();
    const dir = path.join(this.backupDir, String(t.appid));
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* no backup */ }
    const imgs = {};
    const exts = {};
    for (const a of ASSETS) {
      const ext = manifest && manifest.files && manifest.files[a] === 'jpg' ? 'jpg' : 'png';
      const backed = manifest && manifest.files && manifest.files[a] && path.join(dir, `${a}.${ext}`);
      const useBackup = backed && fs.existsSync(backed);
      imgs[a] = fs.readFileSync(useBackup ? backed : path.join(this.staticDir, `${a}.png`));
      exts[a] = useBackup ? ext : 'png';
    }
    const iconFile = path.join(t.gridDir, gridName(t.appid, 'icon'));
    let iconPath = manifest && manifest.iconPath;
    try { checkPath(iconPath); if (iconPath === iconFile || !fs.existsSync(iconPath)) iconPath = null; } catch { iconPath = null; }
    if (!iconPath) { writeAtomic(iconFile, fs.readFileSync(path.join(this.staticDir, 'icon.png'))); iconPath = iconFile; }

    const live = await this.withSteam(async (ctx) => {
      for (const a of ASSETS) {
        await ctx.run({ fn: 'clearArtwork', appid: t.appid, assetType: ASSET_TYPES[a] });
        // Clearing can delete the grid file; set the original straight back so the library shows it now (not the hero:
        // its file is written below and Steam shows it after a restart).
        if (LIVE_ASSETS.includes(a)) await ctx.run({ fn: 'setArtwork', appid: t.appid, base64: imgs[a].toString('base64'), ext: exts[a], assetType: ASSET_TYPES[a] });
      }
      await ctx.run({ fn: 'setIcon', appid: t.appid, path: iconPath });
    });
    this.lastLiveAt = live ? this.now() : this.lastLiveAt;
    for (const a of ASSETS) writeGrid(t.gridDir, t.appid, a, imgs[a], exts[a]);
    this.writeState({});
    this.log(`[steam-art] restored original art for appid ${t.appid} (${manifest ? 'backup' : 'shipped art'}); live=${live}`);
    return { ok: true, live, appid: t.appid };
  }
}

module.exports = {
  ASSET_TYPES, ASSETS, gridName, crc32, shortcutAppId, appIdFromEnv, parseVdf, lurkboxShortcut, findUserdata,
  buildCall, FUNCTIONS, LIVE_ASSETS, openSteamContext, pngFrom, imageFrom, backupOnce, SteamArt, steamRoot,
};
