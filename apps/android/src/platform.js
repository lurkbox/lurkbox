// The Android window.lurkbox (packages/core/src/platform.d.ts), built from injected Capacitor plugins so it can be
// tested in Node with mocks. platform-android.js wires the real plugins in.
//
// Implemented: settings, accounts and the phone (device-code) sign-in, Helix, the direct engine (web GQL + usher, with
// the master's playlists through the app's HLS proxy), clips, VOD storyboards, resume positions, QR codes, logging,
// window focus (app pause/resume), and with the native twitch.tv window (web-session.js) and hidden twitch.tv pages
// (hidden-pages.js) the TV sign-in, the player session, subs/Turbo in the direct engine, channel points (points.js),
// follow/unfollow (follow.js) and Drops (drops.js). Left out (optional members) or answered as "unavailable":
// watch-time points and the desktop-only parts (Steam art and keyboard, joydev, window icon, chat extensions).
// docs/android.md lists what comes later.
import { DEFAULT_SETTINGS, sanitizeSettings } from '@lurkbox/core/src/shared/settings.js';
import { Twitch, Emitter } from '@lurkbox/core/src/shared/twitch-auth.js';
import { fetchMaster, fetchLiveInfo, fetchStoryboard } from '@lurkbox/core/src/shared/direct.js';
import { fetchClipSources } from '@lurkbox/core/src/shared/clips.js';
import { resumeUpdate, resumeEntries, RESUME_MAX_PER_ACCOUNT } from '@lurkbox/core/src/shared/continue-watching.js';
import { storeWhispers, loadWhispers } from '@lurkbox/core/src/shared/whispers.js';
import { accountsWithIndex, accountIndexKey } from '@lurkbox/core/src/shared/emote-index.js';
import { removeAccountData } from '@lurkbox/core/src/shared/account-data.js';
import { ProxyHosts, rewriteMaster } from '@lurkbox/core/src/shared/hls-rewrite.js';
import { createWebSession, mismatchWarning, SESSION_TOKEN } from './web-session.js';
import { createHiddenPages } from './hidden-pages.js';
import { createPoints } from './points.js';
import { createFollow } from './follow.js';
import { createDrops } from './drops.js';

/** Same-origin prefix the WebView answers natively (MainActivity's HLS proxy): <prefix><host>/<path>?<query>. */
export const PROXY_PREFIX = 'https://localhost/_lbhls/';

const LOGIN = /^[a-z0-9_]{1,25}$/i;
const VIDEO_ID = /^\d{1,20}$/;
const UNAVAILABLE = 'unavailable';

/** A JSON value kept in Capacitor Preferences (Android SharedPreferences, private to the app): sync reads, async saves. */
export class PrefValue {
  constructor(prefs, key, defaults = {}) {
    this.prefs = prefs;
    this.key = key;
    this.defaults = defaults;
    this.data = { ...defaults };
    this.saving = Promise.resolve();
  }
  async load() {
    try {
      const r = await this.prefs.get({ key: this.key });
      if (r && r.value) this.data = { ...this.defaults, ...JSON.parse(r.value) };
    } catch (e) { console.warn(`[prefs] could not read ${this.key}: ${e.message}`); }
    return this;
  }
  get() { return { ...this.data }; }
  set(patch) { this.data = { ...this.data, ...patch }; this.save(); return this.get(); }
  replace(obj) { this.data = { ...this.defaults, ...obj }; this.save(); }
  save() {
    const value = JSON.stringify(this.data);
    this.saving = this.saving.then(() => this.prefs.set({ key: this.key, value })).catch((e) => console.warn(`[prefs] could not save ${this.key}: ${e.message}`));
    return this.saving;
  }
}

/**
 * Moves a value from Preferences (plaintext) into the encrypted store, once: copied when the store has none yet, then
 * the plaintext copy is deleted either way (also when the copy can't be saved: the sign-in is lost rather than left
 * unencrypted). Never throws. Resolves { migrated, reset } (reset: the store's key stopped working and it was cleared).
 */
export async function migrateToSecure(prefs, secure, key, log = () => {}) {
  let plain = null;
  try { const r = await prefs.get({ key }); plain = r && r.value ? r.value : null; } catch { plain = null; }
  let stored = null;
  let reset = false;
  try {
    const r = await secure.get({ key });
    stored = r && r.value ? r.value : null;
    reset = !!(r && r.reset);
  } catch (e) { log(`[secure] could not read ${key}: ${e.message}`); }
  if (reset) log(`[secure] the stored ${key} could not be decrypted (the device's key changed); cleared, sign in again`);
  if (!plain) return { migrated: false, reset };
  let migrated = false;
  if (!stored) {
    try { await secure.set({ key, value: plain }); migrated = true; log(`[secure] moved ${key} into encrypted storage`); } catch (e) { log(`[secure] could not encrypt ${key}: ${e.message}`); }
  }
  try { await prefs.remove({ key }); } catch (e) { log(`[secure] could not delete the plaintext ${key}: ${e.message}`); }
  return { migrated, reset };
}

/**
 * VOD resume positions per account, like the desktop's resume.json: { accounts: { id|anon: { videoId: { pos, dur, at, m? } } } }
 * (m: the video's details for Continue watching). The entry maths are shared (shared/continue-watching.js).
 */
export class ResumePositions {
  constructor(value, { now = () => Date.now(), max = RESUME_MAX_PER_ACCOUNT } = {}) { this.value = value; this.now = now; this.max = max; }
  key(accountId) { return VIDEO_ID.test(String(accountId || '')) ? String(accountId) : 'anon'; }
  get(accountId, videoId) {
    if (!VIDEO_ID.test(String(videoId))) return null;
    const e = ((this.value.get().accounts || {})[this.key(accountId)] || {})[String(videoId)];
    return e ? { position: e.pos, duration: e.dur, at: e.at } : null;
  }
  set(accountId, videoId, position, duration, meta) {
    if (!VIDEO_ID.test(String(videoId))) return false;
    const accounts = { ...(this.value.get().accounts || {}) };
    accounts[this.key(accountId)] = resumeUpdate(accounts[this.key(accountId)], videoId, position, duration, meta, { now: this.now(), max: this.max });
    this.value.replace({ accounts });
    return true;
  }
  list(accountId) { return resumeEntries((this.value.get().accounts || {})[this.key(accountId)]); }
  clear(accountId) {
    const accounts = { ...(this.value.get().accounts || {}) };
    delete accounts[this.key(accountId)];
    this.value.replace({ accounts });
    return true;
  }
}

/**
 * @param {object} d
 * @param {typeof fetch} d.fetch      native HTTP (http.js makeNativeFetch(CapacitorHttp))
 * @param {{get, set, remove}} d.prefs        Capacitor Preferences
 * @param {{get, set, remove}} [d.secure]   the encrypted store for the tokens (SecureStorePlugin.java; same shape,
 *   get may also resolve reset: true when its key stopped working). Without it the tokens stay in prefs (tests).
 * @param {{addListener, exitApp}} d.app   Capacitor App
 * @param {{log?, proxyAllow?, webOpen?, pageOpen?}} d.native   the app's own LurkboxNative plugin (web*: the twitch.tv
 *   window; page*: the hidden twitch.tv pages)
 * @param {(text: string) => string} d.qrSvg
 * @param {string} d.version
 */
export function createPlatform({ fetch, prefs, secure = null, app, native = {}, qrSvg, version = '0.0.0', setInterval: every = setInterval, features = {} }) {
  const bus = new Emitter();
  const on = (name) => (cb) => { bus.on(name, cb); return () => bus.off(name, cb); };
  const noopUnsub = () => () => {};
  const log = (line) => {
    try {
      const p = native.log ? native.log({ line: String(line).slice(0, 2000) }) : null;
      if (p && p.catch) p.catch(() => {});
    } catch { /* never throw into the caller */ }
  };

  const settings = new PrefValue(prefs, 'settings', DEFAULT_SETTINGS);
  const tokens = new PrefValue(secure || prefs, 'tokens', {});
  const resumeValue = new PrefValue(prefs, 'resume', { accounts: {} });
  const resume = new ResumePositions(resumeValue);
  // Whisper history per account, like the desktop's whispers.json: { accounts: { id: threads } } (shared/whispers.js).
  const whispersValue = new PrefValue(prefs, 'whispers', { accounts: {} });
  const emoteIndexValue = new PrefValue(prefs, 'emoteIndex', { accounts: {} }); // Emote search → Seen channels
  const hosts = new ProxyHosts();
  let twitch = null;
  // The twitch.tv web session (TV sign-in, player session) when the native twitch.tv window is there.
  const web = native.webOpen ? createWebSession({ native, log, getSettings: () => settings.get() }) : null;
  // Channel points, follow and Drops: Twitch's own pages in that session, hidden (page*) or in the twitch.tv window.
  // features: options for tests (timers).
  const hidden = web && native.pageOpen ? createHiddenPages({ native, ...(features.pages || {}) }) : null;
  const getSettings = () => settings.get();
  const emit = (name, data) => bus.emit(name, data);
  const points = hidden ? createPoints({ pages: hidden, web, getSettings, emit, log, ...(features.points || {}) }) : null;
  const follow = hidden ? createFollow({ pages: hidden, web, log, ...(features.follow || {}) }) : null;
  const drops = hidden ? createDrops({ pages: hidden, web, getSettings, emit, log, ...(features.drops || {}) }) : null;

  const ready = (async () => {
    if (secure) await migrateToSecure(prefs, secure, 'tokens', log);
    await Promise.all([settings.load(), tokens.load(), resumeValue.load(), whispersValue.load(), emoteIndexValue.load()]);
    twitch = new Twitch({ getSettings: () => settings.get(), tokens, fetch, onSwitch: web ? web.onSwitch : undefined });
    twitch.on('state', (s) => bus.emit('auth:state', s));
    twitch.on('auth', (ev) => bus.emit('auth:event', ev));
    twitch.validate().catch((e) => log(`[auth] validate failed: ${e.message}`)).finally(() => twitch.emitState());
    every(() => twitch.validate().then(() => twitch.emitState()).catch(() => {}), 60 * 60 * 1000);
    if (drops) drops.start();
  })();
  const after = (fn) => async (...args) => { await ready; return fn(...args); };

  // The one place an account's data is deleted (sign-out and Remove): tokens and profile, the twitch.tv session and
  // its jar, and every per-account store (shared/account-data.js). Global settings stay.
  const removeAccount = (id) => removeAccountData(id, {
    twitch,
    settings,
    onSettings: (next) => bus.emit('settings', next),
    log,
    clearLiveSession: async () => { if (web) await web.jar.clear(); },
    removeJar: async (acct) => { if (web) await web.jar.remove(acct); },
    restoreSession: web ? (next) => web.jar.restore(next) : undefined,
    stores: {
      resume: (acct) => resume.clear(acct),
      whispers: (acct) => whispersValue.replace(storeWhispers(whispersValue.get(), acct, [])),
      'emote-index': (acct) => emoteIndexValue.replace({ accounts: accountsWithIndex(emoteIndexValue.get().accounts, acct, null) }),
      'session-state': async (_acct, { wasActive }) => {
        if (!wasActive) return;
        if (points) await points.watch(null);
        if (drops && drops.reset) drops.reset();
      },
    },
  });

  // Picture-in-picture (pip.js, MainActivity): its play/pause button and its closing, for the open player.
  const hasPip = !!(native.pip && native.addListener);
  if (hasPip) {
    try {
      const h = native.addListener('pipAction', (d) => { if (d && typeof d.action === 'string') bus.emit('media', d.action); });
      if (h && h.catch) h.catch(() => {});
    } catch { /* no events: the window still works, without its button */ }
  }
  const pipSupported = (async () => {
    if (!native.pipSupported) return false;
    try { return !!(await native.pipSupported()).supported; } catch { return false; }
  })();

  if (app && app.addListener) {
    // The core's "window focus": the app in front (resumed) or not (paused, home screen, another app).
    app.addListener('appStateChange', (st) => bus.emit('focus', !!(st && st.isActive)));
  }

  const signedOutPlayer = () => ({ signedIn: false, login: null, mismatch: null });
  const playerState = async () => {
    if (!web) return signedOutPlayer();
    const st = await web.status();
    return { ...st, mismatch: mismatchWarning(st.login, twitch.user && twitch.user.login) };
  };
  // Only with the native twitch.tv window: without these members the core uses the phone sign-in everywhere.
  const webMembers = web ? {
    tvSignIn: after((opts) => web.tvSignIn(twitch, opts)),
    playerSessionLogin: after(async () => ({ ...(await web.playerLogin(twitch)), ...(await playerState()) })),
  } : {};

  // Only with the hidden pages: without these members the core hides the features (or says "unavailable").
  const pageMembers = hidden ? {
    pointsWatch: after((login) => points.watch(login)),
    onPointsState: on('points:state'),
    followChannel: after((req) => follow.follow(req)),
    openChannelPage: after((login) => follow.openPage(login)),
    dropsStatus: after(() => drops.status()),
    dropsProgress: after(() => drops.progress()),
    onDropsEvent: on('drops:event'),
  } : {};

  const pipMembers = hasPip ? { onMediaAction: on('media') } : {};

  return {
    ...pipMembers,
    // ---- app and window ----
    // hostPages: the chat page (points) and the Drops inventory are shown in the native windows, not the app's iframes.
    // pip: picture-in-picture on this device (a phone or tablet; Settings shows its switch).
    appInfo: async () => ({ windowed: false, gamescope: false, startChannel: null, startVod: null, version, touch: true, hostPages: true, pip: await pipSupported, defaults: DEFAULT_SETTINGS }),
    quit: async () => { if (app && app.exitApp) await app.exitApp(); },
    onWindowFocus: on('focus'),
    log,
    qrSvg: async (text) => qrSvg(String(text)),

    // ---- settings ----
    getSettings: after(() => settings.get()),
    setSettings: after((patch) => {
      const clean = sanitizeSettings(patch || {});
      const prevClientId = settings.get().clientId;
      const next = settings.set(clean);
      if ('clientId' in clean && clean.clientId !== prevClientId) {
        // Tokens are bound to the Client ID that issued them.
        twitch.cancelDeviceFlow();
        twitch.clearTokens();
      }
      bus.emit('settings', next);
      return next;
    }),
    onSettingsChanged: on('settings'),

    // ---- accounts and sign-in (the phone / device-code flow; the code and QR show on the TV) ----
    authState: after(() => twitch.state()),
    authStart: after(async () => {
      try { return { ok: true, flow: await twitch.startDeviceFlow() }; } catch (e) { return { ok: false, error: e.message }; }
    }),
    authCancel: after(() => { twitch.cancelDeviceFlow(); }),
    // Signing out and removing an account are the same: the account and everything kept for it go (removeAccount below).
    signOut: after(async (id) => (await removeAccount(id || undefined)).active),
    // Per account: the API token, and whether the twitch.tv session (live for the active one, else its jar) is them.
    accountsStatus: after(async () => {
      const st = twitch.state();
      const live = web ? await web.status() : { signedIn: false, login: null };
      return Promise.all(st.accounts.map(async (a) => {
        const playerLogin = !web ? null : a.id === st.active ? (live.signedIn ? live.login || '' : null) : await web.jar.peekLogin(a.id);
        return { id: a.id, api: !a.needsSignin, player: playerLogin !== null && (!playerLogin || playerLogin.toLowerCase() === String(a.login).toLowerCase()), playerLogin };
      }));
    }),
    switchAccount: after((id) => twitch.switchAccount(String(id))),
    removeAccount: after(async (id) => (await removeAccount(String(id))).active),
    ...webMembers,
    onAuthState: on('auth:state'),
    onAuthEvent: on('auth:event'),

    // ---- Twitch API ----
    helix: after(async (req) => {
      try {
        const r = await twitch.helix(req);
        return { ok: true, status: r.status, data: r.data };
      } catch (e) {
        return { ok: false, status: e.status || 0, error: e.message, data: e.body || null, resetAt: e.resetAt || null };
      }
    }),

    // ---- player session: the twitch.tv web session in CookieManager (signed out without the native window) ----
    playerSessionStatus: after(() => playerState()),
    playerSessionSignOut: after(async () => {
      if (web) { await web.jar.clear().catch((e) => log(`[web] clear failed: ${e.message}`)); log('[player-login] signed out of the player'); }
      return playerState();
    }),

    // ---- official embed (fallback engine): no script access to its frame here ----
    dismissPlayerGate: async () => '',

    // ---- direct engine ----
    directMaster: async (req) => {
      try {
        const login = req && req.login && LOGIN.test(req.login) ? req.login : null;
        const vodId = req && req.vodId && /^\d+$/.test(req.vodId) ? req.vodId : null;
        if (!login && !vodId) return { ok: false, reason: 'bad request' };
        const codecs = ((req && req.codecs) || ['h264']).filter((c) => ['av1', 'h265', 'h264'].includes(c));
        // Signed in to twitch.tv: the token request carries the session (subs/Turbo); native webGql adds the cookie.
        const authed = web && (await web.status()).signedIn;
        const r = authed
          ? await fetchMaster({ fetch: web.gqlFetch(fetch), login, vodId, codecs, authToken: SESSION_TOKEN, log })
          : await fetchMaster({ fetch, login, vodId, codecs, authToken: null, log });
        if (r.ok) {
          r.master = rewriteMaster(r.master, hosts, PROXY_PREFIX);
          // The native proxy only serves the cloudfront hosts a master we fetched pointed at.
          if (native.proxyAllow && hosts.seen.size) await native.proxyAllow({ hosts: [...hosts.seen] }).catch((e) => log(`[direct] proxyAllow failed: ${e.message}`));
        }
        return r;
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },
    liveInfo: async (login) => {
      try { return LOGIN.test(String(login)) ? await fetchLiveInfo({ fetch, login }) : null; } catch (e) { log(`[direct] live info failed: ${e.message}`); return null; }
    },
    storyboard: async (vodId) => {
      try { return await fetchStoryboard({ fetch, vodId }); } catch (e) { log(`[direct] storyboard failed: ${e.message}`); return null; }
    },
    clipSources: async (slug) => {
      try {
        const r = await fetchClipSources({ fetch, slug: String(slug || ''), log });
        if (!r.ok) log(`[clip] sources failed: ${r.reason}`);
        return r;
      } catch (e) { return { ok: false, reason: e.message }; }
    },

    // ---- VOD resume positions ----
    resumeGet: after((videoId) => resume.get(twitch.store().active, String(videoId))),
    resumeSet: after((videoId, position, duration, meta) => resume.set(twitch.store().active, String(videoId), position, duration, meta)),
    resumeList: after(() => resume.list(twitch.store().active)),
    resumeClear: after(() => resume.clear(twitch.store().active)),

    // ---- whispers (history kept on the device, per account) ----
    whispersLoad: after((accountId) => loadWhispers(whispersValue.get(), accountId)),
    whispersSave: after((accountId, threads) => { whispersValue.replace(storeWhispers(whispersValue.get(), accountId, threads)); return true; }),
    // ---- the "seen channels" emote index (per account) ----
    emoteIndexGet: after(() => (emoteIndexValue.get().accounts || {})[accountIndexKey(twitch.store().active)] || null),
    emoteIndexSet: after((index) => { emoteIndexValue.replace({ accounts: accountsWithIndex(emoteIndexValue.get().accounts, twitch.store().active, index) }); return true; }),

    // ---- channel points, Drops, follow: Twitch's own pages in the twitch.tv session (points.js, drops.js, follow.js) ----
    pointsOpenPanel: points ? after((opts) => points.openPanel(opts)) : async () => ({ ok: false, reason: UNAVAILABLE }),
    pointsPad: points ? (key) => points.pad(key) : async () => null,
    pointsClosePanel: points ? () => points.closePanel() : async () => false,
    onPointsEvent: points ? on('points:event') : noopUnsub,
    dropsOpen: drops ? after(() => drops.open()) : async () => ({ ok: false, reason: UNAVAILABLE }),
    dropsPad: drops ? (key) => drops.pad(key) : async () => 'close',
    dropsClose: drops ? () => drops.close() : async () => false,
    ...pageMembers,

    // ---- open requests (Android intents / deep links, later) ----
    openReady: async () => null,
    onOpenChannel: on('open'),

    // ---- desktop-only, required by the interface ----
    chatExtensionsUpdate: async () => [],
  };
}
