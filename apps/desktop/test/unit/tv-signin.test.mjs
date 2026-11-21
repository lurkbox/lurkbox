import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tmpDir, json, fakeFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { TvSignIn, planSignIn, LOGIN_URL } = require('../../src/main/tv-signin.js');
const { Twitch } = require('../../src/main/twitch.js');
const { CookieJar, playerStatus } = require('../../src/main/player-session.js');
const { JsonFile, DEFAULT_SETTINGS } = require('../../src/main/store.js');
const { SCOPES } = require('@lurkbox/core/src/shared/config.js');

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

/** Electron-like session.cookies with 'changed' events. */
function fakeCookies(initial = []) {
  const em = new EventEmitter();
  let list = initial.map((c) => ({ path: '/', secure: true, domain: '.twitch.tv', ...c }));
  return Object.assign(em, {
    list: () => list,
    async get(filter = {}) {
      if (filter.url) {
        const host = new URL(filter.url).hostname;
        return list.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain.startsWith('.') ? c.domain : `.${c.domain}`));
      }
      return [...list];
    },
    async remove(url, name) {
      const host = new URL(url).hostname;
      const gone = list.filter((c) => c.name === name && c.domain.replace(/^\./, '') === host);
      list = list.filter((c) => !gone.includes(c));
      for (const c of gone) em.emit('changed', {}, c, 'explicit', true);
    },
    async set(c) {
      const { url, ...rest } = c;
      list = list.filter((x) => !(x.name === rest.name && x.domain === rest.domain));
      const cookie = { path: '/', ...rest };
      list.push(cookie);
      em.emit('changed', {}, cookie, 'explicit', false);
    },
  });
}
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
const webLogin = (cookies, login) => Promise.all([
  cookies.set({ url: 'https://www.twitch.tv/', name: 'login', value: login, domain: '.twitch.tv' }),
  cookies.set({ url: 'https://www.twitch.tv/', name: 'auth-token', value: `SECRET-${login}`, domain: '.twitch.tv' }),
]);
const cookiesFor = (login) => [{ name: 'auth-token', value: `SECRET-${login}` }, { name: 'login', value: login }];

const USERS = { viewer: '42', alice: '111', bob: '222' };

/**
 * A Lurkbox main process in miniature: Twitch (real) on a fake id.twitch.tv, a real CookieJar on fake cookies, and a
 * scripted login window. `script.login` is who signs in on twitch.tv/login; `script.authorizeAs` is who Twitch says
 * authorized (normally the web session's user); `script.closeAt` closes the window at 'login' or 'activate'.
 */
function world({ tokens = {}, cookies: initial = [], script = {} } = {}) {
  const dir = tmpDir();
  const tokenFile = new JsonFile(path.join(dir, 'tokens.json'), {});
  tokenFile.replace(tokens);
  const cookies = fakeCookies(initial);
  const jar = new CookieJar({ cookies, safeStorage: fakeSafe, dir: path.join(dir, 'jars') });
  let authorized = null;
  const fetch = fakeFetch([
    ['/oauth2/device', () => json(200, { device_code: 'dc', user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH', expires_in: 1800, interval: 1 })],
    ['/oauth2/token', (u, i, body) => {
      if (body.grant_type === 'refresh_token') return json(400, { message: 'Invalid refresh token' });
      return authorized ? json(200, { access_token: `at-${authorized}`, refresh_token: 'rt', scope: SCOPES, expires_in: 3600 }) : json(400, { message: 'authorization_pending' });
    }],
    ['/oauth2/validate', (u, init) => {
      const login = String(init.headers.Authorization).replace('OAuth at-', '');
      return USERS[login] ? json(200, { client_id: DEFAULT_SETTINGS.clientId, login, user_id: USERS[login], scopes: SCOPES }) : json(401, {});
    }],
    ['/oauth2/revoke', () => json(200, {})],
    ['api.twitch.tv/helix/users', () => json(200, { data: [] })],
  ]);
  const twitch = new Twitch({
    getSettings: () => ({ ...DEFAULT_SETTINGS }), tokens: tokenFile, fetch,
    onSwitch: async (from, to) => { if (from && /^\d+$/.test(from)) await jar.save(from); if (to) await jar.restore(to); },
  });
  const loads = [];
  const openWindow = () => {
    let resolveClosed;
    const w = {
      closed: new Promise((r) => { resolveClosed = r; }),
      close: () => resolveClosed(),
      load: (url) => {
        loads.push(url);
        const stage = url === LOGIN_URL ? 'login' : 'activate';
        if (script.closeAt === stage) { setTimeout(() => resolveClosed(), 0); return; }
        if (stage === 'login') setTimeout(() => webLogin(cookies, script.login || 'viewer'), 0);
        // The user presses Authorize on the consent page (never clicked for them).
        else setTimeout(() => { authorized = script.authorizeAs || 'viewer'; }, 0);
      },
    };
    return w;
  };
  const signin = new TvSignIn({ twitch, jar, cookies, openWindow, settleMs: 0 });
  const approve = (login) => { authorized = login; }; // approval on another device (phone flow)
  return { twitch, cookies, jar, signin, loads, fetch, tokenFile, dir, approve };
}

/** Runs a promise to completion while advancing the fake clock. */
async function drive(p) {
  let done = false;
  let out;
  p.then((v) => { done = true; out = v; }, (e) => { done = true; out = e; });
  for (let i = 0; i < 50 && !done; i++) { await flush(); mock.timers.tick(1000); }
  await flush();
  assert.ok(done, 'flow did not finish');
  return out;
}

test('plan: add → full-clear; no web session → full; same user → consent; other user → full-clear', () => {
  assert.equal(planSignIn({ add: true, webLogin: 'viewer' }), 'full-clear');
  assert.equal(planSignIn({ webLogin: null }), 'full');
  assert.equal(planSignIn({ webLogin: 'viewer' }), 'consent');
  assert.equal(planSignIn({ webLogin: 'Viewer', targetLogin: 'viewer' }), 'consent');
  assert.equal(planSignIn({ webLogin: 'alice', targetLogin: 'viewer' }), 'full-clear');
});

test('one sign-in: twitch.tv login → device code → activate page → token → validate → logins match', async () => {
  const w = world({ script: { login: 'viewer' } });
  const r = await drive(w.signin.run());
  assert.deepEqual({ ok: r.ok, login: r.login, id: r.id, plan: r.plan }, { ok: true, login: 'viewer', id: '42', plan: 'full' });
  assert.deepEqual(w.loads, [LOGIN_URL, 'https://www.twitch.tv/activate?device-code=ABCDEFGH']);
  assert.ok(w.fetch.calls.findIndex((c) => c.url.includes('/oauth2/device')) >= 0);
  const st = w.twitch.state();
  assert.equal(st.signedIn, true);
  assert.equal(st.user.login, 'viewer');
  assert.deepEqual(await playerStatus(w.cookies), { signedIn: true, login: 'viewer' }, 'player signed in as the same account');
  assert.equal(w.jar.peekLogin('42'), 'viewer', 'web session saved to the account jar');
});

test('the web login and the authorized account must match; a mismatch signs both out', async () => {
  const w = world({ script: { login: 'viewer', authorizeAs: 'bob' } });
  const r = await drive(w.signin.run());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mismatch');
  assert.match(r.message, /viewer.*bob/);
  assert.equal(w.twitch.state().signedIn, false);
  assert.equal(w.twitch.store().accounts['222'], undefined, 'the new, mismatched account is not kept');
  assert.equal((await playerStatus(w.cookies)).signedIn, false);
  assert.ok(w.fetch.calls.some((c) => c.url.includes('/oauth2/revoke')), 'the mismatched token is revoked');
});

test('re-auth with a valid web session for that account needs only the Authorize page', async () => {
  const tokens = { accounts: { 42: { login: 'viewer', access_token: null, refresh_token: null, needs_signin: true } }, active: '42' };
  const w = world({ tokens, cookies: cookiesFor('viewer') });
  const r = await drive(w.signin.run({ accountId: '42' }));
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'consent');
  assert.deepEqual(w.loads, ['https://www.twitch.tv/activate?device-code=ABCDEFGH']);
  assert.equal(w.twitch.state().signedIn, true);
});

test('re-auth when the web session is gone (or someone else) runs the full flow', async () => {
  const tokens = { accounts: { 42: { login: 'viewer', access_token: null, refresh_token: null, needs_signin: true } }, active: '42' };
  const gone = world({ tokens });
  assert.equal((await drive(gone.signin.run())).plan, 'full');
  assert.equal(gone.loads[0], LOGIN_URL);

  const other = world({ tokens, cookies: cookiesFor('alice'), script: { login: 'viewer' } });
  const r = await drive(other.signin.run());
  assert.equal(r.plan, 'full-clear');
  assert.equal(r.ok, true);
  assert.equal((await playerStatus(other.cookies)).login, 'viewer');
});

test('add account: saves the current jar, starts signed out of twitch.tv, and both jars survive', async () => {
  const tokens = { accounts: { 111: { login: 'alice', access_token: 'at-alice', refresh_token: 'rt' } }, active: '111' };
  const w = world({ tokens, cookies: cookiesFor('alice'), script: { login: 'bob', authorizeAs: 'bob' } });
  const r = await drive(w.signin.run({ add: true }));
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'full-clear');
  assert.equal(w.loads[0], LOGIN_URL, 'login page starts signed out');
  assert.equal(w.jar.peekLogin('111'), 'alice', "alice's player session kept in her jar");
  assert.equal(w.jar.peekLogin('222'), 'bob');
  assert.equal(w.twitch.store().active, '222');
  assert.equal((await playerStatus(w.cookies)).login, 'bob');
  await drive(w.twitch.switchAccount('111'));
  assert.equal((await playerStatus(w.cookies)).login, 'alice', 'switching back restores alice');
});

test('add account cancelled (window closed) restores the current account\'s player session', async () => {
  const tokens = { accounts: { 111: { login: 'alice', access_token: 'at-alice', refresh_token: 'rt' } }, active: '111' };
  for (const closeAt of ['login', 'activate']) {
    const w = world({ tokens, cookies: cookiesFor('alice'), script: { login: 'bob', closeAt } });
    const r = await drive(w.signin.run({ add: true }));
    assert.equal(r.cancelled, true, closeAt);
    assert.equal(w.twitch.store().active, '111');
    assert.equal(w.twitch.state().deviceFlow, null);
    assert.equal((await playerStatus(w.cookies)).login, 'alice', `alice is back after closing at ${closeAt}`);
  }
});

test('phone fallback (code on another device) leaves the new account\'s player signed out', async () => {
  const tokens = { accounts: { 111: { login: 'alice', access_token: 'at-alice', refresh_token: 'rt' } }, active: '111' };
  const w = world({ tokens, cookies: cookiesFor('alice') });
  const success = new Promise((res) => w.twitch.on('auth', (e) => { if (e.status === 'success') res(e); }));
  await w.twitch.startDeviceFlow(); // the phone flow: no window, cookies swap as on any account switch
  w.approve('bob');
  const ev = await drive(success);
  assert.equal(ev.user.login, 'bob');
  assert.equal(w.twitch.store().active, '222');
  assert.equal((await playerStatus(w.cookies)).signedIn, false, 'player signed out for bob, so the app offers the TV login');
  assert.equal(w.jar.peekLogin('111'), 'alice', "alice's player session saved");
  assert.equal(w.loads.length, 0, 'no login window');
});
