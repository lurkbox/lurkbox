'use strict';
// Chat sending smoke test, offline, in demo mode (LURKBOX_DEMO=1: made-up data, no network): opens a live demo channel
// with Lurkbox chat on, presses "Send a message" in the player overlay with a virtual gamepad, types on Lurkbox's own
// on-screen keyboard (demo mode has no Steam keyboard), sends with A, and waits for the message to be drawn at once and
// then confirmed by the fake chat's IRC echo. Then it sends the same text again and checks that the demo's
// "identical message" drop is marked as not sent. Then the emote picker (X in the composer) inserts one of your own
// Twitch emotes from its Twitch tab and the message goes out with the emote drawn; quick chat (Y in the composer, and
// the overlay's quick-chat icon) sends a saved phrase at once, which comes back as its echo, and the same phrase
// again is held by its 3 s cooldown. LURKBOX_SHOT_DIR=<dir> saves chat-send-*.png. Exits 0 on success.
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-chat-send-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ chatDefault: true, chatStyle: 'lurkbox', videoOnlyUnfocused: false, navSounds: false, inputWhenUnfocused: true, continueWatchingOn: false }));
Object.assign(process.env, { LURKBOX_DEMO: '1', LURKBOX_USER_DATA: userData, LURKBOX_DEMO_SIZE: '1280x800' });
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
  // Without ffmpeg the demo has no video and the player falls back to Twitch's embed script, which demo mode blocks.
  // That is about the video, not chat: noted, not a failure. Anything else reaching for the network fails the test.
  const EMBED = /player\.twitch\.tv\/js\/embed/;
  if (blocked.some((l) => EMBED.test(l))) console.log('[chat-send] note: no demo video (ffmpeg missing?), the player tried the embed');
  blocked = blocked.filter((l) => !EMBED.test(l));
  if (blocked.length) { console.log(`[chat-send] demo mode tried to reach the network:\n  ${blocked.join('\n  ')}`); code = code || 3; }
  const errs = errors.filter((e) => !EMBED.test(e));
  if (errs.length) console.log(`[chat-send] renderer errors:\n  ${errs.join('\n  ')}`);
  console.log(`[chat-send] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
setTimeout(() => finish(1, 'timed out'), 90000).unref();

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
  const waitFor = async (what, code, timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`waiting for ${what} timed out`);
      await sleep(150);
    }
  };
  const press = async (...keys) => { for (const k of keys) await js(`__pad.press(${JSON.stringify(k)})`); };
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `chat-send-${name}.png`), (await wc.capturePage()).toPNG()); };
  const focusControl = async (key) => {
    for (let i = 0; i < 14; i++) {
      if (await js(`document.activeElement && document.activeElement.dataset.key === ${JSON.stringify(key)}`)) return;
      await press('RIGHT');
    }
    throw new Error(`no overlay control ${key}`);
  };
  /** Types on the built-in on-screen keyboard: each character's key is focused and pressed (A). */
  const typeOnOsk = async (text) => {
    for (const ch of text) {
      if (ch === ' ') { await press('Y'); continue; } // Y = space
      const ok = await js(`(() => { const k = [...document.querySelectorAll('.osk .osk-key[data-ch]')].find((n) => n.dataset.ch === ${JSON.stringify(ch)}); if (!k) return false; k.focus(); return true; })()`);
      if (!ok) throw new Error(`no key for ${ch}`);
      await press('A');
    }
  };
  const ownMessages = () => js(`[...document.querySelectorAll('#chat .chat-msg.own')].map((n) => ({ text: n.querySelector('.chat-text') && n.querySelector('.chat-text').textContent, cls: n.className, id: n.dataset.id }))`);

  let ran = false;
  wc.on('did-finish-load', async () => {
    if (ran || !/^http:\/\/localhost:/.test(wc.getURL())) return;
    ran = true;
    try {
      await waitFor('the app', '!!(window.__lurkbox && window.__lurkbox.dispatch && window.__lurkboxDemo)');
      await js(PAD);
      await sleep(400);
      await waitFor('Following', "document.querySelectorAll('[data-view=following] .grid .card').length >= 5");
      await js("document.querySelector('[data-view=following] .grid-live .card').focus(); true");
      await press('A');
      await waitFor('the player', "!document.getElementById('player-screen').hidden");
      await waitFor('chat messages', "document.querySelectorAll('#chat .chat-msg:not(.system)').length >= 10", 25000).catch(async (e) => {
        const d = await js("({ msgs: document.querySelectorAll('#chat .chat-msg').length, real: document.querySelectorAll('#chat .chat-msg:not(.system)').length, chatHidden: !!(document.getElementById('chat') && document.getElementById('chat').hidden), cur: window.__lurkbox.player.current && { kind: window.__lurkbox.player.current.kind, login: window.__lurkbox.player.current.login }, chatOn: window.__lurkbox.player.chatOn, sys: [...document.querySelectorAll('#chat .chat-msg.system')].map((n) => n.textContent.slice(0, 80)), modal: !!document.querySelector('.modal') })").catch((x) => String(x));
        throw new Error(`${e.message}: ${JSON.stringify(d)}`);
      });
      await waitFor('the composer', "(() => { const c = document.querySelector('#chat .chat-composer'); return c && !c.hidden; })()");
      // Overlay → "Send a message" → the on-screen keyboard.
      await press('A');
      await waitFor('the overlay', "!document.getElementById('player-overlay').hidden");
      await focusControl('compose');
      await press('A');
      await waitFor('the on-screen keyboard', "!!document.querySelector('.osk .osk-key')");
      await typeOnOsk('hi chat');
      await shot('keyboard');
      // The layout toggle: symbols and numbers, focus stays on the toggle, then back to letters (the grid keeps its rows).
      const oskRows = () => js("new Set([...document.querySelectorAll('.osk .osk-key')].map((k) => k.dataset.row)).size");
      const rowsBefore = await oskRows();
      await js("document.querySelector('.osk .osk-key[data-key=layout]').focus(); true");
      await press('A');
      await waitFor('the symbols layout', "!!document.querySelector('.osk .osk-key[data-ch=\"$\"]') && document.activeElement.dataset.key === 'layout'");
      if (await oskRows() !== rowsBefore) throw new Error('the symbols layout has a different number of rows');
      await press('UP');
      await waitFor('up from the layout toggle keeping its column', "document.activeElement.dataset.ch === '«'", 5000);
      await press('DOWN');
      await waitFor('focus back on the layout toggle', "document.activeElement.dataset.key === 'layout'", 5000);
      await press('A');
      await waitFor('the letters layout', "!!document.querySelector('.osk .osk-key[data-ch=q]')");
      await press('START'); // Done
      await waitFor('the text in the composer', "document.querySelector('#chat .cm-input').value === 'hi chat'");
      await waitFor('focus on Send', "document.activeElement && document.activeElement.classList.contains('cm-send')");
      await press('A'); // Send
      // Drawn at once (pending), then confirmed by the echo (the pending class goes, the IRC id replaces the local one).
      await waitFor('the message drawn', "[...document.querySelectorAll('#chat .chat-msg.own .chat-text')].some((n) => n.textContent === 'hi chat')", 5000);
      await waitFor('the echo', "[...document.querySelectorAll('#chat .chat-msg.own')].some((n) => !n.classList.contains('pending') && /^demo-msg-/.test(n.dataset.id || '') && n.querySelector('.chat-text').textContent === 'hi chat')", 8000);
      if (await js("document.querySelector('#chat .cm-input').value") !== '') throw new Error('the draft was not cleared after sending');
      await shot('sent');
      // The same text again within 30 s: the demo drops it like Twitch (msg_duplicate); it is marked "not sent".
      await sleep(1200); // past the 1 s gap between sends
      await js("(() => { const i = document.querySelector('#chat .cm-input'); i.focus(); i.value = 'hi chat'; i.dispatchEvent(new Event('input')); return true; })()");
      await js("document.querySelector('#chat .cm-send').focus(); true");
      await press('A');
      await waitFor('the refusal', "[...document.querySelectorAll('#chat .chat-msg.own.failed')].some((n) => n.textContent.includes('not sent'))", 5000);
      await waitFor('a toast with the reason', "[...document.querySelectorAll('#toasts .toast')].some((t) => /identical/i.test(t.textContent))", 3000);
      if (await js("document.querySelector('#chat .cm-input').value") !== 'hi chat') throw new Error('a refused message should stay in the composer');
      await shot('dropped');
      // The emote picker: X from the text box, the Twitch tab (your own emotes, two Helix pages in demo mode), A inserts.
      await js("(() => { const i = document.querySelector('#chat .cm-input'); i.value = 'hello'; i.dispatchEvent(new Event('input')); i.focus(); return true; })()");
      await press('X');
      await waitFor('the emote picker', "!!document.querySelector('.pop-emotes .ep-tab')", 3000);
      for (let i = 0; i < 6 && !(await js("!!document.querySelector('.pop-emotes .ep-tab.selected[data-tab=\"twitch\"]')")); i++) await press('RB');
      await waitFor('your Twitch emotes', "document.querySelectorAll('.pop-emotes .ep-grid .ep-emote').length === 4", 5000);
      await js("document.querySelector('.pop-emotes .ep-emote[title=\"lurkerHi\"]').focus(); true");
      await press('A');
      await waitFor('the emote in the draft', "document.querySelector('#chat .cm-input').value === 'hello lurkerHi '", 3000);
      await shot('emotes');
      await press('B');
      await waitFor('the picker closed, focus on its button', "!document.querySelector('.pop-emotes') && document.activeElement && document.activeElement.classList.contains('cm-emotes')", 3000);
      await sleep(1100);
      await press('START'); // send from anywhere in the composer
      await waitFor('the emote message echoed with the emote drawn', "[...document.querySelectorAll('#chat .chat-msg.own')].some((n) => /^demo-msg-/.test(n.dataset.id || '') && !!n.querySelector('img.emote[alt=\"lurkerHi\"]'))", 8000);
      const recents = await js("(() => { const s = window.__lurkbox.state; return (s.settings.emoteRecents || {})[s.auth.user.id] || []; })()");
      if (!recents.includes('lurkerHi')) throw new Error(`recent emotes not saved: ${JSON.stringify(recents)}`);
      // Quick chat from the composer (Y): A sends a phrase at once; it is echoed.
      await sleep(1100);
      await press('Y');
      await waitFor('quick chat', "!!document.querySelector('.pop-quick .qc-item')", 3000);
      const first = await js("document.activeElement && document.activeElement.dataset.phrase");
      if (!first) throw new Error('quick chat did not focus a phrase');
      await shot('quick');
      await press('A');
      await waitFor(`the phrase "${first}" echoed`, `[...document.querySelectorAll('#chat .chat-msg.own')].some((n) => /^demo-msg-/.test(n.dataset.id || '') && n.querySelector('.chat-text').textContent.trim() === ${JSON.stringify(first)})`, 8000);
      // Again at once: the 3 s per-phrase cooldown holds it (a toast, nothing sent).
      const before = (await ownMessages()).length;
      await press('A');
      await waitFor('the cooldown toast', "[...document.querySelectorAll('#toasts .toast')].some((t) => /^Wait \\d+ s$/.test(t.textContent.trim()))", 3000);
      if ((await ownMessages()).length !== before) throw new Error('the cooldown let a repeat through');
      await press('B');
      // B leaves the composer for the overlay, on "Send a message".
      await press('B');
      await waitFor('the overlay on compose', "!document.getElementById('player-overlay').hidden && document.activeElement && document.activeElement.dataset.key === 'compose'", 3000);
      // The overlay's quick-chat icon: another phrase, sent from the overlay's pop-over.
      await press('RIGHT');
      await waitFor('the quick-chat icon', "document.activeElement && document.activeElement.dataset.key === 'quick'", 3000);
      await press('A');
      await waitFor('quick chat in the overlay', "!!document.querySelector('#player-overlay .pop-quick .qc-item')", 3000);
      await press('DOWN');
      const second = await js("document.activeElement && document.activeElement.dataset.phrase");
      if (!second || second === first) throw new Error(`expected another phrase, got ${second}`);
      await sleep(3100);
      await press('A');
      await waitFor(`the phrase "${second}" echoed`, `[...document.querySelectorAll('#chat .chat-msg.own')].some((n) => /^demo-msg-/.test(n.dataset.id || '') && n.querySelector('.chat-text').textContent.trim() === ${JSON.stringify(second)})`, 8000);
      const own = await ownMessages();
      finish(0, `sent and echoed, duplicate refused and marked, emote inserted, quick chat sent from the composer and the overlay: ${JSON.stringify(own.map((m) => m.text))}`);
    } catch (e) {
      await shot('FAILED').catch(() => {});
      finish(1, e.message);
    }
  });
});

require('../../src/main/main.js');
