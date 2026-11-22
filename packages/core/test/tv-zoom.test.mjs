import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvZoom, twitchChatZoom, twitchChatPanelWidth, zoomFrameSource, chatFrameZoom, TWITCH_CHAT_SIZES } from '../src/shared/tv-zoom.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings.js';
import { twitchChatSizeItems } from '../src/js/views/settings-chat.js';

test('tv zoom: the login window rule (about 1.74 on the 800-px Game Mode screen)', () => {
  assert.equal(tvZoom(800), 1.74);
  assert.equal(tvZoom(1080), 2.35);
  assert.equal(tvZoom(2160), 3);
  assert.equal(tvZoom(400), 1);
  assert.equal(tvZoom(800, 120), 2.09);
});

test('twitch chat size: Auto by default, fixed percentages, junk falls back to Auto', () => {
  assert.equal(DEFAULT_SETTINGS.twitchChatSize, 'auto');
  assert.equal(twitchChatZoom(DEFAULT_SETTINGS, 800), 1.74);
  assert.equal(twitchChatZoom({ twitchChatSize: 'auto', uiScale: 110 }, 800), 1.91);
  assert.equal(twitchChatZoom({ twitchChatSize: 150, uiScale: 125 }, 800), 1.5);
  assert.equal(twitchChatZoom({}, 1080), 2.35);
  assert.deepEqual(sanitizeSettings({ twitchChatSize: '200' }), { twitchChatSize: 200 });
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 999 }), { twitchChatSize: 'auto' });
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 'auto' }), { twitchChatSize: 'auto' });
  const items = twitchChatSizeItems(DEFAULT_SETTINGS, 800);
  assert.deepEqual(items.map((i) => i.value), ['auto', ...TWITCH_CHAT_SIZES]);
  assert.equal(items[0].label, 'Auto (174%)');
  assert.equal(TWITCH_CHAT_SIZES[0], 100);
  assert.equal(TWITCH_CHAT_SIZES.at(-1), 250);
});

test('twitch chat panel: 340 CSS px of layout at the zoom, capped at 45% of the window', () => {
  assert.equal(twitchChatPanelWidth(1, 1280), 340);
  assert.equal(twitchChatPanelWidth(1.74, 1280), 576); // 340 * 1.74 = 591.6, cap 576
  assert.equal(twitchChatPanelWidth(1.5, 1920), 510);
  assert.equal(twitchChatPanelWidth(2.5, 1920), 850);
  assert.equal(twitchChatPanelWidth(2.5, 1600), 720);
  assert.equal(twitchChatPanelWidth(1.74, 0), 592);
});

test('twitch chat frame zoom script: a clamped, idempotent <html> zoom style', () => {
  const src = zoomFrameSource(1.74);
  assert.match(src, /let z = 1\.74;/);
  assert.match(src, /html \{ zoom: ' \+ z \+ ' !important; \}/);
  assert.match(src, /lurkbox-tv-zoom/);
  assert.match(zoomFrameSource(99), /let z = 3;/);
  assert.match(zoomFrameSource('x'), /let z = 1;/);
  assert.match(zoomFrameSource(1.74, { minWidth: 400 }), /innerWidth \/ 400/);
});

test('twitch chat frame zoom by mode: the hidden frame keeps a desktop layout, the rewards view keeps 400 CSS px', () => {
  assert.deepEqual(chatFrameZoom('hidden', 1.74), { zoom: 1 });
  assert.deepEqual(chatFrameZoom('panel', 1.74), { zoom: 1.74 });
  assert.deepEqual(chatFrameZoom('modal', 2.35), { zoom: 2.35, minWidth: 400 });
});
