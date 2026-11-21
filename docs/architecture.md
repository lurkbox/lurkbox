# Lurkbox architecture

Lurkbox is a controller-driven TV client for Twitch. The first target is SteamOS Game Mode, where it also has to work as the floating picture of [Floater](https://github.com/jancard/decky-floater). An Android app (Android TV, tablets, phones) is planned from the same codebase.

## Layout

```
packages/core/          @lurkbox/core: the platform-neutral app (browser code only)
  src/index.html, css/, js/, js/views/, fonts/
  src/shared/           config.js (Client ID, scopes), settings.js (defaults, themes, sanitizeSettings)
  src/platform.d.ts     the window.lurkbox interface every host implements
  src/platform-check.js dev check: core use of window.lurkbox == platform.d.ts
  test/                 core unit tests
apps/desktop/           Electron app (SteamOS / Linux): AppImage now, Flatpak draft
  src/main/             main process (Twitch auth, direct playback, Steam, Floater, joydev, ...)
  src/preload.js        the desktop window.lurkbox (contextBridge → ipcMain)
  src/login-preload.js  controller navigation in the twitch.tv login window
  electron-builder.config.js, flatpak/, scripts/ (deploy, steam_shortcut.py)
  test/unit, test/smoke, test/fixtures
assets/                 icons, Steam art and their sources (shared)
docs/                   this file, development.md, android.md
```

npm workspaces tie `packages/core` and `apps/desktop` together; `apps/desktop` depends on `@lurkbox/core`. The Decky companion plugin is a separate repository ([lurkbox/decky-lurkbox](https://github.com/lurkbox/decky-lurkbox)).

## The platform boundary

The core never imports Node or Electron. Everything it needs from the device goes through `window.lurkbox`, documented member by member in [`packages/core/src/platform.d.ts`](../packages/core/src/platform.d.ts): settings, accounts and sign-in, the Helix API (tokens stay in the host), direct playback (GQL and usher, which need CORS-free requests and the twitch.tv session cookie), VOD resume positions, channel points, window focus, open requests, and the desktop-only Steam art, joydev and extension features. Members that only make sense on some hosts are optional and feature-tested by the core.

Two tests keep the boundary honest:
- `packages/core/test/platform.test.mjs` runs `platform-check.js`, which scans the core's `.js` and `.html` for `window.lurkbox` use (direct, `?.`, aliases, destructuring) and fails on a member missing from `platform.d.ts`, on a documented member nothing uses, and on computed access it can't check.
- `apps/desktop/test/unit/preload-platform.test.mjs` fails unless `preload.js` exposes exactly the documented members.

The host also serves two files next to `index.html`: `/vendor/hls.min.js` (from the hls.js dependency) and `/vendor/wordmark.json` (from `assets/src/`).

Shared, platform-neutral logic that a non-browser host also needs lives in `packages/core/src/shared/` as ES modules. The desktop main process loads them with `require()` (require(esm), Electron 45 / Node 24); `apps/desktop/src/main/store.js` re-exports the settings schema next to its JSON file store.

## Desktop host (Electron)

- **Why Electron:** the official Twitch embed needs a real Chromium; Electron gives the Gamepad API and lets background throttling be switched off (`backgroundThrottling: false` plus the disable-renderer-backgrounding switches), which Floater needs; it packages as an AppImage and as a Flatpak (`org.electronjs.Electron2.BaseApp`). Alternatives considered: Qt/mpv, and the Android TV app under Waydroid (heavy, uncertain PipeWire capture, awkward with the controller).
- **Serving the core:** `src/main/server.js` serves `packages/core/src` on `http://localhost:<random port>/` (loopback only), because the embed refuses `file://` and needs `parent=localhost`. `src/main/paths.js` finds the core through the `@lurkbox/core` package and the assets in the repo (development) or in `app.asar/assets` (packaged).
- **Packaging:** `apps/desktop/electron-builder.config.js`. Output `dist/Lurkbox-<version>-x86_64.AppImage` at the repo root; app id `io.github.lurkbox.Lurkbox`; productName `Lurkbox`, so user data is in `~/.config/Lurkbox/`. electron-builder copies `@lurkbox/core` (its `files`: `src/` without the dev check) and hls.js into `app.asar/node_modules`.
- **Data:** tokens (`tokens.json`, mode 0600, `{accounts, active}`), settings, resume positions, encrypted per-account player cookie jars, `lurkbox.log` (up to 5 MB, then rotated to `lurkbox.log.1`). Never in the repo.

## Twitch

- **Sign-in:** Device Code Grant with a public client (no secret). The Client ID and scopes are in `packages/core/src/shared/config.js`; a Client ID saved in Settings overrides it. All scopes are requested once; a token missing any asks for sign-in again.
- **TV sign-in** (`tv-signin.js`, `player-session.js`): twitch.tv/login opens in an in-app window (TV zoom, D-pad → Tab), then the same window shows the Authorize page for the device code; the user presses Authorize. The web login and the API token must be the same user. `planSignIn()` picks consent-only, full, or full-clear (add account / different user). The phone flow is the fallback. Multiple accounts each keep their own encrypted twitch.tv cookie jar.
- **Player:** the default "direct" engine gets a playback token from Twitch's web GQL (`PlaybackAccessToken`) and the usher master playlist in the main process, then plays it with hls.js in a `<video>`. The official embed (`Twitch.Player`) is the automatic fallback and can be forced in Settings. Ads are detected (`EXT-X-DATERANGE`) and labelled, **never skipped or filtered**. Fatal hls.js errors: AV1/HEVC media errors reload once as H.264; H.264 tries `recoverMediaError`, then reloads, then falls back to the embed.
- **Chat:** anonymous read-only IRC over `wss://irc-ws.chat.twitch.tv`, with Twitch emotes and badges (Helix) and 7TV, BetterTTV and FrankerFaceZ emotes and 7TV cosmetics (all in the core, plain fetch/WebSocket). An experimental mode loads the real extensions into Twitch's embedded chat (`chat-extensions.js`, desktop only).
- **Raids:** EventSub WebSocket `channel.raid` for the watched channel; a countdown that B cancels.
- **Player overlay** (`player.js`, `player-ui.js`, `popover.js`, `slider.js`, `icons.js`): a translucent scrim over the full-bleed video, built once and updated in place so the focused control keeps its node. One row of outline icons (Lurkbox's own 24-px stroke set, `icons.js`); the focused, hovered or long-pressed icon shows a label bubble (`controlLabel()`), with the A glyph only when focused from a controller or keyboard. Volume, quality, chat, channel points and "more" open pop-overs anchored above their icon (`anchorPopover()`); focus moves in, and B closes and returns focus to the icon (`Popover`, by focus key if the bar was re-rendered). The overlay hides after 4 s without input (8 s with a pop-over open) and comes back with focus on the control used last.
- **Chat layout** (`shared/chat-layout.js`, `chat-controls.js`): text size, panel width (Auto or 20–50 % of the window, never more than half, so the video keeps the rest and is letterboxed, never squished), side, background opacity and "over the video" (Lurkbox chat only, and only on the Direct engine: Twitch's chat frame and the embed pause when covered). The chat pop-over and Settings → Chat build their controls from the same specs (`chatControlSpecs()`) over the same settings keys. Sliders call `previewSettings()` (state.js), which updates `state.settings` and every listener at once and saves after 250 ms; until then pending values win over host echoes.
- **Twitch chat style:** Twitch's embedded chat page is drawn at desktop size, so the main process zooms it inside the frame (`html { zoom }`, re-applied on every frame load, points scan and setting change) by Settings → Chat → Twitch chat size (Auto = the TV sign-in window's rule, about 1.74 on an 800-px screen; or 75–250 %, also the chat pop-over's text size slider in this style). With the width on Auto the side panel widens to keep ~340 CSS px of chat layout, capped at 45 % of the window; a set width keeps at least 250 CSS px of layout. The video shrinks beside it (`packages/core/src/shared/tv-zoom.js`).
- **Channel points:** Twitch's embedded chat page signed in with the web session; the main process scans the frame, auto-claims the bonus and drives the rewards popover with the controller. Watch-time minutes are reported for the on-screen stream on the direct engine only.
- **Unofficial interfaces** (web GQL, usher, the embedded chat page, "minute-watched") are listed with their off switches in the README. Twitch's private GQL is not used to follow, subscribe or change the account.
- **What the public API can't do for viewers:** follow/unfollow, channel points balance and redemptions, voting in predictions/polls, subs, gifts, Bits, Drops.

## SteamOS and Floater (desktop only)

- **Never pause on blur/visibilitychange,** no exclusive fullscreen, readable at 10–50 % scale. While unfocused for 1.5 s the player hides chat and controls ("video only"); after 3 s the quality can be capped (Settings).
- **Audio scope (`keep-scope.js`):** Chromium moves the browser process into `app-<desktopName>-<pid>.scope` on its first portal request, which pulls new children (the audio service included) out of Steam's `app-steam-app<appid>` scope, so Floater would find no audio. Lurkbox records the launch scope and writes its pids back into it (`LURKBOX_KEEP_SCOPE=0` turns it off).
- **VA-API (`gpu-diag.js`):** decoder profiles come from a hidden chrome://gpu window, the decoder in use from the DevTools Media domain. `--ozone-platform=x11` is only appended without `WAYLAND_DISPLAY`; prefer setting it in the Steam launch options.
- **Controllers:** the Gamepad API plus a joydev reader (`joydev.js`) for pads Chromium misses; input is ignored while unfocused unless enabled in Settings.
- **Steam library art:** the core renders themed SVG/PNGs; `steam-art.js` writes Steam's grid files (with a one-time backup) and, when Steam's CEF debugger is on, calls only allow-listed `SteamClient.Apps` functions.
- **Decky plugin bridge:** `notify-export.js` writes which followed channels have the bell on (`notify-channels.json`); `open-request.js` consumes `open-request.json` from the plugin to open a channel.

## Decisions

- Direct HLS playback is the default engine (a ToS grey area); the embed is the fallback.
- No ad skipping or filtering.
- PiP mode was removed; Floater does the floating and the player hides its chrome while unfocused.
- Screen margin defaults to 0 (a margin made the embed's visibility check pause playback).
- Settings live in the app's own UI.
- The UI follows the official Android TV app's navigation model (rows, focus, overlay, chat side panel) without copying its code or assets.
- Core UI work stays touch-ready, for the Android app.
