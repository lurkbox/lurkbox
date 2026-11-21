import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartTimeline } from '../src/js/start-timeline.js';

test('VOD start timeline: one line with each step once, in order, in ms since open', () => {
  let t = 1000;
  const tl = new StartTimeline(2935383720, () => t);
  t = 1085; tl.mark('resume prompt shown');
  t = 3310; tl.mark('answered', 'resume at 3:25');
  t = 3650; tl.mark('master', 'signed in');
  t = 3700; tl.mark('master', 'again'); // repeats ignored
  t = 3905; tl.mark('first level');
  t = 4120; tl.mark('first frame');
  t = 4150;
  assert.equal(tl.finish(), '[vod] 2935383720 open → resume prompt shown 85 ms → answered 2310 ms (resume at 3:25) → master 2650 ms (signed in) → first level 2905 ms → first frame 3120 ms → PLAYING 3150 ms');
  assert.equal(tl.finish(), null);
  tl.mark('late');
  assert.doesNotMatch(tl.line(), /late/);
});

test('VOD start timeline: left before it played', () => {
  let t = 0;
  const tl = new StartTimeline('9', () => t);
  t = 400; tl.mark('master');
  t = 900;
  assert.equal(tl.finish('left before PLAYING'), '[vod] 9 open → master 400 ms → left before PLAYING 900 ms');
  assert.equal(new StartTimeline('1', () => 0).line(), '[vod] 1 open');
});
