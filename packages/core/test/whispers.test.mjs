// Whispers: the Helix request and what its answers mean, the EventSub watcher, the stored history (caps, one list per
// account), the service that ties them together, and demo mode's fakes.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWhisperRequest, interpretWhisperResult, whisperAuthState, whisperFromEvent, whisperLimit, sanitizeWhisperThreads,
  addWhisper, markThreadRead, updateWhisper, unreadCount, storeWhispers, loadWhispers, WhisperGate, whisperWaitText,
  WHISPER_MAX_THREADS, WHISPER_MAX_MESSAGES, WHISPER_MAX_NEW, WHISPER_MAX_REPLY, WHISPER_SCOPE,
} from '../src/shared/whispers.js';
import { SCOPES } from '../src/shared/config.js';
import { WhisperWatcher } from '../src/js/eventsub.js';
import { WhisperService, onWhisperSent } from '../src/js/whispers.js';
import { buildDemoData, DEMO_NOW } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';
import { demoWhisperThreads, demoIncomingEvent, demoReplyEvent, NO_WHISPERS_LOGIN } from '../src/js/demo/whispers.js';
import { demoWebSocket } from '../src/js/demo/install.js';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const ev = (over = {}) => ({
  from_user_id: '7100004', from_user_login: 'pixelmoth', from_user_name: 'PixelMoth', to_user_id: '1000001', to_user_login: 'lurker', to_user_name: 'lurker',
  whisper_id: 'w-1', whisper: { text: ' hi there ' }, ...over,
});
const fail = (status, message, extra = {}) => ({ ok: false, status, error: 'x', data: { message }, resetAt: null, ...extra });

// ---- the request and its answers ----

test('the send request: POST /whispers with from/to in the query and the trimmed message in the body', () => {
  assert.deepEqual(buildWhisperRequest({ fromId: 1000001, toId: '7100004', message: '  hey  ' }), {
    path: '/whispers', method: 'POST', query: { from_user_id: '1000001', to_user_id: '7100004' }, body: { message: 'hey' },
  });
  assert.deepEqual(buildWhisperRequest({ fromId: '1', toId: '2', message: '  ' }), { error: 'empty' });
  assert.deepEqual(buildWhisperRequest({ fromId: null, toId: '2', message: 'a' }), { error: 'not-signed-in' });
  assert.deepEqual(buildWhisperRequest({ fromId: '1', toId: 'bob', message: 'a' }), { error: 'no-recipient' });
  assert.deepEqual(buildWhisperRequest({ fromId: '1', toId: '1', message: 'a' }), { error: 'self' });
});

test('the length limit: 500 to someone new, 10,000 once they have whispered you (Twitch\'s rule)', () => {
  assert.equal(whisperLimit(null), WHISPER_MAX_NEW);
  assert.equal(whisperLimit({ messages: [{ me: true, text: 'a', at: 1 }] }), 500, 'only your own messages: still new');
  assert.equal(whisperLimit({ messages: [{ me: false, text: 'a', at: 1 }] }), WHISPER_MAX_REPLY);
  assert.deepEqual(buildWhisperRequest({ fromId: '1', toId: '2', message: 'a'.repeat(501) }), { error: 'too-long', limit: 500 });
  assert.ok(buildWhisperRequest({ fromId: '1', toId: '2', message: 'a'.repeat(501), limit: 10000 }).body);
  assert.ok(buildWhisperRequest({ fromId: '1', toId: '2', message: '😀'.repeat(500) }).body, 'code points, so an emoji is one');
  assert.equal(buildWhisperRequest({ fromId: '1', toId: '2', message: 'a'.repeat(10001), limit: 10000 }).error, 'too-long');
});

test('Helix answers → what the user sees (Twitch\'s documented errors)', () => {
  assert.deepEqual(interpretWhisperResult({ ok: true, status: 204, data: null }), { ok: true });
  assert.equal(interpretWhisperResult(fail(401, 'The user in the from_user_id query parameter must have a verified phone number.')).kind, 'phone');
  assert.match(interpretWhisperResult(fail(401, 'must have a verified phone number')).reason, /verified phone/);
  assert.equal(interpretWhisperResult(fail(401, 'Invalid OAuth token')).kind, 'auth');
  assert.equal(interpretWhisperResult(fail(401, 'Missing scope: user:manage:whispers')).kind, 'auth');
  assert.equal(interpretWhisperResult({ ok: false, status: 0, error: 'NOT_SIGNED_IN', data: null }).kind, 'auth');
  assert.equal(interpretWhisperResult(fail(403, 'The user that you\'re sending the whisper to doesn\'t allow whisper messages.')).kind, 'blocked');
  assert.equal(interpretWhisperResult(fail(400, 'The recipient has Block Whispers from Strangers on')).kind, 'blocked');
  assert.equal(interpretWhisperResult(fail(403, '')).kind, 'blocked');
  assert.equal(interpretWhisperResult(fail(404, 'The ID in to_user_id was not found.')).kind, 'not-found');
  assert.equal(interpretWhisperResult(fail(400, 'The message contains words that Twitch\'s moderation settings block.')).kind, 'rejected');
  const rate = interpretWhisperResult(fail(429, 'Too many', { resetAt: 1800000000 }));
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAt, 1800000000 * 1000);
  assert.match(rate.reason, /40 new people a day/);
  assert.equal(interpretWhisperResult(fail(429, ''), 5000).retryAt, 15000, 'no Ratelimit-Reset: 10 s');
  assert.equal(interpretWhisperResult(fail(500, '')).kind, 'error');
  assert.equal(interpretWhisperResult(null).kind, 'error');
});

test('the scope: requested at sign-in; a token without it asks for the sign-in again', () => {
  assert.ok(SCOPES.includes(WHISPER_SCOPE));
  const user = { id: '1', login: 'a' };
  assert.equal(whisperAuthState({ signedIn: true, user, missingScopes: [] }), 'ok');
  assert.equal(whisperAuthState({ signedIn: true, user, missingScopes: ['user:manage:whispers'] }), 'reauth');
  assert.equal(whisperAuthState({ signedIn: false, user: null }), 'signed-out');
});

test('the local gate: 3 a second, 100 a minute, 40 new people a day', () => {
  const g = new WhisperGate();
  for (let i = 0; i < 3; i++) { assert.ok(g.check({ now: 1000, to: '2' }).ok); g.mark({ now: 1000, to: '2' }); }
  assert.equal(g.check({ now: 1500, to: '2' }).why, 'second');
  assert.ok(g.check({ now: 2001, to: '2' }).ok);
  const m = new WhisperGate();
  for (let i = 0; i < 100; i++) m.mark({ now: i * 400, to: '2' });
  assert.equal(m.check({ now: 40000, to: '2' }).why, 'minute');
  const d = new WhisperGate();
  for (let i = 0; i < 40; i++) d.mark({ now: i * 2000, to: String(100 + i) });
  assert.ok(d.check({ now: 100000, to: '100' }).ok, 'someone already whispered today');
  const no = d.check({ now: 100000, to: '999' });
  assert.equal(no.why, 'recipients');
  assert.match(whisperWaitText(no), /40 new people/);
  assert.ok(d.check({ now: 86400000 + 1000, to: '999' }).ok, 'a day later');
  const b = new WhisperGate();
  b.block(9000);
  assert.equal(b.check({ now: 5000, to: '2' }).why, 'rate');
});

// ---- EventSub ----

test('an EventSub event → the peer and the message, only for this account', () => {
  const got = whisperFromEvent(ev(), '1000001', 42);
  assert.deepEqual(got, { peer: { id: '7100004', login: 'pixelmoth', name: 'PixelMoth' }, message: { id: 'w-1', me: false, text: 'hi there', at: 42 } });
  assert.equal(whisperFromEvent(ev(), '1000002'), null, 'another account');
  assert.equal(whisperFromEvent(ev({ whisper: { text: '  ' } }), '1000001'), null);
  assert.equal(whisperFromEvent(ev({ from_user_id: 'x' }), '1000001'), null);
  assert.equal(whisperFromEvent(null, '1'), null);
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.closed = false; FakeWS.all.push(this); }
  close() { this.closed = true; }
  recv(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}
const note = (type, event, id = 'n-1') => ({ metadata: { message_type: 'notification', message_id: id, subscription_type: type, message_timestamp: new Date().toISOString() }, payload: { event } });

test('WhisperWatcher: its own socket, user.whisper.message with user_id = you, events for you only', async () => {
  FakeWS.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-22T12:00:00Z') });
  try {
    const calls = [];
    const helix = async (path, query, opts = {}) => { calls.push({ path, query, ...opts }); return opts.method === 'POST' ? { data: [{ id: 'sub-w' }] } : { data: [] }; };
    const w = new WhisperWatcher({ helix, WebSocket: FakeWS, isSignedIn: () => true, onSignin: () => {}, getAccountId: () => '1000001' });
    const got = [];
    w.addEventListener('whisper', (e) => got.push(e.detail));
    w.watch({ id: '1000001', login: 'lurker' });
    await flush();
    FakeWS.all[0].recv({ metadata: { message_type: 'session_welcome', message_id: 'w' }, payload: { session: { id: 'sess-w', keepalive_timeout_seconds: 10 } } });
    await flush();
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body, { type: 'user.whisper.message', version: '1', condition: { user_id: '1000001' }, transport: { method: 'websocket', session_id: 'sess-w' } });
    assert.equal(w.status, 'active');
    FakeWS.all[0].recv(note('user.whisper.message', ev()));
    FakeWS.all[0].recv(note('user.whisper.message', ev(), 'n-1')); // a repeated delivery
    FakeWS.all[0].recv(note('channel.raid', { from_broadcaster_user_id: '1000001' }, 'n-2'));
    FakeWS.all[0].recv(note('user.whisper.message', ev({ to_user_id: '5' }), 'n-3'));
    assert.equal(got.length, 1);
    assert.equal(got[0].whisper_id, 'w-1');
    // Reconnects like the raid watcher: a dropped socket comes back and subscribes again.
    FakeWS.all[0].onclose({ code: 1006 });
    mock.timers.tick(1100);
    await flush();
    assert.equal(FakeWS.all.length, 2);
    w.watch(null);
    await flush();
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.query.id === 'sub-w') || FakeWS.all[1].closed);
  } finally { mock.timers.reset(); }
});

// ---- storage ----

const msg = (i, me = false) => ({ id: `m${i}`, me, text: `message ${i}`, at: 1000 + i });

test('storage caps: 200 messages a thread (the newest), 50 threads (the newest), one thread per person', () => {
  const big = { id: '7', login: 'x', name: 'X', unread: 0, at: 0, messages: Array.from({ length: 250 }, (_, i) => msg(i)) };
  const [t] = sanitizeWhisperThreads([big]);
  assert.equal(t.messages.length, WHISPER_MAX_MESSAGES);
  assert.equal(t.messages[0].id, 'm50');
  assert.equal(t.at, 1249);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: String(100 + i), login: '', name: `u${i}`, unread: 0, at: 5000 + i, messages: [msg(i)] }));
  const kept = sanitizeWhisperThreads(many);
  assert.equal(kept.length, WHISPER_MAX_THREADS);
  assert.equal(kept[0].id, '159', 'newest first');
  assert.ok(!kept.some((x) => x.id === '100'), 'the oldest go');
  assert.equal(sanitizeWhisperThreads([many[0], many[0]]).length, 1);
  assert.deepEqual(sanitizeWhisperThreads([{ id: 'bad' }, null, { id: '1', messages: [] }]), []);
  // addWhisper keeps the caps too, and moves the thread to the top.
  let list = kept;
  list = addWhisper(list, { id: '100', login: 'u0', name: 'U0' }, { id: 'new', me: false, text: 'back!', at: 99999 }, { unread: true });
  assert.equal(list.length, 50);
  assert.equal(list[0].id, '100');
  assert.equal(list[0].unread, 1);
  assert.equal(unreadCount(list), 1);
  assert.equal(addWhisper(list, { id: '100' }, { id: 'new', me: false, text: 'back!', at: 99999 }), list, 'the same whisper twice');
  list = markThreadRead(list, '100');
  assert.equal(unreadCount(list), 0);
  list = updateWhisper(list, '100', 'new', { failed: 'nope' });
  assert.equal(list[0].messages.at(-1).failed, 'nope');
  assert.equal(sanitizeWhisperThreads(list)[0].messages.at(-1).failed, 'nope', 'kept when stored');
});

test('storage is per account: each account sees only its own threads; bad ids are refused', () => {
  const a = [{ id: '7', login: 'x', name: 'X', unread: 1, at: 1, messages: [msg(1)] }];
  const b = [{ id: '8', login: 'y', name: 'Y', unread: 0, at: 1, messages: [msg(2, true)] }];
  let data = storeWhispers(null, '1000001', a);
  data = storeWhispers(data, '1000002', b);
  assert.deepEqual(loadWhispers(data, '1000001').map((t) => t.id), ['7']);
  assert.deepEqual(loadWhispers(data, '1000002').map((t) => t.id), ['8']);
  assert.deepEqual(loadWhispers(data, '1000003'), []);
  assert.deepEqual(storeWhispers(data, '../etc', a), data, 'not an account id');
  assert.deepEqual(loadWhispers(data, 'anon'), []);
  data = storeWhispers(data, '1000001', []);
  assert.deepEqual(Object.keys(data.accounts), ['1000002'], 'clearing forgets only that account');
});

// ---- the service ----

function harness() {
  const stored = {};
  const helixCalls = [];
  let helixAnswer = { ok: true, status: 204, data: null };
  globalThis.window = {
    lurkbox: {
      whispersLoad: async (id) => loadWhispers(stored, id),
      whispersSave: async (id, threads) => { Object.assign(stored, storeWhispers(stored, id, threads)); return true; },
      helix: async (req) => { helixCalls.push(req); return helixAnswer; },
    },
  };
  const watcher = new EventTarget();
  watcher.watching = [];
  watcher.watch = (t) => watcher.watching.push(t);
  let auth = { signedIn: true, user: { id: '1000001', login: 'lurker' }, missingScopes: [], active: '1000001' };
  let authCb = null;
  let now = DEMO_NOW;
  const svc = new WhisperService({ watcher, getAuth: () => auth, now: () => now, onAuth: (cb) => { authCb = cb; } });
  return {
    svc, watcher, stored, helixCalls,
    setAnswer: (r) => { helixAnswer = r; },
    setAuth: async (a) => { auth = a; authCb(); await flush(); },
    tick: (ms) => { now += ms; },
    incoming: (over) => watcher.dispatchEvent(new CustomEvent('whisper', { detail: ev(over) })),
  };
}

beforeEach(() => { delete globalThis.window; });
afterEach(() => { delete globalThis.window; });

test('the service: watches the signed-in account, stores incoming whispers per account, unread unless open', async () => {
  const h = harness();
  await h.svc.sync();
  assert.deepEqual(h.watcher.watching.at(-1), { id: '1000001', login: 'lurker' });
  const seen = [];
  h.svc.addEventListener('incoming', (e) => seen.push(e.detail));
  h.incoming();
  await flush();
  assert.equal(h.svc.unread(), 1);
  assert.equal(seen[0].open, false);
  assert.deepEqual(loadWhispers(h.stored, '1000001').map((t) => t.id), ['7100004']);
  h.svc.setOpen('7100004');
  assert.equal(h.svc.unread(), 0, 'opening the thread reads it');
  h.incoming({ whisper_id: 'w-2', whisper: { text: 'and again' } });
  assert.equal(h.svc.unread(), 0, 'the open thread stays read');
  assert.equal(seen[1].open, true);
  // Another account: its own (empty) history, and the watcher follows it.
  await h.setAuth({ signedIn: true, user: { id: '1000002', login: 'couchcritter' }, missingScopes: [], active: '1000002' });
  assert.deepEqual(h.svc.threads, []);
  assert.deepEqual(h.watcher.watching.at(-1), { id: '1000002', login: 'couchcritter' });
  h.incoming({ whisper_id: 'w-3' }); // to 1000001: not this account's
  assert.deepEqual(h.svc.threads, []);
  await h.setAuth({ signedIn: true, user: { id: '1000001', login: 'lurker' }, missingScopes: [], active: '1000001' });
  assert.equal(h.svc.thread('7100004').messages.length, 2, 'back to the first account: its history');
  // Without the scope: no subscription.
  await h.setAuth({ signedIn: true, user: { id: '1000001', login: 'lurker' }, missingScopes: ['user:manage:whispers'], active: '1000001' });
  assert.equal(h.watcher.watching.at(-1), null);
  assert.equal(h.svc.authState(), 'reauth');
  assert.equal((await h.svc.send({ id: '7100004' }, 'hi')).kind, 'auth');
});

test('the service: sending adds the message at once; a refusal marks it "not sent"; Clear empties the account', async () => {
  const h = harness();
  await h.svc.sync();
  const sent = [];
  const off = onWhisperSent((d) => sent.push(d));
  const peer = { id: '7100004', login: 'pixelmoth', name: 'PixelMoth' };
  const r = await h.svc.send(peer, ' hello ');
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(h.helixCalls[0], { path: '/whispers', method: 'POST', query: { from_user_id: '1000001', to_user_id: '7100004' }, body: { message: 'hello' } });
  assert.equal(h.svc.thread('7100004').messages[0].me, true);
  assert.deepEqual(sent, [{ from: { id: '1000001', login: 'lurker' }, to: '7100004', text: 'hello' }]);
  assert.equal(h.svc.limitFor('7100004'), 500, 'they never whispered: 500');
  assert.equal((await h.svc.send(peer, 'a'.repeat(501))).kind, 'too-long');
  h.setAnswer(fail(401, 'The user in the from_user_id query parameter must have a verified phone number.'));
  h.tick(2000);
  const bad = await h.svc.send(peer, 'second');
  assert.equal(bad.kind, 'phone');
  const last = h.svc.thread('7100004').messages.at(-1);
  assert.equal(last.text, 'second');
  assert.match(last.failed, /verified phone/);
  assert.match(loadWhispers(h.stored, '1000001')[0].messages.at(-1).failed, /verified phone/, 'stored as failed');
  h.setAnswer(fail(429, '', { resetAt: Math.ceil((DEMO_NOW + 60000) / 1000) }));
  h.tick(2000);
  assert.equal((await h.svc.send(peer, 'third')).kind, 'rate');
  h.tick(1000);
  assert.equal((await h.svc.send(peer, 'fourth')).kind, 'cooldown', 'the 429 blocks sending until Ratelimit-Reset');
  h.incoming();
  assert.equal(h.svc.limitFor('7100004'), 10000, 'after their whisper: 10,000');
  await h.svc.clear();
  assert.deepEqual(h.svc.threads, []);
  assert.deepEqual(loadWhispers(h.stored, '1000001'), []);
  off();
});

// ---- demo mode ----

test('demo mode: POST /whispers answers like Helix; the seeded history and fake events fit the core', () => {
  const db = buildDemoData({ media: (p) => `lbhls://demo/${p}` });
  const me = db.accounts[0].id;
  const send = (to, message, from = me) => demoHelix(db, { path: '/whispers', method: 'POST', query: { from_user_id: from, to_user_id: to }, body: { message } }, { activeId: me });
  const moth = db.users.find((u) => u.login === 'pixelmoth');
  assert.deepEqual(send(moth.id, 'hi'), { ok: true, status: 204, data: null });
  assert.equal(interpretWhisperResult(send(moth.id, '  ')).kind, 'rejected');
  assert.equal(interpretWhisperResult(send('9999999', 'hi')).kind, 'not-found');
  assert.equal(interpretWhisperResult(send(db.users.find((u) => u.login === NO_WHISPERS_LOGIN).id, 'hi')).kind, 'blocked');
  assert.equal(interpretWhisperResult(send(moth.id, 'hi', '1000002')).kind, 'auth');
  for (let i = 0; i < 39; i++) db.whispersSent.add(`90000${i}`); // 40 people today, with PixelMoth
  assert.ok(send(moth.id, 'again').ok, 'someone already whispered today');
  const other = db.users.find((u) => u.login === 'slowfoxruns');
  assert.equal(interpretWhisperResult(send(other.id, 'hey')).kind, 'rate', 'a 41st person: 429');
  assert.equal(demoHelix(db, { path: '/whispers', method: 'GET' }, { activeId: me }).status, 404);
  // The seeded history is valid as stored, with one unread thread.
  const threads = demoWhisperThreads(db, me, DEMO_NOW);
  assert.deepEqual(sanitizeWhisperThreads(threads), threads);
  assert.equal(unreadCount(threads), 1);
  assert.deepEqual(demoWhisperThreads(db, null), []);
  // The fake incoming whisper and the reply are events the core takes.
  assert.equal(whisperFromEvent(demoIncomingEvent(db, me), me).peer.login, 'nightowlnoodles');
  const reply = whisperFromEvent(demoReplyEvent(db, { from: db.accounts[0], to: moth.id, text: 'hi', n: 1 }), me);
  assert.equal(reply.peer.id, moth.id);
  assert.equal(demoReplyEvent(db, { from: db.accounts[0], to: '1', text: 'x', n: 1 }), null);
});

test('demo mode: the fake EventSub socket delivers whisper notifications to the whisper watcher', async () => {
  const timers = [];
  const eventsubs = new Set();
  const WS = demoWebSocket({ roomIdOf: () => null, chat: { paused: true, intervalMs: 1000 }, eventsubs, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  const calls = [];
  const helix = async (path, query, opts = {}) => { calls.push(opts.body); return opts.method === 'POST' ? { data: [{ id: 'demo-sub' }] } : { data: [] }; };
  const w = new WhisperWatcher({ helix, WebSocket: WS, isSignedIn: () => true, onSignin: () => {}, getAccountId: () => '1000001' });
  const got = [];
  w.addEventListener('whisper', (e) => got.push(e.detail));
  w.watch({ id: '1000001', login: 'lurker' });
  await flush();
  timers.splice(0).forEach((fn) => fn()); // open + welcome
  await flush();
  assert.equal(calls.filter(Boolean)[0].type, 'user.whisper.message');
  assert.equal(eventsubs.size, 1);
  const db = buildDemoData();
  for (const s of eventsubs) s.notify('user.whisper.message', demoIncomingEvent(db, '1000001'));
  assert.equal(got.length, 1);
  assert.equal(got[0].from_user_login, 'nightowlnoodles');
  w.disconnect();
  assert.equal(eventsubs.size, 0, 'closed sockets leave the set');
});
