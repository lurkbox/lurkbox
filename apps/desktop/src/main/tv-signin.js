'use strict';
// The single TV sign-in (twitch.tv login, then Authorize, in one in-app window): shared with the other hosts, see
// packages/core/src/shared/tv-signin.js. Here the web session is Electron's cookies, whose 'changed' events say when
// twitch.tv set auth-token. Cookie values are never logged.
const shared = require('@lurkbox/core/src/shared/tv-signin.js');
const { playerStatus, isTwitchCookie } = require('./player-session');

class TvSignIn extends shared.TvSignIn {
  /**
   * @param {object} d
   * @param {Electron.Cookies} d.cookies   the main session's cookies (an EventEmitter with 'changed')
   * Other options: see the shared TvSignIn.
   */
  constructor({ cookies, ...rest }) {
    super({ ...rest, webStatus: () => playerStatus(cookies) });
    this.cookies = cookies;
  }

  /** Resolves with the web login once twitch.tv sets auth-token. */
  waitForWebLogin() {
    return new Promise((resolve) => {
      const onCookie = (_e, cookie, _cause, removed) => {
        if (removed || cookie.name !== 'auth-token' || !cookie.value || !isTwitchCookie(cookie)) return;
        this.cookies.removeListener('changed', onCookie);
        setTimeout(async () => resolve((await playerStatus(this.cookies)).login || ''), this.settleMs);
      };
      this.cookies.on('changed', onCookie);
      this.stopWaitingForCookie = () => this.cookies.removeListener('changed', onCookie);
    });
  }
}

const { planSignIn, mismatchMessage, LOGIN_URL, ACTIVATE_RE } = shared;
module.exports = { TvSignIn, planSignIn, mismatchMessage, LOGIN_URL, ACTIVATE_RE };
