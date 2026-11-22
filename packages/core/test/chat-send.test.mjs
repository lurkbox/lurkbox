// Chat sending (chat-send.js): the Helix request, what its answer means (drop_reason, 429, sign-in), the room modes
// from ROOMSTATE, matching the IRC echo to the message drawn at once, and the local send gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHAT_LENGTH, chatLength, cleanMessage, buildSendRequest, dropReasonText, DROP_REASONS, interpretSendResult, sendAuthState,
  parseRoomState, roomModeNote, NO_MODES, slowModeExempt, PendingEchoes, SendGate, waitText, onChatSent, emitChatSent,
  PHRASE_COOLDOWN_MS, GLOBAL_GAP_MS,
} from '../src/js/chat-send.js';
import { parseIrc, ircEvent } from '../src/js/chat.js';
import { counterState } from '../src/js/chat-composer.js';

test('the send request: POST /chat/messages with broadcaster, sender and the cleaned message', () => {
  assert.deepEqual(buildSendRequest({ broadcasterId: '7100004', senderId: 1000001, message: '  hello\nthere  ' }), {
    path: '/chat/messages', method: 'POST', body: { broadcaster_id: '7100004', sender_id: '1000001', message: 'hello there' },
  });
  assert.deepEqual(buildSendRequest({ broadcasterId: '1', senderId: '2', message: '   ' }), { error: 'empty' });
  assert.deepEqual(buildSendRequest({ broadcasterId: '', senderId: '2', message: 'hi' }), { error: 'no-channel' });
  assert.deepEqual(buildSendRequest({ broadcasterId: '1', senderId: null, message: 'hi' }), { error: 'not-signed-in' });
  assert.deepEqual(buildSendRequest({ broadcasterId: 'abc', senderId: '2', message: 'hi' }), { error: 'no-channel' }, 'ids are numeric');
});

test('the 500-character limit counts characters, not UTF-16 units', () => {
  assert.equal(MAX_CHAT_LENGTH, 500);
  assert.equal(chatLength('😀😀'), 2);
  assert.equal(buildSendRequest({ broadcasterId: '1', senderId: '2', message: '😀'.repeat(500) }).method, 'POST', '500 emoji fit');
  assert.deepEqual(buildSendRequest({ broadcasterId: '1', senderId: '2', message: 'a'.repeat(501) }), { error: 'too-long' });
  assert.equal(cleanMessage('a\r\n\tb'), 'a b');
  assert.deepEqual(counterState('a'.repeat(399)), { text: '399/500', show: false, over: false });
  assert.deepEqual(counterState('a'.repeat(400)), { text: '400/500', show: true, over: false });
  assert.deepEqual(counterState('a'.repeat(501)), { text: '501/500', show: true, over: true });
});

test('Helix answers: sent, dropped with drop_reason, 429, sign-in needed, other errors', () => {
  const sent = { ok: true, status: 200, data: { data: [{ message_id: 'abc-1', is_sent: true, drop_reason: null }] } };
  assert.deepEqual(interpretSendResult(sent), { ok: true, id: 'abc-1' });

  const dropped = (drop_reason) => interpretSendResult({ ok: true, status: 200, data: { data: [{ message_id: '', is_sent: false, drop_reason }] } });
  assert.deepEqual(dropped({ code: 'msg_duplicate', message: 'Your message is identical to the one you sent within the last 30 seconds.' }),
    { ok: false, kind: 'dropped', reason: 'Your message is identical to the one you sent within the last 30 seconds.', code: 'msg_duplicate' }, 'Twitch\'s own text wins');
  assert.equal(dropped({ code: 'msg_followersonly', message: '' }).reason, DROP_REASONS.msg_followersonly, 'known codes without text');
  assert.equal(dropped({ code: 'msg_emoteonly' }).reason, 'This chat is emote-only.');
  assert.equal(dropped({ code: 'msg_slowmode' }).reason, DROP_REASONS.msg_slowmode);
  assert.equal(dropped({ code: 'msg_subsonly' }).reason, 'This chat is subscribers-only.');
  assert.match(dropped({ code: 'something_new' }).reason, /something_new/);
  assert.match(dropped(null).reason, /didn't send/);
  assert.match(dropReasonText(undefined), /didn't send/);

  const rate = interpretSendResult({ ok: false, status: 429, error: 'Too Many Requests', data: null, resetAt: 1700000005 }, 1700000000000);
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAt, 1700000005000, 'Ratelimit-Reset is in seconds');
  assert.equal(interpretSendResult({ ok: false, status: 429, error: 'x', data: null, resetAt: null }, 1000).retryAt, 6000, 'no reset header: 5 s');

  assert.equal(interpretSendResult({ ok: false, status: 401, error: 'NOT_SIGNED_IN', data: null }).kind, 'auth');
  assert.equal(interpretSendResult({ ok: false, status: 401, error: 'Missing scope: user:write:chat', data: null }).kind, 'auth');
  assert.equal(interpretSendResult({ ok: false, status: 403, error: 'Forbidden', data: { message: 'The sender is banned' } }).reason, 'The sender is banned');
  assert.equal(interpretSendResult({ ok: false, status: 422, error: 'x', data: null }).kind, 'dropped');
  assert.match(interpretSendResult({ ok: false, status: 500, error: 'Internal Server Error', data: null }).reason, /Couldn't send: Internal Server Error/);
  assert.equal(interpretSendResult({ ok: true, status: 200, data: { data: [] } }).kind, 'error');
  assert.equal(interpretSendResult(null).kind, 'error');
});

test('who may send: signed in with user:write:chat, else sign in (again)', () => {
  const user = { id: '1', login: 'a' };
  assert.equal(sendAuthState({ signedIn: true, user, missingScopes: [] }), 'ok');
  assert.equal(sendAuthState({ signedIn: false, user: null }), 'signed-out');
  assert.equal(sendAuthState({ signedIn: false, user: null, needsReauth: true, missingScopes: ['user:write:chat'] }), 'reauth');
  assert.equal(sendAuthState({ signedIn: true, user, missingScopes: ['user:write:chat'] }), 'reauth', 'a token without the scope');
  assert.equal(sendAuthState(null), 'signed-out');
});

test('room modes from ROOMSTATE: full state on join, then changes merged; the composer note', () => {
  const ev = (line) => ircEvent(parseIrc(line));
  const join = ev('@emote-only=0;followers-only=-1;r9k=0;room-id=12;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #chan');
  let m = parseRoomState(join.modes);
  assert.deepEqual(m, NO_MODES);
  assert.equal(roomModeNote(m), '');
  m = parseRoomState(ev('@room-id=12;slow=30 :tmi.twitch.tv ROOMSTATE #chan').modes, m);
  assert.equal(m.slow, 30);
  m = parseRoomState(ev('@followers-only=10;room-id=12 :tmi.twitch.tv ROOMSTATE #chan').modes, m);
  assert.equal(m.slow, 30, 'a partial update keeps the other modes');
  assert.equal(roomModeNote(m), 'Slow mode 30 s · Followers-only (10 min)');
  m = parseRoomState({ 'followers-only': '0', 'subs-only': '1', 'emote-only': '1', r9k: '1', slow: '0' }, m);
  assert.equal(roomModeNote(m), 'Followers-only · Subscribers-only · Emote-only · Unique chat');
  assert.equal(roomModeNote(parseRoomState({ 'followers-only': '1440' })), 'Followers-only (1 d)');
  assert.equal(roomModeNote(parseRoomState({ 'followers-only': '120' })), 'Followers-only (2 h)');
  assert.equal(parseRoomState({ slow: 'junk' }).slow, 0);
  assert.equal(ev(':tmi.twitch.tv ROOMSTATE #chan'), null, 'no room id: ignored');
});

test('slow mode exemption: broadcaster, moderators and VIPs', () => {
  assert.equal(slowModeExempt({ userId: '5', roomId: '5' }), true);
  assert.equal(slowModeExempt({ userId: '5', roomId: '6', badges: 'moderator/1,subscriber/12' }), true);
  assert.equal(slowModeExempt({ userId: '5', roomId: '6', badges: 'vip/1' }), true);
  assert.equal(slowModeExempt({ userId: '5', roomId: '6', badges: 'subscriber/12' }), false);
  assert.equal(slowModeExempt({ userId: '5', roomId: '6' }), false);
});

test('the optimistic echo: matched by Helix id, else by sender and text; unmatched ones time out', () => {
  const p = new PendingEchoes({ timeoutMs: 15000 });
  p.add({ localId: 'local-1', text: 'hello  there ', userId: '1', at: 0 });
  p.add({ localId: 'local-2', text: 'gg', userId: '1', at: 0 });
  p.setId('local-2', 'helix-2');
  assert.equal(p.match({ id: 'other', userId: '2', text: 'gg' }), null, 'someone else saying the same');
  assert.equal(p.match({ id: 'helix-2', userId: '1', text: 'gg' }).localId, 'local-2', 'by id');
  assert.equal(p.match({ id: 'irc-x', userId: '1', text: 'hello there' }).localId, 'local-1', 'by sender and text (spaces collapsed)');
  assert.equal(p.items.length, 0);
  p.add({ localId: 'local-3', text: 'late', userId: '1', at: 1000 });
  p.add({ localId: 'local-4', text: 'later', userId: '1', at: 9000 });
  assert.deepEqual(p.expire(16500).map((x) => x.localId), ['local-3']);
  assert.equal(p.remove('local-4').localId, 'local-4');
  assert.equal(p.remove('nope'), null);
});

test('the send gate: a short gap, slow mode (unless exempt), 429 blocks, per-phrase cooldown, undo', () => {
  const g = new SendGate();
  assert.deepEqual(g.check({ now: 0 }), { ok: true });
  const t1 = g.mark({ now: 0, phrase: 'gg' });
  assert.equal(g.check({ now: 500 }).why, 'gap');
  assert.equal(g.check({ now: GLOBAL_GAP_MS }).ok, true);
  assert.equal(g.check({ now: 1500, phrase: 'gg' }).why, 'phrase');
  assert.equal(g.check({ now: 1500, phrase: 'gg' }).waitMs, PHRASE_COOLDOWN_MS - 1500);
  assert.equal(g.check({ now: 1500, phrase: 'o7' }).ok, true, 'another phrase');
  assert.equal(g.check({ now: PHRASE_COOLDOWN_MS, phrase: 'gg' }).ok, true);
  // Slow mode: the gap is the slow-mode delay.
  const slow = g.check({ now: 5000, slowSec: 30 });
  assert.equal(slow.why, 'slow');
  assert.equal(slow.waitMs, 25000);
  assert.equal(waitText(slow), 'Slow mode: wait 25 s');
  assert.equal(g.check({ now: 5000, slowSec: 30, exempt: true }).ok, true, 'mods and VIPs');
  assert.equal(g.check({ now: 30000, slowSec: 30 }).ok, true);
  // A refused send doesn't count.
  g.undo(t1);
  assert.equal(g.check({ now: 100, phrase: 'gg', slowSec: 30 }).ok, true);
  // 429.
  g.block(60000);
  const r = g.check({ now: 40000 });
  assert.equal(r.why, 'rate');
  assert.equal(waitText(r), 'Sending too fast: wait 20 s');
  assert.equal(waitText({ why: 'phrase', waitMs: 200 }), 'Wait 1 s');
});

test('sent listeners get every accepted message (demo echo, recent emotes)', () => {
  const seen = [];
  const off = onChatSent((d) => seen.push(d.text));
  emitChatSent({ text: 'one' });
  off();
  emitChatSent({ text: 'two' });
  assert.deepEqual(seen, ['one']);
});
