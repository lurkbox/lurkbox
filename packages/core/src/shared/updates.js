// Update notifications: is there a newer Lurkbox release on GitHub? Shared by the hosts (the desktop main process and
// the Android platform layer); the page only sees the resulting state (platform.d.ts UpdateState).
//
// - The check is one unauthenticated GET of GitHub's "latest release" API (no token, no cookies), at start and then at
//   most once a day, with the answer cached (ETag: a 304 doesn't count against GitHub's rate limit).
// - Versions compare by semver (prereleases before their release; build metadata ignored). Android's versionName is the
//   package version plus the commit ("0.1.0-78501e0"), so hosts pass the package version, or versionCore() of it.
// - Downloads come only from GitHub's hosts (allowedUpdateUrl); redirects are followed one hop at a time, each checked
//   like the first URL (as the HLS proxy does), and the file is checked against the release's SHA256SUMS.txt.
// ES module; the desktop main process loads it with require().

export const REPO = 'lurkbox/lurkbox';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const SUMS_NAME = 'SHA256SUMS.txt';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** The hosts update requests may reach: the API, release pages and the asset downloads they redirect to. */
export const UPDATE_HOSTS = Object.freeze(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{0,64})?$/;

/** '1.2.3', 'v1.2.3-rc.1' → { major, minor, patch, pre: ['rc', 1] }; null when it isn't a version. */
export function parseVersion(s) {
  const m = SEMVER.exec(String(s || '').trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  if (pre.some((p) => p === '')) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** The x.y.z at the start of a version string ('0.1.0-78501e0' → '0.1.0'), or null. */
export function versionCore(s) {
  const m = /^v?(\d{1,6}\.\d{1,6}\.\d{1,6})/.exec(String(s || '').trim());
  return m ? m[1] : null;
}

/** Semver precedence: < 0 when a is older than b, 0 when equal, > 0 when newer. Unparseable versions sort first. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0); // a release > its prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = typeof p === 'number';
    const qn = typeof q === 'number';
    if (pn && qn) return p < q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Is `latest` a newer version than `current`? */
export function isNewer(latest, current) {
  return !!parseVersion(latest) && !!parseVersion(current) && compareVersions(latest, current) > 0;
}

/** The URL as a string when update requests may fetch it (https, one of UPDATE_HOSTS, no credentials, port 443), else null. */
export function allowedUpdateUrl(url, base) {
  let u;
  try { u = base ? new URL(String(url), base) : new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!UPDATE_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return u.href;
}

/**
 * GET `url` through `hop` (one request, redirects not followed: a 3xx comes back with its Location header), following
 * redirects here, each checked with allowedUpdateUrl. Resolves the final Response-like object; throws on a refused URL,
 * a bad redirect or too many of them.
 */
export async function fetchChecked(hop, url, init = {}, { max = MAX_REDIRECTS } = {}) {
  let target = allowedUpdateUrl(url);
  if (!target) throw new Error('update URL not allowed');
  for (let n = 0; ; n++) {
    const res = await hop(target, { method: 'GET', ...init });
    if (!REDIRECT.has(res.status)) return Object.assign(res, { finalUrl: target });
    if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
    const next = allowedUpdateUrl(res.headers.get('location') || '', target);
    if (!next) throw new Error(`redirect from ${new URL(target).hostname} not followed`);
    if (n >= max) throw new Error('too many redirects');
    target = next;
  }
}

/** A release asset's file name is plain (no paths), so it can be matched against SHA256SUMS.txt and saved under it. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/**
 * GitHub's release JSON → { version, tag, name, url, publishedAt, assets: [{ name, url, size }] }, or null for a
 * draft, a prerelease, a tag that isn't a version, or anything malformed. Only https URLs on GitHub's hosts are kept.
 */
export function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const tag = String(json.tag_name || '');
  if (!parseVersion(tag)) return null;
  const page = allowedUpdateUrl(json.html_url || '');
  const assets = (Array.isArray(json.assets) ? json.assets : [])
    .map((a) => ({ name: String((a && a.name) || ''), url: allowedUpdateUrl((a && a.browser_download_url) || ''), size: Number(a && a.size) || 0 }))
    .filter((a) => ASSET_NAME.test(a.name) && a.url);
  return {
    version: tag.replace(/^v/, ''),
    tag,
    name: String(json.name || `Lurkbox ${tag}`).slice(0, 120),
    url: page && new URL(page).hostname === 'github.com' ? page : `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
    assets,
  };
}

const ASSET_PATTERNS = { appimage: /-x86_64\.AppImage$/, apk: /-android\.apk$/ };

/** The release's asset for a kind ('appimage' or 'apk'), or null. */
export function pickAsset(release, kind) {
  const re = ASSET_PATTERNS[kind];
  return (re && release && release.assets.find((a) => re.test(a.name))) || null;
}

/** The release's SHA256SUMS.txt asset, or null. */
export function sumsAsset(release) {
  return (release && release.assets.find((a) => a.name === SUMS_NAME)) || null;
}

/** `sha256sum` output ("<64 hex>  <name>" per line, "*" before binary names) → Map(name → lowercase hex). */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(\S.*)$/.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** The cached check as stored by the host: { checkedAt, etag, release } (validated; anything else → null). */
export function sanitizeCache(c) {
  if (!c || typeof c !== 'object') return null;
  const checkedAt = Number(c.checkedAt) || 0;
  const etag = typeof c.etag === 'string' && c.etag.length <= 200 ? c.etag : null;
  const release = c.release && typeof c.release === 'object' ? parseRelease(c.release.raw || null) : null;
  return { checkedAt, etag, release: release ? { ...release, raw: c.release.raw } : null };
}

/** Is a scheduled check due? Always at start (atStart), then once CHECK_EVERY_MS has passed since the last one. */
export function checkDue({ checkedAt, now, atStart = false, every = CHECK_EVERY_MS }) {
  return atStart || !checkedAt || now - checkedAt >= every || now < checkedAt;
}

/**
 * The update state the page sees (platform.d.ts UpdateState), from the checker's facts.
 * install: how this copy updates: 'appimage' (download and replace the file), 'apk' (download and open the installer),
 * 'flatpak' (Discover / `flatpak update`), 'manual' (show the release page).
 */
export function updateState({ current, enabled, install, release, checkedAt, checking = false, error = null, download = null, note = null }) {
  const available = !!(release && isNewer(release.version, current));
  return {
    current: String(current || ''),
    enabled: !!enabled,
    install,
    checking: !!checking,
    checkedAt: checkedAt || null,
    error: error || null,
    available,
    latest: release ? { version: release.version, url: release.url, name: release.name, publishedAt: release.publishedAt } : null,
    download: download || { status: 'idle' },
    note: note || null,
  };
}

/**
 * Checks GitHub for the latest release on a schedule and keeps the state. The host injects the request and the cache.
 * @param {object} o
 * @param {(url: string, init: object) => Promise<{status: number, headers: {get(k): string|null}, json(): Promise<any>}>} o.hop
 *   one GET without cookies; redirects not followed (fetchChecked follows them)
 * @param {string} o.current  the running version (x.y.z)
 * @param {string} o.install  see updateState()
 * @param {{get(): any, set(v: any): void}} o.cache  the stored check (sanitizeCache)
 * @param {() => boolean} o.enabled  Settings → "Check for updates"
 */
export class UpdateChecker {
  constructor({ hop, current, install = 'manual', cache, enabled = () => true, now = () => Date.now(), log = () => {}, onChange = () => {}, setInterval: every = setInterval, clearInterval: stop = clearInterval, setTimeout: later = setTimeout, startDelay = 10000, userAgent = 'Lurkbox-updater' }) {
    Object.assign(this, { hop, current, install, cache, enabled, now, log, onChange, every, stop, later, startDelay, userAgent });
    const c = sanitizeCache(cache.get());
    this.release = c ? c.release : null;
    this.checkedAt = c ? c.checkedAt : 0;
    this.etag = c ? c.etag : null;
    this.checking = null;
    this.error = null;
    this.download = null;
    this.note = null;
    this.timer = null;
  }

  state() {
    return updateState({ current: this.current, enabled: this.enabled(), install: this.install, release: this.release, checkedAt: this.checkedAt, checking: !!this.checking, error: this.error, download: this.download, note: this.note });
  }

  emit() { try { this.onChange(this.state()); } catch (e) { this.log(`[update] listener failed: ${e.message}`); } }

  /** Checks at start (startDelay after it, when enabled), then looks once an hour whether a day has passed. */
  start() {
    const first = this.later(() => { if (this.enabled()) this.check({ atStart: true }).catch(() => {}); }, this.startDelay);
    if (first && first.unref) first.unref();
    this.timer = this.every(() => { if (this.enabled()) this.check().catch(() => {}); }, 60 * 60 * 1000);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  shutdown() { if (this.timer) this.stop(this.timer); this.timer = null; }

  /** One check; force: the user's "Check now" (ignores the schedule and the setting). Never rejects. */
  check({ force = false, atStart = false } = {}) {
    if (this.checking) return this.checking;
    if (!force && !checkDue({ checkedAt: this.checkedAt, now: this.now(), atStart })) return Promise.resolve(this.state());
    this.checking = this.run().finally(() => { this.checking = null; this.emit(); });
    this.emit();
    return this.checking;
  }

  async run() {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': this.userAgent, 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.etag && this.release) headers['If-None-Match'] = this.etag;
    try {
      const res = await fetchChecked(this.hop, RELEASES_API, { headers });
      const at = this.now();
      if (res.status === 304) {
        this.checkedAt = at;
      } else if (res.status === 404) {
        this.release = null; // no release published yet
        this.checkedAt = at;
        this.etag = null;
      } else if (res.status === 200) {
        const raw = await res.json();
        const rel = parseRelease(raw);
        if (!rel) throw new Error('the latest release could not be read');
        this.release = { ...rel, raw: slimRelease(raw) };
        this.etag = res.headers.get('etag') || null;
        this.checkedAt = at;
      } else if (res.status === 403 || res.status === 429) {
        throw new Error('GitHub rate limit reached; trying again later');
      } else {
        throw new Error(`GitHub answered ${res.status}`);
      }
      this.error = null;
      this.cache.set({ checkedAt: this.checkedAt, etag: this.etag, release: this.release ? { raw: this.release.raw } : null });
      const s = this.state();
      this.log(`[update] checked: running ${this.current}, latest ${s.latest ? s.latest.version : 'none'}${s.available ? ' (newer)' : ''}`);
    } catch (e) {
      this.error = e.message || String(e);
      this.log(`[update] check failed: ${this.error}`);
    }
    return this.state();
  }

  setDownload(d) { this.download = d; this.emit(); }
  setNote(n) { this.note = n; this.emit(); }
}

/** Just the release fields parseRelease reads, for the cache. */
function slimRelease(raw) {
  return {
    tag_name: raw.tag_name, name: raw.name, html_url: raw.html_url, published_at: raw.published_at, draft: !!raw.draft, prerelease: !!raw.prerelease,
    assets: (raw.assets || []).slice(0, 50).map((a) => ({ name: a && a.name, browser_download_url: a && a.browser_download_url, size: a && a.size })),
  };
}

/** Show the one-time "is available" toast? Once per version (notified: the version it was last shown for). */
export function shouldNotify(state, notified) {
  return !!(state && state.available && state.latest && state.latest.version !== String(notified || ''));
}

/**
 * Settings → About's update row from the state: { text, actions } with actions from 'check', 'download', 'install',
 * 'release' (the release page as a QR code). Pure; the page builds the buttons.
 */
export function updateSummary(st) {
  if (!st) return { text: '', actions: [] };
  const v = st.latest ? `v${st.latest.version}` : '';
  const d = st.download || { status: 'idle' };
  if (st.checking && !st.available) return { text: 'Checking for updates…', actions: [] };
  if (!st.available) {
    if (st.error) return { text: `Couldn't check for updates: ${st.error}`, actions: ['check'] };
    if (!st.checkedAt) return { text: st.enabled ? 'Not checked yet.' : 'Update checks are off.', actions: ['check'] };
    return { text: `Lurkbox is up to date (checked ${new Date(st.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}).`, actions: ['check'] };
  }
  if (st.install === 'flatpak') return { text: `Lurkbox ${v} is available. Flatpak updates come through Discover (Desktop Mode) or \`flatpak update\`.`, actions: ['release'] };
  if (st.note === 'signature-mismatch') {
    return { text: `Lurkbox ${v} is downloaded, but it is signed with a different key than this copy (a development build), so Android can't install it over this one. Uninstall Lurkbox first, then install the release from its page (you sign in again afterwards).`, actions: ['release'] };
  }
  if (st.install === 'appimage' || st.install === 'apk') {
    if (d.status === 'downloading') {
      const pct = d.total ? ` ${Math.min(100, Math.floor((100 * (d.received || 0)) / d.total))} %` : '';
      return { text: `Downloading Lurkbox ${v}…${pct}`, actions: [] };
    }
    if (d.status === 'ready') {
      if (st.install === 'appimage') return { text: `Lurkbox ${v} is downloaded and checked. Restart to use it.`, actions: ['install'] };
      if (st.note === 'install-permission') return { text: `Allow Lurkbox to install apps in the settings that opened, then press Install again.`, actions: ['install', 'release'] };
      return { text: `Lurkbox ${v} is downloaded and checked.`, actions: ['install'] };
    }
    const failed = d.status === 'failed' ? ` The download failed: ${d.error || 'unknown error'}.` : '';
    return { text: `Lurkbox ${v} is available.${failed}`, actions: ['download', 'release'] };
  }
  return { text: `Lurkbox ${v} is available.`, actions: ['release', 'check'] };
}
