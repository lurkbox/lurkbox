import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir, json, fakeFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { parsePage, fetchNotifySettings, writeExport, NotifyExporter, edgeNotify } = require('../../src/main/notify-export.js');

const edge = (id, login, opts = {}) => ({ cursor: `c${id}`, node: { id, login }, ...opts });
const page = (edges, hasNextPage = false, user = { id: '42', login: 'Me' }) => ({
  data: { currentUser: { ...user, follows: { edges, pageInfo: { hasNextPage } } } },
});

test('edgeNotify prefers notificationSettings.isEnabled, then disableNotifications', () => {
  assert.equal(edgeNotify({ notificationSettings: { isEnabled: false }, disableNotifications: false }), false);
  assert.equal(edgeNotify({ notificationSettings: { isEnabled: true }, disableNotifications: true }), true);
  assert.equal(edgeNotify({ notificationSettings: null, disableNotifications: true }), false);
  assert.equal(edgeNotify({ disableNotifications: false }), true);
  assert.equal(edgeNotify({}), null);
});

test('parsePage reads channels, defaults a missing setting to on, skips bad nodes', () => {
  const p = parsePage(page([
    edge('1', 'Alpha', { notificationSettings: { isEnabled: true } }),
    edge('2', 'beta', { disableNotifications: true }),
    edge('3', 'gamma'),
    { cursor: 'x', node: null },
    { cursor: 'y', node: { id: 'abc', login: 'bad' } },
  ], true));
  assert.equal(p.ok, true);
  assert.equal(p.userId, '42');
  assert.equal(p.login, 'me');
  assert.deepEqual(p.channels, [
    { id: '1', login: 'alpha', notify: true },
    { id: '2', login: 'beta', notify: false },
    { id: '3', login: 'gamma', notify: true },
  ]);
  assert.equal(p.hasNext, true);
  assert.equal(p.cursor, 'y');
});

test('parsePage reports errors without a user, and integrity failures on follows', () => {
  assert.deepEqual(parsePage({ data: { currentUser: null } }), { ok: false, reason: 'not signed in' });
  assert.equal(parsePage(null).ok, false);
  const r = parsePage({ errors: [{ message: 'failed integrity check' }], data: { currentUser: { id: '42', login: 'me', follows: null } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'failed integrity check');
});

test('fetchNotifySettings pages with the cursor and sends the web Client-ID and OAuth header', async () => {
  let n = 0;
  const fetch = fakeFetch([['gql.twitch.tv', () => {
    n++;
    return n === 1 ? json(200, page([edge('1', 'a')], true)) : json(200, page([edge('2', 'b', { disableNotifications: true })], false));
  }]]);
  const r = await fetchNotifySettings({ fetch, authToken: 'tok' });
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.channels.length, 2);
  assert.equal(fetch.calls[0].headers['Client-ID'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
  assert.equal(fetch.calls[0].headers.Authorization, 'OAuth tok');
});

test('fetchNotifySettings keeps a partial result when a later page fails', async () => {
  let n = 0;
  const bodies = [];
  const fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    if (n === 1) return json(200, page([edge('1', 'a')], true));
    return json(200, { errors: [{ message: 'failed integrity check' }], data: { currentUser: { id: '42', login: 'me', follows: null } } });
  };
  const r = await fetchNotifySettings({ fetch, authToken: 'tok' });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.match(r.reason, /integrity/);
  assert.deepEqual(r.channels, [{ id: '1', login: 'a', notify: true }]);
  assert.equal(bodies[0].variables.cursor, null);
  assert.equal(bodies[1].variables.cursor, 'c1');
});

test('fetchNotifySettings without a token or with a network error does nothing', async () => {
  assert.equal((await fetchNotifySettings({ fetch: () => { throw new Error('no'); }, authToken: null })).ok, false);
  const r = await fetchNotifySettings({ fetch: async () => { throw new Error('ENOTFOUND'); }, authToken: 't' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /network/);
});

test('writeExport writes the documented shape atomically with mode 0600', () => {
  const file = path.join(tmpDir(), 'sub', 'notify-channels.json');
  writeExport(file, { userId: 42, login: 'me', complete: true, channels: [{ id: '1', login: 'a', notify: 1 }] }, Date.UTC(2026, 10, 21));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data, { updated_at: '2026-11-21T00:00:00.000Z', user_id: '42', login: 'me', complete: true, channels: [{ id: '1', login: 'a', notify: true }] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['notify-channels.json']);
});

test('NotifyExporter.runOnce writes when signed in, leaves the file alone when not, never logs the token', async () => {
  const file = path.join(tmpDir(), 'notify-channels.json');
  const logs = [];
  let token = 'secret-token';
  const ex = new NotifyExporter({
    fetch: async () => json(200, page([edge('1', 'a', { notificationSettings: { isEnabled: false } })])),
    getAuthToken: async () => token,
    file,
    log: (l) => logs.push(l),
  });
  const d = await ex.runOnce();
  assert.equal(d.channels[0].notify, false);
  assert.ok(fs.existsSync(file));
  token = null;
  assert.equal(await ex.runOnce(), null);
  assert.ok(fs.existsSync(file));
  assert.ok(!logs.join('\n').includes('secret-token'));
});
