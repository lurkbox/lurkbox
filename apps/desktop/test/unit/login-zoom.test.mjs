import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loginZoom } = require('../../src/main/player-session.js');

test('login zoom scales with screen height and UI scale, clamped 1..3', () => {
  assert.equal(loginZoom(800), 1.74);
  assert.equal(loginZoom(1080), 2.35);
  assert.equal(loginZoom(2160), 3);
  assert.equal(loginZoom(400), 1);
  assert.equal(loginZoom(800, 120), 2.09);
  assert.equal(loginZoom(undefined), 1.57);
});
