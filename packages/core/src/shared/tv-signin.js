// One sign-in for everything, on the TV (shared by the hosts; the desktop's apps/desktop/src/main/tv-signin.js and
// the Android platform wrap it):
//   1. twitch.tv/login in the in-app twitch.tv window (the web session the player uses for subs/Turbo);
//   2. in the same window and session, Lurkbox's own device-code flow: the window goes to the activate page with the
//      code filled in, and the user presses Authorize (never clicked for them). The token comes from polling as usual;
//   3. the web login and the authorized account must be the same user.
// The host supplies the web session's status (signed in, login name) and its cookie jars; no cookie value passes here.
export const LOGIN_URL = 'https://www.twitch.tv/login';
export const ACTIVATE_RE = /^https:\/\/(www\.)?twitch\.tv\/activate([?#]|$)/;
const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * What a sign-in has to do, given the current twitch.tv web session.
 *   'consent'    : already signed in to twitch.tv as the right user; only the Authorize page.
 *   'full'       : twitch.tv login, then Authorize.
 *   'full-clear' : clear the twitch.tv cookies first (adding an account, or the web session is someone else).
 */
export function planSignIn({ add = false, webLogin = null, targetLogin = null } = {}) {
  if (add) return 'full-clear';
  if (!webLogin) return 'full';
  if (targetLogin && !sameLogin(webLogin, targetLogin)) return 'full-clear';
  return 'consent';
}

export function mismatchMessage(webLogin, apiLogin) {
  return `twitch.tv is signed in as ${webLogin || 'nobody'}, but Twitch authorized Lurkbox for ${apiLogin}. Lurkbox signed both out; please sign in again with one account.`;
}

export class TvSignIn {
  /**
   * @param {object} d
   * @param {import('./twitch-auth.js').Twitch} d.twitch
   * @param {{save(id: string): Promise<unknown>, restore(id: string): Promise<unknown>, clear(): Promise<unknown>}} d.jar
   *   the host's per-account twitch.tv cookie jars
   * @param {() => Promise<{signedIn: boolean, login: string|null}>} d.webStatus  the twitch.tv web session (no values)
   * @param {() => {load(url: string): void, close(): void, closed: Promise<void>}} d.openWindow
   * @param {(line: string) => void} [d.log]
   * @param {number} [d.pollMs] how often waitForWebLogin() checks webStatus() (hosts with cookie events override it)
   * @param {number} [d.settleMs] wait after auth-token appears, so the 'login' cookie lands too
   */
  constructor({ twitch, jar, webStatus, openWindow, log = () => {}, pollMs = 500, settleMs = 800 }) {
    Object.assign(this, { twitch, jar, webStatus, openWindow, log, pollMs, settleMs });
    this.busy = false;
  }

  /** Resolves with the web login once twitch.tv sets auth-token (polls webStatus(); a host with cookie events overrides this). */
  waitForWebLogin() {
    return new Promise((resolve) => {
      let timer = null;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        let st = null;
        try { st = await this.webStatus(); } catch { /* try again */ }
        if (stopped) return;
        if (st && st.signedIn) {
          stopped = true;
          setTimeout(async () => resolve(((await this.webStatus().catch(() => null)) || st).login || ''), this.settleMs);
          return;
        }
        timer = setTimeout(tick, this.pollMs);
      };
      this.stopWaitingForCookie = () => { stopped = true; clearTimeout(timer); };
      tick();
    });
  }

  /** Resolves with the next terminal device-flow event. */
  waitForAuth() {
    return new Promise((resolve) => {
      const on = (ev) => {
        if (!['success', 'expired', 'denied'].includes(ev.status)) return;
        this.twitch.removeListener('auth', on);
        resolve(ev);
      };
      this.twitch.on('auth', on);
      this.stopWaitingForAuth = () => this.twitch.removeListener('auth', on);
    });
  }

  /**
   * @param {{add?: boolean, accountId?: string}} [opts] add: a new account (starts signed out of twitch.tv);
   *   accountId: re-auth that account (default: the active one, if it needs sign-in).
   */
  async run({ add = false, accountId = null } = {}) {
    if (this.busy) return { ok: false, error: 'busy' };
    this.busy = true;
    const before = JSON.parse(JSON.stringify(this.twitch.store())); // a snapshot: the store's objects are live
    const prevActive = before.accounts[before.active] ? before.active : null;
    const target = add ? null : (accountId || prevActive);
    const targetLogin = target && before.accounts[target] ? before.accounts[target].login || null : null;
    const web = await this.webStatus();
    const plan = planSignIn({ add, webLogin: web.signedIn ? web.login : null, targetLogin });
    this.log(`[signin] start: ${plan}${add ? ' (add account)' : ''}`);

    let cleared = false;
    if (plan === 'full-clear') {
      // Keep the current account's player session in its jar before signing twitch.tv out.
      const prevLogin = prevActive && before.accounts[prevActive].login;
      if (prevActive && /^\d+$/.test(prevActive) && web.signedIn && sameLogin(web.login, prevLogin)) await this.jar.save(prevActive);
      await this.jar.clear();
      cleared = true;
    }
    const undo = async () => {
      if (cleared && prevActive && /^\d+$/.test(prevActive) && this.twitch.store().active === prevActive) await this.jar.restore(prevActive);
    };

    let win = null;
    let closedFlag = false;
    try {
      win = this.openWindow();
      const closed = win.closed.then(() => { closedFlag = true; return null; });

      if (plan !== 'consent') {
        win.load(LOGIN_URL);
        const login = await Promise.race([this.waitForWebLogin(), closed]);
        if (closedFlag || login === null) { this.log('[signin] cancelled at twitch.tv login'); await undo(); return { ok: false, cancelled: true }; }
      }

      const flow = await this.twitch.startDeviceFlow({ keepCookies: true });
      if (!ACTIVATE_RE.test(String(flow.verificationUri || ''))) throw new Error('Twitch returned an unexpected activation address');
      const authP = this.waitForAuth();
      win.load(flow.verificationUri);
      const ev = await Promise.race([authP, closed]);
      if (closedFlag || ev === null) {
        this.twitch.cancelDeviceFlow();
        this.log('[signin] cancelled at the Authorize page');
        await undo();
        return { ok: false, cancelled: true };
      }
      if (ev.status !== 'success' || !ev.user) { await undo(); return { ok: false, error: ev.status }; }

      const now = await this.webStatus();
      if (!now.signedIn || !sameLogin(now.login, ev.user.login)) {
        this.log('[signin] web login and authorized account differ; signing both out');
        if (Object.prototype.hasOwnProperty.call(before.accounts, ev.user.id)) await this.twitch.signOut(ev.user.id);
        else await this.twitch.removeAccount(ev.user.id);
        await this.jar.clear();
        cleared = true;
        await undo();
        return { ok: false, error: 'mismatch', message: mismatchMessage(now.login, ev.user.login) };
      }
      await this.jar.save(ev.user.id);
      this.log(`[signin] signed in (${plan}); player and Lurkbox match`);
      return { ok: true, id: ev.user.id, login: ev.user.login, plan };
    } catch (e) {
      this.log(`[signin] failed: ${e.message}`);
      this.twitch.cancelDeviceFlow();
      await undo().catch(() => {});
      return { ok: false, error: 'failed', message: e.message };
    } finally {
      if (this.stopWaitingForCookie) this.stopWaitingForCookie();
      if (this.stopWaitingForAuth) this.stopWaitingForAuth();
      if (win && !closedFlag) { try { win.close(); } catch { /* already closed */ } }
      this.busy = false;
    }
  }
}

