import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { codecsFor, backgroundCap, levelPlan, levelLabel } from '@lurkbox/core/src/js/hls-util.js';

const require = createRequire(import.meta.url);
const { parseDecodeProfiles, parseGlRenderer, summarizeProfiles, summarizeVideoTracks } = require('../../src/main/gpu-diag.js');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../../src/main/store.js');

test('video codec setting: H.264 only by default, best available on request', () => {
  assert.deepEqual(codecsFor('h264', () => true, { av1: true, h265: true }), ['h264']);
  assert.deepEqual(codecsFor(undefined, () => true, { av1: true }), ['h264']);
  assert.deepEqual(codecsFor('best', () => true, { av1: true, h265: true }), ['av1', 'h265', 'h264']);
  assert.deepEqual(codecsFor('best', () => true, { av1: false, h265: false }), ['h264']);
  assert.equal(DEFAULT_SETTINGS.videoCodec, 'h264');
  assert.equal(sanitizeSettings({ videoCodec: 'av1' }).videoCodec, 'h264');
  assert.equal(sanitizeSettings({ videoCodec: 'best' }).videoCodec, 'best');
});

test('background quality setting', () => {
  assert.equal(DEFAULT_SETTINGS.backgroundQuality, '720');
  assert.equal(backgroundCap('same'), null);
  assert.equal(backgroundCap('720'), 720);
  assert.equal(backgroundCap('480'), 480);
  assert.equal(sanitizeSettings({ backgroundQuality: 480 }).backgroundQuality, '480');
  assert.equal(sanitizeSettings({ backgroundQuality: '1080' }).backgroundQuality, '720');
});

// hls.js order: lowest bitrate first.
const LEVELS = [
  { height: 160, bitrate: 2e5, group: '160p30' }, { height: 360, bitrate: 7e5, group: '360p30' }, { height: 480, bitrate: 1.4e6, group: '480p30' },
  { height: 720, bitrate: 2.5e6, group: '720p30' }, { height: 720, bitrate: 3.4e6, group: '720p60' }, { height: 1080, bitrate: 8e6, group: 'chunked' },
];

test('levelPlan: no cap keeps the chosen quality', () => {
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'auto' }), { level: -1, autoCap: -1 });
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'chunked' }), { level: 5, autoCap: -1 });
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'gone' }), { level: -1, autoCap: -1 }, 'unknown group: auto');
});

test('levelPlan: background cap lowers fixed and auto quality, never raises it', () => {
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'chunked', capHeight: 720 }), { level: 4, autoCap: -1 }, '720p60 rather than 720p30');
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'chunked', capHeight: 480 }), { level: 2, autoCap: -1 });
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: '360p30', capHeight: 720 }), { level: 1, autoCap: -1 }, 'already below the cap');
  assert.deepEqual(levelPlan({ levels: LEVELS, quality: 'auto', capHeight: 720 }), { level: -1, autoCap: 4 });
  assert.deepEqual(levelPlan({ levels: [{ height: 1080, group: 'chunked' }], quality: 'auto', capHeight: 480 }), { level: -1, autoCap: 0 }, 'nothing fits: the lowest there is');
});

test('stats label for a level', () => {
  assert.equal(levelLabel({ width: 1280, height: 720, videoCodec: 'avc1.4D401F' }), '1280x720 avc1.4D401F');
  assert.equal(levelLabel({ height: 480, attrs: { CODECS: 'av01.0.08M.08,mp4a.40.2' } }), '480p av01.0.08M.08,mp4a.40.2');
  assert.equal(levelLabel(null), '-');
});

test('chrome://gpu parsing for the [gpu] log line', () => {
  const txt = `Graphics Feature Status ... GL_RENDERER: ANGLE (AMD, AMD Radeon RX 7600 (radeonsi, navi33, LLVM 20), OpenGL 4.6) GL_VERSION OpenGL ES 3.0
    Video Acceleration Information ============================== Decoding : Decode h264 baseline : 64x64 to 4096x4096 pixels
    Decode h264 high : 64x64 to 4096x4096 pixels Decode hevc main 10 : 64x64 to 8192x4352 pixels Decode av1 profile main : 16x16 to 8192x4352 pixels
    Encoding : Encode h264 main : 0x0 to 4096x2304 pixels Vulkan Information`;
  const p = parseDecodeProfiles(txt);
  assert.deepEqual(p, ['h264 baseline', 'h264 high', 'hevc main 10', 'av1 profile main']);
  assert.equal(summarizeProfiles(p), 'h264(2) hevc(1) av1(1)');
  assert.equal(parseGlRenderer(txt), 'ANGLE (AMD, AMD Radeon RX 7600 (radeonsi, navi33, LLVM 20), OpenGL 4.6)');
  assert.deepEqual(parseDecodeProfiles('Video Acceleration Information Decoding : Encoding :'), []);
  assert.deepEqual(parseDecodeProfiles(''), []);
});

test('media decoder track summary', () => {
  assert.equal(summarizeVideoTracks('[{"codec":"h264","coded size":"1920x1080","alpha mode":"is_opaque"}]'), 'h264 1920x1080');
  assert.equal(summarizeVideoTracks('nope'), '');
});
