import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PP_QUERY, PP_OPERATION, ppBody, ppQuery, parsePrediction, parsePoll, parsePredictionsPolls, PredictionsWatcher, RESULT_MS,
  fmtPoints, fmtLeft, predictionStatus, myBetLine, pollStatus, canBetOn, payout, betPresets, stepBet, compactLine,
  predictSource, pollVoteSource,
} from '../src/shared/predictions.js';
import { createDemoPredictions } from '../src/js/demo/predictions.js';

const NOW = Date.parse('2026-11-23T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const event = (over = {}) => ({
  id: 'ev1', title: 'Win this round?', status: 'ACTIVE', createdAt: iso(NOW - 60000), predictionWindowSeconds: 120,
  lockedAt: null, endedAt: null, winningOutcome: null,
  outcomes: [{ id: 'o1', title: 'Yes', color: 'BLUE', totalPoints: 3000, totalUsers: 3 }, { id: 'o2', title: 'No', color: 'PINK', totalPoints: 1000, totalUsers: 1 }],
  self: null,
  ...over,
});
const poll = (over = {}) => ({
  id: 'p1', title: 'Next map?', status: 'ACTIVE', remainingDurationMilliseconds: 45000, endedAt: null,
  choices: [{ id: 'c1', title: 'Dust', votes: { total: 6 } }, { id: 'c2', title: 'Mirage', votes: { total: 2 } }],
  votes: { total: 8 }, settings: { communityPointsVotes: { isEnabled: true, cost: 250 } },
  ...over,
});
const answer = ({ active = [], locked = [], resolved = [], viewablePoll = null } = {}) => ({
  data: { channel: { id: '1', activePredictionEvents: active, lockedPredictionEvents: locked, resolvedPredictionEvents: { edges: resolved.map((node) => ({ node })) } }, user: { viewablePoll } },
});

test('the request: one named query, only for valid logins; signed in first, signed out after a 401', async () => {
  assert.equal(ppBody('bad login!'), null);
  const body = JSON.parse(ppBody('SomeOne'));
  assert.equal(body.operationName, PP_OPERATION);
  assert.equal(body.query, PP_QUERY);
  assert.deepEqual(body.variables, { login: 'someone' });
  assert.ok(!/mutation/i.test(PP_QUERY));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init.headers.Authorization || null);
    return init.headers.Authorization ? { ok: false, status: 401 } : { ok: true, status: 200, json: async () => answer() };
  };
  const r = await ppQuery({ fetch, login: 'someone', authToken: 'tok' });
  assert.deepEqual(calls, ['OAuth tok', null]);
  assert.ok(r.data);
  await assert.rejects(ppQuery({ fetch: async () => ({ ok: false, status: 500 }), login: 'someone' }), /500/);
});

test('predictions: shares, Twitch\'s 1:x return, the end of the window, your bet, the result', () => {
  const p = parsePrediction(event({ self: { prediction: { points: 200, outcome: { id: 'o2' }, result: null } } }));
  assert.equal(p.status, 'active');
  assert.equal(p.total, 4000);
  assert.equal(p.users, 4);
  assert.deepEqual(p.outcomes.map((o) => [o.percent, o.ratio, o.color]), [[75, 1.33, 'blue'], [25, 4, 'pink']]);
  assert.equal(p.endsAt, NOW + 60000);
  assert.deepEqual(p.mine, { outcomeId: 'o2', points: 200, result: null });
  assert.equal(predictionStatus(p, NOW), 'Predictions close in 1:00');
  assert.equal(myBetLine(p), 'Your prediction: 200 points on No');
  assert.ok(canBetOn({ ...p, endsAt: Date.now() + 1000 }, 'o2'));
  assert.ok(!canBetOn({ ...p, endsAt: Date.now() + 1000 }, 'o1'), 'no switching outcome');
  assert.equal(payout(p, 'o2', 100), Math.floor((100 * 4100) / 1100));

  const locked = parsePrediction(event({ status: 'LOCKED', lockedAt: iso(NOW) }));
  assert.equal(locked.status, 'locked');
  assert.match(predictionStatus(locked), /locked/);
  assert.ok(!canBetOn(locked, 'o1'));
  const won = parsePrediction(event({ status: 'RESOLVED', endedAt: iso(NOW), winningOutcome: { id: 'o2' }, self: { prediction: { points: 200, outcome: { id: 'o2' }, result: 'WIN' } } }));
  assert.equal(predictionStatus(won), 'Result: No');
  assert.equal(won.outcomes[1].winner, true);
  assert.equal(myBetLine(won), 'You won 800 points (bet 200 on No)');
  const lost = parsePrediction(event({ status: 'RESOLVED', endedAt: iso(NOW), winningOutcome: { id: 'o1' }, self: { prediction: { points: 200, outcome: { id: 'o2' } } } }));
  assert.equal(myBetLine(lost), 'You lost 200 points on No');
  const canceled = parsePrediction(event({ status: 'CANCELED', self: { prediction: { points: 50, outcome: { id: 'o1' } } } }));
  assert.equal(predictionStatus(canceled), 'Canceled: points were refunded');
  assert.equal(myBetLine(canceled), 'Your 50 points came back');
  // Malformed input never throws.
  assert.equal(parsePrediction(null), null);
  assert.equal(parsePrediction({ id: 'x', outcomes: [] }), null);
  assert.equal(parsePrediction(event({ outcomes: [{ id: 'a', totalPoints: 0 }, { id: 'b' }] })).outcomes[0].ratio, null);
});

test('polls: shares, the countdown, channel-point votes, the winner when it ends', () => {
  const q = parsePoll(poll(), NOW);
  assert.equal(q.status, 'active');
  assert.equal(q.endsAt, NOW + 45000);
  assert.deepEqual(q.choices.map((c) => [c.percent, c.top]), [[75, true], [25, false]]);
  assert.deepEqual(q.pointsVotes, { cost: 250 });
  assert.equal(pollStatus(q, NOW), 'Poll ends in 0:45 · 8 votes');
  const ended = parsePoll(poll({ status: 'COMPLETED', endedAt: iso(NOW) }), NOW);
  assert.equal(pollStatus(ended, NOW), 'Poll ended: Dust · 8 votes');
  assert.equal(parsePoll(poll({ settings: {} }), NOW).pointsVotes, null);
  assert.equal(parsePoll({ id: 'x', choices: [] }), null);
});

test('what shows: active or locked first, a fresh result, never an archived or stale poll', () => {
  let r = parsePredictionsPolls(answer({ active: [event()], viewablePoll: poll() }), NOW);
  assert.equal(r.prediction.id, 'ev1');
  assert.equal(r.poll.id, 'p1');
  r = parsePredictionsPolls(answer({ locked: [event({ id: 'ev2', status: 'LOCKED' })] }), NOW);
  assert.equal(r.prediction.status, 'locked');
  r = parsePredictionsPolls(answer({ resolved: [event({ status: 'RESOLVED', endedAt: iso(NOW - 10000), winningOutcome: { id: 'o1' } })] }), NOW);
  assert.equal(r.prediction.status, 'resolved');
  r = parsePredictionsPolls(answer({ resolved: [event({ status: 'RESOLVED', endedAt: iso(NOW - RESULT_MS - 1) })] }), NOW);
  assert.equal(r.prediction, null);
  assert.equal(parsePredictionsPolls(answer({ viewablePoll: poll({ status: 'ARCHIVED' }) }), NOW).poll, null);
  assert.equal(parsePredictionsPolls(answer({ viewablePoll: poll({ status: 'TERMINATED', endedAt: iso(NOW - RESULT_MS - 1) }) }), NOW).poll, null);
  assert.equal(parsePredictionsPolls(answer({ viewablePoll: poll({ status: 'TERMINATED', endedAt: iso(NOW - 5000) }) }), NOW).poll.status, 'ended');
  assert.deepEqual(parsePredictionsPolls({}, NOW), { prediction: null, poll: null });
});

test('the watcher: changes only, fast while something shows, slow otherwise, backoff on errors, a channel switch', async () => {
  const answers = [answer(), answer({ active: [event()] }), answer({ active: [event()] }), new Error('down'), answer()];
  const timers = [];
  const states = [];
  const logs = [];
  const w = new PredictionsWatcher({
    query: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; },
    onState: (s) => states.push(s), log: (l) => logs.push(l), now: () => NOW,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  w.watch('chan');
  await w.running;
  assert.equal(states.length, 1); // the reset to chan (nothing open): one state, the answer didn't change it
  assert.equal(timers.at(-1).ms, 15000);
  await w.kick();
  assert.equal(states.at(-1).prediction.id, 'ev1');
  assert.equal(timers.at(-1).ms, 3000);
  await w.kick();
  assert.equal(states.length, 2, 'the same answer again is no change');
  await w.kick();
  assert.equal(timers.at(-1).ms, 30000);
  assert.ok(logs.some((l) => /query failed \(down\)/.test(l)));
  assert.equal(states.at(-1).prediction.id, 'ev1', 'an error keeps the last state');
  w.watch('other');
  assert.deepEqual(states.at(-1), { login: 'other', prediction: null, poll: null });
  w.stop();
  assert.equal(states.at(-1).login, null);
});

test('formatting, the amount chooser\'s presets and steps, the compact line', () => {
  assert.equal(fmtPoints(999), '999');
  assert.equal(fmtPoints(1234), '1,234');
  assert.equal(fmtPoints(12345), '12.3K');
  assert.equal(fmtPoints(250000), '250K');
  assert.equal(fmtPoints(1234567), '1.2M');
  assert.equal(fmtLeft(NOW + 65000, NOW), '1:05');
  assert.equal(fmtLeft(NOW - 5, NOW), '0:00');
  assert.equal(fmtLeft(null, NOW), '');
  assert.deepEqual(betPresets(12480), [10, 100, 500, 1000, 3120, 5000, 6240, 10000, 12480]);
  assert.deepEqual(betPresets(40), [10, 20, 40]);
  assert.deepEqual(betPresets(0), []);
  assert.equal(betPresets(10_000_000).at(-1), 250000, 'Twitch\'s cap');
  assert.equal(stepBet(100, 1, 12480), 200);
  assert.equal(stepBet(200, 1, 12480), 500);
  assert.equal(stepBet(500, -1, 12480), 200);
  assert.equal(stepBet(10000, 1, 12480), 12480);
  assert.equal(stepBet(1, -1, 12480), 1);
  assert.equal(stepBet(300, 1, 0), 0);
  assert.deepEqual(compactLine({ prediction: parsePrediction(event()), poll: null }, NOW), { kind: 'prediction', label: 'Prediction · 1:00' });
  assert.deepEqual(compactLine({ prediction: null, poll: parsePoll(poll(), NOW) }, NOW), { kind: 'poll', label: 'Poll · 0:45' });
  assert.equal(compactLine({ prediction: null, poll: null }), null);
});

test('the frame sources are valid scripts with the data JSON-encoded', () => {
  const p = predictSource({ outcomeIndex: 1, outcomeTitle: 'No "way"</script>', points: 250.7 });
  const v = pollVoteSource({ choiceIndex: 2, choiceTitle: 'Ice', withPoints: true });
  for (const src of [p, v]) assert.doesNotThrow(() => new Function(`return ${src};`));
  assert.match(p, /typeInto\(input, 250\)/);
  assert.ok(p.includes(JSON.stringify('No "way"</script>')));
});

test('demo mode: GQL-shaped answers, a bet lands in the totals and in self, votes count', () => {
  let t = NOW;
  const demo = createDemoPredictions({ now: () => t });
  let r = parsePredictionsPolls(demo.answer('pixelmoth'), t);
  assert.equal(r.prediction.status, 'active');
  assert.equal(r.poll.choices.length, 3);
  const o = r.prediction.outcomes[1];
  assert.deepEqual(demo.bet('pixelmoth', o.id, 500), { ok: true });
  assert.equal(demo.bet('pixelmoth', r.prediction.outcomes[0].id, 10).ok, false, 'no switching');
  r = parsePredictionsPolls(demo.answer('pixelmoth'), t);
  assert.deepEqual(r.prediction.mine, { outcomeId: o.id, points: 500, result: null });
  const before = r.poll.total;
  demo.vote('pixelmoth', r.poll.choices[0].id, true);
  assert.ok(parsePredictionsPolls(demo.answer('pixelmoth'), t).poll.total > before);
  t += 300000; // the window ends: locked
  assert.equal(parsePredictionsPolls(demo.answer('pixelmoth'), t).prediction.status, 'locked');
});
