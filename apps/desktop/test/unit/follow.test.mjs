import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const F = require('../../src/main/follow.js');

/** A fake channel page: answers the state scan from `states`, and the action from `acts`. */
function pages(script) {
  const opened = [];
  const openPage = async (url) => {
    const p = script.shift();
    if (!p) throw new Error('no more pages');
    if (p.throws) throw new Error(p.throws);
    opened.push(url);
    const states = [...(p.states || [])];
    return {
      eval: async (src) => {
        if (/const ACT = null;/.test(src)) return { state: states.length > 1 ? states.shift() : states[0] };
        p.actions = (p.actions || 0) + 1;
        p.src = src;
        return p.act;
      },
      close: () => { p.closed = true; },
    };
  };
  return { openPage, opened };
}
const base = { login: 'SomeChannel', name: 'SomeChannel', hasSession: async () => true, sleep: async () => {}, pollMs: 1, readyTimeoutMs: 5 };

test('follow: waits for the button, clicks once, succeeds only when it flipped', async () => {
  const script = [{ states: ['loading', 'not-following'], act: { state: 'following', clicked: true, flipped: true } }];
  const { openPage, opened } = pages(script);
  const r = await F.runFollow({ ...base, action: 'follow', openPage });
  assert.deepEqual(r, { ok: true, following: true });
  assert.deepEqual(opened, ['https://www.twitch.tv/somechannel'], 'only the chosen channel');
  assert.equal(script.length, 0);
});

test('a click that never flips gets one retry in a fresh page, then fails with timeout', async () => {
  const script = [
    { states: ['not-following'], act: { state: 'not-following', clicked: true, flipped: false, reason: 'timeout' } },
    { states: ['not-following'], act: { state: 'not-following', clicked: true, flipped: false, reason: 'timeout' } },
    { states: ['not-following'], act: { state: 'following', flipped: true } },
  ];
  const { openPage, opened } = pages(script);
  const r = await F.runFollow({ ...base, action: 'follow', openPage });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(opened.length, 2, 'one retry, no more');
});

test('retry succeeds; a load error counts as an attempt; a button that never appears times out', async () => {
  let { openPage } = pages([{ throws: 'load timed out' }, { states: ['not-following'], act: { flipped: true, state: 'following' } }]);
  assert.deepEqual(await F.runFollow({ ...base, action: 'follow', openPage }), { ok: true, following: true });
  ({ openPage } = pages([{ states: ['loading'] }, { states: ['loading'] }]));
  assert.deepEqual(await F.runFollow({ ...base, action: 'follow', openPage }), { ok: false, reason: 'timeout' });
});

test('challenge, sign-in wall and wrong channel: no click, no retry', async () => {
  for (const s of ['challenge', 'signed-out', 'wrong-channel']) {
    const script = [{ states: [s] }, { states: ['not-following'], act: { flipped: true } }];
    const { openPage, opened } = pages(script);
    assert.deepEqual(await F.runFollow({ ...base, action: 'follow', openPage }), { ok: false, reason: s });
    assert.equal(opened.length, 1);
    assert.ok(!script[0].actions, 'never clicked');
  }
  const script = [{ states: ['not-following'], act: { state: 'challenge', clicked: true, flipped: false } }, { states: ['not-following'] }];
  const { openPage, opened } = pages(script);
  assert.deepEqual(await F.runFollow({ ...base, action: 'follow', openPage }), { ok: false, reason: 'challenge' });
  assert.equal(opened.length, 1);
});

test('no twitch.tv session: inert (no page is opened)', async () => {
  let opened = 0;
  const r = await F.runFollow({ ...base, action: 'follow', hasSession: async () => false, openPage: async () => { opened++; } });
  assert.deepEqual(r, { ok: false, reason: 'no-session' });
  assert.equal(opened, 0);
  const r2 = await F.runFollow({ ...base, action: 'follow', hasSession: async () => { throw new Error('x'); }, openPage: async () => { opened++; } });
  assert.equal(r2.reason, 'no-session');
  assert.equal(opened, 0);
});

test('unfollow needs the confirmation; bad logins and actions are refused before anything loads', async () => {
  let opened = 0;
  const openPage = async () => { opened++; };
  assert.equal((await F.runFollow({ ...base, action: 'unfollow', openPage })).reason, 'invalid');
  assert.equal((await F.runFollow({ ...base, action: 'unfollow', confirmed: 'yes', openPage })).reason, 'invalid');
  assert.equal((await F.runFollow({ ...base, login: 'a/b', action: 'follow', openPage })).reason, 'invalid');
  assert.equal((await F.runFollow({ ...base, login: '../x', action: 'follow', openPage })).reason, 'invalid');
  assert.equal((await F.runFollow({ ...base, action: 'block', openPage })).reason, 'invalid');
  assert.equal(opened, 0);
  assert.throws(() => F.pageSource({ login: 'x', act: 'unfollow' }), /confirmation/);
  assert.throws(() => F.pageSource({ login: 'x/y' }), /invalid/);
  // Confirmed unfollow: the page source carries the action, and "already not following" is a success with no click.
  const script = [{ states: ['following'], act: { state: 'not-following', clicked: false, flipped: false, already: true } }];
  const p = pages(script);
  assert.deepEqual(await F.runFollow({ ...base, action: 'unfollow', confirmed: true, openPage: p.openPage }), { ok: true, following: false, already: true });
});

test('channelUrl: only valid logins, lower-cased, on www.twitch.tv', () => {
  assert.equal(F.channelUrl('SomeChannel'), 'https://www.twitch.tv/somechannel');
  assert.equal(F.channelUrl('some_channel_1'), 'https://www.twitch.tv/some_channel_1');
  for (const bad of ['', 'a b', 'x?y', 'x#', 'a'.repeat(26), null, 5]) assert.equal(F.channelUrl(bad), null);
});
