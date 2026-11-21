'use strict';
// Drops against a fixture of Twitch's Drops Inventory page (no account needed), hosted in the Drops section's layout
// with the core's real stylesheet: the scan waits out the loading state, reads the campaigns and their progress, finds
// the Claim buttons by attribute or by text (also after the class names change), clicks each finished drop once and
// confirms it, stops when the page doesn't take a click, and reports the sign-in wall; then the shared controller
// navigation moves over single targets in the zoomed page, scrolls them into view, and B asks to leave the frame.
//   npm run test:drops            (LURKBOX_SHOT_DIR=<dir> also saves drops-*.png screenshots there)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const drops = require('../../src/main/drops');
const { navSource, pressSource, backSource } = require('../../src/main/frame-nav');
const { zoomFrameSource, tvZoom } = require('@lurkbox/core/src/shared/tv-zoom.js');
const ZOOM = tvZoom(800, 100); // the login window's rule on the 800-px Game Mode screen
const SHOTS = process.env.LURKBOX_SHOT_DIR || '';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'drops-inventory.html');

const fail = (m) => { console.log(`[drops-smoke] FAIL: ${m}`); app.exit(1); };
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

/** Scans until the page leaves its loading state, as the hidden auto-claim window does. */
async function scanReady(js, opts) {
  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await js(drops.scanSource({ claim: false }));
    if (r.state !== 'loading') break;
    await wait(100);
  }
  return opts && opts.claim && r.state === 'ready' ? js(drops.scanSource(opts)) : r;
}

app.whenReady().then(async () => {
  // ---- the hidden auto-claim window's view of the page ----
  const hidden = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const hjs = (s) => hidden.webContents.executeJavaScript(s);
  await hidden.loadFile(FIXTURE);
  const first = await hjs(drops.scanSource({ claim: true }));
  if (first.state !== 'loading' || (await hjs('window.claims.length'))) return fail(`not "loading" before the content, or clicked: ${JSON.stringify(first)}`);
  let r = await scanReady(hjs);
  if (r.state !== 'ready') return fail(`state ${r.state}`);
  const byGame = Object.fromEntries(r.campaigns.map((c) => [c.game, c]));
  const rust = byGame.Rust;
  const quest = byGame['Example Quest'];
  if (!rust || !quest || r.campaigns.length !== 2) return fail(`campaigns ${JSON.stringify(r.campaigns)}`);
  if (rust.name !== 'Rust: Winter Drops Week') return fail(`campaign name ${rust.name}`);
  const d = (c, n) => c.drops.find((x) => x.name === n);
  if (!d(rust, 'Winter Jacket') || d(rust, 'Winter Jacket').percent !== 45 || d(rust, 'Winter Jacket').claimable) return fail(`jacket ${JSON.stringify(rust.drops)}`);
  if (!d(rust, 'Frost Hatchet') || !d(rust, 'Frost Hatchet').claimable) return fail(`hatchet ${JSON.stringify(rust.drops)}`);
  if (!d(quest, 'Explorer Banner') || !d(quest, 'Explorer Banner').claimable || d(quest, 'Pocket Pet').percent !== 10) return fail(`quest ${JSON.stringify(quest.drops)}`);
  if (d(quest, 'Launch Badge')) return fail('an already claimed drop was listed');
  if (await hjs('window.claims.length')) return fail('clicked with claim off');

  r = await hjs(drops.scanSource({ claim: true, gapMs: 400 }));
  const claims = await hjs('window.claims');
  if (JSON.stringify(claims) !== '["claim-hatchet","claim-banner"]') return fail(`clicks ${JSON.stringify(claims)}`);
  if (JSON.stringify(r.claimed) !== JSON.stringify([{ name: 'Frost Hatchet', confirmed: true }, { name: 'Explorer Banner', confirmed: true }])) return fail(`claimed ${JSON.stringify(r.claimed)}`);
  r = await hjs(drops.scanSource({ claim: true, gapMs: 400 }));
  if (r.claimed.length || (await hjs('window.claims.length')) !== 2) return fail('clicked again after the claims');

  // Tolerance: other class names on the campaign header, no attributes on the buttons (text only).
  await hidden.loadFile(FIXTURE);
  await scanReady(hjs);
  await hjs(`document.querySelectorAll('.inventory-campaign-info').forEach((n) => { n.className = 'Layout-sc-1 drops-campaign-info-header'; });
    document.querySelectorAll('button').forEach((b) => { b.removeAttribute('data-a-target'); b.removeAttribute('aria-label'); b.className = ''; }); true`);
  r = await hjs(drops.scanSource({ claim: true, gapMs: 400 }));
  if (r.campaigns.length !== 2 || r.claimed.length !== 2 || !r.claimed.every((c) => c.confirmed)) return fail(`tolerance: ${JSON.stringify(r)}`);
  if ((await hjs('window.claims.length')) !== 2) return fail('tolerance: wrong clicks');

  // A page that ignores the click: one click, not confirmed, no more.
  await hidden.loadFile(FIXTURE, { query: { stuck: '1' } });
  r = await scanReady(hjs, { claim: true, gapMs: 400 });
  if (r.claimed.length !== 1 || r.claimed[0].confirmed || (await hjs('window.claims.length')) !== 1) return fail(`stuck page: ${JSON.stringify(r.claimed)}`);
  // The sign-in wall.
  await hidden.loadFile(FIXTURE, { query: { signedout: '1' } });
  r = await hjs(drops.scanSource({ claim: true }));
  if (r.state !== 'signed-out') return fail(`signed out: ${r.state}`);

  // ---- the Drops section: the page in the large frame, the controller inside it ----
  const win = new BrowserWindow({ show: !!SHOTS, x: 0, y: 0, frame: false, width: 1280, height: 800, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'fixtures', 'drops-host.html'));
  const host = (s) => win.webContents.executeJavaScript(s);
  const css = pathToFileURL(require.resolve('@lurkbox/core/src/css/app.css')).href;
  await host(`new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(css)}; l.onload = res; document.head.append(l); })`);
  const frame = win.webContents.mainFrame.frames[0];
  if (!frame) return fail('no inventory frame');
  const js = (s) => frame.executeJavaScript(s);
  const shot = async (name) => {
    if (!SHOTS) return;
    await wait(150);
    fs.writeFileSync(path.join(SHOTS, `drops-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  await scanReady(js);
  const zoom = await js(zoomFrameSource(ZOOM));
  if (Number(zoom) !== ZOOM) return fail(`zoom ${zoom}`);
  // The frame is large and the hint is below it, never over the page.
  const layout = await host(`(() => {
    const m = document.querySelector('.drops-stage').getBoundingClientRect();
    const h = document.querySelector('.points-hint').getBoundingClientRect();
    return { stage: [m.left, m.top, m.width, m.height].map(Math.round), hintTop: Math.round(h.top), hintBottom: Math.round(h.bottom) };
  })()`);
  if (layout.hintTop < layout.stage[1] + layout.stage[3] || layout.hintBottom > 800) return fail(`hint overlaps the frame: ${JSON.stringify(layout)}`);
  if (layout.stage[3] < 0.7 * 800) return fail(`frame too small: ${JSON.stringify(layout)}`);

  await js(navSource(drops.NAV_OPTIONS));
  if (!(await js('window.__lbNav.start()'))) return fail('navigation did not start');
  const targets = await js('window.__lbNav.targets().map((n) => n.id || n.getAttribute("aria-label") || n.textContent.trim().slice(0, 20))');
  for (const t of ['claim-hatchet', 'claim-banner']) if (!targets.includes(t)) return fail(`${t} is not a target: ${targets.join(' | ')}`);
  if (targets.some((t) => /^card-|^tile-/.test(t))) return fail(`a card is a target: ${targets.join(' | ')}`);
  const cur = () => js("(() => { const c = window.__lbNav.current(); return c ? c.id || c.textContent.trim().slice(0, 20) || c.getAttribute('href') : null; })()");
  const ring = () => js(`(() => {
    const c = window.__lbNav.current();
    const g = document.getElementById('lurkbox-focus-ring');
    if (!c || !g || g.style.display === 'none') return { ok: false, current: !!c, ring: !!g && g.style.display };
    const a = c.getBoundingClientRect(); const b = g.getBoundingClientRect();
    return { a: [a.top, a.bottom], ring: [b.top, b.left], ih: innerHeight, ok: a.top >= -1 && a.bottom <= innerHeight + 1 && Math.abs(b.top - Math.max(0, a.top - 4)) < 1.5 && Math.abs(b.left - Math.max(0, a.left - 4)) < 1.5 };
  })()`);
  await shot('top');
  const seen = [await cur()];
  for (let i = 0; i < 30; i++) {
    await js(pressSource('down'));
    await wait(30);
    const c = await cur();
    const g = await ring();
    if (!g.ok) return fail(`ring/scroll after down on ${c}: ${JSON.stringify(g)}`);
    if (c === seen[seen.length - 1]) break;
    seen.push(c);
  }
  if (seen[seen.length - 1] !== 'bottom-link' || !seen.includes('claim-banner')) return fail(`down did not walk the page: ${seen.join(' | ')}`);
  if (!((await js('document.scrollingElement.scrollTop')) > 0)) return fail('the page did not scroll');
  await shot('bottom');
  if ((await js(backSource())) !== 'close') return fail('B without a dialog did not ask to leave the frame');
  await js('window.__lbNav.stop()');
  if (await js('!!document.getElementById("lurkbox-focus-ring") || !!window.__lbNav')) return fail('navigation not cleaned up');

  console.log(`[drops-smoke] PASS: loading -> ready; 2 campaigns (Jacket 45%, Pet 10%); Claim clicked once each for Hatchet (text) and Banner (attribute), both confirmed, never for Claimed or "Learn how to claim"; same result with other class names and no attributes; a page that ignores the click got one click; sign-in wall seen; frame ${layout.stage[2]}x${layout.stage[3]} zoomed ${zoom} with the hint below; ${targets.length} targets, down walked ${seen.length} with the ring on each and the page scrolled; B asks to leave`);
  hidden.destroy();
  app.exit(0);
}).catch((e) => fail((e && e.stack) || String(e)));
