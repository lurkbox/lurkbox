'use strict';
// The twitch.tv web session reaches Twitch's chat frame (channel points). The chat is an iframe of Lurkbox's own
// http://localhost page, so twitch.tv is a third party there and Chromium only hands it cookies marked SameSite=None.
// With fake auth-token and login cookies (SameSite=None, Secure, .twitch.tv) and the chat URL served from a fixture:
//   - the chat frame sees both cookies;
//   - the failure mode: a twitch.tv page in a first-party window (like the hidden Drops or follow windows) rewrites
//     auth-token without SameSite (Lax by default), and without the fix the chat frame no longer sees it (signed out);
//   - with keepTwitchCookiesThirdParty() the rewrite is turned back into SameSite=None and the frame sees the new value;
//   - repair() fixes the chat frame's cookies that were already Lax at startup (and ones a jar restore wrote as Lax),
//     leaves other twitch.tv cookies as they are, host-only stays host-only, and the scan's authCookie diagnostic reports what the frame sees.
//   npm run test:points-cookies
const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const { keepTwitchCookiesThirdParty, CookieJar } = require('../../src/main/player-session');
const points = require('../../src/main/channel-points');

// Demo-style network block: nothing leaves the machine (localhost is the page host, https is served below).
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost');
const fail = (m) => { console.log(`[points-cookies] FAIL: ${m}`); app.exit(1); };
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const CHAT = 'https://www.twitch.tv/embed/somechannel/chat?parent=localhost&darkpopout';
const year = () => Math.floor(Date.now() / 1000) + 365 * 86400;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const ses = session.fromPartition('points-cookies');
    const log = [];
    ses.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      if (u.hostname !== 'www.twitch.tv') return new Response('', { status: 404 });
      // A first-party twitch.tv page whose script writes auth-token the way a site script does: no SameSite.
      if (u.pathname === '/drops/inventory') {
        return new Response('<script>document.cookie = "auth-token=rewritten; domain=.twitch.tv; path=/; secure; max-age=86400"; document.title = "written";</script>', { headers: { 'content-type': 'text/html' } });
      }
      return new Response('<div data-test-selector="community-points-summary"><button aria-label="Bits and Points Balances"><span data-test-selector="copo-balance-string">1,234</span></button></div>', { headers: { 'content-type': 'text/html' } });
    });
    const server = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(`<iframe src="${CHAT}"></iframe>`); }).listen(0, '127.0.0.1');
    await new Promise((r) => server.on('listening', r));
    const PAGE = `http://localhost:${server.address().port}/`;
    const host = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
    /** What the chat frame's scripts see: cookie names → values, and the points scan's diagnostic. */
    const frameView = async () => {
      await host.webContents.loadURL(PAGE);
      for (let i = 0; i < 40 && !host.webContents.mainFrame.frames[0]; i++) await wait(50);
      const f = host.webContents.mainFrame.frames.find((x) => points.isChatFrameUrl(x.url, 'somechannel'));
      if (!f) throw new Error('no chat frame');
      const jar = Object.fromEntries((await f.executeJavaScript('document.cookie')).split(/;\s*/).filter(Boolean).map((p) => p.split('=')));
      const scan = await f.executeJavaScript(points.scanSource({ autoClaim: false }));
      return { jar, scan };
    };
    const firstPartyWrite = async () => {
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
      await w.loadURL('https://www.twitch.tv/drops/inventory');
      await wait(300);
      w.destroy();
    };
    const authCookie = async () => (await ses.cookies.get({ name: 'auth-token' }))[0];
    const setSession = async (sameSite = 'no_restriction') => {
      for (const [name, value] of [['auth-token', 'fake-token'], ['login', 'lurker']]) {
        await ses.cookies.set({ url: 'https://www.twitch.tv/', domain: '.twitch.tv', path: '/', name, value, secure: true, httpOnly: false, sameSite, expirationDate: year() });
      }
    };

    // 1. A signed-in session (SameSite=None, Secure): the chat frame gets it.
    await setSession();
    let v = await frameView();
    if (v.jar['auth-token'] !== 'fake-token' || v.jar.login !== 'lurker') return fail(`frame cookies ${JSON.stringify(Object.keys(v.jar))}`);
    if (v.scan.authCookie !== true || !v.scan.signedIn || v.scan.balanceText !== '1,234') return fail(`scan ${JSON.stringify(v.scan)}`);

    // 2. The failure mode, without the fix: a first-party page rewrites auth-token (Lax by default) and the frame loses it.
    await firstPartyWrite();
    const lax = await authCookie();
    if (!lax || lax.value !== 'rewritten' || lax.sameSite === 'no_restriction') return fail(`first-party write ${JSON.stringify(lax && { v: lax.value, s: lax.sameSite })}`);
    v = await frameView();
    if ('auth-token' in v.jar) return fail('a Lax auth-token still reached the third-party frame; the failure mode is not reproduced');
    if (v.scan.authCookie !== false) return fail(`authCookie diagnostic ${v.scan.authCookie}`);

    // 3. repair(): the startup fix. Host-only cookies stay host-only.
    await ses.cookies.set({ url: 'https://www.twitch.tv/', name: 'persistent', value: '1', secure: false, sameSite: 'lax', expirationDate: year() });
    // A twitch.tv cookie the chat frame doesn't need keeps its SameSite.
    await ses.cookies.set({ url: 'https://www.twitch.tv/', name: 'experiment_overrides', value: '1', domain: '.twitch.tv', secure: true, sameSite: 'lax', expirationDate: year() });
    const keeper = keepTwitchCookiesThirdParty(ses.cookies, (l) => log.push(l));
    const fixed = await keeper.repair();
    if (!fixed.some((n) => n.startsWith('auth-token(')) || !fixed.some((n) => n.startsWith('persistent(')) || fixed.some((n) => n.startsWith('experiment_overrides('))) return fail(`repair fixed ${fixed}`);
    const other = (await ses.cookies.get({ name: 'experiment_overrides' }))[0];
    if (!other || other.sameSite !== 'lax') return fail(`an unneeded cookie was changed: ${JSON.stringify(other && other.sameSite)}`);
    const ho = (await ses.cookies.get({ name: 'persistent' }))[0];
    if (!ho || ho.sameSite !== 'no_restriction' || !ho.secure || !ho.hostOnly) return fail(`host-only cookie ${JSON.stringify(ho)}`);
    if ((await ses.cookies.get({ name: 'auth-token' })).length !== 1) return fail('two auth-token cookies after the repair');
    v = await frameView();
    if (v.jar['auth-token'] !== 'rewritten' || v.jar.login !== 'lurker') return fail(`frame after repair ${JSON.stringify(v.jar)}`);

    // 4. Kept so: the next first-party rewrite is turned back into SameSite=None at once.
    await ses.cookies.set({ url: 'https://www.twitch.tv/', domain: '.twitch.tv', path: '/', name: 'auth-token', value: 'fake-token', secure: true, sameSite: 'no_restriction', expirationDate: year() });
    await firstPartyWrite();
    await wait(200);
    const kept = await authCookie();
    if (!kept || kept.value !== 'rewritten' || kept.sameSite !== 'no_restriction' || !kept.secure) return fail(`after a rewrite ${JSON.stringify(kept && { v: kept.value, s: kept.sameSite })}`);
    if (!log.some((l) => /auth-token was written SameSite=(lax|unspecified)/.test(l))) return fail(`no log line: ${JSON.stringify(log)}`);
    if (log.some((l) => /rewritten|fake-token|lurker/.test(l))) return fail('a cookie value reached the log');
    v = await frameView();
    if (v.jar['auth-token'] !== 'rewritten') return fail('the frame lost auth-token after a kept rewrite');

    // 5. A jar restore that brings back Lax cookies is fixed too.
    const lists = [{ name: 'auth-token', value: 'from-jar', domain: '.twitch.tv', path: '/', secure: true, httpOnly: false, expirationDate: year(), sameSite: 'lax' }];
    const jar = new CookieJar({ cookies: ses.cookies, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }, dir: app.getPath('temp') });
    require('fs').writeFileSync(jar.file('42'), JSON.stringify(lists));
    await jar.restore('42');
    jar.remove('42');
    await wait(200);
    const restored = await authCookie();
    if (!restored || restored.value !== 'from-jar' || restored.sameSite !== 'no_restriction') return fail(`after a jar restore ${JSON.stringify(restored && { v: restored.value, s: restored.sameSite })}`);
    v = await frameView();
    if (v.jar['auth-token'] !== 'from-jar') return fail('the frame did not get the restored auth-token');

    keeper.stop();
    server.close();
    console.log('[points-cookies] PASS: the chat frame gets SameSite=None cookies; a Lax rewrite hides them (reproduced) and is repaired at startup and kept SameSite=None afterwards, also after a jar restore');
    app.exit(0);
  } catch (e) {
    fail(e.stack || e.message);
  }
});
