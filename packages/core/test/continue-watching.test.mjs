// Continue watching: the row's rules (started, not finished, 30 days, 20 items, newest first), the card's progress
// maths, the stored details, the per-account store entries, the lazy removal of deleted VODs and the sideways scroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  continueWatching, isFinished, cwProgress, fmtLeft, sanitizeResumeMeta, checkVideos, videoOfEntry, resumeUpdate, resumeEntries,
  CW_MAX, CW_MAX_AGE_MS, RESUME_MAX_PER_ACCOUNT,
} from '../src/shared/continue-watching.js';
import { computeScrollLeft } from '../src/js/focus.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 22);
const entry = (id, position, duration, ago = 1000, extra = {}) => ({ id: String(id), position, duration, at: NOW - ago, ...extra });

test('finished: 95 % watched or under 2 minutes left', () => {
  assert.equal(isFinished(3000, 3600), false);
  assert.equal(isFinished(3420, 3600), true, 'exactly 95 %');
  assert.equal(isFinished(3419, 3600), false);
  assert.equal(isFinished(7000, 7200), true, 'under 2 min left (97 %)');
  assert.equal(isFinished(60, 179), true, 'a short video: 119 s left');
  assert.equal(isFinished(59, 180), false, '121 s left');
  assert.equal(isFinished(100, null), false, 'unknown duration');
});

test('the row: started, unfinished, last 30 days, newest first, at most 20', () => {
  const rows = continueWatching([
    entry(1, 600, 3600, 5 * DAY),
    entry(2, 1200, 3600, 1 * DAY),
    entry(3, 29, 3600, 1000), // barely started
    entry(4, 3500, 3600, 1000), // finished
    entry(5, 600, 3600, CW_MAX_AGE_MS + 1), // too old
    entry(6, 600, 3600, CW_MAX_AGE_MS), // exactly 30 days: still in
    entry(7, 600, null, 1000), // no duration: no progress to show
    entry('x', 600, 3600, 1000), // bad id
    null,
  ], NOW);
  assert.deepEqual(rows.map((r) => r.id), ['2', '1', '6']);
  const many = Array.from({ length: 30 }, (_, i) => entry(100 + i, 600, 3600, i * 60000));
  const capped = continueWatching(many, NOW);
  assert.equal(capped.length, CW_MAX);
  assert.equal(capped[0].id, '100', 'most recent first');
  assert.equal(capped[19].id, '119');
  assert.deepEqual(continueWatching(undefined, NOW), []);
});

test('card progress: the bar fraction and "x min left"', () => {
  assert.deepEqual(cwProgress(900, 3600), { fraction: 0.25, left: 2700, label: '45 min left' });
  assert.equal(cwProgress(0, 3600).fraction, 0);
  assert.equal(cwProgress(5000, 3600).fraction, 1, 'clamped');
  assert.equal(cwProgress(-5, 3600).fraction, 0);
  assert.equal(cwProgress(10, 0).fraction, 0, 'no duration');
  assert.equal(fmtLeft(61), '2 min left', 'rounded up');
  assert.equal(fmtLeft(20), '1 min left');
  assert.equal(fmtLeft(3600), '1 h left');
  assert.equal(fmtLeft(3900), '1 h 5 min left');
  assert.equal(cwProgress(1800, 9000).label, '2 h left');
});

test('stored details are validated (Helix video objects work too)', () => {
  assert.deepEqual(sanitizeResumeMeta({ title: ' Late night\n session ', user_login: 'Lurker_1', user_name: 'Lurker_1', user_id: '123', thumbnail_url: 'https://static-cdn.jtvnw.net/cf_vods/x/thumb0-%{width}x%{height}.jpg' }),
    { title: 'Late night  session', login: 'lurker_1', name: 'Lurker_1', userId: '123', thumb: 'https://static-cdn.jtvnw.net/cf_vods/x/thumb0-%{width}x%{height}.jpg' });
  assert.deepEqual(sanitizeResumeMeta({ thumb: 'javascript:alert(1)', login: '../x', userId: 'abc', title: 'x'.repeat(300) }), { title: 'x'.repeat(200) });
  assert.equal(sanitizeResumeMeta({ thumb: 'http://example.com/a.jpg' }), null, 'https only');
  assert.equal(sanitizeResumeMeta(null), null);
  assert.equal(sanitizeResumeMeta('x'), null);
  assert.ok(sanitizeResumeMeta({ thumb: 'lbhls://demo/img/vod/a-%{width}x%{height}.svg' }).thumb, 'the demo pictures');
});

test('store entries: per account, details kept between saves, 0 forgets, capped', () => {
  let acct = resumeUpdate({}, '100', 61.4, 3600, { title: 'A', login: 'abc' }, { now: 5 });
  assert.deepEqual(acct, { 100: { pos: 61, dur: 3600, at: 5, m: { title: 'A', login: 'abc' } } });
  const before = acct;
  acct = resumeUpdate(acct, '100', 120, 3600, undefined, { now: 6 });
  assert.deepEqual(acct['100'].m, { title: 'A', login: 'abc' }, 'details kept when not given');
  assert.equal(before['100'].pos, 61, 'a copy: the old object is unchanged');
  assert.deepEqual(resumeEntries(acct), [{ title: 'A', login: 'abc', id: '100', position: 120, duration: 3600, at: 6 }]);
  acct = resumeUpdate(acct, '100', 0, 3600, null, { now: 7 });
  assert.deepEqual(acct, {}, '0 forgets (Remove from Continue watching, finished)');
  for (let i = 0; i < 5; i++) acct = resumeUpdate(acct, String(200 + i), 50, 100, null, { now: 10 + i, max: 3 });
  assert.deepEqual(Object.keys(acct).sort(), ['202', '203', '204'], 'the oldest go first');
  assert.equal(RESUME_MAX_PER_ACCOUNT, 300);
  assert.deepEqual(resumeEntries({ bad: { pos: 1 }, 5: null }), []);
});

test('Helix check: a 404 or a missing id means the VOD is gone; errors say nothing', () => {
  const v = { id: '2', title: 'fresh' };
  const ok = checkVideos(['1', '2'], { ok: true, status: 200, data: { data: [v] } });
  assert.deepEqual(ok.gone, ['1']);
  assert.equal(ok.fresh.get('2'), v);
  assert.deepEqual(checkVideos(['1', '2'], { ok: false, status: 404 }).gone, ['1', '2']);
  for (const status of [0, 401, 429, 500]) assert.deepEqual(checkVideos(['1'], { ok: false, status }).gone, [], `HTTP ${status}`);
  assert.deepEqual(checkVideos(['1'], null).gone, [], 'no answer');
});

test('a row entry as a Helix-shaped video for the card and the player', () => {
  assert.deepEqual(videoOfEntry({ id: '9', title: 'T', login: 'abc', name: 'Abc', userId: '5', thumb: 'https://x/y.jpg' }),
    { id: '9', title: 'T', user_login: 'abc', user_name: 'Abc', user_id: '5', thumbnail_url: 'https://x/y.jpg', duration: '', type: 'archive' });
  const fresh = { id: '9', title: 'Renamed' };
  assert.equal(videoOfEntry({ id: '9' }, fresh), fresh);
});

test('the sideways row scrolls a focused card into view with a margin', () => {
  assert.equal(computeScrollLeft({ scrollLeft: 0, viewWidth: 1000, itemLeft: 100, itemRight: 400, margin: 24 }), null, 'in view');
  assert.equal(computeScrollLeft({ scrollLeft: 0, viewWidth: 1000, itemLeft: 900, itemRight: 1200, margin: 24 }), 224);
  assert.equal(computeScrollLeft({ scrollLeft: 500, viewWidth: 1000, itemLeft: -100, itemRight: 200, margin: 24 }), 376);
  assert.equal(computeScrollLeft({ scrollLeft: 10, viewWidth: 1000, itemLeft: 5, itemRight: 300, margin: 24 }), 0, 'never below 0');
});
