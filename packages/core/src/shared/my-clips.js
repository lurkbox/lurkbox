// Clip creation (Helix POST /clips) and "My clips": the request, its errors, and the clips you made, per account
// (pure; ES module, shared by every platform: sanitizeSettings runs it in the desktop main process too).
//
// myClips: { [twitchUserId]: Entry[] }, newest first, at most MAX_MY_CLIPS per account. Entry:
//   { id: clip slug, broadcasterId, login, name, at: ms, editUrl }
// Clips are edited (title, length) on twitch.tv: editUrl is Helix's edit_url.

export const CLIP_SCOPE = 'clips:edit';
export const MAX_MY_CLIPS = 50;
export const MAX_CLIP_ACCOUNTS = 20;
const ID = /^\d{1,20}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;
const SLUG = /^[A-Za-z0-9_-]{1,120}$/;

/** 'ok', 'signed-out' or 'reauth' (the token lacks clips:edit: sign in again). */
export function clipAuthState(auth) {
  const a = auth || {};
  if (!a.signedIn || !a.user) return 'signed-out';
  const missing = Array.isArray(a.missingScopes) ? a.missingScopes : [];
  if (missing.includes(CLIP_SCOPE)) return 'reauth';
  return 'ok';
}

/** The Helix request: POST /clips?broadcaster_id=… (the clip is of the live stream, made as the signed-in user). */
export function buildClipCreate(broadcasterId) {
  const id = String(broadcasterId || '');
  if (!ID.test(id)) return { error: 'no-channel' };
  return { path: '/clips', query: { broadcaster_id: id }, method: 'POST' };
}

/** The short link to a clip (shown with the QR code): clips.twitch.tv/<slug>. */
export function clipShortLink(id) { return `clips.twitch.tv/${id}`; }

/** An edit URL we may show and encode: https on Twitch's clip or www host, else the standard one for the slug. */
export function clipEditUrl(id, editUrl) {
  try {
    const u = new URL(String(editUrl || ''));
    if (u.protocol === 'https:' && /^(clips|www)\.twitch\.tv$/.test(u.hostname)) return u.href;
  } catch { /* below */ }
  return `https://clips.twitch.tv/${id}/edit`;
}

/**
 * A HelixResult of the POST → { ok: true, id, editUrl } or { ok: false, code, message, resetAt? }.
 * code: 'reauth' (401 or the scope), 'disabled' (403: clips off, or only for followers/subscribers), 'offline' (404:
 * not live), 'ratelimited' (429; resetAt in ms), 'unavailable' (5xx), 'error'.
 */
export function clipCreateResult(r, { name = 'this channel', now = Date.now() } = {}) {
  if (r && r.ok) {
    const c = r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
    if (c && SLUG.test(String(c.id || ''))) return { ok: true, id: String(c.id), editUrl: clipEditUrl(c.id, c.edit_url) };
    return { ok: false, code: 'error', message: 'Twitch didn’t return the clip. Try again.' };
  }
  const status = r ? Number(r.status) || 0 : 0;
  const detail = String((r && r.data && r.data.message) || (r && r.error) || '');
  if (status === 401 || /missing scope|clips:edit/i.test(detail)) return { ok: false, code: 'reauth', message: 'Making clips needs a fresh sign-in.' };
  if (status === 403) {
    const restricted = /follower|subscriber|restrict/i.test(detail);
    return { ok: false, code: 'disabled', message: restricted ? `${name} lets only some viewers make clips.` : `Clips are turned off for ${name}.` };
  }
  if (status === 404) return { ok: false, code: 'offline', message: `${name} isn’t live, so there’s nothing to clip.` };
  if (status === 429) {
    const reset = Number(r.resetAt);
    const resetAt = Number.isFinite(reset) && reset > 0 ? (reset < 1e12 ? reset * 1000 : reset) : now + 60000;
    const sec = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return { ok: false, code: 'ratelimited', resetAt, message: `Too many clips. Try again in ${sec} s.` };
  }
  if (status >= 500) return { ok: false, code: 'unavailable', message: 'Twitch couldn’t make the clip right now. Try again.' };
  return { ok: false, code: 'error', message: detail ? `Couldn’t clip: ${detail.slice(0, 120)}` : 'Couldn’t clip. Try again.' };
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id || '');
  const broadcasterId = String(e.broadcasterId || '');
  const login = String(e.login || '').toLowerCase();
  if (!SLUG.test(id) || !ID.test(broadcasterId) || !LOGIN.test(login)) return null;
  const at = Number(e.at);
  const name = typeof e.name === 'string' && e.name.trim() ? Array.from(e.name.trim()).slice(0, 50).join('') : login;
  return { id, broadcasterId, login, name, at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0, editUrl: clipEditUrl(id, e.editUrl) };
}

/** One account's list: valid entries, one per clip id (the first wins), at most MAX_MY_CLIPS. */
export function sanitizeClipList(list) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const c = cleanEntry(e);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= MAX_MY_CLIPS) break;
  }
  return out;
}

/** The whole setting: numeric account ids only, at most MAX_CLIP_ACCOUNTS accounts, empty lists dropped. */
export function sanitizeMyClips(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, list] of Object.entries(v)) {
    if (!ID.test(k)) continue;
    const l = sanitizeClipList(list);
    if (l.length) out[k] = l;
    if (Object.keys(out).length >= MAX_CLIP_ACCOUNTS) break;
  }
  return out;
}

/** The setting with a new clip on top of this account's list. */
export function addMyClip(all, userId, entry) {
  const cur = all && typeof all === 'object' ? all : {};
  const list = sanitizeClipList([entry, ...(cur[userId] || [])]);
  return sanitizeMyClips({ ...cur, [userId]: list });
}

/** This account's clips of one channel, newest first. */
export function myClipsFor(all, userId, broadcasterId) {
  return ((all && all[userId]) || []).filter((c) => c.broadcasterId === String(broadcasterId));
}
