// VOD chat replay: the chat as it happened, synced to the playback position. Twitch's web GQL
// VideoCommentsByOffsetOrCursor (public, anonymous; the web client ID, the same transport as clips and storyboards) gives
// pages of comments from an offset (seconds into the video) or after a cursor. The host fetches (fetchComments); the
// page keeps a small buffer ahead of the position and hands each comment to the chat when the video reaches it
// (VodChatReplay), in the IRC event shape the live chat renders (commentEvent), so badges, Twitch emotes and the 7TV,
// BetterTTV and FrankerFaceZ emotes look the same. Seeking (or a jump) starts over from the new offset; pausing stops it.
// ES module; the desktop main process loads it with require().
import { GQL_URL, WEB_CLIENT_ID } from './direct.js';

export const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';
const COMMENTS_QUERY = 'query VideoCommentsByOffsetOrCursor($videoID: ID!, $contentOffsetSeconds: Int, $cursor: Cursor) { video(id: $videoID) { id creator { id } comments(contentOffsetSeconds: $contentOffsetSeconds, after: $cursor) { edges { cursor node { id contentOffsetSeconds commenter { id login displayName } message { fragments { text emote { emoteID from } } userBadges { setID version } userColor } } } pageInfo { hasNextPage } } } }';
const VIDEO_ID = /^\d{1,20}$/;

/** The GQL body: by offset (seconds) or after a cursor; persisted: the twitch.tv hash, else the plain query. */
export function commentsBody({ videoId, offset = null, cursor = null, persisted = true }) {
  const variables = { videoID: String(videoId) };
  if (cursor) variables.cursor = String(cursor);
  else variables.contentOffsetSeconds = Math.max(0, Math.floor(Number(offset) || 0));
  return persisted
    ? { operationName: 'VideoCommentsByOffsetOrCursor', variables, extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } } }
    : { operationName: 'VideoCommentsByOffsetOrCursor', query: COMMENTS_QUERY, variables };
}

/** Code points, as IRC emote positions count them. */
const cpLength = (s) => [...String(s)].length;

/**
 * One comment node → the live chat's IRC message event ({ id, nick, login, color, text, userId, roomId, badges,
 * emotes, offset }): the fragments joined, each Twitch emote fragment at its code-point range, badges as "set/version".
 */
export function commentEvent(node, roomId = '') {
  if (!node || !node.id || !node.message) return null;
  const frags = Array.isArray(node.message.fragments) ? node.message.fragments : [];
  let text = '';
  const emotes = new Map();
  for (const f of frags) {
    const t = String((f && f.text) || '');
    const start = cpLength(text);
    text += t;
    const id = f && f.emote && f.emote.emoteID ? String(f.emote.emoteID) : null;
    if (id && t && /^[\w:.-]+$/.test(id)) {
      if (!emotes.has(id)) emotes.set(id, []);
      emotes.get(id).push(`${start}-${start + cpLength(t) - 1}`);
    }
  }
  if (!text) return null;
  const c = node.commenter || {};
  const badges = (Array.isArray(node.message.userBadges) ? node.message.userBadges : [])
    .filter((b) => b && b.setID).map((b) => `${b.setID}/${b.version || '1'}`).join(',');
  let action = false;
  const am = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (am) { text = am[1]; action = true; }
  return {
    kind: 'msg',
    id: String(node.id).slice(0, 64),
    nick: String(c.displayName || c.login || 'someone').slice(0, 40),
    login: String(c.login || '').toLowerCase().slice(0, 25),
    color: typeof node.message.userColor === 'string' && /^#[0-9a-f]{6}$/i.test(node.message.userColor) ? node.message.userColor : '',
    text: text.slice(0, 600),
    action,
    userId: String(c.id || ''),
    roomId: String(roomId || ''),
    badges,
    emotes: [...emotes].map(([id, r]) => `${id}:${r.join(',')}`).join('/'),
    offset: Math.max(0, Number(node.contentOffsetSeconds) || 0),
  };
}

/** A GQL answer → { ok, comments (events, by offset), cursor (to read on), hasNext, roomId } or { ok: false, reason }. */
export function parseComments(json) {
  const v = json && json.data && json.data.video;
  if (json && Array.isArray(json.errors) && json.errors.length && !v) return { ok: false, reason: String(json.errors[0].message || 'GQL error').slice(0, 120) };
  if (!v) return { ok: false, reason: 'not-found' };
  const roomId = (v.creator && v.creator.id) || '';
  const edges = (v.comments && Array.isArray(v.comments.edges)) ? v.comments.edges : [];
  const comments = edges.map((e) => commentEvent(e && e.node, roomId)).filter(Boolean);
  comments.sort((a, b) => a.offset - b.offset);
  const last = edges.length ? edges[edges.length - 1] : null;
  return { ok: true, comments, cursor: last && last.cursor ? String(last.cursor) : null, hasNext: !!(v.comments && v.comments.pageInfo && v.comments.pageInfo.hasNextPage), roomId: String(roomId) };
}

/** One page of comments (host side): the persisted query, then the plain one if Twitch no longer knows the hash. */
export async function fetchComments({ fetch, videoId, offset = null, cursor = null, log = () => {} }) {
  if (!VIDEO_ID.test(String(videoId || ''))) return { ok: false, reason: 'bad request' };
  let last = { ok: false, reason: 'no answer' };
  for (const persisted of [true, false]) {
    try {
      const r = await fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(commentsBody({ videoId, offset, cursor, persisted })) });
      if (!r.ok) { last = { ok: false, reason: `GQL HTTP ${r.status}` }; continue; }
      const json = await r.json();
      const unknownHash = json && Array.isArray(json.errors) && json.errors.some((e) => /PersistedQueryNotFound/i.test(String(e && e.message)));
      if (persisted && unknownHash) { log('[vod-chat] persisted query unknown; plain query'); continue; }
      return parseComments(json);
    } catch (e) { last = { ok: false, reason: e.message }; }
  }
  return last;
}

/**
 * The page's replay: keeps the comments ahead of the position (at most `maxAhead`), fetches the next page while less
 * than `leadSec` seconds are buffered, and emits each comment once the video reaches it. A seek (back, or forward past
 * the buffer) starts over from the new offset, with the last `contextSec` seconds of chat shown at once.
 */
export class VodChatReplay {
  /**
   * @param {object} o
   * @param {(req: { offset?: number, cursor?: string }) => Promise<object>} o.load  one page (parseComments' shape)
   * @param {(ev: object) => void} o.onMessage
   * @param {() => void} [o.onReset]  the chat should clear (a seek)
   * @param {(text: string) => void} [o.onNote]  a note for the chat (no comments, errors)
   */
  constructor({ load, onMessage, onReset = () => {}, onNote = () => {}, leadSec = 40, maxAhead = 1500, contextSec = 20, now = () => Date.now() }) {
    Object.assign(this, { load, onMessage, onReset, onNote, leadSec, maxAhead, contextSec, now });
    this.ahead = []; // events not shown yet, by offset
    this.pos = null; // the last position handled
    this.cursor = null;
    this.hasNext = false;
    this.loading = null;
    this.gen = 0;
    this.failures = 0;
    this.retryAt = 0;
    this.seen = new Set(); // ids shown since the last reset (pages can overlap)
    this.loadedTo = -1; // the offset the buffer covers up to (the last comment fetched)
    this.retryOffset = null; // a failed first page, asked again after the backoff
  }

  /** Called a few times a second with the video's position (seconds) and whether it plays. */
  tick(position, paused = false) {
    const p = Math.max(0, Number(position) || 0);
    if (this.pos === null || p < this.pos - 2 || (p > this.pos + 15 && !(this.loadedTo >= p))) { this.seek(p); return; }
    if (paused && p === this.pos) return;
    this.pos = p;
    this.emitUpTo(p);
    this.maybeLoad();
  }

  /** Starts over at p: clear, load from p − contextSec, show what is up to p. */
  seek(p) {
    this.gen++;
    this.pos = p;
    this.ahead = [];
    this.cursor = null;
    this.hasNext = false;
    this.loading = null;
    this.seen.clear();
    this.loadedTo = -1;
    this.failures = 0;
    this.retryAt = 0;
    this.retryOffset = null;
    this.onReset();
    this.fetch({ offset: Math.max(0, Math.floor(p - this.contextSec)) });
  }

  emitUpTo(p) {
    let n = 0;
    while (this.ahead.length && this.ahead[0].offset <= p) {
      const ev = this.ahead.shift();
      if (this.seen.has(ev.id)) continue;
      this.seen.add(ev.id);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
      this.onMessage(ev);
      n++;
    }
    return n;
  }

  maybeLoad() {
    if (this.loading || this.now() < this.retryAt) return;
    if (this.retryOffset != null) { const offset = this.retryOffset; this.retryOffset = null; this.fetch({ offset }); return; }
    if (!this.hasNext || !this.cursor) return;
    const lead = this.ahead.length ? this.ahead[this.ahead.length - 1].offset - this.pos : 0;
    if (lead >= this.leadSec || this.ahead.length >= this.maxAhead) return;
    this.fetch({ cursor: this.cursor });
  }

  fetch(req) {
    const gen = this.gen;
    this.loading = Promise.resolve().then(() => this.load(req)).catch((e) => ({ ok: false, reason: e.message })).then((r) => {
      if (gen !== this.gen) return;
      this.loading = null;
      if (!r || !r.ok) {
        this.failures++;
        this.retryAt = this.now() + Math.min(60000, 2000 * 2 ** this.failures);
        if (this.failures === 1) this.onNote(r && r.reason === 'not-found' ? 'This video has no chat replay.' : `Chat replay unavailable right now (${(r && r.reason) || 'error'}); retrying.`);
        if (r && r.reason === 'not-found') { this.hasNext = false; this.retryOffset = null; return; }
        if (req.offset != null) this.retryOffset = req.offset;
        return;
      }
      this.failures = 0;
      const fresh = r.comments.filter((c) => !this.seen.has(c.id) && !this.ahead.some((a) => a.id === c.id));
      this.ahead.push(...fresh);
      this.ahead.sort((a, b) => a.offset - b.offset);
      if (this.ahead.length > this.maxAhead) this.ahead.length = this.maxAhead;
      if (r.comments.length) this.loadedTo = Math.max(this.loadedTo, r.comments[r.comments.length - 1].offset);
      this.cursor = r.cursor;
      this.hasNext = !!r.hasNext && !!r.cursor;
      if (req.offset != null && !r.comments.length && !r.hasNext) this.onNote('No chat messages from here on.');
      this.emitUpTo(this.pos);
      this.maybeLoad();
    });
    return this.loading;
  }
}
