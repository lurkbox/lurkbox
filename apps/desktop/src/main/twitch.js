'use strict';
// Twitch auth (Device Code Grant, public client, no secret) and Helix calls.
// Runs in the main process so tokens never reach the renderer.
const { EventEmitter } = require('events');

const ID_BASE = 'https://id.twitch.tv/oauth2';
const HELIX_BASE = 'https://api.twitch.tv/helix';
const { SCOPES } = require('@lurkbox/core/src/shared/config.js');

class HttpError extends Error {
  constructor(status, body, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.append(k, String(v));
  return p;
}

/**
 * Converts any saved tokens.json into {accounts, active}. The pre-multi-account
 * shape ({access_token, refresh_token, scope}) becomes a pending '_legacy'
 * account that validate() re-keys by its user id.
 */
function migrateTokens(raw) {
  if (raw && raw.accounts && typeof raw.accounts === 'object') {
    return { accounts: raw.accounts, active: raw.active && raw.accounts[raw.active] ? raw.active : Object.keys(raw.accounts)[0] || null };
  }
  if (raw && raw.access_token) {
    return { accounts: { _legacy: { access_token: raw.access_token, refresh_token: raw.refresh_token, scopes: raw.scope || [] } }, active: '_legacy' };
  }
  return { accounts: {}, active: null };
}

class Twitch extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings
   * @param {import('./store').JsonFile} opts.tokens  tokens.json ({accounts, active})
   * @param {typeof fetch} [opts.fetch] injectable for tests
   * @param {(fromId, toId) => Promise<void>} [opts.onSwitch] e.g. swap player cookie jars
   */
  constructor({ getSettings, tokens, fetch: fetchImpl, onSwitch }) {
    super();
    this.fetch = fetchImpl || globalThis.fetch;
    this.getSettings = getSettings;
    this.tokens = tokens;
    this.onSwitch = onSwitch || (async () => {});
    this.refreshing = new Map();
    this.device = null;
    const migrated = migrateTokens(tokens.get());
    tokens.replace(migrated);
  }

  get clientId() { return this.getSettings().clientId || ''; }

  store() { return migrateTokens(this.tokens.get()); }
  account(id) { return this.store().accounts[id] || null; }
  saveStore(s) { this.tokens.replace(s); }
  updateAccount(id, patch) {
    const s = this.store();
    if (!s.accounts[id]) return;
    s.accounts[id] = { ...s.accounts[id], ...patch };
    this.saveStore(s);
  }

  /** The active account when it is usable, as {id, login}. */
  get user() {
    const s = this.store();
    const a = s.accounts[s.active];
    return a && a.login && a.access_token && !a.needs_signin ? { id: s.active, login: a.login } : null;
  }

  state() {
    const s = this.store();
    const a = s.accounts[s.active];
    const missing = a && Array.isArray(a.missing_scopes) ? a.missing_scopes : [];
    return {
      hasClientId: !!this.clientId,
      signedIn: !!this.user,
      needsReauth: !!(a && a.needs_signin === 'scopes'),
      missingScopes: missing,
      user: this.user ? { ...this.user, display_name: a.display_name, profile_image_url: a.profile_image_url } : null,
      active: s.active,
      accounts: Object.entries(s.accounts).filter(([id]) => id !== '_legacy').map(([id, x]) => ({
        id, login: x.login, display_name: x.display_name || x.login, profile_image_url: x.profile_image_url || '', needsSignin: !!x.needs_signin || !x.access_token,
      })),
      deviceFlow: this.device ? this.device.public : null,
    };
  }

  emitState() { this.emit('state', this.state()); }

  // ---- validation / refresh (per account) ----

  async validateToken(token) {
    const res = await this.fetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (res.status === 401) return { status: 401 };
    if (!res.ok) throw new Error(`validate HTTP ${res.status}`);
    return { status: 200, body: await readJson(res) };
  }

  /** Validates the active account (refreshing on 401). Network errors throw. */
  async validate() {
    const s = this.store();
    let id = s.active;
    const a = s.accounts[id];
    if (!a || !a.access_token || !this.clientId) return false;
    let v = await this.validateToken(a.access_token);
    if (v.status === 401) {
      if (!(await this.refresh(id))) return false;
      v = await this.validateToken(this.account(id).access_token);
      if (v.status === 401) { this.markNeedsSignin(id); return false; }
    }
    const body = v.body;
    if (body.client_id && body.client_id !== this.clientId) { this.markNeedsSignin(id); return false; }
    if (id !== body.user_id) id = this.rekey(id, body.user_id); // legacy migration
    const granted = new Set(body.scopes || []);
    const missing = SCOPES.filter((sc) => !granted.has(sc));
    this.updateAccount(id, { login: body.login, scopes: body.scopes || [], missing_scopes: missing, needs_signin: missing.length ? 'scopes' : false });
    if (missing.length) {
      console.warn(`[auth] ${body.login}: token lacks scopes ${missing.join(' ')}; asking for a new sign-in`);
      return false;
    }
    this.loadProfile(id).catch(() => {});
    return true;
  }

  rekey(oldId, newId) {
    const s = this.store();
    const acct = s.accounts[oldId];
    delete s.accounts[oldId];
    s.accounts[newId] = { ...(s.accounts[newId] || {}), ...acct };
    if (s.active === oldId) s.active = newId;
    this.saveStore(s);
    return newId;
  }

  async loadProfile(id) {
    const r = await this.helix({ path: '/users', query: { id }, accountId: id });
    const u = r.data && r.data.data && r.data.data[0];
    if (u) { this.updateAccount(id, { display_name: u.display_name, profile_image_url: u.profile_image_url }); this.emitState(); }
  }

  /** Refreshes one account. Rejected refresh → only that account needs sign-in. Network errors throw. */
  refresh(id = this.store().active) {
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const p = (async () => {
      const a = this.account(id);
      if (!a || !a.refresh_token || !this.clientId) return false;
      try {
        const res = await this.fetch(`${ID_BASE}/token`, {
          method: 'POST',
          body: form({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: a.refresh_token }),
        });
        const body = await readJson(res);
        if (!res.ok || !body.access_token) {
          console.warn('[auth] refresh failed', res.status, body && body.message);
          if (res.status === 400 || res.status === 401) this.markNeedsSignin(id);
          return false;
        }
        this.updateAccount(id, { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (body.expires_in || 0) * 1000 });
        return true;
      } catch (e) {
        console.warn('[auth] refresh error', e.message); // keep tokens; the caller retries later
        throw e;
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, p);
    return p;
  }

  markNeedsSignin(id) {
    this.updateAccount(id, { access_token: null, refresh_token: null, needs_signin: true });
    this.emitState();
  }

  // ---- accounts ----

  /** Adds (or updates, if the user id already exists) an account from a token response; makes it active. */
  async addAccount(body, { switchCookies = true } = {}) {
    const v = await this.validateToken(body.access_token);
    if (v.status !== 200) return null;
    const id = v.body.user_id;
    const s = this.store();
    const prev = s.active;
    s.accounts[id] = {
      ...(s.accounts[id] || {}),
      login: v.body.login,
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      scopes: v.body.scopes || body.scope || [],
      missing_scopes: SCOPES.filter((sc) => !(v.body.scopes || []).includes(sc)),
      needs_signin: false,
      expires_at: Date.now() + (body.expires_in || 0) * 1000,
    };
    s.active = id;
    this.saveStore(s);
    // The TV sign-in keeps the session's cookies (they are the new account's web login) and saves the jars itself.
    if (prev && prev !== id && switchCookies) await this.onSwitch(prev, id);
    this.loadProfile(id).catch(() => {});
    return { id, login: v.body.login };
  }

  async switchAccount(id) {
    const s = this.store();
    if (!s.accounts[id] || s.active === id) return false;
    const prev = s.active;
    s.active = id;
    this.saveStore(s);
    await this.onSwitch(prev, id);
    try { await this.validate(); } catch { /* offline: keep the stored state */ }
    this.emitState();
    return true;
  }

  async revoke(token) {
    if (!token || !this.clientId) return;
    try { await this.fetch(`${ID_BASE}/revoke`, { method: 'POST', body: form({ client_id: this.clientId, token }) }); } catch { /* best effort */ }
  }

  /** Signs one account out (revokes) but keeps it in the list as "needs sign-in". */
  async signOut(id = this.store().active) {
    this.cancelDeviceFlow();
    const a = this.account(id);
    if (a) await this.revoke(a.access_token);
    if (a) this.updateAccount(id, { access_token: null, refresh_token: null, needs_signin: true });
    this.emitState();
  }

  /** Removes an account entirely; the active one falls back to another usable account, or none. */
  async removeAccount(id) {
    const a = this.account(id);
    if (!a) return null;
    await this.revoke(a.access_token);
    const s = this.store();
    delete s.accounts[id];
    if (s.active === id) {
      const usable = Object.entries(s.accounts).find(([, x]) => x.access_token && !x.needs_signin);
      s.active = usable ? usable[0] : (Object.keys(s.accounts)[0] || null);
    }
    this.saveStore(s);
    this.emitState();
    return s.active;
  }

  clearTokens() { this.saveStore({ accounts: {}, active: null }); this.emitState(); }

  // ---- device code flow ----

  /** @param {{keepCookies?: boolean}} [opts] keepCookies: on success, don't swap player cookie jars (TV sign-in). */
  async startDeviceFlow({ keepCookies = false } = {}) {
    if (!this.clientId) throw new Error('No Client ID set. Add one in Settings.');
    this.cancelDeviceFlow();
    const res = await this.fetch(`${ID_BASE}/device`, {
      method: 'POST',
      body: form({ client_id: this.clientId, scopes: SCOPES.join(' ') }),
    });
    const body = await readJson(res);
    if (!res.ok) throw new Error(`Twitch refused the sign-in request (${res.status}): ${(body && body.message) || 'unknown error'}`);
    const flow = {
      deviceCode: body.device_code,
      interval: Math.max(1, body.interval || 5),
      expiresAt: Date.now() + (body.expires_in || 1800) * 1000,
      timer: null,
      cancelled: false,
      keepCookies,
      public: {
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresIn: body.expires_in,
        status: 'pending',
      },
    };
    this.device = flow;
    this.schedulePoll(flow);
    this.emitState();
    return flow.public;
  }

  cancelDeviceFlow() {
    if (!this.device) return;
    this.device.cancelled = true;
    clearTimeout(this.device.timer);
    this.device = null;
    this.emitState();
  }

  schedulePoll(flow) {
    flow.timer = setTimeout(() => this.poll(flow), flow.interval * 1000);
  }

  async poll(flow) {
    if (flow.cancelled || this.device !== flow) return;
    if (Date.now() > flow.expiresAt) {
      this.device = null;
      this.emit('auth', { status: 'expired' });
      this.emitState();
      return;
    }
    try {
      const res = await this.fetch(`${ID_BASE}/token`, {
        method: 'POST',
        body: form({
          client_id: this.clientId,
          scopes: SCOPES.join(' '),
          device_code: flow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const body = await readJson(res);
      if (flow.cancelled) return;
      if (res.ok && body.access_token) {
        this.device = null;
        const acct = await this.addAccount(body, { switchCookies: !flow.keepCookies });
        this.emit('auth', { status: 'success', user: acct ? { id: acct.id, login: acct.login } : null });
        this.emitState();
        return;
      }
      const msg = (body && body.message) || '';
      if (msg === 'authorization_pending') {
        this.schedulePoll(flow);
      } else if (msg === 'slow_down') {
        flow.interval += 5;
        this.schedulePoll(flow);
      } else if (msg === 'invalid device code' || msg === 'expired_token') {
        this.device = null;
        this.emit('auth', { status: 'expired' });
        this.emitState();
      } else if (msg === 'access_denied') {
        this.device = null;
        this.emit('auth', { status: 'denied' });
        this.emitState();
      } else {
        console.warn('[auth] unexpected poll response', res.status, msg);
        this.schedulePoll(flow);
      }
    } catch (e) {
      console.warn('[auth] poll error', e.message);
      if (!flow.cancelled) this.schedulePoll(flow);
    }
  }

  // ---- Helix ----

  /**
   * @param {{method?: string, path: string, query?: object, body?: object}} req
   * Returns { status, data } where data is the parsed body.
   */
  async helix(req) {
    if (!this.clientId) throw new HttpError(0, null, 'NO_CLIENT_ID');
    const id = req.accountId || this.store().active;
    const acct = this.account(id);
    if (!acct || !acct.access_token) throw new HttpError(401, null, 'NOT_SIGNED_IN');
    const url = new URL(HELIX_BASE + req.path);
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    const doFetch = () => {
      const headers = {
        'Client-Id': this.clientId,
        Authorization: `Bearer ${this.account(id).access_token}`,
      };
      const init = { method: req.method || 'GET', headers };
      if (req.body) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body);
      }
      return this.fetch(url, init);
    };
    let res = await doFetch();
    if (res.status === 401) {
      if (await this.refresh(id)) res = await doFetch();
      if (res.status === 401) {
        this.markNeedsSignin(id);
        throw new HttpError(401, null, 'NOT_SIGNED_IN');
      }
    }
    const data = await readJson(res);
    if (!res.ok) {
      const err = new HttpError(res.status, data, (data && data.message) || `Helix ${res.status}`);
      err.resetAt = res.headers.get('ratelimit-reset');
      throw err;
    }
    return { status: res.status, data };
  }
}

module.exports = { Twitch, HttpError, SCOPES, migrateTokens };
