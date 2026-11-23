'use strict';
// Update notifications on the desktop (the shared checker: @lurkbox/core/src/shared/updates.js).
//
// How this copy updates (installMode): a Flatpak (FLATPAK_ID) updates through Discover or `flatpak update`; an AppImage
// whose file ($APPIMAGE) and folder are writable downloads the release's AppImage, checks it against SHA256SUMS.txt,
// and replaces the file atomically (a temporary file in the same folder, then rename), so the next start is the new
// version ("Restart to update"); anything else (a development run, a read-only AppImage) shows the release page.
// Requests carry no cookies (netHop, like the HLS proxy) and reach only GitHub's hosts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const shared = require('@lurkbox/core/src/shared/updates.js');

const MAX_APPIMAGE = 1024 * 1024 * 1024; // 1 GB
const MAX_SUMS = 64 * 1024;

/** 'flatpak' | 'appimage' | 'manual' for this launch. */
function installMode(env = process.env, { access = fs.accessSync, stat = fs.statSync } = {}) {
  if (env.FLATPAK_ID) return 'flatpak';
  const file = env.APPIMAGE;
  if (!file || !path.isAbsolute(file)) return 'manual';
  try {
    if (!stat(file).isFile()) return 'manual';
    access(file, fs.constants.W_OK);
    access(path.dirname(file), fs.constants.W_OK);
    return 'appimage';
  } catch { return 'manual'; }
}

/** Reads a Response body (web stream or text()) into a string of at most `max` bytes. */
async function readText(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') return String(await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('response too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The expected SHA-256 of an asset, from the release's SHA256SUMS.txt. */
async function expectedSha(hop, release, name) {
  const sums = shared.sumsAsset(release);
  if (!sums) throw new Error('the release has no SHA256SUMS.txt');
  const res = await shared.fetchChecked(hop, sums.url, { headers: { 'User-Agent': 'Lurkbox-updater' } });
  if (res.status !== 200) throw new Error(`checksums: HTTP ${res.status}`);
  const sha = shared.parseSums(await readText(res, MAX_SUMS)).get(name);
  if (!sha) throw new Error(`no checksum for ${name}`);
  return sha;
}

/**
 * Downloads the release's AppImage next to `target`, checks its SHA-256 and moves it over `target` (atomic rename on
 * the same file system; the running copy keeps its open file). Resolves { ok: true, sha256 } or { ok: false, error };
 * the temporary file never stays behind.
 */
async function downloadAppImage({ hop, release, target, onProgress = () => {}, log = () => {} }) {
  const asset = shared.pickAsset(release, 'appimage');
  if (!asset) return { ok: false, error: 'the release has no AppImage' };
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.update-${crypto.randomBytes(4).toString('hex')}`);
  let fh = null;
  try {
    const sha = await expectedSha(hop, release, asset.name);
    const res = await shared.fetchChecked(hop, asset.url, { headers: { 'User-Agent': 'Lurkbox-updater', Accept: 'application/octet-stream' } });
    if (res.status !== 200 || !res.body) throw new Error(`download: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    if (total > MAX_APPIMAGE) throw new Error('the AppImage is too large');
    fh = await fs.promises.open(tmp, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const reader = res.body.getReader();
    let received = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_APPIMAGE) { reader.cancel().catch(() => {}); throw new Error('the AppImage is too large'); }
      hash.update(value);
      await fh.write(value);
      if (received - last >= 1024 * 1024) { last = received; onProgress({ received, total }); }
    }
    await fh.sync();
    await fh.close();
    fh = null;
    onProgress({ received, total });
    const got = hash.digest('hex');
    if (got !== sha) throw new Error('the download does not match its SHA-256 checksum');
    await fs.promises.chmod(tmp, 0o755);
    await fs.promises.rename(tmp, target);
    log(`[update] ${asset.name} (${received} bytes, sha256 ok) replaced ${target}`);
    return { ok: true, sha256: got };
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    log(`[update] download failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * The desktop's updater: the shared checker plus the AppImage download and restart.
 * @param {object} o
 * @param {Function} o.hop  one request, no cookies, redirects returned (hls-proxy netHop(net))
 * @param {string} o.cacheFile  <userData>/update-check.json
 * @param {() => object} o.getSettings
 * @param {(state) => void} o.onState
 * @param {() => void} o.relaunch  restart into $APPIMAGE
 */
function createUpdater({ hop, current, cacheFile, getSettings, onState = () => {}, log = () => {}, env = process.env, install = installMode(env), relaunch = () => {}, now, setInterval: every, clearInterval: stop, startDelay }) {
  const cache = {
    get() { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; } },
    set(v) {
      try {
        const tmp = `${cacheFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(v));
        fs.renameSync(tmp, cacheFile);
      } catch (e) { log(`[update] could not save the check: ${e.message}`); }
    },
  };
  const checker = new shared.UpdateChecker({
    hop, current, install, cache, log, onChange: onState,
    enabled: () => getSettings().checkUpdates !== false,
    ...(now ? { now } : {}), ...(startDelay != null ? { startDelay } : {}), ...(every ? { setInterval: every } : {}), ...(stop ? { clearInterval: stop } : {}),
  });
  if (install === 'flatpak') checker.note = 'flatpak';
  let downloading = null;

  async function download() {
    const st = checker.state();
    if (install !== 'appimage' || !st.available || !checker.release) return st;
    if (st.download.status === 'ready') return st;
    if (downloading) return downloading;
    const version = checker.release.version;
    checker.setDownload({ status: 'downloading', version, received: 0, total: 0 });
    downloading = downloadAppImage({
      hop, release: checker.release, target: env.APPIMAGE, log,
      onProgress: (p) => checker.setDownload({ status: 'downloading', version, ...p }),
    }).then((r) => {
      checker.setDownload(r.ok ? { status: 'ready', version } : { status: 'failed', version, error: r.error });
      return checker.state();
    }).finally(() => { downloading = null; });
    return downloading;
  }

  async function install_() {
    const st = checker.state();
    if (install !== 'appimage' || st.download.status !== 'ready') return { ok: false, reason: 'not-ready' };
    log('[update] restarting into the new AppImage');
    setTimeout(() => relaunch(), 50); // after the answer reached the page
    return { ok: true };
  }

  return {
    checker,
    start: () => checker.start(),
    shutdown: () => checker.shutdown(),
    state: () => checker.state(),
    check: () => checker.check({ force: true }),
    download,
    install: install_,
  };
}

module.exports = { installMode, downloadAppImage, createUpdater, readText };
