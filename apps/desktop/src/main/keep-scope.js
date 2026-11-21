'use strict';
// Keeps Lurkbox's processes in the cgroup scope Steam launched it in.
//
// Why: Floater (and Steam itself) find a game's PipeWire streams by mapping stream PIDs to the systemd scope
// "app-steam-app<appid>-*.scope". On the first xdg-desktop-portal request, which Electron makes at startup for the
// Settings portal (ui::PortalSettingsLinux, colour scheme), Chromium moves the browser process into a new transient
// scope "app-<desktop name>-<pid>.scope" over D-Bus (components/dbus/xdg/systemd.cc,
// SetSystemdScopeUnitNameForXdgPortal). Every child launched after that, the audio service that owns the PipeWire
// stream included, starts in the new scope, so Floater saw no audio for Lurkbox's appid.
//
// Chromium skips the move only when FLATPAK_SANDBOX_DIR or SNAP was set before it started (it caches that check before
// the main script runs, so setting it from here does nothing), and there is no switch or feature for it. So we undo it:
// remember our scope at startup, and when the browser process turns up in another scope, write it and any children
// that followed it back into the original scope's cgroup.procs. Under user@<uid>.service the user owns the whole
// cgroup subtree, so this needs no privileges. The emptied transient scope then stops by itself.
const fs = require('fs');
const path = require('path');

const CGROUP_ROOT = '/sys/fs/cgroup';

// "0::/user.slice/.../app.slice/app-steam-app1-2.scope" -> "/user.slice/.../app-steam-app1-2.scope" (cgroup v2 only).
function parseCgroup(text) {
  for (const line of String(text || '').split('\n')) {
    const m = /^0::(\/.*)$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

// Moves are only safe and useful between sibling units of the user manager: same parent slice, and the target must be
// a scope (we never move into the transient scope or out of a slice we don't own).
function shouldMoveBack(original, current) {
  if (!original || !current || original === current) return false;
  if (!/\.scope$/.test(original)) return false;
  return path.posix.dirname(original) === path.posix.dirname(current);
}

function readCgroup(pid, procRoot = '/proc') {
  try { return parseCgroup(fs.readFileSync(`${procRoot}/${pid}/cgroup`, 'utf8')); } catch { return null; }
}

// PIDs listed in a cgroup's cgroup.procs.
function cgroupPids(cg, root = CGROUP_ROOT) {
  try {
    return fs.readFileSync(path.join(root, cg, 'cgroup.procs'), 'utf8').split('\n').map(Number).filter((n) => n > 0);
  } catch { return []; }
}

function movePid(pid, cg, root = CGROUP_ROOT) {
  fs.writeFileSync(path.join(root, cg, 'cgroup.procs'), `${pid}\n`);
}

class ScopeKeeper {
  constructor({ pid = process.pid, procRoot = '/proc', cgroupRoot = CGROUP_ROOT, log = () => {} } = {}) {
    this.pid = pid;
    this.procRoot = procRoot;
    this.cgroupRoot = cgroupRoot;
    this.log = log;
    this.original = readCgroup(pid, procRoot);
    this.moved = 0;
    this.timer = null;
  }

  // One check. Returns the number of processes moved back.
  check() {
    const current = readCgroup(this.pid, this.procRoot);
    if (!shouldMoveBack(this.original, current)) return 0;
    let n = 0;
    // Our own process first, so that anything forked from now on is born in the right scope.
    const pids = [this.pid, ...cgroupPids(current, this.cgroupRoot).filter((p) => p !== this.pid)];
    for (const p of pids) {
      try { movePid(p, this.original, this.cgroupRoot); n += 1; } catch (e) {
        this.log(`[scope] could not move ${p} back to ${path.posix.basename(this.original)}: ${e.code || e.message}`);
      }
    }
    if (n) {
      this.moved += n;
      this.log(`[scope] Chromium moved us to ${path.posix.basename(current)}; moved ${n} process(es) back to ${path.posix.basename(this.original)}`);
    }
    return n;
  }

  // Chromium makes the move shortly after startup; watch for a while, then rarely (a later portal request can't
  // move us again: Chromium caches the result, but a check every 10 s costs nothing).
  start({ fastMs = 200, fastFor = 20000, slowMs = 10000 } = {}) {
    if (process.platform !== 'linux' || !this.original) return this;
    this.log(`[scope] launched in ${path.posix.basename(this.original)}`);
    const t0 = Date.now();
    const tick = () => {
      this.check();
      this.timer = setTimeout(tick, Date.now() - t0 < fastFor ? fastMs : slowMs);
      if (this.timer.unref) this.timer.unref();
    };
    tick();
    return this;
  }

  stop() { clearTimeout(this.timer); this.timer = null; }
}

module.exports = { ScopeKeeper, parseCgroup, shouldMoveBack };
