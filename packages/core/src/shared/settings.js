// The settings schema: defaults, the theme list and validation of a settings patch. Shared by every
// platform: the desktop main process validates with it before saving (apps/desktop/src/main/store.js).
// ES module; the desktop main process loads it with require().
import { DEFAULT_CLIENT_ID } from './config.js';
import { CHAT_LAYOUT_DEFAULTS, sanitizeChatLayout } from './chat-layout.js';
import { DEFAULT_QUICK_CHAT, sanitizeQuickChat, sanitizeEmoteRecents } from './quick-chat.js';

export const THEMES = ['lurkbox', 'game-mode', 'classic-purple', 'oled', 'daylight', 'high-contrast', 'custom'];
export const CUSTOM_KEYS = ['bg', 'surface', 'accent', 'fg', 'muted'];
const HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_SETTINGS = Object.freeze({
  clientId: DEFAULT_CLIENT_ID, // an empty string saved in Settings means "no Client ID"
  defaultQuality: 'auto', // 'auto', 'chunked' (Source), '1080p60', '720p60', '720p30', '480p30', '360p30', '160p30'
  chatDefault: false,
  raidFollow: true,
  raidDelay: 10, // seconds before following a raid; B cancels
  skipContentGate: true, // auto-click the embed's "Start watching" content-classification gate
  inputWhenUnfocused: false, // accept controller input while the window is not focused (Floater safety)
  theme: 'lurkbox',
  volume: 1, // player volume 0..1
  screenMargin: 0, // percent: 0 | 2.5 | 5 (TV overscan)
  uiScale: 100, // percent, 90..150
  refreshInterval: 15, // seconds: 10 | 15 | 30 | 60
  followSort: 'recent',
  videoOnlyUnfocused: true, // hide chat/controls while unfocused (player only)
  confirmExit: true,
  navSounds: true,
  navSoundVolume: 30,
  profilePicker: 'remember', // 'remember' last account | 'ask' at startup
  playerEngine: 'direct', // 'direct' (hls.js) | 'embed' (official Twitch player)
  hwDecode: true,
  videoCodec: 'h264', // 'h264' (smoothest) | 'best' (AV1/H.265 when decoded efficiently)
  backgroundQuality: '720', // while unfocused for 3 s: 'same' | '720' | '480'
  lowLatency: true,
  autoCatchUp: true,
  chatStyle: 'lurkbox', // 'lurkbox' (IRC panel) | 'twitch' (Twitch's embedded chat: points, predictions, polls)
  autoClaimPoints: true, // click the channel-points bonus chest in Twitch's chat frame
  autoClaimDrops: true, // check Twitch's Drops inventory every 15 min and click Claim for finished drops
  earnWatchPoints: true, // direct engine: report watched minutes for the stream on screen, like Twitch's player
  chatEmotes7tv: true, // Lurkbox chat: 7TV emotes
  chatEmotesBttv: true, // BetterTTV emotes
  chatEmotesFfz: true, // FrankerFaceZ emotes
  chatAnimatedEmotes: true, // animated emotes (off: the static frame)
  chat7tvCosmetics: true, // 7TV name paints and badges
  chatExtensions: false, // experimental: the real 7TV/BTTV/FFZ browser extensions in Twitch chat mode
  quickChat: DEFAULT_QUICK_CHAT, // saved phrases: { global: [...], channels: { <broadcaster id>: { login, phrases } } } (./quick-chat.js)
  emoteRecents: Object.freeze({}), // the emote picker's Recent tab, per account: { <user id>: [names] }
  // Chat layout (chat pop-over in the player and Settings → Chat; see ./chat-layout.js): chatTextSize, twitchChatSize
  // (Twitch chat style: zoom inside Twitch's chat frame, 'auto' = the TV rule, or 75..250 percent), chatWidth,
  // chatSide, chatBgOpacity, chatOverlay, chatOverlayOpacity.
  ...CHAT_LAYOUT_DEFAULTS,
  steamArtSync: false, // recolour the Steam library art on theme changes (Settings → Appearance)
  customTheme: null, // { base, colors: { bg, surface, accent, fg, muted } }
});

export function sanitizeSettings(patch) {
  const out = {};
  if ('clientId' in patch) out.clientId = String(patch.clientId || '').trim().replace(/[^A-Za-z0-9]/g, '');
  if ('defaultQuality' in patch) out.defaultQuality = String(patch.defaultQuality || 'auto');
  for (const k of ['chatDefault', 'raidFollow', 'skipContentGate', 'inputWhenUnfocused', 'confirmExit', 'videoOnlyUnfocused', 'hwDecode', 'lowLatency', 'autoCatchUp', 'steamArtSync', 'autoClaimPoints', 'autoClaimDrops', 'earnWatchPoints', 'chatEmotes7tv', 'chatEmotesBttv', 'chatEmotesFfz', 'chatAnimatedEmotes', 'chat7tvCosmetics', 'chatExtensions', 'navSounds']) {
    if (k in patch) out[k] = !!patch[k];
  }
  if ('screenMargin' in patch) out.screenMargin = [0, 2.5, 5].includes(Number(patch.screenMargin)) && patch.screenMargin !== 'auto' ? Number(patch.screenMargin) : 0;
  if ('uiScale' in patch) { const n = Math.round(Number(patch.uiScale)); out.uiScale = Number.isFinite(n) ? Math.min(150, Math.max(90, n)) : 100; }
  if ('playerEngine' in patch) out.playerEngine = patch.playerEngine === 'embed' ? 'embed' : 'direct';
  if ('refreshInterval' in patch) out.refreshInterval = [10, 15, 30, 60].includes(Number(patch.refreshInterval)) ? Number(patch.refreshInterval) : 15;
  if ('followSort' in patch) out.followSort = ['recent', 'az', 'followed'].includes(patch.followSort) ? patch.followSort : 'recent';
  if ('videoCodec' in patch) out.videoCodec = patch.videoCodec === 'best' ? 'best' : 'h264';
  if ('backgroundQuality' in patch) out.backgroundQuality = ['same', '720', '480'].includes(String(patch.backgroundQuality)) ? String(patch.backgroundQuality) : '720';
  Object.assign(out, sanitizeChatLayout(patch));
  if ('quickChat' in patch) out.quickChat = sanitizeQuickChat(patch.quickChat);
  if ('emoteRecents' in patch) out.emoteRecents = sanitizeEmoteRecents(patch.emoteRecents);
  if ('chatStyle' in patch) out.chatStyle = patch.chatStyle === 'twitch' ? 'twitch' : 'lurkbox';
  if ('profilePicker' in patch) out.profilePicker = patch.profilePicker === 'ask' ? 'ask' : 'remember';
  if ('navSoundVolume' in patch) { const n = Math.round(Number(patch.navSoundVolume) / 10) * 10; out.navSoundVolume = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 30; }
  if ('volume' in patch) { const v = Number(patch.volume); out.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; }
  if ('theme' in patch) out.theme = THEMES.includes(patch.theme) ? patch.theme : DEFAULT_SETTINGS.theme;
  if ('customTheme' in patch) {
    const c = patch.customTheme;
    if (!c || typeof c !== 'object') out.customTheme = null;
    else {
      const colors = {};
      for (const k of CUSTOM_KEYS) if (c.colors && HEX.test(c.colors[k])) colors[k] = c.colors[k].toLowerCase();
      out.customTheme = { base: THEMES.includes(c.base) && c.base !== 'custom' ? c.base : 'lurkbox', colors };
    }
  }
  if ('raidDelay' in patch) {
    const n = Math.round(Number(patch.raidDelay));
    out.raidDelay = Number.isFinite(n) ? Math.min(120, Math.max(0, n)) : DEFAULT_SETTINGS.raidDelay;
  }
  return out;
}
