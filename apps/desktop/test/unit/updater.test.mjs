import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { installMode, downloadAppImage, createUpdater } = require('../../src/main/updater.js');
const { demoUpdateHop } = require('../../src/main/demo.js');
const { parseRelease } = require('@lurkbox/core/src/shared/updates.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NEW = Buffer.from('#!/bin/sh\necho new lurkbox\n');

/** GitHub as one-hop requests: the assets redirect to the asset host, like the real downloads. */
function github({ version = '0.2.0', body = NEW, sums = null, assetHost = 'release-assets.githubusercontent.com' } = {}) {
  const name = `Lurkbox-${version}-x86_64.AppImage`;
  const base = `https://github.com/lurkbox/lurkbox/releases/download/v${version}/`;
  const files = { [name]: body, 'SHA256SUMS.txt': Buffer.from(sums != null ? sums : `${sha(body)}  ${name}\n${'0'.repeat(64)}  Lurkbox-${version}-android.apk\n`) };
  const raw = { tag_name: `v${version}`, html_url: `https://github.com/lurkbox/lurkbox/releases/tag/v${version}`, assets: Object.keys(files).map((n) => ({ name: n, size: files[n].length, browser_download_url: base + n })) };
  const calls = [];
  const hop = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.github.com') return new Response(JSON.stringify(raw), { status: 200, headers: { etag: '"a"' } });
    if (u.hostname === 'github.com') return new Response(null, { status: 302, headers: { location: `https://${assetHost}/f/${u.pathname.split('/').pop()}` } });
    const f = files[u.pathname.split('/').pop()];
    return f ? new Response(f, { status: 200, headers: { 'content-length': String(f.length) } }) : new Response('', { status: 404 });
  };
  return { hop, calls, raw, release: parseRelease(raw) };
}

function appImage(dir) {
  const file = path.join(dir, 'Lurkbox.AppImage');
  fs.writeFileSync(file, 'old', { mode: 0o755 });
  return file;
}

test('install mode: Flatpak, a writable AppImage, else manual', () => {
  const dir = tmpDir();
  const file = appImage(dir);
  assert.equal(installMode({ FLATPAK_ID: 'io.github.lurkbox.Lurkbox', APPIMAGE: file }), 'flatpak');
  assert.equal(installMode({ APPIMAGE: file }), 'appimage');
  assert.equal(installMode({}), 'manual');
  assert.equal(installMode({ APPIMAGE: 'relative.AppImage' }), 'manual');
  assert.equal(installMode({ APPIMAGE: path.join(dir, 'missing.AppImage') }), 'manual');
  assert.equal(installMode({ APPIMAGE: file }, { access: () => { throw new Error('EACCES'); }, stat: fs.statSync }), 'manual');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AppImage download: checked against SHA256SUMS.txt, then moved over the running file (executable), nothing left behind', async () => {
  const dir = tmpDir();
  const target = appImage(dir);
  const gh = github();
  const progress = [];
  const r = await downloadAppImage({ hop: gh.hop, release: gh.release, target, onProgress: (p) => progress.push(p) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), NEW.toString());
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(dir), ['Lurkbox.AppImage']);
  assert.deepEqual(progress.at(-1), { received: NEW.length, total: NEW.length });
  assert.ok(gh.calls.some((u) => u.startsWith('https://release-assets.githubusercontent.com/')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AppImage download: a wrong checksum, a missing one or a redirect off GitHub leave the running file alone', async () => {
  for (const [why, gh, re] of [
    ['wrong checksum', github({ sums: `${'f'.repeat(64)}  Lurkbox-0.2.0-x86_64.AppImage\n` }), /SHA-256/],
    ['no checksum', github({ sums: '' }), /no checksum/],
    ['redirect elsewhere', github({ assetHost: 'evil.example' }), /not followed/],
  ]) {
    const dir = tmpDir();
    const target = appImage(dir);
    const r = await downloadAppImage({ hop: gh.hop, release: gh.release, target });
    assert.equal(r.ok, false, why);
    assert.match(r.error, re, why);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old', why);
    assert.deepEqual(fs.readdirSync(dir), ['Lurkbox.AppImage'], why);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updater: check → Download → ready → Restart relaunches; Flatpak and manual copies never download', async () => {
  const dir = tmpDir();
  const target = appImage(dir);
  const gh = github();
  const states = [];
  let relaunched = 0;
  const u = createUpdater({ hop: gh.hop, current: '0.1.0', cacheFile: path.join(dir, 'update-check.json'), getSettings: () => ({}), onState: (s) => states.push(s), env: { APPIMAGE: target }, relaunch: () => { relaunched++; }, setInterval: () => 0, clearInterval: () => {} });
  assert.equal(u.state().install, 'appimage');
  assert.deepEqual(await u.install(), { ok: false, reason: 'not-ready' });
  let s = await u.check();
  assert.equal(s.available, true);
  assert.ok(fs.existsSync(path.join(dir, 'update-check.json')));
  s = await u.download();
  assert.equal(s.download.status, 'ready');
  assert.ok(states.some((x) => x.download.status === 'downloading'));
  assert.equal(fs.readFileSync(target, 'utf8'), NEW.toString());
  assert.deepEqual(await u.install(), { ok: true });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(relaunched, 1);

  const flat = createUpdater({ hop: gh.hop, current: '0.1.0', cacheFile: path.join(dir, 'f.json'), getSettings: () => ({}), env: { FLATPAK_ID: 'x', APPIMAGE: target }, setInterval: () => 0 });
  await flat.check();
  s = await flat.download();
  assert.equal(s.install, 'flatpak');
  assert.equal(s.note, 'flatpak');
  assert.equal(s.download.status, 'idle');
  const manual = createUpdater({ hop: gh.hop, current: '0.1.0', cacheFile: path.join(dir, 'm.json'), getSettings: () => ({}), env: {}, setInterval: () => 0 });
  await manual.check();
  assert.equal((await manual.download()).download.status, 'idle');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('demo mode GitHub: a release with a verifiable AppImage behind a redirect', async () => {
  const dir = tmpDir();
  const target = appImage(dir);
  const hop = demoUpdateHop({ version: '0.2.0', appImage: NEW });
  const u = createUpdater({ hop, current: '0.1.0', cacheFile: path.join(dir, 'c.json'), getSettings: () => ({}), env: { APPIMAGE: target }, setInterval: () => 0 });
  assert.equal((await u.check()).latest.version, '0.2.0');
  assert.equal((await u.download()).download.status, 'ready');
  assert.equal(fs.readFileSync(target, 'utf8'), NEW.toString());
  fs.rmSync(dir, { recursive: true, force: true });
});
