import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrc, ircEvent, MessageLog } from '../src/js/chat.js';

test('parses a tagged PRIVMSG', () => {
  const line = '@badge-info=;color=#1E90FF;display-name=Some\\sUser;id=abc-123;mod=0 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #chan :hello there :)';
  const m = parseIrc(line);
  assert.equal(m.command, 'PRIVMSG');
  assert.deepEqual(m.params, ['#chan']);
  assert.equal(m.trailing, 'hello there :)');
  assert.equal(m.tags['display-name'], 'Some User', 'escaped \\s becomes a space');
  const ev = ircEvent(m);
  assert.deepEqual(ev, { kind: 'msg', id: 'abc-123', nick: 'Some User', login: 'someuser', color: '#1E90FF', text: 'hello there :)', action: false, userId: '', roomId: '', badges: '', emotes: '' });
});

test('/me ACTION messages, nick fallback without tags', () => {
  const ev = ircEvent(parseIrc(':bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :\u0001ACTION waves\u0001'));
  assert.equal(ev.nick, 'bob');
  assert.equal(ev.text, 'waves');
  assert.equal(ev.action, true);
});

test('PING, RECONNECT, CLEARMSG and USERNOTICE', () => {
  assert.deepEqual(ircEvent(parseIrc('PING :tmi.twitch.tv')), { kind: 'ping', reply: 'PONG :tmi.twitch.tv' });
  assert.equal(ircEvent(parseIrc(':tmi.twitch.tv RECONNECT')).kind, 'reconnect');
  assert.deepEqual(ircEvent(parseIrc('@login=x;target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #chan :bad')), { kind: 'delete', id: 'abc-123' });
  const raid = ircEvent(parseIrc('@msg-id=raid;system-msg=5\\sraiders\\sfrom\\sFoo :tmi.twitch.tv USERNOTICE #chan'));
  assert.equal(raid.kind, 'system');
  assert.equal(raid.text, '5 raiders from Foo');
});

test('MessageLog keeps only the newest 150 messages', () => {
  const log = new MessageLog(150);
  const evicted = [];
  for (let i = 0; i < 200; i++) evicted.push(...log.push({ id: String(i) }));
  assert.equal(log.items.length, 150);
  assert.equal(log.items[0].id, '50');
  assert.equal(log.items[149].id, '199');
  assert.equal(evicted.length, 50);
  assert.equal(log.remove((x) => x.id === '100').id, '100');
  assert.equal(log.items.length, 149);
});
