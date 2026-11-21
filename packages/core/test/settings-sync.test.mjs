// One settings source: a slider in the chat pop-over previews through state.settings (every view sees it at once)
// and is saved shortly after; a host echo of an older save never moves it back; an explicit save wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const saved = [];
let echo = null;
globalThis.window = {
  lurkbox: {
    async setSettings(patch) { saved.push(patch); const next = { ...host, ...patch }; host = next; return next; },
    async authState() { return { signedIn: false }; },
    async appInfo() { return {}; },
    async getSettings() { return { ...host }; },
    onSettingsChanged(fn) { echo = fn; },
    onAuthState() {},
  },
};
let host = { chatTextSize: 100, chatWidth: 'auto', theme: 'lurkbox' };
const { state, onState, initState, previewSettings, flushSettings, saveSettings } = await import('../src/js/state.js');
await initState();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a preview reaches every listener at once (pop-over and Settings → Chat) and is saved after a pause', async () => {
  const seen = { popover: [], settings: [] };
  const off1 = onState((w) => { if (w === 'settings') seen.popover.push(state.settings.chatTextSize); });
  const off2 = onState((w) => { if (w === 'settings') seen.settings.push(state.settings.chatTextSize); });
  previewSettings({ chatTextSize: 120 }, 30);
  previewSettings({ chatTextSize: 125 }, 30);
  assert.deepEqual(seen.popover, [120, 125]);
  assert.deepEqual(seen.settings, [120, 125]);
  assert.equal(saved.length, 0, 'not saved while it moves');
  await wait(80);
  assert.deepEqual(saved.at(-1), { chatTextSize: 125 }, 'one save with the last value');
  assert.equal(host.chatTextSize, 125);
  off1(); off2();
});

test('previews are validated like saved settings', () => {
  previewSettings({ chatTextSize: 999, chatWidth: 'nonsense' }, 10000);
  assert.equal(state.settings.chatTextSize, 250);
  assert.equal(state.settings.chatWidth, 'auto');
});

test('an older host echo never moves a slider back; flush saves pending changes', async () => {
  previewSettings({ chatWidth: 40 }, 10000);
  echo({ ...host, chatWidth: 25 }); // e.g. the save of an earlier value arriving late
  assert.equal(state.settings.chatWidth, 40);
  await flushSettings();
  assert.equal(host.chatWidth, 40);
  echo({ ...host });
  assert.equal(state.settings.chatWidth, 40);
});

test('an explicit save (Reset chat layout) wins over a pending preview', async () => {
  previewSettings({ chatSide: 'left' }, 10000);
  await saveSettings({ chatSide: 'right' });
  assert.equal(state.settings.chatSide, 'right');
  await flushSettings();
  assert.equal(host.chatSide, 'right', 'the stale preview is not saved later');
});
