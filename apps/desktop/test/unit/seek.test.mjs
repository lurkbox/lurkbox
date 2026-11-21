import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';
import { scrubStep, seekJump, fmtTime, Scrubber, resumeDecision, storyboardFrame, parseHelixDuration, matchArchive, rewindGeometry, rewindTarget } from '@lurkbox/core/src/js/seek.js';
import { Repeater, keyAction, padActions, LT, RT, LEFT, SHIFT_LEFT, SHIFT_RIGHT, HOME, END } from '@lurkbox/core/src/js/input-core.js';

const require = createRequire(import.meta.url);
const { ResumeStore, MAX_PER_ACCOUNT } = require('../../src/main/resume.js');

test('scrub acceleration: 10 s steps, then 30 s, 1 min, 5 min the longer it is held', () => {
  assert.deepEqual([0, 1000, 1199].map(scrubStep), [10, 10, 10]);
  assert.deepEqual([1200, 2799].map(scrubStep), [30, 30]);
  assert.deepEqual([2800, 4799].map(scrubStep), [60, 60]);
  assert.deepEqual([4800, 60000].map(scrubStep), [300, 300]);
  for (let t = 0; t < 10000; t += 100) assert.ok(scrubStep(t + 100) >= scrubStep(t), 'never slows down while held');
});

test('step mapping: triggers ±30 s anywhere, LB/RB ±5 min only on the bar, Shift+arrows ±1 min, Home/End', () => {
  assert.deepEqual(seekJump('LT'), { delta: -30 });
  assert.deepEqual(seekJump('RT'), { delta: 30 });
  assert.equal(seekJump('LB'), null);
  assert.equal(seekJump('RB'), null);
  assert.deepEqual(seekJump('LB', { onBar: true }), { delta: -300 });
  assert.deepEqual(seekJump('RB', { onBar: true }), { delta: 300 });
  assert.deepEqual(seekJump('SHIFT_LEFT'), { delta: -60 });
  assert.deepEqual(seekJump('SHIFT_RIGHT'), { delta: 60 });
  assert.deepEqual(seekJump('HOME'), { to: 'start' });
  assert.deepEqual(seekJump('END'), { to: 'end' });
  assert.equal(seekJump('A'), null);
  // Input: triggers are standard buttons 6/7; keys map to the seek actions (not while typing).
  const pad = (b) => ({ mapping: 'standard', id: 'x', buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === b, value: i === b ? 1 : 0 })), axes: [] });
  assert.ok(padActions(pad(6)).has(LT));
  assert.ok(padActions(pad(7)).has(RT));
  assert.equal(keyAction('ArrowLeft', false, true), SHIFT_LEFT);
  assert.equal(keyAction('ArrowRight', false, true), SHIFT_RIGHT);
  assert.equal(keyAction('ArrowLeft', true, true), LEFT);
  assert.equal(keyAction('Home', false), HOME);
  assert.equal(keyAction('End', false), END);
  assert.equal(keyAction('Home', true), null);
  assert.equal(keyAction('[', false), LT);
});

test('Repeater reports releases (hold-to-scrub applies on release)', () => {
  const r = new Repeater({ delay: 400, rate: 100 });
  r.update(new Set([LEFT]), 0);
  assert.deepEqual(r.released, []);
  r.update(new Set([LEFT]), 50);
  r.update(new Set(), 100);
  assert.deepEqual(r.released, [LEFT]);
});

function scrubHarness({ pos = 100, max = 10000 } = {}) {
  let now = 0;
  const timers = new Map();
  let id = 0;
  const previews = [];
  const commits = [];
  const s = new Scrubber({
    position: () => pos, bounds: () => [0, max],
    onPreview: (t) => previews.push(t), onCommit: (t) => commits.push(t),
    now: () => now, setTimer: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimer: (t) => timers.delete(t),
  });
  const advance = (ms) => {
    now += ms;
    for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.fn(); }
  };
  return { s, previews, commits, advance, setNow: (n) => { now = n; } };
}

test('Scrubber: a tap is ±10 s, committed after a 400 ms pause', () => {
  const h = scrubHarness();
  h.s.press(1);
  assert.deepEqual(h.previews, [110]);
  h.advance(399);
  assert.deepEqual(h.commits, []);
  h.advance(1);
  assert.deepEqual(h.commits, [110]);
});

test('Scrubber: holding accelerates (repeats every 110 ms), release applies at once', () => {
  const h = scrubHarness({ pos: 0 });
  h.s.press(1); // t=0
  for (let t = 380; t <= 5500; t += 110) { h.advance(t === 380 ? 380 : 110); h.s.press(1); }
  const steps = h.previews.map((p, i) => (i ? p - h.previews[i - 1] : p));
  assert.equal(steps[0], 10);
  assert.ok(steps.includes(30) && steps.includes(60) && steps.includes(300), steps.join(','));
  assert.deepEqual(h.commits, [], 'no commit while held');
  h.s.release();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0], h.previews.at(-1));
  h.advance(1000);
  assert.equal(h.commits.length, 1, 'the idle timer does not fire a second commit');
});

test('Scrubber: direction change restarts the acceleration; clamps to the bounds; nudges accumulate', () => {
  const h = scrubHarness({ pos: 50, max: 200 });
  h.s.press(1);
  h.advance(2000); // committed at 60 (idle)
  assert.deepEqual(h.commits, [60]);
  h.s.press(-1);
  h.s.press(-1);
  h.s.press(-1);
  h.s.press(-1);
  h.s.press(-1);
  h.s.press(-1);
  assert.equal(h.previews.at(-1), 0, 'clamped at the start');
  h.advance(500);
  const n = scrubHarness({ pos: 100, max: 1000 });
  n.s.nudge(30);
  n.s.nudge(30);
  n.s.nudge(-300);
  n.advance(400);
  assert.deepEqual(n.commits, [0]);
  n.s.setTarget(5000);
  n.advance(400);
  assert.deepEqual(n.commits, [0, 1000]);
});

test('resume prompt decision', () => {
  assert.equal(resumeDecision({ position: 0, duration: 3600 }), 'start');
  assert.equal(resumeDecision({ position: 29, duration: 3600 }), 'start');
  assert.equal(resumeDecision({ position: 30, duration: 3600 }), 'ask');
  assert.equal(resumeDecision({ position: 3000, duration: 3600 }), 'ask');
  assert.equal(resumeDecision({ position: 3550, duration: 3600 }), 'start', 'last minute: watched');
  assert.equal(resumeDecision({ position: 5000, duration: NaN }), 'ask', 'unknown duration');
  assert.equal(resumeDecision({ position: undefined, duration: 100 }), 'start');
});

test('resume positions are stored per account and per VOD', () => {
  const file = path.join(tmpDir(), 'resume.json');
  let now = 1;
  const st = new ResumeStore(file, { now: () => now });
  st.set('111', '2935383720', 1234.6, 40000);
  st.set('222', '2935383720', 99, 40000);
  st.set(null, '2935383720', 50, 40000);
  const again = new ResumeStore(file);
  assert.deepEqual(again.get('111', '2935383720'), { position: 1235, duration: 40000, at: 1 });
  assert.equal(again.get('222', '2935383720').position, 99);
  assert.equal(again.get(undefined, '2935383720').position, 50, 'signed out = anon');
  assert.equal(again.get('333', '2935383720'), null);
  assert.equal(again.get('111', '../etc'), null);
  assert.equal(again.set('111', 'abc', 10), false);
  again.set('111', '2935383720', 0);
  assert.equal(again.get('111', '2935383720'), null, '0 forgets');
  for (let i = 0; i < MAX_PER_ACCOUNT + 5; i++) { now = 10 + i; st.set('111', String(1000 + i), 100); }
  assert.equal(Object.keys(st.data.accounts['111']).length, MAX_PER_ACCOUNT);
  assert.equal(st.get('111', '1000'), null, 'the oldest go first');
  assert.ok(st.get('111', String(1000 + MAX_PER_ACCOUNT + 4)));
});

test('time format and Helix durations', () => {
  assert.equal(fmtTime(7), '0:07');
  assert.equal(fmtTime(245), '4:05');
  assert.equal(fmtTime(5025), '1:23:45');
  assert.equal(fmtTime(-3), '0:00');
  assert.equal(parseHelixDuration('3h2m1s'), 10921);
  assert.equal(parseHelixDuration('45m'), 2700);
  assert.equal(parseHelixDuration('59s'), 59);
  assert.ok(Number.isNaN(parseHelixDuration('')));
  assert.ok(Number.isNaN(parseHelixDuration('x')));
});

test('storyboard frame lookup', () => {
  const sb = { count: 200, width: 220, height: 124, rows: 10, cols: 5, interval: 215, images: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'] };
  assert.deepEqual(storyboardFrame(sb, 0), { url: 'a.jpg', x: 0, y: 0, w: 220, h: 124, sheetW: 1100, sheetH: 1240 });
  const f = storyboardFrame(sb, 215 * 57 + 10); // index 57 → sheet 1, k 7 → col 2, row 1
  assert.deepEqual([f.url, f.x, f.y], ['b.jpg', 440, 124]);
  assert.equal(storyboardFrame(sb, 1e9).url, 'd.jpg', 'clamped to the last frame');
  assert.equal(storyboardFrame(null, 5), null);
  assert.equal(storyboardFrame({ ...sb, interval: 0 }, 5), null);
});

test('live rewind: archive match by stream id', () => {
  const stream = { id: '555', started_at: '2026-11-21T10:00:00Z' };
  const vids = [{ id: '1', type: 'archive', stream_id: '554' }, { id: '2', type: 'archive', stream_id: '555' }, { id: '3', type: 'highlight', stream_id: '555' }];
  assert.equal(matchArchive(stream, vids).id, '2');
  assert.equal(matchArchive(stream, [vids[0], vids[2]]), null, 'no archive for this stream (VODs off)');
  assert.equal(matchArchive(null, vids), null);
  assert.equal(matchArchive({ id: '555' }, null), null);
});

test('live rewind: offset <-> VOD position, clamped to what the archive has', () => {
  const start = 1_000_000;
  // Live for 2 h; the VOD started 5 s after the stream and has 1 h 55 min in its playlist (lags 5 min).
  const g = rewindGeometry({ nowSec: start + 7200, streamStartSec: start, vodStartSec: start + 5, available: 6900, endMargin: 10 });
  assert.equal(g.uptime, 7200);
  assert.equal(g.vodPosition(600), 7200 - 600 - 5);
  assert.equal(g.offsetOf(g.vodPosition(600)), 600);
  assert.equal(g.minOffset, 7195 - 6890, 'closest to live the archive reaches: lag + margin');
  assert.equal(g.vodPosition(10), 6890, 'clamped to the available end');
  assert.equal(g.vodPosition(99999), 0, 'clamped to the start');
  assert.equal(g.maxOffset, 7195);
});

test('live rewind: where a scrub goes', () => {
  const start = 1_000_000;
  const g = rewindGeometry({ nowSec: start + 7200, streamStartSec: start, vodStartSec: start, available: 7000, endMargin: 10 });
  assert.deepEqual(rewindTarget({ offset: 15, liveWindow: 20, archive: { id: '1' }, geometry: g }), { mode: 'live', offset: 15 });
  assert.deepEqual(rewindTarget({ offset: 600, liveWindow: 20, archive: { id: '1' }, geometry: g }), { mode: 'vod', position: 6600, offset: 600, clamped: false });
  const near = rewindTarget({ offset: 60, liveWindow: 20, archive: { id: '1' }, geometry: g });
  assert.deepEqual(near, { mode: 'vod', position: 6990, offset: 210, clamped: true }, 'archive lags: clamp to "available up to -3:30"');
  assert.deepEqual(rewindTarget({ offset: 600, liveWindow: 20, archive: null, geometry: null }), { mode: 'none', offset: 20 }, 'no archive: only the live window');
  assert.deepEqual(rewindTarget({ offset: -5, liveWindow: 20, archive: null, geometry: null }), { mode: 'live', offset: 0 });
});

test('signed out: the GQL archive match needs RECORDING and a start within 10 min of the stream', () => {
  const { matchGqlArchive } = require('../../src/main/direct.js');
  const stream = { id: '318369725026', createdAt: '2026-11-21T14:01:23Z' };
  const node = { id: '2936129297', createdAt: '2026-11-21T14:01:30Z', lengthSeconds: 15679, status: 'RECORDING' };
  assert.deepEqual(matchGqlArchive(stream, node), { id: '2936129297', type: 'archive', stream_id: '318369725026', created_at: '2026-11-21T14:01:30Z', duration: '15679s' });
  assert.equal(matchGqlArchive(stream, { ...node, status: 'RECORDED' }), null, 'a finished VOD is an earlier broadcast');
  assert.equal(matchGqlArchive(stream, { ...node, createdAt: '2026-11-20T14:01:30Z' }), null);
  assert.equal(matchGqlArchive(stream, null), null);
});
