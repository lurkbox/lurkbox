#!/usr/bin/env bash
# Deploy Lurkbox to a SteamOS device over SSH: AppImage, non-Steam shortcut and Steam artwork.
# Usage: apps/desktop/scripts/deploy-steammachine.sh [--restart-steam]   (run `npm run dist` at the repo root first)
#   Settings come from the environment or from apps/desktop/scripts/deploy.local.env (gitignored; see deploy.local.env.example):
#     LURKBOX_HOST     user@host of the device (required)
#     LURKBOX_STEAMID  Steam userdata id (optional; found automatically when there is only one)
#     LURKBOX_BACKUPS  local folder for shortcuts.vdf backups (default: ./.deploy-backups)
#   For password SSH, point SSH_ASKPASS at a helper that prints the password; this script never stores it.
#   --restart-steam restarts Steam (needed the first time, to see the shortcut), but only if no game is running.
set -euo pipefail
cd "$(dirname "$0")/../../.."   # repo root: dist/ and assets/ live there
SCRIPTS=apps/desktop/scripts

[[ -f $SCRIPTS/deploy.local.env ]] && source "$SCRIPTS/deploy.local.env"
HOST=${LURKBOX_HOST:?Set LURKBOX_HOST (e.g. in $SCRIPTS/deploy.local.env)}
BACKUPS=${LURKBOX_BACKUPS:-.deploy-backups}
export SSH_ASKPASS_REQUIRE=${SSH_ASKPASS_REQUIRE:-force}
SSH_OPTS=(-o PubkeyAuthentication=no -o ConnectTimeout=10)
ssh_() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
scp_() { scp -q "${SSH_OPTS[@]}" "$@"; }

APPIMAGE=$(ls -t dist/Lurkbox-*.AppImage 2>/dev/null | head -1 || true)
[[ -n $APPIMAGE ]] || { echo "No dist/Lurkbox-*.AppImage; run npm run dist first" >&2; exit 1; }
REMOTE_DIR=/home/deck/Applications
STEAMID=${LURKBOX_STEAMID:-$(ssh_ 'ls ~/.local/share/Steam/userdata | grep -E "^[0-9]+$" | grep -v "^0$"' | head -2 | { read -r a; read -r b || true; [[ -z ${b:-} ]] && echo "$a"; })}
[[ -n $STEAMID ]] || { echo "Several Steam users on the device; set LURKBOX_STEAMID" >&2; exit 1; }
CFG=.local/share/Steam/userdata/$STEAMID/config

echo "== AppImage: $APPIMAGE"
ssh_ "mkdir -p $REMOTE_DIR/Lurkbox"
scp_ "$APPIMAGE" "$HOST:$REMOTE_DIR/Lurkbox.AppImage.new"
ssh_ "chmod +x $REMOTE_DIR/Lurkbox.AppImage.new && mv -f $REMOTE_DIR/Lurkbox.AppImage.new $REMOTE_DIR/Lurkbox.AppImage"
scp_ assets/steam/icon.png "$HOST:$REMOTE_DIR/Lurkbox/icon.png"

echo "== Backing up shortcuts.vdf"
mkdir -p "$BACKUPS"
stamp=$(date +%Y%m%d-%H%M%S)
scp_ "$HOST:$CFG/shortcuts.vdf" "$BACKUPS/shortcuts.vdf.$stamp"
echo "   $BACKUPS/shortcuts.vdf.$stamp"

echo "== Shortcut"
# Steam keeps shortcuts in memory and rewrites shortcuts.vdf from it, so the file is only edited when the shortcut is
# missing, and only while Steam is stopped (--restart-steam). Updating the AppImage never touches the file.
if ssh_ "grep -q Lurkbox.AppImage $CFG/shortcuts.vdf"; then
  APPID=$(ssh_ "python3 - --appid $REMOTE_DIR/Lurkbox.AppImage" < "$SCRIPTS/steam_shortcut.py")
  echo "   already present, appid $APPID (shortcuts.vdf not touched)"
else
  [[ ${1:-} == --restart-steam ]] || { echo "!! No Lurkbox shortcut yet; re-run with --restart-steam to add it with Steam stopped" >&2; exit 2; }
  if ssh_ "pgrep -f '[S]teamLaunch AppId=' >/dev/null"; then echo "!! A game is running; not stopping Steam." >&2; exit 2; fi
  old=$(ssh_ "pgrep -of '[s]teamrt64/steam .*-gamepadui' || true")
  ssh_ "steam -shutdown >/dev/null 2>&1 || true"
  for _ in $(seq 60); do sleep 1; [[ -z $old ]] || ! ssh_ "kill -0 $old 2>/dev/null" && break; done
  APPID=$(ssh_ "python3 - $CFG/shortcuts.vdf $REMOTE_DIR/Lurkbox.AppImage $REMOTE_DIR/Lurkbox/icon.png" < "$SCRIPTS/steam_shortcut.py")
  echo "   added with Steam stopped, appid $APPID; Game Mode restarts Steam on its own"
  RESTARTED=1
fi

echo "== Artwork"
ssh_ "mkdir -p $CFG/grid"
scp_ assets/steam/capsule.png "$HOST:$CFG/grid/${APPID}p.png"
scp_ assets/steam/wide.png "$HOST:$CFG/grid/${APPID}.png"
scp_ assets/steam/hero.png "$HOST:$CFG/grid/${APPID}_hero.png"
scp_ assets/steam/logo.png "$HOST:$CFG/grid/${APPID}_logo.png"

if [[ ${1:-} == --restart-steam && -z ${RESTARTED:-} ]]; then
  if ssh_ "pgrep -f '[S]teamLaunch AppId=' >/dev/null"; then
    echo "!! A game is running; not restarting Steam. Re-run with --restart-steam later." >&2
    exit 2
  fi
  echo "== Restarting Steam"
  old=$(ssh_ "pgrep -of '[s]teamrt64/steam .*-gamepadui' || true")
  ssh_ "steam -shutdown >/dev/null 2>&1 || true"
  # Wait for the old client to exit, then for the session to start a new one.
  for _ in $(seq 60); do sleep 2; [[ -z $old ]] || ! ssh_ "kill -0 $old 2>/dev/null" && break; done
  for _ in $(seq 90); do sleep 2; new=$(ssh_ "pgrep -of '[s]teamrt64/steam .*-gamepadui' || true"); [[ -n $new && $new != "$old" ]] && break; done
  sleep 10
  # Steam can rewrite shortcuts.vdf on exit; make sure the entry survived.
  if ! ssh_ "grep -q Lurkbox $CFG/shortcuts.vdf"; then
    echo "!! Shortcut was overwritten during restart; re-adding (restart Steam again to see it)" >&2
    ssh_ "python3 - $CFG/shortcuts.vdf $REMOTE_DIR/Lurkbox.AppImage $REMOTE_DIR/Lurkbox/icon.png" < "$SCRIPTS/steam_shortcut.py" >/dev/null
    exit 3
  fi
fi
echo "== Done (appid $APPID)"
