import { test } from 'node:test';
import assert from 'node:assert/strict';

// A minimal DOM: TwitchChatFrame only creates elements, sets attributes/classes and appends/removes them.
class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parent = null; this.className = ''; this.dataset = {}; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener() {}
  focus() { this.focused = true; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => new FakeNode('#text') };
const modes = [];
const watched = [];
globalThis.window = { lurkbox: { pointsMode: (m) => modes.push(m), pointsWatch: (l) => watched.push(l) } };

const { TwitchChatFrame, POINTS_MARKER } = await import('../src/js/twitch-chat.js');
const { state } = await import('../src/js/state.js');

const setup = (chatStyle, hostPages = false) => {
  state.settings = { ...state.settings, chatStyle };
  state.info = { hostPages };
  const screen = new FakeNode('div');
  return { screen, tc: new TwitchChatFrame(screen) };
};
const src = (f) => f && f.attrs.src;

test('Lurkbox chat style: one points frame, hidden under the video or the rewards modal', () => {
  const { tc } = setup('lurkbox');
  tc.open('LofiGirl');
  assert.ok(src(tc.frame).includes(POINTS_MARKER));
  assert.equal(tc.panelFrame, null);
  tc.setMode('modal');
  assert.equal(tc.host.className, 'twitch-chat-host tc-modal');
  assert.equal(tc.panelHost.className, 'twitch-chat-host tc-off');
});

test('Twitch chat style: a separate hidden points frame next to the visible panel frame', () => {
  const { tc } = setup('twitch');
  tc.open('lofigirl');
  assert.ok(src(tc.frame).includes(POINTS_MARKER), 'points frame carries the marker (no chat extensions there)');
  assert.ok(tc.panelFrame && !src(tc.panelFrame).includes(POINTS_MARKER), 'visible panel frame has no marker');
  assert.equal(tc.frame.parent, tc.host);
  assert.equal(tc.panelFrame.parent, tc.panelHost);
  tc.setMode('panel');
  assert.equal(tc.host.className, 'twitch-chat-host tc-hidden', 'points frame stays hidden under the video');
  assert.equal(tc.panelHost.className, 'twitch-chat-host tc-panel');
  assert.equal(tc.panelHost.getAttribute('aria-hidden'), 'false');
  // The rewards view uses the points frame; the panel stays shown under it.
  tc.setMode('modal');
  assert.equal(tc.host.className, 'twitch-chat-host tc-modal');
  assert.equal(tc.panelHost.className, 'twitch-chat-host tc-panel');
  assert.ok(tc.frame.focused && !tc.panelFrame.focused);
  tc.setMode('hidden');
  assert.equal(tc.host.className, 'twitch-chat-host tc-hidden');
  assert.equal(tc.panelHost.className, 'twitch-chat-host tc-off');
  // Re-opening the same channel keeps both frames; switching style rebuilds them.
  const [f, p] = [tc.frame, tc.panelFrame];
  tc.open('lofigirl');
  assert.equal(tc.frame, f);
  assert.equal(tc.panelFrame, p);
  state.settings = { ...state.settings, chatStyle: 'lurkbox' };
  tc.open('lofigirl');
  assert.notEqual(tc.frame, f);
  assert.equal(tc.panelFrame, null);
  assert.equal(p.parent, null);
  tc.close();
  assert.equal(tc.frame, null);
  assert.equal(watched.at(-1), null);
});

test('host with its own chat page (Android): Twitch chat style keeps one unmarked panel frame', () => {
  const { tc } = setup('twitch', true);
  tc.open('lofigirl');
  assert.ok(tc.frame && !src(tc.frame).includes(POINTS_MARKER));
  assert.equal(tc.panelFrame, null);
  tc.setMode('panel');
  assert.equal(tc.host.className, 'twitch-chat-host tc-panel');
  const other = setup('lurkbox', true).tc;
  other.open('lofigirl');
  assert.equal(other.frame, null);
});
