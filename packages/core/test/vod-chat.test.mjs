import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentsBody, commentEvent, parseComments, fetchComments, VodChatReplay, COMMENTS_HASH } from '../src/shared/vod-chat.js';
import { demoComments } from '../src/js/demo/vod-chat.js';
import { tokenize } from '../src/js/chat-emotes.js';

const node = (id, offset, fragments, extra = {}) => ({
  id, contentOffsetSeconds: offset, commenter: { id: '42', login: 'Viewer', displayName: 'Viewer' },
  message: { fragments, userBadges: [{ setID: 'subscriber', version: '12' }, { setID: '', version: '' }], userColor: '#FF7F50' }, ...extra,
});

test('the request: persisted by offset or cursor, the plain query as the fallback', () => {
  assert.deepEqual(commentsBody({ videoId: 5, offset: 61.7 }).variables, { videoID: '5', contentOffsetSeconds: 61 });
  assert.equal(commentsBody({ videoId: 5, offset: 1 }).extensions.persistedQuery.sha256Hash, COMMENTS_HASH);
  assert.deepEqual(commentsBody({ videoId: 5, cursor: 'abc' }).variables, { videoID: '5', cursor: 'abc' });
  const plain = commentsBody({ videoId: 5, offset: 0, persisted: false });
  assert.match(plain.query, /comments\(contentOffsetSeconds: \$contentOffsetSeconds, after: \$cursor\)/);
  assert.equal(plain.extensions, undefined);
});

test('a comment becomes the live chat\'s message event: text, emote ranges in code points, badges, colour', () => {
  const ev = commentEvent(node('c1', 61, [{ text: '😀 hi ' }, { text: 'Kappa', emote: { emoteID: '25', from: 5 } }, { text: ' and ' }, { text: 'Kappa', emote: { emoteID: '25' } }]), '99');
  assert.equal(ev.text, '😀 hi Kappa and Kappa');
  assert.equal(ev.emotes, '25:5-9,15-19');
  assert.equal(ev.badges, 'subscriber/12');
  assert.equal(ev.color, '#FF7F50');
  assert.equal(ev.nick, 'Viewer');
  assert.equal(ev.login, 'viewer');
  assert.equal(ev.roomId, '99');
  assert.equal(ev.offset, 61);
  // The live chat's tokenizer puts the emote where the IRC tag would.
  const parts = tokenize(ev.text, ev.emotes, { enabled: () => true, get: () => null }, {});
  assert.equal(parts.filter((p) => p.type === 'emote' || p.emote).length, 2);
  const me = commentEvent(node('c2', 3, [{ text: '\u0001ACTION waves\u0001' }]));
  assert.equal(me.action, true);
  assert.equal(me.text, 'waves');
  assert.equal(commentEvent(node('c3', 3, [])), null);
  assert.equal(commentEvent(node('c4', 3, [{ text: 'x' }], { message: { fragments: [{ text: 'x' }], userColor: 'red' } })).color, '');
});

test('a page: sorted events, the cursor to go on, not found, errors', () => {
  const json = { data: { video: { id: '5', creator: { id: '99' }, comments: { edges: [{ cursor: 'a', node: node('2', 9, [{ text: 'b' }]) }, { cursor: 'b', node: node('1', 4, [{ text: 'a' }]) }], pageInfo: { hasNextPage: true } } } } };
  const r = parseComments(json);
  assert.deepEqual(r.comments.map((c) => c.id), ['1', '2']);
  assert.equal(r.cursor, 'b');
  assert.equal(r.hasNext, true);
  assert.equal(r.roomId, '99');
  assert.deepEqual(parseComments({ data: { video: null } }), { ok: false, reason: 'not-found' });
  assert.equal(parseComments({ errors: [{ message: 'boom' }] }).reason, 'boom');
});

test('fetchComments: the persisted query, then the plain one when Twitch forgot the hash; bad ids refused', async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.extensions) return { ok: true, json: async () => ({ errors: [{ message: 'PersistedQueryNotFound' }] }) };
    return { ok: true, json: async () => demoComments({ videoId: '5', offset: 0 }) };
  };
  const r = await fetchComments({ fetch, videoId: '5', offset: 0 });
  assert.equal(r.ok, true);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].query);
  assert.deepEqual(await fetchComments({ fetch, videoId: 'x' }), { ok: false, reason: 'bad request' });
  const down = await fetchComments({ fetch: async () => ({ ok: false, status: 503 }), videoId: '5' });
  assert.equal(down.ok, false);
});

/** The replay over the demo's comments (every 2.5 s, 25 a page). */
function replay({ load = null, ...opts } = {}) {
  const shown = [];
  const loads = [];
  const notes = [];
  let resets = 0;
  let t = 0;
  const r = new VodChatReplay({
    load: async (req) => { loads.push(req); return load ? load(req) : parseComments(demoComments({ videoId: '5', durationSec: 600, ...req })); },
    onMessage: (ev) => shown.push(ev.offset),
    onReset: () => { resets++; shown.length = 0; },
    onNote: (n) => notes.push(n),
    now: () => t,
    ...opts,
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res)); };
  return { r, shown, loads, notes, settle, resets: () => resets, advance: (ms) => { t += ms; } };
}

test('replay: the last 20 s at once, then each comment when the video reaches it, never ahead', async () => {
  const x = replay();
  x.r.tick(120);
  await x.settle();
  assert.deepEqual(x.loads[0], { offset: 100 });
  assert.ok(x.shown.length >= 8);
  assert.ok(Math.min(...x.shown) >= 100 && Math.max(...x.shown) <= 120);
  const n = x.shown.length;
  x.r.tick(121);
  x.r.tick(122.6);
  await x.settle();
  assert.ok(x.shown.length > n);
  assert.ok(Math.max(...x.shown) <= 122.6);
  // Ahead: the next pages by cursor while less than 40 s are buffered.
  for (let p = 123; p < 200; p += 1) { x.r.tick(p); await x.settle(); }
  assert.ok(x.loads.some((l) => l.cursor), 'read on by cursor');
  assert.ok(x.r.ahead.every((c) => c.offset > 199));
  assert.ok(x.r.ahead.length <= 1500);
  assert.deepEqual([...x.shown], [...x.shown].sort((a, b) => a - b), 'in order');
});

test('replay: paused, nothing new; a seek back or far ahead starts over there', async () => {
  const x = replay();
  x.r.tick(60);
  await x.settle();
  const n = x.shown.length;
  x.r.tick(60, true);
  x.r.tick(60, true);
  await x.settle();
  assert.equal(x.shown.length, n);
  x.r.tick(30); // back
  await x.settle();
  assert.equal(x.resets(), 2);
  assert.ok(Math.max(...x.shown) <= 30);
  x.r.tick(500); // far ahead
  await x.settle();
  assert.equal(x.resets(), 3);
  assert.ok(Math.min(...x.shown) >= 480 && Math.max(...x.shown) <= 500);
  // A page that comes back after a newer seek is dropped.
  let release;
  const slow = replay({ load: (req) => (req.offset === 0 ? new Promise((r) => { release = () => r(parseComments(demoComments({ videoId: '5', ...req }))); }) : parseComments(demoComments({ videoId: '5', ...req }))) });
  slow.r.tick(10);
  slow.r.tick(300);
  await slow.settle();
  release();
  await slow.settle();
  assert.ok(slow.shown.every((o) => o >= 280));
});

test('replay: no replay for the video, and errors retried after a backoff with one note', async () => {
  const none = replay({ load: async () => ({ ok: false, reason: 'not-found' }) });
  none.r.tick(10);
  await none.settle();
  assert.deepEqual(none.notes, ['This video has no chat replay.']);
  none.advance(120000);
  none.r.tick(11);
  await none.settle();
  assert.equal(none.loads.length, 1, 'not asked again');
  let fail = true;
  const flaky = replay({ load: async (req) => (fail ? { ok: false, reason: 'GQL HTTP 503' } : parseComments(demoComments({ videoId: '5', ...req }))) });
  flaky.r.tick(50);
  await flaky.settle();
  assert.match(flaky.notes[0], /unavailable right now/);
  flaky.r.tick(50.5);
  await flaky.settle();
  assert.equal(flaky.loads.length, 1, 'waits out the backoff');
  fail = false;
  flaky.advance(5000);
  flaky.r.tick(51);
  await flaky.settle();
  assert.deepEqual(flaky.loads[1], { offset: 30 }, 'the same first page again');
  assert.ok(flaky.shown.length > 0);
});
