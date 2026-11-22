# Developing Lurkbox

Everything runs from the repository root. The repo is an npm workspace (`packages/core`, `apps/desktop`); keep using npm, since `package-lock.json` and CI depend on it. The Decky companion plugin lives in its own repository, [lurkbox/decky-lurkbox](https://github.com/lurkbox/decky-lurkbox).

## Setup

```sh
npm install
npm rebuild electron      # fetches the Electron binary when npm runs with ignore-scripts=true
npm start -- --windowed   # or: --channel=<login>, --vod=<id>
```

- `ELECTRON_RUN_AS_NODE=1` (set by VS Code terminals) makes Electron act as plain Node. The npm scripts unset it; when you run Electron or the AppImage by hand, use `env -u ELECTRON_RUN_AS_NODE`.
- `LURKBOX_USER_DATA=<dir>` uses a throwaway user-data folder instead of `~/.config/Lurkbox`.
- `--screenshot=<file.png> --screenshot-delay=<ms>` saves a screenshot of the window and quits.
- `LURKBOX_DEMO=1 npm start` runs **demo mode**: a made-up signed-in account (`lurker`), channels, categories, videos and chat (messages you send are accepted and echoed back, except the same text twice within 30 s, which is refused like on Twitch; the account has four emotes of its own for the picker's Twitch tab; the channels are followers-only, for the composer's note), with generated pictures and a generated video. Nothing touches the network (requests other than the local page are cancelled and host names don't resolve). It needs ffmpeg with librsvg for the video (rendered once into the temp dir; `LURKBOX_DEMO_MEDIA=<dir>` picks the folder). `LURKBOX_DEMO_SIZE=1280x800` sets the window size, `LURKBOX_DEMO_SIGNED_OUT=1` starts signed out. It only turns on for exactly `LURKBOX_DEMO=1`.
- Logs go to the terminal and to `<userData>/lurkbox.log` (5 MB, then rotated to `lurkbox.log.1`). Each VOD start writes one timeline line, e.g. `[vod] <id> open → resume prompt shown 2 ms → answered 1503 ms (resume at 3:25) → master 1787 ms (anonymous) → first level 1797 ms → first frame 2214 ms → PLAYING 2215 ms`; a VOD left before it plays ends with `left before PLAYING`.

## Screenshots

`npm run screenshots` (or `npm run screenshots -- player player-chat` for some) writes the README screenshots to `docs/screenshots/`. Each scene starts Lurkbox in demo mode at 1280×800 under `xvfb-run` (when installed; `SHOT_XVFB=0` uses your display), presses buttons on a virtual gamepad, waits for fonts, images and the video, and captures. The theme montage is built from one capture per theme with ImageMagick, and every PNG is recompressed (quantised only if it stays over 400 KB). Needs ffmpeg and ImageMagick.

- Scenes live in `apps/desktop/scripts/screenshot-scene.js`; the runner is `screenshots.mjs`. They find things by id, role, aria label and `data-key` (the player controls), so after a UI change a rerun is usually all it takes. A scene that fails saves `FAILED-<scene>.png` next to the others.
- The run fails if demo mode tried to reach the network (`<userData>/demo-blocked.log`).
- Demo code: `packages/core/src/js/demo/` (data, Helix answers, pictures, chat; `install.js` fakes the clock, fetch and WebSocket in the page when `appInfo.demo` is set) and `apps/desktop/src/main/demo.js`, `demo-media.js` (the IPC handlers, the `lbhls://demo/` pictures and HLS playlists, the network block).
- The Decky plugin has its own screenshot script; see [lurkbox/decky-lurkbox](https://github.com/lurkbox/decky-lurkbox).

## Where to put code

- UI, Twitch logic that runs in the page, chat, themes, input: `packages/core/src/js/`. Browser APIs only. Need something from the device? Add a member to `window.lurkbox`: declare it in `packages/core/src/platform.d.ts`, implement it in `apps/desktop/src/preload.js` and an `ipcMain` handler in `apps/desktop/src/main/main.js`. Feature-test it in the core (`if (window.lurkbox.x)`) when other hosts might not have it. The platform tests fail until all three agree.
- Settings: add the key to `DEFAULT_SETTINGS` and `sanitizeSettings` in `packages/core/src/shared/settings.js`. Save with `saveSettings()` (state.js); for sliders and other live previews use `previewSettings()`, which updates `state.settings` (and every `onState` listener) at once and saves after a short pause. The chat layout keys live in `shared/chat-layout.js`; the player's chat pop-over and Settings → Chat both build their controls from `chatControlSpecs()` in `js/chat-controls.js`.
- Player overlay icons: `js/icons.js` (24×24, 2-px round strokes, `currentColor`). Draw new ones in the same style; no third-party artwork.
- Electron, Linux, Steam or file-system code: `apps/desktop/src/main/`.
- Tests sit next to the code they test: `packages/core/test/` (imports `../src/...`) and `apps/desktop/test/unit/` (imports `../../src/main/...`, and core modules as `@lurkbox/core/src/...`). Desktop tests that exercise core and main code together stay in the desktop tests, because core may not depend on desktop.

## Tests

```sh
npm test               # unit tests of every workspace (node --test, no network)
npm run test:smoke     # Electron launches and shows the welcome screen (xvfb-run -a npm run test:smoke headless)
npm run test:play      # embed engine plays a live channel (network; LURKBOX_TEST_CHANNEL, default lofigirl)
npm run test:direct    # direct engine plays a live channel
npm run test:vod       # direct engine plays a VOD (LURKBOX_TEST_VOD or LURKBOX_TEST_VOD_CHANNELS)
npm run test:rewind    # live rewind into the archive VOD
npm run test:points    # channel points against test/fixtures/chat-points.html in a 1280x800 player (LURKBOX_SHOT_DIR=<dir> saves points-*.png)
npm run test:drops     # drops against test/fixtures/drops-inventory.html: scan, claim, selector tolerance, controller navigation, and the real Drops section (stable focus while idle, sub-frame loads and unfocus/refocus; the D-pad moves) (LURKBOX_SHOT_DIR=<dir> saves drops-*.png)
npm run test:follow    # follow/unfollow against test/fixtures/channel-page.html at the real channel URL: selectors, flip, retry, captcha, wrong channel
npm run test:chat      # Lurkbox chat on a busy channel (LURKBOX_SHOT=x.png; LURKBOX_CHAT_STYLE=twitch for Twitch chat style and its TV zoom; LURKBOX_CHAT_EXT=1 for the real extensions)
npm run test:points-cookies # offline: fake twitch.tv auth cookies reach the chat iframe of the localhost page; a Lax rewrite by a first-party twitch.tv page hides them (reproduced) and is repaired at startup and kept SameSite=None
npm run test:chat-send # offline, in demo mode: "Send a message", the on-screen keyboard (and its layout toggle), the echo, a refused duplicate, the emote picker, quick chat from the composer and the overlay (LURKBOX_SHOT_DIR=<dir> saves chat-send-*.png)
npm run screenshots    # README screenshots in demo mode (below)
node packages/core/src/platform-check.js   # the platform interface check on its own, with a readable report
```

`test:play`/`test:direct` run with a 2.5 % margin and 110 % scale (`LURKBOX_TEST_MARGIN`, `LURKBOX_TEST_SCALE`).

## Build

```sh
npm run dist           # dist/Lurkbox-<version>-x86_64.AppImage
npm run dist -- --dir  # dist/linux-unpacked/ only (input for the Flatpak draft)
```

The electron-builder config is `apps/desktop/electron-builder.config.js` (app id `io.github.lurkbox.Lurkbox`, productName `Lurkbox`). It reads the Electron version from the installed package, because npm hoists Electron to the root. The Flatpak manifest draft is `apps/desktop/flatpak/io.github.lurkbox.Lurkbox.yml` (not built yet).

## Installing on a SteamOS device

`apps/desktop/scripts/deploy-steammachine.sh [--restart-steam]` copies the newest AppImage to `~/Applications/Lurkbox.AppImage` on the device, adds or updates the non-Steam shortcut "Lurkbox" (`steam_shortcut.py`, backing up `shortcuts.vdf` first) and copies the Steam art. Settings come from the environment or `apps/desktop/scripts/deploy.local.env` (gitignored; see the `.example`). It restarts Steam only with `--restart-steam` and only when no game is running.

## CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

| Job | Steps |
|---|---|
| Unit tests | `npm ci --ignore-scripts`; `node --check` on every tracked `.js` in `packages/*/src`, `apps/*/src`, `apps/*/test` and `apps/*/*.config.js`; `npm test` |
| Launch smoke test | `npm ci --ignore-scripts && npm rebuild electron`; `xvfb-run -a npm run test:smoke`; `xvfb-run -a npm run test:drops`; `xvfb-run -a npm run test:follow`; `xvfb-run -a npm run test:points-cookies`; `xvfb-run -a npm run test:chat-send` |
| AppImage builds | the same install; `npm run dist -- --publish never`; uploads `dist/*.AppImage` |
| Secret scan | gitleaks over the full history |

To reproduce CI locally, run those commands in a fresh clone.
