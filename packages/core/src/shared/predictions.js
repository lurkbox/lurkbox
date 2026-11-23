// Predictions and polls of the watched channel, shown in the player with live updates and acted on with the controller.
// Shared by the hosts (the desktop main process and the Android platform layer) and the page (the pure view helpers).
//
// Reading: Twitch's web GQL (the public web client ID, the same transport as the direct engine), one query for the
// channel's active, locked and latest resolved prediction and its viewable poll. It works signed out; with the twitch.tv
// session the host adds the auth-token natively (the page never sees it), and the answer includes your own bet. Polled
// every few seconds while something is open, slower otherwise; the points frame's scan of the pinned highlight kicks it
// at once.
// Acting: Twitch's own buttons in the channel's embedded chat page (the points frame, like channel-point rewards):
// predictSource() opens the prediction, switches to a custom amount, types it and presses the outcome's Vote button;
// pollVoteSource() presses the choice. Nothing is sent through GQL on the user's behalf. The selectors follow twitch.tv's
// DOM as far as it is known (2026-11) with text fallbacks; they need checking on a signed-in session.
// ES module; the desktop main process loads it with require().

import { GQL_URL, WEB_CLIENT_ID } from './direct.js';

export const PP_OPERATION = 'LurkboxPredictionsPolls';
/** The one query (also allow-listed verbatim by Android's native webGql, which adds the session). */
export const PP_QUERY = 'query LurkboxPredictionsPolls($login: String!) { channel(name: $login) { id activePredictionEvents { ...LbPrediction } lockedPredictionEvents { ...LbPrediction } resolvedPredictionEvents(first: 1) { edges { node { ...LbPrediction } } } } user(login: $login) { viewablePoll { id title status durationSeconds remainingDurationMilliseconds startedAt endedAt choices { id title votes { total base communityPoints bits } } votes { total base communityPoints bits } settings { communityPointsVotes { isEnabled cost } multichoice { isEnabled } } } } } fragment LbPrediction on PredictionEvent { id title status createdAt predictionWindowSeconds lockedAt endedAt winningOutcome { id } outcomes { id title color totalPoints totalUsers } self { prediction { id points outcome { id } result } } }';

const LOGIN = /^[a-z0-9_]{1,25}$/i;
/** How long a resolved prediction or an ended poll still shows its result (after its end). */
export const RESULT_MS = 45000;
/** Twitch's largest prediction per user and event (the default; channels can lower it). */
export const MAX_BET = 250000;

/** The GQL request body for a channel, or null for a bad login. */
export function ppBody(login) {
  if (!LOGIN.test(String(login || ''))) return null;
  return JSON.stringify({ operationName: PP_OPERATION, query: PP_QUERY, variables: { login: String(login).toLowerCase() } });
}

/**
 * The query for a channel through `fetch`; authToken: the twitch.tv auth-token (desktop) or a placeholder a native layer
 * replaces (Android's SESSION_TOKEN), for your own bet. A refused signed-in request is retried signed out. Resolves the JSON.
 */
export async function ppQuery({ fetch, login, authToken = null }) {
  const body = ppBody(login);
  if (!body) throw new Error('bad login');
  const ask = async (token) => {
    const headers = { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
    if (token) headers.Authorization = `OAuth ${token}`;
    const r = await fetch(GQL_URL, { method: 'POST', headers, body });
    if (!r.ok) throw Object.assign(new Error(`GQL HTTP ${r.status}`), { status: r.status });
    return r.json();
  };
  if (authToken) {
    try { return await ask(authToken); } catch (e) { if (e.status !== 401 && e.status !== 403) throw e; }
  }
  return ask(null);
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const time = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** One prediction event from GQL → the shape the page shows. */
export function parsePrediction(e) {
  if (!e || typeof e !== 'object' || !e.id) return null;
  const outcomes = (Array.isArray(e.outcomes) ? e.outcomes : []).slice(0, 10).map((o) => ({
    id: str(o && o.id, 64), title: str(o && o.title, 100), color: str(o && o.color, 16).toLowerCase() || 'blue',
    points: num(o && o.totalPoints), users: num(o && o.totalUsers),
  })).filter((o) => o.id);
  if (!outcomes.length) return null;
  const total = outcomes.reduce((s, o) => s + o.points, 0);
  const users = outcomes.reduce((s, o) => s + o.users, 0);
  const winner = e.winningOutcome && e.winningOutcome.id ? String(e.winningOutcome.id) : null;
  for (const o of outcomes) {
    o.percent = total ? Math.round((100 * o.points) / total) : 0;
    o.ratio = o.points ? Math.round((100 * total) / o.points) / 100 : null; // Twitch's "1:x" return
    o.winner = !!winner && o.id === winner;
  }
  const status = { ACTIVE: 'active', LOCKED: 'locked', RESOLVE_PENDING: 'locked', RESOLVED: 'resolved', CANCELED: 'canceled', CANCEL_PENDING: 'canceled' }[String(e.status)] || 'locked';
  const created = time(e.createdAt);
  const self = e.self && e.self.prediction;
  return {
    kind: 'prediction', id: String(e.id).slice(0, 64), title: str(e.title, 120), status,
    endsAt: created && num(e.predictionWindowSeconds) ? created + num(e.predictionWindowSeconds) * 1000 : null,
    lockedAt: time(e.lockedAt), endedAt: time(e.endedAt), winner, outcomes, total, users,
    mine: self && self.outcome ? { outcomeId: String(self.outcome.id), points: num(self.points), result: str(self.result, 20) || null } : null,
  };
}

/** The viewable poll from GQL → the shape the page shows. */
export function parsePoll(p, now = Date.now()) {
  if (!p || typeof p !== 'object' || !p.id) return null;
  const choices = (Array.isArray(p.choices) ? p.choices : []).slice(0, 10).map((c) => ({
    id: str(c && c.id, 64), title: str(c && c.title, 100), votes: num(c && c.votes && c.votes.total),
  })).filter((c) => c.id);
  if (!choices.length) return null;
  const total = num(p.votes && p.votes.total) || choices.reduce((s, c) => s + c.votes, 0);
  const top = Math.max(...choices.map((c) => c.votes));
  for (const c of choices) { c.percent = total ? Math.round((100 * c.votes) / total) : 0; c.top = total > 0 && c.votes === top; }
  const status = String(p.status) === 'ACTIVE' ? 'active' : String(p.status) === 'ARCHIVED' ? 'archived' : 'ended';
  const left = Number(p.remainingDurationMilliseconds);
  const cp = p.settings && p.settings.communityPointsVotes;
  return {
    kind: 'poll', id: String(p.id).slice(0, 64), title: str(p.title, 120), status,
    endsAt: status === 'active' && Number.isFinite(left) ? now + Math.max(0, left) : null,
    endedAt: time(p.endedAt), choices, total,
    pointsVotes: cp && cp.isEnabled ? { cost: num(cp.cost) } : null,
  };
}

/**
 * The GQL answer → { prediction, poll } to show (either may be null): the active or locked prediction, else the latest
 * resolved/canceled one while its result is fresh (RESULT_MS); the active poll, or an ended one while fresh.
 */
export function parsePredictionsPolls(json, now = Date.now()) {
  const d = (json && json.data) || {};
  const ch = d.channel || {};
  const pick = (list) => (Array.isArray(list) ? list.map(parsePrediction).find(Boolean) : null) || null;
  let prediction = pick(ch.activePredictionEvents) || pick(ch.lockedPredictionEvents);
  if (!prediction) {
    const edges = ch.resolvedPredictionEvents && Array.isArray(ch.resolvedPredictionEvents.edges) ? ch.resolvedPredictionEvents.edges : [];
    const last = edges.length ? parsePrediction(edges[0] && edges[0].node) : null;
    if (last && last.endedAt && now - last.endedAt < RESULT_MS) prediction = last;
  }
  let poll = parsePoll(d.user && d.user.viewablePoll, now);
  if (poll && (poll.status === 'archived' || (poll.status === 'ended' && !(poll.endedAt && now - poll.endedAt < RESULT_MS)))) poll = null;
  return { prediction, poll };
}

/**
 * Polls a channel's predictions and polls for the host and reports changes.
 * @param {object} o
 * @param {(login: string) => Promise<object>} o.query  the GQL answer (JSON) for ppBody(login)
 * @param {(state: { login, prediction, poll }) => void} o.onState  on every change (and null/null when it ends)
 */
export class PredictionsWatcher {
  constructor({ query, onState = () => {}, log = () => {}, now = () => Date.now(), setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, fastMs = 3000, slowMs = 15000, errorMs = 30000 }) {
    Object.assign(this, { query, onState, log, now, later, cancel, fastMs, slowMs, errorMs });
    this.login = null;
    this.timer = null;
    this.last = '';
    this.state = { login: null, prediction: null, poll: null };
    this.running = null;
    this.errors = 0;
  }

  watch(login) {
    const l = login && LOGIN.test(String(login)) ? String(login).toLowerCase() : null;
    if (l === this.login) return;
    this.login = l;
    this.cancel(this.timer);
    this.timer = null;
    this.errors = 0;
    this.set({ login: l, prediction: null, poll: null });
    if (l) this.kick();
  }

  /** Ask now (the frame's scan saw a new highlight; after a bet or vote). */
  kick() {
    if (!this.login) return Promise.resolve(this.state);
    this.cancel(this.timer);
    this.timer = null;
    if (!this.running) this.running = this.run().finally(() => { this.running = null; this.schedule(); });
    return this.running;
  }

  schedule() {
    if (!this.login) return;
    this.cancel(this.timer);
    const busy = this.state.prediction || this.state.poll;
    const ms = this.errors ? Math.min(this.errorMs * this.errors, 5 * 60000) : busy ? this.fastMs : this.slowMs;
    this.timer = this.later(() => { this.timer = null; this.kick(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  async run() {
    const l = this.login;
    try {
      const json = await this.query(l);
      if (l !== this.login) return this.state;
      if (json && Array.isArray(json.errors) && json.errors.length && !json.data) throw new Error(String(json.errors[0].message || 'GQL error').slice(0, 120));
      const { prediction, poll } = parsePredictionsPolls(json, this.now());
      if (this.errors) this.log(`[predictions] ${l}: answering again`);
      this.errors = 0;
      this.set({ login: l, prediction, poll });
    } catch (e) {
      if (l !== this.login) return this.state;
      if (!this.errors) this.log(`[predictions] ${l}: query failed (${e.message})`);
      this.errors++;
    }
    return this.state;
  }

  set(st) {
    const key = JSON.stringify(st);
    this.state = st;
    if (key === this.last) return;
    const before = this.last ? JSON.parse(this.last) : {};
    this.last = key;
    for (const k of ['prediction', 'poll']) {
      const was = before[k];
      const is = st[k];
      if (is && (!was || was.id !== is.id || was.status !== is.status)) this.log(`[predictions] ${st.login}: ${k} ${is.status}`);
    }
    try { this.onState({ ...st }); } catch (e) { this.log(`[predictions] listener failed: ${e.message}`); }
  }

  stop() { this.watch(null); }
}

// ---- the page's view helpers (pure) ----

/** 1234 → "1,234"; 12345 → "12.3K"; 1234567 → "1.2M". */
export function fmtPoints(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('en-US');
}

/** Seconds left as "1:05", or '' without an end. */
export function fmtLeft(endsAt, now = Date.now()) {
  if (!endsAt) return '';
  const s = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The status line of a prediction. */
export function predictionStatus(p, now = Date.now()) {
  if (!p) return '';
  if (p.status === 'active') {
    const left = fmtLeft(p.endsAt, now);
    return left && left !== '0:00' ? `Predictions close in ${left}` : 'Predictions closing…';
  }
  if (p.status === 'locked') return 'Predictions are locked: waiting for the result';
  if (p.status === 'canceled') return 'Canceled: points were refunded';
  const w = p.outcomes.find((o) => o.winner);
  return w ? `Result: ${w.title}` : 'Result';
}

/** The line about your own bet, or ''. */
export function myBetLine(p) {
  if (!p || !p.mine) return '';
  const o = p.outcomes.find((x) => x.id === p.mine.outcomeId);
  const on = o ? ` on ${o.title}` : '';
  if (p.status === 'resolved') {
    if (o && o.winner) return `You won ${fmtPoints(Math.floor(p.mine.points * (o.ratio || 1)))} points (bet ${fmtPoints(p.mine.points)}${on})`;
    return `You lost ${fmtPoints(p.mine.points)} points${on}`;
  }
  if (p.status === 'canceled') return `Your ${fmtPoints(p.mine.points)} points came back`;
  return `Your prediction: ${fmtPoints(p.mine.points)} points${on}`;
}

/** The status line of a poll. */
export function pollStatus(p, now = Date.now()) {
  if (!p) return '';
  const votes = `${p.total.toLocaleString('en-US')} vote${p.total === 1 ? '' : 's'}`;
  if (p.status === 'active') {
    const left = fmtLeft(p.endsAt, now);
    return left ? `Poll ends in ${left} · ${votes}` : votes;
  }
  const top = p.choices.filter((c) => c.top);
  return top.length === 1 ? `Poll ended: ${top[0].title} · ${votes}` : `Poll ended · ${votes}`;
}

/** Can the user bet on this outcome now? Twitch allows adding to your outcome, never switching. */
export function canBetOn(p, outcomeId) {
  if (!p || p.status !== 'active') return false;
  if (p.endsAt && p.endsAt <= Date.now()) return false;
  return !p.mine || p.mine.outcomeId === outcomeId;
}

/** The points you would get back if this outcome wins with an extra `points` on it (Twitch's pari-mutuel payout). */
export function payout(p, outcomeId, points) {
  const o = p && p.outcomes.find((x) => x.id === outcomeId);
  if (!o || !(points > 0)) return 0;
  return Math.floor((points * (p.total + points)) / (o.points + points));
}

/** The amount chooser's presets for a balance: fixed amounts and shares of the balance, ascending, at most MAX_BET. */
export function betPresets(balance, max = MAX_BET) {
  const cap = Math.min(Math.max(0, Math.floor(Number(balance) || 0)), max);
  if (cap < 1) return [];
  const out = new Set([10, 100, 500, 1000, 5000, 10000].filter((v) => v <= cap));
  for (const f of [0.25, 0.5]) { const v = Math.floor(cap * f); if (v >= 1) out.add(v); }
  out.add(cap); // All (or the cap)
  return [...out].sort((a, b) => a - b);
}

/** Up/Down on the amount: the next "nice" amount (1, 2, 5 × 10^n), kept within 1..cap. */
export function stepBet(amount, dir, balance, max = MAX_BET) {
  const cap = Math.min(Math.max(0, Math.floor(Number(balance) || 0)), max);
  if (cap < 1) return 0;
  const a = Math.min(Math.max(1, Math.floor(Number(amount) || 0)), cap);
  const nice = [];
  for (let p = 1; p <= 1e6; p *= 10) for (const m of [1, 2, 5]) nice.push(m * p);
  const next = dir > 0 ? nice.find((v) => v > a) : [...nice].reverse().find((v) => v < a);
  return Math.min(Math.max(1, next || (dir > 0 ? cap : 1)), cap);
}

/** The card's compact line (the indicator while the controls are hidden). */
export function compactLine(st, now = Date.now()) {
  const p = st && st.prediction;
  const q = st && st.poll;
  if (p) return { kind: 'prediction', label: p.status === 'active' ? `Prediction · ${fmtLeft(p.endsAt, now) || 'open'}` : p.status === 'locked' ? 'Prediction · locked' : 'Prediction · result' };
  if (q) return { kind: 'poll', label: q.status === 'active' ? `Poll · ${fmtLeft(q.endsAt, now) || 'open'}` : 'Poll · result' };
  return null;
}

// ---- acting through Twitch's own buttons in the points frame ----

/** Selectors and text patterns for the prediction and poll views of the embedded chat page (with fallbacks). */
export const ACT = Object.freeze({
  predictionHighlight: ['[data-test-selector="community-prediction-highlight-header"]', '[class*="prediction-highlight"]', '[data-test-selector="predictions-highlight"]'],
  pollHighlight: ['[data-test-selector="community-poll-highlight"]', '[class*="poll-highlight"]', '[data-test-selector="poll-highlight"]'],
  customToggle: ['[data-test-selector="prediction-checkout-active-footer__input-type-toggle"]'],
  customToggleText: '^(predict with )?custom amount',
  amountInput: ['.custom-prediction-button input', 'input[type="number"]', 'input[inputmode="numeric"]'],
  voteText: '^(vote|predict)\\b',
  doneText: '(you predicted|your prediction|prediction (submitted|placed)|you have predicted|points? on )',
  pollVoteText: '(vote|channel points)',
});

/** Shared helpers inside the frame: find by selectors or text, click like a user, type into React inputs. */
const FRAME_HELPERS = `
    const A = ${JSON.stringify(ACT)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const shown = (n) => { const r = n.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(n).visibility !== 'hidden'; };
    const q = (list, root = document) => { for (const s of list) { try { for (const n of root.querySelectorAll(s)) if (shown(n)) return n; } catch (e) {} } return null; };
    const clickable = (n) => (n && (n.closest('button, [role=button], a') || n));
    const press = (n) => { const b = clickable(n); b.scrollIntoView({ block: 'nearest' }); b.click(); return b; };
    const buttons = (root = document) => [...root.querySelectorAll('button, [role=button]')].filter((b) => shown(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const byText = (re, root = document) => buttons(root).find((b) => new RegExp(re, 'i').test(norm(b.innerText || b.textContent || b.getAttribute('aria-label'))));
    const typeInto = (input, value) => {
      const proto = Object.getPrototypeOf(input);
      const set = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      input.focus();
      set.set.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const until = async (fn, ms = 4000) => { for (let t = 0; t < ms; t += 150) { const v = fn(); if (v) return v; await sleep(150); } return fn(); };
    const popover = () => q(['.reward-center__content', '[data-test-selector="reward-center-content"]', '[class*="reward-center__content"]', '[role=dialog]']);
`;

/**
 * Places a prediction through the chat page's own UI: opens the pinned prediction (or the Predictions tab), switches to
 * a custom amount, types `points` into the outcome's box (by its position, checked against its title when the page
 * shows titles) and presses that outcome's Vote button. Resolves { ok, reason?, step }.
 */
export function predictSource({ outcomeIndex, outcomeTitle, points }) {
  const idx = Math.max(0, Math.floor(Number(outcomeIndex) || 0));
  const amount = Math.max(1, Math.floor(Number(points) || 0));
  return `(async () => {
    ${FRAME_HELPERS}
    const title = norm(${JSON.stringify(String(outcomeTitle || ''))});
    // 1. The prediction's view: the pinned highlight, else the rewards popover's Predictions tab.
    let inputs = () => [...(popover() || document).querySelectorAll(A.amountInput.join(','))].filter(shown);
    if (!inputs().length && !byText(A.customToggleText, popover() || document)) {
      const h = q(A.predictionHighlight);
      if (h) press(h);
      else {
        const tab = byText('^predictions?$');
        if (!tab) return { ok: false, reason: 'no prediction in the chat page', step: 'open' };
        press(tab);
      }
      await until(() => inputs().length || byText(A.customToggleText, popover() || document), 5000);
    }
    // 2. A custom amount (Twitch shows fixed amounts first).
    if (!inputs().length) {
      const t = q(A.customToggle) || byText(A.customToggleText, popover() || document);
      if (!t) return { ok: false, reason: 'no custom amount in the prediction view', step: 'custom' };
      press(t);
      await until(() => inputs().length, 4000);
    }
    const list = inputs();
    if (list.length <= ${idx}) return { ok: false, reason: 'outcome not found', step: 'outcome', inputs: list.length };
    const input = list[${idx}];
    // The outcome's box: its column, from the input up to the block that holds one Vote button.
    let box = input;
    while (box.parentElement && box.parentElement !== document.body && buttons(box.parentElement).filter((b) => new RegExp(A.voteText, 'i').test(norm(b.innerText || b.textContent))).length <= 1) box = box.parentElement;
    if (title && norm(box.innerText).length && !norm(box.innerText).includes(title) && list.length > 1) {
      const other = list.find((i) => { let b = i; for (let k = 0; k < 6 && b.parentElement; k++) b = b.parentElement; return norm(b.innerText).includes(title); });
      if (other && other !== input) return { ok: false, reason: 'outcomes are in another order than expected', step: 'outcome' };
    }
    typeInto(input, ${amount});
    await sleep(250);
    const vote = buttons(box).find((b) => new RegExp(A.voteText, 'i').test(norm(b.innerText || b.textContent || b.getAttribute('aria-label'))));
    if (!vote) return { ok: false, reason: 'no Vote button for the outcome', step: 'vote' };
    if (vote.disabled) return { ok: false, reason: 'Twitch did not accept the amount', step: 'vote' };
    press(vote);
    const done = await until(() => new RegExp(A.doneText, 'i').test(norm((popover() || document.body).innerText)) || !input.isConnected, 5000);
    return done ? { ok: true, step: 'done' } : { ok: false, reason: 'no confirmation from Twitch', step: 'confirm' };
  })()`;
}

/**
 * Votes in the poll through the chat page's own UI: opens the pinned poll and presses the choice's button (found by its
 * title, else its position); withPoints presses its "vote with channel points" button instead. Resolves { ok, reason?, step }.
 */
export function pollVoteSource({ choiceIndex, choiceTitle, withPoints = false }) {
  const idx = Math.max(0, Math.floor(Number(choiceIndex) || 0));
  return `(async () => {
    ${FRAME_HELPERS}
    const title = norm(${JSON.stringify(String(choiceTitle || ''))});
    const h = q(A.pollHighlight);
    const area = () => (h && (h.closest('[class*="highlight"]') || h.parentElement)) || popover() || document;
    const choices = () => buttons(area()).filter((b) => !/^(close|dismiss|hide|collapse|expand|details|see details|minimize)/.test(norm(b.innerText || b.getAttribute('aria-label'))));
    if (h && choices().length < 2) { press(h); await until(() => choices().length >= 2, 4000); }
    const list = choices();
    if (list.length < 2) return { ok: false, reason: 'no poll choices in the chat page', step: 'open' };
    let b = list.find((x) => norm(x.innerText || x.getAttribute('aria-label')).startsWith(title)) || null;
    if (${withPoints ? 'true' : 'false'}) {
      const named = list.filter((x) => norm(x.innerText || x.getAttribute('aria-label')).includes(title));
      b = named.find((x) => new RegExp(A.pollVoteText, 'i').test(norm(x.innerText || x.getAttribute('aria-label'))) && x !== named[0]) || null;
      if (!b) return { ok: false, reason: 'no channel-points vote button', step: 'points' };
    }
    if (!b) b = list[${idx}] || null;
    if (!b) return { ok: false, reason: 'choice not found', step: 'choice' };
    const before = norm(area().innerText);
    press(b);
    const changed = await until(() => norm(area().innerText) !== before, 3000);
    return changed ? { ok: true, step: 'done' } : { ok: false, reason: 'no change in the poll after the vote', step: 'confirm' };
  })()`;
}
