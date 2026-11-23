'use strict';
// Sign-out and account removal: one function that deletes everything the desktop keeps for an account
// (@lurkbox/core/src/shared/account-data.js removeAccountData does the order; the stores are listed here).
const fs = require('fs');
const path = require('path');
const { removeAccountData } = require('@lurkbox/core/src/shared/account-data.js');

/** The Decky plugin's follow-notification export (notify-export.js), when it was written for this user. */
function removeNotifyExport(file, id) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!data || String(data.user_id) === String(id)) fs.rmSync(file, { force: true });
}

/**
 * @param {object} d
 * @param {object} d.twitch     the shared Twitch
 * @param {object} d.settings   the settings JsonFile
 * @param {(s: object) => void} [d.onSettings]
 * @param {object} d.playerJar  CookieJar (player-session.js)
 * @param {() => Promise<void>} [d.clearSiteData]  twitch.tv's own site data in the session (local storage and caches)
 * @param {object} d.resume     ResumeStore
 * @param {object} d.whispers   WhisperStore
 * @param {object} d.emoteIndex EmoteIndexStore
 * @param {string} d.dir        userData (notify-channels.json, open-request.json)
 * @param {() => void} [d.onActiveRemoved]  in-memory state of the active web session (Drops progress, a pending open request)
 * @param {(line: string) => void} [d.log]
 */
function createAccountRemover(d) {
  return (id) => removeAccountData(id, {
    twitch: d.twitch,
    settings: d.settings,
    onSettings: d.onSettings,
    log: d.log,
    clearLiveSession: async () => {
      await d.playerJar.clear();
      if (d.clearSiteData) await d.clearSiteData();
    },
    removeJar: async (acct) => { if (/^\d+$/.test(acct)) d.playerJar.remove(acct); },
    restoreSession: (next) => d.playerJar.restore(next),
    stores: {
      resume: (acct) => d.resume.removeAccount(acct),
      whispers: (acct) => d.whispers.removeAccount(acct),
      'emote-index': (acct) => d.emoteIndex.removeAccount(acct),
      'notify-channels': (acct) => removeNotifyExport(path.join(d.dir, 'notify-channels.json'), acct),
      'open-request': () => fs.rmSync(path.join(d.dir, 'open-request.json'), { force: true }),
      'session-state': (_acct, { wasActive }) => { if (wasActive && d.onActiveRemoved) d.onActiveRemoved(); },
    },
  });
}

module.exports = { createAccountRemover, removeNotifyExport };
