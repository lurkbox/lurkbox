'use strict';
// Demo mode video (LURKBOX_DEMO=1): a 60 s loop rendered once with ffmpeg from the demo scene (the camera pans
// across it while a little TV runner crosses), cut into 2 s HLS segments, plus a storyboard sprite for scrubbing.
// The playlists are made up on the fly: a sliding live window that loops the segments forever (with
// discontinuities at each wrap), and VODs of any length built from the same loop. No network involved.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SEG_DUR = 2;
const LOOP_SEC = 60;
const SEG_COUNT = LOOP_SEC / SEG_DUR;
const VERSION = 'v1';
const SB = { cols: 5, rows: 5, width: 220, height: 124 };

const pad = (i) => String(i).padStart(3, '0');

/** Renders the media into dir unless it is already there. Returns { ok, dir, reason? }. */
function ensureDemoMedia(dir, { sceneSvg, runnerSvg, ffmpeg = process.env.LURKBOX_FFMPEG || 'ffmpeg', log = () => {} }) {
  const stamp = path.join(dir, `ready-${VERSION}`);
  if (fs.existsSync(stamp)) return { ok: true, dir };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.svg'), sceneSvg);
  fs.writeFileSync(path.join(dir, 'runner.svg'), runnerSvg);
  const run = (args) => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const t0 = Date.now();
  // Rasterise the SVGs once (decoding an SVG for every frame is slow).
  for (const n of ['scene', 'runner']) {
    const c = run(['-i', `${n}.svg`, '-frames:v', '1', `${n}.png`]);
    if (c.error || c.status !== 0) {
      const reason = c.error ? (c.error.code === 'ENOENT' ? 'ffmpeg not found' : c.error.message) : `ffmpeg could not rasterise ${n}.svg (no librsvg?): ${(c.stderr || '').trim().slice(-200)}`;
      log(`[demo] demo video not rendered: ${reason}`);
      return { ok: false, dir, reason };
    }
  }
  // Pan over the 1600×900 scene in a closed loop (sin/cos with a 60 s period), so the wrap is seamless; the runner
  // crosses the screen once per loop with a little hop.
  const filter = [
    '[0:v]scale=1600:900,setsar=1[bg]',
    "[bg]crop=1280:720:x='160+150*sin(2*PI*t/60)':y='90+60*sin(2*PI*t/30)'[pan]",
    '[1:v]scale=120:120[run]',
    "[pan][run]overlay=x='mod(t*1400/60,1400)-120':y='470-abs(70*sin(2*PI*t/1.5))':shortest=1,format=yuv420p[v]",
  ].join(';');
  const r = run([
    '-loop', '1', '-framerate', '30', '-t', String(LOOP_SEC), '-i', 'scene.png',
    '-loop', '1', '-framerate', '30', '-t', String(LOOP_SEC), '-i', 'runner.png',
    '-f', 'lavfi', '-t', String(LOOP_SEC), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', filter, '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast', '-crf', '24', '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-t', String(LOOP_SEC),
    '-f', 'hls', '-hls_time', String(SEG_DUR), '-hls_list_size', '0', '-hls_segment_filename', 'seg%03d.ts', 'loop.m3u8',
  ]);
  if (r.error || r.status !== 0) {
    const reason = r.error ? `${r.error.code === 'ENOENT' ? 'ffmpeg not found' : r.error.message}` : `ffmpeg failed: ${(r.stderr || '').trim().slice(-300)}`;
    log(`[demo] demo video not rendered: ${reason}`);
    return { ok: false, dir, reason };
  }
  // Storyboard: 25 frames spread over the loop, tiled 5×5.
  const sb = run(['-i', 'loop.m3u8', '-vf', `fps=${SB.cols * SB.rows}/${LOOP_SEC},scale=${SB.width}:${SB.height},tile=${SB.cols}x${SB.rows}`, '-frames:v', '1', '-q:v', '4', 'storyboard.jpg']);
  if (sb.status !== 0) log(`[demo] storyboard not rendered: ${(sb.stderr || '').trim().slice(-200)}`);
  const segs = fs.readdirSync(dir).filter((f) => /^seg\d{3}\.ts$/.test(f)).length;
  if (segs < SEG_COUNT) return { ok: false, dir, reason: `only ${segs} segments rendered` };
  fs.writeFileSync(stamp, new Date().toISOString());
  log(`[demo] rendered the demo video in ${Date.now() - t0} ms (${dir})`);
  return { ok: true, dir };
}

/** A master playlist in Twitch's shape (named VIDEO groups), every rendition pointing at the same demo media. */
function masterPlaylist(mediaUrl) {
  const levels = [
    ['chunked', '720p60 (source)', 1280, 720, 60, 3000000],
    ['720p30', '720p', 1280, 720, 30, 2000000],
    ['480p30', '480p', 852, 480, 30, 1200000],
    ['360p30', '360p', 640, 360, 30, 700000],
  ];
  const out = ['#EXTM3U'];
  for (const [group, name, w, h, fps, bw] of levels) {
    out.push(`#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${group}",NAME="${name}",AUTOSELECT=YES,DEFAULT=${group === 'chunked' ? 'YES' : 'NO'}`);
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},CODECS="avc1.4D401F,mp4a.40.2",VIDEO="${group}",FRAME-RATE=${fps}.000`);
    out.push(`${mediaUrl}${mediaUrl.includes('?') ? '&' : '?'}q=${group}`);
  }
  return `${out.join('\n')}\n`;
}

const segLine = (base, i) => `${base}seg${pad(i % SEG_COUNT)}.ts`;

/** A live media playlist: the last `windowSize` segments of an endless loop, `elapsedSec` after it started. */
function livePlaylist({ elapsedSec, segBase, windowSize = 6 }) {
  const last = Math.max(windowSize - 1, Math.floor(elapsedSec / SEG_DUR));
  const first = last - windowSize + 1;
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DUR}`, `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / SEG_COUNT)}`];
  for (let i = first; i <= last; i++) {
    if (i > first && i % SEG_COUNT === 0) out.push('#EXT-X-DISCONTINUITY');
    out.push(`#EXTINF:${SEG_DUR.toFixed(3)},live`, segLine(segBase, i));
  }
  return `${out.join('\n')}\n`;
}

/** A VOD media playlist of about durationSec seconds, looping the segments. */
function vodPlaylist({ durationSec, segBase }) {
  const n = Math.max(1, Math.ceil(durationSec / SEG_DUR));
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG_DUR}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % SEG_COUNT === 0) out.push('#EXT-X-DISCONTINUITY');
    out.push(`#EXTINF:${SEG_DUR.toFixed(3)},`, segLine(segBase, i));
  }
  out.push('#EXT-X-ENDLIST');
  return `${out.join('\n')}\n`;
}

/** Storyboard info for a VOD of durationSec (platform.d.ts storyboard shape): the loop's sprite stretched over it. */
function storyboardFor(durationSec, url) {
  const count = SB.cols * SB.rows;
  return { count, width: SB.width, height: SB.height, rows: SB.rows, cols: SB.cols, interval: Math.max(1, durationSec / count), images: [url] };
}

module.exports = { ensureDemoMedia, masterPlaylist, livePlaylist, vodPlaylist, storyboardFor, SEG_DUR, SEG_COUNT, LOOP_SEC, VERSION };
