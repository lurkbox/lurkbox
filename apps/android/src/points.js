// Channel points on Android: the channel's embedded chat page in a hidden WebView (hidden-pages.js, 340×720 CSS px at
// zoom 1, like the desktop's hidden frame), scanned every 4 s with the shared source (shared/channel-points.js): the
// balance, the bonus chest (auto-claim) and new predictions/polls. The rewards view is the same chat page in the in-app
// twitch.tv window (web-session.js openWindow), with the rewards popover opened, fitted and driven by the remote
// natively (frame-nav), at the TV zoom lowered so the layout stays at least 400 px wide; the system keyboard comes up
// for a message reward. Without a twitch.tv session nothing is loaded.
import { PointsTracker, scanSource, chatPageUrl, rewardsViewSource, rewardsReturnSource } from '@lurkbox/core/src/shared/channel-points.js';
import { twitchChatZoom, modalZoom } from '@lurkbox/core/src/shared/tv-zoom.js';

const LOGIN = /^[a-z0-9_]{1,25}$/i;

/**
 * @param {object} d
 * @param {ReturnType<import('./hidden-pages.js').createHiddenPages>} d.pages
 * @param {ReturnType<import('./web-session.js').createWebSession>} d.web
 * @param {() => object} d.getSettings
 * @param {(name: string, data: object) => void} d.emit   'points:state' and 'points:event'
 * @param {(line: string) => void} d.log
 */
export function createPoints({ pages, web, getSettings, emit, log, every = setInterval, stopEvery = clearInterval,
  screenWidth = () => (globalThis.screen && globalThis.screen.width) || 960 }) {
  const tracker = new PointsTracker();
  let login = null;
  let timer = null;
  let page = null; // the loaded chat page (for login), or a promise of it
  let pageFor = null;
  let note = '';
  let panel = null; // the rewards view's window while it is open
  let scanning = false;
  const say = (line) => { if (line !== note) { note = line; log(line); } };

  const closePage = () => {
    if (page) pages.close('points');
    page = null;
    pageFor = null;
  };

  const ensurePage = async (l) => {
    if (page && pageFor === l) return page;
    closePage();
    pageFor = l;
    page = pages.open('points', chatPageUrl(l)).catch((e) => { say(`[points] ${l}: chat page failed (${e.message})`); if (pageFor === l) { page = null; pageFor = null; } return null; });
    return page;
  };

  const scan = async () => {
    const l = login;
    if (!l || scanning) return;
    scanning = true;
    try {
      if (!(await web.status()).signedIn) {
        say(`[points] ${l}: no twitch.tv session; channel points inactive (sign in on the TV to use them)`);
        closePage();
        emit('points:state', { login: l, signedIn: false, balance: null });
        return;
      }
      const p = await ensurePage(l);
      if (!p || l !== login) return;
      let s;
      try { s = await p.evalSync(scanSource({ autoClaim: (getSettings() || {}).autoClaimPoints !== false })); } catch (e) { say(`[points] ${l}: scan failed (${e.message})`); return; }
      if (l !== login || !s) return;
      const { events, state } = tracker.update(s);
      for (const ev of events) {
        if (ev.type === 'signed-in') say(`[points] ${l}: chat ${ev.signedIn ? 'shows the points balance' : `shows no points (signed out, or the channel has no points; sign-in prompt ${s.signInPrompt ? 'shown' : 'absent'}; CSS viewport ${s.vw}x${s.vh})`}`);
        else if (ev.type === 'claim-clicked') log(`[points] ${l}: clicked Claim Bonus`);
        else if (ev.type === 'claimed') log(`[points] ${l}: claimed bonus ${ev.amount != null ? `+${ev.amount}` : '(amount not seen)'}, balance ${ev.balance}`);
        else if (ev.type === 'prediction' || ev.type === 'poll') { log(`[points] ${l}: ${ev.type} shown`); emit('points:event', { login: l, ...ev }); }
      }
      emit('points:state', { login: l, ...state });
    } finally { scanning = false; }
  };

  return {
    /** platform.pointsWatch */
    watch: async (value) => {
      const l = value && LOGIN.test(String(value)) ? String(value).toLowerCase() : null;
      if (l === login) return true;
      login = l;
      tracker.reset(l);
      note = '';
      if (timer) stopEvery(timer);
      timer = null;
      closePage();
      if (l) {
        timer = every(() => { scan().catch(() => {}); }, 4000);
        scan().catch(() => {});
      }
      return true;
    },
    /** platform.pointsOpenPanel: the rewards view in the twitch.tv window; 'panel-closed' when the user leaves it. */
    openPanel: async (opts = {}) => {
      const l = login;
      if (!l) return { ok: false, reason: 'chat not loaded' };
      if (!(await web.status()).signedIn) return { ok: false, reason: 'not signed in to twitch.tv' };
      const rewards = !!(opts && opts.rewards);
      const zoom = modalZoom(twitchChatZoom(getSettings() || {}, web.screenHeight()), screenWidth());
      const win = web.openWindow({ zoom, script: rewardsViewSource({ rewards }), textScript: rewards ? rewardsReturnSource() : '' });
      panel = win;
      win.closed.then(() => {
        if (panel === win) panel = null;
        emit('points:event', { login: l, type: 'panel-closed' });
      });
      win.load(chatPageUrl(l));
      log(`[points] ${l}: rewards view opened (${rewards ? 'rewards' : 'prediction/poll'}, zoom ${zoom})`);
      return { ok: true, opened: true };
    },
    /** The remote drives the window natively; a press that still reaches the app has nothing to do there. */
    pad: async (key) => (String(key) === 'b' ? 'close' : null),
    closePanel: async () => {
      const win = panel;
      panel = null;
      if (win) win.close();
      return true;
    },
    /** For tests. */
    scan,
  };
}
