import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpDir } from './helpers.mjs';

const require = createRequire(import.meta.url);
const SA = require('../../src/main/steam-art.js');
const { appIdFromEnv, shortcutAppId, buildCall, gridName, ASSET_TYPES, SteamArt, lurkboxShortcut, openSteamContext } = SA;

const VECTOR_EXE = '/home/deck/Applications/Lurkbox.AppImage';
const VECTOR_ID = 3002582954;

// ---- appid ----

test('appid from the AppImage path matches the test vector (crc32 of quoted exe + name)', () => {
  assert.equal(shortcutAppId(VECTOR_EXE), VECTOR_ID);
  assert.deepEqual(appIdFromEnv({ APPIMAGE: VECTOR_EXE }), { appid: VECTOR_ID, source: 'APPIMAGE' });
});

test('SteamGameId (64-bit game id) is preferred: appid = SteamGameId >> 32', () => {
  const gameId = ((BigInt(1234567890 + 0x80000000) << 32n) | 0x02000000n).toString();
  assert.deepEqual(appIdFromEnv({ SteamGameId: gameId, APPIMAGE: VECTOR_EXE }), { appid: 1234567890 + 0x80000000, source: 'SteamGameId' });
  const vec = ((BigInt(VECTOR_ID) << 32n) | 0x02000000n).toString();
  assert.equal(appIdFromEnv({ SteamGameId: vec }).appid, VECTOR_ID);
});

test('a SteamGameId without a shortcut appid (or garbage) falls back to the AppImage path', () => {
  assert.equal(appIdFromEnv({ SteamGameId: '570', APPIMAGE: VECTOR_EXE }).source, 'APPIMAGE');
  assert.equal(appIdFromEnv({ SteamGameId: '1; rm -rf', APPIMAGE: VECTOR_EXE }).source, 'APPIMAGE');
  assert.equal(appIdFromEnv({}), null);
  assert.equal(appIdFromEnv({ APPIMAGE: 'relative/Lurkbox.AppImage' }), null);
});

// ---- CDP calls ----

const DECLS = Object.values(SA.FUNCTIONS);

test('the call builder uses fixed function declarations; image data is only ever an argument', () => {
  const calls = [
    buildCall({ fn: 'setArtwork', appid: VECTOR_ID, base64: 'iVBORw0KGgo=', assetType: 0 }),
    buildCall({ fn: 'setArtwork', appid: VECTOR_ID, base64: '/9j/4AAQ', ext: 'jpg', assetType: 3 }),
    buildCall({ fn: 'clearArtwork', appid: VECTOR_ID, assetType: 3 }),
    buildCall({ fn: 'setIcon', appid: VECTOR_ID, path: '/home/deck/.local/share/Steam/userdata/1/config/grid/3002582954_icon.png' }),
  ];
  assert.deepEqual(calls[0].args, [VECTOR_ID, 'iVBORw0KGgo=', 'png', 0]);
  assert.deepEqual(calls[1].args, [VECTOR_ID, '/9j/4AAQ', 'jpg', 3]);
  for (const c of calls) {
    assert.ok(DECLS.includes(c.functionDeclaration));
    assert.ok(!c.functionDeclaration.includes('iVBOR') && !c.functionDeclaration.includes(String(VECTOR_ID)));
  }
});

test('the call builder rejects bad input', () => {
  const bad = [
    null, 'SteamClient.Apps.SetShortcutIcon(1, "/x.png")',
    { fn: 'eval', appid: 1 },
    { fn: 'SetCustomLogoPositionForApp', appid: 1 },
    { fn: 'setArtwork', appid: '3002582954', base64: 'AAAA', assetType: 0 },
    { fn: 'setArtwork', appid: -1, base64: 'AAAA', assetType: 0 },
    { fn: 'setArtwork', appid: 1.5, base64: 'AAAA', assetType: 0 },
    { fn: 'setArtwork', appid: 2 ** 32, base64: 'AAAA', assetType: 0 },
    { fn: 'setArtwork', appid: NaN, base64: 'AAAA', assetType: 0 },
    { fn: 'setArtwork', appid: 1, base64: 'AAAA", alert(1), "', assetType: 0 },
    { fn: 'setArtwork', appid: 1, base64: 'AAA', assetType: 0 },
    { fn: 'setArtwork', appid: 1, base64: '', assetType: 0 },
    { fn: 'setArtwork', appid: 1, base64: 'AAAA', assetType: 4 },
    { fn: 'setArtwork', appid: 1, base64: 'AAAA', assetType: '0' },
    { fn: 'setArtwork', appid: 1, base64: 'AAAA', ext: 'gif', assetType: 0 },
    { fn: 'clearArtwork', appid: 1, assetType: '1); fetch("x"' },
    { fn: 'setIcon', appid: 1, path: 'relative/icon.png' },
    { fn: 'setIcon', appid: 1, path: '/home/deck/../etc/icon.png' },
    { fn: 'setIcon', appid: 1, path: '/home/deck/a"b.png' },
    { fn: 'setIcon', appid: 1, path: '/home/deck/a\nb.png' },
    { fn: 'setIcon', appid: 1, path: '/home/deck/icon.svg' },
    { fn: 'setIcon', appid: 1, path: '' },
  ];
  for (const b of bad) assert.throws(() => buildCall(b), undefined, JSON.stringify(b));
});

test('asset types are a fixed table: capsule 0, hero 1, logo 2, wide 3', () => {
  assert.deepEqual({ ...ASSET_TYPES }, { capsule: 0, hero: 1, logo: 2, wide: 3 });
  assert.ok(Object.isFrozen(ASSET_TYPES));
});

test('grid file names per asset', () => {
  assert.equal(gridName(VECTOR_ID, 'capsule'), '3002582954p.png');
  assert.equal(gridName(VECTOR_ID, 'wide'), '3002582954.png');
  assert.equal(gridName(VECTOR_ID, 'hero'), '3002582954_hero.png');
  assert.equal(gridName(VECTOR_ID, 'logo'), '3002582954_logo.png');
  assert.equal(gridName(VECTOR_ID, 'icon'), '3002582954_icon.png');
  assert.equal(gridName(VECTOR_ID, 'hero', 'jpg'), '3002582954_hero.jpg');
  assert.throws(() => gridName(VECTOR_ID, 'hero', 'gif'));
  assert.throws(() => gridName(VECTOR_ID, 'header'));
  assert.throws(() => gridName('../x', 'hero'));
});

// ---- files: a fake Steam root ----

function vdfDump(d) {
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    const kb = Buffer.concat([Buffer.from(k), Buffer.from([0])]);
    if (typeof v === 'object') parts.push(Buffer.from([0]), kb, vdfDump(v), Buffer.from([8]));
    else if (typeof v === 'number') { const n = Buffer.alloc(4); n.writeInt32LE(v); parts.push(Buffer.from([2]), kb, n); }
    else parts.push(Buffer.from([1]), kb, Buffer.from(String(v)), Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag.padEnd(4, '.'))]);
const dataUrl = (tag) => `data:image/png;base64,${PNG(tag).toString('base64')}`;
const pngs = (tag) => Object.fromEntries(['capsule', 'wide', 'hero', 'logo', 'icon'].map((a) => [a, dataUrl(`${tag}-${a}`)]));

function fakeSteam({ originals = true } = {}) {
  const root = tmpDir('lurkbox-steam-');
  const iconDir = tmpDir('lurkbox-icon-');
  const origIcon = path.join(iconDir, 'icon.png');
  fs.writeFileSync(origIcon, PNG('orig-icon'));
  const signed = VECTOR_ID | 0;
  const vdf = Buffer.concat([vdfDump({ shortcuts: { 0: { appid: signed, AppName: 'Lurkbox', Exe: `"${VECTOR_EXE}"`, icon: origIcon } } }), Buffer.from([8])]);
  fs.mkdirSync(path.join(root, 'userdata', '99', 'config'), { recursive: true }); // another user without Lurkbox
  const cfg = path.join(root, 'userdata', '12345678', 'config');
  fs.mkdirSync(path.join(cfg, 'grid'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'shortcuts.vdf'), vdf);
  if (originals) for (const a of ['capsule', 'wide', 'hero', 'logo']) fs.writeFileSync(path.join(cfg, 'grid', gridName(VECTOR_ID, a)), PNG(`orig-${a}`));
  const staticDir = tmpDir('lurkbox-static-');
  for (const a of ['capsule', 'wide', 'hero', 'logo', 'icon']) fs.writeFileSync(path.join(staticDir, `${a}.png`), PNG(`static-${a}`));
  return { root, grid: path.join(cfg, 'grid'), staticDir, backupDir: path.join(tmpDir(), 'steam-art-backup'), origIcon };
}

const read = (f) => fs.readFileSync(f).toString('latin1').slice(8);

test('shortcuts.vdf parser finds the Lurkbox entry and its unsigned appid', () => {
  const s = fakeSteam();
  const e = lurkboxShortcut(fs.readFileSync(path.join(s.root, 'userdata', '12345678', 'config', 'shortcuts.vdf')));
  assert.equal(e.appid, VECTOR_ID);
  assert.equal(e.icon, s.origIcon);
});

test('backs up the original grid art before the first overwrite, and only once', async () => {
  const s = fakeSteam();
  const log = [];
  const art = new SteamArt({ root: s.root, staticDir: s.staticDir, backupDir: s.backupDir, env: { APPIMAGE: VECTOR_EXE }, log: (l) => log.push(l), openContext: async () => null });
  const r1 = await art.apply(pngs('one'));
  assert.deepEqual(r1, { ok: true, live: false, appid: VECTOR_ID });
  const bdir = path.join(s.backupDir, String(VECTOR_ID));
  assert.equal(read(path.join(bdir, 'hero.png')), 'orig-hero');
  assert.equal(read(path.join(s.grid, '3002582954_hero.png')), 'one-hero');
  assert.equal(read(path.join(s.grid, '3002582954p.png')), 'one-capsule');
  assert.equal(read(path.join(s.grid, '3002582954_icon.png')), 'one-icon');
  await art.apply(pngs('two'));
  assert.equal(read(path.join(bdir, 'hero.png')), 'orig-hero', 'second apply must not overwrite the backup');
  assert.equal(read(path.join(s.grid, '3002582954_logo.png')), 'two-logo');
  assert.ok(log.some((l) => l.includes('backed up')));

  await art.restore();
  for (const a of ['capsule', 'wide', 'hero', 'logo']) assert.equal(read(path.join(s.grid, gridName(VECTOR_ID, a))), `orig-${a}`);
});

test('restore without original files uses the shipped art', async () => {
  const s = fakeSteam({ originals: false });
  const art = new SteamArt({ root: s.root, staticDir: s.staticDir, backupDir: s.backupDir, env: {}, openContext: async () => null });
  await art.apply(pngs('one')); // appid comes from shortcuts.vdf here
  await art.restore();
  assert.equal(read(path.join(s.grid, '3002582954_hero.png')), 'static-hero');
});

test('rejects non-PNG data and reports a missing shortcut', async () => {
  const s = fakeSteam();
  const art = new SteamArt({ root: s.root, staticDir: s.staticDir, backupDir: s.backupDir, env: { APPIMAGE: VECTOR_EXE }, openContext: async () => null });
  await assert.rejects(art.apply({ ...pngs('x'), hero: 'data:image/png;base64,AAAA' }), /PNG/);
  assert.equal(read(path.join(s.grid, '3002582954_hero.png')), 'orig-hero');
  const none = new SteamArt({ root: tmpDir(), staticDir: s.staticDir, backupDir: s.backupDir, env: { APPIMAGE: VECTOR_EXE }, openContext: async () => null });
  await assert.rejects(none.apply(pngs('x')), /No Steam shortcut/);
});

// ---- CDP ----

function fakeCdp({ list } = {}) {
  const sent = [];
  class FakeWS {
    constructor(url) { this.url = url; this.l = {}; setTimeout(() => this.emit('open'), 0); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    emit(t, ev) { for (const f of this.l[t] || []) f(ev); }
    send(s) {
      const m = JSON.parse(s);
      sent.push(m);
      const result = m.method === 'Runtime.evaluate' ? { result: { type: 'object', objectId: 'global-1' } } : { result: { value: true } };
      setTimeout(() => this.emit('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
    }
    close() {}
  }
  const fetch = async (url) => {
    assert.equal(url, 'http://127.0.0.1:8080/json');
    return { ok: true, json: async () => list || [{ title: 'Steam Big Picture Mode', webSocketDebuggerUrl: 'ws://127.0.0.1:8080/devtools/page/A' }, { title: 'SharedJSContext', webSocketDebuggerUrl: 'ws://127.0.0.1:8080/devtools/page/B' }] };
  };
  return { sent, open: () => openSteamContext({ fetch, WebSocket: FakeWS }) };
}

const JPEG = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.padEnd(4, '.'))]);
const themed = (tag, key) => ({
  key,
  capsule: `data:image/jpeg;base64,${JPEG(`${tag}-capsule`).toString('base64')}`,
  wide: `data:image/jpeg;base64,${JPEG(`${tag}-wide`).toString('base64')}`,
  hero: `data:image/jpeg;base64,${JPEG(`${tag}-hero`).toString('base64')}`,
  logo: dataUrl(`${tag}-logo`),
  icon: dataUrl(`${tag}-icon`),
});
const calls = (sent) => sent.filter((m) => m.method === 'Runtime.callFunctionOn');

test('live update: fixed functions via callFunctionOn, no image data in any source, hero not sent, released and closed', async () => {
  const s = fakeSteam();
  const cdp = fakeCdp();
  const log = [];
  const art = new SteamArt({ root: s.root, staticDir: s.staticDir, backupDir: s.backupDir, env: { APPIMAGE: VECTOR_EXE }, openContext: cdp.open, log: (l) => log.push(l) });
  const r = await art.apply(themed('one', 'k1'));
  assert.equal(r.live, true);
  const methods = cdp.sent.map((m) => m.method);
  assert.deepEqual(methods, ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup']);
  assert.equal(cdp.sent[0].params.expression, 'globalThis');
  for (const m of calls(cdp.sent)) {
    assert.ok(DECLS.includes(m.params.functionDeclaration), m.params.functionDeclaration);
    assert.equal(m.params.objectId, 'global-1');
  }
  // capsule 0, wide 3, logo 2 as jpg/jpg/png; then the icon. No hero (type 1).
  assert.deepEqual(calls(cdp.sent).slice(0, 3).map((m) => [m.params.arguments[2].value, m.params.arguments[3].value]), [['jpg', 0], ['jpg', 3], ['png', 2]]);
  assert.match(calls(cdp.sent)[3].params.arguments[1].value, /3002582954_icon\.png$/);
  // Files: JPEG assets replace the PNG grid files.
  assert.ok(fs.existsSync(path.join(s.grid, '3002582954_hero.jpg')));
  assert.ok(!fs.existsSync(path.join(s.grid, '3002582954_hero.png')));
  assert.ok(log.some((l) => /payload capsule jpg \d+ KB, wide jpg/.test(l)), log.join('\n'));

  cdp.sent.length = 0;
  art.lastLiveAt = 0;
  await art.restore();
  const fns = calls(cdp.sent).map((m) => /Apps\.(\w+)/.exec(m.params.functionDeclaration)[1]);
  assert.equal(fns.filter((f) => f === 'ClearCustomArtworkForApp').length, 4);
  assert.equal(fns.filter((f) => f === 'SetCustomArtworkForApp').length, 3, 'hero is file-only');
  assert.equal(calls(cdp.sent).at(-1).params.arguments[1].value, s.origIcon, 'restores the original shortcut icon');
  assert.ok(fs.existsSync(path.join(s.grid, '3002582954_hero.png')));
  assert.ok(!fs.existsSync(path.join(s.grid, '3002582954_hero.jpg')));
});

test('an unchanged theme key is skipped, even after a restart; live updates are at least 60 s apart', async () => {
  const s = fakeSteam();
  const cdp = fakeCdp();
  let now = 1_000_000;
  const timers = [];
  const mk = () => new SteamArt({ root: s.root, staticDir: s.staticDir, backupDir: s.backupDir, env: { APPIMAGE: VECTOR_EXE }, openContext: cdp.open, now: () => now, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  const art = mk();
  assert.equal((await art.apply(themed('one', 'k1'))).live, true);
  const n = cdp.sent.length;
  assert.equal((await art.apply(themed('one', 'k1'))).skipped, true);
  assert.equal((await mk().apply(themed('one', 'k1'))).skipped, true, 'the key survives a restart');
  assert.equal(cdp.sent.length, n, 'nothing sent for an unchanged theme');

  now += 10_000;
  const r2 = await art.apply(themed('two', 'k2'));
  assert.equal(r2.deferred, true);
  assert.equal(read(path.join(s.grid, '3002582954_logo.png')), 'two-logo', 'files are written right away');
  await art.apply(themed('three', 'k3'));
  assert.equal(timers.length, 1, 'one deferred live update, not one per apply');
  assert.equal(timers[0].ms, 50_000);
  assert.equal(cdp.sent.length, n);
  now += 50_000;
  await timers[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  const logos = calls(cdp.sent.slice(n)).filter((m) => m.params.arguments[3] && m.params.arguments[3].value === 2);
  assert.equal(logos.length, 1);
  assert.equal(Buffer.from(logos[0].params.arguments[1].value, 'base64').toString('latin1').slice(8), 'three-logo', 'the newest images go live');
});

test('no SharedJSContext, or a non-loopback debugger URL, means no CDP', async () => {
  assert.equal(await fakeCdp({ list: [{ title: 'Other', webSocketDebuggerUrl: 'ws://127.0.0.1:8080/x' }] }).open(), null);
  assert.equal(await fakeCdp({ list: [{ title: 'SharedJSContext', webSocketDebuggerUrl: 'ws://evil.example:8080/x' }] }).open(), null);
  assert.equal(await openSteamContext({ fetch: async () => { throw new Error('ECONNREFUSED'); }, WebSocket: class {} }), null);
});
