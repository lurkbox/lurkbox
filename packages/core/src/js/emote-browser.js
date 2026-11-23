// The channel page's Emotes tab, the parts without a DOM (unit-tested): the sub-tabs, shaping a provider's list for the
// grid (A–Z, one per name, overlay marking), the search filter, the detail panel's facts, the bigger preview's URL, and
// the A (add to the chat draft for this channel) and Y (add to this channel's quick-chat phrases) actions.
import { insertEmote } from './emote-picker.js';
import { onAccountRemoved } from './state.js';
import { editPhrases, phraseList, listOps, sanitizeQuickChat, MAX_PHRASES } from '../shared/quick-chat.js';

/** The sub-tabs, in order. */
export const EMOTE_TABS = [
  { value: '7tv', label: '7TV' },
  { value: 'bttv', label: 'BTTV' },
  { value: 'ffz', label: 'FFZ' },
  { value: 'twitch', label: 'Twitch' },
];
export const PROVIDER_NAMES = { '7tv': '7TV', bttv: 'BetterTTV', ffz: 'FrankerFaceZ', twitch: 'Twitch' };

/** The empty state of a sub-tab that loaded fine but has nothing. */
export function emptyText(tab, channelName = 'This channel') {
  if (tab === 'twitch') return `${channelName} has no Twitch channel emotes.`;
  return `${channelName} has no ${PROVIDER_NAMES[tab] || tab} emote set.`;
}

/** Overlay (zero-width) emotes: 7TV/BTTV zero-width flags, and FrankerFaceZ modifier emotes. */
export function isOverlay(e) {
  return !!(e && (e.zeroWidth || e.ffzModifier));
}

/**
 * One provider's emotes for the grid: only ones with a name and a picture, one per name (the first wins, as the loaders
 * list the channel's own first), sorted A–Z ignoring case (ties: exact name), each marked `overlay`.
 */
export function shapeEmotes(list) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.name !== 'string' || !e.name || typeof e.url !== 'string' || !e.url || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ ...e, overlay: isOverlay(e) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The emotes whose name contains `query` (ignoring case and surrounding spaces); names that start with it come first,
 * each group keeping the list's order. An empty query returns the list as it is.
 */
export function filterEmotes(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  const starts = [];
  const contains = [];
  for (const e of list) {
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) starts.push(e);
    else if (n.includes(q)) contains.push(e);
  }
  return [...starts, ...contains];
}

/** The sub-tab's label with its count ("7TV 312"), or just the name while loading or on an error. */
export function tabLabel(tab, count) {
  const t = EMOTE_TABS.find((x) => x.value === tab);
  const name = t ? t.label : tab;
  return Number.isInteger(count) && count >= 0 ? `${name} ${count > 999 ? '999+' : count}` : name;
}

/** The bigger picture for the detail panel: each CDN's next size up (only on those CDNs); else the grid's URL. */
export function bigUrl(e) {
  const u = String((e && e.url) || '');
  if (u.startsWith('https://cdn.7tv.app/')) return u.replace(/\/2x(_static)?\.(webp|avif|gif|png)$/, '/4x$1.$2');
  if (u.startsWith('https://cdn.betterttv.net/')) return u.replace(/\/2x\.(webp|png|gif)$/, '/3x.$1');
  if (u.startsWith('https://cdn.frankerfacez.com/')) return u.replace(/\/2(\.webp)?$/, '/4$1');
  if (u.startsWith('https://static-cdn.jtvnw.net/emoticons/')) return u.replace(/\/2\.0$/, '/3.0');
  return u;
}

const TWITCH_KINDS = { subscriptions: 'Subscriber', follower: 'Follower', bitstier: 'Bits' };

/** The detail panel's rows: [[label, value]], for a shaped emote. */
export function emoteFacts(e) {
  const rows = [['Provider', PROVIDER_NAMES[e.provider] || e.provider]];
  if (e.provider === 'twitch') {
    const kind = TWITCH_KINDS[e.emoteType] || '';
    const tier = e.emoteType === 'subscriptions' && /^[123]000$/.test(e.tier || '') ? ` · Tier ${e.tier[0]}` : '';
    if (kind) rows.push(['Type', `${kind}${tier}`]);
  } else if (e.author) {
    rows.push([e.provider === 'ffz' ? 'Owner' : 'By', e.author]);
  }
  rows.push(['Zero-width', e.overlay ? 'Yes' : 'No']);
  if (e.animated) rows.push(['Animated', 'Yes']);
  return rows;
}

// ---- A: the chat draft for a channel ----

/**
 * Whether A can add to a chat message: 'ok', 'signed-out' (no sign-in to send with) or 'twitch-style' (the Twitch chat
 * style has its own input, Lurkbox's composer is hidden).
 */
export function draftAvailability(auth, settings) {
  if (!auth || !auth.signedIn) return 'signed-out';
  if (settings && settings.chatStyle === 'twitch') return 'twitch-style';
  return 'ok';
}

/** Drafts waiting for the player, by channel login. The player takes a channel's draft when it opens that channel. */
const pending = new Map();
onAccountRemoved(() => pending.clear()); // drafts belong to the account that wrote them

/** Adds an emote name to the channel's draft. Returns the new draft text, or null when it would go over 500 characters. */
export function addToDraft(login, name, drafts = pending) {
  const key = String(login || '').toLowerCase();
  const r = insertEmote(drafts.get(key) || '', null, name);
  if (!r) return null;
  drafts.set(key, r.text);
  return r.text;
}

/** The channel's waiting draft ('' when none), left in place. */
export function peekDraft(login, drafts = pending) {
  return drafts.get(String(login || '').toLowerCase()) || '';
}

/** The player opening a channel: its waiting draft ('' when none), which is then cleared. */
export function takeDraft(login, drafts = pending) {
  const key = String(login || '').toLowerCase();
  const t = drafts.get(key) || '';
  drafts.delete(key);
  return t;
}

// ---- Y: this channel's quick-chat phrases ----

/**
 * Adds the emote's name as a phrase to the channel's own list. channel: { id, login }. Returns { qc, result } with
 * result 'added', 'exists' (the list has it already; qc unchanged) or 'full' (MAX_PHRASES; qc unchanged).
 */
export function addEmotePhrase(qc, channel, name) {
  const q = sanitizeQuickChat(qc);
  const list = phraseList(q, 'channel', channel && channel.id);
  if (list.includes(name)) return { qc: q, result: 'exists' };
  if (list.length >= MAX_PHRASES) return { qc: q, result: 'full' };
  return { qc: editPhrases(q, 'channel', channel, (l) => listOps.add(l, name)), result: 'added' };
}
