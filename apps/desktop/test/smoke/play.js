'use strict';
// Playback smoke test (needs network and a live channel).
//   npm run test:play     → official embed engine
//   npm run test:direct   → direct HLS engine
//   LURKBOX_TEST_CHANNEL=foo overrides the channel (default lofigirl).
// Runs under Gamescope-like settings (screen margin 2.5%, UI scale 110%),
// opens the overlay right after PLAYING, checks playback continues for 10 s,
// then pauses and resumes like a user. Exits 0 on pass, 1 on failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const CHANNEL = process.env.LURKBOX_TEST_CHANNEL || 'lofigirl';
const ENGINE = process.env.LURKBOX_TEST_ENGINE === 'direct' ? 'direct' : 'embed';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lurkbox-play-'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ playerEngine: ENGINE, screenMargin: Number(process.env.LURKBOX_TEST_MARGIN ?? 2.5), uiScale: Number(process.env.LURKBOX_TEST_SCALE ?? 110) }));
process.env.LURKBOX_USER_DATA = userData;
process.argv.push('--windowed', `--channel=${CHANNEL}`);

let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  console.log(`[play-smoke:${ENGINE}] ${code === 0 ? 'PASS' : 'FAIL'}: ${msg}`);
  try { console.log(fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8').trim().split('\n').map((l) => `  log: ${l}`).join('\n')); } catch { /* no log */ }
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
};
setTimeout(() => finish(1, `timed out on "${CHANNEL}" (is it live?)`), 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  let started = false;
  wc.on('console-message', async (e) => {
    if (started || !/\[player\] PLAYING after/.test(e.message)) return;
    started = true;
    const ms = Number(/after (\d+)/.exec(e.message)[1]);
    if (ENGINE === 'direct' && !(await js('!!(__lurkbox.player.embed && __lurkbox.player.embed.isDirect)'))) return finish(1, 'fell back to the embed');
    if (ENGINE === 'embed') {
      const pe = await js("getComputedStyle(document.querySelector('#player-host iframe')).pointerEvents");
      if (pe !== 'none') return finish(1, `iframe pointer-events is "${pe}"`);
      for (const f of wc.mainFrame.framesInSubtree) {
        if (!/player\.twitch\.tv/.test(f.url)) continue;
        const native = await f.executeJavaScript("[...document.querySelectorAll('[data-a-target=\"player-info-title\"],[data-a-target=\"player-controls\"]')].filter((n) => n.offsetParent !== null).length").catch(() => '?');
        if (native !== 0) return finish(1, `native embed overlay visible (${native})`);
      }
    }
    // Open our overlay right away (the device bug: the embed paused and never resumed).
    await js("__lurkbox.dispatch('A', 'pad')");
    const t0 = await js('__lurkbox.player.embed.getCurrentTime()');
    await sleep(10000);
    const s1 = await js('({ paused: __lurkbox.player.embed.isPaused(), t: __lurkbox.player.embed.getCurrentTime(), overlay: !document.querySelector("#player-overlay").hidden })');
    const playedUnderOverlay = !s1.paused && s1.t - t0 >= 7;
    if (!playedUnderOverlay && ENGINE === 'direct') return finish(1, `playback stalled with the overlay open (paused=${s1.paused}, advanced ${(s1.t - t0).toFixed(1)} s)`);
    // Close the overlay; the embed must be playing again shortly after.
    await js("__lurkbox.player.hideOverlay()");
    await sleep(2500);
    const ta = await js('__lurkbox.player.embed.getCurrentTime()');
    await sleep(3000);
    const sb = await js('({ paused: __lurkbox.player.embed.isPaused(), t: __lurkbox.player.embed.getCurrentTime() })');
    if (sb.paused || sb.t - ta < 2) return finish(1, `not playing after the overlay closed (paused=${sb.paused}, advanced ${(sb.t - ta).toFixed(1)} s)`);
    // User pause, then resume.
    await js('__lurkbox.player.togglePause()');
    await sleep(1500);
    if (!(await js('__lurkbox.player.embed.isPaused()'))) return finish(1, 'user pause did not pause');
    await js('__lurkbox.player.togglePause()');
    await sleep(2500); // a live embed restarts at the live edge, so currentTime may reset
    const t1 = await js('__lurkbox.player.embed.getCurrentTime()');
    await sleep(5000);
    const s2 = await js('({ paused: __lurkbox.player.embed.isPaused(), t: __lurkbox.player.embed.getCurrentTime() })');
    if (s2.paused || s2.t - t1 < 3) return finish(1, `resume after a user pause failed (paused=${s2.paused}, advanced ${(s2.t - t1).toFixed(1)} s)`);
    const gate = /clicked .*(gate|mature|content-classification)/.test(fs.existsSync(path.join(userData, 'lurkbox.log')) ? fs.readFileSync(path.join(userData, 'lurkbox.log'), 'utf8') : '');
    finish(0, `PLAYING after ${ms} ms; content gate ${gate ? 'appeared and was dismissed' : 'did not appear'}; ${playedUnderOverlay ? 'kept playing 10 s under the translucent overlay' : 'PAUSED under the overlay, resumed when it closed'} (margin ${process.env.LURKBOX_TEST_MARGIN ?? 2.5}%, scale ${process.env.LURKBOX_TEST_SCALE ?? 110}%); pause/resume works`);
  });
});

require('../../src/main/main.js');
