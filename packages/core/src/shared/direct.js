// Shared by the hosts (ES module, `fetch` injected; the desktop loads it with require()).
// Direct HLS playback support (approved by the maintainer 2026-11-21; a ToS grey area).
// Fetches a playback access token from Twitch's web GQL endpoint and the usher
// master playlist. Ads are never skipped or filtered; they are only labelled.
export const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // twitch.tv web's public client ID (GQL only)
export const GQL_URL = 'https://gql.twitch.tv/gql';

const QUERY = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {'
  + ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature authorization { isForbidden forbiddenReasonCode } __typename }'
  + ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

/** GQL request for a live channel ({login}) or a VOD ({vodId}); authToken = twitch.tv auth-token cookie or null. */
export function buildGqlRequest({ login, vodId, authToken }) {
  const isVod = !!vodId;
  const headers = { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
  if (authToken) headers.Authorization = `OAuth ${authToken}`;
  return {
    url: GQL_URL,
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName: 'PlaybackAccessToken',
      query: QUERY,
      variables: { isLive: !isVod, login: isVod ? '' : String(login).toLowerCase(), isVod, vodID: isVod ? String(vodId) : '', playerType: 'site', platform: 'web' },
    }),
  };
}

export function usherUrl({ login, vodId, token, sig, codecs = ['h264'], rand = Math.floor(Math.random() * 1e7) }) {
  const base = vodId
    ? `https://usher.ttvnw.net/vod/${encodeURIComponent(String(vodId))}.m3u8`
    : `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(String(login).toLowerCase())}.m3u8`;
  const q = new URLSearchParams({
    sig, token,
    allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true',
    p: String(rand), player_backend: 'mediaplayer', playlist_include_framerate: 'true',
    supported_codecs: codecs.join(','), platform: 'web',
  });
  return `${base}?${q}`;
}

/** Why a signed-in token request fell back to anonymous: 'integrity required' | 'cookie rejected (...)'. */
export function anonReasonFor(reason) {
  const r = String(reason || '');
  if (/integrity/i.test(r)) return `integrity required (${r.slice(0, 80)})`;
  return `cookie rejected (${r.slice(0, 80)})`;
}

/**
 * Returns { ok, master, authed, anonReason } or { ok:false, reason, offline? }.
 * Tries with the player sign-in first (subs/Turbo), then anonymously.
 */
export async function fetchMaster({ fetch, login, vodId, codecs, authToken, log = () => {} }) {
  const attempt = async (auth) => {
    const req = buildGqlRequest({ login, vodId, authToken: auth });
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    if (!res.ok) return { ok: false, reason: `token HTTP ${res.status}` };
    const json = await res.json();
    const t = json && json.data && (vodId ? json.data.videoPlaybackAccessToken : json.data.streamPlaybackAccessToken);
    if (!t || !t.value || !t.signature) return { ok: false, reason: (json && json.errors && json.errors[0] && json.errors[0].message) || 'no token' };
    if (t.authorization && t.authorization.isForbidden) return { ok: false, reason: `forbidden: ${t.authorization.forbiddenReasonCode}` };
    return { ok: true, token: t.value, sig: t.signature };
  };
  let tok = authToken ? await attempt(authToken).catch((e) => ({ ok: false, reason: e.message })) : null;
  const authed = !!(tok && tok.ok);
  let anonReason = null;
  if (!authed) {
    anonReason = authToken ? anonReasonFor(tok.reason) : 'no auth-token cookie';
    if (authToken) log(`[direct] authenticated token failed (${tok.reason}); anon token (ads possible)`);
    tok = await attempt(null).catch((e) => ({ ok: false, reason: e.message }));
  }
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const res = await fetch(usherUrl({ login, vodId, token: tok.token, sig: tok.sig, codecs }));
  if (res.status === 404) return { ok: false, reason: 'offline', offline: true };
  if (!res.ok) return { ok: false, reason: `usher HTTP ${res.status}` };
  const master = await res.text();
  if (!/^#EXTM3U/.test(master) || !/#EXT-X-STREAM-INF/.test(master)) return { ok: false, reason: 'invalid playlist' };
  return { ok: true, master, authed, anonReason };
}

/**
 * The archive VOD being recorded for the live stream (GQL has no stream id on videos): status RECORDING and created
 * within 10 minutes after the stream started. Returns a Helix-shaped video or null.
 */
export function matchGqlArchive(stream, node) {
  if (!stream || !node || node.status !== 'RECORDING') return null;
  const s = Date.parse(stream.createdAt);
  const v = Date.parse(node.createdAt);
  if (!Number.isFinite(s) || !Number.isFinite(v) || v < s - 60000 || v > s + 600000) return null;
  return { id: String(node.id), type: 'archive', stream_id: String(stream.id), created_at: node.createdAt, duration: `${Math.max(0, Math.floor(Number(node.lengthSeconds) || 0))}s` };
}

/** Live stream + its archive VOD for a channel without a Helix token: { stream: {id, started_at} | null, archive }. */
export async function fetchLiveInfo({ fetch, login }) {
  const q = `{ user(login: ${JSON.stringify(String(login).toLowerCase())}) { id stream { id createdAt } videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id createdAt lengthSeconds status } } } } }`;
  const r = await fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID }, body: JSON.stringify({ query: q }) }).then((x) => x.json());
  const u = r && r.data && r.data.user;
  if (!u || !u.stream) return { stream: null, archive: null };
  const node = u.videos && u.videos.edges && u.videos.edges[0] && u.videos.edges[0].node;
  return { stream: { id: String(u.stream.id), started_at: u.stream.createdAt, user_id: String(u.id) }, archive: matchGqlArchive(u.stream, node) };
}

/** VOD scrubbing thumbnails: Twitch's seekPreviewsURL sprite sheets (web GQL). Null when unavailable. */
export async function fetchStoryboard({ fetch, vodId }) {
  if (!/^\d{1,20}$/.test(String(vodId))) return null;
  const q = { query: `{ video(id: ${JSON.stringify(String(vodId))}) { seekPreviewsURL } }` };
  const r = await fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID }, body: JSON.stringify(q) }).then((x) => x.json());
  const url = r && r.data && r.data.video && r.data.video.seekPreviewsURL;
  if (!url) return null;
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/\.cloudfront\.net$|\.twitch\.tv$|\.ttvnw\.net$/.test(u.hostname)) return null;
  const list = await fetch(url).then((x) => (x.ok ? x.json() : null));
  if (!Array.isArray(list)) return null;
  const pick = list.find((s) => s.quality === 'high') || list[0];
  if (!pick || !Array.isArray(pick.images)) return null;
  const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
  return {
    count: num(pick.count), width: num(pick.width), height: num(pick.height), rows: num(pick.rows), cols: num(pick.cols), interval: num(pick.interval),
    images: pick.images.filter((i) => /^[\w.-]+\.jpg$/.test(i)).map((i) => new URL(i, url).href),
  };
}
