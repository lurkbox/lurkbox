// The twitch.tv web session on Android: the in-app twitch.tv window (a full-screen native WebView, LurkboxNative's
// web* methods in TwitchWebDialog.java) and the session's cookies in Android's CookieManager. Cookie values never
// reach this page: the native side answers only "signed in" and the public login name, keeps the per-account jars in
// the app's private storage, and adds the auth-token to the web GQL request itself (webGql).
//
// Here: the TV sign-in (the shared TvSignIn: twitch.tv login, then Authorize, in the same window), the player sign-in,
// account switching (jar swap), and the direct engine's authenticated PlaybackAccessToken.
import { TvSignIn, LOGIN_URL } from '@lurkbox/core/src/shared/tv-signin.js';
import { navSource } from '@lurkbox/core/src/shared/frame-nav.js';
import { tvZoom } from '@lurkbox/core/src/shared/tv-zoom.js';
import { GQL_URL } from '@lurkbox/core/src/shared/direct.js';

const ID = /^\d{1,20}$/;
/** Stands in for the auth-token in the GQL request this page builds; the native side swaps in the real value. */
export const SESSION_TOKEN = 'lurkbox-web-session';
const NAV_HINT = 'D-pad: move · OK: select (opens the keyboard on text boxes) · BACK: cancel';

/** Message for a player/Lurkbox account mismatch, or null when they match (as on the desktop). */
export function mismatchWarning(playerLogin, lurkboxLogin) {
  if (!playerLogin || !lurkboxLogin) return null;
  if (playerLogin.toLowerCase() === lurkboxLogin.toLowerCase()) return null;
  return `The player is signed in as ${playerLogin}, but Lurkbox is signed in as ${lurkboxLogin}. Subs apply to ${playerLogin}.`;
}

/**
 * @param {object} d
 * @param {object} d.native   LurkboxNative (webOpen, webLoad, webClose, webStatus, webClear, webClearSiteData, webJar*, webGql, addListener)
 * @param {(line: string) => void} d.log
 * @param {() => object} d.getSettings
 * @param {() => number} [d.screenHeight]  CSS px (for the TV zoom)
 */
export function createWebSession({ native, log, getSettings, screenHeight = () => (globalThis.screen && globalThis.screen.height) || 720 }) {
  let seq = 0;
  const closedWaiters = new Map();
  let current = 0; // the session shown in the (one) native window, 0 when it is closed
  const ended = (session) => {
    if (current === session) current = 0;
    const done = closedWaiters.get(session);
    if (done) { closedWaiters.delete(session); done(); }
  };
  if (native.addListener) {
    const p = native.addListener('webClosed', (ev) => ended(ev && ev.session));
    if (p && p.catch) p.catch(() => {});
  }

  const status = async () => {
    try {
      const r = await native.webStatus();
      return { signedIn: !!(r && r.signedIn), login: r && r.signedIn && r.login ? String(r.login) : null };
    } catch (e) { log(`[web] status failed: ${e.message}`); return { signedIn: false, login: null }; }
  };

  const jar = {
    save: async (id) => (ID.test(String(id)) ? native.webJarSave({ id: String(id) }) : null),
    restore: async (id) => (ID.test(String(id)) ? native.webJarRestore({ id: String(id) }) : native.webClear()),
    clear: async () => native.webClear(),
    /** Sign-out of the active account: twitch.tv's own site data in the WebView (local storage, IndexedDB, cache). */
    clearSiteData: async () => { if (native.webClearSiteData) await native.webClearSiteData(); },
    remove: async (id) => { if (ID.test(String(id))) await native.webJarRemove({ id: String(id) }).catch(() => {}); },
    peekLogin: async (id) => {
      if (!ID.test(String(id))) return null;
      try { const r = await native.webJarPeek({ id: String(id) }); return r && r.has ? String(r.login || '') : null; } catch { return null; }
    },
  };

  /**
   * The in-app twitch.tv window, as the shared TvSignIn wants it: load(url), close(), closed. The sign-in's by default;
   * other views pass their own zoom, script (fixed sources, run after each page load) and textScript (run when BACK
   * leaves a text box). close() only closes this window, not a later one.
   */
  const openWindow = ({ zoom = tvZoom(screenHeight(), (getSettings() || {}).uiScale), script = navSource({ hint: NAV_HINT, preferText: true }), textScript = '' } = {}) => {
    const session = ++seq;
    const closed = new Promise((resolve) => closedWaiters.set(session, resolve));
    let opened = null;
    const fail = (what) => (e) => { log(`[web] ${what} failed: ${e.message}`); native.webClose().catch(() => {}); };
    return {
      session,
      load: (url) => {
        if (!opened) {
          // The native window is reused: a window still open is replaced by this one, so it counts as closed.
          if (current && current !== session) ended(current);
          current = session;
          opened = native.webOpen({ url, session, zoom, script, textScript }).catch(fail('open'));
        }
        else opened = opened.then(() => native.webLoad({ url })).catch(fail('load'));
      },
      close: () => { if (current === session) native.webClose().catch(() => {}); },
      closed,
    };
  };

  const signIn = (twitch) => new TvSignIn({ twitch, jar, webStatus: status, openWindow, log });

  return {
    status,
    jar,
    openWindow,
    screenHeight,
    /** Twitch's onSwitch: keep the old account's web session in its jar, put the new one's in. */
    onSwitch: async (fromId, toId) => {
      try {
        if (fromId && ID.test(fromId)) await jar.save(fromId);
        if (toId) await jar.restore(toId);
        log('[accounts] switched; player cookies swapped');
      } catch (e) { log(`[accounts] cookie swap failed: ${e.message}`); }
    },
    /** platform.tvSignIn */
    tvSignIn: async (twitch, opts = {}) => {
      const s = signIn(twitch);
      const r = await s.run({ add: !!(opts && opts.add), accountId: opts && ID.test(String(opts.accountId)) ? String(opts.accountId) : null });
      twitch.emitState();
      return r;
    },
    /** platform.playerSessionLogin: the twitch.tv login alone, for the active account. */
    playerLogin: async (twitch) => {
      const s = signIn(twitch);
      const win = openWindow();
      let closedFlag = false;
      const closed = win.closed.then(() => { closedFlag = true; return null; });
      try {
        win.load(LOGIN_URL);
        const login = await Promise.race([s.waitForWebLogin(), closed]);
        const st = await status();
        const ok = !closedFlag && login !== null && st.signedIn;
        log(`[player-login] finished: signedIn=${st.signedIn}`);
        const active = twitch.store().active;
        if (ok && active && ID.test(active)) await jar.save(active).catch(() => {});
        return { ok, login: st.login };
      } finally {
        if (s.stopWaitingForCookie) s.stopWaitingForCookie();
        if (!closedFlag) win.close();
      }
    },
    /**
     * fetch() for the direct engine: a GQL request carrying SESSION_TOKEN goes through native webGql, which sends it
     * with the session's real auth-token; everything else goes through the given fetch unchanged.
     */
    gqlFetch: (fetch) => async (url, init = {}) => {
      const headers = { ...(init.headers || {}) };
      const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
      if (String(url) !== GQL_URL || !authKey || headers[authKey] !== `OAuth ${SESSION_TOKEN}`) return fetch(url, init);
      delete headers[authKey];
      const r = await native.webGql({ headers, body: String(init.body || '') });
      const status = Number(r && r.status) || 0;
      const text = (r && r.data) || '';
      return { ok: status >= 200 && status < 300, status, url: GQL_URL, headers: { get: () => null, has: () => false }, text: async () => text, json: async () => JSON.parse(text) };
    },
  };
}
