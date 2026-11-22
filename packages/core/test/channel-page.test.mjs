// The channel page: Helix wrappers and pagination (videos, clips, schedule, followers), the clip period window, clip
// sorting, schedule times across time zones, and the saved filter choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_TABS, VIDEO_FILTERS, CLIP_PERIODS, clipRange, fmtLength, scheduleSegments, nextSegment, vacation, fmtSchedule, fmtFollowers, validChoice,
} from '../src/shared/channel-page.js';
import { CLIP_SORTS, SORT_SETTINGS, sortClips } from '../src/shared/sorts.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { fetchAllPages } from '../src/js/follows.js';
import { buildDemoData } from '../src/js/demo/data.js';
import { demoHelix } from '../src/js/demo/helix.js';

/** window.lurkbox.helix answered by `answer(req)`; records the requests. */
function fakeHost(answer) {
  const calls = [];
  globalThis.window = { lurkbox: { helix: async (req) => { calls.push(req); return answer(req); } } };
  return calls;
}
const { tw, ApiError } = await import('../src/js/api.js');

const NOW = Date.UTC(2026, 2, 14, 20, 0, 5); // Sat 14 Mar 2026, 20:00:05 UTC
const H = 3600 * 1000;

test('tabs and filters', () => {
  assert.deepEqual(CHANNEL_TABS.map((t) => t.value), ['home', 'videos', 'clips', 'schedule', 'about']);
  assert.deepEqual(VIDEO_FILTERS.map((t) => t.value), ['archive', 'highlight', 'upload'], 'Helix /videos types');
  assert.deepEqual(CLIP_PERIODS.map((t) => t.value), ['24h', '7d', '30d', 'all']);
  assert.equal(validChoice(VIDEO_FILTERS, 'upload'), 'upload');
  assert.equal(validChoice(VIDEO_FILTERS, 'all'), 'archive', 'unknown → the first');
  assert.equal(validChoice(CLIP_PERIODS, 'x', '7d'), '7d');
});

test('clip periods: both ends of the window, nothing for all time', () => {
  assert.deepEqual(clipRange('24h', NOW), { started_at: '2026-03-13T20:00:05Z', ended_at: '2026-03-14T20:00:05Z' });
  assert.deepEqual(clipRange('7d', NOW), { started_at: '2026-03-07T20:00:05Z', ended_at: '2026-03-14T20:00:05Z' });
  assert.deepEqual(clipRange('30d', NOW), { started_at: '2026-02-12T20:00:05Z', ended_at: '2026-03-14T20:00:05Z' });
  assert.deepEqual(clipRange('all', NOW), {});
  assert.deepEqual(clipRange('nonsense', NOW), {});
});

test('clip sorting: most viewed (default), newest, oldest; stable ties', () => {
  const c = [
    { id: 'a', title: 'b-side', view_count: 10, created_at: '2026-03-10T00:00:00Z' },
    { id: 'b', title: 'Alpha', view_count: 500, created_at: '2026-03-01T00:00:00Z' },
    { id: 'c', title: 'charlie', view_count: 10, created_at: '2026-03-12T00:00:00Z' },
    { id: 'd', title: 'delta', view_count: 75, created_at: '2026-03-12T00:00:00Z' },
  ];
  const ids = (l) => l.map((x) => x.id).join('');
  assert.equal(ids(sortClips(c, 'views')), 'bdca', 'by views; a tie goes to the newer');
  assert.equal(ids(sortClips(c, 'newest')), 'dcab', 'same day: more views first');
  assert.equal(ids(sortClips(c, 'oldest')), 'badc');
  assert.equal(ids(sortClips(c, 'whatever')), ids(sortClips(c, 'views')));
  assert.equal(ids(c), 'abcd', 'the input is not modified');
  assert.deepEqual(CLIP_SORTS.map((s) => s.value), ['views', 'newest', 'oldest']);
  assert.equal(SORT_SETTINGS.clipSort.fallback, 'views');
});

test('the saved choices go through the settings schema', () => {
  assert.equal(DEFAULT_SETTINGS.videoFilter, 'archive');
  assert.equal(DEFAULT_SETTINGS.clipPeriod, '7d');
  assert.equal(DEFAULT_SETTINGS.clipSort, 'views');
  assert.deepEqual(sanitizeSettings({ videoFilter: 'highlight', clipPeriod: '30d', clipSort: 'newest' }), { videoFilter: 'highlight', clipPeriod: '30d', clipSort: 'newest' });
  assert.deepEqual(sanitizeSettings({ videoFilter: 'live', clipPeriod: '1y', clipSort: 'random' }), { videoFilter: 'archive', clipPeriod: '7d', clipSort: 'views' });
  assert.equal(DEFAULT_SETTINGS.clipAutoplay, true, 'the next clip plays by default');
  assert.deepEqual(sanitizeSettings({ clipAutoplay: 0 }), { clipAutoplay: false });
});

test('lengths and follower counts', () => {
  assert.equal(fmtLength(27.4), '0:27');
  assert.equal(fmtLength(62), '1:02');
  assert.equal(fmtLength(3605), '1:00:05');
  assert.equal(fmtLength(null), '0:00');
  assert.equal(fmtFollowers(1), '1 follower');
  assert.equal(fmtFollowers(12345, (n) => `${Math.floor(n / 1000)}K`), '12K followers');
  assert.equal(fmtFollowers(null), '');
});

const seg = (id, startMs, hours = 2, extra = {}) => ({ id, start_time: new Date(startMs).toISOString(), end_time: hours == null ? null : new Date(startMs + hours * H).toISOString(), title: `s${id}`, category: { id: '9', name: 'Cozy' }, canceled_until: null, is_recurring: true, ...extra });

test('schedule segments: upcoming only, soonest first, cancelled ones marked', () => {
  const data = {
    segments: [
      seg('late', NOW + 50 * H),
      seg('over', NOW - 5 * H), // ended an hour before now
      seg('on-now', NOW - H), // still running
      seg('soon', NOW + 3 * H, 2, { canceled_until: '2026-03-15T00:00:00Z' }),
      seg('open-ended', NOW + 6 * H, null),
      { id: 'bad', start_time: 'not a date' },
    ],
    vacation: { start_time: '2026-03-20T00:00:00Z', end_time: '2026-03-27T00:00:00Z' },
  };
  const s = scheduleSegments(data, NOW);
  assert.deepEqual(s.map((x) => x.id), ['on-now', 'soon', 'open-ended', 'late']);
  assert.equal(s[1].canceled, true);
  assert.deepEqual(s[0].category, { id: '9', name: 'Cozy' });
  assert.equal(nextSegment(s).id, 'on-now');
  assert.equal(nextSegment(s.slice(1)).id, 'open-ended', 'a cancelled segment is never "next"');
  assert.equal(nextSegment([]), null);
  assert.deepEqual(vacation(data), { start: Date.UTC(2026, 2, 20), end: Date.UTC(2026, 2, 27) });
  assert.equal(vacation({ vacation: null }), null);
  assert.deepEqual(scheduleSegments({ segments: null }, NOW), [], 'Helix sends null segments during a vacation');
  assert.deepEqual(scheduleSegments(null, NOW), []);
});

test('schedule times: the same segment in different time zones', () => {
  const start = Date.UTC(2026, 2, 15, 1, 30); // Sun 15 Mar 01:30 UTC = Sat evening in the Americas
  const end = start + 2 * H;
  const at = (timeZone) => fmtSchedule(start, end, { now: NOW, timeZone, locale: 'en-US' });
  assert.deepEqual(at('UTC'), { day: 'Tomorrow', time: '1:30 AM – 3:30 AM', zone: 'UTC', label: 'Tomorrow · 1:30 AM – 3:30 AM UTC' });
  // In Los Angeles it is still Saturday 14 Mar for both: today (PDT since 8 Mar).
  assert.deepEqual(at('America/Los_Angeles'), { day: 'Today', time: '6:30 PM – 8:30 PM', zone: 'PDT', label: 'Today · 6:30 PM – 8:30 PM PDT' });
  // In Tokyo, now is Sun 15 Mar 05:00 and the segment is Sun 15 Mar 10:30: today.
  assert.equal(at('Asia/Tokyo').day, 'Today');
  assert.equal(at('Asia/Tokyo').time, '10:30 AM – 12:30 PM');
  // Kiritimati (UTC+14): now is Sun 15 Mar 10:00, the segment Sun 15:30, also today.
  assert.equal(at('Pacific/Kiritimati').day, 'Today');
  // Berlin is still on winter time (CET = GMT+1): Sun 15 Mar 02:30, tomorrow.
  assert.deepEqual([at('Europe/Berlin').day, at('Europe/Berlin').zone], ['Tomorrow', 'GMT+1']);
  // 24-hour locales keep their own clock; a later day shows the weekday and date; another year adds the year.
  assert.equal(fmtSchedule(start + 13 * H, end + 13 * H, { now: NOW, timeZone: 'Europe/London', locale: 'en-GB' }).time, '14:30 – 16:30');
  assert.equal(fmtSchedule(start + 3 * 24 * H, null, { now: NOW, timeZone: 'UTC', locale: 'en-US' }).label, 'Wed, Mar 18 · 1:30 AM UTC');
  assert.equal(fmtSchedule(Date.UTC(2027, 0, 4, 18), null, { now: NOW, timeZone: 'UTC', locale: 'en-US' }).day, 'Mon, Jan 4, 2027');
});

test('Helix wrappers: videos by type, clips in a window, clip by id, followers, channel info', async () => {
  const calls = fakeHost((req) => {
    if (req.path === '/channels/followers') return { ok: true, status: 200, data: { data: [], total: 4321, pagination: {} } };
    return { ok: true, status: 200, data: { data: [{ id: 'x' }], pagination: { cursor: 'next1' } } };
  });
  assert.deepEqual(await tw.videos('7', 'c0', 'highlight'), { items: [{ id: 'x' }], cursor: 'next1' });
  assert.deepEqual(calls.at(-1), { path: '/videos', query: { user_id: '7', first: 40, type: 'highlight', after: 'c0' }, method: 'GET', body: undefined, accountId: undefined });
  await tw.videos('7');
  assert.equal(calls.at(-1).query.type, 'all', 'no filter: every type');
  await tw.clips('7', { period: '24h', now: NOW, after: 'c1' });
  assert.deepEqual(calls.at(-1).query, { broadcaster_id: '7', first: 40, after: 'c1', started_at: '2026-03-13T20:00:05Z', ended_at: '2026-03-14T20:00:05Z' });
  await tw.clips('7', { period: 'all' });
  assert.ok(!('started_at' in calls.at(-1).query) && !('ended_at' in calls.at(-1).query), 'all time: no window');
  assert.deepEqual(await tw.clipById('Slug'), { id: 'x' });
  assert.deepEqual(calls.at(-1).query, { id: 'Slug' });
  assert.equal(await tw.followerCount('7'), 4321);
  assert.deepEqual(calls.at(-1).query, { broadcaster_id: '7', first: 1 });
  assert.deepEqual(await tw.channelInfo('7'), { id: 'x' });
});

test('Helix schedule: segments and cursor; 404 means no schedule; other errors throw', async () => {
  fakeHost(() => ({ ok: true, status: 200, data: { data: { segments: [seg('a', NOW + H)], vacation: null }, pagination: { cursor: 'p2' } } }));
  const r = await tw.schedule('7', { now: NOW });
  assert.deepEqual(r.items.map((s) => s.id), ['a']);
  assert.equal(r.cursor, 'p2');
  assert.equal(r.vacation, null);
  fakeHost(() => ({ ok: false, status: 404, error: 'Not Found', data: { message: 'segments were not found' }, resetAt: null }));
  assert.deepEqual(await tw.schedule('7'), { items: [], cursor: null, vacation: null });
  fakeHost(() => ({ ok: false, status: 500, error: 'boom', data: null, resetAt: null }));
  await assert.rejects(tw.schedule('7'), (e) => e instanceof ApiError && e.status === 500);
  fakeHost(() => ({ ok: false, status: 401, error: 'NOT_SIGNED_IN', data: null, resetAt: null }));
  await assert.rejects(tw.schedule('7'), (e) => e.code === 'NOT_SIGNED_IN');
});

test('pagination over every page (demo Helix): videos, clips and the schedule', async () => {
  const db = buildDemoData();
  const calls = fakeHost((req) => demoHelix(db, req, { activeId: '1000001' }));
  const u = db.users.find((x) => x.login === 'pixelmoth');
  const clips = await fetchAllPages((c) => tw.clips(u.id, { after: c, period: 'all', first: 2 }));
  assert.equal(clips.length, db.clips.filter((c) => c.broadcaster_id === u.id).length);
  assert.equal(new Set(clips.map((c) => c.id)).size, clips.length, 'no clip twice');
  assert.ok(calls.filter((c) => c.path === '/clips').length >= 3, 'several pages');
  assert.deepEqual(clips.map((c) => c.view_count), [...clips.map((c) => c.view_count)].sort((a, b) => b - a), 'Helix order: views');
  const week = await fetchAllPages((c) => tw.clips(u.id, { after: c, period: '7d', now: db.now, first: 2 }));
  assert.ok(week.length > 0 && week.length < clips.length, 'the period narrows the list');
  assert.ok(week.every((c) => Date.parse(c.created_at) >= db.now - 7 * 24 * H));
  const vids = await fetchAllPages((c) => tw.videos(u.id, c, 'archive', 3));
  assert.ok(vids.length >= 4 && vids.every((v) => v.type === 'archive'));
  const pages = [];
  let cursor = null;
  do { const p = await tw.schedule(u.id, { after: cursor, now: db.now, first: 4 }); pages.push(p.items); cursor = p.cursor; } while (cursor);
  assert.ok(pages.length >= 2 && pages.flat().length === 9, 'three weeks of three segments, over pages');
  const none = db.users.find((x) => !db.schedules.has(x.id) && !db.accounts.some((a) => a.id === x.id));
  assert.deepEqual((await tw.schedule(none.id)).items, [], 'a channel without a schedule');
});
