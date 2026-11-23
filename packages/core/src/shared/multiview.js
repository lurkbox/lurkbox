// Multi-view (2–4 live streams at once): the pure rules, unit-tested in packages/core/test/multiview.test.mjs.
// A tile is { login, name, userId, stream? }; the UI (js/multiview.js) keeps the list, the active index and the layout.

export const MIN_TILES = 2;
export const MAX_TILES = 4;

/** Layout ids: 'side' (side by side), 'big' (one big plus a column of small ones), 'grid' (2x2). */
export const LAYOUT_NAMES = { side: 'Side by side', big: 'One big', grid: 'Grid' };

/** The layouts that fit n tiles, the default first. */
export function layoutsFor(n) {
  if (n <= 2) return ['side', 'big'];
  if (n === 3) return ['big', 'grid'];
  return ['grid', 'big'];
}

/** The layout to use for n tiles: the wanted one if it fits, else the default. */
export function fitLayout(want, n) {
  const ok = layoutsFor(n);
  return ok.includes(want) ? want : ok[0];
}

/** The next layout for the layout button. */
export function nextLayout(cur, n) {
  const ok = layoutsFor(n);
  return ok[(ok.indexOf(cur) + 1) % ok.length];
}

/**
 * Tile rectangles as fractions of the stage ({ x, y, w, h }, 0..1), in tile order. 'big': tile 0 is big (2/3 of
 * the width), the others share the right column; 'grid': 2x2 (three tiles leave the last cell empty).
 */
export function layoutRects(layout, n) {
  const l = fitLayout(layout, n);
  if (n <= 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (l === 'side') return Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0, w: 1 / n, h: 1 }));
  if (l === 'grid') return Array.from({ length: n }, (_, i) => ({ x: (i % 2) / 2, y: Math.floor(i / 2) / 2, w: 0.5, h: 0.5 }));
  const small = n - 1;
  return [{ x: 0, y: 0, w: 2 / 3, h: 1 }, ...Array.from({ length: small }, (_, i) => ({ x: 2 / 3, y: i / small, w: 1 / 3, h: 1 / small }))];
}

/** D-pad: the tile next to `active` in direction dir ('up'|'down'|'left'|'right'), or active when there is none. */
export function moveActive(rects, active, dir) {
  const c = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const a = rects[active];
  if (!a) return active;
  const from = c(a);
  let best = active;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === active) return;
    const p = c(r);
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const main = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (main <= 1e-6) return;
    // Overlapping on the cross axis beats a nearer tile off to the side.
    const overlap = dir === 'left' || dir === 'right' ? r.y < a.y + a.h - 1e-6 && r.y + r.h > a.y + 1e-6 : r.x < a.x + a.w - 1e-6 && r.x + r.w > a.x + 1e-6;
    const score = (overlap ? 0 : 10) + main + cross * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** Only the active tile plays sound: muted[i] for each tile. muteAll: the user muted the whole view. */
export function tileMutes(n, active, muteAll = false) {
  return Array.from({ length: n }, (_, i) => muteAll || i !== active);
}

/**
 * The quality cap (max height in px, or null for none) for one tile. Non-active tiles get the multi-view setting
 * ('480' default, '720', 'same' = no cap); the background cap (while unfocused) applies to every tile; the lower wins.
 */
export function tileCap({ isActive, multiQuality = '480', backgroundCap = null }) {
  const own = isActive ? null : multiQuality === 'same' ? null : multiQuality === '720' ? 720 : 480;
  const caps = [own, backgroundCap].filter((c) => Number.isFinite(c) && c > 0);
  return caps.length ? Math.min(...caps) : null;
}

const same = (a, b) => String(a.login).toLowerCase() === String(b.login).toLowerCase();

/** Adds a channel: { tiles, active, error? } (error 'full' or 'duplicate'). The new tile becomes active. */
export function addTile(tiles, active, ch) {
  if (tiles.some((t) => same(t, ch))) return { tiles, active, error: 'duplicate' };
  if (tiles.length >= MAX_TILES) return { tiles, active, error: 'full' };
  const next = [...tiles, ch];
  return { tiles: next, active: next.length - 1 };
}

/**
 * Removes tile i. Fewer than MIN_TILES left: { exit: the channel to play on its own }. Otherwise the active index
 * follows its tile (removing the active one makes the one before it active).
 */
export function removeTile(tiles, active, i) {
  if (i < 0 || i >= tiles.length) return { tiles, active };
  const next = tiles.filter((_, j) => j !== i);
  if (next.length < MIN_TILES) return { tiles: next, active: 0, exit: next[0] || null };
  let a = active;
  if (i < active) a = active - 1;
  else if (i === active) a = Math.max(0, i - 1);
  return { tiles: next, active: Math.min(a, next.length - 1) };
}

/** Swaps tiles i and j (e.g. "Move to the big tile"); the active index follows the tile it was on. */
export function swapTiles(tiles, active, i, j) {
  if (i === j || !tiles[i] || !tiles[j]) return { tiles, active };
  const next = [...tiles];
  [next[i], next[j]] = [next[j], next[i]];
  const a = active === i ? j : active === j ? i : active;
  return { tiles: next, active: a };
}

/** Replaces tile i's channel in place (a raid followed inside its tile). */
export function replaceTile(tiles, i, ch) {
  if (!tiles[i]) return tiles;
  if (tiles.some((t, j) => j !== i && same(t, ch))) return tiles.filter((_, j) => j !== i); // already shown: drop the duplicate
  return tiles.map((t, j) => (j === i ? ch : t));
}

/** B (or "Watch only this"): leave multi-view for the single player on this channel. */
export function exitTarget(tiles, active) {
  return tiles[active] || tiles[0] || null;
}

/** Who can be added from the followed live list: the streams not already shown. */
export function candidates(live, tiles) {
  return live.filter((s) => !tiles.some((t) => same(t, { login: s.user_login })));
}

// ---- raids on every tile (one EventSub connection carries a channel.raid subscription per tile) ----

/** The raid watcher's targets: every tile with a known broadcaster id ({ id, login }). */
export function raidTargets(tiles) {
  return tiles.filter((t) => t.userId).map((t) => ({ id: String(t.userId), login: t.login }));
}

/** The tile a raid comes from (the raiding channel), or -1. */
export function raidTileIndex(tiles, ev) {
  const from = ev && String(ev.from_broadcaster_user_id || '');
  return from ? tiles.findIndex((t) => t.userId && String(t.userId) === from) : -1;
}

/** The raid target as a tile channel. */
export function raidChannel(ev) {
  return { login: ev.to_broadcaster_user_login, name: ev.to_broadcaster_user_name || ev.to_broadcaster_user_login, userId: String(ev.to_broadcaster_user_id || '') || null, stream: null };
}

// ---- the multi-select picker ----

/** Free slots for adding streams to `n` tiles. */
export function freeSlots(n) { return Math.max(0, MAX_TILES - n); }

/** A toggles `value` in the selection (in pick order), up to `limit`: { selected, error? 'full' }. */
export function toggleSelection(selected, value, limit) {
  if (selected.includes(value)) return { selected: selected.filter((v) => v !== value) };
  if (selected.length >= limit) return { selected, error: 'full' };
  return { selected: [...selected, value] };
}

/** Start/Y: the picked values, or the focused item when nothing is ticked (so A-less confirm still adds one). */
export function confirmSelection(selected, focused, limit) {
  const out = selected.length ? selected : focused != null ? [focused] : [];
  return out.slice(0, limit);
}

// ---- the last set, per account ("Resume multi-view") ----

const LOGIN = /^[a-z0-9_]{1,25}$/i;
const ACCOUNT = /^\d{1,20}$/;

function cleanTile(t) {
  if (!t || typeof t !== 'object' || !LOGIN.test(String(t.login || ''))) return null;
  const login = String(t.login).toLowerCase();
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 50) : login;
  const userId = t.userId != null && ACCOUNT.test(String(t.userId)) ? String(t.userId) : null;
  return { login, name, userId };
}

function cleanSet(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list) {
    const c = cleanTile(t);
    if (c && !out.some((x) => x.login === c.login)) out.push(c);
    if (out.length >= MAX_TILES) break;
  }
  return out.length >= MIN_TILES ? out : null;
}

/** settings.multiSets: { <user id>: [{ login, name, userId }] } (2–4 each); anything else is dropped. */
export function sanitizeMultiSets(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, list] of Object.entries(v)) {
    if (!ACCOUNT.test(id)) continue;
    const s = cleanSet(list);
    if (s) out[id] = s;
  }
  return out;
}

/** Remembers this account's set (2+ tiles; fewer keeps the last one). Returns the new map, or null if unchanged. */
export function rememberSet(sets, accountId, tiles) {
  if (!accountId || !ACCOUNT.test(String(accountId))) return null;
  const s = cleanSet(tiles);
  if (!s) return null;
  const cur = (sets || {})[accountId];
  if (cur && cur.length === s.length && cur.every((t, i) => t.login === s[i].login && t.userId === s[i].userId)) return null;
  return { ...(sets || {}), [accountId]: s };
}

/**
 * "Resume multi-view": this account's saved channels that are live now (`live` = Helix /streams of followed
 * channels), as the streams in the saved order; [] when fewer than two are live.
 */
export function resumableSet(sets, accountId, live) {
  const saved = (sets || {})[accountId];
  if (!saved || !Array.isArray(live)) return [];
  const out = saved.map((t) => live.find((s) => String(s.user_login).toLowerCase() === t.login)).filter(Boolean);
  return out.length >= MIN_TILES ? out : [];
}
