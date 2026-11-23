// The shared twitch.tv page logic the hosts run (shared/channel-points.js, follow.js, drops.js, tv-zoom.js): the
// pieces added for hosts that show the pages in their own windows (Android).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { rewardsViewSource, rewardsReturnSource, chatPageUrl, scanSource, openRewardsSource } from '../src/shared/channel-points.js';
import { scanInventory, scanSource as dropsScanSource } from '../src/shared/drops.js';
import { pageSource } from '../src/shared/follow.js';
import { modalZoom, TWITCH_MODAL_MIN_LAYOUT_PX } from '../src/shared/tv-zoom.js';

test('the sources injected into twitch.tv pages are valid scripts', () => {
  for (const src of [rewardsViewSource({ rewards: true }), rewardsViewSource({ rewards: false }), rewardsReturnSource(), scanSource({ autoClaim: true }), openRewardsSource(), dropsScanSource({ claim: true }), pageSource({ login: 'a', act: 'follow' })]) {
    assert.doesNotThrow(() => new vm.Script(src), src.slice(0, 80));
  }
});

test('rewards view: opens the popover only for rewards, fits it, starts the navigation once per page', () => {
  const on = rewardsViewSource({ rewards: true });
  const off = rewardsViewSource({ rewards: false });
  assert.ok(on.includes('if (true) for'));
  assert.ok(off.includes('if (false) for'));
  for (const s of [on, off]) {
    assert.ok(s.includes('window.__lbRewardsView') && s.includes('window.__lbFit') && s.includes('window.__lbNav.start()'));
    assert.ok(!/cookie/i.test(s.replace(/document\.cookie/g, '')), 'no cookie handling');
  }
  assert.ok(rewardsReturnSource().includes('BALANCE_BUTTON'));
});

test('chat page URL: lowercased, only valid logins', () => {
  assert.equal(chatPageUrl('SomeOne_1'), 'https://www.twitch.tv/embed/someone_1/chat?parent=localhost&darkpopout');
  assert.equal(chatPageUrl('a/b'), null);
  assert.equal(chatPageUrl(''), null);
});

test('modal zoom keeps a 400 px layout, never below 1', () => {
  assert.equal(TWITCH_MODAL_MIN_LAYOUT_PX, 400);
  assert.equal(modalZoom(2.5, 960), 2.4);
  assert.equal(modalZoom(1.2, 960), 1.2);
  assert.equal(modalZoom(2, 300), 1);
  assert.equal(modalZoom(9, 0), 3);
});

test('inventory scan: waits for the page, settles, then scans once more with claim', async () => {
  const seen = [];
  const answers = [{ state: 'loading' }, { state: 'loading' }, { state: 'ready', campaigns: [] }, { state: 'ready', campaigns: [], claimed: [{ name: 'x', confirmed: true }] }];
  const sleeps = [];
  const r = await scanInventory({ page: { eval: async (s) => { seen.push(s.includes('if (true)')); return answers.shift(); } }, claim: true, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(r.claimed, [{ name: 'x', confirmed: true }]);
  assert.deepEqual(seen, [false, false, false, true]);
  assert.deepEqual(sleeps, [1000, 1000, 2500]);
  const out = await scanInventory({ page: { eval: async () => ({ state: 'signed-out', campaigns: [], claimed: [] }) }, claim: true, sleep: async () => {} });
  assert.equal(out.state, 'signed-out');
  const never = await scanInventory({ page: { eval: async () => null }, claim: true, tries: 2, sleep: async () => {} });
  assert.equal(never.state, 'loading');
});
