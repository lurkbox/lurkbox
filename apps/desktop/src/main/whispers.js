'use strict';
// Whisper history, kept on this device per account (the core's Whispers section). userData/whispers.json (mode 0600):
//   { accounts: { "<userId>": [{ id, login, name, unread, at, messages: [{ id, me, text, at, failed? }] }] } }
// Validation and the caps (50 threads, 200 messages each) are shared with Android (@lurkbox/core/src/shared/whispers.js).
const fs = require('fs');
const path = require('path');
const { storeWhispers, loadWhispers } = require('@lurkbox/core/src/shared/whispers.js');

class WhisperStore {
  /** file null: in memory only (demo mode). */
  constructor(file) {
    this.file = file;
    this.data = { accounts: {} };
    if (!file) return;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && typeof d.accounts === 'object') this.data = d;
    } catch { /* new file */ }
  }

  load(accountId) { return loadWhispers(this.data, accountId); }

  /** Replaces the account's threads (an empty list forgets them: Settings → Clear whispers). */
  save(accountId, threads) {
    this.data = storeWhispers(this.data, accountId, threads);
    this.write();
    return true;
  }

  removeAccount(accountId) { return this.save(accountId, []); }

  write() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn(`[whispers] save failed: ${e.message}`); }
  }
}

module.exports = { WhisperStore };
