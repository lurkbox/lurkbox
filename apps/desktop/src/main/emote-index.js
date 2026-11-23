'use strict';
// The "seen channels" emote index per account (Emote search → Seen channels). userData/emote-index.json:
//   { accounts: { "<userId>|anon": { v: 1, channels: [{ id, login, name, at, emotes: [[provider, id, name, url?]] }] } } }
// Validation and the 20,000-emote cap are shared with Android (@lurkbox/core/src/shared/emote-index.js).
const fs = require('fs');
const path = require('path');
const { accountsWithIndex, accountIndexKey } = require('@lurkbox/core/src/shared/emote-index.js');

class EmoteIndexStore {
  /** file null: in memory only (demo mode). */
  constructor(file) {
    this.file = file;
    this.accounts = {};
    if (!file) return;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.accounts && typeof d.accounts === 'object') this.accounts = d.accounts;
    } catch { /* new file */ }
  }

  get(accountId) { return this.accounts[accountIndexKey(accountId)] || null; }

  /** Saves (validated) the account's index; null forgets it. */
  set(accountId, index) {
    this.accounts = accountsWithIndex(this.accounts, accountId, index);
    this.save();
    return true;
  }

  removeAccount(accountId) { this.set(accountId, null); }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ accounts: this.accounts }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn(`[emote-index] save failed: ${e.message}`); }
  }
}

module.exports = { EmoteIndexStore };
