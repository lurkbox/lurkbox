// Sending chat messages as the signed-in Lurkbox account through the official Helix API (POST /chat/messages,
// scope user:write:chat). The anonymous IRC connection that shows chat also receives the message once Twitch has
// accepted it, so a sent message is drawn at once and confirmed when that echo arrives. The pure parts (request,
// response, room modes, echo matching, cooldowns) are unit-tested; the DOM lives in chat.js and chat-composer.js.

/** Twitch's limit for one chat message, in characters (code points). */
export const MAX_CHAT_LENGTH = 500;
/** The composer shows a counter from here on. */
export const COUNTER_FROM = 400;
/** How long a sent message waits for its IRC echo before it is marked "not seen in chat". */
export const ECHO_TIMEOUT_MS = 15000;
/** The scope Helix needs to send (requested at sign-in with every other scope, SCOPES in shared/config.js). */
export const SEND_SCOPE = 'user:write:chat';

/** Characters as Twitch counts them (code points, so an emoji is one). */
export function chatLength(text) { return Array.from(String(text || '')).length; }

/** The text Twitch would get: trimmed, line breaks as spaces (Twitch chat is one line). */
export function cleanMessage(text) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * The Helix request for one message, or { error } when it can't be sent as it is.
 * Returns { path: '/chat/messages', method: 'POST', body: { broadcaster_id, sender_id, message } }.
 */
export function buildSendRequest({ broadcasterId, senderId, message }) {
  const text = cleanMessage(message);
  if (!text) return { error: 'empty' };
  if (chatLength(text) > MAX_CHAT_LENGTH) return { error: 'too-long' };
  const b = String(broadcasterId || '');
  const s = String(senderId || '');
  if (!/^\d+$/.test(b)) return { error: 'no-channel' };
  if (!/^\d+$/.test(s)) return { error: 'not-signed-in' };
  return { path: '/chat/messages', method: 'POST', body: { broadcaster_id: b, sender_id: s, message: text } };
}

/** Readable text for Helix's drop_reason codes (Twitch's own message is used when it sends one). */
export const DROP_REASONS = {
  msg_duplicate: 'You sent the same message a moment ago.',
  msg_slowmode: 'Slow mode is on. Wait a little before sending again.',
  msg_followersonly: 'This chat is followers-only.',
  msg_followersonly_followed: 'This chat is followers-only, and you haven\'t followed long enough yet.',
  msg_followersonly_zero: 'This chat is followers-only.',
  msg_subsonly: 'This chat is subscribers-only.',
  msg_emoteonly: 'This chat is emote-only.',
  msg_r9k: 'Unique-chat mode is on: the message must be different from recent ones.',
  msg_banned: 'You are banned from this chat.',
  msg_timedout: 'You are timed out in this chat.',
  msg_suspended: 'Your account is suspended.',
  msg_channel_suspended: 'This channel is suspended.',
  msg_channel_blocked: 'You can\'t chat in this channel.',
  msg_verified_email: 'This chat needs a verified email address.',
  msg_requires_verified_phone_number: 'This chat needs a verified phone number.',
  msg_rejected: 'Twitch held or rejected the message (AutoMod).',
  msg_rejected_mandatory: 'Twitch rejected the message.',
  msg_ratelimit: 'You are sending messages too fast.',
  automod_held: 'AutoMod is holding the message for review.',
};

/** drop_reason ({ code, message }) → text for a toast. */
export function dropReasonText(dr) {
  if (!dr) return 'Twitch didn\'t send the message.';
  const msg = typeof dr.message === 'string' ? dr.message.trim() : '';
  if (msg) return msg;
  const code = String(dr.code || '');
  return DROP_REASONS[code] || (code ? `Twitch didn't send the message (${code}).` : 'Twitch didn\'t send the message.');
}

/**
 * What a Helix result (HelixResult from window.lurkbox.helix) means for the sender.
 *   { ok: true, id }                           sent (id = message_id, matched against the IRC echo)
 *   { ok: false, kind: 'dropped', reason, code } Twitch refused it (is_sent: false)
 *   { ok: false, kind: 'rate', reason, retryAt } HTTP 429 (retryAt in ms, from Ratelimit-Reset when given)
 *   { ok: false, kind: 'auth', reason }        sign-in needed (401, or the token lacks user:write:chat)
 *   { ok: false, kind: 'error', reason }       anything else
 */
export function interpretSendResult(r, now = Date.now()) {
  if (!r) return { ok: false, kind: 'error', reason: 'No answer from Twitch.' };
  if (r.ok) {
    const d = r.data && Array.isArray(r.data.data) ? r.data.data[0] : null;
    if (!d) return { ok: false, kind: 'error', reason: 'Twitch sent an empty answer.' };
    if (d.is_sent === false) return { ok: false, kind: 'dropped', reason: dropReasonText(d.drop_reason), code: (d.drop_reason && d.drop_reason.code) || '' };
    return { ok: true, id: String(d.message_id || '') };
  }
  const msg = String((r.data && r.data.message) || r.error || '');
  if (r.status === 429) {
    const reset = Number(r.resetAt);
    return { ok: false, kind: 'rate', reason: 'You are sending messages too fast. Wait a moment.', retryAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 5000 };
  }
  if (r.status === 401 || r.error === 'NOT_SIGNED_IN' || /scope/i.test(msg)) return { ok: false, kind: 'auth', reason: 'Sign in again to chat.' };
  if (r.status === 403) return { ok: false, kind: 'dropped', reason: msg || 'You can\'t chat in this channel.' };
  if (r.status === 422) return { ok: false, kind: 'dropped', reason: msg || 'The message is too long.' };
  return { ok: false, kind: 'error', reason: msg ? `Couldn't send: ${msg}` : `Couldn't send (HTTP ${r.status || 'error'}).` };
}

/** Can this account send at all? 'ok', 'signed-out' or 'reauth' (the token lacks the scope: sign in again). */
export function sendAuthState(auth) {
  const a = auth || {};
  const missing = Array.isArray(a.missingScopes) ? a.missingScopes : [];
  if (missing.includes(SEND_SCOPE) || (a.needsReauth && !a.signedIn)) return 'reauth';
  if (!a.signedIn || !a.user) return 'signed-out';
  return 'ok';
}

// ---- room modes (IRC ROOMSTATE) ----

export const NO_MODES = Object.freeze({ slow: 0, followersOnly: -1, subsOnly: false, emoteOnly: false, uniqueChat: false });

/**
 * ROOMSTATE tags → modes, merged over the previous ones (Twitch sends every tag on join, then only the ones that
 * changed). slow: seconds (0 = off); followersOnly: minutes (-1 = off, 0 = any follower).
 */
export function parseRoomState(tags, prev = NO_MODES) {
  const t = tags || {};
  const out = { ...NO_MODES, ...prev };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  if ('slow' in t) { const n = num(t.slow); out.slow = n && n > 0 ? n : 0; }
  if ('followers-only' in t) { const n = num(t['followers-only']); out.followersOnly = n === null || n < 0 ? -1 : n; }
  if ('subs-only' in t) out.subsOnly = t['subs-only'] === '1';
  if ('emote-only' in t) out.emoteOnly = t['emote-only'] === '1';
  if ('r9k' in t) out.uniqueChat = t.r9k === '1';
  return out;
}

function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)} h`;
  if (m < 43200) return `${Math.round(m / 1440)} d`;
  return `${Math.round(m / 43200)} mo`;
}

/** The small note above the composer: "Slow mode 30 s · Followers-only (10 min)", or '' when no mode is on. */
export function roomModeNote(modes) {
  const m = { ...NO_MODES, ...(modes || {}) };
  const parts = [];
  if (m.slow > 0) parts.push(`Slow mode ${m.slow} s`);
  if (m.followersOnly === 0) parts.push('Followers-only');
  else if (m.followersOnly > 0) parts.push(`Followers-only (${fmtMinutes(m.followersOnly)})`);
  if (m.subsOnly) parts.push('Subscribers-only');
  if (m.emoteOnly) parts.push('Emote-only');
  if (m.uniqueChat) parts.push('Unique chat');
  return parts.join(' · ');
}

/** Slow mode doesn't apply to the broadcaster, moderators and VIPs (known from the badges on your own messages). */
export function slowModeExempt({ userId, roomId, badges = '' }) {
  if (userId && roomId && String(userId) === String(roomId)) return true;
  return /(^|,)(broadcaster|moderator|vip)\//.test(String(badges || ''));
}

// ---- the optimistic echo ----

/** Same text as far as Twitch's echo goes (it trims and collapses runs of spaces). */
const norm = (s) => cleanMessage(s).replace(/\s+/g, ' ');

/**
 * Messages sent but not seen in chat yet. add() when Helix says sent; match(ev) for each incoming IRC message
 * returns the pending entry it confirms (by Helix message id, else by sender and text) and removes it; expire(now)
 * returns (and removes) the ones that waited longer than ECHO_TIMEOUT_MS.
 */
export class PendingEchoes {
  constructor({ timeoutMs = ECHO_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.items = [];
  }

  /** entry: { localId, text, userId, at, id? (Helix message_id, may be set later with setId) } */
  add(entry) { this.items.push({ ...entry, norm: norm(entry.text) }); return entry.localId; }

  setId(localId, id) { const e = this.items.find((x) => x.localId === localId); if (e) e.id = id; }

  remove(localId) { const i = this.items.findIndex((x) => x.localId === localId); return i >= 0 ? this.items.splice(i, 1)[0] : null; }

  match(ev) {
    if (!ev) return null;
    let i = ev.id ? this.items.findIndex((x) => x.id && x.id === ev.id) : -1;
    if (i < 0 && ev.userId) {
      const n = norm(ev.text);
      i = this.items.findIndex((x) => String(x.userId) === String(ev.userId) && x.norm === n);
    }
    return i >= 0 ? this.items.splice(i, 1)[0] : null;
  }

  expire(now) {
    const gone = this.items.filter((x) => now - x.at > this.timeoutMs);
    if (gone.length) this.items = this.items.filter((x) => !gone.includes(x));
    return gone;
  }

  clear() { this.items = []; }
}

// ---- cooldowns ----

/** A gap between any two sends (Twitch's own limit is 20 messages per 30 s for viewers). */
export const GLOBAL_GAP_MS = 1000;
/** Quick-chat phrases: the same phrase at most once per 3 s. */
export const PHRASE_COOLDOWN_MS = 3000;

/**
 * Local send gate: a short gap between any two messages, slow mode's gap (unless exempt), a 429's retry time, and
 * a per-phrase cooldown for quick chat. check() → { ok: true } or { ok: false, waitMs, why: 'slow'|'phrase'|'rate'|'gap' }.
 */
export class SendGate {
  constructor({ gapMs = GLOBAL_GAP_MS, phraseMs = PHRASE_COOLDOWN_MS } = {}) {
    this.gapMs = gapMs;
    this.phraseMs = phraseMs;
    this.lastAt = -Infinity;
    this.blockedUntil = -Infinity;
    this.phrases = new Map(); // phrase key → last send time
  }

  /** opts: { now, slowSec, exempt, phrase } */
  check({ now, slowSec = 0, exempt = false, phrase = null } = {}) {
    if (now < this.blockedUntil) return { ok: false, waitMs: this.blockedUntil - now, why: 'rate' };
    if (phrase != null) {
      const at = this.phrases.get(phrase);
      if (at != null && now - at < this.phraseMs) return { ok: false, waitMs: this.phraseMs - (now - at), why: 'phrase' };
    }
    const slowMs = !exempt && slowSec > 0 ? slowSec * 1000 : 0;
    const gap = Math.max(this.gapMs, slowMs);
    if (now - this.lastAt < gap) return { ok: false, waitMs: gap - (now - this.lastAt), why: slowMs > this.gapMs ? 'slow' : 'gap' };
    return { ok: true };
  }

  /** Records a send; returns a token for undo(). */
  mark({ now, phrase = null } = {}) {
    const token = { lastAt: this.lastAt, phrase, phraseAt: phrase != null ? this.phrases.get(phrase) : undefined };
    this.lastAt = now;
    if (phrase != null) this.phrases.set(phrase, now);
    return token;
  }

  /** A send that Twitch refused doesn't count (slow mode counts only sent messages; the phrase may go again). */
  undo(token) {
    if (!token) return;
    this.lastAt = token.lastAt;
    if (token.phrase != null) {
      if (token.phraseAt === undefined) this.phrases.delete(token.phrase); else this.phrases.set(token.phrase, token.phraseAt);
    }
  }

  /** A 429: nothing goes out until `until` (ms). */
  block(until) { this.blockedUntil = Math.max(this.blockedUntil, until); }
}

/** "Wait 2 s" text for a gate refusal. */
export function waitText(gate) {
  const s = Math.max(1, Math.ceil((gate.waitMs || 0) / 1000));
  if (gate.why === 'slow') return `Slow mode: wait ${s} s`;
  if (gate.why === 'rate') return `Sending too fast: wait ${s} s`;
  return `Wait ${s} s`;
}

// ---- "sent" listeners (recent emotes; demo mode's fake IRC echo) ----

const sentListeners = new Set();
/** fn({ channel, roomId, text, id, user }) after Twitch accepted a message. Returns an unsubscribe function. */
export function onChatSent(fn) { sentListeners.add(fn); return () => sentListeners.delete(fn); }
export function emitChatSent(detail) {
  for (const fn of sentListeners) { try { fn(detail); } catch (e) { console.error(e); } }
}
