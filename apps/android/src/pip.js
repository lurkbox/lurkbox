// Picture-in-picture on phones and tablets (MainActivity.java): while a video plays in the player and the setting is
// on, the page tells the activity (LurkboxNative.pip) so Home or the swipe up opens the small window (Android 12+ by
// itself, older versions from onUserLeaveHint). In the window the page shows only the video (body.pip, the "video
// only" rules in the core's CSS); the class goes when the window is expanded or closed. Its play/pause button and its
// closing arrive as pipAction events, which platform.js passes on as onMediaAction.
import { anyVideoPlaying } from './playback.js';

/**
 * @param {object} d
 * @param {Document} d.doc
 * @param {{pip?, addListener?}} d.native   LurkboxNative
 * @param {() => boolean} d.enabled         the pipOnLeave setting
 * @returns {{ update(): void, setMode(inPip: boolean): void, state(): {wanted: boolean, playing: boolean, inPip: boolean}, stop(): void }}
 */
export function createPip({ doc, native, enabled }) {
  let sent = null; // "wanted|playing" last told to the activity
  let inPip = false;
  const playerOpen = () => !!(doc.body && doc.body.classList.contains('player-active'));
  const current = () => {
    const playing = playerOpen() && anyVideoPlaying(doc);
    return { wanted: !!enabled() && playing, playing };
  };
  const update = () => {
    if (!native || !native.pip) return;
    const s = current();
    const key = `${s.wanted}|${s.playing}`;
    if (key === sent) return;
    sent = key;
    Promise.resolve(native.pip(s)).catch(() => {});
  };
  const setMode = (on) => {
    inPip = !!on;
    if (doc.body) doc.body.classList.toggle('pip', inPip);
  };
  const events = ['playing', 'play', 'pause', 'ended', 'emptied', 'abort', 'error'];
  for (const e of events) doc.addEventListener(e, update, true);
  const handles = [];
  if (native && native.addListener) {
    const h = native.addListener('pipMode', (d) => { setMode(!!(d && d.inPip)); update(); });
    handles.push(h);
  }
  // The player opening or closing is a class on body.
  let observer = null;
  const MO = doc.defaultView && doc.defaultView.MutationObserver;
  if (MO && doc.body) { observer = new MO(update); observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] }); }
  return {
    update,
    setMode,
    state: () => ({ ...current(), inPip }),
    stop() {
      for (const e of events) doc.removeEventListener(e, update, true);
      if (observer) observer.disconnect();
      for (const h of handles) Promise.resolve(h).then((x) => x && x.remove && x.remove()).catch(() => {});
    },
  };
}

/** Wires createPip to the platform's settings (window.lurkbox). */
export function installPip(doc, native, platform) {
  if (!native || !native.pip) return null;
  let on = true;
  const pip = createPip({ doc, native, enabled: () => on });
  Promise.resolve(platform.getSettings()).then((s) => { on = s.pipOnLeave !== false; pip.update(); }).catch(() => {});
  platform.onSettingsChanged((s) => { on = s.pipOnLeave !== false; pip.update(); });
  return pip;
}
