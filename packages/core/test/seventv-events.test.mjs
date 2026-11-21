import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SevenTVEvents, paintCss, rgba, badgeFrom7tv, emoteSetChanges, entitlementTwitchIds } from '../src/js/seventv-events.js';

const user = (twitchId) => ({ id: 'STV', connections: [{ platform: 'TWITCH', id: twitchId }, { platform: 'DISCORD', id: 'd' }] });
const emote = (name, id = name) => ({ id, name, flags: 0, data: { id, name, flags: 0, animated: false, host: { url: `//cdn.7tv.app/emote/${id}`, files: [{ name: '1x.webp', width: 28, height: 28, format: 'WEBP' }, { name: '2x.webp', width: 56, height: 56, format: 'WEBP' }] } } });

test('rgba: 7TV colours are signed 32-bit RGBA', () => {
  assert.equal(rgba(-16729089), 'rgba(255, 0, 187, 1.000)');
  assert.equal(rgba(7357951), 'rgba(0, 112, 69, 1.000)');
  assert.equal(rgba(0xff000080), 'rgba(255, 0, 0, 0.502)');
});

test('paintCss: linear, radial, image and layered paints; nothing drawable gives ""', () => {
  const lin = paintCss({ data: { function: 'LINEAR_GRADIENT', angle: 135, repeat: false, stops: [{ at: 0.2, color: 7357951 }, { at: 0.8, color: -16729089 }], shadows: [{ x_offset: 0, y_offset: 0, radius: 4, color: -16729089 }] } });
  assert.match(lin, /background-image: linear-gradient\(135deg, rgba\(0, 112, 69, 1\.000\) 20%, rgba\(255, 0, 187, 1\.000\) 80%\)/);
  assert.match(lin, /background-clip: text/);
  assert.match(lin, /filter: drop-shadow\(0px 0px 4px rgba\(255, 0, 187, 1\.000\)\)/);
  assert.match(paintCss({ data: { function: 'RADIAL_GRADIENT', shape: 'circle', repeat: true, stops: [{ at: 0, color: 255 }, { at: 1, color: 255 }] } }), /repeating-radial-gradient\(circle,/);
  assert.match(paintCss({ data: { function: 'URL', image_url: 'https://cdn.7tv.app/paint/x/1x.webp', stops: [] } }), /url\("https:\/\/cdn\.7tv\.app\/paint\/x\/1x\.webp"\)/);
  assert.equal(paintCss({ data: { function: 'URL', image_url: 'a"); color: red; ("', stops: [] } }).includes('"); color'), false, 'quotes cannot break out of url()');
  assert.match(paintCss({ data: { gradients: [{ function: 'LINEAR_GRADIENT', angle: 90, stops: [{ at: 0, color: 255 }, { at: 1, color: 255 }] }, { function: 'URL', image_url: 'u' }] } }), /linear-gradient\(90deg.*\), url\("u"\)/);
  assert.equal(paintCss({ data: { function: 'LINEAR_GRADIENT', stops: [] } }), '');
});

test('helpers: badges, entitlement ids, emote set changes', () => {
  assert.deepEqual(badgeFrom7tv({ data: { tooltip: '7TV Sub', host: { url: '//cdn.7tv.app/badge/B', files: [{ name: '1x.webp', format: 'WEBP' }, { name: '2x.webp', format: 'WEBP' }] } } }), { url: 'https://cdn.7tv.app/badge/B/2x.webp', title: '7TV Sub' });
  assert.deepEqual(entitlementTwitchIds({ user: user('123') }), ['123']);
  const ch = emoteSetChanges({ pushed: [{ key: 'emotes', value: emote('New') }], pulled: [{ key: 'emotes', old_value: emote('Gone') }], updated: [{ key: 'emotes', old_value: emote('Old', 'R'), value: emote('Renamed', 'R') }] });
  assert.deepEqual(ch.add.map((e) => e.name), ['New', 'Renamed']);
  assert.deepEqual(ch.remove, ['Gone', 'Old']);
});

test('SevenTVEvents: subscribes on hello, scoped to the channel and its emote set', () => {
  const sent = [];
  class FakeWS { constructor(url) { this.url = url; FakeWS.last = this; } send(s) { sent.push(JSON.parse(s)); } close() {} }
  const ev = new SevenTVEvents({ WebSocketImpl: FakeWS });
  ev.watch('71092938', { setId: 'SET', cosmetics: true });
  assert.equal(FakeWS.last.url, 'wss://events.7tv.io/v3');
  FakeWS.last.onmessage({ data: JSON.stringify({ op: 1, d: { session_id: 's', heartbeat_interval: 45000 } }) });
  assert.deepEqual(sent.map((m) => [m.op, m.d.type, m.d.condition]), [
    [35, 'emote_set.*', { object_id: 'SET' }],
    [35, 'entitlement.*', { ctx: 'channel', platform: 'TWITCH', id: '71092938' }],
    [35, 'cosmetic.*', { ctx: 'channel', platform: 'TWITCH', id: '71092938' }],
    [35, 'emote_set.*', { ctx: 'channel', platform: 'TWITCH', id: '71092938' }],
  ]);
  const before = FakeWS.last;
  new SevenTVEvents({ WebSocketImpl: FakeWS }).watch('2', { setId: null, cosmetics: false });
  assert.equal(FakeWS.last, before, 'nothing to watch: no connection');
});

test('SevenTVEvents: paints and badges reach users through entitlements, in either order', () => {
  const ev = new SevenTVEvents({ WebSocketImpl: null });
  const seen = [];
  ev.onCosmetics = (ids) => seen.push(...ids);
  ev.dispatch({ type: 'entitlement.create', body: { object: { kind: 'PAINT', ref_id: 'P1', user: user('42') } } });
  assert.deepEqual(ev.cosmeticsFor('42'), { paintId: null, badge: null }, 'paint not defined yet');
  ev.dispatch({ type: 'cosmetic.create', body: { object: { id: 'P1', kind: 'PAINT', data: { function: 'LINEAR_GRADIENT', angle: 0, stops: [{ at: 0, color: 255 }, { at: 1, color: -1 }] } } } });
  assert.equal(ev.cosmeticsFor('42').paintId, 'P1');
  ev.dispatch({ type: 'cosmetic.create', body: { object: { id: 'B1', kind: 'BADGE', data: { tooltip: 'Sub', host: { url: '//cdn/b', files: [{ name: '2x.webp', format: 'WEBP' }] } } } } });
  ev.dispatch({ type: 'entitlement.create', body: { object: { kind: 'BADGE', ref_id: 'B1', user: user('42') } } });
  assert.equal(ev.cosmeticsFor('42').badge.title, 'Sub');
  assert.ok(seen.includes('42'));
  ev.dispatch({ type: 'entitlement.delete', body: { object: { kind: 'PAINT', ref_id: 'P1', user: user('42') } } });
  assert.equal(ev.cosmeticsFor('42').paintId, null);
});

test('SevenTVEvents: channel emote changes and personal sets', () => {
  const ev = new SevenTVEvents({ WebSocketImpl: null });
  ev.setId = 'CHAN';
  const got = [];
  const sets = [];
  ev.onEmotes = (x) => got.push(x);
  ev.onUserSet = (...a) => sets.push(a);
  ev.dispatch({ type: 'emote_set.update', body: { id: 'CHAN', pushed: [{ key: 'emotes', value: emote('Fresh') }] } });
  assert.equal(got[0].personal, false);
  assert.deepEqual(got[0].add.map((e) => e.name), ['Fresh']);
  ev.dispatch({ type: 'emote_set.update', body: { id: 'OTHER', pushed: [{ key: 'emotes', value: emote('X') }] } });
  assert.equal(got.length, 1, 'unknown sets are ignored');
  ev.dispatch({ type: 'emote_set.create', body: { object: { id: 'PERS', flags: 4, emotes: [] } } });
  ev.dispatch({ type: 'entitlement.create', body: { object: { kind: 'EMOTE_SET', ref_id: 'PERS', user: user('9') } } });
  ev.dispatch({ type: 'emote_set.update', body: { id: 'PERS', pushed: [{ key: 'emotes', value: emote('Mine') }] } });
  assert.deepEqual(sets, [['9', 'PERS', true]]);
  assert.equal(got[1].personal, true);
  assert.equal(got[1].setId, 'PERS');
});
