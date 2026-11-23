// The player overlay's controls and their labels (pure, unit-tested; no DOM).
// The bar shows icons only; the focused (or hovered, or long-pressed) control shows its label in a bubble above it.

/**
 * The row of icon buttons, in order, for what is playing.
 * ctx: { kind: 'live'|'video', points: bool (Twitch's chat frame is loaded), follow: bool (the channel is known and
 * follow/unfollow is available), compose: bool (signed in, Lurkbox chat style: "Send a message"), quick: bool (signed in:
 * quick chat, in either chat style), fullscreen: bool, vod: bool (a clip whose broadcast Twitch still has), prev/next:
 * bool (a clip with a clip before/after it in its list), clip: bool (signed in: make a clip of the live stream),
 * volume: bool (default true; false on a phone, which has volume buttons), replay: bool (a VOD or clip with a chat
 * replay: the chat control shows for it) }
 */
export function overlayControls(ctx) {
  const live = ctx.kind === 'live';
  const volume = ctx.volume !== false ? 'volume' : null;
  if (ctx.kind === 'clip') {
    return ['play', volume, 'quality', ctx.replay ? 'chat' : null, ctx.prev ? 'prev' : null, ctx.next ? 'next' : null, ctx.vod ? 'vod' : null, ctx.follow ? 'follow' : null, 'channel', 'more', 'back'].filter(Boolean);
  }
  return [
    'play', volume, 'quality',
    live || ctx.replay ? 'chat' : null, // a VOD's chat replay (read-only: no compose)
    live && ctx.compose ? 'compose' : null,
    live && ctx.quick ? 'quick' : null,
    live ? 'live' : null,
    live && ctx.points ? 'points' : null,
    live && ctx.clip ? 'clip' : null,
    ctx.follow ? 'follow' : null,
    'channel', 'more', 'back',
  ].filter(Boolean);
}

/**
 * The multi-view active tile's row: the player's controls that make sense for one tile of several (the rest of the
 * tile's actions stay in its menu, behind More). ctx: { points: bool, follow: bool } as for overlayControls().
 */
export function multiControls(ctx = {}) {
  return ['live', ctx.points ? 'points' : null, ctx.follow ? 'follow' : null, 'more'].filter(Boolean);
}

/**
 * Which controls leave the row first when it is too narrow: the end of this list goes first. Those in
 * PINNED_CONTROLS never leave it; the rest move into the More pop-over, in their row order.
 */
export const CONTROL_PRIORITY = ['play', 'chat', 'quick', 'volume', 'quality', 'live', 'prev', 'next', 'vod', 'follow', 'clip', 'points', 'channel', 'compose', 'back', 'more'];
export const PINNED_CONTROLS = new Set(['play', 'chat', 'quick', 'more']);

/**
 * Fits the row of `keys` (row order) into `width` px, every button `button` px wide with `gap` px between them.
 * Drops the lowest-priority unpinned controls until the rest fit. Returns { shown, overflow }, both in row order.
 * A width or button size of 0 (not laid out yet) keeps them all. `pinned` can add to the controls that always stay.
 */
export function fitControls(keys, { width, button, gap = 0, pinned = PINNED_CONTROLS }) {
  if (!(width > 0) || !(button > 0)) return { shown: [...keys], overflow: [] };
  const rank = (k) => { const i = CONTROL_PRIORITY.indexOf(k); return i < 0 ? CONTROL_PRIORITY.length : i; };
  const fits = (n) => n * button + Math.max(0, n - 1) * gap <= width + 0.5;
  const kept = new Set(keys);
  const drop = keys.filter((k) => !pinned.has(k)).sort((a, b) => rank(b) - rank(a));
  for (const k of drop) {
    if (fits(kept.size)) break;
    kept.delete(k);
  }
  return { shown: keys.filter((k) => kept.has(k)), overflow: keys.filter((k) => !kept.has(k)) };
}

/** Which controls open a pop-over above themselves (the rest act at once). */
export const POPOVER_CONTROLS = new Set(['volume', 'quality', 'chat', 'quick', 'points', 'more']);

/** Icon name for a control in this state. */
export function controlIcon(key, ctx = {}) {
  switch (key) {
    case 'play': return ctx.paused ? 'play' : 'pause';
    case 'volume': return ctx.muted || ctx.volume === 0 ? 'volume-muted' : ctx.volume < 0.5 ? 'volume-low' : 'volume';
    case 'chat': return ctx.chatOn ? 'chat' : 'chat-off';
    case 'follow': return ctx.following ? 'heart-filled' : 'heart';
    case 'compose': return 'keyboard';
    default: return key;
  }
}

/** Short form of a channel-points balance for the badge on the icon: 950, 12.3K, 1.2M. */
export function shortCount(n) {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e4) return `${Math.floor(v / 1e3)}K`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}

/**
 * The label bubble's text: the action and, after " · ", its current state.
 * ctx: { paused, muted, volume (0..1), quality (label), chatOn, rewound, behind, points (balance or null), name,
 *        following (true / false / null when unknown) }
 */
export function controlLabel(key, ctx = {}) {
  const dot = ' · ';
  switch (key) {
    case 'play': return ctx.paused ? 'Play' : 'Pause';
    case 'volume': return `Volume${dot}${ctx.muted ? 'Muted' : `${Math.round((Number(ctx.volume) || 0) * 100)}%`}`;
    case 'quality': return `Quality${dot}${ctx.quality || 'Auto'}`;
    case 'chat': return `Chat${dot}${ctx.chatOn ? 'On' : 'Off'}`;
    case 'compose': return 'Send a message';
    case 'quick': return 'Quick chat';
    case 'live': return ctx.rewound ? 'Back to live' : ctx.behind ? 'Jump to live' : 'Live';
    case 'points': return Number.isFinite(ctx.points) ? `Channel points${dot}${Math.round(ctx.points).toLocaleString('en-US')}` : 'Channel points';
    case 'follow': return ctx.following ? `Following${dot}Unfollow?` : 'Follow';
    case 'channel': return ctx.name ? `${ctx.name}${dot}Channel` : 'Channel';
    case 'clip': return ctx.clipping ? 'Clipping…' : 'Clip';
    case 'vod': return ctx.vodOffset ? `Watch from here${dot}${ctx.vodOffset}` : 'Watch the broadcast';
    case 'prev': return ctx.prev ? `Previous clip${dot}${ctx.prev}` : 'Previous clip';
    case 'next': return ctx.next ? `Next clip${dot}${ctx.next}` : 'Next clip';
    case 'more': return 'More';
    case 'back': return 'Back';
    default: return key;
  }
}

/** The badge on the top line: '● LIVE', '−0:23 behind', 'Rewound −1:02:03' (null for videos). */
export function liveLabel({ kind, rewoundBy = null, badge = null, direct = true }) {
  if (kind !== 'live') return null;
  if (rewoundBy != null) return { text: `Rewound −${fmtClock(rewoundBy)}`, state: 'rewound' };
  if (!direct || !badge || badge.live) return { text: '● LIVE', state: 'live' };
  return { text: badge.text, state: 'behind' };
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * Where a pop-over goes: above its button, centred on it, kept inside the box (the overlay) with `margin` px.
 * Rects are { left, top, right, bottom } in the same coordinates; size is { width, height }.
 * Returns { left, bottom } in px relative to the box (CSS left/bottom).
 */
export function anchorPopover(btn, size, box, { margin = 12, gap = 10 } = {}) {
  const boxW = box.right - box.left;
  const centre = (btn.left + btn.right) / 2 - box.left;
  const left = Math.min(Math.max(margin, centre - size.width / 2), Math.max(margin, boxW - size.width - margin));
  const bottom = Math.max(margin, box.bottom - btn.top + gap);
  return { left: Math.round(left), bottom: Math.round(bottom) };
}

/** Auto-hide delays: the bar alone, and with a pop-over open (time to read and adjust). */
export const OVERLAY_HIDE_MS = 4000;
export const POPOVER_HIDE_MS = 8000;
