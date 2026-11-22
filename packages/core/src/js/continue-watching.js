// Following's Continue watching row: its items, from the host's resume positions (no DOM; unit-tested).
import { state } from './state.js';
import { continueWatching, checkVideos, videoOfEntry } from '../shared/continue-watching.js';

// Continue watching: the Helix check of each VOD in the row (fresh details, or gone), once per account and session.
const checked = { account: null, videos: new Map() };

/**
 * The Continue watching row's items for the active account: the host's resume positions through the row's rules,
 * each VOD checked once with Helix (one GET /videos for the unchecked ones). VODs Twitch no longer has (404, or
 * missing from the answer) are forgotten here, lazily. Items: { id, position, duration, at, video }.
 */
export async function loadContinueWatching({ account = state.auth.active, now = Date.now() } = {}) {
  const lurkbox = window.lurkbox;
  if (state.settings.continueWatchingOn === false || !lurkbox.resumeList) return [];
  if (checked.account !== account) { checked.account = account; checked.videos = new Map(); }
  let rows = continueWatching(await lurkbox.resumeList().catch(() => []), now);
  const unchecked = rows.map((e) => e.id).filter((id) => !checked.videos.has(id));
  if (unchecked.length) {
    const r = await lurkbox.helix({ path: '/videos', query: { id: unchecked, first: 100 }, method: 'GET' }).catch(() => null);
    const { gone, fresh } = checkVideos(unchecked, r);
    for (const [id, v] of fresh) checked.videos.set(id, v);
    if (gone.length) {
      for (const id of gone) lurkbox.resumeSet(id, 0).catch(() => {});
      rows = rows.filter((e) => !gone.includes(e.id));
    }
  }
  rows = rows.filter((e) => !pending.has(e.id));
  return rows.map((e) => ({ id: e.id, position: e.position, duration: e.duration, at: e.at, video: videoOfEntry(e, checked.videos.get(e.id)) }));
}

/** Tests: forget the Helix checks. */
export function resetContinueWatchingChecks() { checked.account = null; checked.videos = new Map(); }

// Removals waiting out their Undo toast: id → timer. The row leaves them out meanwhile; the position is only
// forgotten when the time is up (or at exit, flushRemovals), so Undo puts the card back exactly as it was.
export const UNDO_MS = 6000;
const pending = new Map();

/** Remove with Undo: hidden at once, forgotten after `ms` unless undoRemoval(id) comes first. */
export function scheduleRemoval(id, ms = UNDO_MS) {
  const k = String(id);
  clearTimeout(pending.get(k));
  pending.set(k, setTimeout(() => { pending.delete(k); removeFromContinueWatching(k); }, ms));
}
/** Undo: true if the removal was still pending. */
export function undoRemoval(id) {
  const k = String(id);
  if (!pending.has(k)) return false;
  clearTimeout(pending.get(k));
  pending.delete(k);
  return true;
}
/** At exit: forget every pending removal now. */
export function flushRemovals() {
  for (const [k, t] of pending) { clearTimeout(t); removeFromContinueWatching(k); }
  pending.clear();
}
export const isPendingRemoval = (id) => pending.has(String(id));

/** "Remove from Continue watching": forgets the saved position too (the video would start over next time). */
export function removeFromContinueWatching(id) {
  if (!window.lurkbox.resumeSet) return Promise.resolve(false);
  return window.lurkbox.resumeSet(String(id), 0).catch(() => false);
}
