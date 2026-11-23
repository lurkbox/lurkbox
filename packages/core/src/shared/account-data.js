// Signing out (or removing) an account deletes everything Lurkbox keeps for it on the device: its tokens and profile,
// its twitch.tv web session (live cookies when it is the active account, and its saved cookie jar), and every
// per-account store. Global settings (theme, layout, input, chat layout, sounds) stay. Shared by the hosts: each one
// lists its stores and calls removeAccountData() from both signOut and removeAccount.

/** Settings keys that hold per-account data: { <user id>: ... }. */
export const PER_ACCOUNT_SETTINGS = Object.freeze(['searchHistory', 'emoteRecents', 'multiSets', 'myClips']);

/** The settings patch that drops this account from every per-account key ({} when it has nothing there). */
export function settingsWithoutAccount(settings, id) {
  const key = String(id);
  const patch = {};
  for (const k of PER_ACCOUNT_SETTINGS) {
    const v = settings && settings[k];
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, key)) {
      const next = { ...v };
      delete next[key];
      patch[k] = next;
    }
  }
  return patch;
}

/**
 * Removes the account and all of its data. Never throws for one store: a failing store is logged and the rest go on.
 * @param {string} id the account (default: the active one)
 * @param {object} h
 * @param {object} h.twitch            shared Twitch (store(), removeAccount(id): revokes, deletes tokens and profile)
 * @param {{get(): object, set(patch): object}} h.settings
 * @param {(settings: object) => void} [h.onSettings]  tell the page the settings changed
 * @param {() => Promise<void>} h.clearLiveSession     the active account's twitch.tv session (cookies, site data)
 * @param {(id: string) => Promise<void>} h.removeJar  the account's saved cookie jar
 * @param {(id: string) => Promise<void>} [h.restoreSession]  put the new active account's jar in (after the active one went)
 * @param {Record<string, (id: string, ctx: {wasActive: boolean}) => unknown>} h.stores  name → remove this account's data
 * @param {(line: string) => void} [h.log]
 * @returns {Promise<{ id: string|null, cleared: string[], active: string|null }>}
 */
export async function removeAccountData(id, h) {
  const log = h.log || (() => {});
  const target = id ? String(id) : h.twitch.store().active;
  if (!target) return { id: null, cleared: [], active: h.twitch.store().active };
  const wasActive = h.twitch.store().active === target;
  const cleared = [];
  const step = async (name, fn) => {
    try { await fn(); cleared.push(name); } catch (e) { log(`[accounts] could not clear ${name}: ${e && e.message}`); }
  };
  if (wasActive) await step('web-session', () => h.clearLiveSession());
  await step('cookie-jar', () => h.removeJar(target));
  for (const [name, fn] of Object.entries(h.stores || {})) await step(name, () => fn(target, { wasActive }));
  await step('settings', () => {
    const patch = settingsWithoutAccount(h.settings.get(), target);
    if (!Object.keys(patch).length) return;
    const next = h.settings.set(patch);
    if (h.onSettings) h.onSettings(next);
  });
  let active = h.twitch.store().active;
  await step('account', async () => { active = await h.twitch.removeAccount(target); }); // tokens + profile; emits the state
  if (active == null) active = h.twitch.store().active;
  if (wasActive && active && h.restoreSession) await step('next-session', () => h.restoreSession(active));
  log(`[accounts] removed an account and its data (${cleared.join(', ')})`);
  return { id: target, cleared, active: active || null };
}
