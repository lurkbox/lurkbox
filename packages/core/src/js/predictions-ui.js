// Predictions and polls in the player (and multi-view's active tile): the host follows the channel's prediction and
// poll (window.lurkbox.predictionsWatch / onPredictionsState, shared/predictions.js) and this draws them:
//   - a compact card in the overlay (focusable; A opens it) and a small chip while the overlay is hidden;
//   - the dialog: outcomes with their share, return, points and people, your bet, the time left; A on an outcome opens
//     the amount chooser (presets, − and +, X/Y step), then a confirm step, then the host presses Twitch's own buttons;
//     the poll's choices with their share, A votes (an extra vote with channel points after a confirm, when the poll
//     allows it);
//   - results when the prediction locks or resolves (or the poll ends) until the host drops them.
// Everything updates in place as new states arrive, so the focus stays where it was.
import { el, button, toast } from './ui.js';
import { openModal, confirmDialog } from './modal.js';
import { hint, X, Y } from './input.js';
import { state, onState } from './state.js';
import {
  fmtPoints, predictionStatus, pollStatus, myBetLine, canBetOn, payout, betPresets, stepBet, compactLine,
} from '../shared/predictions.js';

/** Is the host's predictions support there? */
export const hasPredictions = () => !!(window.lurkbox && window.lurkbox.predictionsWatch && window.lurkbox.onPredictionsState);

/** Follow this channel's prediction and poll (null stops); the live player and multi-view's active tile call it. */
export function watchPredictions(login) {
  const on = state.settings.showPredictions !== false; // Settings → Player → Predictions and polls in the player
  if (hasPredictions()) window.lurkbox.predictionsWatch(on && login ? login : null).catch(() => {});
}

const COLOR = { blue: 'pp-blue', pink: 'pp-pink' };

export class PredictionsUI {
  /**
   * @param {object} o
   * @param {HTMLElement} o.chipHost   where the chip goes (shown while the controls are hidden)
   * @param {HTMLElement} [o.cardHost] where the card goes (inside the overlay), or none
   * @param {() => string|null} o.login  the channel on screen (the active tile)
   * @param {() => number|null} o.balance  the channel-points balance, if known
   * @param {(kind: string) => void} o.fallback  open Twitch's own view (the rewards view with the prediction/poll)
   * @param {() => void} [o.onChange]  the card appeared or went (the overlay may re-fit)
   */
  constructor({ chipHost, cardHost = null, login, balance = () => null, fallback = () => {}, onChange = () => {} }) {
    Object.assign(this, { login, balance, fallback, onChange });
    this.st = { login: null, prediction: null, poll: null };
    this.dialog = null;
    this.chip = el('button', { type: 'button', class: 'pp-chip', hidden: true, tabindex: '-1', 'aria-label': 'Prediction or poll', onclick: () => this.open() });
    chipHost.append(this.chip);
    this.card = cardHost ? el('button', { type: 'button', class: 'pp-card focusable po-ui', hidden: true, dataset: { focusKey: 'po-predictions' }, onclick: () => this.open() }) : null;
    if (this.card) cardHost.append(this.card);
    this.timer = null;
    if (hasPredictions()) window.lurkbox.onPredictionsState((st) => this.apply(st));
    // The setting turns the watch on or off for the channel on screen at once.
    let was = state.settings.showPredictions !== false;
    onState((what) => {
      const on = state.settings.showPredictions !== false;
      if (what !== 'settings' || on === was) return;
      was = on;
      if (this.login()) watchPredictions(this.login());
    });
  }

  /** The state for the channel on screen, or null. */
  current() {
    const l = this.login();
    return l && this.st.login === l && (this.st.prediction || this.st.poll) ? this.st : null;
  }

  has() { return !!this.current(); }

  apply(st) {
    if (!st) return;
    const before = this.has();
    this.st = st;
    this.render();
    if (this.dialog) this.dialog.update();
    if (before !== this.has()) this.onChange();
  }

  /** Redraws the chip and the card (also every second for the countdown while one shows). */
  render() {
    const cur = this.current();
    const line = cur ? compactLine(cur) : null;
    this.chip.hidden = !line;
    if (line) this.chip.replaceChildren(el('span', { class: 'pp-dot' }), line.label);
    if (this.card) {
      this.card.hidden = !cur;
      if (cur) this.card.replaceChildren(...this.cardLines(cur));
    }
    if (cur && !this.timer) this.timer = setInterval(() => this.render(), 1000);
    if (!cur && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  cardLines(cur) {
    const out = [];
    const p = cur.prediction;
    if (p) {
      out.push(el('div', { class: 'pp-card-head' }, el('span', { class: 'pp-kind' }, 'Prediction'), el('span', { class: 'pp-card-status' }, predictionStatus(p))));
      out.push(el('div', { class: 'pp-card-title' }, p.title));
      out.push(el('div', { class: 'pp-bars' }, p.outcomes.slice(0, 4).map((o) => el('div', { class: `pp-bar ${COLOR[o.color] || ''}${o.winner ? ' won' : ''}` },
        el('span', { class: 'pp-bar-fill', style: `width:${o.percent}%` }), el('span', { class: 'pp-bar-text' }, `${o.title} · ${o.percent} %`)))));
      const mine = myBetLine(p);
      if (mine) out.push(el('div', { class: 'pp-mine' }, mine));
    }
    const q = cur.poll;
    if (q) {
      out.push(el('div', { class: 'pp-card-head' }, el('span', { class: 'pp-kind' }, 'Poll'), el('span', { class: 'pp-card-status' }, pollStatus(q))));
      out.push(el('div', { class: 'pp-card-title' }, q.title));
      if (!p) out.push(el('div', { class: 'pp-bars' }, q.choices.slice(0, 4).map((c) => el('div', { class: `pp-bar${c.top && q.status !== 'active' ? ' won' : ''}` },
        el('span', { class: 'pp-bar-fill', style: `width:${c.percent}%` }), el('span', { class: 'pp-bar-text' }, `${c.title} · ${c.percent} %`)))));
    }
    out.push(hint(`{A} ${p && p.status === 'active' ? 'predict' : q && q.status === 'active' ? 'vote' : 'details'}`, 'pp-card-hint'));
    return out;
  }

  /** The dialog for the prediction (or the poll); kind picks one when both are open. */
  open(kind = null) {
    const cur = this.current();
    if (!cur) { this.fallback(kind || 'prediction'); return; }
    if (this.dialog) this.dialog.close();
    const k = kind === 'poll' && cur.poll ? 'poll' : cur.prediction ? 'prediction' : 'poll';
    this.dialog = k === 'prediction' ? this.predictionDialog() : this.pollDialog();
  }

  close() { if (this.dialog) this.dialog.close(); }

  predictionDialog() {
    const id = this.current().prediction.id;
    const status = el('div', { class: 'pp-status' });
    const mine = el('div', { class: 'pp-mine' });
    const balance = el('div', { class: 'pp-balance' });
    const rows = new Map();
    const list = el('div', { class: 'pp-outcomes' });
    const other = this.current().poll ? button('Poll', () => { m.close(); this.open('poll'); }, { dataset: { key: 'pp-to-poll' } }) : null;
    const content = el('div', { class: 'pp-dialog' }, status, list, mine, balance,
      el('div', { class: 'row pp-actions' }, other, button('Open in Twitch chat', () => { m.close(); this.fallback('prediction'); }, { dataset: { key: 'pp-twitch' } }), button('Close', () => m.close(), { dataset: { key: 'pp-close' } })));
    const update = () => {
      const cur = this.current();
      const p = cur && cur.prediction;
      if (!p || p.id !== id) { m.close(); return; }
      status.textContent = `${predictionStatus(p)} · ${fmtPoints(p.total)} points from ${p.users.toLocaleString('en-US')} ${p.users === 1 ? 'person' : 'people'}`;
      mine.textContent = myBetLine(p);
      const bal = this.balance();
      balance.textContent = bal == null ? '' : `Your balance: ${fmtPoints(bal)} points`;
      for (const o of p.outcomes) {
        let r = rows.get(o.id);
        if (!r) {
          r = { title: el('span', { class: 'pp-o-title' }), pct: el('span', { class: 'pp-o-pct' }), stats: el('span', { class: 'pp-o-stats' }), fill: el('span', { class: 'pp-bar-fill' }) };
          r.node = button([el('span', { class: 'pp-o-bar' }, r.fill), el('span', { class: 'pp-o-head' }, r.title, r.pct), r.stats], () => this.chooseAmount(o.id), { class: `pp-outcome ${COLOR[o.color] || ''}`, dataset: { key: `pp-o-${o.id}` } });
          rows.set(o.id, r);
          list.append(r.node);
        }
        r.title.textContent = `${o.winner ? '✓ ' : ''}${o.title}`;
        r.pct.textContent = `${o.percent} %`;
        r.fill.style.width = `${o.percent}%`;
        r.stats.textContent = `${fmtPoints(o.points)} points · ${o.users.toLocaleString('en-US')} ${o.users === 1 ? 'person' : 'people'}${o.ratio ? ` · 1:${o.ratio}` : ''}${p.mine && p.mine.outcomeId === o.id ? ' · your pick' : ''}`;
        r.node.classList.toggle('won', !!o.winner);
        r.node.classList.toggle('mine', !!(p.mine && p.mine.outcomeId === o.id));
        r.node.classList.toggle('closed', !canBetOn(p, o.id));
      }
    };
    const m = openModal({ title: this.current().prediction.title, class: 'pp-modal', content, focus: '.pp-outcome', onClose: () => { if (this.dialog === h) this.dialog = null; } });
    const h = { close: () => m.close(), update };
    update();
    return h;
  }

  /** A on an outcome: the amount chooser, then the confirm step, then the bet. */
  chooseAmount(outcomeId) {
    const cur = this.current();
    const p = cur && cur.prediction;
    if (!p) return;
    const o = p.outcomes.find((x) => x.id === outcomeId);
    if (!canBetOn(p, outcomeId)) {
      toast(p.status !== 'active' ? 'Predictions are closed' : 'You already predicted another outcome; Twitch only lets you add to yours', 3500, 'warn');
      return;
    }
    if (!state.auth.signedIn) { toast('Sign in to predict with channel points', 3500, 'warn'); return; }
    const bal = this.balance();
    const max = bal == null ? 250000 : bal;
    if (bal != null && bal < 1) { toast('You have no channel points here yet', 3500, 'warn'); return; }
    let amount = Math.min(max, bal == null ? 100 : Math.max(1, Math.min(100, max)));
    const big = el('div', { class: 'pp-amount', 'aria-live': 'polite' });
    const win = el('div', { class: 'pp-payout' });
    const show = () => {
      big.textContent = `${amount.toLocaleString('en-US')} points`;
      const q = this.current() && this.current().prediction;
      win.textContent = q ? `If ${o.title} wins: about ${fmtPoints(payout(q, outcomeId, amount))} back` : '';
    };
    const set = (v) => { amount = Math.max(1, Math.min(max, Math.floor(v))); show(); };
    const presets = (bal == null ? [10, 100, 500, 1000, 5000] : betPresets(bal)).map((v) => button(v === bal ? `All ${fmtPoints(v)}` : fmtPoints(v), () => set(v), { class: 'pp-preset', dataset: { key: `pp-preset-${v}` } }));
    const go = () => {
      const pts = amount;
      m.close();
      confirmDialog({
        title: `Predict ${pts.toLocaleString('en-US')} points?`,
        message: `On "${o.title}". Once it's in, Twitch doesn't let you take it back or switch to another outcome.`,
        yes: 'Predict',
        onYes: () => this.bet(p, o, pts),
      });
    };
    const content = el('div', { class: 'pp-amount-chooser' },
      el('div', { class: 'row pp-amount-row' }, button('−', () => set(stepBet(amount, -1, max)), { class: 'pp-step', 'aria-label': 'Less', dataset: { key: 'pp-less' } }), big, button('+', () => set(stepBet(amount, 1, max)), { class: 'pp-step', 'aria-label': 'More', dataset: { key: 'pp-more' } })),
      el('div', { class: 'pp-presets' }, presets),
      win,
      el('div', { class: 'row pp-actions' }, button('Predict', go, { class: 'primary pp-go', dataset: { key: 'pp-go' } }), button('Cancel', () => m.close(), { dataset: { key: 'pp-cancel' } })),
      hint('{X} less · {Y} more · {A} choose · {B} back', 'pp-hint'));
    const m = openModal({
      title: `Predict on ${o.title}`, class: 'pp-modal pp-amount-modal', content, focus: '.pp-go',
      onAction: (action) => {
        if (action === X) { set(stepBet(amount, -1, max)); return true; }
        if (action === Y) { set(stepBet(amount, 1, max)); return true; }
        return false;
      },
    });
    show();
  }

  async bet(p, o, points) {
    const r = await window.lurkbox.predictionBet({ login: this.login(), eventId: p.id, outcomeId: o.id, points }).catch((e) => ({ ok: false, reason: e.message }));
    if (r && r.ok) { toast(`Predicted ${points.toLocaleString('en-US')} points on ${o.title}`, 4000, 'ok'); return; }
    this.failed(r && r.reason, 'prediction');
  }

  failed(reason, kind) {
    if (reason === 'no-session') { toast('Predictions and polls need the TV sign-in (the twitch.tv session)', 4500, 'warn'); return; }
    confirmDialog({
      title: kind === 'prediction' ? 'Couldn\'t place the prediction' : 'Couldn\'t vote',
      message: `Lurkbox couldn't do it in Twitch's chat page (${reason || 'unknown error'}). Open Twitch's own view to do it there?`,
      yes: 'Open in Twitch chat',
      onYes: () => this.fallback(kind),
    });
  }

  pollDialog() {
    const id = this.current().poll.id;
    const status = el('div', { class: 'pp-status' });
    const note = el('div', { class: 'pp-mine' });
    const rows = new Map();
    const list = el('div', { class: 'pp-outcomes' });
    const other = this.current().prediction ? button('Prediction', () => { m.close(); this.open('prediction'); }, { dataset: { key: 'pp-to-prediction' } }) : null;
    const content = el('div', { class: 'pp-dialog' }, status, list, note,
      el('div', { class: 'row pp-actions' }, other, button('Open in Twitch chat', () => { m.close(); this.fallback('poll'); }, { dataset: { key: 'pp-twitch' } }), button('Close', () => m.close(), { dataset: { key: 'pp-close' } })));
    const update = () => {
      const cur = this.current();
      const q = cur && cur.poll;
      if (!q || q.id !== id) { m.close(); return; }
      status.textContent = pollStatus(q);
      const voted = this.voted === q.id;
      note.textContent = q.status !== 'active' ? '' : voted && q.pointsVotes ? `Voted. More votes cost ${fmtPoints(q.pointsVotes.cost)} channel points each.` : voted ? 'Voted.' : q.pointsVotes ? `Extra votes cost ${fmtPoints(q.pointsVotes.cost)} channel points each.` : '';
      for (const c of q.choices) {
        let r = rows.get(c.id);
        if (!r) {
          r = { title: el('span', { class: 'pp-o-title' }), pct: el('span', { class: 'pp-o-pct' }), stats: el('span', { class: 'pp-o-stats' }), fill: el('span', { class: 'pp-bar-fill' }) };
          r.node = button([el('span', { class: 'pp-o-bar' }, r.fill), el('span', { class: 'pp-o-head' }, r.title, r.pct), r.stats], () => this.vote(c.id), { class: 'pp-outcome', dataset: { key: `pp-c-${c.id}` } });
          rows.set(c.id, r);
          list.append(r.node);
        }
        r.title.textContent = c.title;
        r.pct.textContent = `${c.percent} %`;
        r.fill.style.width = `${c.percent}%`;
        r.stats.textContent = `${c.votes.toLocaleString('en-US')} vote${c.votes === 1 ? '' : 's'}`;
        r.node.classList.toggle('won', q.status !== 'active' && c.top);
        r.node.classList.toggle('closed', q.status !== 'active');
      }
    };
    const m = openModal({ title: this.current().poll.title, class: 'pp-modal', content, focus: '.pp-outcome', onClose: () => { if (this.dialog === h) this.dialog = null; } });
    const h = { close: () => m.close(), update };
    update();
    return h;
  }

  /** A on a choice: the vote; once voted (and the poll allows it), an extra vote paid with channel points after a confirm. */
  vote(choiceId) {
    const q = this.current() && this.current().poll;
    if (!q) return;
    const c = q.choices.find((x) => x.id === choiceId);
    if (q.status !== 'active') { toast('The poll has ended', 3000); return; }
    if (!state.auth.signedIn) { toast('Sign in to vote', 3500, 'warn'); return; }
    const send = async (points) => {
      const r = await window.lurkbox.pollVote({ login: this.login(), pollId: q.id, choiceId, points }).catch((e) => ({ ok: false, reason: e.message }));
      if (r && r.ok) {
        this.voted = q.id;
        toast(points ? `Extra vote for ${c.title}` : `Voted for ${c.title}`, 3500, 'ok');
        if (this.dialog) this.dialog.update();
      } else this.failed(r && r.reason, 'poll');
    };
    if (this.voted !== q.id) { send(false); return; }
    if (!q.pointsVotes) { toast('You already voted in this poll', 3000); return; }
    confirmDialog({
      title: `Another vote for ${c.title}?`,
      message: `An extra vote costs ${fmtPoints(q.pointsVotes.cost)} channel points.`,
      yes: 'Vote',
      onYes: () => send(true),
    });
  }
}

