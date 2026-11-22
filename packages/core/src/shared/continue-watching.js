// Continue watching (Following's top row): the VODs an account started but didn't finish, built from the host's
// per-account resume positions (window.lurkbox.resumeList) and the video details stored with them. Pure; shared by the
// core (the row) and the hosts (resumeSet validates the details with sanitizeResumeMeta). ES module.
//
// Clips are not in the row: a clip is at most 60 s long, so it is always under the "2 minutes left" mark (and the
// player keeps no clip positions).

export const CW_MAX = 20; // items in the row
export const CW_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // not watched for 30 days: off the row
export const CW_MIN_WATCHED = 30; // seconds; less isn't "started" (the same mark as the player's resume prompt)
export const CW_DONE_FRACTION = 0.95;
export const CW_DONE_LEFT = 120; // seconds left

const LOGIN = /^[a-z0-9_]{1,25}$/;
const DIGITS = /^\d{1,20}$/;
// Thumbnails: Twitch's https CDN, or the demo's picture scheme. Nothing else reaches an <img>.
const THUMB = /^(https:\/\/|lbhls:\/\/demo\/)[^\s"'<>]{1,500}$/;
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/**
 * The video details stored next to a resume position (title, channel, thumbnail), validated. Returns null when
 * there is nothing usable. Helix's video object works as input too.
 */
export function sanitizeResumeMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  const title = text(m.title, 200);
  if (title) out.title = title;
  const login = String(m.login || m.user_login || '').toLowerCase();
  if (LOGIN.test(login)) out.login = login;
  const name = text(m.name || m.user_name, 60);
  if (name) out.name = name;
  const userId = String(m.userId || m.user_id || '');
  if (DIGITS.test(userId)) out.userId = userId;
  const thumb = String(m.thumb || m.thumbnail_url || '');
  if (THUMB.test(thumb)) out.thumb = thumb;
  return Object.keys(out).length ? out : null;
}

/** Finished: 95 % watched, or under 2 minutes left. */
export function isFinished(position, duration) {
  const p = Number(position);
  const d = Number(duration);
  if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return false;
  return p / d >= CW_DONE_FRACTION || d - p < CW_DONE_LEFT;
}

/** "12 min left", "1 h 5 min left" (rounded up to the minute). */
export function fmtLeft(sec) {
  const m = Math.max(1, Math.ceil(Math.max(0, Number(sec) || 0) / 60));
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min left` : `${h} h left`;
}

/** The card's progress bar and label: { fraction (0..1), left (seconds), label }. */
export function cwProgress(position, duration) {
  const d = Math.max(0, Number(duration) || 0);
  const p = Math.min(d, Math.max(0, Number(position) || 0));
  const fraction = d > 0 ? p / d : 0;
  const left = d - p;
  return { fraction, left, label: fmtLeft(left) };
}

/**
 * The row from the host's entries ([{ id, position, duration, at, title?, login?, ... }]): started, not finished,
 * watched in the last 30 days, with a known duration; most recent first, at most CW_MAX.
 */
export function continueWatching(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && DIGITS.test(String(e.id)) && Number(e.position) >= CW_MIN_WATCHED && Number(e.duration) > 0
      && !isFinished(e.position, e.duration) && Number(e.at) > 0 && now - Number(e.at) <= CW_MAX_AGE_MS)
    .sort((a, b) => Number(b.at) - Number(a.at) || String(a.id).localeCompare(String(b.id)))
    .slice(0, CW_MAX);
}

/**
 * What a Helix GET /videos?id=… check says about the row's ids. result: { ok, status, data } (the host's HelixResult).
 * Returns { gone: ids Twitch no longer has (a 404, or missing from a 200 answer), fresh: Map id → Helix video }.
 * Anything else (network, 5xx, 429, 401) says nothing: no id is gone.
 */
export function checkVideos(ids, result) {
  const fresh = new Map();
  if (!result) return { gone: [], fresh };
  if (!result.ok) return { gone: result.status === 404 ? [...ids] : [], fresh };
  for (const v of (result.data && result.data.data) || []) if (v && v.id) fresh.set(String(v.id), v);
  return { gone: ids.filter((id) => !fresh.has(String(id))), fresh };
}

/** A Helix-shaped video for the card and the player, from a row entry (and the fresh Helix video, when known). */
export function videoOfEntry(e, fresh = null) {
  if (fresh) return fresh;
  return {
    id: String(e.id), title: e.title || '', user_login: e.login || '', user_name: e.name || e.login || '',
    user_id: e.userId || null, thumbnail_url: e.thumb || '', duration: '', type: 'archive',
  };
}

// ---- the hosts' resume store (desktop resume.json, Android preferences): { "<videoId>": { pos, dur, at, m? } } per account ----

export const RESUME_MAX_PER_ACCOUNT = 300;

/**
 * One account's positions after storing one (a copy; `acct` is not changed). position null/0 forgets the video.
 * meta (sanitizeResumeMeta) is kept from the last save when not given. Keeps the newest `max` entries.
 */
export function resumeUpdate(acct, videoId, position, duration, meta, { now = Date.now(), max = RESUME_MAX_PER_ACCOUNT } = {}) {
  const out = { ...(acct || {}) };
  const id = String(videoId);
  const p = Number(position);
  if (!Number.isFinite(p) || p <= 0) { delete out[id]; return out; }
  const m = sanitizeResumeMeta(meta) || (out[id] && out[id].m) || null;
  out[id] = { pos: Math.round(p), dur: Number.isFinite(Number(duration)) && Number(duration) > 0 ? Math.round(Number(duration)) : null, at: now, ...(m ? { m } : {}) };
  const ids = Object.keys(out);
  if (ids.length > max) ids.sort((a, b) => out[b].at - out[a].at).slice(max).forEach((k) => delete out[k]);
  return out;
}

/** One account's positions as resumeList() entries: [{ id, position, duration, at, title?, login?, name?, userId?, thumb? }]. */
export function resumeEntries(acct) {
  return Object.entries(acct || {})
    .filter(([id, e]) => DIGITS.test(id) && e && typeof e === 'object')
    .map(([id, e]) => ({ ...(sanitizeResumeMeta(e.m) || {}), id, position: e.pos, duration: e.dur, at: e.at }));
}
