import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { CookieJar, playerStatus, mismatchWarning } = require('../../src/main/player-session.js');

/** In-memory stand-in for Electron's session.cookies. */
function fakeCookies(initial = []) {
  let list = initial.map((c) => ({ path: '/', secure: true, ...c }));
  return {
    list: () => list,
    async get(filter = {}) {
      if (filter.url) {
        const host = new URL(filter.url).hostname;
        return list.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain.startsWith('.') ? c.domain : `.${c.domain}`));
      }
      return [...list];
    },
    async remove(url, name) {
      const host = new URL(url).hostname;
      list = list.filter((c) => !(c.name === name && c.domain.replace(/^\./, '') === host));
    },
    async set(c) {
      list = list.filter((x) => !(x.name === c.name && x.domain === c.domain));
      const { url, ...rest } = c;
      list.push(rest);
    },
  };
}
// "Encryption" that is visibly not plaintext, so the test can check nothing leaks.
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s).reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString(),
};

const A_COOKIES = [
  { name: 'auth-token', value: 'SECRET-A', domain: '.twitch.tv' },
  { name: 'login', value: 'alice', domain: '.twitch.tv' },
  { name: 'other', value: 'keep-me', domain: 'example.com' },
];

test('save/restore keeps one twitch.tv jar per account and leaves other sites alone', async () => {
  const dir = tmpDir();
  const cookies = fakeCookies(A_COOKIES);
  const jar = new CookieJar({ cookies, safeStorage: fakeSafe, dir });
  assert.equal(await jar.save('111'), true);
  const raw = fs.readFileSync(path.join(dir, '111.bin'));
  assert.ok(!raw.toString().includes('SECRET-A'), 'jar is encrypted');
  assert.equal(fs.statSync(path.join(dir, '111.bin')).mode & 0o777, 0o600);

  // switch to account 222: no jar yet → twitch cookies cleared, others kept
  assert.equal(await jar.restore('222'), 0);
  assert.deepEqual(cookies.list().map((c) => c.name), ['other']);
  await cookies.set({ url: 'https://www.twitch.tv/', name: 'auth-token', value: 'SECRET-B', domain: '.twitch.tv', path: '/' });
  await cookies.set({ url: 'https://www.twitch.tv/', name: 'login', value: 'bob', domain: '.twitch.tv', path: '/' });
  await jar.save('222');

  // back to 111
  assert.equal(await jar.restore('111'), 2);
  assert.equal((await playerStatus(cookies)).login, 'alice');
  assert.ok(cookies.list().some((c) => c.name === 'other'));
  await jar.restore('222');
  assert.equal((await playerStatus(cookies)).login, 'bob');
});

test('removing an account deletes its jar; sign-out clears the player cookies', async () => {
  const dir = tmpDir();
  const cookies = fakeCookies(A_COOKIES);
  const jar = new CookieJar({ cookies, safeStorage: fakeSafe, dir });
  await jar.save('111');
  jar.remove('111');
  assert.equal(fs.existsSync(path.join(dir, '111.bin')), false);
  await jar.clear();
  assert.deepEqual(await playerStatus(cookies), { signedIn: false, login: null });
  assert.throws(() => jar.file('../evil'), /bad user id/);
});

test('player status and the account mismatch warning', async () => {
  assert.deepEqual(await playerStatus(fakeCookies(A_COOKIES)), { signedIn: true, login: 'alice' });
  assert.equal(mismatchWarning('alice', 'Alice'), null);
  assert.equal(mismatchWarning('alice', 'bob'), 'The player is signed in as alice, but Lurkbox is signed in as bob. Subs apply to alice.');
  assert.equal(mismatchWarning(null, 'bob'), null);
});
