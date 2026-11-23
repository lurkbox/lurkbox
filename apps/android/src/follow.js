// Follow/unfollow on Android: the shared runFollow (shared/follow.js) with the channel's twitch.tv page in a hidden
// WebView of the web session (hidden-pages.js, 'follow'): it presses Twitch's own button once, only after the user's
// press (Unfollow only after Lurkbox's confirmation), and confirms the button flipped. The fallback, "Open on
// twitch.tv", is the channel page in the in-app twitch.tv window with the controller navigation.
import { runFollow, channelUrl } from '@lurkbox/core/src/shared/follow.js';

/**
 * @param {object} d
 * @param {ReturnType<import('./hidden-pages.js').createHiddenPages>} d.pages
 * @param {ReturnType<import('./web-session.js').createWebSession>} d.web
 * @param {(line: string) => void} d.log
 */
export function createFollow({ pages, web, log, run = runFollow }) {
  let busy = false;
  return {
    /** platform.followChannel */
    follow: async (req = {}) => {
      if (busy) return { ok: false, reason: 'busy' };
      busy = true;
      try {
        return await run({
          login: String((req && req.login) || ''), name: String((req && req.name) || '').slice(0, 60),
          action: req && req.action, confirmed: !!req && req.confirmed === true,
          hasSession: async () => (await web.status()).signedIn,
          // The page's sources are async (they wait for the button to flip): eval waits for their answer.
          openPage: async (url, timeoutMs) => {
            const p = await pages.open('follow', url, { timeoutMs });
            return { eval: (src) => p.eval(src, { timeoutMs: 20000 }), close: () => p.close() };
          },
          log,
        });
      } finally { busy = false; }
    },
    /** platform.openChannelPage: resolves when the window closes. */
    openPage: async (login) => {
      const url = channelUrl(String(login || ''));
      if (!url) return false;
      const win = web.openWindow();
      win.load(url);
      await win.closed;
      return true;
    },
  };
}
