// Live chat layout: text size, panel width, side, background opacity and the "over the video" mode. Pure maths,
// shared by the player (chat pop-over), Settings → Chat and the settings schema. ES module.
import { TWITCH_CHAT_LAYOUT_PX, twitchChatPanelWidth } from './tv-zoom.js';

/** Settings keys of the chat layout and their defaults ("Reset chat layout" puts these back). */
export const CHAT_LAYOUT_DEFAULTS = Object.freeze({
  chatTextSize: 100, // Lurkbox chat text, percent (75..250)
  twitchChatSize: 'auto', // Twitch chat style: zoom inside Twitch's chat frame, 'auto' or percent (75..250)
  chatWidth: 'auto', // side panel width: 'auto' (26rem, or the Twitch chat rule) or percent of the window (20..50)
  chatSide: 'right', // 'right' | 'left'
  chatBgOpacity: 100, // side panel background, percent (0..100)
  chatOverlay: false, // Lurkbox chat over the video instead of beside it
  chatOverlayOpacity: 55, // background of the chat over the video, percent (0..100)
});

export const TEXT_SIZE = Object.freeze({ min: 75, max: 250, step: 5 });
export const WIDTH = Object.freeze({ min: 20, max: 50, step: 1 });
export const OPACITY = Object.freeze({ min: 0, max: 100, step: 5 });
/** In side mode the panel never takes more than half the window, so the video keeps at least the other half. */
export const MAX_SHARE = 0.5;
/** ...and never less than this many px (a usable column of chat). */
export const MIN_PANEL_PX = 220;
/** Twitch chat breaks below about this many CSS px of layout width inside its frame. */
export const TWITCH_MIN_LAYOUT_PX = 250;
/** The Lurkbox chat panel's default width in rem (22 rem in windows up to 1100 px wide). */
export const LURKBOX_AUTO_REM = 26;
export const LURKBOX_AUTO_REM_NARROW = 22;

export const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Rounds to the range's step and clamps; null when v isn't a number. */
export function snap(v, { min, max, step }) {
  const n = Number(v);
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) return null;
  return clampNum(Math.round(n / step) * step, min, max);
}

/** Validates the chat layout keys present in `patch` (used by sanitizeSettings). */
export function sanitizeChatLayout(patch) {
  const out = {};
  if ('chatTextSize' in patch) out.chatTextSize = snap(patch.chatTextSize, TEXT_SIZE) ?? CHAT_LAYOUT_DEFAULTS.chatTextSize;
  if ('twitchChatSize' in patch) {
    const n = Number(patch.twitchChatSize);
    // Out of range (or 'auto', or junk) is Auto: the TV rule.
    out.twitchChatSize = patch.twitchChatSize !== 'auto' && Number.isFinite(n) && n >= TEXT_SIZE.min && n <= TEXT_SIZE.max ? snap(n, TEXT_SIZE) : 'auto';
  }
  if ('chatWidth' in patch) out.chatWidth = patch.chatWidth === 'auto' ? 'auto' : (snap(patch.chatWidth, WIDTH) ?? 'auto');
  if ('chatSide' in patch) out.chatSide = patch.chatSide === 'left' ? 'left' : 'right';
  if ('chatBgOpacity' in patch) out.chatBgOpacity = snap(patch.chatBgOpacity, OPACITY) ?? CHAT_LAYOUT_DEFAULTS.chatBgOpacity;
  if ('chatOverlay' in patch) out.chatOverlay = !!patch.chatOverlay;
  if ('chatOverlayOpacity' in patch) out.chatOverlayOpacity = snap(patch.chatOverlayOpacity, OPACITY) ?? CHAT_LAYOUT_DEFAULTS.chatOverlayOpacity;
  return out;
}

/** The layout keys of `settings`, each validated, missing ones at their defaults. */
export function chatLayout(settings = {}) {
  const s = settings || {};
  const pick = {};
  for (const k of Object.keys(CHAT_LAYOUT_DEFAULTS)) pick[k] = k in s ? s[k] : CHAT_LAYOUT_DEFAULTS[k];
  return { ...CHAT_LAYOUT_DEFAULTS, ...sanitizeChatLayout(pick) };
}

/**
 * "Over the video" is for Lurkbox chat only: Twitch's frames pause when covered, so Twitch chat style always sits
 * beside the video; so does chat on the Twitch player engine (the embed may pause itself under an overlay).
 */
export function chatOverActive({ layout, style, direct = true }) {
  return !!(layout && layout.chatOverlay && style !== 'twitch' && direct);
}

/**
 * Width in px of the chat panel (excluding the screen margin).
 *   auto, Lurkbox chat: 26 rem (22 rem up to 1100 px), at most half the window;
 *   auto, Twitch chat: TWITCH_CHAT_LAYOUT_PX at the frame's zoom, capped at 45% (twitchChatPanelWidth);
 *   a percentage: that share of the window, between MIN_PANEL_PX and half the window; for Twitch chat at least
 *   TWITCH_MIN_LAYOUT_PX of layout at the zoom (still within half the window).
 * Over the video the same width applies (the chat floats on top instead of shrinking the video).
 */
export function chatPanelWidth({ style = 'lurkbox', chatWidth = 'auto', windowWidth, zoom = 1, remPx = 16 }) {
  const W = Math.max(0, Number(windowWidth) || 0);
  const cap = W > 0 ? Math.floor(W * MAX_SHARE) : Infinity;
  const z = Number(zoom) || 1;
  if (chatWidth === 'auto' || chatWidth == null) {
    if (style === 'twitch') return twitchChatPanelWidth(z, W);
    const rem = W && W <= 1100 ? LURKBOX_AUTO_REM_NARROW : LURKBOX_AUTO_REM;
    return Math.min(cap, Math.round(rem * (Number(remPx) || 16)));
  }
  const pct = snap(chatWidth, WIDTH) ?? WIDTH.min;
  let px = Math.round(W * pct / 100);
  const min = style === 'twitch' ? Math.max(MIN_PANEL_PX, Math.round(TWITCH_MIN_LAYOUT_PX * z)) : MIN_PANEL_PX;
  px = Math.max(px, min);
  return Math.min(px, cap);
}

/** The width as a share of the window, for the slider when the setting is Auto. */
export function widthPercent(px, windowWidth) {
  const W = Number(windowWidth) || 0;
  return W > 0 ? clampNum(Math.round(px / W * 100), WIDTH.min, WIDTH.max) : WIDTH.min;
}

/** Layout width Twitch's chat gets inside its frame at this panel width and zoom (CSS px). */
export function twitchLayoutPx(panelPx, zoom) {
  return Math.round((Number(panelPx) || 0) / (Number(zoom) || 1));
}

export { TWITCH_CHAT_LAYOUT_PX };
