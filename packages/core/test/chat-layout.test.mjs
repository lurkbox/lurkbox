import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatLayout, chatPanelWidth, chatOverActive, sanitizeChatLayout, widthPercent, twitchLayoutPx, CHAT_LAYOUT_DEFAULTS, MIN_PANEL_PX,
  chatBox, chatHeightApplies,
} from '../src/shared/chat-layout.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings.js';
import { twitchChatZoom, twitchChatPanelWidth } from '../src/shared/tv-zoom.js';
import { chatControlSpecs, resetChatLayoutPatch } from '../src/js/chat-controls.js';

const ENV = { windowWidth: 1280, screenHeight: 800, remPx: 18.56, direct: true };

test('chat layout defaults live in DEFAULT_SETTINGS and keep the old look (Auto width, right side, opaque)', () => {
  for (const [k, v] of Object.entries(CHAT_LAYOUT_DEFAULTS)) assert.equal(DEFAULT_SETTINGS[k], v, k);
  assert.equal(DEFAULT_SETTINGS.chatWidth, 'auto');
  assert.equal(DEFAULT_SETTINGS.chatSide, 'right');
  assert.equal(DEFAULT_SETTINGS.chatOverlay, false);
  assert.deepEqual(chatLayout({}), { ...CHAT_LAYOUT_DEFAULTS });
});

test('chat layout validation: snapped to steps, clamped, junk falls back', () => {
  assert.deepEqual(sanitizeChatLayout({ chatTextSize: 312 }), { chatTextSize: 250 });
  assert.deepEqual(sanitizeChatLayout({ chatTextSize: 61 }), { chatTextSize: 75 });
  assert.deepEqual(sanitizeChatLayout({ chatTextSize: 132 }), { chatTextSize: 130 });
  assert.deepEqual(sanitizeChatLayout({ chatTextSize: 'big' }), { chatTextSize: 100 });
  assert.deepEqual(sanitizeChatLayout({ chatWidth: 77 }), { chatWidth: 50 });
  assert.deepEqual(sanitizeChatLayout({ chatWidth: '33' }), { chatWidth: 33 });
  assert.deepEqual(sanitizeChatLayout({ chatWidth: 'x' }), { chatWidth: 'auto' });
  assert.deepEqual(sanitizeChatLayout({ chatSide: 'up' }), { chatSide: 'right' });
  assert.deepEqual(sanitizeChatLayout({ chatBgOpacity: -4, chatOverlayOpacity: 62 }), { chatBgOpacity: 0, chatOverlayOpacity: 60 });
  assert.deepEqual(sanitizeChatLayout({ chatOverlay: 1 }), { chatOverlay: true });
  // Twitch chat size: any 75..250 step of 5 (the slider), Auto otherwise; the old fixed sizes still work.
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 175 }), { twitchChatSize: 175 });
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 137 }), { twitchChatSize: 135 });
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 80 }), { twitchChatSize: 80 });
  assert.deepEqual(sanitizeSettings({ twitchChatSize: 999 }), { twitchChatSize: 'auto' });
  assert.equal(twitchChatZoom({ twitchChatSize: 135 }, 800), 1.35);
  assert.equal(twitchChatZoom({ twitchChatSize: 'auto' }, 800), 1.74);
});

test('panel width: Auto keeps the old rules', () => {
  assert.equal(chatPanelWidth({ style: 'lurkbox', chatWidth: 'auto', windowWidth: 1280, remPx: 18.56 }), Math.round(26 * 18.56));
  assert.equal(chatPanelWidth({ style: 'lurkbox', chatWidth: 'auto', windowWidth: 1024, remPx: 16 }), 22 * 16, '22 rem up to 1100 px');
  assert.equal(chatPanelWidth({ style: 'lurkbox', chatWidth: 'auto', windowWidth: 600, remPx: 18 }), 300, 'never more than half the window');
  for (const [z, w] of [[1.74, 1280], [1.5, 1920], [1, 1280]]) {
    assert.equal(chatPanelWidth({ style: 'twitch', chatWidth: 'auto', windowWidth: w, zoom: z }), twitchChatPanelWidth(z, w));
  }
});

test('panel width: a percentage of the window, clamped so the video keeps at least half', () => {
  assert.equal(chatPanelWidth({ chatWidth: 30, windowWidth: 1280 }), 384);
  assert.equal(chatPanelWidth({ chatWidth: 50, windowWidth: 1280 }), 640);
  assert.equal(chatPanelWidth({ chatWidth: 90, windowWidth: 1280 }), 640, 'over 50% is clamped');
  assert.equal(chatPanelWidth({ chatWidth: 20, windowWidth: 800 }), MIN_PANEL_PX, 'a usable column at least');
  assert.equal(chatPanelWidth({ chatWidth: 20, windowWidth: 400 }), 200, 'but still at most half a tiny window');
  // Twitch chat: at least 250 CSS px of layout inside the zoomed frame (within half the window).
  const z = 1.74;
  const px = chatPanelWidth({ style: 'twitch', chatWidth: 20, windowWidth: 1280, zoom: z });
  assert.equal(px, Math.round(250 * z));
  assert.ok(twitchLayoutPx(px, z) >= 250);
  assert.equal(chatPanelWidth({ style: 'twitch', chatWidth: 20, windowWidth: 1280, zoom: 3 }), 640, 'half the window wins');
  assert.equal(widthPercent(482, 1280), 38);
  assert.equal(widthPercent(10, 1280), 20);
});

test('"over the video" only for Lurkbox chat on the Lurkbox player', () => {
  const layout = chatLayout({ chatOverlay: true });
  assert.equal(chatOverActive({ layout, style: 'lurkbox', direct: true }), true);
  assert.equal(chatOverActive({ layout, style: 'twitch', direct: true }), false);
  assert.equal(chatOverActive({ layout, style: 'lurkbox', direct: false }), false);
  assert.equal(chatOverActive({ layout: chatLayout({}), style: 'lurkbox' }), false);
});

test('chat controls: the pop-over and Settings show the same values, from the same keys', () => {
  const s = { ...DEFAULT_SETTINGS, chatTextSize: 140, chatWidth: 33, chatSide: 'left' };
  const specs = Object.fromEntries(chatControlSpecs(s, ENV).map((x) => [x.key, x]));
  assert.equal(specs.chatTextSize.value, 140);
  assert.equal(specs.chatTextSize.text, '140%');
  assert.equal(specs.chatWidth.value, 33);
  assert.equal(specs.chatSide.value, 'left');
  assert.deepEqual(specs.chatTextSize.patch(150), { chatTextSize: 150 });
  assert.deepEqual(specs.chatWidth.patch(40), { chatWidth: 40 });
  assert.equal(specs.chatOverlayOpacity.disabled, true, 'its slider is off until "over the video" is on');
  assert.equal(specs.chatOverlayOpacity.hidden, true);
  assert.equal(specs.chatBgOpacity.hidden, false);
  const over = Object.fromEntries(chatControlSpecs({ ...s, chatOverlay: true }, ENV).map((x) => [x.key, x]));
  assert.equal(over.chatOverlayOpacity.hidden, false);
  assert.equal(over.chatBgOpacity.hidden, true, 'over the video, its own opacity applies');
  // Auto width shows the current share.
  const auto = Object.fromEntries(chatControlSpecs(DEFAULT_SETTINGS, ENV).map((x) => [x.key, x]));
  assert.equal(auto.chatWidth.text, `Auto · ${widthPercent(Math.round(26 * 18.56), 1280)}%`);
});

test('chat controls in Twitch chat style: text size drives the Twitch chat zoom; "over the video" is disabled with a note', () => {
  const s = { ...DEFAULT_SETTINGS, chatStyle: 'twitch' };
  const specs = Object.fromEntries(chatControlSpecs(s, ENV).map((x) => [x.key, x]));
  assert.ok(!specs.chatTextSize);
  assert.equal(specs.twitchChatSize.value, 174, 'Auto shows the zoom it resolves to');
  assert.equal(specs.twitchChatSize.text, 'Auto · 174%');
  assert.deepEqual(specs.twitchChatSize.patch(200), { twitchChatSize: 200 });
  assert.equal(specs.chatOverlay.disabled, true);
  assert.match(specs.chatOverlay.note, /pause/);
  assert.equal(specs.chatBgOpacity.disabled, true);
  assert.equal(specs.chatBgOpacity.hidden, true);
  assert.equal(specs.chatOverlay.hidden, undefined, '"over the video" stays visible (disabled, with the note)');
  const fixed = Object.fromEntries(chatControlSpecs({ ...s, twitchChatSize: 125 }, ENV).map((x) => [x.key, x]));
  assert.equal(fixed.twitchChatSize.text, '125%');
  // The Twitch player engine can't take an overlay either: chat stays beside it.
  const embed = Object.fromEntries(chatControlSpecs({ ...DEFAULT_SETTINGS, chatOverlay: true }, { ...ENV, direct: false }).map((x) => [x.key, x]));
  assert.match(embed.chatOverlay.note, /beside/);
});

test('reset chat layout puts every layout key back, and nothing else', () => {
  const patch = resetChatLayoutPatch();
  assert.deepEqual(Object.keys(patch).sort(), Object.keys(CHAT_LAYOUT_DEFAULTS).sort());
  assert.deepEqual(sanitizeSettings(patch), patch);
  assert.ok(!('chatStyle' in patch));
});

test('chat height: defaults keep the whole height; the setting snaps to 5, clamps to 30..100, junk is 100', () => {
  assert.equal(DEFAULT_SETTINGS.chatHeight, 100);
  assert.equal(DEFAULT_SETTINGS.chatVPos, 'bottom');
  assert.deepEqual(sanitizeChatLayout({ chatHeight: 12 }), { chatHeight: 30 });
  assert.deepEqual(sanitizeChatLayout({ chatHeight: 140 }), { chatHeight: 100 });
  assert.deepEqual(sanitizeChatLayout({ chatHeight: '62' }), { chatHeight: 60 });
  assert.deepEqual(sanitizeChatLayout({ chatHeight: 'tall' }), { chatHeight: 100 });
  assert.deepEqual(sanitizeChatLayout({ chatHeight: null }), { chatHeight: 100 });
  assert.deepEqual(sanitizeChatLayout({ chatVPos: 'top' }), { chatVPos: 'top' });
  assert.deepEqual(sanitizeChatLayout({ chatVPos: 'middle' }), { chatVPos: 'bottom' });
  assert.deepEqual(sanitizeSettings({ chatHeight: 47, chatVPos: 'top' }), { chatHeight: 45, chatVPos: 'top' });
  assert.deepEqual(sanitizeSettings({ chatVPos: 7 }), { chatVPos: 'bottom' });
});

test('chat box: 100% is the whole height (as before); shorter boxes anchor top or bottom', () => {
  assert.deepEqual(chatBox({ chatHeight: 100, screenHeight: 800 }), { full: true, height: 800, top: 0, bottom: 0 });
  assert.deepEqual(chatBox({ chatHeight: 'junk', screenHeight: 800 }), { full: true, height: 800, top: 0, bottom: 0 });
  assert.deepEqual(chatBox({ chatHeight: 50, chatVPos: 'top', screenHeight: 800 }), { full: false, height: 400, top: 0, bottom: null });
  assert.deepEqual(chatBox({ chatHeight: 50, chatVPos: 'bottom', screenHeight: 800 }), { full: false, height: 400, top: null, bottom: 0 });
  assert.equal(chatBox({ chatHeight: 10, screenHeight: 800 }).height, 240, 'clamped to 30%');
  // Layouts that ignore it (phone, touch portrait) keep the whole height.
  assert.equal(chatBox({ chatHeight: 50, screenHeight: 800, applies: false }).full, true);
});

test('chat box over the video: a bottom chat lifts above the open control bar; side panels and top chats stay put', () => {
  const base = { chatHeight: 50, chatVPos: 'bottom', screenHeight: 800, barPx: 150 };
  assert.deepEqual(chatBox({ ...base, over: true, overlayOpen: true }), { full: false, height: 400, top: null, bottom: 150 });
  assert.equal(chatBox({ ...base, over: true, overlayOpen: false }).bottom, 0, 'bar closed: back down');
  assert.equal(chatBox({ ...base, over: false, overlayOpen: true }).bottom, 0, 'beside the video the bar is on the video');
  assert.deepEqual(chatBox({ ...base, chatVPos: 'top', over: true, overlayOpen: true }), { full: false, height: 400, top: 0, bottom: null });
  // A tall chat gets shorter so it still fits above the bar...
  assert.deepEqual(chatBox({ ...base, chatHeight: 90, over: true, overlayOpen: true }), { full: false, height: 650, top: null, bottom: 150 });
  // ...and a huge bar never pushes it under 30% of the screen.
  const big = chatBox({ ...base, barPx: 700, over: true, overlayOpen: true });
  assert.equal(big.bottom, 560);
  assert.equal(big.height, 240);
  // 100% keeps the old behaviour: full height, no lift.
  assert.deepEqual(chatBox({ ...base, chatHeight: 100, over: true, overlayOpen: true }), { full: true, height: 800, top: 0, bottom: 0 });
});

test('chat height applies everywhere but the phone layout and touch portrait', () => {
  assert.equal(chatHeightApplies({ mode: 'tv' }), true);
  assert.equal(chatHeightApplies({ mode: 'tablet', touch: true, portrait: false }), true);
  assert.equal(chatHeightApplies({ mode: 'tablet', touch: true, portrait: true }), false);
  assert.equal(chatHeightApplies({ mode: 'phone', touch: true, portrait: false }), false);
  assert.equal(chatHeightApplies({ mode: 'tv', touch: false, portrait: true }), true, 'a tall desktop window is still TV');
});

test('chat controls: Height slider, and Position only under 100%', () => {
  const at = (s, env = ENV) => Object.fromEntries(chatControlSpecs({ ...DEFAULT_SETTINGS, ...s }, env).map((x) => [x.key, x]));
  const full = at({});
  assert.equal(full.chatHeight.value, 100);
  assert.equal(full.chatHeight.text, '100%');
  assert.equal(full.chatVPos.hidden, true);
  assert.deepEqual(full.chatHeight.patch(60), { chatHeight: 60 });
  const short = at({ chatHeight: 60, chatVPos: 'top' });
  assert.equal(short.chatVPos.hidden, false);
  assert.equal(short.chatVPos.value, 'top');
  assert.deepEqual(short.chatVPos.patch('bottom'), { chatVPos: 'bottom' });
  assert.match(short.chatHeight.note, /video keeps its size/);
  assert.match(at({ chatHeight: 60, chatOverlay: true }).chatHeight.note, /moves up/);
  const twitch = at({ chatHeight: 60, chatStyle: 'twitch' });
  assert.equal(twitch.chatHeight.disabled, false, 'Twitch chat style follows the height too');
  const phone = at({ chatHeight: 60 }, { ...ENV, heightApplies: false });
  assert.equal(phone.chatHeight.disabled, true);
  assert.equal(phone.chatVPos.disabled, true);
  assert.match(phone.chatHeight.note, /Not used in this layout/);
});
