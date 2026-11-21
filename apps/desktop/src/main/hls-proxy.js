'use strict';
// Twitch HLS through the main process, as the custom scheme lbhls://<host>/<path>?<query> (= https://<host>/...).
//
// Why: Twitch's VOD CDN (*.cloudfront.net, "cloudfront_vod") only sends CORS headers for twitch.tv origins, so
// hls.js in our http://localhost page can't read VOD variant playlists or segments (status 0, levelLoadError).
// The renderer never gets an open proxy: only Twitch's playlist/segment hosts are allowed, and a cloudfront.net host
// only after it appeared in a usher master playlist we fetched ourselves. The response streams straight through.
const SCHEME = 'lbhls';

const STATIC_HOST = /^(usher\.ttvnw\.net|([a-z0-9-]+\.)+ttvnw\.net|([a-z0-9-]+\.)*twitch\.tv)$/i;
const CLOUDFRONT = /^[a-z0-9]+\.cloudfront\.net$/i;

class ProxyHosts {
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

/** https://host/p?q → lbhls://host/p?q (only for allowed hosts; others unchanged). */
function toProxyUrl(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.protocol !== 'https:' || !hosts.allows(u.hostname)) return url;
  return `${SCHEME}://${u.host}${u.pathname}${u.search}`;
}

/** lbhls://host/p?q → https://host/p?q, or null when the host isn't allowed. */
function fromProxyUrl(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || !hosts.allows(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) return null;
  return `https://${u.hostname}${u.pathname}${u.search}`;
}

/**
 * Points every variant/media playlist in a master playlist at the proxy (URI lines and URI="..." attributes).
 * Segment URLs inside a proxied media playlist resolve against it: relative ones (VODs, no CORS) go through the
 * proxy too, absolute ones (live, *.ttvnw.net with CORS) still load directly.
 */
function rewriteMaster(master, hosts) {
  hosts.learn(master);
  return String(master).split(/\r?\n/).map((line) => {
    if (/^https:\/\//.test(line)) return toProxyUrl(line.trim(), hosts);
    if (line.startsWith('#') && line.includes('URI="https://')) return line.replace(/URI="(https:\/\/[^"]+)"/g, (_m, u) => `URI="${toProxyUrl(u, hosts)}"`);
    return line;
  }).join('\n');
}

const FORWARD_REQ = ['range', 'accept'];
const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];

/** protocol.handle handler. fetch = Electron net.fetch. */
function makeHandler({ fetch, hosts, log = () => {} }) {
  let denied = 0;
  return async (request) => {
    const target = fromProxyUrl(request.url, hosts);
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range' };
    if (!target) {
      if (denied++ < 20) log(`[hls-proxy] refused ${String(request.url).slice(0, 120)}`);
      return new Response('not allowed', { status: 403, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('', { status: 405, headers: cors });
    const headers = {};
    for (const k of FORWARD_REQ) { const v = request.headers.get(k); if (v) headers[k] = v; }
    try {
      const res = await fetch(target, { method: request.method, headers, redirect: 'follow', bypassCustomProtocolHandlers: true });
      const out = { ...cors };
      for (const k of FORWARD_RES) { const v = res.headers.get(k); if (v) out[k] = v; }
      if (/\.m3u8(\?|$)/.test(new URL(target).pathname)) out['content-type'] = 'application/vnd.apple.mpegurl';
      if (!res.ok) log(`[hls-proxy] ${res.status} from ${new URL(target).hostname}${new URL(target).pathname.slice(-40)}`);
      return new Response(res.body, { status: res.status, headers: out });
    } catch (e) {
      log(`[hls-proxy] fetch failed for ${new URL(target).hostname}: ${e.message}`);
      return new Response('', { status: 502, headers: cors });
    }
  };
}

module.exports = { SCHEME, ProxyHosts, toProxyUrl, fromProxyUrl, rewriteMaster, makeHandler };
