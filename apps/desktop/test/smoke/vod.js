'use strict';
// VOD smoke test (needs network): plays a recent past broadcast on the direct engine.
//   npm run test:vod
//   LURKBOX_TEST_VOD=<id> picks the video; otherwise the newest archive of LURKBOX_TEST_VOD_CHANNELS (comma list).
// Passes when PLAYING arrives within 10 s of opening, on the direct engine, without a fallback, and playback advances.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { WEB_CLIENT_ID, GQL_URL } = require('../../src/main/direct.js');

const CHANNELS = (process.env.LURKBOX_TEST_VOD_CHANNELS || 'xqc,kaicenat,shroud,summit1g,pokimane').split(',');
const LIMIT_MS = Number(process.env.LURKBOX_TEST_VOD_LIMIT_MS || 10000);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-vod-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ playerEngine: 'direct', videoOnlyUnfocused: false }));
process.env.LURKBOX_USER_DATA = userData;

let done = false;
const readLog = () => { try { return fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8'); } catch { return ''; } };
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(`[vod-smoke] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  console.log(readLog().trim().split('\n').filter((l) => /\[(vod|direct|player|hls-proxy|player-cookies)\]/.test(l)).map((l) => `  log: ${l}`).join('\n'));
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// main.js reads --vod at load and must load before the app is ready, so the lookup runs in a child Node process.
if (process.env.LURKBOX_FIND_VOD) {
  findVod().then((v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); });
  return;
}
let vod = null;
try {
  vod = JSON.parse(require('child_process').execFileSync(process.execPath, [__filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LURKBOX_FIND_VOD: '1' }, timeout: 20000 }).toString() || 'null');
} catch (e) { console.log(`[vod-smoke] VOD lookup failed: ${e.message}`); }
/** Newest public archive VOD (not sub-only) of the first channel that has one, via Twitch's web GQL. */
async function findVod() {
  if (process.env.LURKBOX_TEST_VOD) return { id: process.env.LURKBOX_TEST_VOD, channel: '?' };
  for (const login of CHANNELS) {
    const q = `{ user(login: ${JSON.stringify(login)}) { videos(first: 5, type: ARCHIVE, sort: TIME) { edges { node { id lengthSeconds } } } } }`;
    try {
      const r = await fetch(GQL_URL, { method: 'POST', headers: { 'Client-ID': WEB_CLIENT_ID }, body: JSON.stringify({ query: q }) }).then((x) => x.json());
      const edges = (r.data && r.data.user && r.data.user.videos && r.data.user.videos.edges) || [];
      const v = edges.map((e) => e.node).find((n) => n.lengthSeconds > 120);
      if (v) return { id: v.id, channel: login };
    } catch { /* next channel */ }
  }
  return null;
}
{
  if (!vod) { console.log('[vod-smoke] FAIL: no VOD found'); process.exit(1); }
  console.log(`[vod-smoke] VOD ${vod.id} (${vod.channel})`);
  process.argv.push('--windowed', `--vod=${vod.id}`);
  setTimeout(() => finish(1, `timed out on VOD ${vod.id}`), 45000).unref();

  app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);
    let started = false;
    wc.on('console-message', async (e) => {
      if (/direct engine -> Twitch player/.test(e.message)) return finish(1, `fell back: ${e.message}`);
      if (started || !/\[player\] PLAYING after/.test(e.message)) return;
      started = true;
      const ms = Number(/after (\d+)/.exec(e.message)[1]);
      if (!(await js('!!(__lurkbox.player.embed && __lurkbox.player.embed.isDirect)'))) return finish(1, 'not on the direct engine');
      if (ms > LIMIT_MS) return finish(1, `PLAYING after ${ms} ms (limit ${LIMIT_MS} ms)`);
      const t0 = await js('__lurkbox.player.embed.getCurrentTime()');
      await sleep(4000);
      const t1 = await js('__lurkbox.player.embed.getCurrentTime()');
      if (t1 - t0 < 2) return finish(1, `playback did not advance (${t0.toFixed(1)} -> ${t1.toFixed(1)})`);
      if (/direct engine -> Twitch player/.test(readLog())) return finish(1, 'fell back to the embed');
      // Scrubbing: RT = +30 s (applied after the 400 ms pause), then hold RIGHT on the seek bar and release.
      const now = () => js('__lurkbox.player.embed.getCurrentTime()');
      const a0 = await now();
      await js("__lurkbox.dispatch('RT', 'pad')");
      await sleep(1200);
      const a1 = await now();
      if (!(a1 - a0 > 25 && a1 - a0 < 40)) return finish(1, `RT did not jump +30 s (${a0.toFixed(1)} -> ${a1.toFixed(1)})`);
      const onBar = await js('document.activeElement === __lurkbox.player.seekBar.node');
      if (!onBar) return finish(1, `the seek bar is not focused after a trigger jump (active: ${await js('(document.activeElement && document.activeElement.className) + " overlay hidden=" + document.querySelector("#player-overlay").hidden + " bar in dom=" + document.contains(__lurkbox.player.seekBar.node) + " hidden=" + __lurkbox.player.seekBar.node.hidden')})`);
      await js("__lurkbox.dispatch('RIGHT', 'pad')");
      for (let i = 0; i < 12; i++) { await sleep(110); await js("__lurkbox.dispatch('RIGHT', 'pad')"); }
      const preview = await js('__lurkbox.player.seekBar.preview');
      await js("__lurkbox.player.release('RIGHT')");
      await sleep(1500);
      const a2 = await now();
      if (!(a2 - a1 > 120)) return finish(1, `hold-to-scrub moved only ${(a2 - a1).toFixed(1)} s (preview ${preview})`);
      const shot = process.env.LURKBOX_TEST_SHOT;
      if (shot) {
        await js("__lurkbox.dispatch('RIGHT', 'pad')");
        await sleep(300);
        fs.writeFileSync(shot, (await wc.capturePage()).toPNG());
      }
      // Resume: leave the player, open the VOD again, pick "Resume at ...".
      const leftAt = await now();
      await js('__lurkbox.player.close()');
      await sleep(500);
      await js(`__lurkbox.player.show(); void __lurkbox.player.openVideo({ id: '${vod.id}', title: '', user_login: '', user_name: '' }); 1`);
      await sleep(1500);
      const label = await js("(document.querySelector('.modal .pick-item.selected') || {}).textContent || ''");
      if (!/^Resume at /.test(label)) return finish(1, `no resume prompt on reopening (got "${label}")`);
      await js("document.querySelector('.modal .pick-item.selected').click()");
      await sleep(4000);
      const r = await now();
      if (Math.abs(r - leftAt) > 15) return finish(1, `resumed at ${r.toFixed(0)} s, left at ${leftAt.toFixed(0)} s`);
      // The start timeline: the first open (no prompt) and the resumed open (prompt shown and answered).
      await new Promise((res) => setTimeout(res, 500));
      const lines = readLog().split('\n').filter((l) => l.includes(`[vod] ${vod.id} open`));
      if (!lines.some((l) => /master \d+ ms.*first level \d+ ms.*first frame \d+ ms.*PLAYING \d+ ms/.test(l))) return finish(1, `no VOD start timeline in the log: ${JSON.stringify(lines)}`);
      if (!lines.some((l) => /resume prompt shown \d+ ms → answered \d+ ms \(resume at [\d:]+\).*PLAYING \d+ ms/.test(l))) return finish(1, `no resume steps in the VOD start timeline: ${JSON.stringify(lines)}`);
      finish(0, `VOD ${vod.id} PLAYING after ${ms} ms on the direct engine, advanced ${(t1 - t0).toFixed(1)} s in 4 s; RT +${(a1 - a0).toFixed(0)} s; hold-scrub +${(a2 - a1).toFixed(0)} s; "${label}" resumed at ${r.toFixed(0)} s (left at ${leftAt.toFixed(0)} s)`);
    });
  });
  require('../../src/main/main.js');
}
