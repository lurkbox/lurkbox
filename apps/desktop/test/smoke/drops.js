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
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const drops = require('../../src/main/drops');
const { createDropsFrameHost } = require('../../src/main/drops-frame');
const { startServer } = require('../../src/main/server');
const { WEB_ROOT } = require('../../src/main/paths');
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

/**
 * The Drops section as the app runs it: the core's views/drops.js and frame-focus guard in a page served by Lurkbox's
 * server, the inventory URL answered with the fixture, and drops-frame.js behind drops:open/pad/close. Focus must stay
 * put for 5 s (no focus events in the app, the same target and ring rect, no open/close), also while Twitch's page
 * loads sub-frames and after the window loses and regains focus; then D-pad right and down move it every time.
 * Resolves a summary, or null after fail().
 */
async function sectionTest() {
  const fixture = fs.readFileSync(FIXTURE);
  protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'www.twitch.tv' && u.pathname === '/drops/inventory') return new Response(fixture, { headers: { 'content-type': 'text/html' } });
    if (u.hostname === 'www.twitch.tv' && u.pathname === '/blank') return new Response('<!doctype html><title>sub-frame</title>', { headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  });
  const server = await startServer(WEB_ROOT, { '/test/drops-app.html': path.join(__dirname, '..', 'fixtures', 'drops-app.html') });
  const win = new BrowserWindow({ show: true, x: 0, y: 0, frame: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'drops-preload.js'), sandbox: true, contextIsolation: true } });
  const calls = { open: 0, close: 0 };
  const frames = () => win.webContents.mainFrame.framesInSubtree.filter((f) => { try { return drops.isDropsPageUrl(f.url); } catch { return false; } });
  const dh = createDropsFrameHost({ frames, zoom: () => ZOOM });
  ipcMain.handle('drops:status', () => ({ signedIn: true, lastCheckAt: null, nextCheckAt: null }));
  ipcMain.handle('drops:open', () => { calls.open++; return dh.open(); });
  ipcMain.handle('drops:close', () => { calls.close++; return dh.close(); });
  ipcMain.handle('drops:pad', (_e, k) => dh.pad(k));
  win.webContents.on('did-frame-finish-load', () => dh.prepare()); // as main.js does
  await win.loadURL(`${server.url}test/drops-app.html`);
  win.focus();
  const host = (s) => win.webContents.executeJavaScript(s);
  for (let i = 0; i < 50 && !(await host('!!(window.__t && window.__t.ready && document.querySelector(".drops-stage iframe"))')); i++) await wait(100);
  const frame = async () => { for (let i = 0; i < 50; i++) { const f = frames()[0]; if (f) return f; await wait(100); } return null; };
  if (!(await frame())) { fail('section: no inventory frame'); return null; }
  for (let i = 0; i < 40; i++) { const r = await (await frame()).executeJavaScript(drops.scanSource({ claim: false })); if (r.state === 'ready') break; await wait(100); }
  // Focus arrives from the rail, as RIGHT on the rail does.
  await host('document.getElementById("rail-drops").focus(); document.querySelector(".drops-stage").focus(); true');
  const fjs = async (s) => (await frame()).executeJavaScript(s);
  const snap = () => fjs(`(() => {
    const c = window.__lbNav && window.__lbNav.current();
    const g = document.getElementById('lurkbox-focus-ring');
    const r = g && g.style.display !== 'none' ? g.getBoundingClientRect() : null;
    return { cur: c ? (c.id || c.textContent.trim().slice(0, 24) || c.getAttribute('href')) : null, ring: r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v)).join(',') : null };
  })()`).catch(() => ({ cur: null, ring: null }));
  let s0 = null;
  for (let i = 0; i < 40; i++) { s0 = await snap(); if (s0.cur && s0.ring) break; await wait(100); }
  if (!s0.cur || !s0.ring) { fail(`section: no focus in the frame: ${JSON.stringify(s0)} events ${await host('JSON.stringify(__t.events)')}`); return null; }
  await wait(600);
  s0 = await snap();
  const idle = async (label, ms, during = async () => {}) => {
    const before = { ...calls, events: await host('__t.events.length') };
    const base = await snap();
    const seen = new Set();
    for (let t = 0; t < ms; t += 250) {
      await during(t);
      await wait(250);
      const s = await snap();
      seen.add(`${s.cur}@${s.ring}`);
    }
    const ev = await host(`__t.events.slice(${before.events})`);
    const active = await host('__t.active()');
    if (seen.size !== 1 || !seen.has(`${base.cur}@${base.ring}`) || ev.length || calls.open !== before.open || calls.close !== before.close || !/drops-stage/.test(active)) {
      fail(`section: ${label}: focus not stable: states ${JSON.stringify([...seen])} (start ${base.cur}@${base.ring}), app focus events ${JSON.stringify(ev)}, open ${calls.open - before.open} close ${calls.close - before.close}, active ${active}`);
      return false;
    }
    return true;
  };
  if (!(await idle('idle 5 s', 5000))) return null;
  // Game Mode: the window loses OS focus (a game, Steam's overlay) and gets it back.
  const other = new BrowserWindow({ show: true, x: 100, y: 100, width: 300, height: 200 });
  other.focus();
  await wait(800);
  other.destroy();
  win.focus();
  await wait(800);
  const back = await snap();
  if (back.cur !== s0.cur || back.ring !== s0.ring) { fail(`section: focus moved after unfocus/refocus: ${JSON.stringify(back)} vs ${JSON.stringify(s0)}`); return null; }
  if (!(await idle('after refocus', 2000))) return null;
  // The D-pad moves the focus every time, in the frame, and the app keeps its own focus on the frame.
  const path_ = [s0.cur];
  for (const a of ['RIGHT', 'RIGHT', 'RIGHT', 'DOWN', 'DOWN', 'DOWN']) {
    const prev = await snap();
    if (!(await host(`__t.press(${JSON.stringify(a)})`))) { fail(`section: ${a} was not handled by the Drops view (active ${await host('__t.active()')})`); return null; }
    let now = prev;
    for (let i = 0; i < 20 && now.cur === prev.cur; i++) { await wait(50); now = await snap(); }
    if (now.cur === prev.cur || !now.ring) { fail(`section: ${a} did not move from ${prev.cur} (path ${path_.join(' > ')})`); return null; }
    path_.push(now.cur);
    await wait(300);
    const still = await snap();
    if (still.cur !== now.cur) { fail(`section: after ${a} focus jumped back from ${now.cur} to ${still.cur}`); return null; }
  }
  // Twitch's page keeps loading sub-frames (ads, tracking): each load must not restart the navigation (focus
  // away from the first target, where a restart would put it).
  if (!(await idle('sub-frames loading', 2000, (t) => (t % 500 ? null : fjs("(() => { const f = document.createElement('iframe'); f.src = 'https://www.twitch.tv/blank'; f.style.cssText = 'width:1px;height:1px;border:0'; document.body.append(f); return true; })()"))))) return null;
  if (!/drops-stage/.test(await host('__t.active()'))) { fail(`section: the app lost focus on the frame: ${await host('__t.active()')}`); return null; }
  // B with no dialog: back to the rail, and the navigation stops.
  await host('__t.press("B")');
  for (let i = 0; i < 20 && !(await host('__t.rail')); i++) await wait(50);
  if (!(await host('__t.rail')) || calls.close < 1) { fail(`section: B did not go to the rail (rail ${await host('__t.rail')}, close ${calls.close})`); return null; }
  win.destroy();
  server.close && server.close();
  return `stable 5 s idle and after an unfocus/refocus with no app focus events; D-pad ${path_.join(' > ')}; stable through 2 s of sub-frame loads; B to the rail`;
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

  win.destroy();

  // ---- the real Drops section in the app's focus model: stable while idle, and the D-pad moves ----
  const section = await sectionTest();
  if (!section) return;

  console.log(`[drops-smoke] PASS: loading -> ready; 2 campaigns (Jacket 45%, Pet 10%); Claim clicked once each for Hatchet (text) and Banner (attribute), both confirmed, never for Claimed or "Learn how to claim"; same result with other class names and no attributes; a page that ignores the click got one click; sign-in wall seen; frame ${layout.stage[2]}x${layout.stage[3]} zoomed ${zoom} with the hint below; ${targets.length} targets, down walked ${seen.length} with the ring on each and the page scrolled; B asks to leave; section: ${section}`);
  hidden.destroy();
  app.exit(0);
}).catch((e) => fail((e && e.stack) || String(e)));
