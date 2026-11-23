'use strict';
// Predictions and polls smoke test, offline, in demo mode (LURKBOX_DEMO=1 LURKBOX_DEMO_PREDICTIONS=1: every live channel
// has a made-up prediction and poll behind the host's real watcher): the chip while the controls are hidden, the card in
// the overlay, A on the card opens the prediction; A on an outcome opens the amount chooser, Y raises the amount, A,
// then the confirm step; the bet shows as "Your prediction" in the dialog and on the card; the poll from the dialog's
// Poll button: a vote, then an extra vote with channel points after its confirm; the card goes when the player closes.
// LURKBOX_SHOT_DIR=<dir> saves pp-*.png. Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-pp-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true }));
Object.assign(process.env, { TZ: 'UTC', LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: '1280x800', LURKBOX_DEMO_PREDICTIONS: '1' });
if (!process.argv.includes('--windowed')) process.argv.push('--windowed');

const { app } = require('electron');
const SHOTS = process.env.LURKBOX_SHOT_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let finished = false;
function finish(code, msg) {
  if (finished) return;
  finished = true;
  let blocked = [];
  try { blocked = fs.readFileSync(path.join(userData, 'demo-blocked.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
  const EMBED = /player\.twitch\.tv\/js\/embed|clips\.twitch\.tv\/embed/; // no demo video (ffmpeg missing): the player tried the embed
  if (blocked.some((l) => EMBED.test(l))) console.log('[pp] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[pp] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[pp] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[pp] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => finish(1, 'timed out'), 120000).unref();

// A virtual standard gamepad (the same as the screenshot scenes), so presses take Lurkbox's real input path.
const PAD = `(() => {
  if (window.__pad) return true;
  const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: null };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__pad = { async press(a) { const b = pad.buttons[BUTTON[a]]; b.pressed = true; b.value = 1; pad.timestamp++; await wait(70); b.pressed = false; b.value = 0; pad.timestamp++; await wait(110); return true; } };
  return true;
})()`;

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message.slice(0, 300)); });
  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (what, code, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`waiting for ${what} timed out`);
      await sleep(150);
    }
  };
  const press = async (...keys) => { for (const k of keys) await js(`__pad.press(${JSON.stringify(k)})`); };
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `pp-${name}.png`), (await wc.capturePage()).toPNG()); };
  const tab = () => js("document.querySelector('.channel-body') && document.querySelector('.channel-body').dataset.tab");
  const focusKey = () => js('document.activeElement && document.activeElement.dataset.focusKey');
  const log = (m) => console.log(`[pp] ${m}`);

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid-live .card').length >= 5", 30000);
      const playerOpen = "!document.getElementById('player-screen').hidden && window.__lurkbox.player.current && window.__lurkbox.player.current.kind === 'live'";
      // A on the first live card (once more if a busy machine dropped the press).
      for (let i = 0; i < 2 && !(await js(playerOpen)); i++) {
        await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
        await press('A');
        await waitFor('the player', playerOpen, 10000).catch(() => null);
      }
      await waitFor('the player', playerOpen, 20000);
      const login = await js('window.__lurkbox.player.current.login');
      // The chip, with the controls hidden.
      await js('window.__lurkbox.player.hideOverlay(); true');
      await waitFor('the chip', "(() => { const c = document.querySelector('#player-stage .pp-chip'); return c && !c.hidden && getComputedStyle(c).display !== 'none' && /Prediction · \\d+:\\d\\d/.test(c.textContent); })()");
      await shot('chip');
      // The card in the overlay; A on it opens the prediction.
      await press('A');
      await waitFor('the overlay', "!document.getElementById('player-overlay').hidden");
      await waitFor('the card', "(() => { const c = document.querySelector('#player-overlay .pp-card'); return c && !c.hidden && /Does the boss go down/.test(c.textContent) && /Which level next/.test(c.textContent); })()");
      if (await js("getComputedStyle(document.querySelector('#player-stage .pp-chip')).display !== 'none'")) throw new Error('the chip shows over the overlay');
      await shot('card');
      const dialogOpen = "document.querySelectorAll('.modal.pp-modal .pp-outcome').length === 2";
      for (let i = 0; i < 2 && !(await js(dialogOpen)); i++) {
        await js("document.querySelector('#player-overlay .pp-card').focus(); true");
        await press('A');
        await waitFor('the prediction dialog', dialogOpen, 8000).catch(() => null);
      }
      await waitFor('the prediction dialog', dialogOpen, 10000);
      const st = await js("document.querySelector('.pp-modal .pp-status').textContent");
      if (!/Predictions close in \d+:\d\d/.test(st)) throw new Error(`status line: ${st}`);
      // The totals move on their own (live updates) while the dialog is open.
      const before = await js("document.querySelector('.pp-modal .pp-o-stats').textContent + document.querySelectorAll('.pp-modal .pp-o-stats')[1].textContent");
      await waitFor('a live update', `document.querySelector('.pp-modal .pp-o-stats').textContent + document.querySelectorAll('.pp-modal .pp-o-stats')[1].textContent !== ${JSON.stringify(before)}`, 10000);
      if (!(await js("document.activeElement && document.activeElement.classList.contains('pp-outcome')"))) throw new Error('the focus is not on an outcome');
      await shot('dialog');
      // Bet: A on the first outcome → the amount chooser (100 to start), Y twice → 500, A (Predict) → confirm → A.
      await press('A');
      await waitFor('the amount chooser', "!!document.querySelector('.pp-amount-modal .pp-amount')");
      const a0 = await js("document.querySelector('.pp-amount').textContent");
      await press('Y', 'Y');
      const a1 = await js("document.querySelector('.pp-amount').textContent");
      if (a0 !== '100 points' || a1 !== '500 points') throw new Error(`amounts: ${a0} → ${a1}`);
      if (!(await js("/If Yes, first try wins: about [\\d.,K]+ back/.test(document.querySelector('.pp-payout').textContent)"))) throw new Error('no payout line');
      await shot('amount');
      await press('A');
      await waitFor('the confirm step', "/Predict 500 points\\?/.test(([...document.querySelectorAll('.modal .modal-title')].pop() || {}).textContent || '')");
      await press('A');
      await waitFor('the bet in the dialog', "/Your prediction: 500 points on Yes, first try/.test((document.querySelector('.pp-modal .pp-mine') || {}).textContent || '')", 10000);
      await waitFor('the toast', "[...document.querySelectorAll('#toasts .toast')].some((t) => /Predicted 500 points on Yes, first try/.test(t.textContent))");
      if (!(await js("document.querySelector('.pp-modal .pp-outcome').classList.contains('mine') && document.querySelectorAll('.pp-modal .pp-outcome')[1].classList.contains('closed')"))) throw new Error('the other outcome is still open after the bet');
      log('predicted 500 on the first outcome; the dialog shows it');
      // The poll, from the dialog's Poll button: a vote, then an extra vote with points (confirmed).
      await js("document.querySelector('[data-key=\"pp-to-poll\"]').focus(); true");
      await press('A');
      await waitFor('the poll dialog', "document.querySelectorAll('.modal.pp-modal .pp-outcome').length === 3 && /Poll ends in/.test(document.querySelector('.pp-modal .pp-status').textContent)");
      const votes = await js("document.querySelector('.pp-modal .pp-o-stats').textContent");
      await js("document.querySelector('.pp-modal .pp-outcome').focus(); true");
      await press('A');
      await waitFor('voted', "/Voted\\./.test(document.querySelector('.pp-modal .pp-mine').textContent)");
      await shot('poll');
      await press('A');
      await waitFor('the extra-vote confirm', "/Another vote for Forest level\\?/.test(([...document.querySelectorAll('.modal .modal-title')].pop() || {}).textContent || '')");
      await press('A');
      await waitFor('the extra vote toast', "[...document.querySelectorAll('#toasts .toast')].some((t) => /Extra vote for Forest level/.test(t.textContent))");
      const votes2 = await waitFor('the votes counted', `(() => { const t = document.querySelector('.pp-modal .pp-o-stats'); return t && t.textContent !== ${JSON.stringify(votes)} ? t.textContent : null; })()`, 10000);
      log(`poll: ${votes} → ${votes2}`);
      await press('B');
      await waitFor('the dialog closed', "!document.querySelector('.modal')");
      // The card shows the bet; closing the player removes the card and the chip.
      await js('window.__lurkbox.player.showOverlay(); true');
      await waitFor('the bet on the card', "/Your prediction: 500 points/.test(document.querySelector('#player-overlay .pp-card').textContent)");
      await press('B', 'B');
      await waitFor('the player closed', "document.getElementById('player-screen').hidden");
      await waitFor('the card gone', "document.querySelector('#player-overlay .pp-card').hidden && document.querySelector('#player-stage .pp-chip').hidden", 8000);
      finish(0, `${login}: chip, card, dialog with live updates, a 500-point prediction (amount chooser, confirm), a poll vote and an extra vote with points, gone after the player closed`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      const diag = await js("JSON.stringify({ st: window.__lurkbox.player.pp && window.__lurkbox.player.pp.st, login: window.__lurkbox.player.current && window.__lurkbox.player.current.login, chip: document.querySelector('.pp-chip') && document.querySelector('.pp-chip').outerHTML.slice(0, 200) })").catch(() => '');
      let lines = '';
      try { lines = fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8').split('\n').filter((l) => /predictions|demo/.test(l)).slice(-8).join('\n'); } catch { /* none */ }
      finish(1, `${e.message}\n${String(diag).slice(0, 1500)}\n${lines}`);
    }
  });
});

require('../../src/main/main.js');
