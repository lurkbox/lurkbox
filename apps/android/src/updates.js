// Update notifications on Android: the shared checker (@lurkbox/core/src/shared/updates.js) over native HTTP, and the
// APK download and install in LurkboxNative (LurkboxNativePlugin.java): it fetches SHA256SUMS.txt and the APK from
// GitHub's hosts only (redirects checked one hop at a time), checks the SHA-256, compares the APK's signing certificate
// with this install's ('signature-mismatch': a debug-signed copy can't be upgraded by the release-signed APK; uninstall
// first) and opens the system installer through the FileProvider (REQUEST_INSTALL_PACKAGES).
import { UpdateChecker, allowedUpdateUrl, pickAsset, sumsAsset, versionCore } from '@lurkbox/core/src/shared/updates.js';

/**
 * @param {object} d
 * @param {typeof fetch} d.fetch  native HTTP (CapacitorHttp); it follows redirects itself, so the final URL is checked too
 * @param {{get(), replace(v)}} d.cacheValue  a loaded PrefValue ('updateCheck')
 * @param {object} d.native  LurkboxNative (updateDownload, updateInstall, addListener)
 */
export function createUpdates({ fetch, cacheValue, native = {}, version, getSettings, emit, log = () => {}, setInterval: every, clearInterval: stop, now }) {
  const hop = async (url, init) => {
    const res = await fetch(url, init);
    if (res.url && !allowedUpdateUrl(res.url)) throw new Error('redirected off GitHub');
    return res;
  };
  const canInstall = !!(native.updateDownload && native.updateInstall);
  const checker = new UpdateChecker({
    hop, current: versionCore(version) || version, install: canInstall ? 'apk' : 'manual', log,
    cache: { get: () => cacheValue.get().check || null, set: (v) => cacheValue.replace({ check: v }) },
    enabled: () => getSettings().checkUpdates !== false,
    onChange: (st) => emit('update:state', st),
    ...(every ? { setInterval: every } : {}), ...(stop ? { clearInterval: stop } : {}), ...(now ? { now } : {}),
  });
  if (native.addListener) {
    try {
      const h = native.addListener('updateProgress', (p) => {
        const d = checker.download;
        if (d && d.status === 'downloading') checker.setDownload({ ...d, received: Number(p && p.received) || 0, total: Number(p && p.total) || 0 });
      });
      if (h && h.catch) h.catch(() => {});
    } catch { /* no progress, the download still works */ }
  }
  let downloading = null;
  let apkName = null;

  async function download() {
    const st = checker.state();
    const rel = checker.release;
    if (!canInstall || !st.available || !rel) return st;
    if (st.download.status === 'ready') return st;
    if (downloading) return downloading;
    const asset = pickAsset(rel, 'apk');
    const sums = sumsAsset(rel);
    if (!asset || !sums) { checker.setDownload({ status: 'failed', version: rel.version, error: asset ? 'the release has no SHA256SUMS.txt' : 'the release has no APK' }); return checker.state(); }
    checker.setDownload({ status: 'downloading', version: rel.version, received: 0, total: asset.size || 0 });
    downloading = (async () => {
      try {
        const r = await native.updateDownload({ url: asset.url, sumsUrl: sums.url, name: asset.name });
        apkName = asset.name;
        if (r && r.signature === 'mismatch') {
          log('[update] the downloaded APK is signed with a different key than this install');
          checker.note = 'signature-mismatch';
        }
        log(`[update] ${asset.name} downloaded, sha256 ok, signature ${(r && r.signature) || 'unknown'}`);
        checker.setDownload({ status: 'ready', version: rel.version });
      } catch (e) {
        log(`[update] download failed: ${e.message}`);
        checker.setDownload({ status: 'failed', version: rel.version, error: e.message });
      }
      return checker.state();
    })().finally(() => { downloading = null; });
    return downloading;
  }

  async function install() {
    const st = checker.state();
    if (!canInstall || st.download.status !== 'ready' || !apkName) return { ok: false, reason: 'not-ready' };
    if (st.note === 'signature-mismatch') return { ok: false, reason: 'signature-mismatch' };
    try {
      const r = await native.updateInstall({ name: apkName });
      if (r && r.permission === false) { checker.setNote('install-permission'); return { ok: false, reason: 'permission' }; }
      if (st.note === 'install-permission') checker.setNote(null);
      return { ok: true };
    } catch (e) {
      log(`[update] installer failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  }

  return {
    checker,
    start: () => checker.start(),
    state: () => checker.state(),
    check: () => checker.check({ force: true }),
    download,
    install,
  };
}
