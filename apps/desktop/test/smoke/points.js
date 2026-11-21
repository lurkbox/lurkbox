'use strict';
// Channel points against a fixture of Twitch's embedded chat (no account needed): the scan finds the balance, clicks
// Claim Bonus once, notices the prediction; the shared controller navigation moves inside the rewards popover.
// The fixture is zoomed for the TV first, as the main process zooms Twitch's real chat frame.
//   npm run test:points
const path = require('path');
const { app, BrowserWindow } = require('electron');
const points = require('../../src/main/channel-points');
const { navSource, pressSource } = require('../../src/main/frame-nav');
const { zoomFrameSource } = require('@lurkbox/core/src/shared/tv-zoom.js');
const ZOOM = 1.74; // Auto on the 800-px Game Mode screen

const fail = (m) => { console.log(`[points-smoke] FAIL: ${m}`); app.exit(1); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'fixtures', 'chat-points.html'));
  const js = (s) => win.webContents.executeJavaScript(s);
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
  await new Promise((res) => setTimeout(res, 200));
  r = tracker.update(await js(points.scanSource({ autoClaim: true })));
  if ((await js('window.claims')) !== 1) return fail('clicked twice');
  const claimed = r.events.find((e) => e.type === 'claimed');
  if (!claimed || claimed.amount !== 50 || r.state.balance !== 12350) return fail(`claim amount ${JSON.stringify(r.events)}`);
  if (r.events.some((e) => e.type === 'prediction')) return fail('prediction announced twice');
  // Rewards popover + controller navigation.
  if (!(await js(points.openRewardsSource()))) return fail('rewards button not found');
  await js(navSource({ scopeSelector: '[role=dialog]' }));
  await js('window.__lbNav.start()');
  const first = await js('document.activeElement && document.activeElement.id');
  if (first !== 'r1') return fail(`navigation did not start in the popover (${first})`);
  await js(pressSource('down'));
  const second = await js('document.activeElement && document.activeElement.id');
  await js(pressSource('a'));
  const picked = await js('window.picked');
  await js(pressSource('down'));
  const kb = await js(pressSource('a'));
  if (second !== 'r2' || picked !== 'r2' || kb !== 'keyboard') return fail(`navigation: ${second} ${picked} ${kb}`);
  if (process.env.LURKBOX_SHOT) require('fs').writeFileSync(process.env.LURKBOX_SHOT, (await win.webContents.capturePage()).toPNG());
  console.log(`[points-smoke] PASS: chat zoomed ${zoom}; balance 12.3K -> 12,350 after one Claim Bonus click (+50), prediction noticed once, rewards popover driven by the D-pad (A on a text box asks for the keyboard)`);
  app.exit(0);
}).catch((e) => fail(e.stack));
