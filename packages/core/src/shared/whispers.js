// Whispers (Twitch private messages), the pure parts shared by the core and the hosts (ES module; the desktop main
// process loads it with require()). Receiving is EventSub `user.whisper.message`, sending Helix POST /whispers
// (scope user:manage:whispers). History is kept on the device, per account:
//   threads: [{ id, login, name, unread, at, messages: [{ id, me, text, at, failed? }] }], newest thread first,
//   at most WHISPER_MAX_THREADS threads of at most WHISPER_MAX_MESSAGES messages (the newest are kept).

export const WHISPER_SCOPE = 'user:manage:whispers';
export const WHISPER_MAX_THREADS = 50;
export const WHISPER_MAX_MESSAGES = 200;
/** Twitch: 500 characters to someone who hasn't whispered you before, 10,000 once they have (longer is truncated). */
export const WHISPER_MAX_NEW = 500;
export const WHISPER_MAX_REPLY = 10000;
/** Twitch's rate limits: 40 new recipients a day; within that, 3 whispers a second and 100 a minute. */
export const WHISPER_RECIPIENTS_PER_DAY = 40;
export const WHISPER_PER_SECOND = 3;
export const WHISPER_PER_MINUTE = 100;

const ID = /^\d{1,20}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;
const len = (s) => Array.from(String(s || '')).length;
const clip = (s, n) => Array.from(String(s || '')).slice(0, n).join('');

/** A whisper's text as Twitch takes it: trimmed (line breaks are allowed in whispers but drawn as spaces here). */
export function cleanWhisper(text) { return String(text || '').replace(/\r\n?/g, '\n').trim(); }

/** The length limit for a whisper to this thread: 10,000 when they have whispered you before, else 500. */
export function whisperLimit(thread) {
  return thread && Array.isArray(thread.messages) && thread.messages.some((m) => !m.me) ? WHISPER_MAX_REPLY : WHISPER_MAX_NEW;
}

/**
 * The Helix request for one whisper, or { error } ('empty', 'too-long', 'not-signed-in', 'no-recipient', 'self').
 * Returns { path: '/whispers', method: 'POST', query: { from_user_id, to_user_id }, body: { message } }.
 */
export function buildWhisperRequest({ fromId, toId, message, limit = WHISPER_MAX_NEW }) {
  const text = cleanWhisper(message);
  if (!text) return { error: 'empty' };
  if (len(text) > limit) return { error: 'too-long', limit };
  const from = String(fromId || '');
  const to = String(toId || '');
  if (!ID.test(from)) return { error: 'not-signed-in' };
  if (!ID.test(to)) return { error: 'no-recipient' };
  if (from === to) return { error: 'self' };
  return { path: '/whispers', method: 'POST', query: { from_user_id: from, to_user_id: to }, body: { message: text } };
}

/**
 * What a HelixResult of POST /whispers means (Twitch's documented answers):
 *   { ok: true }                                   204: sent (or silently dropped by Twitch)
 *   { ok: false, kind: 'phone', reason }           401 "must have a verified phone number"
 *   { ok: false, kind: 'auth', reason }            other 401s, NOT_SIGNED_IN, a missing scope: sign in again
 *   { ok: false, kind: 'blocked', reason }         403 (they don't take whispers from you; you can't send) or 400 for the same
 *   { ok: false, kind: 'not-found', reason }       404 (no such user, or suspended)
 *   { ok: false, kind: 'rate', reason, retryAt }   429 (retryAt in ms, from Ratelimit-Reset when given)
 *   { ok: false, kind: 'rejected', reason }        400 otherwise (blocked words, empty, invalid ids)
 *   { ok: false, kind: 'error', reason }           anything else
 */
export function interpretWhisperResult(r, now = Date.now()) {
  if (!r) return { ok: false, kind: 'error', reason: 'No answer from Twitch.' };
  if (r.ok) return { ok: true };
  const msg = String((r.data && r.data.message) || '').trim();
  const s = r.status;
  if (s === 401 && /phone/i.test(msg)) return { ok: false, kind: 'phone', reason: 'Twitch needs a verified phone number on your account to send whispers (twitch.tv → Settings → Security and Privacy).' };
  if (s === 401 || r.error === 'NOT_SIGNED_IN' || /scope/i.test(msg)) return { ok: false, kind: 'auth', reason: 'Sign in again to send whispers.' };
  if (s === 429) {
    const reset = Number(r.resetAt);
    return {
      ok: false, kind: 'rate',
      reason: 'Twitch\'s whisper limit: at most 40 new people a day, 3 whispers a second and 100 a minute. Wait a moment.',
      retryAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 10000,
    };
  }
  if (s === 403 || (s === 400 && /(doesn't|does not|not) (allow|accept)|strangers|suspended/i.test(msg))) {
    return { ok: false, kind: 'blocked', reason: msg && s === 403 ? `Twitch didn't send it: ${msg}` : 'This person doesn\'t accept whispers from you (or your account can\'t send whispers).' };
  }
  if (s === 404) return { ok: false, kind: 'not-found', reason: 'Twitch couldn\'t find that user (or the account is suspended).' };
  if (s === 400) return { ok: false, kind: 'rejected', reason: msg ? `Twitch didn't send it: ${msg}` : 'Twitch didn\'t send the whisper.' };
  return { ok: false, kind: 'error', reason: msg ? `Couldn't send: ${msg}` : `Couldn't send (HTTP ${s || 'error'}).` };
}

/** Can this account whisper at all? 'ok', 'signed-out' or 'reauth' (the token lacks user:manage:whispers). */
export function whisperAuthState(auth) {
  const a = auth || {};
  const missing = Array.isArray(a.missingScopes) ? a.missingScopes : [];
  if (missing.includes(WHISPER_SCOPE) || (a.needsReauth && !a.signedIn)) return 'reauth';
  if (!a.signedIn || !a.user) return 'signed-out';
  return 'ok';
}

/**
 * An EventSub user.whisper.message notification event → { peer: { id, login, name }, message } for the account
 * meId, or null when it isn't a whisper to that account.
 */
export function whisperFromEvent(ev, meId, at = Date.now()) {
  if (!ev || !ev.whisper || String(ev.to_user_id) !== String(meId)) return null;
  const id = String(ev.from_user_id || '');
  if (!ID.test(id) || id === String(meId)) return null;
  const text = clip(cleanWhisper(ev.whisper.text), WHISPER_MAX_REPLY);
  if (!text) return null;
  const login = String(ev.from_user_login || '').toLowerCase();
  return {
    peer: { id, login: LOGIN.test(login) ? login : '', name: clip(ev.from_user_name || login || id, 50) },
    message: { id: clip(ev.whisper_id || `w-${at}`, 64), me: false, text, at },
  };
}

// ---- storage ----

function cleanMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const text = clip(cleanWhisper(m.text), WHISPER_MAX_REPLY);
  const at = Number(m.at);
  if (!text || !Number.isFinite(at) || at <= 0) return null;
  const out = { id: clip(m.id || `m-${at}`, 64), me: m.me === true, text, at };
  if (m.failed) out.failed = clip(typeof m.failed === 'string' ? m.failed : 'not sent', 200);
  return out;
}

function cleanThread(t) {
  if (!t || typeof t !== 'object' || !ID.test(String(t.id || ''))) return null;
  const login = String(t.login || '').toLowerCase();
  const messages = (Array.isArray(t.messages) ? t.messages : []).map(cleanMessage).filter(Boolean)
    .sort((a, b) => a.at - b.at).slice(-WHISPER_MAX_MESSAGES);
  const last = messages.length ? messages[messages.length - 1].at : 0;
  const at = Math.max(Number(t.at) || 0, last);
  if (!at) return null;
  return {
    id: String(t.id),
    login: LOGIN.test(login) ? login : '',
    name: clip(t.name || login || t.id, 50),
    unread: Math.max(0, Math.min(WHISPER_MAX_MESSAGES, Math.floor(Number(t.unread) || 0))),
    at,
    messages,
  };
}

/** Validated threads: one per user, newest first, the caps applied. Used by the hosts before saving too. */
export function sanitizeWhisperThreads(list) {
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(list) ? list : []).map(cleanThread).filter(Boolean).sort((a, b) => b.at - a.at)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= WHISPER_MAX_THREADS) break;
  }
  return out;
}

/**
 * Adds a message to the thread with `peer` (made if new) and moves it to the top. unread: count it as unread.
 * Returns the new threads (the input is not changed).
 */
export function addWhisper(threads, peer, message, { unread = false } = {}) {
  const list = Array.isArray(threads) ? threads : [];
  const old = list.find((t) => t.id === String(peer.id));
  const t = old
    ? { ...old, login: peer.login || old.login, name: peer.name || old.name, messages: [...old.messages] }
    : { id: String(peer.id), login: peer.login || '', name: peer.name || peer.login || String(peer.id), unread: 0, at: 0, messages: [] };
  if (message.id && t.messages.some((m) => m.id === message.id)) return list; // a repeated EventSub delivery
  t.messages.push(message);
  t.at = Math.max(t.at, message.at);
  if (unread) t.unread += 1;
  return sanitizeWhisperThreads([t, ...list.filter((x) => x !== old)]);
}

/** Changes one message of a thread (e.g. marks it failed). */
export function updateWhisper(threads, peerId, messageId, patch) {
  return (threads || []).map((t) => (t.id !== String(peerId) ? t : { ...t, messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }));
}

export function markThreadRead(threads, peerId) {
  return (threads || []).map((t) => (t.id === String(peerId) && t.unread ? { ...t, unread: 0 } : t));
}

export function deleteThread(threads, peerId) { return (threads || []).filter((t) => t.id !== String(peerId)); }

export function unreadCount(threads) { return (threads || []).reduce((n, t) => n + (t.unread ? 1 : 0), 0); }

/**
 * Per-account storage maths for the hosts: { accounts: { <id>: threads } }. Returns the new object.
 * Unknown (non-numeric) account ids are refused.
 */
export function storeWhispers(data, accountId, threads) {
  const accounts = { ...((data && data.accounts) || {}) };
  if (!ID.test(String(accountId || ''))) return { accounts };
  const clean = sanitizeWhisperThreads(threads);
  if (clean.length) accounts[String(accountId)] = clean; else delete accounts[String(accountId)];
  return { accounts };
}

export function loadWhispers(data, accountId) {
  if (!ID.test(String(accountId || ''))) return [];
  return sanitizeWhisperThreads(((data && data.accounts) || {})[String(accountId)]);
}

// ---- local send gate (Twitch's 429 is the authority; this keeps the app from hitting it) ----

const DAY = 86400000;

/**
 * Twitch's whisper limits, tracked for this session: check({ now, to }) → { ok: true } or { ok: false, why:
 * 'second'|'minute'|'recipients'|'rate', waitMs }. mark({ now, to }) after a send; block(until) after a 429.
 */
export class WhisperGate {
  constructor() {
    this.sent = []; // times (ms), last minute
    this.recipients = new Map(); // user id → first send time (last 24 h)
    this.blockedUntil = -Infinity;
  }

  prune(now) {
    this.sent = this.sent.filter((t) => now - t < 60000);
    for (const [id, t] of this.recipients) if (now - t >= DAY) this.recipients.delete(id);
  }

  check({ now, to }) {
    this.prune(now);
    if (now < this.blockedUntil) return { ok: false, why: 'rate', waitMs: this.blockedUntil - now };
    const lastSecond = this.sent.filter((t) => now - t < 1000);
    if (lastSecond.length >= WHISPER_PER_SECOND) return { ok: false, why: 'second', waitMs: 1000 - (now - lastSecond[0]) };
    if (this.sent.length >= WHISPER_PER_MINUTE) return { ok: false, why: 'minute', waitMs: 60000 - (now - this.sent[0]) };
    if (to && !this.recipients.has(String(to)) && this.recipients.size >= WHISPER_RECIPIENTS_PER_DAY) {
      const first = Math.min(...this.recipients.values());
      return { ok: false, why: 'recipients', waitMs: DAY - (now - first) };
    }
    return { ok: true };
  }

  mark({ now, to }) {
    this.sent.push(now);
    if (to && !this.recipients.has(String(to))) this.recipients.set(String(to), now);
  }

  block(until) { this.blockedUntil = Math.max(this.blockedUntil, until); }
}

/** The text for a gate refusal. */
export function whisperWaitText(g) {
  if (g.why === 'recipients') return 'Twitch allows whispers to 40 new people a day. Try again tomorrow.';
  const s = Math.max(1, Math.ceil((g.waitMs || 0) / 1000));
  return `Sending whispers too fast: wait ${s} s`;
}
