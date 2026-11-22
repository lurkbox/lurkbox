'use strict';
// Channel points through Twitch's own embedded chat page (twitch.tv/embed/<channel>/chat), signed in with the user's
// twitch.tv web session. The renderer hosts the iframe; this module scans it from the main process
// (webFrameMain.executeJavaScript): auto-claims the bonus chest, reads the balance and notices predictions and polls.
// Only Twitch's own buttons are clicked; nothing is called on the user's behalf beyond what the page itself offers.
//
// The selectors follow twitch.tv's DOM (2026-11) and have fallbacks; they need checking on a signed-in session.

const SELECTORS = Object.freeze({
  summary: ['[data-test-selector="community-points-summary"]', '.community-points-summary'],
  claim: [
    '[data-test-selector="community-points-summary"] button[aria-label="Claim Bonus"]',
    'button[aria-label="Claim Bonus"]',
    '.claimable-bonus__icon',
    '[data-test-selector="community-points-summary"] [class*="claimable-bonus"] button',
  ],
  // Seen on the live page (2026-11-21): community-points-summary > copo-balance-string (and bits-balance-string).
  balance: [
    '[data-test-selector="community-points-summary"] [data-test-selector="copo-balance-string"]',
    '[data-test-selector="copo-balance-string"]',
    '[data-test-selector="community-points-summary"] [data-test-selector="balance-string"]',
  ],
  // The pinned "highlight" at the top of chat: predictions, polls, hype trains.
  prediction: ['[data-test-selector="community-prediction-highlight-header"]', '[class*="prediction-highlight"]', '[data-test-selector="predictions-highlight"]'],
  poll: ['[data-test-selector="community-poll-highlight"]', '[class*="poll-highlight"]', '[data-test-selector="poll-highlight"]'],
  // "Bits and Points Balances" (seen 2026-11-21).
  // Tried in order; the last ones find the button from the balance text or its label anywhere in the chat input area.
  rewardsButton: [
    '[data-test-selector="community-points-summary"] button[aria-label*="Points" i]',
    '[data-test-selector="community-points-summary"] button',
    '[data-test-selector="community-points-summary"] [role=button]',
    'BALANCE_BUTTON', // the button around the balance string
    '.chat-input button[aria-label*="Points" i]',
    'button[aria-label*="Bits and Points" i]',
  ],
  // The "Power-ups & Rewards" popover the balance button opens (and the prediction/poll details, same balloon).
  rewardsPopover: ['.reward-center__content', '[data-test-selector="reward-center-content"]', '[class*="reward-center__content"]', '.reward-center-body'],
  signedOut: ['[data-a-target="chat-welcome-message"] a[href*="login"]', 'button[data-a-target="login-button"]', '[data-test-selector="chat-input-signup-button"]'],
});

/** frame-nav options in the rewards view: stay in the popover; without one, the pinned prediction/poll and the balance. */
// Without the popover (the pinned prediction, or a reward that needs a message: Twitch closes the popover and shows its
// chat input with the reward above it), the targets are the highlights and the chat input area (the editor, the reward
// chip's buttons, the balance and the "Chat" button).
const NAV_OPTIONS = Object.freeze({
  scopeSelector: '[role=dialog], .reward-center__content',
  fallbackSelector: '.community-highlight-stack, [class*="community-highlight"], .chat-input, [data-test-selector="community-points-summary"]',
});

/** "1,234" → 1234, "12.3K" → 12300, "1.2M" → 1200000, "12,3 k" → 12300. NaN when there is no number. */
function parseBalance(text) {
  const t = String(text || '').trim().replace(/ /g, ' ');
  const m = /(\d[\d.,\s]*)\s*([KkMm])?/.exec(t);
  if (!m) return NaN;
  let num = m[1].replace(/\s/g, '');
  const suffix = m[2] ? m[2].toLowerCase() : '';
  if (suffix) num = num.replace(',', '.'); // "12,3K" (decimal comma) or "12.3K"
  else num = num.replace(/[.,](?=\d{3}(\D|$))/g, ''); // thousands separators
  const n = Number(num);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1));
}

/**
 * Source of the function run inside the chat frame. Returns
 * { signedIn, balanceText, claimed, prediction, poll } (strings or null). Clicks the bonus button when autoClaim.
 */
function scanSource({ autoClaim }) {
  return `(() => {
    const S = ${JSON.stringify(SELECTORS)};
    const q = (list) => { for (const s of list) { try { const n = document.querySelector(s); if (n) return n; } catch (e) {} } return null; };
    const text = (n) => (n ? (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null);
    const summary = q(S.summary);
    // authCookie: whether the frame's scripts see an auth-token cookie at all (its name only; never the value). False with
    // a signed-in session means the cookie isn't SameSite=None, so the third-party frame doesn't get it.
    let authCookie = null;
    try { authCookie = /(^|;\\s*)auth-token=/.test(document.cookie); } catch (e) { /* no access */ }
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const out = { signedIn: !!summary && !q(S.signedOut), signInPrompt: !!q(S.signedOut), authCookie, vw: innerWidth, vh: innerHeight, zoom, lw: Math.round(innerWidth / zoom), balanceText: text(q(S.balance)), claimed: false, prediction: null, poll: null };
    if (${autoClaim ? 'true' : 'false'}) {
      // Only ever a real button (the wrapper around the chest stays in the page after a claim).
      let b = null;
      for (const sel of S.claim) { try { const n = document.querySelector(sel); const btn = n && n.closest('button'); if (btn && !btn.disabled) { b = btn; break; } } catch (e) {} }
      if (b) { b.click(); out.claimed = true; }
    }
    const p = q(S.prediction);
    if (p) out.prediction = text(p.closest('[class*="highlight"]') || p);
    const poll = q(S.poll);
    if (poll) out.poll = text(poll.closest('[class*="highlight"]') || poll);
    return out;
  })()`;
}

/**
 * Opens the rewards popover (the balance button; it toggles, so not when it is already open). True when it is open.
 * With detail: { opened, already, via (the selector that worked), tried: [selector: 'none' | 'error'] , summary, signedOut }
 * for the log, so a Twitch page change shows which strategies failed.
 */
function openRewardsSource({ detail = false } = {}) {
  return `(() => {
    const S = ${JSON.stringify(SELECTORS)};
    const shown = (n) => { const r = n.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const has = (list) => list.some((s) => { try { return !!document.querySelector(s); } catch (e) { return false; } });
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const out = { opened: false, already: false, via: null, tried: [], summary: has(S.summary), signedOut: has(S.signedOut), vw: innerWidth, vh: innerHeight, zoom, lw: Math.round(innerWidth / zoom) };
    const done = () => (${detail ? 'out' : 'out.opened'});
    for (const s of S.rewardsPopover) for (const n of document.querySelectorAll(s)) if (shown(n)) { out.opened = out.already = true; return done(); }
    for (const s of S.rewardsButton) {
      let n = null;
      try {
        if (s === 'BALANCE_BUTTON') {
          for (const b of S.balance) { const t = document.querySelector(b); if (t && t.closest('button, [role=button]')) { n = t.closest('button, [role=button]'); break; } }
        } else n = document.querySelector(s);
      } catch (e) { out.tried.push(s + ': error'); continue; }
      if (n) { n.click(); out.opened = true; out.via = s; return done(); }
      out.tried.push(s + ': none');
    }
    return done();
  })()`;
}

/**
 * Installs window.__lbFit in the chat frame: while it runs, the rewards popover (Twitch anchors it above the chat
 * input, with a max-height for a desktop window) fills the whole frame, and its scroll container takes all the height
 * that is left under the header. Re-applied every 400 ms (sub-views replace the popover's content); stop() undoes it.
 * Returns whether a popover is fitted right now.
 */
function fitRewardsSource() {
  return `(() => {
    if (window.__lbFit) return window.__lbFit.run();
    const SEL = ${JSON.stringify(SELECTORS.rewardsPopover)};
    const shown = (n) => { const r = n.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const changed = [];
    const set = (n, k, v) => {
      if (n.style.getPropertyValue(k) === v && n.style.getPropertyPriority(k) === 'important') return;
      if (!changed.some((c) => c[0] === n && c[1] === k)) changed.push([n, k, n.style.getPropertyValue(k), n.style.getPropertyPriority(k)]);
      n.style.setProperty(k, v, 'important');
    };
    const findRoot = () => {
      for (const s of SEL) for (const n of document.querySelectorAll(s)) {
        if (shown(n)) return n.closest('[role=dialog]') || n.closest('[class*="balloon" i]') || n;
      }
      return null;
    };
    const scroller = (root) => {
      let best = null;
      let most = -1;
      for (const n of root.querySelectorAll('*')) {
        if (!/(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY)) continue;
        if (n.scrollHeight > most) { most = n.scrollHeight; best = n; }
      }
      return best;
    };
    let root = null;
    let sc = null;
    const run = () => {
      const r = findRoot();
      if (!r) { root = null; sc = null; return false; }
      if (r !== root || !sc || !sc.isConnected || !r.contains(sc)) { root = r; sc = scroller(r); }
      // A transformed ancestor would make position: fixed relative to it instead of the frame.
      for (let p = r.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.transform !== 'none') set(p, 'transform', 'none');
        if (cs.filter !== 'none') set(p, 'filter', 'none');
        if (cs.contain !== 'none' && cs.contain !== '') set(p, 'contain', 'none');
      }
      for (const [k, v] of [['position', 'fixed'], ['inset', '0px'], ['width', 'auto'], ['height', 'auto'], ['min-width', '0px'],
        ['max-width', 'none'], ['max-height', 'none'], ['margin', '0px'], ['transform', 'none'], ['translate', 'none'],
        ['display', 'flex'], ['flex-direction', 'column'], ['z-index', '2147483000'], ['border-radius', '0px']]) set(r, k, v);
      if (!sc) { set(r, 'overflow-y', 'auto'); return true; }
      // Every box from the popover down to the scroll container grows to the frame; the rest (header, footer) keeps its
      // height.
      for (let n = sc; n && n !== r; n = n.parentElement) {
        set(n, 'flex', '1 1 auto');
        set(n, 'min-height', '0px');
        set(n, 'max-height', 'none');
        set(n, 'width', 'auto'); // Twitch gives the popover's content a desktop width: use the frame's
        set(n, 'max-width', 'none');
        set(n, 'align-self', 'stretch');
        if (n !== sc) { set(n, 'display', 'flex'); set(n, 'flex-direction', 'column'); }
        else set(n, 'height', 'auto');
        for (const sib of n.parentElement ? n.parentElement.children : []) if (sib !== n) set(sib, 'flex-shrink', '0');
      }
      return true;
    };
    const timer = setInterval(run, 400);
    window.__lbFit = {
      run,
      scroller: () => sc,
      root: () => root,
      stop: () => {
        clearInterval(timer);
        for (const [n, k, v, prio] of changed.reverse()) { if (v) n.style.setProperty(k, v, prio); else n.style.removeProperty(k); }
        delete window.__lbFit;
      },
    };
    return run();
  })()`;
}

/** Source run when the rewards view closes: Escape for Twitch's popover, then the navigation and the fit stop. */
function closeRewardsSource() {
  return "(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); if (window.__lbNav) window.__lbNav.stop(); if (window.__lbFit) window.__lbFit.stop(); return true; })()";
}

/** A prediction/poll title for the toast: drop the "Prediction"/"Poll" label and timers. */
function highlightTitle(text) {
  return String(text || '')
    .replace(/^(live\s+)?(prediction|poll)s?\s*(·|:|-)?\s*/i, '')
    .replace(/\b(\d+:)?\d+:\d\d\s*(left|remaining)?\b/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Is this frame URL Twitch's embedded chat (for this channel when given)? */
function isChatFrameUrl(url, login = null) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || !/^(www\.)?twitch\.tv$/.test(u.hostname)) return false;
  const m = /^\/embed\/([a-z0-9_]{1,25})\/chat\/?$/i.exec(u.pathname);
  return !!m && (!login || m[1].toLowerCase() === String(login).toLowerCase());
}

/**
 * Turns successive scans into events: claims (with the amount once the balance moves), balance changes, and a
 * prediction/poll that just appeared. Pure; feed it one scan at a time.
 */
class PointsTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reset(null);
  }

  reset(login) {
    this.login = login;
    this.balance = null;
    this.pendingClaim = null; // { before, at }
    this.prediction = null;
    this.poll = null;
    this.signedIn = null;
  }

  /** @returns {{ events: object[], state: { signedIn, balance, prediction, poll } }} */
  update(scan) {
    const events = [];
    if (!scan) return { events, state: this.state() };
    if (scan.signedIn !== this.signedIn) { this.signedIn = scan.signedIn; events.push({ type: 'signed-in', signedIn: scan.signedIn }); }
    const bal = parseBalance(scan.balanceText);
    if (scan.claimed) { this.pendingClaim = { before: Number.isFinite(bal) ? bal : this.balance, at: this.now() }; events.push({ type: 'claim-clicked' }); }
    if (Number.isFinite(bal) && bal !== this.balance) {
      const prev = this.balance;
      this.balance = bal;
      events.push({ type: 'balance', balance: bal, previous: prev });
      const pc = this.pendingClaim;
      if (pc && pc.before != null && bal > pc.before && this.now() - pc.at < 30000) {
        events.push({ type: 'claimed', amount: bal - pc.before, balance: bal });
        this.pendingClaim = null;
      }
    }
    if (this.pendingClaim && this.now() - this.pendingClaim.at >= 30000) {
      events.push({ type: 'claimed', amount: null, balance: this.balance });
      this.pendingClaim = null;
    }
    const pred = scan.prediction ? highlightTitle(scan.prediction) : null;
    if (pred && pred !== this.prediction) events.push({ type: 'prediction', title: pred });
    this.prediction = pred;
    const poll = scan.poll ? highlightTitle(scan.poll) : null;
    if (poll && poll !== this.poll) events.push({ type: 'poll', title: poll });
    this.poll = poll;
    return { events, state: this.state() };
  }

  state() { return { signedIn: !!this.signedIn, balance: this.balance, prediction: this.prediction, poll: this.poll }; }
}

module.exports = { SELECTORS, NAV_OPTIONS, parseBalance, scanSource, openRewardsSource, fitRewardsSource, closeRewardsSource, highlightTitle, isChatFrameUrl, PointsTracker };
