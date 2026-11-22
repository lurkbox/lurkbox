'use strict';
// Follow / unfollow against a fixture of a twitch.tv channel page (no account needed), served at the real URL
// (https://www.twitch.tv/somechannel) to a hidden window like the app's: the button is found by data-a-target, by
// aria-label and by text; another channel's button earlier in the page is never pressed; follow flips the button;
// unfollow (confirmed) presses Twitch's dialog too; a page that ignores the click gets one retry; a captcha, a missing
// dialog and another channel's page fail without retry; an already-followed channel is not clicked; no session is inert.
//   npm run test:follow
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, session } = require('electron');
const follow = require('../../src/main/follow');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'channel-page.html'), 'utf8');
const fail = (m) => { console.log(`[follow-smoke] FAIL: ${m}`); app.exit(1); };
let mode = '';
let loads = 0;
const pages = [];

app.on('window-all-closed', () => {}); // the test opens and closes its pages itself
app.whenReady().then(async () => {
  protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'www.twitch.tv' && u.pathname === '/somechannel') {
      loads++;
      return new Response(FIXTURE.replace('<script>', `<script>window.MODE = ${JSON.stringify(mode)};</script><script>`), { headers: { 'content-type': 'text/html' } });
    }
    return new Response('', { status: 404 });
  });
  // As main.js opens it (hidden, same session), but the windows are kept to read the clicks afterwards.
  const openPage = async (url, timeoutMs) => {
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, paintWhenInitiallyHidden: true, webPreferences: { session: session.defaultSession, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    pages.push(w);
    await Promise.race([w.webContents.loadURL(url), new Promise((_r, rej) => setTimeout(() => rej(new Error('load timed out')), timeoutMs))]);
    return { eval: (s) => w.webContents.executeJavaScript(s), close: () => {} };
  };
  const clicks = async () => {
    const out = [];
    for (const w of pages.splice(0)) { out.push(...(await w.webContents.executeJavaScript('window.clicks'))); w.destroy(); }
    return out;
  };
  const run = async (m, action, extra = {}) => {
    mode = m;
    loads = 0;
    const r = await follow.runFollow({ login: 'somechannel', name: 'SomeChannel', action, confirmed: action === 'unfollow', hasSession: async () => true, openPage, readyTimeoutMs: 3000, pollMs: 200, waitMs: 2000, ...extra });
    return { r, clicks: await clicks(), loads };
  };
  const expect = (label, got, r, c, l) => {
    const ok = JSON.stringify(got.r) === JSON.stringify(r) && JSON.stringify(got.clicks) === JSON.stringify(c) && (l == null || got.loads === l);
    if (!ok) fail(`${label}: ${JSON.stringify(got)}; wanted ${JSON.stringify({ r, clicks: c, loads: l })}`);
    return ok;
  };
  const lines = [];
  const T = async (label, m, action, r, c, l) => { if (!expect(label, await run(m, action), r, c, l)) throw new Error('stop'); lines.push(label); };
  try {
    await T('follow by data-a-target', '', 'follow', { ok: true, following: true }, ['follow'], 1);
    await T('follow by aria-label', 'bare', 'follow', { ok: true, following: true }, ['follow'], 1);
    await T('follow by text', 'textonly', 'follow', { ok: true, following: true }, ['follow'], 1);
    await T('follow after a slow render', 'slow', 'follow', { ok: true, following: true }, ['follow'], 1);
    await T('unfollow + Twitch dialog', 'following', 'unfollow', { ok: true, following: false }, ['unfollow', 'confirm'], 1);
    await T('unfollow + dialog by text', 'following,textonly', 'unfollow', { ok: true, following: false }, ['unfollow', 'confirm'], 1);
    await T('already following: no click', 'following', 'follow', { ok: true, following: true, already: true }, [], 1);
    await T('already not following: no click', '', 'unfollow', { ok: true, following: false, already: true }, [], 1);
    await T('stuck: one retry, then timeout', 'stuck', 'follow', { ok: false, reason: 'timeout' }, ['follow', 'follow'], 2);
    await T('captcha: no retry', 'challenge', 'follow', { ok: false, reason: 'challenge' }, ['follow'], 1);
    await T('no dialog: retry, then timeout', 'following,noconfirm', 'unfollow', { ok: false, reason: 'timeout' }, ['unfollow', 'unfollow'], 2);
    await T('another channel\'s header: refused', 'renamed', 'follow', { ok: false, reason: 'wrong-channel' }, [], 1);
    // No session: no page at all.
    loads = 0;
    const none = await follow.runFollow({ login: 'somechannel', action: 'follow', hasSession: async () => false, openPage });
    if (none.reason !== 'no-session' || loads || pages.length) throw new Error(fail(`no session: ${JSON.stringify(none)} loads ${loads}`) || 'stop');
    lines.push('no session: inert');
  } catch (e) {
    if (e.message !== 'stop') fail((e && e.stack) || String(e));
    return;
  }
  console.log(`[follow-smoke] PASS: ${lines.join('; ')}; the other channel's button was never pressed`);
  app.exit(0);
}).catch((e) => fail((e && e.stack) || String(e)));
