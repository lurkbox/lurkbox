'use strict';
// Channel points against a fixture of Twitch's embedded chat (no account needed), hosted in a 1280x800 player screen
// that uses the core's real stylesheet: the scan finds the balance, clicks Claim Bonus once and notices the
// prediction; then the frame becomes the large rewards view (modal), the rewards popover is fitted to it, and the
// shared controller navigation moves over individual reward tiles, scrolls them into view, opens a reward's detail,
// asks for the keyboard on its text box, and B goes back before it closes. The frame is zoomed for the TV first, as
// the main process zooms Twitch's real chat frame.
//   npm run test:points            (LURKBOX_SHOT_DIR=<dir> also saves points-*.png screenshots there)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const points = require('../../src/main/channel-points');
const { navSource, pressSource, backSource } = require('../../src/main/frame-nav');
const { zoomFrameSource } = require('@lurkbox/core/src/shared/tv-zoom.js');
const ZOOM = 1.74; // Auto on the 800-px Game Mode screen
const SHOTS = process.env.LURKBOX_SHOT_DIR || '';

const fail = (m) => { console.log(`[points-smoke] FAIL: ${m}`); app.exit(1); };
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: !!SHOTS, x: 0, y: 0, frame: false, width: 1280, height: 800, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'fixtures', 'points-host.html'));
  const host = (s) => win.webContents.executeJavaScript(s);
  const css = pathToFileURL(require.resolve('@lurkbox/core/src/css/app.css')).href;
  await host(`new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(css)}; l.onload = res; document.head.append(l); })`);
  const frame = win.webContents.mainFrame.frames[0];
  if (!frame) return fail('no chat frame');
  const js = (s) => frame.executeJavaScript(s);
  const shot = async (name) => {
    if (!SHOTS) return;
    await wait(150);
    fs.writeFileSync(path.join(SHOTS, `points-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  // ---- scanning (unchanged by the rewards view) ----
  const zoom = await js(zoomFrameSource(ZOOM));
  await js(zoomFrameSource(ZOOM)); // re-applied on every scan: must stay a single style element
  if (Number(zoom) !== ZOOM || (await js("document.querySelectorAll('#lurkbox-tv-zoom').length")) !== 1) return fail(`zoom ${zoom}`);
  const tracker = new points.PointsTracker();
  let r = tracker.update(await js(points.scanSource({ autoClaim: false })));
  if (r.state.balance !== 12300) return fail(`balance ${r.state.balance}`);
  if (await js('window.claims || 0')) return fail('claimed with auto-claim off');
  if (!r.events.some((e) => e.type === 'prediction' && /finish the mission/.test(e.title))) return fail(`no prediction event: ${JSON.stringify(r.events)}`);
  r = tracker.update(await js(points.scanSource({ autoClaim: true })));
  if ((await js('window.claims')) !== 1) return fail('Claim Bonus not clicked');
  await wait(200);
  r = tracker.update(await js(points.scanSource({ autoClaim: true })));
  if ((await js('window.claims')) !== 1) return fail('clicked twice');
  const claimed = r.events.find((e) => e.type === 'claimed');
  if (!claimed || claimed.amount !== 50 || r.state.balance !== 12350) return fail(`claim amount ${JSON.stringify(r.events)}`);
  if (r.events.some((e) => e.type === 'prediction')) return fail('prediction announced twice');

  // The old way, for comparison: Twitch's popover inside the side chat panel.
  if (!(await js(points.openRewardsSource()))) return fail('rewards button not found');
  await shot('before-side-panel');
  await js('closeRewards()');

  // ---- the rewards view: the frame as a modal, as the core's openPointsPanel() does ----
  const openView = async (rewards) => {
    await host("document.getElementById('twitch-chat-host').className = 'tc-modal'; document.querySelector('.points-backdrop').hidden = false; true");
    await wait(100);
    await js(navSource(points.NAV_OPTIONS));
    const opened = rewards ? await js(points.openRewardsSource()) : false;
    await js(points.fitRewardsSource());
    await wait(50);
    await js('window.__lbFit.run(), window.__lbNav.start()');
    return opened;
  };
  const closeView = async () => {
    await js(points.closeRewardsSource());
    await host("document.getElementById('twitch-chat-host').className = 'tc-panel'; document.querySelector('.points-backdrop').hidden = true; true");
  };
  const cur = () => js("(() => { const c = window.__lbNav && window.__lbNav.current(); return c ? c.id || c.getAttribute('aria-label') || c.tagName : null; })()");
  // The ring hugs the element (4 px out, clamped to the frame), the element is fully visible in its scroll container.
  const geometry = () => js(`(() => {
    const c = window.__lbNav.current();
    const ring = document.getElementById('lurkbox-focus-ring');
    if (!c || !ring || ring.style.display === 'none') return { ok: false, why: 'no ring', c: !!c, ring: !!ring, disp: ring && ring.style.display, iw: innerWidth, ih: innerHeight, r: c && c.getBoundingClientRect().toJSON() };
    const a = c.getBoundingClientRect();
    const g = ring.getBoundingClientRect();
    const want = { left: Math.max(0, a.left - 4), top: Math.max(0, a.top - 4), right: Math.min(innerWidth, a.right + 4), bottom: Math.min(innerHeight, a.bottom + 4) };
    const off = Math.max(...['left', 'top', 'right', 'bottom'].map((k) => Math.abs(g[k] - want[k])));
    const sc = window.__lbFit && window.__lbFit.scroller();
    const box = sc && sc.contains(c) ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    const inside = a.top >= box.top - 1 && a.bottom <= box.bottom + 1 && g.top >= 0 && g.bottom <= innerHeight && g.left >= 0 && g.right <= innerWidth;
    return { ok: off < 1.5 && inside, off, inside, a: [a.left, a.top, a.width, a.height].map(Math.round) };
  })()`);
  // A runs as a user gesture, as the main process sends it (a text box may then take real focus).
  const press = async (k) => { const v = await frame.executeJavaScript(pressSource(k), k === 'a'); await wait(30); return v; };

  if (!(await openView(true))) return fail('rewards popover did not open');
  // The popover fills the frame, and its scroll container the height under the header.
  const fit = await js(`(() => {
    const root = window.__lbFit.root(); const sc = window.__lbFit.scroller();
    const a = root.getBoundingClientRect(); const s = sc.getBoundingClientRect();
    return { root: [a.left, a.top, a.right, a.bottom].map(Math.round), view: [innerWidth, innerHeight], scBottom: Math.round(s.bottom), sc: sc.id };
  })()`);
  const [vw, vh] = fit.view;
  if (fit.root[0] !== 0 || fit.root[1] !== 0 || Math.abs(fit.root[2] - vw) > 1 || Math.abs(fit.root[3] - vh) > 1 || fit.sc !== 'scroller' || Math.abs(fit.scBottom - vh) > 1) {
    return fail(`popover not fitted to the frame: ${JSON.stringify(fit)}`);
  }
  // The hint is below the modal, never over it.
  const layout = await host(`(() => {
    const m = document.getElementById('twitch-chat-host').getBoundingClientRect();
    const h = document.querySelector('.points-hint').getBoundingClientRect();
    return { modal: [m.left, m.top, m.width, m.height].map(Math.round), hintTop: Math.round(h.top), hintBottom: Math.round(h.bottom) };
  })()`);
  if (layout.hintTop < layout.modal[1] + layout.modal[3] || layout.hintBottom > 800) return fail(`hint overlaps the modal: ${JSON.stringify(layout)}`);
  if (layout.modal[2] < 0.65 * 1280 || layout.modal[3] < 0.8 * 800) return fail(`modal too small: ${JSON.stringify(layout)}`);
  // Targets are single elements: the focusable wrappers around the tiles and the chat input are skipped.
  const targets = await js('window.__lbNav.targets().map((n) => n.id || n.getAttribute("aria-label") || n.tagName)');
  for (const t of ['powerups', 'input-wrapper', 'popover']) if (targets.includes(t)) return fail(`wrapper ${t} is a target: ${targets.join(' ')}`);
  for (const t of ['close', 'tab-rewards', 'streak-share', 'pu-highlight', 'cr-dance']) if (!targets.includes(t)) return fail(`${t} is not a target: ${targets.join(' ')}`);
  const first = await cur();
  if (first !== 'streak-share') return fail(`focus did not start on the popover's content (${first})`);
  let g = await geometry();
  if (!g.ok) return fail(`ring at the start: ${JSON.stringify(g)}`);
  await shot('modal-top');

  // Down to the last row: every focused tile is scrolled fully into view and the ring follows it.
  const seen = [first];
  for (let i = 0; i < 12; i++) {
    await press('down');
    const c = await cur();
    g = await geometry();
    if (!g.ok) return fail(`ring/scroll after down on ${c}: ${JSON.stringify(g)}`);
    if (c === seen[seen.length - 1]) break;
    seen.push(c);
  }
  if (!seen.some((id) => /^pu-/.test(id)) || !/^cr-(hat|dance|map)$/.test(seen[seen.length - 1])) return fail(`down did not walk the grid: ${seen.join(' ')}`);
  if (!((await js('document.getElementById("scroller").scrollTop')) > 0)) return fail('the scroll container did not scroll');
  await press('right');
  await shot('modal-scrolled');
  // Scrolling by other means (the wheel, touch) keeps the ring on the element.
  await js('document.getElementById("scroller").scrollTop -= 40');
  await wait(300); // the scroll event, or the 250-ms redraw in a window that does not paint
  const moved = await js(`(() => {
    const a = window.__lbNav.current().getBoundingClientRect();
    const g = document.getElementById('lurkbox-focus-ring').getBoundingClientRect();
    return Math.abs(g.top - Math.max(0, a.top - 4)) < 1.5 && Math.abs(g.left - Math.max(0, a.left - 4)) < 1.5;
  })()`);
  if (!moved) return fail('ring did not follow the scroll');

  // A on a reward opens its detail (a sub-view); B goes back to the list; a second B closes the view.
  const tile = await cur();
  await press('a');
  if ((await js('window.picked')) !== tile || !(await js('!!document.getElementById("detail")'))) return fail(`A on ${tile} did not open its detail`);
  if ((await js(backSource())) !== 'back' || (await js('!!document.getElementById("detail")'))) return fail('B did not go back from the detail');
  // A reward without a message: its detail's Redeem button redeems it.
  // Walks the D-pad towards an element: up/down until on its row, then left/right.
  const focusTarget = async (id) => {
    await js('window.__lbNav.reset(), window.__lbNav.start()');
    for (let i = 0; i < 24 && (await cur()) !== id; i++) {
      const d = await js(`(() => { const a = window.__lbNav.current().getBoundingClientRect(); const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
        const dy = (b.top + b.bottom - a.top - a.bottom) / 2; const dx = (b.left + b.right - a.left - a.right) / 2;
        return Math.abs(dy) > 8 ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left'); })()`);
      await press(d);
    }
    return cur();
  };
  if ((await focusTarget('cr-hydrate')) !== 'cr-hydrate') return fail(`could not reach Hydrate! (${await cur()})`);
  await press('a');
  await wait(50);
  await js('window.__lbNav.reset(), window.__lbNav.start()');
  for (let i = 0; i < 4 && (await cur()) !== 'redeem'; i++) await press('down');
  await press('a');
  if ((await js('window.redeemed')) !== 'cr-hydrate') return fail(`Redeem did not redeem (${await js('window.redeemed')})`);
  await js(backSource());
  // A power-up with a message in its detail: A on the text box takes real focus and asks for the Steam keyboard; the
  // first B leaves the box ('text'), the next goes back.
  await focusTarget('pu-highlight');
  if ((await cur()) !== 'pu-highlight') return fail(`could not reach the highlight power-up (${await cur()})`);
  await press('a');
  await wait(50);
  await js('window.__lbNav.start()');
  let kb = null;
  for (let i = 0; i < 4 && kb !== 'keyboard'; i++) {
    if ((await cur()) === 'reward-text') kb = await press('a');
    else await press('down');
  }
  if (kb !== 'keyboard') return fail(`A on the power-up's text box did not ask for the keyboard (${await cur()})`);
  if ((await js('document.activeElement && document.activeElement.id')) !== 'reward-text') return fail('the text box did not get DOM focus');
  g = await geometry();
  if (!g.ok) return fail(`ring on the text box: ${JSON.stringify(g)}`);
  await shot('detail-text');
  if ((await js(backSource())) !== 'text') return fail('B in the text box did not just leave it');
  if ((await js('document.activeElement && document.activeElement.id')) === 'reward-text') return fail('the text box kept the focus after B');
  if ((await js(backSource())) !== 'back') return fail('B did not go back from the text reward');

  // A reward that needs a message, the way Twitch does it: the popover closes, the reward becomes a chip above the chat
  // input (a contenteditable Slate editor, not a textarea), and the input has the focus. A on it asks for the
  // keyboard, typed keys reach it, Enter sends (Lurkbox presses "Chat" when the editor didn't send by itself) and the
  // reward is redeemed with the message; B in the box goes back to the reward list and lets go of the focus.
  const reachMessageReward = async () => {
    await focusTarget('cr-message');
    if ((await cur()) !== 'cr-message') throw new Error(`could not reach the message reward (${await cur()})`);
    await press('a');
    await wait(50);
    if (await js("document.getElementById('balloon').style.display !== 'none'")) throw new Error('the popover stayed open for a message reward');
    if (!(await js("document.getElementById('reward-chip').style.display !== 'none'"))) throw new Error('no reward chip');
  };
  const typeKeys = async (text) => {
    win.webContents.focus();
    for (const ch of text) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); await wait(20); }
  };
  const editorText = () => js("document.querySelector('[data-a-target=chat-input]').textContent");
  try { await reachMessageReward(); } catch (e) { return fail(e.message); }
  if (!(await js("!!window.__lbNav.current() && window.__lbNav.current().getAttribute('data-a-target') === 'chat-input'"))) await press('down'); // the nav picks up the page's focus: the editor
  if (!(await js("!!window.__lbNav.current() && window.__lbNav.current().getAttribute('data-a-target') === 'chat-input'"))) return fail(`the chat input is not a target after picking the reward (${await cur()})`);
  const kb2 = await press('a');
  if (kb2 !== 'keyboard') return fail(`A on the chat input did not ask for the keyboard (${kb2})`);
  if (!(await js("document.activeElement === document.querySelector('[data-a-target=chat-input]')"))) return fail('the chat input did not get DOM focus');
  await typeKeys('hi');
  if ((await editorText()) !== 'hi') return fail(`typing did not reach the chat input ("${await editorText()}")`);
  await shot('reward-message');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await wait(700);
  const red = await js('({ redeemed: window.redeemed, text: window.redeemedText, sent: window.sent, focused: document.activeElement === document.querySelector("[data-a-target=chat-input]") })');
  if (red.redeemed !== 'cr-message' || red.text !== 'hi') return fail(`Enter did not send the reward's message: ${JSON.stringify(red)}`);
  if (red.focused) return fail('the chat input kept the focus after sending');
  // Again, and B this time: back to the reward list, the box lets go of the focus.
  await js("document.getElementById('balance-btn').click(), true"); // the list again
  try { await reachMessageReward(); } catch (e) { return fail(e.message); }
  const onEditor = () => js("!!window.__lbNav.current() && window.__lbNav.current().getAttribute('data-a-target') === 'chat-input'");
  if (!(await onEditor())) await press('down');
  if ((await press('a')) !== 'keyboard') return fail('A on the chat input (second time) did not ask for the keyboard');
  const b1 = await js(backSource());
  if (b1 !== 'text') return fail(`B in the chat input returned ${b1}`);
  if (await js("document.activeElement === document.querySelector('[data-a-target=chat-input]')")) return fail('the chat input kept the focus after B');
  await js(points.openRewardsSource()); // what the main process does after 'text'
  if (!(await js("document.getElementById('balloon').style.display !== 'none' && !!document.getElementById('rewards')"))) return fail('B did not go back to the reward list');
  if ((await js(backSource())) !== 'close') return fail('B on the list did not ask to close the view');
  await closeView();
  const after = await js(`({ open: document.getElementById('balloon').style.display !== 'none', nav: !!window.__lbNav, fit: !!window.__lbFit, ring: !!document.getElementById('lurkbox-focus-ring'), transform: document.getElementById('balloon').style.transform })`);
  if (after.open || after.nav || after.fit || after.ring || after.transform) return fail(`view not cleaned up: ${JSON.stringify(after)}`);

  // Y on a prediction toast: the same view without the popover, on the pinned prediction; A opens it, fitted.
  await openView(false);
  if ((await cur()) !== 'prediction') return fail(`prediction view did not start on the prediction (${await cur()})`);
  g = await geometry();
  if (!g.ok) return fail(`ring on the prediction: ${JSON.stringify(g)}`);
  await shot('prediction');
  await press('a');
  await wait(450); // the fit loop picks up a popover the page opened itself
  const predFit = await js("(() => { const r = document.getElementById('popover').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), innerHeight]; })()");
  if (predFit[0] !== 0 || Math.abs(predFit[1] - predFit[2]) > 1) return fail(`prediction popover not fitted: ${predFit}`);
  await js('window.__lbNav.start()');
  await shot('prediction-open');
  await closeView();

  console.log(`[points-smoke] PASS: chat zoomed ${zoom}; balance 12.3K -> 12,350 after one Claim Bonus click (+50), prediction noticed once; rewards view ${layout.modal[2]}x${layout.modal[3]} with the hint below it, popover fitted to the frame, ${targets.length} single-element targets (wrappers skipped), down walked ${seen.length} tiles with the ring on each and the list scrolled, A opened a detail and B went back then closed, Redeem redeemed, A on a text box focused it and asked for the keyboard, a message reward's contenteditable chat input took the keys and Enter sent it (redeemed with the message), B left the box for the reward list, prediction view fitted`);
  app.exit(0);
}).catch((e) => fail((e && e.stack) || String(e)));
