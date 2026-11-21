'use strict';
// Exports Twitch's per-follow notification bell for the Lurkbox Decky plugin (decky/).
//
// Helix has no field for "notifications on" per followed channel, so while the twitch.tv web session is signed in,
// this asks the web GQL (the same private API direct.js uses, approved for Lurkbox) for the signed-in user's follows
// with their notification setting, and writes ~/.config/Lurkbox/notify-channels.json:
//   {updated_at, user_id, login, complete, channels: [{id, login, notify}]}
// The plugin reads it and notifies only for channels with notify:true (its default mode).
// Never logs or writes the auth token.

const fs = require('fs');
const path = require('path');

const GQL_URL = 'https://gql.twitch.tv/gql';
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const INTERVAL_MS = 10 * 60 * 1000;
const MAX_PAGES = 50; // 100 follows per page

// FollowEdge has both `disableNotifications` and `notificationSettings { isEnabled }` (checked against
// gql.twitch.tv validation, 2026-11-21). isEnabled wins when present.
const QUERY = `query LurkboxFollowNotify($cursor: Cursor) {
  currentUser {
    id
    login
    follows(first: 100, after: $cursor) {
      edges { cursor disableNotifications notificationSettings { isEnabled } node { id login } }
      pageInfo { hasNextPage }
    }
  }
}`;

/** Notification setting of one follow edge, or null if the edge says nothing about it. */
function edgeNotify(edge) {
  if (edge && edge.notificationSettings && typeof edge.notificationSettings.isEnabled === 'boolean') return edge.notificationSettings.isEnabled;
  if (edge && typeof edge.disableNotifications === 'boolean') return !edge.disableNotifications;
  return null;
}

/**
 * Parses one GQL response body. Returns {ok:true, userId, login, channels, hasNext, cursor} or {ok:false, reason}.
 * Edges without a usable node are skipped; a missing notification setting counts as on (Twitch's default for a follow).
 */
function parsePage(body) {
  const b = Array.isArray(body) ? body[0] : body;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'empty response' };
  const errs = Array.isArray(b.errors) ? b.errors : [];
  const user = b.data && b.data.currentUser;
  if (!user) {
    const msg = errs.length ? String(errs[0].message || 'error').slice(0, 80) : 'not signed in';
    return { ok: false, reason: msg };
  }
  const follows = user.follows;
  if (!follows || !Array.isArray(follows.edges)) {
    const msg = errs.length ? String(errs[0].message || 'error').slice(0, 80) : 'no follows field';
    return { ok: false, reason: msg, userId: String(user.id || ''), login: user.login || '' };
  }
  const channels = [];
  let cursor = null;
  for (const e of follows.edges) {
    if (e && e.cursor) cursor = e.cursor;
    const n = e && e.node;
    if (!n || !/^\d+$/.test(String(n.id || '')) || typeof n.login !== 'string') continue;
    const v = edgeNotify(e);
    channels.push({ id: String(n.id), login: n.login.toLowerCase(), notify: v === null ? true : v });
  }
  return {
    ok: true,
    userId: String(user.id || ''),
    login: String(user.login || '').toLowerCase(),
    channels,
    hasNext: !!(follows.pageInfo && follows.pageInfo.hasNextPage) && !!cursor,
    cursor,
  };
}

/**
 * Fetches every follow with its notification setting. A failure after the first page keeps what was read and
 * returns complete:false (the plugin treats channels it doesn't find as "on").
 */
async function fetchNotifySettings({ fetch, authToken, maxPages = MAX_PAGES }) {
  if (!authToken) return { ok: false, reason: 'no web session' };
  const byId = new Map();
  let userId = '';
  let login = '';
  let cursor = null;
  let complete = false;
  let reason = '';
  for (let page = 0; page < maxPages; page++) {
    let body;
    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Client-ID': WEB_CLIENT_ID, Authorization: `OAuth ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'LurkboxFollowNotify', query: QUERY, variables: { cursor } }),
      });
      if (!res.ok) { reason = `http ${res.status}`; break; }
      body = await res.json();
    } catch (e) {
      reason = `network: ${String(e && e.message || e).slice(0, 80)}`;
      break;
    }
    const p = parsePage(body);
    if (!p.ok) { reason = p.reason; break; }
    if (userId && p.userId !== userId) { reason = 'user changed while paging'; break; }
    userId = p.userId;
    login = p.login;
    for (const c of p.channels) byId.set(c.id, c);
    if (!p.hasNext) { complete = true; break; }
    cursor = p.cursor;
  }
  if (!userId) return { ok: false, reason: reason || 'no data' };
  return { ok: true, userId, login, channels: [...byId.values()], complete, reason };
}

/** Writes the export atomically (temp file + rename), mode 0600. */
function writeExport(file, { userId, login, channels, complete }, now = Date.now()) {
  const data = {
    updated_at: new Date(now).toISOString(),
    user_id: String(userId),
    login: login || '',
    complete: !!complete,
    channels: channels.map((c) => ({ id: String(c.id), login: String(c.login), notify: !!c.notify })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return data;
}

/** Runs the export now and then every 10 minutes while getAuthToken() returns a web auth-token. */
class NotifyExporter {
  constructor({ fetch, getAuthToken, file, log = () => {}, intervalMs = INTERVAL_MS }) {
    this.fetch = fetch;
    this.getAuthToken = getAuthToken;
    this.file = file;
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start(firstDelayMs = 30_000) {
    this.stop();
    this.timer = setTimeout(() => this.tick(), firstDelayMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    try { await this.runOnce(); } catch (e) { this.log(`[notify-export] failed: ${e.message}`); }
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async runOnce() {
    if (this.running) return null;
    this.running = true;
    try {
      const token = await this.getAuthToken();
      if (!token) return null; // not signed in on the web: leave any earlier export alone
      const r = await fetchNotifySettings({ fetch: this.fetch, authToken: token });
      if (!r.ok) { this.log(`[notify-export] skipped: ${r.reason}`); return null; }
      const data = writeExport(this.file, r);
      const on = data.channels.filter((c) => c.notify).length;
      this.log(`[notify-export] wrote ${data.channels.length} follows (${on} with notifications on)${r.complete ? '' : `; incomplete: ${r.reason}`}`);
      return data;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { NotifyExporter, fetchNotifySettings, parsePage, writeExport, edgeNotify, QUERY, INTERVAL_MS };
