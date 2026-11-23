// "Earn channel points while watching" for the direct engine: once a minute, while the stream on screen is really
// playing, do what Twitch's web player does for the signed-in viewer (the approach maintained tools such as
// Twitch-Channel-Points-Miner-v2 use since Twitch's 2024 change):
//   1. HEAD the newest segment of the lowest-quality playlist, from a usher master fetched with the viewer's session;
//   2. POST a base64 "minute-watched" event to the spade URL named in twitch.tv's settings script.
// Only for the stream being watched, never for anything else. No tokens are logged. Shared by the hosts: the desktop
// main process (Electron net.fetch, the session's cookie) and Android (CapacitorHttp; the signed-in master comes
// through native webGql, so the auth-token never reaches page JS).

export const HIDDEN_LIMIT_MS = 5 * 60 * 1000;
const SPADE_TTL_MS = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Whether to report this minute. Returns { ok, reason }.
 * @param {object} g
 * @param {boolean} g.enabled      Settings → Player → Earn channel points while watching
 * @param {boolean} g.direct       the direct engine plays (the Twitch player reports by itself)
 * @param {boolean} g.live         a live stream (not a VOD)
 * @param {boolean} g.rewound      playing the archive VOD (live rewind) instead of live
 * @param {boolean} g.playing      not paused, frames advancing
 * @param {boolean} g.webSignedIn  twitch.tv session present
 * @param {boolean} g.sameUser     that session is the active Lurkbox account
 * @param {number|null} g.hiddenMs how long the window has been minimised/hidden (null = visible)
 */
export function reportGate({ enabled, direct, live, rewound, playing, webSignedIn, sameUser, hiddenMs = null }) {
  if (!enabled) return { ok: false, reason: 'setting off' };
  if (!direct) return { ok: false, reason: 'Twitch player reports by itself' };
  if (!live) return { ok: false, reason: 'not live' };
  if (rewound) return { ok: false, reason: 'rewound' };
  if (!playing) return { ok: false, reason: 'not playing' };
  if (!webSignedIn) return { ok: false, reason: 'no twitch.tv session' };
  if (!sameUser) return { ok: false, reason: 'twitch.tv session is another account' };
  if (hiddenMs != null && hiddenMs > HIDDEN_LIMIT_MS) return { ok: false, reason: 'hidden for more than 5 min' };
  return { ok: true, reason: 'ok' };
}

/** Base64 of a string's UTF-8 bytes (no Buffer: this runs in the WebView too). */
function base64Utf8(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The spade POST body: data=<base64 of the JSON event list>. */
export function minuteWatchedBody({ channelId, broadcastId, userId, login }) {
  const events = [{ event: 'minute-watched', properties: { channel_id: String(channelId), broadcast_id: String(broadcastId), player: 'site', user_id: String(userId), live: true, channel: String(login).toLowerCase() } }];
  return `data=${encodeURIComponent(base64Utf8(JSON.stringify(events)))}`;
}

export function findSettingsUrl(html) {
  const m = /(https:\/\/static\.twitchcdn\.net\/config\/settings\.[^"'\s]*?\.js|https:\/\/assets\.twitch\.tv\/config\/settings\.[^"'\s]*?\.js)/.exec(String(html));
  return m ? m[1] : null;
}

export function findSpadeUrl(js) {
  const m = /"spade_url":"(https:\/\/[^"]+)"/.exec(String(js));
  return m ? m[1].replace(/\\\//g, '/') : null;
}

/** Last variant URI in a master playlist (Twitch lists the lowest quality last). */
export function lowestVariant(master) {
  const lines = String(master).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https:\/\//.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}

/** Newest segment URI in a media playlist. */
export function newestSegment(media, base) {
  const lines = String(media).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  try { return new URL(lines[lines.length - 1], base).href; } catch { return null; }
}

export class WatchMinutes {
  /**
   * @param {object} d
   * @param {typeof fetch} d.fetch   Electron net.fetch, or Android's native fetch
   * @param {(login: string) => Promise<{ok, master, authed}>} d.master  a usher master with the viewer's session
   * @param {(line: string) => void} [d.log]
   */
  constructor({ fetch, master, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { fetch, master, log, now });
    this.spade = { url: null, at: 0 };
    this.lastReason = null;
  }

  async spadeUrl(login) {
    if (this.spade.url && this.now() - this.spade.at < SPADE_TTL_MS) return this.spade.url;
    const page = await this.fetch(`https://www.twitch.tv/${encodeURIComponent(login)}`, { headers: { 'User-Agent': UA } }).then((r) => r.text());
    const settings = findSettingsUrl(page);
    if (!settings) throw new Error('settings script not found on the channel page');
    const url = findSpadeUrl(await this.fetch(settings, { headers: { 'User-Agent': UA } }).then((r) => r.text()));
    if (!url || !/^https:\/\/([a-z0-9-]+\.)*(twitch\.tv|ttvnw\.net|twitchcdn\.net)\//i.test(url)) throw new Error('spade_url not found');
    this.spade = { url, at: this.now() };
    return url;
  }

  /**
   * One minute of watching. gate = reportGate() input; info = { login, channelId, broadcastId, userId }.
   * Logs one line: ok / failed / skipped (reason, once per change).
   */
  async report(gate, info) {
    const g = reportGate(gate);
    if (!g.ok) {
      if (g.reason !== this.lastReason) this.log(`[points] minute-watched ${info.login || '-'}: skipped (${g.reason})`);
      this.lastReason = g.reason;
      return { ok: false, skipped: true, reason: g.reason };
    }
    this.lastReason = null;
    try {
      const m = await this.master(info.login);
      if (!m || !m.ok) throw new Error(`master: ${(m && m.reason) || 'failed'}`);
      if (!m.authed) throw new Error('master was not signed in');
      const variant = lowestVariant(m.master);
      if (!variant) throw new Error('no variant');
      const media = await this.fetch(variant, { headers: { 'User-Agent': UA } });
      if (!media.ok) throw new Error(`variant HTTP ${media.status}`);
      const seg = newestSegment(await media.text(), variant);
      if (!seg) throw new Error('no segment');
      const head = await this.fetch(seg, { method: 'HEAD', headers: { 'User-Agent': UA } });
      if (!head.ok) throw new Error(`segment HTTP ${head.status}`);
      const spade = await this.spadeUrl(info.login);
      const r = await this.fetch(spade, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: minuteWatchedBody(info) });
      const ok = r.status === 204 || r.ok;
      this.log(`[points] minute-watched ${info.login}: ${ok ? 'ok' : 'failed'} (segment ${head.status}, spade ${r.status})`);
      if (!ok) this.spade.at = 0; // look the URL up again next time
      return { ok, status: r.status };
    } catch (e) {
      this.log(`[points] minute-watched ${info.login}: failed (${e.message})`);
      return { ok: false, error: e.message };
    }
  }
}

