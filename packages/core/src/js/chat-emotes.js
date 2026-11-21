// Chat emotes: Twitch emotes from the IRC `emotes` tag, plus word-matched third-party emotes (7TV, BetterTTV,
// FrankerFaceZ), with zero-width/overlay emotes layered over the previous emote. Pure; no DOM, unit-tested.

/** Name-clash precedence, highest first (as the 7TV extension does). Twitch emotes are only replaced by name. */
export const PROVIDERS = ['7tv', 'bttv', 'ffz'];

/** Twitch's CDN image for an emote id. `animated: false` asks for the static frame. */
export function twitchEmoteUrl(id, { animated = true, scale = '2.0' } = {}) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/${animated ? 'default' : 'static'}/dark/${scale}`;
}

/**
 * Parses the IRC `emotes` tag ("25:0-4,12-16/1902:6-10") into ranges sorted by start. The positions are
 * inclusive and count Unicode code points (not UTF-16 units). Malformed parts are skipped.
 */
export function parseEmotesTag(tag) {
  const out = [];
  if (!tag) return out;
  for (const group of String(tag).split('/')) {
    const c = group.lastIndexOf(':');
    if (c <= 0) continue;
    const id = group.slice(0, c);
    for (const r of group.slice(c + 1).split(',')) {
      const m = /^(\d+)-(\d+)$/.exec(r);
      if (!m) continue;
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (end >= start) out.push({ id, start, end });
    }
  }
  out.sort((a, b) => a.start - b.start);
  // Drop overlapping ranges (never sent by Twitch, but don't trust input).
  return out.filter((r, i, a) => i === 0 || r.start > a[i - 1].end);
}

/**
 * Splits message text at the Twitch emote ranges. Returns [{ t: 'text', s }] and
 * [{ t: 'emote', provider: 'twitch', id, name }] parts. Ranges outside the text are ignored.
 */
export function splitTwitchEmotes(text, tag) {
  const ranges = parseEmotesTag(tag);
  if (!ranges.length) return text ? [{ t: 'text', s: text }] : [];
  const cps = Array.from(text); // code points, matching Twitch's indexing (emoji and surrogate pairs count as one)
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.end >= cps.length) continue;
    if (r.start > pos) parts.push({ t: 'text', s: cps.slice(pos, r.start).join('') });
    parts.push({ t: 'emote', provider: 'twitch', id: r.id, name: cps.slice(r.start, r.end + 1).join('') });
    pos = r.end + 1;
  }
  if (pos < cps.length) parts.push({ t: 'text', s: cps.slice(pos).join('') });
  return parts;
}

/**
 * The third-party emotes known for the current channel. Each provider has a global and a channel set; the channel
 * set wins within a provider, and providers win in PROVIDERS order. Personal (7TV) sets win for their owner.
 * Lookups are cached in one Map, rebuilt lazily after a change.
 */
export class EmoteIndex {
  constructor() {
    this.sets = new Map(); // `${provider}:${scope}` → Map(name → emote)
    this.enabled = new Set(PROVIDERS);
    this.merged = null;
    this.personal = new Map(); // setId → Map(name → emote)
    this.userSets = new Map(); // twitch user id → Set(setId)
  }

  setEnabled(providers) {
    this.enabled = new Set(providers);
    this.merged = null;
  }

  /** Replaces one provider's 'global' or 'channel' emotes. */
  set(provider, scope, emotes) {
    this.sets.set(`${provider}:${scope}`, new Map((emotes || []).map((e) => [e.name, e])));
    this.merged = null;
  }

  /** Adds, removes or renames emotes in one set (7TV live updates). */
  patch(provider, scope, { add = [], remove = [] } = {}) {
    const key = `${provider}:${scope}`;
    const m = this.sets.get(key) || new Map();
    for (const name of remove) m.delete(name);
    for (const e of add) m.set(e.name, e);
    this.sets.set(key, m);
    this.merged = null;
  }

  clearChannel() {
    for (const p of PROVIDERS) this.sets.delete(`${p}:channel`);
    this.personal.clear();
    this.userSets.clear();
    this.merged = null;
  }

  has(provider, scope) { return this.sets.has(`${provider}:${scope}`); }

  /** The merged name → emote map (lowest precedence first, so higher ones overwrite). */
  map() {
    if (this.merged) return this.merged;
    const m = new Map();
    for (const p of [...PROVIDERS].reverse()) {
      if (!this.enabled.has(p)) continue;
      for (const scope of ['global', 'channel']) {
        const s = this.sets.get(`${p}:${scope}`);
        if (s) for (const [k, v] of s) m.set(k, v);
      }
    }
    this.merged = m;
    return m;
  }

  /** Personal 7TV sets: the user gets the set (entitlement), and the set gets emotes (emote_set events). */
  setUserSet(userId, setId, on = true) {
    const s = this.userSets.get(userId) || new Set();
    if (on) s.add(setId); else s.delete(setId);
    this.userSets.set(userId, s);
  }

  patchPersonal(setId, { add = [], remove = [] } = {}) {
    const m = this.personal.get(setId) || new Map();
    for (const name of remove) m.delete(name);
    for (const e of add) m.set(e.name, e);
    this.personal.set(setId, m);
  }

  get(name, userId) {
    if (userId && this.enabled.has('7tv')) {
      const sets = this.userSets.get(userId);
      if (sets) for (const id of sets) { const e = this.personal.get(id)?.get(name); if (e) return e; }
    }
    return this.map().get(name) || null;
  }
}

// BetterTTV's text modifiers go before an emote ("h! KEKW"). The value is the CSS effect class.
export const BTTV_MODIFIERS = { 'h!': 'flip-x', 'v!': 'flip-y', 'w!': 'wide', 'l!': 'rotate-l', 'r!': 'rotate-r', 'c!': 'cursed', 'z!': 'zero-width', 'p!': 'party', 's!': 'shake' };
// FrankerFaceZ modifier emotes follow an emote; modifier_flags bits → effect.
const FFZ_FLAGS = [[2, 'flip-x'], [4, 'flip-y'], [8, 'wide'], [2048, 'party'], [16384, 'cursed'], [128, 'spin']];
export function ffzEffects(flags) { return FFZ_FLAGS.filter(([bit]) => flags & bit).map(([, e]) => e); }

/**
 * Turns a message into render parts:
 *   { t: 'text', s }
 *   { t: 'emote', emote, effects: [], overlays: [emote, ...] }
 * Twitch emotes come from the tag; other words are matched against the index. A zero-width emote is layered over
 * the previous emote (the whitespace between them is dropped); with nothing to layer on, it shows on its own.
 */
export function tokenize(text, emotesTag, index, { userId = '', animated = true } = {}) {
  const out = [];
  let pendingMods = []; // BTTV modifier words waiting for an emote
  let pendingSpace = ''; // whitespace after them (dropped if an emote follows)
  const lastEmote = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i];
      if (p.t === 'emote') return p;
      if (p.t === 'text' && p.s.trim()) return null;
    }
    return null;
  };
  const pushText = (s) => {
    const prev = out[out.length - 1];
    if (prev && prev.t === 'text') prev.s += s; else out.push({ t: 'text', s });
  };
  const pushEmote = (emote) => {
    const fx = pendingMods.map((w) => BTTV_MODIFIERS[w]);
    const effects = fx.filter((m) => m !== 'zero-width');
    const zeroWidth = emote.zeroWidth || fx.includes('zero-width');
    pendingMods = [];
    pendingSpace = '';
    // FFZ modifier emotes change the previous emote instead of showing.
    if (emote.ffzModifier) {
      const base = lastEmote();
      if (base) {
        dropTrailingSpace();
        base.effects.push(...ffzEffects(emote.ffzFlags || 0));
        if (!(emote.ffzFlags & 1)) base.overlays.push(emote);
        return;
      }
      if (emote.ffzFlags & 1) return;
    }
    if (zeroWidth) {
      const base = lastEmote();
      if (base) { dropTrailingSpace(); base.overlays.push(emote); return; }
    }
    out.push({ t: 'emote', emote, effects, overlays: [] });
  };
  const dropTrailingSpace = () => {
    const prev = out[out.length - 1];
    if (prev && prev.t === 'text' && !prev.s.trim()) out.pop();
  };

  for (const part of splitTwitchEmotes(text, emotesTag)) {
    if (part.t === 'emote') {
      // A third-party emote with the same name wins (7TV > BTTV > FFZ > Twitch).
      const other = index && index.get(part.name, userId);
      pushEmote(other || { provider: 'twitch', id: part.id, name: part.name, url: twitchEmoteUrl(part.id, { animated }) });
      continue;
    }
    for (const w of part.s.split(/(\s+)/)) {
      if (!w) continue;
      if (/^\s+$/.test(w)) { if (pendingMods.length) pendingSpace += w; else pushText(w); continue; }
      if (BTTV_MODIFIERS[w] && index && index.enabled.has('bttv')) {
        pendingMods.push(w);
        continue;
      }
      const e = index && index.get(w, userId);
      if (e) pushEmote(e);
      else {
        if (pendingMods.length) { pushText(`${pendingMods.join(' ')}${pendingSpace}`); pendingMods = []; pendingSpace = ''; }
        pushText(w);
      }
    }
  }
  // A modifier with no emote after it was just text.
  if (pendingMods.length) pushText(`${pendingMods.join(' ')}${pendingSpace}`);
  return out;
}
