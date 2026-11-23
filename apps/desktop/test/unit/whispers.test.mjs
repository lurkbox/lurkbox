// The desktop's whisper history file (userData/whispers.json) and demo mode's whisper handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { WhisperStore } = require('../../src/main/whispers.js');
const { createDemoHost } = require('../../src/main/demo.js');

const thread = (id, n = 1) => ({ id, login: `u${id}`, name: `U${id}`, unread: 1, at: 0, messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, me: i % 2 === 1, text: `hi ${i}`, at: 1000 + i })) });

test('whispers.json: per account, capped, private to the user, survives a restart; removing an account forgets them', () => {
  const file = path.join(tmpDir(), 'whispers.json');
  const st = new WhisperStore(file);
  st.save('111', [thread('7', 230)]);
  st.save('222', [thread('8')]);
  assert.equal(st.save('nope', [thread('9')]), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new WhisperStore(file);
  assert.equal(again.load('111')[0].messages.length, 200, 'the newest 200');
  assert.deepEqual(again.load('222').map((t) => t.id), ['8']);
  assert.deepEqual(again.load('nope'), []);
  again.removeAccount('111');
  assert.deepEqual(new WhisperStore(file).load('111'), []);
  assert.equal(new WhisperStore(file).load('222').length, 1);
});

test('demo mode: a seeded whisper history for the first account, kept in memory', () => {
  const h = createDemoHost({});
  const H = h.handlers;
  const me = h.db.accounts[0].id;
  const list = H['whispers:load'](me);
  assert.equal(list.length, 3);
  assert.equal(list.filter((t) => t.unread).length, 1);
  assert.deepEqual(H['whispers:load'](h.db.accounts[1].id), [], 'the other accounts start empty');
  H['whispers:save'](me, []);
  assert.deepEqual(H['whispers:load'](me), []);
  assert.equal(H.helix({ path: '/whispers', method: 'POST', query: { from_user_id: me, to_user_id: list[0].id }, body: { message: 'hi' } }).status, 204);
});
