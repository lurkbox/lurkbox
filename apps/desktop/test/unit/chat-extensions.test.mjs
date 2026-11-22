import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { ChatExtensions, EXTENSIONS, readPins, sha256, parseVersion, compareVersions, chromeVersion, scopeManifest, bttvManifest, CHAT_MATCHES, RESOURCE_MATCHES } = require('../../src/main/chat-extensions.js');
const { readZip, readTarGz, extractTo, safeEntry } = require('../../src/main/archive.js');

/** A zip with stored or deflated entries, built by hand. */
function makeZip(files, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(zlib.crc32(data), 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(zlib.crc32(data), 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, body);
    central.push(ch, nb);
    off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function makeTarGz(files) {
  const parts = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write(data.length.toString(8).padStart(11, '0'), 124); h.write('0', 156); h.write('ustar', 257);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

test('version parsing and comparison', () => {
  assert.deepEqual(parseVersion('v3.1.6'), [3, 1, 6]);
  assert.deepEqual(parseVersion('chrome-stable/4.82.0.31'), [4, 82, 0, 31]);
  assert.equal(parseVersion('nightly'), null);
  assert.ok(compareVersions('3.1.10', '3.1.9') > 0);
  assert.equal(compareVersions('v7.7.33', '7.7.33'), 0);
  assert.ok(compareVersions('4.82.0.42', '4.82.0') > 0);
  assert.ok(compareVersions('nightly', '1.0') < 0, 'unparsable sorts lowest');
  assert.equal(chromeVersion('4.82.0.31.7'), '4.82.0.31');
  assert.equal(chromeVersion('v1.2.99999'), '1.2.65535');
});

test('manifests: content scripts scoped to the chat pages in all frames, no background, permissions or host access; BTTV wrapper', () => {
  const m = scopeManifest({
    manifest_version: 3, update_url: 'x', content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['content.js'], exclude_globs: ['*://gql.twitch.tv/*'] }], background: { service_worker: 'b.js' },
    permissions: ['scripting', 'storage'], optional_permissions: ['management'], host_permissions: ['*://*.twitch.tv/*'], optional_host_permissions: ['*://*.kick.com/*'],
    externally_connectable: { matches: ['*://*.twitch.tv/*'] }, web_accessible_resources: [{ resources: ['site.js'], matches: ['*://*.twitch.tv/*', '*://*.youtube.com/*'] }],
  });
  assert.deepEqual(m.content_scripts, [{ matches: CHAT_MATCHES, js: ['content.js'], all_frames: true }]);
  for (const k of ['update_url', 'background', 'permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions', 'externally_connectable']) assert.equal(m[k], undefined, k);
  assert.deepEqual(m.web_accessible_resources, [{ resources: ['site.js'], matches: RESOURCE_MATCHES }]);
  const b = bttvManifest('7.7.33');
  assert.equal(b.version, '7.7.33');
  assert.equal(b.content_scripts[0].world, 'MAIN');
  assert.deepEqual(b.content_scripts[0].matches, CHAT_MATCHES);
  assert.equal(b.host_permissions, undefined);
});

test('the committed pins: one per extension, a GitHub release URL and a SHA-256 each', () => {
  const pins = readPins();
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(EXTENSIONS).sort());
  for (const [key, p] of Object.entries(pins)) {
    assert.match(p.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//, key);
    assert.match(p.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(EXTENSIONS[key].asset.test(p.url.split('/').pop()), key);
  }
});

test('archives: zip (stored and deflated), CRX3 header, tar.gz, top folder stripped', () => {
  const files = { 'manifest.json': '{"a":1}', 'js/c.js': 'x'.repeat(5000) };
  for (const deflate of [true, false]) assert.deepEqual(readZip(makeZip(files, { deflate })).map((e) => [e.name, e.data.toString()]), Object.entries(files));
  const crx = Buffer.concat([Buffer.from('Cr24'), Buffer.from([3, 0, 0, 0]), Buffer.from([4, 0, 0, 0]), Buffer.from('abcd'), makeZip(files)]);
  assert.equal(readZip(crx).length, 2);
  assert.deepEqual(readTarGz(makeTarGz({ 'betterttv.js': 'bttv', 'assets/a.png': 'p' })).map((e) => e.name), ['betterttv.js', 'assets/a.png']);
  const dir = tmpDir();
  extractTo(readZip(makeZip({ 'ext/manifest.json': '{}', 'ext/x.js': '1' })), dir);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'x.js')));
});

test('archives: paths outside the target are refused (zip-slip)', () => {
  assert.equal(safeEntry('../evil'), null);
  assert.equal(safeEntry('/etc/passwd'), null);
  assert.equal(safeEntry('a/../../b'), null);
  assert.equal(safeEntry('C:/x'), null);
  assert.equal(safeEntry('./a/b.js'), 'a/b.js');
  const dir = tmpDir();
  assert.throws(() => extractTo(readZip(makeZip({ '../escape.txt': 'x' })), path.join(dir, 'in')), /unsafe path/);
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
});

// ---- the manager, with the downloads and Electron mocked ----

const STV_MF = (v = '3.1.6') => JSON.stringify({ manifest_version: 3, name: '7TV', version: v, content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['content.js'] }], background: { service_worker: 'background.js' }, permissions: ['storage'] });
const PACKAGES = {
  '7tv-3.1.6': makeZip({ 'manifest.json': STV_MF(), 'content.js': '1' }),
  '7tv-3.2.0': makeZip({ 'manifest.json': STV_MF('3.2.0'), 'content.js': '2' }),
  ffz: makeZip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'FFZ', version: '4.82.0.31', content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['s.js'], all_frames: true }] }) }),
  bttv: makeTarGz({ 'betterttv.js': '1', 'betterttv.css': '' }),
};
const URLS = {
  '7tv-3.1.6': 'https://github.com/SevenTV/Extension/releases/download/v3.1.6/7tv-webextension-mv3.zip',
  '7tv-3.2.0': 'https://github.com/SevenTV/Extension/releases/download/v3.2.0/7tv-webextension-mv3.zip',
  ffz: 'https://github.com/FrankerFaceZ/Extension/releases/download/chrome-stable/4.82.0.31/frankerfacez-extension-4.82.0.31.zip',
  bttv: 'https://github.com/night/betterttv/releases/download/7.7.33/betterttv.tar.gz',
};
const pin = (id, version) => ({ version, url: URLS[id], sha256: sha256(PACKAGES[id]) });
const pinsFor = ({ stv = '3.1.6' } = {}) => ({ '7tv': pin(`7tv-${stv}`, stv), ffz: pin('ffz', '4.82.0.31'), bttv: pin('bttv', '7.7.33') });

/** Download stand-in: serves the packages by URL; `tamper` serves a changed file for URLs containing it. */
function fakeGitHub({ failDownload = [], tamper = [] } = {}) {
  const calls = [];
  const byUrl = Object.fromEntries(Object.entries(URLS).map(([id, u]) => [u, PACKAGES[id]]));
  const fetch = async (url, init) => {
    calls.push(url);
    assert.equal(init && init.credentials, 'omit');
    if (failDownload.some((k) => url.includes(k))) return { ok: false, status: 503 };
    let body = byUrl[url];
    if (!body) throw new Error(`unexpected ${url}`);
    if (tamper.some((k) => url.includes(k))) body = Buffer.concat([body, Buffer.from('x')]);
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
  fetch.calls = calls;
  return fetch;
}

test('update: installs the pinned releases into <key>/<version>, writes scoped manifests', async () => {
  const dir = tmpDir();
  const f = fakeGitHub();
  const m = new ChatExtensions({ dir, fetch: f, pins: pinsFor() });
  const st = await m.update();
  assert.deepEqual(st.map((x) => [x.key, x.installed]), [['7tv', '3.1.6'], ['ffz', '4.82.0.31'], ['bttv', '7.7.33']]);
  const mf = JSON.parse(fs.readFileSync(path.join(dir, '7tv', '3.1.6', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.content_scripts[0].matches, CHAT_MATCHES);
  assert.equal(mf.background, undefined);
  assert.equal(mf.permissions, undefined);
  assert.ok(f.calls.every((u) => Object.values(URLS).includes(u)), 'only the pinned files are fetched (no release lookups)');
  assert.ok(fs.existsSync(path.join(dir, '7tv', '3.1.6', 'manifest.orig.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bttv', '7.7.33', 'manifest.json'), 'utf8')).content_scripts[0].js[0], 'betterttv.js');
  // State survives a restart.
  assert.equal(new ChatExtensions({ dir, fetch: null, pins: pinsFor() }).status()[0].installed, '3.1.6');
});

test('update: a download that does not match its pinned checksum is refused and nothing is installed', async () => {
  const dir = tmpDir();
  const logs = [];
  const m = new ChatExtensions({ dir, fetch: fakeGitHub({ tamper: ['7tv-webextension'] }), pins: pinsFor(), log: (l) => logs.push(l) });
  const st = await m.update();
  const stv = st.find((x) => x.key === '7tv');
  assert.equal(stv.installed, null);
  assert.equal(stv.status, 'failed');
  assert.match(stv.error, /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(dir, '7tv', '3.1.6')), false);
  assert.equal(st.find((x) => x.key === 'bttv').installed, '7.7.33');
});

test('update: skips what matches the pin, moves to a new pin and removes the old folder', async () => {
  const dir = tmpDir();
  await new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor() }).update({ keys: ['7tv'] });
  const f = fakeGitHub();
  await new ChatExtensions({ dir, fetch: f, pins: pinsFor() }).update({ keys: ['7tv'] });
  assert.equal(f.calls.length, 0, 'no download when current');
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor({ stv: '3.2.0' }) });
  await m.update({ keys: ['7tv'] });
  assert.equal(m.status()[0].installed, '3.2.0');
  assert.equal(fs.existsSync(path.join(dir, '7tv', '3.1.6')), false);
});

test('update: a failed download is recorded and the others still install', async () => {
  const dir = tmpDir();
  const logs = [];
  const m = new ChatExtensions({ dir, fetch: fakeGitHub({ failDownload: ['betterttv.tar.gz'] }), pins: pinsFor(), log: (l) => logs.push(l) });
  const st = await m.update();
  const bttv = st.find((x) => x.key === 'bttv');
  assert.equal(bttv.status, 'failed');
  assert.match(bttv.error, /download 503/);
  assert.equal(st.find((x) => x.key === '7tv').installed, '3.1.6');
  assert.ok(logs.some((l) => /bttv: update failed/.test(l)));
});

test('loadInto: a load failure disables that extension with the reason; the rest load; update re-enables', async () => {
  const dir = tmpDir();
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor(), log: () => {} });
  await m.update();
  const loaded = [];
  const ses = { extensions: {
    loadExtension: async (p) => {
      if (p.includes(`${path.sep}ffz${path.sep}`)) throw new Error('Manifest version 3 service worker failed');
      loaded.push(p);
      return { id: `id-${loaded.length}`, name: 'x', version: '1' };
    },
    removeExtension: () => {},
  } };
  const st = await m.loadInto(ses, { download: false });
  const ffz = st.find((x) => x.key === 'ffz');
  assert.equal(ffz.status, 'failed');
  assert.match(ffz.error, /service worker/);
  assert.equal(st.filter((x) => x.loaded).length, 2);
  // Next start: the disabled one isn't tried again.
  const m2 = new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor(), log: () => {} });
  let tried = 0;
  await m2.loadInto({ extensions: { loadExtension: async (p) => { tried++; assert.ok(!p.includes(`${path.sep}ffz${path.sep}`)); return { id: 'i', name: 'x', version: '1' }; } } }, { download: false });
  assert.equal(tried, 2);
  m2.reenable();
  assert.equal(m2.state.ffz.disabled, false);
  m.unloadFrom(ses);
  assert.equal(m.status().filter((x) => x.loaded).length, 0);
});

test('loadInto downloads missing packages first; older Electron session.loadExtension is used as a fallback', async () => {
  const dir = tmpDir();
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor(), log: () => {} });
  let n = 0;
  const st = await m.loadInto({ loadExtension: async () => ({ id: `i${++n}`, name: 'x', version: '1' }) });
  assert.equal(st.filter((x) => x.loaded).length, 3);
});

test('loadInto: a package from before the pins is replaced by the pinned one, never loaded as is', async () => {
  const dir = tmpDir();
  const old = path.join(dir, '7tv', '3.1.4');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ '7tv': { version: '3.1.4', path: old, status: 'installed' } }));
  const loaded = [];
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), pins: pinsFor(), log: () => {} });
  await m.loadInto({ extensions: { loadExtension: async (p) => { loaded.push(p); return { id: p, name: 'x', version: '1' }; } } }, { download: false });
  assert.ok(!loaded.includes(old));
  await m.loadInto({ extensions: { loadExtension: async (p) => { loaded.push(p); return { id: p, name: 'x', version: '1' }; } } });
  assert.ok(loaded.includes(path.join(dir, '7tv', '3.1.6')));
  assert.equal(fs.existsSync(old), false);
});
