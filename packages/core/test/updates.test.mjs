import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, versionCore, compareVersions, isNewer, allowedUpdateUrl, fetchChecked, parseRelease, pickAsset, sumsAsset,
  parseSums, checkDue, UpdateChecker, RELEASES_API, CHECK_EVERY_MS, updateSummary, shouldNotify, updateState,
} from '../src/shared/updates.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';

const raw = (version, extra = {}) => ({
  tag_name: `v${version}`, name: `Lurkbox v${version}`, html_url: `https://github.com/lurkbox/lurkbox/releases/tag/v${version}`,
  draft: false, prerelease: false, published_at: '2026-11-20T12:00:00Z',
  assets: [
    { name: `Lurkbox-${version}-x86_64.AppImage`, size: 100, browser_download_url: `https://github.com/lurkbox/lurkbox/releases/download/v${version}/Lurkbox-${version}-x86_64.AppImage` },
    { name: `Lurkbox-${version}-android.apk`, size: 50, browser_download_url: `https://github.com/lurkbox/lurkbox/releases/download/v${version}/Lurkbox-${version}-android.apk` },
    { name: 'SHA256SUMS.txt', size: 10, browser_download_url: `https://github.com/lurkbox/lurkbox/releases/download/v${version}/SHA256SUMS.txt` },
  ],
  ...extra,
});

test('versions: parse, the x.y.z prefix (Android versionName), semver precedence', () => {
  assert.deepEqual(parseVersion('v1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: ['rc', 1] });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('banana'), null);
  assert.equal(versionCore('0.1.0-78501e0'), '0.1.0');
  assert.equal(versionCore('nope'), null);
  const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareVersions(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.ok(compareVersions(order[i + 1], order[i]) > 0);
  }
  assert.equal(compareVersions('v1.0.0', '1.0.0+build.5'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1); // numeric, not text
  assert.ok(isNewer('0.2.0', '0.1.0'));
  assert.ok(!isNewer('0.1.0', '0.1.0'));
  assert.ok(!isNewer('0.1.0', '0.2.0'));
  assert.ok(!isNewer('garbage', '0.1.0'));
});

test('update URLs: only https on GitHub\'s hosts, no credentials, default port', () => {
  assert.equal(allowedUpdateUrl('https://github.com/lurkbox/lurkbox/releases'), 'https://github.com/lurkbox/lurkbox/releases');
  assert.ok(allowedUpdateUrl('https://objects.githubusercontent.com/x'));
  assert.ok(allowedUpdateUrl('https://release-assets.githubusercontent.com/x?sig=1'));
  assert.ok(allowedUpdateUrl('https://api.github.com:443/repos'));
  for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x', 'https://user:pw@github.com/x', 'https://github.com:8443/x', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
    assert.equal(allowedUpdateUrl(bad), null, bad);
  }
  assert.equal(allowedUpdateUrl('/next', 'https://github.com/a/b'), 'https://github.com/next');
});

const res = (status, body = '', headers = {}) => new Response(status === 304 || (status >= 300 && status < 400) ? null : body, { status, headers });

test('fetchChecked follows redirects one hop at a time, each checked; refuses others', async () => {
  const seen = [];
  const hop = async (url) => {
    seen.push(url);
    if (url.startsWith('https://github.com/')) return res(302, '', { location: 'https://release-assets.githubusercontent.com/f?sig=1' });
    return res(200, 'ok');
  };
  const r = await fetchChecked(hop, 'https://github.com/lurkbox/lurkbox/releases/download/v1/x');
  assert.equal(await r.text(), 'ok');
  assert.equal(r.finalUrl, 'https://release-assets.githubusercontent.com/f?sig=1');
  assert.equal(seen.length, 2);

  const evil = async () => res(302, '', { location: 'https://evil.example/f' });
  await assert.rejects(fetchChecked(evil, 'https://github.com/x'), /not followed/);
  const http = async () => res(301, '', { location: 'http://github.com/f' });
  await assert.rejects(fetchChecked(http, 'https://github.com/x'), /not followed/);
  const loop = async () => res(302, '', { location: 'https://github.com/again' });
  await assert.rejects(fetchChecked(loop, 'https://github.com/x'), /too many/);
  await assert.rejects(fetchChecked(async () => res(200), 'https://evil.example/'), /not allowed/);
});

test('releases: parsed, drafts/prereleases skipped, assets picked, sums parsed', () => {
  const r = parseRelease(raw('0.2.0'));
  assert.equal(r.version, '0.2.0');
  assert.equal(r.url, 'https://github.com/lurkbox/lurkbox/releases/tag/v0.2.0');
  assert.equal(pickAsset(r, 'appimage').name, 'Lurkbox-0.2.0-x86_64.AppImage');
  assert.equal(pickAsset(r, 'apk').name, 'Lurkbox-0.2.0-android.apk');
  assert.equal(pickAsset(r, 'exe'), null);
  assert.equal(sumsAsset(r).name, 'SHA256SUMS.txt');
  assert.equal(parseRelease(raw('0.2.0', { draft: true })), null);
  assert.equal(parseRelease(raw('0.2.0', { prerelease: true })), null);
  assert.equal(parseRelease({ tag_name: 'nightly' }), null);
  assert.equal(parseRelease(null), null);
  // Off-GitHub asset URLs and odd names are dropped; a page off GitHub falls back to the tag's page.
  const odd = parseRelease(raw('0.2.0', {
    html_url: 'https://evil.example/',
    assets: [{ name: '../x.AppImage', browser_download_url: 'https://github.com/x' }, { name: 'a-x86_64.AppImage', browser_download_url: 'https://evil.example/a' }],
  }));
  assert.equal(odd.assets.length, 0);
  assert.equal(odd.url, 'https://github.com/lurkbox/lurkbox/releases/tag/v0.2.0');
  const h = 'a'.repeat(64);
  const sums = parseSums(`${h}  Lurkbox-0.2.0-x86_64.AppImage\n${'B'.repeat(64)} *Lurkbox-0.2.0-android.apk\ngarbage line\n`);
  assert.equal(sums.get('Lurkbox-0.2.0-x86_64.AppImage'), h);
  assert.equal(sums.get('Lurkbox-0.2.0-android.apk'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the schedule: always at start, then once a day', () => {
  assert.ok(checkDue({ checkedAt: 1000, now: 2000, atStart: true }));
  assert.ok(!checkDue({ checkedAt: 1000, now: 1000 + CHECK_EVERY_MS - 1 }));
  assert.ok(checkDue({ checkedAt: 1000, now: 1000 + CHECK_EVERY_MS }));
  assert.ok(checkDue({ checkedAt: 0, now: 5 }));
  assert.ok(checkDue({ checkedAt: 5000, now: 10 })); // the clock went back
});

function checker({ answers, cached = null, now = { t: 1_000_000 }, enabled = true, current = '0.1.0' } = {}) {
  const calls = [];
  let store = cached;
  const timers = { interval: null, timeout: null };
  const c = new UpdateChecker({
    hop: async (url, init) => { calls.push({ url, headers: init.headers }); const a = answers.shift(); return typeof a === 'function' ? a() : a; },
    current, install: 'appimage',
    cache: { get: () => store, set: (v) => { store = v; } },
    enabled: () => enabled,
    now: () => now.t,
    setInterval: (fn) => { timers.interval = fn; return 1; },
    clearInterval: () => { timers.interval = null; },
    setTimeout: (fn) => { timers.timeout = fn; return 2; },
  });
  return { c, calls, timers, now, store: () => store };
}

test('checker: the start check, the ETag, a 304, the daily schedule and the cache across restarts', async () => {
  const json = (v, etag) => res(200, JSON.stringify(raw(v)), { etag });
  const t = checker({ answers: [json('0.2.0', '"e1"'), res(304), json('0.3.0', '"e2"')] });
  const states = [];
  t.c.onChange = (s) => states.push(s);
  t.c.start();
  assert.equal(t.calls.length, 0); // the first check waits a moment after start
  t.timers.timeout();
  await t.c.checking;
  assert.equal(t.calls[0].url, RELEASES_API);
  assert.equal(t.calls[0].headers['If-None-Match'], undefined);
  let s = t.c.state();
  assert.equal(s.available, true);
  assert.equal(s.latest.version, '0.2.0');
  assert.ok(states.some((x) => x.checking));

  // An hour later: not due yet, no request.
  t.now.t += 3600e3;
  t.timers.interval();
  assert.equal(t.calls.length, 1);
  // A day later: due; the ETag goes along and a 304 keeps the release.
  t.now.t += CHECK_EVERY_MS;
  t.timers.interval();
  await t.c.checking;
  assert.equal(t.calls[1].headers['If-None-Match'], '"e1"');
  assert.equal(t.c.state().latest.version, '0.2.0');
  // "Check now" ignores the schedule.
  await t.c.check({ force: true });
  assert.equal(t.c.state().latest.version, '0.3.0');

  // A restart reads the cache: the notice shows before any request.
  const again = checker({ answers: [], cached: t.store() });
  s = again.c.state();
  assert.equal(s.latest.version, '0.3.0');
  assert.equal(s.available, true);
  t.c.shutdown();
  assert.equal(t.timers.interval, null);
});

test('checker: off in Settings skips the scheduled checks; rate limits and errors keep the cached release', async () => {
  const off = checker({ answers: [res(200, JSON.stringify(raw('0.2.0')))], enabled: false });
  off.c.start();
  off.timers.timeout();
  off.timers.interval();
  assert.equal(off.calls.length, 0);
  assert.equal(off.c.state().enabled, false);
  await off.c.check({ force: true }); // "Check now" still works
  assert.equal(off.calls.length, 1);

  const t = checker({ answers: [res(200, JSON.stringify(raw('0.2.0')), { etag: '"x"' }), res(403, 'rate limited'), async () => { throw new Error('offline'); }, res(200, '{"tag_name": "junk"}')] });
  await t.c.check({ force: true });
  await t.c.check({ force: true });
  let s = t.c.state();
  assert.match(s.error, /rate limit/);
  assert.equal(s.latest.version, '0.2.0');
  await t.c.check({ force: true });
  assert.match(t.c.state().error, /offline/);
  await t.c.check({ force: true });
  s = t.c.state();
  assert.match(s.error, /could not be read/);
  assert.equal(s.latest.version, '0.2.0');

  // No release yet (404): nothing available, no error.
  const none = checker({ answers: [res(404, '{}')] });
  await none.c.check({ force: true });
  assert.equal(none.c.state().available, false);
  assert.equal(none.c.state().error, null);
  // The running version is newer than the release (a development build): nothing to offer.
  const dev = checker({ answers: [res(200, JSON.stringify(raw('0.1.0')))], current: '0.2.0' });
  await dev.c.check({ force: true });
  assert.equal(dev.c.state().available, false);
});

test('checker: two checks at once share one request', async () => {
  let release;
  const t = checker({ answers: [() => new Promise((r) => { release = r; })] });
  const a = t.c.check({ force: true });
  const b = t.c.check({ force: true });
  assert.equal(a, b);
  release(res(200, JSON.stringify(raw('0.2.0'))));
  await a;
  assert.equal(t.calls.length, 1);
});

test('the toast once per version, and the About row for each state', () => {
  const base = { current: '0.1.0', enabled: true, install: 'appimage', release: parseRelease(raw('0.2.0')), checkedAt: 5 };
  const st = updateState(base);
  assert.ok(shouldNotify(st, ''));
  assert.ok(shouldNotify(st, '0.1.5'));
  assert.ok(!shouldNotify(st, '0.2.0'));
  assert.ok(!shouldNotify(updateState({ ...base, release: parseRelease(raw('0.1.0')) }), ''));

  assert.deepEqual(updateSummary(st).actions, ['download', 'release']);
  assert.match(updateSummary(st).text, /v0\.2\.0 is available/);
  assert.equal(updateSummary(updateState({ ...base, download: { status: 'downloading', received: 50, total: 100 } })).text, 'Downloading Lurkbox v0.2.0… 50 %');
  assert.deepEqual(updateSummary(updateState({ ...base, download: { status: 'ready' } })).actions, ['install']);
  assert.match(updateSummary(updateState({ ...base, download: { status: 'failed', error: 'checksum' } })).text, /download failed: checksum/);
  assert.deepEqual(updateSummary(updateState({ ...base, install: 'flatpak' })).actions, ['release']);
  assert.match(updateSummary(updateState({ ...base, install: 'flatpak' })).text, /flatpak update/);
  assert.deepEqual(updateSummary(updateState({ ...base, install: 'manual' })).actions, ['release', 'check']);
  const apk = { ...base, install: 'apk', download: { status: 'ready' } };
  assert.deepEqual(updateSummary(updateState(apk)).actions, ['install']);
  assert.match(updateSummary(updateState({ ...apk, note: 'signature-mismatch' })).text, /Uninstall Lurkbox first/);
  assert.deepEqual(updateSummary(updateState({ ...apk, note: 'signature-mismatch' })).actions, ['release']);
  assert.match(updateSummary(updateState({ ...apk, note: 'install-permission' })).text, /Allow Lurkbox to install apps/);
  const current = updateState({ ...base, release: parseRelease(raw('0.1.0')) });
  assert.match(updateSummary(current).text, /up to date/);
  assert.deepEqual(updateSummary(current).actions, ['check']);
  assert.match(updateSummary(updateState({ ...base, release: null, checkedAt: null, error: 'offline' })).text, /Couldn't check/);
  assert.equal(updateSummary(updateState({ ...base, release: null, checkedAt: null, checking: true })).text, 'Checking for updates…');
});

test('settings: checkUpdates on by default; updateNotified only takes a version', () => {
  assert.equal(DEFAULT_SETTINGS.checkUpdates, true);
  assert.equal(sanitizeSettings({ checkUpdates: 0 }).checkUpdates, false);
  assert.equal(sanitizeSettings({ updateNotified: '0.2.0' }).updateNotified, '0.2.0');
  assert.equal(sanitizeSettings({ updateNotified: '<img>' }).updateNotified, '');
});
