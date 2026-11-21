'use strict';
// Optional "player sign-in": a twitch.tv web session in the app's own session,
// so the embed recognises the viewer's subs and Turbo. The device-code OAuth
// token can't do this; the embed only honours twitch.tv's own cookies.
// Cookie VALUES are never logged or copied anywhere except the encrypted jar.
const fs = require('fs');
const path = require('path');
const { tvZoom } = require('@lurkbox/core/src/shared/tv-zoom.js');
const { navSource } = require('./frame-nav');

const TWITCH_URL = 'https://www.twitch.tv';
const isTwitchCookie = (c) => /(^|\.)twitch\.tv$/.test(String(c.domain || '').replace(/^\./, ''));

/** Encrypted per-account cookie jars (safeStorage) for switching Lurkbox accounts. */
class CookieJar {
  /**
   * @param {{cookies: Electron.Cookies, safeStorage: Electron.SafeStorage, dir: string}} deps
   */
  constructor({ cookies, safeStorage, dir }) {
    this.cookies = cookies;
    this.safe = safeStorage;
    this.dir = dir;
  }

  file(userId) {
    if (!/^\d+$/.test(String(userId))) throw new Error('bad user id');
    return path.join(this.dir, `${userId}.bin`);
  }

  async twitchCookies() {
    return (await this.cookies.get({})).filter(isTwitchCookie);
  }

  /** Removes every twitch.tv cookie from the session. */
  async clear() {
    for (const c of await this.twitchCookies()) {
      const host = String(c.domain).replace(/^\./, '');
      await this.cookies.remove(`https://${host}${c.path || '/'}`, c.name);
    }
  }

  /** Saves the session's twitch.tv cookies for this account (encrypted). */
  async save(userId) {
    if (!this.safe.isEncryptionAvailable()) return false;
    const list = (await this.twitchCookies()).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure,
      httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite,
    }));
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file(userId), this.safe.encryptString(JSON.stringify(list)), { mode: 0o600 });
    return true;
  }

  /** Clears the session's twitch.tv cookies and restores this account's jar (if any). */
  async restore(userId) {
    await this.clear();
    let buf;
    try { buf = fs.readFileSync(this.file(userId)); } catch { return 0; }
    let list = [];
    try { list = JSON.parse(this.safe.decryptString(buf)); } catch { return 0; }
    let n = 0;
    for (const c of list) {
      const host = String(c.domain).replace(/^\./, '');
      try {
        await this.cookies.set({ url: `https://${host}${c.path || '/'}`, ...c });
        n++;
      } catch { /* expired or rejected cookie */ }
    }
    return n;
  }

  /** The twitch.tv login saved in this account's jar, if it holds a web session (no cookie values leave here). */
  peekLogin(userId) {
    let list;
    try { list = JSON.parse(this.safe.decryptString(fs.readFileSync(this.file(userId)))); } catch { return null; }
    if (!Array.isArray(list) || !list.some((c) => c.name === 'auth-token' && c.value)) return null;
    const l = list.find((c) => c.name === 'login' || c.name === 'name');
    return l ? decodeURIComponent(l.value) : '';
  }

  remove(userId) {
    try { fs.rmSync(this.file(userId), { force: true }); } catch { /* already gone */ }
  }
}

/** Player sign-in status from cookies: { signedIn, login } (login is the public username). */
async function playerStatus(cookies) {
  const all = (await cookies.get({ url: TWITCH_URL }));
  const hasAuth = all.some((c) => c.name === 'auth-token' && c.value);
  const loginCookie = all.find((c) => c.name === 'login' || c.name === 'name');
  return { signedIn: hasAuth, login: hasAuth && loginCookie ? decodeURIComponent(loginCookie.value) : null };
}

/** Message for a player/Lurkbox account mismatch, or null when they match. */
function mismatchWarning(playerLogin, lurkboxLogin) {
  if (!playerLogin || !lurkboxLogin) return null;
  if (playerLogin.toLowerCase() === lurkboxLogin.toLowerCase()) return null;
  return `The player is signed in as ${playerLogin}, but Lurkbox is signed in as ${lurkboxLogin}. Subs apply to ${playerLogin}.`;
}

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Opens twitch.tv/login in a modal child window using the main session.
 * Resolves { ok, login } when the auth-token cookie appears, or { ok:false } when closed.
 */
/** Zoom for twitch.tv pages on a TV: scale so the page is laid out at ~460 CSS px tall, times the UI scale. */
function loginZoom(screenHeight, uiScale = 100) {
  return tvZoom(screenHeight, uiScale);
}

/** The in-app twitch.tv window (TV zoom, controller → keyboard preload, popups kept inside). */
function createLoginWindow({ BrowserWindow, parent, session, fullscreen, preload, zoom = 1, title = 'Sign in to Twitch' }) {
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 1100,
    height: 820,
    fullscreen,
    backgroundColor: '#0e0e10',
    title,
    autoHideMenuBar: true,
    webPreferences: { session, preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setUserAgent(CHROME_UA);
  // twitch.tv is laid out for a desktop monitor; scale it up so it's readable from the couch.
  const applyZoom = () => { if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom); };
  win.webContents.on('did-finish-load', applyZoom);
  // Controller navigation over the page (the preload forwards the presses). Twitch renders the form after load,
  // so pick a starting element once something focusable exists.
  win.webContents.on('dom-ready', () => {
    const wc = win.webContents;
    wc.executeJavaScript(navSource({ hint: 'D-pad: move \u00B7 A: select (opens the keyboard on text boxes) \u00B7 B: cancel', preferText: true })).catch(() => {});
    let n = 0;
    const t = setInterval(() => {
      if (win.isDestroyed() || ++n > 60) { clearInterval(t); return; }
      wc.executeJavaScript('window.__lbNav ? window.__lbNav.start() : false').then((ok) => { if (ok) clearInterval(t); }).catch(() => {});
    }, 250);
  });
  win.webContents.on('did-navigate-in-page', applyZoom);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Keep popups (e.g. "Log in with ...") inside this window.
    if (/^https:\/\/([a-z0-9-]+\.)*twitch\.tv\//.test(url)) win.loadURL(url);
    return { action: 'deny' };
  });
  return win;
}

function openPlayerLogin({ BrowserWindow, parent, session, fullscreen, preload, log, zoom = 1 }) {
  return new Promise((resolve) => {
    const win = createLoginWindow({ BrowserWindow, parent, session, fullscreen, preload, zoom, title: 'Sign in to the player' });
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      session.cookies.removeListener('changed', onCookie);
      const status = ok ? await playerStatus(session.cookies) : { signedIn: false, login: null };
      if (log) log(`[player-login] finished: signedIn=${status.signedIn}`);
      if (!win.isDestroyed()) win.close();
      resolve({ ok: ok && status.signedIn, login: status.login });
    };
    const onCookie = (_e, cookie, _cause, removed) => {
      if (!removed && cookie.name === 'auth-token' && isTwitchCookie(cookie) && cookie.value) {
        setTimeout(() => finish(true), 800); // let the 'login' cookie land too
      }
    };
    session.cookies.on('changed', onCookie);
    win.on('closed', () => finish(false));
    win.loadURL(`${TWITCH_URL}/login`);
  });
}

module.exports = { CookieJar, playerStatus, mismatchWarning, openPlayerLogin, createLoginWindow, loginZoom, isTwitchCookie, CHROME_UA };
