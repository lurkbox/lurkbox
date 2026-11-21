import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyEvents, toStandard, isSteamVirtualPad } = require('../../src/main/joydev.js');

function ev(type, number, value, init = false) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0, 0); b.writeInt16LE(value, 4); b.writeUInt8(type | (init ? 0x80 : 0), 6); b.writeUInt8(number, 7);
  return b;
}

test('joydev events map to a standard gamepad snapshot', () => {
  const st = { buttons: [], axes: [] };
  const buf = Buffer.concat([ev(1, 0, 1, true), ev(2, 7, -32767), ev(2, 0, 32767), ev(2, 2, -32767), ev(1, 7, 1)]);
  assert.equal(applyEvents(buf, st), 40);
  const g = toStandard(st);
  assert.equal(g.buttons[0].pressed, true);   // A
  assert.equal(g.buttons[12].pressed, true);  // D-pad up from hat Y
  assert.equal(g.buttons[9].pressed, true);   // Start (joydev 7 -> standard 9)
  assert.equal(g.buttons[6].pressed, false);  // left trigger at rest
  assert.equal(g.axes[0], 1);                 // left stick X
});

test('Steam virtual pads are recognised; other pads are left to the Gamepad API', () => {
  assert.equal(isSteamVirtualPad({ name: 'Microsoft X-Box 360 pad 1', vendor: '28de' }), true);
  assert.equal(isSteamVirtualPad({ name: 'Sony DualSense', vendor: '054c' }), false);
});
