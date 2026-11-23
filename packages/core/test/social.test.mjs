// Subscriptions and blocked users (src/js/social.js): tier mapping, batched and cached sub checks, the block list,
// the chat filter and confirm-before-block. Also the demo mode answers for both (demo/helix.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierLabel, tierBadge, parseSubscription, subDetail, SubChecker, parseBlocks, BlockList, hideFromChat, confirmBlock, confirmUnblock,
} from '../src/js/social.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';

const httpError = (status, resetAt) => Object.assign(new Error(`HTTP ${status}`), { status, resetAt });
const subRes = (id, tier = '1000', gift = null) => ({ data: [{ broadcaster_id: id, broadcaster_login: `ch${id}`, broadcaster_name: `Ch${id}`, tier, is_gift: !!gift, gifter_login: gift ? gift.toLowerCase() : '', gifter_name: gift || '' }] });

test('tier mapping: 1000/2000/3000 → Tier 1/2/3, badge text, anything else "Subscribed"', () => {
  assert.equal(tierLabel('1000'), 'Tier 1');
  assert.equal(tierLabel('2000'), 'Tier 2');
  assert.equal(tierLabel(3000), 'Tier 3');
  assert.equal(tierLabel(''), 'Subscribed');
  assert.equal(tierLabel(undefined), 'Subscribed');
  assert.deepEqual(['1000', '2000', '3000', 'x'].map(tierBadge), ['Sub', 'Sub T2', 'Sub T3', 'Sub']);
});

test('parseSubscription: tier, gift and gifter; empty answers are null', () => {
  const s = parseSubscription(subRes('7', '2000', 'SnackGoblin'));
  assert.deepEqual(s, { broadcasterId: '7', login: 'ch7', name: 'Ch7', tier: '2000', tierLabel: 'Tier 2', isGift: true, gifter: { login: 'snackgoblin', name: 'SnackGoblin' } });
  assert.equal(subDetail(s), 'Tier 2 · gifted by SnackGoblin');
  const own = parseSubscription(subRes('8'));
  assert.equal(own.gifter, null);
  assert.equal(subDetail(own), 'Tier 1');
  assert.equal(subDetail(parseSubscription({ data: [{ broadcaster_id: '9', tier: '1000', is_gift: true }] })), 'Tier 1 · gifted');
  assert.equal(parseSubscription({ data: [] }), null);
  assert.equal(parseSubscription(null), null);
});

/** A fake Helix for /subscriptions/user: subscribed to `subs` (id → tier), 404 for the rest; records concurrency. */
function subHelix(subs, { fail = new Set(), rateLimitOnce = new Set() } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const fn = async (path, q) => {
    calls.push(q.broadcaster_id);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--;
    assert.equal(path, '/subscriptions/user');
    if (rateLimitOnce.delete(q.broadcaster_id)) throw httpError(429, '0');
    if (fail.has(q.broadcaster_id)) throw httpError(500);
    if (subs[q.broadcaster_id]) return subRes(q.broadcaster_id, subs[q.broadcaster_id]);
    throw httpError(404);
  };
  fn.calls = calls;
  fn.peak = () => peak;
  return fn;
}

test('SubChecker: checks each channel once, at most `concurrency` at a time, with gaps; 404 means not subscribed', async () => {
  const helix = subHelix({ 2: '1000', 5: '3000' });
  const sleeps = [];
  const c = new SubChecker({ helix, concurrency: 2, gapMs: 250, sleep: async (ms) => { sleeps.push(ms); } });
  const results = [];
  const found = await c.checkAll('me', ['1', '2', '3', '4', '5', '2', 6], { onResult: (id, s) => results.push([id, s ? s.tier : null]) });
  assert.deepEqual([...found.keys()].sort(), ['2', '5']);
  assert.equal(found.get('5').tierLabel, 'Tier 3');
  assert.deepEqual(helix.calls.sort(), ['1', '2', '3', '4', '5', '6'], 'deduplicated');
  assert.equal(helix.peak(), 2, 'never more than 2 requests at once');
  assert.ok(sleeps.length >= 4 && sleeps.every((ms) => ms === 250), 'spaced out');
  assert.equal(results.length, 6);
  assert.deepEqual(results.find(([id]) => id === '1'), ['1', null], 'the 404 is a quiet "no"');
});

test('SubChecker: answers (yes and no) are cached for an hour per account; errors are not cached', async () => {
  let now = 1_000_000;
  const helix = subHelix({ 2: '2000' }, { fail: new Set(['3']) });
  const c = new SubChecker({ helix, now: () => now, sleep: async () => {}, gapMs: 0 });
  await c.checkAll('me', ['1', '2', '3']);
  assert.equal(helix.calls.length, 3);
  assert.equal(c.cached('me', '1'), null);
  assert.equal(c.cached('me', '2').tier, '2000');
  assert.equal(c.cached('me', '3'), undefined, 'a 500 is unknown, not "no"');
  assert.equal(c.cached('other', '2'), undefined, 'per account');
  assert.deepEqual([...c.known('me').keys()], ['2']);

  now += 59 * 60 * 1000;
  const seen = [];
  await c.checkAll('me', ['1', '2', '3'], { onResult: (id, s) => seen.push([id, !!s]) });
  assert.deepEqual(helix.calls.slice(3), ['3'], 'only the unknown one is asked again');
  assert.deepEqual(seen.slice(0, 2), [['1', false], ['2', true]], 'cached answers are reported at once');

  now += 2 * 60 * 1000; // past the hour
  await c.checkAll('me', ['1', '2']);
  assert.deepEqual(helix.calls.slice(4).sort(), ['1', '2']);
});

test('SubChecker: a 429 pauses and retries that channel once', async () => {
  const helix = subHelix({ 1: '1000' }, { rateLimitOnce: new Set(['1']) });
  const sleeps = [];
  let now = 5000;
  const c = new SubChecker({ helix, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, gapMs: 0 });
  const s = await c.check('me', '1');
  assert.equal(s.tier, '1000');
  assert.deepEqual(helix.calls, ['1', '1']);
  assert.ok(sleeps[0] >= 1000 && sleeps[0] <= 60000, 'waited before the retry');
});

test('SubChecker: cancelled() stops the batch', async () => {
  const helix = subHelix({});
  const c = new SubChecker({ helix, concurrency: 1, sleep: async () => {}, gapMs: 0 });
  let n = 0;
  await c.checkAll('me', ['1', '2', '3', '4'], { onResult: () => { n++; }, cancelled: () => n >= 2 });
  assert.equal(helix.calls.length, 2);
});

test('parseBlocks: user_id/login/display name; junk rows dropped', () => {
  assert.deepEqual(parseBlocks({ data: [{ user_id: '1', user_login: 'a', display_name: 'A' }, { user_login: 'nobody' }, { user_id: 2, user_login: 'b' }] }), [
    { id: '1', login: 'a', name: 'A' }, { id: '2', login: 'b', name: 'b' },
  ]);
  assert.deepEqual(parseBlocks(null), []);
});

test('BlockList: loads every page, then block (PUT) and unblock (DELETE) keep it in step and notify', async () => {
  const calls = [];
  const pages = { '': { data: [{ user_id: '1', user_login: 'a', display_name: 'A' }], pagination: { cursor: 'p2' } }, p2: { data: [{ user_id: '2', user_login: 'b', display_name: 'B' }], pagination: {} } };
  const helix = async (path, q, opts = {}) => { calls.push([opts.method || 'GET', path, q]); return (opts.method ? null : pages[q.after || '']); };
  const list = new BlockList({ helix });
  let changes = 0;
  list.subscribe(() => changes++);
  await list.load('me');
  assert.deepEqual(list.items.map((b) => b.id), ['1', '2']);
  assert.ok(list.has('2') && list.has(2) && !list.has('3'));
  assert.deepEqual(calls.map((c) => c[2].broadcaster_id), ['me', 'me']);
  await list.load('me'); // fresh: no new request
  assert.equal(calls.length, 2);

  await list.block({ id: '3', login: 'c', name: 'C' });
  assert.deepEqual(calls[2], ['PUT', '/users/blocks', { target_user_id: '3', source_context: 'chat', reason: undefined }]);
  assert.ok(list.has('3'));
  await list.unblock({ id: '1', name: 'A' });
  assert.deepEqual(calls[3], ['DELETE', '/users/blocks', { target_user_id: '1' }]);
  assert.deepEqual(list.items.map((b) => b.id), ['3', '2']);
  assert.ok(changes >= 3);

  await list.load('someone-else'); // switching accounts starts over
  assert.equal(calls[4][2].broadcaster_id, 'someone-else');
});

test('chat filter: hides blocked users only while the setting is on', () => {
  const blocked = new Set(['42']);
  assert.equal(hideFromChat({ userId: '42' }, blocked, true), true);
  assert.equal(hideFromChat({ userId: '42' }, blocked, false), false);
  assert.equal(hideFromChat({ userId: '7' }, blocked, true), false);
  assert.equal(hideFromChat({ userId: '' }, blocked, true), false);
  assert.equal(hideFromChat(null, blocked, true), false);
});

/** A BlockList over a fake Helix, and a confirm that answers `answer`. */
function blockRig(answer) {
  const sent = [];
  const list = new BlockList({ helix: async (path, q, opts = {}) => { sent.push([opts.method || 'GET', q.target_user_id]); return { data: [] }; } });
  const dialogs = [];
  const toasts = [];
  const confirm = (d) => { dialogs.push(d); queueMicrotask(() => (answer === 'yes' ? d.onYes() : d.onNo())); };
  return { list, sent, dialogs, toasts, deps: { confirm, list, toast: (m) => toasts.push(m) } };
}

test('confirm before block: Cancel sends nothing; Yes sends PUT once', async () => {
  const no = blockRig('no');
  assert.equal(await confirmBlock({ id: '9', login: 'troll', name: 'Troll' }, no.deps), false);
  assert.deepEqual(no.sent, []);
  assert.equal(no.dialogs[0].title, 'Block Troll?');
  assert.equal(no.list.has('9'), false);

  const yes = blockRig('yes');
  assert.equal(await confirmBlock({ id: '9', login: 'troll', name: 'Troll' }, yes.deps), true);
  assert.deepEqual(yes.sent, [['PUT', '9']]);
  assert.ok(yes.list.has('9'));
  assert.deepEqual(yes.toasts, ['Blocked Troll']);
});

test('confirm before unblock too', async () => {
  const no = blockRig('no');
  no.list.set([{ id: '9', login: 'troll', name: 'Troll' }]);
  assert.equal(await confirmUnblock({ id: '9', name: 'Troll' }, no.deps), false);
  assert.deepEqual(no.sent, []);
  const yes = blockRig('yes');
  yes.list.set([{ id: '9', login: 'troll', name: 'Troll' }]);
  assert.equal(await confirmUnblock({ id: '9', name: 'Troll' }, yes.deps), true);
  assert.deepEqual(yes.sent, [['DELETE', '9']]);
  assert.equal(yes.list.has('9'), false);
});

test('demo mode: subscriptions one channel at a time (404 otherwise) and a block list that blocks and unblocks', async () => {
  const db = buildDemoData();
  const me = db.accounts[0].id;
  const h = (path, query, method = 'GET') => demoHelix(db, { path, query, method }, { activeId: me });
  const helix = async (path, query, opts = {}) => { const r = h(path, query, opts.method); if (r.ok) return r.data; throw httpError(r.status); };
  const checker = new SubChecker({ helix, sleep: async () => {}, gapMs: 0 });
  const found = await checker.checkAll(me, db.follows.map((f) => f.broadcaster_id));
  const byLogin = new Map([...found.values()].map((s) => [s.login, s]));
  assert.deepEqual([...byLogin.keys()].sort(), ['lofilighthouse', 'mossykeyboard', 'pixelmoth', 'teaandtiles', 'velvetvoxel']);
  assert.equal(subDetail(byLogin.get('mossykeyboard')), 'Tier 2 · gifted by SnackGoblin');
  assert.equal(byLogin.get('velvetvoxel').tierLabel, 'Tier 3');
  assert.equal(h('/subscriptions/user', { broadcaster_id: db.follows[1].broadcaster_id, user_id: me }).status, 404);
  assert.equal(h('/subscriptions/user', { broadcaster_id: db.follows[0].broadcaster_id, user_id: 'someone' }).status, 403);

  const list = new BlockList({ helix });
  await list.load(me);
  assert.deepEqual(list.items.map((b) => b.name), ['CaffeineCrab', 'spamtastic_bot', 'GrumbleWhisker'], 'two to a page, all pages loaded');
  await list.block({ id: '8000010', login: 'noodle_arms', name: 'noodle_arms' });
  await list.unblock({ id: '8100001' });
  await list.load(me, { maxAgeMs: 0 });
  assert.deepEqual(list.items.map((b) => b.name), ['noodle_arms', 'CaffeineCrab', 'GrumbleWhisker'], 'the demo remembers both changes');
});
