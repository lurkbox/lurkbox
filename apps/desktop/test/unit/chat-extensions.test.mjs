import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { ChatExtensions, parseVersion, compareVersions, chromeVersion, scopeManifest, bttvManifest, CHAT_MATCHES } = require('../../src/main/chat-extensions.js');
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

test('manifests: content scripts scoped to the chat pages in all frames; BTTV wrapper', () => {
  const m = scopeManifest({ manifest_version: 3, update_url: 'x', content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['content.js'] }], background: { service_worker: 'b.js' } });
  assert.deepEqual(m.content_scripts, [{ matches: CHAT_MATCHES, js: ['content.js'], all_frames: true }]);
  assert.equal(m.update_url, undefined);
  assert.deepEqual(m.background, { service_worker: 'b.js' });
  const b = bttvManifest('7.7.33');
  assert.equal(b.version, '7.7.33');
  assert.equal(b.content_scripts[0].world, 'MAIN');
  assert.deepEqual(b.content_scripts[0].matches, CHAT_MATCHES);
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

// ---- the manager, with GitHub and Electron mocked ----

const rel = (tag, assets, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map((n) => ({ name: n, browser_download_url: `https://dl/${tag}/${n}` })), ...extra });
const STV_MF = JSON.stringify({ manifest_version: 3, name: '7TV', version: '3.1.6', content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['content.js'] }] });

function fakeGitHub({ stvTag = 'v3.1.6', failDownload = [] } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => body });
    if (url.includes('/repos/SevenTV/Extension/releases')) return ok([rel('nightly-release', ['7tv-webextension-mv3.zip'], { prerelease: true }), rel(stvTag, ['7tv-webextension-ext.crx', '7tv-webextension-mv3.zip'])]);
    if (url.includes('/repos/FrankerFaceZ/Extension/releases')) return ok([rel('firefox-stable/4.82.0.42', ['frankerfacez-extension-4.82.0.42.zip']), rel('chrome-stable/4.82.0.31', ['frankerfacez-extension-4.82.0.31.zip'])]);
    if (url.includes('/repos/night/betterttv/releases')) return ok([rel('7.7.33', ['betterttv.tar.gz'])]);
    if (failDownload.some((k) => url.includes(k))) return { ok: false, status: 503 };
    if (url.endsWith('-mv3.zip')) return ok(makeZip({ 'manifest.json': STV_MF, 'content.js': '1' }));
    if (url.endsWith('.zip')) return ok(makeZip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'FFZ', version: '4.82.0.31', content_scripts: [{ matches: ['*://*.twitch.tv/*'], js: ['s.js'], all_frames: true }] }) }));
    if (url.endsWith('.tar.gz')) return ok(makeTarGz({ 'betterttv.js': '1', 'betterttv.css': '' }));
    throw new Error(`unexpected ${url}`);
  };
  fetch.calls = calls;
  return fetch;
}

test('update: picks stable releases, installs into <key>/<version>, writes scoped manifests', async () => {
  const dir = tmpDir();
  const m = new ChatExtensions({ dir, fetch: fakeGitHub() });
  const st = await m.update();
  assert.deepEqual(st.map((x) => [x.key, x.installed]), [['7tv', '3.1.6'], ['ffz', '4.82.0.31'], ['bttv', '7.7.33']]);
  const mf = JSON.parse(fs.readFileSync(path.join(dir, '7tv', '3.1.6', 'manifest.json'), 'utf8'));
  assert.deepEqual(mf.content_scripts[0].matches, CHAT_MATCHES);
  assert.ok(fs.existsSync(path.join(dir, '7tv', '3.1.6', 'manifest.orig.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bttv', '7.7.33', 'manifest.json'), 'utf8')).content_scripts[0].js[0], 'betterttv.js');
  // State survives a restart.
  assert.equal(new ChatExtensions({ dir, fetch: null }).status()[0].installed, '3.1.6');
});

test('update: skips what is current, replaces older versions and removes the old folder', async () => {
  const dir = tmpDir();
  await new ChatExtensions({ dir, fetch: fakeGitHub() }).update({ keys: ['7tv'] });
  const f = fakeGitHub();
  await new ChatExtensions({ dir, fetch: f }).update({ keys: ['7tv'] });
  assert.equal(f.calls.filter((u) => u.startsWith('https://dl/')).length, 0, 'no download when current');
  const m = new ChatExtensions({ dir, fetch: fakeGitHub({ stvTag: 'v3.2.0' }) });
  await m.update({ keys: ['7tv'] });
  assert.equal(m.status()[0].installed, '3.2.0');
  assert.equal(fs.existsSync(path.join(dir, '7tv', '3.1.6')), false);
});

test('update: a failed download is recorded and the others still install', async () => {
  const dir = tmpDir();
  const logs = [];
  const m = new ChatExtensions({ dir, fetch: fakeGitHub({ failDownload: ['betterttv.tar.gz'] }), log: (l) => logs.push(l) });
  const st = await m.update();
  const bttv = st.find((x) => x.key === 'bttv');
  assert.equal(bttv.status, 'failed');
  assert.match(bttv.error, /download 503/);
  assert.equal(st.find((x) => x.key === '7tv').installed, '3.1.6');
  assert.ok(logs.some((l) => /bttv: update failed/.test(l)));
});

test('loadInto: a load failure disables that extension with the reason; the rest load; update re-enables', async () => {
  const dir = tmpDir();
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), log: () => {} });
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
  const m2 = new ChatExtensions({ dir, fetch: fakeGitHub(), log: () => {} });
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
  const m = new ChatExtensions({ dir, fetch: fakeGitHub(), log: () => {} });
  let n = 0;
  const st = await m.loadInto({ loadExtension: async () => ({ id: `i${++n}`, name: 'x', version: '1' }) });
  assert.equal(st.filter((x) => x.loaded).length, 3);
});
