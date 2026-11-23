// Pure helpers for the direct HLS engine (unit-tested).

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

/** Quality list from a Twitch master playlist, in playlist order: [{group, name, height, fps, bandwidth, index}]. */
export function parseQualities(master) {
  const names = {};
  const out = [];
  for (const line of String(master).split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13));
      if (a.TYPE === 'VIDEO') names[a['GROUP-ID']] = a.NAME;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(line.slice(18));
      const group = a.VIDEO || '';
      const height = a.RESOLUTION ? Number(a.RESOLUTION.split('x')[1]) : 0;
      out.push({
        group,
        name: (names[group] || group).replace(/\s*\(source\)/i, ' (Source)'),
        height,
        fps: Math.round(Number(a['FRAME-RATE']) || 0),
        bandwidth: Number(a.BANDWIDTH) || 0,
        index: out.length,
        audioOnly: group === 'audio_only',
      });
    }
  }
  return out;
}

/**
 * Ad markers from EXT-X-DATERANGE entries (objects with CLASS, START-DATE, DURATION
 * and X-TV-TWITCH-* attributes, or raw playlist text). Returns
 * { inAd, endsAt (ms epoch | null) } for a given program time. Labels only; nothing is skipped.
 */
export function adState(input, nowMs) {
  const ranges = typeof input === 'string'
    ? input.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-DATERANGE:')).map((l) => attrs(l.slice(18)))
    : input;
  let inAd = false;
  let endsAt = null;
  // The latest stream-source marker says whether stitched ads or live content is playing.
  const sources = ranges.filter((r) => r.CLASS === 'twitch-stream-source').sort((a, b) => Date.parse(a['START-DATE']) - Date.parse(b['START-DATE']));
  const lastSource = sources.filter((r) => Date.parse(r['START-DATE']) <= nowMs).pop();
  if (lastSource && lastSource['X-TV-TWITCH-STREAM-SOURCE'] && lastSource['X-TV-TWITCH-STREAM-SOURCE'] !== 'live') inAd = true;
  for (const r of ranges) {
    if (r.CLASS !== 'twitch-stitched-ad') continue;
    const start = Date.parse(r['START-DATE']);
    const dur = Number(r.DURATION || r['X-TV-TWITCH-AD-POD-LENGTH'] || 0) * 1000;
    if (start <= nowMs && (!dur || nowMs < start + dur)) {
      inAd = true;
      if (dur) endsAt = Math.max(endsAt || 0, start + dur);
    }
  }
  return { inAd, endsAt };
}

/** Whether to give up on the direct engine and use the official embed. */
export function shouldFallback(ev) {
  switch (ev.type) {
    case 'token-error': return { fallback: true, reason: `token: ${ev.reason}` };
    case 'usher': return ev.status === 404 ? { fallback: false, offline: true } : { fallback: true, reason: `usher ${ev.status || ev.reason}` };
    case 'invalid-playlist': return { fallback: true, reason: 'empty or invalid playlist' };
    case 'fatal': return ev.count >= 2 ? { fallback: true, reason: `fatal hls.js error x${ev.count}: ${ev.detail}` } : { fallback: false, recover: true };
    case 'no-frames': return { fallback: true, reason: 'no frames after 10 s' };
    default: return { fallback: false };
  }
}

export const CODEC_TYPES = { av1: 'video/mp4; codecs="av01.0.08M.08"', h265: 'video/mp4; codecs="hvc1.1.6.L120.90"' };

/**
 * Codecs to advertise to usher. AV1/H.265 only when decodable AND power-efficient
 * (hardware); otherwise H.264 only, to avoid slow software decoding.
 * @param {(type: string) => boolean} isTypeSupported
 * @param {Record<string, boolean>} [efficient] codec → MediaCapabilities powerEfficient
 */
export function supportedCodecs(isTypeSupported, efficient = {}) {
  const out = [];
  for (const c of ['av1', 'h265']) if (isTypeSupported(CODEC_TYPES[c]) && efficient[c]) out.push(c);
  out.push('h264');
  return out;
}

/** Live-edge badge from latency in seconds: { live, text }. */
export function liveBadge(latencySec, threshold = 4) {
  if (!Number.isFinite(latencySec) || latencySec <= threshold) return { live: true, text: '● LIVE' };
  const s = Math.round(latencySec);
  return { live: false, text: `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} behind` };
}

/** What to do about drift: 'none' | 'auto' (play slightly faster) | 'offer' (toast: X to jump). */
export function catchUpDecision(latencySec, { autoCatchUp = true, liveThreshold = 4, offerAfter = 30 } = {}) {
  if (!Number.isFinite(latencySec) || latencySec <= liveThreshold) return 'none';
  if (latencySec > offerAfter) return 'offer';
  return autoCatchUp ? 'auto' : 'none';
}

/** hls.js maxLiveSyncPlaybackRate for the catch-up setting. */
export function catchUpRate(autoCatchUp) { return autoCatchUp ? 1.1 : 1; }

/**
 * Codecs to ask usher for, from Settings → Player "Video codec": 'h264' (default, smoothest: hardware H.264 is
 * everywhere and software H.264 is cheap) or 'best' (AV1/H.265 when the browser says it decodes them efficiently).
 */
export function codecsFor(pref, isTypeSupported, efficient = {}) {
  return pref === 'best' ? supportedCodecs(isTypeSupported, efficient) : ['h264'];
}

/** Height cap for "Quality while in the background": 'same' → null, '720' → 720, '480' → 480. */
function qualityHeight(q) {
  const m = /(\d{3,4})p(\d+)?/.exec(q || '');
  return m ? [Number(m[1]), Number(m[2] || 30)] : null;
}

/**
 * Settings → default quality ('auto', 'chunked' = source, or e.g. '720p60') against an engine's qualities
 * ([{ group, name }], 'auto' first): the group to set, or null for Auto. Without an exact match, the best one at or
 * under the wanted height and frame rate, else the lowest.
 */
export function pickDefaultQuality(qualities, want) {
  if (!want || want === 'auto') return null;
  const qs = (qualities || []).filter((q) => q.group && q.group !== 'auto');
  if (!qs.length) return null;
  let pick = qs.find((q) => q.group === want);
  if (!pick && want === 'chunked') pick = qs[0];
  if (!pick) {
    const [wh, wf] = qualityHeight(want) || [720, 30];
    const scored = qs.map((q) => ({ q, hf: qualityHeight(q.name || q.group) }))
      .filter((x) => x.hf && (x.hf[0] < wh || (x.hf[0] === wh && x.hf[1] <= wf)))
      .sort((a, b) => b.hf[0] - a.hf[0] || b.hf[1] - a.hf[1]);
    pick = scored.length ? scored[0].q : qs[qs.length - 1];
  }
  return pick;
}

export function backgroundCap(setting) {
  const n = Number(setting);
  return setting === 'same' || !Number.isFinite(n) || n <= 0 ? null : n;
}

/**
 * Which hls.js level to play. levels: [{height, group}] in hls.js order; quality: 'auto' or a VIDEO group;
 * capHeight: null or a max height (background). Returns { level, autoCap }:
 * level -1 means ABR (with autoLevelCapping = autoCap, -1 = no cap), otherwise a fixed level index.
 */
export function levelPlan({ levels, quality = 'auto', capHeight = null }) {
  const list = (levels || []).map((l, i) => ({ i, h: Number(l.height) || 0, b: Number(l.bitrate) || 0, group: l.group }));
  let cap = -1;
  if (capHeight) {
    // The best level that fits: highest height, then highest bitrate (720p60 over 720p30).
    const fit = list.filter((l) => l.h > 0 && l.h <= capHeight).sort((a, b) => b.h - a.h || b.b - a.b)[0]
      || list.filter((l) => l.h > 0).sort((a, b) => a.h - b.h || a.b - b.b)[0];
    if (fit) cap = fit.i;
  }
  const fixed = quality === 'auto' ? -1 : list.findIndex((l) => l.group === quality);
  // ABR: hls.js sorts levels by bitrate (lowest first) and autoLevelCapping is the highest index it may pick.
  if (fixed < 0) return { level: -1, autoCap: cap };
  if (cap >= 0 && list[fixed].h > list[cap].h) return { level: cap, autoCap: -1 };
  return { level: fixed, autoCap: -1 };
}

/**
 * What to do on a fatal hls.js error: 'recover' (hls.recoverMediaError), 'restart-load' (hls.startLoad),
 * 'reload-h264' (fetch a fresh H.264-only master and start over; once), or 'fallback' (official embed).
 * A media error (e.g. bufferAppendError) on a non-H.264 rendition goes straight to the H.264 reload: that's most
 * likely an AV1/HEVC rendition this machine can't decode.
 */
export function fatalAction({ mediaError, count, h264Only, reloaded }) {
  if (mediaError && !h264Only && !reloaded) return 'reload-h264';
  if (count <= 1) return mediaError ? 'recover' : 'restart-load';
  if (!reloaded) return 'reload-h264';
  return 'fallback';
}

/**
 * A playlist load failure that retrying won't fix: HTTP 4xx or status 0 (CORS/network refusal) on a manifest or level
 * playlist before any level has ever loaded. hls.js would otherwise cycle through every level and we'd restart and
 * reload twice (about 15 s) before falling back.
 */
export function unrecoverableLoad({ network, details, code, levelLoaded }) {
  if (!network || levelLoaded) return false;
  if (!/^(manifestLoadError|levelLoadError|audioTrackLoadError)$/.test(String(details))) return false;
  const c = Number(code);
  return c === 0 || (c >= 400 && c <= 499);
}

/**
 * Resuming a paused live stream. Twitch keeps only a short window of segments: if the paused position has left it
 * (or nothing around it is buffered and it is about to), jump to the live edge; otherwise play on, behind live.
 * Returns 'play' | 'jump' | 'reload' (no live position known: restart loading, then jump).
 */
export function resumeDecision({ live, position, windowStart, liveSync, bufferedEnd = null, margin = 6 }) {
  if (!live) return 'play';
  if (!Number.isFinite(liveSync)) return 'reload';
  if (Number.isFinite(windowStart) && position < windowStart + margin && !(Number.isFinite(bufferedEnd) && bufferedEnd > position + margin)) return 'jump';
  if (Number.isFinite(windowStart) && position < windowStart) return 'jump';
  return 'play';
}

/** "1280x720 avc1.4D401F" for the stats log. */
export function levelLabel(level) {
  if (!level) return '-';
  const res = level.width && level.height ? `${level.width}x${level.height}` : (level.height ? `${level.height}p` : '?');
  return `${res} ${level.videoCodec || level.codecSet || (level.attrs && level.attrs.CODECS) || '?'}`;
}
