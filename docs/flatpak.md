# Lurkbox as a Flatpak

Lurkbox publishes its own Flatpak repository on GitHub Pages: **https://lurkbox.github.io/lurkbox/**. This is not Flathub, and nothing here is meant for Flathub.

## Install

- **KDE Discover / GNOME Software:** open https://lurkbox.github.io/lurkbox/, click **Install Lurkbox**, open the downloaded `io.github.lurkbox.Lurkbox.flatpakref` and choose Install.
- **Terminal:**

  ```sh
  flatpak install --user https://lurkbox.github.io/lurkbox/io.github.lurkbox.Lurkbox.flatpakref
  flatpak run io.github.lurkbox.Lurkbox
  ```

The `.flatpakref` adds the repository as the remote `lurkbox` (signed with the key below) and points `RuntimeRepo` at Flathub, so `org.freedesktop.Platform//26.08` and `org.electronjs.Electron2.BaseApp//26.08` come from Flathub. To add only the repository: `flatpak remote-add --user lurkbox https://lurkbox.github.io/lurkbox/lurkbox.flatpakrepo`.

Uninstall with `flatpak uninstall --user io.github.lurkbox.Lurkbox` (add `--delete-data` to remove the profile in `~/.var/app/io.github.lurkbox.Lurkbox/`).

## Updates

Each publish replaces the `stable` branch in the repository with a new signed commit. Discover lists it under Updates like any other Flatpak, and `flatpak update` picks it up. The repository is rebuilt from scratch on every publish, so it only holds the latest build (no history and no rollback with `flatpak update --commit`); the static delta is a from-scratch one.

## How it is built and published

- **Manifest:** `apps/desktop/flatpak/io.github.lurkbox.Lurkbox.yml`, on `org.freedesktop.Platform//26.08` with `org.electronjs.Electron2.BaseApp//26.08`. It packages the electron-builder `--linux dir` output (`dist/linux-unpacked/`) instead of building from source in the sandbox (that would need the Node SDK extension and generated offline npm sources). `chrome-sandbox` is dropped, because zypak (from the BaseApp) runs Chromium's sandbox.
- **Metadata:** `io.github.lurkbox.Lurkbox.metainfo.xml` (AppStream) and `io.github.lurkbox.Lurkbox.desktop` next to the manifest; icons from `assets/icons/`. `appstreamcli validate` passes. `flatpak-builder-lint` reports only Flathub rules: screenshots that aren't mirrored to Flathub's media server.
- **Workflow:** `.github/workflows/flatpak.yml` ("Flatpak").
  - Pull requests: build the app, build the Flatpak into an unsigned OSTree repo, run `build-update-repo`, install it from that repo and check the files. Nothing is signed or published.
  - Tag pushes (`v*`) and manual runs (`gh workflow run Flatpak`): the same, but `flatpak-builder --gpg-sign` signs the commits and `flatpak build-update-repo --generate-static-deltas --gpg-sign` signs the summary and writes the appstream branches. The install check then verifies the signatures against the committed public key. The site goes up with `actions/upload-pages-artifact` and `actions/deploy-pages`.
- **Site layout** (from `apps/desktop/flatpak/site/`): `index.html`, `io.github.lurkbox.Lurkbox.flatpakref`, `lurkbox.flatpakrepo`, `lurkbox-flatpak.gpg`, `icon.png` and `repo/` (the OSTree repository).
- **Pages:** the source is GitHub Actions. The `github-pages` environment allows deployments from `main` and from `v*` tags.

Local build (with `flatpak-builder`, or the `org.flatpak.Builder` Flatpak):

```sh
npm ci --ignore-scripts && npm rebuild electron
(cd apps/desktop && npx electron-builder --config electron-builder.config.js --linux dir --x64 --publish never)
flatpak-builder --user --install --install-deps-from=flathub --force-clean --default-branch=stable \
  apps/desktop/flatpak/build-dir apps/desktop/flatpak/io.github.lurkbox.Lurkbox.yml
```

With `org.flatpak.Builder`, run it as `flatpak run --env=FLATPAK_USER_DIR=$HOME/.local/share/flatpak --command=flatpak-builder org.flatpak.Builder …`, so it finds the runtimes in your normal user installation. Add `--filesystem=/tmp` if the checkout is under `/tmp`. When you run the Flatpak from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first.

## Signing key

- A dedicated ed25519 key, "Lurkbox Flatpak repository", fingerprint `5A11 8BD9 DB64 1F63 0D2B 277C E5F9 F45D 5EB9 FC46`, with no passphrase.
- The public key is in [docs/flatpak/lurkbox-flatpak.gpg](flatpak/lurkbox-flatpak.gpg) and, base64-encoded, in the `GPGKey=` lines of the `.flatpakref` and `.flatpakrepo`.
- The private key is the repository Actions secret `FLATPAK_GPG_KEY` (ASCII-armoured). The maintainer's copy is outside the repo, in `~/.config/lurkbox-flatpak/` (mode 0600). The workflow refuses to publish if the secret's fingerprint doesn't match the committed public key.
- Rotating it: generate a new key, update the secret, the `.gpg` file and both `GPGKey=` lines in one PR. Existing installs keep the old key, so they need `flatpak remote-modify --user --gpg-import=<new.gpg> lurkbox` (or a reinstall from the new `.flatpakref`).

## Sandbox permissions and limits

| Permission | Why |
|---|---|
| `--share=network`, `--share=ipc` | Twitch, chat, EventSub. Also Steam's CEF debugger on `127.0.0.1:8080` (Steam library art, live update). |
| `--socket=wayland`, `--socket=fallback-x11` | Wayland when there is one. Otherwise X11, as under Gamescope, where Lurkbox adds `--ozone-platform=x11` itself when `WAYLAND_DISPLAY` is unset. |
| `--socket=pulseaudio` | Audio. |
| `--device=all` | Gamepads. This covers the GPU (`dri`) too. |
| `--filesystem=~/.config/Lurkbox:ro` | A one-time import of the AppImage's profile. |
| `--filesystem=~/.local/share/Steam/userdata` | Steam library art: reads `shortcuts.vdf` and writes `config/grid/`. |

- **Profile.** In the Flatpak, userData is `~/.var/app/io.github.lurkbox.Lurkbox/config/Lurkbox/`, not `~/.config/Lurkbox/`. On the first start with an empty profile, `flatpak-import.js` copies the AppImage's `~/.config/Lurkbox/` (sign-ins, settings, resume positions, cookie jars; not caches, logs or locks) and writes `.flatpak-import.json` so it never runs again. After that the two profiles are separate. `LURKBOX_FLATPAK_IMPORT=0` skips the import. The grant is the home path `~/.config/Lurkbox:ro`, not `xdg-config/Lurkbox:ro`, because Flatpak also binds an `xdg-config/<dir>` grant over the app's own `config/<dir>`, which made userData read-only (tested).
- **Gamepads.** The Gamepad API and the joydev reader both work: with `--device=all` the sandbox can read `/dev/input/js*` and `/sys/class/input/js*/device/name` (tested on a laptop). As on the host, the device nodes must be readable by the user (`input` group or the seat's ACL).
- **Steam keyboard.** There is no `steam` binary in the sandbox, so in the Flatpak Lurkbox runs `xdg-open steam://open/keyboard`. The runtime passes that to the OpenURI portal, which hands it to the host's `steam://` handler. No `--talk-name` and no `flatpak-spawn --host` are needed. This needs xdg-desktop-portal on the host. It is not tested in Game Mode yet, and the portal may ask once which app should open `steam://` links.
- **Steam library art: on.** It uses the narrowest grant that works (`~/.local/share/Steam/userdata`, plus the network for the CEF port), and the setting is still off by default. Inside the Flatpak the appid comes only from `SteamGameId`, so art is written only when Steam launched Lurkbox. Steam installs that keep their data only in `~/.steam/steam` (not `~/.local/share/Steam`) aren't covered. Note that write access to Steam's userdata is a broad grant: a compromised app could change other Steam settings there.
- **Off, or limited, in the Flatpak:**
  - **Floater audio.** `flatpak run` puts the app in its own `app-flatpak-io.github.lurkbox.Lurkbox-*.scope`, not Steam's `app-steam-app<appid>` scope. That happens before Lurkbox starts (its log shows `[scope] launched in app-flatpak-…`), so the scope keeper has no Steam scope to keep, and Floater may not find Lurkbox's audio. For Floater in Game Mode, use the AppImage.
  - **Decky plugin bridge.** `notify-channels.json` and `open-request.json` live in the Flatpak's profile (`~/.var/app/io.github.lurkbox.Lurkbox/config/Lurkbox/`), and the decky-lurkbox plugin only looks in `~/.config/Lurkbox/`. It doesn't work with the Flatpak until the plugin also checks that path.

## Status

Done:

- Manifest, metainfo, desktop file and icons, built and linted locally with `org.flatpak.Builder`.
- A local install that started and ran (Wayland, with gamepads seen via joydev) and imported the profile.
- The workflow, the signing key and secret, and Pages enabled.

Left:

- Test the Steam keyboard through the portal, and joydev with Steam's virtual pads, in Game Mode on a SteamOS device.
- Make the Decky plugin also read the Flatpak profile path.
- Optional: keep repository history across publishes (download the current repo before building) to allow deltas and rollbacks.
