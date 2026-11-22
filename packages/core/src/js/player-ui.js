// The player overlay's controls and their labels (pure, unit-tested; no DOM).
// The bar shows icons only; the focused (or hovered, or long-pressed) control shows its label in a bubble above it.

/**
 * The row of icon buttons, in order, for what is playing.
 * ctx: { kind: 'live'|'video', points: bool (Twitch's chat frame is loaded), follow: bool (the channel is known and
 * follow/unfollow is available), compose: bool (signed in, Lurkbox chat style: "Send a message"), quick: bool (signed in:
 * quick chat, in either chat style), fullscreen: bool, vod: bool (a clip whose broadcast Twitch still has), prev/next:
 * bool (a clip with a clip before/after it in its list), clip: bool (signed in: make a clip of the live stream) }
 */
export function overlayControls(ctx) {
  const live = ctx.kind === 'live';
  if (ctx.kind === 'clip') {
    return ['play', 'volume', 'quality', ctx.prev ? 'prev' : null, ctx.next ? 'next' : null, ctx.vod ? 'vod' : null, ctx.follow ? 'follow' : null, 'channel', 'more', 'back'].filter(Boolean);
  }
  return [
    'play', 'volume', 'quality',
    live ? 'chat' : null,
    live && ctx.compose ? 'compose' : null,
    live && ctx.quick ? 'quick' : null,
    live ? 'live' : null,
    live && ctx.points ? 'points' : null,
    live && ctx.clip ? 'clip' : null,
    ctx.follow ? 'follow' : null,
    'channel', 'more', 'back',
  ].filter(Boolean);
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
