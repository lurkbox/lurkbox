'use strict';
// Experimental: the real 7TV, FrankerFaceZ and BetterTTV browser extensions inside Twitch's embedded chat page
// ("Twitch chat" style). Off by default (Settings → Chat). Packages come from each project's official GitHub
// releases (never the Chrome Web Store) into userData/extensions/<key>/<version>/.
//
// Lurkbox changes each manifest so the content scripts run only in twitch.tv/embed and popout chat (all frames,
// because the chat is an iframe inside Lurkbox's page) and not in the player or the login window. BetterTTV
// publishes only its page script on GitHub, so Lurkbox wraps it in a small generated manifest, like its extension.
// An extension that fails to load is disabled with the reason recorded; Lurkbox's own chat emotes keep working.
const fs = require('fs');
const path = require('path');
const { readZip, readTarGz, extractTo } = require('./archive');

const CHAT_MATCHES = ['https://www.twitch.tv/embed/*', 'https://www.twitch.tv/popout/*'];

const EXTENSIONS = {
  '7tv': {
    name: '7TV',
    repo: 'SevenTV/Extension',
    pick: (rels) => rels.find((r) => !r.draft && !r.prerelease && /^v?\d/.test(r.tag_name)),
    asset: /-mv3\.zip$/,
    version: (r) => r.tag_name.replace(/^v/, ''),
    kind: 'zip',
  },
  ffz: {
    name: 'FrankerFaceZ',
    repo: 'FrankerFaceZ/Extension',
    pick: (rels) => rels.find((r) => !r.draft && r.tag_name.startsWith('chrome-stable/')),
    asset: /^frankerfacez-extension-[\d.]+\.zip$/,
    version: (r) => r.tag_name.slice('chrome-stable/'.length),
    kind: 'zip',
  },
  bttv: {
    name: 'BetterTTV',
    repo: 'night/betterttv',
    pick: (rels) => rels.find((r) => !r.draft && !r.prerelease && /^v?\d/.test(r.tag_name)),
    asset: /^betterttv\.tar\.gz$/,
    version: (r) => r.tag_name.replace(/^v/, ''),
    kind: 'tgz',
  },
};

/** "v3.1.6" / "chrome-stable/4.82.0.31" / "7.7.33" → [3,1,6] etc.; null if there is no number. */
function parseVersion(v) {
  const m = /(\d+(?:\.\d+)*)/.exec(String(v || ''));
  return m ? m[1].split('.').map(Number) : null;
}

/** <0, 0, >0 like a comparator; an unparsable version sorts lowest. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Chrome only accepts 1-4 dot-separated integers as a manifest version. */
function chromeVersion(v) {
  const p = parseVersion(v) || [0];
  return p.slice(0, 4).map((n) => Math.min(65535, n)).join('.');
}

/** Restricts content scripts to the chat pages and lets them run in frames. Returns the new manifest. */
function scopeManifest(m) {
  const out = { ...m };
  delete out.update_url;
  out.content_scripts = (m.content_scripts || []).map((cs) => ({ ...cs, matches: CHAT_MATCHES, all_frames: true }));
  return out;
}

function bttvManifest(version) {
  return {
    manifest_version: 3,
    name: 'BetterTTV (Lurkbox wrapper)',
    description: 'BetterTTV\'s published page script, loaded into Twitch chat by Lurkbox.',
    version: chromeVersion(version),
    content_scripts: [{ matches: CHAT_MATCHES, js: ['betterttv.js'], all_frames: true, run_at: 'document_start', world: 'MAIN' }],
    host_permissions: ['https://*.twitch.tv/*'],
  };
}

class ChatExtensions {
  /**
   * @param {object} o
   * @param {string} o.dir          userData/extensions
   * @param {Function} o.fetch      fetch(url, init) → Response (Electron net.fetch in the app)
   * @param {Function} [o.log]
   */
  constructor({ dir, fetch, log = () => {} }) {
    this.dir = dir;
    this.fetch = fetch;
    this.log = log;
    this.stateFile = path.join(dir, 'state.json');
    this.state = this.readState();
    this.loaded = new Map(); // key → Electron extension id
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }

  saveState() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 2));
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  entry(key) { return this.state[key] || (this.state[key] = {}); }

  /** One line per extension, for Settings: { key, name, installed, latest, status, error }. */
  status() {
    return Object.entries(EXTENSIONS).map(([key, def]) => {
      const e = this.state[key] || {};
      return { key, name: def.name, installed: e.version || null, latest: e.latest || null, status: e.status || (e.version ? 'installed' : 'missing'), error: e.error || null, loaded: this.loaded.has(key) };
    });
  }

  async github(url) {
    const r = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lurkbox' } });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  }

  /** The latest release of one extension: { version, url, assetName }. */
  async latest(key) {
    const def = EXTENSIONS[key];
    const rels = await this.github(`https://api.github.com/repos/${def.repo}/releases?per_page=20`);
    const rel = def.pick(Array.isArray(rels) ? rels : []);
    if (!rel) throw new Error('no release found');
    const asset = (rel.assets || []).find((a) => def.asset.test(a.name));
    if (!asset) throw new Error(`release ${rel.tag_name} has no ${def.asset} asset`);
    return { version: def.version(rel), url: asset.browser_download_url, assetName: asset.name };
  }

  /** Checks all (or some) extensions; records `latest`. Returns status(). */
  async check(keys = Object.keys(EXTENSIONS)) {
    for (const key of keys) {
      const e = this.entry(key);
      try {
        e.latest = (await this.latest(key)).version;
        e.checkError = null;
      } catch (err) {
        e.checkError = err.message;
        this.log(`[extensions] ${key}: update check failed: ${err.message}`);
      }
    }
    this.saveState();
    return this.status();
  }

  /** Downloads and installs the latest release where it is newer than the installed one (or `force`). */
  async update({ keys = Object.keys(EXTENSIONS), force = false } = {}) {
    for (const key of keys) {
      const e = this.entry(key);
      try {
        const rel = await this.latest(key);
        e.latest = rel.version;
        if (!force && e.version && compareVersions(rel.version, e.version) <= 0 && e.path && fs.existsSync(e.path)) continue;
        const r = await this.fetch(rel.url, { headers: { 'User-Agent': 'Lurkbox' } });
        if (!r.ok) throw new Error(`download ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const dest = path.join(this.dir, key, rel.version.replace(/[^\w.-]/g, '_'));
        fs.rmSync(dest, { recursive: true, force: true });
        this.install(key, buf, dest, rel.version);
        const old = e.path;
        Object.assign(e, { version: rel.version, path: dest, status: 'installed', error: null, installedAt: Date.now() });
        if (old && old !== dest) fs.rmSync(old, { recursive: true, force: true });
        this.log(`[extensions] ${key}: installed ${rel.version} (${rel.assetName})`);
      } catch (err) {
        e.error = err.message;
        if (!e.version) e.status = 'failed';
        this.log(`[extensions] ${key}: update failed: ${err.message}`);
      }
    }
    this.saveState();
    return this.status();
  }

  /** Unpacks a downloaded package into dest and writes the scoped manifest. */
  install(key, buf, dest, version) {
    const def = EXTENSIONS[key];
    const entries = def.kind === 'tgz' ? readTarGz(buf) : readZip(buf);
    extractTo(entries, dest);
    const mf = path.join(dest, 'manifest.json');
    if (key === 'bttv') {
      if (!fs.existsSync(path.join(dest, 'betterttv.js'))) throw new Error('betterttv.js missing from the release');
      fs.writeFileSync(mf, JSON.stringify(bttvManifest(version), null, 2));
      return;
    }
    if (!fs.existsSync(mf)) throw new Error('no manifest.json in the package');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    fs.writeFileSync(path.join(dest, 'manifest.orig.json'), JSON.stringify(m, null, 2));
    fs.writeFileSync(mf, JSON.stringify(scopeManifest(m), null, 2));
  }

  /**
   * Loads every installed, enabled extension into the session (the one Twitch's chat iframe uses).
   * Missing packages are downloaded first. A failure disables that extension and records why.
   */
  async loadInto(ses, { download = true } = {}) {
    const api = ses.extensions && typeof ses.extensions.loadExtension === 'function' ? ses.extensions : ses;
    const missing = Object.keys(EXTENSIONS).filter((k) => { const e = this.state[k]; return !(e && e.path && fs.existsSync(e.path)) && !(e && e.disabled); });
    if (download && missing.length) await this.update({ keys: missing });
    for (const key of Object.keys(EXTENSIONS)) {
      const e = this.state[key];
      if (!e || !e.path || e.disabled || this.loaded.has(key)) continue;
      try {
        const ext = await api.loadExtension(e.path, { allowFileAccess: false });
        this.loaded.set(key, ext.id);
        e.status = 'loaded';
        e.error = null;
        this.log(`[extensions] ${key}: loaded ${ext.name} ${ext.version} (${ext.id})`);
      } catch (err) {
        e.status = 'failed';
        e.error = err.message;
        e.disabled = true;
        this.log(`[extensions] ${key}: failed to load, disabled: ${err.message}`);
      }
    }
    this.saveState();
    return this.status();
  }

  /** Unloads everything this manager loaded (the setting was turned off). */
  unloadFrom(ses) {
    const api = ses.extensions && typeof ses.extensions.removeExtension === 'function' ? ses.extensions : ses;
    for (const [key, id] of this.loaded) {
      try { api.removeExtension(id); } catch (err) { this.log(`[extensions] ${key}: unload failed: ${err.message}`); }
      const e = this.state[key];
      if (e && e.status === 'loaded') e.status = 'installed';
    }
    this.loaded.clear();
    this.saveState();
  }

  /** Records what a probe of the chat frame found ({ key: true|false }); a loaded extension that never shows up is reported. */
  recordProbe(found) {
    for (const [key, ok] of Object.entries(found || {})) {
      const e = this.state[key];
      if (!e || !this.loaded.has(key)) continue;
      e.active = !!ok;
      if (!ok) this.log(`[extensions] ${key}: loaded but not active in the chat frame`);
    }
    this.saveState();
  }

  /** Clears the "disabled after a failure" flag so the next load tries again (Update extensions does this). */
  reenable() {
    for (const e of Object.values(this.state)) if (e && e.disabled) { e.disabled = false; e.error = null; }
    this.saveState();
  }
}

/** JS run in the chat frame (main world) to see which extensions are active. */
const PROBE_JS = `(() => ({
  '7tv': !!document.querySelector('#seventv-extension, #seventv-root, [id^="seventv"], [class*="seventv-"]'),
  ffz: !!(window.FrankerFaceZ || window.ffz),
  bttv: !!(window.BetterTTV || document.querySelector('[class*="bttv-"], #bttv-settings-button')),
}))()`;

module.exports = { ChatExtensions, EXTENSIONS, parseVersion, compareVersions, chromeVersion, scopeManifest, bttvManifest, CHAT_MATCHES, PROBE_JS };

/**
 * Main-process wiring: IPC for Settings, loading at startup when the setting is on, and a probe of Twitch's chat
 * frame that logs which extensions actually run there. Returns { loadChatExtensions(session), setEnabled(on),
 * watchFrames(webContents) }.
 */
function setupChatExtensions({ ipcMain, ses, getSettings, dir, fetch, log }) {
  const mgr = new ChatExtensions({ dir, fetch, log });
  let enabled = false;

  /** Loads the installed extensions into a session (downloads missing ones in the background). */
  async function loadChatExtensions(target = ses) {
    if (!getSettings().chatExtensions) return mgr.status();
    enabled = true;
    const st = await mgr.loadInto(target, { download: false });
    const missing = st.filter((x) => !x.installed && x.status !== 'failed');
    if (missing.length) {
      // First run: install in the background, then reload any open chat frame so the new ones run there.
      mgr.loadInto(target, { download: true }).then(reloadChatFrames).catch((e) => log(`[extensions] background install failed: ${e.message}`));
    }
    return st;
  }

  const watched = new Set();
  const chatFrames = (wc) => wc.mainFrame.framesInSubtree.filter((f) => {
    try { const u = new URL(f.url); return u.hostname === 'www.twitch.tv' && u.pathname.startsWith('/embed/'); } catch { return false; }
  });
  function reloadChatFrames() {
    for (const wc of watched) {
      if (wc.isDestroyed()) { watched.delete(wc); continue; }
      for (const f of chatFrames(wc)) {
        log('[extensions] reloading Twitch chat so the newly installed extensions run');
        f.executeJavaScript('location.reload()').catch(() => {});
      }
    }
  }

  async function setEnabled(on) {
    if (on && !enabled) await loadChatExtensions(ses);
    if (!on && enabled) { mgr.unloadFrom(ses); enabled = false; }
  }

  const probedAt = new WeakMap(); // frame → time of the last probe
  function watchFrames(wc) {
    watched.add(wc);
    wc.on('did-frame-finish-load', () => {
      if (!enabled || !mgr.loaded.size) return;
      for (const f of chatFrames(wc)) {
        if (Date.now() - (probedAt.get(f) || 0) < 30000) continue;
        probedAt.set(f, Date.now());
        setTimeout(() => {
          f.executeJavaScript(PROBE_JS).then((found) => {
            const loadedOnly = Object.fromEntries(Object.entries(found).filter(([k]) => mgr.loaded.has(k)));
            log(`[extensions] active in chat frame: ${JSON.stringify(loadedOnly)}`);
            mgr.recordProbe(loadedOnly);
          }).catch(() => {});
        }, 20000);
      }
    });
  }

  ipcMain.handle('chatext:status', () => mgr.status());
  ipcMain.handle('chatext:update', async () => {
    mgr.reenable();
    await mgr.update({});
    if (enabled) { mgr.unloadFrom(ses); enabled = false; await loadChatExtensions(ses); }
    return mgr.status();
  });

  return { manager: mgr, loadChatExtensions, setEnabled, watchFrames };
}

module.exports.setupChatExtensions = setupChatExtensions;
