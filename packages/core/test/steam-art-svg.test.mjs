import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { steamArtSvgs } from '../src/js/steam-art-svg.js';

const wm = JSON.parse(fs.readFileSync(new URL('../../../assets/src/wordmark.json', import.meta.url), 'utf8'));
const colors = { bg: '#000000', bgTop: '#111111', glow: '#ffd400', accent: '#ffd400', accentDark: '#9e8300', silhouette: '#ffffff', stroke: '#ffffff', halo: 0, fg: '#fefefe' };

test('Steam art uses the build-art.py sizes and the theme colours', () => {
  const s = steamArtSvgs(colors, wm);
  assert.deepEqual([s.capsule.width, s.capsule.height], [600, 900]);
  assert.deepEqual([s.wide.width, s.wide.height], [920, 430]);
  assert.deepEqual([s.hero.width, s.hero.height], [3840, 1240]);
  assert.deepEqual([s.icon.width, s.icon.height], [256, 256]);
  assert.equal(s.logo.width, 1360);
  for (const [name, a] of Object.entries(s)) {
    assert.match(a.svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}"`), name);
    assert.ok(!a.svg.includes('#FF8A66') && !a.svg.includes('#ff8a66'), `${name} must not use the default palette`);
  }
  assert.ok(s.capsule.svg.includes(wm.d) && s.logo.svg.includes('fill="#fefefe"'), 'wordmark in the theme text colour');
  assert.ok(!s.hero.svg.includes(wm.d), 'hero has no text');
  assert.ok(s.hero.svg.includes('fill="#ffffff"'), 'hero silhouette uses the theme silhouette');
});
