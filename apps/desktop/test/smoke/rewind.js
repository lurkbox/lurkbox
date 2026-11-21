'use strict';
// Live rewind smoke test (needs network): a live channel whose broadcast is being archived.
//   npm run test:rewind     (LURKBOX_TEST_CHANNEL=<login> to pick one)
// Rewinds 10 minutes with the triggers (into the archive VOD), checks it plays there with the "Rewound" badge,
// then X goes back to live.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WEB_CLIENT_ID, GQL_URL, matchGqlArchive } = require('../../src/main/direct.js');

async function findChannel() {
  if (process.env.LURKBOX_TEST_CHANNEL) return process.env.LURKBOX_TEST_CHANNEL;
  const q = '{ streams(first: 30) { edges { node { id createdAt broadcaster { login videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id createdAt lengthSeconds status } } } } } } } }';
  const r = await fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID }, body: JSON.stringify({ query: q }) }).then((x) => x.json());
  for (const e of r.data.streams.edges) {
    const n = e.node;
    const v = n.broadcaster && n.broadcaster.videos.edges[0];
    const a = v && matchGqlArchive(n, v.node);
    if (a && v.node.lengthSeconds > 1800) return n.broadcaster.login;
  }
  return null;
}

if (process.env.LURKBOX_FIND_CHANNEL) {
  findChannel().then((c) => { process.stdout.write(JSON.stringify(c)); process.exit(0); });
  return;
}
let channel = null;
try {
  channel = JSON.parse(require('child_process').execFileSync(process.execPath, [__filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LURKBOX_FIND_CHANNEL: '1' }, timeout: 20000 }).toString() || 'null');
} catch (e) { console.log(`[rewind-smoke] lookup failed: ${e.message}`); }
if (!channel) { console.log('[rewind-smoke] FAIL: no live channel with an archive found'); process.exit(1); }

const { app } = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-rewind-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ playerEngine: 'direct', videoOnlyUnfocused: false }));
process.env.LURKBOX_USER_DATA = userData;
process.argv.push('--windowed', `--channel=${channel}`);
console.log(`[rewind-smoke] channel ${channel}`);

let done = false;
const readLog = () => { try { return fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8'); } catch { return ''; } };
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(`[rewind-smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  console.log(readLog().trim().split('\n').filter((l) => /live rewind|PLAYING|fell|direct engine ->|seek/.test(l)).map((l) => `  log: ${l}`).join('\n'));
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
};
setTimeout(() => finish(1, 'timed out'), 90000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  let started = false;
  wc.on('console-message', async (e) => {
    if (started || !/\[player\] PLAYING after/.test(e.message)) return;
    started = true;
    await sleep(2000); // live info (stream start, archive) arrives
    const hasArchive = await js('!!__lurkbox.player.archive');
    if (!hasArchive) return finish(1, 'no archive found for the live stream');
    // 20 x RT-style jumps back = −10 min, applied once after the 400 ms pause.
    for (let i = 0; i < 20; i++) await js("__lurkbox.dispatch('LT', 'pad')");
    await sleep(6000);
    const st = await js(`(() => { const p = __lurkbox.player; const m = p.seekModel(); return { rewind: !!p.rewind, video: p.embed.target && p.embed.target.video, t: p.embed.getCurrentTime(), paused: p.embed.isPaused(), off: m ? m.max - m.pos : null, badge: document.getElementById('live-badge').textContent, label: (document.querySelector('.po-live') || {}).textContent }; })()`);
    if (!st.rewind || !st.video) return finish(1, `not rewound: ${JSON.stringify(st)}`);
    await sleep(3000);
    const t2 = await js('__lurkbox.player.embed.getCurrentTime()');
    if (t2 - st.t < 2) return finish(1, `archive VOD not playing (${st.t} -> ${t2})`);
    if (!(st.off > 500 && st.off < 700)) return finish(1, `rewound ${st.off} s, expected ~600`);
    const shot = process.env.LURKBOX_TEST_SHOT;
    if (shot) fs.writeFileSync(shot, (await wc.capturePage()).toPNG());
    await js("__lurkbox.dispatch('X', 'pad')");
    await sleep(5000);
    const back = await js('({ rewind: !!__lurkbox.player.rewind, channel: __lurkbox.player.embed.target.channel, paused: __lurkbox.player.embed.isPaused(), lat: __lurkbox.player.latency() })');
    if (back.rewind || !back.channel || back.paused) return finish(1, `X did not go back to live: ${JSON.stringify(back)}`);
    finish(0, `${channel}: rewound to −${Math.round(st.off)} s in archive ${st.video} (label "${st.label}"), playing; X back to live (latency ${back.lat && back.lat.toFixed(1)} s)`);
  });
});
require('../../src/main/main.js');
