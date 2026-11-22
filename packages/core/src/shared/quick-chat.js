// Quick chat (saved phrases) and recent emotes: the stored shapes, their validation, and the list edits used by the
// player's quick-chat picker and Settings → Chat → Quick chat. Shared by every platform (sanitizeSettings runs these
// in the desktop main process too). Pure; ES module.
//
// quickChat: { global: string[], channels: { [broadcasterId]: { login, phrases: string[] } } }
// emoteRecents: { [twitchUserId]: string[] } (emote names, newest first, per account)

export const MAX_PHRASE_LENGTH = 500; // Twitch's message limit
export const MAX_PHRASES = 30; // per list
export const MAX_CHANNEL_LISTS = 100;
export const MAX_RECENTS = 24;
export const MAX_RECENT_ACCOUNTS = 20;

export const DEFAULT_QUICK_CHAT = Object.freeze({
  global: Object.freeze(['gg', 'LUL', 'hype!', 'o7', 'PogChamp']),
  channels: Object.freeze({}),
});

const ID = /^\d{1,20}$/;
const LOGIN = /^[a-z0-9_]{1,25}$/;

/** One phrase as stored: one line, trimmed, at most 500 characters (code points); '' when unusable. */
export function cleanPhrase(text) {
  if (typeof text !== 'string') return '';
  const one = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, MAX_PHRASE_LENGTH).join('').trim();
}

/** A phrase list: strings only, cleaned, no empties or repeats, at most 30. */
export function sanitizePhrases(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    const c = cleanPhrase(p);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

/** The whole quick-chat setting. Channel lists are keyed by broadcaster id, with the login kept for display. */
export function sanitizeQuickChat(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { global: [...DEFAULT_QUICK_CHAT.global], channels: {} };
  const channels = {};
  const src = v.channels && typeof v.channels === 'object' && !Array.isArray(v.channels) ? v.channels : {};
  for (const [id, c] of Object.entries(src)) {
    if (Object.keys(channels).length >= MAX_CHANNEL_LISTS) break;
    if (!ID.test(id) || !c || typeof c !== 'object') continue;
    const phrases = sanitizePhrases(c.phrases);
    if (!phrases.length) continue;
    const login = typeof c.login === 'string' && LOGIN.test(c.login.toLowerCase()) ? c.login.toLowerCase() : '';
    channels[id] = { login, phrases };
  }
  return { global: sanitizePhrases(v.global), channels };
}

/** Recent emotes per account: names without spaces, at most 24 each, for at most 20 accounts. */
export function sanitizeEmoteRecents(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, names] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_RECENT_ACCOUNTS) break;
    if (!ID.test(id) || !Array.isArray(names)) continue;
    const list = [];
    for (const n of names) {
      if (typeof n !== 'string' || !n || n.length > 100 || /\s/.test(n) || list.includes(n)) continue;
      list.push(n);
      if (list.length >= MAX_RECENTS) break;
    }
    if (list.length) out[id] = list;
  }
  return out;
}

/** The recents after using `name` (newest first). */
export function pushRecent(recents, userId, name) {
  const all = { ...(recents || {}) };
  const id = String(userId || '');
  if (!ID.test(id) || !name) return all;
  all[id] = [name, ...(all[id] || []).filter((n) => n !== name)].slice(0, MAX_RECENTS);
  return all;
}

/**
 * The picker's phrases for a channel: its own first, then the global ones (a global phrase the channel list already
 * has is left out). Each: { text, scope: 'channel' | 'global', index } (index into its own list).
 */
export function quickPhrases(qc, broadcasterId) {
  const q = qc || DEFAULT_QUICK_CHAT;
  const own = (broadcasterId && q.channels && q.channels[broadcasterId] && q.channels[broadcasterId].phrases) || [];
  const out = own.map((text, index) => ({ text, scope: 'channel', index }));
  (q.global || []).forEach((text, index) => { if (!own.includes(text)) out.push({ text, scope: 'global', index }); });
  return out;
}

/** The list a scope refers to. */
export function phraseList(qc, scope, broadcasterId) {
  const q = qc || DEFAULT_QUICK_CHAT;
  if (scope === 'global') return [...(q.global || [])];
  const c = q.channels && q.channels[broadcasterId];
  return c ? [...c.phrases] : [];
}

/**
 * A new quick-chat value with one list changed by `edit(list) → list`. scope 'global', or 'channel' with
 * channel: { id, login }. An emptied channel list is removed. The result is sanitised.
 */
export function editPhrases(qc, scope, channel, edit) {
  const q = sanitizeQuickChat(qc || DEFAULT_QUICK_CHAT);
  if (scope === 'global') return sanitizeQuickChat({ ...q, global: edit([...q.global]) });
  const id = String((channel && channel.id) || '');
  if (!ID.test(id)) return q;
  const prev = q.channels[id];
  const phrases = sanitizePhrases(edit(prev ? [...prev.phrases] : []));
  const channels = { ...q.channels };
  if (phrases.length) channels[id] = { login: (channel && channel.login) || (prev && prev.login) || '', phrases };
  else delete channels[id];
  return sanitizeQuickChat({ ...q, channels });
}

/** List edits (pure): add at the end, replace, remove, move one step up (-1) or down (+1). */
export const listOps = {
  add: (list, text) => (list.length >= MAX_PHRASES ? list : [...list, text]),
  set: (list, i, text) => list.map((x, j) => (j === i ? text : x)),
  remove: (list, i) => list.filter((_, j) => j !== i),
  move: (list, i, dir) => {
    const j = i + dir;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  },
};
