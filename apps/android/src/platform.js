// The Android window.lurkbox (packages/core/src/platform.d.ts), built from injected Capacitor plugins so it can be
// tested in Node with mocks. platform-android.js wires the real plugins in.
//
// Implemented: settings, accounts and the phone (device-code) sign-in, Helix, the direct engine (web GQL + usher, with
// the master's playlists through the app's HLS proxy), clips, VOD storyboards, resume positions, QR codes, logging,
// window focus (app pause/resume). Left out (optional members) or answered as "unavailable": everything that needs a
// twitch.tv web session (the TV sign-in, the player session, channel points, Drops, follow) and the desktop-only parts
// (Steam art and keyboard, joydev, window icon, chat extensions). docs/android.md lists what comes later.
import { DEFAULT_SETTINGS, sanitizeSettings } from '@lurkbox/core/src/shared/settings.js';
import { Twitch, Emitter } from '@lurkbox/core/src/shared/twitch-auth.js';
import { fetchMaster, fetchLiveInfo, fetchStoryboard } from '@lurkbox/core/src/shared/direct.js';
import { fetchClipSources } from '@lurkbox/core/src/shared/clips.js';
import { resumeUpdate, resumeEntries, RESUME_MAX_PER_ACCOUNT } from '@lurkbox/core/src/shared/continue-watching.js';
import { ProxyHosts, rewriteMaster } from '@lurkbox/core/src/shared/hls-rewrite.js';

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
 * @param {{get, set}} d.prefs        Capacitor Preferences
 * @param {{addListener, exitApp}} d.app   Capacitor App
 * @param {{log?, proxyAllow?}} d.native   the app's own LurkboxNative plugin
 * @param {(text: string) => string} d.qrSvg
 * @param {string} d.version
 */
export function createPlatform({ fetch, prefs, app, native = {}, qrSvg, version = '0.0.0', setInterval: every = setInterval }) {
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
  const tokens = new PrefValue(prefs, 'tokens', {});
  const resumeValue = new PrefValue(prefs, 'resume', { accounts: {} });
  const resume = new ResumePositions(resumeValue);
  const hosts = new ProxyHosts();
  let twitch = null;

  const ready = (async () => {
    await Promise.all([settings.load(), tokens.load(), resumeValue.load()]);
    twitch = new Twitch({ getSettings: () => settings.get(), tokens, fetch });
    twitch.on('state', (s) => bus.emit('auth:state', s));
    twitch.on('auth', (ev) => bus.emit('auth:event', ev));
    twitch.validate().catch((e) => log(`[auth] validate failed: ${e.message}`)).finally(() => twitch.emitState());
    every(() => twitch.validate().then(() => twitch.emitState()).catch(() => {}), 60 * 60 * 1000);
  })();
  const after = (fn) => async (...args) => { await ready; return fn(...args); };

  if (app && app.addListener) {
    // The core's "window focus": the app in front (resumed) or not (paused, home screen, another app).
    app.addListener('appStateChange', (st) => bus.emit('focus', !!(st && st.isActive)));
  }

  const signedOutPlayer = () => ({ signedIn: false, login: null, mismatch: null });

  return {
    // ---- app and window ----
    appInfo: async () => ({ windowed: false, gamescope: false, startChannel: null, startVod: null, version, touch: true, defaults: DEFAULT_SETTINGS }),
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
    signOut: after((id) => twitch.signOut(id || undefined)),
    accountsStatus: after(() => twitch.state().accounts.map((a) => ({ id: a.id, api: !a.needsSignin, player: false, playerLogin: null }))),
    switchAccount: after((id) => twitch.switchAccount(String(id))),
    removeAccount: after((id) => twitch.removeAccount(String(id))),
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

    // ---- player session: needs a twitch.tv web session (an Android WebView login, later) ----
    playerSessionStatus: async () => signedOutPlayer(),
    playerSessionSignOut: async () => signedOutPlayer(),

    // ---- official embed (fallback engine): no script access to its frame here ----
    dismissPlayerGate: async () => '',

    // ---- direct engine ----
    directMaster: async (req) => {
      try {
        const login = req && req.login && LOGIN.test(req.login) ? req.login : null;
        const vodId = req && req.vodId && /^\d+$/.test(req.vodId) ? req.vodId : null;
        if (!login && !vodId) return { ok: false, reason: 'bad request' };
        const codecs = ((req && req.codecs) || ['h264']).filter((c) => ['av1', 'h265', 'h264'].includes(c));
        const r = await fetchMaster({ fetch, login, vodId, codecs, authToken: null, log });
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

    // ---- channel points, Drops: Twitch's own pages in a twitch.tv session; not on Android yet ----
    pointsOpenPanel: async () => ({ ok: false, reason: UNAVAILABLE }),
    pointsPad: async () => null,
    pointsClosePanel: async () => false,
    onPointsEvent: noopUnsub,
    dropsOpen: async () => ({ ok: false, reason: UNAVAILABLE }),
    dropsPad: async () => 'close',
    dropsClose: async () => false,

    // ---- open requests (Android intents / deep links, later) ----
    openReady: async () => null,
    onOpenChannel: on('open'),

    // ---- desktop-only, required by the interface ----
    chatExtensionsUpdate: async () => [],
  };
}
