// Which Twitch HLS hosts a host may proxy, and pointing a usher master playlist's variant playlists at that proxy.
// Shared by the hosts (ES module; the desktop loads it with require()):
//   - desktop: the lbhls://<host>/<path> scheme (apps/desktop/src/main/hls-proxy.js);
//   - Android: https://localhost/_lbhls/<host>/<path>, answered natively by the WebView client (MainActivity).
// Why: Twitch's VOD CDN (*.cloudfront.net) only sends CORS headers for twitch.tv origins, so hls.js in our page can't
// read VOD playlists or segments directly. No open proxy: only Twitch's playlist/segment hosts, and a cloudfront.net
// host only after it appeared in a usher master playlist the host fetched itself.
const STATIC_HOST = /^(usher\.ttvnw\.net|([a-z0-9-]+\.)+ttvnw\.net|([a-z0-9-]+\.)*twitch\.tv)$/i;
const CLOUDFRONT = /^[a-z0-9]+\.cloudfront\.net$/i;

export class ProxyHosts {
  constructor() { this.seen = new Set(); }

  /** Hosts allowed through the proxy. */
  allows(host) {
    const h = String(host || '').toLowerCase();
    return STATIC_HOST.test(h) || (CLOUDFRONT.test(h) && this.seen.has(h));
  }

  /** Remembers the cloudfront hosts a usher master points at. */
  learn(master) {
    for (const m of String(master).matchAll(/https:\/\/([a-z0-9]+\.cloudfront\.net)\//gi)) this.seen.add(m[1].toLowerCase());
  }
}

/** https://host/p?q → prefix + host/p?q (only for allowed hosts; others unchanged). */
export function toProxyUrl(url, hosts, prefix) {
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.protocol !== 'https:' || !hosts.allows(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) return url;
  return `${prefix}${u.hostname}${u.pathname}${u.search}`;
}

/**
 * Points every variant/media playlist in a master playlist at the proxy (URI lines and URI="..." attributes).
 * Segment URLs inside a proxied media playlist resolve against it: relative ones (VODs, no CORS) go through the
 * proxy too, absolute ones (live, *.ttvnw.net with CORS) still load directly.
 */
export function rewriteMaster(master, hosts, prefix) {
  hosts.learn(master);
  return String(master).split(/\r?\n/).map((line) => {
    if (/^https:\/\//.test(line)) return toProxyUrl(line.trim(), hosts, prefix);
    if (line.startsWith('#') && line.includes('URI="https://')) return line.replace(/URI="(https:\/\/[^"]+)"/g, (_m, u) => `URI="${toProxyUrl(u, hosts, prefix)}"`);
    return line;
  }).join('\n');
}
