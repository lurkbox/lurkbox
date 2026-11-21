'use strict';
// Opens Steam's on-screen keyboard (the same one Steam + X shows) from inside Lurkbox.
// In Game Mode, running `steam steam://open/keyboard` hands the URL to the running client through ~/.steam/steam.pipe.
const { spawn } = require('child_process');

function openSteamKeyboard(log) {
  try {
    const child = spawn('steam', ['steam://open/keyboard'], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log && log(`[keyboard] could not run steam: ${e.code || e.message}`));
    child.unref();
    if (log) log('[keyboard] requested Steam on-screen keyboard');
    return true;
  } catch (e) {
    if (log) log(`[keyboard] failed: ${e.message}`);
    return false;
  }
}

/** True when running inside Steam's Game Mode session (Gamescope). */
function inGameMode(env = process.env) {
  return env.XDG_SESSION_DESKTOP === 'gamescope' || !!env.GAMESCOPE_WAYLAND_DISPLAY || !!env.SteamGameId;
}

module.exports = { openSteamKeyboard, inGameMode };
