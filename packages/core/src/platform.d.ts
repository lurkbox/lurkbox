// The platform interface: everything @lurkbox/core asks of its host.
//
// The core (this package) is plain browser code. It never uses Node or Electron; its only contact with the
// platform is the `window.lurkbox` object described here, plus the resources listed under "Host-served files".
// Each app implements it:
//   - desktop: apps/desktop/src/preload.js (contextBridge → ipcMain handlers in apps/desktop/src/main/main.js);
//   - Android: apps/android/src/platform-android.js (Capacitor), see docs/android.md.
//
// Rules for hosts:
//   - Every method returns a Promise unless noted; failures resolve to an { ok: false, ... } shape or null as
//     documented rather than rejecting, wherever the desktop host does so today.
//   - `on*` members subscribe to host events: they take a callback and return an unsubscribe function.
//   - Members marked "Optional" are feature-tested by the core (`if (window.lurkbox.x)`), so a host may leave them
//     out; the feature then hides or falls back. Members marked "Desktop" only make sense on SteamOS/Linux; other
//     hosts should omit them (if optional) or implement them as documented no-ops.
//   - Settings patches must be validated with sanitizeSettings() from ./shared/settings.js before they are saved.
//   - Twitch's embedded chat frame (chat style "Twitch chat", rewards, predictions, polls) is drawn at desktop size.
//     Hosts zoom it inside the frame with twitchChatZoom() / zoomFrameSource() from ./shared/tv-zoom.js on every load
//     and settings change; the core widens the panel to match (twitchChatPanelWidth).
//
// Host-served files (same origin as index.html):
//   - /vendor/hls.min.js     hls.js (dist/hls.min.js of the hls.js dependency), loaded by the direct engine;
//   - /vendor/wordmark.json  assets/src/wordmark.json (the logo outlines for the Steam art renderer).
// The official Twitch embed needs the page origin's host name to be `localhost` (its `parent` parameter).
//
// packages/core/src/platform-check.js (run by `npm test`) fails when the core uses a window.lurkbox member that
// is not declared in LurkboxPlatform below, or when a declared member is no longer used; apps/desktop's tests
// check that preload.js exposes exactly these members, and apps/android's that its platform has every required one
// and nothing undocumented.

export type Unsubscribe = () => void;

/** Static facts about this launch. */
export interface AppInfo {
  /** Running in a window rather than fullscreen (desktop `--windowed`). */
  windowed: boolean;
  /** Running under Gamescope (SteamOS Game Mode). */
  gamescope: boolean;
  /** Channel login to open at start (desktop `--channel=`), or null. */
  startChannel: string | null;
  /** VOD id to open at start (desktop `--vod=`), or null. */
  startVod: string | null;
  /** App version string. */
  version: string;
  /** Optional. The host can show the touch layouts (tablet, phone; shared/layout-mode.js): Android sets it, the
   *  desktop leaves it out, so Settings → Layout → Auto is always the TV layout there. Auto still needs a coarse
   *  pointer and no controller, so Android TV gets the TV layout. */
  touch?: boolean;
  /** Optional. Set only in demo mode (desktop: LURKBOX_DEMO=1, for screenshots): the page installs ./js/demo/install.js,
   *  which fakes the clock, chat and emote APIs. mediaBase prefixes the demo's pictures; now is the pinned clock (ms);
   *  touch (LURKBOX_DEMO_TOUCH=1) treats the pointer as a touchscreen, for the touch layout screenshots;
   *  whisperInMs > 0 fakes an incoming whisper that long after start (desktop LURKBOX_DEMO_WHISPER_IN=<s>; 0 or left out: none). */
  demo?: { mediaBase: string; now?: number; touch?: boolean; whisperInMs?: number } | null;
  /** DEFAULT_SETTINGS from ./shared/settings.js. */
  defaults: Settings;
}

/** The saved settings; see DEFAULT_SETTINGS in ./shared/settings.js for every key and its default. */
export type Settings = Record<string, unknown>;

export interface Account {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  /** The stored token is missing, expired beyond refresh, or lacks scopes. */
  needsSignin: boolean;
}

/** Sign-in state of the Twitch API half (device-code token). */
export interface AuthState {
  hasClientId: boolean;
  signedIn: boolean;
  /** The token lacks scopes that Lurkbox now requests (SCOPES in ./shared/config.js). */
  needsReauth: boolean;
  missingScopes: string[];
  user: { id: string; login: string; display_name?: string; profile_image_url?: string } | null;
  /** Id of the active account, or null. */
  active: string | null;
  accounts: Account[];
  /** The running phone (device-code) flow; null when none runs. */
  deviceFlow: { userCode: string; verificationUri: string; expiresIn: number; status: string } | null;
}

/** A device-code flow event: 'success' (with the user), 'expired' or 'denied'. */
export interface AuthEvent {
  status: 'success' | 'expired' | 'denied' | string;
  user?: { id: string; login: string } | null;
}

/** Sign-in state of the player half (the twitch.tv web session, for subs and Turbo). */
export interface PlayerSessionState {
  signedIn: boolean;
  login: string | null;
  /** A warning when the web session and the API token belong to different users, else null. */
  mismatch: string | null;
}

export interface HelixRequest {
  /** Path under https://api.twitch.tv/helix, e.g. '/streams/followed'. */
  path: string;
  /** Query parameters; arrays repeat the key; empty values are dropped. */
  query?: Record<string, string | number | boolean | Array<string | number> | null | undefined>;
  method?: string;
  body?: unknown;
  /** Account to call as; defaults to the active one. */
  accountId?: string;
}

export type HelixResult =
  | { ok: true; status: number; data: any }
  | { ok: false; status: number; error: string; data: any; resetAt: number | null };

/** A VOD's details stored with its resume position. */
export interface ResumeMeta {
  title?: string;
  login?: string;
  name?: string;
  userId?: string;
  thumb?: string; // Helix thumbnail_url (with %{width}x%{height})
}

/** resumeList(): a saved position (seconds) and when it was saved (ms). */
export interface ResumeEntry extends ResumeMeta {
  id: string;
  position: number;
  duration: number | null;
  at: number;
}

/** A whisper conversation kept on the device (see ./shared/whispers.js; at most 50 threads of 200 messages). */
export interface WhisperThread {
  /** The other person's user id. */
  id: string;
  login: string;
  name: string;
  /** Unread incoming whispers. */
  unread: number;
  /** The newest message's time (ms). */
  at: number;
  /** Oldest first. me: sent by this account; failed: why Twitch didn't send it. */
  messages: Array<{ id: string; me: boolean; text: string; at: number; failed?: string }>;
}

export interface ChatExtensionStatus {
  key: string;
  name: string;
  installed: string | null;
  latest: string | null;
  status: string;
  error: string | null;
  loaded: boolean;
}

/** A gamepad read by the host outside the Gamepad API (desktop: Linux joydev), in standard-mapping form. */
export interface HostPad {
  index: number;
  id: string;
  gone?: boolean;
  buttons?: Array<{ pressed: boolean; value: number }>;
  axes?: number[];
  [k: string]: unknown;
}

export interface LurkboxPlatform {
  // ---- app and window ----

  /** Launch facts and the default settings. Called once at startup. */
  appInfo(): Promise<AppInfo>;
  /** Quit the app (B on home, after the confirm dialog). */
  quit(): Promise<void>;
  /** Optional. Toggle fullscreen (F11, player menu). Desktop: BrowserWindow fullscreen, never exclusive. */
  toggleFullscreen?(): Promise<void>;
  /** Optional, Desktop. Set the window/taskbar icon to the theme-coloured mascot (PNG data URL, ≤ 2 MB). Resolves true when applied. */
  setWindowIcon?(pngDataUrl: string): Promise<boolean>;
  /** Window focus changes (true = focused). Drives "video only while unfocused" and the background quality cap. */
  onWindowFocus(cb: (focused: boolean) => void): Unsubscribe;
  /** Optional, Desktop. Gamepads read outside the Gamepad API (Linux joydev), merged into input handling. */
  onJoydevPad?(cb: (pad: HostPad) => void): Unsubscribe;
  /** Optional. Append a line to the host's log (desktop: userData/lurkbox.log). Must never throw into the caller. */
  log?(line: string): Promise<void> | void;
  /** Render text as a QR code; resolves an <svg> string (phone sign-in, links). */
  qrSvg(text: string): Promise<string>;
  /**
   * Optional, Desktop. Open the system's on-screen keyboard over the focused text box (desktop: Steam's keyboard, in
   * Game Mode only; it types into the box). Resolves true when it opened; false makes the core show its own keyboard.
   */
  openOnScreenKeyboard?(): Promise<boolean>;

  // ---- settings ----

  /** The saved settings merged over the defaults. */
  getSettings(): Promise<Settings>;
  /** Validate (sanitizeSettings) and save a partial patch; resolves the full new settings and fires onSettingsChanged. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Settings changed (by this page or by the host). */
  onSettingsChanged(cb: (settings: Settings) => void): Unsubscribe;

  // ---- accounts and sign-in ----

  /** Current API sign-in state for all accounts. */
  authState(): Promise<AuthState>;
  /** Start the phone (device-code) flow; the code shows via onAuthState(deviceFlow). */
  authStart(): Promise<{ ok: true; flow: unknown } | { ok: false; error: string }>;
  /** Cancel a running device-code flow. */
  authCancel(): Promise<void>;
  /** Sign out an account (default: the active one): its API token and, for the active one, its player session. */
  signOut(id?: string): Promise<unknown>;
  /** Optional. The TV sign-in: twitch.tv login, then Authorize for Lurkbox, in one in-app window. `add` starts signed out for a new account; `accountId` re-signs one. Without it the core uses the phone (device-code) sign-in everywhere and never offers the player sign-in. */
  tvSignIn?(opts?: { add?: boolean; accountId?: string | null }): Promise<
    | { ok: true; id: string; login: string; plan: string }
    | { ok: false; cancelled?: boolean; error?: string; message?: string }
  >;
  /** Per account: is the API token usable, and is the player (web session) signed in as the same user? */
  accountsStatus(): Promise<Array<{ id: string; api: boolean; player: boolean; playerLogin: string | null }>>;
  /** Make another account active (swaps its player session in); the new state arrives via onAuthState. */
  switchAccount(id: string): Promise<unknown>;
  /** Forget an account and its stored player session. */
  removeAccount(id: string): Promise<unknown>;
  /** API sign-in state changed. */
  onAuthState(cb: (state: AuthState) => void): Unsubscribe;
  /** Device-code flow finished: success, expired or denied. */
  onAuthEvent(cb: (event: AuthEvent) => void): Unsubscribe;

  // ---- Twitch API ----

  /**
   * Call the Helix API with the account's token (the token never reaches the page). Refreshes on 401. Chat sending
   * uses it too: POST /chat/messages (user:write:chat) and GET /chat/emotes/user (user:read:emotes); whispers use
   * POST /whispers (user:manage:whispers, 204 with no body); a 429 carries Ratelimit-Reset (seconds since the epoch)
   * as resetAt.
   */
  helix(req: HelixRequest): Promise<HelixResult>;

  // ---- player session (twitch.tv web login, for subs/Turbo in the player) ----

  /** Whether the player half is signed in, and as whom. */
  playerSessionStatus(): Promise<PlayerSessionState>;
  /** Optional. Open the twitch.tv login for the player only; resolves the outcome plus the new state. Without it the core doesn't offer the player sign-in. */
  playerSessionLogin?(): Promise<PlayerSessionState & { ok: boolean; [k: string]: unknown }>;
  /** Sign the player half out. */
  playerSessionSignOut(): Promise<PlayerSessionState>;

  // ---- official embed (fallback engine) ----

  /** Click the embed's content-classification gate (and, with play: true, its play button) inside the cross-origin player frame. Resolves what was clicked, or ''. */
  dismissPlayerGate(opts?: { play?: boolean }): Promise<string>;
  /** Optional. Debug probe of the embed frame (booleans only: viewer logged in, ad showing). */
  probePlayer?(): Promise<{ viewerLoggedIn: boolean | null; adShowing: boolean | null }>;

  // ---- direct engine (Twitch web GQL + usher; see README "Unofficial Twitch interfaces") ----

  /** Fetch the HLS master playlist for a live channel or VOD with the web session's token, so CORS and the auth cookie stay in the host. The desktop rewrites segment URLs through its own proxy scheme. */
  directMaster(req: { login?: string; vodId?: string; codecs?: Array<'av1' | 'h265' | 'h264'> }): Promise<
    | { ok: true; master: string; authed: boolean; anonReason?: string }
    | { ok: false; reason: string; offline?: boolean }
  >;
  /** Optional. Signed out: the live stream's id/start time and its archive VOD, from web GQL. Null on failure. */
  liveInfo?(login: string): Promise<{ stream: { id: string; started_at: string; user_id: string } | null; archive: unknown } | null>;
  /** Optional. VOD scrubbing thumbnails (seekPreviewsURL sprite sheets). Null when unavailable. */
  storyboard?(vodId: string): Promise<{ count: number; width: number; height: number; rows: number; cols: number; interval: number; images: string[] } | null>;

  /**
   * Optional. A clip's MP4 qualities with a signed playback token (web GQL VideoAccessToken_Clip, anonymous), best
   * first or in any order: [{ quality: '1080', frameRate: 60, url }]. reason 'not-found' for a deleted clip. Without
   * this member (or when it fails) the core plays Twitch's clip embed (clips.twitch.tv/embed).
   */
  clipSources?(slug: string): Promise<
    | { ok: true; qualities: Array<{ quality: string; frameRate: number; url: string }> }
    | { ok: false; reason: string }
  >;

  // ---- VOD resume positions (per account) ----

  /** Optional. Saved position for a VOD, or null. */
  resumeGet?(videoId: string): Promise<{ position: number; duration: number; at: number } | null>;
  /**
   * Optional. Save a VOD position (0 clears it, e.g. watched to the end) and the video's details for Continue
   * watching (validated with shared/continue-watching.js sanitizeResumeMeta; kept from the last save when left out).
   */
  resumeSet?(videoId: string, position: number, duration?: number, meta?: ResumeMeta): Promise<boolean>;
  /** Optional. Every saved position of the active account with its details (Following → Continue watching). */
  resumeList?(): Promise<ResumeEntry[]>;
  /** Optional. Forget every saved position of the active account (Settings → Clear watch history). */
  resumeClear?(): Promise<boolean>;

  // ---- whispers (history kept on the device, per account) ----

  /** Optional (without it the Whispers section says it isn't available). The account's stored whisper threads, newest first. */
  whispersLoad?(accountId: string): Promise<WhisperThread[]>;
  /**
   * Replace the account's stored threads (an empty list forgets them: Settings → Clear whispers). Hosts validate and
   * cap them with ./shared/whispers.js storeWhispers(); removing an account forgets its whispers too.
   */
  whispersSave(accountId: string, threads: WhisperThread[]): Promise<boolean>;

  // ---- channel points (Twitch's embedded chat page, scanned by the host) ----

  /** Optional. Watch the channel's embedded chat frame for the points balance, bonus chest (auto-claim), predictions and polls; null stops. */
  pointsWatch?(login: string | null): Promise<boolean>;
  /** Optional. The chat frame's mode ('hidden', 'panel' or 'modal'): the host zooms it for the TV in the panel and the large view only. */
  pointsMode?(mode: 'hidden' | 'panel' | 'modal'): Promise<boolean>;
  /** The chat frame is shown as the large rewards view: open the rewards popover (rewards: true) or focus the chat's prediction/poll, fitted to the frame, for controller navigation inside it. */
  pointsOpenPanel(opts?: { rewards?: boolean }): Promise<{ ok: boolean; opened?: boolean; reason?: string }>;
  /** Forward a controller key ('up', 'down', 'left', 'right', 'a' or 'b') to the frame's navigation. Resolves the frame's answer ('keyboard' after A on a text box; for 'b', 'back' when a sub-view closed, else 'close'), or null. */
  pointsPad(key: string): Promise<string | null>;
  /** Close the popover and reset in-frame navigation. */
  pointsClosePanel(): Promise<boolean>;
  /** Optional. Points state for the watched channel: { login, signedIn, balance, ... }. */
  onPointsState?(cb: (state: { login: string; signedIn?: boolean; balance: number | null; [k: string]: unknown }) => void): Unsubscribe;
  /** Points events (a prediction or poll appeared). Used together with onPointsState. */
  onPointsEvent(cb: (event: { login: string; type: string; [k: string]: unknown }) => void): Unsubscribe;
  /** Optional. Once a minute while a live stream plays on the direct engine: report a watched minute (earns watch-time points; the host applies the gates). */
  watchMinute?(info: { login: string; channelId: string; broadcastId: string; direct: boolean; live: boolean; rewound: boolean; playing: boolean }): Promise<{ ok: boolean; [k: string]: unknown }>;

  // ---- Twitch Drops (Twitch's own Drops Inventory page with the twitch.tv session; the host auto-claims) ----

  /** Optional (without it the Drops section is hidden). Whether a twitch.tv web session exists (the Drops section shows a sign-in prompt otherwise) and when the background inventory check last ran (ms since the epoch, or null). */
  dropsStatus?(): Promise<{ signedIn: boolean; lastCheckAt: number | null; nextCheckAt: number | null }>;
  /** The Drops section's frame (https://www.twitch.tv/drops/inventory) got the app's focus: zoom it for the TV and start controller navigation inside it. */
  dropsOpen(): Promise<{ ok: boolean; reason?: string }>;
  /** Forward a controller key ('up', 'down', 'left', 'right', 'a' or 'b') to the inventory frame. For 'b', resolves 'back' when a dialog in the page closed, else 'close' (the app leaves the frame). */
  dropsPad(key: string): Promise<string | null>;
  /** The frame lost the app's focus: stop the navigation inside it. */
  dropsClose(): Promise<boolean>;
  /** Optional. Campaigns in progress from the last inventory check, for the player's drops chip: [{ game, name, drops: [{ name, percent, claimable }] }]. */
  dropsProgress?(): Promise<{ checkedAt: number | null; campaigns: { game: string; name: string; drops: { name: string; percent: number | null; claimable: boolean }[] }[] }>;
  /** Optional. Drops events: { type: 'claimed', name } after auto-claim pressed a drop's Claim button and the page took it. */
  onDropsEvent?(cb: (event: { type: string; name?: string }) => void): Unsubscribe;

  // ---- follow / unfollow (desktop: Twitch's own channel page in the twitch.tv session; the public API has none) ----

  /**
   * Optional. Presses Twitch's own Follow (or, with confirmed: true after the user confirmed, Unfollow) button on the
   * channel's twitch.tv page in a hidden window, and resolves once the button flipped. reason: 'no-session' (no
   * twitch.tv sign-in), 'challenge' (captcha), 'signed-out', 'wrong-channel', 'timeout', 'load', 'busy', 'invalid'.
   */
  followChannel?(req: { login: string; name?: string; action: 'follow' | 'unfollow'; confirmed?: boolean }): Promise<{ ok: boolean; following?: boolean; already?: boolean; reason?: string }>;
  /** Optional. Opens the channel's twitch.tv page in the in-app TV window (controller navigation, B closes); resolves when it closes. */
  openChannelPage?(login: string): Promise<boolean>;

  // ---- open requests (desktop: from the Decky plugin's go-live toasts) ----

  /** The page is ready for open requests; resolves one that arrived before it was ready, or null. */
  openReady(): Promise<{ channel: string; name: string } | null>;
  /** Open this channel now. */
  onOpenChannel(cb: (req: { channel: string; name: string }) => void): Unsubscribe;

  // ---- Steam library art (Desktop) ----

  /** Optional, Desktop. Write the theme-coloured capsule, wide, hero, logo and icon to Steam's grid folder (and live, when Steam's debugger is on). Other hosts omit it; the setting is hidden. */
  steamArtApply?(images: { capsule: string; wide: string; hero: string; logo: string; icon: string; key?: string }): Promise<{ ok: boolean; live?: boolean; error?: string; [k: string]: unknown }>;
  /** Optional, Desktop. Put the original Lurkbox art back. Other hosts omit it. */
  steamArtRestore?(): Promise<{ ok: boolean; live?: boolean; error?: string; [k: string]: unknown }>;

  // ---- experimental browser extensions in Twitch chat (Desktop) ----

  /** Optional, Desktop. Status of the real 7TV / BetterTTV / FrankerFaceZ extensions. */
  chatExtensionsStatus?(): Promise<ChatExtensionStatus[]>;
  /** Desktop (called only when chatExtensionsStatus exists). Download/update the extensions and reload the chat frame. */
  chatExtensionsUpdate(): Promise<ChatExtensionStatus[]>;
}

declare global {
  interface Window {
    lurkbox: LurkboxPlatform;
  }
}
