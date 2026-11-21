# Android plan (not started)

One Android app for Android TV / Google TV, tablets and phones, built with [Capacitor](https://capacitorjs.com/) from the same `packages/core`. TV comes first; touch layouts (bottom tabs on phones, a rail on tablets, swipe for chat, tap to scrub) follow.

## How it plugs in

```
apps/android/                 (new workspace, depends on @lurkbox/core)
  capacitor.config.ts         webDir: a build folder made from packages/core/src
  src/platform.js             window.lurkbox for Android, loaded before js/main.js
  android/                    the generated Android Studio project
```

1. **Web assets.** A small build step copies `packages/core/src` into the web dir and adds the host-served files the core expects: `vendor/hls.min.js` (from hls.js) and `vendor/wordmark.json` (from `assets/src/`). `index.html` gets one extra `<script>` for the Android platform before `js/main.js`.
2. **`window.lurkbox`.** Implement every member of `LurkboxPlatform` in [`packages/core/src/platform.d.ts`](../packages/core/src/platform.d.ts). Add a test like the desktop's `preload-platform.test.mjs` so the implementation can't drift from the interface. Optional members can be left out; the core hides those features.
3. **Shared logic.** `packages/core/src/shared/config.js` (Client ID, scopes) and `settings.js` (defaults, `sanitizeSettings`) are ES modules the Android platform imports directly. The desktop's Twitch auth (`apps/desktop/src/main/twitch.js`: device flow, refresh, multi-account) and direct-playback requests (`direct.js`: GQL and usher) are written without Electron APIs and take `fetch` as a parameter; move them into `packages/core/src/shared/` as ES modules when Android starts, so both hosts use one copy (`twitch.js` needs a small event emitter in place of Node's `EventEmitter`).
4. **Embed origin.** The official Twitch embed needs `parent=localhost`; Capacitor serves from `https://localhost` by default, which fits.

## Mapping the interface

| Area | Android implementation |
|---|---|
| `appInfo`, `quit`, `log`, `qrSvg` | Capacitor App plugin; a log file in app storage; a JS QR library |
| Settings, resume positions | Capacitor Preferences (validate patches with `sanitizeSettings`) |
| Tokens and `helix` | Tokens in encrypted storage (Android Keystore); Helix calls from the platform layer so the page never sees the token |
| Phone sign-in (`authStart`, device code) | Same device flow; works as is (the QR code fits TV well) |
| TV sign-in (`tvSignIn`), player session | An in-app browser/WebView for twitch.tv login, then Authorize; read the `auth-token` cookie with the native cookie manager |
| `directMaster`, `liveInfo`, `storyboard`, `watchMinute` | CapacitorHttp (native, no CORS) with the web session cookie. Rewrite segment URLs only if the WebView can't load them directly |
| Video | hls.js in the WebView first; switch to ExoPlayer/Media3 behind the same player interface only if it stutters on TV hardware |
| Channel points (`points*`), Twitch chat style | The embedded chat page is a cross-origin iframe; scanning it, and zooming it for the TV (`zoomFrameSource` in `shared/tv-zoom.js`), needs a native WebView the platform layer can run scripts in. Leave optional at first |
| `onWindowFocus` | App pause/resume and window focus events |
| Controller input | The Gamepad API and D-pad key events in the WebView; TV remotes send arrow keys and Enter/Back |
| `openReady`, `onOpenChannel` | Android intents / deep links (for example from a notification) |
| `toggleFullscreen` | Omit (always fullscreen) |
| `dismissPlayerGate`, `probePlayer` | Need script access to the embed frame; optional, embed is only the fallback |

## Desktop-only (no Android equivalent)

- **Steam library art** (`steamArtApply`, `steamArtRestore`, `apps/desktop/src/main/steam-art.js`): return `{ ok: false, error }` and hide the setting.
- **joydev** (`onJoydevPad`): Linux input devices; omit.
- **Floater / systemd scope** (`keep-scope.js`), **Gamescope** detection, `--ozone-platform`, VA-API diagnostics: omit.
- **Window icon** (`setWindowIcon`): omit.
- **Experimental browser extensions in Twitch chat** (`chatExtensions*`): omit; the core's own 7TV/BTTV/FFZ emotes work everywhere.
- **The AppImage, Flatpak, deploy script and Steam shortcut**: replaced by an APK/AAB.
- **Decky bell sync and open requests via files**: replaced by Android notifications and intents if wanted.
