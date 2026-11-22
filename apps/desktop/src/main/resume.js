'use strict';
// Where each account stopped watching each VOD (resume positions), with the video's details for Following's
// Continue watching row. userData/resume.json:
//   { accounts: { "<userId>|anon": { "<videoId>": { pos, dur, at, m?: { title, login, name, userId, thumb } } } } }
// The entry maths are shared with Android (@lurkbox/core/src/shared/continue-watching.js).
const fs = require('fs');
const path = require('path');
const { resumeUpdate, resumeEntries, RESUME_MAX_PER_ACCOUNT: MAX_PER_ACCOUNT } = require('@lurkbox/core/src/shared/continue-watching.js');

const ID = /^\d{1,20}$/;
const accountKey = (id) => (ID.test(String(id || '')) ? String(id) : 'anon');

class ResumeStore {
  /** file null: in memory only (demo mode). */
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { accounts: {} };
    if (!file) return;
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

  /** Stores a position (seconds) and the video's details (meta). position null/0 forgets it. Keeps the newest MAX_PER_ACCOUNT entries. */
  set(accountId, videoId, position, duration, meta) {
    if (!ID.test(String(videoId))) return false;
    const key = accountKey(accountId);
    this.data.accounts[key] = resumeUpdate(this.data.accounts[key], videoId, position, duration, meta, { now: this.now(), max: MAX_PER_ACCOUNT });
    this.save();
    return true;
  }

  /** Every saved position of the account, with its details (resumeList). */
  list(accountId) { return resumeEntries(this.data.accounts[accountKey(accountId)]); }

  /** Settings → Clear watch history: the account's positions and details. */
  clear(accountId) { this.removeAccount(accountId); return true; }

  removeAccount(accountId) { delete this.data.accounts[accountKey(accountId)]; this.save(); }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn(`[resume] save failed: ${e.message}`); }
  }
}

module.exports = { ResumeStore, MAX_PER_ACCOUNT };
