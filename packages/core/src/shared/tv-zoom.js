// TV zoom for twitch.tv pages Lurkbox shows at desktop size: the login window and Twitch's embedded chat
// (chat style "Twitch chat", channel-points rewards, predictions and polls). Shared by the core (panel width)
// and the hosts (which apply the zoom inside the page or frame).

/** About 1.74 on an 800-px-tall Game Mode screen, 2.35 at 1080p, between 1 and 3, times the UI scale. */
export function tvZoom(screenHeight, uiScale = 100) {
  const base = Math.min(3, Math.max(1, (Number(screenHeight) || 720) / 460));
  return Math.round(base * (Number(uiScale) || 100)) / 100;
}

/** Settings → Chat → Twitch chat size: 'auto' or a percentage (75..250; these are the round steps). */
export const TWITCH_CHAT_SIZES = [100, 125, 150, 175, 200, 225, 250];

/** Layout width (CSS px inside the frame) Twitch's chat gets at any zoom. */
export const TWITCH_CHAT_LAYOUT_PX = 340;
/** The panel never takes more than this share of the window width. */
export const TWITCH_CHAT_MAX_SHARE = 0.45;

/** The zoom applied inside Twitch's chat frame. */
export function twitchChatZoom(settings, screenHeight) {
  const v = settings && settings.twitchChatSize;
  const n = Number(v);
  if (v !== 'auto' && v != null && v !== '' && Number.isFinite(n) && n >= 75 && n <= 250) return Math.round(n) / 100;
  return tvZoom(screenHeight, settings && settings.uiScale);
}

/** Width in CSS px of the frame in the chat panel: TWITCH_CHAT_LAYOUT_PX at that zoom, capped at 45% of the window. */
export function twitchChatPanelWidth(zoom, windowWidth) {
  const want = Math.round(TWITCH_CHAT_LAYOUT_PX * (Number(zoom) || 1));
  const cap = Math.floor((Number(windowWidth) || 0) * TWITCH_CHAT_MAX_SHARE);
  return cap > 0 ? Math.min(want, cap) : want;
}

/** Layout width (CSS px inside the frame) the rewards view (modal) keeps at any zoom: Twitch's popover needs it. */
export const TWITCH_MODAL_MIN_LAYOUT_PX = 400;

/**
 * Zoom for Twitch's chat frame in a mode of the core's TwitchChatFrame: 'hidden' (off-screen, for the points scan and
 * the bonus chest) gets none, so Twitch lays it out as a normal desktop chat; at the TV zoom its layout would be under
 * 200 CSS px wide and Twitch drops the chat input row with the points summary. 'panel' gets the TV zoom; 'modal' too,
 * lowered so the layout stays TWITCH_MODAL_MIN_LAYOUT_PX wide. Returns the options for zoomFrameSource().
 */
export function chatFrameZoom(mode, zoom) {
  if (mode === 'hidden') return { zoom: 1 };
  if (mode === 'modal') return { zoom, minWidth: TWITCH_MODAL_MIN_LAYOUT_PX };
  return { zoom };
}

/**
 * Script run inside the chat frame: sets (or updates) a zoom style on <html>. Idempotent. With minWidth the zoom is
 * lowered (not below 1) so the frame's layout keeps that many CSS px. Returns { zoom (computed), vw, vh (the frame's
 * CSS viewport), lw, lh (the layout size at that zoom) } for the log.
 */
export function zoomFrameSource(zoom, { minWidth = 0 } = {}) {
  const z = Math.min(3, Math.max(0.5, Number(zoom) || 1));
  const minW = Math.max(0, Number(minWidth) || 0);
  return `(() => {
  let z = ${z};
  if (${minW} > 0 && innerWidth > 0) z = Math.min(z, Math.max(1, Math.floor(innerWidth / ${minW} * 100) / 100));
  let s = document.getElementById('lurkbox-tv-zoom');
  if (!s) { s = document.createElement('style'); s.id = 'lurkbox-tv-zoom'; (document.head || document.documentElement).append(s); }
  const css = 'html { zoom: ' + z + ' !important; }';
  if (s.textContent !== css) s.textContent = css;
  const computed = Number(getComputedStyle(document.documentElement).zoom) || 1;
  return { zoom: computed, vw: innerWidth, vh: innerHeight, lw: Math.round(innerWidth / computed), lh: Math.round(innerHeight / computed) };
})()`;
}
