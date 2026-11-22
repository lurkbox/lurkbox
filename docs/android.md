# Android (early)

Status: **early, untested on a real TV, phone or tablet.** `apps/android` is a Capacitor 8 project that bundles the core's renderer into the APK (no dev server), shows on the Google TV / Android TV home row (leanback launcher, banner), and has its own `window.lurkbox` (`apps/android/src/`). One app for Android TV / Google TV, tablets and phones: no touchscreen or leanback requirement, and the core picks the TV, tablet or phone layout (`AppInfo.touch` is set; see "Layout modes" in [architecture.md](architecture.md)).

## What works (in code and unit tests; see "Test on a real Google TV")

- **Sign-in:** the phone (device-code) flow everywhere: the code and QR code show big on the TV, you approve on your phone. Multiple accounts, switch, sign out, remove. Without a TV sign-in (`tvSignIn` left out) the core never offers "Sign in with your phone instead" or the player sign-in.
- **Twitch API:** Helix, id.twitch.tv, web GQL and usher go through Capacitor's native HTTP (`CapacitorHttp`, `src/http.js`), so no CORS. Tokens and settings are JSON in Capacitor Preferences (the app's private SharedPreferences; `allowBackup=false`).
- **Shared logic:** the Twitch auth (`twitch-auth.js`), direct playback requests (`direct.js`), clip sources (`clips.js`) and the HLS host allowlist and master rewrite (`hls-rewrite.js`) moved from the desktop main process to `packages/core/src/shared/` as ES modules. Desktop and Android use the same code; the desktop files are thin `require()` wrappers.
- **Playback:** live, VODs and clips through the direct engine (hls.js in the WebView; hardware decoding through the WebView's MediaCodec). Autoplay with sound (`setMediaPlaybackRequiresUserGesture(false)` in `MainActivity`). The screen stays on while a video plays (`src/playback.js` → `LurkboxNative.keepScreenOn`).
- **The HLS proxy** (the desktop's `lbhls://`): `directMaster` points the master's variant playlists at `https://localhost/_lbhls/<host>/<path>` on the app's own origin, and `LurkboxWebViewClient` + `HlsProxy.java` fetch them natively and stream them back (with Range). Relative VOD segments resolve against the proxied playlist and go through it too; live segments (`*.ttvnw.net`, CORS open) load directly. Only Twitch's hosts, and a cloudfront.net host only after a usher master named it (`proxyAllow`).
- **Input:** the remote's D-pad arrives as arrow keys; OK (`DPAD_CENTER`) is remapped to Enter in `MainActivity`; BACK comes from the Capacitor App plugin's `backButton` event and becomes the core's B (Escape), so leaving the app stays behind the core's "Exit Lurkbox?" (`src/input.js`). Game controllers use the Gamepad API in the WebView. Text uses the core's own on-screen keyboard (no Steam keyboard; `openOnScreenKeyboard` is left out).
- **Touch layouts:** with a touchscreen and no controller, Auto picks the phone layout (bottom tab bar, app bar, chat below the video in portrait, swiped in from the right sideways) or the tablet layout (the rail; chat beside the video in landscape, below it in portrait); Settings → Layout overrides it. Gestures: tap, long-press (channel page, delete a recent search), swipe between channel tabs, pull to refresh, double tap to seek ±10 s, seek-bar drag, swipe down to close the player. Text boxes use the system keyboard (`adjustResize`). Phones and tablets rotate freely; a TV (`UI_MODE_TYPE_TELEVISION`) is held in landscape by `MainActivity`. Safe areas (notches, the gesture bar) come from Capacitor's `--safe-area-inset-*` CSS variables (SystemBars, `insetsHandling: css`, the default) on the app bar, the tab bar, the rail, the player and the bottom sheets. BACK is B in every layout.
- **Window focus:** the App plugin's `appStateChange` (pause/resume) drives `onWindowFocus`.
- **Logging:** `log()` goes to `adb logcat -s Lurkbox` and to `files/lurkbox.log` in app storage (2 MB, then `lurkbox.log.1`): `adb shell run-as io.github.lurkbox.Lurkbox cat files/lurkbox.log` on a debug build. The page's console is in logcat under `Capacitor/Console`.
- **Tests:** `apps/android/test/` (in `npm test`): the platform against `platform.d.ts` (every required member, nothing undocumented, the left-out ones really left out), mocked CapacitorHttp / Preferences / App / LurkboxNative (settings, tokens, the device flow, Helix with refresh, focus, BACK, keep-screen-on, `directMaster` and the proxy rewrite, clips), and the web build.

## Not on Android yet

| Feature | Members | Android route later |
|---|---|---|
| TV sign-in and the player session (subs/Turbo in the player) | `tvSignIn`, `playerSessionLogin` left out; `playerSessionStatus` says signed out | An Android WebView for the twitch.tv login, its `auth-token` cookie read with `CookieManager`, passed to `fetchMaster` as `authToken` |
| Channel points, Twitch chat scanning, watch-time points | `pointsWatch`, `onPointsState`, `watchMinute` left out; `pointsOpenPanel` etc. answer "unavailable" | Needs the web session plus script access to the chat frame (a native WebView the platform can run scripts in) |
| Drops (inventory, auto-claim, chip) | `dropsStatus`, `dropsProgress`, `onDropsEvent` left out (the Drops section is hidden); `dropsOpen` etc. "unavailable" | A hidden WebView with the web session, like the desktop's hidden window |
| Follow / unfollow, "Open on twitch.tv" | `followChannel`, `openChannelPage` left out | Same hidden WebView |
| Official embed gate clicks | `dismissPlayerGate` resolves `''`, `probePlayer` left out | Only matters for the fallback engine |
| Open requests | `openReady` resolves null | Intents / deep links (notifications) |
| Desktop only, never on Android | Steam art (`steamArtApply`/`steamArtRestore` left out, setting hidden), joydev, Steam keyboard, window icon, fullscreen, chat extensions (`chatExtensionsUpdate` resolves `[]`) | — |

Tokens are in SharedPreferences, private to the app but not encrypted; moving them behind the Android Keystore is on the list.

## Test on a real Google TV

1. `adb install -r …/app-debug.apk`; Lurkbox appears in Apps / the home row with its banner, and opens with the D-pad focused on "Sign in with Twitch".
2. D-pad moves, OK selects, BACK goes back; BACK on Following → rail → "Exit Lurkbox?" (never a sudden exit).
3. A game controller (Bluetooth or USB): A/B/X/Y, LB/RB, sticks. Watch for doubled moves (the remote's key events and the Gamepad API both firing for one press).
4. Sign in with the phone: the code and QR are readable from the couch; the follows load.
5. Play a live stream, a VOD (the proxy path: `adb logcat -s Lurkbox` shows `[hls-proxy]` only on errors) and a clip: sound on at once, smooth 1080p60, quality switching, seeking in a VOD, the screen doesn't dim during long playback and does when paused.
6. Home button and back into the app: the background quality cap and "video only while unfocused" react (`onWindowFocus`).
7. The on-screen keyboard in Search and the chat composer.
8. On a phone and a tablet (no controller): the phone/tablet layout in both orientations, the gestures above, the system keyboard in Search and the composer, and BACK (gesture and button) as B.

## Build and install

Needs Node 22, a JDK 21 (the Android Gradle Plugin doesn't run on newer JDKs) and the Android SDK (`ANDROID_HOME`, default `~/Android/Sdk`; Gradle downloads a missing SDK platform itself).

```sh
npm ci --ignore-scripts
npm run android:sync      # core → apps/android/www → the Android project (cap sync android)
npm run android:build     # debug APK; prints its path, versionName and versionCode
npm run android:release   # release APK (debug-signed until there is a release key)
adb install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk
```

- `JAVA_HOME` picks the JDK; when it's unset, the scripts use a portable JDK 21 unpacked in `~/.cache/lurkbox-jdk21/` if there is one.
- **applicationId** `io.github.lurkbox.Lurkbox` (fixed for good). **versionName** is the package version plus the commit (`0.1.0-78501e0`); **versionCode** is the minutes since 2026-01-01 UTC at build time (or `LURKBOX_VERSION_CODE`), so every build upgrades the previous one in place.
- **Signing:** debug and release builds use `~/.config/lurkbox-android/debug.keystore` (or `LURKBOX_DEBUG_KEYSTORE`) when it exists, so upgrades keep the same key; otherwise Android's default debug key. Make one once with `keytool -genkeypair -keystore ~/.config/lurkbox-android/debug.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"`. Never commit a keystore.
- CI's "Android APK" job builds the debug APK (default debug key) and uploads it as the `Lurkbox-Android-debug-APK` artifact, for reference only.
- minSdk 24, targetSdk 35, compileSdk 36. The banner (`res/drawable-xhdpi/banner.png`, 320×180) and launcher icons come from `assets/src/build-art.py`.

## Next

1. Fixes from the first real-TV test (input doubling, focus, playback).
2. The twitch.tv web session in an Android WebView (TV sign-in, player session for subs/Turbo, then channel points, Drops and follow).
3. Tokens behind the Android Keystore.
4. Touch layouts: test on a real phone and tablet (the screenshots use Chromium's touch emulation): the system keyboard over the chat composer with edge-to-edge (does `adjustResize` shrink the page, or does the composer need the IME inset?), the safe-area values on a notched phone, rotation while the player is open, and whether a Bluetooth controller switching the layout to TV mid-session feels right. Left out so far: Twitch chat style (the embedded chat frame) in the portrait and swipe-in chat layouts, a pull-to-refresh on Search results, and swipes between top sections.
5. ExoPlayer (Media3) behind the player interface only if hls.js stutters on TV hardware.

# Android plan (the original design notes)

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
3. **Shared logic.** `packages/core/src/shared/config.js` (Client ID, scopes) and `settings.js` (defaults, `sanitizeSettings`) are ES modules the Android platform imports directly. The Twitch auth, direct-playback requests, clip sources and the HLS rewrite now live there too (done; see "What works").
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
