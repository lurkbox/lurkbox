// Twitch Drops: pure helpers for the Drops section (views/drops.js) and the player's progress chip (unit-tested).
// The host shows Twitch's own Drops Inventory page and auto-claims finished drops; see window.lurkbox.drops*.
import { UP, DOWN, LEFT, RIGHT, A, B } from './input-core.js';

/** The URL the Drops section frames (the host allows framing for exactly this page). */
export const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';

/** What the Drops section shows: 'unsupported' (host has no drops), 'signin' (no twitch.tv session) or 'inventory'. */
export function dropsScreen({ supported, signedIn }) {
  if (!supported) return 'unsupported';
  return signedIn ? 'inventory' : 'signin';
}

const PAD = { [UP]: 'up', [DOWN]: 'down', [LEFT]: 'left', [RIGHT]: 'right', [A]: 'a', [B]: 'b' };
/** The key forwarded to the page's controller navigation for an action, or null (LB/RB, Y, ... stay with the app). */
export function dropsPadKey(action) { return PAD[action] || null; }

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** "Rust: Winter Drops" / "Rust - Week 2" / "Rust | Launch" start with the game "Rust". */
function prefixed(campaign, game) {
  const c = String(campaign || '').trim().toLowerCase();
  const gm = String(game || '').trim().toLowerCase();
  return !!gm && c.startsWith(gm) && /^\s*[:\-\u2013\u2014|]/.test(c.slice(gm.length));
}

/**
 * The player's drops chip for a stream's game, from the inventory's campaigns in progress: the unfinished drop with
 * the most progress in a campaign for that game (matched on the game name, or a campaign name like "<game>: ...").
 * Returns { name, percent, label } or null. Twitch's public API doesn't say whether a stream has drops enabled, so
 * this only says "you are earning a drop for this game".
 */
export function pickDropsChip(campaigns, gameName) {
  const g = norm(gameName);
  if (!g || !Array.isArray(campaigns)) return null;
  let best = null;
  for (const c of campaigns) {
    if (!c || !(norm(c.game) === g || norm(c.name) === g || prefixed(c.name, gameName))) continue;
    for (const d of c.drops || []) {
      if (!d || d.claimable || d.percent == null || d.percent === '') continue;
      const p = Number(d.percent);
      if (!Number.isFinite(p) || p >= 100 || p < 0) continue;
      if (!best || p > best.percent) best = { name: String(d.name || '').slice(0, 60), percent: Math.round(p) };
    }
  }
  if (!best) return null;
  return { ...best, label: best.name ? `Drop ${best.percent}% · ${best.name}` : `Drop ${best.percent}%` };
}
