// Sign-out and account removal delete everything the desktop keeps for that account, and nothing of the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir, json, fakeFetch } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { JsonFile, DEFAULT_SETTINGS } = require('../../src/main/store.js');
const { Twitch } = require('../../src/main/twitch.js');
const { CookieJar, playerStatus } = require('../../src/main/player-session.js');
const { ResumeStore } = require('../../src/main/resume.js');
const { WhisperStore } = require('../../src/main/whispers.js');
const { EmoteIndexStore } = require('../../src/main/emote-index.js');
const { createAccountRemover } = require('../../src/main/account-data.js');
const { settingsWithoutAccount, PER_ACCOUNT_SETTINGS } = require('@lurkbox/core/src/shared/account-data.js');

const A = '111';
const B = '222';
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
function fakeCookies(initial = []) {
  let list = initial.map((c) => ({ path: '/', secure: true, ...c }));
  return {
    list: () => list,
    async get(filter = {}) {
      if (filter.url) { const host = new URL(filter.url).hostname; return list.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain)); }
      return [...list];
    },
    async remove(url, name) { const host = new URL(url).hostname; list = list.filter((c) => !(c.name === name && c.domain.replace(/^\./, '') === host)); },
    async set(c) { list = list.filter((x) => !(x.name === c.name && x.domain === c.domain)); const { url, ...rest } = c; list.push(rest); },
  };
}
const session = (login) => [{ name: 'auth-token', value: `tok-${login}`, domain: '.twitch.tv' }, { name: 'login', value: login, domain: '.twitch.tv' }];
const thread = (id) => ({ id, login: `u${id}`, name: `U${id}`, unread: 0, at: 1, messages: [{ id: 'm', me: false, text: 'hi', at: 1 }] });
const index = (login) => ({ v: 1, channels: [{ id: '9', login, name: login, at: 1, emotes: [['twitch', '1', 'Kappa']] }] });
const account = (login) => ({ access_token: `at-${login}`, refresh_token: `rt-${login}`, scopes: [], login, display_name: login.toUpperCase(), profile_image_url: `https://img/${login}.png` });

/** Both accounts with data in every store; A is active and its twitch.tv session is live. */
async function setup() {
  const dir = tmpDir();
  const settings = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
  settings.set({
    clientId: 'abc', theme: 'oled', navSounds: false, uiScale: 125, chatWidth: 30, layoutMode: 'tv',
    searchHistory: { [A]: [{ q: 'alpha', at: 1 }], [B]: [{ q: 'beta', at: 1 }] },
    emoteRecents: { [A]: ['Kappa'], [B]: ['LUL'] },
    multiSets: { [A]: [{ login: 'x', name: 'X', userId: '5' }], [B]: [{ login: 'y', name: 'Y', userId: '6' }] },
    myClips: { [A]: [{ id: 'c1', broadcasterId: '5', login: 'x', name: 'X', at: 1, editUrl: '' }], [B]: [{ id: 'c2', broadcasterId: '6', login: 'y', name: 'Y', at: 1, editUrl: '' }] },
  });
  const tokens = new JsonFile(path.join(dir, 'tokens.json'), {});
  tokens.replace({ accounts: { [A]: account('alice'), [B]: account('bob') }, active: A });
  const fetch = fakeFetch([['/revoke', () => json(200, {})]]);
  const twitch = new Twitch({ getSettings: () => settings.get(), tokens, fetch });
  const cookies = fakeCookies(session('bob'));
  const jar = new CookieJar({ cookies, safeStorage: fakeSafe, dir: path.join(dir, 'player-cookies') });
  await jar.save(B);
  await jar.restore(B); await jar.clear();
  for (const c of session('alice')) await cookies.set({ url: 'https://www.twitch.tv/', ...c });
  await jar.save(A);
  const resume = new ResumeStore(path.join(dir, 'resume.json'));
  resume.set(A, '100', 50, 600, { title: 'a vod' });
  resume.set(B, '200', 60, 600, { title: 'b vod' });
  const whispers = new WhisperStore(path.join(dir, 'whispers.json'));
  whispers.save(A, [thread('7')]);
  whispers.save(B, [thread('8')]);
  const emoteIndex = new EmoteIndexStore(path.join(dir, 'emote-index.json'));
  emoteIndex.set(A, index('chanA'));
  emoteIndex.set(B, index('chanB'));
  fs.writeFileSync(path.join(dir, 'notify-channels.json'), JSON.stringify({ user_id: A, login: 'alice', channels: [] }));
  fs.writeFileSync(path.join(dir, 'open-request.json'), JSON.stringify({ channel: 'x', at: Date.now() }));
  const events = { settings: [], activeRemoved: 0, siteData: 0 };
  const remove = createAccountRemover({
    twitch, settings, playerJar: jar, resume, whispers, emoteIndex, dir,
    onSettings: (s) => events.settings.push(s),
    clearSiteData: async () => { events.siteData++; },
    onActiveRemoved: () => { events.activeRemoved++; },
  });
  return { dir, settings, tokens, twitch, cookies, jar, resume, whispers, emoteIndex, remove, events, fetch };
}

function assertBIntact(t) {
  const s = t.settings.get();
  assert.deepEqual(Object.keys(t.tokens.get().accounts), [B]);
  assert.equal(t.tokens.get().accounts[B].access_token, 'at-bob');
  assert.equal(t.jar.peekLogin(B), 'bob');
  assert.equal(t.resume.list(B).length, 1);
  assert.equal(new ResumeStore(path.join(t.dir, 'resume.json')).list(B).length, 1);
  assert.equal(new WhisperStore(path.join(t.dir, 'whispers.json')).load(B).length, 1);
  assert.ok(new EmoteIndexStore(path.join(t.dir, 'emote-index.json')).get(B));
  for (const k of PER_ACCOUNT_SETTINGS) assert.ok(s[k][B], `${k} of the other account stays`);
}

function assertAGone(t) {
  const s = new JsonFile(path.join(t.dir, 'settings.json'), DEFAULT_SETTINGS).get();
  const tokensOnDisk = fs.readFileSync(path.join(t.dir, 'tokens.json'), 'utf8');
  for (const v of ['at-alice', 'rt-alice', 'alice', 'ALICE', 'img/alice']) assert.equal(tokensOnDisk.includes(v), false, `tokens.json still has ${v}`);
  assert.equal(fs.existsSync(path.join(t.dir, 'player-cookies', `${A}.bin`)), false, 'the cookie jar');
  assert.equal(t.jar.peekLogin(A), null);
  assert.deepEqual(new ResumeStore(path.join(t.dir, 'resume.json')).list(A), []);
  assert.deepEqual(new WhisperStore(path.join(t.dir, 'whispers.json')).load(A), []);
  assert.equal(new EmoteIndexStore(path.join(t.dir, 'emote-index.json')).get(A), null);
  assert.equal(fs.existsSync(path.join(t.dir, 'notify-channels.json')), false, 'the Decky export for this user');
  for (const k of PER_ACCOUNT_SETTINGS) assert.equal(A in s[k], false, `${k} still has the account`);
  // Global settings stay.
  assert.equal(s.clientId, 'abc');
  assert.equal(s.theme, 'oled');
  assert.equal(s.navSounds, false);
  assert.equal(s.uiScale, 125);
  assert.equal(s.chatWidth, 30);
  assert.equal(s.layoutMode, 'tv');
}

test('signing out the active account deletes all of its data and keeps the other account\'s', async () => {
  const t = await setup();
  const states = [];
  t.twitch.on('state', (s) => states.push(s));
  const r = await t.remove(undefined);
  assert.equal(r.id, A);
  assert.equal(r.active, B, 'the other account becomes active');
  assertAGone(t);
  assertBIntact(t);
  assert.equal((await playerStatus(t.cookies)).login, 'bob', 'the live session is now the other account\'s, never alice\'s');
  assert.equal(fs.existsSync(path.join(t.dir, 'open-request.json')), false);
  assert.equal(t.events.siteData, 1);
  assert.equal(t.events.activeRemoved, 1);
  assert.equal(t.events.settings.length, 1, 'the page gets the new settings');
  assert.ok(t.fetch.calls.some((c) => c.url.includes('/revoke') && c.body.token === 'at-alice'), 'the token is revoked');
  const last = states.at(-1);
  assert.equal(last.user.login, 'bob');
  assert.deepEqual(last.accounts.map((a) => a.id), [B], 'the profile is gone from the list');
  for (const st of [...r.cleared]) assert.equal(typeof st, 'string');
  assert.deepEqual(r.cleared, ['web-session', 'cookie-jar', 'resume', 'whispers', 'emote-index', 'notify-channels', 'open-request', 'session-state', 'settings', 'account', 'next-session']);
});

test('the last account signing out leaves nothing and no twitch.tv session', async () => {
  const t = await setup();
  await t.remove(B);
  const r = await t.remove(A);
  assert.equal(r.active, null);
  assert.deepEqual(t.tokens.get().accounts, {});
  assert.deepEqual(await playerStatus(t.cookies), { signedIn: false, login: null });
  assert.deepEqual(fs.readdirSync(path.join(t.dir, 'player-cookies')), []);
});

test('removing an inactive account deletes its data and leaves the active session alone', async () => {
  const t = await setup();
  // Swap roles: B (inactive) goes, A stays signed in.
  fs.writeFileSync(path.join(t.dir, 'notify-channels.json'), JSON.stringify({ user_id: A, login: 'alice', channels: [] }));
  const r = await t.remove(B);
  assert.equal(r.active, A);
  assert.equal((await playerStatus(t.cookies)).login, 'alice', 'the active account stays signed in to twitch.tv');
  assert.equal(t.events.siteData, 0);
  assert.equal(t.events.activeRemoved, 0);
  assert.equal(fs.existsSync(path.join(t.dir, 'player-cookies', `${B}.bin`)), false);
  assert.equal(fs.existsSync(path.join(t.dir, 'notify-channels.json')), true, 'the export of the other user stays');
  assert.deepEqual(t.resume.list(B), []);
  assert.deepEqual(t.whispers.load(B), []);
  assert.equal(t.emoteIndex.get(B), null);
  for (const k of PER_ACCOUNT_SETTINGS) assert.equal(B in t.settings.get()[k], false);
  assert.equal(t.resume.list(A).length, 1);
  assert.equal(t.whispers.load(A).length, 1);
  assert.ok(t.emoteIndex.get(A));
  assert.deepEqual(Object.keys(t.tokens.get().accounts), [A]);
});

test('settingsWithoutAccount touches only the per-account keys that hold the account', () => {
  assert.deepEqual(settingsWithoutAccount({ theme: 'oled', searchHistory: { 1: [], 2: [] }, emoteRecents: { 2: [] } }, '1'), { searchHistory: { 2: [] } });
  assert.deepEqual(settingsWithoutAccount({}, '1'), {});
});

test('sign-out and Remove in the main process both go through the one remover', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(src, /'auth:signOut', async \(_e, id\) => \(await removeAccount\(/);
  assert.match(src, /'auth:remove', async \(_e, id\) => \(await removeAccount\(/);
  assert.equal(/twitch\.signOut\(/.test(src), false, 'nothing signs out without deleting the data');
});
