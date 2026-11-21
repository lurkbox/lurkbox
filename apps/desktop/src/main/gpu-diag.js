'use strict';
// GPU and video-decode diagnostics for lurkbox.log.
//
// Findings (Electron 45 / Chromium 156, AMD on X11, 2026-11-21):
// - app.getGPUInfo('complete') has no decoder list in this Electron (only auxAttributes and gpuDevice), so the old
//   "[gpu] ... decode profiles: none reported" line said nothing about VA-API. chrome://gpu's "Video Acceleration
//   Information" is the real list; we read it from a hidden window.
// - VA-API decode is on by default on Linux in this Chromium; no enable-features flag is needed.
// - Which decoder a <video> really uses is only visible through the DevTools Media domain
//   (kVideoDecoderName / kIsPlatformVideoDecoder), so that is logged per player.
// - Appending --ozone-platform from the main script is too late for the browser process (it has already picked its
//   platform) but not for the GPU process, which then crashes (exit 139) when they differ. Pass it on the command line.
const { app, BrowserWindow } = require('electron');

/** Decoder lines from chrome://gpu's "Video Acceleration Information" text: ['h264 main', 'av1 profile main', ...]. */
function parseDecodeProfiles(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const start = t.indexOf('Video Acceleration Information');
  if (start < 0) return [];
  const sec = t.slice(start);
  const dec = sec.indexOf('Decoding');
  if (dec < 0) return [];
  let body = sec.slice(dec + 'Decoding'.length);
  const end = body.search(/Encoding|Vulkan Information|Device Performance/);
  if (end >= 0) body = body.slice(0, end);
  const out = [];
  const re = /Decode ([a-z0-9]+(?: [a-z0-9-]+)*?)\s*:\s*\d+x\d+ to \d+x\d+ pixels/gi;
  let m;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}

/** Codec family of a decode profile name: 'h264' | 'hevc' | 'av1' | 'vp9' | 'vp8' | other. */
function profileCodec(p) { return String(p).split(' ')[0].toLowerCase(); }

/** Short summary for the log: "h264(3) hevc(3) av1(1) vp9(2)". */
function summarizeProfiles(profiles) {
  const n = {};
  for (const p of profiles) { const c = profileCodec(p); n[c] = (n[c] || 0) + 1; }
  return Object.entries(n).map(([c, k]) => `${c}(${k})`).join(' ');
}

/** GL_RENDERER from chrome://gpu text, e.g. "ANGLE (AMD, AMD Radeon ... radeonsi ..., OpenGL 4.6)". */
function parseGlRenderer(text) {
  const m = /GL_RENDERER\s*:?\s*(.+?)\s*GL_VERSION/.exec(String(text || '').replace(/\s+/g, ' '));
  return m ? m[1].trim() : null;
}

/** One-line summary of a Media-domain kVideoTracks value: "h264 1920x1080". */
function summarizeVideoTracks(value) {
  try {
    const t = (typeof value === 'string' ? JSON.parse(value) : value)[0] || {};
    return [t.codec, t['coded size']].filter(Boolean).join(' ');
  } catch { return ''; }
}

/** Opens chrome://gpu in a hidden window: { profiles, glRenderer } (empty on failure). */
async function readChromeGpu({ timeoutMs = 8000 } = {}) {
  let w = null;
  let last = { profiles: [], glRenderer: null };
  try {
    // Hidden and unfocusable, so it can't take focus. Offscreen rendering is worse: it blurred the main window.
    w = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 400, height: 300, webPreferences: { offscreen: false } });
    await w.loadURL('chrome://gpu');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const txt = await w.webContents.executeJavaScript(
        "(() => { const v = document.querySelector('info-view'); const r = v && v.shadowRoot; return r ? r.textContent : ''; })()",
      ).catch(() => '');
      // The page fills in its sections asynchronously; wait for the decoder list (it may legitimately be empty).
      if (/Video Acceleration Information/.test(txt)) {
        last = { profiles: parseDecodeProfiles(txt), glRenderer: parseGlRenderer(txt) };
        if (last.profiles.length) return last;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  } catch { return { profiles: [], glRenderer: null }; } finally {
    if (w && !w.isDestroyed()) w.destroy();
  }
}

/** Logs GPU devices, feature status, GL backend and the real decode profiles once. */
async function logGpu({ log, hwRequested, config }) {
  let dev = 'unknown GPU';
  let gl = '?';
  try {
    const info = await app.getGPUInfo('complete');
    dev = (info.gpuDevice || []).map((d) => `${d.active ? '*' : ''}${(d.vendorId || 0).toString(16)}:${(d.deviceId || 0).toString(16)}${d.driverVendor ? ` ${d.driverVendor} ${d.driverVersion || ''}`.trimEnd() : ''}`).join(', ') || dev;
    const aux = info.auxAttributes || {};
    gl = aux.glImplementationParts || aux.glRenderer || '?';
  } catch (e) { gl = `getGPUInfo failed: ${e.message}`; }
  const fs = app.getGPUFeatureStatus();
  const { profiles, glRenderer } = await readChromeGpu();
  if (glRenderer) gl = glRenderer;
  log(`[gpu] ${dev}; gl ${gl}; gpu_compositing=${fs.gpu_compositing} video_decode=${fs.video_decode}; hw decode ${hwRequested ? 'requested' : 'off'} (${config}); decode profiles: ${profiles.length ? summarizeProfiles(profiles) : 'none reported'}`);
  if (profiles.length) log(`[gpu] decode profiles: ${profiles.join(', ')}`);
  return profiles;
}

/**
 * Logs which decoder each media player in the window uses (DevTools Media domain), e.g.
 * "[media] decoder VaapiVideoDecoder (hardware) avc1 1920x1080". Never throws.
 */
function watchDecoders(wc, log) {
  const seen = new Map();
  const dbg = wc.debugger;
  const attach = async () => {
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Media.enable');
    } catch (e) { log(`[media] decoder watch unavailable: ${e.message}`); }
  };
  dbg.on('message', (_e, method, params) => {
    if (method !== 'Media.playerPropertiesChanged') return;
    const st = seen.get(params.playerId) || {};
    for (const p of params.properties || []) st[p.name] = p.value;
    seen.set(params.playerId, st);
    if (st.kVideoDecoderName && st.kVideoDecoderName !== st.loggedDecoder) {
      st.loggedDecoder = st.kVideoDecoderName;
      const hw = st.kIsPlatformVideoDecoder === 'true' || st.kIsPlatformVideoDecoder === true;
      const tracks = summarizeVideoTracks(st.kVideoTracks);
      log(`[media] decoder ${st.kVideoDecoderName} (${hw ? 'hardware' : 'software'})${tracks ? ` ${tracks}` : ''}`);
    }
  });
  dbg.on('detach', (_e, reason) => { if (reason !== 'target closed') log(`[media] debugger detached: ${reason}`); });
  wc.on('did-finish-load', attach);
  attach();
}

module.exports = { parseDecodeProfiles, parseGlRenderer, summarizeVideoTracks, summarizeProfiles, profileCodec, readChromeGpu, logGpu, watchDecoders };
