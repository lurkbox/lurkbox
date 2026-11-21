import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../../src/main/drops.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../../src/main/store.js');

const MIN = 60000;

/** A DropsClaimer on a fake clock: timers fire only through advance(). */
function rig({ enabled = true, session = true, run } = {}) {
  let t = 0;
  const timers = [];
  const logs = [];
  const toasts = [];
  const progress = [];
  const calls = { run: 0, session: 0 };
  const flags = { enabled, session };
  const c = new D.DropsClaimer({
    enabled: () => flags.enabled,
    hasSession: async () => { calls.session++; return flags.session; },
    run: async () => { calls.run++; return run ? run(calls.run) : { state: 'ready', campaigns: [], claimed: [] }; },
    onClaim: (n) => toasts.push(n),
    onProgress: (p) => progress.push(p),
    log: (l) => logs.push(l),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const h = timers[0];
      if (!h || h.at > end) break;
      timers.shift();
      t = h.at;
      h.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    t = end;
  };
  return { c, advance, logs, toasts, progress, calls, flags, timers, now: () => t };
}

test('auto-claim checks once a minute after start, then every 15 minutes', async () => {
  const r = rig();
  r.c.start();
  await r.advance(59 * 1000);
  assert.equal(r.calls.run, 0);
  await r.advance(1000);
  assert.equal(r.calls.run, 1);
  await r.advance(15 * MIN - 1000);
  assert.equal(r.calls.run, 1);
  await r.advance(1000);
  assert.equal(r.calls.run, 2);
  assert.equal(r.c.nextAt, r.now() + 15 * MIN);
});

test('setting off: inert, the page is never loaded (and it starts working once turned on)', async () => {
  const r = rig({ enabled: false });
  r.c.start();
  await r.advance(3 * 60 * MIN);
  assert.equal(r.calls.run, 0);
  assert.equal(r.calls.session, 0);
  r.flags.enabled = true;
  await r.advance(15 * MIN);
  assert.equal(r.calls.run, 1);
});

test('no twitch.tv session: inert, logged once', async () => {
  const r = rig({ session: false });
  r.c.start();
  await r.advance(2 * 60 * MIN);
  assert.equal(r.calls.run, 0);
  assert.ok(r.calls.session >= 2);
  assert.equal(r.logs.filter((l) => /no twitch\.tv session/.test(l)).length, 1);
});

test('rate limit: a check never runs within 5 minutes of the last one', async () => {
  const r = rig();
  r.c.start();
  await r.advance(MIN);
  assert.equal(r.calls.run, 1);
  const res = await r.c.tick(); // e.g. a second trigger right after
  assert.deepEqual(res, { skipped: 'rate' });
  assert.equal(r.calls.run, 1);
  await r.advance(5 * MIN);
  assert.equal(r.calls.run, 2);
  // Overlapping ticks don't double-run either.
  await r.advance(6 * MIN);
  const a = r.c.tick();
  const b = r.c.tick();
  await Promise.all([a, b]);
  assert.ok(r.calls.run <= 4);
});

test('errors back off: 30, 60, 120 min ... capped at 4 h; a success resets it', async () => {
  let fail = true;
  const r = rig({ run: () => { if (fail) throw new Error('net::ERR_FAILED'); return { state: 'ready', campaigns: [], claimed: [] }; } });
  r.c.start();
  await r.advance(MIN);
  assert.equal(r.calls.run, 1);
  const gaps = [];
  for (let i = 0; i < 5; i++) { const before = r.now(); gaps.push(r.c.nextAt - before); await r.advance(r.c.nextAt - before); }
  assert.deepEqual(gaps.map((g) => g / MIN), [30, 60, 120, 240, 240]);
  assert.ok(r.logs.some((l) => /check failed \(net::ERR_FAILED\); next try in 30 min/.test(l)));
  fail = false;
  await r.advance(r.c.nextAt - r.now());
  assert.equal(r.c.failures, 0);
  assert.equal(r.c.nextAt - r.now(), 15 * MIN);
});

test('a page that never loads, or shows the sign-in wall, counts as an error', async () => {
  for (const state of ['loading', 'signed-out']) {
    const r = rig({ run: () => ({ state, campaigns: [], claimed: [] }) });
    r.c.start();
    await r.advance(MIN);
    assert.equal(r.c.failures, 1, state);
    assert.equal(r.c.nextAt - r.now(), 30 * MIN);
  }
});

test('claims: confirmed ones are logged by name (no IDs) and toasted; unconfirmed ones only logged', async () => {
  const r = rig({ run: () => ({ state: 'ready', campaigns: [{ game: 'Rust', name: 'Rust: Week', drops: [{ name: 'Jacket', percent: 45, claimable: false }] }],
    claimed: [{ name: 'Frost Hatchet', confirmed: true }, { name: 'Banner 1234567890 https://x.y/z', confirmed: true }, { name: 'Pet', confirmed: false }] }) });
  r.c.start();
  await r.advance(MIN);
  assert.deepEqual(r.toasts, ['Frost Hatchet', 'Banner']);
  assert.ok(r.logs.includes('[drops] claimed Frost Hatchet'));
  assert.ok(r.logs.includes('[drops] claimed Banner'));
  assert.ok(r.logs.some((l) => /clicked Claim for Pet, but the page did not confirm it/.test(l)));
  assert.ok(!r.logs.some((l) => /\d{6,}|https?:/.test(l)));
  assert.equal(r.progress.length, 1);
  assert.equal(r.progress[0][0].game, 'Rust');
});

test('stop() cancels the next check', async () => {
  const r = rig();
  r.c.start();
  r.c.stop();
  await r.advance(60 * MIN);
  assert.equal(r.calls.run, 0);
});

test('inventory URLs', () => {
  assert.ok(D.isInventoryUrl('https://www.twitch.tv/drops/inventory'));
  assert.ok(D.isInventoryUrl('https://twitch.tv/drops/inventory/'));
  assert.ok(!D.isInventoryUrl('http://www.twitch.tv/drops/inventory'));
  assert.ok(!D.isInventoryUrl('https://www.twitch.tv.evil.example/drops/inventory'));
  assert.ok(!D.isInventoryUrl('https://www.twitch.tv/drops/campaigns'));
  assert.ok(D.isDropsPageUrl('https://www.twitch.tv/drops/campaigns'));
  assert.ok(!D.isDropsPageUrl('https://www.twitch.tv/dropsfoo'));
  assert.ok(!D.isDropsPageUrl('not a url'));
});

test('allowFraming drops only X-Frame-Options and frame-ancestors', () => {
  const out = D.allowFraming({
    'X-Frame-Options': ['SAMEORIGIN'],
    'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'self' https://*.twitch.tv; img-src *"],
    'Set-Cookie': ['a=b'],
  });
  assert.equal(out['X-Frame-Options'], undefined);
  assert.deepEqual(out['Set-Cookie'], ['a=b']);
  assert.equal(out['Content-Security-Policy'].length, 1);
  assert.doesNotMatch(out['Content-Security-Policy'][0], /frame-ancestors/);
  assert.match(out['Content-Security-Policy'][0], /default-src 'self'; img-src \*/);
  // A CSP that was only frame-ancestors disappears.
  assert.deepEqual(D.allowFraming({ 'content-security-policy': ['frame-ancestors https://www.twitch.tv'] }), {});
});

test('claim text matches Claim / Claim Now / Click to claim, never Claimed or longer labels', () => {
  for (const t of ['Claim', 'Claim Now', ' click to claim ', 'CLAIM NOW', 'Claim Drop']) assert.match(t, D.CLAIM_TEXT, t);
  for (const t of ['Claimed', 'Learn how to claim', 'Claim all rewards in settings', 'Unclaim']) assert.doesNotMatch(t, D.CLAIM_TEXT, t);
});

test('scan source: claims only when asked, bounded clicks, and the selectors are embedded', () => {
  const on = D.scanSource({ claim: true, maxClaims: 99, gapMs: 10 });
  const off = D.scanSource({ claim: false });
  assert.match(on, /if \(true\)/);
  assert.match(off, /if \(false\)/);
  assert.match(on, /i < 20;/); // at most 20 clicks per run, whatever is asked
  assert.ok(on.includes('inventory-campaign-info'));
  assert.ok(on.includes('[role=\\"progressbar\\"]'));
  new Function(`return ${on}`); // valid JavaScript
  new Function(`return ${off}`);
});

test('cleanName', () => {
  assert.equal(D.cleanName('  Frost\n Hatchet '), 'Frost Hatchet');
  assert.equal(D.cleanName(''), 'a drop');
  assert.equal(D.cleanName('x'.repeat(200)).length, 80);
});

test('the Auto-claim drops setting defaults on and is a boolean', () => {
  assert.equal(DEFAULT_SETTINGS.autoClaimDrops, true);
  assert.deepEqual(sanitizeSettings({ autoClaimDrops: 0 }), { autoClaimDrops: false });
});

test('the Drops frame never takes DOM focus, and re-preparing it keeps a running navigation', async () => {
  const { ensureNavSource } = require('../../src/main/frame-nav');
  const { createDropsFrameHost } = require('../../src/main/drops-frame');
  assert.equal(D.NAV_OPTIONS.domFocus, false);
  const src = ensureNavSource(D.NAV_OPTIONS);
  assert.ok(src.startsWith("(window.__lbNav ? 'already' : "));
  const ran = [];
  const frame = { executeJavaScript: async (s) => { ran.push(s); return s.includes('start()') ? true : 'already'; } };
  const host = createDropsFrameHost({ frames: () => [frame], zoom: () => 1.5 });
  await host.prepare();
  assert.equal(ran.length, 1, 'not engaged: only the zoom');
  await host.open();
  await new Promise((r) => setTimeout(r, 0));
  await host.prepare();
  assert.ok(ran.filter((s) => s.includes('__lbNav ?') && s.includes('installNav')).length >= 1);
  await host.close();
  assert.equal(host.engaged, false);
});
