'use strict';
// Where each account stopped watching each VOD (resume positions). userData/resume.json:
//   { accounts: { "<userId>|anon": { "<videoId>": { pos, dur, at } } } }
const fs = require('fs');
const path = require('path');

const MAX_PER_ACCOUNT = 300;
const ID = /^\d{1,20}$/;
const accountKey = (id) => (ID.test(String(id || '')) ? String(id) : 'anon');

class ResumeStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { accounts: {} };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && typeof d.accounts === 'object') this.data = d;
    } catch { /* new file */ }
  }

  get(accountId, videoId) {
    if (!ID.test(String(videoId))) return null;
    const e = (this.data.accounts[accountKey(accountId)] || {})[String(videoId)];
    return e ? { position: e.pos, duration: e.dur, at: e.at } : null;
  }

  /** Stores a position (seconds). position null/0 forgets it. Keeps the newest MAX_PER_ACCOUNT entries. */
  set(accountId, videoId, position, duration) {
    if (!ID.test(String(videoId))) return false;
    const key = accountKey(accountId);
    const acct = this.data.accounts[key] || (this.data.accounts[key] = {});
    const p = Number(position);
    if (!Number.isFinite(p) || p <= 0) delete acct[String(videoId)];
    else acct[String(videoId)] = { pos: Math.round(p), dur: Number.isFinite(Number(duration)) ? Math.round(Number(duration)) : null, at: this.now() };
    const ids = Object.keys(acct);
    if (ids.length > MAX_PER_ACCOUNT) {
      ids.sort((a, b) => acct[b].at - acct[a].at).slice(MAX_PER_ACCOUNT).forEach((id) => delete acct[id]);
    }
    this.save();
    return true;
  }

  removeAccount(accountId) { delete this.data.accounts[accountKey(accountId)]; this.save(); }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn(`[resume] save failed: ${e.message}`); }
  }
}

module.exports = { ResumeStore, MAX_PER_ACCOUNT };
