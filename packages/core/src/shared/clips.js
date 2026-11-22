// Shared by the hosts (ES module, `fetch` injected; the desktop loads it with require()).
// Clip playback sources (unofficial; README "Unofficial Twitch interfaces"). Helix GET /clips has no video URL, so,
// like twitch.tv itself and Streamlink, Lurkbox asks Twitch's web GQL for the clip's MP4 qualities and a signed
// playback token (VideoAccessToken_Clip), then appends sig and token to each quality's URL. Read-only; nothing here
// changes the account. The persisted query is what twitch.tv sends; a plain query is the fallback when Twitch no
// longer knows the hash.
import { WEB_CLIENT_ID, GQL_URL } from './direct.js';

export const CLIP_HASH = '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11';
const CLIP_QUERY = 'query VideoAccessToken_Clip($slug: ID!) { clip(slug: $slug) { id'
  + ' playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { signature value }'
  + ' videoQualities { frameRate quality sourceURL } } }';
const SLUG = /^[A-Za-z0-9_-]{1,120}$/;
/** Hosts a clip's MP4 may come from. */
const CLIP_HOSTS = /(^|\.)(twitchcdn\.net|twitch\.tv|cloudfront\.net|ttvnw\.net|jtvnw\.net)$/;

export function validSlug(slug) { return SLUG.test(String(slug || '')); }

/** The GQL request for a clip; persisted: the twitch.tv hash (true) or the plain query (false). authToken optional. */
export function buildClipRequest(slug, { persisted = true, authToken = null } = {}) {
  const headers = { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
  if (authToken) headers.Authorization = `OAuth ${authToken}`;
  const body = persisted
    ? { operationName: 'VideoAccessToken_Clip', variables: { slug: String(slug) }, extensions: { persistedQuery: { version: 1, sha256Hash: CLIP_HASH } } }
    : { operationName: 'VideoAccessToken_Clip', query: CLIP_QUERY, variables: { slug: String(slug) } };
  return { url: GQL_URL, method: 'POST', headers, body: JSON.stringify(body) };
}

/**
 * A GQL answer → { ok: true, qualities: [{ quality, frameRate, url }] } (signed URLs) or { ok: false, reason }.
 * reason 'not-found' when the clip doesn't exist (deleted), 'persisted' when the hash is unknown (retry plain).
 */
export function parseClipAccess(json) {
  const r = Array.isArray(json) ? json[0] : json;
  const err = r && Array.isArray(r.errors) && r.errors[0] ? String(r.errors[0].message || 'error') : null;
  if (err) return { ok: false, reason: /PersistedQueryNotFound/i.test(err) ? 'persisted' : err.slice(0, 120) };
  const clip = r && r.data && r.data.clip;
  if (!clip) return { ok: false, reason: 'not-found' };
  const tok = clip.playbackAccessToken;
  if (!tok || !tok.signature || !tok.value) return { ok: false, reason: 'no token' };
  const qualities = [];
  for (const q of Array.isArray(clip.videoQualities) ? clip.videoQualities : []) {
    let u;
    try { u = new URL(String(q && q.sourceURL)); } catch { continue; }
    if (u.protocol !== 'https:' || !CLIP_HOSTS.test(u.hostname)) continue;
    u.searchParams.set('sig', String(tok.signature));
    u.searchParams.set('token', String(tok.value));
    qualities.push({ quality: String(q.quality || ''), frameRate: Number(q.frameRate) || 30, url: u.href });
  }
  if (!qualities.length) return { ok: false, reason: 'no qualities' };
  return { ok: true, qualities };
}

/** Fetches a clip's signed qualities: the persisted query first, then the plain one. */
export async function fetchClipSources({ fetch, slug, authToken = null, log = () => {} }) {
  if (!validSlug(slug)) return { ok: false, reason: 'bad slug' };
  let last = { ok: false, reason: 'no answer' };
  for (const persisted of [true, false]) {
    const req = buildClipRequest(slug, { persisted, authToken });
    let res;
    try { res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body }); } catch (e) { return { ok: false, reason: e.message }; }
    if (!res.ok) { last = { ok: false, reason: `GQL HTTP ${res.status}` }; continue; }
    last = parseClipAccess(await res.json().catch(() => null));
    if (last.ok || last.reason === 'not-found') return last;
    log(`[clip] ${persisted ? 'persisted' : 'plain'} query failed: ${last.reason}`);
  }
  return last;
}

