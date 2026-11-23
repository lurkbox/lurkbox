import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RaidWatcher } from '../src/js/eventsub.js';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeWS.all.push(this);
  }
  close() { this.closed = true; }
  recv(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
  welcome(id, keepalive = 10) {
    this.recv({ metadata: { message_type: 'session_welcome', message_id: `w-${id}` }, payload: { session: { id, keepalive_timeout_seconds: keepalive } } });
  }
}

let calls;
let nextSub;
const helix = async (path, query, opts = {}) => {
  calls.push({ path, query, method: opts.method || 'GET', body: opts.body, accountId: opts.accountId });
  if (opts.method === 'POST') return { data: [{ id: `sub-${++nextSub}` }] };
  return { data: [] };
};
let accountId = 'A';
const make = () => new RaidWatcher({ helix, WebSocket: FakeWS, isSignedIn: () => true, onSignin: () => {}, getAccountId: () => accountId });
const posts = () => calls.filter((c) => c.method === 'POST');
const deletes = () => calls.filter((c) => c.method === 'DELETE');

beforeEach(() => {
  accountId = 'A';
  FakeWS.all = [];
  calls = [];
  nextSub = 0;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-21T12:00:00Z') });
});
afterEach(() => mock.timers.reset());

test('subscribes to channel.raid with the right body on session_welcome', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  assert.equal(FakeWS.all.length, 1, 'socket opens only when watching');
  assert.match(FakeWS.all[0].url, /^wss:\/\/eventsub\.wss\.twitch\.tv\/ws/);
  assert.equal(posts().length, 0, 'waits for welcome');
  FakeWS.all[0].welcome('sess-1');
  await flush();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, '/eventsub/subscriptions');
  assert.deepEqual(posts()[0].body, {
    type: 'channel.raid',
    version: '1',
    condition: { from_broadcaster_user_id: '111' },
    transport: { method: 'websocket', session_id: 'sess-1' },
  });
  assert.equal(w.status, 'active');
});

test('channel change deletes the old subscription and subscribes the new channel', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  w.watch({ id: '222', login: 'beta' });
  await flush();
  assert.deepEqual(deletes().map((c) => c.query.id), ['sub-1']);
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].body.condition.from_broadcaster_user_id, '222');
  assert.equal(FakeWS.all.length, 1, 'same socket reused');
  w.watch(null);
  await flush();
  assert.deepEqual(deletes().map((c) => c.query.id), ['sub-1', 'sub-2']);
  assert.equal(FakeWS.all[0].closed, true, 'socket closed when nothing is watched');
});

test('session_reconnect moves to the new URL without resubscribing', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  const first = FakeWS.all[0];
  first.welcome('sess-1');
  await flush();
  first.recv({ metadata: { message_type: 'session_reconnect' }, payload: { session: { id: 'sess-1', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } } });
  assert.equal(FakeWS.all.length, 2);
  assert.match(FakeWS.all[1].url, /reconnect=1/);
  FakeWS.all[1].welcome('sess-2');
  await flush();
  assert.equal(first.closed, true, 'old socket closed after the new welcome');
  assert.equal(posts().length, 1, 'no new subscription');
  assert.equal(deletes().length, 0);
});

test('an unexpected close resubscribes on a fresh session', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  FakeWS.all[0].onclose({ code: 1006, reason: '' });
  mock.timers.tick(1000);
  await flush();
  assert.equal(FakeWS.all.length, 2);
  FakeWS.all[1].welcome('sess-3');
  await flush();
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].body.transport.session_id, 'sess-3');
});

test('keepalive watchdog reconnects when Twitch goes quiet', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  FakeWS.all[0].welcome('sess-1', 10);
  await flush();
  mock.timers.tick(10000 + 8000);
  await flush();
  mock.timers.tick(1000);
  await flush();
  assert.equal(FakeWS.all.length, 2, 'fresh socket after keepalive timeout');
});

test('a raid notification for the watched channel emits a raid event once', async () => {
  const w = make();
  const raids = [];
  w.addEventListener('raid', (e) => raids.push(e.detail));
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  const msg = {
    metadata: { message_type: 'notification', message_id: 'n-1', subscription_type: 'channel.raid', message_timestamp: new Date().toISOString() },
    payload: { event: { from_broadcaster_user_id: '111', from_broadcaster_user_login: 'alpha', to_broadcaster_user_id: '333', to_broadcaster_user_login: 'gamma', to_broadcaster_user_name: 'Gamma', viewers: 9 } },
  };
  FakeWS.all[0].recv(msg);
  FakeWS.all[0].recv(msg); // duplicate delivery
  FakeWS.all[0].recv({ ...msg, metadata: { ...msg.metadata, message_id: 'n-2' }, payload: { event: { ...msg.payload.event, from_broadcaster_user_id: '999' } } });
  assert.equal(raids.length, 1);
  assert.equal(raids[0].to_broadcaster_user_login, 'gamma');
});

test('switching account moves the subscription: delete with the old token, resubscribe with the new', async () => {
  const w = make();
  w.watch({ id: '111', login: 'alpha' });
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  assert.equal(posts()[0].accountId, 'A');
  accountId = 'B';
  w.kick();
  await flush();
  assert.deepEqual(deletes().map((c) => [c.query.id, c.accountId]), [['sub-1', 'A']], 'old subscription deleted with the old account');
  assert.equal(FakeWS.all[0].closed, true, 'old session closed');
  assert.equal(FakeWS.all.length, 2);
  FakeWS.all[1].welcome('sess-2');
  await flush();
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].accountId, 'B');
  assert.equal(posts()[1].body.transport.session_id, 'sess-2');
});

test('multi-view: one socket carries a channel.raid subscription per tile; tiles coming and going add and delete them', async () => {
  const w = make();
  const raids = [];
  w.addEventListener('raid', (e) => raids.push(e.detail.from_broadcaster_user_id));
  w.watchMany([{ id: '111', login: 'alpha' }, { id: '222', login: 'beta' }]);
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  assert.equal(FakeWS.all.length, 1, 'one connection for every tile');
  assert.deepEqual(posts().map((c) => c.body.condition.from_broadcaster_user_id), ['111', '222']);
  assert.ok(posts().every((c) => c.body.transport.session_id === 'sess-1'));
  // A third tile, and the first one swapped out (a raid followed in place).
  w.watchMany([{ id: '333', login: 'gamma' }, { id: '222', login: 'beta' }, { id: '444', login: 'delta' }]);
  await flush();
  assert.deepEqual(deletes().map((c) => c.query.id), ['sub-1'], "only alpha's subscription is deleted");
  assert.deepEqual(posts().slice(2).map((c) => c.body.condition.from_broadcaster_user_id), ['333', '444']);
  assert.equal(w.status, 'active');
  // The same set again (in another order) changes nothing.
  w.watchMany([{ id: '444', login: 'delta' }, { id: '333', login: 'gamma' }, { id: '222', login: 'beta' }]);
  await flush();
  assert.equal(posts().length, 4);
  // Raids from any watched tile come through; others don't.
  const note = (id, from) => ({ metadata: { message_type: 'notification', message_id: id, subscription_type: 'channel.raid', message_timestamp: new Date().toISOString() }, payload: { event: { from_broadcaster_user_id: from, to_broadcaster_user_id: '9', to_broadcaster_user_login: 'z' } } });
  FakeWS.all[0].recv(note('n1', '444'));
  FakeWS.all[0].recv(note('n2', '222'));
  FakeWS.all[0].recv(note('n3', '111'));
  assert.deepEqual(raids, ['444', '222']);
  // Back to a single channel (the single player), then nothing.
  w.watch({ id: '222', login: 'beta' });
  await flush();
  assert.deepEqual(deletes().map((c) => c.query.id).sort(), ['sub-1', 'sub-3', 'sub-4']);
  w.watch(null);
  await flush();
  assert.equal(deletes().length, 4);
  assert.equal(FakeWS.all[0].closed, true);
});

test('multi-view: a fresh session resubscribes every tile; a revoked one is retried alone', async () => {
  const w = make();
  w.watchMany([{ id: '111', login: 'alpha' }, { id: '222', login: 'beta' }]);
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  FakeWS.all[0].onclose({ code: 1006, reason: '' });
  mock.timers.tick(1000);
  await flush();
  FakeWS.all[1].welcome('sess-2');
  await flush();
  assert.deepEqual(posts().slice(2).map((c) => [c.body.condition.from_broadcaster_user_id, c.body.transport.session_id]), [['111', 'sess-2'], ['222', 'sess-2']]);
  FakeWS.all[1].recv({ metadata: { message_type: 'revocation' }, payload: { subscription: { id: 'sub-4', status: 'authorization_revoked' } } });
  mock.timers.tick(3000);
  await flush();
  assert.deepEqual(posts().slice(4).map((c) => c.body.condition.from_broadcaster_user_id), ['222'], 'only the revoked one again');
});

test('multi-view: targets past the per-connection cost limit are left out', async () => {
  const w = make();
  w.watchMany(Array.from({ length: 12 }, (_, i) => ({ id: String(100 + i), login: `c${i}` })));
  assert.equal(w.targets.size, 10, 'channel.raid costs 1 each; a WebSocket session allows 10');
  await flush();
  FakeWS.all[0].welcome('sess-1');
  await flush();
  assert.equal(posts().length, 10);
});
