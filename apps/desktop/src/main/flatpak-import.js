'use strict';
// One-time import of the AppImage's user data into the Flatpak's own config folder.
//
// Inside the Flatpak, XDG_CONFIG_HOME is ~/.var/app/io.github.lurkbox.Lurkbox/config, so Electron's userData is
// ~/.var/app/io.github.lurkbox.Lurkbox/config/Lurkbox instead of ~/.config/Lurkbox. The manifest grants
// --filesystem=~/.config/Lurkbox:ro, so the AppImage's folder is readable at its usual host path (not
// xdg-config/Lurkbox: Flatpak binds that grant over the app's own config/Lurkbox too, so userData would be read-only).
// On the first start with an empty userData, copy it over (sign-ins, settings, resume positions, cookie jars; not
// caches, logs or locks), then leave a marker so it never runs again. The host folder is never changed.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = '.flatpak-import.json';
// Chromium caches and per-run files: rebuilt on demand, and the Singleton* files are the running AppImage's locks.
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Crashpad', 'ShaderCache', 'GrShaderCache', 'lurkbox.log', 'lurkbox.log.1', MARKER]);

function skipped(name) {
  return SKIP.has(name) || name.startsWith('Singleton');
}

/**
 * @param {object} o
 * @param {string} o.userData  Electron's userData inside the sandbox
 * @param {object} [o.env]
 * @param {string} [o.hostDir] the AppImage's folder (default ~/.config/Lurkbox, readable through the :ro grant)
 * @returns {{ imported: boolean, reason: string, from?: string, entries?: number }}
 */
function importHostConfig({ userData, env = process.env, hostDir = path.join(os.homedir(), '.config', 'Lurkbox') }) {
  if (!env.FLATPAK_ID) return { imported: false, reason: 'not a Flatpak' };
  if (env.LURKBOX_FLATPAK_IMPORT === '0') return { imported: false, reason: 'turned off (LURKBOX_FLATPAK_IMPORT=0)' };
  if (path.resolve(hostDir) === path.resolve(userData)) return { imported: false, reason: 'same folder' };
  if (fs.existsSync(path.join(userData, MARKER))) return { imported: false, reason: 'already done' };
  // Never overwrite a Flatpak profile that is already in use.
  if (['tokens.json', 'settings.json'].some((f) => fs.existsSync(path.join(userData, f)))) {
    writeMarker(userData, { skipped: 'userData already in use' });
    return { imported: false, reason: 'userData already in use' };
  }
  let names;
  try { names = fs.readdirSync(hostDir); } catch { return { imported: false, reason: `no readable ${hostDir}` }; }
  names = names.filter((n) => !skipped(n));
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  let entries = 0;
  for (const name of names) {
    try {
      // cpSync keeps file modes, so tokens.json and the cookie jars stay 0600.
      fs.cpSync(path.join(hostDir, name), path.join(userData, name), { recursive: true, errorOnExist: false, force: false, dereference: false });
      entries++;
    } catch { /* unreadable entry: skip it, the app recreates what it needs */ }
  }
  writeMarker(userData, { from: hostDir, entries });
  return { imported: entries > 0, reason: entries > 0 ? 'copied' : 'nothing to copy', from: hostDir, entries };
}

function writeMarker(userData, info) {
  try {
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(userData, MARKER), JSON.stringify({ at: new Date().toISOString(), ...info }) + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

module.exports = { importHostConfig, MARKER };
