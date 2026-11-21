import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir, json, fakeFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { Twitch, migrateTokens } = require('../../src/main/twitch.js');
const { JsonFile, DEFAULT_SETTINGS } = require('../../src/main/store.js');
const { SCOPES } = require('@lurkbox/core/src/shared/config.js');

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

const acct = (id, token = 'old', refresh = 'rt', extra = {}) => ({ accounts: { [id]: { login: `user${id}`, access_token: token, refresh_token: refresh, ...extra } }, active: id });

function setup(routes, tokens = {}, opts = {}) {
  const dir = tmpDir();
  const tokenFile = new JsonFile(path.join(dir, 'tokens.json'), {});
  tokenFile.replace(tokens);
  const fetch = fakeFetch(routes);
  const tw = new Twitch({ getSettings: () => ({ ...DEFAULT_SETTINGS }), tokens: tokenFile, fetch, ...opts });
  const events = [];
  tw.on('auth', (e) => events.push(e));
  return { tw, fetch, tokenFile, events };
}

const deviceRoute = ['/oauth2/device', () => json(200, { device_code: 'dc', user_code: 'ABCDEFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCDEFGH', expires_in: 1800, interval: 5 })];
const validateOk = (scopes = SCOPES) => ['/oauth2/validate', () => json(200, { client_id: DEFAULT_SETTINGS.clientId, login: 'viewer', user_id: '42', scopes })];

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test('device flow: requests every scope, polls while pending, backs off on slow_down, then succeeds', async () => {
  const replies = [
    json(400, { status: 400, message: 'authorization_pending' }),
    json(400, { status: 400, message: 'slow_down' }),
    json(200, { access_token: 'at', refresh_token: 'rt', scope: SCOPES, expires_in: 3600 }),
  ];
  const { tw, fetch, tokenFile, events } = setup([deviceRoute, ['/oauth2/token', () => replies.shift()], validateOk()]);
  const flow = await tw.startDeviceFlow();
  assert.equal(flow.userCode, 'ABCDEFGH');
  assert.equal(fetch.calls[0].body.scopes, SCOPES.join(' '));
  mock.timers.tick(5000); await flush();
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/token')).length, 1, 'first poll after interval');
  mock.timers.tick(5000); await flush(); // slow_down -> interval becomes 10 s
  mock.timers.tick(5000); await flush();
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/token')).length, 2, 'no poll 5 s after slow_down');
  mock.timers.tick(5000); await flush();
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/token')).length, 3);
  const poll = fetch.calls.find((c) => c.url.endsWith('/token')).body;
  assert.equal(poll.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll.client_id, DEFAULT_SETTINGS.clientId);
  assert.ok(!('client_secret' in poll));
  assert.equal(events.at(-1).status, 'success');
  assert.equal(tokenFile.get().accounts['42'].access_token, 'at');
  assert.equal(tokenFile.get().active, '42');
  assert.equal(tw.state().signedIn, true);
});

test('device flow: expired_token and access_denied end the flow', async () => {
  for (const [message, status] of [['expired_token', 'expired'], ['access_denied', 'denied']]) {
    const { tw, events } = setup([deviceRoute, ['/oauth2/token', () => json(400, { status: 400, message })]]);
    await tw.startDeviceFlow();
    mock.timers.tick(5000); await flush();
    assert.equal(events.at(-1).status, status);
    assert.equal(tw.state().deviceFlow, null);
  }
});

test('Helix 401 refreshes once and retries the request', async () => {
  let helixCalls = 0;
  const { tw, fetch, tokenFile } = setup([
    ['/oauth2/token', (u, i, body) => {
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.client_id, DEFAULT_SETTINGS.clientId);
      assert.ok(!('client_secret' in body));
      return json(200, { access_token: 'new', refresh_token: 'rt2', scope: SCOPES });
    }],
    ['api.twitch.tv/helix', (u, init) => (++helixCalls === 1 ? json(401, { message: 'Invalid OAuth token' }) : json(200, { data: [{ ok: init.headers.Authorization }] }))],
  ], acct('42'));
  const r = await tw.helix({ path: '/streams' });
  assert.equal(helixCalls, 2);
  assert.equal(r.data.data[0].ok, 'Bearer new');
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/token')).length, 1);
  assert.equal(tokenFile.get().accounts['42'].refresh_token, 'rt2');
});

test('a rejected refresh clears tokens and signals sign-in', async () => {
  const states = [];
  const { tw, tokenFile } = setup([
    ['/oauth2/token', () => json(400, { status: 400, message: 'Invalid refresh token' })],
    ['api.twitch.tv/helix', () => json(401, {})],
  ], acct('42', 'old', 'bad'));
  tw.on('state', (s) => states.push(s));
  await assert.rejects(tw.helix({ path: '/streams' }), (e) => e.message === 'NOT_SIGNED_IN' && e.status === 401);
  assert.equal(tokenFile.get().accounts['42'].access_token, null);
  assert.equal(tokenFile.get().accounts['42'].needs_signin, true);
  assert.equal(states.at(-1).signedIn, false);
});

test('a network error during refresh keeps the tokens', async () => {
  const { tw, tokenFile } = setup([
    ['/oauth2/token', () => { throw new TypeError('fetch failed'); }],
    ['/oauth2/validate', () => json(401, {})],
  ], acct('42'));
  await assert.rejects(tw.validate(), /fetch failed/);
  assert.equal(tokenFile.get().accounts['42'].refresh_token, 'rt');
});

test('validate: a token missing any scope needs a new sign-in', async () => {
  const { tw } = setup([validateOk(['user:read:follows'])], acct('42', 'at'));
  assert.equal(await tw.validate(), false);
  const s = tw.state();
  assert.equal(s.signedIn, false);
  assert.equal(s.needsReauth, true);
  const full = setup([validateOk(), ['api.twitch.tv/helix/users', () => json(200, { data: [{ id: '42', display_name: 'Viewer' }] })]], acct('42', 'at'));
  assert.equal(await full.tw.validate(), true);
  assert.equal(full.tw.state().signedIn, true);
  assert.equal(full.tw.state().user.id, '42');
  assert.equal(full.tw.state().user.login, 'viewer');
});

// ---- multi-account ----

test('migration: an old single-token file becomes an account keyed by user id', async () => {
  assert.deepEqual(migrateTokens({ access_token: 'a', refresh_token: 'r', scope: ['x'] }), { accounts: { _legacy: { access_token: 'a', refresh_token: 'r', scopes: ['x'] } }, active: '_legacy' });
  assert.deepEqual(migrateTokens({}), { accounts: {}, active: null });
  const { tw, tokenFile } = setup([validateOk(), ['api.twitch.tv/helix/users', () => json(200, { data: [] })]], { access_token: 'legacy', refresh_token: 'rt' });
  assert.equal(await tw.validate(), true);
  const t = tokenFile.get();
  assert.deepEqual(Object.keys(t.accounts), ['42']);
  assert.equal(t.active, '42');
  assert.equal(t.accounts['42'].access_token, 'legacy');
  assert.equal(t.accounts['42'].login, 'viewer');
});

test('adding an account that already exists updates it instead of duplicating', async () => {
  const swaps = [];
  const { tw, tokenFile } = setup([validateOk(), ['api.twitch.tv/helix/users', () => json(200, { data: [] })]],
    { accounts: { 42: { login: 'viewer', access_token: 'old42' }, 7: { login: 'other', access_token: 't7' } }, active: '7' },
    { onSwitch: async (a, b) => swaps.push(`${a}->${b}`) });
  await tw.addAccount({ access_token: 'new42', refresh_token: 'r42' });
  const t = tokenFile.get();
  assert.deepEqual(Object.keys(t.accounts).sort(), ['42', '7']);
  assert.equal(t.accounts['42'].access_token, 'new42');
  assert.equal(t.active, '42');
  assert.deepEqual(swaps, ['7->42'], 'player cookie jars swapped');
});

test('a failed refresh on one account leaves the others intact', async () => {
  const { tw, tokenFile } = setup([['/oauth2/token', () => json(400, { message: 'Invalid refresh token' })]],
    { accounts: { 1: { login: 'a', access_token: 'x', refresh_token: 'bad' }, 2: { login: 'b', access_token: 'y', refresh_token: 'good' } }, active: '1' });
  assert.equal(await tw.refresh('1'), false);
  const t = tokenFile.get();
  assert.equal(t.accounts['1'].needs_signin, true);
  assert.equal(t.accounts['2'].access_token, 'y');
  assert.equal(t.accounts['2'].refresh_token, 'good');
});

test('removing the active account falls back to another one, then to none (welcome screen)', async () => {
  const { tw, tokenFile } = setup([['/oauth2/revoke', () => json(200, {})]],
    { accounts: { 1: { login: 'a', access_token: 'x' }, 2: { login: 'b', access_token: 'y' } }, active: '1' });
  assert.equal(await tw.removeAccount('1'), '2');
  assert.equal(tokenFile.get().active, '2');
  assert.equal(await tw.removeAccount('2'), null);
  assert.equal(tw.state().signedIn, false);
  assert.deepEqual(tw.state().accounts, []);
});
