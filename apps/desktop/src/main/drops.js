'use strict';
// Twitch Drops through Twitch's own Drops Inventory page (twitch.tv/drops/inventory), signed in with the user's
// twitch.tv web session. Two uses:
//   - the Drops section shows the page in an iframe (zoomed for the TV, driven by frame-nav.js);
//   - auto-claim (Settings → Player → Auto-claim drops) loads the same page in a hidden window every 15 min, reads the
//     campaigns in progress and clicks the page's own "Claim" buttons for finished drops.
// Only Twitch's own buttons are clicked; nothing is called on the user's behalf beyond what the page itself offers.
// Logs carry drop names only, never IDs or cookie values.
//
// The inventory page has few stable hooks: the selectors below were taken from public userscripts that claim drops on
// this page (class names "inventory-max-width" and "inventory-campaign-info", role=progressbar) and are deliberately
// tolerant: data-a-target / data-test-selector / aria-label first, then the button's text. They need checking on a
// signed-in session.

const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';

const SELECTORS = Object.freeze({
  // The page's content column.
  root: ['.inventory-max-width', '[data-test-selector*="inventory" i]', '[data-a-target*="inventory" i]', 'main'],
  // One campaign card's header (game box art, campaign name, end date).
  campaignInfo: ['.inventory-campaign-info', '[data-test-selector*="campaign-info" i]', '[class*="campaign-info" i]'],
  // The game: a link to its directory page, or its box art.
  game: ['a[href*="/directory/category/"]', 'a[href*="/directory/game/"]', 'img[alt]'],
  progress: ['[role="progressbar"]', '[data-a-target*="progress" i]', '[class*="progress-bar" i]'],
  // Claim buttons by attribute first; any button whose own text says "Claim" / "Claim Now" / "Click to claim" too.
  claim: ['button[data-a-target*="claim" i]', 'button[data-test-selector*="claim" i]', 'button[aria-label*="claim" i]'],
  loading: ['[data-a-target*="loading-spinner" i]', '.tw-loading-spinner', '[class*="loading-spinner" i]'],
  signedOut: ['button[data-a-target="login-button"]', '[data-a-target="signup-button"]', 'a[href^="/login"]'],
});

/** Button texts that mean "claim this drop" (and not "Claimed"). */
const CLAIM_TEXT = /^\s*(click\s+to\s+)?claim(\s+now|\s+drop|\s+reward)?\s*!?\s*$/i;

/**
 * frame-nav options in the Drops view: stay in an open dialog, otherwise the whole page; DOM focus stays on the app's
 * frame host (the ring shows the target), so the app's focus and the page's never take turns.
 */
const NAV_OPTIONS = Object.freeze({ scopeSelector: '[role=dialog]', domFocus: false });

/** Is this the Drops Inventory page (www.twitch.tv/drops/inventory)? */
function isInventoryUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && /^(www\.)?twitch\.tv$/.test(u.hostname) && /^\/drops\/inventory\/?$/.test(u.pathname);
}

/** Any twitch.tv Drops page (the inventory frame may move to /drops/campaigns inside the page, without a reload). */
function isDropsPageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && /^(www\.)?twitch\.tv$/.test(u.hostname) && /^\/drops(\/|$)/.test(u.pathname);
}

/**
 * Is this webRequest (onHeadersReceived details) the Drops section's own frame: a sub-frame of Lurkbox's window whose
 * parent is the window's top frame showing Lurkbox's page (pageUrl), not a frame nested deeper inside another site?
 */
function isAppDropsFrame(d, { webContentsId, pageUrl }) {
  if (!d || d.resourceType !== 'subFrame' || d.webContentsId !== webContentsId) return false;
  let parent = null;
  try { parent = d.frame && d.frame.parent; } catch { return false; }
  if (!parent || parent.parent) return false;
  try { return String(parent.url).startsWith(pageUrl); } catch { return false; }
}

/**
 * Response headers for the inventory page in the Drops view's iframe: twitch.tv refuses framing (X-Frame-Options,
 * CSP frame-ancestors), so those two are removed for this page only; every other header is kept as is.
 */
function allowFraming(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === 'x-frame-options') continue;
    if (key === 'content-security-policy') {
      const list = (Array.isArray(v) ? v : [v]).map((p) => String(p).split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')).filter((p) => p.trim());
      if (list.length) out[k] = list;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** A drop name for logs and toasts: one line, no URLs or long digit runs (IDs), at most 80 characters. */
function cleanName(name) {
  return String(name || '').replace(/https?:\/\/\S+/g, '').replace(/\b\d{6,}\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'a drop';
}

/**
 * Source of the function run inside the inventory page. Resolves
 *   { state: 'loading' | 'signed-out' | 'ready', campaigns: [{ game, name, drops: [{ name, percent, claimable }] }],
 *     claimed: [{ name, confirmed }] }.
 * With claim, clicks at most maxClaims enabled Claim buttons, gapMs apart, and reports whether each one went away
 * (or turned disabled / "Claimed") afterwards.
 */
function scanSource({ claim = false, maxClaims = 5, gapMs = 1500 } = {}) {
  return `(async () => {
    const S = ${JSON.stringify(SELECTORS)};
    const CLAIM_TEXT = ${CLAIM_TEXT.toString()};
    const q = (list, root = document) => { for (const s of list) { try { const n = root.querySelector(s); if (n) return n; } catch (e) {} } return null; };
    const qa = (list, root = document) => { const out = []; for (const s of list) { try { root.querySelectorAll(s).forEach((n) => { if (!out.includes(n)) out.push(n); }); } catch (e) {} } return out; };
    const text = (n) => (n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : '');
    const shown = (n) => { const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const root = q(S.root);
    if (/^\\/login/.test(location.pathname) || (!document.querySelector(S.root[0]) && q(S.signedOut) && !qa(S.progress).length)) return { state: 'signed-out', campaigns: [], claimed: [] };
    if (!root || document.readyState !== 'complete' || qa(S.loading, root).some(shown)) return { state: 'loading', campaigns: [], claimed: [] };
    const isClaim = (b) => {
      if (!b || b.tagName !== 'BUTTON' || b.disabled || b.getAttribute('aria-disabled') === 'true' || !shown(b)) return false;
      const t = text(b);
      if (/claimed/i.test(t)) return false;
      return CLAIM_TEXT.test(t) || S.claim.some((s) => { try { return b.matches(s); } catch (e) { return false; } });
    };
    const claimButtons = () => Array.from(root.querySelectorAll('button')).filter(isClaim);
    // One drop's tile: the nearest ancestor (at most 6 up) with a picture or a name, but not a whole campaign card.
    const tileOf = (n) => {
      let best = n.parentElement;
      for (let p = n.parentElement, i = 0; p && p !== root && i < 6; p = p.parentElement, i++) {
        if (q(S.campaignInfo, p) || p.matches(S.campaignInfo.join(','))) break;
        best = p;
        if (p.querySelector('img[alt], p, h3, h4')) break;
      }
      return best;
    };
    const dropName = (tile, skip) => {
      const img = tile.querySelector('img[alt]');
      if (img && img.alt.trim()) return img.alt.trim();
      for (const n of tile.querySelectorAll('p, h3, h4, span')) {
        if (skip && skip.contains(n)) continue;
        const t = text(n);
        if (t && !/%|^\\d+\\s*(of|\\/)|claim|minute|hour/i.test(t)) return t;
      }
      return '';
    };
    const percentOf = (bar) => {
      const v = Number(bar.getAttribute('aria-valuenow'));
      const max = Number(bar.getAttribute('aria-valuemax')) || 100;
      if (Number.isFinite(v) && bar.hasAttribute('aria-valuenow')) return Math.round((v / max) * 100);
      const w = /([\\d.]+)%/.exec(bar.getAttribute('style') || '') || /([\\d.]+)%/.exec(text(bar.parentElement));
      return w ? Math.round(Number(w[1])) : null;
    };
    // Campaign cards: from each campaign header, the nearest ancestor that also holds its drops.
    const campaigns = [];
    for (const info of qa(S.campaignInfo, root)) {
      let card = info.parentElement;
      for (let i = 0; card && card !== root && i < 4 && !qa(S.progress, card).length && !card.querySelector('button'); i++) card = card.parentElement;
      if (!card || card === root) card = info.parentElement;
      const g = q(S.game, info);
      const game = g ? (g.tagName === 'IMG' ? g.alt : (text(g) || (g.querySelector('img[alt]') || {}).alt || '')).trim() : '';
      const title = Array.from(info.querySelectorAll('p, h3, h4, a')).map(text).find((t) => t && t !== game) || '';
      const drops = [];
      const tiles = [];
      const buttons = claimButtons().filter((b) => card.contains(b));
      for (const bar of qa(S.progress, card)) {
        const tile = tileOf(bar);
        tiles.push(tile);
        drops.push({ name: dropName(tile, bar).slice(0, 120), percent: percentOf(bar), claimable: buttons.some((b) => tile.contains(b)) });
      }
      for (const b of buttons) {
        if (tiles.some((t) => t.contains(b))) continue;
        drops.push({ name: dropName(tileOf(b), b).slice(0, 120), percent: 100, claimable: true });
      }
      campaigns.push({ game: game.slice(0, 120), name: title.slice(0, 160), drops });
    }
    const claimed = [];
    if (${claim ? 'true' : 'false'}) {
      for (let i = 0; i < ${Math.max(0, Math.min(20, Number(maxClaims) || 0))}; i++) {
        const b = claimButtons()[0];
        if (!b) break;
        const name = dropName(tileOf(b), b);
        b.click();
        await new Promise((r) => setTimeout(r, ${Math.max(0, Number(gapMs) || 0)}));
        const confirmed = !b.isConnected || b.disabled || /claimed/i.test(text(b)) || !isClaim(b);
        claimed.push({ name: name.slice(0, 120), confirmed });
        if (!confirmed) break; // the page did not take it; don't keep clicking
      }
    }
    return { state: 'ready', campaigns, claimed };
  })()`;
}

const MIN = 60 * 1000;

/**
 * The auto-claim loop. Inert while the setting is off or there is no twitch.tv session (run() is never called then).
 * Checks once firstDelayMs after start(), then every intervalMs; never twice within minGapMs; after an error the delay
 * doubles per failure up to maxBackoffMs.
 */
class DropsClaimer {
  /**
   * @param {object} d
   * @param {() => boolean} d.enabled             Settings → Auto-claim drops
   * @param {() => Promise<boolean>} d.hasSession  a twitch.tv web session exists
   * @param {() => Promise<{state: string, campaigns: object[], claimed: {name: string, confirmed: boolean}[]}>} d.run
   * @param {(name: string) => void} [d.onClaim]
   * @param {(campaigns: object[]) => void} [d.onProgress]
   * @param {(line: string) => void} [d.log]
   */
  constructor({ enabled, hasSession, run, onClaim = () => {}, onProgress = () => {}, log = () => {}, now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    firstDelayMs = MIN, intervalMs = 15 * MIN, minGapMs = 5 * MIN, maxBackoffMs = 4 * 60 * MIN }) {
    Object.assign(this, { enabled, hasSession, run, onClaim, onProgress, log, now, setTimer, clearTimer, firstDelayMs, intervalMs, minGapMs, maxBackoffMs });
    this.timer = null;
    this.failures = 0;
    this.lastRunAt = null;
    this.running = false;
    this.nextAt = null;
    this.lastNote = '';
  }

  start() { this.schedule(this.firstDelayMs); return this; }

  stop() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.nextAt = null; }

  schedule(ms) {
    if (this.timer) this.clearTimer(this.timer);
    this.nextAt = this.now() + ms;
    this.timer = this.setTimer(() => { this.timer = null; this.tick().catch(() => {}); }, ms);
  }

  note(line) { if (line !== this.lastNote) { this.lastNote = line; this.log(line); } }

  /** One check. Resolves what happened: { skipped } or { ok, claimed } or { error }. */
  async tick() {
    if (this.running) return { skipped: 'busy' };
    if (!this.enabled()) { this.schedule(this.intervalMs); return { skipped: 'off' }; }
    let session = false;
    try { session = await this.hasSession(); } catch { session = false; }
    if (!session) { this.note('[drops] no twitch.tv session; auto-claim inactive (sign in on the TV to use it)'); this.schedule(this.intervalMs); return { skipped: 'no-session' }; }
    const since = this.lastRunAt == null ? Infinity : this.now() - this.lastRunAt;
    if (since < this.minGapMs) { this.schedule(this.minGapMs - since); return { skipped: 'rate' }; }
    this.running = true;
    this.lastRunAt = this.now();
    try {
      const r = await this.run();
      if (!r || r.state !== 'ready') throw new Error(r && r.state === 'signed-out' ? 'the inventory page shows the sign-in wall' : 'the inventory page did not load');
      this.failures = 0;
      const claimed = [];
      for (const c of r.claimed || []) {
        const name = cleanName(c.name);
        if (c.confirmed) { claimed.push(name); this.log(`[drops] claimed ${name}`); this.onClaim(name); }
        else this.log(`[drops] clicked Claim for ${name}, but the page did not confirm it`);
      }
      this.onProgress(r.campaigns || []);
      const open = (r.campaigns || []).reduce((n, c) => n + (c.drops || []).filter((d) => !d.claimable && (d.percent == null || d.percent < 100)).length, 0);
      this.note(`[drops] checked: ${(r.campaigns || []).length} campaign(s), ${open} drop(s) in progress`);
      this.schedule(this.intervalMs);
      return { ok: true, claimed };
    } catch (e) {
      this.failures += 1;
      const delay = Math.min(this.maxBackoffMs, this.intervalMs * 2 ** this.failures);
      this.log(`[drops] check failed (${e.message}); next try in ${Math.round(delay / MIN)} min`);
      this.schedule(delay);
      return { error: e.message };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { INVENTORY_URL, SELECTORS, CLAIM_TEXT, NAV_OPTIONS, isInventoryUrl, isDropsPageUrl, isAppDropsFrame, allowFraming, cleanName, scanSource, DropsClaimer };
