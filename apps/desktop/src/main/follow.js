'use strict';
// Follow and unfollow through Twitch's own channel page (www.twitch.tv/<login>), signed in with the user's twitch.tv
// web session. Twitch removed the public follow/unfollow API in 2023; like auto-claim and channel points, Lurkbox loads
// the page in a hidden window of the same session and presses the page's own button, once, for the channel the user
// chose, and only when the user pressed Follow / confirmed Unfollow in Lurkbox. No GQL calls.
//
// Selectors, checked on the live page signed out (2026-11): the channel header's button is
//   <button data-a-target="follow-button" data-test-selector="follow-button" aria-label="Follow <Name>">Follow</button>
// inside [data-target="channel-header-right"], and the header's <h1> is the display name. Signed in and following, it
// is data-a-target="unfollow-button" (aria-label "Unfollow <Name>"), and it opens a confirm dialog whose button is
// data-a-target="modal-unfollow-button". Kept tolerant: data-a-target first, then aria-label, then the text.

const LOGIN_RE = /^[a-z0-9_]{1,25}$/i;

const SELECTORS = Object.freeze({
  header: ['[data-target="channel-header-right"]', '[data-a-target="channel-header-right"]', '.channel-info-content', 'main'],
  follow: ['button[data-a-target="follow-button"]', 'button[data-test-selector="follow-button"]', 'button[aria-label^="Follow " i]', 'button[aria-label="Follow" i]'],
  unfollow: ['button[data-a-target="unfollow-button"]', 'button[data-test-selector="unfollow-button"]', 'button[aria-label^="Unfollow " i]', 'button[aria-label="Unfollow" i]'],
  confirm: ['button[data-a-target="modal-unfollow-button"]', '[role="dialog"] button[data-a-target*="unfollow" i]', '[role="dialog"] button[aria-label^="Unfollow" i]'],
  dialog: ['[role="dialog"]', '[data-a-target="tw-dialog-layer"]', '.ReactModal__Content'],
  challenge: ['iframe[src*="arkoselabs" i]', 'iframe[src*="captcha" i]', 'iframe[title*="challenge" i]', '[data-a-target*="captcha" i]', '[id*="captcha" i]', '[class*="captcha" i]', '[data-a-target*="challenge" i]'],
  signedOut: ['[data-a-target="passport-modal"]', 'button[data-a-target="login-button"]'],
  signedIn: ['[data-a-target="user-menu-toggle"]', 'button[data-a-target="user-menu-toggle"]'],
});

/** Button texts, after the data attributes and aria-labels. */
const FOLLOW_TEXT = /^\s*follow\s*$/i;
const UNFOLLOW_TEXT = /^\s*(unfollow|following)\s*$/i;
const CONFIRM_TEXT = /^\s*unfollow\s*$/i;

function validLogin(login) { return typeof login === 'string' && LOGIN_RE.test(login); }

/** The channel page for a login (only valid logins; null otherwise). */
function channelUrl(login) { return validLogin(login) ? `https://www.twitch.tv/${login.toLowerCase()}` : null; }

/**
 * Source run inside the channel page. Resolves { state, ... } where state is
 *   'loading' | 'wrong-channel' | 'signed-out' | 'challenge' | 'following' | 'not-following'
 * and, with act:
 *   'follow': clicks the Follow button only when the page says "not following";
 *   'unfollow' (with confirmed): clicks Unfollow only when the page says "following", then the dialog's Unfollow;
 * then waits up to waitMs for the button to flip and reports { clicked, flipped, state }. It never clicks the other
 * button, and never acts on a page that isn't the chosen channel's.
 */
function pageSource({ login, name = '', act = null, confirmed = false, waitMs = 8000, dialogMs = 4000 }) {
  if (!validLogin(login)) throw new Error('invalid login');
  if (act === 'unfollow' && confirmed !== true) throw new Error('unfollow needs the user\'s confirmation');
  if (act !== null && act !== 'follow' && act !== 'unfollow') throw new Error('bad action');
  return `(async () => {
    const S = ${JSON.stringify(SELECTORS)};
    const FOLLOW_TEXT = ${FOLLOW_TEXT.toString()}, UNFOLLOW_TEXT = ${UNFOLLOW_TEXT.toString()}, CONFIRM_TEXT = ${CONFIRM_TEXT.toString()};
    const LOGIN = ${JSON.stringify(login.toLowerCase())}, NAME = ${JSON.stringify(String(name || '').trim().toLowerCase())};
    const ACT = ${JSON.stringify(act)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shown = (n) => { if (!n) return false; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const all = (list, root = document) => { const out = []; for (const s of list) { try { root.querySelectorAll(s).forEach((n) => { if (!out.includes(n)) out.push(n); }); } catch (e) {} } return out; };
    const text = (n) => (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
    const usable = (b) => b && b.tagName === 'BUTTON' && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && shown(b);
    const mine = (b) => usable(b) && forChannel(b);
    // A button whose label names a channel ("Follow <Name>") must name this one.
    const forChannel = (b) => {
      const m = /^\s*(?:un)?follow\s+(.+?)\s*$/i.exec(b.getAttribute('aria-label') || '');
      if (!m) return true;
      const n = m[1].toLowerCase();
      return n === LOGIN || (!!NAME && n === NAME);
    };
    const header = () => all(S.header).find(shown) || null;
    // A button by attribute, else by its text, preferring the channel header (other channels' buttons elsewhere on
    // the page, e.g. a raid or a recommendation, are never used).
    const find = (attrs, re) => {
      const roots = [header()].filter(Boolean);
      for (const root of roots) {
        const a = all(attrs, root).find(mine);
        if (a) return a;
        const t = Array.from(root.querySelectorAll('button')).find((b) => mine(b) && re.test(text(b)));
        if (t) return t;
      }
      return null;
    };
    const challenge = () => all(S.challenge).some(shown);
    const onChannel = () => {
      const seg = (location.pathname.split('/')[1] || '').toLowerCase();
      if (location.hostname !== 'www.twitch.tv' && location.hostname !== 'twitch.tv') return false;
      if (seg !== LOGIN) return false;
      const h = Array.from(document.querySelectorAll('h1')).find(shown);
      if (h) { const t = text(h).toLowerCase(); if (t && t !== LOGIN && (!NAME || t !== NAME)) return false; }
      return true;
    };
    const state = () => {
      if (!onChannel()) return 'wrong-channel';
      if (challenge()) return 'challenge';
      if (all(S.signedOut).some(shown) && !all(S.signedIn).some(shown)) return 'signed-out';
      if (find(S.unfollow, UNFOLLOW_TEXT)) return 'following';
      if (find(S.follow, FOLLOW_TEXT)) return 'not-following';
      return 'loading';
    };
    let s = state();
    if (!ACT || s === 'loading' || s === 'wrong-channel' || s === 'challenge' || s === 'signed-out') return { state: s, clicked: false, flipped: false };
    const want = ACT === 'follow' ? 'following' : 'not-following';
    if (s === want) return { state: s, clicked: false, flipped: false, already: true };
    if (ACT === 'follow') {
      find(S.follow, FOLLOW_TEXT).click();
    } else {
      find(S.unfollow, UNFOLLOW_TEXT).click();
      // Twitch asks "Unfollow <name>?": press the dialog's Unfollow (the user already confirmed in Lurkbox).
      let c = null;
      for (let t = 0; t < ${Math.max(0, Number(dialogMs) || 0)} && !c; t += 100) {
        await sleep(100);
        if (challenge()) return { state: 'challenge', clicked: true, flipped: false };
        c = all(S.confirm).find(usable) || all(S.dialog).filter(shown).map((d) => Array.from(d.querySelectorAll('button')).find((b) => usable(b) && CONFIRM_TEXT.test(text(b)))).find(Boolean) || null;
        if (!c && state() === want) return { state: want, clicked: true, flipped: true };
      }
      if (!c) return { state: state(), clicked: true, flipped: false, reason: 'no-confirm' };
      c.click();
    }
    for (let t = 0; t < ${Math.max(0, Number(waitMs) || 0)}; t += 100) {
      await sleep(100);
      s = state();
      if (s === want) return { state: s, clicked: true, flipped: true };
      if (s === 'challenge' || s === 'signed-out' || s === 'wrong-channel') return { state: s, clicked: true, flipped: false };
    }
    return { state: s, clicked: true, flipped: false, reason: 'timeout' };
  })()`;
}

/**
 * One follow/unfollow for the channel the user chose: open the page (openPage), wait for its button, act, confirm the
 * flip. A page that never shows the button or never flips gets one retry in a fresh page; a challenge, the sign-in
 * wall or the wrong channel don't. Resolves { ok, following, already?, reason? }:
 *   reason 'no-session' | 'challenge' | 'signed-out' | 'wrong-channel' | 'timeout' | 'load' | 'invalid'.
 */
async function runFollow({ login, name, action, confirmed = false, hasSession, openPage, log = () => {},
  loadTimeoutMs = 30000, readyTimeoutMs = 15000, pollMs = 500, waitMs = 8000, retries = 1, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!validLogin(login) || (action !== 'follow' && action !== 'unfollow')) return { ok: false, reason: 'invalid' };
  if (action === 'unfollow' && confirmed !== true) return { ok: false, reason: 'invalid' };
  let session = false;
  try { session = await hasSession(); } catch { session = false; }
  if (!session) return { ok: false, reason: 'no-session' };
  const want = action === 'follow';
  let last = 'timeout';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let page = null;
    try {
      page = await openPage(channelUrl(login), loadTimeoutMs);
      let s = null;
      for (let t = 0; t <= readyTimeoutMs; t += pollMs) {
        s = await page.eval(pageSource({ login, name }));
        if (s && s.state !== 'loading') break;
        await sleep(pollMs);
      }
      if (!s || s.state === 'loading') { last = 'timeout'; log(`[follow] ${login}: the page showed no follow button (attempt ${attempt + 1})`); continue; }
      if (s.state === 'challenge' || s.state === 'signed-out' || s.state === 'wrong-channel') { log(`[follow] ${login}: ${s.state}`); return { ok: false, reason: s.state }; }
      const r = await page.eval(pageSource({ login, name, act: action, confirmed, waitMs }));
      if (r && r.already) { log(`[follow] ${login}: already ${want ? 'following' : 'not following'}`); return { ok: true, following: want, already: true }; }
      if (r && r.flipped) { log(`[follow] ${login}: ${want ? 'followed' : 'unfollowed'}`); return { ok: true, following: want }; }
      if (r && (r.state === 'challenge' || r.state === 'signed-out' || r.state === 'wrong-channel')) { log(`[follow] ${login}: ${r.state} after the click`); return { ok: false, reason: r.state }; }
      last = 'timeout';
      log(`[follow] ${login}: the button did not flip (${(r && r.reason) || 'timeout'}, attempt ${attempt + 1})`);
      // Clicked but not confirmed: a retry reloads first and acts only if the page still shows the old state.
    } catch (e) {
      last = 'load';
      log(`[follow] ${login}: ${e.message} (attempt ${attempt + 1})`);
    } finally {
      if (page) { try { page.close(); } catch { /* gone */ } }
    }
  }
  return { ok: false, reason: last };
}

module.exports = { SELECTORS, FOLLOW_TEXT, UNFOLLOW_TEXT, CONFIRM_TEXT, validLogin, channelUrl, pageSource, runFollow };
