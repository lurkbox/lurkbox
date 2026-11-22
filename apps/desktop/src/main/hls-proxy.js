'use strict';
// Twitch HLS through the main process, as the custom scheme lbhls://<host>/<path>?<query> (= https://<host>/...).
//
// Why: Twitch's VOD CDN (*.cloudfront.net, "cloudfront_vod") only sends CORS headers for twitch.tv origins, so
// hls.js in our http://localhost page can't read VOD variant playlists or segments (status 0, levelLoadError).
// The allowed hosts and the master rewrite are shared with Android (packages/core/src/shared/hls-rewrite.js); the
// response streams straight through.
//
// Only Lurkbox's own page may use it (its Origin, or its referrer for a request without one). Upstream requests carry
// no cookies or credentials, and redirects are followed here, one hop at a time, each checked like the first URL.
const { Readable } = require('stream');

const SCHEME = 'lbhls';

const shared = require('@lurkbox/core/src/shared/hls-rewrite.js');

const { ProxyHosts, allowedTarget } = shared;
const PREFIX = `${SCHEME}://`;
const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** https://host/p?q → lbhls://host/p?q (only for allowed hosts; others unchanged). */
function toProxyUrl(url, hosts) { return shared.toProxyUrl(url, hosts, PREFIX); }

/** lbhls://host/p?q → https://host/p?q, or null when the host isn't allowed. */
function fromProxyUrl(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${SCHEME}:` || !hosts.allows(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) return null;
  return `https://${u.hostname}${u.pathname}${u.search}`;
}

/** A usher master with its variant playlists through lbhls:// (see shared/hls-rewrite.js). */
function rewriteMaster(master, hosts) { return shared.rewriteMaster(master, hosts, PREFIX); }

const FORWARD_REQ = ['range', 'accept'];
const FORWARD_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];

/** The origin of an http(s) URL, or ''. */
function originOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; }
}

/** Is this request from the page at `origin`? Its Origin header when it has one, else its referrer. */
function fromPage(request, origin) {
  if (!origin) return false;
  const o = request.headers.get('origin');
  if (o) return o === origin;
  return originOf(request.referrer || request.headers.get('referer') || '') === origin;
}

/**
 * One upstream request with Electron's net.request, without cookies and without following redirects: resolves a
 * Response; a redirect comes back as its 3xx status with a Location header and no body.
 */
function netHop(net) {
  return (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = net.request({ url, method, redirect: 'manual', credentials: 'omit', useSessionCookies: false, bypassCustomProtocolHandlers: true });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on('redirect', (status, _m, location) => {
      req.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    req.on('response', (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const empty = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * protocol.handle handler.
 * @param {object} o
 * @param {(url: string, init: {method: string, headers: object}) => Promise<Response>} o.fetch  one hop, no
 *   cookies, redirects returned as 3xx (netHop(net) in the app)
 * @param {ProxyHosts} o.hosts
 * @param {() => string} o.origin  the Lurkbox page's origin (http://localhost:<port>)
 */
function makeHandler({ fetch, hosts, origin, log = () => {} }) {
  let denied = 0;
  const refuse = (why, url, headers) => {
    if (denied++ < 20) log(`[hls-proxy] refused (${why}) ${String(url).slice(0, 120)}`);
    return new Response('not allowed', { status: 403, headers });
  };
  return async (request) => {
    const page = origin();
    const cors = { 'access-control-allow-origin': page || 'null', 'access-control-expose-headers': 'content-length, content-range', vary: 'origin' };
    if (!fromPage(request, page)) return refuse('not from the Lurkbox page', request.url, cors);
    const first = fromProxyUrl(request.url, hosts);
    if (!first) return refuse('host', request.url, cors);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('', { status: 405, headers: cors });
    const headers = {};
    for (const k of FORWARD_REQ) { const v = request.headers.get(k); if (v) headers[k] = v; }
    let target = first;
    try {
      let res;
      for (let hop = 0; ; hop++) {
        res = await fetch(target, { method: request.method, headers });
        if (!REDIRECT.has(res.status)) break;
        if (res.body) res.body.cancel().catch(() => {});
        let next = null;
        try { next = allowedTarget(new URL(res.headers.get('location') || '', target), hosts); } catch { /* bad Location */ }
        if (!next || hop >= MAX_REDIRECTS) {
          log(`[hls-proxy] redirect from ${new URL(target).hostname} not followed`);
          return new Response('', { status: 502, headers: cors });
        }
        target = next;
      }
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

module.exports = { SCHEME, ProxyHosts, toProxyUrl, fromProxyUrl, rewriteMaster, makeHandler, netHop, fromPage };
