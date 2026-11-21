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
  rewardsButton: ['[data-test-selector="community-points-summary"] button[aria-label*="Points" i]', '[data-test-selector="community-points-summary"] button'],
  signedOut: ['[data-a-target="chat-welcome-message"] a[href*="login"]', 'button[data-a-target="login-button"]', '[data-test-selector="chat-input-signup-button"]'],
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
    const out = { signedIn: !!summary && !q(S.signedOut), balanceText: text(q(S.balance)), claimed: false, prediction: null, poll: null };
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

/** Opens the rewards popover (the balance button). Returns true if it clicked. */
function openRewardsSource() {
  return `(() => {
    const S = ${JSON.stringify(SELECTORS)};
    for (const s of S.rewardsButton) { const n = document.querySelector(s); if (n) { n.click(); return true; } }
    return false;
  })()`;
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

module.exports = { SELECTORS, parseBalance, scanSource, openRewardsSource, highlightTitle, isChatFrameUrl, PointsTracker };
