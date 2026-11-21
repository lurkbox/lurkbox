import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TOGGLES, chatSettingOn } from '../src/js/views/settings-chat.js';
import { chatPrefs } from '../src/js/chat.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings.js';

const KEYS = ['chatEmotes7tv', 'chatEmotesBttv', 'chatEmotesFfz', 'chatAnimatedEmotes', 'chat7tvCosmetics'];

test('chat settings: emotes, animation and 7TV cosmetics on by default; extensions off', () => {
  for (const k of KEYS) assert.equal(DEFAULT_SETTINGS[k], true, k);
  assert.equal(DEFAULT_SETTINGS.chatExtensions, false);
  assert.deepEqual(CHAT_TOGGLES.map((t) => t.key), KEYS);
});

test('chat settings are sanitised to booleans', () => {
  assert.deepEqual(sanitizeSettings({ chatEmotes7tv: 0, chatEmotesBttv: 'yes', chatExtensions: 1, chatAnimatedEmotes: null }),
    { chatEmotes7tv: false, chatEmotesBttv: true, chatExtensions: true, chatAnimatedEmotes: false });
});

test('missing chat settings count as on (settings saved by older versions), extensions as off', () => {
  for (const k of KEYS) assert.equal(chatSettingOn({}, k), true);
  assert.equal(chatSettingOn({}, 'chatExtensions'), false);
  assert.equal(chatSettingOn({ chatExtensions: true }, 'chatExtensions'), true);
  assert.equal(chatSettingOn({ chatEmotesFfz: false }, 'chatEmotesFfz'), false);
});

test('chatPrefs: the toggles select providers in precedence order', () => {
  assert.deepEqual(chatPrefs({}), { providers: ['7tv', 'bttv', 'ffz'], animated: true, cosmetics: true });
  assert.deepEqual(chatPrefs({ chatEmotes7tv: false, chatAnimatedEmotes: false, chat7tvCosmetics: false }), { providers: ['bttv', 'ffz'], animated: false, cosmetics: false });
  assert.deepEqual(chatPrefs({ chatEmotesBttv: false, chatEmotesFfz: false }).providers, ['7tv']);
});
