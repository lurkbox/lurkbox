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
