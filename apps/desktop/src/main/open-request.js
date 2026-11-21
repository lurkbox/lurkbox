'use strict';
// "Open this channel" requests from the Lurkbox Decky plugin (decky/). When a go-live toast is clicked, the plugin
// writes ~/.config/Lurkbox/open-request.json {channel, at} and starts (or focuses) the Lurkbox shortcut. Lurkbox
// consumes the file at startup and whenever it changes, and opens the channel if the request is under 2 minutes old.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'open-request.json';
const MAX_AGE_MS = 2 * 60 * 1000;
const MAX_SKEW_MS = 60 * 1000; // a request "from the future" (clock change) within a minute still counts
const LOGIN_RE = /^[a-z0-9_]{1,25}$/i;

/** `at` as epoch ms: accepts ms, seconds (Python time.time()) or an ISO string. NaN if unusable. */
function atMs(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at < 1e12 ? at * 1000 : at;
  if (typeof at === 'string' && at) return Date.parse(at);
  return NaN;
}

/** Validates a parsed request. Returns {channel, name} or {error}. */
function parseRequest(obj, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not an object' };
  const channel = typeof obj.channel === 'string' ? obj.channel.trim().toLowerCase() : '';
  if (!LOGIN_RE.test(channel)) return { error: 'bad channel' };
  const t = atMs(obj.at);
  if (!Number.isFinite(t)) return { error: 'bad time' };
  const age = now - t;
  if (age > maxAgeMs) return { error: 'stale' };
  if (age < -MAX_SKEW_MS) return { error: 'from the future' };
  const name = typeof obj.name === 'string' && obj.name.length <= 50 ? obj.name : channel;
  return { channel, name };
}

/**
 * Reads and deletes the request file. Returns {channel, name}, or null if there is none or it is stale or malformed
 * (those are deleted too, so an old request never fires later).
 */
function consumeOpenRequest(file, { now = Date.now(), maxAgeMs = MAX_AGE_MS, log = () => {} } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  let obj;
  try { obj = JSON.parse(raw); } catch { log('[open-request] ignored: malformed file'); return null; }
  const r = parseRequest(obj, now, maxAgeMs);
  if (r.error) { log(`[open-request] ignored: ${r.error}`); return null; }
  return r;
}

/** Watches the folder for open-request.json and calls onRequest({channel, name}) for each fresh request. */
class OpenRequestWatcher {
  constructor({ dir, onRequest, log = () => {}, now = () => Date.now() }) {
    this.dir = dir;
    this.file = path.join(dir, FILE_NAME);
    this.onRequest = onRequest;
    this.log = log;
    this.now = now;
    this.watcher = null;
    this.debounce = null;
  }

  /** Consumes a request left before Lurkbox started (the toast that launched it). */
  takeNow() {
    const r = consumeOpenRequest(this.file, { now: this.now(), log: this.log });
    if (r) this.log(`[open-request] open ${r.channel}`);
    return r;
  }

  start() {
    this.stop();
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_ev, name) => {
        if (name && String(name) !== FILE_NAME) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const r = this.takeNow();
          if (r) { try { this.onRequest(r); } catch (e) { this.log(`[open-request] handler failed: ${e.message}`); } }
        }, 100);
      });
      this.watcher.on('error', (e) => this.log(`[open-request] watch error: ${e.message}`));
    } catch (e) {
      this.log(`[open-request] cannot watch ${this.dir}: ${e.message}`);
    }
  }

  stop() {
    clearTimeout(this.debounce);
    if (this.watcher) { try { this.watcher.close(); } catch { /* closed */ } }
    this.watcher = null;
  }
}

module.exports = { OpenRequestWatcher, consumeOpenRequest, parseRequest, atMs, FILE_NAME, MAX_AGE_MS };
