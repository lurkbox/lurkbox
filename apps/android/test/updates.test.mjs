import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdates } from '../src/updates.js';
import { createPlatform } from '../src/platform.js';
import { makeNativeFetch } from '../src/http.js';
import { RELEASES_API } from '@lurkbox/core/src/shared/updates.js';

const release = (v) => ({
  tag_name: `v${v}`, html_url: `https://github.com/lurkbox/lurkbox/releases/tag/v${v}`,
  assets: [`Lurkbox-${v}-android.apk`, `Lurkbox-${v}-x86_64.AppImage`, 'SHA256SUMS.txt'].map((name) => ({ name, size: 10, browser_download_url: `https://github.com/lurkbox/lurkbox/releases/download/v${v}/${name}` })),
});

/** CapacitorHttp-shaped fetch: { status, url, headers.get, json } for the API URL. */
function apiFetch(v, { finalUrl = RELEASES_API } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, ok: true, url: finalUrl, headers: { get: (k) => (k === 'etag' ? '"e"' : null) }, json: async () => release(v) };
  };
  return { fetch, calls };
}

function value(initial = {}) {
  let data = { ...initial };
  return { get: () => ({ ...data }), replace: (v) => { data = { ...v }; } };
}

function native({ signature = 'match', permission = true, fail = null } = {}) {
  const calls = { download: [], install: [] };
  let progress = null;
  return {
    calls,
    fireProgress: (p) => progress(p),
    addListener: (name, fn) => { if (name === 'updateProgress') progress = fn; return Promise.resolve({ remove() {} }); },
    updateDownload: async (a) => {
      calls.download.push(a);
      progress({ received: 5, total: 10 });
      if (fail) throw new Error(fail);
      return { sha256: 'ok', signature };
    },
    updateInstall: async (a) => { calls.install.push(a); return { permission }; },
  };
}

const mk = (n, f = apiFetch('0.2.0')) => {
  const states = [];
  const u = createUpdates({ fetch: f.fetch, cacheValue: value(), native: n, version: '0.1.0', getSettings: () => ({}), emit: (_n, s) => states.push(s), setInterval: () => 0 });
  return { u, states };
};

test('Android: check → Download (the native download checks the hash) → Install opens the system installer', async () => {
  const n = native();
  const { u, states } = mk(n);
  assert.equal(u.state().install, 'apk');
  let s = await u.check();
  assert.equal(s.available, true);
  s = await u.download();
  assert.equal(s.download.status, 'ready');
  assert.deepEqual(n.calls.download, [{ url: 'https://github.com/lurkbox/lurkbox/releases/download/v0.2.0/Lurkbox-0.2.0-android.apk', sumsUrl: 'https://github.com/lurkbox/lurkbox/releases/download/v0.2.0/SHA256SUMS.txt', name: 'Lurkbox-0.2.0-android.apk' }]);
  assert.ok(states.some((x) => x.download.status === 'downloading' && x.download.received === 5));
  assert.deepEqual(await u.install(), { ok: true });
  assert.deepEqual(n.calls.install, [{ name: 'Lurkbox-0.2.0-android.apk' }]);
});

test('Android: a debug-signed install says "uninstall first" instead of opening an installer that would fail', async () => {
  const n = native({ signature: 'mismatch' });
  const { u } = mk(n);
  await u.check();
  const s = await u.download();
  assert.equal(s.note, 'signature-mismatch');
  assert.deepEqual(await u.install(), { ok: false, reason: 'signature-mismatch' });
  assert.equal(n.calls.install.length, 0);
});

test('Android: without "install unknown apps" the settings open first; then Install again', async () => {
  const n = native({ permission: false });
  const { u } = mk(n);
  await u.check();
  await u.download();
  assert.deepEqual(await u.install(), { ok: false, reason: 'permission' });
  assert.equal(u.state().note, 'install-permission');
});

test('Android: a failed download (checksum, network) is reported; a redirect off GitHub fails the check', async () => {
  const { u } = mk(native({ fail: 'the download does not match its SHA-256 checksum' }));
  await u.check();
  const s = await u.download();
  assert.equal(s.download.status, 'failed');
  assert.match(s.download.error, /SHA-256/);

  const off = mk(native(), apiFetch('0.2.0', { finalUrl: 'https://evil.example/latest' }));
  const st = await off.u.check();
  assert.equal(st.available, false);
  assert.match(st.error, /off GitHub/);
});

test('Android: the platform exposes the updater and keeps the check in Preferences', async () => {
  const store = new Map();
  const prefs = { get: async ({ key }) => ({ value: store.get(key) || null }), set: async ({ key, value: v }) => { store.set(key, v); }, remove: async ({ key }) => { store.delete(key); } };
  const http = { request: async (req) => (req.url === RELEASES_API ? { status: 200, data: JSON.stringify(release('0.3.0')), headers: { ETag: '"x"' } } : { status: 404, data: '', headers: {} }) };
  const app = { addListener() {}, exitApp: async () => {} };
  const p = createPlatform({ fetch: makeNativeFetch(http), prefs, app, native: native(), qrSvg: () => '', version: '0.1.0', setInterval: () => 0 });
  const s = await p.updateCheck();
  assert.equal(s.latest.version, '0.3.0');
  assert.equal(s.install, 'apk');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(store.get('updateCheck')).check.etag, '"x"');
  assert.equal((await p.updateState()).available, true);
});
